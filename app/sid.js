/**
 * sid.js — SID-1 Agentic Retrieval Module
 *
 * Runs a multi-turn tool-calling loop against SID-1 (api.sid-1.com) to
 * perform iterative search, read, and ranking over the Project Gutenberg
 * books index in OpenSearch. SID-1 decides which tools to call and when
 * to stop; this module provides the tool implementations and orchestration.
 *
 * Exports: { runAgentLoop }
 */

const OpenAI = require("openai");
const { Client } = require("@opensearch-project/opensearch");

// OpenSearch client — used by tool implementations to query the "books" index.
// Separate instance from the one in search.js; both read BONSAI_URL.
const client = new Client({ node: process.env.BONSAI_URL });

// OpenAI-compatible client pointed at SID-1's API.
// SID-1 uses the standard chat completions endpoint with tool_calls.
const sidClient = new OpenAI({
  baseURL: "https://api.sid-1.com/v1",
  apiKey: process.env.SID_API_KEY,
});

// Maximum number of SID-1 turns before we force-stop the loop.
// SID-1 typically resolves in 2-5 turns; 8 is a generous upper bound.
const MAX_TURNS = 8;

/**
 * System prompt sent to SID-1 on every request.
 *
 * SID-1 reads tool definitions from the system prompt, NOT from the API
 * tools field (which only carries a dummy stub to activate the parser).
 * The prompt describes the corpus, the four available tools with their
 * argument schemas, and the expected interaction pattern (search → read
 * → report_helpful_ids).
 *
 * Based on the recommended prompt structure from the SID-1 documentation
 * at https://docs.sid.ai, adapted for the books corpus.
 */
const SYSTEM_PROMPT = `
You are a research librarian searching a corpus of ~70,000 Project Gutenberg books.
Each book has: title, author_names, summaries, subjects, bookshelves, languages, media_type, and download_count.

Steps:
1. Reflect on what information is needed to answer the question and use the search tools to find documents. Each document has an id.
2. Repeat step 1 until all documents necessary and sufficient to answer the question have been found. Take as many turns and searches as needed – you can make multiple searches per turn! Most questions will require multiple turns. Most questions require at least 5-8 search requests. Many will need more.
3. Use the report_helpful_ids tool to report the most helpful document ids. List the most helpful document ids first (important!).

The interaction ends once report_helpful_ids is called. Every assistant turn should contain a tool call: use search/read tools while gathering evidence, and use report_helpful_ids for the final ranked IDs. You will be scored based on whether you have found all the documents and whether you reported them in the correct order (NDCG)

You have access to the following tools:

- search: semantic search across book metadata and summaries
  - Arguments: query (required), limit (optional, default 5, max 15)
- text_search: full-text search supporting quoted phrases and Boolean operators (AND, OR, NOT, "" for exact phrases, - to exclude)
  - Arguments: query (required), limit (optional, default 5, max 15)
- read: fetch complete metadata and summary for one book by its ID
  - Arguments: id (required)
- report_helpful_ids: report ranked list of book IDs (most relevant first)
  - Arguments: ids (required, list of strings)

To use a tool, enclose it within <tool_call> tags with a Python dictionary containing "name" and "arguments". For example:

<tool_call>
{"name": "search", "arguments": {"query": "novels about time travel in Victorian England", "limit": 5}}
</tool_call>

The semantic search tool will match things that are conceptually related or use synonyms. You can write long queries describing the book you want precisely with this tool.

<tool_call>
{"name": "text_search", "arguments": {"query": "\"Jane Austen\" -\"Pride and Prejudice\""}}
</tool_call>

For text_search queries, you can use \\"\\\" (escaped double quotes) to find exact matches for a term. You can also use a - to exclude terms.

Both search tools return snippets (relevant excerpts) rather than full documents. Snippets show the most relevant portion of the book's metadata based on your query.
To read the full metadata and summary, use the read tool with the book's ID from your search results.

<tool_call>
{"name": "read", "arguments": {"id": "84"}}
</tool_call>

After you've found all relevant books, report the helpful IDs:

<tool_call>
{"name": "report_helpful_ids", "arguments": {"ids": ["84", "1342", "11"]}}
</tool_call>
`;

/**
 * Dummy tools array passed to the SID-1 API.
 *
 * SID-1 ignores the contents of the tools field — it only uses it as a
 * signal to activate tool-call parsing in the response. The actual tool
 * definitions live in the system prompt above. A single stub entry with
 * any name is sufficient. See: https://docs.sid.ai/docs/reference/tools
 */
const tools = [{ type: "function", function: { name: "dummy" } }];

/**
 * OpenSearch fields used by the search and text_search tools.
 *
 * Boosted fields (title^3, summaries^2, author_names^2) ensure that
 * matches in the most identifying fields score higher. Both the stemmed
 * (analyze_english) and precise (possessive-only) field variants are
 * included so that cross_fields queries benefit from both recall and
 * phrase accuracy.
 */
const SEARCH_FIELDS = [
  "title^3",
  "title_precise^3",
  "summaries^2",
  "summaries_precise^2",
  "author_names^2",
  "subjects",
  "bookshelves",
];

/**
 * Fields from which snippet content is drawn when formatting search
 * results for SID-1. These are the human-readable metadata fields
 * (without boost suffixes or precise variants).
 */
const SNIPPET_FIELDS = [
  "title",
  "author_names",
  "summaries",
  "subjects",
  "bookshelves",
];

/**
 * Escapes a string for safe inclusion in XML attributes and content.
 *
 * @param {string} s - Raw string to escape.
 * @returns {string} XML-safe string with &, <, >, " replaced by entities.
 */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Truncates text to a maximum number of whitespace-delimited words.
 *
 * @param {string} text     - Input text.
 * @param {number} maxWords - Maximum word count.
 * @returns {string} Original text if within limit, otherwise truncated
 *                   with a trailing "...".
 */
function truncateWords(text, maxWords) {
  var words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

/**
 * Formats an array of document objects into SID-1's expected XML format.
 *
 * SID-1 uses <doc id="..." title="...">content</doc> blocks to track
 * documents across turns. The id attribute is the stable identifier
 * (gutenberg_id) that SID-1 references in read() and report_helpful_ids().
 *
 * @param {Array<{id: string, title: string, content: string}>} docs
 *   Array of document objects with id, title, and content fields.
 * @returns {string} Newline-concatenated XML doc blocks.
 */
function formatDocsXml(docs) {
  return docs
    .map(function (doc) {
      return (
        '<doc id="' +
        escapeXml(doc.id) +
        '" title="' +
        escapeXml(doc.title || "") +
        '">\n' +
        doc.content +
        "\n</doc>"
      );
    })
    .join("\n");
}

/**
 * Converts OpenSearch hit objects into snippet documents for SID-1.
 *
 * Extracts key metadata fields from each hit's _source and formats them
 * as a condensed text snippet (~50 words of summary). These snippets give
 * SID-1 enough context to decide whether to read() the full document or
 * refine its search.
 *
 * @param {Array<Object>} hits - OpenSearch hit objects (from resp.body.hits.hits).
 * @returns {Array<{id: string, title: string, content: string}>}
 *   Snippet documents ready for formatDocsXml().
 */
function hitsToSnippetDocs(hits) {
  return hits.map(function (hit) {
    var src = hit._source;
    var parts = [];
    if (src.author_names && src.author_names.length) {
      parts.push("Authors: " + [].concat(src.author_names).join(", "));
    }
    if (src.subjects && src.subjects.length) {
      parts.push("Subjects: " + [].concat(src.subjects).slice(0, 5).join(", "));
    }
    if (src.bookshelves && src.bookshelves.length) {
      parts.push("Bookshelves: " + [].concat(src.bookshelves).join(", "));
    }
    if (src.languages && src.languages.length) {
      parts.push("Languages: " + [].concat(src.languages).join(", "));
    }
    if (src.download_count != null) {
      parts.push("Downloads: " + src.download_count);
    }
    var summaries = [].concat(src.summaries || []);
    if (summaries.length) {
      parts.push("Summary: " + truncateWords(summaries[0], 50));
    }
    return {
      id: String(src.gutenberg_id),
      title: src.title || "",
      content: parts.join("\n"),
    };
  });
}

/**
 * Builds an OpenSearch query body for a BM25 cross-field search.
 *
 * Used by the "search" tool. Produces a multi_match (cross_fields) query
 * across boosted metadata fields. This is BM25-based, not vector — the
 * index has a 768-dim summaries_embedding field that could enable true
 * semantic search, but that would require an embedding model at query time.
 *
 * @param {string} query - Free-text search query (authored by SID-1).
 * @param {number} limit - Max results to return (clamped to 1–15).
 * @returns {Object} OpenSearch request body (size, query, _source).
 */
function buildSearchBody(query, limit) {
  return {
    size: Math.min(Math.max(limit || 5, 1), 15),
    query: {
      multi_match: {
        query: query,
        type: "cross_fields",
        fields: SEARCH_FIELDS,
      },
    },
    _source: { excludes: ["summaries_embedding", "page"] },
  };
}

/**
 * Builds an OpenSearch query body for a Lucene query_string search.
 *
 * Used by the "text_search" tool. Supports Boolean operators (AND, OR, NOT),
 * quoted phrase matching ("..."), field targeting, and term exclusion (-term).
 * SID-1 constructs these queries itself — the query text is passed through
 * verbatim. We intentionally do NOT downgrade to simple_query_string because
 * SID-1 may rely on full Lucene syntax features.
 *
 * @param {string} query - Lucene query string (authored by SID-1).
 * @param {number} limit - Max results to return (clamped to 1–15).
 * @returns {Object} OpenSearch request body (size, query, _source).
 */
function buildTextSearchBody(query, limit) {
  return {
    size: Math.min(Math.max(limit || 5, 1), 15),
    query: {
      query_string: {
        query: query,
        fields: SEARCH_FIELDS,
        default_operator: "AND",
      },
    },
    _source: { excludes: ["summaries_embedding", "page"] },
  };
}

/**
 * Parses a single OpenSearch response (from _search or an _msearch sub-response)
 * into the {text, meta} format expected by tool result handling.
 *
 * Extracts total hits, latency, and top IDs as metadata for the workflow sidebar.
 * Formats hit documents as XML snippets for SID-1. Handles error sub-responses
 * from _msearch where the response may contain an `error` field instead of `hits`.
 *
 * @param {Object} respBody     - The OpenSearch response body (or msearch sub-response).
 * @param {string} emptyMessage - Message to return when no documents match.
 * @returns {{text: string, meta: Object|null}}
 *   text: XML doc blocks or error/empty message for SID-1.
 *   meta: { totalHits, tookMs, topIds } on success, null on error.
 */
function parseSearchResponse(respBody, emptyMessage) {
  if (respBody.error) {
    var errMsg = respBody.error.reason || JSON.stringify(respBody.error);
    return { text: "Search error: " + errMsg, meta: null };
  }
  var hits = respBody.hits.hits;
  var total = respBody.hits.total;
  var totalCount = typeof total === "object" ? total.value : total;
  var took = respBody.took;
  var topIds = hits.map(function (h) {
    return String(h._source.gutenberg_id);
  });
  var meta = { totalHits: totalCount, tookMs: took, topIds: topIds };
  if (!hits.length) return { text: emptyMessage, meta: meta };
  return { text: formatDocsXml(hitsToSnippetDocs(hits)), meta: meta };
}

/**
 * Executes all tool calls for a single SID-1 turn, batching search queries.
 *
 * Collects all "search" and "text_search" tool calls and executes them in a
 * single OpenSearch _msearch request instead of individual queries. This
 * reduces HTTP round-trips — SID-1 typically issues 2-5 search calls per turn.
 * Non-search tool calls (read, report_helpful_ids) are executed individually
 * via Promise.all in parallel with the msearch request.
 *
 * Results are returned in the same order as the input tool calls.
 *
 * @param {Array<Object>} tcs - Tool call objects from SID-1's response
 *   (each has .id, .function.name, .function.arguments).
 * @returns {Promise<Array<{toolCallId: string, name: string, args: Object,
 *   text: string, meta: Object|null, shouldStop: boolean}>>}
 *   Array of results in the same order as the input tool calls.
 */
async function executeTurnToolCalls(tcs) {
  // Parse all arguments upfront
  var parsed = tcs.map(function (tc) {
    var args;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch (e) {
      args = null;
    }
    return { tc: tc, name: tc.function.name, args: args };
  });

  // Identify which tool calls can be batched into _msearch
  var msearchEntries = []; // [{index, body, emptyMessage}]
  var msearchIndices = []; // original indices into `parsed`
  var otherPromises = []; // [{index, promise}]

  parsed.forEach(function (p, i) {
    if (p.args === null) {
      // JSON parse error — return inline, no async needed
      return;
    }
    if (p.name === "search") {
      msearchEntries.push({
        body: buildSearchBody(p.args.query, p.args.limit),
        emptyMessage: "No documents matched the query. Try different search terms.",
      });
      msearchIndices.push(i);
    } else if (p.name === "text_search") {
      msearchEntries.push({
        body: buildTextSearchBody(p.args.query, p.args.limit),
        emptyMessage: "No documents matched the query. Try broader or different search terms. Check query syntax — this tool supports Lucene query syntax.",
      });
      msearchIndices.push(i);
    } else if (p.name === "read") {
      otherPromises.push({ index: i, promise: toolRead(p.args.id) });
    }
    // report_helpful_ids and unknown tools need no async work
  });

  // Execute _msearch and other tool calls in parallel
  var msearchPromise = null;
  if (msearchEntries.length > 0) {
    var msearchBody = [];
    msearchEntries.forEach(function (entry) {
      msearchBody.push({ index: "books" });
      msearchBody.push(entry.body);
    });
    msearchPromise = client.msearch({ body: msearchBody }).catch(function (err) {
      return { error: err };
    });
  }

  var otherResults = {};
  var allOther = otherPromises.map(function (op) {
    return op.promise.then(function (text) {
      otherResults[op.index] = text;
    });
  });

  // Wait for everything
  var settled = await Promise.all(
    [msearchPromise].concat(allOther),
  );

  var msearchResp = settled[0];

  // Build the results array in original order
  var results = parsed.map(function (p, i) {
    // JSON parse error
    if (p.args === null) {
      return {
        toolCallId: p.tc.id,
        name: p.name,
        args: {},
        text: "Invalid JSON in tool arguments.",
        meta: null,
        shouldStop: false,
      };
    }

    // Search tools — pull from msearch response
    if (p.name === "search" || p.name === "text_search") {
      var msIdx = msearchIndices.indexOf(i);
      var entry = msearchEntries[msIdx];
      // If the entire msearch request failed
      if (msearchResp && msearchResp.error) {
        return {
          toolCallId: p.tc.id,
          name: p.name,
          args: p.args,
          text: "Search error: " + msearchResp.error.message,
          meta: null,
          shouldStop: false,
        };
      }
      var subResp = msearchResp.body.responses[msIdx];
      var result = parseSearchResponse(subResp, entry.emptyMessage);
      return {
        toolCallId: p.tc.id,
        name: p.name,
        args: p.args,
        text: result.text,
        meta: result.meta,
        shouldStop: false,
      };
    }

    // Read tool
    if (p.name === "read") {
      return {
        toolCallId: p.tc.id,
        name: p.name,
        args: p.args,
        text: otherResults[i] || "Read error: no result.",
        meta: null,
        shouldStop: false,
      };
    }

    // report_helpful_ids — terminates the loop
    if (p.name === "report_helpful_ids") {
      return {
        toolCallId: p.tc.id,
        name: p.name,
        args: p.args,
        text: JSON.stringify(p.args.ids),
        meta: null,
        shouldStop: true,
      };
    }

    // Unknown tool
    return {
      toolCallId: p.tc.id,
      name: p.name,
      args: p.args,
      text: "Unknown tool: " + p.name,
      meta: null,
      shouldStop: false,
    };
  });

  return results;
}

/**
 * Tool: read — Fetch full metadata and summary for a single book by ID.
 *
 * Looks up a book by its gutenberg_id using a term query (exact match).
 * Returns all metadata fields plus the full summary text, truncated to
 * ~3000 words to stay within SID-1's context budget. This gives SID-1
 * deep detail on a specific book after seeing it in search snippets.
 *
 * @param {string} id - The gutenberg_id of the book to read.
 * @returns {Promise<string>} XML doc block with full metadata, or an
 *   error/not-found message as plain text.
 */
async function toolRead(id) {
  try {
    var resp = await client.search({
      index: "books",
      body: {
        size: 1,
        query: { term: { gutenberg_id: id } },
        _source: { excludes: ["summaries_embedding", "page"] },
      },
    });
    var hits = resp.body.hits.hits;
    if (!hits.length) return "No document found with id " + id + ".";
    var src = hits[0]._source;
    var parts = [];
    parts.push("Title: " + (src.title || "Unknown"));
    if (src.author_names && src.author_names.length) {
      parts.push("Authors: " + [].concat(src.author_names).join(", "));
    }
    if (src.editor_names && src.editor_names.length) {
      parts.push("Editors: " + [].concat(src.editor_names).join(", "));
    }
    if (src.translator_names && src.translator_names.length) {
      parts.push("Translators: " + [].concat(src.translator_names).join(", "));
    }
    if (src.subjects && src.subjects.length) {
      parts.push("Subjects: " + [].concat(src.subjects).join(", "));
    }
    if (src.bookshelves && src.bookshelves.length) {
      parts.push("Bookshelves: " + [].concat(src.bookshelves).join(", "));
    }
    if (src.languages && src.languages.length) {
      parts.push("Languages: " + [].concat(src.languages).join(", "));
    }
    if (src.media_type) parts.push("Media Type: " + src.media_type);
    if (src.copyright != null)
      parts.push(
        "Copyright: " + (src.copyright ? "Yes" : "No (Public Domain)"),
      );
    if (src.download_count != null)
      parts.push("Downloads: " + src.download_count);
    var summaries = [].concat(src.summaries || []);
    if (summaries.length) {
      var fullSummary = summaries.join("\n\n");
      parts.push("Summary:\n" + truncateWords(fullSummary, 3000));
    }
    return formatDocsXml([
      {
        id: String(src.gutenberg_id),
        title: src.title || "",
        content: parts.join("\n"),
      },
    ]);
  } catch (err) {
    return "Read error: " + err.message;
  }
}

/**
 * Generates the turn-budget notice appended to the last tool message each turn.
 *
 * SID-1 uses this to know how many turns remain before it must call
 * report_helpful_ids. On the final available turn, an explicit warning
 * forces SID-1 to report rather than search again. This follows the
 * recommended pattern from the SID-1 docs (build/loop#turn-budget).
 *
 * @param {number} turnsLeft - Number of turns remaining after the current one.
 * @returns {string} Notice string to append to the last tool message content.
 */
function turnBudgetNotice(turnsLeft) {
  var notice =
    "\n\nYou have " + turnsLeft + " out of " + MAX_TURNS + " turns left.";
  if (turnsLeft === 1) {
    notice += " You must call `report_helpful_ids` in the next turn.";
  }
  return notice;
}

/**
 * Fetches full book records by gutenberg_id, preserving SID-1's rank order.
 *
 * After SID-1 calls report_helpful_ids with a ranked list of IDs, this
 * function bulk-fetches the corresponding _source documents from OpenSearch
 * using a terms query. The results are then reordered to match SID-1's
 * original ranking (most relevant first), since OpenSearch terms queries
 * don't guarantee order. IDs that don't match any document are silently
 * dropped.
 *
 * @param {string[]} ids - Gutenberg IDs in SID-1's ranked order.
 * @returns {Promise<Object[]>} Array of _source objects in rank order,
 *   or empty array on error.
 */
async function fetchBooksByIds(ids) {
  if (!ids.length) return [];
  try {
    var numericIds = ids
      .map(function (id) {
        return parseInt(id, 10);
      })
      .filter(function (n) {
        return !isNaN(n);
      });
    var resp = await client.search({
      index: "books",
      body: {
        size: numericIds.length,
        query: { terms: { gutenberg_id: numericIds } },
        _source: { excludes: ["summaries_embedding", "page"] },
      },
    });
    var hitMap = {};
    resp.body.hits.hits.forEach(function (hit) {
      hitMap[String(hit._source.gutenberg_id)] = hit._source;
    });
    // Preserve SID's rank order
    return ids
      .filter(function (id) {
        return hitMap[id];
      })
      .map(function (id) {
        return hitMap[id];
      });
  } catch (err) {
    return [];
  }
}

/**
 * Runs the SID-1 agentic retrieval loop for a user query.
 *
 * Orchestrates a multi-turn conversation with SID-1 where each turn:
 *   1. Sends the accumulated message history to SID-1
 *   2. Receives tool_calls (search, text_search, read, or report_helpful_ids)
 *   3. Executes tool calls — search/text_search batched via _msearch, others in parallel
 *   4. Appends tool results (as <doc> XML) back to the message history
 *   5. Appends a turn-budget notice to the last tool message
 *   6. Repeats until report_helpful_ids is called or MAX_TURNS is reached
 *
 * Progress is streamed to the client via SSE events through the emit callback:
 *   - "progress" {turn, maxTurns, status:"thinking"}  — SID-1 is generating
 *   - "progress" {turn, maxTurns, status:"tools", tools, toolCalls} — tools dispatched
 *   - "tool_results" {turn, calls:[{name, args, meta}]} — tools completed with metadata
 *   - "results" {books, ids} — final ranked results
 *   - "error_event" {message} — unrecoverable error
 *
 * After report_helpful_ids, the reported IDs are bulk-fetched from OpenSearch
 * and formatted using the books dataset display config (title, image, link,
 * snippet, subtitles, tags) for client-side rendering.
 *
 * @param {string} query       - The user's research question.
 * @param {function} emit      - SSE emitter: emit(eventName, dataObject).
 * @param {function} isAborted - Returns true if the client has disconnected
 *                               (checked between turns and after tool execution).
 * @returns {Promise<void>} Resolves when the loop completes or is aborted.
 */
async function runAgentLoop(query, emit, isAborted) {
  var messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: query },
  ];

  var reportedIds = null;
  var totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (var turn = 0; turn < MAX_TURNS; turn++) {
    if (isAborted()) return;

    // Notify client that SID-1 is generating its next response
    emit("progress", {
      turn: turn + 1,
      maxTurns: MAX_TURNS,
      status: "thinking",
    });

    // Call SID-1 chat completions API
    var response;
    try {
      response = await sidClient.chat.completions.create({
        model: "sid-1",
        messages: messages,
        tools: tools,
      });
    } catch (err) {
      emit("error_event", { message: "SID-1 API error: " + err.message });
      return;
    }

    if (isAborted()) return;

    var assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    // Extract token usage from this turn's API response
    var turnUsage = null;
    if (response.usage) {
      turnUsage = {
        promptTokens: response.usage.prompt_tokens || 0,
        completionTokens: response.usage.completion_tokens || 0,
        totalTokens: response.usage.total_tokens || 0,
      };
      totalUsage.promptTokens += turnUsage.promptTokens;
      totalUsage.completionTokens += turnUsage.completionTokens;
      totalUsage.totalTokens += turnUsage.totalTokens;
    }

    // SID-1 should always return tool calls — no tool calls is an error
    if (!assistantMsg.tool_calls || !assistantMsg.tool_calls.length) {
      emit("error_event", {
        message:
          "SID-1 returned no tool calls on turn " +
          (turn + 1) +
          ". This is unexpected.",
      });
      return;
    }

    // Parse tool call arguments for the progress event (pre-execution)
    var toolCalls = assistantMsg.tool_calls.map(function (tc) {
      var args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        args = {};
      }
      return { name: tc.function.name, args: args };
    });
    emit("progress", {
      turn: turn + 1,
      maxTurns: MAX_TURNS,
      status: "tools",
      tools: toolCalls.map(function (t) {
        return t.name;
      }),
      toolCalls: toolCalls,
    });

    // Execute tool calls — search/text_search batched via _msearch, others in parallel
    var results = await executeTurnToolCalls(assistantMsg.tool_calls);

    if (isAborted()) return;

    // Emit post-execution metadata (totalHits, tookMs, topIds, token usage) for the workflow sidebar
    emit("tool_results", {
      turn: turn + 1,
      usage: turnUsage,
      calls: results.map(function (r) {
        return { name: r.name, args: r.args, meta: r.meta || null };
      }),
    });

    // Append tool results to the message history for the next SID-1 turn
    var lastToolMessage = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var toolMessage = {
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.text,
      };
      messages.push(toolMessage);
      lastToolMessage = toolMessage;
      if (r.shouldStop) {
        reportedIds = r.args.ids;
      }
    }

    if (reportedIds !== null) break;

    // Append turn-budget notice to the last tool message so SID-1 knows
    // how many turns remain before it must call report_helpful_ids
    var turnsLeft = MAX_TURNS - (turn + 1);
    if (turnsLeft >= 1 && lastToolMessage) {
      lastToolMessage.content += turnBudgetNotice(turnsLeft);
    }
  }

  // If SID-1 exhausted all turns without reporting, emit an error
  if (!reportedIds) {
    emit("error_event", {
      message:
        "SID-1 exhausted all " +
        MAX_TURNS +
        " turns without reporting results.",
    });
    return;
  }

  // Bulk-fetch the reported books and format for display using the
  // books dataset config (same display functions as the standard search)
  var books = await fetchBooksByIds(reportedIds);
  var booksConfig = require("./datasets/books");
  var displayBooks = books.map(function (src) {
    var img =
      booksConfig.display.image(src) || booksConfig.display.imageFallback;
    var snippet = booksConfig.display.snippet
      ? booksConfig.display.snippet(src)
      : null;
    var link = booksConfig.display.linkTemplate(src);
    var title = src[booksConfig.display.titleField];
    var subtitles = booksConfig.display.subtitleFields
      .map(function (sf) {
        return sf.value(src);
      })
      .filter(Boolean);
    var tags = [];
    booksConfig.display.tags.forEach(function (tagFn) {
      var tagVal = tagFn(src);
      []
        .concat(tagVal || [])
        .filter(function (t) {
          return t != null;
        })
        .forEach(function (t) {
          tags.push(t);
        });
    });
    return {
      title: title,
      link: link,
      img: img,
      snippet: snippet,
      subtitles: subtitles,
      tags: tags,
    };
  });

  emit("results", { books: displayBooks, ids: reportedIds, usage: totalUsage });
}

module.exports = { runAgentLoop };

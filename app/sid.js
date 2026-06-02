const OpenAI = require("openai");
const { Client } = require("@opensearch-project/opensearch");

const client = new Client({ node: process.env.BONSAI_URL });

const sidClient = new OpenAI({
  baseURL: "https://api.sid-1.com/v1",
  apiKey: process.env.SID_API_KEY,
});

const MAX_TURNS = 8;

const SYSTEM_PROMPT = `
You are a research librarian searching a corpus of ~70,000 Project Gutenberg books.
Each book has: title, author_names, summaries, subjects, bookshelves, languages,
media_type, and download_count.

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

const tools = [{ type: "function", function: { name: "dummy" } }];

const SEARCH_FIELDS = [
  "title^3",
  "title_precise^3",
  "summaries^2",
  "summaries_precise^2",
  "author_names^2",
  "subjects",
  "bookshelves",
];

const SNIPPET_FIELDS = ["title", "author_names", "summaries", "subjects", "bookshelves"];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateWords(text, maxWords) {
  var words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

function formatDocsXml(docs) {
  return docs
    .map(function (doc) {
      return '<doc id="' + escapeXml(doc.id) + '" title="' + escapeXml(doc.title || "") + '">\n' + doc.content + "\n</doc>";
    })
    .join("\n");
}

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

async function toolSearch(query, limit) {
  limit = Math.min(Math.max(limit || 5, 1), 15);
  try {
    var resp = await client.search({
      index: "books",
      body: {
        size: limit,
        query: {
          multi_match: {
            query: query,
            type: "cross_fields",
            fields: SEARCH_FIELDS,
          },
        },
        _source: { excludes: ["summaries_embedding", "page"] },
      },
    });
    var hits = resp.body.hits.hits;
    var total = resp.body.hits.total;
    var totalCount = (typeof total === "object") ? total.value : total;
    var took = resp.body.took;
    var topIds = hits.map(function (h) { return String(h._source.gutenberg_id); });
    var meta = { totalHits: totalCount, tookMs: took, topIds: topIds };
    if (!hits.length) return { text: "No documents matched the query. Try different search terms.", meta: meta };
    return { text: formatDocsXml(hitsToSnippetDocs(hits)), meta: meta };
  } catch (err) {
    return { text: "Search error: " + err.message, meta: null };
  }
}

async function toolTextSearch(query, limit) {
  limit = Math.min(Math.max(limit || 5, 1), 15);
  try {
    var resp = await client.search({
      index: "books",
      body: {
        size: limit,
        query: {
          query_string: {
            query: query,
            fields: SEARCH_FIELDS,
            default_operator: "AND",
          },
        },
        _source: { excludes: ["summaries_embedding", "page"] },
      },
    });
    var hits = resp.body.hits.hits;
    var total = resp.body.hits.total;
    var totalCount = (typeof total === "object") ? total.value : total;
    var took = resp.body.took;
    var topIds = hits.map(function (h) { return String(h._source.gutenberg_id); });
    var meta = { totalHits: totalCount, tookMs: took, topIds: topIds };
    if (!hits.length) return { text: "No documents matched the query. Try broader or different search terms.", meta: meta };
    return { text: formatDocsXml(hitsToSnippetDocs(hits)), meta: meta };
  } catch (err) {
    return { text: "Search error: " + err.message + ". Check query syntax — this tool supports Lucene query syntax.", meta: null };
  }
}

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
    if (src.copyright != null) parts.push("Copyright: " + (src.copyright ? "Yes" : "No (Public Domain)"));
    if (src.download_count != null) parts.push("Downloads: " + src.download_count);
    var summaries = [].concat(src.summaries || []);
    if (summaries.length) {
      var fullSummary = summaries.join("\n\n");
      parts.push("Summary:\n" + truncateWords(fullSummary, 3000));
    }
    return formatDocsXml([{
      id: String(src.gutenberg_id),
      title: src.title || "",
      content: parts.join("\n"),
    }]);
  } catch (err) {
    return "Read error: " + err.message;
  }
}

async function executeToolCall(tc) {
  var name = tc.function.name;
  var args;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch (e) {
    return { toolCallId: tc.id, name: name, args: {}, text: "Invalid JSON in tool arguments: " + e.message, shouldStop: false };
  }

  if (name === "search") {
    var result = await toolSearch(args.query, args.limit);
    return { toolCallId: tc.id, name: name, args: args, text: result.text, meta: result.meta, shouldStop: false };
  }
  if (name === "text_search") {
    var result = await toolTextSearch(args.query, args.limit);
    return { toolCallId: tc.id, name: name, args: args, text: result.text, meta: result.meta, shouldStop: false };
  }
  if (name === "read") {
    var text = await toolRead(args.id);
    return { toolCallId: tc.id, name: name, args: args, text: text, meta: null, shouldStop: false };
  }
  if (name === "report_helpful_ids") {
    return { toolCallId: tc.id, name: name, args: args, text: JSON.stringify(args.ids), shouldStop: true };
  }
  return { toolCallId: tc.id, name: name, args: args, text: "Unknown tool: " + name, shouldStop: false };
}

function turnBudgetNotice(turnsLeft) {
  var notice = "\n\nYou have " + turnsLeft + " out of " + MAX_TURNS + " turns left.";
  if (turnsLeft === 1) {
    notice += " You must call `report_helpful_ids` in the next turn.";
  }
  return notice;
}

async function fetchBooksByIds(ids) {
  if (!ids.length) return [];
  try {
    var numericIds = ids.map(function (id) { return parseInt(id, 10); }).filter(function (n) { return !isNaN(n); });
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
      .filter(function (id) { return hitMap[id]; })
      .map(function (id) { return hitMap[id]; });
  } catch (err) {
    return [];
  }
}

async function runAgentLoop(query, emit, isAborted) {
  var messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: query },
  ];

  var reportedIds = null;

  for (var turn = 0; turn < MAX_TURNS; turn++) {
    if (isAborted()) return;

    emit("progress", { turn: turn + 1, maxTurns: MAX_TURNS, status: "thinking" });

    var response;
    try {
      response = await sidClient.chat.completions.create({ model: "sid-1", messages: messages, tools: tools });
    } catch (err) {
      emit("error_event", { message: "SID-1 API error: " + err.message });
      return;
    }

    if (isAborted()) return;

    var assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || !assistantMsg.tool_calls.length) {
      emit("error_event", { message: "SID-1 returned no tool calls on turn " + (turn + 1) + ". This is unexpected." });
      return;
    }

    var toolCalls = assistantMsg.tool_calls.map(function (tc) {
      var args;
      try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }
      return { name: tc.function.name, args: args };
    });
    emit("progress", {
      turn: turn + 1,
      maxTurns: MAX_TURNS,
      status: "tools",
      tools: toolCalls.map(function (t) { return t.name; }),
      toolCalls: toolCalls,
    });

    var results = await Promise.all(assistantMsg.tool_calls.map(executeToolCall));

    if (isAborted()) return;

    emit("tool_results", {
      turn: turn + 1,
      calls: results.map(function (r) {
        return { name: r.name, args: r.args, meta: r.meta || null };
      }),
    });

    var lastToolMessage = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var toolMessage = { role: "tool", tool_call_id: r.toolCallId, content: r.text };
      messages.push(toolMessage);
      lastToolMessage = toolMessage;
      if (r.shouldStop) {
        reportedIds = r.args.ids;
      }
    }

    if (reportedIds !== null) break;

    var turnsLeft = MAX_TURNS - (turn + 1);
    if (turnsLeft >= 1 && lastToolMessage) {
      lastToolMessage.content += turnBudgetNotice(turnsLeft);
    }
  }

  if (!reportedIds) {
    emit("error_event", { message: "SID-1 exhausted all " + MAX_TURNS + " turns without reporting results." });
    return;
  }

  var books = await fetchBooksByIds(reportedIds);
  var booksConfig = require("./datasets/books");
  var displayBooks = books.map(function (src) {
    var img = booksConfig.display.image(src) || booksConfig.display.imageFallback;
    var snippet = booksConfig.display.snippet ? booksConfig.display.snippet(src) : null;
    var link = booksConfig.display.linkTemplate(src);
    var title = src[booksConfig.display.titleField];
    var subtitles = booksConfig.display.subtitleFields
      .map(function (sf) { return sf.value(src); })
      .filter(Boolean);
    var tags = [];
    booksConfig.display.tags.forEach(function (tagFn) {
      var tagVal = tagFn(src);
      [].concat(tagVal || []).filter(function (t) { return t != null; }).forEach(function (t) {
        tags.push(t);
      });
    });
    return { title: title, link: link, img: img, snippet: snippet, subtitles: subtitles, tags: tags };
  });

  emit("results", { books: displayBooks, ids: reportedIds });
}

module.exports = { runAgentLoop };

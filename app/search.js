const { Client } = require("@opensearch-project/opensearch");
const client = new Client({ node: process.env.BONSAI_URL });

// Datasets may live on another cluster (config.url); one client per URL.
const clients = {};
const getClient = function (config) {
  if (!config || !config.url) return client;
  if (!clients[config.url])
    clients[config.url] = new Client({ node: config.url });
  return clients[config.url];
};

// Vector field used for similarity: top-level for knn datasets, the kNN
// subquery's field for hybrid ones.
const knnField = function (config) {
  return config.query.knn ? config.query.knn.field : config.query.field;
};

const sourceFilter = function (config) {
  return (
    config.query.sourceIncludes || {
      excludes: config.query.sourceExcludes || [],
    }
  );
};

// Documents a dataset never returns (config.query.exclude, must_not clauses),
// as one filter clause; null when there are none.
const exclusionFilter = function (config) {
  var exclude = config.query.exclude;
  return exclude && exclude.length ? { bool: { must_not: exclude } } : null;
};

// Build a kNN vector-search body. OpenSearch needs k >= from + size; a fixed
// paginationDepth keeps the candidate pool (and so the ranking) stable across pages.
const getKnnQuery = function (config, vector, size, from) {
  var field = knnField(config);
  var k = config.query.paginationDepth || (from || 0) + size;
  var body = {
    size: size,
    from: from || 0,
    query: {
      knn: {
        [field]: { vector: vector, k: k },
      },
    },
    _source: sourceFilter(config),
  };
  var exclusion = exclusionFilter(config);
  if (exclusion) body.query.knn[field].filter = exclusion;
  return body;
};

// Aggregation requests from config.aggregations.
const buildAggs = function (config) {
  var aggs = {};
  config.aggregations.forEach(function (agg) {
    if (agg.type === "terms") {
      aggs[agg.name] = { terms: { field: agg.field } };
      if (agg.size) aggs[agg.name].terms.size = agg.size;
    } else if (agg.type === "range") {
      aggs[agg.name] = {
        range: { field: agg.field, ranges: agg.ranges },
      };
    } else if (agg.type === "histogram") {
      aggs[agg.name] = {
        histogram: { field: agg.field, interval: agg.filterInterval },
      };
    }
  });
  return aggs;
};

// Hybrid lexical + kNN query, run through a search pipeline that normalizes and
// combines subquery scores. Hybrid can't sit inside a bool and 2.19 has no
// hybrid-level filter, so filters are pushed into each subquery.
const getHybridQuery = function (config, querystring, size, filters, from) {
  var q = config.query;
  var filterClauses = buildFilterClauses(config, filters);

  var lexical = {
    multi_match: { query: querystring, fields: q.lexical.fields },
  };
  var lexicalFilters = (q.lexical.filter || []).concat(filterClauses);
  if (lexicalFilters.length) {
    lexical = { bool: { must: lexical, filter: lexicalFilters } };
  }
  var knn = { vector: querystring, k: q.knn.k };
  if (filterClauses.length) {
    knn.filter = { bool: { filter: filterClauses } };
  }

  return {
    size: size,
    from: from || 0,
    _source: q.sourceIncludes,
    query: {
      hybrid: {
        pagination_depth: q.paginationDepth,
        queries: [lexical, { knn: { [q.knn.field]: knn } }],
      },
    },
    aggs: buildAggs(config),
  };
};

// ANN results can differ between replicas, which shuffles items across pages.
// A stable preference pins every page of one query to the same shard copies.
// Prefixed because preferences starting with "_" are reserved.
const preferenceFor = function (key) {
  return "q:" + key;
};

// Results can't go past paginationDepth; trim the last page to fit.
const pageSize = function (config, k, from) {
  var depth = config.query.paginationDepth;
  return depth ? Math.min(k, depth - (from || 0)) : k;
};

const emptyResults = function () {
  return {
    body: {
      hits: { hits: [], total: { value: 0 } },
      took: 0,
      aggregations: {},
    },
  };
};

// kNN hits.total counts candidates across segments (up to k per segment), not
// the k results actually reachable; clamp it to what pagination can show.
const capKnnTotal = function (config, resp) {
  var depth = config.query.paginationDepth;
  var total = resp.body.hits.total;
  if (depth && total && total.value > depth) {
    resp.body.hits.total = { value: depth, relation: "eq" };
  }
  return resp;
};

const getQuery = function (config, querystring, k, filters, permissions) {
  k = k || 10;
  filters = filters || {};

  // --- build should clauses from config ---
  var shouldClauses = config.query.clauses
    .map(function (clause) {
      if (clause.type === "match_phrase") {
        var mp = { query: querystring, boost: clause.boost };
        if (clause.slop != null) mp.slop = clause.slop;
        return { match_phrase: { [clause.field]: mp } };
      }
      if (clause.type === "multi_match") {
        return {
          multi_match: {
            query: querystring,
            type: clause.matchType,
            fields: clause.fields,
            boost: clause.boost,
          },
        };
      }
      return null;
    })
    .filter(Boolean);

  // --- build core bool query ---
  var boolQuery = { bool: { should: shouldClauses, minimum_should_match: 1 } };

  // --- wrap in function_score if scoreFunction configured ---
  var queryBody;
  if (config.query.scoreFunction) {
    queryBody = {
      function_score: {
        query: boolQuery,
        field_value_factor: {
          field: config.query.scoreFunction.field,
          modifier: config.query.scoreFunction.modifier,
          factor: config.query.scoreFunction.factor,
        },
        boost_mode: config.query.boostMode || "sum",
      },
    };
  } else {
    queryBody = boolQuery;
  }

  var body = {
    size: k,
    query: queryBody,
    _source: { excludes: config.query.sourceExcludes || [] },
    aggs: buildAggs(config),
  };

  var filterClauses = buildFilterClauses(config, filters, permissions);

  // --- attach filters to the bool query ---
  if (filterClauses.length) {
    if (config.query.scoreFunction) {
      body.query.function_score.query.bool.filter = filterClauses;
    } else {
      body.query.bool.filter = filterClauses;
    }
  }

  return body;
};

// Sidebar selections (and optional permissions) as non-scoring filter clauses.
const buildFilterClauses = function (config, filters, permissions) {
  filters = filters || {};

  // --- apply permissions filter ---
  var filterClauses = [];
  if (permissions && permissions.length) {
    filterClauses.push({ terms: { permissions: permissions } });
  }

  var exclusion = exclusionFilter(config);
  if (exclusion) filterClauses.push(exclusion);

  // --- apply filter clauses from sidebar selections ---

  config.aggregations.forEach(function (agg) {
    var vals = filters[agg.name];
    if (!vals || !vals.length) return;

    var filterField = agg.filterField || agg.field;

    if (agg.type === "terms") {
      var coerced = vals;
      if (agg.valueType === "boolean") {
        coerced = vals.map(function (v) {
          return v === "true";
        });
      }
      filterClauses.push({ terms: { [filterField]: coerced } });
    } else if (agg.type === "range" && agg.filterRanges) {
      var rangeShould = vals
        .filter(function (k) {
          return agg.filterRanges[k];
        })
        .map(function (k) {
          return { range: { [filterField]: agg.filterRanges[k] } };
        });
      if (rangeShould.length) {
        filterClauses.push({
          bool: { should: rangeShould, minimum_should_match: 1 },
        });
      }
    } else if (agg.type === "histogram") {
      var interval = agg.filterInterval;
      var histShould = vals
        .map(function (v) {
          return parseInt(v, 10);
        })
        .filter(function (n) {
          return !isNaN(n);
        })
        .map(function (start) {
          return {
            range: { [filterField]: { gte: start, lt: start + interval } },
          };
        });
      if (histShould.length) {
        filterClauses.push({
          bool: { should: histShould, minimum_should_match: 1 },
        });
      }
    }
  });

  return filterClauses;
};

// Image-to-image similarity: use an existing document's stored embedding as the
// query vector. The clicked doc is guaranteed to lead the first page.
const searchSimilar = async function (config, id, k, from) {
  from = from || 0;
  const field = knnField(config);
  const size = pageSize(config, k, from);
  if (size <= 0) return emptyResults();

  const doc = await getClient(config).get({ index: config.index, id: id });
  const src = doc.body._source;
  const vector = src[field];

  const body = getKnnQuery(config, vector, size, from);
  const resp = await getClient(config).search({
    index: config.index,
    body: body,
    preference: preferenceFor(id),
  });

  // Drop the self-match from the neighbor list; on the first page, prepend it
  // explicitly so it always appears first regardless of ANN recall. Its score is
  // the self-match score (1.0 for cosine, 2.0 for innerproduct) when ANN found it.
  var allHits = resp.body.hits.hits || [];
  var self = allHits.find(function (h) {
    return h._id === id;
  });
  var hits = allHits.filter(function (h) {
    return h._id !== id;
  });
  if (from === 0) {
    var clickedSrc = {};
    Object.keys(src).forEach(function (key) {
      if (key !== field) clickedSrc[key] = src[key];
    });
    hits.unshift({
      _id: id,
      _score: self ? self._score : 1.0,
      _source: clickedSrc,
    });
  }
  resp.body.hits.hits = hits.slice(0, size);
  resp.body.similarSource = src;
  return capKnnTotal(config, resp);
};

const search = async function (
  config,
  querystring,
  k,
  filters,
  from,
  permissions,
) {
  var body;
  var params = {};
  var size = pageSize(config, k, from);
  if (size <= 0) return emptyResults();
  if (config.query.type === "hybrid") {
    body = getHybridQuery(config, querystring, size, filters, from);
    params.search_pipeline = config.query.pipeline;
    params.preference = preferenceFor(querystring);
  } else if (config.query.type === "knn") {
    // Raw query text as the vector; the cluster embeds it server-side.
    body = getKnnQuery(config, querystring, size, from);
    params.preference = preferenceFor(querystring);
  } else {
    body = getQuery(config, querystring, k, filters, permissions);
    body.from = from || 0;
  }
  const resp = await getClient(config).search(
    Object.assign(
      {
        index: config.index,
        body: body,
      },
      params,
    ),
  );
  return config.query.type === "knn" ? capKnnTotal(config, resp) : resp;
};

// Pick a random document id from an index (uniform via random_score).
const randomId = async function (index) {
  const resp = await client.search({
    index: index,
    body: {
      size: 1,
      _source: false,
      query: { function_score: { query: { match_all: {} }, random_score: {} } },
    },
  });
  const hits = resp.body.hits.hits || [];
  return hits.length ? hits[0]._id : null;
};

// For a given doc id, return its source doc plus the top-k nearest neighbors
// (excluding the doc itself) within a specific index. Used by the blind compare.
const similarTopK = async function (index, field, id, k) {
  const doc = await client.get({ index: index, id: id });
  const src = doc.body._source;
  const vector = src[field];

  const resp = await client.search({
    index: index,
    body: {
      size: k + 1, // self + k neighbors
      query: { knn: { [field]: { vector: vector, k: k + 1 } } },
      _source: { excludes: [field] },
    },
  });

  const neighbors = (resp.body.hits.hits || [])
    .filter(function (h) {
      return h._id !== id;
    })
    .slice(0, k);

  var sourceSrc = {};
  Object.keys(src).forEach(function (key) {
    if (key !== field) sourceSrc[key] = src[key];
  });

  return { source: { _id: id, _source: sourceSrc }, neighbors: neighbors };
};

// Lucene's _english_ stop list, mirrored so agg `include` regexes match the
// suggest fields, whose analyzers drop these words.
const STOPWORDS = new Set(
  ("a an and are as at be but by for if in into is it no not of on or such " +
    "that the their then there these they this to was will with").split(" "),
);

// Autocomplete, per https://bonsai.io/blog/how-to-really-scale-autocomplete/:
// match_phrase_prefix on a search_as_you_type field picks the top documents,
// and aggregations over just those matches propose completions:
//   phrases  terms on 2–4 word shingles that start with the typed text
//   words    significant_terms completing a single typed word
// The suggest analyzers drop stopwords, leaving a "_" filler in shingles that
// span one ("sunset over _ bay"). Typed stopwords are matched against the
// filler and shown as typed; phrases with a filler after the typed text are
// dropped, since the missing word can't be recovered.
const autocomplete = async function (config, raw) {
  var ac = config.autocomplete;
  var text = String(raw || "").toLowerCase();
  var empty = { query: raw, suggestions: [], docs: [] };
  var typedTokens = text.match(/[\p{L}\p{N}]+/gu) || [];
  var tokens = typedTokens.filter(function (t) {
    return !STOPWORDS.has(t);
  });
  if (!tokens.length || text.trim().length < 2) return empty;

  // A trailing space means the last word is finished: suggest what follows it.
  var finished = /\s$/.test(text);
  var pattern = typedTokens.map(function (t, i) {
    if (!STOPWORDS.has(t)) return t;
    // An unfinished stopword may still grow into a real word ("the" → "theater").
    return !finished && i === typedTokens.length - 1 ? "(_|" + t + ")" : "_";
  });
  var aggs = {
    phrases: {
      terms: {
        field: ac.phraseField,
        include: pattern.join(" ") + (finished ? " .*" : ".*"),
        min_doc_count: ac.minDocCount,
        size: ac.suggestions * 4,
      },
    },
  };
  // Lone words only for a single term: significant_terms has no notion of
  // word order, so "red sp" would complete to unrelated words.
  if (!finished && typedTokens.length === 1) {
    aggs.words = {
      significant_terms: {
        field: ac.wordField,
        include: tokens[0] + ".*",
        min_doc_count: ac.minDocCount,
        size: ac.suggestions,
      },
    };
  }

  var match = {};
  match[ac.completionField] = { query: text.trim() };
  var query = { match_phrase_prefix: match };
  var exclusion = exclusionFilter(config);
  if (exclusion) query = { bool: { must: query, filter: [exclusion] } };
  const resp = await getClient(config).search({
    index: config.index,
    body: {
      size: ac.docs * 3,
      _source: ac.sourceIncludes,
      query: query,
      aggs: aggs,
    },
  });
  var body = resp.body;

  // Show the typed words in place of their fillers; drop phrases with a
  // filler past the typed text. Then drop a longer phrase whose shorter prefix
  // covers the same documents ("red spurfowl galloperdix" under "red spurfowl").
  var phrases = [];
  (body.aggregations.phrases.buckets || [])
    .map(function (b) {
      var words = b.key.split(" ");
      var shown = typedTokens.concat(words.slice(typedTokens.length));
      // An unfinished last word was matched as a prefix: keep the full word.
      var tail = words[typedTokens.length - 1];
      if (!finished && tail !== "_") shown[typedTokens.length - 1] = tail;
      if (shown.indexOf("_") !== -1) return null;
      return { text: shown.join(" "), count: b.doc_count };
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return a.text.length - b.text.length;
    })
    .forEach(function (p) {
      var covered = phrases.some(function (k) {
        return p.text.indexOf(k.text + " ") === 0 && k.count === p.count;
      });
      if (!covered) phrases.push(p);
    });
  var words = ((body.aggregations.words || {}).buckets || []).map(function (b) {
    return { text: b.key, count: b.doc_count };
  });

  var seen = new Set([typedTokens.join(" ")]);
  var suggestions = words
    .concat(phrases)
    .sort(function (a, b) {
      return b.count - a.count;
    })
    .filter(function (s) {
      if (seen.has(s.text)) return false;
      seen.add(s.text);
      return true;
    })
    .slice(0, ac.suggestions);

  // Many Commons files share a caption; show each title once.
  var titles = new Set();
  var docs = [];
  (body.hits.hits || []).forEach(function (h) {
    var title = ac.docTitle(h._source);
    var key = title.toLowerCase();
    if (docs.length >= ac.docs || titles.has(key)) return;
    titles.add(key);
    docs.push({ id: h._id, title: title, thumb: ac.docThumb(h._source) });
  });

  return { query: raw, took: body.took, suggestions: suggestions, docs: docs };
};

module.exports = { getClient, search, searchSimilar, randomId, similarTopK, autocomplete };

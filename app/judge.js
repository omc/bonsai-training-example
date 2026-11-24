// Relevance grades from the judge service (JUDGE_URL) for datasets with a
// `config.judge` block: { rubric, fields } as the service's /v1/label expects,
// plus an optional source(src) that reshapes each hit's _source before sending.
const JUDGE_URL = process.env.JUDGE_URL || null;
// Bearer key, required by the hosted service; a local one may not need it.
const JUDGE_KEY = process.env.JUDGE_KEY || null;
const TIMEOUT_MS = parseInt(process.env.JUDGE_TIMEOUT_MS, 10) || 10000;
const BATCH_TIMEOUT_MS = parseInt(process.env.JUDGE_BATCH_TIMEOUT_MS, 10) || 30000;

const enabled = function (config) {
  return !!(JUDGE_URL && config && config.judge);
};

// Pages judge only when asked to with ?judge=1 or ?judge=true.
const requested = function (value) {
  return typeof value === "string" && /^(1|true)$/i.test(value);
};

// nDCG over one page of grades in rank order, against that same page's grades
// re-sorted: it measures ordering within the page, not recall. Gain 2^g - 1,
// discount log2(rank + 1); unlabelled hits count as 0.
const ndcg = function (grades) {
  var gs = grades.map(function (g) {
    return g == null ? 0 : g;
  });
  var dcg = function (list) {
    return list.reduce(function (sum, g, i) {
      return sum + (Math.pow(2, g) - 1) / Math.log2(i + 2);
    }, 0);
  };
  var ideal = dcg(gs.slice().sort(function (a, b) {
    return b - a;
  }));
  return ideal ? dcg(gs) / ideal : 0;
};

const meanGrade = function (grades) {
  if (!grades.length) return null;
  return grades.reduce(function (sum, g) {
    return sum + (g == null ? 0 : g);
  }, 0) / grades.length;
};

const buildRequest = function (config, query, hits) {
  var source = config.judge.source;
  if (source) {
    hits = hits.map(function (hit) {
      return Object.assign({}, hit, { _source: source(hit._source) });
    });
  }
  return {
    query: query,
    response: hits,
    rubric: config.judge.rubric,
    fields: config.judge.fields,
    options: { include_probs: false, include_fields: false, max_hits: hits.length },
  };
};

// One label request per page, so each hit is judged alongside the same
// neighbours as on its own results page.
const buildBatch = function (config, query, pages) {
  return {
    requests: pages.map(function (hits) {
      return buildRequest(config, query, hits);
    }),
  };
};

// Items ordered by grade, best first; equal grades keep their original order
// and ungraded items (null) go last.
const rerank = function (items, grades) {
  return items
    .map(function (item, i) {
      return { item: item, grade: grades[i] == null ? -1 : grades[i] };
    })
    .sort(function (a, b) {
      return b.grade - a.grade;
    })
    .map(function (x) {
      return x.item;
    });
};

const post = async function (path, body, timeout) {
  var resp = await fetch(JUDGE_URL.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      JUDGE_KEY ? { Authorization: "Bearer " + JUDGE_KEY } : {},
    ),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    throw new Error("judge " + resp.status + ": " + (await resp.text()).slice(0, 200));
  }
  return resp.json();
};

// POST /v1/label; resolves to the service's response body.
const label = function (config, query, hits) {
  return post("/v1/label", buildRequest(config, query, hits), TIMEOUT_MS);
};

// POST /v1/label/batch; resolves to one label response per page.
const labelBatch = async function (config, query, pages) {
  var out = await post("/v1/label/batch", buildBatch(config, query, pages), BATCH_TIMEOUT_MS);
  return out.responses;
};

module.exports = { enabled, requested, ndcg, meanGrade, buildRequest, buildBatch, rerank, label, labelBatch };

const express = require("express");
const path = require("path");
const fs = require("fs");
const { Client } = require("@opensearch-project/opensearch");
const { getClient, search, searchSimilar, randomId, similarTopK } = require("./search");
const { runAgentLoop } = require("./sid");

const app = express();
const PORT = process.env.PORT || 4444;

// --- View engine ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "templates"));

// --- OpenSearch client ---
const opensearchUrl = process.env.BONSAI_URL || "https://localhost:9200";
const client = new Client({ node: opensearchUrl });

// --- Load dataset configs ---
const datasetsDir = path.join(__dirname, "datasets");
const configs = {};
fs.readdirSync(datasetsDir)
  .filter(function (f) {
    return f.endsWith(".js");
  })
  .forEach(function (f) {
    var name = f.replace(/\.js$/, "");
    configs[name] = require(path.join(datasetsDir, f));
  });

// --- Helpers ---
async function getIndexCount(config) {
  try {
    var resp = await getClient(config).count({ index: config.index });
    return resp.body.count;
  } catch (e) {
    return null;
  }
}

// --- Static files & body parsing ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));

// --- Routes ---
app.get("/health", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const info = await client.cluster.health();
    res.json({ status: "ok", opensearch: info.body.status });
  } catch (err) {
    res.status(503).json({ status: "degraded", error: err.message });
  }
});

app.get("/", (req, res) => {
  res.redirect("/books");
});

// --- Blind side-by-side compare: pictures (1152-d) vs pictures-sm (768-d) ---
const COMPARE_A = "pictures";
const COMPARE_B = "pictures-sm";
const COMPARE_FIELD = "emb";
const COMPARE_K = 5;
const COMPARE_LOG = path.join(__dirname, "..", "pictures", "compare-results.ndjson");

function appendCompareRecord(record) {
  fs.appendFileSync(COMPARE_LOG, JSON.stringify(record) + "\n");
}
function readCompareRecords() {
  try {
    return fs
      .readFileSync(COMPARE_LOG, "utf8")
      .split("\n")
      .filter(function (l) { return l.trim(); })
      .map(function (l) {
        try { return JSON.parse(l); } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}
function countCompareRecords() {
  return readCompareRecords().length;
}

app.get("/compare", async (req, res) => {
  var config = configs[COMPARE_A];
  var chosen = null;

  // Draw random ids until the two indices disagree on their top-K neighbors.
  // Identical result sets are logged automatically and skipped (no user choice).
  for (var attempt = 0; attempt < 25 && !chosen; attempt++) {
    var id = await randomId(COMPARE_A);
    if (!id) break;
    var results = await Promise.all([
      similarTopK(COMPARE_A, COMPARE_FIELD, id, COMPARE_K),
      similarTopK(COMPARE_B, COMPARE_FIELD, id, COMPARE_K),
    ]);
    var a = results[0];
    var b = results[1];
    var aIds = a.neighbors.map(function (h) { return h._id; });
    var bIds = b.neighbors.map(function (h) { return h._id; });
    if (JSON.stringify(aIds) === JSON.stringify(bIds)) {
      appendCompareRecord({
        timestamp: new Date().toISOString(),
        source_id: id,
        left_index: COMPARE_A, left_ids: aIds,
        right_index: COMPARE_B, right_ids: bIds,
        choice: null,
        preferred: "identical",
      });
      continue;
    }
    chosen = { id: id, a: a, b: b, aIds: aIds, bIds: bIds };
  }

  if (!chosen) {
    return res.render("compare", { config: config, empty: true, count: countCompareRecords() });
  }

  // Coin toss: which index's result set is shown on the left (keeps it blind).
  var aOnLeft = Math.random() < 0.5;
  var left = aOnLeft
    ? { index: COMPARE_A, res: chosen.a, ids: chosen.aIds }
    : { index: COMPARE_B, res: chosen.b, ids: chosen.bIds };
  var right = aOnLeft
    ? { index: COMPARE_B, res: chosen.b, ids: chosen.bIds }
    : { index: COMPARE_A, res: chosen.a, ids: chosen.aIds };

  res.render("compare", {
    config: config,
    empty: false,
    sourceId: chosen.id,
    source: chosen.a.source,
    left: left,
    right: right,
    count: countCompareRecords(),
  });
});

app.get("/compare/results", (req, res) => {
  var records = readCompareRecords();
  var counts = {};
  counts[COMPARE_A] = 0;
  counts[COMPARE_B] = 0;
  counts.neutral = 0;
  counts.identical = 0;
  records.forEach(function (r) {
    if (counts[r.preferred] == null) counts[r.preferred] = 0;
    counts[r.preferred]++;
  });

  var total = records.length;
  var decisive = counts[COMPARE_A] + counts[COMPARE_B];

  // Head-to-head bars: share of decisive picks (neutral/identical excluded).
  var headToHead = [
    { index: COMPARE_A, label: COMPARE_A + " (1152-d)", count: counts[COMPARE_A] },
    { index: COMPARE_B, label: COMPARE_B + " (768-d)", count: counts[COMPARE_B] },
  ].map(function (b) {
    b.pct = decisive ? (b.count / decisive) * 100 : 0;
    return b;
  });
  var leader = decisive
    ? (counts[COMPARE_A] === counts[COMPARE_B]
        ? null
        : counts[COMPARE_A] > counts[COMPARE_B] ? COMPARE_A : COMPARE_B)
    : null;

  // Outcome bars: share of all rounds.
  var outcomes = [
    { key: COMPARE_A, label: "Preferred " + COMPARE_A, count: counts[COMPARE_A], kind: "a" },
    { key: COMPARE_B, label: "Preferred " + COMPARE_B, count: counts[COMPARE_B], kind: "b" },
    { key: "neutral", label: "Neutral (no preference)", count: counts.neutral, kind: "neutral" },
    { key: "identical", label: "Identical (auto-logged)", count: counts.identical, kind: "identical" },
  ].map(function (o) {
    o.pct = total ? (o.count / total) * 100 : 0;
    return o;
  });

  res.render("compare-results", {
    total: total,
    decisive: decisive,
    counts: counts,
    headToHead: headToHead,
    leader: leader,
    outcomes: outcomes,
    indexA: COMPARE_A,
    indexB: COMPARE_B,
  });
});

app.post("/compare/choose", (req, res) => {
  var choice = req.body.choice;
  if (choice !== "left" && choice !== "right" && choice !== "neutral") choice = "right";
  var leftIndex = req.body.left_index;
  var rightIndex = req.body.right_index;
  var leftIds = [];
  var rightIds = [];
  try { leftIds = JSON.parse(req.body.left_ids || "[]"); } catch (e) {}
  try { rightIds = JSON.parse(req.body.right_ids || "[]"); } catch (e) {}
  // "neutral" = no preference, either result set is fine.
  var preferred = choice === "left" ? leftIndex : choice === "right" ? rightIndex : "neutral";
  appendCompareRecord({
    timestamp: new Date().toISOString(),
    source_id: req.body.source_id,
    left_index: leftIndex, left_ids: leftIds,
    right_index: rightIndex, right_ids: rightIds,
    choice: choice,
    preferred: preferred,
  });
  res.redirect("/compare");
});

// --- Embeddable image search (iframe) ---
// Chrome-less grid search for marketing pages, for datasets with an `embed`
// config. Search, facets, asset pages and image-to-image similarity all stay
// inside the frame.
// Set EMBED_FRAME_ANCESTORS to restrict which sites may frame it
// (space-separated origins); defaults to any.
const EMBED_PER_PAGE = 12;

app.get("/embed/:dataset/asset", function (req, res) {
  var config = configs[req.params.dataset];
  if (!config || !config.embed) return res.status(404).send("Not found");
  return renderAsset(req, res, true);
});

app.get("/embed/:dataset", async (req, res) => {
  var config = configs[req.params.dataset];
  if (!config || !config.embed || config.display.layout !== "grid") return res.status(404).send("Not found");
  var dataset = req.params.dataset;

  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors " + (process.env.EMBED_FRAME_ANCESTORS || "*"),
  );

  // No query on first load: show results for an example so the frame isn't empty.
  var examples = config.embed.examples || [];
  var query = req.query.q != null ? String(req.query.q) : examples[0] || "";
  var similarId = req.query.id ? String(req.query.id) : null;
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var from = (page - 1) * EMBED_PER_PAGE;
  var filters = {};
  if (!similarId) {
    config.aggregations.forEach(function (agg) {
      if (req.query[agg.name]) filters[agg.name] = [].concat(req.query[agg.name]).map(String);
    });
  }

  var results = null;
  var error = null;
  try {
    if (similarId) {
      results = await searchSimilar(config, similarId, EMBED_PER_PAGE, from);
    } else if (query.trim()) {
      results = await search(config, query, EMBED_PER_PAGE, filters, from);
    }
  } catch (err) {
    console.error("embed search failed:", err.message);
    error = err.meta && err.meta.statusCode === 404 ? "Image not found." : "Search is temporarily unavailable.";
  }

  var similarLabel = null;
  if (results && similarId) {
    var similarSrc = Object.assign({ id: similarId, path: similarId }, results.body.similarSource);
    similarLabel = config.display.titleValue(similarSrc);
  }

  res.render("embed", {
    config,
    dataset,
    query,
    similarId,
    similarLabel,
    page,
    perPage: EMBED_PER_PAGE,
    results,
    error,
    examples,
    filters,
    // Asset pages link "back" here.
    selfUrl: req.originalUrl,
    indexCount: await getIndexCount(config),
  });
});

// --- Agent routes (before /:dataset catch-all) ---
app.get("/books/agent", (req, res) => {
  res.render("agent", { query: req.query.q || "" });
});

app.get("/books/agent/stream", (req, res) => {
  var query = req.query.q || "";
  if (!query.trim()) {
    res.status(400).json({ error: "Missing query parameter q" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  var aborted = false;
  req.on("close", function () { aborted = true; });

  function emit(event, data) {
    if (aborted) return;
    res.write("event: " + event + "\n");
    res.write("data: " + JSON.stringify(data) + "\n\n");
  }

  runAgentLoop(query, emit, function () { return aborted; })
    .then(function () {
      if (!aborted) res.end();
    })
    .catch(function (err) {
      console.error("Agent loop error:", err);
      emit("error_event", { message: "Internal server error." });
      if (!aborted) res.end();
    });
});

app.get("/:dataset/count", async (req, res) => {
  var config = configs[req.params.dataset];
  if (!config) return res.status(404).send("Dataset not found");
  try {
    const resp = await getClient(config).count({ index: config.index });
    res.json({ index: config.index, count: resp.body.count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/:dataset", async (req, res) => {
  var config = configs[req.params.dataset];
  if (!config) return res.status(404).send("Dataset not found");
  var datasets = Object.keys(configs).map(function (key) {
    return { slug: key, label: configs[key].label };
  });
  var indexCount = await getIndexCount(config);
  res.render("index", { dataset: req.params.dataset, config: config, datasets: datasets, indexCount: indexCount });
});

app.get("/:dataset/search", async (req, res) => {
  var config = configs[req.params.dataset];
  if (!config) return res.status(404).send("Dataset not found");

  var dataset = req.params.dataset;
  const query = req.query.q || "";
  const filters = {};
  config.aggregations.forEach(function (agg) {
    if (req.query[agg.name]) {
      filters[agg.name] = [].concat(req.query[agg.name]);
    }
  });
  const perPage = config.perPage || 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const from = (page - 1) * perPage;
  console.log(JSON.stringify(req.query));
  var permissions = null;
  var role = req.query.role || null;
  if (config.permissionPresets && role) {
    var preset = config.permissionPresets.find(function (p) { return p.value === role; });
    if (preset) permissions = preset.permissions;
  }
  var indexCount = await getIndexCount(config);
  var results;
  if (query.trim()) {
    results = await search(config, query, perPage, filters, from, permissions);
  } else {
    // Empty query: nothing to embed/match — render an empty result set.
    results = { body: { hits: { hits: [], total: { value: 0 } }, took: 0, aggregations: {} } };
  }
  res.render("results", {
    query,
    results,
    filters,
    page,
    perPage,
    dataset,
    config,
    role,
    indexCount,
    mode: "search",
    similarId: null,
    similarLabel: null,
  });
});

// --- Image-to-image similarity (before /:dataset catch-all) ---
app.get("/:dataset/similar", async (req, res) => {
  var config = configs[req.params.dataset];
  if (!config) return res.status(404).send("Dataset not found");
  if (config.query.type !== "knn" && config.query.type !== "hybrid") return res.status(400).send("Dataset does not support similarity search");

  var dataset = req.params.dataset;
  var id = req.query.id || "";
  if (!id) return res.redirect("/" + dataset);

  const perPage = config.perPage || 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const from = (page - 1) * perPage;

  var indexCount = await getIndexCount(config);
  var results;
  try {
    results = await searchSimilar(config, id, perPage, from);
  } catch (err) {
    if (err.meta && err.meta.statusCode === 404) return res.status(404).send("Picture not found");
    throw err;
  }

  var similarSrc = Object.assign({ id: id, path: id }, results.body.similarSource);
  var similarLabel = config.display.titleValue
    ? config.display.titleValue(similarSrc)
    : id;

  res.render("results", {
    query: "",
    results,
    filters: {},
    page,
    perPage,
    dataset,
    config,
    role: null,
    indexCount,
    mode: "similar",
    similarId: id,
    similarLabel,
  });
});

// --- Single-image asset page with a similar-images pane (datasets with `asset`) ---
// Shared by /:dataset/asset and the iframe's /embed/:dataset/asset; `embed`
// keeps every link and the back target inside /embed/.
async function renderAsset(req, res, embed) {
  var config = configs[req.params.dataset];
  if (!config || !config.asset) return res.status(404).send("Not found");

  var dataset = req.params.dataset;
  var home = (embed ? "/embed/" : "/") + dataset;
  var id = req.query.id ? String(req.query.id) : "";
  if (!id) return res.redirect(home);

  // Where "back" goes: a local path under `home`, so the param can't send the
  // page (or the frame) off-site.
  var back = req.query.back ? String(req.query.back) : "";
  if (!back) {
    var ref = req.get("Referer") || "";
    try {
      var refUrl = new URL(ref);
      if (refUrl.host === req.get("host") && !refUrl.pathname.endsWith("/asset")) {
        back = refUrl.pathname + refUrl.search;
      }
    } catch (e) {}
  }
  if (back.startsWith("//") || !(back === home || back.startsWith(home + "?") || back.startsWith(home + "/"))) back = "";

  // The clicked doc comes back as similarSource; neighbors exclude it.
  var results;
  try {
    results = await searchSimilar(config, id, config.asset.similarCount + 1, 0);
  } catch (err) {
    if (err.meta && err.meta.statusCode === 404) return res.status(404).send("Image not found");
    throw err;
  }
  var similar = results.body.hits.hits.filter(function (h) {
    return h._id !== id;
  }).slice(0, config.asset.similarCount);

  if (embed) {
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors " + (process.env.EMBED_FRAME_ANCESTORS || "*"),
    );
  }
  res.render("asset", {
    config,
    dataset,
    id,
    src: results.body.similarSource,
    similar,
    back,
    embed,
  });
}

app.get("/:dataset/asset", function (req, res) {
  return renderAsset(req, res, false);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Bonsai Search listening on :${PORT}`);
});

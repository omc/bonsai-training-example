const express = require("express");
const path = require("path");
const fs = require("fs");
const { Client } = require("@opensearch-project/opensearch");
const { search } = require("./search");
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

// --- Static files ---
app.use(express.static(path.join(__dirname, "public")));

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
    const resp = await client.count({ index: config.index });
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
  res.render("index", { dataset: req.params.dataset, config: config, datasets: datasets });
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
  const perPage = 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const from = (page - 1) * perPage;
  console.log(JSON.stringify(req.query));
  var permissions = null;
  var role = req.query.role || null;
  if (config.permissionPresets && role) {
    var preset = config.permissionPresets.find(function (p) { return p.value === role; });
    if (preset) permissions = preset.permissions;
  }
  const results = await search(config, query, perPage, filters, from, permissions);
  res.render("results", {
    query,
    results,
    filters,
    page,
    perPage,
    dataset,
    config,
    role,
  });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Bonsai Search listening on :${PORT}`);
});

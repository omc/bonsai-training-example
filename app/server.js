const express = require("express");
const path = require("path");
const fs = require("fs");
const { Client } = require("@opensearch-project/opensearch");
const { search } = require("./search");

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
  const results = await search(config, query, perPage, filters, from);
  res.render("results", {
    query,
    results,
    filters,
    page,
    perPage,
    dataset,
    config,
  });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Bonsai Search listening on :${PORT}`);
});

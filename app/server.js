const express = require("express");
const path = require("path");
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

// --- Static files ---
app.use(express.static(path.join(__dirname, "public")));

// --- Routes ---
app.get("/health", async (req, res) => {
  try {
    const info = await client.cluster.health();
    res.json({ status: "ok", opensearch: info.body.status });
  } catch (err) {
    res.status(503).json({ status: "degraded", error: err.message });
  }
});

app.get("/", async (req, res) => {
  res.render("index");
});

app.get("/search", async (req, res) => {
  const query = req.query.q || "";
  const filterKeys = [
    "subjects",
    "authors",
    "bookshelves",
    "languages",
    "media_type",
    "copyright",
    "popularity",
    "author_era",
  ];
  const filters = {};
  filterKeys.forEach((key) => {
    if (req.query[key]) {
      filters[key] = [].concat(req.query[key]);
    }
  });
  console.log(JSON.stringify(req.query));
  const results = await search("books", query, 10, filters);
  res.render("results", { query, results, filters });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Bonsai Search listening on :${PORT}`);
});

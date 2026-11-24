const test = require("node:test");
const assert = require("node:assert/strict");
const { requested, ndcg, meanGrade, buildRequest, buildBatch, rerank } = require("./judge");

test("ndcg is 1 for an ideally ordered page", function () {
  assert.equal(ndcg([3, 2, 1, 0]), 1);
});

test("ndcg uses exponential gain and log2 discount", function () {
  // DCG [1,3] = 1/log2(2) + 7/log2(3); ideal [3,1] = 7 + 1/log2(3)
  var expected = (1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3));
  assert.ok(Math.abs(ndcg([1, 3]) - expected) < 1e-12);
});

test("ndcg is page-local: all-1 pages score 1", function () {
  assert.equal(ndcg([1, 1, 1]), 1);
});

test("ndcg treats unlabelled hits as 0 and all-0 pages as 0", function () {
  assert.equal(ndcg([null, 3]), ndcg([0, 3]));
  assert.equal(ndcg([0, null, 0]), 0);
  assert.equal(ndcg([]), 0);
});

test("meanGrade averages with unlabelled as 0", function () {
  assert.equal(meanGrade([3, null, 0, 1]), 1);
  assert.equal(meanGrade([]), null);
});

test("buildRequest maps config to the label API", function () {
  var config = { judge: { rubric: "web_graded_v1", fields: { title: "title" } } };
  var hits = [{ _index: "books", _id: "1", _source: { title: "A" } }];
  assert.deepEqual(buildRequest(config, "q", hits), {
    query: "q",
    response: hits,
    rubric: "web_graded_v1",
    fields: { title: "title" },
    options: { include_probs: false, include_fields: false, max_hits: 1 },
  });
});

test("buildRequest applies config.judge.source to copies of each _source", function () {
  var config = {
    judge: {
      rubric: "r",
      fields: { title: "title" },
      source: function (src) {
        return Object.assign({}, src, { title: src.title.toUpperCase() });
      },
    },
  };
  var hits = [{ _id: "1", _source: { title: "a" } }];
  var req = buildRequest(config, "q", hits);
  assert.equal(req.response[0]._source.title, "A");
  assert.equal(req.response[0]._id, "1");
  assert.equal(hits[0]._source.title, "a");
});

test("books judge source strips the Category: prefix from bookshelves", function () {
  var books = require("./datasets/books");
  var src = books.judge.source({ bookshelves: ["Category: Novels", "Best Books Ever Listings"] });
  assert.deepEqual(src.bookshelves, ["Novels", "Best Books Ever Listings"]);
  assert.deepEqual(books.judge.source({}).bookshelves, []);
});

test("buildBatch sends one label request per page", function () {
  var config = { judge: { rubric: "r", fields: { title: "title" } } };
  var pages = [[{ _id: "1" }, { _id: "2" }], [{ _id: "3" }]];
  var batch = buildBatch(config, "q", pages);
  assert.equal(batch.requests.length, 2);
  assert.deepEqual(batch.requests[1], buildRequest(config, "q", pages[1]));
});

test("rerank sorts by grade, keeping original order within a grade", function () {
  var hits = ["a", "b", "c", "d", "e", "f"];
  var grades = [1, 3, null, 1, 3, 0];
  assert.deepEqual(rerank(hits, grades), ["b", "e", "a", "d", "f", "c"]);
  assert.deepEqual(hits, ["a", "b", "c", "d", "e", "f"]);
});

test("requests carry a bearer token when JUDGE_KEY is set", async function () {
  var saved = { url: process.env.JUDGE_URL, key: process.env.JUDGE_KEY, fetch: global.fetch };
  var calls = [];
  process.env.JUDGE_URL = "https://judge.example/";
  process.env.JUDGE_KEY = "sk-test";
  global.fetch = async function (url, init) {
    calls.push({ url: url, init: init });
    return { ok: true, json: async function () { return { responses: [] }; } };
  };
  delete require.cache[require.resolve("./judge")];
  try {
    var fresh = require("./judge");
    var config = { judge: { rubric: "r", fields: { title: "title" } } };
    await fresh.label(config, "q", [{ _id: "1" }]);
    await fresh.labelBatch(config, "q", [[{ _id: "1" }]]);
    assert.equal(calls[0].url, "https://judge.example/v1/label");
    assert.equal(calls[1].url, "https://judge.example/v1/label/batch");
    calls.forEach(function (c) {
      assert.equal(c.init.headers.Authorization, "Bearer sk-test");
    });
  } finally {
    process.env.JUDGE_URL = saved.url;
    process.env.JUDGE_KEY = saved.key;
    if (saved.url === undefined) delete process.env.JUDGE_URL;
    if (saved.key === undefined) delete process.env.JUDGE_KEY;
    global.fetch = saved.fetch;
    delete require.cache[require.resolve("./judge")];
  }
});

test("requested accepts judge=1 or judge=true only", function () {
  ["1", "true", "TRUE", "True"].forEach(function (v) {
    assert.equal(requested(v), true, v);
  });
  [undefined, "", "0", "false", "yes", ["1", "1"]].forEach(function (v) {
    assert.equal(requested(v), false, String(v));
  });
});

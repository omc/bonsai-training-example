const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore, parseS3Uri } = require("./compare-store");

// In-memory stand-in for S3Client.send: Put/Get/ListObjectsV2 by command name,
// paging list results 2 keys at a time to exercise continuation tokens.
function fakeS3() {
  var objects = {};
  return {
    objects: objects,
    send: async function (cmd) {
      var name = cmd.constructor.name;
      var input = cmd.input;
      if (name === "PutObjectCommand") {
        objects[input.Bucket + "/" + input.Key] = input.Body;
        return {};
      }
      if (name === "GetObjectCommand") {
        var body = objects[input.Bucket + "/" + input.Key];
        return { Body: { transformToString: async function () { return body; } } };
      }
      if (name === "ListObjectsV2Command") {
        var keys = Object.keys(objects)
          .filter(function (k) { return k.startsWith(input.Bucket + "/" + input.Prefix); })
          .map(function (k) { return k.slice(input.Bucket.length + 1); })
          .sort();
        var start = input.ContinuationToken ? parseInt(input.ContinuationToken, 10) : 0;
        var page = keys.slice(start, start + 2);
        var more = start + 2 < keys.length;
        return {
          Contents: page.map(function (k) { return { Key: k }; }),
          KeyCount: page.length,
          IsTruncated: more,
          NextContinuationToken: more ? String(start + 2) : undefined,
        };
      }
      throw new Error("unexpected command " + name);
    },
  };
}

test("parseS3Uri splits bucket and prefix", function () {
  assert.deepEqual(parseS3Uri("s3://bucket-x/examples/"), { bucket: "bucket-x", prefix: "examples/" });
  assert.deepEqual(parseS3Uri("s3://bucket-x/examples"), { bucket: "bucket-x", prefix: "examples/" });
});

test("s3 store appends one object per record under compare/", async function () {
  var s3 = fakeS3();
  var store = createStore({ dataUri: "s3://b/examples/", s3: s3 });
  await store.append({ preferred: "pictures" });
  await store.append({ preferred: "neutral" });
  await store.append({ preferred: "pictures-sm" });
  var keys = Object.keys(s3.objects);
  assert.equal(keys.length, 3);
  keys.forEach(function (k) { assert.match(k, /^b\/examples\/compare\/.+\.json$/); });
  assert.equal(await store.count(), 3);
  var prefs = (await store.readAll()).map(function (r) { return r.preferred; }).sort();
  assert.deepEqual(prefs, ["neutral", "pictures", "pictures-sm"]);
});

test("s3 store skips unparseable objects", async function () {
  var s3 = fakeS3();
  s3.objects["b/examples/compare/bad.json"] = "{nope";
  var store = createStore({ dataUri: "s3://b/examples/", s3: s3 });
  await store.append({ preferred: "neutral" });
  assert.equal((await store.readAll()).length, 1);
});

test("file store appends ndjson and tolerates a missing file", async function () {
  var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "compare-")), "r.ndjson");
  var store = createStore({ file: file });
  assert.deepEqual(await store.readAll(), []);
  await store.append({ preferred: "pictures" });
  await store.append({ preferred: "neutral" });
  assert.equal(await store.count(), 2);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 2);
});

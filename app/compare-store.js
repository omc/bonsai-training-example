// Storage for blind-compare records. On labs (LABS_DATA_URI set) each record
// is its own S3 object under <prefix>compare/, since S3 can't append and the
// Lambda filesystem is read-only; locally it's an ndjson file.
const fs = require("fs");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const parseS3Uri = function (uri) {
  var m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new Error("Bad S3 URI: " + uri);
  var prefix = m[2];
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { bucket: m[1], prefix: prefix };
};

const fileStore = function (file) {
  var readAll = async function () {
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(function (l) { return l.trim(); })
        .map(function (l) {
          try { return JSON.parse(l); } catch (e) { return null; }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  };
  return {
    append: async function (record) {
      fs.appendFileSync(file, JSON.stringify(record) + "\n");
    },
    readAll: readAll,
    count: async function () {
      return (await readAll()).length;
    },
  };
};

const s3Store = function (dataUri, s3) {
  var loc = parseS3Uri(dataUri);
  var prefix = loc.prefix + "compare/";

  // Every key under the prefix, following continuation tokens.
  var listKeys = async function () {
    var keys = [];
    var token;
    do {
      var page = await s3.send(new ListObjectsV2Command({
        Bucket: loc.bucket, Prefix: prefix, ContinuationToken: token,
      }));
      (page.Contents || []).forEach(function (o) { keys.push(o.Key); });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  };

  return {
    append: async function (record) {
      // Timestamp first so keys list in write order; random suffix avoids collisions.
      var key = prefix + new Date().toISOString() + "-" + crypto.randomBytes(4).toString("hex") + ".json";
      await s3.send(new PutObjectCommand({
        Bucket: loc.bucket, Key: key, Body: JSON.stringify(record), ContentType: "application/json",
      }));
    },
    // One GET per record, 16 at a time.
    readAll: async function () {
      var keys = await listKeys();
      var records = [];
      for (var i = 0; i < keys.length; i += 16) {
        var batch = await Promise.all(keys.slice(i, i + 16).map(async function (key) {
          var obj = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: key }));
          try { return JSON.parse(await obj.Body.transformToString()); } catch (e) { return null; }
        }));
        records = records.concat(batch.filter(Boolean));
      }
      return records;
    },
    count: async function () {
      return (await listKeys()).length;
    },
  };
};

// opts: { dataUri, s3 } for S3 (s3 defaults to a real client), or { file }.
const createStore = function (opts) {
  if (opts.dataUri) return s3Store(opts.dataUri, opts.s3 || new S3Client({}));
  return fileStore(opts.file);
};

module.exports = { createStore, parseS3Uri };

module.exports = {
  index: "multimodal",
  label: "Multimodal",

  // Separate cluster from BONSAI_URL.
  url: process.env.BONSAI_MULTIMODAL_URL,

  // Pagination sized to fill the 4-up grid evenly.
  perPage: 24,

  // Hybrid lexical + kNN; scores are normalized/combined by the search pipeline.
  // The kNN clause takes the raw query text; the cluster embeds it server-side.
  query: {
    type: "hybrid",
    pipeline: "hybrid-pipeline-lexical20-knn80",
    paginationDepth: 100,
    lexical: {
      fields: ["title^2", "tags"],
      // Docs with no image also have no embedding (and width 0); webp_b64 isn't
      // indexed, so the vector field stands in for "has an image". kNN can't
      // match vector-less docs, so only the lexical side needs this.
      filter: [{ exists: { field: "webp_b64__bonsai_multimodal_01" } }],
    },
    knn: { field: "webp_b64__bonsai_multimodal_01", k: 50 },
    sourceIncludes: [
      "id",
      "title",
      "tags",
      "url",
      "width",
      "height",
      "webp_b64",
    ],
  },

  // /embed/multimodal: example-query chips; the first loads on open.
  embed: {
    examples: [
      "sunset over the ocean",
      "red sports car",
      "dog on a beach",
      "birthday party",
      "coffee cup",
    ],
  },

  aggregations: [
    {
      name: "tags",
      label: "Tags",
      type: "terms",
      field: "tags",
      size: 20,
    },
  ],

  display: {
    layout: "grid",
    titleValue: function (src) {
      return src.title || String(src.id || "(untitled)");
    },
    // `webp_b64` is stored as a full data URI; prefix only if it's bare base64.
    imageData: function (src) {
      var b64 = src.webp_b64;
      if (!b64) return null;
      return b64.startsWith("data:") ? b64 : "data:image/webp;base64," + b64;
    },
    // Tiles link to image-to-image similarity; this links to the source file.
    originalLink: function (src) {
      return src.url || null;
    },
    tags: function (src) {
      return [].concat(src.tags || []);
    },
    metaFields: [
      {
        value: function (src) {
          return src.width && src.height
            ? src.width + " × " + src.height
            : null;
        },
      },
    ],
  },
};

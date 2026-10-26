module.exports = {
  index: "pictures",
  label: "Pictures",

  url: process.env.BONSAI_MULTIMODAL_URL,

  // Pagination sized to fill the 4-up grid evenly.
  perPage: 20,

  query: {
    type: "knn",
    // Fixed kNN candidate pool; caps pagination at 10 pages of 20.
    paginationDepth: 200,
    field: "img__bonsai_multimodal_01",
    sourceExcludes: ["img__bonsai_multimodal_01"],
  },

  // /embed/pictures: example-query chips; the first loads on open.
  embed: {
    examples: [
      "city skyline at night",
      "red sports car",
      "dog on a beach",
      "coffee cup",
      "hand-drawn cartoon cat",
    ],
  },

  // No facets or filters for multimodal image search.
  aggregations: [],

  display: {
    layout: "grid",
    titleValue: function (src) {
      if (src.path) {
        var parts = src.path.split("/");
        return parts[parts.length - 1];
      }
      return src.id || "(untitled)";
    },
    // Base64 JPEG stored in the `img` binary field.
    imageData: function (src) {
      return src.img; // ? "data:image/jpeg;base64," + src.img : null;
    },
    metaFields: [
      {
        value: function (src) {
          return src.width && src.height
            ? src.width + " × " + src.height
            : null;
        },
      },
      {
        value: function (src) {
          if (!src.path) return null;
          var parts = src.path.split("/");
          return parts.length > 1 ? parts[0].replace(/_/g, " ") : null;
        },
      },
    ],
  },
};

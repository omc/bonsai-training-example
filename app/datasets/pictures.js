module.exports = {
  index: "pictures",
  label: "Pictures",

  // Pagination sized to fill the 4-up grid evenly.
  perPage: 20,

  query: {
    type: "knn",
    field: "emb",
    sourceExcludes: ["emb"],
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
      return src.img ? "data:image/jpeg;base64," + src.img : null;
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

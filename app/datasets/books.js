module.exports = {
  index: "books",
  label: "Books",

  query: {
    clauses: [
      { type: "match_phrase", field: "title_precise", boost: 2.0 },
      { type: "match_phrase", field: "summaries_precise", boost: 1.4 },
      { type: "match_phrase", field: "author_names", boost: 1.4, slop: 1 },
      {
        type: "multi_match",
        matchType: "cross_fields",
        fields: [
          "title_precise",
          "summaries_precise",
          "author_names",
          "editor_names",
          "translator_names",
          "subjects",
          "bookshelves",
          "languages",
          "media_type",
        ],
        boost: 1.2,
      },
      {
        type: "multi_match",
        matchType: "cross_fields",
        fields: ["title", "summaries"],
        boost: 1.0,
      },
      {
        type: "multi_match",
        matchType: "cross_fields",
        fields: ["page"],
        boost: 1.0,
      },
    ],
    scoreFunction: { field: "download_count", modifier: "log1p", factor: 1.0 },
    boostMode: "sum",
    sourceExcludes: ["summaries_embedding"],
  },

  aggregations: [
    {
      name: "subjects",
      label: "Subject",
      type: "terms",
      field: "subjects.keyword",
      size: 20,
    },
    {
      name: "authors",
      label: "Author",
      type: "terms",
      field: "author_names.keyword",
      size: 20,
    },
    {
      name: "bookshelves",
      label: "Bookshelf",
      type: "terms",
      field: "bookshelves.keyword",
      size: 20,
    },
    {
      name: "languages",
      label: "Language",
      type: "terms",
      field: "languages",
      size: 20,
    },
    {
      name: "media_type",
      label: "Media Type",
      type: "terms",
      field: "media_type",
      size: 10,
    },
    {
      name: "copyright",
      label: "Copyright",
      type: "terms",
      field: "copyright",
      valueType: "boolean",
      formatBucket: function (b) {
        return b.key_as_string === "true" ? "Copyrighted" : "Public Domain";
      },
      bucketValue: function (b) {
        return b.key_as_string;
      },
    },
    {
      name: "popularity",
      label: "Popularity",
      type: "range",
      field: "download_count",
      ranges: [
        { key: "low", to: 100 },
        { key: "moderate", from: 100, to: 1000 },
        { key: "popular", from: 1000, to: 10000 },
        { key: "very_popular", from: 10000 },
      ],
      filterRanges: {
        low: { lt: 100 },
        moderate: { gte: 100, lt: 1000 },
        popular: { gte: 1000, lt: 10000 },
        very_popular: { gte: 10000 },
      },
      hideEmpty: true,
      formatBucket: function (b) {
        return b.key
          .replace(/_/g, " ")
          .replace(/\b\w/g, function (c) {
            return c.toUpperCase();
          });
      },
    },
    {
      name: "author_era",
      label: "Author Era",
      type: "histogram",
      field: "author_birth_years",
      filterInterval: 100,
      hideEmpty: true,
      formatBucket: function (b) {
        return b.key + "s";
      },
    },
  ],

  display: {
    titleField: "title",
    linkTemplate: function (src) {
      return "https://www.gutenberg.org/ebooks/" + src.gutenberg_id;
    },
    image: function (src) {
      return (src.formats && src.formats["image/jpeg"]) || null;
    },
    imageFallback: "/img/book.svg",
    subtitleFields: [
      {
        value: function (src) {
          return [].concat(src.author_names || []).join(", ") || null;
        },
      },
      {
        value: function (src) {
          return [].concat(src.languages || []).join(", ") || null;
        },
      },
      {
        value: function (src) {
          return src.download_count != null
            ? src.download_count.toLocaleString() + " downloads"
            : null;
        },
      },
    ],
    snippet: function (src) {
      var summaries = [].concat(src.summaries || []);
      var s = summaries.length ? summaries[0] : "";
      if (s.length > 300) s = s.substring(0, 300) + "...";
      return s || null;
    },
    tags: [
      function (src) {
        return src.media_type || null;
      },
      function (src) {
        return src.copyright === false ? "Public Domain" : null;
      },
      function (src) {
        return [].concat(src.subjects || []).slice(0, 3);
      },
    ],
  },
};

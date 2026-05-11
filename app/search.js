const { Client } = require("@opensearch-project/opensearch");
const client = new Client({ node: process.env.BONSAI_URL });

//All the "getQuery" methods below are iterations on relevance
const getQuery = function (querystring, k, filters) {
  k = k || 10;
  filters = filters || {};

  let body = {
    size: k,
    query: {
      function_score: {
        query: {
          bool: {
            should: [
              {
                match_phrase: {
                  title_precise: {
                    query: querystring,
                    boost: 2.0,
                  },
                },
              },
              {
                match_phrase: {
                  summaries_precise: {
                    query: querystring,
                    boost: 1.4,
                  },
                },
              },
              {
                match_phrase: {
                  author_names: {
                    query: querystring,
                    boost: 1.4,
                    slop: 1,
                  },
                },
              },

              {
                multi_match: {
                  query: querystring,
                  type: "cross_fields",
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
              },
              {
                multi_match: {
                  query: querystring,
                  type: "cross_fields",
                  fields: ["title", "summaries"],
                  boost: 1.0,
                },
              },
              {
                multi_match: {
                  query: querystring,
                  type: "cross_fields",
                  fields: ["page"],
                  boost: 1.0,
                },
              },
            ],
          },
        },
        field_value_factor: {
          field: "download_count",
          modifier: "log1p",
          factor: 1.0,
        },
        boost_mode: "sum",
      },
    },
    _source: { excludes: ["summaries_embedding"] },
    aggs: {
      subjects: {
        terms: { field: "subjects.keyword", size: 20 },
      },
      bookshelves: {
        terms: { field: "bookshelves.keyword", size: 20 },
      },
      authors: {
        terms: { field: "author_names.keyword", size: 20 },
      },
      languages: {
        terms: { field: "languages", size: 20 },
      },
      media_type: {
        terms: { field: "media_type", size: 10 },
      },
      copyright: {
        terms: { field: "copyright" },
      },
      download_count_stats: {
        stats: { field: "download_count" },
      },
      popularity: {
        range: {
          field: "download_count",
          ranges: [
            { key: "low", to: 100 },
            { key: "moderate", from: 100, to: 1000 },
            { key: "popular", from: 1000, to: 10000 },
            { key: "very_popular", from: 10000 },
          ],
        },
      },
      author_era: {
        histogram: { field: "author_birth_years", interval: 100 },
      },
    },
  };

  // --- apply filter clauses from sidebar selections ---
  var filterClauses = [];

  var termFilterMap = {
    subjects: "subjects.keyword",
    authors: "author_names.keyword",
    bookshelves: "bookshelves.keyword",
    languages: "languages",
    media_type: "media_type",
  };

  Object.keys(termFilterMap).forEach(function (param) {
    if (filters[param] && filters[param].length) {
      filterClauses.push({ terms: { [termFilterMap[param]]: filters[param] } });
    }
  });

  if (filters.copyright && filters.copyright.length) {
    var boolVals = filters.copyright.map(function (v) {
      return v === "true";
    });
    filterClauses.push({ terms: { copyright: boolVals } });
  }

  if (filters.popularity && filters.popularity.length) {
    var popRanges = {
      low: { lt: 100 },
      moderate: { gte: 100, lt: 1000 },
      popular: { gte: 1000, lt: 10000 },
      very_popular: { gte: 10000 },
    };
    var popShould = filters.popularity
      .filter(function (k) {
        return popRanges[k];
      })
      .map(function (k) {
        return { range: { download_count: popRanges[k] } };
      });
    if (popShould.length) {
      filterClauses.push({
        bool: { should: popShould, minimum_should_match: 1 },
      });
    }
  }

  if (filters.author_era && filters.author_era.length) {
    var eraShould = filters.author_era
      .map(function (v) {
        return parseInt(v, 10);
      })
      .filter(function (n) {
        return !isNaN(n);
      })
      .map(function (start) {
        return {
          range: { author_birth_years: { gte: start, lt: start + 100 } },
        };
      });
    if (eraShould.length) {
      filterClauses.push({
        bool: { should: eraShould, minimum_should_match: 1 },
      });
    }
  }

  if (filterClauses.length) {
    body.query.function_score.query.bool.filter = filterClauses;
  }

  return body;
};

const search = async function (collection, querystring, k, filters, from) {
  const body = getQuery(querystring, k, filters);
  body.from = from || 0;
  const resp = await client.search({
    index: collection,
    body: body,
  });
  return resp;
};

module.exports = { search };

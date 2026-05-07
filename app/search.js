const { Client } = require("@opensearch-project/opensearch");
const client = new Client({ node: process.env.BONSAI_URL });

//All the "getQuery" methods below are iterations on relevance
const getQuery = function (querystring, k) {
  k = k || 10;

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

  return body;
};

const search = async function (collection, querystring, k) {
  const body = getQuery(querystring, k);
  const resp = await client.search({
    index: collection,
    body: body,
  });
  console.log(JSON.stringify(resp, null, 2));
  return resp;
};

module.exports = { search };

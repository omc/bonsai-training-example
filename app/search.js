const { Client } = require("@opensearch-project/opensearch");
const client = new Client({ node: process.env.BONSAI_URL });

const getQuery = function (config, querystring, k, filters) {
  k = k || 10;
  filters = filters || {};

  // --- build should clauses from config ---
  var shouldClauses = config.query.clauses.map(function (clause) {
    if (clause.type === "match_phrase") {
      var mp = { query: querystring, boost: clause.boost };
      if (clause.slop != null) mp.slop = clause.slop;
      return { match_phrase: { [clause.field]: mp } };
    }
    if (clause.type === "multi_match") {
      return {
        multi_match: {
          query: querystring,
          type: clause.matchType,
          fields: clause.fields,
          boost: clause.boost,
        },
      };
    }
    return null;
  }).filter(Boolean);

  // --- build core bool query ---
  var boolQuery = { bool: { should: shouldClauses, minimum_should_match: 1 } };

  // --- wrap in function_score if scoreFunction configured ---
  var queryBody;
  if (config.query.scoreFunction) {
    queryBody = {
      function_score: {
        query: boolQuery,
        field_value_factor: {
          field: config.query.scoreFunction.field,
          modifier: config.query.scoreFunction.modifier,
          factor: config.query.scoreFunction.factor,
        },
        boost_mode: config.query.boostMode || "sum",
      },
    };
  } else {
    queryBody = boolQuery;
  }

  // --- build aggregations from config ---
  var aggs = {};
  config.aggregations.forEach(function (agg) {
    if (agg.type === "terms") {
      aggs[agg.name] = { terms: { field: agg.field } };
      if (agg.size) aggs[agg.name].terms.size = agg.size;
    } else if (agg.type === "range") {
      aggs[agg.name] = {
        range: { field: agg.field, ranges: agg.ranges },
      };
    } else if (agg.type === "histogram") {
      aggs[agg.name] = {
        histogram: { field: agg.field, interval: agg.filterInterval },
      };
    }
  });

  var body = {
    size: k,
    query: queryBody,
    _source: { excludes: config.query.sourceExcludes || [] },
    aggs: aggs,
  };

  // --- apply filter clauses from sidebar selections ---
  var filterClauses = [];

  config.aggregations.forEach(function (agg) {
    var vals = filters[agg.name];
    if (!vals || !vals.length) return;

    var filterField = agg.filterField || agg.field;

    if (agg.type === "terms") {
      var coerced = vals;
      if (agg.valueType === "boolean") {
        coerced = vals.map(function (v) {
          return v === "true";
        });
      }
      filterClauses.push({ terms: { [filterField]: coerced } });
    } else if (agg.type === "range" && agg.filterRanges) {
      var rangeShould = vals
        .filter(function (k) {
          return agg.filterRanges[k];
        })
        .map(function (k) {
          return { range: { [filterField]: agg.filterRanges[k] } };
        });
      if (rangeShould.length) {
        filterClauses.push({
          bool: { should: rangeShould, minimum_should_match: 1 },
        });
      }
    } else if (agg.type === "histogram") {
      var interval = agg.filterInterval;
      var histShould = vals
        .map(function (v) {
          return parseInt(v, 10);
        })
        .filter(function (n) {
          return !isNaN(n);
        })
        .map(function (start) {
          return {
            range: { [filterField]: { gte: start, lt: start + interval } },
          };
        });
      if (histShould.length) {
        filterClauses.push({
          bool: { should: histShould, minimum_should_match: 1 },
        });
      }
    }
  });

  // --- attach filters to the bool query ---
  if (filterClauses.length) {
    if (config.query.scoreFunction) {
      body.query.function_score.query.bool.filter = filterClauses;
    } else {
      body.query.bool.filter = filterClauses;
    }
  }

  return body;
};

const search = async function (config, querystring, k, filters, from) {
  const body = getQuery(config, querystring, k, filters);
  body.from = from || 0;
  const resp = await client.search({
    index: config.index,
    body: body,
  });
  return resp;
};

module.exports = { search };

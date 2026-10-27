// ISO country / language codes in the index -> English names for facet labels.
var regionNames = new Intl.DisplayNames(["en"], { type: "region" });
var languageNames = new Intl.DisplayNames(["en"], { type: "language" });

var displayName = function (names, code) {
  try {
    return names.of(code) || code;
  } catch (e) {
    return code;
  }
};

var titleCase = function (s) {
  return s.replace(/\b\w/g, function (c) {
    return c.toUpperCase();
  });
};

// Commons thumbnail URL at width `w`, rewritten from the stored `thumb_url`.
// Commons only serves fixed widths (others return 400) and won't upscale, so
// null when the original is narrower than `w`.
var commonsThumb = function (src, w) {
  var m = /^(.*\/)(\d+)px-([^/]+)$/.exec(src.thumb_url || "");
  if (!m || !(src.width >= w)) return null;
  return m[1] + w + "px-" + m[3];
};

// EXIF rationals arrive as "num/den" strings.
var rational = function (s) {
  if (s == null) return null;
  var parts = String(s).split("/");
  var n = parseFloat(parts[0]);
  var d = parts.length > 1 ? parseFloat(parts[1]) : 1;
  return isFinite(n) && isFinite(d) && d ? n / d : null;
};

var round = function (n, places) {
  var f = Math.pow(10, places);
  return Math.round(n * f) / f;
};

var pointText = function (loc) {
  if (!loc || loc.lat == null || loc.lon == null) return null;
  var text = round(loc.lat, 5) + ", " + round(loc.lon, 5);
  var where = [
    loc.region,
    loc.country ? displayName(regionNames, loc.country) : null,
  ].filter(Boolean);
  if (where.length) text += " (" + where.join(", ") + ")";
  return {
    text: text,
    href:
      "https://www.openstreetmap.org/?mlat=" + loc.lat + "&mlon=" + loc.lon +
      "#map=15/" + loc.lat + "/" + loc.lon,
  };
};

var assessmentLabels = {
  quality: "Quality image",
  valued: "Valued image",
  featured: "Featured picture",
  potd: "Picture of the Day",
  poty: "Picture of the Year finalist",
};

module.exports = {
  // Wikimedia Commons "Quality images" (multimodal/commons-qi*.py,
  // multimodal/wikimedia-index.json).
  index: "wikimedia",
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
      // `title` is the Commons file name. `captions.text` (all languages) is
      // left out: its analyzer keeps stopwords, so "in"/"a" match most of the
      // index and swamp the facet counts.
      fields: [
        "caption^3",
        "depicts.label.text^2",
        "title",
        "description",
        "categories.text",
        "wikidata_items.label.text",
        "location_of_creation.label.text",
      ],
    },
    knn: { field: "image__bonsai_multimodal_01", k: 50 },
    sourceIncludes: [
      "pageid",
      "title",
      "caption",
      "depicts.label",
      "author",
      "license",
      "file_page",
      "width",
      "height",
      "image_width",
      "image_height",
      "image",
      "thumb_url",
    ],
  },

  // /embed/multimodal: example-query chips; the first loads on open.
  embed: {
    examples: [
      "sunset over the ocean",
      "red sports car",
      "city skyline at night",
      "lighthouse in a storm",
      "old steam train",
      "coffee cup",
    ],
    // A shorter facet list for the marketing frame (aggregation names, in
    // order), trimmed rows, and only the first few expanded so the sidebar
    // doesn't outgrow 12 results.
    facets: ["depicts", "assessment", "license", "attribution", "taken", "resolution", "country", "camera"],
    facetSize: 6,
    openFacets: 4,
  },

  // Search-as-you-type over the suggest fields in wikimedia-index.json
  // (caption + depicts feed completions/suggest_word/suggest_phrase), after
  // https://bonsai.io/blog/how-to-really-scale-autocomplete/.
  autocomplete: {
    completionField: "completions",
    wordField: "suggest_word",
    phraseField: "suggest_phrase",
    minDocCount: 3,
    suggestions: 8,
    docs: 4,
    docTitle: function (src) {
      return src.caption || (src.title || "").replace(/^File:/, "").replace(/\.[^.]+$/, "");
    },
    // 120px is a standard Commons step; tiny originals fall back to thumb_url.
    docThumb: function (src) {
      return commonsThumb(src, 120) || src.thumb_url || null;
    },
    sourceIncludes: ["caption", "title", "thumb_url", "width"],
  },

  aggregations: [
    {
      name: "depicts",
      label: "Depicts",
      type: "terms",
      field: "depicts.label",
      size: 15,
    },
    {
      name: "categories",
      label: "Category",
      type: "terms",
      field: "categories",
      size: 10,
    },
    {
      name: "assessment",
      label: "Recognition",
      type: "terms",
      field: "assessments",
      formatBucket: function (b) {
        return assessmentLabels[b.key] || b.key;
      },
    },
    {
      name: "taken",
      label: "Year Taken",
      type: "range",
      field: "date_taken",
      ranges: [
        { key: "before_2010", to: "2010" },
        { key: "2010_2014", from: "2010", to: "2015" },
        { key: "2015_2019", from: "2015", to: "2020" },
        { key: "2020_2022", from: "2020", to: "2023" },
        { key: "2023_later", from: "2023" },
      ],
      filterRanges: {
        before_2010: { lt: "2010" },
        "2010_2014": { gte: "2010", lt: "2015" },
        "2015_2019": { gte: "2015", lt: "2020" },
        "2020_2022": { gte: "2020", lt: "2023" },
        "2023_later": { gte: "2023" },
      },
      hideEmpty: true,
      formatBucket: function (b) {
        return {
          before_2010: "Before 2010",
          "2010_2014": "2010–2014",
          "2015_2019": "2015–2019",
          "2020_2022": "2020–2022",
          "2023_later": "2023 and later",
        }[b.key];
      },
    },
    {
      name: "country",
      label: "Country",
      type: "terms",
      field: "camera_location.country",
      size: 15,
      formatBucket: function (b) {
        return displayName(regionNames, b.key);
      },
    },
    {
      name: "resolution",
      label: "Resolution",
      type: "range",
      field: "width",
      ranges: [
        { key: "under_3000", to: 3000 },
        { key: "3000_5999", from: 3000, to: 6000 },
        { key: "6000_up", from: 6000 },
      ],
      filterRanges: {
        under_3000: { lt: 3000 },
        "3000_5999": { gte: 3000, lt: 6000 },
        "6000_up": { gte: 6000 },
      },
      hideEmpty: true,
      formatBucket: function (b) {
        return {
          under_3000: "Under 3000 px wide",
          "3000_5999": "3000–5999 px wide",
          "6000_up": "6000+ px wide",
        }[b.key];
      },
    },
    {
      name: "license",
      label: "License",
      type: "terms",
      field: "license",
      size: 10,
    },
    {
      name: "attribution",
      label: "Attribution",
      type: "terms",
      field: "attribution_required",
      valueType: "boolean",
      formatBucket: function (b) {
        return b.key_as_string === "true" ? "Required" : "Not required";
      },
      bucketValue: function (b) {
        return b.key_as_string;
      },
    },
    {
      name: "author",
      label: "Photographer",
      type: "terms",
      field: "author",
      size: 10,
    },
    {
      name: "camera",
      label: "Camera Make",
      type: "terms",
      field: "exif.make",
      size: 10,
      formatBucket: function (b) {
        return titleCase(b.key);
      },
    },
    {
      name: "wikipedia",
      label: "Used on Wikipedia",
      type: "terms",
      field: "wikipedia.wiki",
      size: 10,
      formatBucket: function (b) {
        var m = /^([a-z-]+)\.wikipedia\.org$/.exec(b.key);
        return m ? displayName(languageNames, m[1]) : b.key;
      },
    },
  ],

  display: {
    layout: "grid",
    // Flickr-style justified rows with metadata overlaid on the photo.
    justified: true,
    // From the stored thumbnail, so it matches the pixels actually shown.
    aspectRatio: function (src) {
      var w = src.image_width || src.width;
      var h = src.image_height || src.height;
      return w && h ? w / h : 1;
    },
    // Caption when there is one; otherwise the file name without its extension.
    titleValue: function (src) {
      if (src.caption) return src.caption;
      return (src.title || String(src.pageid || "(untitled)")).replace(
        /\.\w+$/,
        "",
      );
    },
    // `image` is stored as a full data URI.
    imageData: function (src) {
      return src.image || null;
    },
    // Sharper copies straight from Wikimedia's thumbnail CDN, loaded by the
    // viewer's browser over the inline thumbnail.
    imageSrcset: function (src) {
      return [500, 960]
        .map(function (w) {
          var url = commonsThumb(src, w);
          return url ? url + " " + w + "w" : null;
        })
        .filter(Boolean)
        .join(", ") || null;
    },
    // Tiles link to image-to-image similarity; this links to the Commons file
    // page, which carries the full license and attribution.
    originalLink: function (src) {
      return src.file_page || null;
    },
    tags: function (src) {
      return (src.depicts || [])
        .map(function (d) {
          return d.label;
        })
        .filter(Boolean)
        .slice(0, 6);
    },
    // Most images are CC BY / CC BY-SA, so author and license must be shown.
    metaFields: [
      {
        value: function (src) {
          return src.author || null;
        },
      },
      {
        value: function (src) {
          return src.license || null;
        },
      },
    ],
  },

  // /:dataset/asset?id= — single-image page. Values are null (row skipped), a
  // string, {text, href}, or an array of those; `chips` renders arrays as pills.
  // Relative hrefs ("search?q=") resolve against /:dataset/.
  asset: {
    similarCount: 18,
    // Largest Commons rendition we use, with its pixel width so the page can
    // cap the display size there. Null falls back to the inline thumbnail.
    image: function (src) {
      var widths = [960, 500];
      for (var i = 0; i < widths.length; i++) {
        var url = commonsThumb(src, widths[i]);
        if (url) return { url: url, width: widths[i] };
      }
      return null;
    },
    description: function (src) {
      return src.description && src.description !== src.caption
        ? src.description
        : null;
    },
    sections: [
      {
        title: "Credit & license",
        rows: [
          {
            label: "Author",
            value: function (src) {
              return src.author
                ? { text: src.author, href: src.author_url || null }
                : null;
            },
          },
          {
            label: "License",
            value: function (src) {
              if (!src.license) return null;
              var text = src.usage_terms && src.usage_terms !== src.license
                ? src.license + " — " + src.usage_terms
                : src.license;
              return { text: text, href: src.license_url || null };
            },
          },
          {
            label: "Attribution",
            value: function (src) {
              if (src.attribution) return src.attribution;
              return src.attribution_required === false ? "Not required" : null;
            },
          },
          {
            // Ready to paste under the image wherever it's reused.
            label: "Credit line",
            value: function (src) {
              if (!src.author || !src.license) return null;
              return src.author + ", " + src.license + ", via Wikimedia Commons";
            },
          },
          {
            label: "Restrictions",
            value: function (src) {
              return (src.restrictions || []).length
                ? src.restrictions.join(", ")
                : null;
            },
          },
        ],
      },
      {
        title: "Subject",
        rows: [
          {
            label: "Depicts",
            chips: true,
            value: function (src) {
              return (src.depicts || []).map(function (d) {
                return { text: d.label, href: "search?q=" + encodeURIComponent(d.label) };
              });
            },
          },
          {
            label: "Wikidata",
            chips: true,
            value: function (src) {
              return (src.wikidata_items || []).map(function (d) {
                return {
                  text: d.label || d.id,
                  href: "https://www.wikidata.org/wiki/" + d.id,
                };
              });
            },
          },
          {
            label: "Recognition",
            chips: true,
            value: function (src) {
              return (src.assessments || []).map(function (a) {
                return assessmentLabels[a] || a;
              });
            },
          },
        ],
      },
      {
        title: "Captions",
        rows: [
          {
            label: "Other languages",
            value: function (src) {
              return (src.captions || [])
                .filter(function (c) {
                  return c.text && c.text !== src.caption;
                })
                .map(function (c) {
                  return displayName(languageNames, c.lang) + ": " + c.text;
                });
            },
          },
        ],
      },
      {
        title: "When & where",
        rows: [
          {
            label: "Date taken",
            value: function (src) {
              if (!src.date_taken) return null;
              var d = new Date(src.date_taken + "T00:00:00Z");
              if (isNaN(d)) return src.date_taken;
              // Partial dates ("2019", "2019-06") stay as stored.
              return src.date_taken.length === 10
                ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
                : src.date_taken;
            },
          },
          {
            label: "Place",
            value: function (src) {
              return (src.location_of_creation || []).map(function (l) {
                return { text: l.label || l.id, href: "https://www.wikidata.org/wiki/" + l.id };
              });
            },
          },
          {
            label: "Camera position",
            value: function (src) {
              return pointText(src.camera_location);
            },
          },
          {
            label: "Subject position",
            value: function (src) {
              return pointText(src.object_location);
            },
          },
        ],
      },
      {
        title: "Camera",
        rows: [
          {
            label: "Camera",
            value: function (src) {
              var cw = (src.captured_with || [])[0];
              if (cw && cw.label) return { text: cw.label, href: "https://www.wikidata.org/wiki/" + cw.id };
              var e = src.exif || {};
              return [e.make, e.model].filter(Boolean).join(" ") || null;
            },
          },
          {
            label: "Lens",
            value: function (src) {
              return (src.exif || {}).lens_model || null;
            },
          },
          {
            label: "Focal length",
            value: function (src) {
              var f = rational((src.exif || {}).focal_length);
              return f ? round(f, 1) + " mm" : null;
            },
          },
          {
            label: "Aperture",
            value: function (src) {
              var f = rational((src.exif || {}).f_number);
              return f ? "f/" + round(f, 1) : null;
            },
          },
          {
            label: "Exposure",
            value: function (src) {
              var t = (src.exif || {}).exposure_time;
              var v = rational(t);
              if (!v) return null;
              return v >= 1 ? round(v, 1) + " s" : "1/" + Math.round(1 / v) + " s";
            },
          },
          {
            label: "ISO",
            value: function (src) {
              var iso = (src.exif || {}).iso;
              return iso ? String(iso) : null;
            },
          },
          {
            // EXIF flash is a bit field; bit 0 says whether it fired.
            label: "Flash",
            value: function (src) {
              var f = (src.exif || {}).flash;
              if (f == null) return null;
              return f & 1 ? "Fired" : "Did not fire";
            },
          },
        ],
      },
      {
        title: "Used on Wikipedia",
        rows: [
          {
            label: "Articles",
            value: function (src) {
              return (src.wikipedia || []).map(function (w) {
                var m = /^([a-z-]+)\.wikipedia\.org$/.exec(w.wiki || "");
                var lang = m ? displayName(languageNames, m[1]) : w.wiki;
                return {
                  text: (w.title || "").replace(/_/g, " ") + " (" + lang + ")",
                  href: w.url,
                };
              });
            },
          },
        ],
      },
      {
        title: "Categories",
        rows: [
          {
            label: "Commons",
            chips: true,
            value: function (src) {
              return (src.categories || []).map(function (c) {
                return {
                  text: c,
                  href: "https://commons.wikimedia.org/wiki/Category:" + encodeURIComponent(c.replace(/ /g, "_")),
                };
              });
            },
          },
        ],
      },
      {
        title: "File",
        rows: [
          {
            label: "Original size",
            value: function (src) {
              if (!src.width || !src.height) return null;
              var mp = round((src.width * src.height) / 1e6, 1);
              return src.width + " × " + src.height + " px (" + mp + " MP)";
            },
          },
          {
            label: "Format",
            value: function (src) {
              return src.mime || null;
            },
          },
          {
            label: "Commons page",
            value: function (src) {
              return src.file_page ? { text: src.title || "File page", href: src.file_page } : null;
            },
          },
          {
            label: "Download",
            value: function (src) {
              return src.original_url ? { text: "Full-resolution original", href: src.original_url } : null;
            },
          },
        ],
      },
    ],
  },
};

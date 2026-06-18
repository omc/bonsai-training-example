module.exports = {
  index: "music",
  label: "Music",

  query: {
    clauses: [
      {
        type: "multi_match",
        matchType: "cross_fields",
        fields: ["names^3", "aka^2", "emails", "notes", "address", "url"],
        boost: 1.0,
      },
    ],
  },

  aggregations: [
    {
      name: "type",
      label: "Type",
      type: "terms",
      field: "type",
      size: 10,
      formatBucket: function (b) {
        return b.key.charAt(0).toUpperCase() + b.key.slice(1);
      },
    },
  ],

  display: {
    layout: "rows",
    titleValue: function (src) {
      return (src.names && src.names[0]) || "(untitled)";
    },
    linkTemplate: function () {
      return null;
    },
    icons: {
      artist:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>',
      album:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
      track:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="18" r="3"/><circle cx="20" cy="14" r="3"/><path d="M11 18V4l12-2v12"/></svg>',
      customer:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M7 20c0-2.8 2.2-5 5-5s5 2.2 5 5"/></svg>',
      employee:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      invoice:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
      playlist:
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
    },
    subtitleFields: [
      {
        value: function (src) {
          return src.type
            ? src.type.charAt(0).toUpperCase() + src.type.slice(1)
            : null;
        },
      },
      {
        value: function (src) {
          return [].concat(src.aka || []).join(", ") || null;
        },
      },
      {
        value: function (src) {
          return [].concat(src.emails || []).join(", ") || null;
        },
      },
    ],
    detailLine: function (src) {
      if (!src.details) return null;
      var parts = [];
      if (src.details.price != null) parts.push("$" + src.details.price.toFixed(2));
      if (src.details.duration_ms != null) {
        var totalSec = Math.round(src.details.duration_ms / 1000);
        var min = Math.floor(totalSec / 60);
        var sec = totalSec % 60;
        parts.push(min + ":" + (sec < 10 ? "0" : "") + sec);
      }
      if (src.details.media_type) parts.push(src.details.media_type);
      if (src.details.total != null) parts.push("Total: $" + src.details.total.toFixed(2));
      if (src.details.support_rep) parts.push("Rep: " + src.details.support_rep);
      return parts.length ? parts.join(" \u00b7 ") : null;
    },
    tags: [],
  },
};

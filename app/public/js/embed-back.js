// "Back to results" for the iframe embed. Links carry only an image id (so
// crawlers see one URL per image), so each results page records itself in
// this tab's sessionStorage and `a[data-back]` links point at the last one:
// data-back="search" for the last text search, "results" for any results page.
// Without storage, links keep their server-rendered href.
(function () {
  try {
    var store = window.sessionStorage;
    document.querySelectorAll("a[data-back]").forEach(function (a) {
      var url = store.getItem("embed-back:" + a.dataset.back);
      if (!url) return;
      a.href = url;
      if (a.dataset.backLabel) a.textContent = a.dataset.backLabel;
    });
    var kind = document.body.dataset.results;
    if (!kind) return;
    var here = location.pathname + location.search;
    store.setItem("embed-back:results", here);
    if (kind === "search") store.setItem("embed-back:search", here);
  } catch (e) {}
})();

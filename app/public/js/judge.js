// Relevance grades for a results page. <main data-judge="<endpoint>"
// data-judge-query="<q>"> holds cards marked data-judge-id; once the page is
// up, posts the ids in rank order and fills each card's .judge-badge and the
// .judge-summary line. On failure the results stay as they are.
(function () {
  var main = document.querySelector('main[data-judge]');
  var summary = document.querySelector('.judge-summary');
  if (!main) return;
  var cards = Array.prototype.slice.call(main.querySelectorAll('[data-judge-id]'));
  if (!cards.length) return;

  fetch(main.getAttribute('data-judge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: main.getAttribute('data-judge-query'),
      ids: cards.map(function (c) { return c.getAttribute('data-judge-id'); }),
    }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(render, function () {
      if (summary) {
        summary.textContent = 'judge unavailable';
        summary.classList.add('judge-error');
      }
    });

  function render(data) {
    data.labels.forEach(function (l, i) {
      var badge = cards[i] && cards[i].querySelector('.judge-badge');
      if (!badge) return;
      if (l.label == null) {
        badge.textContent = 'not judged';
        badge.className = 'judge-badge judge-none';
      } else {
        var word = data.grades && data.grades[l.label];
        badge.textContent = l.label + (word ? ' · ' + word : '');
        badge.className = 'judge-badge judge-g' + l.label;
        badge.title = 'expected grade ' + l.expected_grade.toFixed(2) + ' (' + data.rubric + ')';
      }
      badge.hidden = false;
    });
    if (summary) {
      summary.textContent = 'judged nDCG@' + data.labels.length + ' ' + data.ndcg.toFixed(2) +
        ' (page-local) · mean grade ' + data.mean.toFixed(2);
      summary.title = data.rubric + ' · ' + data.model +
        '\nnDCG is against this page’s own grades re-sorted, so it measures ordering, not recall.';
    }
  }
})();

// Search-as-you-type for inputs marked data-autocomplete="<endpoint>".
//   data-asset-base  where image suggestions link (…/asset); omit for none
// Waits for a ~50ms pause in typing before asking, cancels stale requests and
// remembers answers per prefix, so backspacing costs nothing.
(function () {
  var DEBOUNCE_MS = 50;
  var MIN_CHARS = 2;

  document.querySelectorAll('input[data-autocomplete]').forEach(setup);

  function setup(input, n) {
    var form = input.form;
    var endpoint = input.getAttribute('data-autocomplete');
    var assetBase = input.getAttribute('data-asset-base');
    var cache = new Map();
    var timer = null;
    var controller = null;
    var items = [];
    var active = -1;
    var listId = 'ac-list-' + n;

    var list = document.createElement('div');
    list.className = 'ac-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    form.classList.add('ac-host');
    form.appendChild(list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value;
      if (q.trim().length < MIN_CHARS) return close();
      if (cache.has(q)) return render(cache.get(q));
      timer = setTimeout(function () { fetchSuggestions(q); }, DEBOUNCE_MS);
    });

    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var step = e.key === 'ArrowDown' ? 1 : -1;
        // Cycle through the options and back to the typed text (-1).
        setActive((active + 1 + step + items.length + 1) % (items.length + 1) - 1);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        choose(items[active]);
      } else if (e.key === 'Escape') {
        close();
      }
    });

    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('focus', function () {
      if (cache.has(input.value) && input.value.trim().length >= MIN_CHARS) render(cache.get(input.value));
    });
    // Keep focus in the input while clicking an option.
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });

    function fetchSuggestions(q) {
      if (controller) controller.abort();
      controller = new AbortController();
      fetch(endpoint + '?q=' + encodeURIComponent(q), { signal: controller.signal })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          cache.set(q, data);
          if (input.value === q) render(data);
        })
        .catch(function () {});
    }

    function render(data) {
      list.textContent = '';
      items = [];
      active = -1;
      input.removeAttribute('aria-activedescendant');
      var typed = input.value.toLowerCase().trimStart();

      data.suggestions.forEach(function (s) {
        var el = option('ac-suggestion');
        var span = document.createElement('span');
        // The typed part stays plain; the completion is emphasised.
        if (s.text.indexOf(typed) === 0 && typed.length) {
          span.appendChild(document.createTextNode(s.text.slice(0, typed.length)));
          var b = document.createElement('b');
          b.textContent = s.text.slice(typed.length);
          span.appendChild(b);
        } else {
          span.textContent = s.text;
        }
        el.appendChild(span);
        items.push({ el: el, text: s.text });
      });

      if (assetBase && data.docs.length) {
        var head = document.createElement('div');
        head.className = 'ac-head';
        head.textContent = 'Images';
        list.appendChild(head);
        data.docs.forEach(function (d) {
          var el = option('ac-doc');
          if (d.thumb) {
            var img = document.createElement('img');
            img.src = d.thumb;
            img.alt = '';
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            img.onerror = function () { img.remove(); };
            el.appendChild(img);
          }
          var span = document.createElement('span');
          span.textContent = d.title;
          el.appendChild(span);
          var back = location.pathname + location.search;
          items.push({ el: el, href: assetBase + '?' + new URLSearchParams({ id: d.id, back: back }) });
        });
      }

      items.forEach(function (item, i) {
        item.el.id = listId + '-' + i;
        item.el.addEventListener('click', function () { choose(item); });
      });
      if (items.length) open(); else close();
    }

    function option(cls) {
      var el = document.createElement('div');
      el.className = 'ac-option ' + cls;
      el.setAttribute('role', 'option');
      list.appendChild(el);
      return el;
    }

    function setActive(i) {
      if (active >= 0) items[active].el.classList.remove('active');
      active = i;
      if (i < 0) return input.removeAttribute('aria-activedescendant');
      items[i].el.classList.add('active');
      items[i].el.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', items[i].el.id);
    }

    function choose(item) {
      close();
      if (item.href) {
        location.href = item.href;
      } else {
        input.value = item.text;
        form.submit();
      }
    }

    function open() {
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
  }
})();

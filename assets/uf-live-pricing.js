/* Live pricing refresh.
   The static HTML already carries real numbers — the scheduled rebuild keeps them fresh
   for crawlers and no-JS visitors. This tops them up on load so a price changed in the
   staff dashboard is visible immediately rather than at the next rebuild.
   Fails silently: if the API is unreachable, the page keeps its built-in values. */
(function () {
  var els = document.querySelectorAll('[data-uf-price],[data-uf-plan],[data-uf-limit]');
  if (!els.length || !window.fetch) return;

  function setLeadingText(el, value) {
    // Only the element's own first text node — several of these wrap a nested <span>
    // (e.g. the "/mo" suffix, the "free tier" label) that must survive untouched.
    var first = el.firstChild;
    if (first && first.nodeType === 3) {
      if (first.nodeValue !== value) first.nodeValue = value;
    } else {
      el.insertBefore(document.createTextNode(value), first || null);
    }
  }

  var fmt = new Intl.NumberFormat('en-US');

  fetch('https://app.utmfox.com/api/v1/public/plans', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data || data.schema !== 1 || !data.plans || !data.plans.length) return;

      var price = {}, name = {}, limit = {};
      data.plans.forEach(function (p) {
        name[p.key] = p.name;
        // Mirrors priceLabel() in tools/sync-pricing.mjs — keep the two in step.
        price[p.key] = p.key === 'agency' ? 'Custom'
          : p.priceCents === 0 ? '$0'
          : '$' + fmt.format(Math.round(p.priceCents / 100));
        Object.keys(p.values || {}).forEach(function (fk) {
          var v = p.values[fk];
          if (typeof v === 'number') limit[p.key + ':' + fk] = fmt.format(v);
          else if (v === null) limit[p.key + ':' + fk] = 'Unlimited';
        });
      });

      Array.prototype.forEach.call(els, function (el) {
        var pk = el.getAttribute('data-uf-price');
        var nk = el.getAttribute('data-uf-plan');
        var lk = el.getAttribute('data-uf-limit');
        if (pk && price[pk] !== undefined) setLeadingText(el, price[pk]);
        if (nk && name[nk] !== undefined) setLeadingText(el, name[nk]);
        if (lk && limit[lk] !== undefined) setLeadingText(el, limit[lk]);
      });
    })
    .catch(function () { /* keep the built-in values */ });
})();

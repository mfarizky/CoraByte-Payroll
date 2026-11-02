/**
 * CoraByte Payroll — dropdown ("combo") and edit-lock helpers.
 *   GKI.combo({ items:[{value,label}], value, onChange(value), label, search })
 *   GKI.comboPanel(anchor, { items, value, onChange })
 *   GKI.lock(container, keepSelector) -> { set(locked) }
 */
(function () {
  window.GKI = window.GKI || {};
  var openPanelEl = null, closer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function closePanel() {
    if (openPanelEl && openPanelEl.parentNode) openPanelEl.parentNode.removeChild(openPanelEl);
    openPanelEl = null;
    if (closer) { document.removeEventListener('mousedown', closer, true); closer = null; }
  }

  function comboPanel(anchor, o) {
    closePanel();
    var items = o.items || [], value = o.value;
    var showSearch = o.search === true || (o.search !== false && items.length > 5);
    var panel = el('div', 'pr-cpanel');
    var q = null;
    if (showSearch) {
      q = el('input', 'pr-csearch');
      q.placeholder = o.searchPlaceholder || 'Search…';
      q.setAttribute('aria-label', 'Search');
      panel.appendChild(q);
    }
    var list = el('div', 'pr-clist');
    list.setAttribute('role', 'listbox');
    panel.appendChild(list);
    var shown = [], idx = 0;
    function pick(it) { closePanel(); if (o.onChange) o.onChange(it.value); }
    function draw() {
      list.textContent = '';
      var t = q ? q.value.trim().toLowerCase() : '';
      shown = items.filter(function (it) { return !t || String(it.label).toLowerCase().indexOf(t) !== -1; });
      if (!shown.length) list.appendChild(el('div', 'pr-cempty', 'No match.'));
      if (idx >= shown.length) idx = Math.max(0, shown.length - 1);
      shown.forEach(function (it, i) {
        var r = el('div', 'pr-copt' + (it.value === value ? ' sel' : '') + (i === idx ? ' hi' : ''), it.label);
        r.setAttribute('role', 'option');
        r.addEventListener('mousedown', function (ev) { ev.preventDefault(); pick(it); });
        r.addEventListener('mousemove', function () { if (idx !== i) { idx = i; draw(); } });
        list.appendChild(r);
      });
      var hi = list.querySelector('.hi');
      if (hi && hi.scrollIntoView) hi.scrollIntoView({ block: 'nearest' });
    }
    idx = Math.max(0, items.map(function (i) { return i.value; }).indexOf(value));
    var r = anchor.getBoundingClientRect();
    panel.style.left = Math.round(r.left + window.scrollX) + 'px';
    panel.style.top = Math.round(r.bottom + window.scrollY + 6) + 'px';
    panel.style.minWidth = Math.max(220, Math.round(r.width)) + 'px';
    document.body.appendChild(panel);
    openPanelEl = panel;
    closer = function (ev) { if (!panel.contains(ev.target) && !anchor.contains(ev.target)) closePanel(); };
    document.addEventListener('mousedown', closer, true);
    function key(ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); idx = Math.min(shown.length - 1, idx + 1); draw(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (shown[idx]) pick(shown[idx]); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closePanel(); if (anchor.focus) anchor.focus(); }
    }
    (q || panel).addEventListener('keydown', key);
    if (q) q.addEventListener('input', function () { idx = 0; draw(); });
    else { panel.tabIndex = -1; }
    draw();
    (q || panel).focus();
  }

  function combo(o) {
    var btn = el('button', 'pr-combo');
    btn.type = 'button';
    if (o.label) btn.setAttribute('aria-label', o.label);
    var txt = el('span', 'pr-combo-t');
    btn.appendChild(txt);
    btn.appendChild(el('i', null, '▾'));
    var value = o.value;
    function labelOf(v) {
      var f = (o.items || []).filter(function (i) { return i.value === v; })[0];
      return f ? f.label : '';
    }
    txt.textContent = labelOf(value);
    function open() {
      comboPanel(btn, { items: o.items, value: value, search: o.search, searchPlaceholder: o.searchPlaceholder,
        onChange: function (v) { value = v; txt.textContent = labelOf(v); if (o.onChange) o.onChange(v); } });
    }
    btn.addEventListener('click', function () { if (openPanelEl) closePanel(); else open(); });
    btn.getValue = function () { return value; };
    btn.open = open;
    return btn;
  }

  window.GKI.combo = combo;
  window.GKI.comboPanel = comboPanel;
  window.GKI.comboClose = closePanel;
}());

/* ── view/edit lock (redesign 2026-10-22) ───────────────────────────────
   GKI.lock(container, keepSel) -> { set(locked) }. While locked, every direct
   child of container (except those matching keepSel) is `inert`: no click, no
   focus, no typing. New children added by a redraw are locked too. */
(function () {
  window.GKI = window.GKI || {};
  GKI.lock = function (container, keepSel) {
    var locked = false, busy = false;
    function apply() {
      if (busy) return; busy = true;
      Array.prototype.forEach.call(container.children, function (ch) {
        var keep = keepSel && ch.matches(keepSel);
        if (locked && !keep) ch.setAttribute('inert', ''); else ch.removeAttribute('inert');
      });
      container.classList.toggle('pr-locked', locked);
      busy = false;
    }
    new MutationObserver(apply).observe(container, { childList: true });
    return { set: function (v) { locked = !!v; apply(); } };
  };
}());

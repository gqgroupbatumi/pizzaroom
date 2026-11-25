// Мини-движок: рисует шаблон (sc-if / sc-for / {{...}}) и перерисовывает при setState.
class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(o) { Object.assign(this.state, o); if (this.__mounted) this.__schedule(); }
}
function mountDC(Component, tpl, host, props) {
  const comp = new Component(props);
  const get = (scope, path) => { let o = scope; for (const p of path.split('.')) { if (o == null) return undefined; o = o[p]; } return o; };
  const one = /^\{\{\s*([\w.]+)\s*\}\}$/;
  const interp = (s, scope) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => { const v = get(scope, p); return v == null ? '' : String(v); });
  const build = (node, scope, out) => {
    if (node.nodeType === 3) { out.push(document.createTextNode(node.nodeValue.indexOf('{{') >= 0 ? interp(node.nodeValue, scope) : node.nodeValue)); return; }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'sc-if') { const m = one.exec(node.getAttribute('value') || ''); if (m && get(scope, m[1])) for (const c of node.childNodes) build(c, scope, out); return; }
    if (tag === 'sc-for') {
      const m = one.exec(node.getAttribute('list') || ''); const as = node.getAttribute('as');
      const list = (m && get(scope, m[1])) || [];
      for (const item of list) { const sc = Object.create(scope); sc[as] = item; for (const c of node.childNodes) build(c, sc, out); }
      return;
    }
    const el = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? document.createElementNS(node.namespaceURI, tag) : document.createElement(tag);
    for (const a of node.attributes) {
      const n = a.name, v = a.value;
      if (n.startsWith('hint-')) continue;
      const m = one.exec(v);
      if (n.startsWith('on') && m) { const fn = get(scope, m[1]); if (typeof fn === 'function') el.addEventListener(n.slice(2).toLowerCase(), fn); continue; }
      if (m && (n === 'disabled' || n === 'checked')) { if (get(scope, m[1])) el.setAttribute(n, ''); continue; }
      const val = v.indexOf('{{') >= 0 ? interp(v, scope) : v;
      el.setAttribute(n, val);
      if (n === 'value' && 'value' in el) el.value = val;
    }
    const kids = []; for (const c of node.childNodes) build(c, scope, kids); for (const k of kids) el.appendChild(k);
    out.push(el);
  };
  const pathOf = (el) => { const p = []; while (el && el !== host) { p.unshift(Array.prototype.indexOf.call(el.parentNode.childNodes, el)); el = el.parentNode; } return p; };
  const byPath = (p) => { let el = host; for (const i of p) { el = el && el.childNodes[i]; } return el; };
  let queued = false;
  const render = () => {
    queued = false;
    const scrolls = []; host.querySelectorAll('*').forEach((e) => { if (e.scrollTop > 0) scrolls.push([pathOf(e), e.scrollTop]); });
    const ae = document.activeElement; const focusId = ae && host.contains(ae) && ae.id ? ae.id : null; const sel = focusId && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
    const vals = comp.renderVals(); const out = [];
    for (const c of tpl.content.childNodes) build(c, vals, out);
    host.replaceChildren(...out);
    scrolls.forEach(([p, t]) => { const e = byPath(p); if (e) e.scrollTop = t; });
    if (focusId) { const e = document.getElementById(focusId); if (e) { e.focus(); if (sel) try { e.setSelectionRange(sel[0], sel[1]); } catch (x) {} } }
    if (comp.afterRender) comp.afterRender(host);
    if (comp.__didMount && comp.componentDidUpdate) comp.componentDidUpdate();
  };
  comp.__schedule = () => { if (!queued) { queued = true; requestAnimationFrame(render); } };
  comp.__mounted = true; render(); comp.__didMount = true;
  if (comp.componentDidMount) comp.componentDidMount();
  return comp;
}

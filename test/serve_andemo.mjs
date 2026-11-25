// ДЕМО онлайн-оплаты: банк — заглушка на этом же сервере (страница /__bank). Не для загрузки на сервер.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { D1Shim } from './d1shim.mjs';
import { handle, hashPin } from '../src/worker.js';
import { demoSeed } from './demo_seed.mjs';
const DB = new D1Shim();
DB.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
DB.exec(readFileSync(new URL('../seed.sql', import.meta.url), 'utf8'));
for (const [n, r, p] of [['Гиорги', 'owner', '7391'], ['Тамара', 'manager', '2580'], ['Нино', 'cashier', '482613']]) DB.db.prepare('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)').run(n, r, await hashPin(p, 's' + p), 's' + p);
const env = { DB }; const PORT = Number(process.env.PORT || 8799);
await handle(new Request('http://localhost/api/public/settings'), env); demoSeed(DB);
const TRG = DB.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all(); for (const t of TRG) DB.exec('DROP TRIGGER ' + t.name);
DB.exec(`UPDATE orders SET channel='takeaway' WHERE id % 4 = 1; UPDATE orders SET channel='site' WHERE id % 6 = 2; UPDATE orders SET channel='wolt' WHERE id % 7 = 3; UPDATE orders SET channel='glovo' WHERE id % 13 = 5;
UPDATE payments SET method='online' WHERE order_id IN (SELECT id FROM orders WHERE channel='site') AND order_id % 2 = 0;
UPDATE payments SET method='platform', commission_tetri = total_tetri * 33 / 100 WHERE order_id IN (SELECT id FROM orders WHERE channel IN ('wolt','glovo'));
UPDATE payments SET method='card' WHERE method='cash' AND order_id % 3 = 0;`);
for (const t of TRG) DB.exec(t.sql);
const PAYS = {}; let N = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opt = {}) => { u = String(u);
  const J = (d, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/tpay/access-token')) return J({ access_token: 'demo', expires_in: 86400 });
  if (u.endsWith('/tpay/payments') && opt.method === 'POST') { const b = JSON.parse(opt.body); const id = 'tpay-demo' + (++N); PAYS[id] = { status: 'Created', amount: b.amount.total, ret: b.returnurl, cb: b.callbackUrl };
    return J({ payId: id, status: 'Created', links: [{ rel: 'approval_url', uri: `http://localhost:${PORT}/__bank/${id}` }] }); }
  let m = u.match(/\/tpay\/payments\/([^/]+)\/cancel$/); if (m) { PAYS[m[1]].status = 'Returned'; PAYS[m[1]].returned = PAYS[m[1]].amount; return J({}); }
  m = u.match(/\/tpay\/payments\/([^/?]+)$/); if (m && PAYS[m[1]]) { const p = PAYS[m[1]]; return J({ status: p.status, amount: p.amount, returnedAmount: p.returned || 0 }); }
  return realFetch(u, opt); };
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', png: 'image/png', webp: 'image/webp', webmanifest: 'application/manifest+json', json: 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let m = url.pathname.match(/^\/__bank\/([^/]+)(\/pay|\/fail)?$/);
  if (m) { const p = PAYS[m[1]];
    if (m[2]) { p.status = m[2] === '/pay' ? 'Succeeded' : 'Failed'; await handle(new Request(p.cb, { method: 'POST', body: '{}' }), env); res.writeHead(302, { location: p.ret }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;background:#eef3f8;margin:0"><div style="background:#00a3e0;color:#fff;padding:16px 20px;font-weight:800">TBC Checkout · ДЕМО-заглушка банка</div><div style="max-width:380px;margin:30px auto;background:#fff;border-radius:16px;padding:22px;box-shadow:0 4px 20px #0001"><div style="color:#666">Pizza Room</div><div style="font-size:34px;font-weight:800;margin:6px 0 18px">${p.amount.toFixed(2)} ₾</div><div style="border:1px solid #ccd;border-radius:10px;padding:12px;color:#889;margin-bottom:10px">4242 •••• •••• 4242</div><div style="display:flex;gap:10px;margin-bottom:18px"><div style="flex:1;border:1px solid #ccd;border-radius:10px;padding:12px;color:#889">12/29</div><div style="flex:1;border:1px solid #ccd;border-radius:10px;padding:12px;color:#889">CVV</div></div><a id="pay" href="/__bank/${m[1]}/pay" style="display:block;text-align:center;background:#00a3e0;color:#fff;border-radius:10px;padding:14px;font-weight:800;text-decoration:none">Оплатить</a><a href="/__bank/${m[1]}/fail" style="display:block;text-align:center;color:#c00;margin-top:12px">Отменить</a></div>`); return; }
  // страницы для поисковиков (как на Cloudflare: главная и /ru/, /en/, /menu, /pizza/... проходят через сервер)
  { const fp = new URL('../public' + url.pathname, import.meta.url).pathname; const isFile = url.pathname !== '/' && existsSync(fp) && !statSync(fp).isDirectory();
    if (req.method === 'GET' && !isFile && !url.pathname.startsWith('/api/') && !/^\/(terms|refund|privacy|kassa|print)(\/|$)/.test(url.pathname)) {
      const env2 = Object.assign(Object.create(env), { ASSETS: { fetch: async () => new Response(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { headers: { 'content-type': 'text/html; charset=utf-8' } }) } });
      const r = await handle(new Request('https://pizzaroom.ge' + req.url, { redirect: 'manual' }), env2);
      const loc = r.headers.get('location'); res.writeHead(r.status, Object.assign({ 'content-type': r.headers.get('content-type') || 'text/plain' }, loc ? { location: loc.replace('https://pizzaroom.ge', '') } : {})); res.end(await r.text()); return; } }
  if (url.pathname.startsWith('/api/') || /^\/(terms|refund|privacy)\/?$/.test(url.pathname)) {
    const body = req.method === 'GET' ? undefined : await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const r = await handle(new Request('http://localhost:' + PORT + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': req.headers['x-ip'] || '127.0.0.1' }, body }), env);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') }); res.end(await r.text()); return;
  }
  let p = new URL('../public' + url.pathname, import.meta.url).pathname;
  if (existsSync(p) && statSync(p).isDirectory()) p += '/index.html';
  if (!existsSync(p)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[p.split('.').pop()] || 'application/octet-stream' }); res.end(readFileSync(p));
}).listen(PORT, () => console.log('ready'));

// Локальный сервер для проверки: API на тестовой базе + файлы из public
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { D1Shim } from './d1shim.mjs';
import { handle, hashPin } from '../src/worker.js';
const DB = new D1Shim();
DB.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
DB.exec(readFileSync(new URL('../seed.sql', import.meta.url), 'utf8'));
for (const [n, r, p] of [['Гиорги', 'owner', '7391'], ['Тамара', 'manager', '2580'], ['Нино', 'cashier', '482613']]) DB.db.prepare('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)').run(n, r, await hashPin(p, 's' + p), 's' + p);
const env = { DB };
if (process.env.DEMO) { await handle(new Request('http://localhost/api/public/catalog'), env); (await import('./demo_seed.mjs')).demoSeed(DB); }
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', png: 'image/png', webp: 'image/webp', webmanifest: 'application/manifest+json', json: 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'GET' ? undefined : await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    const r = await handle(new Request('http://localhost' + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': req.headers['x-ip'] || '127.0.0.1' }, body }), env);
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); return;
  }
  let p = new URL('../public' + url.pathname, import.meta.url).pathname;
  if (existsSync(p) && statSync(p).isDirectory()) p += '/index.html';
  if (!existsSync(p)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[p.split('.').pop()] || 'application/octet-stream' }); res.end(readFileSync(p));
}).listen(Number(process.env.PORT || 8787), () => console.log('ready'));

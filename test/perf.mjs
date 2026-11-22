// замер: сколько запросов к базе делает каждый экран админки (каждый запрос к D1 ≈ 20–50 мс в реальности)
import { readFileSync } from 'node:fs';
import { D1Shim } from './d1shim.mjs';
import { handle, hashPin } from '../src/worker.js';
let LAT = 0; const DB = new D1Shim(); let Q = 0; const P = DB.prepare.bind(DB); const B = DB.batch.bind(DB);
DB.prepare = (sql) => { const s = P(sql); const wrap = (st) => { for (const m of ['first', 'all', 'run']) { const f = st[m].bind(st); st[m] = async (...a) => { Q++; if (LAT) await new Promise((r) => setTimeout(r, LAT)); return f(...a); }; } const bd = st.bind.bind(st); st.bind = (...a) => wrap(bd(...a)); return st; }; return wrap(s); };
DB.batch = async (x) => { Q++; if (LAT) await new Promise((r) => setTimeout(r, LAT)); return B(x); };
DB.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); DB.exec(readFileSync(new URL('../seed.sql', import.meta.url), 'utf8'));
for (const [n, r, p] of [['Гиорги', 'owner', '7391'], ['Нино', 'cashier', '482613']]) DB.db.prepare('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)').run(n, r, await hashPin(p, 's' + p), 's' + p);
const env = { DB };
const api = async (m, path, body, tok) => { const r = await handle(new Request('https://pizzaroom.ge' + path, { method: m, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.1.1.1', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return r.json().catch(() => ({})); };
const own = (await api('POST', '/api/login', { pin: '7391', device: 'p' })).token; const cs = (await api('POST', '/api/login', { pin: '482613', device: 'k' })).token;
await api('POST', '/api/shifts/open', { opening_cash_tetri: 0 }, cs);
const N = Number(process.env.N || 400); const prods = ['marg', 'pep', 'carb', 'hawaii', 'cola'];
for (let i = 0; i < N; i++) { const o = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: prods[i % 5], qty: 1 + (i % 3) }, { product_id: prods[(i + 2) % 5], qty: 1 }] }, cs); if (o.id) await api('POST', `/api/orders/${o.id}/pay`, { method: i % 2 ? 'cash' : 'card' }, cs); }
for (const t of DB.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all()) { DB.db.exec('DROP TRIGGER ' + t.name); globalThis.__TR = (globalThis.__TR || []).concat(t.sql); }
DB.db.exec(`UPDATE orders SET created_at = datetime(created_at, '-' || (id % 90) || ' days'), paid_at = datetime(created_at, '-' || (id % 90) || ' days')`);
DB.db.exec(`UPDATE payments SET created_at = datetime(created_at, '-' || (order_id % 90) || ' days')`);
for (const sql of globalThis.__TR || []) DB.db.exec(sql);
const m = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 7); const y = m.slice(0, 4); const today = new Date().toISOString().slice(0, 10);
const list = [['GET', '/api/me'], ['GET', '/api/orders'], ['GET', '/api/catalog'], ['GET', '/api/holidays'], ['GET', '/api/public/settings'], ['GET', '/api/cash'], ['GET', '/api/advice'], ['GET', '/api/combos'], ['GET', '/api/party'], ['GET', '/api/settlements'],
  ['GET', '/api/pnl?month=' + m], ['GET', '/api/pnl/months?year=' + y], ['GET', '/api/setup-check'], ['GET', '/api/expenses?month=' + m], ['GET', '/api/expenses/months?year=' + y], ['GET', '/api/payroll?month=' + m], ['GET', '/api/staff'], ['GET', '/api/customers'], ['GET', '/api/waitlist'],
  ['GET', '/api/stock/moves?limit=60'], ['GET', '/api/stock/forecast'], ['GET', '/api/shifts'], ['GET', '/api/reports/staff'], ['GET', '/api/complaints'], ['GET', '/api/settings'], ['GET', '/api/branches'], ['GET', '/api/owner/security'], ['GET', '/api/print/status'], ['GET', '/api/test'],
  ['GET', '/api/schedule?month=' + m], ['GET', '/api/people'], ['GET', '/api/audit?limit=200'], ['GET', '/api/paygw'], ['GET', `/api/reports/insights?from=${m}-01&to=${today}`], ['GET', '/api/kitchen'], ['GET', '/api/public/menu'], ['GET', '/api/stoplist'], ['GET', `/api/reports/summary?group=day&from=${m}-01&to=${today}`], ['GET', `/api/reports/products?from=${m}-01&to=${today}`]];
LAT = Number(process.env.LAT || 0); const res = [];
for (const [mm, p] of list) { Q = 0; const t = performance.now(); await api(mm, p, null, own); res.push([p, Q, Math.round(performance.now() - t)]); }
// аналитика — что грузит loadAnalytics
res.sort((a, b) => b[2] - a[2]); for (const r of res) console.log(String(r[1]).padStart(5), 'запросов', String(r[2]).padStart(5), 'мс (70мс на запрос, как на живом сервере)  ', r[0]);

// Pizza Room — сервер (Cloudflare Worker + D1)
// Главные правила безопасности:
//  • цены всегда берутся из базы, цене с экрана кассы сервер не верит;
//  • отмена, уменьшение после кухни, скидка, списание — только с PIN менеджера;
//  • журнал действий — цепочка хешей, изменить или удалить запись нельзя;
//  • смена закрывается вслепую: кассир не видит, сколько денег должно быть.

const PBKDF2_ITERATIONS = 20000;
const SESSION_HOURS = 14;
const MAX_FAILED_LOGINS = 5;          // за 10 минут с одного устройства
const MAX_FAILED_IP = 8;              // за 10 минут с одного интернет-адреса
const MAX_FAILED_ALL = 30;            // за 10 минут всего — значит, кто-то подбирает PIN
const clientIp = (request) => (request && request.headers && (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim()) || 'local';
const MAX_DISCOUNT_BP = 3000;         // 30%

const PERMS = {
  cashier: ['menu.read', 'order.create', 'order.edit', 'order.send', 'order.pay', 'order.fiscal', 'shift.open', 'shift.close', 'product.stop', 'kitchen.view'],
  cook: ['menu.read', 'kitchen.view'],
  manager: ['menu.read', 'order.create', 'order.edit', 'order.send', 'order.pay', 'order.fiscal', 'shift.open', 'shift.close', 'product.stop',
    'order.cancel', 'order.decrease_sent', 'order.discount', 'prices.edit', 'menu.edit', 'stock.view', 'stock.receipt', 'stock.writeoff',
    'stock.inventory', 'reports.view', 'kitchen.view', 'settings.edit', 'shifts.view', 'payroll.manage'],
  owner: ['*']
};
const can = (staff, perm) => { const p = PERMS[staff.role] || []; return p.includes('*') || p.includes(perm); };

// ───────── утилиты ─────────
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const MAX_BODY = 256 * 1024; // 256 КБ — больше заказам и настройкам не нужно
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000', 'permissions-policy': 'camera=(), microphone=(), payment=(), usb=()', 'cross-origin-opener-policy': 'same-origin' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, SEC_HEADERS) });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomHex = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
const isoNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const int = (v, name) => { const n = Number(v); if (!Number.isInteger(n)) fail(400, 'bad_input', `Поле ${name} должно быть целым числом`); return n; };

export async function hashPin(pin, salt) {
  if (!/^\d{4,8}$/.test(String(pin))) fail(400, 'bad_pin', 'PIN — от 4 до 8 цифр');
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

// ───────── база ─────────
// Кэш чтений на время ОДНОГО запроса: одинаковый SELECT второй раз не идёт в базу (каждый поход в D1 — десятки мс).
// Любая запись (run/batch) кэш очищает, чтобы после записи читались свежие данные. Отдаём копию, чтобы правки строк не портили кэш.
const qcGet = (env, kind, sql, a, load) => {
  const qc = env.__qc; if (!qc || !/^\s*(SELECT|WITH)\b/i.test(sql)) return load();
  const k = kind + '\u0001' + sql + '\u0001' + JSON.stringify(a); let p = qc.get(k);
  if (!p) { p = load(); qc.set(k, p); p.catch(() => qc.delete(k)); }
  return p.then((v) => (v == null ? v : structuredClone(v)));
};
const qcClear = (env) => { if (env.__qc) env.__qc.clear(); };
const db = (env) => ({
  one: (sql, ...a) => qcGet(env, 'o', sql, a, () => env.DB.prepare(sql).bind(...a).first()),
  all: (sql, ...a) => qcGet(env, 'a', sql, a, async () => (await env.DB.prepare(sql).bind(...a).all()).results),
  run: async (sql, ...a) => { qcClear(env); const r = (await env.DB.prepare(sql).bind(...a).run()).meta; qcClear(env); return r; },
  stmt: (sql, ...a) => env.DB.prepare(sql).bind(...a),
  batch: async (stmts) => { qcClear(env); const r = await env.DB.batch(stmts); qcClear(env); return r; }
});

async function audit(env, staffId, action, entity, entityId, details) {
  const D = db(env);
  const prev = await D.one('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prevHash = prev ? prev.hash : 'GENESIS';
  const ts = isoNow();
  const det = details === undefined ? null : JSON.stringify(details);
  const hash = await sha256(prevHash + '|' + [ts, staffId ?? '', action, entity ?? '', entityId ?? '', det ?? ''].join('|'));
  await D.run('INSERT INTO audit_log (ts, staff_id, action, entity, entity_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
    ts, staffId ?? null, action, entity ?? null, entityId == null ? null : String(entityId), det, prevHash, hash);
}

// Секреты (токен Telegram-бота и т.п.) — в отдельной таблице, никогда не отдаются в /api/settings
async function secretGet(env, key) { try { const r = await db(env).one('SELECT value FROM secrets WHERE key = ?', key); return r ? JSON.parse(r.value) : null; } catch (e) { return null; } }
async function secretSet(env, key, v) { await db(env).run('INSERT INTO secrets (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(v)); }
async function tgConf(env) { if (env.TG_TOKEN && env.TG_CHAT) return { token: env.TG_TOKEN, chat: env.TG_CHAT }; return (await secretGet(env, 'tg')) || {}; }
async function tgCall(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
  return r.json().catch(() => ({ ok: false }));
}
async function tgSend(env, chat, text, extra) { const c = await tgConf(env); if (!c.token || !chat) return false; try { const r = await tgCall(c.token, 'sendMessage', Object.assign({ chat_id: chat, text, disable_web_page_preview: true }, extra || {})); return !!r.ok; } catch (e) { return false; } }
async function notify(env, text) {
  try { const c = await tgConf(env); if (!c.token || !c.chat) return; await tgSend(env, c.chat, 'Pizza Room · ' + text); } catch (e) { /* уведомление не должно ломать кассу */ }
}

async function findStaffByPin(env, pin, roles) {
  const list = await db(env).all('SELECT * FROM staff WHERE active = 1');
  for (const s of list) {
    if (roles && !roles.includes(s.role)) continue;
    if (await hashPin(pin, s.pin_salt) === s.pin_hash) return s;
  }
  return null;
}

async function authenticate(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) fail(401, 'no_session', 'Войдите по PIN');
  const s = await db(env).one(`SELECT st.* FROM sessions se JOIN staff st ON st.id = se.staff_id
    WHERE se.token = ? AND se.expires_at > ? AND st.active = 1`, token, isoNow());
  if (!s) fail(401, 'session_expired', 'Сессия закончилась, войдите снова');
  return s;
}

// Подтверждение менеджера. Менеджер и владелец действуют сами; кассиру нужен PIN другого сотрудника с ролью manager/owner.
async function requireApproval(env, me, approvalPin, action, orderId, details) {
  if (me.role === 'manager' || me.role === 'owner') {
    await db(env).run('INSERT INTO approvals (action, order_id, requested_by, approved_by, details) VALUES (?,?,?,?,?)', action, orderId ?? null, me.id, me.id, JSON.stringify(details ?? {}));
    return me;
  }
  if (!approvalPin) fail(403, 'approval_required', 'Нужно подтверждение менеджера');
  const approver = await findStaffByPin(env, approvalPin, ['manager', 'owner']);
  if (!approver || approver.id === me.id) {
    await audit(env, me.id, 'approval.failed', 'order', orderId, { action });
    await notify(env, `Неверный PIN менеджера: ${me.name} пытался «${action}» (заказ ${orderId ?? '—'})`);
    fail(403, 'approval_failed', 'Неверный PIN менеджера — попытка записана');
  }
  await db(env).run('INSERT INTO approvals (action, order_id, requested_by, approved_by, details) VALUES (?,?,?,?,?)', action, orderId ?? null, me.id, approver.id, JSON.stringify(details ?? {}));
  return approver;
}

async function loadOrder(env, id) {
  const o = await db(env).one('SELECT * FROM orders WHERE id = ?', id);
  if (!o) fail(404, 'not_found', 'Заказ не найден');
  o.items = await db(env).all(`SELECT oi.*, p.name_ru, p.name_ka FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ? ORDER BY oi.id`, id);
  return withTotals(o);
}
function withTotals(o) {
  const sub = o.items.reduce((s, i) => s + i.qty * i.unit_price_tetri, 0);
  const plat = Math.round(sub * (o.platform_disc_bp || 0) / 10000);
  const disc = Math.round((sub - plat) * o.discount_bp / 10000);
  o.subtotal_tetri = sub; o.platform_discount_tetri = plat; o.manual_discount_tetri = disc;
  o.discount_tetri = plat + disc; o.total_tetri = sub - plat - disc + (o.delivery_fee_tetri || 0);
  delete o.track_token; delete o.source_ip;
  return o;
}
const editable = (o) => { if (o.status !== 'open' && o.status !== 'sent') fail(409, 'order_closed', 'Заказ уже оплачен или отменён'); };

async function priceFor(env, productId, channel) {
  const r = await db(env).one(`SELECT pr.price_tetri, p.active, p.in_stock, p.category_id, cat.soon FROM channels c
    JOIN prices pr ON pr.price_list = c.price_list AND pr.product_id = ?
    JOIN products p ON p.id = pr.product_id JOIN categories cat ON cat.id = p.category_id WHERE c.id = ?`, productId, channel);
  if (!r || !r.active) fail(400, 'no_price', 'Нет цены для этой позиции в этом канале');
  if (r.soon) fail(409, 'soon', 'Этот раздел скоро откроется');
  if (!r.in_stock) fail(409, 'stopped', 'Позиция в стоп-листе');
  const promo = await activePromo(env, channel);
  if (promo && (promo.cats.includes(r.category_id) || promo.cats.includes(productId))) return Math.round(r.price_tetri * (100 - promo.pct) / 100);
  return r.price_tetri;
}
// Акция, которая действует сегодня (по времени Тбилиси) для этого канала
const tbDate = (d = new Date()) => new Date(d.getTime() + 4 * 3600e3).toISOString().slice(0, 10);
/* акция по дням недели: wdays = '[2]' — только по вторникам; пусто — каждый день */
const wdOk = (p, d) => { let w = null; try { w = p.wdays ? JSON.parse(p.wdays) : null; } catch (e) {} return !w || !w.length || w.includes(new Date(d + 'T12:00:00Z').getUTCDay()); };
async function activePromo(env, channel) {
  const t = tbDate();
  const rows = await db(env).all('SELECT * FROM promos WHERE active = 1 AND date_from <= ? AND date_to >= ? ORDER BY pct DESC', t, t);
  for (const r of rows) {
    const ch = JSON.parse(r.channels || '[]'); if (!ch.includes(channel) || !wdOk(r, t)) continue;
    return Object.assign(r, { cats: JSON.parse(r.cats || '[]'), channels: ch });
  }
  return null;
}

async function openShiftOf(env, staffId) {
  return db(env).one('SELECT * FROM shifts WHERE staff_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', staffId);
}

// Списание продуктов по рецептам (продажа или приготовленное, но отменённое)
// Свои заготовки (тесто, маринованная курица…): у ингредиента есть состав на 1000 единиц (г / мл / шт).
// Со склада списывается сырьё, сама заготовка на складе не числится; её цена считается из сырья.
async function partsMap(env) {
  const m = {}; for (const r of await db(env).all('SELECT parent_id, child_id, qty_per_1000 FROM ingredient_parts')) (m[r.parent_id] ||= []).push(r); return m;
}
function expandIng(parts, id, qty, out, depth = 0) {
  const ps = parts[id];
  if (!ps || !ps.length || depth > 4) { out[id] = (out[id] || 0) + qty; return out; }
  for (const p of ps) expandIng(parts, p.child_id, qty * p.qty_per_1000 / 1000, out, depth + 1);
  return out;
}
const q2 = (x) => Math.round(x * 100) / 100;
async function refreshComposite(env) {
  const D = db(env); const parts = await partsMap(env); const ids = Object.keys(parts); if (!ids.length) return;
  const cost = Object.fromEntries((await D.all('SELECT id, cost_per_1000_tetri FROM ingredients')).map((r) => [r.id, r.cost_per_1000_tetri]));
  const st = ids.map((id) => { const raw = expandIng(parts, id, 1000, {});
    return D.stmt('UPDATE ingredients SET cost_per_1000_tetri = ? WHERE id = ?', Math.round(Object.entries(raw).reduce((s, [k, q]) => s + q * (cost[k] || 0) / 1000, 0)), id); });
  await D.batch(st);
}
async function recipeMoves(env, items, kind, orderId, staffId, approvedBy, reason) {
  const D = db(env); const stmts = []; const parts = await partsMap(env); let cost = null;
  for (const it of items) {
    if (!it.qty) continue;
    const rec = await D.all('SELECT r.ingredient_id, r.qty FROM recipes r WHERE r.product_id = ?', it.product_id);
    const raw = {}; for (const r of rec) expandIng(parts, r.ingredient_id, r.qty * it.qty, raw);
    if (!cost) cost = Object.fromEntries((await D.all('SELECT id, cost_per_1000_tetri FROM ingredients')).map((r) => [r.id, r.cost_per_1000_tetri]));
    for (const [ing, q] of Object.entries(raw)) {
      const used = q2(q); if (!used) continue;
      stmts.push(D.stmt('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, order_id, staff_id, approved_by, cost_tetri) VALUES (?,?,?,?,?,?,?,?)',
        ing, -used, kind, reason ?? null, orderId, staffId, approvedBy ?? null, Math.round(used * (cost[ing] || 0) / 1000)));
    }
  }
  return stmts;
}

// Упаковка: коробка для пиццы, стакан для кофе. Списывается при оплате; mode 'away' — только навынос/доставка/площадки, 'always' — и в зале
async function packMoves(env, o, staffId) {
  const D = db(env); const st = []; const extra = {};
  const ids = [...new Set(o.items.filter((i) => i.qty > 0).map((i) => i.product_id))]; if (!ids.length) return { st, extra };
  const rows = await D.all(`SELECT p.id, p.pack_qty, p.pack_mode, i.id AS ing, i.cost_per_1000_tetri FROM products p JOIN ingredients i ON i.id = p.pack_ing
    WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const it of o.items) {
    const r = by[it.product_id]; if (!r || !it.qty) continue;
    if (r.pack_mode !== 'always' && o.channel === 'hall') continue;
    const used = (r.pack_qty || 1) * it.qty;
    st.push(D.stmt('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, order_id, staff_id, cost_tetri) VALUES (?,?,?,?,?,?,?)', r.ing, -used, 'sale', 'Упаковка', o.id, staffId, Math.round(used * r.cost_per_1000_tetri / 1000)));
    extra[it.id] = Math.round((r.pack_qty || 1) * r.cost_per_1000_tetri / 1000);
  }
  return { st, extra };
}

// ───────── маршруты ─────────
const routes = [];
const on = (method, pattern, perm, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), perm, handler });

// Вход по PIN
on('POST', '/api/login', null, async ({ env, body, request }) => {
  const D = db(env); const device = String(body.device || 'unknown').slice(0, 64);
  const ip = clientIp(request);
  // защита от подбора PIN: лимит по устройству, по интернет-адресу и общий (название устройства можно подделать, адрес — нет)
  const fails = await D.one(`SELECT COUNT(*) AS n FROM login_attempts WHERE device = ? AND ok = 0 AND created_at > datetime('now','-10 minutes')`, device);
  const failsIp = await D.one(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at > datetime('now','-10 minutes')`, ip);
  const failsAll = await D.one(`SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND created_at > datetime('now','-10 minutes')`);
  if (fails.n >= MAX_FAILED_LOGINS || failsIp.n >= MAX_FAILED_IP) fail(429, 'locked', 'Слишком много неверных PIN. Подождите 10 минут или позовите менеджера');
  if (failsAll.n >= MAX_FAILED_ALL) fail(429, 'locked', 'Вход временно закрыт: слишком много неверных PIN. Подождите 10 минут');
  if (typeof body.pin !== 'string' && typeof body.pin !== 'number' || String(body.pin).length > 12) fail(400, 'bad_pin', 'Неверный PIN');
  const s = await findStaffByPin(env, String(body.pin));
  await D.run('INSERT INTO login_attempts (device, ok, ip) VALUES (?,?,?)', device, s ? 1 : 0, ip);
  if (!s && failsAll.n + 1 === MAX_FAILED_ALL) await notify(env, `⚠️ Похоже на подбор PIN: ${MAX_FAILED_ALL} неверных попыток за 10 минут. Вход закрыт на 10 минут. Последний адрес: ${ip}`);
  if (!s) {
    await audit(env, null, 'login.failed', 'device', device);
    if (fails.n + 1 >= MAX_FAILED_LOGINS) await notify(env, `Касса «${device}» заблокирована на 10 минут: ${MAX_FAILED_LOGINS} неверных PIN подряд`);
    fail(401, 'bad_pin', 'Неверный PIN');
  }
  const token = randomHex(32);
  const exp = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  await D.run('INSERT INTO sessions (token, staff_id, device, expires_at) VALUES (?,?,?,?)', token, s.id, device, exp);
  await audit(env, s.id, 'login', 'device', device);
  return { token, staff: { id: s.id, name: s.name, role: s.role } };
});

// Меню для кассы с ценой выбранного канала
on('GET', '/api/menu', 'menu.read', async ({ env, url }) => {
  const channel = url.searchParams.get('channel') || 'hall';
  const rows = await db(env).all(`SELECT p.id, p.category_id, p.name_ru, p.name_ka, p.name_en, p.size, p.photo, p.in_stock, pr.price_tetri
    FROM products p JOIN channels c ON c.id = ? JOIN prices pr ON pr.product_id = p.id AND pr.price_list = c.price_list
    JOIN categories cat ON cat.id = p.category_id WHERE p.active = 1 AND cat.active = 1 AND cat.soon = 0 ORDER BY cat.sort, p.sort`, channel);
  // акция программы: цена в кассе сразу со скидкой — кассир ничего не вводит
  const promo = await activePromo(env, channel);
  if (promo) for (const r of rows) if (promo.cats.includes(r.category_id) || promo.cats.includes(r.id)) { r.base_tetri = r.price_tetri; r.price_tetri = Math.round(r.price_tetri * (100 - promo.pct) / 100); r.promo_pct = promo.pct; }
  return rows;
});
on('GET', '/api/promo/now', 'menu.read', async ({ env, url }) => {
  const p = await activePromo(env, url.searchParams.get('channel') || 'hall'); if (!p) return { on: false };
  const names = await db(env).all(`SELECT id, name_ka, name_ru FROM products WHERE id IN (${p.cats.map(() => '?').join(',') || "''"})`, ...p.cats);
  const cats = await db(env).all(`SELECT id, name_ka, name_ru FROM categories WHERE id IN (${p.cats.map(() => '?').join(',') || "''"})`, ...p.cats);
  return { on: true, pct: p.pct, title_ka: p.title_ka, title_ru: p.title_ru, to: p.date_to, on_ka: [...cats, ...names].map((x) => x.name_ka || x.name_ru) };
});

// Публичное меню для сайта (цены зала/сайта)
on('GET', '/api/public/menu', null, async ({ env }) => db(env).all(`SELECT p.id, p.category_id, p.name_ka, p.name_en, p.name_ru, p.desc_ka, p.desc_en, p.desc_ru,
  p.size, p.photo, p.in_stock, pr.price_tetri FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.price_list = 'base' WHERE p.active = 1 ORDER BY p.sort`));

on('GET', '/api/public/catalog', null, async ({ env }) => ({
  combos: await publicCombos(env, { showPaused: true }),
  categories: await db(env).all('SELECT id, sort, name_ka, name_en, name_ru, soon, age18 FROM categories c WHERE active = 1 AND (soon = 1 OR EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.active = 1)) ORDER BY sort'),
  products: await db(env).all(`SELECT p.id, p.category_id, p.name_ka, p.name_en, p.name_ru, p.desc_ka, p.desc_en, p.desc_ru, p.size, p.photo, p.in_stock, pr.price_tetri
    FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.price_list = 'base' JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1 ORDER BY c.sort, p.sort`)
}));

// Смены
on('POST', '/api/shifts/open', 'shift.open', async ({ env, me, body }) => {
  if (await openShiftOf(env, me.id)) fail(409, 'shift_open', 'Смена уже открыта');
  const cash = int(body.opening_cash_tetri ?? 0, 'opening_cash_tetri');
  const m = await db(env).run('INSERT INTO shifts (staff_id, opening_cash_tetri, is_test) VALUES (?,?,?)', me.id, cash, (await testMode(env)) ? 1 : 0);
  await audit(env, me.id, 'shift.open', 'shift', m.last_row_id, { opening_cash_tetri: cash });
  return { shift_id: m.last_row_id };
});

on('POST', '/api/shifts/close', 'shift.close', async ({ env, me, body }) => {
  const sh = await openShiftOf(env, me.id); if (!sh) fail(409, 'no_shift', 'Смена не открыта');
  const counted = int(body.counted_cash_tetri, 'counted_cash_tetri');
  const cash = await db(env).one(`SELECT COALESCE(SUM(total_tetri),0) AS s FROM payments WHERE shift_id = ? AND method = 'cash'`, sh.id);
  const out = await db(env).one('SELECT COALESCE(SUM(amount_tetri),0) AS s FROM cash_moves WHERE shift_id = ?', sh.id);
  const expected = sh.opening_cash_tetri + cash.s - out.s; const diff = counted - expected;
  await db(env).run('UPDATE shifts SET closed_at = ?, counted_cash_tetri = ?, expected_cash_tetri = ?, diff_tetri = ? WHERE id = ?', isoNow(), counted, expected, diff, sh.id);
  await audit(env, me.id, 'shift.close', 'shift', sh.id, { counted, expected, diff });
  const unfiscal = await db(env).one(`SELECT COUNT(*) AS n FROM payments p LEFT JOIN fiscal_receipts f ON f.order_id = p.order_id WHERE p.shift_id = ? AND p.method IN ('cash','card') AND f.order_id IS NULL`, sh.id);
  await notify(env, `Смена ${me.name} закрыта. Наличные по системе ${(expected / 100).toFixed(2)} ₾, насчитано ${(counted / 100).toFixed(2)} ₾, разница ${(diff / 100).toFixed(2)} ₾. Оплат без фискального чека: ${unfiscal.n}`);
  return { closed: true }; // кассиру — только факт закрытия, без цифр
});

// Заказы
on('POST', '/api/orders', 'order.create', async ({ env, me, body }) => {
  const channel = String(body.channel || 'hall');
  if (!(await db(env).one('SELECT id FROM channels WHERE id = ?', channel))) fail(400, 'bad_channel', 'Неизвестный канал');
  const sh = await openShiftOf(env, me.id); if (!sh) fail(409, 'no_shift', 'Сначала откройте смену');
  if (body.external_id && await db(env).one('SELECT id FROM orders WHERE channel = ? AND external_id = ?', channel, body.external_id))
    fail(409, 'duplicate', 'Этот заказ площадки уже пробит');
  const S = await getSettings(env);
  const platBp = ['wolt', 'glovo'].includes(channel) ? Math.round((Number(S.delivery.aggDisc) || 0) * 100) : 0;
  const fee = channel === 'delivery' ? Math.max(0, int(body.delivery_fee_tetri ?? 0, 'delivery_fee_tetri')) : 0;
  const m = await db(env).run('INSERT INTO orders (channel, external_id, shift_id, created_by, customer_phone, note, platform_disc_bp, delivery_fee_tetri, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)',
    channel, body.external_id ?? null, sh.id, me.id, body.customer_phone ?? null, body.note ?? null, platBp, fee, isoNow());
  const id = m.last_row_id;
  if (await testMode(env)) await db(env).run('UPDATE orders SET is_test = 1 WHERE id = ?', id);
  for (const it of body.items || []) {
    const qty = int(it.qty, 'qty'); if (qty < 1) fail(400, 'bad_qty', 'Количество от 1');
    const price = await priceFor(env, it.product_id, channel);   // цена — только из базы
    await db(env).run('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri, added_by) VALUES (?,?,?,?,?)', id, it.product_id, qty, price, me.id);
  }
  await audit(env, me.id, 'order.create', 'order', id, { channel, external_id: body.external_id ?? null });
  return loadOrder(env, id);
});

on('GET', '/api/orders/:id', 'order.create', async ({ env, params }) => loadOrder(env, int(params.id, 'id')));

on('POST', '/api/orders/:id/items', 'order.edit', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  const qty = int(body.qty ?? 1, 'qty'); if (qty < 1) fail(400, 'bad_qty', 'Количество от 1');
  const price = await priceFor(env, body.product_id, o.channel);
  const same = o.items.find((i) => i.product_id === body.product_id && !i.sent && !i.combo_n);
  if (same) await db(env).run('UPDATE order_items SET qty = qty + ? WHERE id = ?', qty, same.id);
  else await db(env).run('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri, added_by) VALUES (?,?,?,?,?)', o.id, body.product_id, qty, price, me.id);
  await audit(env, me.id, 'order.add_item', 'order', o.id, { product_id: body.product_id, qty });
  return loadOrder(env, o.id);
});

// Уменьшить позицию. Если она уже на кухне — только с менеджером, и пицца уходит в списание.
on('POST', '/api/orders/:id/items/:itemId/decrease', 'order.edit', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  const it = o.items.find((i) => i.id === int(params.itemId, 'itemId')); if (!it) fail(404, 'not_found', 'Позиция не найдена');
  if (it.combo_n) {
    // комбо убираем целиком: цена разложена по всем его позициям
    const group = o.items.filter((x) => x.combo_n === it.combo_n && x.qty > 0);
    let approver = null;
    if (group.some((x) => x.sent)) {
      approver = await requireApproval(env, me, body.approval_pin, 'Убрать комбо после кухни', o.id, { combo: it.combo_id });
      const moves = await recipeMoves(env, group.filter((x) => x.sent).map((x) => ({ product_id: x.product_id, qty: x.qty })), 'writeoff', o.id, me.id, approver.id, 'Комбо убрано из заказа после кухни');
      if (moves.length) await db(env).batch(moves);
    }
    await db(env).batch(group.map((x) => db(env).stmt('UPDATE order_items SET qty = 0 WHERE id = ?', x.id)));
    await audit(env, me.id, 'order.remove_combo', 'order', o.id, { combo: it.combo_id, approved_by: approver?.id ?? null });
    return loadOrder(env, o.id);
  }
  const qty = int(body.qty ?? 1, 'qty'); if (qty < 1 || qty > it.qty) fail(400, 'bad_qty', 'Неверное количество');
  let approver = null;
  if (it.sent) {
    approver = await requireApproval(env, me, body.approval_pin, 'Убрать позицию после кухни', o.id, { item: it.name_ru, qty });
    const moves = await recipeMoves(env, [{ product_id: it.product_id, qty }], 'writeoff', o.id, me.id, approver.id, 'Убрано из заказа после кухни');
    if (moves.length) await db(env).batch(moves);
    await notify(env, `${approver.id === me.id ? me.name : 'Менеджер'} разрешил убрать «${it.name_ru}» ×${qty} из заказа №${o.id} после кухни (кассир ${me.name})`);
  }
  await db(env).run('UPDATE order_items SET qty = qty - ? WHERE id = ?', qty, it.id);
  await audit(env, me.id, it.sent ? 'order.decrease_sent' : 'order.decrease', 'order', o.id, { item: it.name_ru, qty, approved_by: approver?.id ?? null });
  return loadOrder(env, o.id);
});

on('POST', '/api/orders/:id/send', 'order.send', async ({ env, me, params }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  if (!o.items.some((i) => i.qty > 0)) fail(400, 'empty', 'Заказ пустой');
  await db(env).batch([
    db(env).stmt('UPDATE order_items SET sent = 1 WHERE order_id = ? AND qty > 0', o.id),
    db(env).stmt(`UPDATE orders SET status = 'sent', sent_at = COALESCE(sent_at, ?) WHERE id = ?`, isoNow(), o.id)
  ]);
  await audit(env, me.id, 'order.send', 'order', o.id);
  return loadOrder(env, o.id);
});

// Наша доставка: клиент платит курьеру (наличными или картой). Заказ сразу идёт на кухню,
// оплату кассир отмечает, когда курьер вернулся и сдал деньги / чек терминала.
on('POST', '/api/orders/:id/courier', 'order.send', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  if (o.channel !== 'delivery') fail(400, 'not_delivery', 'Оплата курьеру — только для нашей доставки');
  if (!o.items.some((i) => i.qty > 0)) fail(400, 'empty', 'Заказ пустой');
  const m = body.method === 'card' ? 'card' : 'cash';
  await db(env).batch([
    db(env).stmt('UPDATE order_items SET sent = 1 WHERE order_id = ? AND qty > 0', o.id),
    db(env).stmt(`UPDATE orders SET status = 'sent', sent_at = COALESCE(sent_at, ?), pay_on = ?, mode = 'delivery' WHERE id = ?`, isoNow(), m, o.id)]);
  await audit(env, me.id, 'order.courier', 'order', o.id, { pay_on: m });
  return loadOrder(env, o.id);
});
on('POST', '/api/orders/:id/discount', 'order.edit', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  if (me.role !== 'owner') fail(403, 'no_manual_discount', 'Ручные скидки в кассе отключены — скидки ставит программа (акции и комбо)');
  const bp = Math.round(Number(body.percent) * 100);
  if (!(bp >= 0 && bp <= MAX_DISCOUNT_BP)) fail(400, 'bad_discount', 'Скидка от 0 до 30%');
  const approver = await requireApproval(env, me, body.approval_pin, 'Скидка ' + body.percent + '%', o.id, { percent: body.percent });
  await db(env).run('UPDATE orders SET discount_bp = ?, discount_approved_by = ? WHERE id = ?', bp, approver.id, o.id);
  await audit(env, me.id, 'order.discount', 'order', o.id, { percent: body.percent, approved_by: approver.id });
  await notify(env, `Скидка ${body.percent}% на заказ №${o.id}. Кассир ${me.name}, разрешил ${approver.name}`);
  return loadOrder(env, o.id);
});

on('POST', '/api/orders/:id/cancel', 'order.edit', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  const reason = String(body.reason || '').trim(); if (reason.length < 3) fail(400, 'no_reason', 'Укажите причину отмены');
  const incomingSite = o.channel === 'site' && !o.accepted_at;
  const approver = incomingSite ? me : await requireApproval(env, me, body.approval_pin, 'Отмена заказа', o.id, { reason });
  const cooked = o.items.filter((i) => i.sent && i.qty > 0);
  const moves = await recipeMoves(env, cooked, 'writeoff', o.id, me.id, approver.id, 'Отмена после кухни: ' + reason);
  moves.push(db(env).stmt(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, cancel_approved_by = ? WHERE id = ?`, isoNow(), reason, approver.id, o.id));
  await db(env).batch(moves);
  await audit(env, me.id, 'order.cancel', 'order', o.id, { reason, approved_by: approver.id, total_tetri: o.total_tetri, cooked: cooked.length });
  if (o.pay_state === 'paid') { // оплачен онлайн — деньги клиенту возвращаем сразу
    const p = await db(env).one(`SELECT * FROM online_pays WHERE order_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1`, o.id);
    try { await payRefund(env, p, me.id, 'Отмена заказа: ' + reason); } catch (e) { await notify(env, `⚠️ Заказ №${o.id} отменён, но вернуть онлайн-оплату автоматически не получилось (${e.message}). Верните вручную: админка → Онлайн-оплата.`); }
  }
  await notify(env, `Отмена заказа №${o.id} на ${(o.total_tetri / 100).toFixed(2)} ₾. Причина: ${reason}. Кассир ${me.name}, разрешил ${approver.name}`);
  return { cancelled: true };
});

// Аннулировать ОПЛАЧЕННЫЙ заказ (клиент отказался, Wolt/Glovo отменили): только администратор или владелец, с причиной.
// Оплата не стирается (защита истории), заказ помечается аннулированным и уходит из выручки; наличные — возврат из кассы.
on('POST', '/api/orders/:id/void', 'order.edit', async ({ env, me, params, body }) => {
  if (me.role !== 'owner' && me.role !== 'manager') fail(403, 'boss_only', 'Аннулировать оплаченный заказ может только администратор или владелец');
  const id = int(params.id, 'id'); const D = db(env); const o = await loadOrder(env, id);
  const p = await D.one('SELECT * FROM payments WHERE order_id = ?', id); if (!p) fail(409, 'not_paid', 'Заказ ещё не оплачен — его можно просто отменить в кассе');
  if (await D.one('SELECT order_id FROM voids WHERE order_id = ?', id)) fail(409, 'already_void', 'Этот заказ уже аннулирован');
  const reason = String(body.reason || '').trim().slice(0, 300); if (reason.length < 3) fail(400, 'no_reason', 'Укажите причину');
  let mv = null;
  if (p.method === 'cash') { const now = await cashNow(env);
    mv = (await D.run('INSERT INTO cash_moves (kind, amount_tetri, staff_id, shift_id, note) VALUES (?,?,?,?,?)', 'refund', p.total_tetri, me.id, now.basis === 'open_shift' ? now.shift_id : null, 'Заказ №' + id + ': ' + reason)).last_row_id; }
  await D.run('INSERT INTO voids (order_id, reason, total_tetri, method, staff_id, cash_move_id) VALUES (?,?,?,?,?,?)', id, reason, p.total_tetri, p.method, me.id, mv);
  await D.run(`INSERT INTO order_stages (order_id, stage, staff_id) VALUES (?, 'ready', ?)`, id, me.id).catch(() => {}); // с экрана кухни убираем
  let bank = null;
  if (p.method === 'online') { const op = await D.one(`SELECT * FROM online_pays WHERE order_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1`, id);
    if (op) { try { await payRefund(env, op, me.id, 'Аннулирован заказ: ' + reason); bank = 'refunded'; } catch (e) { bank = 'failed'; await notify(env, `⚠️ Заказ №${id} аннулирован, но вернуть онлайн-оплату автоматически не получилось (${e.message}). Верните вручную в кабинете банка.`); } } }
  await audit(env, me.id, 'order.void', 'order', id, { reason, total_tetri: p.total_tetri, method: p.method, cash_move: mv });
  await notify(env, `🚫 Аннулирован оплаченный заказ №${id} на ${(p.total_tetri / 100).toFixed(2)} ₾ (${p.method === 'cash' ? 'наличные вернули из кассы' : p.method === 'card' ? 'карта — верните на терминале' : p.method === 'online' ? 'онлайн — возврат через банк' : 'Wolt/Glovo'}). Причина: ${reason}. ${me.name}`);
  return { ok: true, method: p.method, total_tetri: p.total_tetri, bank };
});
// Список заказов за день — для администратора (с аннулированием)
on('GET', '/api/day-orders', 'order.edit', async ({ env, me, url }) => {
  if (me.role !== 'owner' && me.role !== 'manager') fail(403, 'boss_only', 'Только администратор или владелец');
  const d = dateArg(url.searchParams.get('date') || tbDate(), 'дата'); const D = db(env);
  const rows = await D.all(`SELECT o.*, p.method AS pay_method, p.total_tetri AS paid_tetri, p.created_at AS pay_at, v.reason AS void_reason, v.created_at AS void_at, f.fiscal_number AS rno
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id LEFT JOIN voids v ON v.order_id = o.id LEFT JOIN fiscal_receipts f ON f.order_id = o.id
    WHERE date(datetime(COALESCE(p.created_at, o.cancelled_at, o.created_at), ${TZ})) = ? AND (p.order_id IS NOT NULL OR o.status = 'cancelled') ORDER BY o.id DESC LIMIT 300`, d);
  if (!rows.length) return [];
  const items = await D.all(`SELECT oi.order_id, oi.qty, oi.unit_price_tetri, pr.name_ru, pr.name_ka FROM order_items oi JOIN products pr ON pr.id = oi.product_id WHERE oi.qty > 0 AND oi.order_id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
  return rows.map((o) => withTotals(Object.assign(o, { items: items.filter((i) => i.order_id === o.id) })));
});

// Оплата: всё одним пакетом — оплата, статус, списание по рецептам
on('POST', '/api/orders/:id/pay', 'order.pay', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  if (!o.items.some((i) => i.qty > 0)) fail(400, 'empty', 'Заказ пустой');
  const pre = o.pay_state === 'paid'; // клиент уже оплатил картой на сайте
  if (o.pay_state === 'pending') fail(409, 'pay_pending', 'Клиент ещё не оплатил онлайн');
  if (o.pay_state === 'refunded') fail(409, 'pay_refunded', 'Онлайн-оплата по этому заказу возвращена');
  if (pre) { const p = await db(env).one(`SELECT amount_tetri, bank FROM online_pays WHERE order_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1`, o.id);
    if (p && p.amount_tetri !== o.total_tetri) fail(409, 'pay_mismatch', `Сумма изменилась после онлайн-оплаты: оплачено ${(p.amount_tetri / 100).toFixed(2)} ₾, в заказе ${(o.total_tetri / 100).toFixed(2)} ₾. Верните состав заказа; доплату оформите отдельным заказом.`);
    body.method = 'online'; body.payer = 'ონლაინ · ' + (p && BANKS[p.bank] ? BANKS[p.bank].name : 'ბანკი'); }
  const method = String(body.method || '');
  const platform = ['wolt', 'glovo', 'bolt'].includes(o.channel);
  if (!['cash', 'card', 'platform', 'online'].includes(method)) fail(400, 'bad_method', 'Способ оплаты: cash, card, platform, online');
  if (method === 'platform' && !platform) fail(400, 'bad_method', 'Оплата через площадку — только для Wolt, Glovo, Bolt');
  const payer = String(body.payer || '').trim().slice(0, 120);
  if (method === 'online' && payer.length < 2) fail(400, 'no_payer', 'Укажите, кто платит переводом (компания или человек)');
  if (method === 'online' && !pre && ((await getSettings(env)).pay || {}).transfer !== true) fail(403, 'transfer_off', 'Оплата переводом от компаний выключена в настройках');
  const sh = await openShiftOf(env, me.id); if (!sh) fail(409, 'no_shift', 'Сначала откройте смену');
  const ch = await db(env).one('SELECT commission_bp FROM channels WHERE id = ?', o.channel);
  const commission = Math.round(o.total_tetri * ch.commission_bp / 10000);
  const costs = await unitCosts(env, o.items.map((i) => i.product_id)); const pack = await packMoves(env, o, me.id);
  const stmts = [
    ...o.items.map((i) => db(env).stmt('UPDATE order_items SET unit_cost_tetri = ? WHERE id = ?', (costs[i.product_id] || 0) + (pack.extra[i.id] || 0), i.id)),
    ...pack.st,
    db(env).stmt('INSERT INTO payments (order_id, method, subtotal_tetri, discount_tetri, total_tetri, commission_tetri, shift_id, staff_id) VALUES (?,?,?,?,?,?,?,?)',
      o.id, method, o.subtotal_tetri, o.discount_tetri, o.total_tetri, commission, sh.id, me.id),
    ...(await recipeMoves(env, o.items, 'sale', o.id, me.id, null, null)),
    db(env).stmt('UPDATE order_items SET sent = 1 WHERE order_id = ?', o.id),
    ...(method === 'online' && !pre ? [db(env).stmt('INSERT INTO receivables (order_id, payer, payer_tin, amount_tetri) VALUES (?,?,?,?)', o.id, payer, String(body.payer_tin || '').slice(0, 20) || null, o.total_tetri)] : []),
    db(env).stmt(`UPDATE orders SET status = 'paid', paid_at = ?, sent_at = COALESCE(sent_at, ?), delivered_at = CASE WHEN channel = 'site' AND (COALESCE(mode, '') != 'delivery' OR out_at IS NOT NULL) THEN COALESCE(delivered_at, ?) ELSE delivered_at END WHERE id = ?`, isoNow(), isoNow(), isoNow(), o.id),
    // номер чека — сам, по порядку: каждый день с 101
    db(env).stmt(`INSERT OR IGNORE INTO fiscal_receipts (order_id, fiscal_number, staff_id) SELECT ?, CAST(COALESCE(MAX(CAST(fiscal_number AS INTEGER)), 100) + 1 AS TEXT), ? FROM fiscal_receipts
      WHERE date(datetime(created_at, '+4 hours')) = date(datetime('now', '+4 hours')) AND fiscal_number GLOB '[0-9]*'`, o.id, me.id)
  ];
  await db(env).batch(stmts);
  const rc = await db(env).one('SELECT fiscal_number FROM fiscal_receipts WHERE order_id = ?', o.id);
  await audit(env, me.id, 'order.pay', 'order', o.id, { method, total_tetri: o.total_tetri, receipt: rc && rc.fiscal_number });
  return { paid: true, order_id: o.id, total_tetri: o.total_tetri, receipt_no: rc ? rc.fiscal_number : null, fiscal_required: false };
});

// Касса напечатала фискальный чек через свой модуль и присылает номер
on('POST', '/api/orders/:id/fiscal', 'order.fiscal', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id'));
  if (o.status !== 'paid') fail(409, 'not_paid', 'Фискальный чек — только для оплаченного заказа');
  const num = String(body.fiscal_number || '').trim(); if (!num) fail(400, 'no_number', 'Нет номера фискального чека');
  if (await db(env).one('SELECT order_id FROM fiscal_receipts WHERE order_id = ?', o.id)) fail(409, 'exists', 'Фискальный чек уже записан');
  await db(env).run('INSERT INTO fiscal_receipts (order_id, fiscal_number, staff_id) VALUES (?,?,?)', o.id, num, me.id);
  await audit(env, me.id, 'order.fiscal', 'order', o.id, { fiscal_number: num });
  return { ok: true };
});

// Стоп-лист: кассир может только поставить в стоп, вернуть — менеджер
on('POST', '/api/products/:id/stock', 'product.stop', async ({ env, me, params, body }) => {
  const inStock = body.in_stock ? 1 : 0;
  if (inStock && !can(me, 'menu.edit')) fail(403, 'forbidden', 'Вернуть позицию в продажу может менеджер');
  await db(env).run(`UPDATE products SET in_stock = ?, stop_reason = ?, stop_at = ${inStock ? 'NULL' : "datetime('now')"} WHERE id = ?`, inStock, inStock ? null : 'manual', params.id);
  await audit(env, me.id, inStock ? 'product.resume' : 'product.stop', 'product', params.id);
  const p = await db(env).one('SELECT name_ru FROM products WHERE id = ?', params.id);
  if (p) await notify(env, inStock ? `▶ Снова в продаже: ${p.name_ru} (${me.name})` : `⏸ Временно не продаётся: ${p.name_ru} (${me.name}). На сайте — «Временно нет».`);
  return { ok: true };
});

// Цены
on('PUT', '/api/prices', 'prices.edit', async ({ env, me, body }) => {
  const price = int(body.price_tetri, 'price_tetri'); if (price < 0) fail(400, 'bad_price', 'Цена не может быть отрицательной');
  const old = await db(env).one('SELECT price_tetri FROM prices WHERE product_id = ? AND price_list = ?', body.product_id, body.price_list);
  await db(env).run(`INSERT INTO prices (product_id, price_list, price_tetri) VALUES (?,?,?)
    ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri`, body.product_id, body.price_list, price);
  await audit(env, me.id, 'price.change', 'product', body.product_id, { price_list: body.price_list, old: old?.price_tetri ?? null, new: price });
  await notify(env, `Цена изменена: ${body.product_id} (${body.price_list}) ${old ? (old.price_tetri / 100).toFixed(2) : '—'} → ${(price / 100).toFixed(2)} ₾, ${me.name}`);
  return { ok: true };
});

// Склад
on('GET', '/api/stock', 'stock.view', async ({ env }) => db(env).all('SELECT * FROM stock_levels ORDER BY name'));

// Приход по накладной: несколько строк, цена пересчитывается по средневзвешенной
on('POST', '/api/stock/receipt', 'stock.receipt', async ({ env, me, body }) => {
  const lines = body.lines || [{ ingredient_id: body.ingredient_id, qty: body.qty, cost_per_1000_tetri: body.cost_per_1000_tetri }];
  if (!lines.length) fail(400, 'empty', 'Добавьте хотя бы одну строку');
  const supplier = String(body.supplier || '').slice(0, 120) || null; const invoice = String(body.invoice || '').slice(0, 60) || null;
  const stmts = []; let total = 0; const out = [];
  for (const l of lines) {
    const qty = int(l.qty, 'qty'); if (qty <= 0) fail(400, 'bad_qty', 'Количество больше нуля');
    const ing = await db(env).one('SELECT s.qty, i.* FROM ingredients i JOIN stock_levels s ON s.id = i.id WHERE i.id = ?', l.ingredient_id);
    if (!ing) fail(404, 'not_found', 'Нет продукта ' + l.ingredient_id);
    const lineCost = l.total_tetri != null ? int(l.total_tetri, 'total_tetri') : Math.round(qty * int(l.cost_per_1000_tetri, 'cost_per_1000_tetri') / 1000);
    if (lineCost < 0) fail(400, 'bad_cost', 'Сумма не может быть отрицательной');
    const have = Math.max(0, ing.qty);
    const newCost = have + qty > 0 ? Math.round((have * ing.cost_per_1000_tetri / 1000 + lineCost) * 1000 / (have + qty)) : ing.cost_per_1000_tetri;
    stmts.push(db(env).stmt('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, staff_id, cost_tetri) VALUES (?,?,?,?,?,?)', ing.id, qty, 'receipt', [supplier, invoice].filter(Boolean).join(' · ') || null, me.id, lineCost));
    stmts.push(db(env).stmt('UPDATE ingredients SET cost_per_1000_tetri = ? WHERE id = ?', newCost, ing.id));
    total += lineCost; out.push({ ingredient_id: ing.id, name: ing.name, qty, cost_tetri: lineCost, old_cost_per_1000: ing.cost_per_1000_tetri, new_cost_per_1000: newCost });
  }
  await db(env).batch(stmts); await refreshComposite(env);
  await audit(env, me.id, 'stock.receipt', 'stock', invoice, { supplier, invoice, total_tetri: total, lines: out });
  // поставка пришла — блюда, остановленные из-за этого ингредиента, сами возвращаются в продажу
  let resumed = [];
  for (const l of lines) { const g = await db(env).one('SELECT out_of_stock FROM ingredients WHERE id = ?', l.ingredient_id); if (g && g.out_of_stock) resumed = resumed.concat((await setIngOut(env, me, l.ingredient_id, false)).resumed); }
  const jumps = out.filter((x) => x.old_cost_per_1000 > 0 && x.new_cost_per_1000 > x.old_cost_per_1000 * 1.15);
  if (jumps.length) await notify(env, 'Приход: цена выросла больше чем на 15%: ' + jumps.map((x) => x.name).join(', ') + ' (' + me.name + ')');
  return { ok: true, total_tetri: total, lines: out, resumed };
});

on('POST', '/api/stock/writeoff', 'order.edit', async ({ env, me, body }) => {
  const qty = int(body.qty, 'qty'); if (qty <= 0) fail(400, 'bad_qty', 'Количество больше нуля');
  const reason = String(body.reason || '').trim(); if (!reason) fail(400, 'no_reason', 'Укажите причину списания');
  const ing = await db(env).one('SELECT * FROM ingredients WHERE id = ?', body.ingredient_id); if (!ing) fail(404, 'not_found', 'Нет такого продукта');
  const approver = await requireApproval(env, me, body.approval_pin, 'Списание ' + ing.name, null, { qty, reason });
  const cost = Math.round(qty * ing.cost_per_1000_tetri / 1000);
  const parts = await partsMap(env);
  if (parts[ing.id]) {
    const raw = expandIng(parts, ing.id, qty, {}); const cs = Object.fromEntries((await db(env).all('SELECT id, cost_per_1000_tetri FROM ingredients')).map((r) => [r.id, r.cost_per_1000_tetri]));
    await db(env).batch(Object.entries(raw).filter(([, q]) => q2(q)).map(([k, q]) => db(env).stmt('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, staff_id, approved_by, cost_tetri) VALUES (?,?,?,?,?,?,?)', k, -q2(q), 'writeoff', reason + ' · ' + ing.name, me.id, approver.id, Math.round(q2(q) * (cs[k] || 0) / 1000))));
  } else await db(env).run('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, staff_id, approved_by, cost_tetri) VALUES (?,?,?,?,?,?,?)', ing.id, -qty, 'writeoff', reason, me.id, approver.id, cost);
  await audit(env, me.id, 'stock.writeoff', 'ingredient', ing.id, { qty, reason, cost_tetri: cost, approved_by: approver.id });
  return { ok: true, cost_tetri: cost };
});

// Инвентаризация: вводится факт, разница записывается движением и показывается в лари
on('POST', '/api/stock/inventory', 'stock.inventory', async ({ env, me, body }) => {
  const result = []; const stmts = [];
  for (const c of body.counts || []) {
    const lvl = await db(env).one('SELECT s.qty, i.cost_per_1000_tetri, i.name FROM stock_levels s JOIN ingredients i ON i.id = s.id WHERE s.id = ?', c.ingredient_id);
    if (!lvl) fail(404, 'not_found', 'Нет продукта ' + c.ingredient_id);
    const actual = int(c.actual, 'actual'); const delta = actual - lvl.qty;
    const cost = Math.round(delta * lvl.cost_per_1000_tetri / 1000);
    if (delta) stmts.push(db(env).stmt('INSERT INTO stock_moves (ingredient_id, delta, kind, reason, staff_id, cost_tetri) VALUES (?,?,?,?,?,?)', c.ingredient_id, delta, 'inventory', 'Инвентаризация', me.id, cost));
    result.push({ ingredient_id: c.ingredient_id, name: lvl.name, expected: lvl.qty, actual, delta, cost_tetri: cost });
  }
  if (stmts.length) await db(env).batch(stmts);
  await audit(env, me.id, 'stock.inventory', 'stock', null, { result });
  const loss = result.filter((r) => r.delta < 0).reduce((s, r) => s - r.cost_tetri, 0);
  if (loss > 0) await notify(env, `Инвентаризация: недостача на ${(loss / 100).toFixed(2)} ₾`);
  return { result, shortage_tetri: loss };
});

// Отчёты (время — Тбилиси, UTC+4)
on('GET', '/api/reports/sales', 'reports.view', async ({ env, url }) => {
  const group = url.searchParams.get('group') || 'day';
  const fmt = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' }[group]; if (!fmt) fail(400, 'bad_group', 'group: day, month, year');
  const from = url.searchParams.get('from') || '2000-01-01'; const to = url.searchParams.get('to') || '2100-01-01';
  return db(env).all(`SELECT strftime('${fmt}', datetime(p.created_at, '+4 hours')) AS period, o.channel,
      COUNT(*) AS orders, SUM(p.total_tetri) AS gross_tetri, SUM(p.commission_tetri) AS commission_tetri,
      SUM(p.total_tetri - p.commission_tetri) AS net_tetri, SUM(p.discount_tetri) AS discount_tetri
    FROM sales p JOIN orders o ON o.id = p.order_id
    WHERE date(datetime(p.created_at, '+4 hours')) BETWEEN ? AND ?
    GROUP BY period, o.channel ORDER BY period`, from, to);
});

// Сводка по кассирам: отмены, скидки, расхождения смен
on('GET', '/api/reports/staff', 'reports.view', async ({ env }) => db(env).all(`SELECT s.id, s.name,
    (SELECT COUNT(*) FROM approvals a WHERE a.requested_by = s.id AND a.action LIKE 'Отмена%') AS cancels,
    (SELECT COUNT(*) FROM approvals a WHERE a.requested_by = s.id AND a.action LIKE 'Скидка%') AS discounts,
    (SELECT COUNT(*) FROM audit_log l WHERE l.staff_id = s.id AND l.action = 'approval.failed') AS failed_approvals,
    (SELECT COALESCE(SUM(diff_tetri),0) FROM shifts sh WHERE sh.staff_id = s.id AND sh.closed_at IS NOT NULL) AS cash_diff_tetri
  FROM staff s WHERE s.role = 'cashier' ORDER BY s.name`));

// ───────── Настройки (доставка, комиссии, контакты, акция) ─────────
const DEFAULT_SETTINGS = {
  delivery: { zones: [{ id: 'city', fee: 7, ru: 'Батуми', en: 'Batumi', ka: 'ბათუმი' }, { id: 'airport', fee: 10, ru: 'Район аэропорта', en: 'Airport area', ka: 'აეროპორტის რაიონი' }], tmin: 35, tmax: 40, aggDisc: 20 },
  combo: { minMargin: 50, on: true },
  pay: { poolPct: 1 },
  tax: { income: 20, pensionEmp: 2, pensionEr: 2, pensionDeductible: true, vatPayer: true, vat: 18, profitTax: 15 },
  info: { phone: '+995514888800', wa: '995514888800', open: '11:00', close: '23:00', lat: 41.64318, lng: 41.61974 },
  promo: { on: false, pct: 10, title_ru: '', title_en: '', title_ka: '', from: '', to: '' },
  company: { name_ka: 'შპს პიცარუმი', name_ru: 'ООО «Пиццарум»', name_en: 'LTD Pizzaroom', tin: '445521016', addr_ka: 'ქ. ბათუმი, ზურაბ გორგილაძის ქ. 88', addr_ru: 'г. Батуми, ул. Зураба Горгиладзе, 88', addr_en: '88 Zurab Gorgiladze St, Batumi', phone: '', email: '', updated: '' }
};
async function getSettings(env) {
  const rows = await db(env).all('SELECT key, value FROM settings');
  const S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of rows) { try { S[r.key] = Object.assign({}, S[r.key] || {}, JSON.parse(r.value)); } catch (e) {} }
  return S;
}
on('GET', '/api/settings', 'menu.read', async ({ env }) => {
  const S = await getSettings(env);
  S.channels = await db(env).all('SELECT * FROM channels');
  return S;
});
on('PUT', '/api/settings', 'settings.edit', async ({ env, me, body }) => {
  const allowed = ['delivery', 'info', 'promo', 'combo', 'tax', 'pay', 'company'];
  for (const k of Object.keys(body)) {
    if (k === 'commissions') {
      for (const [ch, bp] of Object.entries(body.commissions || {})) {
        if (!['wolt', 'glovo', 'bolt'].includes(ch)) continue;
        const v = int(bp, 'commission'); if (v < 0 || v > 6000) fail(400, 'bad_commission', 'Комиссия от 0 до 60%');
        await db(env).run('UPDATE channels SET commission_bp = ? WHERE id = ?', v, ch);
      }
      continue;
    }
    if (!allowed.includes(k)) continue;
    if (k === 'company') { // реквизиты компании — для страниц условий и для банка
      const c0 = body.company || {}; const c = {};
      for (const f of ['name_ka', 'name_ru', 'name_en', 'addr_ka', 'addr_ru', 'addr_en', 'phone', 'email']) c[f] = String(c0[f] || '').trim().slice(0, 160);
      c.tin = String(c0.tin || '').replace(/\D/g, ''); if (c.tin && !/^\d{9,11}$/.test(c.tin)) fail(400, 'bad_tin', 'ID компании — 9 цифр (у физлица 11)');
      if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) fail(400, 'bad_email', 'Проверьте эл. почту');
      c.updated = isoNow().slice(0, 10); body.company = c;
    }
    await db(env).run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(body[k]));
  }
  await audit(env, me.id, 'settings.change', 'settings', Object.keys(body).join(','), body);
  return getSettings(env);
});
on('GET', '/api/public/settings', null, async ({ env }) => {
  const S = await getSettings(env); const p = await activePromo(env, 'site');
  const ap = await db(env).one(`SELECT value FROM settings WHERE key = 'site_apps'`);
  const gw = await payGw(env); const co = S.company || {};
  return { online: { on: !!gw.on && gwReady(gw), bank: gw.on ? gw.bank : null }, company: { name_ka: co.name_ka, name_ru: co.name_ru, name_en: co.name_en, tin: co.tin }, apps: ap ? ap.value === '1' : false, dpause: dpauseNow(S), delivery: S.delivery, info: S.info, branch: S.branch, promo: p ? { on: true, id: p.id, pct: p.pct, cats: p.cats, from: p.date_from, to: p.date_to, title_ru: p.title_ru, title_ka: p.title_ka, title_en: p.title_en, banner: !!p.banner } : { on: false } };
});

// ссылки на приложение на сайте (приложение принимает только доставку — когда её нет, ссылки прячем)
on('POST', '/api/site/apps', 'settings.edit', async ({ env, me, body }) => {
  const on = body.on ? '1' : '0';
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('site_apps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, on);
  await audit(env, me.id, on === '1' ? 'site.apps.on' : 'site.apps.off', 'settings', 'site_apps'); return { apps: on === '1' };
});

// ───────── Акции по расписанию ─────────
on('GET', '/api/promos', 'settings.edit', async ({ env }) => (await db(env).all('SELECT * FROM promos ORDER BY date_from DESC LIMIT 200')).map((r) => Object.assign(r, { cats: JSON.parse(r.cats || '[]'), channels: JSON.parse(r.channels || '[]'), wdays: r.wdays ? JSON.parse(r.wdays) : [] })));
on('POST', '/api/promos', 'settings.edit', async ({ env, me, body }) => {
  const pct = int(body.pct, 'pct'); if (pct < 1 || pct > 50) fail(400, 'bad_pct', 'Скидка от 1 до 50%');
  const from = String(body.date_from || ''), to = String(body.date_to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) fail(400, 'bad_dates', 'Проверьте даты акции');
  const cats = (body.cats || []).map(String); if (!cats.length) fail(400, 'no_cats', 'Выберите разделы, на которые действует скидка');
  const chans = (body.channels || ['site']).filter((c) => ['site', 'hall', 'takeaway', 'delivery'].includes(c)); if (!chans.length) fail(400, 'no_channels', 'Выберите, где действует акция');
  const title_ru = String(body.title_ru || '').trim(); if (!title_ru) fail(400, 'no_title', 'Введите название акции');
  const vals = [title_ru, String(body.title_ka || title_ru), String(body.title_en || title_ru), pct, from, to, JSON.stringify(cats), JSON.stringify(chans), body.banner === false ? 0 : 1, body.active === false ? 0 : 1, String(body.holiday || '') || null];
  const wd = [...new Set((body.wdays || []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort(); vals.push(wd.length && wd.length < 7 ? JSON.stringify(wd) : null);
  let id = body.id ? int(body.id, 'id') : null;
  if (id) await db(env).run('UPDATE promos SET title_ru=?, title_ka=?, title_en=?, pct=?, date_from=?, date_to=?, cats=?, channels=?, banner=?, active=?, holiday=?, wdays=? WHERE id = ?', ...vals, id);
  else id = (await db(env).run('INSERT INTO promos (title_ru, title_ka, title_en, pct, date_from, date_to, cats, channels, banner, active, holiday, wdays, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, me.id)).last_row_id;
  await audit(env, me.id, 'promo.save', 'promo', id, body);
  if (pct > 25) await notify(env, `Акция −${pct}% «${title_ru}» ${from}…${to} (${me.name})`);
  return { id };
});

// включить / выключить акцию одной кнопкой в любой момент (сайт и касса сразу без скидки)
on('POST', '/api/promos/:id/active', 'settings.edit', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); const p = await db(env).one('SELECT * FROM promos WHERE id = ?', id); if (!p) fail(404, 'not_found', 'Акция не найдена');
  const on = body.on ? 1 : 0; await db(env).run('UPDATE promos SET active = ? WHERE id = ?', on, id);
  await audit(env, me.id, on ? 'promo.on' : 'promo.off', 'promo', id);
  await notify(env, `${on ? '▶ Акция включена' : '⏸ Акция выключена'}: «${p.title_ru}» −${p.pct}% (${me.name})`);
  return { id, active: on };
});

// ───────── Праздники Грузии и мировые поводы для акций ─────────
const EASTER = { 2026: '04-12', 2027: '05-02', 2028: '04-16', 2029: '04-08', 2030: '04-28', 2031: '04-13', 2032: '05-02' };
function holidaysOf(y) {
  const pad = (n) => String(n).padStart(2, '0'), at = (md, off = 0) => { const d = new Date(Date.UTC(y, +md.slice(0, 2) - 1, +md.slice(3) + off)); return d.toISOString().slice(0, 10); };
  const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay(); const thanks = 1 + ((4 - nov1 + 7) % 7) + 21; const bf = `${y}-11-${pad(thanks + 1)}`;
  const list = [
    ['ny', '01-01', -1, 1, 'Новый год', 'ახალი წელი', 'New Year', 15], ['xmas', '01-07', 0, 0, 'Рождество (Шоба)', 'შობა', 'Orthodox Christmas', 10], ['oldny', '01-14', 0, 0, 'Старый Новый год', 'ძველით ახალი წელი', 'Old New Year', 10],
    ['pizzaday', '02-09', 0, 0, 'Всемирный день пиццы', 'პიცის მსოფლიო დღე', 'World Pizza Day', 20], ['valentine', '02-14', 0, 0, 'День влюблённых', 'ვალენტინობა', "Valentine's Day", 15],
    ['mothers', '03-03', 0, 0, 'День матери', 'დედის დღე', "Mothers' Day", 10], ['women', '03-08', 0, 0, '8 Марта', '8 მარტი', "Women's Day", 15],
    ['victory', '05-09', 0, 0, 'День Победы', 'გამარჯვების დღე', 'Victory Day', 10], ['family', '05-17', 0, 0, 'День семьи', 'ოჯახის დღე', 'Family Day', 10],
    ['independence', '05-26', 0, 0, 'День независимости', 'დამოუკიდებლობის დღე', 'Independence Day', 15], ['children', '06-01', 0, 0, 'День защиты детей', 'ბავშვთა დღე', "Children's Day", 15],
    ['summer', '06-15', 0, 6, 'Старт летнего сезона в Батуми', 'ზაფხულის სეზონის დაწყება', 'Batumi summer season', 10], ['mariamoba', '08-28', 0, 0, 'Мариамоба', 'მარიამობა', 'St Mary’s Day', 10],
    ['school', '09-15', 0, 0, 'Снова в школу', 'სკოლაში დაბრუნება', 'Back to school', 10], ['svetitskhoveli', '10-14', 0, 0, 'Светицховлоба', 'სვეტიცხოვლობა', 'Svetitskhovloba', 10],
    ['halloween', '10-31', 0, 0, 'Хэллоуин', 'ჰელოუინი', 'Halloween', 15], ['giorgoba', '11-23', 0, 0, 'Гиоргоба', 'გიორგობა', "St George's Day", 15],
    ['catholicxmas', '12-25', 0, 0, 'Католическое Рождество (туристы)', 'კათოლიკური შობა', 'Christmas', 10], ['nye', '12-31', 0, 0, 'Новогодняя ночь — предзаказы', 'საახალწლო ღამე', "New Year's Eve", 10]];
  const out = list.map(([id, md, a, b, ru, ka, en, pct]) => ({ id: id + '-' + y, key: id, date: at(md), from: at(md, a), to: at(md, b), ru, ka, en, pct }));
  if (EASTER[y]) out.push({ id: 'easter-' + y, key: 'easter', date: `${y}-${EASTER[y]}`, from: at(EASTER[y], -2), to: at(EASTER[y], 1), ru: 'Пасха (Агдгома)', ka: 'აღდგომა', en: 'Orthodox Easter', pct: 15 });
  out.push({ id: 'bf-' + y, key: 'blackfriday', date: bf, from: bf, to: `${y}-11-${pad(thanks + 4)}`, ru: 'Чёрная пятница', ka: 'შავი პარასკევი', en: 'Black Friday', pct: 25 });
  return out.sort((x, z) => x.date.localeCompare(z.date));
}
function upcomingHolidays(days = 365) {
  const t = tbDate(); const y = +t.slice(0, 4); const end = tbDate(new Date(Date.now() + days * 864e5));
  return [...holidaysOf(y), ...holidaysOf(y + 1)].filter((h) => h.to >= t && h.date <= end);
}
on('GET', '/api/holidays', 'settings.edit', async ({ env }) => {
  const promos = await db(env).all('SELECT id, holiday, date_from, date_to, pct, active FROM promos');
  return upcomingHolidays(400).map((h) => Object.assign(h, { promo: promos.find((p) => p.holiday === h.id || (p.date_from <= h.date && p.date_to >= h.date && p.active)) || null, days_left: Math.round((Date.parse(h.date) - Date.parse(tbDate())) / 864e5) }));
});
// Ежедневно утром: напоминание о праздниках без акции + отчёт за вчера (в Telegram владельцу)
async function dailyJob(env, quiet) {
  await ensureSchema(env);
  // уборка: старые попытки входа и закончившиеся сессии (база не растёт зря)
  await db(env).run(`DELETE FROM login_attempts WHERE created_at < datetime('now', '-30 days')`).catch(() => {});
  await db(env).run(`DELETE FROM sessions WHERE expires_at < datetime('now', '-7 days')`).catch(() => {});
  await paySweep(env).catch(() => {});
  const promos = await db(env).all('SELECT holiday, date_from, date_to, active FROM promos');
  const soon = upcomingHolidays(10).filter((h) => !promos.some((p) => p.holiday === h.id || (p.active && p.date_from <= h.date && p.date_to >= h.date)));
  const y = tbDate(new Date(Date.now() - 864e5));
  const r = await db(env).one(`SELECT COUNT(*) AS n, COALESCE(SUM(p.total_tetri),0) AS gross, COALESCE(SUM(p.commission_tetri),0) AS com FROM sales p WHERE date(datetime(p.created_at, '+4 hours')) = ?`, y);
  const c = await db(env).one(`SELECT COALESCE(SUM(oi.qty * oi.unit_cost_tetri),0) AS cost FROM order_items oi JOIN sales p ON p.order_id = oi.order_id WHERE date(datetime(p.created_at, '+4 hours')) = ?`, y);
  const top = await db(env).all(`SELECT pr.name_ru, SUM(oi.qty) AS q FROM order_items oi JOIN sales p ON p.order_id = oi.order_id JOIN products pr ON pr.id = oi.product_id WHERE oi.qty > 0 AND date(datetime(p.created_at, '+4 hours')) = ? GROUP BY oi.product_id ORDER BY q DESC LIMIT 3`, y);
  const diff = await db(env).one(`SELECT COALESCE(SUM(diff_tetri),0) AS d FROM shifts WHERE date(datetime(closed_at, '+4 hours')) = ?`, y);
  const low = await db(env).all('SELECT i.name FROM ingredients i JOIN stock_levels s ON s.id = i.id WHERE s.qty < i.min_stock AND i.id NOT IN (SELECT parent_id FROM ingredient_parts)');
  const m = (t) => (t / 100).toFixed(2) + ' ₾';
  let text = `Pizza Room · ${y}\nЗаказов: ${r.n} · выручка ${m(r.gross)} · комиссии ${m(r.com)} · себестоимость ${m(c.cost)} · прибыль ≈ ${m(r.gross - r.com - c.cost)}`;
  if (top.length) text += '\nТоп: ' + top.map((t) => `${t.name_ru} ×${t.q}`).join(', ');
  if (diff.d) text += `\nРазница кассы за день: ${m(diff.d)}`;
  if (low.length) text += '\nЗаканчивается: ' + low.map((l) => l.name).join(', ');
  try { const cn = await cashNow(env); const cc = await cashConf(env); text += `\n💵 Наличных в кассе: ${(cn.tetri / 100).toFixed(2)} ₾${cn.tetri >= cc.alert_tetri ? ' — пора забрать или сдать в банк' : ''}`; if (!quiet) await cashReminder(env); } catch (e) {}
  try { const A = await advise(env); const act = A.items.filter((x) => x.kind !== 'info');
    if (act.length) text += `\n\n🤖 Советник (${act.length}):\n` + act.slice(0, 5).map((x) => '• ' + x.title.ru).join('\n') + '\nПодробно и одной кнопкой — админка → «Советник».'; } catch (e) {}
  if (!quiet) await notify(env, text);
  return text;
}
on('POST', '/api/daily-report', 'staff.manage', async ({ env }) => ({ text: await dailyJob(env) }));

// ───────── Советник: скидки по слабым дням, слабые пиццы, срок годности, комбо недели ─────────
// Считает каждый раз заново по продажам, себестоимости и складу. Предложение висит, пока его не сделают или не нажмут «Пропустить».
const WD_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_IN = ['В воскресенье', 'В понедельник', 'Во вторник', 'В среду', 'В четверг', 'В пятницу', 'В субботу'];
const WD_KA_ON = ['კვირაობით', 'ორშაბათობით', 'სამშაბათობით', 'ოთხშაბათობით', 'ხუთშაბათობით', 'პარასკევობით', 'შაბათობით'];
const WD_KA = ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი'];
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const ddmm = (d) => d.slice(8, 10) + '.' + d.slice(5, 7);
const gel = (t) => (Math.round(t) / 100).toFixed(2).replace(/\.00$/, '') + ' ₾';
function isoWeek(d) { const x = new Date(d + 'T12:00:00Z'); const wd = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - wd + 3);
  const y = x.getUTCFullYear(); const j4 = new Date(Date.UTC(y, 0, 4)); return { key: `${y}-W${String(1 + Math.round((x - j4) / 6048e5 - ((j4.getUTCDay() + 6) % 7 - 3) / 7)).padStart(2, '0')}`, n: Math.round((x - j4) / 6048e5) }; }
const qtyTxt = (q, u, ka) => u === 'pcs' ? Math.round(q) + (ka ? ' ც' : ' шт') : q >= 1000 ? (Math.round(q / 100) / 10) + (u === 'g' ? (ka ? ' კგ' : ' кг') : (ka ? ' ლ' : ' л')) : Math.round(q) + (u === 'g' ? (ka ? ' გ' : ' г') : (ka ? ' მლ' : ' мл'));
const ingName = (n, ka) => { const p = String(n).split(' · '); return (ka ? p[0] : p[1] || p[0]).trim(); };
const SALE_CH = ['site', 'hall', 'takeaway', 'delivery'];

async function advise(env) {
  const D = db(env); const t = tbDate(); const W = isoWeek(t);
  const [daily, sold, products, costs, ingAll, stock, receipts, usedRows, promos, log, combos, pairs, recipes, parts, S] = await Promise.all([
    D.all(`SELECT date(datetime(p.created_at, ${TZ})) AS d, SUM(p.total_tetri) AS rev, COUNT(*) AS n FROM sales p WHERE p.created_at > datetime('now', '-60 days') GROUP BY d`),
    D.all(`SELECT oi.product_id AS id, SUM(oi.qty) AS q FROM order_items oi JOIN sales p ON p.order_id = oi.order_id WHERE oi.qty > 0 AND p.created_at > datetime('now', '-14 days') GROUP BY oi.product_id`),
    D.all(`SELECT p.id, p.category_id, p.name_ru, p.name_ka, p.name_en, p.photo, p.in_stock, p.pack_ing, p.pack_qty, p.pack_mode, (SELECT price_tetri FROM prices WHERE product_id = p.id AND price_list = 'base') AS price
      FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND p.archived = 0 AND c.active = 1 AND c.soon = 0`),
    productCosts(env),
    D.all('SELECT id, cost_per_1000_tetri AS c FROM ingredients'),
    D.all(`SELECT i.id, i.name, i.unit, i.shelf_days, i.cost_per_1000_tetri AS cost, s.qty AS stock FROM ingredients i JOIN stock_levels s ON s.id = i.id
      WHERE i.archived = 0 AND i.shelf_days > 0 AND i.id NOT IN (SELECT parent_id FROM ingredient_parts)`),
    D.all(`SELECT ingredient_id AS id, MAX(date(datetime(created_at, ${TZ}))) AS d FROM stock_moves WHERE kind = 'receipt' AND delta > 0 GROUP BY ingredient_id`),
    D.all(`SELECT ingredient_id AS id, -SUM(delta) AS used FROM stock_moves WHERE kind IN ('sale','writeoff') AND created_at > datetime('now', '-14 days') GROUP BY ingredient_id`),
    D.all('SELECT date_from, date_to, cats, holiday, wdays FROM promos WHERE active = 1 AND date_to >= ?', t),
    D.all('SELECT key FROM advice_log'),
    D.all('SELECT slots FROM combos WHERE active = 1'),
    D.all(`SELECT a.product_id AS x, b.product_id AS y, COUNT(DISTINCT a.order_id) AS n FROM order_items a JOIN order_items b ON b.order_id = a.order_id AND b.product_id <> a.product_id
      JOIN sales p ON p.order_id = a.order_id WHERE a.qty > 0 AND b.qty > 0 AND p.created_at > datetime('now', '-60 days') GROUP BY a.product_id, b.product_id`),
    D.all('SELECT product_id, ingredient_id FROM recipes'),
    D.all('SELECT parent_id, child_id FROM ingredient_parts'),
    getSettings(env)]);
  const done = new Set(log.map((r) => r.key)); const items = [];
  const add = (it) => { if (!done.has(it.key)) items.push(it); };
  const minM = Number((S.combo || {}).minMargin ?? 50);
  const ic = Object.fromEntries(ingAll.map((r) => [r.id, r.c]));
  const unitCost = (p) => costOf(costs[p.id]) + (p.pack_ing && p.pack_mode === 'always' ? Math.round((ic[p.pack_ing] || 0) * (p.pack_qty || 1) / 1000) : 0);
  const marg = (p) => (p.price ? (p.price - unitCost(p)) / p.price : 0);
  const maxPct = (p, cap) => { if (!p.price) return 0; const x = 1 - unitCost(p) / (p.price * (1 - minM / 100)); return Math.max(0, Math.min(cap, Math.floor(x * 20) * 5)); };
  const promoOn = (d) => promos.some((p) => p.date_from <= d && p.date_to >= d && wdOk(p, d));
  const hol = upcomingHolidays(14); const holOn = (d) => hol.some((h) => h.from <= d && h.to >= d);
  const pname = (p, ka) => (ka ? p.name_ka || p.name_ru : p.name_ru);
  const qty = Object.fromEntries(sold.map((r) => [r.id, r.q]));
  const pizzas = products.filter((p) => p.category_id === 'pizza' && p.price);

  // 1) выручка по дням недели за последние 8 недель
  const byDay = Object.fromEntries(daily.map((r) => [r.d, r.rev])); const first = daily.map((r) => r.d).filter((d) => d < t).sort()[0];
  const span = []; if (first) for (let d = first; d < t; d = addDays(d, 1)) span.push(d);
  const last = span.slice(-56); const enough = last.length >= 14;
  const wdAvg = Array(7).fill(0); let overall = 0;
  if (enough) { const acc = Array.from({ length: 7 }, () => []); for (const d of last) acc[dow(d)].push(byDay[d] || 0);
    acc.forEach((a, k) => { wdAvg[k] = a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }); overall = wdAvg.reduce((s, x) => s + x, 0) / 7; }
  const stats = { days: last.length, avg_day_tetri: Math.round(overall), weekdays: wdAvg.map((v, k) => ({ ru: WD_RU[k], ka: WD_KA[k], tetri: Math.round(v), pct: overall ? Math.round(v * 100 / overall) : 0 })) };
  if (!enough) items.push({ key: 'info:data', kind: 'info', prio: 9,
    title: { ru: 'Советнику нужно больше продаж', ka: 'მრჩეველს მეტი გაყიდვები სჭირდება' },
    text: { ru: `Скидки по дням и слабые пиццы считаются по продажам минимум за 2 недели. Сейчас есть ${last.length} дн. — ещё ${14 - last.length} дн., и советы появятся сами. Срок годности и комбо работают уже сейчас.`,
      ka: `დღეების ფასდაკლებები და სუსტი პიცები ითვლება მინიმუმ 2 კვირის გაყიდვებით. ახლა არის ${last.length} დღე — კიდევ ${14 - last.length} დღე და რჩევები თავად გამოჩნდება. ვადები და კომბოები უკვე მუშაობს.` }, action: null });
  if (enough && overall > 0) {
    for (let k = 0; k < 7; k++) {
      const d = addDays(t, k); const w = dow(d); const r = wdAvg[w] / overall; if (r >= 0.9 || promoOn(d) || holOn(d)) continue;
      const pct = r < 0.8 ? 10 : 5; const when = k === 0 ? ['Сегодня', 'დღეს'] : k === 1 ? ['Завтра', 'ხვალ'] : k === 2 ? ['Послезавтра', 'ზეგ'] : null;
      add({ key: 'day:' + d, kind: 'day', prio: k, date: d,
        title: { ru: `${when ? when[0] + ' (' + WD_RU[w] + ', ' + ddmm(d) + ')' : WD_RU[w][0].toUpperCase() + WD_RU[w].slice(1) + ', ' + ddmm(d)}: скидка ${pct}% на пиццы`, ka: `${when ? when[1] + ' (' + WD_KA[w] + ', ' + ddmm(d) + ')' : WD_KA[w] + ', ' + ddmm(d)}: ${pct}% ფასდაკლება პიცებზე` },
        text: { ru: `${WD_IN[w]} обычно выручка ${gel(wdAvg[w])} — на ${Math.round((1 - r) * 100)}% ниже среднего дня (${gel(overall)}). Скидка ${pct}% на пиццы в этот день привлечёт людей. Себестоимость пицц позволяет: прибыль остаётся выше ${minM}%.`,
          ka: `${WD_KA_ON[w]} ჩვეულებრივ შემოსავალია ${gel(wdAvg[w])} — ${Math.round((1 - r) * 100)}%-ით ნაკლები საშუალო დღეზე (${gel(overall)}). ამ დღეს პიცებზე ${pct}% ფასდაკლება ხალხს მოიზიდავს. მოგება ${minM}%-ზე მაღალი რჩება.` },
        action: { type: 'promo', payload: { title_ru: `Скидка дня −${pct}% на пиццы`, title_ka: `დღის ფასდაკლება −${pct}% პიცებზე`, title_en: `Deal of the day −${pct}% on pizza`, pct, date_from: d, date_to: d, cats: ['pizza'], channels: SALE_CH, banner: true } } });
    }
  }

  // 1б) постоянно слабый день недели (данные за 4+ недели): предложить скидку КАЖДУЮ неделю в этот день, на 3 месяца
  if (last.length >= 28 && overall > 0) {
    const WD_KA = ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი'];
    const weekly = promos.filter((p) => p.wdays);
    for (let w = 0; w < 7; w++) { const r = wdAvg[w] / overall; if (r >= 0.8 || weekly.some((p) => wdOk(p, addDays(t, (w - dow(t) + 7) % 7)))) continue;
      const pct = r < 0.65 ? 15 : 10;
      add({ key: 'wday:' + w + ':' + t.slice(0, 7), kind: 'weekly', prio: 3,
        title: { ru: `${WD_RU[w][0].toUpperCase() + WD_RU[w].slice(1)} — самый слабый день: скидка ${pct}% каждую неделю`, ka: `${WD_KA[w]} — სუსტი დღეა: ${pct}% ფასდაკლება ყოველ კვირას` },
        text: { ru: `${WD_IN[w]} в среднем ${gel(wdAvg[w])} выручки — на ${Math.round((1 - r) * 100)}% меньше обычного дня (${gel(overall)}), по продажам за ${last.length} дн. Постоянная скидка ${pct}% на пиццы ${WD_IN[w].toLowerCase()} на 3 месяца — гости привыкнут, что в этот день выгодно. Через месяц посмотрите в «Аналитика → Дни недели», выросла ли выручка.`,
          ka: `${WD_KA_ON[w]} საშუალოდ ${gel(wdAvg[w])} შემოსავალი — ${Math.round((1 - r) * 100)}%-ით ნაკლები ჩვეულებრივ დღეზე (${gel(overall)}). მუდმივი ${pct}% ფასდაკლება პიცებზე 3 თვით.` },
        action: { type: 'promo', payload: { title_ru: `−${pct}% на пиццы ${WD_IN[w].toLowerCase()}`, title_ka: `−${pct}% პიცებზე ${WD_KA_ON[w]}`, title_en: `−${pct}% pizza every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][w]}`, pct, date_from: t, date_to: addDays(t, 91), wdays: [w], cats: ['pizza'], channels: SALE_CH, banner: true } } });
    }
  }

  // 2) пиццы, которые продаются хуже остальных (14 дней)
  const totalPz = pizzas.reduce((s, p) => s + (qty[p.id] || 0), 0);
  const slowIds = new Set();
  if (enough && pizzas.length >= 3 && totalPz >= 20) {
    const qs = pizzas.map((p) => qty[p.id] || 0).sort((a, b) => a - b); const med = qs[Math.floor(qs.length / 2)];
    const slow = pizzas.filter((p) => p.in_stock && (qty[p.id] || 0) < med * 0.5).sort((a, b) => (qty[a.id] || 0) - (qty[b.id] || 0)).slice(0, 2);
    // самые слабые 3 дня подряд на неделе вперёд, где нет акции
    let bestS = -1, bestV = Infinity;
    for (let s0 = 1; s0 <= 5; s0++) { const ds = [0, 1, 2].map((j) => addDays(t, s0 + j)); if (ds.some((d) => promoOn(d) || holOn(d))) continue; const v = ds.reduce((s, d) => s + wdAvg[dow(d)], 0); if (v < bestV) { bestV = v; bestS = s0; } }
    for (const p of slow) {
      slowIds.add(p.id); const pct = maxPct(p, 15); if (pct < 5 || bestS < 0) continue;
      const from = addDays(t, bestS), to = addDays(t, bestS + 2);
      add({ key: `slow:${p.id}:${W.key}`, kind: 'slow', prio: 3, product: p.id,
        title: { ru: `«${pname(p)}» продаётся слабо — скидка ${pct}% на 3 дня`, ka: `„${pname(p, 1)}“ სუსტად იყიდება — ${pct}% ფასდაკლება 3 დღით` },
        text: { ru: `За 2 недели продано ${qty[p.id] || 0} шт, у остальных пицц в среднем ${med}. Предлагаю скидку ${pct}% только на неё с ${ddmm(from)} по ${ddmm(to)} (самые тихие дни недели). Наценка позволяет: себестоимость ${gel(unitCost(p))} при цене ${gel(p.price)}. Ещё лучше — добавить её в комбо недели (ниже).`,
          ka: `2 კვირაში გაიყიდა ${qty[p.id] || 0} ც, სხვა პიცები საშუალოდ ${med}. გთავაზობთ ${pct}% ფასდაკლებას მხოლოდ მასზე ${ddmm(from)}-დან ${ddmm(to)}-მდე (კვირის ყველაზე მშვიდი დღეები). თვითღირებულება ${gel(unitCost(p))}, ფასი ${gel(p.price)}. კიდევ უკეთესი — კვირის კომბოში ჩასმა (ქვემოთ).` },
        action: { type: 'promo', payload: { title_ru: `${pname(p)} −${pct}%`, title_ka: `${pname(p, 1)} −${pct}%`, title_en: `${p.name_en || p.name_ru} −${pct}%`, pct, date_from: from, date_to: to, cats: [p.id], channels: SALE_CH, banner: true } } });
    }
  }

  // 3) срок годности: что не успеем продать до конца срока по текущему расходу
  const rec = Object.fromEntries(receipts.map((r) => [r.id, r.d])); const used = Object.fromEntries(usedRows.map((r) => [r.id, r.used]));
  const prodsOf = (ing) => { const via = new Set([ing, ...parts.filter((x) => x.child_id === ing).map((x) => x.parent_id)]);
    return [...new Set(recipes.filter((r) => via.has(r.ingredient_id)).map((r) => r.product_id))].map((id) => products.find((p) => p.id === id)).filter((p) => p && p.price && p.in_stock); };
  for (const i of stock) {
    if (!(i.stock > 0) || !rec[i.id]) continue;
    const exp = addDays(rec[i.id], i.shelf_days); const left = Math.round((Date.parse(exp) - Date.parse(t)) / 864e5); const perDay = (used[i.id] || 0) / 14;
    const nm = [ingName(i.name), ingName(i.name, 1)];
    if (left < 0) {
      add({ key: `exp:${i.id}:${exp}`, kind: 'expired', prio: 0,
        title: { ru: `${nm[0]}: срок вышел ${ddmm(exp)}`, ka: `${nm[1]}: ვადა გავიდა ${ddmm(exp)}` },
        text: { ru: `Последняя поставка ${ddmm(rec[i.id])}, хранится ${i.shelf_days} дн. На складе по программе ${qtyTxt(i.stock, i.unit)} (≈ ${gel(i.stock * i.cost / 1000)}). Проверьте качество; если испорчено — спишите в «Складе», чтобы остатки были верными.`,
          ka: `ბოლო მიწოდება ${ddmm(rec[i.id])}, ინახება ${i.shelf_days} დღე. საწყობში პროგრამით ${qtyTxt(i.stock, i.unit, 1)} (≈ ${gel(i.stock * i.cost / 1000)}). შეამოწმეთ ხარისხი; თუ გაფუჭდა — ჩამოწერეთ „საწყობში“.` },
        action: { type: 'open', tab: 'stock' } });
      continue;
    }
    if (left > 4) continue;
    const rest = i.stock - perDay * left; if (rest <= Math.max(i.stock * 0.15, i.unit === 'pcs' ? 1 : 100)) continue;
    const ps = prodsOf(i.id).sort((a, b) => marg(b) - marg(a)).slice(0, 4); const pct = ps.length ? Math.min(...ps.map((p) => maxPct(p, 10))) : 0;
    const names = [ps.map((p) => pname(p)).join(', '), ps.map((p) => pname(p, 1)).join(', ')];
    add({ key: `exp:${i.id}:${exp}`, kind: 'expiry', prio: 1,
      title: { ru: `${nm[0]}: к ${ddmm(exp)} останется ≈ ${qtyTxt(rest, i.unit)}`, ka: `${nm[1]}: ${ddmm(exp)}-მდე დარჩება ≈ ${qtyTxt(rest, i.unit, 1)}` },
      text: { ru: `Срок по поставке от ${ddmm(rec[i.id])} — до ${ddmm(exp)} (${left ? 'через ' + left + ' дн.' : 'сегодня'}). Расход ≈ ${qtyTxt(perDay, i.unit)} в день, на складе ${qtyTxt(i.stock, i.unit)} — не успеем продать ≈ ${qtyTxt(rest, i.unit)} (≈ ${gel(rest * i.cost / 1000)}).${ps.length && pct >= 5 ? ` Предлагаю скидку ${pct}% до ${ddmm(exp)} на: ${names[0]}.` : ps.length ? ` Предложите эти позиции гостям: ${names[0]}.` : ''}`,
        ka: `მიწოდება ${ddmm(rec[i.id])}, ვადა ${ddmm(exp)}-მდე (${left ? left + ' დღეში' : 'დღეს'}). ხარჯი ≈ ${qtyTxt(perDay, i.unit, 1)} დღეში, საწყობში ${qtyTxt(i.stock, i.unit, 1)} — ვერ გავყიდით ≈ ${qtyTxt(rest, i.unit, 1)} (≈ ${gel(rest * i.cost / 1000)}).${ps.length && pct >= 5 ? ` გთავაზობთ ${pct}% ფასდაკლებას ${ddmm(exp)}-მდე: ${names[1]}.` : ps.length ? ` შესთავაზეთ სტუმრებს: ${names[1]}.` : ''}` },
      action: ps.length && pct >= 5 && ![0, 1, 2, 3, 4].some((j) => j <= left && promoOn(addDays(t, j))) ? { type: 'promo', payload: { title_ru: `−${pct}%: ${names[0]}`, title_ka: `−${pct}%: ${names[1]}`, title_en: `−${pct}%`, pct, date_from: t, date_to: exp, cats: ps.map((p) => p.id), channels: SALE_CH, banner: true } } : { type: 'open', tab: 'stock' } });
  }

  // 4) комбо недели: самые выгодные позиции + слабая пицца, цена так, чтобы прибыль ≥ порога
  const existing = new Set(combos.map((c) => JSON.parse(c.slots || '[]').map((s) => (s.ids || [s.cat]).slice().sort().join(',')).sort().join('|')));
  const rot = (arr, n) => (arr.length ? [...arr.slice(n % arr.length), ...arr.slice(0, n % arr.length)] : arr);
  const pz = pizzas.filter((p) => p.in_stock).sort((a, b) => marg(b) - marg(a));
  const known = (p) => costs[p.id] && !costs[p.id].est;
  const cold = products.filter((p) => p.category_id === 'drinks' && p.price && p.in_stock && known(p)).sort((a, b) => marg(b) - marg(a));
  const hot = products.filter((p) => p.category_id === 'coffee' && p.price && p.in_stock && known(p)).sort((a, b) => marg(b) - marg(a));
  const pairN = (a, b) => pairs.filter((x) => a.includes(x.x) && b.includes(x.y)).reduce((s, x) => s + x.n, 0);
  // комбо — только конкретные позиции (одна пицца + один напиток), без «на выбор», чтобы кассиру не путаться
  // каждый день — новые варианты: сначала пиццы, которые нужно продать (с продуктом, у которого кончается срок, и те, что продаются хуже всех)
  const DN = Math.floor(Date.parse(t + 'T12:00:00Z') / 864e5);
  const expPz = new Set(items.filter((x) => x.kind === 'expiry' && x.action && x.action.payload).flatMap((x) => x.action.payload.cats || []));
  const need = pz.slice().sort((a, b) => (Number(expPz.has(b.id)) - Number(expPz.has(a.id))) || ((qty[a.id] || 0) - (qty[b.id] || 0)) || (marg(b) - marg(a)));
  const nt = need.slice(0, Math.min(4, need.length)); const best = pz.slice(0, Math.min(4, pz.length));
  const p1 = nt[DN % (nt.length || 1)]; const p2 = nt[(DN + 1) % (nt.length || 1)];
  const p3 = rot(best, DN).find((p) => p !== p2 && p !== p1) || best[0];
  const d1 = rot(cold.slice(0, 5), DN)[0]; const c1 = rot(hot.slice(0, 3), DN)[0];
  const needWhy = (p) => expPz.has(p.id) ? { ru: `в «${pname(p)}» продукт, у которого скоро кончается срок`, ka: `„${pname(p, 1)}“-ში პროდუქტია, რომელსაც ვადა ეწურება` }
    : enough ? { ru: `«${pname(p)}» продаётся меньше других (${qty[p.id] || 0} шт за 2 недели)`, ka: `„${pname(p, 1)}“ სხვებზე ნაკლებად იყიდება (${qty[p.id] || 0} ც 2 კვირაში)` } : null;
  const nm = (ps, k) => ps.map((p) => (k === 'ka' ? p.name_ka || p.name_ru : k === 'en' ? p.name_en || p.name_ru : p.name_ru)).join(' + ');
  const lbl = (p) => ({ ru: p.name_ru, ka: p.name_ka || p.name_ru, en: p.name_en || p.name_ru });
  const ideas = [];
  if (p1 && d1) ideas.push({ n: 1, items: [p1, d1], need: p1 });
  if (p2 && p3 && p2 !== p3) ideas.push({ n: 2, items: [p2, p3], need: p2 });
  if (p2 && c1 && p2 !== p1) ideas.push({ n: 3, items: [p2, c1], lunch: true, need: p2 }); else if (p3 && c1) ideas.push({ n: 3, items: [p3, c1], lunch: true });
  for (const idea of ideas) { idea.name = { ru: (idea.lunch ? 'Обед: ' : '') + nm(idea.items, 'ru'), ka: (idea.lunch ? 'სადილი: ' : '') + nm(idea.items, 'ka'), en: (idea.lunch ? 'Lunch: ' : '') + nm(idea.items, 'en') }; idea.slots = idea.items.map((p) => [p.category_id === 'pizza' ? 'pz' : 'dr', [p]]); }
  for (const idea of ideas) {
    const key = `combo:${t}:${idea.n}`; if (done.has(key)) continue;
    // дороже базовой позиции — с доплатой на разницу в цене, чтобы комбо не уходило в минус на дорогих пиццах
    const slots = idea.items.map((p) => ({ ...lbl(p), ids: [p.id], extra: {} }));
    const sig = slots.map((s) => s.ids.slice().sort().join(',')).sort().join('|'); if (existing.has(sig)) continue;
        const listMin = idea.slots.reduce((s, [, ps]) => s + Math.min(...ps.map((p) => p.price)), 0);
    let price = Math.floor(listMin * 0.87 / 50) * 50; let m = null;
    while (price < listMin * 0.97) { m = await comboMargin(env, { price_tetri: price, slots }); if (m.ok && m.min_margin_pct >= minM) break; price += 50; m = null; }
    if (!m) continue;
    const allPs = idea.slots.flatMap(([, ps]) => ps); const sl = allPs.find((p) => slowIds.has(p.id));
    const mr = allPs.filter((p) => p.category_id === 'pizza' && !slowIds.has(p.id)).map((p) => Math.round(marg(p) * 100)); const mrT = !mr.length ? '' : Math.min(...mr) === Math.max(...mr) ? Math.min(...mr) + '%' : Math.min(...mr) + '–' + Math.max(...mr) + '%';
    const pairs1 = idea.slots.length === 2 && idea.slots[0][0] !== idea.slots[1][0] ? pairN(idea.slots[0][1].map((p) => p.id), idea.slots[1][1].map((p) => p.id)) : 0;
    const why = { ru: mrT ? [`у этих пицц самая высокая наценка (${mrT})`] : [], ka: mrT ? [`ამ პიცებს ყველაზე მაღალი მარჟა აქვს (${mrT})`] : [] };
    const nw = idea.need ? needWhy(idea.need) : null; if (nw) { why.ru.unshift(nw.ru + ' — комбо её подтянет'); why.ka.unshift(nw.ka + ' — კომბო გაზრდის გაყიდვებს'); }
    if (pairs1) { why.ru.push(`за 2 месяца эти позиции брали вместе ${pairs1} раз`); why.ka.push(`2 თვეში ეს პოზიციები ერთად აიღეს ${pairs1}-ჯერ`); }
    const same = idea.slots.length === 2 && idea.slots[0][1].map((p) => p.id).join() === idea.slots[1][1].map((p) => p.id).join();
    const list = same ? [`2 пиццы на выбор: ${idea.slots[0][1].map((p) => pname(p)).join(' / ')}`, `2 პიცა არჩევით: ${idea.slots[0][1].map((p) => pname(p, 1)).join(' / ')}`]
      : [idea.slots.map(([, ps]) => ps.map((p) => pname(p)).join(' / ')).join(' + '), idea.slots.map(([, ps]) => ps.map((p) => pname(p, 1)).join(' / ')).join(' + ')];
    const save = Math.round((1 - price / listMin) * 100);
    add({ key, kind: 'combo', prio: 5,
      title: { ru: `Комбо дня: «${idea.name.ru}» за ${gel(price)}`, ka: `დღის კომბო: „${idea.name.ka}“ ${gel(price)}` },
      text: { ru: `${list[0]}. По меню ${gel(listMin)}, в комбо ${gel(price)} — гость экономит ${save}%${slots.some((x) => Object.keys(x.extra).length) ? ' (за дорогие пиццы/напитки — доплата на разницу в цене)' : ''}. Прибыль с комбо не ниже ${m.min_margin_pct}%. ${why.ru.length ? 'Почему: ' + why.ru.join('; ') + '.' : ''}`,
        ka: `${list[1]}. მენიუთი ${gel(listMin)}, კომბოში ${gel(price)} — სტუმარი ზოგავს ${save}%-ს${slots.some((x) => Object.keys(x.extra).length) ? ' (ძვირიან პოზიციებზე — სხვაობის დამატება)' : ''}. კომბოს მოგება არანაკლებ ${m.min_margin_pct}%. ${why.ka.length ? 'რატომ: ' + why.ka.join('; ') + '.' : ''}` },
      action: { type: 'combo', payload: { name_ru: idea.name.ru, name_ka: idea.name.ka, name_en: idea.name.en, desc_ru: list[0], desc_ka: list[1], desc_en: list[0], price_tetri: price, slots, photo: idea.items[0].photo || null, sort: 5, active: true } } });
  }
  // 0) наличные в кассе выше порога
  try { const cn = await cashNow(env); const cc = await cashConf(env); if (cn.tetri >= cc.alert_tetri) items.push({ key: 'cash:' + t, kind: 'cash', prio: -1,
    title: { ru: `В кассе ${gel(cn.tetri)} наличными — заберите или сдайте в банк`, ka: `სალაროში ${gel(cn.tetri)} ნაღდია — აიღეთ ან ჩააბარეთ ბანკში` },
    text: { ru: `Порог напоминания — ${gel(cc.alert_tetri)}. Когда заберёте деньги, отметьте это в «Деньги → Наличные в кассе», и программа будет знать, сколько осталось.`, ka: `შეხსენების ზღვარი — ${gel(cc.alert_tetri)}. როცა აიღებთ, მონიშნეთ „ფინანსები → ნაღდი სალაროში“.` },
    action: { type: 'open', tab: 'cash' } }); } catch (e) {}
  // 5) праздники в ближайшие 14 дней, на которые ещё нет акции
  for (const h of hol) {
    if (promos.some((p) => p.holiday === h.id || (p.date_from <= h.date && p.date_to >= h.date))) continue;
    const dl = Math.round((Date.parse(h.date) - Date.parse(t)) / 864e5); if (dl < 0) continue;
    add({ key: 'hol:' + h.id, kind: 'holiday', prio: 2, date: h.date,
      title: { ru: `${h.ru} ${ddmm(h.date)} — через ${dl} дн., акции нет`, ka: `${h.ka} ${ddmm(h.date)} — ${dl} დღეში, აქცია არ არის` },
      text: { ru: `Предлагаю скидку ${h.pct}% на пиццы ${h.from === h.to ? 'на ' + ddmm(h.from) : 'с ' + ddmm(h.from) + ' по ' + ddmm(h.to)}. В праздники люди заказывают больше — скидка и баннер на сайте привлекут их к вам, а не к конкурентам.`,
        ka: `გთავაზობთ ${h.pct}% ფასდაკლებას პიცებზე ${h.from === h.to ? ddmm(h.from) + '-ს' : ddmm(h.from) + '-დან ' + ddmm(h.to) + '-მდე'}. დღესასწაულებზე მეტს უკვეთავენ — ფასდაკლება და ბანერი საიტზე მათ თქვენთან მოიყვანს.` },
      action: { type: 'promo', payload: { title_ru: h.ru + ` −${h.pct}%`, title_ka: h.ka + ` −${h.pct}%`, title_en: (h.en || h.ru) + ` −${h.pct}%`, pct: h.pct, date_from: h.from < t ? t : h.from, date_to: h.to, cats: ['pizza'], channels: SALE_CH, banner: true, holiday: h.id } } });
  }
  // 6) что видно по прибыли за текущий месяц (food cost, зарплаты, аренда, минус…)
  try { const P = await pnl(env, monthOf(t)); const mo = monthOf(t);
    for (const f of P.findings || []) add({ key: `pnl:${mo}:${f[3]}`, kind: 'pnl', prio: f[0] === 'bad' ? 4 : 6, level: f[0],
      title: { ru: f[1].split('. ')[0].replace(/\.$/, ''), ka: f[2].split('. ')[0].replace(/\.$/, '') }, text: { ru: f[1], ka: f[2] }, action: { type: 'open', tab: 'pnl' } }); } catch (e) {}
  items.sort((a, b) => a.prio - b.prio || String(a.date || '').localeCompare(String(b.date || '')));
  return { date: t, week: W.key, stats, items };
}
on('GET', '/api/advice', 'reports.view', async ({ env }) => advise(env));
on('POST', '/api/advice/mark', 'reports.view', async ({ env, me, body }) => {
  const key = String(body.key || '').slice(0, 120); const st = body.status === 'done' ? 'done' : 'skip'; if (!key) fail(400, 'no_key', 'Нет предложения');
  await db(env).run('INSERT INTO advice_log (key, status, staff_id) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, staff_id = excluded.staff_id, at = datetime(\'now\')', key, st, me.id);
  await audit(env, me.id, 'advice.' + st, 'advice', key, {});
  return { ok: true };
});





// ───────── Наличные в кассе: сколько лежит, кто забрал, напоминание ─────────
const CASH_KINDS = { owner: 'Забрал владелец', bank: 'Сдано в банк', expense: 'Оплачено наличными (расход)', courier: 'Выдано курьеру на сдачу', in: 'Внесено в кассу (размен)', refund: 'Возврат клиенту (аннулирован заказ)' };
async function cashNow(env) {
  const D = db(env);
  const open = await D.one('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  if (open) {
    const cash = await D.one(`SELECT COALESCE(SUM(total_tetri),0) AS s FROM payments WHERE shift_id = ? AND method = 'cash'`, open.id);
    const out = await D.one('SELECT COALESCE(SUM(amount_tetri),0) AS s FROM cash_moves WHERE shift_id = ?', open.id);
    return { tetri: open.opening_cash_tetri + cash.s - out.s, basis: 'open_shift', shift_id: open.id, since: open.opened_at };
  }
  const last = await D.one('SELECT * FROM shifts WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1');
  if (!last) { const m = await D.one('SELECT COALESCE(SUM(amount_tetri),0) AS s FROM cash_moves'); return { tetri: -m.s, basis: 'none', shift_id: null }; }
  const out = await D.one('SELECT COALESCE(SUM(amount_tetri),0) AS s FROM cash_moves WHERE shift_id IS NULL AND at >= ?', last.closed_at);
  return { tetri: (last.counted_cash_tetri ?? last.expected_cash_tetri ?? 0) - out.s, basis: 'last_close', shift_id: null, since: last.closed_at };
}
async function cashConf(env) { const S = await getSettings(env); return Object.assign({ alert_tetri: 1000000, every_days: 7 }, S.cash || {}); }
on('GET', '/api/cash', 'payroll.manage', async ({ env }) => {
  const [now, conf, moves] = await Promise.all([cashNow(env), cashConf(env), db(env).all(`SELECT m.*, s.name AS staff_name FROM cash_moves m LEFT JOIN staff s ON s.id = m.staff_id ORDER BY m.id DESC LIMIT 60`)]);
  const lastOut = moves.find((m) => m.kind === 'owner' || m.kind === 'bank');
  return { now, conf, moves, last_out: lastOut || null, kinds: CASH_KINDS, alert: now.tetri >= conf.alert_tetri };
});
on('POST', '/api/cash/move', 'payroll.manage', async ({ env, me, body }) => {
  const kind = String(body.kind || ''); if (!CASH_KINDS[kind]) fail(400, 'bad_kind', 'Выберите, что сделали с деньгами');
  let amt = int(body.amount_tetri, 'amount_tetri'); if (amt <= 0) fail(400, 'bad_amount', 'Сумма должна быть больше нуля');
  if (kind === 'in') amt = -amt;
  const now = await cashNow(env); if (amt > 0 && amt > now.tetri + 100) fail(400, 'too_much', `В кассе по программе только ${(now.tetri / 100).toFixed(2)} ₾`);
  const note = String(body.note || '').slice(0, 200);
  const r = await db(env).run('INSERT INTO cash_moves (kind, amount_tetri, staff_id, shift_id, note) VALUES (?,?,?,?,?)', kind, amt, me.id, now.basis === 'open_shift' ? now.shift_id : null, note || null);
  await audit(env, me.id, 'cash.' + kind, 'cash', r.last_row_id, { amount_tetri: amt, note });
  const after = await cashNow(env);
  await notify(env, `💵 ${CASH_KINDS[kind]}: ${(Math.abs(amt) / 100).toFixed(2)} ₾ (${me.name})${note ? ' — ' + note : ''}. В кассе теперь ${(after.tetri / 100).toFixed(2)} ₾.`);
  return { ok: true, now: after };
});
on('POST', '/api/cash/conf', 'settings.edit', async ({ env, me, body }) => {
  const v = { alert_tetri: Math.max(10000, int(body.alert_tetri, 'alert_tetri')), every_days: Math.max(1, Math.min(31, Number(body.every_days) || 7)) };
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('cash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(v));
  await audit(env, me.id, 'cash.conf', 'settings', 'cash', v); return v;
});
async function cashReminder(env) {
  const [now, conf] = await Promise.all([cashNow(env), cashConf(env)]); if (now.tetri < conf.alert_tetri) return null;
  const last = await db(env).one(`SELECT value FROM settings WHERE key = 'cash_reminded'`);
  if (last && Date.now() - Date.parse(JSON.parse(last.value)) < conf.every_days * 864e5 - 3600e3) return null;
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('cash_reminded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(new Date().toISOString()));
  const t = `💵 В кассе ${(now.tetri / 100).toFixed(0)} ₾ наличными — пора забрать или сдать в банк. После этого отметьте в админке: «Деньги → Наличные в кассе».`;
  await notify(env, t); return t;
}

// ───────── «Не дали чек?» — жалоба с сайта, сразу владельцу ─────────
on('POST', '/api/public/nocheck', null, async ({ env, body, request }) => {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const n = await db(env).one(`SELECT COUNT(*) AS n FROM complaints WHERE ip = ? AND at > datetime('now', '-1 hour')`, ip); if (n.n >= 3) fail(429, 'too_many', 'Слишком много обращений — попробуйте позже');
  const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 20); if (phone.replace(/\D/g, '').length < 9) fail(400, 'bad_phone', 'Укажите телефон, чтобы мы вернули вам пиццу');
  const kind = ['nocheck', 'other'].includes(body.kind) ? body.kind : 'nocheck';
  const v = [kind, phone, String(body.name || '').slice(0, 60), String(body.happened || '').slice(0, 60), String(body.details || '').slice(0, 500), ip];
  const r = await db(env).run('INSERT INTO complaints (kind, phone, name, happened, details, ip) VALUES (?,?,?,?,?,?)', ...v);
  await notify(env, `🧾❗ Клиент сообщает: НЕ ДАЛИ ЧЕК.\nТелефон: ${v[1]}${v[2] ? ' (' + v[2] + ')' : ''}\nКогда: ${v[3] || '—'}\n${v[4] || ''}\nПроверьте кассу и выдайте клиенту бесплатную пиццу. Админка → Контроль кассы → Обращения.`);
  return { ok: true, id: r.last_row_id };
});
on('GET', '/api/complaints', 'payroll.manage', async ({ env }) => db(env).all('SELECT * FROM complaints ORDER BY id DESC LIMIT 100'));
on('POST', '/api/complaints/:id', 'payroll.manage', async ({ env, me, params, body }) => {
  await db(env).run('UPDATE complaints SET status = ?, handled_by = ?, handled_note = ? WHERE id = ?', body.status === 'rejected' ? 'rejected' : 'done', me.id, String(body.note || '').slice(0, 300), int(params.id, 'id'));
  await audit(env, me.id, 'complaint.' + (body.status === 'rejected' ? 'rejected' : 'done'), 'complaint', params.id, { note: body.note }); return { ok: true };
});

// ───────── Доставка на паузе: нет курьеров, непогода, много заказов ─────────
const DP_REASONS = ['couriers', 'weather', 'busy', 'other'];
function dpauseNow(S) {
  const p = S.dpause || {}; if (!p.on) return null;
  if (p.until && Date.parse(p.until) <= Date.now()) return null;
  const ul = p.until ? new Date(Date.parse(p.until) + 4 * 3600e3).toISOString().slice(11, 16) : null;
  return { reason: DP_REASONS.includes(p.reason) ? p.reason : 'other', note: p.note || '', until: p.until || null, until_local: ul, since: p.since || null };
}
async function setDpause(env, me, body) {
  const on = !!body.on; let until = null;
  if (on && body.until) { const t = Date.parse(body.until); if (!isFinite(t) || t <= Date.now()) fail(400, 'bad_until', 'Время окончания уже прошло'); until = new Date(t).toISOString(); }
  const v = on ? { on: true, reason: DP_REASONS.includes(body.reason) ? body.reason : 'other', note: String(body.note || '').slice(0, 140), until, since: new Date().toISOString(), by: me ? me.name : 'Telegram' } : { on: false };
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('dpause', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(v));
  await audit(env, me ? me.id : null, on ? 'delivery.pause' : 'delivery.resume', 'settings', 'dpause', v);
  const R = { couriers: 'нет курьеров', weather: 'плохая погода', busy: 'очень много заказов', other: v.note || 'другое' };
  const ul = until ? new Date(Date.parse(until) + 4 * 3600e3).toISOString().slice(11, 16) : null;
  await notify(env, on ? `🛵⏸ Доставка на паузе (${R[v.reason]})${ul ? ' до ' + ul : ' — пока не включите'}. Сайт принимает только самовывоз. Включить: админка → Настройки или /delivery_on` : '🛵▶ Доставка снова работает.');
  return dpauseNow(await getSettings(env));
}
on('POST', '/api/delivery/pause', 'settings.edit', async ({ env, me, body }) => ({ dpause: await setDpause(env, me, body) }));
// ───────── «Нет у поставщика»: ингредиент закончился → все блюда с ним временно не продаются ─────────
async function productsUsing(env, ingId) {
  const parts = await db(env).all('SELECT parent_id, child_id FROM ingredient_parts');
  const via = new Set([ingId]); let grew = true; while (grew) { grew = false; for (const x of parts) if (via.has(x.child_id) && !via.has(x.parent_id)) { via.add(x.parent_id); grew = true; } }
  const rec = await db(env).all('SELECT product_id, ingredient_id FROM recipes'); const pk = await db(env).all("SELECT id, pack_ing FROM products WHERE pack_ing IS NOT NULL");
  return [...new Set([...rec.filter((r) => via.has(r.ingredient_id)).map((r) => r.product_id), ...pk.filter((p) => via.has(p.pack_ing)).map((p) => p.id)])];
}
async function setIngOut(env, me, id, out) {
  const D = db(env); const ing = await D.one('SELECT id, name FROM ingredients WHERE id = ?', id); if (!ing) fail(404, 'not_found', 'Нет такого ингредиента');
  const ids = await productsUsing(env, id); const nm = ingName(ing.name);
  if (out) {
    await D.run('UPDATE ingredients SET out_of_stock = 1 WHERE id = ?', id);
    const ps = ids.length ? await D.all(`SELECT id, name_ru FROM products WHERE active = 1 AND archived = 0 AND in_stock = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    if (ps.length) await D.batch(ps.map((p) => D.stmt("UPDATE products SET in_stock = 0, stop_reason = ?, stop_at = datetime('now') WHERE id = ?", 'ing:' + id, p.id)));
    await audit(env, me ? me.id : null, 'ingredient.out', 'ingredient', id, { stopped: ps.map((p) => p.id) });
    await notify(env, `⏸ Нет у поставщика: ${nm}. Временно не продаются: ${ps.map((p) => p.name_ru).join(', ') || '—'}.`);
    return { stopped: ps };
  }
  await D.run('UPDATE ingredients SET out_of_stock = 0 WHERE id = ?', id);
  const ps = await D.all('SELECT id, name_ru FROM products WHERE in_stock = 0 AND stop_reason = ?', 'ing:' + id);
  const stillOut = await D.all('SELECT id FROM ingredients WHERE out_of_stock = 1'); const back = [];
  for (const p of ps) {
    let other = null; for (const o of stillOut) if ((await productsUsing(env, o.id)).includes(p.id)) { other = o.id; break; }
    if (other) await D.run('UPDATE products SET stop_reason = ? WHERE id = ?', 'ing:' + other, p.id);
    else { await D.run('UPDATE products SET in_stock = 1, stop_reason = NULL, stop_at = NULL WHERE id = ?', p.id); back.push(p); }
  }
  await audit(env, me ? me.id : null, 'ingredient.back', 'ingredient', id, { resumed: back.map((p) => p.id) });
  await notify(env, `▶ ${nm} снова есть. Вернулись в продажу: ${back.map((p) => p.name_ru).join(', ') || '—'}.`);
  return { resumed: back };
}
on('POST', '/api/ingredients/:id/out', 'menu.edit', async ({ env, me, params, body }) => setIngOut(env, me, params.id, !!body.out));
on('GET', '/api/ingredients/:id/uses', 'menu.edit', async ({ env, params }) => {
  const ids = await productsUsing(env, params.id); if (!ids.length) return [];
  return db(env).all(`SELECT id, name_ru, name_ka, in_stock FROM products WHERE active = 1 AND archived = 0 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, name_ru`, ...ids);
});
// ───────── Свой PIN, восстановление доступа владельца, Telegram-бот ─────────
const PIN_OK = (p) => /^\d{4,8}$/.test(String(p || ''));
const WEAK = ['0000', '1111', '1234', '2222', '9999', '1961', '4321', '12345', '123456'];
// кассиры — ровно 6 цифр; остальные — от 4 до 8
function pinPolicy(role, pin) {
  const p = String(pin || '');
  if (role === 'cashier' && !/^\d{6}$/.test(p)) fail(400, 'pin_6', 'PIN кассира — ровно 6 цифр');
  if (!/^\d{4,8}$/.test(p)) fail(400, 'bad_pin_format', 'PIN — от 4 до 8 цифр');
}
async function setPin(env, id, pin, keepToken) {
  if (!PIN_OK(pin)) fail(400, 'bad_pin_format', 'PIN — от 4 до 8 цифр');
  const who = await db(env).one('SELECT role FROM staff WHERE id = ?', id); if (who) pinPolicy(who.role, pin);
  if (WEAK.includes(String(pin)) || /^(\d)\1+$/.test(String(pin))) fail(400, 'weak_pin', 'Слишком простой PIN');
  const other = await findStaffByPin(env, pin); if (other && other.id !== id) fail(409, 'pin_taken', 'Такой PIN уже у другого сотрудника — придумайте другой');
  const salt = randomHex(16); const D = db(env);
  await D.batch([D.stmt('UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?', await hashPin(pin, salt), salt, id),
    keepToken ? D.stmt('DELETE FROM sessions WHERE staff_id = ? AND token <> ?', id, keepToken) : D.stmt('DELETE FROM sessions WHERE staff_id = ?', id)]);
}
on('POST', '/api/me/pin', 'menu.read', async ({ env, me, body, request }) => {
  const s = await findStaffByPin(env, body.old_pin); if (!s || s.id !== me.id) { await audit(env, me.id, 'pin.change_failed'); fail(403, 'bad_old_pin', 'Старый PIN неверный'); }
  await setPin(env, me.id, body.new_pin, (request.headers.get('authorization') || '').slice(7));
  await audit(env, me.id, 'pin.change_own', 'staff', me.id);
  return { ok: true };
});
async function recovery(env) { return Object.assign({ email: 'vbatumi1@gmail.com', phone: '+995557420004' }, (await secretGet(env, 'recovery')) || {}); }
on('GET', '/api/owner/security', 'staff.manage', async ({ env }) => {
  const c = await tgConf(env); const r = await recovery(env);
  return { tg: { has_token: !!c.token, username: c.username || null, linked: !!c.chat, env: !!env.TG_TOKEN }, recovery: r, mail_ready: !!env.MAIL };
});
on('POST', '/api/owner/recovery', 'staff.manage', async ({ env, me, body }) => {
  const email = String(body.email || '').trim().slice(0, 120); const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'bad_email', 'Проверьте почту');
  await secretSet(env, 'recovery', { email, phone }); await audit(env, me.id, 'owner.recovery', 'settings', 'recovery', { email, phone });
  return { ok: true };
});
async function makeResetLink(env, staffId, origin) {
  const tok = randomHex(24); const exp = new Date(Date.now() + 30 * 60e3).toISOString().slice(0, 19).replace('T', ' ');
  await db(env).run('INSERT INTO pin_resets (hash, staff_id, expires_at) VALUES (?,?,?)', await sha256(tok), staffId, exp);
  return `${origin}/kassa/#reset=${tok}`;
}
// «Забыли PIN?» на экране входа: ссылка уходит владельцу в Telegram (и на почту, когда почта подключена)
on('POST', '/api/recover', null, async ({ env, request }) => {
  const D = db(env); const ip = request.headers.get('cf-connecting-ip') || 'local';
  const n = await D.one(`SELECT COUNT(*) AS n FROM pin_resets WHERE created_at > datetime('now', '-1 hour')`); if (n.n >= 3) fail(429, 'too_many', 'Ссылка уже отправлена. Новую можно запросить через час.');
  const owner = await D.one(`SELECT * FROM staff WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1`); if (!owner) fail(404, 'no_owner', 'Владелец не найден');
  const link = await makeResetLink(env, owner.id, payOrigin(request)); const sent = [];
  const c = await tgConf(env);
  if (c.chat && await tgSend(env, c.chat, `🔑 Pizza Room: запрос на новый PIN владельца (IP ${ip}).\nСсылка действует 30 минут:\n${link}\n\nЕсли это были не вы — ничего не делайте.`)) sent.push('telegram');
  if (env.MAIL) { try { await sendMail(env, (await recovery(env)).email, 'Pizza Room — новый PIN владельца', `Ссылка для нового PIN (действует 30 минут):\n${link}\n\nЕсли это были не вы — ничего не делайте.`); sent.push('email'); } catch (e) {} }
  await audit(env, null, 'pin.recover_request', 'staff', owner.id, { ip, sent });
  if (!sent.length) fail(503, 'no_channel', 'Telegram-бот ещё не подключён — восстановить PIN можно только через Cloudflare (как в инструкции). Подключите бота в «Настройках».');
  return { ok: true, sent };
});
on('POST', '/api/recover/reset', null, async ({ env, body }) => {
  const r = await db(env).one('SELECT * FROM pin_resets WHERE hash = ?', await sha256(String(body.token || '')));
  if (!r || r.used || r.expires_at < isoNow()) fail(400, 'bad_link', 'Ссылка устарела или уже использована — запросите новую');
  await setPin(env, r.staff_id, body.pin);
  await db(env).run('UPDATE pin_resets SET used = 1 WHERE hash = ?', r.hash);
  await audit(env, r.staff_id, 'pin.recovered', 'staff', r.staff_id); await notify(env, '🔑 PIN владельца изменён по ссылке восстановления.');
  return { ok: true };
});
// Почта: заработает, когда домен будет в Cloudflare и в wrangler.toml появится привязка send_email «MAIL»
async function sendMail(env, to, subject, text) {
  const { EmailMessage } = await import('cloudflare:email');
  const from = env.MAIL_FROM || 'noreply@pizzaroom.ge';
  const raw = [`From: Pizza Room <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text].join('\r\n');
  await env.MAIL.send(new EmailMessage(from, to, raw));
}
// Telegram: владелец вставляет токен бота из @BotFather, программа сама настраивает бота
on('POST', '/api/tg/connect', 'staff.manage', async ({ env, me, body, request }) => {
  const token = String(body.token || '').trim(); if (!/^\d{6,12}:[\w-]{30,}$/.test(token)) fail(400, 'bad_token', 'Это не похоже на токен бота. Скопируйте его из @BotFather целиком.');
  const who = await tgCall(token, 'getMe'); if (!who.ok) fail(400, 'bad_token', 'Telegram не принял токен — проверьте, что скопировали полностью.');
  const secret = randomHex(16); const code = randomHex(6); const origin = new URL(request.url).origin;
  const wh = await tgCall(token, 'setWebhook', { url: `${origin}/api/tg/hook/${secret}`, secret_token: secret, allowed_updates: ['message'] });
  if (!wh.ok) fail(502, 'webhook', 'Не удалось подключить бота: ' + (wh.description || 'нет ответа от Telegram'));
  await tgCall(token, 'setMyCommands', { commands: [{ command: 'report', description: 'Отчёт за вчера' }, { command: 'today', description: 'Продажи сегодня' }, { command: 'cash', description: 'Сколько наличных в кассе' }, { command: 'advice', description: 'Советник: что сделать' }, { command: 'pin', description: 'Забыл PIN — ссылка на новый' }, { command: 'delivery_off', description: 'Доставку на паузу (нет курьеров)' }, { command: 'delivery_on', description: 'Включить доставку' }, { command: 'help', description: 'Что умеет бот' }] });
  const old = (await secretGet(env, 'tg')) || {};
  await secretSet(env, 'tg', { token, username: who.result.username, secret, code, chat: old.token === token ? old.chat : null });
  await audit(env, me.id, 'tg.connect', 'settings', 'tg', { bot: who.result.username });
  return { username: who.result.username, link: `https://t.me/${who.result.username}?start=${code}` };
});
on('POST', '/api/tg/disconnect', 'staff.manage', async ({ env, me }) => {
  const c = (await secretGet(env, 'tg')) || {}; if (c.token) { try { await tgCall(c.token, 'deleteWebhook', {}); } catch (e) {} }
  await db(env).run(`DELETE FROM secrets WHERE key = 'tg'`); await audit(env, me.id, 'tg.disconnect'); return { ok: true };
});
on('POST', '/api/tg/test', 'staff.manage', async ({ env }) => { const c = await tgConf(env); if (!c.chat) fail(400, 'not_linked', 'Сначала откройте бота по ссылке и нажмите «Start»'); return { ok: await tgSend(env, c.chat, '✅ Pizza Room: бот работает. Сюда будут приходить отчёты, советы и ссылка для восстановления PIN.') }; });
async function todayText(env) {
  const t = tbDate(); const r = await db(env).one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_tetri),0) AS s FROM sales WHERE date(datetime(created_at, ${TZ})) = ?`, t);
  const top = await db(env).all(`SELECT pr.name_ru, SUM(oi.qty) AS q FROM order_items oi JOIN sales p ON p.order_id = oi.order_id JOIN products pr ON pr.id = oi.product_id WHERE oi.qty > 0 AND date(datetime(p.created_at, ${TZ})) = ? GROUP BY oi.product_id ORDER BY q DESC LIMIT 5`, t);
  return `Сегодня ${t}: заказов ${r.n}, выручка ${(r.s / 100).toFixed(2)} ₾` + (top.length ? '\nТоп: ' + top.map((x) => `${x.name_ru} ×${x.q}`).join(', ') : '');
}
on('POST', '/api/tg/hook/:secret', null, async ({ env, params, body, request }) => {
  const c = (await secretGet(env, 'tg')) || {};
  if (!c.secret || params.secret !== c.secret || request.headers.get('x-telegram-bot-api-secret-token') !== c.secret) fail(403, 'forbidden', 'нет');
  const m = body && body.message; if (!m || !m.chat) return { ok: true };
  const chat = String(m.chat.id); const text = String(m.text || '').trim(); const origin = new URL(request.url).origin;
  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1] || '';
    if (c.code && code === c.code) { await secretSet(env, 'tg', Object.assign({}, c, { chat, code: null })); await audit(env, null, 'tg.linked', 'settings', 'tg', { chat });
      await tgSend(env, chat, '✅ Готово! Это бот Pizza Room только для владельца.\n\nКаждое утро в 9:00 — отчёт за вчера и советы. Команды:\n/today — продажи сегодня\n/report — отчёт за вчера\n/advice — что предлагает советник\n/pin — ссылка на новый PIN, если забыли'); return { ok: true }; }
  }
  if (!c.chat || chat !== String(c.chat)) { await tgSend(env, chat, 'Этот бот работает только для владельца Pizza Room.'); return { ok: true }; }
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/delivery_off' || cmd === '/delivery_on') { const on = cmd === '/delivery_off'; await setDpause(env, null, { on, reason: (text.split(/\s+/)[1] || 'couriers').toLowerCase() });
    await tgSend(env, chat, on ? '⏸ Доставка на паузе. На сайте — только самовывоз. Включить: /delivery_on' : '▶ Доставка снова работает.'); }
  else if (cmd === '/cash') { const cn = await cashNow(env); const cc = await cashConf(env); await tgSend(env, chat, `💵 В кассе сейчас ${(cn.tetri / 100).toFixed(2)} ₾ наличными.${cn.tetri >= cc.alert_tetri ? ' Пора забрать или сдать в банк.' : ''}`); }
  else if (cmd === '/today') await tgSend(env, chat, await todayText(env));
  else if (cmd === '/report') await tgSend(env, chat, await dailyJob(env, true));
  else if (cmd === '/advice') { const A = await advise(env); const act = A.items.filter((x) => x.kind !== 'info');
    await tgSend(env, chat, act.length ? `🤖 Советник (${act.length}):\n\n` + act.slice(0, 8).map((x) => '• ' + x.title.ru + '\n  ' + x.text.ru).join('\n\n') + `\n\nВключить одной кнопкой: ${origin}/kassa/` : '🤖 Сейчас предложений нет — всё в порядке.'); }
  else if (cmd === '/pin') { const owner = await db(env).one(`SELECT id FROM staff WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1`);
    await tgSend(env, chat, `🔑 Ссылка для нового PIN владельца (30 минут):\n${await makeResetLink(env, owner.id, origin)}`); await audit(env, owner.id, 'pin.recover_request', 'staff', owner.id, { via: 'telegram' }); }
  else await tgSend(env, chat, 'Команды:\n/today — продажи сегодня\n/report — отчёт за вчера\n/advice — советник\n/delivery_off — доставку на паузу (нет курьеров)\n/delivery_off weather — пауза из-за погоды\n/delivery_on — включить доставку\n/pin — новый PIN владельца');
  return { ok: true };
});

// ───────── Лист ожидания «Скоро» ─────────
on('POST', '/api/public/waitlist', null, async ({ env, body, request }) => {
  const digits = String(body.phone || '').replace(/\D/g, '').replace(/^995/, '');
  if (!/^5\d{8}$/.test(digits)) fail(400, 'bad_phone', 'Проверьте номер: 9 цифр, начинается с 5');
  const cat = await db(env).one('SELECT id FROM categories WHERE id = ? AND soon = 1', String(body.category_id || '')); if (!cat) fail(400, 'bad_category', 'Раздел не найден');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const n = await db(env).one(`SELECT COUNT(*) AS n FROM waitlist WHERE source_ip = ? AND created_at > datetime('now','-1 hour')`, ip); if (n.n >= 5) fail(429, 'too_many', 'Слишком много попыток');
  await db(env).run('INSERT INTO waitlist (phone, category_id, lang, source_ip) VALUES (?,?,?,?) ON CONFLICT(phone, category_id) DO NOTHING', '+995' + digits, cat.id, ['ka', 'en', 'ru'].includes(body.lang) ? body.lang : 'ka', ip);
  return { ok: true };
});
on('GET', '/api/waitlist', 'reports.view', async ({ env }) => db(env).all('SELECT w.*, c.name_ru FROM waitlist w JOIN categories c ON c.id = w.category_id ORDER BY w.id DESC LIMIT 500'));

// ───────── Кухня ─────────
// напитки на кухню не идут: повара готовят только пиццу (и суши, когда появятся) — напитки выдаёт кассир
const DRINK_CATS = ['drinks', 'beer', 'wine', 'coffee', 'tea']; const DRINK_SQL = DRINK_CATS.map((c) => `'${c}'`).join(',');
on('GET', '/api/kitchen', 'kitchen.view', async ({ env }) => {
  const rows = await db(env).all(`SELECT o.*, (SELECT fiscal_number FROM fiscal_receipts f WHERE f.order_id = o.id) AS rno FROM orders o WHERE o.status != 'cancelled' AND o.ready_at IS NULL
    AND (o.sent_at IS NOT NULL OR o.paid_at IS NOT NULL OR (o.channel = 'site' AND o.accepted_at IS NOT NULL))
    AND (COALESCE(o.sent_at, o.paid_at, o.created_at) > datetime('now','-4 hours') OR (o.want_at IS NOT NULL AND o.want_at > datetime('now','-4 hours')))
    AND EXISTS (SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id AND oi.qty > 0 AND p.category_id NOT IN (${DRINK_SQL}))
    AND NOT EXISTS (SELECT 1 FROM order_stages s WHERE s.order_id = o.id AND s.stage = 'ready') ORDER BY COALESCE(${START_SQL}, o.sent_at, o.paid_at, o.created_at)`);
  if (!rows.length) return [];
  const items = await db(env).all(`SELECT oi.order_id, oi.qty, p.name_ka, p.name_ru, p.category_id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.qty > 0 AND p.category_id NOT IN (${DRINK_SQL}) AND oi.order_id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
  await withStages(env, rows);
  const nowS = isoNow().slice(0, 19).replace('T', ' ');
  return rows.map((o) => ({ id: o.id, no: o.rno || null, want_at: o.want_at, start_at: startAtOf(o), later: !!(o.want_at && !o.cooking_at && startAtOf(o) > nowS), cooking: !!o.cooking_at, paid: !!o.paid_at || o.pay_state === 'paid', test: !!o.is_test, channel: o.channel, external_id: o.external_id, mode: o.mode, note: o.channel === 'site' ? o.note : o.note, since: o.sent_at || o.paid_at || o.created_at, items: items.filter((i) => i.order_id === o.id) }));
});

// ───────── Печать на кухню: программа на компьютере кассы забирает заказы и печатает бланк ─────────
// Ключ программы: создаёт владелец/менеджер в «Настройках» (показывается один раз), хранится только хэш.
async function printAuth(env, request) {
  const k = String(request.headers.get('x-print-key') || ''); const c = await secretGet(env, 'print_key');
  if (!k || !c || c.hash !== await sha256(k)) fail(401, 'bad_key', 'Неверный ключ принтера — создайте новый в «Настройках»');
  const now = isoNow(); // «последний раз на связи» — пишем не чаще раза в минуту
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('print_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value < ?`, now,
    new Date(Date.now() - 60e3).toISOString().slice(0, 19).replace('T', ' '));
  return c;
}
// Заказ «ко времени»: кухня начинает за 20 минут (самовывоз) или за 40 минут (доставка) до нужного времени
const LEAD_SQL = `CASE WHEN o.mode = 'delivery' THEN 40 ELSE 20 END`;
const START_SQL = `datetime(o.want_at, '-' || ${LEAD_SQL} || ' minutes')`;
const startAtOf = (o) => o.want_at ? new Date(Date.parse(o.want_at.replace(' ', 'T') + 'Z') - (o.mode === 'delivery' ? 40 : 20) * 60e3).toISOString().slice(0, 19).replace('T', ' ') : null;
const PCH = { hall: 'დარბაზი', takeaway: 'წასაღები', site: 'საიტი', delivery: 'მიტანა', wolt: 'WOLT', glovo: 'GLOVO', bolt: 'BOLT' };
function tbsTime(iso) { const d = new Date(String(iso).replace(' ', 'T') + 'Z'); d.setUTCHours(d.getUTCHours() + 4); return d.toISOString().slice(11, 16); }
async function kitchenTickets(env, onlyNew, limit = 10, only = null) {
  const c = await secretGet(env, 'print_key'); const from = (c && c.from) || isoNow();
  // only = список заказов для повторной печати чека кассира (кнопка «печать чека» с телефона)
  const rows = only ? (only.length ? await db(env).all(`SELECT o.*, f.fiscal_number AS rno FROM orders o LEFT JOIN fiscal_receipts f ON f.order_id = o.id WHERE o.status != 'cancelled' AND o.id IN (${only.map(() => '?').join(',')})`, ...only) : []) : await db(env).all(`SELECT o.*, f.fiscal_number AS rno FROM orders o LEFT JOIN fiscal_receipts f ON f.order_id = o.id WHERE o.status != 'cancelled'
    AND (o.sent_at IS NOT NULL OR o.paid_at IS NOT NULL OR (o.channel = 'site' AND o.accepted_at IS NOT NULL))
    AND (COALESCE(o.sent_at, o.paid_at, o.accepted_at) > datetime('now','-4 hours') OR (o.want_at IS NOT NULL AND o.want_at > datetime('now','-4 hours'))) AND COALESCE(o.sent_at, o.paid_at, o.accepted_at) > ?
    AND (o.want_at IS NULL OR ${START_SQL} <= datetime('now')) -- заказ ко времени печатается только когда пора готовить
    AND o.id NOT IN (SELECT order_id FROM voids)
    AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.qty > 0)
    ${onlyNew ? 'AND NOT EXISTS (SELECT 1 FROM kitchen_prints k WHERE k.order_id = o.id)' : ''} ORDER BY COALESCE(o.sent_at, o.paid_at, o.accepted_at) LIMIT ${limit}`, from);
  if (!rows.length) return [];
  const items = await db(env).all(`SELECT oi.order_id, oi.qty, oi.unit_price_tetri, p.name_ka, p.name_ru, p.size, p.category_id FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.qty > 0 AND oi.order_id IN (${rows.map(() => '?').join(',')}) ORDER BY oi.id`, ...rows.map((r) => r.id));
  const jobs = [];
  for (const o of rows) {
    const mine = items.filter((i) => i.order_id === o.id);
    const g = {}; mine.forEach((i) => { const k = (i.name_ka || i.name_ru) + (i.size ? ' ' + String(i.size).replace(/см/g, 'სმ').replace(/(\d)\s*л\b|(\d)\s*л$/g, '$1$2 ლ') : '');
      g[k] = g[k] || { n: k, q: 0, sum: 0, d: DRINK_CATS.includes(i.category_id) }; g[k].q += i.qty; g[k].sum += i.qty * i.unit_price_tetri; });
    const all = Object.values(g); const food = all.filter((x) => !x.d);
    const mode = o.channel === 'site' ? (o.mode === 'pickup' ? 'წასაღები' : 'მიტანა') : '';
    const L = [];
    L.push({ t: 'PIZZA ROOM · სამზარეულო', s: 9, a: 'c' });
    if (o.is_test) L.push({ t: 'ტესტი · ТЕСТ', s: 14, b: 1, a: 'c', inv: 1 });
    L.push({ t: '# ' + (o.rno || o.id), s: 34, b: 1, a: 'c' });
    L.push({ t: (PCH[o.channel] || o.channel) + (o.external_id ? ' #' + o.external_id : '') + (mode ? ' · ' + mode : ''), s: 15, b: 1, a: 'c', inv: ['wolt', 'glovo', 'bolt'].includes(o.channel) ? 1 : 0 });
    const paid = !!o.paid_at || o.pay_state === 'paid';
    if (o.want_at) { L.push({ line: 1 }); L.push({ t: '⏰ ' + tbsTime(o.want_at) + '-ისთვის', s: 30, b: 1, a: 'c', inv: 1 }); L.push({ t: 'К ' + tbsTime(o.want_at) + ' · ' + (o.mode === 'delivery' ? 'მიტანა / доставка' : 'კლიენტი მოვა / клиент придёт'), s: 12, b: 1, a: 'c' }); }
    L.push({ t: paid ? 'გადახდილია ✓ ОПЛАЧЕНО' : 'არ არის გადახდილი · НЕ ОПЛАЧЕН', s: paid ? 18 : 12, b: 1, a: 'c', inv: paid ? 1 : 0 });
    L.push({ t: tbsTime(o.sent_at || o.paid_at || o.accepted_at), s: 10, a: 'c' });
    L.push({ line: 1 });
    food.forEach((x) => L.push({ t: x.q + ' × ' + x.n, s: 17, b: 1 }));
    if (o.note) { L.push({ line: 1 }); L.push({ t: '>> ' + String(o.note).slice(0, 300), s: 13, b: 1 }); }
    L.push({ line: 1 }); L.push({ t: 'შიდა #' + o.id, s: 8, a: 'c' });
    const no = String(o.rno || o.id);
    // 1) бланк на кухню — только пиццы (если в заказе одни напитки — на кухню ничего не печатаем)
    if (food.length && !only) jobs.push({ id: o.id, no, kind: 'kitchen', lines: L });
    // 2) чек кассиру — всё, что в заказе, с ценами; номер тот же, что на кухне
    const T = withTotals(Object.assign({}, o, { items: mine }));
    const K = [{ t: 'PIZZA ROOM · სალარო', s: 9, a: 'c' }];
    if (o.is_test) K.push({ t: 'ტესტი · ТЕСТ', s: 14, b: 1, a: 'c', inv: 1 });
    K.push({ t: '# ' + no, s: 34, b: 1, a: 'c' });
    K.push({ t: (PCH[o.channel] || o.channel) + (o.external_id ? ' #' + o.external_id : '') + (mode ? ' · ' + mode : ''), s: 13, b: 1, a: 'c' });
    if (o.want_at) K.push({ t: '⏰ ' + tbsTime(o.want_at) + '-ისთვის', s: 16, b: 1, a: 'c', inv: 1 });
    K.push({ t: tbsTime(o.sent_at || o.paid_at || o.accepted_at), s: 10, a: 'c' }); K.push({ line: 1 });
    const gel = (t) => (t / 100).toFixed(2) + ' ₾';
    all.forEach((x) => K.push({ t: x.q + ' × ' + x.n + '   ' + gel(x.sum), s: 12, b: x.d ? 0 : 1 }));
    K.push({ line: 1 });
    if (T.discount_tetri) K.push({ t: 'ფასდაკლება  −' + gel(T.discount_tetri), s: 11 });
    if (o.delivery_fee_tetri) K.push({ t: 'მიტანა  ' + gel(o.delivery_fee_tetri), s: 11 });
    K.push({ t: 'სულ: ' + gel(T.total_tetri), s: 20, b: 1, a: 'r' });
    K.push({ t: paid ? 'გადახდილია ✓' : 'გადასახდელია', s: 12, b: 1, a: 'c', inv: paid ? 1 : 0 });
    if (o.customer_name || o.customer_phone) K.push({ t: [o.customer_name, o.customer_phone].filter(Boolean).join(' · '), s: 11 });
    if (o.address) K.push({ t: String(o.address).slice(0, 200), s: 11 });
    if (o.note) K.push({ t: '>> ' + String(o.note).slice(0, 300), s: 11 });
    jobs.push({ id: o.id, no, kind: 'cashier', lines: K });
  }
  return jobs;
}
on('GET', '/api/print/kitchen', null, async ({ env, request }) => {
  await printAuth(env, request);
  const out = await kitchenTickets(env, true);
  const rc = await rcQueue(env); if (rc.length) out.push(...(await kitchenTickets(env, false, 20, rc)).filter((j) => j.kind === 'cashier'));
  const t = await db(env).one(`SELECT value FROM settings WHERE key = 'print_test'`);
  if (t) out.unshift({ id: 0, no: 'TEST', lines: [{ t: 'PIZZA ROOM', s: 22, b: 1, a: 'c' }, { t: 'სატესტო ბეჭდვა · Тест печати', s: 13, a: 'c' }, { line: 1 },
    { t: '2 × პეპერონი', s: 17, b: 1 }, { t: '1 × მარგარიტა', s: 17, b: 1 }, { line: 1 }, { t: 'ქართული · Русский · English — OK', s: 11, a: 'c' }, { t: tbsTime(isoNow()), s: 10, a: 'c' }] });
  return out;
});
on('POST', '/api/print/kitchen/:id/done', null, async ({ env, request, params }) => {
  await printAuth(env, request); const id = Number(params.id);
  if (id === 0) await db(env).run(`DELETE FROM settings WHERE key = 'print_test'`);
  else { await db(env).run('INSERT OR IGNORE INTO kitchen_prints (order_id) VALUES (?)', int(params.id, 'id')); const rc = await rcQueue(env); if (rc.includes(id)) await rcSave(env, rc.filter((x) => x !== id)); }
  return { ok: true };
});
// повторный чек кассира на принтер кассы (с телефона window.print() не работает)
async function rcQueue(env) { const r = await db(env).one(`SELECT value FROM settings WHERE key = 'print_rc'`); try { return r ? JSON.parse(r.value).filter(Number.isInteger) : []; } catch (e) { return []; } }
async function rcSave(env, a) { await db(env).run(`INSERT INTO settings (key, value) VALUES ('print_rc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(a.slice(-20))); }
on('POST', '/api/print/receipt/:id', 'kitchen.view', async ({ env, me, params }) => {
  const id = int(params.id, 'id'); const c = await secretGet(env, 'print_key'); if (!c) fail(409, 'no_printer', 'Принтер кассы не подключён');
  const o = await db(env).one('SELECT id FROM orders WHERE id = ?', id); if (!o) fail(404, 'not_found', 'Заказ не найден');
  const printed = await db(env).one('SELECT 1 AS x FROM kitchen_prints WHERE order_id = ?', id);
  if (!printed && (await kitchenTickets(env, true, 50)).some((j) => j.id === id)) return { ok: true, auto: true }; // и так сейчас напечатается
  const rc = await rcQueue(env); if (!rc.includes(id)) await rcSave(env, [...rc, id]);
  await audit(env, me.id, 'print.receipt', 'order', id); return { ok: true };
});
on('POST', '/api/print/error', null, async ({ env, request, body }) => {
  await printAuth(env, request); const msg = String(body.msg || '').slice(0, 200);
  const prev = await db(env).one(`SELECT value FROM settings WHERE key = 'print_err'`);
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('print_err', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ at: isoNow(), msg }));
  if (!prev || JSON.parse(prev.value).at < new Date(Date.now() - 30 * 60e3).toISOString().slice(0, 19).replace('T', ' ')) await notify(env, '🖨 Принтер кухни: ' + msg);
  return { ok: true };
});
on('GET', '/api/print/status', 'kitchen.view', async ({ env }) => {
  const test = !!(await testMode(env));
  const c = await secretGet(env, 'print_key'); if (!c) return { configured: false, test };
  const s = await db(env).one(`SELECT value FROM settings WHERE key = 'print_seen'`); const e = await db(env).one(`SELECT value FROM settings WHERE key = 'print_err'`);
  const pending = new Set((await kitchenTickets(env, true, 50)).map((j) => j.id)).size; const seen = s ? s.value : null;
  const err = e ? JSON.parse(e.value) : null;
  return { configured: true, test, seen_at: seen, online: !!seen && seen > new Date(Date.now() - 3 * 60e3).toISOString().slice(0, 19).replace('T', ' '), pending,
    error: err && seen && err.at >= seen ? err.msg : null, created_at: c.at };
});
on('POST', '/api/print/key', 'settings.edit', async ({ env, me }) => {
  const key = 'PR-' + randomHex(12).toUpperCase(); await secretSet(env, 'print_key', { hash: await sha256(key), at: isoNow(), from: isoNow(), by: me.id });
  await db(env).run(`DELETE FROM settings WHERE key IN ('print_seen','print_err')`);
  await audit(env, me.id, 'print.key', 'settings', 'print'); return { key };
});
on('POST', '/api/print/test', 'kitchen.view', async ({ env }) => {
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('print_test', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, isoNow()); return { ok: true };
});
on('POST', '/api/print/kitchen/:id/again', 'kitchen.view', async ({ env, me, params }) => {
  const id = int(params.id, 'id'); await db(env).run('DELETE FROM kitchen_prints WHERE order_id = ?', id);
  await audit(env, me.id, 'print.again', 'order', id); return { ok: true };
});

// ───────── Тестовый режим (владелец): заказы помечаются тестовыми и потом удаляются одной кнопкой ─────────
async function testMode(env) { const r = await db(env).one(`SELECT value FROM settings WHERE key = 'test_mode'`).catch(() => null); return r ? JSON.parse(r.value) : null; }
const ownerOnly = (me) => { if (me.role !== 'owner') fail(403, 'owner_only', 'Только владелец'); };
async function testSummary(env) {
  const r = await db(env).one(`SELECT (SELECT COUNT(*) FROM orders WHERE is_test = 1) AS orders, (SELECT COALESCE(SUM(p.total_tetri),0) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 1) AS total_tetri,
    (SELECT COUNT(*) FROM shifts WHERE is_test = 1) AS shifts, (SELECT COUNT(*) FROM stock_moves m JOIN orders o ON o.id = m.order_id WHERE o.is_test = 1) AS moves`);
  return Object.assign({ mode: await testMode(env) }, r);
}
on('GET', '/api/test', 'settings.edit', async ({ env, me }) => { ownerOnly(me); return testSummary(env); });
on('POST', '/api/test/mode', 'settings.edit', async ({ env, me, body }) => {
  ownerOnly(me);
  if (body.on) await db(env).run(`INSERT INTO settings (key, value) VALUES ('test_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ since: isoNow(), by: me.id }));
  else { await db(env).run(`DELETE FROM settings WHERE key = 'test_mode'`); await db(env).run('UPDATE shifts SET is_test = 0 WHERE is_test = 1 AND closed_at IS NULL'); }
  await audit(env, me.id, body.on ? 'test.on' : 'test.off', 'settings', 'test_mode');
  await notify(env, body.on ? '🧪 Включён тестовый режим: новые заказы будут тестовыми.' : '✅ Тестовый режим выключен: заказы снова настоящие.');
  return testSummary(env);
});
// Защита от удаления снимается только на время этой операции и сразу возвращается (всё в одной транзакции)
const GUARDS = [['voids_no_delete', 'voids', 'voids are immutable'], ['pay_no_delete', 'payments', 'payments are immutable'], ['moves_no_delete', 'stock_moves', 'stock moves are immutable'], ['fiscal_no_delete', 'fiscal_receipts', 'fiscal receipts are immutable'],
  ['approvals_no_delete', 'approvals', 'approvals are immutable'], ['orders_no_delete', 'orders', 'orders cannot be deleted, cancel instead'], ['items_no_delete', 'order_items', 'order items cannot be deleted']];
on('POST', '/api/test/purge', 'settings.edit', async ({ env, me, body }) => {
  ownerOnly(me); if (body.confirm !== 'DELETE') fail(400, 'confirm', 'Нужно подтверждение');
  const D = db(env); const before = await testSummary(env);
  if (!before.orders && !before.shifts) return before;
  const T = 'SELECT id FROM orders WHERE is_test = 1';
  const freeShifts = `SELECT id FROM shifts WHERE is_test = 1 AND id NOT IN (SELECT shift_id FROM orders WHERE shift_id IS NOT NULL AND is_test = 0) AND id NOT IN (SELECT p.shift_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0 AND p.shift_id IS NOT NULL)`;
  await D.batch([
    ...GUARDS.map(([n]) => D.stmt(`DROP TRIGGER IF EXISTS ${n}`)),
    D.stmt(`DELETE FROM stock_moves WHERE order_id IN (${T})`), D.stmt(`DELETE FROM kitchen_prints WHERE order_id IN (${T})`), D.stmt(`DELETE FROM online_pays WHERE order_id IN (${T})`), D.stmt(`DELETE FROM order_stages WHERE order_id IN (${T})`),
    D.stmt(`DELETE FROM receivables WHERE order_id IN (${T})`), D.stmt(`DELETE FROM approvals WHERE order_id IN (${T})`), D.stmt(`DELETE FROM fiscal_receipts WHERE order_id IN (${T})`),
    D.stmt(`DELETE FROM voids WHERE order_id IN (${T})`), D.stmt(`DELETE FROM payments WHERE order_id IN (${T})`), D.stmt(`DELETE FROM order_items WHERE order_id IN (${T})`), D.stmt(`DELETE FROM orders WHERE is_test = 1`),
    D.stmt(`DELETE FROM cash_moves WHERE shift_id IN (SELECT id FROM shifts WHERE is_test = 1)`), D.stmt(`DELETE FROM shifts WHERE id IN (${freeShifts}) AND closed_at IS NOT NULL`), // открытую смену не трогаем — кассир продолжает работать
    D.stmt(`DELETE FROM settings WHERE key IN ('print_test','cash_reminded')`),
    ...GUARDS.map(([n, t, msg]) => D.stmt(`CREATE TRIGGER IF NOT EXISTS ${n} BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${msg}'); END`))
  ]);
  await audit(env, me.id, 'test.purge', 'orders', null, { orders: before.orders, total_tetri: before.total_tetri, shifts: before.shifts });
  await notify(env, `🧪 Удалены тестовые заказы: ${before.orders} шт. на ${(before.total_tetri / 100).toFixed(2)} ₾. Склад и касса пересчитаны.`);
  return testSummary(env);
});

// ───────── Старт «с чистого листа»: один раз удалить ВСЕ пробные продажи до запуска (только владелец, с подтверждением) ─────────
async function salesResetInfo(env) {
  const D = db(env); const done = await D.one(`SELECT value FROM settings WHERE key = 'sales_reset'`);
  const r = await D.one(`SELECT COUNT(*) AS orders, MIN(created_at) AS first_at, MAX(created_at) AS last_at, (SELECT COALESCE(SUM(total_tetri),0) FROM payments) AS total_tetri,
    (SELECT COUNT(*) FROM shifts WHERE closed_at IS NOT NULL) AS shifts, (SELECT COUNT(*) FROM orders WHERE channel = 'site') AS site_orders FROM orders`);
  return Object.assign({ done: done ? JSON.parse(done.value) : null }, r);
}
on('GET', '/api/sales-reset', 'settings.edit', async ({ env, me }) => { ownerOnly(me); return salesResetInfo(env); });
on('POST', '/api/sales-reset', 'settings.edit', async ({ env, me, body }) => {
  ownerOnly(me); const info = await salesResetInfo(env);
  if (info.done) fail(409, 'already_done', 'Пробные продажи уже удалены ' + String(info.done.at || '').slice(0, 10) + '. Повторно удалять продажи нельзя — это защита настоящей выручки.');
  if (String(body.confirm || '').trim().toUpperCase() !== 'УДАЛИТЬ') fail(400, 'confirm', 'Впишите слово УДАЛИТЬ');
  if (Number(body.orders) !== info.orders) fail(409, 'changed', 'Пока вы подтверждали, появились новые заказы — откройте окно ещё раз');
  const D = db(env); const cut = await D.one(`SELECT datetime('now') AS t`); const C = cut.t;
  const T = `SELECT id FROM orders WHERE created_at <= '${C}'`;
  const shiftsGone = `SELECT id FROM shifts WHERE closed_at IS NOT NULL AND closed_at <= '${C}'`;
  await D.batch([
    ...GUARDS.map(([n]) => D.stmt(`DROP TRIGGER IF EXISTS ${n}`)),
    D.stmt(`DELETE FROM stock_moves WHERE order_id IN (${T})`), D.stmt(`DELETE FROM kitchen_prints WHERE order_id IN (${T})`), D.stmt(`DELETE FROM online_pays WHERE order_id IN (${T})`), D.stmt(`DELETE FROM order_stages WHERE order_id IN (${T})`),
    D.stmt(`DELETE FROM receivables WHERE order_id IN (${T})`), D.stmt(`DELETE FROM approvals WHERE order_id IN (${T})`), D.stmt(`DELETE FROM fiscal_receipts WHERE order_id IN (${T})`),
    D.stmt(`DELETE FROM voids WHERE order_id IN (${T})`), D.stmt(`DELETE FROM payments WHERE order_id IN (${T})`), D.stmt(`DELETE FROM order_items WHERE order_id IN (${T})`), D.stmt(`DELETE FROM orders WHERE id IN (${T})`),
    D.stmt(`DELETE FROM cash_moves WHERE shift_id IN (${shiftsGone})`), D.stmt(`DELETE FROM shifts WHERE id IN (${shiftsGone}) AND id NOT IN (SELECT shift_id FROM orders WHERE shift_id IS NOT NULL) AND id NOT IN (SELECT shift_id FROM payments WHERE shift_id IS NOT NULL)`),
    D.stmt(`DELETE FROM settings WHERE key IN ('print_test','cash_reminded')`),
    D.stmt(`INSERT INTO settings (key, value) VALUES ('sales_reset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ at: C, by: me.id, orders: info.orders, total_tetri: info.total_tetri })),
    ...GUARDS.map(([n, t, msg]) => D.stmt(`CREATE TRIGGER IF NOT EXISTS ${n} BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${msg}'); END`))
  ]);
  await audit(env, me.id, 'sales.reset', 'orders', null, { orders: info.orders, total_tetri: info.total_tetri, shifts: info.shifts, before: C });
  await notify(env, `🧹 Удалены все пробные продажи до запуска: ${info.orders} заказов на ${(info.total_tetri / 100).toFixed(2)} ₾ (${me.name}). С этого момента считаются только настоящие продажи.`);
  return salesResetInfo(env);
});

// ───────── Клиенты (по телефону) ─────────
on('GET', '/api/customers', 'reports.view', async ({ env }) => { // все, кто хоть раз заказывал (сайт, касса, телефон) — даже если заказ ещё не оплачен
  const rows = await db(env).all(`WITH g AS (SELECT o.customer_phone AS ph, COUNT(DISTINCT o.id) AS orders, SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      COALESCE(SUM(p.total_tetri), 0) AS total_tetri, MAX(o.id) AS last_id, MIN(o.created_at) AS first_at, MAX(o.created_at) AS last_at, SUM(CASE WHEN o.channel = 'site' THEN 1 ELSE 0 END) AS site_orders
    FROM orders o LEFT JOIN sales p ON p.order_id = o.id WHERE o.customer_phone IS NOT NULL AND o.customer_phone != '' AND COALESCE(o.is_test, 0) = 0 GROUP BY o.customer_phone)
    SELECT g.ph AS phone, o.customer_name AS name, o.address AS address, g.orders, g.paid_orders, g.total_tetri, g.first_at, g.last_at, g.site_orders
    FROM g JOIN orders o ON o.id = g.last_id ORDER BY g.last_at DESC LIMIT 2000`);
  return rows;
});

// ───────── Прогноз склада: на сколько дней хватит и что заказать ─────────
on('GET', '/api/stock/forecast', 'stock.view', async ({ env, url }) => {
  const days = Math.min(60, Math.max(3, Number(url.searchParams.get('days')) || 14));
  const rows = await db(env).all(`SELECT i.id, i.name, i.unit, i.min_stock, i.cost_per_1000_tetri, s.qty AS stock,
      COALESCE((SELECT -SUM(delta) FROM stock_moves m WHERE m.ingredient_id = i.id AND m.kind IN ('sale','writeoff') AND m.created_at > datetime('now', ?)), 0) AS used
    FROM ingredients i JOIN stock_levels s ON s.id = i.id WHERE i.archived = 0 ORDER BY i.name`, `-${days} days`);
  return rows.map((r) => { const perDay = r.used / days; const daysLeft = perDay > 0 ? Math.max(0, r.stock) / perDay : null;
    const need7 = Math.max(0, Math.ceil(perDay * 7 * 1.15 - Math.max(0, r.stock)), r.stock < r.min_stock ? r.min_stock - r.stock : 0);
    return Object.assign(r, { per_day: Math.round(perDay), days_left: daysLeft == null ? null : Math.round(daysLeft * 10) / 10, buy_qty: need7, buy_tetri: Math.round(need7 * r.cost_per_1000_tetri / 1000) }); });
});

// ───────── Филиалы (основа для сети) ─────────
on('GET', '/api/branches', 'menu.read', async ({ env }) => db(env).all('SELECT * FROM branches ORDER BY sort, id'));
on('POST', '/api/branches', 'staff.manage', async ({ env, me, body }) => {
  const name = String(body.name_ru || '').trim(); if (!name) fail(400, 'no_name', 'Введите название филиала');
  const id = body.id || newId('br', body.name_en || name);
  await db(env).run(`INSERT INTO branches (id, name_ru, name_ka, name_en, address, phone, lat, lng, sort) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name_ru = excluded.name_ru, name_ka = excluded.name_ka, name_en = excluded.name_en, address = excluded.address, phone = excluded.phone, lat = excluded.lat, lng = excluded.lng, sort = excluded.sort`,
    id, name, body.name_ka || name, body.name_en || name, body.address || null, body.phone || null, body.lat ?? null, body.lng ?? null, int(body.sort ?? 50, 'sort'));
  await audit(env, me.id, 'branch.save', 'branch', id, body);
  return { id };
});

// ───────── Каталог: разделы, товары, ингредиенты, рецепты ─────────
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const newId = (prefix, name) => (slug(name) || prefix) + '-' + randomHex(2);
async function unitCosts(env, ids) {
  const out = {}; if (!ids.length) return out;
  const rows = await db(env).all(`SELECT r.product_id, SUM(r.qty * i.cost_per_1000_tetri) / 1000.0 AS c FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
    WHERE r.product_id IN (${ids.map(() => '?').join(',')}) GROUP BY r.product_id`, ...ids);
  for (const r of rows) out[r.product_id] = Math.round(r.c);
  return out;
}
on('GET', '/api/categories', 'menu.read', async ({ env }) => db(env).all('SELECT * FROM categories WHERE active = 1 ORDER BY sort, name_ru'));
on('GET', '/api/catalog', 'menu.edit', async ({ env }) => {
  const D = db(env);
  const [cats, prods, prices, recipes, ings, channels] = await Promise.all([
    D.all('SELECT * FROM categories c WHERE c.active = 1 OR EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.archived = 0) ORDER BY sort, name_ru'), D.all('SELECT * FROM products WHERE archived = 0 ORDER BY sort, name_ru'),
    D.all('SELECT * FROM prices'), D.all('SELECT * FROM recipes'), D.all('SELECT i.*, s.qty AS stock FROM ingredients i JOIN stock_levels s ON s.id = i.id WHERE i.archived = 0 ORDER BY i.name'),
    D.all('SELECT * FROM channels')]);
  const ingById = Object.fromEntries(ings.map((i) => [i.id, i]));
  for (const r of await D.all('SELECT parent_id, child_id, qty_per_1000 FROM ingredient_parts')) if (ingById[r.parent_id]) (ingById[r.parent_id].parts ||= []).push({ child_id: r.child_id, qty_per_1000: r.qty_per_1000 });
  for (const p of prods) {
    p.prices = {}; for (const pr of prices) if (pr.product_id === p.id) p.prices[pr.price_list] = pr.price_tetri;
    p.recipe = recipes.filter((r) => r.product_id === p.id).map((r) => ({ ingredient_id: r.ingredient_id, qty: r.qty, line_cost_tetri: Math.round(r.qty * (ingById[r.ingredient_id]?.cost_per_1000_tetri || 0) / 1000) }));
    p.cost_tetri = p.recipe.reduce((s, r) => s + r.line_cost_tetri, 0);
  }
  return { categories: cats, products: prods, ingredients: ings, channels };
});
on('POST', '/api/categories', 'menu.edit', async ({ env, me, body }) => {
  const name_ru = String(body.name_ru || '').trim(); if (!name_ru) fail(400, 'no_name', 'Введите название раздела');
  const id = body.id || newId('cat', body.name_en || name_ru);
  await db(env).run(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru, active, soon, age18) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sort = excluded.sort, name_ka = excluded.name_ka, name_en = excluded.name_en, name_ru = excluded.name_ru, active = excluded.active, soon = excluded.soon, age18 = excluded.age18`,
    id, int(body.sort ?? 50, 'sort'), String(body.name_ka || name_ru), String(body.name_en || name_ru), name_ru, body.active === false ? 0 : 1, body.soon ? 1 : 0, body.age18 ? 1 : 0);
  await audit(env, me.id, 'category.save', 'category', id, body);
  return { id };
});
// Удаление ингредиента: если он нигде не используется. С историей движений — скрывается (отчёты не ломаются), без истории — удаляется совсем.
on('POST', '/api/ingredients/:id/delete', 'menu.edit', async ({ env, me, params }) => {
  const D = db(env); const id = String(params.id);
  const ing = await D.one('SELECT * FROM ingredients WHERE id = ?', id); if (!ing) fail(404, 'not_found', 'Нет такого ингредиента');
  const [rec, par, pack, moves] = await Promise.all([
    D.all('SELECT p.name_ru FROM recipes r JOIN products p ON p.id = r.product_id WHERE r.ingredient_id = ? AND p.archived = 0', id),
    D.all('SELECT i.name FROM ingredient_parts x JOIN ingredients i ON i.id = x.parent_id WHERE x.child_id = ?', id),
    D.all('SELECT name_ru FROM products WHERE pack_ing = ? AND archived = 0', id),
    D.one('SELECT COUNT(*) AS n FROM stock_moves WHERE ingredient_id = ?', id)]);
  const where = [];
  if (rec.length) where.push('в рецептах: ' + rec.map((r) => r.name_ru).join(', '));
  if (par.length) where.push('в заготовках: ' + par.map((r) => r.name.split(' · ').pop()).join(', '));
  if (pack.length) where.push('как упаковка: ' + pack.map((r) => r.name_ru).join(', '));
  if (where.length) fail(409, 'in_use', 'Сначала уберите ингредиент ' + where.join('; '));
  if (moves.n) await D.run('UPDATE ingredients SET archived = 1 WHERE id = ?', id);
  else await D.batch([D.stmt('DELETE FROM ingredient_parts WHERE parent_id = ?', id), D.stmt('DELETE FROM ingredients WHERE id = ?', id)]);
  await refreshComposite(env);
  await audit(env, me.id, 'ingredient.delete', 'ingredient', id, { name: ing.name, archived: !!moves.n });
  return { ok: true, archived: !!moves.n };
});
on('POST', '/api/ingredients', 'menu.edit', async ({ env, me, body }) => {
  const name = String(body.name || '').trim(); if (!name) fail(400, 'no_name', 'Введите название ингредиента');
  const unit = body.unit; if (!['g', 'ml', 'pcs'].includes(unit)) fail(400, 'bad_unit', 'Единица: g, ml или pcs');
  const D = db(env); const old = body.id ? await D.one('SELECT * FROM ingredients WHERE id = ?', body.id) : null;
  const dup = (await D.all('SELECT id, name, archived FROM ingredients')).find((x) => x.id !== body.id && x.name.trim().toLowerCase() === name.toLowerCase());
  if (dup && dup.archived) { await D.run('UPDATE ingredients SET archived = 0 WHERE id = ?', dup.id); return { id: dup.id }; }
  if (dup) fail(409, 'duplicate', 'Ингредиент с таким названием уже есть');
  const id = old ? old.id : newId('ing', body.name_en || name);
  const cost = body.cost_per_1000_tetri != null ? int(body.cost_per_1000_tetri, 'cost') : (old ? old.cost_per_1000_tetri : 0);
  if (old && cost !== old.cost_per_1000_tetri && me.role !== 'owner') fail(403, 'forbidden', 'Цену ингредиента меняет приход по накладной или владелец');
  let bu = old ? (old.buy_units || '[]') : '[]';
  if (Array.isArray(body.buy_units)) {
    const L = body.buy_units.slice(0, 5).map((x) => ({ n: String(x && x.n || '').trim().slice(0, 20), q: Math.round(Number(x && x.q) * 1000) / 1000 })).filter((x) => x.n);
    for (const x of L) if (!(x.q > 0 && x.q <= 1e7)) fail(400, 'bad_unit', 'Укажите, сколько г / мл / шт в единице «' + x.n + '»');
    bu = JSON.stringify(L);
  }
  const shelf = body.shelf_days != null && body.shelf_days !== '' ? Math.max(0, Math.min(3650, Math.round(Number(body.shelf_days) || 0))) : (old ? old.shelf_days || 0 : 0);
  await D.run(`INSERT INTO ingredients (id, name, unit, cost_per_1000_tetri, min_stock, buy_units, shelf_days) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, unit = excluded.unit, cost_per_1000_tetri = excluded.cost_per_1000_tetri, min_stock = excluded.min_stock, buy_units = excluded.buy_units, shelf_days = excluded.shelf_days`,
    id, name, unit, cost, int(body.min_stock ?? 0, 'min_stock'), bu, shelf);
  if (Array.isArray(body.parts)) {
    const all = new Set((await D.all('SELECT id FROM ingredients')).map((r) => r.id)); const seen = new Set();
    const P = body.parts.map((x) => ({ c: String(x && x.child_id || ''), q: Math.round(Number(x && x.qty_per_1000) * 100) / 100 })).filter((x) => x.c && x.q > 0 && !seen.has(x.c) && seen.add(x.c));
    for (const x of P) { if (!all.has(x.c)) fail(400, 'bad_ingredient', 'Нет такого ингредиента в составе'); if (x.c === id) fail(400, 'self_part', 'Заготовка не может состоять сама из себя'); }
    const pm = await partsMap(env); pm[id] = P.map((x) => ({ child_id: x.c, qty_per_1000: x.q }));
    const loop = (k, d) => d > 5 || (pm[k] || []).some((x) => x.child_id === id || loop(x.child_id, d + 1));
    if (P.some((x) => loop(x.c, 0))) fail(400, 'loop', 'Состав заготовки ссылается сам на себя');
    await D.batch([D.stmt('DELETE FROM ingredient_parts WHERE parent_id = ?', id), ...P.map((x) => D.stmt('INSERT INTO ingredient_parts (parent_id, child_id, qty_per_1000) VALUES (?,?,?)', id, x.c, x.q))]);
  }
  await refreshComposite(env);
  await audit(env, me.id, old ? 'ingredient.edit' : 'ingredient.create', 'ingredient', id, { name, unit, cost_per_1000_tetri: cost, old: old ? old.cost_per_1000_tetri : null });
  return { id };
});
// Удаление товара из меню. Продавался — скрывается (история продаж и отчёты не ломаются), не продавался — удаляется совсем.
// Его собственная позиция склада (бутылка st_…), если больше нигде не нужна, убирается вместе с ним.
on('POST', '/api/products/:id/delete', 'menu.edit', async ({ env, me, params }) => {
  const D = db(env); const id = String(params.id);
  const p = await D.one('SELECT * FROM products WHERE id = ?', id); if (!p) fail(404, 'not_found', 'Нет такого товара');
  const [sold, rec] = await Promise.all([D.one('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?', id), D.all('SELECT ingredient_id FROM recipes WHERE product_id = ?', id)]);
  if (sold.n) await D.batch([D.stmt('UPDATE products SET active = 0, archived = 1 WHERE id = ?', id), D.stmt('DELETE FROM recipes WHERE product_id = ?', id)]);
  else await D.batch([D.stmt('DELETE FROM recipes WHERE product_id = ?', id), D.stmt('DELETE FROM prices WHERE product_id = ?', id), D.stmt('DELETE FROM products WHERE id = ?', id)]);
  const removedIngs = [];
  for (const r of rec) {
    if (!String(r.ingredient_id).startsWith('st_')) continue;
    const used = await D.one(`SELECT (SELECT COUNT(*) FROM recipes rr JOIN products pp ON pp.id = rr.product_id WHERE rr.ingredient_id = ? AND pp.archived = 0) +
      (SELECT COUNT(*) FROM ingredient_parts WHERE child_id = ?) + (SELECT COUNT(*) FROM products WHERE pack_ing = ? AND archived = 0) AS n`, r.ingredient_id, r.ingredient_id, r.ingredient_id);
    if (used.n) continue;
    const mv = await D.one('SELECT COUNT(*) AS n FROM stock_moves WHERE ingredient_id = ?', r.ingredient_id);
    if (mv.n) await D.run('UPDATE ingredients SET archived = 1 WHERE id = ?', r.ingredient_id); else await D.run('DELETE FROM ingredients WHERE id = ?', r.ingredient_id);
    removedIngs.push(r.ingredient_id);
  }
  await audit(env, me.id, 'product.delete', 'product', id, { name: p.name_ru, archived: !!sold.n, ingredients: removedIngs });
  return { ok: true, archived: !!sold.n, ingredients: removedIngs.length };
});
on('POST', '/api/products', 'menu.edit', async ({ env, me, body }) => {
  const D = db(env);
  const name_ru = String(body.name_ru || '').trim(); if (!name_ru) fail(400, 'no_name', 'Введите название товара');
  if (!(await D.one('SELECT id FROM categories WHERE id = ?', body.category_id))) fail(400, 'bad_category', 'Выберите раздел');
  const old = body.id ? await D.one('SELECT * FROM products WHERE id = ?', body.id) : null;
  const id = old ? old.id : newId('p', body.name_en || name_ru);
  const stmts = [D.stmt(`INSERT INTO products (id, category_id, name_ka, name_en, name_ru, desc_ka, desc_en, desc_ru, size, photo, sort, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name_ka = excluded.name_ka, name_en = excluded.name_en, name_ru = excluded.name_ru,
      desc_ka = excluded.desc_ka, desc_en = excluded.desc_en, desc_ru = excluded.desc_ru, size = excluded.size, photo = excluded.photo, sort = excluded.sort, active = excluded.active`,
    id, body.category_id, String(body.name_ka || name_ru), String(body.name_en || name_ru), name_ru, body.desc_ka ?? null, body.desc_en ?? null, body.desc_ru ?? null,
    body.size ?? null, body.photo ?? null, int((old && (body.sort == null || (body.sort_was != null && Number(body.sort) === Number(body.sort_was)))) ? old.sort : (body.sort ?? 50), 'sort'), body.active === false ? 0 : 1)];
  const priceChanges = [];
  if (body.active !== false && (body.prices?.base == null || body.prices.base === '') && !(old && (await D.one("SELECT 1 AS x FROM prices WHERE product_id = ? AND price_list = 'base'", id)))) fail(400, 'no_price', 'Укажите цену «зал / сайт», чтобы включить товар в продажу');
  for (const pl of ['base', 'wolt', 'glovo', 'bolt']) {
    const v = body.prices?.[pl]; if (v == null || v === '') continue;
    const t = int(v, 'price'); if (t < 0) fail(400, 'bad_price', 'Цена не может быть отрицательной');
    const was = await D.one('SELECT price_tetri FROM prices WHERE product_id = ? AND price_list = ?', id, pl);
    if (!was || was.price_tetri !== t) priceChanges.push({ list: pl, old: was?.price_tetri ?? null, new: t });
    stmts.push(D.stmt('INSERT INTO prices (product_id, price_list, price_tetri) VALUES (?,?,?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri', id, pl, t));
  }
  if ('pack_ing' in body) {
    const pi = body.pack_ing ? String(body.pack_ing) : null;
    if (pi && !(await D.one('SELECT id FROM ingredients WHERE id = ?', pi))) fail(400, 'bad_ingredient', 'Нет такой упаковки на складе');
    stmts.push(D.stmt('UPDATE products SET pack_ing = ?, pack_qty = ?, pack_mode = ? WHERE id = ?', pi, Math.max(1, Math.min(20, Number(body.pack_qty) || 1)), body.pack_mode === 'always' ? 'always' : 'away', id));
  }
  if (Array.isArray(body.recipe)) {
    stmts.push(D.stmt('DELETE FROM recipes WHERE product_id = ?', id));
    const seen = new Set();
    for (const r of body.recipe) {
      const q = int(r.qty, 'qty'); if (q <= 0) fail(400, 'bad_qty', 'Количество ингредиента больше нуля');
      if (seen.has(r.ingredient_id)) fail(400, 'dup_ingredient', 'Ингредиент указан дважды'); seen.add(r.ingredient_id);
      if (!(await D.one('SELECT id FROM ingredients WHERE id = ?', r.ingredient_id))) fail(400, 'bad_ingredient', 'Нет такого ингредиента');
      stmts.push(D.stmt('INSERT INTO recipes (product_id, ingredient_id, qty) VALUES (?,?,?)', id, r.ingredient_id, q));
    }
  }
  await D.batch(stmts);
  await audit(env, me.id, old ? 'product.edit' : 'product.create', 'product', id, { name_ru, category_id: body.category_id, prices: priceChanges, recipe: body.recipe ?? null });
  if (priceChanges.length && old) await notify(env, `Цены «${name_ru}» изменены (${me.name}): ` + priceChanges.map((c) => `${c.list} ${c.old == null ? '—' : (c.old / 100).toFixed(2)} → ${(c.new / 100).toFixed(2)} ₾`).join(', '));
  return { id };
});




// ───────── Финансы: зарплаты с налогами, расходы, P&L, что заполнить ─────────
// Налоги Грузии по умолчанию: подоходный 20%, пенсия 2% работник + 2% работодатель; пенсия работника вычитается из базы подоходного.
const EXP_CATS = ['rent', 'utilities', 'marketing', 'repairs', 'packaging', 'cleaning', 'bank', 'accounting', 'software', 'transport', 'taxes', 'other'];
const monthOf = (s) => { const m = String(s || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(m)) fail(400, 'bad_month', 'Месяц в формате ГГГГ-ММ'); return m; };
const monthDays = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
function payCalc(T, gross, pension) {
  const pe = pension ? Math.round(gross * T.pensionEmp / 100) : 0;
  const base = T.pensionDeductible ? gross - pe : gross;
  const inc = Math.round(base * T.income / 100);
  const per = pension ? Math.round(gross * T.pensionEr / 100) : 0;
  return { gross, pension_emp: pe, income_tax: inc, net: gross - pe - inc, pension_er: per, employer_cost: gross + per };
}
// «Чистыми до пенсии» (как принято в заведении): сумма — уже после подоходного; 2% пенсии вычитается из неё, компания доплачивает свои 2% сверху.
// 1400 ₾ → на руки 1372, пенсия 28 + 28, подоходный 350, начислено 1750, обходится компании 1778.
function payCalcPP(T, amt, pension) {
  // «чистыми, −2% пенсии»: начислено = сумма / 0,8; пенсия 2% работника и 2% компании — от НАЧИСЛЕННОГО (по закону), подоходный 20% — от начисленного минус пенсия
  return payCalc(T, Math.round(amt / (1 - T.income / 100)), pension);
}
function grossFromNet(T, net, pension) { // обратный расчёт «на руки» → начислено
  const k = pension ? (T.pensionDeductible ? (1 - T.pensionEmp / 100) * (1 - T.income / 100) : 1 - T.pensionEmp / 100 - T.income / 100) : 1 - T.income / 100;
  let g = Math.round(net / k); for (let i = 0; i < 5; i++) { const d = net - payCalc(T, g, pension).net; if (!d) break; g += d; } return g;
}
async function payroll(env, month) {
  const S = await getSettings(env); const T = S.tax; const D = db(env);
  // человек считается с месяца начала работы (или с месяца, когда его внесли в систему)
  // всё нужное за месяц — несколькими параллельными запросами, а не по запросу на каждого сотрудника
  // зарплата считается только по факту: с месяца, когда пиццерия реально начала работать (первая продажа или смена в кассе),
  // и не раньше даты начала работы человека. Раньше этого — только то, что внесли вручную (премия, аванс).
  const st = await D.one(`SELECT MIN(d) AS d FROM (SELECT MIN(substr(datetime(p.created_at,'+4 hours'),1,10)) AS d FROM payments p JOIN orders o ON o.id = p.order_id WHERE COALESCE(o.is_test,0) = 0
    UNION ALL SELECT MIN(substr(datetime(opened_at,'+4 hours'),1,10)) FROM shifts WHERE COALESCE(is_test,0) = 0)`);
  const bizStart = (st && st.d) || tbDate(); const early = month < bizStart.slice(0, 7);
  const [people, revRow, tsAll, shAll, salesAll, adjAll, schAll] = await Promise.all([
    D.all(`SELECT * FROM people WHERE (active = 1 AND ? = 0 AND substr(COALESCE(start_date, datetime(created_at,'+4 hours')),1,7) <= ?) OR id IN (SELECT person_id FROM payroll_adj WHERE month = ?) ORDER BY owner DESC, position, name`, early ? 1 : 0, month, month),
    // общий бонус: % от выручки месяца делится поровну между участниками (повара и кассиры)
    D.one(`SELECT COALESCE(SUM(total_tetri),0) AS s FROM sales WHERE strftime('%Y-%m', datetime(created_at,'+4 hours')) = ?`, month),
    D.all('SELECT * FROM timesheet WHERE month = ?', month),
    D.all(`SELECT staff_id, COUNT(DISTINCT date(datetime(opened_at,'+4 hours'))) AS d, COALESCE(SUM((julianday(COALESCE(closed_at, opened_at)) - julianday(opened_at)) * 24), 0) AS h
      FROM shifts WHERE strftime('%Y-%m', datetime(opened_at,'+4 hours')) = ? GROUP BY staff_id`, month),
    D.all(`SELECT staff_id, COALESCE(SUM(total_tetri),0) AS s FROM sales WHERE strftime('%Y-%m', datetime(created_at,'+4 hours')) = ? GROUP BY staff_id`, month),
    D.all('SELECT * FROM payroll_adj WHERE month = ? ORDER BY id', month),
    D.all(`SELECT person_id, COUNT(*) AS n FROM schedule WHERE code = 'W' AND substr(date,1,7) = ? GROUP BY person_id`, month)]);
  const revMonth = revRow.s;
  const tsBy = Object.fromEntries(tsAll.map((r) => [r.person_id, r])), shBy = Object.fromEntries(shAll.map((r) => [r.staff_id, r])), salesBy = Object.fromEntries(salesAll.map((r) => [r.staff_id, r.s]));
  const poolPct = Number((S.pay || {}).poolPct ?? 1); const poolN = people.filter((p) => p.active && p.share_pool).length;
  const pool = Math.round(revMonth * poolPct / 100); const share = poolN ? Math.floor(pool / poolN) : 0;
  const rows = [];
  for (const p of people) {
    const ts = tsBy[p.id];
    let days = null, hours = null, sales = 0;
    if (p.staff_id) {
      const sh = shBy[p.staff_id] || { d: 0, h: 0 };
      days = sh.d; hours = Math.round(sh.h * 10) / 10;
      sales = salesBy[p.staff_id] || 0;
    }
    const sch = schAll.find((x) => x.person_id === p.id); if (sch && !days) days = sch.n; // дни из графика работы, если смен в кассе нет
    if (ts) { if (ts.days != null) days = ts.days; if (ts.hours != null) hours = ts.hours; }
    const adj = adjAll.filter((a) => a.person_id === p.id);
    const sum = (k) => adj.filter((a) => a.kind === k).reduce((x, a) => x + a.amount_tetri, 0);
    const units = p.pay_type === 'day' ? (days || 0) : p.pay_type === 'hour' ? (hours || 0) : 1;
    const baseAmt = early ? 0 : Math.round(p.pay_amount_tetri * (p.pay_type === 'month' ? 1 : units)); // до начала работы пиццерии ставка не начисляется
    const poolShare = p.active && p.share_pool ? share : 0;
    const bonus = sum('bonus') + poolShare, fine = sum('fine'), advance = sum('advance');
    let calc;
    if (p.pay_is_net === 2) calc = payCalcPP(T, Math.max(0, baseAmt + bonus - fine), !!p.pension);
    else if (p.pay_is_net) calc = payCalc(T, grossFromNet(T, Math.max(0, baseAmt + bonus - fine), !!p.pension), !!p.pension);
    else calc = payCalc(T, Math.max(0, baseAmt + bonus - fine), !!p.pension);
    rows.push({ id: p.id, name: p.name, position: p.position, staff_id: p.staff_id, pay_type: p.pay_type, pay_amount_tetri: p.pay_amount_tetri, pay_is_net: p.pay_is_net === 2 ? 2 : (p.pay_is_net ? 1 : 0), pension: !!p.pension, active: !!p.active,
      share_pool: !!p.share_pool, owner: !!p.owner, start_date: p.start_date, pool_share_tetri: poolShare, days, hours, sales_tetri: sales, timesheet_manual: !!ts, base_tetri: baseAmt, bonus_tetri: bonus, fine_tetri: fine, advance_tetri: advance, adj,
      ...calc, to_pay_tetri: calc.net - advance });
  }
  const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
  return { month, tax: T, pool: { pct: poolPct, revenue_tetri: revMonth, pool_tetri: pool, people: poolN, share_tetri: share }, people: rows, totals: { gross: tot('gross'), net: tot('net'), income_tax: tot('income_tax'), pension_emp: tot('pension_emp'), pension_er: tot('pension_er'), employer_cost: tot('employer_cost'), to_pay: tot('to_pay_tetri'), advances: tot('advance_tetri') } };
}
async function materializeRecurring(env, month) {
  const rec = await db(env).all(`SELECT * FROM recurring_expenses WHERE active = 1 AND substr(datetime(created_at,'+4 hours'),1,7) <= ?`, month);
  if (!rec.length) return;
  const have = new Set((await db(env).all('SELECT recurring_id FROM expenses WHERE recurring_id IS NOT NULL AND substr(date,1,7) = ?', month)).map((x) => x.recurring_id));
  for (const r of rec) {
    if (have.has(r.id)) continue;
    const day = String(Math.min(r.day, monthDays(month))).padStart(2, '0');
    if (`${month}-${day}` > tbDate()) continue; // будущие месяцы не заполняем заранее
    await db(env).run('INSERT INTO expenses (date, category, amount_tetri, vat_included, supplier, note, recurring_id) VALUES (?,?,?,?,?,?,?)', `${month}-${day}`, r.category, r.amount_tetri, r.vat_included, r.name, 'ежемесячный', r.id);
  }
}
// ───────── график работы ─────────
// Коды: W — работает, O — выходной, V — отпуск, S — больничный. Правит менеджер или владелец.
const SCH = ['W', 'O', 'V', 'S'];
on('GET', '/api/schedule', 'payroll.manage', async ({ env, url }) => {
  const month = String(url.searchParams.get('month') || tbDate().slice(0, 7)); if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'bad_month', 'Неверный месяц');
  const D = db(env);
  const [people, rows] = await Promise.all([
    D.all('SELECT id, name, position, owner, pay_type FROM people WHERE active = 1 ORDER BY owner DESC, position, name'),
    D.all('SELECT person_id, date, code FROM schedule WHERE substr(date,1,7) = ?', month)]);
  const days = {}; for (const r of rows) (days[r.person_id] ||= {})[r.date] = r.code;
  return { month, days_in_month: monthDays(month), people, days };
});
on('POST', '/api/schedule', 'payroll.manage', async ({ env, me, body }) => {
  const pid = int(body.person_id, 'person_id'); const date = String(body.date || ''); const code = String(body.code || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'bad_date', 'Неверная дата');
  if (code && !SCH.includes(code)) fail(400, 'bad_code', 'Неверная отметка');
  if (!(await db(env).one('SELECT id FROM people WHERE id = ?', pid))) fail(404, 'not_found', 'Нет такого сотрудника');
  if (code) await db(env).run('INSERT INTO schedule (person_id, date, code) VALUES (?,?,?) ON CONFLICT(person_id, date) DO UPDATE SET code = excluded.code', pid, date, code);
  else await db(env).run('DELETE FROM schedule WHERE person_id = ? AND date = ?', pid, date);
  return { ok: true };
});
// заполнить месяц по шаблону: 5/2 (пн–пт), 2/2 (с выбранного дня), каждый день, отпуск с–по, очистить
on('POST', '/api/schedule/fill', 'payroll.manage', async ({ env, me, body }) => {
  const pid = int(body.person_id, 'person_id'); const month = String(body.month || ''); const pat = String(body.pattern || '');
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'bad_month', 'Неверный месяц');
  if (!['5/2', '2/2', '1/1', 'all', 'vac', 'clear'].includes(pat)) fail(400, 'bad_pattern', 'Неверный шаблон');
  const n = monthDays(month); const from = Math.max(1, Math.min(n, Number(body.from) || 1)); const to = Math.max(from, Math.min(n, Number(body.to) || n));
  const D = db(env); const st = [];
  for (let d = from; d <= to; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`; const wd = new Date(date + 'T12:00:00Z').getUTCDay(); const k = d - from;
    let code = '';
    if (pat === '5/2') code = wd === 0 || wd === 6 ? 'O' : 'W';
    if (pat === '2/2') code = k % 4 < 2 ? 'W' : 'O';
    if (pat === '1/1') code = k % 2 === 0 ? 'W' : 'O';
    if (pat === 'all') code = 'W';
    if (pat === 'vac') code = 'V';
    st.push(code ? D.stmt('INSERT INTO schedule (person_id, date, code) VALUES (?,?,?) ON CONFLICT(person_id, date) DO UPDATE SET code = excluded.code', pid, date, code)
      : D.stmt('DELETE FROM schedule WHERE person_id = ? AND date = ?', pid, date));
  }
  await D.batch(st);
  await audit(env, me.id, 'schedule.fill', 'person', String(pid), { month, pattern: pat, from, to });
  return { ok: true };
});
on('GET', '/api/people', 'payroll.manage', async ({ env }) => db(env).all('SELECT * FROM people ORDER BY active DESC, name'));
on('POST', '/api/people', 'payroll.manage', async ({ env, me, body }) => {
  const name = String(body.name || '').trim().slice(0, 80); if (!name) fail(400, 'no_name', 'Введите имя');
  const type = ['month', 'day', 'hour'].includes(body.pay_type) ? body.pay_type : 'month';
  const amt = Math.round(Number(body.pay_amount_tetri) || 0); if (amt < 0) fail(400, 'bad_amount', 'Неверная сумма');
  // связь с PIN кассы: если не задана — ищем сотрудника кассы с тем же именем (для дней и часов из смен)
  let sid = body.staff_id ? int(body.staff_id, 'staff_id') : null;
  if (!sid) { const st = (await db(env).all('SELECT id, name FROM staff WHERE active = 1')).find((x) => x.name.trim().toLowerCase() === name.toLowerCase()); if (st) sid = st.id; }
  const args = [name, String(body.position || '').slice(0, 60) || null, sid, type, amt, Number(body.pay_is_net) === 2 ? 2 : (body.pay_is_net === false || body.pay_is_net === 0 || body.pay_is_net === '0') ? 0 : 1, body.pension === false ? 0 : 1, body.active === false ? 0 : 1, body.start_date || null, body.share_pool ? 1 : 0, body.owner ? 1 : 0];
  let id = body.id ? int(body.id, 'id') : null;
  if (id) await db(env).run('UPDATE people SET name=?, position=?, staff_id=?, pay_type=?, pay_amount_tetri=?, pay_is_net=?, pension=?, active=?, start_date=?, share_pool=?, owner=? WHERE id = ?', ...args, id);
  else id = (await db(env).run('INSERT INTO people (name, position, staff_id, pay_type, pay_amount_tetri, pay_is_net, pension, active, start_date, share_pool, owner) VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...args)).last_row_id;
  await audit(env, me.id, 'people.save', 'people', id, { name, type, amt });
  return { id };
});
on('POST', '/api/timesheet', 'payroll.manage', async ({ env, me, body }) => {
  const month = monthOf(body.month); const pid = int(body.person_id, 'person_id');
  const num = (v) => (v === '' || v == null ? null : Math.max(0, Number(v)));
  await db(env).run('INSERT INTO timesheet (person_id, month, days, hours) VALUES (?,?,?,?) ON CONFLICT(person_id, month) DO UPDATE SET days = excluded.days, hours = excluded.hours', pid, month, num(body.days), num(body.hours));
  await audit(env, me.id, 'timesheet.save', 'people', pid, { month, days: body.days, hours: body.hours });
  return { ok: true };
});
on('POST', '/api/payroll/adj', 'payroll.manage', async ({ env, me, body }) => {
  const month = monthOf(body.month); const pid = int(body.person_id, 'person_id');
  const kind = String(body.kind); if (!['bonus', 'fine', 'advance'].includes(kind)) fail(400, 'bad_kind', 'Тип: премия, штраф или аванс');
  const amt = Math.round(Number(body.amount_tetri)); if (!(amt > 0)) fail(400, 'bad_amount', 'Сумма больше нуля');
  const id = (await db(env).run('INSERT INTO payroll_adj (person_id, month, kind, amount_tetri, note, created_by) VALUES (?,?,?,?,?,?)', pid, month, kind, amt, String(body.note || '').slice(0, 200) || null, me.id)).last_row_id;
  await audit(env, me.id, 'payroll.adj', 'people', pid, { month, kind, amt });
  return { id };
});
on('POST', '/api/payroll/adj/:id/delete', 'payroll.manage', async ({ env, me, params }) => {
  const id = int(params.id, 'id'); const a = await db(env).one('SELECT * FROM payroll_adj WHERE id = ?', id); if (!a) fail(404, 'not_found', 'Не найдено');
  await db(env).run('DELETE FROM payroll_adj WHERE id = ?', id); await audit(env, me.id, 'payroll.adj_delete', 'people', a.person_id, a); return { ok: true };
});
on('GET', '/api/payroll/range', 'payroll.manage', async ({ env, url }) => {
  const f = monthOf(url.searchParams.get('from')), t = monthOf(url.searchParams.get('to')); if (t < f) fail(400, 'bad_month', 'Конец раньше начала');
  const months = monthsBetween(`${f}-01`, `${t}-01`).slice(0, 36); const by = {}; const perMonth = [];
  const prs = await Promise.all(months.map((mo) => payroll(env, mo)));
  for (const [i, mo] of months.entries()) {
    const pr = prs[i]; perMonth.push({ month: mo, ...pr.totals, pool_tetri: pr.pool.pool_tetri, revenue_tetri: pr.pool.revenue_tetri });
    for (const p of pr.people) { const x = by[p.id] = by[p.id] || { id: p.id, name: p.name, position: p.position, gross: 0, net: 0, income_tax: 0, pension: 0, employer_cost: 0, pool: 0, bonus: 0, fine: 0, advance: 0 };
      x.gross += p.gross; x.net += p.net; x.income_tax += p.income_tax; x.pension += p.pension_emp + p.pension_er; x.employer_cost += p.employer_cost; x.pool += p.pool_share_tetri; x.bonus += p.bonus_tetri - p.pool_share_tetri; x.fine += p.fine_tetri; x.advance += p.advance_tetri; }
  }
  return { from: f, to: t, months: perMonth, people: Object.values(by) };
});
on('GET', '/api/payroll', 'payroll.manage', async ({ env, url }) => payroll(env, monthOf(url.searchParams.get('month') || tbDate())));
on('GET', '/api/expenses', 'reports.view', async ({ env, url }) => {
  const q = url.searchParams; let from, to, month = null;
  if (q.get('from')) { from = dateArg(q.get('from'), 'с'); to = dateArg(q.get('to'), 'по'); }
  else { month = monthOf(q.get('month') || tbDate()); from = `${month}-01`; to = `${month}-${String(monthDays(month)).padStart(2, '0')}`; }
  await Promise.all(monthsBetween(from, to).slice(0, 36).map((mo) => materializeRecurring(env, mo)));
  const items = await db(env).all('SELECT * FROM expenses WHERE deleted = 0 AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC', from, to);
  const byCat = {}; for (const e of items) byCat[e.category] = (byCat[e.category] || 0) + e.amount_tetri;
  // зарплаты за эти месяцы (с налогами работодателя) — чтобы видеть полную картину расходов
  const pays = await Promise.all(monthsBetween(from, to).slice(0, 36).map((mo) => payMonth(env, mo)));
  const payroll_tetri = pays.reduce((a, b) => a + b.full, 0), payroll_sofar_tetri = pays.reduce((a, b) => a + b.sofar, 0);
  const pf = await platFeesByMonth(env, from, to); const platform_tetri = Object.values(pf).reduce((a, b) => a + b, 0);
  return { month, from, to, categories: EXP_CATS, items, by_category: byCat, payroll_tetri, payroll_sofar_tetri, platform_tetri,
    recurring: await db(env).all('SELECT * FROM recurring_expenses ORDER BY active DESC, category, name') };
});
on('POST', '/api/expenses', 'settings.edit', async ({ env, me, body }) => {
  const date = String(body.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'bad_date', 'Дата расхода');
  const cat = EXP_CATS.includes(body.category) ? body.category : fail(400, 'bad_category', 'Выберите категорию');
  const amt = Math.round(Number(body.amount_tetri)); if (!(amt > 0)) fail(400, 'bad_amount', 'Сумма больше нуля');
  const args = [date, cat, amt, body.vat_included === false ? 0 : 1, String(body.supplier || '').slice(0, 80) || null, String(body.note || '').slice(0, 200) || null];
  let id = body.id ? int(body.id, 'id') : null;
  if (id) await db(env).run('UPDATE expenses SET date=?, category=?, amount_tetri=?, vat_included=?, supplier=?, note=? WHERE id = ?', ...args, id);
  else id = (await db(env).run('INSERT INTO expenses (date, category, amount_tetri, vat_included, supplier, note, created_by) VALUES (?,?,?,?,?,?,?)', ...args, me.id)).last_row_id;
  await audit(env, me.id, 'expense.save', 'expense', id, { date, cat, amt });
  return { id };
});
on('POST', '/api/expenses/:id/delete', 'settings.edit', async ({ env, me, params }) => {
  const id = int(params.id, 'id'); await db(env).run('UPDATE expenses SET deleted = 1 WHERE id = ?', id); await audit(env, me.id, 'expense.delete', 'expense', id); return { ok: true };
});
on('POST', '/api/recurring', 'settings.edit', async ({ env, me, body }) => {
  const name = String(body.name || '').trim().slice(0, 80); if (!name) fail(400, 'no_name', 'Название расхода');
  const cat = EXP_CATS.includes(body.category) ? body.category : fail(400, 'bad_category', 'Выберите категорию');
  const amt = Math.round(Number(body.amount_tetri)); if (!(amt > 0)) fail(400, 'bad_amount', 'Сумма больше нуля');
  const day = Math.min(28, Math.max(1, int(body.day ?? 1, 'day')));
  const args = [name, cat, amt, body.vat_included === false ? 0 : 1, day, body.active === false ? 0 : 1];
  let id = body.id ? int(body.id, 'id') : null;
  if (id) { await db(env).run('UPDATE recurring_expenses SET name=?, category=?, amount_tetri=?, vat_included=?, day=?, active=? WHERE id = ?', ...args, id);
    // новая сумма — с этого месяца: строка текущего месяца меняется, прошлые месяцы остаются как были
    await db(env).run('UPDATE expenses SET amount_tetri = ?, category = ?, supplier = ?, vat_included = ? WHERE recurring_id = ? AND deleted = 0 AND substr(date,1,7) = ?', amt, cat, name, args[3], id, tbDate().slice(0, 7)); }
  else id = (await db(env).run('INSERT INTO recurring_expenses (name, category, amount_tetri, vat_included, day, active) VALUES (?,?,?,?,?,?)', ...args)).last_row_id;
  await audit(env, me.id, 'recurring.save', 'recurring', id, { name, amt });
  return { id };
});
// P&L за любой период: продажи → без НДС → минус продукты, списания, площадки, зарплаты (пропорционально дням), расходы → прибыль
const DT = (col) => `date(datetime(${col},'+4 hours'))`;
function monthsBetween(from, to) { const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7); const ey = +to.slice(0, 4), em = +to.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } } return out; }
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
async function pnlRange(env, from, to, opts = {}) {
  const D = db(env); const S = await getSettings(env); const T = S.tax; const today = tbDate();
  const vatK = T.vatPayer ? T.vat / (100 + T.vat) : 0;
  const months = monthsBetween(from, to); await Promise.all(months.map((mo) => materializeRecurring(env, mo)));
  const payP = Promise.all(months.map((mo) => payroll(env, mo)));
  const wasteP = D.one(`SELECT COALESCE(SUM(cost_tetri),0) AS c FROM stock_moves WHERE kind = 'writeoff' AND ${DT('created_at')} BETWEEN ? AND ?`, from, to);
  const exP = D.all(`SELECT category, SUM(amount_tetri) AS gross, SUM(CASE WHEN vat_included = 1 THEN amount_tetri ELSE 0 END) AS with_vat FROM expenses WHERE deleted = 0 AND date BETWEEN ? AND ? GROUP BY category`, from, to);
  const settP = opts.sett ? Promise.resolve(opts.sett) : settlementsSummary(env);
  const chansP = D.all('SELECT id, commission_bp FROM channels');
  const [ch, cogsRows, pizRow] = await Promise.all([D.all(`SELECT o.channel, COUNT(*) AS orders, SUM(p.total_tetri) AS total_tetri FROM sales p JOIN orders o ON o.id = p.order_id WHERE ${DT('p.created_at')} BETWEEN ? AND ? GROUP BY o.channel`, from, to),
    D.all(`SELECT o.channel, SUM(oi.qty * oi.unit_cost_tetri) AS c FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id
    WHERE ${DT('p.created_at')} BETWEEN ? AND ? GROUP BY o.channel`, from, to),
    D.one(`SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN products pr ON pr.id = oi.product_id JOIN sales p ON p.order_id = oi.order_id
    WHERE pr.category_id = 'pizza' AND ${DT('p.created_at')} BETWEEN ? AND ?`, from, to)]);
  const cogsBy = Object.fromEntries(cogsRows.map((r) => [r.channel, r.c || 0])); const pizzas = pizRow.n;
  const [sett, chRows, pays, wasteRow, ex] = await Promise.all([settP, chansP, payP, wasteP, exP]);
  const realRate = Object.fromEntries(sett.platforms.map((x) => [x.platform, x.real_rate_pct]));
  const chans = Object.fromEntries(chRows.map((c) => [c.id, c.commission_bp / 100]));
  const channels = ch.map((c) => {
    const rate = PLATS.includes(c.channel) ? (realRate[c.channel] ?? chans[c.channel] ?? 0) : 0;
    const fees = Math.round(c.total_tetri * rate / 100), vat = Math.round(c.total_tetri * vatK), cogs = cogsBy[c.channel] || 0;
    return { channel: c.channel, orders: c.orders, revenue_tetri: c.total_tetri, vat_tetri: vat, net_revenue_tetri: c.total_tetri - vat, cogs_tetri: cogs, platform_fees_tetri: fees, platform_rate_pct: rate,
      contribution_tetri: c.total_tetri - vat - cogs - fees, avg_check_tetri: c.orders ? Math.round(c.total_tetri / c.orders) : 0 };
  });
  const sum = (k) => channels.reduce((a, c) => a + c[k], 0);
  const waste = wasteRow.c;
  // зарплаты: месячные начисления пропорционально дням периода в каждом месяце
  const prT = { gross: 0, net: 0, income_tax: 0, pension_emp: 0, pension_er: 0, employer_cost: 0, to_pay: 0, advances: 0, pool: 0 };
  for (const [i, mo] of months.entries()) {
    const md = monthDays(mo), ms = `${mo}-01`, me = `${mo}-${String(md).padStart(2, '0')}`;
    const a0 = from > ms ? from : ms; let b0 = to < me ? to : me; if (b0 > today) b0 = today; // зарплата набегает по дням — вперёд не считаем
    const ov = b0 < a0 ? 0 : dayDiff(a0, b0); const k = Math.min(1, Math.max(0, ov / md));
    const pr = pays[i];
    for (const key of ['gross', 'net', 'income_tax', 'pension_emp', 'pension_er', 'employer_cost', 'to_pay', 'advances']) prT[key] += Math.round(pr.totals[key] * k);
    prT.pool += Math.round(pr.pool.pool_tetri * k);
  }
  const expenses = ex.map((e) => { const vatIn = T.vatPayer ? Math.round(e.with_vat * T.vat / (100 + T.vat)) : 0; return { category: e.category, gross_tetri: e.gross, vat_in_tetri: vatIn, net_tetri: e.gross - vatIn }; });
  const expNet = expenses.reduce((a, e) => a + e.net_tetri, 0);
  const rev = sum('revenue_tetri'), netRev = sum('net_revenue_tetri'), cogs = sum('cogs_tetri'), fees = sum('platform_fees_tetri');
  const labor = prT.employer_cost;
  const gross = netRev - cogs - waste - fees;
  const ebit = gross - labor - expNet;
  const lastDay = to > today ? today : to; const days = Math.max(1, dayDiff(from, lastDay < from ? from : lastDay)); const fullDays = dayDiff(from, to);
  const fixed = labor + expNet, varRate = netRev ? (cogs + waste + fees) / netRev : 0.35;
  const breakevenNet = varRate < 1 ? Math.round(fixed / (1 - varRate)) : null;
  const pct = (a) => (netRev ? Math.round(a * 1000 / netRev) / 10 : 0);
  const k = { food_cost_pct: pct(cogs), waste_pct: pct(waste), labor_pct: pct(labor), platform_pct: pct(fees), rent_pct: pct((expenses.find((e) => e.category === 'rent') || {}).net_tetri || 0), profit_pct: pct(ebit) };
  const F = [];
  if (k.food_cost_pct > 35) F.push(['bad', `Себестоимость продуктов ${k.food_cost_pct}% — выше нормы для пиццерии (28–32%). Проверьте граммовки, цены поставщиков и списания.`, `პროდუქტების თვითღირებულება ${k.food_cost_pct}% — პიცერიის ნორმაზე მაღალია (28–32%). შეამოწმეთ გრამაჟი, მომწოდებლების ფასები და ჩამოწერები.`, 'food']);
  else if (cogs && k.food_cost_pct < 20) F.push(['warn', `Себестоимость ${k.food_cost_pct}% — подозрительно низкая: возможно, не у всех позиций внесены рецепты.`, `თვითღირებულება ${k.food_cost_pct}% — საეჭვოდ დაბალია: შესაძლოა ყველა პოზიციას რეცეპტი არ აქვს.`, 'foodlow']);
  if (k.labor_pct > 32) F.push(['bad', `Зарплаты с налогами — ${k.labor_pct}% выручки (норма 25–30%). Сравните выручку на час работы сотрудников в разделе «Зарплаты».`, `ხელფასები გადასახადებით — ამონაგების ${k.labor_pct}% (ნორმა 25–30%). შეადარეთ თანამშრომლების სამუშაო საათები განყოფილებაში „ხელფასები“.`, 'labor']);
  if (k.rent_pct > 12) F.push(['warn', `Аренда — ${k.rent_pct}% выручки (норма до 10%).`, `იჯარა — ამონაგების ${k.rent_pct}% (ნორმა 10%-მდე).`, 'rent']);
  for (const c of channels) if (PLATS.includes(c.channel) && c.platform_rate_pct > 30) F.push(['bad', `${c.channel === 'glovo' ? 'Glovo' : 'Wolt'} забирает ${c.platform_rate_pct}% — каждый заказ через сайт вместо площадки экономит столько же.`, `${c.channel === 'glovo' ? 'Glovo' : 'Wolt'} იღებს ${c.platform_rate_pct}%-ს — ყოველი შეკვეთა საიტით პლატფორმის ნაცვლად ამდენს ზოგავს.`, 'plat_' + c.channel]);
  if (waste && k.waste_pct > 3) F.push(['warn', `Списания ${k.waste_pct}% выручки — выше 3%. Посмотрите причины в «Склад → история».`, `ჩამოწერები ამონაგების ${k.waste_pct}% — 3%-ზე მეტი. მიზეზები ნახეთ „საწყობში“.`, 'waste']);
  if (!labor) F.push(['warn', 'Зарплаты за период не внесены — прибыль завышена. Заполните раздел «Зарплаты».', 'ხელფასები პერიოდისთვის შეტანილი არ არის — მოგება გაზრდილია. შეავსეთ „ხელფასები“.', 'nolabor']);
  if (!expNet) F.push(['warn', 'Расходы за период не внесены (аренда, свет, газ…) — прибыль завышена.', 'ხარჯები პერიოდისთვის შეტანილი არ არის (იჯარა, დენი, გაზი…) — მოგება გაზრდილია.', 'noexp']);
  if (ebit < 0) { const be = breakevenNet ? (breakevenNet / (1 - vatK) / 100 / fullDays).toFixed(0) : '—'; F.push(['bad', `Период в минусе на ${(ebit / -100).toFixed(2)} ₾. Для безубыточности нужно ≈${be} ₾ продаж в день.`, `პერიოდი მინუსშია ${(ebit / -100).toFixed(2)} ₾-ით. უზარალობისთვის საჭიროა ≈${be} ₾ გაყიდვა დღეში.`, 'loss']); }
  const partial = to > today && from <= today;
  return { from, to, days_in_period: days, vat_payer: !!T.vatPayer, channels, totals: { orders: sum('orders'), revenue_tetri: rev, vat_tetri: sum('vat_tetri'), net_revenue_tetri: netRev, cogs_tetri: cogs, waste_tetri: waste,
      platform_fees_tetri: fees, gross_profit_tetri: gross, labor_tetri: labor, expenses_tetri: expNet, profit_tetri: ebit, pizzas, avg_check_tetri: sum('orders') ? Math.round(rev / sum('orders')) : 0,
      profit_per_pizza_tetri: pizzas ? Math.round(ebit / pizzas) : 0, breakeven_net_tetri: breakevenNet, breakeven_per_day_tetri: breakevenNet ? Math.round(breakevenNet / (1 - vatK) / fullDays) : null,
      revenue_per_day_tetri: Math.round(rev / days),
      forecast_profit_tetri: partial ? Math.round(gross * fullDays / days - labor - expNet) : ebit, partial }, payroll: prT, expenses, kpi: k, findings: F };
}
async function pnl(env, month) { const md = String(monthDays(month)).padStart(2, '0'); const r = await pnlRange(env, `${month}-01`, `${month}-${md}`); r.month = month; return r; }
const dateArg = (v, k) => { const s = String(v || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(400, 'bad_date', 'Дата ' + k); return s; };
on('GET', '/api/pnl', 'reports.view', async ({ env, url }) => {
  const q = url.searchParams;
  if (q.get('from')) { const f = dateArg(q.get('from'), 'с'), t = dateArg(q.get('to'), 'по'); if (t < f) fail(400, 'bad_date', 'Конец раньше начала'); if (dayDiff(f, t) > 800) fail(400, 'bad_date', 'Слишком длинный период'); return pnlRange(env, f, t); }
  return pnl(env, monthOf(q.get('month') || tbDate()));
});
// Помесячная таблица за год
// Расходы по месяцам за год: категории + зарплаты + итог
/* зарплата месяца с налогами — для текущего месяца только за прошедшие дни, будущие месяцы = 0 */
/* зарплата месяца с налогами — ровно та же сумма, что «Обходится компании» в «Зарплатах»; будущие месяцы = 0; sofar — сколько набежало по сегодня */
async function payMonth(env, mo) { const t = tbDate(); if (`${mo}-01` > t) return { full: 0, sofar: 0 }; const full = await payroll(env, mo).then((x) => x.totals.employer_cost || 0).catch(() => 0);
  return { full, sofar: mo === t.slice(0, 7) ? Math.round((full * Number(t.slice(8, 10))) / monthDays(mo)) : full }; }
/* сколько забрали Wolt / Glovo по месяцам (по реальной комиссии из их инвойсов, иначе — из настроек) */
async function platFeesByMonth(env, from, to) {
  const [sett, rows, chs] = await Promise.all([settlementsSummary(env), db(env).all(`SELECT substr(${DT('p.created_at')},1,7) AS mo, o.channel, SUM(p.total_tetri) AS s FROM sales p JOIN orders o ON o.id = p.order_id
    WHERE o.channel IN ('wolt','glovo','bolt') AND ${DT('p.created_at')} BETWEEN ? AND ? GROUP BY mo, o.channel`, from, to), db(env).all('SELECT id, commission_bp FROM channels')]);
  const real = Object.fromEntries(sett.platforms.map((x) => [x.platform, x.real_rate_pct])); const cfg = Object.fromEntries(chs.map((c) => [c.id, c.commission_bp / 100]));
  const out = {}; for (const r of rows) { const rate = real[r.channel] ?? cfg[r.channel] ?? 0; out[r.mo] = (out[r.mo] || 0) + Math.round((r.s * rate) / 100); } return out;
}
on('GET', '/api/expenses/months', 'reports.view', async ({ env, url }) => {
  const y = Number(url.searchParams.get('year')) || Number(tbDate().slice(0, 4)); const cur = tbDate().slice(0, 7);
  const mos = []; for (let m = 1; m <= 12; m++) { const mo = `${y}-${String(m).padStart(2, '0')}`; if (mo > cur) break; mos.push(mo); }
  await Promise.all(mos.map((mo) => materializeRecurring(env, mo)));
  const ex = await db(env).all(`SELECT substr(date,1,7) AS mo, category, SUM(amount_tetri) AS s FROM expenses WHERE deleted = 0 AND substr(date,1,4) = ? GROUP BY mo, category`, String(y));
  const [pays, pf] = await Promise.all([Promise.all(mos.map((mo) => payMonth(env, mo).then((x) => x.full))), platFeesByMonth(env, `${y}-01-01`, `${y}-12-31`)]);
  const months = mos.map((mo, i) => { const cats = {}; ex.filter((r) => r.mo === mo).forEach((r) => { cats[r.category] = r.s; });
    const other = Object.values(cats).reduce((a, b) => a + b, 0); const plat = pf[mo] || 0; return { month: mo, cats, payroll_tetri: pays[i], platform_tetri: plat, total_tetri: other + pays[i] + plat }; });
  return { year: y, months };
});
on('GET', '/api/pnl/months', 'reports.view', async ({ env, url }) => {
  const y = Number(url.searchParams.get('year')) || Number(tbDate().slice(0, 4)); const cur = tbDate().slice(0, 7);
  const sett = await settlementsSummary(env); const rows = [];
  const mos = []; for (let m = 1; m <= 12; m++) { const mo = `${y}-${String(m).padStart(2, '0')}`; if (mo > cur) break; mos.push(mo); }
  const res = await Promise.all(mos.map((mo) => pnlRange(env, `${mo}-01`, `${mo}-${String(monthDays(mo)).padStart(2, '0')}`, { sett })));
  mos.forEach((mo, i) => rows.push({ month: mo, ...res[i].totals, kpi: res[i].kpi }));
  const tot = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  return { year: y, months: rows, totals: { revenue_tetri: tot('revenue_tetri'), net_revenue_tetri: tot('net_revenue_tetri'), cogs_tetri: tot('cogs_tetri'), waste_tetri: tot('waste_tetri'), platform_fees_tetri: tot('platform_fees_tetri'), labor_tetri: tot('labor_tetri'), expenses_tetri: tot('expenses_tetri'), profit_tetri: tot('profit_tetri'), orders: tot('orders') } };
});
// Что ещё не заполнено, чтобы цифры были точными
on('GET', '/api/setup-check', 'reports.view', async ({ env }) => {
  const D = db(env); const out = [];
  await Promise.all([ // все проверки разом; дальше они берутся из кэша запроса
    D.all('SELECT name FROM ingredients WHERE cost_per_1000_tetri <= 0'), D.one('SELECT COUNT(*) AS n FROM people WHERE active = 1'), D.one('SELECT COUNT(*) AS n FROM recurring_expenses WHERE active = 1'),
    D.one(`SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'inventory'`), D.one(`SELECT MAX(period_to) AS d FROM platform_invoices`)]);
  const noRec = await D.all(`SELECT p.name_ru FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.soon = 0 AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.product_id = p.id)`);
  if (noRec.length) out.push({ key: 'recipes', tab: 'menu', n: noRec.length, ru: `У ${noRec.length} позиций нет рецепта/себестоимости: ${noRec.slice(0, 6).map((x) => x.name_ru).join(', ')}${noRec.length > 6 ? '…' : ''}`, ka: `${noRec.length} პოზიციას არ აქვს რეცეპტი` });
  const noPrice = await D.all('SELECT name FROM ingredients WHERE cost_per_1000_tetri <= 0');
  if (noPrice.length) out.push({ key: 'ing', tab: 'ingredients', n: noPrice.length, ru: `У ${noPrice.length} ингредиентов нет цены: ${noPrice.slice(0, 6).map((x) => x.name).join(', ')}`, ka: `${noPrice.length} ინგრედიენტს არ აქვს ფასი` });
  if (!(await D.one('SELECT COUNT(*) AS n FROM people WHERE active = 1')).n) out.push({ key: 'people', tab: 'payroll', ru: 'Не внесены сотрудники и зарплаты', ka: 'თანამშრომლები და ხელფასები არ არის შეყვანილი' });
  if (!(await D.one('SELECT COUNT(*) AS n FROM recurring_expenses WHERE active = 1')).n) out.push({ key: 'recurring', tab: 'expenses', ru: 'Не внесены ежемесячные расходы: аренда, свет, газ, вода, интернет, бухгалтер', ka: 'ყოველთვიური ხარჯები არ არის შეყვანილი' });
  if (!(await D.one(`SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'inventory'`)).n) out.push({ key: 'inventory', tab: 'stock', ru: 'Не было ни одной инвентаризации — внесите фактические остатки склада', ka: 'ინვენტარიზაცია არ ჩატარებულა' });
  const lastInv = await D.one(`SELECT MAX(period_to) AS d FROM platform_invoices`);
  const platOrders = (await D.one(`SELECT COUNT(*) AS n FROM orders WHERE channel IN ('wolt','glovo','bolt') AND created_at > datetime('now','-30 days')`)).n;
  if (platOrders && (!lastInv.d || lastInv.d < new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10))) out.push({ key: 'settle', tab: 'settle', ru: 'Нет свежих инвойсов Wolt/Glovo — внесите, чтобы видеть долг и реальную комиссию', ka: 'Wolt/Glovo-ს ინვოისები არ არის' });
  return out;
});

// ───────── Расчёты с площадками и долги по переводам ─────────
// Площадка присылает инвойс за период: продажи, скидка партнёра, услуги площадки с НДС, штрафы/компенсации → к выплате.
// Система сверяет их продажи с нашими заказами за те же дни и считает долг, включая ещё не выставленные периоды.
const PLATS = ['wolt', 'glovo', 'bolt'];
const TB = (d) => `date(datetime(o.created_at, '+4 hours'))`;
async function ourPlatformSales(env, platform, from, to) {
  return db(env).one(`SELECT COUNT(*) AS orders, COALESCE(SUM(p.subtotal_tetri),0) AS menu_tetri, COALESCE(SUM(p.total_tetri),0) AS net_tetri
    FROM orders o JOIN sales p ON p.order_id = o.id WHERE o.channel = ? AND ${TB()} BETWEEN ? AND ?`, platform, from, to);
}
async function settlementsSummary(env) {
  const recP = db(env).all(`SELECT r.*, o.id AS order_no FROM receivables r JOIN orders o ON o.id = r.order_id ORDER BY (r.received_at IS NOT NULL), r.created_at DESC LIMIT 300`);
  const per = await Promise.all(PLATS.map(async (pl) => { // площадки параллельно
    const inv = await db(env).all('SELECT i.*, f.name AS file_name, f.size AS file_size FROM platform_invoices i LEFT JOIN invoice_files f ON f.invoice_id = i.id WHERE i.platform = ? ORDER BY i.period_from DESC', pl);
    const ours = await Promise.all(inv.map((i) => ourPlatformSales(env, pl, i.period_from, i.period_to)));
    for (const [k, i] of inv.entries()) {
      i.ours = ours[k];
      const theirNet = i.gross_tetri - i.partner_disc_tetri;
      i.diff_tetri = theirNet - i.ours.net_tetri; // > 0 — у площадки продаж больше, чем пробито у нас (кассир забыл?)
      i.cost_pct = theirNet ? Math.round((i.fees_tetri - i.adj_tetri) * 1000 / theirNet) / 10 : 0;
      i.owed_tetri = i.paid_at ? 0 : i.payout_tetri;
      i.paid_diff_tetri = i.paid_at ? (i.paid_tetri || 0) - i.payout_tetri : null;
    }
    const net = inv.reduce((a, i) => a + i.gross_tetri - i.partner_disc_tetri, 0), fees = inv.reduce((a, i) => a + i.fees_tetri - i.adj_tetri, 0);
    const ch = await db(env).one('SELECT commission_bp FROM channels WHERE id = ?', pl);
    const rate = net > 0 ? fees / net : (ch ? ch.commission_bp / 10000 : 0);
    const last = inv.length ? inv.map((i) => i.period_to).sort().pop() : '2000-01-01';
    const pend = await db(env).one(`SELECT COUNT(*) AS orders, COALESCE(SUM(p.total_tetri),0) AS net_tetri FROM orders o JOIN sales p ON p.order_id = o.id WHERE o.channel = ? AND ${TB()} > ?`, pl, last);
    const pendingPayout = Math.round(pend.net_tetri * (1 - rate));
    const invoiced = inv.reduce((a, i) => a + i.owed_tetri, 0);
    if (!inv.length && !pend.orders) return null;
    return ({ platform: pl, invoices: inv, real_rate_pct: Math.round(rate * 1000) / 10, setting_rate_pct: ch ? ch.commission_bp / 100 : 0,
      invoiced_owed_tetri: invoiced, not_invoiced: { since: last === '2000-01-01' ? null : last, orders: pend.orders, net_tetri: pend.net_tetri, expected_payout_tetri: pendingPayout },
      total_owed_tetri: invoiced + pendingPayout });
  }));
  const out = per.filter(Boolean); const rec = await recP;
  return { platforms: out, receivables: rec, receivables_owed_tetri: rec.filter((r) => !r.received_at).reduce((a, r) => a + r.amount_tetri, 0) };
}
on('GET', '/api/settlements', 'reports.view', async ({ env }) => settlementsSummary(env));
on('POST', '/api/settlements', 'settings.edit', async ({ env, me, body }) => {
  const pl = String(body.platform || ''); if (!PLATS.includes(pl)) fail(400, 'bad_platform', 'Площадка: wolt, glovo, bolt');
  const d = (x, k) => { const v = String(x || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(400, 'bad_date', 'Неверная дата: ' + k); return v; };
  const from = d(body.period_from, 'с'), to = d(body.period_to, 'по'); if (to < from) fail(400, 'bad_date', 'Конец периода раньше начала');
  const m = (k) => Math.round(Number(body[k] || 0));
  const gross = m('gross_tetri'), disc = m('partner_disc_tetri'), fees = m('fees_tetri'), adj = m('adj_tetri');
  if (gross <= 0) fail(400, 'bad_amount', 'Введите сумму продаж из инвойса');
  if (fees < 0 || disc < 0) fail(400, 'bad_amount', 'Суммы не могут быть отрицательными');
  const payout = body.payout_tetri != null && body.payout_tetri !== '' ? m('payout_tetri') : gross - disc - fees + adj;
  const args = [pl, from, to, String(body.invoice_no || '').slice(0, 60) || null, gross, disc, fees, adj, payout, body.due_date || null, String(body.note || '').slice(0, 300) || null];
  let id = body.id ? int(body.id, 'id') : null;
  if (id) await db(env).run('UPDATE platform_invoices SET platform=?, period_from=?, period_to=?, invoice_no=?, gross_tetri=?, partner_disc_tetri=?, fees_tetri=?, adj_tetri=?, payout_tetri=?, due_date=?, note=? WHERE id = ?', ...args, id);
  else id = (await db(env).run('INSERT INTO platform_invoices (platform, period_from, period_to, invoice_no, gross_tetri, partner_disc_tetri, fees_tetri, adj_tetri, payout_tetri, due_date, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ...args, me.id)).last_row_id;
  await audit(env, me.id, 'settlement.save', 'platform_invoice', id, { pl, from, to, gross, fees, payout });
  const ours = await ourPlatformSales(env, pl, from, to); const diff = gross - disc - ours.net_tetri;
  if (Math.abs(diff) >= 500) await notify(env, `Сверка ${pl}: по инвойсу продажи ${((gross - disc) / 100).toFixed(2)} ₾, у нас пробито ${(ours.net_tetri / 100).toFixed(2)} ₾ за ${from}–${to}. Разница ${(diff / 100).toFixed(2)} ₾`);
  return { id, payout_tetri: payout, ours, diff_tetri: diff };
});
// документ к инвойсу Wolt / Glovo (PDF или фото, до 1,5 МБ) — хранится в базе, скачивается из админки
on('POST', '/api/settlements/:id/file', 'settings.edit', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); if (!(await db(env).one('SELECT id FROM platform_invoices WHERE id = ?', id))) fail(404, 'not_found', 'Инвойс не найден');
  const b64 = String(body.b64 || '').replace(/^data:[^,]*,/, ''); const size = Math.floor(b64.length * 3 / 4);
  if (!size) fail(400, 'no_file', 'Выберите файл'); if (size > 1572864) fail(400, 'too_big', 'Файл больше 1,5 МБ — сохраните PDF поменьше или сфотографируйте');
  const mime = String(body.mime || 'application/octet-stream').slice(0, 80); if (!/^(application\/pdf|image\/(png|jpeg|webp)|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/csv)$/.test(mime)) fail(400, 'bad_type', 'Подходят PDF, фото, Excel или CSV');
  const name = String(body.name || 'invoice').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  await db(env).run(`INSERT INTO invoice_files (invoice_id, name, mime, b64, size, created_by) VALUES (?,?,?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET name = excluded.name, mime = excluded.mime, b64 = excluded.b64, size = excluded.size, created_by = excluded.created_by, created_at = datetime('now')`, id, name, mime, b64, size, me.id);
  await audit(env, me.id, 'settlement.file', 'platform_invoice', id, { name, size });
  return { ok: true, name, size };
});
on('GET', '/api/settlements/:id/file', 'reports.view', async ({ env, params }) => {
  const f = await db(env).one('SELECT name, mime, b64, size FROM invoice_files WHERE invoice_id = ?', int(params.id, 'id')); if (!f) fail(404, 'not_found', 'Документа нет'); return f;
});
on('POST', '/api/settlements/:id/paid', 'settings.edit', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); const i = await db(env).one('SELECT * FROM platform_invoices WHERE id = ?', id); if (!i) fail(404, 'not_found', 'Инвойс не найден');
  const amt = Math.round(Number(body.paid_tetri)); if (!(amt >= 0)) fail(400, 'bad_amount', 'Введите полученную сумму');
  const date = String(body.paid_at || tbDate()); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'bad_date', 'Неверная дата');
  await db(env).run('UPDATE platform_invoices SET paid_tetri = ?, paid_at = ? WHERE id = ?', amt, date, id);
  await audit(env, me.id, 'settlement.paid', 'platform_invoice', id, { amt, expected: i.payout_tetri });
  if (amt !== i.payout_tetri) await notify(env, `${i.platform}: пришло ${(amt / 100).toFixed(2)} ₾, а по инвойсу ${(i.payout_tetri / 100).toFixed(2)} ₾ (разница ${((amt - i.payout_tetri) / 100).toFixed(2)} ₾)`);
  return { ok: true, diff_tetri: amt - i.payout_tetri };
});
on('POST', '/api/settlements/apply-rate', 'settings.edit', async ({ env, me, body }) => {
  const pl = String(body.platform || ''); if (!PLATS.includes(pl)) fail(400, 'bad_platform', 'Площадка не найдена');
  const S = (await settlementsSummary(env)).platforms.find((x) => x.platform === pl); if (!S || !S.invoices.length) fail(409, 'no_invoices', 'Сначала внесите хотя бы один инвойс');
  const bp = Math.round(S.real_rate_pct * 100); if (bp < 0 || bp > 6000) fail(400, 'bad_commission', 'Странная комиссия — проверьте инвойсы');
  await db(env).run('UPDATE channels SET commission_bp = ? WHERE id = ?', bp, pl);
  await audit(env, me.id, 'settlement.apply_rate', 'channel', pl, { bp });
  return { ok: true, commission_pct: bp / 100 };
});
on('POST', '/api/receivables/:id/received', 'settings.edit', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); const r = await db(env).one('SELECT * FROM receivables WHERE order_id = ?', id); if (!r) fail(404, 'not_found', 'Долг не найден');
  if (r.received_at) fail(409, 'already', 'Уже отмечено');
  const amt = Math.round(Number(body.received_tetri ?? r.amount_tetri));
  await db(env).run('UPDATE receivables SET received_tetri = ?, received_at = ?, received_by = ? WHERE order_id = ?', amt, String(body.received_at || tbDate()), me.id, id);
  await audit(env, me.id, 'receivable.received', 'order', id, { amt, expected: r.amount_tetri });
  return { ok: true };
});

// ───────── Комбо ─────────
// Слот комбо: { ka, en, ru, cat: 'pizza' } или { ..., ids: ['cola', ...] }; extra: доплата за дорогие позиции (тетри).
// Комбо только в своих каналах: на Wolt/Glovo уже скидка 20% и комиссия — второй скидки не даём.
const COMBO_CHANNELS = ['hall', 'takeaway', 'delivery', 'site', 'pickup'];
const COMBO_EST = 3500; // если у позиции нет рецепта, считаем себестоимость осторожно: 35% цены
async function productCosts(env) {
  const rows = await db(env).all(`SELECT p.id, COALESCE((SELECT SUM(r.qty * i.cost_per_1000_tetri) / 1000 FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.product_id = p.id), 0) AS cost,
    (SELECT price_tetri FROM prices WHERE product_id = p.id AND price_list = 'base') AS base FROM products p`);
  return Object.fromEntries(rows.map((r) => [r.id, { cost: Math.round(r.cost), base: r.base || 0, est: !r.cost }]));
}
const costOf = (c) => (c ? (c.est ? Math.round(c.base * COMBO_EST / 10000) : c.cost) : 0);
async function comboOptions(env, slot) {
  const rows = slot.ids && slot.ids.length
    ? await db(env).all(`SELECT p.id, p.category_id, p.name_ru, p.name_ka, p.name_en, p.in_stock, c.age18 FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1 AND c.soon = 0 AND p.id IN (${slot.ids.map(() => '?').join(',')}) ORDER BY p.sort`, ...slot.ids)
    : await db(env).all(`SELECT p.id, p.category_id, p.name_ru, p.name_ka, p.name_en, p.in_stock, c.age18 FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1 AND c.soon = 0 AND p.category_id = ? ORDER BY p.sort`, String(slot.cat || ''));
  return rows.map((r) => Object.assign(r, { extra: Math.max(0, Math.round(Number((slot.extra || {})[r.id]) || 0)) }));
}
async function loadCombo(env, id, onlyActive = true) {
  const c = await db(env).one(`SELECT * FROM combos WHERE id = ?${onlyActive ? ' AND active = 1' : ''}`, String(id || ''));
  if (c && onlyActive && c.grp !== 'party' && ((await getSettings(env)).combo || {}).on === false) fail(409, 'combo_off', 'Комбо сейчас не продаются');
  if (!c) fail(404, 'no_combo', 'Комбо не найдено');
  c.slots = JSON.parse(c.slots || '[]'); return c;
}
// Разбить цену комбо по позициям пропорционально обычным ценам: склад, кухня и отчёты видят настоящие пиццы
async function comboLines(env, combo, picks, channel) {
  if (!COMBO_CHANNELS.includes(channel)) fail(409, 'combo_channel', 'Комбо — только в зале, на сайте и при своей доставке');
  if (!Array.isArray(picks) || picks.length !== combo.slots.length) fail(400, 'combo_picks', 'Выберите позицию в каждом пункте комбо');
  const costs = await productCosts(env); const lines = []; let total = combo.price_tetri;
  for (let k = 0; k < combo.slots.length; k++) {
    const opt = (await comboOptions(env, combo.slots[k])).find((o) => o.id === picks[k]);
    if (!opt) fail(400, 'combo_pick', 'Эта позиция не входит в комбо');
    if (!opt.in_stock) fail(409, 'stopped', 'Позиция в стоп-листе');
    total += opt.extra; lines.push({ product_id: opt.id, w: (costs[opt.id] && costs[opt.id].base) || 1 });
  }
  const W = lines.reduce((s, l) => s + l.w, 0); let left = total;
  lines.forEach((l, i) => { l.price = i === lines.length - 1 ? left : Math.round(total * l.w / W); left -= l.price; });
  return { total, lines };
}
// Худший случай: самые дорогие по себестоимости позиции в каждом слоте
// ───────── «Для компании»: наборы от 5 пицц + 5 Coca-Cola, общая скидка включается/выключается в админке ─────────
// Обычные комбо — только конкретный состав (без выбора), минимум 2 пиццы, без кофе; пиво только Heineken и Corona.
// num — номер для кассы и сотрудников («комбо №3»); наборы «Для компании» продолжают нумерацию.
const COMBO_SETS = [ // v11: сначала по 2 пиццы, потом по 3, потом 5, 8 и 10 — всё в одном разделе «Комбо»
  { id: 'student', num: 1, ru: 'Студент', ka: 'სტუდენტი', en: 'Student', items: ['marg', 'pep', 'cola', 'sprite'], photo: '/img/cmb-student-v6-600.webp' },
  { id: 'duo', num: 2, ru: 'Дуэт', ka: 'დუეტი', en: 'Duet', items: ['hawaii', 'ranch', 'icetea_peach', 'icetea_mango'], photo: '/img/cmb-duo-v6-600.webp' },
  { id: 'chicken', num: 3, ru: 'Чикен', ka: 'ჩიქენი', en: 'Chicken', items: ['chbbq', 'ranch', 'sprite', 'sprite'], photo: '/img/cmb-chicken-v6-600.webp' },
  { id: 'cheese', num: 4, ru: 'Чиз', ka: 'ჩიზი', en: 'Cheese', items: ['five', 'carb', 'sprite', 'icetea_lemon'], photo: '/img/cmb-cheese-v6-600.webp' },
  { id: 'burgershow', num: 5, ru: 'Бургер', ka: 'ბურგერი', en: 'Burger', items: ['burger', 'pep', 'cola', 'cola'], photo: '/img/cmb-burgershow-v6-600.webp' },
  { id: 'fire', num: 6, ru: 'Огонь 18+', ka: 'ცეცხლი 18+', en: 'Fire 18+', items: ['diablo', 'chorizo', 'corona', 'corona'], photo: '/img/cmb-fire-v6-600.webp' },
  { id: 'prem2', num: 7, ru: 'Премиум', ka: 'პრემიუმი', en: 'Premium', items: ['premium', 'salmon', 'limon_fresh', 'icetea_berry'], photo: '/img/cmb-prem2-v6-600.webp' },
  { id: 'kids', num: 8, ru: 'Детский — не острый', ka: 'საბავშვო — არაცხარე', en: 'Kids — not spicy', items: ['marg', 'hawaii', 'five', 'fanta', 'cappy_orange', 'icetea_peach'], photo: '/img/cmb-kids-v7-600.webp' },
  { id: 'friday', num: 9, ru: 'Фиеста', ka: 'ფიესტა', en: 'Fiesta', items: ['pep', 'bbq', 'diablo', 'cola', 'cola', 'sprite'], photo: '/img/cmb-friday-v7-600.webp' },
  { id: 'sunday', num: 10, ru: 'Семейный', ka: 'საოჯახო', en: 'Family', items: ['marg', 'carb', 'five', 'cola', 'cola', 'sprite'], photo: '/img/cmb-sunday-v6-600.webp' },
  { id: 'meat2', num: 11, ru: 'Мясной', ka: 'ხორციანი', en: 'Meat lovers', items: ['bbq', 'burger', 'chbbq', 'cola', 'pepsi', 'sprite'], photo: '/img/cmb-meat2-v6-600.webp' },
  { id: 'evening', num: 12, ru: 'Футбол 18+', ka: 'ფეხბურთი 18+', en: 'Football 18+', items: ['pep', 'pepgrill', 'ranch', 'heineken', 'heineken', 'heineken'], photo: '/img/cmb-evening-v7-600.webp' },
  { id: 'party-classic', num: 13, big: 5, ru: 'Пати — 5 пицц', ka: 'პარტი — 5 პიცა', en: 'Party — 5 pizzas', items: ['marg', 'pep', 'hawaii', 'chbbq', 'bbq', 'cola', 'cola', 'fanta', 'sprite', 'icetea_peach'], photo: '/img/party-classic-v6-600.webp' },
  { id: 'party-office', num: 14, big: 8, ru: 'Офис — 8 пицц', ka: 'ოფისი — 8 პიცა', en: 'Office — 8 pizzas', items: ['marg', 'pep', 'pepgrill', 'hawaii', 'five', 'carb', 'ranch', 'chbbq', 'cola', 'cola', 'cola', 'sprite', 'sprite', 'fanta', 'icetea_lemon', 'icetea_lemon'], photo: '/img/party-office-v6-600.webp' },
  { id: 'party-big', num: 15, big: 10, ru: 'Мега — 10 пицц', ka: 'მეგა — 10 პიცა', en: 'Mega — 10 pizzas', items: ['marg', 'pep', 'pepgrill', 'chorizo', 'hawaii', 'bbq', 'chbbq', 'ranch', 'five', 'premium', 'cola', 'cola', 'cola', 'cola', 'fanta', 'fanta', 'sprite', 'sprite', 'icetea_peach', 'icetea_peach'], photo: '/img/party-big-v6-600.webp' },
];
// Цены наборов: одинаковая прибыль, поэтому скидки разные (дорогие в себестоимости — меньше, выгодные — больше), в среднем = pct
async function balancedPrices(env, lists, pct) {
  const costs = await productCosts(env);
  const rows = lists.map((ids) => ({ L: ids.reduce((a, id) => a + ((costs[id] && costs[id].base) || 0), 0), C: ids.reduce((a, id) => a + costOf(costs[id]), 0) }));
  const ok = rows.filter((r) => r.L > 0 && r.C > 0); const mean = ok.length ? ok.reduce((a, r) => a + r.C / r.L, 0) / ok.length : 0;
  const k = mean ? (1 - pct / 100) / mean : 0;
  return rows.map((r) => { let d = r.L && r.C && k ? 1 - (r.C * k) / r.L : pct / 100;
    d = Math.min(Math.max(d, Math.max(0.03, pct / 100 - 0.03)), Math.min(0.3, pct / 100 + 0.03));
    return { list: r.L, cost: r.C, price: Math.round(r.L * (1 - d) / 100) * 100 }; });
}

const PIZZA_IDS = new Set(['carb', 'pep', 'pepgrill', 'chorizo', 'diablo', 'marg', 'hawaii', 'bbq', 'chbbq', 'ranch', 'five', 'premium', 'salmon', 'burger']);
function setDesc(nm, ids, l) { const k = 'name_' + l; const N = (id) => (nm[id] && (nm[id][k] || nm[id].name_ru)) || id;
  const pz = ids.filter((id) => PIZZA_IDS.has(id)).map(N); const cnt = {}; ids.filter((id) => !PIZZA_IDS.has(id)).forEach((id) => { cnt[id] = (cnt[id] || 0) + 1; });
  return pz.join(', ') + ' + ' + Object.entries(cnt).map(([id, n]) => (n > 1 ? n + ' × ' : '') + N(id)).join(', '); }
async function seedComboSets(env) { // один раз: заменить старые комбо «на выбор» конкретными
  const D = db(env); const v = await D.one(`SELECT value FROM settings WHERE key = 'combos_v'`).catch(() => null); if (v && Number(v.value) >= 12) return;
  const ids = [...new Set(COMBO_SETS.flatMap((c) => c.items))];
  const nm = Object.fromEntries((await D.all(`SELECT id, name_ru, name_ka, name_en FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((x) => [x.id, x]));
  if (Object.keys(nm).length < ids.length) return; // меню ещё не загружено
  const st = []; const BP = await balancedPrices(env, COMBO_SETS.map((c) => c.items), 10);
  for (const [ci, c] of COMBO_SETS.entries()) {
    const slots = c.items.map((id) => ({ ka: nm[id].name_ka || nm[id].name_ru, en: nm[id].name_en || nm[id].name_ru, ru: nm[id].name_ru, ids: [id], extra: {} }));
    const pr = BP[ci];
    st.push(D.stmt(`INSERT INTO combos (id, name_ru, name_ka, name_en, desc_ru, desc_ka, desc_en, price_tetri, photo, slots, active, sort, grp) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,'combo')
      ON CONFLICT(id) DO UPDATE SET name_ru = excluded.name_ru, name_ka = excluded.name_ka, name_en = excluded.name_en, desc_ru = excluded.desc_ru, desc_ka = excluded.desc_ka, desc_en = excluded.desc_en,
        price_tetri = excluded.price_tetri, photo = excluded.photo, slots = excluded.slots, active = 1, sort = excluded.sort, grp = 'combo'`,
      c.id, '№' + c.num + ' ' + c.ru, '№' + c.num + ' ' + c.ka, '№' + c.num + ' ' + c.en, setDesc(nm, c.items, 'ru'), setDesc(nm, c.items, 'ka'), setDesc(nm, c.items, 'en'), pr.price, c.photo, JSON.stringify(slots), c.num));
  }
  st.push(D.stmt(`UPDATE combos SET active = 0 WHERE id NOT IN (${COMBO_SETS.map(() => '?').join(',')})`, ...COMBO_SETS.map((c) => c.id))); // старые комбо и отдельные «Для компании» — выключены
  st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('combos_v', '12') ON CONFLICT(key) DO UPDATE SET value = '12'`));
  await D.batch(st);
}
const PHOTO_B = ['beer-argo', 'beer-corona', 'beer-estrella', 'beer-heineken', 'beer-lowenbrau', 'beer-staropramen', 'coffee-americano', 'coffee-cappuccino', 'coffee-espresso', 'coffee-latte', 'drink-bakhmaro', 'drink-borjomi', 'drink-burakhi', 'drink-cappy_apple', 'drink-cappy_berry', 'drink-cappy_cherry', 'drink-cappy_grapefruit', 'drink-cappy_orange', 'drink-cappy_peach', 'drink-cola', 'drink-fanta', 'drink-icetea_berry', 'drink-icetea_lemon', 'drink-icetea_mango', 'drink-icetea_peach', 'drink-juice-apple', 'drink-juice-cherry', 'drink-juice-orange', 'drink-limon_fresh', 'drink-pepsi', 'drink-sprite', 'drink-water', 'drink-zero', 'pizza-bbq', 'pizza-burger', 'pizza-carb', 'pizza-chbbq', 'pizza-diablo', 'pizza-five', 'pizza-hawaii', 'pizza-marg', 'pizza-pep', 'pizza-pepgrill', 'pizza-premium', 'pizza-ranch', 'pizza-salmon', 'tea-berry', 'tea-black', 'tea-green', 'wine-khikhvi', 'wine-krakhuna', 'wine-rkatsiteli', 'wine-tsolikauri']; // фото на общем коричневом фоне
const partyIds = (p) => [...p.pizzas, ...(p.drinks || Array(p.n).fill(p.drink))];
const PARTY_SETS = []; // отдельного раздела «Для компании» больше нет: большие наборы — это комбо №8–10
async function partyConf(env) { const r = await db(env).one(`SELECT value FROM settings WHERE key = 'party'`).catch(() => null); return Object.assign({ on: false, pct: 10 }, r ? JSON.parse(r.value) : {}); }
async function partyPrice(env, ids, pct) {
  const u = [...new Set(ids)]; const rows = await db(env).all(`SELECT product_id, price_tetri FROM prices WHERE price_list = 'base' AND product_id IN (${u.map(() => '?').join(',')})`, ...u);
  const by = Object.fromEntries(rows.map((r) => [r.product_id, r.price_tetri])); const list = ids.reduce((a, id) => a + (by[id] || 0), 0);
  return { list, price: Math.round(list * (100 - pct) / 100 / 100) * 100, missing: ids.filter((id) => !by[id]) };
}
async function seedPartySets(env) {
  const D = db(env);
  const have = new Set((await D.all(`SELECT id FROM combos WHERE grp = 'party'`)).map((x) => x.id));
  if (!PARTY_SETS.length || PARTY_SETS.every((p) => have.has(p.id))) return; // всё уже создано — ничего не делаем
  const c = await partyConf(env);
  for (const p of PARTY_SETS) {
    if (have.has(p.id)) continue;
    const ids = partyIds(p);
    const names = await D.all(`SELECT id, name_ru, name_ka, name_en FROM products WHERE id IN (${[...new Set(ids)].map(() => '?').join(',')})`, ...new Set(ids));
    if (names.length < new Set(ids).size) continue; // нет какой-то позиции в меню — набор не создаём
    const nm = Object.fromEntries(names.map((x) => [x.id, x]));
    const slots = ids.map((id) => ({ ka: nm[id].name_ka || nm[id].name_ru, en: nm[id].name_en || nm[id].name_ru, ru: nm[id].name_ru, ids: [id], extra: {} }));
    const pr = (await balancedPrices(env, PARTY_SETS.map(partyIds), c.pct))[PARTY_SETS.indexOf(p)];
    const d = (l) => partyDesc(nm, p, l);
    await D.run(`INSERT OR IGNORE INTO combos (id, name_ru, name_ka, name_en, desc_ru, desc_ka, desc_en, price_tetri, photo, slots, active, sort, grp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'party')`,
      p.id, '№' + p.num + ' ' + p.ru, '№' + p.num + ' ' + p.ka, '№' + p.num + ' ' + p.en, d('ru'), d('ka'), d('en'), pr.price, p.photo, JSON.stringify(slots), c.on ? 1 : 0, p.sort);
  }
}
function partyDesc(nm, p, l) { return setDesc(nm, partyIds(p), l); }
async function partyDescUpdate(env) { // состав в описании: конкретные пиццы (обновляется при каждом сохранении)
  const D = db(env); const ids = [...new Set(PARTY_SETS.flatMap(partyIds))]; if (!ids.length) return;
  const nm = Object.fromEntries((await D.all(`SELECT id, name_ru, name_ka, name_en FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((x) => [x.id, x]));
  const slotsOf = (p) => JSON.stringify(partyIds(p).map((id) => ({ ka: (nm[id] || {}).name_ka || (nm[id] || {}).name_ru || id, en: (nm[id] || {}).name_en || (nm[id] || {}).name_ru || id, ru: (nm[id] || {}).name_ru || id, ids: [id], extra: {} })));
  const st = []; // все обновления одним пакетом — один поход в базу вместо двадцати
  if (Object.keys(nm).length === ids.length) for (const p of PARTY_SETS) st.push(D.stmt('UPDATE combos SET slots = ? WHERE id = ?', slotsOf(p), p.id));
  for (const p of PARTY_SETS) st.push(D.stmt('UPDATE combos SET name_ru = ?, name_ka = ?, name_en = ?, desc_ru = ?, desc_ka = ?, desc_en = ?, sort = ?, photo = CASE WHEN photo LIKE \'/img/party-%\' THEN ? ELSE photo END WHERE id = ?', '№' + p.num + ' ' + p.ru, '№' + p.num + ' ' + p.ka, '№' + p.num + ' ' + p.en, partyDesc(nm, p, 'ru'), partyDesc(nm, p, 'ka'), partyDesc(nm, p, 'en'), p.num, p.photo, p.id));
  if (st.length) await D.batch(st);
}
async function partyState(env) {
  const c = await partyConf(env); const sets = await db(env).all(`SELECT * FROM combos WHERE grp = 'party' ORDER BY sort, id`);
  const out = await Promise.all(sets.map(async (s0) => { const ids = JSON.parse(s0.slots || '[]').map((x) => (x.ids || [])[0]).filter(Boolean);
    const [pr, m] = await Promise.all([partyPrice(env, ids, 0), comboMargin(env, { id: s0.id, price_tetri: s0.price_tetri, slots: JSON.parse(s0.slots || '[]') })]);
    return { id: s0.id, name_ru: s0.name_ru, name_ka: s0.name_ka, desc_ru: s0.desc_ru, desc_ka: s0.desc_ka, active: !!s0.active, price_tetri: s0.price_tetri, list_tetri: pr.list, margin_pct: m && m.ok ? m.min_margin_pct : null }; }));
  return Object.assign({}, c, { sets: out });
}
on('POST', '/api/combos/switch', 'settings.edit', async ({ env, me, body }) => { // общий выключатель «Комбо» (сайт + касса)
  const S = await getSettings(env); const c = Object.assign({}, S.combo || {}, { on: !!body.on });
  await db(env).run(`INSERT INTO settings (key, value) VALUES ('combo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(c));
  await audit(env, me.id, c.on ? 'combo.on' : 'combo.off', 'settings', 'combo', {});
  await notify(env, c.on ? `🍕 Комбо включены на сайте и в кассе (${me.name})` : `⏸ Комбо выключены на сайте и в кассе (${me.name})`);
  return { ok: true, on: c.on };
});
on('GET', '/api/party', 'menu.edit', async ({ env }) => { await seedPartySets(env); await partyDescUpdate(env); return partyState(env); });
on('POST', '/api/party', 'settings.edit', async ({ env, me, body }) => {
  const pct = Math.round(Number(body.pct)); if (!(pct >= 0 && pct <= 30)) fail(400, 'bad_pct', 'Скидка от 0 до 30%');
  const on = !!body.on; const D = db(env);
  await D.run(`INSERT INTO settings (key, value) VALUES ('party', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ on, pct }));
  await seedPartySets(env);
  await partyDescUpdate(env);
  const rows = await D.all(`SELECT id, slots FROM combos WHERE grp = 'party' ORDER BY sort, id`);
  const BP = await balancedPrices(env, rows.map((s0) => JSON.parse(s0.slots || '[]').map((x) => (x.ids || [])[0]).filter(Boolean)), pct);
  for (const [i, s0] of rows.entries()) await D.run('UPDATE combos SET price_tetri = ?, active = ? WHERE id = ?', BP[i].price, on ? 1 : 0, s0.id);
  await partyDescUpdate(env);
  await audit(env, me.id, on ? 'party.on' : 'party.off', 'settings', 'party', { pct });
  await notify(env, on ? `🎉 «Для компании» включено: скидка ${pct}% (${me.name})` : `⏸ «Для компании» выключено (${me.name})`);
  return partyState(env);
});

async function comboMargin(env, combo) {
  const costs = await productCosts(env); let price = combo.price_tetri, cost = 0, est = false, minPct = Infinity, worst = null;
  const per = [];
  per.push(...(await Promise.all(combo.slots.map((sl) => comboOptions(env, sl)))).map((opts) => opts.map((o) => ({ id: o.id, extra: o.extra, cost: costOf(costs[o.id]), est: !!(costs[o.id] && costs[o.id].est) }))));
  if (per.some((o) => !o.length)) return { ok: false, empty: true, min_margin_pct: 0 };
  // перебор по слотам независимо: минимальная маржа = max(cost - extra) в каждом слоте
  const pick = per.map((opts) => opts.reduce((a, b) => (b.cost - b.extra > a.cost - a.extra ? b : a)));
  price += pick.reduce((s, o) => s + o.extra, 0); cost = pick.reduce((s, o) => s + o.cost, 0); est = per.some((opts) => opts.some((o) => o.est));
  minPct = price ? Math.round((price - cost) * 1000 / price) / 10 : 0;
  const listPrice = pick.reduce((s, o) => s + ((costs[o.id] && costs[o.id].base) || 0), 0);
  return { ok: true, price_tetri: price, cost_tetri: cost, profit_tetri: price - cost, min_margin_pct: minPct, cost_estimated: est, list_price_tetri: listPrice, saving_tetri: listPrice - price };
}
async function comboMinMargin(env) { const S = await getSettings(env); return Number((S.combo || {}).minMargin ?? 50); }
async function publicCombos(env, opts = {}) {
  const out = [];
  const [combos0, costs, S] = await Promise.all([db(env).all('SELECT * FROM combos WHERE active = 1 ORDER BY sort, id'), productCosts(env), getSettings(env)]);
  const off = (S.combo || {}).on === false; // «Комбо» выключены: на сайте они видны с надписью «Временно недоступно», заказать нельзя
  const combos = off && !opts.showPaused ? combos0.filter((c) => c.grp === 'party') : combos0;
  const optCache = {}; const optsFor = (s) => (optCache[JSON.stringify([s.ids, s.cat])] ||= comboOptions(env, s));
  const allSlots = combos.flatMap((c) => JSON.parse(c.slots || '[]')); await Promise.all(allSlots.map(optsFor));
  for (const c of combos) {
    const slots = JSON.parse(c.slots || '[]'); const sl = []; let age18 = false, ok = true, list = 0;
    for (const s of slots) {
      const opts = (await optsFor(s)).filter((o) => o.in_stock);
      if (!opts.length) { ok = false; break; }
      if (opts.some((o) => o.age18)) age18 = true;
      list += Math.min(...opts.map((o) => (costs[o.id] && costs[o.id].base) || 0));
      sl.push({ ka: s.ka, en: s.en, ru: s.ru, options: opts.map((o) => ({ id: o.id, ka: o.name_ka, en: o.name_en, ru: o.name_ru, extra: o.extra })) });
    }
    if (ok) out.push({ id: c.id, name_ka: c.name_ka, name_en: c.name_en, name_ru: c.name_ru, desc_ka: c.desc_ka, desc_en: c.desc_en, desc_ru: c.desc_ru,
      price_tetri: c.price_tetri, old_price_tetri: Math.max(list, c.price_tetri), photo: c.photo, age18, slots: sl, grp: c.grp || 'combo', paused: off && c.grp !== 'party' });
  }
  return out;
}
on('GET', '/api/public/combos', null, async ({ env }) => publicCombos(env));
on('GET', '/api/combos', 'menu.read', async ({ env, me }) => {
  const rows = await db(env).all('SELECT * FROM combos ORDER BY sort, id'); const min = await comboMinMargin(env);
  await Promise.all(rows.map(async (r) => { // все комбо параллельно, а не по очереди
    r.slots = JSON.parse(r.slots || '[]');
    await Promise.all(r.slots.map(async (s) => { s.options = (await comboOptions(env, s)).map((o) => ({ id: o.id, name_ru: o.name_ru, name_ka: o.name_ka, extra: o.extra, in_stock: o.in_stock })); }));
    if (can(me, 'menu.edit')) r.margin = await comboMargin(env, r);
  }));
  const S = await getSettings(env); const pc = await partyConf(env);
  return { combos: rows, min_margin_pct: min, combos_on: (S.combo || {}).on !== false, party_on: !!pc.on };
});
on('POST', '/api/combos', 'menu.edit', async ({ env, me, body }) => {
  const name = String(body.name_ru || '').trim(); if (!name) fail(400, 'no_name', 'Введите название комбо');
  const price = int(body.price_tetri, 'price_tetri'); if (price < 100) fail(400, 'bad_price', 'Цена комбо слишком маленькая');
  const slots = (Array.isArray(body.slots) ? body.slots : []).slice(0, 8).map((s) => ({ ka: String(s.ka || s.ru || '').slice(0, 60), en: String(s.en || s.ru || '').slice(0, 60), ru: String(s.ru || '').slice(0, 60),
    ...(Array.isArray(s.ids) && s.ids.length ? { ids: s.ids.map(String).slice(0, 60) } : { cat: String(s.cat || '') }),
    extra: Object.fromEntries(Object.entries(s.extra || {}).map(([k, v]) => [String(k), Math.max(0, Math.round(Number(v) || 0))])) }));
  if (slots.length < 2) fail(400, 'few_slots', 'В комбо должно быть минимум 2 позиции');
  if (body.active !== false && slots.some((s0) => !s0.ids || s0.ids.length !== 1)) fail(400, 'combo_fixed', 'В комбо — только конкретные позиции: в каждом пункте выберите одну пиццу или один напиток');
  const id = String(body.id || '').trim() || 'combo-' + randomHex(3);
  const draft = { id, price_tetri: price, slots };
  const m = await comboMargin(env, draft); const min = await comboMinMargin(env);
  if (!m.ok) fail(400, 'combo_empty', 'В одном из пунктов нет доступных позиций');
  if (m.min_margin_pct < min && body.active !== false) fail(409, 'low_margin', `Прибыль комбо ${m.min_margin_pct}% — ниже порога ${min}%. Поднимите цену или добавьте доплату за дорогие позиции.`);
  await db(env).run(`INSERT INTO combos (id, name_ru, name_ka, name_en, desc_ru, desc_ka, desc_en, price_tetri, photo, slots, active, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name_ru = excluded.name_ru, name_ka = excluded.name_ka, name_en = excluded.name_en, desc_ru = excluded.desc_ru, desc_ka = excluded.desc_ka, desc_en = excluded.desc_en,
      price_tetri = excluded.price_tetri, photo = excluded.photo, slots = excluded.slots, active = excluded.active, sort = excluded.sort`,
    id, name, body.name_ka || name, body.name_en || name, body.desc_ru || null, body.desc_ka || null, body.desc_en || null, price, body.photo || null, JSON.stringify(slots), body.active === false ? 0 : 1, int(body.sort ?? 50, 'sort'));
  await audit(env, me.id, 'combo.save', 'combo', id, { price, margin: m.min_margin_pct });
  return { id, margin: m };
});
// Касса: добавить комбо в заказ
on('POST', '/api/orders/:id/combo', 'order.edit', async ({ env, me, params, body }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  const combo = await loadCombo(env, body.combo_id); const q = await comboLines(env, combo, body.picks, o.channel);
  const n = (await db(env).one('SELECT COALESCE(MAX(combo_n),0) + 1 AS n FROM order_items WHERE order_id = ?', o.id)).n;
  await db(env).batch(q.lines.map((l) => db(env).stmt('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri, added_by, combo_id, combo_n) VALUES (?,?,1,?,?,?,?)', o.id, l.product_id, l.price, me.id, combo.id, n)));
  await audit(env, me.id, 'order.add_combo', 'order', o.id, { combo: combo.id, picks: body.picks, total: q.total });
  return loadOrder(env, o.id);
});

// ───────── Заказы с сайта ─────────
// Часы работы по Тбилиси (UTC+4); если закрытие после полуночи — тоже работает
function isOpenNow(open, close) {
  const n = new Date(Date.now() + 4 * 3600e3), m = n.getUTCHours() * 60 + n.getUTCMinutes();
  const p = (x) => { const a = String(x || '0:0').split(':'); return (+a[0]) * 60 + (+a[1] || 0); };
  const o = p(open), c = p(close); if (o === c) return true;
  return c > o ? (m >= o && m < c) : (m >= o || m < c);
}
const SITE_MAX_PER_10MIN = 4;
// Заказ ко времени: клиент выбирает «сегодня 17:00» / «завтра 12:30» (время Батуми). Проверяем: не раньше чем через 30/45 мин, не позже 2 суток, в часы работы.
function wantAt(S, raw, delivery) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(raw || '').trim()); if (!m) fail(400, 'bad_time', 'Выберите время заказа');
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 4 * 3600e3;
  if (utc < Date.now() + (delivery ? 45 : 30) * 60e3 - 60e3) fail(400, 'too_soon', `Ко времени — не раньше чем через ${delivery ? 45 : 30} минут`);
  if (utc > Date.now() + 2 * 864e5) fail(400, 'too_far', 'Заказ ко времени — максимум на завтра');
  const p = (x) => { const a = String(x || '0:0').split(':'); return (+a[0]) * 60 + (+a[1] || 0); };
  const o = p(S.info.open), c = p(S.info.close), t = (+m[4]) * 60 + (+m[5]);
  const ok = o === c || (c > o ? (t >= o + 15 && t <= c - 15) : (t >= o + 15 || t <= c - 15));
  if (!ok) fail(400, 'bad_time', `Выберите время в часы работы: ${S.info.open}–${S.info.close}`);
  return { utc: new Date(utc).toISOString().slice(0, 19).replace('T', ' '), hm: m[4] + ':' + m[5], day: m[1] + '-' + m[2] + '-' + m[3] };
}
on('POST', '/api/public/order', null, async ({ env, body, request }) => {
  const D = db(env); const S = await getSettings(env);
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const recent = await D.one(`SELECT COUNT(*) AS n FROM orders WHERE channel = 'site' AND source_ip = ? AND created_at > datetime('now','-10 minutes')`, ip);
  if (recent.n >= SITE_MAX_PER_10MIN) fail(429, 'too_many', 'Слишком много заказов подряд. Позвоните нам: ' + S.info.phone);
  // защита от ботов: скрытое поле-ловушка (человек его не видит и не заполняет) и время на сайте до заказа
  if (body.website || body.hp) { await audit(env, null, 'site.bot', 'ip', ip, { why: 'honeypot' }); fail(400, 'bad_input', 'Проверьте данные заказа'); }
  const el = Number(body.el); if (Number.isFinite(el) && el >= 0 && el < 2500) { await audit(env, null, 'site.bot', 'ip', ip, { why: 'too_fast', el }); fail(400, 'too_fast', 'Слишком быстро — проверьте заказ и нажмите ещё раз'); }
  if (!Number.isFinite(el) && recent.n >= 1) fail(429, 'too_many', 'Обновите страницу pizzaroom.ge и оформите заказ ещё раз');
  if (!Array.isArray(body.items) && body.items != null) fail(400, 'bad_input', 'Корзина пустая');
  const online = body.pay === 'online';
  if (online) { const gw = await payGw(env); if (!gw.on || !gwReady(gw)) fail(409, 'no_online', 'Онлайн-оплата сейчас недоступна — выберите оплату при получении'); }
  const delivery0 = body.mode === 'delivery';
  const want = body.at ? wantAt(S, body.at, delivery0) : null;
  if (!want && !isOpenNow(S.info.open, S.info.close)) fail(409, 'closed', `Сейчас закрыто. Работаем ${S.info.open}–${S.info.close}`);
  const name = String(body.name || '').trim().slice(0, 60); if (!name) fail(400, 'no_name', 'Введите имя');
  const phone = String(body.phone || '').replace(/[^\d+]/g, ''); const digits = phone.replace(/\D/g, '').replace(/^995/, '');
  if (!/^5\d{8}$/.test(digits)) fail(400, 'bad_phone', 'Проверьте номер: 9 цифр, начинается с 5');
  // один номер — не больше 3 непринятых заказов за 30 минут; всего не больше 25 непринятых за 10 минут (волна фальшивых заказов)
  const byPhone = await D.one(`SELECT COUNT(*) AS n FROM orders WHERE channel = 'site' AND customer_phone = ? AND accepted_at IS NULL AND status != 'cancelled' AND created_at > datetime('now','-30 minutes')`, '+995' + digits);
  if (byPhone.n >= 3) fail(429, 'too_many', 'С этого номера уже есть заказы, которые ждут кассира. Позвоните нам: ' + S.info.phone);
  const wave = await D.one(`SELECT COUNT(*) AS n FROM orders WHERE channel = 'site' AND accepted_at IS NULL AND status != 'cancelled' AND created_at > datetime('now','-10 minutes')`);
  if (wave.n >= 25) { const k = await D.one(`SELECT value FROM settings WHERE key = 'bot_wave'`); if (!k || Date.parse(JSON.parse(k.value).at) < Date.now() - 3600e3) { await D.run(`INSERT INTO settings (key, value) VALUES ('bot_wave', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ at: new Date().toISOString() })); await notify(env, '⚠️ Подозрительно много новых заказов с сайта за 10 минут (25+), касса их не принимает. Возможно, это боты — проверьте кассу. Приём с сайта временно ограничен.'); }
    fail(429, 'too_many', 'Сейчас очень много заказов. Позвоните нам: ' + S.info.phone); }
  const delivery = body.mode === 'delivery';
  if (delivery && dpauseNow(S)) fail(409, 'delivery_paused', 'Доставка временно недоступна — оформите самовывоз из Batumi Mall');
  let fee = 0, zoneName = null, zoneKa = null;
  if (delivery) {
    const z = S.delivery.zones.find((x) => x.id === body.zone); if (!z) fail(400, 'bad_zone', 'Выберите зону доставки');
    fee = Math.round(Number(z.fee) * 100); zoneName = z.ru; zoneKa = z.ka || z.ru;
    if (String(body.address || '').trim().length < 4) fail(400, 'no_address', 'Введите адрес');
  }
  const items = (body.items || []).filter((it) => it && it.qty > 0);
  const combosIn = (Array.isArray(body.combos) ? body.combos : []).slice(0, 10);
  if ((!items.length && !combosIn.length) || items.length > 40) fail(400, 'empty', 'Корзина пустая');
  const comboRows = [];
  for (const [k, cb] of combosIn.entries()) { const combo = await loadCombo(env, cb.combo_id); const q = await comboLines(env, combo, cb.picks, 'site'); q.lines.forEach((l) => comboRows.push({ ...l, combo_id: combo.id, n: k + 1 })); }
  const priced = [];
  for (const it of items) { const q = int(it.qty, 'qty'); if (q > 20) fail(400, 'bad_qty', 'Слишком большое количество'); priced.push({ id: it.product_id, qty: q, price: await priceFor(env, it.product_id, 'site') }); }
  const token = randomHex(12);
  const lat = Number(body.lat), lng = Number(body.lng);
  // касса и кухня — на грузинском
  const todayL = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const wantKa = want ? '⏰ ' + (want.day === todayL ? '' : 'ხვალ ') + want.hm : null;
  const note = [wantKa, delivery ? 'მიტანა' : 'გატანა', zoneKa, String(body.address || '').slice(0, 160), String(body.comment || '').slice(0, 200), online ? '💳 ონლაინ გადახდა' : body.pay === 'card' ? 'ბარათით' : 'ნაღდი ფულით'].filter(Boolean).join(' · ');
  const m = await D.run(`INSERT INTO orders (channel, external_id, customer_phone, customer_name, address, note, delivery_fee_tetri, track_token, source_ip, mode, pay_on, lat, lng, lang)
    VALUES ('site', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'S-' + token.slice(0, 6).toUpperCase(), '+995' + digits, name, String(body.address || '').slice(0, 160) || null, note, fee, token, ip,
    delivery ? 'delivery' : 'pickup', online ? 'online' : body.pay === 'card' ? 'card' : 'cash', Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, ['ka', 'en', 'ru'].includes(body.lang) ? body.lang : 'ka');
  const id = m.last_row_id;
  if (want) await D.run('UPDATE orders SET want_at = ? WHERE id = ?', want.utc, id);
  if (online) await D.run(`UPDATE orders SET pay_state = 'pending' WHERE id = ?`, id);
  if (await testMode(env)) await D.run('UPDATE orders SET is_test = 1 WHERE id = ?', id);
  const promo = await activePromo(env, 'site');
  await D.batch([...priced.map((p) => D.stmt('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri) VALUES (?,?,?,?)', id, p.id, p.qty, p.price)), ...comboRows.map((l) => D.stmt('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri, combo_id, combo_n) VALUES (?,?,1,?,?,?)', id, l.product_id, l.price, l.combo_id, l.n)), ...(promo ? [D.stmt('UPDATE orders SET promo_id = ? WHERE id = ?', promo.id, id)] : [])]);
  await audit(env, null, 'site.order', 'order', id, { items: priced, combos: combosIn, fee, ip });
  const o = await loadOrder(env, id);
  if (online) { // сначала оплата в банке; касса и Telegram узнают о заказе только после подтверждения оплаты
    try { const r = await payStart(env, request, { orderId: id, amount: o.total_tetri, lang: o.lang, desc: 'Pizza Room order ' + id, back: '/?paid=' + token.slice(0, 8) });
      return { id, token, total_tetri: o.total_tetri, pay_url: r.url };
    } catch (e) {
      await D.run(`UPDATE orders SET pay_state = 'failed', status = 'cancelled', cancelled_at = ?, cancel_reason = 'Онлайн-оплата: банк не открыл оплату' WHERE id = ?`, isoNow(), id);
      console.error('pay_start', e && e.message); fail(502, 'pay_failed', 'Не удалось открыть оплату картой. Попробуйте ещё раз или выберите оплату при получении');
    }
  }
  await notify(env, `Новый заказ с сайта №${id}: ${(o.total_tetri / 100).toFixed(2)} ₾, ${name}, ${'+995' + digits}${want ? ' · ⏰ КО ВРЕМЕНИ: ' + (want.day === todayL ? 'сегодня ' : 'завтра ') + want.hm : ''}`);
  return { id, token, total_tetri: o.total_tetri };
});
// «Мой заказ» с другого телефона или после очистки браузера: телефон + номер заказа (за последние 2 суток)
on('POST', '/api/public/order/find', null, async ({ env, body, request }) => {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const tries = await db(env).one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.find' AND entity_id = ? AND ts > datetime('now','-10 minutes')`, ip);
  if (tries.n >= 8) fail(429, 'too_many', 'Слишком много попыток. Попробуйте через 10 минут или позвоните нам');
  await audit(env, null, 'site.find', 'ip', ip);
  const digits = String(body.phone || '').replace(/\D/g, '').replace(/^995/, ''); const id = Number(String(body.id || '').replace(/\D/g, ''));
  if (!/^5\d{8}$/.test(digits)) fail(400, 'bad_input', 'Проверьте телефон: 9 цифр, начинается с 5');
  // номер заказа помнят не все — тогда телефон + имя, на которое заказывали (первые 3 буквы, без учёта регистра)
  const nm = String(body.name || '').trim().toLowerCase().slice(0, 3);
  if (!id && nm.length < 2) fail(400, 'bad_input', 'Введите номер заказа или имя, на которое заказывали');
  const o = id
    ? await db(env).one(`SELECT id, track_token, mode FROM orders WHERE id = ? AND channel = 'site' AND customer_phone = ? AND created_at > datetime('now','-2 days')`, id, '+995' + digits)
    : (await db(env).all(`SELECT id, track_token, mode, customer_name FROM orders WHERE channel = 'site' AND customer_phone = ? AND created_at > datetime('now','-2 days') ORDER BY id DESC LIMIT 20`, '+995' + digits))
        .find((r) => String(r.customer_name || '').trim().toLowerCase().slice(0, nm.length) === nm); // сравнение в JS — работает и для кириллицы
  if (!o) fail(404, 'not_found', id ? 'Заказ не найден — проверьте телефон и номер заказа' : 'Заказ не найден — проверьте телефон и имя');
  return { id: o.id, token: o.track_token, mode: o.mode };
});
on('GET', '/api/public/order/:token', null, async ({ env, params }) => {
  const tok = String(params.token || ''); if (tok.length < 16 || tok.length > 80) fail(404, 'not_found', 'Заказ не найден');
  const o = await db(env).one('SELECT * FROM orders WHERE track_token = ?', tok);
  if (!o) fail(404, 'not_found', 'Заказ не найден');
  // ссылка на заказ действует 3 дня после заказа (для заказа ко времени — сутки после выбранного времени), потом закрывается
  const base = Math.max(Date.parse(o.created_at.replace(' ', 'T') + 'Z') + 2 * 864e5, o.want_at ? Date.parse(o.want_at.replace(' ', 'T') + 'Z') : 0) + 864e5;
  if (Date.now() > base) fail(404, 'expired', 'Срок просмотра заказа закончился');
  let opay = o.pay_on === 'online' ? await db(env).one(`SELECT * FROM online_pays WHERE order_id = ? ORDER BY id DESC LIMIT 1`, o.id) : null;
  if (o.pay_state === 'pending') { // клиент вернулся со страницы банка — спросим банк сами (не чаще раза в 5 секунд)
    const p = opay;
    if (p && p.status === 'created' && (!p.checked_at || Date.parse(p.checked_at.replace(' ', 'T') + 'Z') < Date.now() - 5000)) { try { opay = await payCheck(env, p) || p; } catch (e) {} Object.assign(o, await db(env).one('SELECT * FROM orders WHERE id = ?', o.id)); }
  }
  const S = await getSettings(env);
  await withStages(env, [o]);
  const st = clientStatus(o);
  const items = await db(env).all('SELECT oi.qty, oi.unit_price_tetri, p.name_ru, p.name_en, p.name_ka FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ? AND qty > 0', o.id);
  const full = withTotals(Object.assign({}, o, { items }));
  return { id: o.id, status: st, pay: o.pay_on === 'online' ? ({ created: 'pending', paid: 'paid', failed: 'failed', refunded: 'refunded' }[opay && opay.status] || o.pay_state || 'pending') : null, mode: o.mode, want_at: o.want_at, created_at: o.created_at, accepted_at: o.accepted_at, cooking_at: o.cooking_at, ready_at: o.ready_at, travel: Number(S.delivery.travel) || 20, out_at: o.out_at, delivered_at: o.delivered_at,
    tmin: S.delivery.tmin, tmax: S.delivery.tmax, total_tetri: full.total_tetri, items, lat: o.lat, lng: o.lng, courier_lat: o.courier_lat, courier_lng: o.courier_lng };
});

// Этапы заказа: у неоплаченных — в колонках заказа, у оплаченных (заказ «заморожен») — в order_stages. Собираем вместе.
async function withStages(env, rows) {
  if (!rows.length) return rows;
  const st = await db(env).all(`SELECT order_id, stage, MIN(created_at) AS at FROM order_stages WHERE order_id IN (${rows.map(() => '?').join(',')}) GROUP BY order_id, stage`, ...rows.map((r) => r.id));
  for (const r of rows) for (const x of st.filter((y) => y.order_id === r.id)) { const c = { cooking: 'cooking_at', ready: 'ready_at', out: 'out_at', delivered: 'delivered_at' }[x.stage]; if (c && !r[c]) r[c] = x.at; }
  return rows;
}
// Статус для клиента: только то, что реально нажали в пиццерии (никаких «по времени»)
function clientStatus(o) {
  if (o.status === 'cancelled') return 'cancelled';
  const del = o.mode === 'delivery';
  if (del ? (o.out_at && (o.delivered_at || o.paid_at)) : (o.ready_at && (o.paid_at || o.delivered_at))) return 'delivered';
  if (del && o.out_at) return 'onway';
  if (o.ready_at) return 'ready';
  if (o.cooking_at) return 'cooking';
  if (o.accepted_at || o.paid_at) return 'accepted';
  return 'received';
}

// Касса: входящие и открытые заказы, этапы
on('GET', '/api/orders', 'order.create', async ({ env }) => {
  try { await paySweep(env); } catch (e) {}
  const rows = await db(env).all(`SELECT * FROM orders WHERE (status IN ('open','sent') AND COALESCE(pay_state, '') NOT IN ('pending','failed')) OR (channel = 'site' AND status = 'paid' AND delivered_at IS NULL AND paid_at > datetime('now','-1 day') AND NOT EXISTS (SELECT 1 FROM order_stages s WHERE s.order_id = orders.id AND s.stage = 'delivered')) ORDER BY id DESC LIMIT 80`);
  const ids = rows.map((r) => r.id); if (!ids.length) return [];
  await withStages(env, rows);
  const items = await db(env).all(`SELECT oi.*, p.name_ru, p.name_ka FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY oi.id`, ...ids);
  return rows.map((o) => withTotals(Object.assign(o, { items: items.filter((i) => i.order_id === o.id) })));
});
on('POST', '/api/orders/:id/accept', 'order.send', async ({ env, me, params }) => {
  const o = await loadOrder(env, int(params.id, 'id')); editable(o);
  if (o.accepted_at) fail(409, 'accepted', 'Заказ уже принят');
  const sh = await openShiftOf(env, me.id); if (!sh) fail(409, 'no_shift', 'Сначала откройте смену');
  await db(env).batch([
    db(env).stmt(`UPDATE orders SET accepted_at = ?, shift_id = ?, created_by = ?, status = 'sent', sent_at = ? WHERE id = ?`, isoNow(), sh.id, me.id, isoNow(), o.id),
    db(env).stmt('UPDATE order_items SET sent = 1 WHERE order_id = ? AND qty > 0', o.id)]);
  await audit(env, me.id, 'order.accept', 'order', o.id);
  return loadOrder(env, o.id);
});
on('POST', '/api/orders/:id/stage', 'kitchen.view', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); const col = { cooking: 'cooking_at', ready: 'ready_at', out: 'out_at', delivered: 'delivered_at' }[body.stage];
  if (!col) fail(400, 'bad_stage', 'Этап: cooking, ready, out, delivered');
  const o = await db(env).one('SELECT * FROM orders WHERE id = ?', id); if (!o) fail(404, 'not_found', 'Заказ не найден');
  if (o.status === 'cancelled') fail(409, 'order_closed', 'Заказ отменён');
  if (o.status === 'paid') { // оплаченный заказ заморожен — этапы доставки пишем в отдельную таблицу
    await db(env).run('INSERT INTO order_stages (order_id, stage, staff_id) VALUES (?,?,?)', id, body.stage, me.id);
  } else await db(env).run(`UPDATE orders SET ${col} = COALESCE(${col}, ?) WHERE id = ?`, isoNow(), id);
  await audit(env, me.id, 'order.stage', 'order', id, { stage: body.stage });
  return { ok: true };
});

// Смены
on('GET', '/api/shifts/current', 'shift.open', async ({ env, me }) => { const sh = await openShiftOf(env, me.id); return sh ? { open: true, id: sh.id, opened_at: sh.opened_at } : { open: false }; });
on('GET', '/api/shifts', 'shifts.view', async ({ env }) => db(env).all(`SELECT sh.*, s.name AS staff_name,
    (SELECT COUNT(*) FROM payments p WHERE p.shift_id = sh.id) AS payments,
    (SELECT COALESCE(SUM(total_tetri),0) FROM payments p WHERE p.shift_id = sh.id) AS revenue_tetri,
    (SELECT COUNT(*) FROM payments p LEFT JOIN fiscal_receipts f ON f.order_id = p.order_id WHERE p.shift_id = sh.id AND p.method IN ('cash','card') AND f.order_id IS NULL) AS unfiscal
  FROM shifts sh JOIN staff s ON s.id = sh.staff_id ORDER BY sh.id DESC LIMIT 60`));

// Склад: остатки со стоимостью и история
on('GET', '/api/stock/moves', 'stock.view', async ({ env, url }) => db(env).all(`SELECT m.*, i.name, i.unit, s.name AS staff_name FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id
  LEFT JOIN staff s ON s.id = m.staff_id ORDER BY m.id DESC LIMIT ?`, Math.min(300, Number(url.searchParams.get('limit')) || 100)));

// ───────── Аналитика с себестоимостью и прибылью ─────────
const TZ = "'+4 hours'";
const periodFmt = (g) => ({ day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' })[g] || fail(400, 'bad_group', 'group: day, month, year');
on('GET', '/api/reports/summary', 'reports.view', async ({ env, url }) => {
  const fmt = periodFmt(url.searchParams.get('group') || 'day');
  const from = url.searchParams.get('from') || '2000-01-01'; const to = url.searchParams.get('to') || '2100-01-01';
  const pays = await db(env).all(`SELECT strftime('${fmt}', datetime(p.created_at, ${TZ})) AS period, o.channel, COUNT(*) AS orders,
      SUM(p.total_tetri) AS gross_tetri, SUM(p.commission_tetri) AS commission_tetri, SUM(p.discount_tetri) AS discount_tetri,
      SUM(o.delivery_fee_tetri) AS delivery_tetri
    FROM sales p JOIN orders o ON o.id = p.order_id WHERE date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY period, o.channel ORDER BY period`, from, to);
  const costs = await db(env).all(`SELECT strftime('${fmt}', datetime(p.created_at, ${TZ})) AS period, o.channel, SUM(oi.qty * oi.unit_cost_tetri) AS cost_tetri
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id
    WHERE date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY period, o.channel`, from, to);
  const losses = await db(env).all(`SELECT strftime('${fmt}', datetime(created_at, ${TZ})) AS period, kind, SUM(CASE WHEN kind = 'writeoff' THEN cost_tetri ELSE -cost_tetri END) AS cost_tetri FROM stock_moves
    WHERE kind IN ('writeoff','inventory') AND date(datetime(created_at, ${TZ})) BETWEEN ? AND ? GROUP BY period, kind`, from, to);
  for (const r of pays) { const c = costs.find((x) => x.period === r.period && x.channel === r.channel); r.cost_tetri = c ? Math.round(c.cost_tetri) : 0; r.net_tetri = r.gross_tetri - r.commission_tetri; r.profit_tetri = r.net_tetri - r.cost_tetri; }
  return { rows: pays, losses };
});
// Продажи по дням (как в FINA): чеков, сумма, средний чек, наличные / терминал / онлайн / площадки
on('GET', '/api/reports/daily', 'reports.view', async ({ env, url }) => {
  const g = url.searchParams.get('group') === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const from = dateArg(url.searchParams.get('from') || '2000-01-01', 'с'), to = dateArg(url.searchParams.get('to') || '2100-01-01', 'по');
  const D = db(env);
  const [rows, cats] = await Promise.all([
    D.all(`SELECT strftime('${g}', datetime(p.created_at, ${TZ})) AS d, COUNT(*) AS n, SUM(p.total_tetri) AS rev,
      SUM(CASE WHEN p.method = 'cash' THEN p.total_tetri ELSE 0 END) AS cash, SUM(CASE WHEN p.method = 'card' THEN p.total_tetri ELSE 0 END) AS card,
      SUM(CASE WHEN p.method = 'online' THEN p.total_tetri ELSE 0 END) AS online, SUM(CASE WHEN p.method = 'platform' THEN p.total_tetri ELSE 0 END) AS platform
      FROM sales p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY d ORDER BY d`, from, to),
    D.all(`SELECT c.id, c.name_ru, c.name_ka, c.name_en, SUM(oi.qty) AS qty, ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0)) AS rev
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id JOIN products pr ON pr.id = oi.product_id JOIN categories c ON c.id = pr.category_id
      WHERE oi.qty > 0 AND o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY c.id ORDER BY rev DESC`, from, to)]);
  return { rows, cats };
});
on('GET', '/api/reports/products', 'reports.view', async ({ env, url }) => {
  const g = url.searchParams.get('group'); const per = g ? `strftime('${periodFmt(g)}', datetime(p.created_at, ${TZ}))` : `'all'`;
  const from = url.searchParams.get('from') || '2000-01-01'; const to = url.searchParams.get('to') || '2100-01-01';
  return db(env).all(`SELECT ${per} AS period, oi.product_id, pr.name_ru, pr.name_ka, pr.category_id, o.channel, SUM(oi.qty) AS qty,
      ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0)) AS revenue_tetri,
      ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0 * p.commission_tetri / MAX(p.total_tetri, 1))) AS commission_tetri,
      SUM(oi.qty * oi.unit_cost_tetri) AS cost_tetri
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id JOIN products pr ON pr.id = oi.product_id
    WHERE oi.qty > 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ?
    GROUP BY period, oi.product_id, o.channel ORDER BY period, qty DESC`, from, to);
});

// Аналитика маржи, продукции и финансового положения: текущий период + такой же предыдущий для сравнения
on('GET', '/api/reports/insights', 'reports.view', async ({ env, url }) => {
  const q = url.searchParams; let f = dateArg(q.get('from'), 'с'); const t = dateArg(q.get('to'), 'по'); if (t < f) fail(400, 'bad_date', 'Конец раньше начала');
  const fd0 = await db(env).one(`SELECT MIN(date(datetime(p.created_at, ${TZ}))) AS d FROM sales p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0`);
  if (fd0 && fd0.d && f < fd0.d && fd0.d <= t) f = fd0.d; // «всё время» — с первого дня продаж, а не с 2000 года
  const len = Math.min(dayDiff(f, t), 800); const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const pf = shift(f, -len), pt = shift(f, -1); const D = db(env);
  const prodQ = (a, b) => D.all(`SELECT oi.product_id AS id, pr.name_ru, pr.name_ka, pr.category_id AS cat, SUM(oi.qty) AS qty,
      ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0)) AS rev,
      ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0 * p.commission_tetri / MAX(p.total_tetri, 1))) AS com,
      SUM(oi.qty * oi.unit_cost_tetri) AS cost, SUM(CASE WHEN oi.combo_id IS NOT NULL THEN oi.qty ELSE 0 END) AS in_combo
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id JOIN products pr ON pr.id = oi.product_id
    WHERE oi.qty > 0 AND o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY oi.product_id`, a, b);
  const [cur, prev, pnlC, pnlP, combos, wd, hr, costs, prods, cats] = await Promise.all([
    prodQ(f, t), prodQ(pf, pt), pnlRange(env, f, t), pnlRange(env, pf, pt),
    D.all(`SELECT oi.combo_id AS id, c.name_ru, c.name_ka, c.grp, COUNT(DISTINCT oi.order_id || '-' || oi.combo_n) AS sold, SUM(oi.qty * oi.unit_price_tetri) AS rev, SUM(oi.qty * oi.unit_cost_tetri) AS cost
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id LEFT JOIN combos c ON c.id = oi.combo_id
      WHERE oi.combo_id IS NOT NULL AND oi.qty > 0 AND o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY oi.combo_id ORDER BY sold DESC`, f, t),
    D.all(`SELECT CAST(strftime('%w', datetime(p.created_at, ${TZ})) AS INTEGER) AS d, COUNT(*) AS n, SUM(p.total_tetri) AS rev FROM sales p JOIN orders o ON o.id = p.order_id
      WHERE o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY d`, f, t),
    D.all(`SELECT CAST(strftime('%H', datetime(p.created_at, ${TZ})) AS INTEGER) AS h, COUNT(*) AS n, SUM(p.total_tetri) AS rev FROM sales p JOIN orders o ON o.id = p.order_id
      WHERE o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY h`, f, t),
    productCosts(env),
    D.all(`SELECT p.id, p.name_ru, p.name_ka, p.category_id AS cat FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND p.archived = 0 AND c.active = 1 AND c.soon = 0`),
    D.all('SELECT id, name_ru, name_ka FROM categories ORDER BY sort, id')]);
  const [onl, firstRow, sett, byCh, tp, chs] = await Promise.all([
    D.all(`SELECT o.channel, p.method, COUNT(*) AS n, SUM(p.total_tetri) AS rev FROM sales p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY o.channel, p.method`, f, t),
    D.one(`SELECT MIN(date(datetime(p.created_at, ${TZ}))) AS d FROM sales p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0`),
    settlementsSummary(env),
    D.all(`SELECT oi.product_id AS id, o.channel, SUM(oi.qty) AS qty, ROUND(SUM(oi.qty * oi.unit_price_tetri * (10000 - o.platform_disc_bp) / 10000.0 * (10000 - o.discount_bp) / 10000.0)) AS rev, SUM(oi.qty * oi.unit_cost_tetri) AS cost
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN sales p ON p.order_id = o.id WHERE oi.qty > 0 AND o.is_test = 0 AND date(datetime(p.created_at, ${TZ})) BETWEEN ? AND ? GROUP BY oi.product_id, o.channel`, f, t),
    D.all(`SELECT product_id, price_list, price_tetri FROM prices WHERE price_list IN ('wolt','glovo','bolt')`),
    D.all('SELECT id, commission_bp, price_list FROM channels')]);
  // комиссия площадок: реальная по их инвойсам, а если инвойсов нет — из настроек
  const rates = {}; for (const c of chs) if (['wolt', 'glovo', 'bolt'].includes(c.id)) { const r = sett.platforms.find((x) => x.platform === c.id); rates[c.id] = r && r.invoices.length ? r.real_rate_pct : c.commission_bp / 100; }
  const tariff = {}; for (const r of tp) { (tariff[r.product_id] = tariff[r.product_id] || {})[r.price_list] = r.price_tetri; }
  // «по меню»: сколько зарабатываем с одной штуки по текущей цене и рецепту — даже если продаж ещё мало
  const menu = prods.map((p) => { const c = costs[p.id] || {}; const cost = costOf(c); return { id: p.id, name_ru: p.name_ru, name_ka: p.name_ka, cat: p.cat, price: c.base || 0, price_wolt: (tariff[p.id] || {}).wolt || null, price_glovo: (tariff[p.id] || {}).glovo || null, cost, est: !!c.est, profit: (c.base || 0) - cost, margin: c.base ? Math.round(((c.base - cost) / c.base) * 1000) / 10 : 0 }; });
  const sold = new Set(cur.map((x) => x.id));
  return { from: f, to: t, prev_from: pf, prev_to: pt, cur, prev, pnl: { cur: pnlC.totals, prev: pnlP.totals, kpi: pnlC.kpi, kpi_prev: pnlP.kpi, findings: pnlC.findings, expenses: pnlC.expenses },
    rates, by_ch: byCh, channels: pnlC.channels, channels_prev: pnlP.channels, pay_split: onl, first_day: firstRow && firstRow.d, plat: sett.platforms.map((x) => ({ platform: x.platform, real_rate_pct: x.real_rate_pct, setting_rate_pct: x.setting_rate_pct, invoices: x.invoices.length })),
    combos, weekdays: wd, hours: hr, menu, not_sold: menu.filter((m) => !sold.has(m.id)).map((m) => m.id), cats };
});

// Сотрудники: список и смена PIN
// Владелец управляет всеми входами; администратор (менеджер) — только кассирами и поварами
function canManage(me, role) { if (me.role === 'owner') return true; if (me.role === 'manager' && ['cashier', 'cook'].includes(role)) return true; fail(403, 'forbidden', 'Администратор может менять только кассиров и поваров'); }
on('GET', '/api/staff', 'payroll.manage', async ({ env, me }) => db(env).all(`SELECT id, name, role, active, created_at FROM staff WHERE COALESCE(deleted, 0) = 0 ${me.role === 'owner' ? '' : "AND role IN ('cashier','cook')"} ORDER BY active DESC, role, name`));
on('POST', '/api/staff/:id/pin', 'payroll.manage', async ({ env, me, params, body }) => {
  const id = int(params.id, 'id'); const who = await db(env).one('SELECT role FROM staff WHERE id = ?', id); if (!who) fail(404, 'not_found', 'Нет такого сотрудника'); canManage(me, who.role); pinPolicy(who.role, body.pin);
  const other = await findStaffByPin(env, body.pin);
  if (other && other.id !== id) fail(409, 'pin_taken', 'Такой PIN уже у другого сотрудника');
  if (['0000', '1111', '1234', '2222', '9999', '1961'].includes(String(body.pin))) fail(400, 'weak_pin', 'Слишком простой PIN');
  const salt = randomHex(16);
  await db(env).batch([db(env).stmt('UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?', await hashPin(body.pin, salt), salt, id), db(env).stmt('DELETE FROM sessions WHERE staff_id = ?', id)]);
  await audit(env, me.id, 'staff.pin_change', 'staff', id);
  return { ok: true };
});
on('GET', '/api/me', 'menu.read', async ({ me }) => ({ id: me.id, name: me.name, role: me.role }));
on('POST', '/api/logout', 'menu.read', async ({ env, me, request }) => {
  const t = (request.headers.get('authorization') || '').slice(7); await db(env).run('DELETE FROM sessions WHERE token = ?', t); await audit(env, me.id, 'logout'); return { ok: true };
});

// Сотрудники — только владелец
on('POST', '/api/staff', 'payroll.manage', async ({ env, me, body }) => {
  if (!['owner', 'manager', 'cashier', 'cook'].includes(body.role)) fail(400, 'bad_role', 'Роль: owner, manager, cashier, cook'); canManage(me, body.role);
  pinPolicy(body.role, body.pin);
  if (await findStaffByPin(env, body.pin)) fail(409, 'pin_taken', 'Такой PIN уже у другого сотрудника');
  const salt = randomHex(16); const hash = await hashPin(body.pin, salt);
  const m = await db(env).run('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)', String(body.name), body.role, hash, salt);
  await audit(env, me.id, 'staff.create', 'staff', m.last_row_id, { name: body.name, role: body.role });
  return { id: m.last_row_id };
});

on('POST', '/api/staff/:id/disable', 'payroll.manage', async ({ env, me, params }) => {
  const who = await db(env).one('SELECT role FROM staff WHERE id = ?', int(params.id, 'id')); if (!who) fail(404, 'not_found', 'Нет такого сотрудника'); canManage(me, who.role); if (who.role === 'owner') fail(400, 'owner', 'Владельца отключить нельзя');
  await db(env).batch([
    db(env).stmt('UPDATE staff SET active = 0 WHERE id = ?', int(params.id, 'id')),
    db(env).stmt('DELETE FROM sessions WHERE staff_id = ?', int(params.id, 'id'))
  ]);
  await audit(env, me.id, 'staff.disable', 'staff', params.id);
  return { ok: true };
});
on('POST', '/api/staff/:id/enable', 'payroll.manage', async ({ env, me, params }) => { // снова дать доступ
  const id = int(params.id, 'id'); const who = await db(env).one('SELECT role, deleted FROM staff WHERE id = ?', id); if (!who || who.deleted) fail(404, 'not_found', 'Нет такого сотрудника'); canManage(me, who.role);
  await db(env).run('UPDATE staff SET active = 1 WHERE id = ?', id); await audit(env, me.id, 'staff.enable', 'staff', id); return { ok: true };
});
on('PUT', '/api/staff/:id', 'payroll.manage', async ({ env, me, params, body }) => { // имя и роль
  const id = int(params.id, 'id'); const who = await db(env).one('SELECT role, deleted FROM staff WHERE id = ?', id); if (!who || who.deleted) fail(404, 'not_found', 'Нет такого сотрудника'); canManage(me, who.role);
  const name = String(body.name || '').trim().slice(0, 60); if (name.length < 2) fail(400, 'bad_name', 'Введите имя');
  const role = body.role || who.role; if (!['owner', 'manager', 'cashier', 'cook'].includes(role)) fail(400, 'bad_role', 'Неверная роль'); canManage(me, role);
  if (who.role === 'owner' && role !== 'owner') { const n = await db(env).one(`SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1 AND COALESCE(deleted, 0) = 0`); if (n.n <= 1) fail(400, 'last_owner', 'Нельзя убрать последнего владельца'); }
  if (role === 'cashier' && who.role !== 'cashier') fail(400, 'pin_6', 'Чтобы сделать кассиром, создайте новый вход с PIN из 6 цифр');
  await db(env).batch([db(env).stmt('UPDATE staff SET name = ?, role = ? WHERE id = ?', name, role, id), ...(role !== who.role ? [db(env).stmt('DELETE FROM sessions WHERE staff_id = ?', id)] : [])]);
  await audit(env, me.id, 'staff.edit', 'staff', id, { name, role, was: who.role }); return { ok: true };
});
on('DELETE', '/api/staff/:id', 'payroll.manage', async ({ env, me, params }) => { // удалить: доступ закрыт навсегда, из списка убран; в истории заказов имя остаётся
  const id = int(params.id, 'id'); const who = await db(env).one('SELECT role FROM staff WHERE id = ?', id); if (!who) fail(404, 'not_found', 'Нет такого сотрудника'); canManage(me, who.role);
  if (who.role === 'owner') fail(400, 'owner', 'Владельца удалить нельзя'); if (id === me.id) fail(400, 'self', 'Себя удалить нельзя');
  await db(env).batch([db(env).stmt('UPDATE staff SET active = 0, deleted = 1, pin_hash = ?, pin_salt = ? WHERE id = ?', 'deleted-' + randomHex(16), randomHex(8), id), db(env).stmt('DELETE FROM sessions WHERE staff_id = ?', id)]);
  await audit(env, me.id, 'staff.delete', 'staff', id); return { ok: true };
});

// Журнал — только владелец, и проверка, что его никто не подделал
on('GET', '/api/audit', 'audit.view', async ({ env, url }) => db(env).all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(500, Number(url.searchParams.get('limit')) || 100)));

on('GET', '/api/audit/verify', 'audit.view', async ({ env }) => {
  const rows = await db(env).all('SELECT * FROM audit_log ORDER BY id');
  let prev = 'GENESIS';
  for (const r of rows) {
    const h = await sha256(prev + '|' + [r.ts, r.staff_id ?? '', r.action, r.entity ?? '', r.entity_id ?? '', r.details ?? ''].join('|'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, broken_at: r.id };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
});

const CATALOG_V2 = [{"cat": "pizza", "id": "carb", "ka": "კარბონარა", "en": "Carbonara", "ru": "Карбонара", "desc": "Сливочный соус, бекон, моцарелла", "base": 29, "agg": 38, "size": "33 см", "photo": "/img/menu-carbonara-600.webp"}, {"cat": "pizza", "id": "pep", "ka": "პეპერონი", "en": "Pepperoni", "ru": "Пепперони", "desc": "Томатный соус, моцарелла, пепперони", "base": 25, "agg": 33, "size": "33 см", "photo": "/img/menu-pepperoni-600.webp"}, {"cat": "pizza", "id": "pepgrill", "ka": "პეპერონი გრილი", "en": "Grilled pepperoni", "ru": "Пепперони гриль", "desc": "Пепперони, овощи гриль, моцарелла", "base": 27, "agg": 35, "size": "33 см", "photo": "/img/menu-pepperoni-600.webp"}, {"cat": "pizza", "id": "chorizo", "ka": "პეპერონი ჩორიზო", "en": "Pepperoni chorizo", "ru": "Пепперони чоризо", "desc": "Пепперони, чоризо, моцарелла", "base": 25, "agg": 33, "size": "33 см", "photo": "/img/menu-pepperoni-600.webp"}, {"cat": "pizza", "id": "diablo", "ka": "პეპერონი ჯალაპენო/დიაბლო", "en": "Pepperoni diablo", "ru": "Пепперони диабло", "desc": "Пепперони, халапеньо, моцарелла", "base": 26, "agg": 34, "size": "33 см", "photo": "/img/menu-diablo-600.webp"}, {"cat": "pizza", "id": "marg", "ka": "მარგარიტა", "en": "Margherita", "ru": "Маргарита", "desc": "Томатный соус, моцарелла, базилик", "base": 25, "agg": 33, "size": "33 см", "photo": "/img/menu-margherita-600.webp"}, {"cat": "pizza", "id": "hawaii", "ka": "ჰავაი", "en": "Hawaiian", "ru": "Гавайская", "desc": "Ветчина, ананас, моцарелла", "base": 26, "agg": 34, "size": "33 см", "photo": "/img/menu-hawaii-600.webp"}, {"cat": "pizza", "id": "bbq", "ka": "ბარბექიუ", "en": "BBQ", "ru": "Барбекю", "desc": "Соус барбекю, колбаски, лук, моцарелла", "base": 27, "agg": 35, "size": "33 см", "photo": "/img/menu-diablo-600.webp"}, {"cat": "pizza", "id": "chbbq", "ka": "ბარბექიუ ქათმით", "en": "Chicken BBQ", "ru": "Курица барбекю", "desc": "Соус барбекю, курица, лук, моцарелла", "base": 27, "agg": 35, "size": "33 см", "photo": "/img/menu-ranch-600.webp"}, {"cat": "pizza", "id": "ranch", "ka": "ქათმის რანჩი", "en": "Chicken ranch", "ru": "Цыплёнок ранч", "desc": "Соус ранч, курица, моцарелла", "base": 26, "agg": 34, "size": "33 см", "photo": "/img/menu-ranch-600.webp"}, {"cat": "pizza", "id": "five", "ka": "5 ყველით", "en": "5 cheese", "ru": "5 сыров", "desc": "Пять сыров на сливочной основе", "base": 27, "agg": 35, "size": "33 см", "photo": "/img/menu-five-600.webp"}, {"cat": "pizza", "id": "premium", "ka": "პიცა პრემიუმი", "en": "Premium", "ru": "Премиум", "desc": "Фирменная пицца", "base": 32, "agg": 42, "size": "33 см", "photo": "/img/menu-carbonara-600.webp"}, {"cat": "pizza", "id": "salmon", "ka": "ორაგულით", "en": "Salmon", "ru": "С лососем", "desc": "Лосось, сливочный сыр, моцарелла", "base": 32, "agg": 42, "size": "33 см", "photo": "/img/menu-salmon-600.webp"}, {"cat": "pizza", "id": "burger", "ka": "პიცა ბურგერი", "en": "Burger pizza", "ru": "Пицца-бургер", "desc": "Говяжий фарш, соус бургер, огурцы, моцарелла", "base": 29, "agg": 38, "size": "33 см", "photo": "/img/menu-pepperoni-600.webp"}, {"cat": "drinks", "id": "cola", "ka": "კოკა-კოლა", "en": "Coca-Cola", "ru": "Coca-Cola", "desc": "", "base": 4, "agg": 5, "size": "0,5 л", "photo": "/img/drink-cola-600.webp"}, {"cat": "drinks", "id": "zero", "ka": "კოკა-კოლა ზერო", "en": "Coca-Cola Zero", "ru": "Coca-Cola Zero", "desc": "", "base": 4, "agg": 5, "size": "0,5 л", "photo": "/img/drink-zero-600.webp"}, {"cat": "drinks", "id": "fanta", "ka": "ფანტა", "en": "Fanta", "ru": "Fanta", "desc": "", "base": 4, "agg": 5, "size": "0,5 л", "photo": "/img/drink-fanta-600.webp"}, {"cat": "drinks", "id": "sprite", "ka": "სპრაიტი", "en": "Sprite", "ru": "Sprite", "desc": "", "base": 4, "agg": 5, "size": "0,5 л", "photo": "/img/drink-sprite-600.webp"}, {"cat": "drinks", "id": "water", "ka": "უგაზო წყალი", "en": "Still water", "ru": "Вода негазированная", "desc": "", "base": 2.5, "agg": 3, "size": "0,5 л", "photo": "/img/drink-water-600.webp"}, {"cat": "drinks", "id": "borjomi", "ka": "ბორჯომი", "en": "Borjomi", "ru": "Боржоми", "desc": "", "base": 3.5, "agg": 4.5, "size": "0,5 л", "photo": "/img/drink-borjomi-600.webp"}, {"cat": "drinks", "id": "juice", "ka": "წვენი", "en": "Juice", "ru": "Сок", "desc": "", "base": 6, "agg": 7.5, "size": "1 л", "photo": "/img/drink-juice-600.webp"}];

// Обновление базы до новой версии — само, при первом запросе после OBNOVIT
const schemaReady = new WeakSet();
const schemaRun = new WeakMap();
// Каждый запрос сам доводит обновление базы до конца (миграции повторяемые, шаги помечаются в data_v).
// Нельзя ждать промис другого запроса: в Cloudflare Workers он может так и не завершиться — тогда сайт «висит».
const SCHEMA_MARK = 'm61';   // меняйте при добавлении новой миграции
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  try { const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_mark'`).first(); if (r && r.value === SCHEMA_MARK) { schemaReady.add(env.DB); return; } } catch (e) {}
  await migrate(env);
}
async function migrate(env) {
  const D = db(env);
  await D.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await D.run('CREATE TABLE IF NOT EXISTS advice_log (key TEXT PRIMARY KEY, status TEXT NOT NULL, staff_id INTEGER, at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  await D.run('CREATE TABLE IF NOT EXISTS cash_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime(\'now\')), kind TEXT NOT NULL, amount_tetri INTEGER NOT NULL, staff_id INTEGER, shift_id INTEGER, note TEXT)');
  await D.run('CREATE TABLE IF NOT EXISTS complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime(\'now\')), kind TEXT NOT NULL, phone TEXT, name TEXT, happened TEXT, details TEXT, ip TEXT, status TEXT NOT NULL DEFAULT \'new\', handled_by INTEGER, handled_note TEXT)');
  await D.run('CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // аннулированные оплаченные заказы: оплата остаётся в истории, но из выручки, аналитики и отчётов заказ уходит (через «sales»)
  await D.run(`CREATE TABLE IF NOT EXISTS voids (order_id INTEGER PRIMARY KEY REFERENCES orders(id), reason TEXT NOT NULL, total_tetri INTEGER NOT NULL, method TEXT NOT NULL, staff_id INTEGER, cash_move_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TRIGGER IF NOT EXISTS voids_no_delete BEFORE DELETE ON voids BEGIN SELECT RAISE(ABORT, 'voids are immutable'); END`).catch(() => {});
  await D.run(`DROP VIEW IF EXISTS sales`);
  await D.run(`CREATE VIEW sales AS SELECT * FROM payments WHERE order_id NOT IN (SELECT order_id FROM voids)`);
  await D.run(`CREATE TABLE IF NOT EXISTS kitchen_prints (order_id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run('CREATE TABLE IF NOT EXISTS pin_resets (hash TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  await D.run('CREATE TABLE IF NOT EXISTS schedule (person_id INTEGER NOT NULL, date TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY (person_id, date))');
  await D.run('CREATE TABLE IF NOT EXISTS ingredient_parts (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, qty_per_1000 REAL NOT NULL, PRIMARY KEY (parent_id, child_id))');
  await D.run(`CREATE TABLE IF NOT EXISTS order_stages (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), stage TEXT NOT NULL, staff_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const cols = async (t) => (await D.all(`PRAGMA table_info(${t})`)).map((c) => c.name);
  const want = {
    staff: ['deleted INTEGER NOT NULL DEFAULT 0'],
    products: ['pack_ing TEXT', 'pack_qty INTEGER NOT NULL DEFAULT 1', "pack_mode TEXT NOT NULL DEFAULT 'away'", 'archived INTEGER NOT NULL DEFAULT 0', 'stop_reason TEXT', 'stop_at TEXT'],
    orders: ['platform_disc_bp INTEGER NOT NULL DEFAULT 0', 'delivery_fee_tetri INTEGER NOT NULL DEFAULT 0', 'customer_name TEXT', 'address TEXT', 'mode TEXT', 'pay_on TEXT',
      'accepted_at TEXT', 'want_at TEXT', 'cooking_at TEXT', 'ready_at TEXT', 'out_at TEXT', 'delivered_at TEXT', 'track_token TEXT', 'source_ip TEXT', 'lat REAL', 'lng REAL', 'lang TEXT', 'courier_lat REAL', 'courier_lng REAL', 'promo_id INTEGER', "branch_id TEXT NOT NULL DEFAULT 'main'", 'is_test INTEGER NOT NULL DEFAULT 0', 'pay_state TEXT'],
    order_items: ['unit_cost_tetri INTEGER NOT NULL DEFAULT 0', 'combo_id TEXT', 'combo_n INTEGER'],
    login_attempts: ['ip TEXT'],
    ingredients: ["buy_units TEXT NOT NULL DEFAULT '[]'", 'archived INTEGER NOT NULL DEFAULT 0', 'shelf_days INTEGER NOT NULL DEFAULT 0', 'out_of_stock INTEGER NOT NULL DEFAULT 0'],
    categories: ['active INTEGER NOT NULL DEFAULT 1', 'soon INTEGER NOT NULL DEFAULT 0', 'age18 INTEGER NOT NULL DEFAULT 0'],
    shifts: ["branch_id TEXT NOT NULL DEFAULT 'main'", 'is_test INTEGER NOT NULL DEFAULT 0']
  };
  for (const [t, list] of Object.entries(want)) {
    const have = await cols(t);
    for (const def of list) { const c = def.split(' ')[0]; if (!have.includes(c)) await D.run(`ALTER TABLE ${t} ADD COLUMN ${def}`).catch((e) => { if (!/duplicate column/i.test(String(e && e.message))) throw e; }); }
  }
  await D.run('CREATE UNIQUE INDEX IF NOT EXISTS orders_track ON orders(track_token) WHERE track_token IS NOT NULL');
  await D.run(`CREATE TABLE IF NOT EXISTS invoice_files (invoice_id INTEGER PRIMARY KEY REFERENCES platform_invoices(id), name TEXT NOT NULL, mime TEXT NOT NULL, b64 TEXT NOT NULL, size INTEGER NOT NULL, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS online_pays (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER REFERENCES orders(id), bank TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, ext_id TEXT,
    amount_tetri INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', method TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), checked_at TEXT, paid_at TEXT, refunded_at TEXT, refunded_tetri INTEGER NOT NULL DEFAULT 0)`);
  await D.run('CREATE INDEX IF NOT EXISTS ix_opay_order ON online_pays(order_id)');
  await D.run(`CREATE TABLE IF NOT EXISTS promos (id INTEGER PRIMARY KEY AUTOINCREMENT, title_ru TEXT NOT NULL, title_ka TEXT, title_en TEXT, pct INTEGER NOT NULL,
    date_from TEXT NOT NULL, date_to TEXT NOT NULL, cats TEXT NOT NULL DEFAULT '[]', channels TEXT NOT NULL DEFAULT '["site"]', banner INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
    holiday TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  try { await D.run('ALTER TABLE promos ADD COLUMN wdays TEXT'); } catch (e) {}
  await D.run(`CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, category_id TEXT NOT NULL, lang TEXT, source_ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (phone, category_id))`);
  await D.run(`CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position TEXT, staff_id INTEGER REFERENCES staff(id),
    pay_type TEXT NOT NULL DEFAULT 'month', pay_amount_tetri INTEGER NOT NULL DEFAULT 0, pay_is_net INTEGER NOT NULL DEFAULT 1, pension INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, share_pool INTEGER NOT NULL DEFAULT 0, owner INTEGER NOT NULL DEFAULT 0,
    start_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS timesheet (person_id INTEGER NOT NULL REFERENCES people(id), month TEXT NOT NULL, days REAL, hours REAL, PRIMARY KEY (person_id, month))`);
  await D.run(`CREATE TABLE IF NOT EXISTS payroll_adj (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id), month TEXT NOT NULL, kind TEXT NOT NULL,
    amount_tetri INTEGER NOT NULL, note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, amount_tetri INTEGER NOT NULL, vat_included INTEGER NOT NULL DEFAULT 1,
    supplier TEXT, note TEXT, recurring_id INTEGER, deleted INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS recurring_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, amount_tetri INTEGER NOT NULL, vat_included INTEGER NOT NULL DEFAULT 1,
    day INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS platform_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL, invoice_no TEXT,
    gross_tetri INTEGER NOT NULL DEFAULT 0, partner_disc_tetri INTEGER NOT NULL DEFAULT 0, fees_tetri INTEGER NOT NULL DEFAULT 0, adj_tetri INTEGER NOT NULL DEFAULT 0, payout_tetri INTEGER NOT NULL DEFAULT 0,
    due_date TEXT, paid_tetri INTEGER, paid_at TEXT, note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await D.run(`CREATE TABLE IF NOT EXISTS receivables (order_id INTEGER PRIMARY KEY REFERENCES orders(id), payer TEXT NOT NULL, payer_tin TEXT, amount_tetri INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), received_tetri INTEGER, received_at TEXT, received_by INTEGER, note TEXT)`);
  await D.run(`CREATE TABLE IF NOT EXISTS combos (id TEXT PRIMARY KEY, name_ru TEXT NOT NULL, name_ka TEXT, name_en TEXT, desc_ru TEXT, desc_ka TEXT, desc_en TEXT,
    price_tetri INTEGER NOT NULL, photo TEXT, slots TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 50, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  try { await D.run(`ALTER TABLE combos ADD COLUMN grp TEXT NOT NULL DEFAULT 'combo'`); } catch (e) {}
  await seedPartySets(env);
  await D.run(`CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name_ru TEXT NOT NULL, name_ka TEXT, name_en TEXT, address TEXT, phone TEXT, lat REAL, lng REAL, sort INTEGER NOT NULL DEFAULT 50)`);
  const v = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (!v || Number(v.value) < 2) {
    const st = [
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('pizza', 1, 'პიცა', 'Pizza', 'Пицца') ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('drinks', 9, 'სასმელები', 'Drinks', 'Напитки') ON CONFLICT(id) DO NOTHING`),
      D.stmt(`UPDATE channels SET commission_bp = 2124 WHERE id = 'wolt' AND commission_bp = 3000`),
      D.stmt(`UPDATE channels SET commission_bp = 2950 WHERE id = 'glovo' AND commission_bp = 3000`)];
    CATALOG_V2.forEach((p, i) => {
      st.push(D.stmt(`INSERT INTO products (id, category_id, name_ka, name_en, name_ru, desc_ru, size, photo, sort) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name_ka = excluded.name_ka, name_en = excluded.name_en, name_ru = excluded.name_ru,
          desc_ru = COALESCE(products.desc_ru, excluded.desc_ru), size = excluded.size, photo = COALESCE(products.photo, excluded.photo), sort = excluded.sort`,
        p.id, p.cat, p.ka, p.en, p.ru, p.desc || null, p.size, p.photo, i + 1));
      for (const [pl, v] of [['base', p.base], ['wolt', p.agg], ['glovo', p.agg], ['bolt', p.agg]])
        st.push(D.stmt('INSERT INTO prices (product_id, price_list, price_tetri) VALUES (?,?,?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri', p.id, pl, Math.round(v * 100)));
    });
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '2') ON CONFLICT(key) DO UPDATE SET value = '2'`));
    await D.batch(st);
  }
  const v3 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v3.value) < 3) {
    await D.batch([
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru, soon) VALUES ('sushi', 5, 'სუში და როლები', 'Sushi & rolls', 'Суши и роллы', 1) ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru, age18) VALUES ('beer', 10, 'ლუდი', 'Beer', 'Пиво', 1) ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT INTO branches (id, name_ru, name_ka, name_en, address, phone, lat, lng, sort) VALUES ('main', 'Batumi Mall', 'Batumi Mall', 'Batumi Mall', 'ул. Зураба Горгиладзе, 88', '+995514888800', 41.64318, 41.61974, 1) ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '3') ON CONFLICT(key) DO UPDATE SET value = '3'`)]);
  }
  const v4 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v4.value) < 4) {
    // Реальные напитки, пиво и вино из приложения Pizza Room (ноябрь 2026). Цены Wolt/Glovo ≈ +30%, их можно поправить в админке.
    const N = [
      ['drinks', 'cola', 'კოკა-კოლა', 'Coca-Cola', 'Coca-Cola', '0,33 л', 3, 4, '/img/drink-cola-600.webp', 1],
      ['drinks', 'zero', 'კოკა-კოლა ზერო', 'Coca-Cola Zero', 'Coca-Cola Zero', '0,33 л', 3, 4, '/img/drink-zero-600.webp', 2],
      ['drinks', 'sprite', 'სპრაიტი', 'Sprite', 'Sprite', '0,33 л', 3, 4, '/img/drink-sprite-600.webp', 3],
      ['drinks', 'fanta', 'ფანტა', 'Fanta', 'Fanta', '0,33 л', 3, 4, '/img/drink-fanta-600.webp', 4],
      ['drinks', 'juice', 'ალუბლის წვენი', 'Cherry juice', 'Сок вишнёвый', '0,95 л', 8, 10.5, '/img/drink-juice-cherry-600.webp', 5],
      ['drinks', 'juice_orange', 'ფორთოხლის წვენი', 'Orange juice', 'Сок апельсиновый', '0,95 л', 8, 10.5, '/img/drink-juice-orange-600.webp', 6],
      ['drinks', 'juice_apple', 'ვაშლის წვენი', 'Apple juice', 'Сок яблочный', '0,95 л', 7.5, 10, '/img/drink-juice-apple-600.webp', 7],
      ['drinks', 'bakhmaro', 'ბახმარო, მთის წყალი', 'Bakhmaro mountain water', 'Вода Бахмаро', '0,5 л', 2, 2.5, '/img/drink-bakhmaro-600.webp', 8],
      ['beer', 'argo', 'არგო', 'Argo', 'Арго', '0,5 л', 4.5, 6, '/img/beer-argo-600.webp', 1],
      ['beer', 'heineken', 'ჰაინეკენი', 'Heineken', 'Heineken', '0,33 л', 4.5, 6, '/img/beer-heineken-600.webp', 2],
      ['wine', 'krakhuna', 'კრახუნა', 'Krakhuna', 'Крахуна', '0,75 л', 31, 40.5, '/img/wine-krakhuna-600.webp', 1],
      ['wine', 'khikhvi', 'ხიხვი', 'Khikhvi', 'Хихви', '0,75 л', 31, 40.5, '/img/wine-khikhvi-600.webp', 2]];
    const st = [
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('drinks', 9, 'სასმელები', 'Drinks', 'Напитки') ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru, age18) VALUES ('wine', 11, 'ღვინო', 'Wine', 'Вино', 1) ON CONFLICT(id) DO NOTHING`),
      D.stmt(`UPDATE products SET active = 0 WHERE id IN ('water', 'borjomi')`)];
    for (const [cat, id, ka, en, ru, size, base, agg, photo, sort] of N) {
      st.push(D.stmt(`INSERT INTO products (id, category_id, name_ka, name_en, name_ru, size, photo, sort, active) VALUES (?,?,?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name_ka = excluded.name_ka, name_en = excluded.name_en, name_ru = excluded.name_ru,
          size = excluded.size, photo = excluded.photo, sort = excluded.sort, active = 1`, id, cat, ka, en, ru, size, photo, 100 + sort));
      for (const [pl, val] of [['base', base], ['wolt', agg], ['glovo', agg], ['bolt', agg]])
        st.push(D.stmt('INSERT INTO prices (product_id, price_list, price_tetri) VALUES (?,?,?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri', id, pl, Math.round(val * 100)));
    }
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '4') ON CONFLICT(key) DO UPDATE SET value = '4'`));
    await D.batch(st);
  }
  const v5 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v5.value) < 5) {
    // Настоящие фото пицц Pizza Room (у чоризо пока фото пепперони)
    const st = [];
    for (const id of ['five', 'chbbq', 'bbq', 'burger', 'carb', 'marg', 'salmon', 'pepgrill', 'diablo', 'pep', 'premium', 'ranch', 'hawaii'])
      st.push(D.stmt('UPDATE products SET photo = ? WHERE id = ?', `/img/pizza-${id}-600.webp`, id));
    st.push(D.stmt(`UPDATE products SET photo = '/img/pizza-pep-600.webp' WHERE id = 'chorizo'`));
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '5') ON CONFLICT(key) DO UPDATE SET value = '5'`));
    await D.batch(st);
  }
  const v6 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v6.value) < 6) {
    // Описания пицц на грузинском и английском (раньше на KA/EN показывался русский текст), названия как в приложении
    const T = {
      carb: ['ნაღების სოუსი, ბეკონი, მოცარელა', 'Cream sauce, bacon, mozzarella'],
      pep: ['ტომატის სოუსი, მოცარელა, პეპერონი', 'Tomato sauce, mozzarella, pepperoni'],
      pepgrill: ['პეპერონი, გრილზე შემწვარი ბოსტნეული, მოცარელა', 'Pepperoni, grilled vegetables, mozzarella'],
      chorizo: ['პეპერონი, ჩორიზო, მოცარელა', 'Pepperoni, chorizo, mozzarella'],
      diablo: ['პეპერონი, ჰალაპენიო, მოცარელა', 'Pepperoni, jalapeño, mozzarella'],
      marg: ['ტომატის სოუსი, მოცარელა, ბაზილიკი', 'Tomato sauce, mozzarella, basil'],
      hawaii: ['ლორი, ანანასი, მოცარელა', 'Ham, pineapple, mozzarella'],
      bbq: ['ბარბექიუს სოუსი, სოსისები, ხახვი, მოცარელა', 'BBQ sauce, sausages, onion, mozzarella'],
      chbbq: ['ბარბექიუს სოუსი, ქათამი, ხახვი, მოცარელა', 'BBQ sauce, chicken, onion, mozzarella'],
      ranch: ['რანჩის სოუსი, ქათამი, მოცარელა', 'Ranch sauce, chicken, mozzarella'],
      five: ['ხუთი სახის ყველი ნაღების საფუძველზე', 'Five cheeses on a cream base'],
      premium: ['ფირმის საუკეთესო პიცა', 'Our signature pizza'],
      salmon: ['ორაგული, ნაღების ყველი, მოცარელა', 'Salmon, cream cheese, mozzarella'],
      burger: ['საქონლის ფარში, ბურგერის სოუსი, მწნილი, მოცარელა', 'Ground beef, burger sauce, pickles, mozzarella']};
    const st = Object.entries(T).map(([id, [ka, en]]) => D.stmt('UPDATE products SET desc_ka = COALESCE(desc_ka, ?), desc_en = COALESCE(desc_en, ?) WHERE id = ?', ka, en, id));
    st.push(D.stmt(`UPDATE products SET name_ka = 'პეპერონი ჰალაპენიო', name_ru = 'Пепперони халапеньо', name_en = 'Pepperoni jalapeño' WHERE id = 'diablo' AND name_ka = 'პეპერონი ჯალაპენო/დიაბლო'`));
    for (const [id, ka] of [['juice', 'ალუბლის წვენი'], ['juice_orange', 'ფორთოხლის წვენი'], ['juice_apple', 'ვაშლის წვენი'], ['bakhmaro', 'ბახმარო, მთის წყალი']])
      st.push(D.stmt('UPDATE products SET name_ka = ? WHERE id = ?', ka, id));
    st.push(D.stmt(`UPDATE products SET name_ka = 'პრემიუმი' WHERE id = 'premium' AND name_ka = 'პიცა პრემიუმი'`));
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '6') ON CONFLICT(key) DO UPDATE SET value = '6'`));
    await D.batch(st);
  }
  const v7 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v7.value) < 7) {
    const PZ = { ka: 'პიცა', en: 'Pizza', ru: 'Пицца', cat: 'pizza', extra: { carb: 300, burger: 300, premium: 500, salmon: 500 } };
    const CAN = { ka: 'სასმელი 0,33', en: 'Drink 0.33', ru: 'Напиток 0,33', ids: ['cola', 'zero', 'sprite', 'fanta'], extra: {} };
    const JU = { ka: 'წვენი 0,95', en: 'Juice 0.95', ru: 'Сок 0,95', ids: ['juice', 'juice_orange', 'juice_apple'], extra: {} };
    const BR = { ka: 'ლუდი', en: 'Beer', ru: 'Пиво', ids: ['argo', 'heineken'], extra: {} };
    const C = [
      ['lunch', 'Ланч', 'ლანჩი', 'Lunch', 'Любая пицца + напиток 0,33', 'ნებისმიერი პიცა + სასმელი 0,33', 'Any pizza + a 0.33 drink', 2600, [PZ, CAN], 1],
      ['duo', 'На двоих', 'ორისთვის', 'For two', '2 пиццы + 2 напитка 0,33', '2 პიცა + 2 სასმელი 0,33', '2 pizzas + 2 drinks 0.33', 5200, [PZ, PZ, CAN, CAN], 2],
      ['party', 'Компания', 'მეგობრებისთვის', 'Party', '3 пиццы + сок 0,95 л', '3 პიცა + წვენი 0,95 ლ', '3 pizzas + 0.95 L juice', 7600, [PZ, PZ, PZ, JU], 3],
      ['evening', 'Вечер 18+', 'საღამო 18+', 'Evening 18+', 'Пицца + 2 пива', 'პიცა + 2 ლუდი', 'Pizza + 2 beers', 3200, [PZ, BR, BR], 4]];
    const st = C.map(([id, ru, ka, en, dru, dka, den, price, slots, sort]) => D.stmt(`INSERT INTO combos (id, name_ru, name_ka, name_en, desc_ru, desc_ka, desc_en, price_tetri, photo, slots, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      id, ru, ka, en, dru, dka, den, price, `/img/combo-${id}-600.webp`, JSON.stringify(slots), sort));
    st.push(D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('pizza', 1, 'პიცა', 'Pizza', 'Пицца') ON CONFLICT(id) DO NOTHING`));
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '7') ON CONFLICT(key) DO UPDATE SET value = '7'`));
    await D.batch(st);
  }
  const v8 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v8.value) < 8) {
    if (!(await D.one('SELECT COUNT(*) AS n FROM people')).n) {
      // [имя, должность, оклад ₾ на руки (0 — уточнить), доля в 1% от выручки, владелец]
      const P = [['Гиорги Катамадзе', 'Директор, совладелец', 0, 0, 1], ['Анна Селиванова', 'Совладелец', 0, 0, 1],
        ['Ия', 'Повар', 1400, 1, 0], ['Нино', 'Повар', 1400, 1, 0], ['Теона', 'Повар', 1400, 1, 0], ['Тамила', 'Повар', 1400, 1, 0], ['Инга', 'Повар', 1400, 1, 0],
        ['Лали', 'Кассир', 1400, 1, 0], ['Миранда', 'Кассир', 1400, 1, 0], ['Теона (уборщица)', 'Уборщица', 900, 0, 0], ['Нани', 'Уборщица', 900, 0, 0],
        ['Линда', 'Администратор', 0, 0, 0], ['Ираклий', 'Менеджер (инкассация)', 0, 0, 0], ['Бухгалтер', 'Бухгалтер', 0, 0, 0]];
      await D.batch(P.map(([n, pos, amt, pool, own]) => D.stmt('INSERT INTO people (name, position, pay_type, pay_amount_tetri, pay_is_net, pension, share_pool, owner) VALUES (?,?,?,?,1,1,?,?)', n, pos, 'month', amt * 100, pool, own)));
    }
    await D.batch([D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '8') ON CONFLICT(key) DO UPDATE SET value = '8'`)]);
  }
  const v9 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v9.value) < 9) {
    // ингредиенты из списка заведения (ноябрь 2026): название «по-грузински · по-русски»
    const ING = [["sesame", "სეზამი", "Кунжут", "g"], ["champ", "შამპინიონი", "Шампиньоны", "g"], ["tomato", "პომიდორი", "Помидоры", "g"], ["onion_red", "ხახვი წითელი", "Лук красный", "g"], ["rucola", "რუკოლა [არუგულა]", "Руккола", "g"], ["dill", "უკროპი [კამა]", "Укроп", "g"], ["oregano", "ორეგანო", "Орегано", "g"], ["pepper_blk", "შავი წიწაკა", "Перец чёрный", "g"], ["ketchup", "კეტჩუპი", "Кетчуп", "g"], ["pickles", "კიტრის მწნილი", "Огурцы маринованные", "g"], ["pineapple", "ანანასი [კონსერვი]", "Ананас консервированный", "g"], ["olive_oil", "ზეითუნის ზეთი", "Масло оливковое", "ml"], ["jalapeno", "ჯალაპენო", "Халапеньо", "g"], ["tomato_can", "პომიდორის კონსერვი", "Томаты консервированные", "g"], ["flour", "ფქვილი", "Мука", "g"], ["yeast", "დროჟი", "Дрожжи", "g"], ["salt", "მარილი", "Соль", "g"], ["sugar", "შაქარი", "Сахар", "g"], ["milk", "რძე", "Молоко", "ml"], ["cream_raw", "ნაღები", "Сливки", "ml"], ["parmesan", "ყველი პარმეზანი", "Сыр пармезан", "g"], ["cheddar", "ყველი ჩედარი", "Сыр чеддер", "g"], ["dorblu", "ყველი დორბლუ", "Сыр дорблю", "g"], ["feta", "ყველი ფეტა", "Сыр фета", "g"], ["mascarpone", "ყველი მასკარპონე", "Сыр маскарпоне", "g"], ["salmon_f", "ორაგული", "Лосось", "g"], ["beef_mince", "საქონლის ფარში", "Фарш говяжий", "g"], ["ham_turkey", "ლორი [ინდაურის]", "Ветчина [индейка]", "g"], ["bacon", "ბეკონი", "Бекон", "g"], ["salami", "ძეხვი სალიამი მილანო", "Салями Милано", "g"], ["chorizo", "ძეხვი პეპერონი ჩორიზო", "Пепперони чоризо", "g"], ["sauce_bbq", "ბარბექიუს სოუსი", "Соус барбекю", "g"], ["sauce_garlic", "ნივრის სოუსი", "Соус чесночный", "g"], ["sauce_grill", "გრილის სოუსი", "Соус гриль", "g"], ["box", "ყუთი პიცის", "Коробка для пиццы", "pcs"]];
    const REN = [["mozz", "Моцарелла", "ყველი მოცარელა · Сыр моцарелла"], ["basil", "Базилик", "ბაზილიკა (პიტნა) · Базилик"], ["pepp", "Пепперони", "ძეხვი პეპერონი · Пепперони"], ["chick", "Курица", "ქათმის ფილე · Куриное филе"], ["dough", "Тесто", "ცომი [საკუთარი] · Тесто"], ["sauce", "Томатный соус", "ტომატის სოუსი [საკუთარი] · Томатный соус"], ["cream", "Сливочная основа", "ნაღების საფუძველი [საკუთარი] · Сливочная основа"]];
    const st = ING.map(([id, ka, ru, u]) => D.stmt('INSERT OR IGNORE INTO ingredients (id, name, unit, cost_per_1000_tetri, min_stock) VALUES (?,?,?,0,0)', id, ka + ' · ' + ru, u));
    for (const [id, old, nm] of REN) st.push(D.stmt('UPDATE ingredients SET name = ? WHERE id = ? AND name = ?', nm, id, old));
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '9') ON CONFLICT(key) DO UPDATE SET value = '9'`));
    await D.batch(st);
  }
  const v10 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v10.value) < 10) {
    // томатный соус для пиццы закупается литрами, в рецептах — граммы. 1 л ≈ 1000 г (уточняется в админке взвешиванием)
    await D.batch([D.stmt(`UPDATE ingredients SET buy_units = '[{"n":"л","q":1000}]' WHERE id = 'sauce' AND (buy_units IS NULL OR buy_units = '[]')`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '10') ON CONFLICT(key) DO UPDATE SET value = '10'`)]);
  }
  const v11 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v11.value) < 11) {
    // Напитки и упаковка из списка заведения (12.11.2026). Новые позиции добавлены скрытыми и без цены: цену ставит владелец, потом включает «Показывать».
    const B = [["cola", "კოკა-კოლა 0,33 ლ", "Coca-Cola 0,33 л", null], ["fanta", "ფანტა 0,33 ლ", "Fanta 0,33 л", null], ["sprite", "სპრაიტი 0,33 ლ", "Sprite 0,33 л", null], ["bakhmaro", "მთის წყალი 0,5 ლ", "Вода горная 0,5 л", null], ["heineken", "ლუდი ჰაინეკენი, მინის ბოთლი 0,33 ლ", "Пиво Heineken, стекло 0,33 л", null], ["icetea_peach", "ცივი ჩაი ატამი 0,5 ლ", "Холодный чай персик 0,5 л", ["drinks", "ცივი ჩაი ატამი", "Iced tea peach", "Холодный чай персик", "0,5 л", 20]], ["icetea_lemon", "ცივი ჩაი ლიმონი 0,5 ლ", "Холодный чай лимон 0,5 л", ["drinks", "ცივი ჩაი ლიმონი", "Iced tea lemon", "Холодный чай лимон", "0,5 л", 21]], ["icetea_mango", "ცივი ჩაი მანგო-ანანასი 0,5 ლ", "Холодный чай манго-ананас 0,5 л", ["drinks", "ცივი ჩაი მანგო-ანანასი", "Iced tea mango-pineapple", "Холодный чай манго-ананас", "0,5 л", 22]], ["icetea_berry", "ცივი ჩაი ტყის კენკრა 0,5 ლ", "Холодный чай лесные ягоды 0,5 л", ["drinks", "ცივი ჩაი ტყის კენკრა", "Iced tea forest berries", "Холодный чай лесные ягоды", "0,5 л", 23]], ["cappy_apple", "კაპი ვაშლი 0,5 ლ", "Cappy яблоко 0,5 л", ["drinks", "კაპი ვაშლი", "Cappy apple", "Cappy яблоко", "0,5 л", 30]], ["cappy_cherry", "კაპი ალუბალი 0,5 ლ", "Cappy вишня 0,5 л", ["drinks", "კაპი ალუბალი", "Cappy cherry", "Cappy вишня", "0,5 л", 31]], ["cappy_orange", "კაპი ფორთოხალი 0,5 ლ", "Cappy апельсин 0,5 л", ["drinks", "კაპი ფორთოხალი", "Cappy orange", "Cappy апельсин", "0,5 л", 32]], ["cappy_berry", "კაპი ტყის კენკრა 0,5 ლ", "Cappy лесные ягоды 0,5 л", ["drinks", "კაპი ტყის კენკრა", "Cappy forest berries", "Cappy лесные ягоды", "0,5 л", 33]], ["cappy_peach", "კაპი ატამი 0,5 ლ", "Cappy персик 0,5 л", ["drinks", "კაპი ატამი", "Cappy peach", "Cappy персик", "0,5 л", 34]], ["cappy_grapefruit", "კაპი გრეიფრუტი პალპი 0,5 ლ", "Cappy грейпфрут с мякотью 0,5 л", ["drinks", "კაპი გრეიფრუტი პალპი", "Cappy grapefruit pulpy", "Cappy грейпфрут с мякотью", "0,5 л", 35]], ["limon_fresh", "ლაიმონ ფრეშ 0,33 ლ", "Laimon Fresh 0,33 л", ["drinks", "ლაიმონ ფრეშ", "Laimon Fresh", "Laimon Fresh", "0,33 л", 40]], ["burakhi", "ბურახი 0,5 ლ", "Бурахи 0,5 л", ["drinks", "ბურახი", "Burakhi", "Бурахи", "0,5 л", 41]], ["pepsi", "პეპსი 0,33 ლ", "Pepsi 0,33 л", ["drinks", "პეპსი", "Pepsi", "Pepsi", "0,33 л", 5]], ["corona", "ლუდი კორონა 0,33 ლ", "Пиво Corona 0,33 л", ["beer", "კორონა", "Corona", "Corona", "0,33 л", 3]], ["staropramen", "ლუდი სტაროპრამენი 0,5 ლ ქილა", "Пиво Staropramen 0,5 л банка", ["beer", "სტაროპრამენი", "Staropramen", "Staropramen", "0,5 л", 4]], ["estrella", "ლუდი ESTRELLA DAMM", "Пиво Estrella Damm", ["beer", "ესტრელა დამი", "Estrella Damm", "Estrella Damm", "", 5]], ["lowenbrau", "ლუდი ლოვენბრაუ 0,5 ლ ქილა", "Пиво Löwenbräu 0,5 л банка", ["beer", "ლოვენბრაუ", "Löwenbräu", "Löwenbräu", "0,5 л", 6]]];
    const C = [["espresso", "ესპრესო", "Espresso", "Эспрессо", "cup_esp", 1], ["americano", "ამერიკანო", "Americano", "Американо", "cup_capp", 2], ["cappuccino", "კაპუჩინო", "Cappuccino", "Капучино", "cup_capp", 3], ["latte", "ლატე", "Latte", "Латте", "cup_capp", 4], ["tea_black", "ჩაი შავი", "Black tea", "Чай чёрный", "cup_capp", 5], ["tea_green", "ჩაი მწვანე", "Green tea", "Чай зелёный", "cup_capp", 6], ["tea_berry", "ჩაი კენკრით", "Tea with berries", "Чай с ягодами", "cup_capp", 7]];
    const st = [D.stmt(`INSERT INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('coffee', 12, 'ყავა და ჩაი', 'Coffee & tea', 'Кофе и чай') ON CONFLICT(id) DO NOTHING`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('cup_capp', 'კაპუჩინოს ჭიქა · Стакан для капучино', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('cup_esp', 'ესპრესოს ჭიქა · Стакан для эспрессо', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('box', 'ყუთი პიცის · Коробка для пиццы', 'pcs')`),
      D.stmt(`UPDATE products SET pack_ing = 'box', pack_mode = 'away' WHERE category_id = 'pizza' AND pack_ing IS NULL`)];
    for (const [pid, ka, ru, np] of B) {
      if (np) { const [cat, nka, nen, nru, size, sort] = np;
        st.push(D.stmt('INSERT OR IGNORE INTO products (id, category_id, name_ka, name_en, name_ru, size, sort, active) VALUES (?,?,?,?,?,?,?,0)', pid, cat, nka, nen, nru, size || null, 100 + sort)); }
      st.push(D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES (?,?,'pcs')`, 'st_' + pid, ka + ' · ' + ru));
      st.push(D.stmt('INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)', pid, 'st_' + pid, pid));
    }
    for (const [pid, ka, en, ru, cup, sort] of C) st.push(D.stmt(`INSERT OR IGNORE INTO products (id, category_id, name_ka, name_en, name_ru, sort, active, pack_ing, pack_mode) VALUES (?, 'coffee', ?,?,?,?,0,?, 'always')`, pid, ka, en, ru, sort, cup));
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '11') ON CONFLICT(key) DO UPDATE SET value = '11'`));
    await D.batch(st);
  }
  const v12 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v12.value) < 12) {
    // 12.11.2026: всё в бумажных стаканах (и в зале); эспрессо — малый стакан, остальное — большой. Позиции старого приложения, которых нет в списке заведения, скрыты.
    const st = [D.stmt(`UPDATE ingredients SET name = 'ესპრესოს ქაღალდის ჭიქა (პატარა) · Бумажный стакан малый (эспрессо)' WHERE id = 'cup_esp'`),
      D.stmt(`UPDATE ingredients SET name = 'ქაღალდის ჭიქა (დიდი) · Бумажный стакан большой (капучино, американо, латте, чай)' WHERE id = 'cup_capp'`),
      D.stmt(`UPDATE products SET pack_mode = 'always' WHERE pack_ing IN ('cup_esp', 'cup_capp')`),
      D.stmt(`UPDATE products SET pack_ing = 'cup_capp' WHERE id IN ('americano', 'cappuccino', 'latte', 'tea_black', 'tea_green', 'tea_berry')`),
      D.stmt(`UPDATE products SET pack_ing = 'cup_esp' WHERE id = 'espresso'`),
      D.stmt(`UPDATE products SET active = 0 WHERE id IN ('zero', 'juice', 'juice_orange', 'juice_apple', 'argo', 'krakhuna', 'khikhvi')`)];
    const CAN = ['cola', 'sprite', 'fanta', 'pepsi']; const BEER = ['heineken', 'corona', 'staropramen', 'estrella', 'lowenbrau'];
    const can = { ka: 'სასმელი 0,33', en: 'Drink 0.33', ru: 'Напиток 0,33', ids: CAN, extra: {} };
    for (const c of await D.all('SELECT id, slots FROM combos')) {
      let sl = JSON.parse(c.slots || '[]'); const was = JSON.stringify(sl); const party = sl.some((x) => (x.ids || []).includes('juice'));
      sl = sl.flatMap((x) => {
        const ids = x.ids || [];
        if (ids.includes('juice')) return [can, can];
        if (ids.includes('cola') || ids.includes('zero')) return [Object.assign({}, x, { ids: CAN })];
        if (ids.includes('argo')) return [Object.assign({}, x, { ids: BEER })];
        return [x];
      });
      if (JSON.stringify(sl) === was) continue;
      st.push(D.stmt('UPDATE combos SET slots = ? WHERE id = ?', JSON.stringify(sl), c.id));
      if (party) st.push(D.stmt(`UPDATE combos SET desc_ru = '3 пиццы + 2 напитка 0,33', desc_ka = '3 პიცა + 2 სასმელი 0,33', desc_en = '3 pizzas + 2 drinks 0.33' WHERE id = ?`, c.id));
    }
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '12') ON CONFLICT(key) DO UPDATE SET value = '12'`));
    await D.batch(st);
  }
  const v13 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v13.value) < 13) {
    // Калькуляция пицц заведения (12.11.2026). Тесто — 1 шт на пиццу (заготовка из муки, молока…), курица для «Ранча» — маринованная (заготовка). Коробка — на каждую пиццу.
    const R = {"pep": [["sauce", 70], ["mozz", 170], ["pepp", 60], ["dough", 1]], "pepgrill": [["sauce", 70], ["mozz", 140], ["pepp", 60], ["sauce_bbq", 30], ["dough", 1]], "chorizo": [["sauce", 70], ["mozz", 140], ["chorizo", 80], ["dough", 1]], "diablo": [["sauce", 70], ["mozz", 140], ["pepp", 60], ["jalapeno", 30], ["dough", 1]], "marg": [["sauce", 70], ["mozz", 270], ["tomato", 70], ["basil", 5], ["dough", 1]], "hawaii": [["sauce", 70], ["mozz", 140], ["ham_turkey", 70], ["pineapple", 80], ["dough", 1]], "carb": [["cream_raw", 60], ["mozz", 140], ["parmesan", 15], ["bacon", 60], ["champ", 60], ["dough", 1]], "bbq": [["sauce", 70], ["mozz", 140], ["bacon", 70], ["onion_red", 12], ["tomato", 70], ["sauce_bbq", 60], ["dough", 1]], "chbbq": [["sauce", 70], ["mozz", 140], ["onion_red", 12], ["tomato", 70], ["chick", 190], ["sauce_bbq", 60], ["dough", 1]], "ranch": [["sauce_garlic", 100], ["mozz", 140], ["tomato", 70], ["onion_red", 12], ["chick_mar", 190], ["dough", 1]], "burger": [["sauce", 70], ["mozz", 105], ["beef_mince", 100], ["sauce_grill", 50], ["onion_red", 40], ["pickles", 50], ["cheddar", 80], ["sesame", 3], ["dough", 1]], "premium": [["sauce", 70], ["mozz", 140], ["salami", 80], ["pepp", 30], ["ham_turkey", 30], ["bacon", 30], ["rucola", 5], ["dough", 1]], "salmon": [["sauce", 70], ["mozz", 165], ["mascarpone", 60], ["salmon_f", 100], ["dill", 5], ["dough", 1]], "five": [["sauce_garlic", 70], ["mozz", 165], ["parmesan", 15], ["dorblu", 15], ["feta", 40], ["cheddar", 10], ["dough", 1]]};
    const PARTS = {"dough": [["flour", 160000], ["milk", 17000], ["sugar", 1000], ["salt", 2000], ["olive_oil", 4000], ["yeast", 100]], "chick_mar": [["chick", 1000], ["ketchup_hot", 75], ["sauce", 37], ["salt", 1], ["pepper_blk", 1]]};
    const st = [D.stmt(`UPDATE ingredients SET unit = 'pcs', name = 'ცომი (საკუთარი) · Тесто (своё), 1 шт на пиццу' WHERE id = 'dough'`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('ketchup_hot', 'კეტჩუპი ცხარე · Кетчуп острый', 'g')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('chick_mar', 'ქათმის ფილე დამარინადებული (საკუთარი) · Курица маринованная (своя)', 'g')`),
      D.stmt(`UPDATE ingredients SET name = 'პიცის სოუსი · Соус для пиццы' WHERE id = 'sauce' AND name LIKE 'ტომატის სოუსი%'`),
      D.stmt(`UPDATE products SET pack_ing = 'box', pack_mode = 'always' WHERE category_id = 'pizza'`)];
    for (const [pid, lines] of Object.entries(R)) {
      st.push(D.stmt('DELETE FROM recipes WHERE product_id = ?', pid));
      for (const [ing, q] of lines) st.push(D.stmt('INSERT OR REPLACE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?) AND EXISTS (SELECT 1 FROM ingredients WHERE id = ?)', pid, ing, q, pid, ing));
    }
    for (const [par, lines] of Object.entries(PARTS)) {
      st.push(D.stmt('DELETE FROM ingredient_parts WHERE parent_id = ?', par));
      for (const [c, q] of lines) st.push(D.stmt('INSERT OR REPLACE INTO ingredient_parts (parent_id, child_id, qty_per_1000) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ingredients WHERE id = ?)', par, c, q, c));
    }
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '13') ON CONFLICT(key) DO UPDATE SET value = '13'`));
    await D.batch(st); await refreshComposite(env);
  }
  const v14 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v14.value) < 14) {
    // 12.11.2026: «Курица барбекю» — тоже маринованная курица. Соус для пиццы — заготовка: на 1 кг покупного томатного соуса + сахар 50, соль 4, орегано 2, масло 4.
    await D.batch([
      D.stmt(`UPDATE recipes SET ingredient_id = 'chick_mar' WHERE product_id = 'chbbq' AND ingredient_id = 'chick'`),
      D.stmt(`UPDATE ingredients SET name = 'პომიდვრის სოუსი (ნაყიდი) · Томатный соус покупной', buy_units = CASE WHEN buy_units IS NULL OR buy_units = '[]' THEN (SELECT buy_units FROM ingredients WHERE id = 'sauce') ELSE buy_units END WHERE id = 'tomato_can'`),
      D.stmt(`UPDATE ingredients SET name = 'პიცის სოუსი (საკუთარი) · Соус для пиццы (свой)', buy_units = '[]' WHERE id = 'sauce'`),
      D.stmt(`DELETE FROM ingredient_parts WHERE parent_id = 'sauce'`),
      ...[['tomato_can', 1000], ['sugar', 50], ['salt', 4], ['oregano', 2], ['olive_oil', 4]].map(([c, q]) => D.stmt('INSERT OR REPLACE INTO ingredient_parts (parent_id, child_id, qty_per_1000) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ingredients WHERE id = ?) AND EXISTS (SELECT 1 FROM ingredients WHERE id = ?)', 'sauce', c, q, c, 'sauce')),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '14') ON CONFLICT(key) DO UPDATE SET value = '14'`)]);
    await refreshComposite(env);
  }
  const v15 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v15.value) < 15) {
    // фото кофе и чая: бумажные стаканы с логотипом Pizza Room
    const PH = { espresso: 'coffee-espresso', americano: 'coffee-americano', cappuccino: 'coffee-cappuccino', latte: 'coffee-latte', tea_black: 'tea-black', tea_green: 'tea-green', tea_berry: 'tea-berry' };
    await D.batch([...Object.entries(PH).map(([id, f]) => D.stmt(`UPDATE products SET photo = ? WHERE id = ? AND (photo IS NULL OR photo = '')`, '/img/' + f + '-600.webp', id)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '15') ON CONFLICT(key) DO UPDATE SET value = '15'`)]);
  }
  const v16 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v16.value) < 16) {
    // должности на двух языках, чтобы в грузинской админке было понятно
    const T = [['Директор, совладелец', 'დირექტორი, თანამფლობელი'], ['Совладелец', 'თანამფლობელი'], ['Администратор', 'ადმინისტრატორი'], ['Менеджер (инкассация)', 'მენეჯერი (ინკასაცია)'],
      ['Бухгалтер', 'ბუღალტერი'], ['Повар', 'მზარეული'], ['Кассир', 'მოლარე'], ['Уборщица', 'დამლაგებელი']];
    await D.batch([...T.map(([ru, ka]) => D.stmt('UPDATE people SET position = ? WHERE position = ?', ka + ' · ' + ru, ru)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '16') ON CONFLICT(key) DO UPDATE SET value = '16'`)]);
  }
  const v17 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v17.value) < 17) {
    // Цены заведения (12.11.2026): закупочные цены сырья и напитков → склад; цены продажи напитков, вина, кофе → меню (Wolt/Glovo — одна цена).
    const ING = {"sesame": 30, "champ": 9.5, "tomato": 5.5, "basil": 22, "onion_red": 3.5, "rucola": 22, "dill": 8, "oregano": 15, "pepper_blk": 30, "coffee": 91.8, "ketchup_hot": 6.67, "pickles": 9.39, "pineapple": 15.47, "olive_oil": 20, "jalapeno": 13.46, "tomato_can": 7.2, "flour": 2, "yeast": 16.67, "salt": 1.13, "sugar": 2.08, "milk": 3.85, "cream_raw": 18.03, "mozz": 17, "parmesan": 56.7, "cheddar": 24.2, "dorblu": 61, "feta": 20.48, "mascarpone": 36.58, "chick": 7.4, "salmon_f": 75, "ham_turkey": 31, "bacon": 45.33, "pepp": 51.17, "salami": 48.6, "chorizo": 49.8, "beef_mince": 30, "sauce_garlic": 11.54, "sauce_grill": 13.5, "sauce_bbq": 9.13};
    const PCS = {"box": 0.63, "tea_bag_black": 0.2, "tea_bag_green": 0.2, "tea_bag_berry": 0.25};
    const DR = [["icetea_peach", 1.83, 3.5, 4.7], ["icetea_lemon", 1.83, 3.5, 4.7], ["icetea_mango", 1.83, 3.5, 4.7], ["icetea_berry", 1.83, 3.5, 4.7], ["cola", 1.49, 3, 4], ["fanta", 1.49, 3, 4], ["sprite", 1.49, 3, 4], ["cappy_apple", 2.25, 4, 4.7], ["cappy_cherry", 2.25, 4, 4.7], ["cappy_orange", 2.25, 4, 4.7], ["cappy_berry", 1.83, 4, 4.7], ["bakhmaro", 0.44, 2, 2.7], ["limon_fresh", 1.9, 3.5, 4.5], ["cappy_peach", 2.25, 4, 4.7], ["cappy_grapefruit", 2.25, 4, 4.7], ["burakhi", 2.3, 4.5, 5.5], ["pepsi", 1.29, 3, 4], ["heineken", 3.8, 7, 8], ["corona", 3.8, 6, 8], ["staropramen", 4.01, 6, 8], ["estrella", 4, 7, 9], ["lowenbrau", 4.47, 6.5, 8], ["rkatsiteli", 24.15, 31, null], ["krakhuna", 24.15, 31, null], ["tsolikauri", 24.15, 31, null], ["khikhvi", 24.15, 31, null]];
    const CO = [["espresso", 3.5], ["americano", 5], ["cappuccino", 5], ["latte", 5], ["tea_black", 1.5], ["tea_green", 1.5], ["tea_berry", 1.5]];
    const st = [
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('coffee', 'ყავა მარცვლებში · Кофе в зёрнах', 'g')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('tea_bag_black', 'ჩაი შავი (პაკეტი) · Чай чёрный (пакетик)', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('tea_bag_green', 'ჩაი მწვანე (პაკეტი) · Чай зелёный (пакетик)', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('tea_bag_berry', 'ჩაი კენკრით (პაკეტი) · Чай с ягодами (пакетик)', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('cup_lid', 'კაპუჩინოს ჭიქის თავსახური · Крышка для стакана', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES ('bag_brand', 'ბრენდირებული პარკი · Фирменный пакет', 'pcs')`),
      D.stmt(`INSERT OR IGNORE INTO products (id, category_id, name_ka, name_en, name_ru, size, sort, active) VALUES ('rkatsiteli', 'wine', 'რქაწითელი', 'Rkatsiteli', 'Ркацители', '0,75 л', 3, 0)`),
      D.stmt(`INSERT OR IGNORE INTO products (id, category_id, name_ka, name_en, name_ru, size, sort, active) VALUES ('tsolikauri', 'wine', 'ცოლიკაური', 'Tsolikauri', 'Цоликаури', '0,75 л', 4, 0)`),
      D.stmt(`UPDATE categories SET active = 1 WHERE id = 'wine'`)];
    for (const [id, gel] of Object.entries(ING)) st.push(D.stmt('UPDATE ingredients SET cost_per_1000_tetri = ? WHERE id = ?', Math.round(gel * 100), id));
    for (const [id, gel] of Object.entries(PCS)) st.push(D.stmt('UPDATE ingredients SET cost_per_1000_tetri = ? WHERE id = ?', Math.round(gel * 100 * 1000), id));
    const WINE = { rkatsiteli: 'რქაწითელი 0,75 ლ · Ркацители 0,75 л', krakhuna: 'კრახუნა 0,75 ლ · Крахуна 0,75 л', tsolikauri: 'ცოლიკაური 0,75 ლ · Цоликаури 0,75 л', khikhvi: 'ხიხვი 0,75 ლ · Хихви 0,75 л' };
    for (const [pid, cost, base, plat] of DR) {
      if (WINE[pid]) st.push(D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES (?, ?, 'pcs')`, 'st_' + pid, WINE[pid]),
        D.stmt('INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)', pid, 'st_' + pid, pid));
      st.push(D.stmt('UPDATE ingredients SET cost_per_1000_tetri = ? WHERE id = ?', Math.round(cost * 100 * 1000), 'st_' + pid));
      st.push(D.stmt(`INSERT INTO prices (product_id, price_list, price_tetri) SELECT ?, 'base', ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri`, pid, Math.round(base * 100), pid));
      for (const pl of ['wolt', 'glovo']) {
        if (plat) st.push(D.stmt(`INSERT INTO prices (product_id, price_list, price_tetri) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri`, pid, pl, Math.round(plat * 100), pid));
        else st.push(D.stmt('DELETE FROM prices WHERE product_id = ? AND price_list = ?', pid, pl));
      }
      st.push(D.stmt('UPDATE products SET active = 1 WHERE id = ?', pid));
    }
    for (const [pid, base] of CO) {
      st.push(D.stmt(`INSERT INTO prices (product_id, price_list, price_tetri) SELECT ?, 'base', ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?) ON CONFLICT(product_id, price_list) DO UPDATE SET price_tetri = excluded.price_tetri`, pid, Math.round(base * 100), pid));
      st.push(D.stmt('UPDATE products SET active = 1 WHERE id = ?', pid));
    }
    // рецепты кофе и чая (граммовку кофе уточнить у бариста): 8 г кофе; капучино +150 мл молока, латте +200 мл; чай — 1 пакетик; крышка на большой стакан
    const RC = { espresso: [['coffee', 8]], americano: [['coffee', 8], ['cup_lid', 1]], cappuccino: [['coffee', 8], ['milk', 150], ['cup_lid', 1]], latte: [['coffee', 8], ['milk', 200], ['cup_lid', 1]],
      tea_black: [['tea_bag_black', 1], ['cup_lid', 1]], tea_green: [['tea_bag_green', 1], ['cup_lid', 1]], tea_berry: [['tea_bag_berry', 1], ['cup_lid', 1]] };
    for (const [pid, lines] of Object.entries(RC)) {
      st.push(D.stmt('DELETE FROM recipes WHERE product_id = ? AND NOT EXISTS (SELECT 1 FROM recipes r2 WHERE r2.product_id = ? AND r2.ingredient_id NOT IN (\'coffee\', \'milk\', \'cup_lid\', \'tea_bag_black\', \'tea_bag_green\', \'tea_bag_berry\'))', pid, pid));
      for (const [ing, q] of lines) st.push(D.stmt('INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)', pid, ing, q, pid));
    }
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '17') ON CONFLICT(key) DO UPDATE SET value = '17'`));
    await D.batch(st); await refreshComposite(env);
  }
  const v18 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v18.value) < 18) {
    // бумажные стаканчики для кофе и чая — 0,15 ₾ за штуку (малый и большой)
    await D.batch([D.stmt(`UPDATE ingredients SET cost_per_1000_tetri = 15000 WHERE id IN ('cup_capp', 'cup_esp')`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '18') ON CONFLICT(key) DO UPDATE SET value = '18'`)]);
  }
  const v19 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v19.value) < 19) {
    // Ежемесячные расходы заведения (12.11.2026), кроме зарплат и закупки продуктов/напитков. НДС не отмечен — отметьте у тех, где есть счёт-фактура.
    const R = [["იჯარა · Аренда", "rent", 5500], ["კომუნალური · Коммунальные", "utilities", 3000], ["დასუფთავების ხარჯი: ხელსახოცები, ხსნარები, ტილო, საწმენდი საშუალებები · Уборка", "cleaning", 1000], ["სხვა: საჩუქრები თანამშრომლებს, რემონტი, ტაქსი · Прочее", "other", 500], ["თეფშები · Тарелки", "other", 200], ["ფინა პროგრამა · Программа FINA", "software", 150], ["მინის მწმენდავი · Мойщик стёкол", "cleaning", 70], ["ტელეფონი (საუბარი) · Телефон", "utilities", 60]];
    await D.batch([...R.map(([name, cat, gel]) => D.stmt('INSERT INTO recurring_expenses (name, category, amount_tetri, vat_included, day, active) SELECT ?, ?, ?, 0, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM recurring_expenses WHERE name = ?)', name, cat, gel * 100, name)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '19') ON CONFLICT(key) DO UPDATE SET value = '19'`)]);
  }
  const v20 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v20.value) < 20) {
    // Калькуляция кофе заведения (12.11.2026): кофе 13 г на чашку; капучино +100 мл молока, латте +120 мл. Крышки в калькуляции нет — убрана.
    const RC = { espresso: [['coffee', 13]], americano: [['coffee', 13]], cappuccino: [['coffee', 13], ['milk', 100]], latte: [['coffee', 13], ['milk', 120]] };
    const st = [D.stmt(`DELETE FROM recipes WHERE ingredient_id = 'cup_lid' AND product_id IN ('espresso', 'americano', 'cappuccino', 'latte', 'tea_black', 'tea_green', 'tea_berry')`)];
    for (const [pid, lines] of Object.entries(RC)) {
      st.push(D.stmt(`DELETE FROM recipes WHERE product_id = ? AND ingredient_id IN ('coffee', 'milk')`, pid));
      for (const [ing, q] of lines) st.push(D.stmt('INSERT OR REPLACE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)', pid, ing, q, pid));
    }
    st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '20') ON CONFLICT(key) DO UPDATE SET value = '20'`));
    await D.batch(st);
  }
  const v21 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v21.value) < 21) {
    // фото новых напитков, пива и вина (иллюстрации в стиле меню) — только где фото ещё нет
    const PH = {"cappy_berry": "/img/drink-cappy_berry-600.webp", "staropramen": "/img/beer-staropramen-600.webp", "cappy_apple": "/img/drink-cappy_apple-600.webp", "burakhi": "/img/drink-burakhi-600.webp", "icetea_mango": "/img/drink-icetea_mango-600.webp", "cappy_orange": "/img/drink-cappy_orange-600.webp", "lowenbrau": "/img/beer-lowenbrau-600.webp", "cappy_peach": "/img/drink-cappy_peach-600.webp", "cappy_grapefruit": "/img/drink-cappy_grapefruit-600.webp", "icetea_berry": "/img/drink-icetea_berry-600.webp", "limon_fresh": "/img/drink-limon_fresh-600.webp", "pepsi": "/img/drink-pepsi-600.webp", "rkatsiteli": "/img/wine-rkatsiteli-600.webp", "icetea_lemon": "/img/drink-icetea_lemon-600.webp", "corona": "/img/beer-corona-600.webp", "estrella": "/img/beer-estrella-600.webp", "tsolikauri": "/img/wine-tsolikauri-600.webp", "cappy_cherry": "/img/drink-cappy_cherry-600.webp", "icetea_peach": "/img/drink-icetea_peach-600.webp"};
    await D.batch([...Object.entries(PH).map(([id, ph]) => D.stmt(`UPDATE products SET photo = ? WHERE id = ? AND (photo IS NULL OR photo = '')`, ph, id)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '21') ON CONFLICT(key) DO UPDATE SET value = '21'`)]);
  }
  const v22 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v22.value) < 22) {
    // холодный чай — Fuse Tea
    const N = [['icetea_peach', 'Fuse Tea ატამი', 'Fuse Tea peach', 'Fuse Tea персик'], ['icetea_lemon', 'Fuse Tea ლიმონი', 'Fuse Tea lemon', 'Fuse Tea лимон'],
      ['icetea_mango', 'Fuse Tea მანგო-ანანასი', 'Fuse Tea mango-pineapple', 'Fuse Tea манго-ананас'], ['icetea_berry', 'Fuse Tea ტყის კენკრა', 'Fuse Tea forest berries', 'Fuse Tea лесные ягоды']];
    await D.batch([...N.map(([id, ka, en, ru]) => D.stmt('UPDATE products SET name_ka = ?, name_en = ?, name_ru = ? WHERE id = ?', ka, en, ru, id)),
      ...N.map(([id, ka, , ru]) => D.stmt(`UPDATE ingredients SET name = ? WHERE id = ?`, ka + ' 0,5 ლ · ' + ru + ' 0,5 л', 'st_' + id)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '22') ON CONFLICT(key) DO UPDATE SET value = '22'`)]);
  }
  const v23 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v23.value) < 23) {
    // Cappy персик убран из продажи (12.11.2026)
    await D.batch([D.stmt(`UPDATE products SET active = 0 WHERE id = 'cappy_peach'`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '23') ON CONFLICT(key) DO UPDATE SET value = '23'`)]);
  }
  const v24 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v24.value) < 24) {
    // вода, Боржоми и соки Sandora 0,95 снова в продаже (фото прислали 12.11.2026); склад — по бутылке/пачке
    const P = [['water', 'წყალი 0,5 ლ · Вода негазированная 0,5 л'], ['borjomi', 'ბორჯომი 0,5 ლ · Боржоми 0,5 л'], ['juice', 'Sandora ალუბალი 0,95 ლ · Сок Sandora вишнёвый 0,95 л'],
      ['juice_orange', 'Sandora ფორთოხალი 0,95 ლ · Сок Sandora апельсиновый 0,95 л'], ['juice_apple', 'Sandora ვაშლი 0,95 ლ · Сок Sandora яблочный 0,95 л']];
    const st = [];
    for (const [pid, nm] of P) st.push(D.stmt('UPDATE products SET active = 1 WHERE id = ? AND archived = 0 AND EXISTS (SELECT 1 FROM prices WHERE product_id = ? AND price_list = \'base\')', pid, pid),
      D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES (?, ?, 'pcs')`, 'st_' + pid, nm),
      D.stmt('INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)', pid, 'st_' + pid, pid));
    st.push(D.stmt(`UPDATE products SET name_ru = 'Сок Sandora вишнёвый', name_ka = 'Sandora ალუბლის წვენი', name_en = 'Sandora cherry juice' WHERE id = 'juice'`),
      D.stmt(`UPDATE products SET name_ru = 'Сок Sandora апельсиновый', name_ka = 'Sandora ფორთოხლის წვენი', name_en = 'Sandora orange juice' WHERE id = 'juice_orange'`),
      D.stmt(`UPDATE products SET name_ru = 'Сок Sandora яблочный', name_ka = 'Sandora ვაშლის წვენი', name_en = 'Sandora apple juice' WHERE id = 'juice_apple'`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '24') ON CONFLICT(key) DO UPDATE SET value = '24'`));
    await D.batch(st);
  }
  const v25 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v25.value) < 25) {
    // зарплаты «чистыми»: 2% пенсии вычитается из оговорённой суммы (1400 → 1372 на руки), компания доплачивает 2%
    await D.batch([D.stmt(`UPDATE people SET pay_is_net = 2 WHERE pay_is_net = 1 AND owner = 0`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '25') ON CONFLICT(key) DO UPDATE SET value = '25'`)]);
  }
  const v26 = await D.one(`SELECT value FROM settings WHERE key = 'data_v'`);
  if (Number(v26.value) < 26) {
    // типичный срок хранения в холодильнике после поставки (дней) — владелец поправит в «Ингредиентах»
    const SH = { mozz: 10, cream_raw: 5, milk: 5, chick: 3, beef_mince: 2, salmon_f: 3, basil: 4, rucola: 4, dill: 5, tomato: 6, champ: 5, bacon: 10, ham_turkey: 7,
      pepp: 21, chorizo: 21, salami: 21, feta: 10, mascarpone: 7, dorblu: 14, cheddar: 21, parmesan: 30, onion_red: 14, jalapeno: 30, pickles: 30, pineapple: 30 };
    await D.batch([...Object.entries(SH).map(([k, v]) => D.stmt('UPDATE ingredients SET shelf_days = ? WHERE id = ? AND shelf_days = 0', v, k)),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('data_v', '26') ON CONFLICT(key) DO UPDATE SET value = '26'`)]);
  }
  // фото новых комбо в общем стиле (пиццы + напитки на тёмном фоне), если владелец не поставил своё
  for (const [id, old] of [['spicy', '/img/pizza-diablo-600.webp'], ['coffee', '/img/pizza-marg-600.webp'], ['family', '/img/pizza-hawaii-600.webp']])
    await D.run('UPDATE combos SET photo = ? WHERE id = ? AND photo = ?', `/img/combo-${id}-600.webp`, id, old).catch(() => {});
  // Индексы — чтобы отчёты, касса и кухня работали быстро и через год, когда заказов будут десятки тысяч
  for (const [n, t, c] of [['ix_orders_created', 'orders', 'created_at'], ['ix_orders_status', 'orders', 'status'], ['ix_orders_shift', 'orders', 'shift_id'], ['ix_orders_channel', 'orders', 'channel, created_at'],
    ['ix_oi_order', 'order_items', 'order_id'], ['ix_oi_product', 'order_items', 'product_id'], ['ix_pay_order', 'payments', 'order_id'], ['ix_pay_shift', 'payments', 'shift_id'], ['ix_pay_created', 'payments', 'created_at'],
    ['ix_sm_ing', 'stock_moves', 'ingredient_id'], ['ix_sm_order', 'stock_moves', 'order_id'], ['ix_sm_created', 'stock_moves', 'created_at'], ['ix_audit_created', 'audit_log', 'created_at'], ['ix_audit_action', 'audit_log', 'action'],
    ['ix_login_created', 'login_attempts', 'created_at'], ['ix_login_ip', 'login_attempts', 'ip'], ['ix_sess_staff', 'sessions', 'staff_id'], ['ix_kp_order', 'kitchen_prints', 'order_id'], ['ix_stages_order', 'order_stages', 'order_id'],
    ['ix_cash_shift', 'cash_moves', 'shift_id'], ['ix_orders_phone', 'orders', 'customer_phone'], ['ix_ts_staff', 'timesheet', 'staff_id']])
    await D.run(`CREATE INDEX IF NOT EXISTS ${n} ON ${t}(${c})`).catch(() => {});
  await seedComboSets(env); await seedPartySets(env).catch(() => {}); await partyDescUpdate(env).catch(() => {});
  { // v5: фото пицц на том же коричневом фоне, что и комбо; «Для компании» включено по умолчанию (−10%)
    const v5 = await D.one(`SELECT value FROM settings WHERE key = 'look_v'`).catch(() => null);
    if (!v5 || Number(v5.value) < 7) {
      const PH = PHOTO_B;
      await D.batch([...PH.map((n) => D.stmt('UPDATE products SET photo = ? WHERE photo IN (?, ?)', `/img/${n}-c-600.webp`, `/img/${n}-600.webp`, `/img/${n}-b-600.webp`)),
        D.stmt(`INSERT INTO settings (key, value) VALUES ('party', '{"on":true,"pct":10}') ON CONFLICT(key) DO NOTHING`),
        D.stmt(`UPDATE ingredients SET archived = 1 WHERE id IN (SELECT r.ingredient_id FROM recipes r JOIN products p ON p.id = r.product_id WHERE p.category_id = 'wine')
          AND id NOT IN (SELECT r.ingredient_id FROM recipes r JOIN products p ON p.id = r.product_id WHERE p.category_id != 'wine')`), // вино убрали совсем
        D.stmt(`UPDATE products SET active = 0, archived = 1 WHERE category_id = 'wine'`), D.stmt(`UPDATE categories SET active = 0 WHERE id = 'wine'`),
        D.stmt(`INSERT INTO settings (key, value) VALUES ('look_v', '7') ON CONFLICT(key) DO UPDATE SET value = '7'`)]);
      const pc = await partyConf(env); await partyDescUpdate(env).catch(() => {});
      const rows = await D.all(`SELECT id, slots FROM combos WHERE grp = 'party' ORDER BY sort, id`);
      const BP = await balancedPrices(env, rows.map((s0) => JSON.parse(s0.slots || '[]').map((x) => (x.ids || [])[0]).filter(Boolean)), pc.pct);
      for (const [i, s0] of rows.entries()) await D.run('UPDATE combos SET price_tetri = ?, active = ? WHERE id = ?', BP[i].price, pc.on ? 1 : 0, s0.id);
    }
  }
  { // новые фото: Cappy грейпфрут 0,5 л; Estrella Galicia 0,5 л вместо Estrella Damm 0,33
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (!dv || Number(dv.value) < 1) await D.batch([
      D.stmt(`UPDATE products SET photo = '/img/drink-cappy_grapefruit05-c-600.webp' WHERE id = 'cappy_grapefruit'`),
      D.stmt(`UPDATE products SET photo = '/img/beer-estrella05-c-600.webp', name_ru = 'Estrella Galicia', name_en = 'Estrella Galicia', name_ka = 'ესტრელა გალისია', size = '0,5 л' WHERE id = 'estrella'`),
      D.stmt(`UPDATE ingredients SET name = REPLACE(REPLACE(name, 'Estrella Damm', 'Estrella Galicia 0,5 л'), 'ESTRELLA DAMM', 'ESTRELLA GALICIA 0,5 ლ') WHERE name LIKE '%Estrella Damm%' OR name LIKE '%ESTRELLA DAMM%'`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`)]);
  }
  { // 26.11.2026: новые напитки — Pepsi Zero 0,33 и квас «Лидский» 0,5 (зал / Wolt и Glovo)
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (!dv || Number(dv.value) < 2) {
      const N = [['pepsi_zero', 'პეპსი ზერო', 'Pepsi Zero', 'Pepsi Zero', '0,33 л', 106, 3.3, 4, 'პეპსი ზერო 0,33 ლ · Pepsi Zero 0,33 л'],
        ['kvass', 'კვასი ლიდსკი', 'Lidskiy kvass', 'Квас «Лидский»', '0,5 л', 142, 4.5, 5.5, 'კვასი ლიდსკი 0,5 ლ ქილა · Квас Лидский 0,5 л банка']];
      const st = [];
      for (const [id, ka, en, ru, size, sort, base, plat, stock] of N) {
        st.push(D.stmt(`INSERT INTO products (id, category_id, name_ka, name_en, name_ru, size, photo, sort, active) VALUES (?, 'drinks', ?,?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING`,
          id, ka, en, ru, size, `/img/drink-${id}-c-600.webp`, sort));
        st.push(D.stmt(`INSERT OR IGNORE INTO ingredients (id, name, unit) VALUES (?, ?, 'pcs')`, 'st_' + id, stock),
          D.stmt('INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) VALUES (?, ?, 1)', id, 'st_' + id));
        for (const [pl, v] of [['base', base], ['wolt', plat], ['glovo', plat]])
          st.push(D.stmt('INSERT INTO prices (product_id, price_list, price_tetri) VALUES (?,?,?) ON CONFLICT(product_id, price_list) DO NOTHING', id, pl, Math.round(v * 100)));
      }
      st.push(D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '2') ON CONFLICT(key) DO UPDATE SET value = '2'`));
      await D.batch(st);
    }
  }
  { // 26.11.2026: в админке вручную завели второй «Pepsi zero» (pepsi-zero-c0c2) со ссылкой на страницу магазина вместо фото — скрываем дубль, остаётся pepsi_zero с фото
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (dv && Number(dv.value) < 3) await D.batch([
      D.stmt(`UPDATE products SET active = 0, archived = 1 WHERE id = 'pepsi-zero-c0c2' AND EXISTS (SELECT 1 FROM products WHERE id = 'pepsi_zero' AND active = 1)`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '3') ON CONFLICT(key) DO UPDATE SET value = '3'`)]);
  }
  { // 26.11.2026: квас и лимонад — наверх, рядом с Pepsi; соки и холодный чай — дальше
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (dv && Number(dv.value) < 4) {
      const ORD = ['water', 'borjomi', 'bakhmaro', 'cola', 'zero', 'sprite', 'fanta', 'pepsi', 'pepsi_zero', 'kvass', 'burakhi', 'limon_fresh',
        'icetea_peach', 'icetea_lemon', 'icetea_mango', 'icetea_berry', 'cappy_apple', 'cappy_cherry', 'cappy_orange', 'cappy_berry', 'cappy_peach', 'cappy_grapefruit', 'juice', 'juice_orange', 'juice_apple'];
      await D.batch([...ORD.map((id, i) => D.stmt(`UPDATE products SET sort = ? WHERE id = ? AND category_id = 'drinks'`, 101 + i, id)),
        D.stmt(`UPDATE products SET sort = 150 WHERE category_id = 'drinks' AND id NOT IN (${ORD.map(() => '?').join(',')}) AND sort < 150`, ...ORD),
        D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '4') ON CONFLICT(key) DO UPDATE SET value = '4'`)]);
    }
  }
  { // 26.11.2026: вода — первой, потом Coca-Cola (старая вкладка админки вернула коле прежний порядок)
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (dv && Number(dv.value) < 5) {
      const ORD = ['water', 'borjomi', 'bakhmaro', 'cola', 'zero', 'sprite', 'fanta', 'pepsi', 'pepsi_zero', 'kvass', 'burakhi', 'limon_fresh',
        'icetea_peach', 'icetea_lemon', 'icetea_mango', 'icetea_berry', 'cappy_apple', 'cappy_cherry', 'cappy_orange', 'cappy_berry', 'cappy_peach', 'cappy_grapefruit', 'juice', 'juice_orange', 'juice_apple'];
      await D.batch([...ORD.map((id, i) => D.stmt(`UPDATE products SET sort = ? WHERE id = ? AND category_id = 'drinks'`, 101 + i, id)),
        D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '5') ON CONFLICT(key) DO UPDATE SET value = '5'`)]);
    }
  }
  { // 26.11.2026: у Cappy персик на фото была срезана крышка — новое фото целиком
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (dv && Number(dv.value) < 6) await D.batch([
      D.stmt(`UPDATE products SET photo = '/img/drink-cappy_peach2-c-600.webp' WHERE id = 'cappy_peach' AND photo LIKE '/img/drink-cappy_peach-%'`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '6') ON CONFLICT(key) DO UPDATE SET value = '6'`)]);
  }
  { // 26.11.2026: Cappy персик — чёткое фото производителя (прошлое было размытым)
    const dv = await D.one(`SELECT value FROM settings WHERE key = 'drinks_v'`).catch(() => null);
    if (dv && Number(dv.value) < 7) await D.batch([
      D.stmt(`UPDATE products SET photo = '/img/drink-cappy_peach3-c-600.webp' WHERE id = 'cappy_peach' AND photo LIKE '/img/drink-cappy_peach%'`),
      D.stmt(`INSERT INTO settings (key, value) VALUES ('drinks_v', '7') ON CONFLICT(key) DO UPDATE SET value = '7'`)]);
  }
  await D.run(`INSERT INTO settings (key, value) VALUES ('schema_mark', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SCHEMA_MARK);
  schemaReady.add(env.DB);
}

// ───────── Онлайн-оплата картой: TBC E-Commerce или Bank of Georgia ─────────
// Ключи банка (client_id, client_secret, apikey) хранятся только в базе, в таблице secrets, и никогда не отдаются наружу — даже в админку.
// Клиент платит на странице банка; данные карты к нам не попадают. «Оплачено» ставим ТОЛЬКО после того, как сами спросили банк о статусе
// (уведомлению от банка не верим на слово — по нему лишь идём проверять).
const PAY_TTL_MIN = 30; // неоплаченный онлайн-заказ закрывается через 30 минут
async function payGw(env) { const g = (await secretGet(env, 'paygw')) || {}; return Object.assign({ bank: 'tbc', client_id: '', client_secret: '', apikey: '', on: false }, g); }
const gwReady = (g) => !!(g.client_id && g.client_secret && (g.bank !== 'tbc' || g.apikey));
const PAY_HTTP_TIMEOUT = 15000;
async function bankFetch(url, opt) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), PAY_HTTP_TIMEOUT);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opt)); const txt = await r.text(); let d = null; try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = { raw: txt.slice(0, 300) }; }
    if (!r.ok) { const m = (d && (d.detail || d.message || d.title || d.error_description || d.error || d.raw)) || ''; throw new HttpError(502, 'bank_error', `Банк ответил ошибкой ${r.status}${m ? ': ' + String(m).slice(0, 160) : ''}`); }
    return d;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'bank_unreachable', 'Банк не отвечает: ' + String(e && e.message || e).slice(0, 120)); }
  finally { clearTimeout(t); }
}
const BANKS = {
  tbc: {
    name: 'TBC Bank',
    async token(g) { const d = await bankFetch('https://api.tbcbank.ge/v1/tpay/access-token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', apikey: g.apikey }, body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret }).toString() });
      if (!d.access_token) throw new HttpError(502, 'bank_auth', 'TBC не выдал доступ — проверьте client_id, client_secret и apikey'); return d.access_token; },
    async create(g, tok, x) {
      const a = Number((x.amount / 100).toFixed(2));
      const d = await bankFetch('https://api.tbcbank.ge/v1/tpay/payments', { method: 'POST', headers: { 'content-type': 'application/json', apikey: g.apikey, authorization: 'Bearer ' + tok },
        body: JSON.stringify({ amount: { currency: 'GEL', total: a, subTotal: a, tax: 0, shipping: 0 }, returnurl: x.returnUrl, callbackUrl: x.callbackUrl, merchantPaymentId: x.ref, extra: x.ref.slice(0, 25), expirationMinutes: 12, language: x.lang === 'ka' ? 'KA' : 'EN', description: String(x.desc || '').replace(/[^\x20-\x7E]/g, '').slice(0, 30), skipInfoMessage: true }) });
      const u = (d.links || []).find((l) => l.rel === 'approval_url'); if (!d.payId || !u) throw new HttpError(502, 'bank_error', 'TBC не вернул ссылку на оплату');
      return { ext: d.payId, url: u.uri };
    },
    async status(g, tok, ext) {
      const d = await bankFetch('https://api.tbcbank.ge/v1/tpay/payments/' + encodeURIComponent(ext), { headers: { apikey: g.apikey, authorization: 'Bearer ' + tok } });
      const s = String(d.status || ''); const amt = Math.round(Number(d.amount || 0) * 100);
      return { state: s === 'Succeeded' ? 'paid' : (s === 'Failed' || s === 'Expired') ? 'failed' : (s === 'Returned' || s === 'PartialReturned') ? 'refunded' : 'pending', amount: amt, refunded: Math.round(Number(d.returnedAmount || 0) * 100), method: d.paymentMethod != null ? String(d.paymentMethod) : null, raw: s };
    },
    async refund(g, tok, ext, amount) { await bankFetch(`https://api.tbcbank.ge/v1/tpay/payments/${encodeURIComponent(ext)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: g.apikey, authorization: 'Bearer ' + tok }, body: JSON.stringify({ amount: Number((amount / 100).toFixed(2)) }) }); }
  },
  flitt: {
    name: 'Flitt',
    // подпись Flitt: sha1(секрет|значения всех непустых полей по алфавиту ключей)
    async sign(g, req) { const v = [g.client_secret]; for (const k of Object.keys(req).sort()) { if (k === 'signature' || k === 'response_signature_string') continue; const x = req[k]; if (x === '' || x == null) continue; v.push(String(x)); }
      const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(v.join('|'))); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); },
    async call(g, path, req) { req.merchant_id = Number(g.client_id); req.signature = await BANKS.flitt.sign(g, req);
      const d = await bankFetch('https://pay.flitt.com/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: req }) }); const r = (d && d.response) || {};
      if (r.response_status !== 'success') throw new HttpError(502, 'bank_error', 'Flitt: ' + String(r.error_message || 'ошибка') + (r.error_code ? ' (' + r.error_code + ')' : '')); return r; },
    async token(g) { // у Flitt нет входа — проверяем ключи запросом статуса несуществующего заказа: «нет такого заказа» = ключи верные
      try { await BANKS.flitt.call(g, 'status/order_id', { order_id: 'PRPROBE' + randomHex(4) }); }
      catch (e) { if (/signature|merchant|1007|1013|1014|1011/i.test(e.message)) throw new HttpError(502, 'bank_auth', 'Flitt не принял ключи — проверьте Merchant ID и Secret key (' + e.message.replace(/^Flitt: /, '') + ')'); if (e.code === 'bank_unreachable') throw e; }
      return 'ok'; },
    async create(g, tok, x) {
      const r = await BANKS.flitt.call(g, 'checkout/url', { order_id: x.ref, order_desc: String(x.desc || 'Pizza Room').slice(0, 1024), amount: x.amount, currency: 'GEL', response_url: x.returnUrl, server_callback_url: x.callbackUrl, lang: ['ka', 'ru', 'en'].includes(x.lang) ? x.lang : 'en', lifetime: 900 });
      if (!r.checkout_url) throw new HttpError(502, 'bank_error', 'Flitt не вернул ссылку на оплату'); return { ext: x.ref, url: r.checkout_url };
    },
    async status(g, tok, ext) {
      const r = await BANKS.flitt.call(g, 'status/order_id', { order_id: ext }); const s = String(r.order_status || '');
      return { state: s === 'approved' ? 'paid' : (s === 'declined' || s === 'expired') ? 'failed' : s === 'reversed' ? 'refunded' : 'pending', amount: Number(r.actual_amount || r.amount || 0), refunded: Number(r.reversal_amount || 0), method: r.payment_system || null, raw: s };
    },
    async refund(g, tok, ext, amount) { const r = await BANKS.flitt.call(g, 'reverse/order_id', { order_id: ext, amount, currency: 'GEL' }); if (r.reverse_status && r.reverse_status !== 'approved') throw new HttpError(502, 'bank_error', 'Flitt не провёл возврат: ' + r.reverse_status); }
  },
  bog: {
    name: 'Bank of Georgia',
    async token(g) { const d = await bankFetch('https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + btoa(g.client_id + ':' + g.client_secret) }, body: 'grant_type=client_credentials' });
      if (!d.access_token) throw new HttpError(502, 'bank_auth', 'Bank of Georgia не выдал доступ — проверьте client_id и client_secret'); return d.access_token; },
    async create(g, tok, x) {
      const a = Number((x.amount / 100).toFixed(2));
      const d = await bankFetch('https://api.bog.ge/payments/v1/ecommerce/orders', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, 'accept-language': x.lang === 'ka' ? 'ka' : 'en', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ callback_url: x.callbackUrl, external_order_id: x.ref, ttl: 15, purchase_units: { currency: 'GEL', total_amount: a, basket: [{ product_id: 'order', description: String(x.desc || 'Pizza Room').slice(0, 60), quantity: 1, unit_price: a }] }, redirect_urls: { success: x.returnUrl, fail: x.returnUrl } }) });
      const u = d._links && d._links.redirect && d._links.redirect.href; if (!d.id || !u) throw new HttpError(502, 'bank_error', 'Bank of Georgia не вернул ссылку на оплату');
      return { ext: d.id, url: u };
    },
    async status(g, tok, ext) {
      const d = await bankFetch('https://api.bog.ge/payments/v1/receipt/' + encodeURIComponent(ext), { headers: { authorization: 'Bearer ' + tok } });
      const k = String((d.order_status && d.order_status.key) || ''); const pu = d.purchase_units || {};
      return { state: k === 'completed' ? 'paid' : k === 'rejected' ? 'failed' : (k === 'refunded' || k === 'refunded_partially') ? 'refunded' : 'pending', amount: Math.round(Number(pu.transfer_amount || 0) * 100), refunded: Math.round(Number(pu.refund_amount || 0) * 100), method: (d.payment_detail && d.payment_detail.transfer_method && d.payment_detail.transfer_method.key) || null, raw: k };
    },
    async refund(g, tok, ext, amount) { await bankFetch('https://api.bog.ge/payments/v1/payment/refund/' + encodeURIComponent(ext), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ amount: Number((amount / 100).toFixed(2)) }) }); }
  }
};
const payOrigin = (request) => { const u = new URL(request.url); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? u.origin : 'https://' + u.host; };
// новый платёж в банке: order_id = null — тестовый платёж владельца на 1 ₾
async function payStart(env, request, { orderId, amount, lang, desc, back }) {
  const g = await payGw(env); if (!gwReady(g)) fail(409, 'no_gateway', 'Онлайн-оплата не настроена');
  const B = BANKS[g.bank]; const ref = 'PR' + randomHex(9).toUpperCase(); const o = payOrigin(request);
  const r = await db(env).run('INSERT INTO online_pays (order_id, bank, ref, amount_tetri, status) VALUES (?,?,?,?,?)', orderId, g.bank, ref, amount, 'created');
  const pid = r.last_row_id;
  try {
    const tok = await B.token(g);
    const x = await B.create(g, tok, { amount, ref, lang, desc, returnUrl: o + back, callbackUrl: o + '/api/pay/cb?ref=' + ref });
    await db(env).run('UPDATE online_pays SET ext_id = ? WHERE id = ?', x.ext, pid);
    if (!/^https:\/\//i.test(String(x.url || ''))) throw new Error('bank returned a non-https payment page');
    return { pid, ref, url: x.url };
  } catch (e) { await db(env).run(`UPDATE online_pays SET status = 'failed', note = ? WHERE id = ?`, String(e && e.message || e).slice(0, 200), pid); throw e; }
}
// спросить банк и записать итог. Возвращает актуальную строку платежа.
async function payCheck(env, p) {
  if (!p || !p.ext_id || p.status === 'refunded') return p;
  const g = await payGw(env); if (!gwReady(g) || g.bank !== p.bank) return p;
  const B = BANKS[p.bank]; const D = db(env);
  await D.run(`UPDATE online_pays SET checked_at = datetime('now') WHERE id = ?`, p.id);
  const s = await B.status(g, await B.token(g), p.ext_id);
  if (s.state === 'paid' && p.status !== 'paid') {
    if (s.amount + 1 < p.amount_tetri) { await D.run(`UPDATE online_pays SET note = ? WHERE id = ?`, `Банк подтвердил меньшую сумму: ${(s.amount / 100).toFixed(2)} ₾`, p.id); await notify(env, `⚠️ Онлайн-оплата ${p.ref}: банк подтвердил ${(s.amount / 100).toFixed(2)} ₾ вместо ${(p.amount_tetri / 100).toFixed(2)} ₾. Проверьте в админке → Онлайн-оплата.`); return D.one('SELECT * FROM online_pays WHERE id = ?', p.id); }
    const ch = await D.run(`UPDATE online_pays SET status = 'paid', paid_at = datetime('now'), method = ? WHERE id = ? AND status != 'paid'`, s.method, p.id);
    if (ch.changes && p.order_id) {
      await D.run(`UPDATE orders SET pay_state = 'paid' WHERE id = ? AND status = 'open'`, p.order_id);
      const o = await loadOrder(env, p.order_id);
      if (o.status === 'cancelled') { // оплата пришла, когда заказ уже закрыт — сразу возвращаем деньги
        try { await payRefund(env, Object.assign({}, p, { status: 'paid' }), null, 'Оплата пришла после закрытия заказа'); } catch (e) { await notify(env, `⚠️ Оплата ${(s.amount / 100).toFixed(2)} ₾ пришла по закрытому заказу №${o.id}. Верните вручную: админка → Онлайн-оплата.`); }
        return D.one('SELECT * FROM online_pays WHERE id = ?', p.id);
      }
      const tL = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
      const w = o.want_at ? new Date(Date.parse(o.want_at.replace(' ', 'T') + 'Z') + 4 * 3600e3).toISOString() : null;
      await audit(env, null, 'site.paid_online', 'order', o.id, { ref: p.ref, bank: p.bank, amount_tetri: s.amount });
      await notify(env, `Новый заказ с сайта №${o.id}: ${(o.total_tetri / 100).toFixed(2)} ₾ — 💳 ОПЛАЧЕН ОНЛАЙН (${BANKS[p.bank].name}), ${o.customer_name || ''}, ${o.customer_phone || ''}${w ? ' · ⏰ КО ВРЕМЕНИ: ' + (w.slice(0, 10) === tL ? 'сегодня ' : 'завтра ') + w.slice(11, 16) : ''}`);
    } else if (ch.changes) await notify(env, `✅ Тестовая онлайн-оплата ${(s.amount / 100).toFixed(2)} ₾ прошла (${BANKS[p.bank].name}). Верните её в админке → Онлайн-оплата.`);
  } else if (s.state === 'failed' && p.status === 'created') {
    await D.run(`UPDATE online_pays SET status = 'failed', note = ? WHERE id = ?`, 'Банк: ' + s.raw, p.id);
    if (p.order_id) await D.run(`UPDATE orders SET pay_state = 'failed', status = 'cancelled', cancelled_at = ?, cancel_reason = 'Онлайн-оплата не прошла' WHERE id = ? AND status = 'open' AND accepted_at IS NULL AND COALESCE(pay_state, '') = 'pending'`, isoNow(), p.order_id);
  } else if (s.state === 'refunded' && p.status !== 'refunded') {
    await D.run(`UPDATE online_pays SET status = 'refunded', refunded_tetri = ?, refunded_at = COALESCE(refunded_at, datetime('now')) WHERE id = ?`, s.refunded || p.amount_tetri, p.id);
    if (p.order_id) await D.run(`UPDATE orders SET pay_state = 'refunded' WHERE id = ? AND status NOT IN ('paid','cancelled')`, p.order_id);
  }
  return D.one('SELECT * FROM online_pays WHERE id = ?', p.id);
}
async function payRefund(env, p, staffId, why) {
  if (!p || p.status !== 'paid') fail(409, 'not_paid', 'Возвращать нечего: платёж не оплачен или уже возвращён');
  const g = await payGw(env); if (!gwReady(g) || g.bank !== p.bank) fail(409, 'no_gateway', 'Онлайн-оплата не настроена для этого банка');
  const B = BANKS[p.bank]; await B.refund(g, await B.token(g), p.ext_id, p.amount_tetri);
  await db(env).run(`UPDATE online_pays SET status = 'refunded', refunded_tetri = ?, refunded_at = datetime('now'), note = ? WHERE id = ?`, p.amount_tetri, String(why || '').slice(0, 200), p.id);
  if (p.order_id) await db(env).run(`UPDATE orders SET pay_state = 'refunded' WHERE id = ? AND status NOT IN ('paid','cancelled')`, p.order_id); // закрытый заказ «заморожен» — итог виден в online_pays
  await audit(env, staffId, 'pay.refund', 'online_pay', p.id, { ref: p.ref, order_id: p.order_id, amount_tetri: p.amount_tetri, why });
  await notify(env, `↩️ Возврат онлайн-оплаты ${(p.amount_tetri / 100).toFixed(2)} ₾${p.order_id ? ' по заказу №' + p.order_id : ' (тестовый платёж)'}. ${why || ''}`);
}
// неоплаченные онлайн-заказы: через 10 минут спрашиваем банк сами, через 30 минут закрываем
async function paySweep(env) {
  const rows = await db(env).all(`SELECT p.* FROM online_pays p WHERE p.status = 'created' AND p.created_at < datetime('now', '-10 minutes') AND (p.checked_at IS NULL OR p.checked_at < datetime('now', '-2 minutes')) ORDER BY p.id LIMIT 3`);
  for (const p of rows) { let q = p; try { q = await payCheck(env, p); } catch (e) {}
    if (q && q.status === 'created' && Date.parse(p.created_at.replace(' ', 'T') + 'Z') < Date.now() - PAY_TTL_MIN * 60e3) {
      await db(env).run(`UPDATE online_pays SET status = 'failed', note = 'Не оплачен за ${PAY_TTL_MIN} минут' WHERE id = ? AND status = 'created'`, p.id);
      if (p.order_id) await db(env).run(`UPDATE orders SET pay_state = 'failed', status = 'cancelled', cancelled_at = ?, cancel_reason = 'Онлайн-оплата не завершена' WHERE id = ? AND status = 'open' AND COALESCE(pay_state, '') = 'pending'`, isoNow(), p.order_id);
    } }
}
// уведомление банка: только повод проверить статус у самого банка
on('POST', '/api/pay/cb', null, async ({ env, url }) => {
  const ref = String(url.searchParams.get('ref') || '').slice(0, 40); const p = ref ? await db(env).one('SELECT * FROM online_pays WHERE ref = ?', ref) : null;
  if (p) { try { await payCheck(env, p); } catch (e) { console.error('pay_cb', e && e.message); } }
  return { ok: true };
});
on('GET', '/api/paygw', 'settings.edit', async ({ env, me, request }) => {
  ownerOnly(me); const g = await payGw(env); const o = payOrigin(request);
  const list = await db(env).all(`SELECT p.*, o.customer_name, o.status AS order_status FROM online_pays p LEFT JOIN orders o ON o.id = p.order_id ORDER BY p.id DESC LIMIT 60`);
  const S = await getSettings(env); const c = S.company || {};
  return { bank: g.bank, client_id: g.client_id, has_secret: !!g.client_secret, has_apikey: !!g.apikey, on: !!g.on && gwReady(g), ready: gwReady(g), checked: g.checked || null,
    callback: o + '/api/pay/cb', return_url: o + '/', legal: ['terms', 'refund', 'privacy'].map((k) => o + '/' + k), company_ok: !!(c.tin && c.addr_ka), list };
});
on('PUT', '/api/paygw', 'settings.edit', async ({ env, me, body }) => {
  ownerOnly(me); const g = await payGw(env);
  if (body.bank != null) { if (!['tbc', 'bog', 'flitt'].includes(body.bank)) fail(400, 'bad_bank', 'Банк: TBC, Bank of Georgia или Flitt'); if (body.bank !== g.bank) { g.bank = body.bank; g.on = false; g.checked = null; } }
  const clean = (v, n) => { const s = String(v || '').trim(); if (s.length > 300 || /\s/.test(s)) fail(400, 'bad_' + n, 'Проверьте поле ' + n + ': без пробелов'); return s; };
  if (body.client_id != null) { const v = clean(body.client_id, 'client_id'); if (v !== g.client_id) { g.client_id = v; g.on = false; g.checked = null; } }
  if (body.client_secret) { g.client_secret = clean(body.client_secret, 'client_secret'); g.on = false; g.checked = null; }
  if (body.apikey) { g.apikey = clean(body.apikey, 'apikey'); g.on = false; g.checked = null; }
  if (body.on === true) {
    if (!gwReady(g)) fail(400, 'not_ready', g.bank === 'tbc' ? 'Сначала введите client_id, client_secret и apikey' : g.bank === 'flitt' ? 'Сначала введите Merchant ID и Secret key' : 'Сначала введите client_id и client_secret');
    if (!g.checked) fail(400, 'not_checked', 'Сначала нажмите «Проверить связь с банком»');
    const c = (await getSettings(env)).company || {}; if (!c.tin || !c.addr_ka) fail(400, 'no_company', 'Сначала заполните реквизиты компании (ID и юридический адрес)');
    g.on = true;
  } else if (body.on === false) g.on = false;
  await secretSet(env, 'paygw', g);
  await audit(env, me.id, 'paygw.change', 'settings', 'paygw', { bank: g.bank, on: g.on, client_id_set: !!g.client_id, secret_changed: !!body.client_secret, apikey_changed: !!body.apikey });
  return { ok: true, on: g.on };
});
on('POST', '/api/paygw/check', 'settings.edit', async ({ env, me }) => {
  ownerOnly(me); const g = await payGw(env); if (!gwReady(g)) fail(400, 'not_ready', 'Сначала введите ключи банка');
  await BANKS[g.bank].token(g); g.checked = isoNow(); await secretSet(env, 'paygw', g);
  await audit(env, me.id, 'paygw.check', 'settings', 'paygw', { bank: g.bank, ok: true });
  return { ok: true, bank: BANKS[g.bank].name };
});
on('POST', '/api/paygw/test', 'settings.edit', async ({ env, me, request }) => {
  ownerOnly(me); const r = await payStart(env, request, { orderId: null, amount: 100, lang: 'ka', desc: 'Pizza Room test', back: '/kassa/?paytest=1' });
  await audit(env, me.id, 'paygw.test', 'online_pay', r.pid, { ref: r.ref }); return { url: r.url, id: r.pid };
});
on('POST', '/api/paygw/:id/check', 'settings.edit', async ({ env, me, params }) => {
  ownerOnly(me); const p = await db(env).one('SELECT * FROM online_pays WHERE id = ?', int(params.id, 'id')); if (!p) fail(404, 'not_found', 'Платёж не найден');
  return payCheck(env, p);
});
on('POST', '/api/paygw/:id/refund', 'settings.edit', async ({ env, me, params, body }) => {
  ownerOnly(me); const p = await db(env).one('SELECT * FROM online_pays WHERE id = ?', int(params.id, 'id')); if (!p) fail(404, 'not_found', 'Платёж не найден');
  const why = String(body.reason || '').trim(); if (p.order_id && why.length < 3) fail(400, 'no_reason', 'Укажите причину возврата');
  await payRefund(env, p, me.id, why || 'Тестовый платёж'); return { ok: true };
});

// ───────── Страницы для банка и клиентов: условия, возврат, конфиденциальность (3 языка, реквизиты — из админки) ─────────
const LEGAL_T = {
  ru: { terms: 'Условия использования и продажи', refund: 'Возврат денег и отмена заказа', privacy: 'Политика конфиденциальности', company: 'Продавец', id: 'Идентификационный код', addr: 'Юридический адрес', place: 'Пиццерия', phone: 'Телефон', email: 'Эл. почта', upd: 'Обновлено', back: 'На сайт', hours: 'Часы работы' },
  en: { terms: 'Terms of use and sale', refund: 'Refunds and cancellations', privacy: 'Privacy policy', company: 'Seller', id: 'Identification code', addr: 'Legal address', place: 'Pizzeria', phone: 'Phone', email: 'Email', upd: 'Updated', back: 'Back to the site', hours: 'Opening hours' },
  ka: { terms: 'გამოყენებისა და გაყიდვის პირობები', refund: 'თანხის დაბრუნება და შეკვეთის გაუქმება', privacy: 'კონფიდენციალურობის პოლიტიკა', company: 'გამყიდველი', id: 'საიდენტიფიკაციო კოდი', addr: 'იურიდიული მისამართი', place: 'პიცერია', phone: 'ტელეფონი', email: 'ელ. ფოსტა', upd: 'განახლდა', back: 'საიტზე დაბრუნება', hours: 'სამუშაო საათები' }
};
function legalBody(doc, lang, v) {
  const P = (...a) => a.map((x) => `<p>${x}</p>`).join(''); const H = (x) => `<h2>${x}</h2>`; const U = (...a) => `<ul>${a.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  const bank = v.bank ? v.bank : { ru: 'банка-партнёра', en: 'our partner bank', ka: 'პარტნიორი ბანკის' }[lang];
  const B = {
    ru: {
      terms: H('1. Общие положения') + P(`Сайт pizzaroom.ge принадлежит компании ${v.name} (ИНН/ID ${v.tin || '—'}). Оформляя заказ на сайте, вы соглашаетесь с этими условиями.`) +
        H('2. Заказ') + P('Заказ оформляется на сайте: вы выбираете блюда, способ получения (доставка или самовывоз) и время. Заказ считается принятым, когда пиццерия его подтвердила — статус виден на странице заказа.', 'Если какое-то блюдо закончилось, мы свяжемся с вами и предложим замену или отмену с полным возвратом денег.') +
        H('3. Цены') + P('Цены указаны в грузинских лари (₾) и включают НДС. Стоимость доставки зависит от зоны и показывается до оформления заказа. Итоговая сумма видна перед подтверждением.') +
        H('4. Оплата') + U('При получении — наличными или картой курьеру либо на кассе в пиццерии.', `Онлайн — картой Visa или Mastercard, Apple Pay или Google Pay на защищённой странице ${bank}. Данные карты вводятся только на странице банка; мы их не получаем и не храним.`, 'Онлайн-заказ передаётся на кухню только после того, как банк подтвердил оплату.') +
        H('5. Доставка и самовывоз') + P(`Доставляем по Батуми в зонах, указанных при оформлении. Обычное время доставки — ${v.tmin}–${v.tmax} минут; в часы пик оно может увеличиться — актуальный статус показан на странице заказа. Самовывоз: ${v.place}. ${LEGAL_T.ru.hours}: ${v.open}–${v.close}.`) +
        H('6. Алкоголь') + P('Пиво продаём только лицам старше 18 лет. Курьер или кассир может попросить документ; без него алкоголь не выдаётся, его стоимость возвращается.') +
        H('7. Аллергены') + P('Если у вас аллергия, позвоните нам до заказа — подскажем состав блюд.') +
        H('8. Возврат и отмена') + P('Правила возврата — на странице «Возврат денег и отмена заказа».') +
        H('9. Споры') + P('Мы решаем вопросы по телефону и WhatsApp. Если договориться не удалось, спор решается по законодательству Грузии.'),
      refund: H('1. Отмена заказа') + U('До того как пиццерия начала готовить заказ — отмена бесплатная, деньги возвращаются полностью.', 'Если заказ отменили мы (блюдо закончилось, не можем доставить и т. п.) — деньги возвращаются полностью.', 'После начала приготовления заказ отменить нельзя: еду готовим специально для вас.') +
        H('2. Ошибка в заказе или качество') + P('Если привезли не то, чего-то не хватает или блюдо испорчено, сообщите нам в течение 24 часов (лучше сразу) — с номером заказа и, если можно, фото. Мы заменим блюдо или вернём деньги за него.') +
        H('3. Как возвращаются деньги') + U('Онлайн-оплата: деньги возвращаются на ту же карту. Мы отправляем возврат в течение 1 рабочего дня; банк зачисляет его обычно за 1–10 рабочих дней — срок зависит от банка, выпустившего карту.', 'Оплата при получении: наличными в пиццерии или переводом.') +
        H('4. Куда обращаться') + P(`Телефон и WhatsApp: ${v.phone}${v.email ? ', эл. почта: ' + v.email : ''}. Укажите номер заказа.`),
      privacy: H('1. Кто обрабатывает данные') + P(`${v.name} (ID ${v.tin || '—'}), ${v.addr || v.place}.`) +
        H('2. Какие данные мы получаем') + U('Имя и номер телефона — чтобы связаться с вами по заказу.', 'Адрес доставки и, если вы разрешили, местоположение на карте — чтобы курьер нашёл вас.', 'Состав заказа, комментарий, время заказа.', 'IP-адрес — для защиты сайта от злоупотреблений.') +
        H('3. Банковские карты') + P(`Оплата картой проходит на странице ${bank}. Номер карты, срок действия и CVV мы не получаем и не храним; банк сообщает нам только, прошла ли оплата.`) +
        H('4. Зачем') + P('Чтобы принять, приготовить и доставить заказ, связаться с вами, вести учёт, который требует закон, и защищать сайт. Мы не продаём данные и не используем их для рекламы третьих лиц.') +
        H('5. Кому передаём') + U('Курьеру — имя, телефон и адрес, чтобы доставить заказ.', 'Банку — сумму и номер платежа для онлайн-оплаты.', 'Хостинг-провайдеру Cloudflare, на серверах которого работает сайт.') +
        H('6. Сколько храним') + P('Данные заказов храним столько, сколько требует налоговое законодательство Грузии. На вашем устройстве имя, телефон и адрес сохраняются только если отмечено «Запомнить мои данные», и не дольше 90 дней; удалить их можно кнопкой «Забыть мои данные» в разделе «Мои заказы».') +
        H('7. Файлы cookie') + P('Мы не используем рекламные и отслеживающие cookie. Сайт хранит в браузере только корзину и ваш последний заказ.') +
        H('8. Ваши права') + P(`По Закону Грузии «О защите персональных данных» вы можете узнать, какие данные о вас есть у нас, исправить их или попросить удалить. Пишите или звоните: ${v.phone}${v.email ? ', ' + v.email : ''}.`)
    },
    en: {
      terms: H('1. General') + P(`The website pizzaroom.ge belongs to ${v.name} (ID ${v.tin || '—'}). By placing an order on the website you accept these terms.`) +
        H('2. Orders') + P('You choose dishes, delivery or pickup, and the time on the website. An order is accepted once the pizzeria confirms it — the status is shown on the order page.', 'If a dish has run out, we will contact you and offer a replacement or a cancellation with a full refund.') +
        H('3. Prices') + P('Prices are in Georgian lari (₾) and include VAT. The delivery fee depends on the zone and is shown before you order. You see the final amount before confirming.') +
        H('4. Payment') + U('On receipt — in cash or by card to the courier or at the pizzeria.', `Online — by Visa or Mastercard, Apple Pay or Google Pay on the secure page of ${bank}. Card details are entered only on the bank’s page; we never receive or store them.`, 'An online order goes to the kitchen only after the bank has confirmed the payment.') +
        H('5. Delivery and pickup') + P(`We deliver within Batumi in the zones shown at checkout. Usual delivery time is ${v.tmin}–${v.tmax} minutes; it may be longer at peak hours — the live status is shown on the order page. Pickup: ${v.place}. ${LEGAL_T.en.hours}: ${v.open}–${v.close}.`) +
        H('6. Alcohol') + P('Beer is sold only to persons over 18. The courier or cashier may ask for ID; without it alcohol is not handed over and its price is refunded.') +
        H('7. Allergens') + P('If you have an allergy, call us before ordering and we will tell you what is in each dish.') +
        H('8. Refunds and cancellations') + P('See the “Refunds and cancellations” page.') +
        H('9. Disputes') + P('We resolve issues by phone and WhatsApp. If we cannot agree, the dispute is settled under the laws of Georgia.'),
      refund: H('1. Cancelling an order') + U('Before the pizzeria starts cooking — free cancellation, full refund.', 'If we cancel the order (a dish has run out, we cannot deliver, etc.) — full refund.', 'Once cooking has started, the order cannot be cancelled: the food is made especially for you.') +
        H('2. Wrong order or quality issue') + P('If something is wrong, missing or spoiled, tell us within 24 hours (preferably right away) with the order number and, if possible, a photo. We will replace the dish or refund it.') +
        H('3. How refunds are paid') + U('Online payment: refunded to the same card. We send the refund within 1 business day; the bank usually credits it within 1–10 business days, depending on the bank that issued the card.', 'Payment on receipt: in cash at the pizzeria or by bank transfer.') +
        H('4. Contact') + P(`Phone and WhatsApp: ${v.phone}${v.email ? ', email: ' + v.email : ''}. Please give your order number.`),
      privacy: H('1. Who processes your data') + P(`${v.name} (ID ${v.tin || '—'}), ${v.addr || v.place}.`) +
        H('2. What data we receive') + U('Name and phone number — to contact you about the order.', 'Delivery address and, if you allow it, your location on the map — so the courier can find you.', 'Order contents, comment, order time.', 'IP address — to protect the website from abuse.') +
        H('3. Bank cards') + P(`Card payments are made on the page of ${bank}. We never receive or store the card number, expiry date or CVV; the bank only tells us whether the payment went through.`) +
        H('4. Why') + P('To accept, cook and deliver your order, contact you, keep the records required by law, and protect the website. We do not sell your data or use it for third-party advertising.') +
        H('5. Who we share it with') + U('The courier — name, phone and address, to deliver the order.', 'The bank — amount and payment number, for online payment.', 'Cloudflare, the hosting provider whose servers run the website.') +
        H('6. How long we keep it') + P('Order records are kept as long as Georgian tax law requires. On your device your name, phone and address are stored only if “Remember my details” is ticked, and for no more than 90 days; you can delete them with “Forget my details” in “My orders”.') +
        H('7. Cookies') + P('We do not use advertising or tracking cookies. The website keeps only your cart and your last order in the browser.') +
        H('8. Your rights') + P(`Under the Law of Georgia on Personal Data Protection you may ask what data we hold about you, correct it or ask us to delete it. Contact us: ${v.phone}${v.email ? ', ' + v.email : ''}.`)
    },
    ka: {
      terms: H('1. ზოგადი დებულებები') + P(`საიტი pizzaroom.ge ეკუთვნის ${v.name}-ს (ს/კ ${v.tin || '—'}). საიტზე შეკვეთის გაფორმებით თქვენ ეთანხმებით ამ პირობებს.`) +
        H('2. შეკვეთა') + P('საიტზე ირჩევთ კერძებს, მიღების წესს (მიტანა ან გატანა) და დროს. შეკვეთა მიღებულად ითვლება, როცა პიცერია მას დაადასტურებს — სტატუსი ჩანს შეკვეთის გვერდზე.', 'თუ რომელიმე კერძი ამოიწურა, დაგიკავშირდებით და შემოგთავაზებთ შეცვლას ან გაუქმებას თანხის სრული დაბრუნებით.') +
        H('3. ფასები') + P('ფასები მითითებულია ლარში (₾) და მოიცავს დღგ-ს. მიტანის ღირებულება დამოკიდებულია ზონაზე და ჩანს შეკვეთამდე. საბოლოო თანხას ხედავთ დადასტურებამდე.') +
        H('4. გადახდა') + U('მიღებისას — ნაღდი ფულით ან ბარათით კურიერთან ან პიცერიის სალაროში.', `ონლაინ — Visa ან Mastercard ბარათით, Apple Pay ან Google Pay-ით ${bank} დაცულ გვერდზე. ბარათის მონაცემები შეგყავთ მხოლოდ ბანკის გვერდზე; ჩვენ მათ არ ვიღებთ და არ ვინახავთ.`, 'ონლაინ შეკვეთა სამზარეულოში გადაეცემა მხოლოდ მას შემდეგ, რაც ბანკი გადახდას დაადასტურებს.') +
        H('5. მიტანა და გატანა') + P(`ვაწვდით ბათუმში, შეკვეთისას მითითებულ ზონებში. მიტანის ჩვეული დრო ${v.tmin}–${v.tmax} წუთია; პიკის საათებში შეიძლება გაიზარდოს — მიმდინარე სტატუსი ჩანს შეკვეთის გვერდზე. გატანა: ${v.place}. ${LEGAL_T.ka.hours}: ${v.open}–${v.close}.`) +
        H('6. ალკოჰოლი') + P('ლუდს ვყიდით მხოლოდ 18 წელს გადაცილებულ პირებზე. კურიერმა ან მოლარემ შეიძლება მოგთხოვოთ დოკუმენტი; მის გარეშე ალკოჰოლი არ გადმოგეცემათ და მისი ღირებულება დაგიბრუნდებათ.') +
        H('7. ალერგენები') + P('თუ ალერგია გაქვთ, შეკვეთამდე დაგვირეკეთ — გეტყვით კერძების შემადგენლობას.') +
        H('8. დაბრუნება და გაუქმება') + P('დაბრუნების წესები იხილეთ გვერდზე „თანხის დაბრუნება და შეკვეთის გაუქმება“.') +
        H('9. დავები') + P('საკითხებს ვაგვარებთ ტელეფონით და WhatsApp-ით. თუ შეთანხმება ვერ მოხერხდა, დავა წყდება საქართველოს კანონმდებლობით.'),
      refund: H('1. შეკვეთის გაუქმება') + U('სანამ პიცერია შეკვეთის მომზადებას დაიწყებს — გაუქმება უფასოა, თანხა სრულად ბრუნდება.', 'თუ შეკვეთას ჩვენ ვაუქმებთ (კერძი ამოიწურა, მიტანა ვერ ხერხდება და ა.შ.) — თანხა სრულად ბრუნდება.', 'მომზადების დაწყების შემდეგ შეკვეთის გაუქმება შეუძლებელია: საჭმელს სპეციალურად თქვენთვის ვამზადებთ.') +
        H('2. შეცდომა შეკვეთაში ან ხარისხი') + P('თუ სხვა რამ მოგიტანეთ, რაღაც აკლია ან კერძი გაფუჭებულია, შეგვატყობინეთ 24 საათის განმავლობაში (სჯობს მაშინვე) — შეკვეთის ნომრით და, თუ შესაძლებელია, ფოტოთი. კერძს შევცვლით ან მის თანხას დაგიბრუნებთ.') +
        H('3. როგორ ბრუნდება თანხა') + U('ონლაინ გადახდა: თანხა ბრუნდება იმავე ბარათზე. დაბრუნებას ვაგზავნით 1 სამუშაო დღეში; ბანკი ჩვეულებრივ ჩარიცხავს 1–10 სამუშაო დღეში — ვადა დამოკიდებულია ბარათის გამცემ ბანკზე.', 'მიღებისას გადახდა: ნაღდი ფულით პიცერიაში ან გადარიცხვით.') +
        H('4. დაგვიკავშირდით') + P(`ტელეფონი და WhatsApp: ${v.phone}${v.email ? ', ელ. ფოსტა: ' + v.email : ''}. მიუთითეთ შეკვეთის ნომერი.`),
      privacy: H('1. ვინ ამუშავებს მონაცემებს') + P(`${v.name} (ს/კ ${v.tin || '—'}), ${v.addr || v.place}.`) +
        H('2. რა მონაცემებს ვიღებთ') + U('სახელი და ტელეფონის ნომერი — შეკვეთასთან დაკავშირებით დასაკავშირებლად.', 'მიტანის მისამართი და, თუ ნებას დაგვრთავთ, მდებარეობა რუკაზე — რომ კურიერმა გიპოვოთ.', 'შეკვეთის შემადგენლობა, კომენტარი, შეკვეთის დრო.', 'IP მისამართი — საიტის ბოროტად გამოყენებისგან დასაცავად.') +
        H('3. საბანკო ბარათები') + P(`ბარათით გადახდა ხდება ${bank} გვერდზე. ბარათის ნომერს, მოქმედების ვადას და CVV-ს ჩვენ არ ვიღებთ და არ ვინახავთ; ბანკი მხოლოდ გვატყობინებს, შესრულდა თუ არა გადახდა.`) +
        H('4. რისთვის') + P('შეკვეთის მისაღებად, მოსამზადებლად და მისატანად, თქვენთან დასაკავშირებლად, კანონით მოთხოვნილი აღრიცხვისთვის და საიტის დასაცავად. მონაცემებს არ ვყიდით და მესამე პირების რეკლამისთვის არ ვიყენებთ.') +
        H('5. ვის გადავცემთ') + U('კურიერს — სახელს, ტელეფონს და მისამართს, შეკვეთის მისატანად.', 'ბანკს — თანხას და გადახდის ნომერს, ონლაინ გადახდისთვის.', 'ჰოსტინგ-პროვაიდერ Cloudflare-ს, რომლის სერვერებზეც მუშაობს საიტი.') +
        H('6. რამდენ ხანს ვინახავთ') + P('შეკვეთების მონაცემებს ვინახავთ იმდენ ხანს, რამდენსაც მოითხოვს საქართველოს საგადასახადო კანონმდებლობა. თქვენს მოწყობილობაზე სახელი, ტელეფონი და მისამართი ინახება მხოლოდ მაშინ, თუ მონიშნულია „დაიმახსოვრე ჩემი მონაცემები“, და არაუმეტეს 90 დღისა; წაშლა შეგიძლიათ ღილაკით „წაშალე ჩემი მონაცემები“ განყოფილებაში „ჩემი შეკვეთები“.') +
        H('7. Cookie ფაილები') + P('სარეკლამო და თვალთვალის cookie-ებს არ ვიყენებთ. საიტი ბრაუზერში ინახავს მხოლოდ კალათას და თქვენს ბოლო შეკვეთას.') +
        H('8. თქვენი უფლებები') + P(`საქართველოს კანონის „პერსონალურ მონაცემთა დაცვის შესახებ“ თანახმად, შეგიძლიათ გაიგოთ, რა მონაცემები გვაქვს თქვენ შესახებ, შეასწოროთ ისინი ან მოითხოვოთ წაშლა. დაგვიკავშირდით: ${v.phone}${v.email ? ', ' + v.email : ''}.`)
    }
  };
  return B[lang][doc];
}
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function legalPage(env, doc, lang) {
  const S = await getSettings(env); const c = S.company || {}; const g = await payGw(env); const T = LEGAL_T[lang];
  const pick = (k) => escH(c[k + '_' + lang] || c[k + '_en'] || c[k + '_ka'] || '');
  const place = { ru: 'Batumi Mall, Батуми', en: 'Batumi Mall, Batumi', ka: 'Batumi Mall, ბათუმი' }[lang];
  const v = { name: pick('name') || 'LTD Pizza Room', tin: escH(c.tin), addr: pick('addr'), place, phone: escH(c.phone || S.info.phone), email: escH(c.email), open: escH(S.info.open), close: escH(S.info.close),
    tmin: escH(S.delivery.tmin || 35), tmax: escH(S.delivery.tmax || 40), bank: g.on && gwReady(g) ? escH(BANKS[g.bank].name) : '' };
  const nav = ['terms', 'refund', 'privacy'].map((d) => d === doc ? `<b>${T[d]}</b>` : `<a href="/${d}?lang=${lang}">${T[d]}</a>`).join(' · ');
  const langs = ['ka', 'en', 'ru'].map((l) => l === lang ? `<b>${l.toUpperCase()}</b>` : `<a href="/${doc}?lang=${l}">${l.toUpperCase()}</a>`).join(' ');
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${T[doc]} — Pizza Room</title>
<style>body{margin:0;background:#F3E9D6;color:#2A1D13;font:16px/1.6 Inter,'Noto Sans Georgian',system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 18px 60px}h1{font-size:26px;line-height:1.25;margin:10px 0 18px}h2{font-size:17px;margin:22px 0 6px}a{color:#8A2414}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px}.nav{font-size:14px;margin-top:6px;color:#5C4632}.card{background:#FBF5EA;border-radius:16px;padding:14px 16px;font-size:14px;margin-top:26px}.card div{display:flex;gap:8px;flex-wrap:wrap}.card span{color:#7A6450;min-width:170px}ul{padding-left:20px}li{margin:4px 0}</style></head>
<body><main><div class="top"><a href="/">← ${T.back}</a><span>${langs}</span></div><div class="nav">${nav}</div><h1>${T[doc]}</h1>${legalBody(doc, lang, v)}
<div class="card"><div><span>${T.company}</span><b>${v.name}</b></div><div><span>${T.id}</span><b>${v.tin || '—'}</b></div>${v.addr ? `<div><span>${T.addr}</span><b>${v.addr}</b></div>` : ''}<div><span>${T.place}</span><b>${place}</b></div><div><span>${T.phone}</span><b>${v.phone}</b></div>${v.email ? `<div><span>${T.email}</span><b>${v.email}</b></div>` : ''}</div>
<p style="font-size:12px;color:#7A6450;margin-top:18px">${T.upd}: ${escH(c.updated || isoNow().slice(0, 10))}</p></main></body></html>`;
  return new Response(html, { headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }, SEC_HEADERS) });
}


// ───────── Страницы для поисковиков (Google, Яндекс) ─────────
// Главные на трёх языках (/, /ru/, /en/), меню с ценами, страница каждой пиццы, перенаправления со старого сайта (WordPress + Ecwid).
const SITE = 'https://pizzaroom.ge';
const YM_ID = 114675747; // счётчик Яндекс.Метрики владельца (аккаунт car24batumi@gmail.com)
const SEO_VERIFY = '<meta name="google-site-verification" content="OVrz1XIXhZk1PymRJWYxzijz_QN6MrxeNNkcKdVLz_8"><meta name="yandex-verification" content="d02d5d2470bfa713"><meta name="yandex-verification" content="a4ba6bc3ac207bd0">';
const ECWID = { 110725460: 'bbq', 125973473: 'chbbq', 141167284: 'carb', 110725414: 'marg', 125987051: 'salmon', 110725413: 'pep', 141161562: 'pepgrill', 141161999: 'diablo',
  373516604: 'burger', 110793318: 'premium', 125973474: 'ranch', 110725415: 'hawaii', 110793149: 'five' };
const LP = { ka: '', ru: '/ru', en: '/en' };
const homeUrl = (l) => SITE + (LP[l] || '') + '/';
const slugOf = (p) => String(p.name_en || p.id).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || p.id;
const SEO_T = {
  ka: { title: 'პიცა ბათუმში მიტანით — Pizza Room · Пицца в Батуми · Pizza Batumi', desc: 'Pizza Room — ცხელი იტალიური პიცა ბათუმში 2018 წლიდან. შეუკვეთეთ ონლაინ: მიტანა ბათუმში 35–40 წუთში ან წაღება Batumi Mall-დან. Пицца в Батуми с доставкой. Pizza delivery Batumi.',
    h1: 'პიცა ბათუმში — Pizza Room', lead: 'ცხელი იტალიური პიცა Batumi Mall-ში 2018 წლიდან. შეუკვეთეთ საიტზე: მიტანა ბათუმში 35–40 წუთში ან თავად წაღება Batumi Mall-დან (ზურაბ გორგილაძის ქ. 88).',
    menu: 'მენიუ და ფასები', pizzas: 'პიცები', order: 'შეკვეთა ონლაინ', all: 'მთელი მენიუ', home: 'მთავარი', del: 'მიტანა ბათუმში 35–40 წუთში', pick: 'წაღება Batumi Mall-დან', hours: 'ყოველდღე', phone: 'ტელეფონი', addr: 'მისამართი', addrv: 'ბათუმი, ზურაბ გორგილაძის ქ. 88, Batumi Mall',
    cm: 'სმ', other: 'სხვა პიცები', ptitle: (n, p) => `${n} — ${p} ₾ | პიცის მიტანა ბათუმში | Pizza Room`, pdesc: (n, d) => `${n}: ${d}. 33 სმ. მიტანა ბათუმში 35–40 წუთში ან წაღება Batumi Mall-დან. შეუკვეთეთ pizzaroom.ge-ზე.`,
    mtitle: 'მენიუ და ფასები — პიცა ბათუმში | Pizza Room', mdesc: 'Pizza Room-ის მენიუ: პიცა 33 სმ, კომბო, სასმელები. ფასები ლარში, მიტანა ბათუმში 35–40 წუთში.', nf: 'გვერდი ვერ მოიძებნა', nfp: 'შესაძლოა მისამართი შეიცვალა. აი, სად შეგიძლიათ გადახვიდეთ:' },
  ru: { title: 'Пицца в Батуми с доставкой — Pizza Room, Batumi Mall', desc: 'Pizza Room — горячая итальянская пицца в Батуми с 2018 года. Закажите онлайн: доставка пиццы по Батуми за 35–40 минут или самовывоз из Batumi Mall. Пицца 33 см от 25 ₾, комбо, напитки.',
    h1: 'Пицца в Батуми — Pizza Room', lead: 'Горячая итальянская пицца в Batumi Mall с 2018 года. Закажите на сайте: доставка пиццы по Батуми за 35–40 минут или самовывоз из Batumi Mall (ул. Зураба Горгиладзе, 88).',
    menu: 'Меню и цены', pizzas: 'Пиццы', order: 'Заказать онлайн', all: 'Всё меню', home: 'Главная', del: 'Доставка по Батуми за 35–40 минут', pick: 'Самовывоз из Batumi Mall', hours: 'Ежедневно', phone: 'Телефон', addr: 'Адрес', addrv: 'Батуми, ул. Зураба Горгиладзе, 88, Batumi Mall',
    cm: 'см', other: 'Другие пиццы', ptitle: (n, p) => `Пицца ${n} — ${p} ₾ | доставка по Батуми | Pizza Room`, pdesc: (n, d) => `Пицца ${n}: ${d}. 33 см. Доставка по Батуми за 35–40 минут или самовывоз из Batumi Mall. Закажите онлайн на pizzaroom.ge.`,
    mtitle: 'Меню и цены — пицца в Батуми | Pizza Room', mdesc: 'Меню Pizza Room: пицца 33 см, комбо, напитки. Цены в лари, доставка по Батуми за 35–40 минут, самовывоз из Batumi Mall.', nf: 'Страница не найдена', nfp: 'Возможно, адрес изменился после обновления сайта. Вот куда можно перейти:' },
  en: { title: 'Pizza delivery in Batumi — Pizza Room, Batumi Mall', desc: 'Pizza Room — hot Italian pizza in Batumi since 2018. Order online: pizza delivery across Batumi in 35–40 minutes or pick up at Batumi Mall. 33 cm pizza from 25 GEL, combos, drinks.',
    h1: 'Pizza in Batumi — Pizza Room', lead: 'Hot Italian pizza at Batumi Mall since 2018. Order online: pizza delivery across Batumi in 35–40 minutes or pick-up at Batumi Mall (88 Zurab Gorgiladze St).',
    menu: 'Menu and prices', pizzas: 'Pizzas', order: 'Order online', all: 'Full menu', home: 'Home', del: 'Delivery across Batumi in 35–40 min', pick: 'Pick-up at Batumi Mall', hours: 'Daily', phone: 'Phone', addr: 'Address', addrv: 'Batumi, 88 Zurab Gorgiladze St, Batumi Mall',
    cm: 'cm', other: 'Other pizzas', ptitle: (n, p) => `${n} pizza — ${p} GEL | delivery in Batumi | Pizza Room`, pdesc: (n, d) => `${n} pizza: ${d}. 33 cm. Delivery across Batumi in 35–40 minutes or pick-up at Batumi Mall. Order online at pizzaroom.ge.`,
    mtitle: 'Menu and prices — pizza in Batumi | Pizza Room', mdesc: 'Pizza Room menu: 33 cm pizza, combos, drinks. Prices in GEL, delivery across Batumi in 35–40 minutes, pick-up at Batumi Mall.', nf: 'Page not found', nfp: 'The address may have changed after the site update. Here is where you can go:' },
};
const NM = (p, l) => p['name_' + l] || p.name_en || p.name_ka;
const DS = (p, l) => String(p['desc_' + l] || p.desc_ru || p.desc_en || '').trim();
const gelS = (t) => { const v = (t || 0) / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2); };
const photoOf = (p) => p.photo || (p.category_id === 'pizza' ? `/img/pizza-${p.id === 'chorizo' ? 'pep' : p.id}-600.webp` : '');
async function seoCatalog(env) {
  const cats = await db(env).all('SELECT id, sort, name_ka, name_en, name_ru FROM categories WHERE active = 1 ORDER BY sort');
  const prods = await db(env).all(`SELECT p.id, p.category_id, p.name_ka, p.name_en, p.name_ru, p.desc_ka, p.desc_en, p.desc_ru, p.size, p.photo, p.in_stock, pr.price_tetri
    FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.price_list = 'base' JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1 ORDER BY c.sort, p.sort`);
  return { cats, prods, pizzas: prods.filter((p) => p.category_id === 'pizza') };
}
const altLinks = (path) => ['ka', 'ru', 'en'].map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${LP[l]}${path}">`).join('') + `<link rel="alternate" hreflang="x-default" href="${SITE}${path}">`;
const ymSnippet = () => `<script>(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r)return;}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js','ym');ym(${YM_ID},'init',{clickmap:true,trackLinks:true,accurateTrackBounce:true});</script><noscript><div><img src="https://mc.yandex.ru/watch/${YM_ID}" style="position:absolute;left:-9999px" alt=""></div></noscript>`;
const SEO_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://mc.yandex.ru https://mc.yandex.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://mc.yandex.ru https://mc.yandex.com; connect-src 'self' https://mc.yandex.ru https://mc.yandex.com https://cloudflareinsights.com; frame-src https://mc.yandex.ru https://mc.yandex.com; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
function restaurantLd(S, pizzas, l) {
  const info = (S && S.info) || {}; const T = SEO_T[l];
  return { '@context': 'https://schema.org', '@type': 'Restaurant', '@id': SITE + '/#restaurant', name: 'Pizza Room', alternateName: ['Пицца Рум', 'პიცა რუმი', 'Pizza Room Batumi'], url: homeUrl(l),
    description: T.desc, image: [SITE + '/img/og-1200.jpg'], logo: SITE + '/icon-v2-512.png', telephone: '+995514888800', email: 'pizzaroombatumi@gmail.com', priceRange: '₾₾', servesCuisine: ['Pizza', 'Italian'],
    currenciesAccepted: 'GEL', paymentAccepted: 'Cash, Credit Card', acceptsReservations: false,
    address: { '@type': 'PostalAddress', streetAddress: 'Zurab Gorgiladze St 88, Batumi Mall', addressLocality: 'Batumi', addressRegion: 'Adjara', postalCode: '6010', addressCountry: 'GE' },
    geo: { '@type': 'GeoCoordinates', latitude: 41.64326, longitude: 41.61982 }, hasMap: 'https://www.google.com/maps/place/Pizza+Room+Batumi/@41.6432591,41.6198185,17z', areaServed: { '@type': 'City', name: 'Batumi' },
    openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: info.open || '11:00', closes: info.close || '23:00' }],
    hasMenu: SITE + LP[l] + '/menu',
    makesOffer: pizzas.slice(0, 20).map((p) => ({ '@type': 'Offer', price: gelS(p.price_tetri), priceCurrency: 'GEL', itemOffered: { '@type': 'MenuItem', name: NM(p, l), url: `${SITE}${LP[l]}/pizza/${slugOf(p)}` } })) };
}
function seoBlock(l, cat) {
  const T = SEO_T[l];
  const li = cat.pizzas.map((p) => `<li><a href="${LP[l]}/pizza/${slugOf(p)}"><b>${escH(NM(p, l))}</b></a> — ${escH(DS(p, l))}${p.size ? ', ' + escH(p.size) : ''} · ${gelS(p.price_tetri)} ₾</li>`).join('');
  return `<div id="seo" style="max-width:560px;margin:0 auto;padding:16px;font:15px/1.5 Inter,sans-serif;color:#2A1D13"><h1>${escH(T.h1)}</h1><p>${escH(T.lead)}</p><h2>${escH(T.pizzas)}</h2><ul>${li}</ul>
<p><a href="${LP[l]}/menu">${escH(T.menu)}</a> · ${escH(T.hours)} 11:00–23:00 · <a href="tel:+995514888800">+995 514 88 88 00</a></p><p><a href="/">ქართული</a> · <a href="/ru/">Русский</a> · <a href="/en/">English</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></div>`;
}
async function seoHome(request, env, l) {
  if (!env.ASSETS) return null;
  const u = new URL(request.url); const res = await env.ASSETS.fetch(new Request(u.origin + '/', { headers: request.headers }));
  if (res.status !== 200) return res;
  const [cat, S] = await Promise.all([seoCatalog(env), getSettings(env).catch(() => ({}))]); const T = SEO_T[l]; const url = homeUrl(l);
  const ld = JSON.stringify([restaurantLd(S, cat.pizzas, l), { '@context': 'https://schema.org', '@type': 'WebSite', '@id': SITE + '/#website', url: SITE + '/', name: 'Pizza Room', inLanguage: ['ka', 'ru', 'en'] }]).replace(/</g, '\\u003c');
  // подставляем язык, заголовки и актуальные цены прямо в текст страницы (разметку делает tools/site/port_live.py)
  let html = await res.text(); const ea = (s) => escH(s);
  const rep = (re, f) => { html = html.replace(re, f); };
  rep(/<html lang="[^"]*"/, `<html lang="${l}"`);
  rep(/<title>[\s\S]*?<\/title>/, `<title>${ea(T.title)}</title>`);
  rep(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${ea(T.desc)}">`);
  rep(/(<link rel="canonical" href=")[^"]*(" id="seo-canon">)/, `$1${url}$2`);
  rep(/(<meta property="og:title" content=")[^"]*(" id="seo-ogt">)/, (m, a, b) => a + ea(T.title) + b);
  rep(/(<meta property="og:description" content=")[^"]*(" id="seo-ogd">)/, (m, a, b) => a + ea(T.desc) + b);
  rep(/(<meta property="og:url" content=")[^"]*(" id="seo-ogu">)/, `$1${url}$2`);
  rep(/(<meta property="og:locale" content=")[^"]*(" id="seo-ogl">)/, `$1${{ ka: 'ka_GE', ru: 'ru_RU', en: 'en_US' }[l]}$2`);
  rep(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${ld}</script>`);
  rep(/<div id="seo"[^>]*>[\s\S]*?<\/div>/, () => seoBlock(l, cat));
  const out = { headers: res.headers };
  const h = new Headers(out.headers); h.set('cache-control', 'public, max-age=0, must-revalidate'); h.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://mc.yandex.ru https://mc.yandex.com https://yastatic.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://unpkg.com https://mc.yandex.ru https://mc.yandex.com; connect-src 'self' https://router.project-osrm.org https://mc.yandex.ru https://mc.yandex.com https://cloudflareinsights.com; frame-src https://mc.yandex.ru https://mc.yandex.com; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"); for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v); h.set('strict-transport-security', 'max-age=31536000'); h.delete('etag'); h.set('content-language', l);
  return new Response(html, { status: 200, headers: h });
}
function seoShell(l, { title, desc, path, body, ld }) {
  const T = SEO_T[l];
  const langs = ['ka', 'ru', 'en'].map((x) => x === l ? `<b>${x.toUpperCase()}</b>` : `<a href="${LP[x]}${path}">${x.toUpperCase()}</a>`).join(' ');
  return `<!DOCTYPE html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title><meta name="description" content="${escH(desc)}">
<link rel="canonical" href="${SITE}${LP[l]}${path}">${altLinks(path)}${SEO_VERIFY}<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website"><meta property="og:site_name" content="Pizza Room"><meta property="og:title" content="${escH(title)}"><meta property="og:description" content="${escH(desc)}"><meta property="og:url" content="${SITE}${LP[l]}${path}"><meta property="og:image" content="${SITE}/img/og-1200.jpg"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png"><link rel="icon" type="image/png" sizes="192x192" href="/icon-v2-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon-v2.png"><meta name="theme-color" content="#2A1D13">
<style>body{margin:0;background:#F3E9D6;color:#2A1D13;font:16px/1.55 Inter,'Noto Sans Georgian',system-ui,sans-serif}a{color:#8A2414}main{max-width:820px;margin:0 auto;padding:14px 16px 60px}
header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}header img{height:44px}nav.bc{font-size:13px;color:#7A6450;margin:10px 0}h1{font-size:28px;line-height:1.2;margin:8px 0 12px}h2{font-size:20px;margin:26px 0 10px}
.btn{display:inline-block;background:#F5B82E;color:#2A1D13;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:14px}.card{background:#FBF5EA;border-radius:18px;padding:14px 16px;margin:14px 0}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:center}.hero img{width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:22px;background:#2B2622}@media(max-width:640px){.hero{grid-template-columns:1fr}.hero img{max-width:300px;margin:0 auto;display:block}}
.price{font-size:30px;font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.grid a{display:block;background:#FBF5EA;border-radius:16px;padding:8px;text-decoration:none;color:#2A1D13;font-size:14px}.grid img{width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:12px}
table{width:100%;border-collapse:collapse}td{padding:8px 4px;border-bottom:1px solid #E5D6BD;vertical-align:top}td.p{text-align:right;white-space:nowrap;font-weight:700}small{color:#7A6450}footer{font-size:13px;color:#7A6450;margin-top:34px}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>${ymSnippet()}</head>
<body><main><header><a href="${LP[l]}/"><img src="/logo-dark.png" alt="Pizza Room"></a><span>${langs}</span></header>${body}
<footer><div class="card"><b>Pizza Room</b> · ${escH(T.addrv)}<br>${escH(T.hours)} 11:00–23:00 · <a href="tel:+995514888800">+995 514 88 88 00</a><br>${escH(T.del)} · ${escH(T.pick)}</div>
<a href="${LP[l]}/">${escH(T.home)}</a> · <a href="${LP[l]}/menu">${escH(T.menu)}</a> · <a href="/terms?lang=${l}">Terms</a> · <a href="/privacy?lang=${l}">Privacy</a></footer></main></body></html>`;
}
const htmlRes = (html, status = 200, maxAge = 300) => new Response(html, { status, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${maxAge}`, 'content-security-policy': SEO_CSP }, SEC_HEADERS) });
async function seoPizza(env, l, slug) {
  const cat = await seoCatalog(env); const T = SEO_T[l];
  let p = cat.pizzas.find((x) => slugOf(x) === slug);
  if (!p) { const byId = cat.pizzas.find((x) => x.id === slug); if (byId) return Response.redirect(`${SITE}${LP[l]}/pizza/${slugOf(byId)}`, 301); return null; }
  const n = NM(p, l), d = DS(p, l), pr = gelS(p.price_tetri), path = `/pizza/${slugOf(p)}`, img = photoOf(p);
  const others = cat.pizzas.filter((x) => x.id !== p.id).map((x) => `<a href="${LP[l]}/pizza/${slugOf(x)}"><img src="${escH(photoOf(x))}" alt="${escH(NM(x, l))}" loading="lazy" width="300" height="300"><b>${escH(NM(x, l))}</b><br>${gelS(x.price_tetri)} ₾</a>`).join('');
  const ld = [{ '@context': 'https://schema.org', '@type': 'Product', name: n, description: d, image: SITE + img, brand: { '@type': 'Brand', name: 'Pizza Room' }, category: 'Pizza',
    offers: { '@type': 'Offer', price: pr, priceCurrency: 'GEL', availability: p.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: SITE + LP[l] + path, seller: { '@id': SITE + '/#restaurant' } } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Pizza Room', item: homeUrl(l) }, { '@type': 'ListItem', position: 2, name: T.menu, item: `${SITE}${LP[l]}/menu` }, { '@type': 'ListItem', position: 3, name: n, item: SITE + LP[l] + path }] }];
  const body = `<nav class="bc"><a href="${LP[l]}/">Pizza Room</a> › <a href="${LP[l]}/menu">${escH(T.menu)}</a> › ${escH(n)}</nav>
<h1>${escH(l === 'ru' ? 'Пицца ' + n : l === 'en' ? n + ' pizza' : n)}</h1><div class="hero"><img src="${escH(img)}" alt="${escH(n)} — Pizza Room Batumi" width="600" height="600"><div><p>${escH(d)}</p><p><small>${escH(p.size || '33 ' + T.cm)}</small></p><div class="price">${pr} ₾</div><p><a class="btn" href="${LP[l]}/">${escH(T.order)}</a></p><p>${escH(T.del)}<br>${escH(T.pick)}</p></div></div>
<h2>${escH(T.other)}</h2><div class="grid">${others}</div>`;
  return htmlRes(seoShell(l, { title: T.ptitle(n, pr), desc: T.pdesc(n, d), path, body, ld }));
}
async function seoMenu(env, l) {
  const cat = await seoCatalog(env); const T = SEO_T[l];
  const secs = cat.cats.map((c) => { const items = cat.prods.filter((p) => p.category_id === c.id); if (!items.length) return '';
    return `<h2>${escH(NM(c, l))}</h2><table>${items.map((p) => `<tr><td>${p.category_id === 'pizza' ? `<a href="${LP[l]}/pizza/${slugOf(p)}"><b>${escH(NM(p, l))}</b></a>` : `<b>${escH(NM(p, l))}</b>`}${DS(p, l) ? `<br><small>${escH(DS(p, l))}</small>` : ''}${p.size ? ` <small>· ${escH(p.size)}</small>` : ''}</td><td class="p">${gelS(p.price_tetri)} ₾</td></tr>`).join('')}</table>`; }).join('');
  const ld = [{ '@context': 'https://schema.org', '@type': 'Menu', name: 'Pizza Room — ' + T.menu, url: `${SITE}${LP[l]}/menu`, inLanguage: l,
    hasMenuSection: cat.cats.map((c) => ({ '@type': 'MenuSection', name: NM(c, l), hasMenuItem: cat.prods.filter((p) => p.category_id === c.id).map((p) => ({ '@type': 'MenuItem', name: NM(p, l), description: DS(p, l) || undefined, offers: { '@type': 'Offer', price: gelS(p.price_tetri), priceCurrency: 'GEL' } })) })).filter((s) => s.hasMenuItem.length) }];
  const body = `<nav class="bc"><a href="${LP[l]}/">Pizza Room</a> › ${escH(T.menu)}</nav><h1>${escH(T.menu)} — Pizza Room</h1><p>${escH(T.lead)}</p><p><a class="btn" href="${LP[l]}/">${escH(T.order)}</a></p>${secs}`;
  return htmlRes(seoShell(l, { title: T.mtitle, desc: T.mdesc, path: '/menu', body, ld }));
}
function seo404(l) {
  const T = SEO_T[l];
  return htmlRes(seoShell(l, { title: T.nf + ' — Pizza Room', desc: T.desc, path: '/', body: `<h1>${escH(T.nf)}</h1><p>${escH(T.nfp)}</p><p><a class="btn" href="${LP[l]}/">${escH(T.order)}</a></p><p><a href="${LP[l]}/menu">${escH(T.menu)}</a></p>`, ld: {} }).replace('<meta name="robots" content="index, follow, max-image-preview:large">', '<meta name="robots" content="noindex">'), 404, 60);
}
async function seoSitemap(env) {
  const cat = await seoCatalog(env); const today = isoNow().slice(0, 10);
  const alt = (path) => ['ka', 'ru', 'en'].map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${SITE}${LP[l]}${path}"/>`).join('') + `<xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${path}"/>`;
  const urls = [];
  const add = (path, pr, cf) => ['ka', 'ru', 'en'].forEach((l) => urls.push(`<url><loc>${SITE}${LP[l]}${path}</loc><lastmod>${today}</lastmod><changefreq>${cf}</changefreq><priority>${pr}</priority>${alt(path)}</url>`));
  add('/', '1.0', 'daily'); add('/menu', '0.9', 'weekly'); cat.pizzas.forEach((p) => add(`/pizza/${slugOf(p)}`, '0.8', 'weekly'));
  ['terms', 'refund', 'privacy'].forEach((d) => urls.push(`<url><loc>${SITE}/${d}</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>`));
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
// Возвращает ответ для «сайтовых» адресов или null, если адрес не наш (тогда работает API)
async function seoRoute(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  let path = url.pathname; if (path.startsWith('/api/')) return null;
  const R = (to) => Response.redirect(to.startsWith('http') ? to : SITE + to, 301);
  if (url.hostname.startsWith('www.') || url.protocol === 'http:') return R(path + url.search);
  try { path = decodeURIComponent(path); } catch (e) {}
  if (/^\/(terms|refund|privacy)\/?$/.test(path)) return null; // юридические страницы — свой обработчик
  const lm = path.match(/^\/(ru|en|ka)(\/.*)?$/); const l = lm ? lm[1] : 'ka'; const rest = lm ? (lm[2] || '/') : path;
  if (l === 'ka' && lm) return R(rest + url.search); // /ka/... → без префикса
  if (rest === '/' ) { if (lm && path !== `/${l}/`) return R(`/${l}/`); try { return await seoHome(request, env, l); } catch (e) { console.error('seo_home', e && e.stack || e); return env.ASSETS ? env.ASSETS.fetch(new Request(url.origin + '/', { headers: request.headers })) : null; } }
  if (path === '/sitemap.xml') return seoSitemap(env);
  if (rest === '/menu' || rest === '/menu/') return seoMenu(env, l);
  const pz = rest.match(/^\/pizza\/([a-z0-9-]+)\/?$/); if (pz) return (await seoPizza(env, l, pz[1])) || seo404(l);
  // старый сайт: товары Ecwid «…-p110725413», страницы WordPress
  const ec = rest.match(/-p(\d{6,12})\/?$/);
  if (ec) { const id = ECWID[ec[1]]; if (id) { const cat = await seoCatalog(env); const p = cat.pizzas.find((x) => x.id === id); if (p) return R(`${LP[l]}/pizza/${slugOf(p)}`); } return R(`${LP[l]}/menu`); }
  if (/^\/(cart|account|signin|search|app|products?|store|shop|menu-2|pizza\/?$|category|tag|author|feed|comments)(\/|$)/i.test(rest)) return R(`${LP[l]}/`);
  if (/^\/sitemap[-_].*\.xml$/i.test(rest)) return R('/sitemap.xml');
  if (/^\/(wp-admin|wp-login\.php|xmlrpc\.php|wp-json|wp-includes|wp-content|\.env|\.git)/i.test(rest)) return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex' } });
  if (/\.(php|asp|aspx|jsp|cgi)$/i.test(rest)) return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain' } });
  return seo404(l);
}

// ───────── вход в сервер ─────────
const SAME_ORIGIN_ONLY = /^\/api\/(public\/|login$|recover)/;
const sameSite = (og, url) => { try { const o = new URL(og); return o.host === url.host || /^(www\.)?pizzaroom\.ge$/.test(o.hostname) && /^(www\.)?pizzaroom\.ge$/.test(url.hostname); } catch (e) { return false; } };
export async function handle(request, env0) {
  const url = new URL(request.url); let staffSeen = false;
  const env = Object.create(env0); env.__qc = new Map(); // свой кэш чтений у каждого запроса
  try {
    await ensureSchema(env);
    const lg = request.method === 'GET' && url.pathname.match(/^\/(terms|refund|privacy)\/?$/);
    const sp = await seoRoute(request, env, url); if (sp) return sp;
    if (lg) { const l0 = url.searchParams.get('lang'); const al = String(request.headers.get('accept-language') || '').slice(0, 2); return legalPage(env, lg[1], ['ka', 'ru', 'en'].includes(l0) ? l0 : ['ru', 'en'].includes(al) ? al : 'ka'); }
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      let body = {};
      if (request.method !== 'GET') {
        if (Number(request.headers.get('content-length') || 0) > MAX_BODY) fail(413, 'too_large', 'Слишком большой запрос');
        const txt = await request.text(); if (txt.length > MAX_BODY) fail(413, 'too_large', 'Слишком большой запрос');
        try { body = txt ? JSON.parse(txt) : {}; } catch (e) { body = {}; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      }
      // защита от подделки запросов с чужих сайтов: формы сайта, вход и восстановление PIN принимаем только со своего адреса
      if (request.method !== 'GET' && SAME_ORIGIN_ONLY.test(url.pathname)) { const og = request.headers.get('origin');
        if (!og || !sameSite(og, url)) fail(403, 'bad_origin', 'Запрос не с нашего сайта. Обновите страницу pizzaroom.ge'); }
      let me = null;
      if (r.perm) { me = await authenticate(request, env); if (!can(me, r.perm)) fail(403, 'forbidden', 'Нет прав на это действие'); staffSeen = true; }
      const data = await r.handler({ env, me, body, url, request, params: m.groups || {} });
      return json(data);
    }
    return json({ error: 'not_found', message: 'Нет такого адреса' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error('server_error', url.pathname, e && e.stack || e);
    // подробности ошибки — только сотрудникам (вошедшим по PIN); посторонним не показываем устройство базы
    return json(Object.assign({ error: 'server_error', message: 'Ошибка сервера' }, staffSeen ? { detail: String(e && e.message || e) } : {}), 500);
  }
}

// Быстрый сайт: публичные данные (меню, настройки) кэшируются на сервере Cloudflare рядом с клиентом на 15 секунд —
// телефон получает их сразу, без похода в базу. Изменения в админке появляются на сайте в течение 15 секунд.
const EDGE = ['/api/public/catalog', '/api/public/settings', '/api/public/menu'];
async function edgeCached(request, env, ctx) {
  const u = new URL(request.url);
  if (request.method !== 'GET' || !EDGE.includes(u.pathname) || typeof caches === 'undefined' || request.headers.get('authorization')) return handle(request, env);
  const key = new Request(u.origin + u.pathname, { method: 'GET' }); const c = caches.default;
  const hit = await c.match(key); if (hit) { const r = new Response(hit.body, hit); r.headers.set('cache-control', 'no-store'); return r; }
  const res = await handle(request, env); if (res.status !== 200) return res;
  const out = new Response(res.body, res); out.headers.set('cache-control', 'public, max-age=15, s-maxage=15');
  ctx.waitUntil(c.put(key, out.clone()));
  // браузеру — не хранить: иначе Cloudflare (Browser Cache TTL) растягивает до 4 часов и телефоны видят старое меню
  const cli = new Response(out.body, out); cli.headers.set('cache-control', 'no-store'); return cli;
}
export default { fetch: (request, env, ctx) => edgeCached(request, env, ctx), scheduled: (event, env, ctx) => ctx.waitUntil(dailyJob(env)) };

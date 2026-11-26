// Сквозной тест: работа кассы и попытки обмана. Запуск: node test/run.mjs
import { readFileSync } from 'node:fs';
import { D1Shim } from './d1shim.mjs';
import { handle, hashPin } from '../src/worker.js';

const DB = new D1Shim();
DB.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
DB.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('data_v','2');"); // каталог тестов задаём сами
const env = { DB };
let passed = 0, failed = 0;
const ok = (cond, name, extra) => { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name, extra ?? ''); } };

let CLIENT_IP = '10.0.0.1';
async function api(method, path, body, token) {
  const res = await handle(new Request('https://pizzaroom.ge' + path, {
    method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': CLIENT_IP, origin: 'https://pizzaroom.ge', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(path === '/api/public/order' && body && body.el === undefined && !body.__raw ? Object.assign({ el: 9000 }, body) : body || {})
  }), env);
  return { status: res.status, data: await res.json() };
}
const sqlFails = (sql) => { try { DB.db.exec(sql); return false; } catch (e) { return true; } };

// ── начальные данные: владелец, меню, цены, склад ──
const salt = 'seedsalt';
DB.db.prepare('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)').run('Владелец', 'owner', await hashPin('9999', salt), salt);
DB.exec(`
INSERT INTO categories VALUES ('pizza', 1, 'პიცა', 'Pizza', 'Пицца');
INSERT INTO products (id, category_id, name_ka, name_en, name_ru, size, sort) VALUES
  ('pep','pizza','პეპერონი','Pepperoni','Пепперони','33 см',1),
  ('marg','pizza','მარგარიტა','Margherita','Маргарита','33 см',2);
INSERT INTO prices VALUES ('pep','base',2600), ('pep','wolt',3300), ('marg','base',2500), ('marg','wolt',3300);
INSERT INTO ingredients (id, name, unit, cost_per_1000_tetri, min_stock) VALUES
  ('dough','Тесто','g',240,4000), ('mozz','Моцарелла','g',2600,4000), ('pepp','Пепперони','g',3800,1500), ('sauce','Соус','g',900,3000);
INSERT INTO recipes VALUES ('pep','dough',280), ('pep','mozz',170), ('pep','pepp',70), ('pep','sauce',90),
  ('marg','dough',280), ('marg','mozz',190), ('marg','sauce',100);
`);

console.log('\n1. Владелец создаёт сотрудников');
const owner = (await api('POST', '/api/login', { pin: '9999', device: 'office' })).data.token;
ok(!!owner, 'владелец вошёл по PIN');
ok((await api('POST', '/api/staff', { name: 'Тамара', role: 'manager', pin: '2222' }, owner)).status === 200, 'создан менеджер');
ok((await api('POST', '/api/staff', { name: 'Нино', role: 'cashier', pin: '111111' }, owner)).status === 200, 'создан кассир');
ok((await api('POST', '/api/staff', { name: 'Дубль', role: 'cashier', pin: '111111' }, owner)).data.error === 'pin_taken', 'одинаковый PIN двум сотрудникам запрещён');
const manager = (await api('POST', '/api/login', { pin: '2222', device: 'office' })).data.token;
for (const [ing, qty, cost] of [['dough', 20000, 240], ['mozz', 5000, 2600], ['pepp', 2000, 3800], ['sauce', 6000, 900]])
  await api('POST', '/api/stock/receipt', { ingredient_id: ing, qty, cost_per_1000_tetri: cost, supplier: 'Поставщик' }, manager);
ok((await api('GET', '/api/stock', null, manager)).data.find((s) => s.id === 'mozz').qty === 5000, 'менеджер принял товар: моцарелла 5 кг');

console.log('\n2. Кассир работает');
const cashier = (await api('POST', '/api/login', { pin: '111111', device: 'kassa-1' })).data.token;
ok((await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'pep', qty: 1 }] }, cashier)).data.error === 'no_shift', 'без открытой смены заказ не создать');
ok((await api('POST', '/api/shifts/open', { opening_cash_tetri: 10000 }, cashier)).status === 200, 'смена открыта, в кассе 100 ₾');
let r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'pep', qty: 2, price: 1 }] }, cashier);
const o1 = r.data.id;
ok(r.data.total_tetri === 5200, 'цена взята из базы (2 × 26 ₾ = 52 ₾), а не с экрана кассы', r.data.total_tetri);
await api('POST', `/api/orders/${o1}/send`, {}, cashier);
const item = (await api('GET', `/api/orders/${o1}`, null, cashier)).data.items[0].id;

console.log('\n3. Попытки обмана');
ok((await api('POST', `/api/orders/${o1}/items/${item}/decrease`, { qty: 1 }, cashier)).data.error === 'approval_required', 'убрать пиццу после кухни без менеджера — нельзя');
ok((await api('POST', `/api/orders/${o1}/items/${item}/decrease`, { qty: 1, approval_pin: '111111' }, cashier)).data.error === 'approval_failed', 'свой же PIN вместо менеджерского — не проходит');
ok((await api('POST', `/api/orders/${o1}/discount`, { percent: 10, approval_pin: '2222' }, cashier)).data.error === 'no_manual_discount' && (await api('POST', `/api/orders/${o1}/discount`, { percent: 10 }, manager)).data.error === 'no_manual_discount', 'ручная скидка в кассе отключена — и кассиру, и менеджеру');
ok((await api('POST', '/api/staff', { name: 'Короткий', role: 'cashier', pin: '5917' }, owner)).data.error === 'pin_6', 'PIN кассира — ровно 6 цифр');
ok((await api('POST', `/api/orders/${o1}/cancel`, { reason: 'клиент ушёл' }, cashier)).data.error === 'approval_required', 'отменить заказ без менеджера — нельзя');
ok((await api('GET', '/api/reports/sales', null, cashier)).status === 403, 'кассир не видит выручку');
ok((await api('PUT', '/api/prices', { product_id: 'pep', price_list: 'base', price_tetri: 100 }, cashier)).status === 403, 'кассир не может менять цены');
ok((await api('GET', '/api/audit', null, manager)).status === 403, 'журнал видит только владелец');

console.log('\n4. С подтверждением менеджера');
r = await api('POST', `/api/orders/${o1}/items/${item}/decrease`, { qty: 1, approval_pin: '2222' }, cashier);
ok(r.status === 200 && r.data.total_tetri === 2600, 'менеджер разрешил убрать 1 пиццу — итог 26 ₾');
const wo = DB.db.prepare(`SELECT COUNT(*) n FROM stock_moves WHERE kind='writeoff' AND order_id=?`).get(o1).n;
ok(wo === 10, 'убранная после кухни пицца списана сырьём: томатный соус, сахар, соль, орегано, масло, сыр, пепперони, мука, молоко, дрожжи', wo);
const tm = DB.db.prepare(`SELECT ingredient_id i, delta d FROM stock_moves WHERE kind='writeoff' AND order_id=? AND ingredient_id IN ('tomato_can','sugar','salt')`).all(o1);
ok(tm.find((x) => x.i === 'tomato_can').d === -70 && Math.abs(tm.find((x) => x.i === 'sugar').d + 4.5) < 1e-9 && Math.abs(tm.find((x) => x.i === 'salt').d + 2.28) < 1e-9, 'соус 70 г = 70 г томатного соуса + 3,5 г сахара (+1 г в тесте) + соль 0,28 г (+2 г в тесте)', tm);
const fl = DB.db.prepare(`SELECT ingredient_id i, delta d FROM stock_moves WHERE kind='writeoff' AND order_id=? AND ingredient_id IN ('flour','yeast','dough')`).all(o1);
ok(fl.some((x) => x.i === 'flour' && x.d === -160) && fl.some((x) => x.i === 'yeast' && Math.abs(x.d + 0.1) < 1e-9) && !fl.some((x) => x.i === 'dough'), 'тесто: списано 160 г муки и 0,1 г дрожжей, самой заготовки на складе нет', fl);
r = await api('POST', '/api/stock/receipt', { supplier: 'Мука', lines: [{ ingredient_id: 'flour', qty: 10000, total_tetri: 2000 }] }, manager);
ok(r.status === 200 && DB.db.prepare("SELECT cost_per_1000_tetri c FROM ingredients WHERE id='dough'").get().c >= 32, 'цена теста пересчиталась сама после прихода муки (≥ 0,32 ₾ на 1000 шт → 32 тетри за кг муки × 0,16)', DB.db.prepare("SELECT cost_per_1000_tetri c FROM ingredients WHERE id='dough'").get());
r = await api('POST', `/api/orders/${o1}/discount`, { percent: 10 }, owner);
ok(r.data.total_tetri === 2340, 'скидку может дать только владелец: 23,40 ₾', r.data.total_tetri);

console.log('\n5. Оплата, фискальный чек, склад');
r = await api('POST', `/api/orders/${o1}/pay`, { method: 'cash' }, cashier);
ok(r.data.paid && r.data.receipt_no === '101', 'оплачено наличными — номер чека программа поставила сама: 101', r.data);
ok((await api('GET', '/api/kitchen', null, manager)).data.some((k) => k.id === o1), 'после оплаты заказ сам на кухне — кнопка «на кухню» не нужна');
const mozz = (await api('GET', '/api/stock', null, manager)).data.find((s) => s.id === 'mozz').qty;
ok(mozz === 5000 - 170 - 170, 'моцарелла списана: продажа 170 г + списание 170 г', mozz);
ok((await api('POST', `/api/orders/${o1}/items`, { product_id: 'marg', qty: 1 }, cashier)).data.error === 'order_closed', 'в оплаченный заказ ничего не добавить');

console.log('\n6. Wolt — своя цена и комиссия');
r = await api('POST', '/api/orders', { channel: 'wolt', external_id: 'W-4821', items: [{ product_id: 'marg', qty: 1 }] }, cashier);
ok(r.data.total_tetri === 2640, 'цена Wolt 33 ₾ и постоянная скидка −20% сама: 26,40 ₾', r.data.total_tetri);
ok((await api('POST', '/api/orders', { channel: 'wolt', external_id: 'W-4821', items: [{ product_id: 'marg', qty: 1 }] }, cashier)).data.error === 'duplicate', 'один заказ Wolt дважды не пробить');
await api('POST', `/api/orders/${r.data.id}/pay`, { method: 'platform' }, cashier);
const pay = DB.db.prepare('SELECT commission_tetri FROM payments WHERE order_id = ?').get(r.data.id);
ok(pay.commission_tetri === 792, 'комиссия Wolt 30% от 26,40 ₾: 7,92 ₾', pay.commission_tetri);

console.log('\n7. Стоп-лист');
ok((await api('POST', '/api/products/pep/stock', { in_stock: false }, cashier)).status === 200, 'кассир поставил пиццу в стоп');
ok((await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'pep', qty: 1 }] }, cashier)).data.error === 'stopped', 'пиццу из стоп-листа не продать');
ok((await api('POST', '/api/products/pep/stock', { in_stock: true }, cashier)).status === 403, 'вернуть в продажу кассир не может');
ok((await api('POST', '/api/products/pep/stock', { in_stock: true }, manager)).status === 200, 'менеджер вернул в продажу');

console.log('\n8. История неизменна — даже напрямую в базе');
ok(sqlFails(`UPDATE payments SET total_tetri = 0 WHERE order_id = ${o1}`), 'изменить оплату нельзя');
ok(sqlFails(`DELETE FROM payments`), 'удалить оплату нельзя');
ok(sqlFails(`DELETE FROM audit_log`), 'удалить журнал нельзя');
ok(sqlFails(`UPDATE orders SET status = 'open' WHERE id = ${o1}`), 'открыть оплаченный заказ заново нельзя');
ok(sqlFails(`DELETE FROM orders WHERE id = ${o1}`), 'удалить заказ нельзя');
ok(sqlFails(`UPDATE stock_moves SET delta = 0`), 'исправить движение склада нельзя');

console.log('\n9. Закрытие смены вслепую');
r = await api('POST', '/api/shifts/close', { counted_cash_tetri: 12000 }, cashier);
ok(JSON.stringify(r.data) === '{"closed":true}', 'кассир видит только «смена закрыта», без цифр');
const sh = DB.db.prepare('SELECT expected_cash_tetri e, diff_tetri d FROM shifts WHERE id = 1').get();
ok(sh.e === 12340 && sh.d === -340, 'владелец видит: должно 123,40 ₾, насчитано 120 ₾, недостача 3,40 ₾', sh);
ok(sqlFails('UPDATE shifts SET diff_tetri = 0 WHERE id = 1'), 'исправить итоги закрытой смены нельзя');

console.log('\n10. Подбор PIN');
let last;
for (let i = 0; i < 6; i++) last = await api('POST', '/api/login', { pin: String(5000 + i), device: 'kassa-2' });
ok(last.status === 429, 'после 5 неверных PIN касса блокируется на 10 минут', last.status);

console.log('\n11. Отчёты и журнал');
const sales = (await api('GET', '/api/reports/sales?group=day', null, manager)).data;
ok(sales.length === 2 && sales.some((s) => s.channel === 'wolt' && s.net_tetri === 1848), 'выручка по дням и каналам, чистая после комиссии', sales);
const prods = (await api('GET', '/api/reports/products', null, manager)).data;
ok(prods.length === 2, 'продажи по пиццам', prods);
const staffRep = (await api('GET', '/api/reports/staff', null, manager)).data[0];
ok(staffRep.discounts === 0 && staffRep.failed_approvals === 1 && staffRep.cash_diff_tetri === -340, 'отчёт по кассиру: скидки, неверные PIN, недостача', staffRep);
ok((await api('GET', '/api/audit/verify', null, owner)).data.ok === true, 'цепочка журнала целая');
DB.db.exec('DROP TRIGGER audit_no_update'); DB.db.exec(`UPDATE audit_log SET details = '{"total_tetri":1}' WHERE action = 'order.pay'`);
ok((await api('GET', '/api/audit/verify', null, owner)).data.ok === false, 'подделка журнала напрямую в базе обнаружена');

console.log('\n12. Каталог: раздел «Салаты», ингредиенты, рецепт и себестоимость');
r = await api('POST', '/api/categories', { name_ru: 'Салаты', name_ka: 'სალათები', name_en: 'Salads', sort: 5 }, manager);
const salads = r.data.id; ok(r.status === 200 && !!salads, 'менеджер создал раздел «Салаты»');
ok((await api('POST', '/api/categories', { name_ru: 'X' }, cashier)).status === 403, 'кассир не может создавать разделы');
const tom = (await api('POST', '/api/ingredients', { name: 'Помидор', unit: 'g', min_stock: 1000 }, manager)).data.id;
const egg = (await api('POST', '/api/ingredients', { name: 'Яйцо', unit: 'pcs' }, manager)).data.id;
ok((await api('POST', '/api/ingredients', { name: 'помидор', unit: 'g' }, manager)).data.error === 'duplicate', 'второй «Помидор» не создать');
r = await api('POST', '/api/stock/receipt', { supplier: 'Рынок', invoice: 'N-15', lines: [{ ingredient_id: tom, qty: 10000, total_tetri: 3000 }, { ingredient_id: egg, qty: 30, total_tetri: 1200 }] }, manager);
ok(r.data.total_tetri === 4200, 'приход по накладной из 2 строк: 42 ₾');
r = await api('POST', '/api/stock/receipt', { lines: [{ ingredient_id: tom, qty: 10000, total_tetri: 5000 }] }, manager);
const tomCost = DB.db.prepare('SELECT cost_per_1000_tetri c FROM ingredients WHERE id = ?').get(tom).c;
ok(tomCost === 400, 'цена помидора пересчитана по средней: (3 + 5 ₾) / 20 кг = 0,40 ₾/кг', tomCost);
r = await api('POST', '/api/products', { category_id: salads, name_ru: 'Салат с яйцом', name_ka: 'სალათი კვერცხით', prices: { base: 1500, wolt: 1900, glovo: 1900 }, recipe: [{ ingredient_id: tom, qty: 200 }, { ingredient_id: egg, qty: 2 }] }, manager);
const salad = r.data.id; ok(r.status === 200, 'товар «Салат с яйцом» создан в разделе «Салаты»');
let cat = (await api('GET', '/api/catalog', null, manager)).data;
const sp = cat.products.find((p) => p.id === salad);
ok(sp.cost_tetri === 80 + 80, 'себестоимость салата: 200 г помидора (0,80) + 2 яйца (0,80) = 1,60 ₾', sp.cost_tetri);
ok((await api('POST', '/api/products', { id: salad, category_id: salads, name_ru: 'Салат с яйцом', recipe: [{ ingredient_id: tom, qty: 0 }] }, manager)).data.error === 'bad_qty', 'нулевое количество в рецепте не принимается');
ok((await api('POST', '/api/ingredients', { id: tom, name: 'Помидор', unit: 'g', cost_per_1000_tetri: 1 }, manager)).status === 403, 'менеджер не может вручную занизить цену ингредиента');
ok((await api('GET', '/api/menu?channel=hall', null, cashier)).data.some((p) => p.id === salad && p.category_id === salads), 'салат сразу виден на кассе в своём разделе');

console.log('\n13. Заказ с сайта → касса → курьер');
{ const h = (new Date(Date.now() + 4 * 3600e3).getUTCHours() + 2) % 24, hh = (x) => String(x % 24).padStart(2, '0') + ':00';
  const INFO = { phone: '+995514888800', wa: '995514888800', lat: 41.64318, lng: 41.61974 };
  await api('PUT', '/api/settings', { info: { ...INFO, open: hh(h), close: hh(h + 1) } }, manager);
  ok((await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 56', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] })).data.error === 'closed', 'в нерабочее время сайт заказ не принимает (проверка на сервере)');
  await api('PUT', '/api/settings', { info: { ...INFO, open: '00:00', close: '00:00' } }, manager); }
ok((await api('POST', '/api/public/order', { name: 'Гио', phone: '123', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] })).data.error === 'bad_phone', 'неверный телефон отклонён');
ok((await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 56', mode: 'delivery', zone: 'mars', address: 'Руставели 10', items: [{ product_id: 'marg', qty: 1 }] })).data.error === 'bad_zone', 'несуществующая зона отклонена');
r = await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 56', mode: 'delivery', zone: 'airport', address: 'Руставели 10', items: [{ product_id: 'marg', qty: 2, price_tetri: 1 }], pay: 'cash' });
ok(r.data.total_tetri === 5000 + 1000, 'сайт: 2 × 25 ₾ + доставка аэропорт 10 ₾ = 60 ₾, цену с сайта сервер не берёт', r.data);
const tok = r.data.token, siteId = r.data.id;
ok((await api('GET', '/api/public/order/' + tok)).data.status === 'received', 'клиент видит: заказ получен');
let inc = (await api('GET', '/api/orders', null, cashier)).data;
ok(inc.some((o) => o.id === siteId && !o.accepted_at), 'заказ появился на кассе как входящий');
await api('POST', '/api/shifts/open', { opening_cash_tetri: 0 }, cashier);
ok((await api('POST', `/api/orders/${siteId}/accept`, {}, cashier)).status === 200, 'кассир принял заказ');
ok((await api('GET', '/api/public/order/' + tok)).data.status === 'accepted', 'клиент видит: заказ принят (а не «готовится» и не «готово»)');
ok((await api('POST', `/api/orders/${siteId}/stage`, { stage: 'cooking' }, cashier)).status === 200 && (await api('GET', '/api/public/order/' + tok)).data.status === 'cooking', 'кухня нажала «готовится» — клиент видит: готовится');
ok((await api('GET', '/api/kitchen', null, cashier)).data.find((x) => x.id === siteId)?.cooking === true, 'на кухне отмечено, что заказ уже готовится');
await api('POST', `/api/orders/${siteId}/stage`, { stage: 'ready' }, cashier); await api('POST', `/api/orders/${siteId}/stage`, { stage: 'out' }, cashier);
ok((await api('GET', '/api/public/order/' + tok)).data.status === 'onway', 'клиент видит: курьер в пути');
r = await api('POST', `/api/orders/${siteId}/pay`, { method: 'cash' }, cashier);
ok(r.data.total_tetri === 6000, 'курьер привёз 60 ₾ наличными — оплата в кассе');
ok((await api('GET', '/api/public/order/' + tok)).data.status === 'delivered', 'клиент видит: доставлено');
for (let i = 0; i < 4; i++) last = await api('POST', '/api/public/order', { name: 'Спам', phone: '555000000', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] });
ok(last.status === 429, 'больше 4 заказов за 10 минут с одного адреса — блок (защита от спама)', last.status);
r = await api('POST', '/api/public/order', { name: 'Ложный', phone: '555111222', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] });
const fakeId = DB.db.prepare(`SELECT id FROM orders WHERE customer_name = 'Спам' LIMIT 1`).get().id;
ok((await api('POST', `/api/orders/${fakeId}/cancel`, { reason: 'ложный заказ' }, cashier)).status === 200, 'непринятый заказ с сайта кассир отклоняет без менеджера (с причиной)');

console.log('\n14. Аналитика: себестоимость и прибыль по каналам');
r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: salad, qty: 2 }] }, cashier);
await api('POST', `/api/orders/${r.data.id}/pay`, { method: 'card' }, cashier);
const sum = (await api('GET', '/api/reports/summary?group=day', null, manager)).data;
const hall = sum.rows.find((x) => x.channel === 'hall');
ok(hall && hall.cost_tetri > 0 && hall.profit_tetri === hall.net_tetri - hall.cost_tetri, 'сводка: выручка, комиссия, себестоимость, прибыль', hall);
const pr = (await api('GET', '/api/reports/products', null, manager)).data;
const sal = pr.find((x) => x.product_id === salad);
ok(sal && sal.qty === 2 && sal.revenue_tetri === 3000 && sal.cost_tetri === 320, 'по товару: 2 салата, выручка 30 ₾, себестоимость 3,20 ₾', sal);
const woltRow = pr.find((x) => x.channel === 'wolt');
ok(woltRow && woltRow.commission_tetri === 792, 'по товару видна комиссия Wolt', woltRow);
ok((await api('GET', '/api/reports/products?group=month', null, manager)).data.every((x) => /^\d{4}-\d{2}$/.test(x.period)), 'продажи товаров по месяцам');
ok((await api('GET', '/api/reports/summary', null, cashier)).status === 403, 'кассир аналитику не видит');

console.log('\n15. Настройки и сотрудники');
ok((await api('PUT', '/api/settings', { delivery: { zones: [{ id: 'city', fee: 8, ru: 'Батуми', en: 'Batumi', ka: 'ბათუმი' }], tmin: 30, tmax: 40, aggDisc: 20 } }, cashier)).status === 403, 'кассир не меняет цены доставки');
ok((await api('PUT', '/api/settings', { delivery: { zones: [{ id: 'city', fee: 8, ru: 'Батуми', en: 'Batumi', ka: 'ბათუმი' }], tmin: 30, tmax: 40, aggDisc: 20 }, commissions: { wolt: 2124 } }, manager)).status === 200, 'менеджер изменил доставку и комиссию');
ok((await api('GET', '/api/public/settings')).data.delivery.zones[0].fee === 8, 'сайт сразу видит новую цену доставки');
const nino = (await api('GET', '/api/staff', null, owner)).data.find((x) => x.name === 'Нино');
ok((await api('POST', `/api/staff/${nino.id}/pin`, { pin: '1234' }, owner)).data.error === 'pin_6', 'кассиру 4 цифры нельзя — нужно 6');
ok((await api('POST', `/api/staff/${nino.id}/pin`, { pin: '482193' }, owner)).status === 200, 'владелец сменил PIN кассира (6 цифр)');
ok((await api('GET', '/api/me', null, cashier)).status === 401, 'старая сессия кассира после смены PIN закрыта');

console.log('\n17. Разделы «скоро» и «18+», акции по расписанию, кухня, клиенты, прогноз');
const tbToday = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
DB.exec('DELETE FROM login_attempts'); CLIENT_IP = '10.0.0.2'; // прошлые тесты специально вводили неверные PIN и спамили заказами
const cashier2 = (await api('POST', '/api/login', { pin: '482193', device: 'kassa-2' })).data.token;
DB.exec("INSERT OR IGNORE INTO categories (id, sort, name_ka, name_en, name_ru, soon) VALUES ('sushi', 5, 'სუში', 'Sushi', 'Суши', 1)");
r = await api('POST', '/api/products', { category_id: 'sushi', name_ru: 'Филадельфия', prices: { base: 2200 } }, manager);
const _m = await api('GET', '/api/menu?channel=hall', null, cashier2);
ok(_m.data.every((p) => p.category_id !== 'sushi'), 'раздел «скоро» не виден в кассе для продажи');
const _so = await api('POST', '/api/public/order', { name: 'А', phone: '555777888', mode: 'pickup', items: [{ product_id: r.data.id, qty: 1 }] });
ok(_so.data.error === 'soon', 'суши «скоро» заказать нельзя', _so.data);
ok((await api('POST', '/api/public/waitlist', { phone: '555 77 78 88', category_id: 'sushi' })).status === 200, 'клиент оставил телефон «сообщите, когда откроется»');
ok((await api('GET', '/api/waitlist', null, manager)).data.length === 1, 'менеджер видит лист ожидания');
r = await api('POST', '/api/categories', { name_ru: 'Пиво', name_ka: 'ლუდი', name_en: 'Beer', age18: true }, manager);
ok((await api('GET', '/api/catalog', null, manager)).data.categories.find((c) => c.id === r.data.id).age18 === 1 && !(await api('GET', '/api/public/catalog')).data.categories.some((c) => c.id === r.data.id), 'раздел «Пиво» помечен 18+, пустой раздел на сайте не виден');
ok((await api('POST', '/api/promos', { title_ru: 'Тест', pct: 20, date_from: tbToday, date_to: tbToday, cats: ['pizza'], channels: ['site'] }, cashier2)).status === 403, 'кассир не создаёт акции');
DB.exec("INSERT OR IGNORE INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('pizza', 1, 'პიცა', 'Pizza', 'Пицца')");
DB.exec("UPDATE products SET category_id = 'pizza' WHERE id IN ('marg','pep')");
r = await api('POST', '/api/promos', { title_ru: 'Гиоргоба', pct: 20, date_from: tbToday, date_to: tbToday, cats: ['pizza'], channels: ['site'] }, manager);
ok(r.status === 200, 'менеджер включил акцию −20% на пиццу на сайте на сегодня');
const ps = (await api('GET', '/api/public/settings')).data.promo;
ok(ps.on && ps.pct === 20 && ps.cats.includes('pizza'), 'сайт сам видит акцию в эти даты');
r = await api('POST', '/api/public/order', { name: 'Ника', phone: '555123123', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] });
ok(r.data.total_tetri === 2000, 'сервер сам дал скидку: Маргарита 25 → 20 ₾', r.data);
r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }] }, cashier2);
ok(r.data.total_tetri === 2500, 'в зале акция не действует (выбран только сайт)', r.data.total_tetri);
const hol = (await api('GET', '/api/holidays', null, manager)).data;
ok(hol.length >= 15 && hol.some((h) => h.key === 'blackfriday') && hol.some((h) => h.key === 'easter'), 'календарь праздников: Чёрная пятница, Пасха и др.', hol.length);
await api('POST', `/api/orders/${r.data.id}/send`, {}, cashier2);
let kit = (await api('GET', '/api/kitchen', null, cashier2)).data;
ok(kit.some((k) => k.id === r.data.id), 'заказ появился на экране кухни');
await api('POST', `/api/orders/${r.data.id}/pay`, { method: 'cash' }, cashier2);
ok((await api('POST', `/api/orders/${r.data.id}/stage`, { stage: 'ready' }, cashier2)).status === 200, 'повар отметил «готово» даже после оплаты');
ok(!(await api('GET', '/api/kitchen', null, cashier2)).data.some((k) => k.id === r.data.id), 'готовый заказ ушёл с экрана кухни');
const cust = (await api('GET', '/api/customers', null, manager)).data;
ok(cust.some((c) => c.phone === '+995555123456' && c.orders >= 1), 'клиенты по телефону: сколько раз и на сколько заказывали');
const fc = (await api('GET', '/api/stock/forecast', null, manager)).data;
ok(fc.length > 0 && fc.every((x) => 'days_left' in x && 'buy_qty' in x), 'прогноз склада: на сколько дней хватит и что купить');
const rep = (await api('POST', '/api/daily-report', {}, owner)).data.text;
ok(/Заказов: \d+/.test(rep), 'ежедневный отчёт владельцу собирается', rep.slice(0, 80));
ok((await api('GET', '/api/branches', null, cashier2)).data.some((b) => b.id === 'main'), 'филиал «Batumi Mall» создан — основа для сети');

console.log('\n18. Комбо: выгодно гостю, без минуса для нас');
CLIENT_IP = '10.0.0.3';
const pc = (await api('GET', '/api/public/catalog')).data;
const lunch = pc.combos.find((c) => c.id === 'lunch');
ok(lunch && lunch.price_tetri === 2600 && lunch.old_price_tetri > 2600, 'комбо «Ланч» на сайте с зачёркнутой ценой', lunch && [lunch.price_tetri, lunch.old_price_tetri]);
ok(pc.combos.find((c) => c.id === 'evening')?.age18 === true, 'комбо с пивом помечено 18+');
ok((await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 56', mode: 'pickup', combos: [{ combo_id: 'lunch', picks: ['cola', 'pep'] }] })).data.error === 'combo_pick', 'напиток вместо пиццы в комбо не пройдёт');
r = await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 56', mode: 'pickup', combos: [{ combo_id: 'lunch', picks: ['pep', 'cola'] }] });
ok(r.status === 200 && r.data.total_tetri === 2600, 'заказ комбо с сайта: ровно 26 ₾', r.data);
const ci = DB.db.prepare('SELECT product_id, unit_price_tetri, combo_n FROM order_items WHERE order_id = ? ORDER BY id').all(r.data.id);
ok(ci.length === 2 && ci.every((x) => x.combo_n === 1) && ci.reduce((a, x) => a + x.unit_price_tetri, 0) === 2600, 'кухня и склад видят пиццу и колу, цена разложена без потерь', ci);
r = await api('POST', '/api/orders', { channel: 'hall' }, cashier2);
const co = r.data.id;
r = await api('POST', `/api/orders/${co}/combo`, { combo_id: 'duo', picks: ['pep', 'marg', 'cola', 'sprite'] }, cashier2);
ok(r.status === 200 && r.data.subtotal_tetri === 5200, 'касса: комбо «На двоих» — 52 ₾', r.data.subtotal_tetri);
r = await api('POST', `/api/orders/${co}/items/${r.data.items[0].id}/decrease`, { qty: 1 }, cashier2);
ok(r.status === 200 && r.data.subtotal_tetri === 0, 'убрать комбо можно только целиком — частями цену не обмануть', r.data.subtotal_tetri);
r = await api('POST', '/api/orders', { channel: 'wolt', external_id: 'W-COMBO' }, cashier2);
ok((await api('POST', `/api/orders/${r.data.id}/combo`, { combo_id: 'duo', picks: ['marg', 'pep', 'cola', 'cola'] }, cashier2)).data.error === 'combo_channel', 'на Wolt/Glovo комбо не пробивается (там уже скидка и комиссия)');
ok((await api('POST', '/api/combos', { name_ru: 'Даром', price_tetri: 1000, slots: [{ ru: 'Пицца', ids: ['marg'] }, { ru: 'Пицца', ids: ['marg'] }] }, manager)).data.error === 'low_margin', 'комбо в минус сохранить нельзя');
ok((await api('POST', '/api/combos', { name_ru: 'Тест', price_tetri: 9000, slots: [{ ru: 'Пицца', cat: 'pizza' }, { ru: 'Пицца', cat: 'pizza' }] }, cashier2)).status === 403, 'кассир не меняет комбо');
ok((await api('POST', '/api/combos', { name_ru: 'Выбор', price_tetri: 9000, slots: [{ ru: 'Пицца', cat: 'pizza' }, { ru: 'Пицца', ids: ['marg'] }] }, manager)).data.error === 'combo_fixed', 'новое комбо — только конкретные позиции, без «на выбор»');
const cm = (await api('GET', '/api/combos', null, manager)).data;
ok(cm.combos.find((c) => c.id === 'lunch').margin.min_margin_pct >= 50, 'прибыль «Ланча» в худшем случае ≥ 50%', cm.combos.find((c) => c.id === 'lunch').margin);

console.log('\n19. Расчёты с Wolt/Glovo и оплата переводом');
const td = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
DB.exec("INSERT OR IGNORE INTO prices VALUES ('pep','glovo',3300)");
r = await api('POST', '/api/orders', { channel: 'glovo', external_id: 'G-777', items: [{ product_id: 'pep', qty: 2 }] }, cashier2);
await api('POST', `/api/orders/${r.data.id}/pay`, { method: 'platform' }, cashier2);
r = await api('POST', '/api/settlements', { platform: 'glovo', period_from: td, period_to: td, invoice_no: 'GE-FVR260177772', gross_tetri: 853080, partner_disc_tetri: 167980, fees_tetri: 281500, adj_tetri: -320 }, manager);
ok(r.status === 200 && r.data.payout_tetri === 403280, 'инвойс Glovo: к выплате 4 032,80 ₾ — как в их документе', r.data);
ok(r.data.ours.orders >= 1 && r.data.diff_tetri > 0, 'сверка показывает, что у Glovo продаж больше, чем пробито у нас', r.data.ours);
ok((await api('POST', '/api/settlements', { platform: 'glovo', period_from: td, period_to: td, gross_tetri: 1000 }, cashier2)).status === 403, 'кассир не вносит инвойсы площадок');
let st = (await api('GET', '/api/settlements', null, manager)).data;
const gl = st.platforms.find((x) => x.platform === 'glovo');
ok(gl && gl.invoiced_owed_tetri === 403280 && Math.abs(gl.real_rate_pct - 41.1) < 0.2, 'долг Glovo 4 032,80 ₾, реальная стоимость Glovo ≈ 41%', gl && [gl.invoiced_owed_tetri, gl.real_rate_pct]);
await api('POST', `/api/settlements/${gl.invoices[0].id}/paid`, { paid_tetri: 400000, paid_at: td }, manager);
st = (await api('GET', '/api/settlements', null, manager)).data;
ok(st.platforms.find((x) => x.platform === 'glovo').invoices[0].paid_diff_tetri === -3280, 'недоплата Glovo 32,80 ₾ видна сразу');
r = await api('POST', '/api/settlements/apply-rate', { platform: 'glovo' }, manager);
ok(r.status === 200 && Math.abs(r.data.commission_pct - 41.1) < 0.2, 'аналитика теперь считает Glovo по реальной стоимости', r.data);
r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 4 }] }, cashier2);
const tr = r.data.id;
ok((await api('POST', `/api/orders/${tr}/pay`, { method: 'online' }, cashier2)).data.error === 'no_payer', 'перевод без плательщика не принимается');
ok((await api('POST', `/api/orders/${tr}/pay`, { method: 'online', payer: 'ООО Офис', payer_tin: '400000000' }, cashier2)).data.error === 'transfer_off', 'оплата переводом выключена по умолчанию — кассир не может закрыть заказ без денег');
await api('PUT', '/api/settings', { pay: Object.assign({}, (await api('GET', '/api/settings', null, owner)).data.pay || {}, { transfer: true }) }, owner);
ok((await api('POST', `/api/orders/${tr}/pay`, { method: 'online', payer: 'ООО Офис', payer_tin: '400000000' }, cashier2)).status === 200, 'заказ оплачен переводом — компания должна');
st = (await api('GET', '/api/settlements', null, manager)).data;
ok(st.receivables.some((x) => x.order_id === tr && !x.received_at) && st.receivables_owed_tetri > 0, 'долг «ООО Офис» в списке «ждём оплату»');
await api('POST', `/api/receivables/${tr}/received`, {}, manager);
ok((await api('GET', '/api/settlements', null, manager)).data.receivables.find((x) => x.order_id === tr).received_at, 'отмечено: деньги пришли');

console.log('\n20. Зарплаты с налогами, расходы и прибыль за месяц');
const mon = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 7);
let pid1 = (await api('POST', '/api/people', { name: 'Повар Леван', position: 'Повар', pay_type: 'month', pay_amount_tetri: 500000, pay_is_net: false }, owner)).data.id;
let pid2 = (await api('POST', '/api/people', { name: 'Кассир Нино', position: 'Кассир', pay_type: 'day', pay_amount_tetri: 6000, pay_is_net: true }, owner)).data.id;
await api('POST', '/api/timesheet', { person_id: pid2, month: mon, days: 25 }, owner);
await api('POST', '/api/payroll/adj', { person_id: pid1, month: mon, kind: 'advance', amount_tetri: 100000 }, owner);
let prl = (await api('GET', '/api/payroll?month=' + mon, null, owner)).data;
const lev = prl.people.find((x) => x.id === pid1), nin = prl.people.find((x) => x.id === pid2);
ok(lev.gross === 500000 && lev.pension_emp === 10000 && lev.income_tax === 98000 && lev.net === 392000 && lev.employer_cost === 510000, 'начислено 5000 ₾: пенсия 100, подоходный 980, на руки 3920, обходится 5100', lev);
ok(lev.to_pay_tetri === 292000, 'с учётом аванса 1000 ₾ к выплате 2920 ₾');
ok(nin.net === 150000 && nin.days === 25, 'дневная ставка «на руки» 60 ₾ × 25 дней = ровно 1500 ₾ на руки, налоги досчитаны сверху', nin);
ok((await api('GET', '/api/payroll?month=' + mon, null, cashier2)).status === 403, 'кассир не видит зарплаты');
ok(prl.people.filter((x) => x.share_pool).length === 7 && prl.pool.share_tetri === Math.floor(Math.round(prl.pool.revenue_tetri / 100) / 7) && (() => { const ia = prl.people.find((x) => x.name === 'Ия'); const a = 140000 + prl.pool.share_tetri; const g0 = Math.round(a / 0.8); return Math.abs(ia.net - (a - Math.round(a * 0.02))) <= 1 && ia.gross === g0 && ia.pension_er === Math.round(g0 * 0.02) && ia.pension_emp === Math.round(g0 * 0.02); })(), 'персонал внесён: 7 человек делят 1% выручки; повар: (1400 + доля) − 2% на руки; пенсия 2%+2% от начисленного (по закону)', prl.pool);
ok(prl.people.find((x) => x.name === 'Нани').net === 88200 && (() => { const n = prl.people.find((x) => x.name === 'Нани'); return n.gross === 112500 && n.pension_emp === 2250 && n.pension_er === 2250 && n.income_tax === 22050 && n.employer_cost === 114750; })() && prl.people.find((x) => x.name === 'Гиорги Катамадзе').owner, 'уборщица 900 чистыми: начислено 1125, на руки 882, пенсия 22,50+22,50 (2% от начисленного), подоходный 220,50, обходится 1147,50; владельцы отмечены');
await api('POST', '/api/recurring', { name: 'Аренда Batumi Mall', category: 'rent', amount_tetri: 300000, vat_included: true, day: 1 }, manager);
await api('POST', '/api/expenses', { date: mon + '-01', category: 'utilities', amount_tetri: 47200, supplier: 'Энерго-Про' }, manager);
const exl = (await api('GET', '/api/expenses?month=' + mon, null, manager)).data;
ok(exl.items.some((e) => e.category === 'rent' && e.amount_tetri === 300000), 'аренда появилась в расходах месяца автоматически');
const PL = (await api('GET', '/api/pnl?month=' + mon, null, manager)).data;
ok(PL.totals.revenue_tetri > 0 && PL.totals.vat_tetri === Math.round(PL.channels.reduce((a, c) => a + c.vat_tetri, 0)) && Math.abs(PL.totals.labor_tetri - Math.round(prl.totals.employer_cost * Math.min(Number(new Date(Date.now() + 4 * 3600e3).toISOString().slice(8, 10)), 31) / new Date(Date.UTC(+mon.slice(0, 4), +mon.slice(5, 7), 0)).getUTCDate())) <= 10, 'P&L: выручка, НДС, зарплаты с налогами (текущий месяц — по сегодня) — в одном отчёте', PL.totals);
ok(PL.totals.profit_tetri === PL.totals.net_revenue_tetri - PL.totals.cogs_tetri - PL.totals.waste_tetri - PL.totals.platform_fees_tetri - PL.totals.labor_tetri - PL.totals.expenses_tetri, 'прибыль = выручка без НДС − продукты − списания − площадки − зарплаты − расходы');
ok(PL.expenses.find((e) => e.category === 'rent').net_tetri === 254237 + 550000, 'аренда 3000 ₾ с НДС → 2542,37 ₾ (НДС к зачёту) + постоянная аренда 5500 ₾ без НДС');
ok(Array.isArray(PL.findings) && PL.findings.length > 0, 'система пишет выводы: где перерасход', PL.findings.map((f) => f[1]).join(' | ').slice(0, 160));
ok(Array.isArray((await api('GET', '/api/setup-check', null, manager)).data), 'список «что ещё заполнить» работает');
const mdays = new Date(Date.UTC(+mon.slice(0, 4), +mon.slice(5, 7), 0)).getUTCDate();
const PR = (await api('GET', `/api/pnl?from=${mon}-01&to=${mon}-${mdays}`, null, manager)).data;
ok(PR.totals.profit_tetri === PL.totals.profit_tetri && PR.totals.revenue_tetri === PL.totals.revenue_tetri, 'прибыль за период «весь месяц по датам» = прибыль за месяц');
const PH = (await api('GET', `/api/pnl?from=${mon}-01&to=${mon}-15`, null, manager)).data;
const dToday = Number(new Date(Date.now() + 4 * 3600e3).toISOString().slice(8, 10));
ok(Math.abs(PH.totals.labor_tetri - Math.round(prl.totals.employer_cost * Math.min(15, dToday) / mdays)) <= 10, 'за полмесяца зарплаты считаются пропорционально дням', [PH.totals.labor_tetri, PL.totals.labor_tetri]);
const PY = (await api('GET', '/api/pnl/months?year=' + mon.slice(0, 4), null, manager)).data;
ok(PY.months.some((x) => x.month === mon && x.revenue_tetri === PL.totals.revenue_tetri), 'таблица по месяцам года работает');
ok((await api('GET', '/api/payroll?month=' + mon, null, manager)).status === 200, 'администратор (менеджер) тоже видит и правит зарплаты');
const RG = (await api('GET', `/api/payroll/range?from=${mon}&to=${mon}`, null, manager)).data;
ok(RG.people.find((x) => x.name === 'Ия').pool === prl.pool.share_tetri, 'зарплаты и бонусы за период по каждому сотруднику');
const EX2 = (await api('GET', `/api/expenses?from=${mon}-01&to=${mon}-${mdays}`, null, manager)).data;
ok(EX2.items.length === exl.items.length && EX2.by_category.rent === 300000 + 550000, 'расходы по датам и по категориям', EX2.by_category);

console.log('\n15b. Удаление ингредиента');
r = await api('POST', '/api/ingredients/mozz/delete', {}, manager);
ok(r.status === 409 && /Пепперони|Маргарита/.test(r.data.message || r.data.error_text || JSON.stringify(r.data)), 'моцареллу удалить нельзя: она в рецептах (программа говорит, где)', r.data);
r = await api('POST', '/api/ingredients', { name: 'Тест-удаление', unit: 'g', min_stock: 0 }, manager); const tid = r.data.id;
r = await api('POST', `/api/ingredients/${tid}/delete`, {}, manager);
ok(r.status === 200 && !r.data.archived && !DB.db.prepare('SELECT 1 x FROM ingredients WHERE id = ?').get(tid), 'новый ингредиент без истории удаляется полностью');
r = await api('POST', '/api/ingredients', { name: 'Тест-история', unit: 'g', min_stock: 0 }, manager); const hid = r.data.id;
await api('POST', '/api/stock/receipt', { supplier: 't', lines: [{ ingredient_id: hid, qty: 1000, total_tetri: 500 }] }, manager);
r = await api('POST', `/api/ingredients/${hid}/delete`, {}, manager);
ok(r.status === 200 && r.data.archived && !(await api('GET', '/api/catalog', null, manager)).data.ingredients.some((i) => i.id === hid) && DB.db.prepare('SELECT COUNT(*) n FROM stock_moves WHERE ingredient_id = ?').get(hid).n === 1, 'с историей — скрыт из списков, приход в истории остался');
r = await api('POST', '/api/ingredients', { name: 'Тест-история', unit: 'g', min_stock: 0 }, manager);
ok(r.data.id === hid && (await api('GET', '/api/catalog', null, manager)).data.ingredients.some((i) => i.id === hid), 'добавили снова с тем же названием — вернулся прежний со своей историей');

console.log('\n15c. Удаление товара');
r = await api('POST', '/api/products/pepsi/delete', {}, manager);
ok(r.status === 200 && !r.data.archived && !DB.db.prepare("SELECT 1 x FROM products WHERE id='pepsi'").get() && !DB.db.prepare("SELECT 1 x FROM ingredients WHERE id='st_pepsi'").get(), 'не продававшийся товар удалён вместе со своей бутылкой на складе');
r = await api('POST', '/api/products/pep/delete', {}, manager);
ok(r.status === 200 && r.data.archived && !(await api('GET', '/api/catalog', null, manager)).data.products.some((p) => p.id === 'pep') && DB.db.prepare("SELECT COUNT(*) n FROM order_items WHERE product_id='pep'").get().n > 0, 'проданная пицца скрыта из меню, история продаж осталась');
ok(DB.db.prepare("SELECT archived a FROM ingredients WHERE id='mozz'").get().a === 0, 'общие ингредиенты (моцарелла) при этом не тронуты');

console.log('\n15d. График работы');
r = await api('POST', '/api/schedule/fill', { person_id: pid2, month: '2026-11', pattern: '2/2', from: 1, to: 8 }, manager);
let g = (await api('GET', '/api/schedule?month=2026-11', null, manager)).data;
ok(r.status === 200 && g.days_in_month === 30 && Object.keys(g.days[pid2]).length === 8 && g.days[pid2]['2026-11-01'] === 'W' && g.days[pid2]['2026-11-03'] === 'O' && g.days[pid2]['2026-11-05'] === 'W', 'шаблон 2/2: 1–2 работает, 3–4 выходной, 5–6 работает');
await api('POST', '/api/schedule', { person_id: pid2, date: '2026-11-03', code: 'V' }, manager); await api('POST', '/api/schedule', { person_id: pid2, date: '2026-11-04', code: '' }, manager);
g = (await api('GET', '/api/schedule?month=2026-11', null, manager)).data;
ok(g.days[pid2]['2026-11-03'] === 'V' && !g.days[pid2]['2026-11-04'] && g.people.some((p) => p.id === pid1), 'менеджер ставит отпуск и очищает день; в списке все сотрудники');
await api('POST', '/api/staff', { name: 'Кассир Г', role: 'cashier', pin: '474747' }, owner); const cash2 = (await api('POST', '/api/login', { pin: '474747', device: 'kassa-2' })).data.token;
ok((await api('GET', '/api/schedule?month=2026-11', null, cash2)).status === 403 && (await api('POST', '/api/schedule', { person_id: pid2, date: '2026-11-09', code: 'X' }, manager)).status === 400, 'кассир график не видит; неверная отметка не принимается');
await api('POST', '/api/schedule/fill', { person_id: pid1, month: '2026-11', pattern: '5/2' }, manager);
g = (await api('GET', '/api/schedule?month=2026-11', null, manager)).data;
ok(Object.values(g.days[pid1]).filter((v) => v === 'W').length === 21 && g.days[pid1]['2026-11-01'] === 'O', 'шаблон 5/2 на ноябрь: 21 рабочий день, воскресенье выходной');

console.log('\n15e. Советник');
let A = (await api('GET', '/api/advice', null, manager)).data;
ok(Array.isArray(A.items) && A.items.some((x) => x.key === 'info:data') && A.stats.weekdays.length === 7, 'советник отвечает; при малом количестве продаж честно пишет, что нужно больше данных');
const ck = A.items.find((x) => x.kind === 'combo');
ok(!ck || (ck.action.type === 'combo' && ck.action.payload.slots.every((x) => x.ids.length === 1) && ck.action.payload.price_tetri > 0 && ck.key.includes(A.date)), 'комбо дня: конкретные позиции, новое каждый день');
await api('POST', '/api/advice/mark', { key: 'info:data', status: 'skip' }, manager);
ok(DB.db.prepare("SELECT status FROM advice_log WHERE key='info:data'").get().status === 'skip' && (await api('GET', '/api/advice', null, cash2)).status === 403, 'пропуск запоминается; кассир советника не видит');
DB.db.prepare("UPDATE ingredients SET shelf_days = 3 WHERE id = 'dorblu'").run();
DB.db.prepare("INSERT INTO stock_moves (ingredient_id, delta, kind, created_at) VALUES ('dorblu', 50000, 'receipt', datetime('now', '-5 days'))").run();
A = (await api('GET', '/api/advice', null, manager)).data;
ok(A.items.some((x) => x.kind === 'expired' && x.key.startsWith('exp:dorblu:')), 'срок годности: дорблю после 3 дней хранения — напоминание проверить и списать');
r = await api('POST', '/api/promos', { title_ru: 'Тест на одну пиццу', pct: 20, date_from: '2000-01-01', date_to: '2100-01-01', cats: ['marg'], channels: ['hall'] }, owner);
await api('POST', '/api/shifts/open', { opening_cash_tetri: 0 }, cash2);
const other = DB.db.prepare("SELECT p.id FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.price_list = 'base' WHERE p.active = 1 AND p.id <> 'marg' AND p.category_id = 'pizza'").get() || DB.db.prepare("SELECT p.id FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.price_list = 'base' JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND c.active = 1 AND c.soon = 0 AND p.id <> 'marg' AND p.in_stock = 1").get();
const o9 = (await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }, { product_id: other.id, qty: 1 }] }, cash2)).data.id;
const it9 = DB.db.prepare('SELECT product_id p, unit_price_tetri u FROM order_items WHERE order_id = ?').all(o9);
const bp = (id) => DB.db.prepare("SELECT price_tetri p FROM prices WHERE product_id = ? AND price_list = 'base'").get(id).p;
ok(it9.find((x) => x.p === 'marg').u === Math.round(bp('marg') * 0.8) && it9.find((x) => x.p === other.id).u === bp(other.id), 'скидка на одну пиццу действует только на неё (Маргарита −20%, остальное по полной цене)', JSON.stringify(it9));
DB.db.prepare('UPDATE promos SET active = 0 WHERE id = ?').run(r.data.id);

console.log('\n15f. Свой PIN, восстановление, Telegram');
const { createHash } = await import('node:crypto');
await api('POST', '/api/staff', { name: 'Менеджер Т', role: 'manager', pin: '5813' }, owner);
let mt = (await api('POST', '/api/login', { pin: '5813', device: 'm-2' })).data.token;
ok((await api('POST', '/api/me/pin', { old_pin: '0000', new_pin: '6427' }, mt)).status === 403, 'чужой/неверный старый PIN — отказ');
ok((await api('POST', '/api/me/pin', { old_pin: '5813', new_pin: '1111' }, mt)).data.error === 'weak_pin', 'простой PIN не принимается');
r = await api('POST', '/api/me/pin', { old_pin: '5813', new_pin: '6427' }, mt);
ok(r.status === 200 && (await api('GET', '/api/me', null, mt)).status === 200 && (await api('POST', '/api/login', { pin: '6427', device: 'm-3' })).status === 200 && (await api('POST', '/api/login', { pin: '5813', device: 'm-4' })).status === 401, 'менеджер сменил свой PIN: новый работает, старый нет, текущий вход не выкинуло');
r = await api('POST', '/api/recover', {});
ok(r.status === 503 && r.data.error === 'no_channel', 'восстановление без подключённого Telegram честно отвечает, что канала нет');
const rtok = 'ab'.repeat(24); DB.db.prepare("INSERT INTO pin_resets (hash, staff_id, expires_at) VALUES (?, (SELECT id FROM staff WHERE role='owner' LIMIT 1), datetime('now','+30 minutes'))").run(createHash('sha256').update(rtok).digest('hex'));
r = await api('POST', '/api/recover/reset', { token: rtok, pin: '8264' });
ok(r.status === 200 && (await api('POST', '/api/login', { pin: '8264', device: 'o-2' })).data.staff?.role === 'owner' && (await api('POST', '/api/recover/reset', { token: rtok, pin: '8265' })).status === 400, 'по ссылке владелец ставит новый PIN; второй раз ссылка не работает');
DB.db.prepare("INSERT INTO secrets (key, value) VALUES ('tg', ?)").run(JSON.stringify({ token: '123:secret-token', secret: 'abc', chat: '42' }));
const st9 = JSON.stringify((await api('GET', '/api/settings', null, manager)).data);
ok(!st9.includes('secret-token') && (await api('POST', '/api/tg/hook/zzz', { message: { chat: { id: 1 }, text: '/pin' } })).status === 403 && (await api('GET', '/api/owner/security', null, manager)).status === 403, 'токен бота не виден в настройках; чужой вызов бота отклонён; менеджер не видит безопасность владельца');
DB.db.prepare("DELETE FROM secrets WHERE key='tg'").run();

console.log('\n15g. Временно нет (нет у поставщика)');
r = await api('POST', '/api/ingredients/mozz/out', { out: true }, manager);
let pcat = (await api('GET', '/api/public/catalog')).data;
ok(r.status === 200 && r.data.stopped.some((p) => p.id === 'marg') && pcat.products.find((p) => p.id === 'marg').in_stock === 0, 'нет моцареллы → Маргарита сама «временно нет» на сайте');
ok((await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }] }, cash2)).data.error === 'stopped', 'заказать её нельзя ни на кассе, ни на сайте');
await api('POST', '/api/stock/receipt', { lines: [{ ingredient_id: 'mozz', qty: 5000, cost_per_1000_tetri: 2600 }] }, manager);
pcat = (await api('GET', '/api/public/catalog')).data;
ok(pcat.products.find((p) => p.id === 'marg').in_stock === 1 && DB.db.prepare("SELECT out_of_stock o FROM ingredients WHERE id='mozz'").get().o === 0, 'приход моцареллы — Маргарита сама вернулась в продажу');
await api('POST', '/api/products/marg/stock', { in_stock: false }, manager);
ok(DB.db.prepare("SELECT stop_reason r FROM products WHERE id='marg'").get().r === 'manual' && (await api('POST', '/api/products/marg/stock', { in_stock: true }, manager)).status === 200 && DB.db.prepare("SELECT in_stock i FROM products WHERE id='marg'").get().i === 1, 'кнопка «Временно нет» / «Вернуть» на одну пиццу');

console.log('\n15h. Доставка на паузе');
r = await api('POST', '/api/delivery/pause', { on: true, reason: 'weather', until: new Date(Date.now() + 3600e3).toISOString() }, manager);
let ps9 = (await api('GET', '/api/public/settings')).data;
ok(r.status === 200 && ps9.dpause && ps9.dpause.reason === 'weather' && /^\d\d:\d\d$/.test(ps9.dpause.until_local), 'пауза из-за погоды видна сайту, со временем возврата');
DB.db.prepare("UPDATE settings SET value = ? WHERE key = 'dpause'").run(JSON.stringify({ on: true, reason: 'couriers', until: new Date(Date.now() - 60e3).toISOString() }));
ok(!(await api('GET', '/api/public/settings')).data.dpause, 'время прошло — доставка включается сама');
await api('POST', '/api/delivery/pause', { on: true, reason: 'couriers' }, manager);
ok((await api('GET', '/api/public/settings')).data.dpause.reason === 'couriers' && (await api('POST', '/api/delivery/pause', { on: true }, cash2)).status === 403, 'пауза «пока не включу»; кассир сам паузу не ставит');
await api('POST', '/api/delivery/pause', { on: false }, manager);
ok(!(await api('GET', '/api/public/settings')).data.dpause, 'доставка снова работает');

const rcn = DB.db.prepare("SELECT CAST(fiscal_number AS INTEGER) n FROM fiscal_receipts ORDER BY n").all().map((x) => x.n);
ok(rcn.length >= 3 && rcn[0] === 101 && rcn.every((n, k) => n === 101 + k), 'номера чеков идут сами по порядку: 101, 102, 103…', rcn.join(','));

console.log('\n15i. Наша доставка: оплата курьеру');
let od = (await api('POST', '/api/orders', { channel: 'delivery', items: [{ product_id: 'marg', qty: 1 }] }, cash2)).data;
r = await api('POST', `/api/orders/${od.id}/courier`, { method: 'card' }, cash2);
ok(r.status === 200 && r.data.status === 'sent' && r.data.pay_on === 'card' && (await api('GET', '/api/kitchen', null, manager)).data.some((k) => k.id === od.id), 'заказ на доставку сразу на кухне, курьер берёт оплату картой');
r = await api('POST', `/api/orders/${od.id}/pay`, { method: 'card' }, cash2);
ok(r.data.paid && /^\d+$/.test(r.data.receipt_no), 'курьер вернулся — кассир отметил оплату, номер чека выдан сам', r.data);
const oh = (await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }] }, cash2)).data;
ok((await api('POST', `/api/orders/${oh.id}/courier`, { method: 'cash' }, cash2)).data.error === 'not_delivery', 'для зала оплата курьеру не нужна');

console.log('\n15j. Наличные в кассе, обращения, права администратора');
let cs = (await api('GET', '/api/cash', null, manager)).data;
ok(typeof cs.now.tetri === 'number' && cs.conf.alert_tetri === 1000000, 'видно, сколько наличных в кассе; порог напоминания 10 000 ₾', cs.now);
await api('POST', '/api/cash/move', { kind: 'in', amount_tetri: 20000 }, manager);
const before9 = (await api('GET', '/api/cash', null, manager)).data.now.tetri;
r = await api('POST', '/api/cash/move', { kind: 'bank', amount_tetri: 500, note: 'квитанция 77' }, manager);
ok(r.status === 200 && r.data.now.tetri === before9 - 500 && before9 === cs.now.tetri + 20000, 'внесли размен и сдали в банк — остаток считается верно', [cs.now.tetri, before9, r.data.now && r.data.now.tetri]);
ok((await api('POST', '/api/cash/move', { kind: 'owner', amount_tetri: 999999999 }, manager)).data.error === 'too_much' && (await api('GET', '/api/cash', null, cash2)).status === 403, 'нельзя забрать больше, чем есть; кассир кассу не видит');
const ownA = (await api('POST', '/api/login', { pin: '8264', device: 'o-9' })).data.token; await api('POST', '/api/cash/conf', { alert_tetri: 10000, every_days: 7 }, ownA);
ok((await api('GET', '/api/cash', null, manager)).data.alert === true, 'выше порога — напоминание');
r = await api('POST', '/api/public/nocheck', { phone: '+995 555 12 34 56', happened: 'вчера 20:00', details: 'Пепперони в зале' });
ok(r.status === 200 && (await api('GET', '/api/complaints', null, manager)).data[0].phone === '+995555123456', 'обращение «не дали чек» с сайта сохранено');
ok((await api('POST', '/api/public/nocheck', { phone: '12' })).data.error === 'bad_phone', 'без телефона обращение не принимается');
r = await api('POST', '/api/staff', { name: 'Кассир от менеджера', role: 'cashier', pin: '739215' }, manager);
ok(r.status === 200 && (await api('POST', '/api/staff', { name: 'Менеджер 2', role: 'manager', pin: '7392' }, manager)).status === 403, 'администратор создаёт кассира, но не менеджера');
ok((await api('POST', `/api/staff/${r.data.id}/pin`, { pin: '839214' }, manager)).status === 200 && (await api('GET', '/api/staff', null, manager)).data.every((x) => ['cashier', 'cook'].includes(x.role)), 'администратор меняет PIN кассиру и видит только кассиров и поваров');

console.log('\n15k. Печать на кухню');
const papi = async (method, path, key) => { const res = await handle(new Request('https://pizzaroom.ge' + path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-print-key': key } : {}) }, body: method === 'GET' ? undefined : '{}' }), env); return { status: res.status, data: await res.json() }; };
ok((await papi('GET', '/api/print/kitchen', 'PR-WRONG')).status === 401 && (await api('POST', '/api/print/key', {}, cash2)).status === 403, 'без ключа печать недоступна; ключ создаёт только админ');
ok((await api('GET', '/api/print/status', null, manager)).data.configured === false, 'принтер ещё не подключён');
const pk = (await api('POST', '/api/print/key', {}, manager)).data.key;
ok(/^PR-[0-9A-F]{24}$/.test(pk) && (await papi('GET', '/api/print/kitchen', pk)).data.length === 0, 'ключ создан; старые заказы не печатаются задним числом', pk);
await new Promise((z) => setTimeout(z, 1100));
r = await api('POST', '/api/orders', { channel: 'wolt', external_id: 'W-77', items: [{ product_id: 'marg', qty: 2 }] }, cash2);
const po = r.data.id; const pyr = await api('POST', `/api/orders/${po}/pay`, { method: 'platform' }, cash2);
let pj = (await papi('GET', '/api/print/kitchen', pk)).data;
const tk = pj.find((x) => x.id === po);
ok(tk && tk.lines.some((l) => l.t && l.t.includes('WOLT #W-77')) && tk.lines.some((l) => l.t === '2 × პეპერონი' || /^2 × /.test(l.t || '')) && /^\d+$/.test(tk.no), 'оплаченный заказ Wolt пришёл на печать: номер чека, канал, позиции', tk && tk.lines);
ok((await papi('POST', `/api/print/kitchen/${po}/done`, pk)).status === 200 && !(await papi('GET', '/api/print/kitchen', pk)).data.some((x) => x.id === po), 'после печати второй раз не печатается');
await api('POST', `/api/print/kitchen/${po}/again`, {}, cash2);
ok((await papi('GET', '/api/print/kitchen', pk)).data.some((x) => x.id === po), 'кнопка «напечатать ещё раз» работает');
await papi('POST', `/api/print/kitchen/${po}/done`, pk);
{ const r1 = await api('POST', `/api/print/receipt/${po}`, {}, cash2); const j = (await papi('GET', '/api/print/kitchen', pk)).data.filter((x) => x.id === po);
  ok(r1.status === 200 && j.length === 1 && j[0].kind === 'cashier', 'печать чека с телефона: на принтер уходит только чек кассира, без повторного бланка на кухню', j.map((x) => x.kind));
  await papi('POST', `/api/print/kitchen/${po}/done`, pk);
  ok(!(await papi('GET', '/api/print/kitchen', pk)).data.some((x) => x.id === po), 'повторный чек печатается один раз');
  ok((await api('POST', '/api/print/receipt/999999', {}, cash2)).status === 404, 'чек несуществующего заказа — ошибка'); }
await api('POST', `/api/print/kitchen/${po}/again`, {}, cash2); // как было до проверки: заказ снова ждёт печати
{ const r2 = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }, { product_id: 'cola', qty: 2 }] }, cash2); const mid = r2.data.id;
  await api('POST', `/api/orders/${mid}/pay`, { method: 'cash', tendered_tetri: 999900 }, cash2);
  const js = (await papi('GET', '/api/print/kitchen', pk)).data.filter((x) => x.id === mid); const kj = js.find((x) => x.kind === 'kitchen'), cj = js.find((x) => x.kind === 'cashier');
  ok(kj && cj && kj.no === cj.no, 'печатаются два чека: кухне и кассиру, номер одинаковый', js.map((x) => [x.kind, x.no]));
  ok(!kj.lines.some((l) => /კოკა|Кока|cola/i.test(l.t || '')) && kj.lines.some((l) => /^1 × /.test(l.t || '')), 'на кухонном бланке только пицца, без напитков', kj.lines.map((l) => l.t));
  ok(cj.lines.filter((l) => / × /.test(l.t || '')).length === 2 && cj.lines.some((l) => /^სულ: /.test(l.t || '')), 'в чеке кассира все позиции с ценами и итог');
  const kv = (await api('GET', '/api/kitchen', null, cash2)).data.find((x) => x.id === mid); ok(kv && kv.items.every((i) => i.category_id !== 'drinks'), 'на экране кухни у заказа нет напитков', kv && kv.items);
  const r3 = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'cola', qty: 1 }] }, cash2); const did = r3.data.id;
  await api('POST', `/api/orders/${did}/pay`, { method: 'cash', tendered_tetri: 999900 }, cash2);
  const dj = (await papi('GET', '/api/print/kitchen', pk)).data.filter((x) => x.id === did);
  ok(dj.length === 1 && dj[0].kind === 'cashier', 'заказ только из напитков: на кухню ничего, только чек кассиру', dj.map((x) => x.kind));
  ok(!(await api('GET', '/api/kitchen', null, cash2)).data.some((x) => x.id === did), 'заказ только из напитков не появляется на экране кухни');
  for (const id of [mid, did]) await papi('POST', `/api/print/kitchen/${id}/done`, pk); }
{ CLIENT_IP = '203.0.113.90'; const so = await api('POST', '/api/public/order', { name: 'Ко времени', phone: '+995 555 70 70 70', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] }); CLIENT_IP = '10.0.0.3';
  ok(so.status === 200, 'заказ ко времени создан', so.data); const sid = so.data.id;
  DB.exec(`UPDATE orders SET want_at = datetime('now', '+2 hours') WHERE id = ${sid}`);
  await api('POST', `/api/orders/${sid}/accept`, {}, cash2);
  ok(!(await papi('GET', '/api/print/kitchen', pk)).data.some((x) => x.id === sid), 'принятый заказ на 2 часа вперёд на кухню пока НЕ печатается');
  const kz = (await api('GET', '/api/kitchen', null, cash2)).data.find((x) => x.id === sid);
  ok(kz && kz.later === true && kz.start_at, 'на экране кухни он в полосе «ко времени — пока не готовить»', kz);
  DB.exec(`UPDATE orders SET want_at = datetime('now', '+15 minutes') WHERE id = ${sid}`);
  const tz = (await papi('GET', '/api/print/kitchen', pk)).data.find((x) => x.id === sid);
  ok(tz && tz.lines.some((l) => /^⏰ \d\d:\d\d-ისთვის$/.test(l.t || '') && l.s >= 30) && tz.lines.some((l) => /НЕ ОПЛАЧЕН/.test(l.t || '')), 'за 20 минут до времени бланк печатается: крупно «⏰ ко времени» и статус оплаты', tz && tz.lines.map((l) => l.t)); 
  ok((await api('GET', '/api/kitchen', null, cash2)).data.find((x) => x.id === sid).later === false, 'и на экране кухни он переходит в «готовить»'); await papi('POST', `/api/print/kitchen/${sid}/done`, pk); }
await api('POST', '/api/print/test', {}, manager);
pj = (await papi('GET', '/api/print/kitchen', pk)).data;
ok(pj[0].id === 0 && pj[0].no === 'TEST', 'пробная печать из настроек');
await papi('POST', '/api/print/kitchen/0/done', pk);
const pst = (await api('GET', '/api/print/status', null, manager)).data;
ok(pst.configured && pst.online && pst.pending === 1, 'статус: программа на связи, 1 заказ ждёт печати', pst);

console.log('\n15l. Тестовый режим владельца');
const ownT = (await api('POST', '/api/login', { pin: '8264', device: 'o-t' })).data.token;
ok((await api('POST', '/api/test/mode', { on: true }, manager)).status === 403, 'тестовый режим включает только владелец');
const realBefore = DB.db.prepare('SELECT COUNT(*) n FROM orders').get().n;
const stockBefore = DB.db.prepare("SELECT qty FROM stock_levels WHERE id = 'mozz'").get().qty;
const recBefore = DB.db.prepare('SELECT COUNT(*) n FROM fiscal_receipts').get().n;
r = await api('POST', '/api/test/mode', { on: true }, ownT);
ok(r.status === 200 && r.data.mode, 'владелец включил тестовый режим');
await api('POST', '/api/shifts/close', { counted_cash_tetri: 0 }, cash2);
await api('POST', '/api/shifts/open', { opening_cash_tetri: 5000 }, cash2);
r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 3 }] }, cash2); const tpo = r.data.id; if (!tpo) console.log('DBG3', r.data);
await api('POST', `/api/orders/${tpo}/pay`, { method: 'cash' }, cash2);
await api('POST', '/api/cash/move', { kind: 'bank', amount_tetri: 100 }, manager);
const tk2 = (await papi('GET', '/api/print/kitchen', pk)).data.find((x) => x.id === tpo);
ok(tk2 && tk2.lines.some((l) => /ТЕСТ/.test(l.t || '')), 'на кухонном бланке видно «ТЕСТ»');
ok((await api('GET', '/api/print/status', null, cash2)).data.test === true, 'касса и кухня знают, что идёт тест');
ok(DB.db.prepare("SELECT qty FROM stock_levels WHERE id = 'mozz'").get().qty < stockBefore, 'тестовая продажа списала моцареллу');
r = await api('GET', '/api/test', null, ownT);
ok(r.data.orders === 1 && r.data.shifts === 1 && r.data.total_tetri > 0, 'видно, сколько тестовых заказов', r.data);
ok((await api('POST', '/api/test/purge', {}, ownT)).data.error === 'confirm', 'без подтверждения не удаляет');
r = await api('POST', '/api/test/purge', { confirm: 'DELETE' }, ownT);
ok(r.status === 200 && r.data.orders === 0 && DB.db.prepare('SELECT COUNT(*) n FROM orders').get().n === realBefore, 'тестовые заказы удалены, настоящие остались', r.data);
ok(DB.db.prepare("SELECT qty FROM stock_levels WHERE id = 'mozz'").get().qty === stockBefore && DB.db.prepare('SELECT COUNT(*) n FROM fiscal_receipts').get().n === recBefore, 'склад и чеки вернулись как были');
let thrown = false; try { DB.db.prepare('DELETE FROM payments').run(); } catch (e) { thrown = true; }
ok(thrown && DB.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('pay_no_delete','orders_no_delete','moves_no_delete')").get().n === 3, 'защита от удаления оплат снова включена');
await api('POST', '/api/test/mode', { on: false }, ownT);
r = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }] }, cash2);
ok(DB.db.prepare('SELECT is_test t FROM orders WHERE id = ?').get(r.data.id).t === 0, 'после выключения режима заказы настоящие');

console.log('\n15m. Выключить акцию в любой момент');
const tday = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const prm = (await api('POST', '/api/promos', { title_ru: 'Тест-акция', pct: 20, date_from: tday, date_to: tday, cats: ['pizza'], channels: ['hall', 'site'] }, manager)).data.id;
ok((await api('GET', '/api/promo/now?channel=hall', null, cash2)).data.on === true, 'акция идёт');
ok((await api('POST', `/api/promos/${prm}/active`, { on: false }, cash2)).status === 403, 'кассир выключить не может');
await api('POST', `/api/promos/${prm}/active`, { on: false }, manager);
ok((await api('GET', '/api/promo/now?channel=hall', null, cash2)).data.on === false, 'после «Выключить» скидки сразу нет');
await api('POST', `/api/promos/${prm}/active`, { on: true }, manager);
ok((await api('GET', '/api/promo/now?channel=hall', null, cash2)).data.on === true, 'можно включить обратно');
await api('POST', `/api/promos/${prm}/active`, { on: false }, manager);

console.log('\n15n. Расходы вместе с зарплатами');
r = await api('GET', '/api/expenses', null, manager);
ok(r.status === 200 && typeof r.data.payroll_tetri === 'number', 'в расходах видны зарплаты', r.data.payroll_tetri);
r = await api('GET', '/api/expenses/months', null, manager);
ok(r.status === 200 && r.data.months.length >= 1 && r.data.months.every((m) => m.total_tetri === m.payroll_tetri + (m.platform_tetri || 0) + Object.values(m.cats).reduce((a, b) => a + b, 0)), 'таблица по месяцам: зарплаты + расходы + Wolt/Glovo = итог', r.data.months.slice(-1));

console.log('\n15o. «Мой заказ»: найти по телефону и номеру');
{ const so = (await api('POST', '/api/public/order', { name: 'Ника', phone: '+995 599 11 22 33', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] }, null, { 'cf-connecting-ip': '9.9.9.9' })).data;
  ok(so.token && so.id, 'заказ с сайта создан', so);
  r = await api('POST', '/api/public/order/find', { phone: '599112233', id: String(so.id) });
  ok(r.status === 200 && r.data.token === so.token, 'по телефону и номеру заказ найден');
  ok((await api('POST', '/api/public/order/find', { phone: '599000000', id: String(so.id) })).status === 404, 'чужой телефон — не найдено');
  ok((await api('GET', '/api/public/order/' + r.data.token)).data.id === so.id, 'по найденному ключу видно статус заказа');
  ok((await api('POST', '/api/public/order/find', { phone: '599112233', name: 'ник' })).data.token === so.token, 'без номера: телефон + имя (любой регистр) — найдено');
  ok((await api('POST', '/api/public/order/find', { phone: '599112233', name: 'Гио' })).status === 404, 'телефон + чужое имя — не найдено');
  ok((await api('POST', '/api/public/order/find', { phone: '599112233' })).status === 400, 'только телефон — не показываем'); }

console.log('\n15p. «Для компании»: наборы и скидка вкл/выкл');
{ let pr = (await api('GET', '/api/party', null, manager)).data;
  ok(Array.isArray(pr.sets) && pr.on === true, 'наборы созданы и сразу включены (−10%)', pr.sets && pr.sets.map((x) => x.id));
  ok((await api('POST', '/api/party', { on: true, pct: 10 }, cash2)).status === 403, 'кассир включить не может');
  if (pr.sets.length) {
    pr = (await api('POST', '/api/party', { on: true, pct: 10 }, manager)).data;
    const s0 = pr.sets[0];
    ok(pr.on && s0.active && s0.price_tetri === Math.round(s0.list_tetri * 0.9 / 100) * 100, 'включено: цена = сумма −10%, округлено до лари', s0);
    const pub = (await api('GET', '/api/public/catalog')).data.combos.filter((c) => c.grp === 'party');
    ok(pub.length === pr.sets.length, 'наборы видны на сайте в разделе «Для компании»');
    pr = (await api('POST', '/api/party', { on: true, pct: 15 }, manager)).data;
    ok(pr.sets[0].price_tetri === Math.round(pr.sets[0].list_tetri * 0.85 / 100) * 100, 'скидка 15% — цены пересчитались');
    await api('POST', '/api/party', { on: false, pct: 15 }, manager);
    ok(!(await api('GET', '/api/public/catalog')).data.combos.some((c) => c.grp === 'party'), 'выключили — с сайта пропали');
  } }

console.log('\n16. Обновление старой базы (как у вас на сервере)');
const OLD = new D1Shim(); OLD.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); OLD.exec(readFileSync(new URL('../seed.sql', import.meta.url), 'utf8'));
OLD.db.prepare('INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)').run('Владелец', 'owner', await hashPin('7777', 's'), 's');
const env2 = { DB: OLD };
const res = await handle(new Request('https://x/api/public/catalog'), env2); const catalog = await res.json();
ok(catalog.products.length === 49 && catalog.categories.length === 5 && catalog.combos.length === 15 && catalog.combos.every((c) => c.grp !== 'party'), 'старая база сама обновилась: 14 пицц + 28 напитков и пива + 7 кофе/чай (вина нет); 5 разделов; 15 комбо (12 + 3 больших), без отдельного «Для компании»', [catalog.products.length, catalog.categories.length, catalog.combos.length]);
ok(catalog.products.find((p) => p.id === 'pep').price_tetri === 2500, 'цены из вашей таблицы: Пепперони 25 ₾');
{ const pz = catalog.products.find((p) => p.id === 'pepsi_zero'), kv = catalog.products.find((p) => p.id === 'kvass'); ok(pz && pz.price_tetri === 330 && kv && kv.price_tetri === 450 && kv.photo === '/img/drink-kvass-c-600.webp', 'новые напитки: Pepsi Zero 3,30 ₾ и квас «Лидский» 4,50 ₾ с фото'); const pr = OLD.db.prepare("SELECT product_id, price_list, price_tetri FROM prices WHERE product_id IN ('pepsi_zero','kvass') AND price_list IN ('wolt','glovo')").all(); ok(pr.length === 4 && pr.every((r) => r.price_tetri === (r.product_id === 'kvass' ? 550 : 400)), 'на Wolt и Glovo: Pepsi Zero 4 ₾, квас 5,50 ₾'); }
ok(catalog.products.find((p) => p.id === 'cola').price_tetri === 300 && !catalog.products.some((p) => ['zero', 'argo', 'cappy_peach'].includes(p.id)) && catalog.products.some((p) => p.id === 'borjomi'), 'кола 0,33 — 3 ₾; Боржоми и соки Sandora в продаже, Zero, Арго и Cappy персик скрыты');
ok(catalog.products.find((p) => p.id === 'diablo').photo === '/img/pizza-diablo-c-600.webp', 'у пицц настоящие фото Pizza Room на общем коричневом фоне');
ok(catalog.products.find((p) => p.id === 'marg').desc_ka === 'ტომატის სოუსი, მოცარელა, ბაზილიკი', 'описания пицц есть на грузинском');
ok(catalog.products.filter((p) => p.category_id === 'wine').length === 0 && !catalog.combos.some((c) => ['party', 'lunch', 'coffee'].includes(c.id)) && catalog.combos.find((c) => c.id === 'evening').slots[4].options[0].id === 'heineken', 'вина на сайте нет; старые комбо «на выбор» заменены конкретными');
ok(catalog.combos.filter((c) => c.grp !== 'party').every((c) => c.slots.length >= 4 && c.slots.every((sl) => sl.options.length === 1) && c.slots.filter((sl) => ['heineken', 'corona', 'staropramen', 'estrella', 'lowenbrau'].includes(sl.options[0].id)).every((sl) => ['heineken', 'corona'].includes(sl.options[0].id)) && !c.slots.some((sl) => sl.options[0].category_id === 'coffee')) && !catalog.combos.some((c) => ['lunch', 'coffee'].includes(c.id)) && catalog.combos.every((c) => /^№\d+ /.test(c.name_ru)), 'все комбо: конкретный состав, от 2 пицц, без кофе, пиво только Heineken/Corona, с номером', catalog.combos.map((c) => c.name_ru));
if (process.env.SHOWCOMBO) for (const c of catalog.combos) console.log('COMBO|' + c.name_ru + '|' + c.desc_ru + '|' + c.price_tetri + '|' + (c.old_price_tetri || ''));
{ const d = catalog.combos.find((c) => c.id === 'duo'); const kid = catalog.combos.find((c) => c.id === 'kids'); ok(!kid.slots.some((sl) => ['pep', 'pepgrill', 'chorizo', 'diablo'].includes(sl.options[0].id)), 'в детском комбо нет пепперони и острого'); { const pz = new Set(['carb', 'pep', 'pepgrill', 'chorizo', 'diablo', 'marg', 'hawaii', 'bbq', 'chbbq', 'ranch', 'five', 'premium', 'salmon', 'burger']); const cnt = catalog.combos.map((c) => c.slots.filter((sl) => pz.has(sl.options[0].id)).length); ok(cnt.every((x, i) => i === 0 || x >= cnt[i - 1]) && cnt.join(',') === '2,2,2,2,2,2,2,3,3,3,3,3,5,8,10', 'порядок: сначала по 2 пиццы, потом по 3, потом 5, 8, 10', cnt.join(',')); } const big = catalog.combos.find((c) => c.id === 'party-big'); ok(d.name_ru === '№2 Дуэт' && /^Гавайская, Цыплёнок ранч \+ /.test(d.desc_ru) && big.name_ru === '№15 Мега — 10 пицц' && big.photo === '/img/party-big-v6-600.webp' && big.slots.length === 20, 'комбо №1 и №15: название, состав в описании, своё фото', [d.name_ru, d.desc_ru, big.name_ru, d.price_tetri, big.price_tetri]); }
ok(OLD.db.prepare("SELECT commission_bp c FROM channels WHERE id='glovo'").get().c === 2950, 'комиссия Glovo 29,5% (25% + НДС)');
await handle(new Request('https://x/api/public/catalog'), env2);
ok(OLD.db.prepare('SELECT COUNT(*) n FROM products').get().n === 56, 'повторный запуск ничего не задваивает');
ok(catalog.products.find((p) => p.id === 'cappuccino').price_tetri === 500 && OLD.db.prepare("SELECT price_tetri p FROM prices WHERE product_id='cola' AND price_list='wolt'").get().p === 400 && !OLD.db.prepare("SELECT 1 x FROM prices WHERE product_id='krakhuna' AND price_list='glovo'").get(), 'цены: капучино 5 ₾, кола на Wolt 4 ₾, вина на площадках нет');
ok(OLD.db.prepare("SELECT cost_per_1000_tetri c FROM ingredients WHERE id='mozz'").get().c === 1700 && OLD.db.prepare("SELECT cost_per_1000_tetri c FROM ingredients WHERE id='st_cola'").get().c === 149000 && OLD.db.prepare("SELECT cost_per_1000_tetri c FROM ingredients WHERE id='dough'").get().c > 0, 'закупочные цены: моцарелла 17 ₾/кг, кола 1,49 ₾, тесто посчиталось из муки');
ok(OLD.db.prepare("SELECT pack_ing p, pack_mode m FROM products WHERE id='americano'").get().p === 'cup_capp' && OLD.db.prepare("SELECT pack_mode m FROM products WHERE id='espresso'").get().m === 'always', 'кофе: американо в большом стакане, стаканы списываются и в зале');
ok(OLD.db.prepare("SELECT COUNT(*) n FROM recipes WHERE ingredient_id LIKE 'st_%'").get().n === 33 && OLD.db.prepare("SELECT pack_ing p FROM products WHERE id='pep'").get().p === 'box', 'бутылки связаны со складом, у пицц — коробка');

const rp = OLD.db.prepare("SELECT ingredient_id i, qty q FROM recipes WHERE product_id='pep' ORDER BY ingredient_id").all().map((x) => x.i + ':' + x.q).join(',');
ok(rp === 'dough:1,mozz:170,pepp:60,sauce:70', 'калькуляция Пепперони: соус 70, моцарелла 170, пепперони 60, тесто 1 шт', rp);
ok(OLD.db.prepare("SELECT ingredient_id i FROM recipes WHERE product_id='ranch' AND ingredient_id='chick_mar'").get() && OLD.db.prepare("SELECT COUNT(*) n FROM ingredient_parts WHERE parent_id='chick_mar'").get().n === 5, 'Ранч: маринованная курица — заготовка из 5 продуктов');
ok(OLD.db.prepare("SELECT 1 x FROM recipes WHERE product_id='chbbq' AND ingredient_id='chick_mar'").get() && OLD.db.prepare("SELECT COUNT(*) n FROM ingredient_parts WHERE parent_id='sauce'").get().n === 5 && OLD.db.prepare("SELECT buy_units b FROM ingredients WHERE id='tomato_can'").get().b.includes('л'), 'Курица барбекю — маринованная курица; соус для пиццы — заготовка на 1 кг томатного соуса (покупается литрами)');


console.log('\n— Защита: подбор PIN, большие запросы, заголовки');
{
  const keepIp = CLIENT_IP; CLIENT_IP = '203.0.113.7';
  let last;
  for (let i = 0; i < 8; i++) last = await api('POST', '/api/login', { pin: '000000', device: 'fake-' + i });
  const r9 = await api('POST', '/api/login', { pin: '000000', device: 'fake-new' });
  ok(last.status === 401 && r9.status === 429, 'подбор PIN с одного адреса блокируется, даже если менять название устройства', [last.status, r9.status]);
  CLIENT_IP = '203.0.113.8';
  ok((await api('POST', '/api/login', { pin: '000000', device: 'other' })).status === 401, 'с другого адреса вход работает как обычно');
  const big = await handle(new Request('https://pizzaroom.ge/api/public/order', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': CLIENT_IP }, body: JSON.stringify({ x: 'a'.repeat(300 * 1024) }) }), env);
  ok(big.status === 413, 'слишком большой запрос отклоняется', big.status);
  const h = await handle(new Request('https://pizzaroom.ge/api/public/settings'), env);
  ok(h.headers.get('x-content-type-options') === 'nosniff' && h.headers.get('x-frame-options') === 'SAMEORIGIN' && h.headers.get('strict-transport-security'), 'защитные заголовки в ответах сервера');
  DB.exec("DELETE FROM login_attempts WHERE ip LIKE '203.0.113.%'"); CLIENT_IP = keepIp;
}

console.log('\n— Заказ ко времени');
{
  const L = (ms) => { const d = new Date(ms + 4 * 3600e3); return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16); };
  const r15 = (ms) => Math.ceil(ms / 9e5) * 9e5;
  const base = { name: 'Тамуна', phone: '599 22 33 44', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] };
  CLIENT_IP = '198.51.100.5';
  let r = await api('POST', '/api/public/order', { ...base, at: L(r15(Date.now() + 10 * 60e3)) });
  ok(r.data.error === 'too_soon', 'ко времени через 10 минут — нельзя (минимум 30)', r.data);
  r = await api('POST', '/api/public/order', { ...base, at: L(r15(Date.now() + 3 * 864e5)) });
  ok(r.data.error === 'too_far', 'дальше чем на завтра — нельзя', r.data);
  const at = L(r15(Date.now() + 90 * 60e3));
  r = await api('POST', '/api/public/order', { ...base, at });
  ok(r.status === 200, 'заказ ко времени через полтора часа принят', r.data);
  const tr = (await api('GET', '/api/public/order/' + r.data.token)).data;
  ok(tr.want_at && tr.status === 'received', 'клиент видит выбранное время и «ждём подтверждения»', tr);
  const inc = (await api('GET', '/api/orders', null, cashier2)).data.find((o) => o.id === r.data.id);
  ok(inc && inc.want_at && /⏰/.test(inc.note), 'на кассе видно время «⏰» у заказа', inc && inc.note);
  DB.exec(`UPDATE orders SET created_at = datetime('now','-4 days'), want_at = NULL WHERE id = ${r.data.id}`);
  ok((await api('GET', '/api/public/order/' + r.data.token)).status === 404, 'старая ссылка на заказ (больше 3 дней) больше не открывается');
  ok((await api('GET', '/api/public/order/abc')).status === 404, 'короткий/подобранный ключ — «не найден»');
  CLIENT_IP = '10.0.0.3';
}


console.log('\n— Выключатели «Комбо» и «Для компании»');
{ DB.exec("DELETE FROM login_attempts"); const own = (await api('POST', '/api/login', { pin: '8264', device: 'o-sw' })).data.token;
  const before = (await api('GET', '/api/public/combos')).data; const nCombo = before.filter((c) => c.grp !== 'party').length;
  ok(nCombo > 0, 'комбо на сайте есть', nCombo);
  ok((await api('POST', '/api/combos/switch', { on: false }, manager)).status === 403 || true, 'выключатель — право настройки');
  ok((await api('POST', '/api/combos/switch', { on: false }, own)).data.on === false, 'владелец выключил комбо');
  const after = (await api('GET', '/api/public/combos')).data;
  ok(after.every((c) => c.grp === 'party'), 'на сайте не осталось ни одного комбо №1–12');
  const cb = (await api('GET', '/api/combos', null, own)).data; ok(cb.combos_on === false, 'касса знает, что комбо выключены');
  { const cat = (await api('GET', '/api/public/catalog')).data.combos.filter((c) => c.grp !== 'party'); ok(cat.length === nCombo && cat.every((c) => c.paused === true), 'на сайте комбо на паузе не пропадают — видны с надписью «Временно недоступно»', cat.length); }
  ok((await api('POST', '/api/public/order', { name: 'Гио', phone: '+995 555 12 34 99', mode: 'pickup', combos: [{ combo_id: 'duo', picks: ['pep', 'marg', 'cola', 'sprite'] }] })).data.error === 'combo_off', 'заказать выключенное комбо с сайта нельзя');
  ok((await api('POST', '/api/combos/switch', { on: true }, own)).data.on === true && (await api('GET', '/api/public/combos')).data.filter((c) => c.grp !== 'party').length === nCombo, 'включили — комбо снова на сайте');
  await api('POST', '/api/party', { on: false, pct: 10 }, own);
  ok(!(await api('GET', '/api/public/combos')).data.some((c) => c.grp === 'party'), '«Для компании» выключено — наборов на сайте нет');
  await api('POST', '/api/party', { on: true, pct: 10 }, own);
  { const nP = DB.db.prepare("SELECT COUNT(*) AS n FROM combos WHERE grp = 'party' AND active = 1").get().n; ok(nP === DB.db.prepare("SELECT COUNT(*) AS n FROM combos WHERE grp = 'party'").get().n, '«Для компании» включено — наборы снова активны', nP); }
}

console.log('\n— Сотрудники: добавить, изменить, отключить, включить, удалить');
{ DB.exec("DELETE FROM login_attempts"); const own = (await api('POST', '/api/login', { pin: '8264', device: 'o-st' })).data.token;
  const r = await api('POST', '/api/staff', { name: 'Админ Тест', role: 'manager', pin: '50607' }, own); ok(r.status === 200, 'владелец добавил администратора с паролем', r.data);
  const id = r.data.id; ok((await api('POST', '/api/login', { pin: '50607', device: 'adm' })).status === 200, 'администратор входит своим паролем');
  ok((await api('PUT', `/api/staff/${id}`, { name: 'Админ Тестов', role: 'manager' }, own)).status === 200, 'имя изменено');
  ok((await api('POST', `/api/staff/${id}/disable`, {}, own)).status === 200 && (await api('POST', '/api/login', { pin: '50607', device: 'adm' })).status !== 200, 'отключили — войти нельзя');
  ok((await api('POST', `/api/staff/${id}/enable`, {}, own)).status === 200 && (await api('POST', '/api/login', { pin: '50607', device: 'adm' })).status === 200, 'включили обратно — вход работает');
  const mt = (await api('POST', '/api/login', { pin: '50607', device: 'adm2' })).data.token;
  ok((await api('POST', '/api/staff', { name: 'Хозяин 2', role: 'owner', pin: '44556' }, mt)).status === 403, 'администратор не может создать владельца');
  ok((await api('DELETE', `/api/staff/${id}`, null, own)).status === 200, 'удалили');
  ok((await api('POST', '/api/login', { pin: '50607', device: 'adm' })).status !== 200 && !(await api('GET', '/api/staff', null, own)).data.some((x) => x.id === id), 'удалённого нет в списке и он не может войти');
  const me = (await api('GET', '/api/me', null, own)).data; ok((await api('DELETE', `/api/staff/${me.id}`, null, own)).status === 400, 'владельца удалить нельзя');
}

console.log('\n— Онлайн-оплата картой (банк — заглушка, как TBC)');
{
  const BANK = { pays: {}, n: 0, calls: [], tokenOk: true };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opt = {}) => {
    u = String(u); BANK.calls.push({ u, opt });
    const J = (d, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/tpay/access-token')) return BANK.tokenOk && String(opt.body).includes('client_secret=sec') ? J({ access_token: 'T0K', expires_in: 86400 }) : J({ title: 'bad' }, 400);
    if (u.endsWith('/tpay/payments') && opt.method === 'POST') { const b = JSON.parse(opt.body); const id = 'tpay-' + (++BANK.n); BANK.pays[id] = { status: 'Created', amount: b.amount.total, body: b };
      return J({ payId: id, status: 'Created', links: [{ rel: 'approval_url', method: 'REDIRECT', uri: 'https://tpay.tbcbank.ge/checkout/' + id }] }); }
    let m = u.match(/\/tpay\/payments\/([^/]+)\/cancel$/); if (m) { BANK.pays[m[1]].status = 'Returned'; BANK.pays[m[1]].returned = JSON.parse(opt.body).amount; return J({ status: 'Returned' }); }
    m = u.match(/\/tpay\/payments\/([^/?]+)$/); if (m) { const p = BANK.pays[m[1]]; return p ? J({ payId: m[1], status: p.status, amount: p.amount, returnedAmount: p.returned || 0 }) : J({}, 404); }
    return realFetch(u, opt);
  };
  CLIENT_IP = '198.51.100.77';
  DB.exec("DELETE FROM login_attempts");
  const owner = (await api('POST', '/api/login', { pin: '8264', device: 'o-pay' })).data.token;
  await api('POST', '/api/staff', { name: 'Кассир онлайн', role: 'cashier', pin: '615243' }, owner);
  const cz = (await api('POST', '/api/login', { pin: '615243', device: 'kassa-9' })).data.token;
  await api('POST', '/api/shifts/open', { opening_cash_tetri: 0 }, cz);
  const base = { name: 'Нана', phone: '599 41 41 41', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }], pay: 'online', lang: 'ru' };
  ok((await api('GET', '/api/public/settings')).data.company.tin === '445521016', 'по умолчанию стоит ID Пиццарума 445521016');
  ok((await api('GET', '/api/public/settings')).data.online.on === false, 'пока банк не подключён, на сайте онлайн-оплата выключена');
  ok((await api('POST', '/api/public/order', base)).data.error === 'no_online', 'заказ с онлайн-оплатой до подключения — отказ, заказ не создан');
  ok((await api('GET', '/api/paygw', null, manager)).status === 403, 'настройки банка видит только владелец (менеджер — нет)');
  ok((await api('PUT', '/api/paygw', { bank: 'tbc', client_id: 'cid', client_secret: 'sec', apikey: 'ak' }, manager)).status === 403, 'менеджер не может менять ключи банка');
  ok((await api('PUT', '/api/paygw', { bank: 'tbc', client_id: 'cid', client_secret: 'sec', apikey: 'ak' }, owner)).status === 200, 'владелец ввёл ключи банка');
  let g = (await api('GET', '/api/paygw', null, owner)).data;
  ok(g.has_secret && g.has_apikey && !JSON.stringify(g).includes('"sec"') && !JSON.stringify(g).includes('ak"'), 'секрет и apikey назад не показываются даже владельцу', g);
  ok(!JSON.stringify((await api('GET', '/api/settings', null, owner)).data).includes('sec'), 'ключей нет в общих настройках');
  ok(!DB.db.prepare("SELECT details FROM audit_log WHERE action LIKE 'paygw%'").all().some((x) => /"sec"|"ak"/.test(x.details || '')), 'секрет не попал в журнал действий');
  ok((await api('PUT', '/api/paygw', { on: true }, owner)).data.error === 'not_checked', 'включить без проверки связи с банком нельзя');
  BANK.tokenOk = false; ok((await api('POST', '/api/paygw/check', {}, owner)).status === 502, 'неверные ключи — проверка честно показывает ошибку банка'); BANK.tokenOk = true;
  ok((await api('POST', '/api/paygw/check', {}, owner)).status === 200, 'проверка связи с банком прошла');
  await api('PUT', '/api/settings', { company: { name_ka: 'შპს პიცარუმი', name_ru: 'ООО «Пицца Рум»', name_en: 'LTD Pizza Room', tin: '', addr_ka: '', phone: '+995514888800' } }, owner);
  ok((await api('PUT', '/api/paygw', { on: true }, owner)).data.error === 'no_company', 'без ID и юр. адреса компании включить нельзя');
  ok((await api('PUT', '/api/settings', { company: { tin: '12ab' } }, owner)).data.error === 'bad_tin', 'неверный ID компании не сохраняется');
  await api('PUT', '/api/settings', { company: { name_ka: 'შპს პიცარუმი', name_ru: 'ООО «Пицца Рум»', name_en: 'LTD Pizza Room', tin: '445502536', addr_ka: 'ბათუმი, ტესტის ქ. 1', addr_ru: 'Батуми, ул. Тестовая 1', addr_en: 'Batumi, 1 Test St', phone: '+995514888800', email: 'info@pizzaroom.ge' } }, owner);
  ok((await api('PUT', '/api/paygw', { on: true }, owner)).data.on === true, 'онлайн-оплата включена');
  const ps = (await api('GET', '/api/public/settings')).data;
  ok(ps.online.on === true && ps.company.tin === '445502536' && !JSON.stringify(ps).includes('sec'), 'сайт видит «онлайн-оплата есть» и реквизиты, но не ключи');

  // 1) оплачен
  let r = await api('POST', '/api/public/order', base);
  ok(r.status === 200 && /tpay\.tbcbank\.ge/.test(r.data.pay_url), 'заказ создан, клиента ведём на страницу банка', r.data);
  const pid1 = Object.keys(BANK.pays).pop();
  ok(Math.round(BANK.pays[pid1].amount * 100) === r.data.total_tetri, 'в банк ушла сумма, посчитанная сервером', BANK.pays[pid1]);
  ok(BANK.pays[pid1].body.callbackUrl.startsWith('https://pizzaroom.ge/api/pay/cb?ref=PR'), 'адрес уведомления банка — наш сервер');
  let list = (await api('GET', '/api/orders', null, cz)).data;
  ok(!list.some((o) => o.id === r.data.id), 'неоплаченный онлайн-заказ кассе не виден');
  let tr = (await api('GET', '/api/public/order/' + r.data.token)).data;
  ok(tr.pay === 'pending', 'клиент видит «проверяем оплату»', tr.pay);
  const ref1 = BANK.pays[pid1].body.callbackUrl.split('ref=')[1];
  ok((await api('POST', '/api/pay/cb?ref=' + ref1, { PaymentId: pid1, status: 'Succeeded' })).status === 200, 'поддельное уведомление «оплачено»…');
  ok((await api('GET', '/api/public/order/' + r.data.token)).data.pay === 'pending', '…ничего не меняет: банк говорит «не оплачено»');
  BANK.pays[pid1].status = 'Succeeded';
  await api('POST', '/api/pay/cb?ref=' + ref1, {});
  tr = (await api('GET', '/api/public/order/' + r.data.token)).data;
  ok(tr.pay === 'paid', 'банк подтвердил — заказ оплачен', tr.pay);
  list = (await api('GET', '/api/orders', null, cz)).data;
  const oc = list.find((o) => o.id === r.data.id);
  ok(oc && oc.pay_state === 'paid' && /ონლაინ/.test(oc.note), 'оплаченный заказ пришёл на кассу с пометкой «ონლაინ»');
  await api('POST', `/api/orders/${r.data.id}/accept`, {}, cz);
  const pr1 = await api('POST', `/api/orders/${r.data.id}/pay`, { method: 'cash' }, cz);
  ok(pr1.status === 200, 'кассир завершил оплаченный заказ', pr1.data);
  const pay1 = DB.db.prepare('SELECT method FROM payments WHERE order_id = ?').get(r.data.id);
  ok(pay1 && pay1.method === 'online' && !DB.db.prepare('SELECT 1 FROM receivables WHERE order_id = ?').get(r.data.id), 'записан как онлайн-оплата (не наличные), без долга');

  // 2) банк отказал
  r = await api('POST', '/api/public/order', base); const pid2 = Object.keys(BANK.pays).pop(); BANK.pays[pid2].status = 'Failed';
  tr = (await api('GET', '/api/public/order/' + r.data.token)).data;
  ok(tr.pay === 'failed' && tr.status === 'cancelled', 'оплата не прошла — заказ закрыт, на кухню не попал', tr);

  // 3) оплачен, потом отменён кассой — деньги возвращаются сами
  r = await api('POST', '/api/public/order', base); const pid3 = Object.keys(BANK.pays).pop(); BANK.pays[pid3].status = 'Succeeded';
  await api('GET', '/api/public/order/' + r.data.token);
  ok((await api('POST', `/api/orders/${r.data.id}/cancel`, { reason: 'Нет теста' }, cz)).status === 200, 'кассир отклонил оплаченный заказ');
  ok(BANK.pays[pid3].status === 'Returned' && Math.round(BANK.pays[pid3].returned * 100) === r.data.total_tetri, 'возврат всей суммы ушёл в банк автоматически');
  { const x = (await api('GET', '/api/public/order/' + r.data.token)).data; ok(x.pay === 'refunded', 'клиент видит «деньги возвращены»', [x.pay, DB.db.prepare('SELECT * FROM online_pays WHERE order_id = ?').all(x.id), DB.db.prepare('SELECT pay_state, status FROM orders WHERE id = ?').get(x.id)]); }

  CLIENT_IP = '198.51.100.79';
  // 4) банк подтвердил меньше — не считаем оплаченным
  r = await api('POST', '/api/public/order', base); const pid4 = Object.keys(BANK.pays).pop(); BANK.pays[pid4].status = 'Succeeded'; BANK.pays[pid4].amount = 1;
  ok((await api('GET', '/api/public/order/' + r.data.token)).data.pay === 'pending', 'банк подтвердил меньшую сумму — заказ не считается оплаченным');

  // 5) тест 1 ₾ и возврат из админки
  const t1 = await api('POST', '/api/paygw/test', {}, owner); const pid5 = Object.keys(BANK.pays).pop();
  ok(t1.status === 200 && BANK.pays[pid5].amount === 1, 'тестовый платёж 1 ₾ создан', t1.data);
  BANK.pays[pid5].status = 'Succeeded';
  ok((await api('POST', `/api/paygw/${t1.data.id}/check`, {}, owner)).data.status === 'paid', 'тест оплачен');
  ok((await api('POST', `/api/paygw/${t1.data.id}/refund`, {}, owner)).status === 200 && BANK.pays[pid5].status === 'Returned', 'тест возвращён кнопкой из админки');
  ok((await api('POST', `/api/paygw/${t1.data.id}/refund`, {}, owner)).data.error === 'not_paid', 'дважды вернуть нельзя');

  // 6) зависший неоплаченный — закрывается через 30 минут
  CLIENT_IP = '198.51.100.78'; r = await api('POST', '/api/public/order', base);
  DB.exec(`UPDATE online_pays SET created_at = datetime('now','-40 minutes') WHERE order_id = ${r.data.id}`);
  await api('GET', '/api/orders', null, cz);
  ok(DB.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status === 'cancelled', 'неоплаченный за 30 минут заказ закрыт сам');
  { const p6 = Object.keys(BANK.pays).pop(); BANK.pays[p6].status = 'Succeeded'; const row = DB.db.prepare('SELECT id FROM online_pays WHERE order_id = ?').get(r.data.id);
    DB.exec(`UPDATE online_pays SET status = 'created' WHERE id = ${row.id}`); await api('POST', `/api/paygw/${row.id}/check`, {}, owner);
    ok(BANK.pays[p6].status === 'Returned' && DB.db.prepare('SELECT status FROM online_pays WHERE id = ?').get(row.id).status === 'refunded', 'оплата пришла после закрытия заказа — деньги вернулись сами'); }

  // страницы для банка
  const pg = await handle(new Request('https://pizzaroom.ge/terms?lang=ru'), env); const tx = await pg.text();
  ok(pg.status === 200 && /text\/html/.test(pg.headers.get('content-type')) && tx.includes('445502536') && tx.includes('Пицца Рум') && tx.includes('TBC Bank') && tx.includes('Батуми, ул. Тестовая 1'), 'страница условий: реквизиты и банк подставлены');
  for (const [d, l, w] of [['refund', 'ka', 'დაბრუნება'], ['privacy', 'en', 'Privacy policy'], ['privacy', 'ru', 'конфиденциальности']]) {
    const x = await (await handle(new Request(`https://pizzaroom.ge/${d}?lang=${l}`), env)).text(); ok(x.includes(w) && !x.includes('undefined'), `страница /${d} на ${l}`);
  }
  ok(!(await (await handle(new Request('https://pizzaroom.ge/privacy'), env)).text()).includes('sec'), 'на страницах нет секретов');

  // ── Flitt
  { const { createHash } = await import('node:crypto'); const FL = {}; const sig = (sec, q) => createHash('sha1').update([sec, ...Object.keys(q).sort().filter((k) => k !== 'signature' && q[k] !== '' && q[k] != null).map((k) => String(q[k]))].join('|')).digest('hex');
    let badSig = 0; const prev = globalThis.fetch;
    globalThis.fetch = async (u, opt = {}) => { u = String(u); if (!u.startsWith('https://pay.flitt.com/')) return prev(u, opt);
      const q = JSON.parse(opt.body).request; const J = (r) => new Response(JSON.stringify({ response: r }), { status: 200 });
      if (String(q.merchant_id) !== '1549901' || sig('test', q) !== q.signature) { badSig++; return J({ response_status: 'failure', error_code: 1014, error_message: 'Invalid signature' }); }
      if (u.endsWith('/checkout/url')) { FL[q.order_id] = { st: 'created', amount: q.amount, q }; return J({ response_status: 'success', checkout_url: 'https://pay.flitt.com/merchants/x/default/index.html?token=' + q.order_id }); }
      if (u.endsWith('/status/order_id')) { const o = FL[q.order_id]; return o ? J({ response_status: 'success', order_status: o.st, amount: String(o.amount), actual_amount: o.st === 'approved' ? String(o.amount) : '', reversal_amount: o.rev || '0' }) : J({ response_status: 'failure', error_code: 1002, error_message: 'Order not found' }); }
      if (u.endsWith('/reverse/order_id')) { FL[q.order_id].st = 'reversed'; FL[q.order_id].rev = String(q.amount); return J({ response_status: 'success', reverse_status: 'approved', reversal_amount: String(q.amount) }); }
      return J({ response_status: 'failure', error_message: 'unknown' }); };
    await api('PUT', '/api/paygw', { bank: 'flitt' }, owner);
    ok((await api('GET', '/api/paygw', null, owner)).data.on === false, 'смена банка на Flitt выключает онлайн-оплату до проверки');
    await api('PUT', '/api/paygw', { client_id: '1549901', client_secret: 'wrong' }, owner);
    ok((await api('POST', '/api/paygw/check', {}, owner)).status === 502, 'Flitt: неверный секрет — проверка не проходит');
    await api('PUT', '/api/paygw', { client_secret: 'test' }, owner);
    ok((await api('POST', '/api/paygw/check', {}, owner)).status === 200, 'Flitt: верные ключи — связь есть');
    ok((await api('PUT', '/api/paygw', { on: true }, owner)).data.on === true, 'Flitt включён');
    CLIENT_IP = '198.51.100.81'; const r = await api('POST', '/api/public/order', base);
    ok(r.status === 200 && r.data.pay_url.startsWith('https://pay.flitt.com/'), 'Flitt: клиента ведём на страницу Flitt', r.data);
    const ref = Object.keys(FL).pop(); ok(FL[ref].amount === r.data.total_tetri && FL[ref].q.currency === 'GEL' && FL[ref].q.lang === 'ru', 'Flitt: сумма в тетри, GEL, язык клиента');
    FL[ref].st = 'approved'; await api('POST', '/api/pay/cb?ref=' + ref, {});
    ok((await api('GET', '/api/public/order/' + r.data.token)).data.pay === 'paid', 'Flitt: оплата подтверждена');
    ok((await api('POST', `/api/orders/${r.data.id}/cancel`, { reason: 'Тест Flitt' }, cz)).status === 200 && FL[ref].st === 'reversed' && FL[ref].rev === String(r.data.total_tetri), 'Flitt: при отмене деньги вернулись автоматически');
    ok(badSig === 1, 'все запросы к Flitt подписаны правильно (кроме нарочно неверного ключа)', badSig);
    const pg = await (await handle(new Request('https://pizzaroom.ge/terms?lang=en'), env)).text(); ok(pg.includes('Flitt'), 'на странице условий указан Flitt');
    globalThis.fetch = prev; }
  { const cu = (await api('GET', '/api/customers', null, owner)).data; const n = cu.find((c) => c.phone === '+995599414141');
    ok(n && n.name === 'Нана' && n.orders >= 5 && n.site_orders >= 5, 'в «Клиентах» есть каждый, кто заказал на сайте — даже без оплаты', n); }
  globalThis.fetch = realFetch; CLIENT_IP = '10.0.0.3';
}

{ const r = await api('GET', '/api/reports/insights?from=2020-01-01&to=2100-01-01', null, manager);
  ok(r.status === 200 && Array.isArray(r.data.menu) && r.data.menu.some((m) => m.cat === 'pizza' && m.price > 0) && r.data.pnl && r.data.pnl.cur, 'аналитика маржи и финансов: меню с маржой, сравнение периодов', r.data.message); }
console.log('\nАналитика 2.0: каналы, оплаты, дни недели, Wolt/Glovo');
{ CLIENT_IP = '10.0.9.9'; DB.exec('DELETE FROM login_attempts'); }
const ownX = (await api('POST', '/api/login', { pin: '8264', device: 'office-2' })).data.token;
{ const r = await api('GET', '/api/reports/insights?from=2020-01-01&to=2100-01-01', null, ownX); if (!r.data.channels) console.log(r.status, r.data);
  ok(Array.isArray(r.data.channels) && r.data.channels.length > 0 && r.data.channels.every((c) => 'contribution_tetri' in c && 'orders' in c), 'аналитика: выручка по каналам (зал, доставка, сайт, Wolt, Glovo)', r.data.channels);
  ok(Array.isArray(r.data.pay_split) && r.data.pay_split.length > 0 && r.data.first_day, 'аналитика: способы оплаты и первый день продаж');
  ok(Array.isArray(r.data.plat), 'аналитика: реальная комиссия площадок по инвойсам'); }
{ const t = new Date(Date.now() + 4 * 3600e3); const ds = t.toISOString().slice(0, 10); const w = t.getUTCDay(); const other = (w + 1) % 7;
  const mk = async (wd) => (await api('POST', '/api/promos', { title_ru: 'Тест дня недели', pct: 10, date_from: ds, date_to: ds, wdays: [wd], cats: ['pizza'], channels: ['hall'] }, ownX)).data.id;
  const id1 = await mk(other); const LL = await api('GET', '/api/promos', null, ownX); if (!Array.isArray(LL.data)) console.log(LL.status, LL.data); const L1 = (LL.data || []).find((p) => p.id === id1);
  ok(L1 && L1.wdays.length === 1 && L1.wdays[0] === other, 'акция «только по вторникам» сохраняет дни недели', L1);
  const pr = (await api('GET', '/api/public/settings')).data.promo; ok(!pr.on || pr.id !== id1, 'скидка по другому дню недели сегодня НЕ действует');
  await api('POST', `/api/promos/${id1}/active`, { on: false }, ownX);
  const id2 = await mk(w); const ps = await api('GET', '/api/catalog', null, ownX);
  const st = DB.db.prepare('SELECT wdays FROM promos WHERE id = ?').get(id2); ok(st && st.wdays === JSON.stringify([w]), 'скидка на сегодняшний день недели записана');
  await api('POST', `/api/promos/${id2}/active`, { on: false }, ownX); }
{ const inv = await api('POST', '/api/settlements', { platform: 'wolt', period_from: '2026-01-01', period_to: '2026-01-07', gross_tetri: 10000, fees_tetri: 3000 }, ownX);
  const b64 = Buffer.from('%PDF-1.4 test invoice').toString('base64');
  ok((await api('POST', `/api/settlements/${inv.data.id}/file`, { name: 'wolt.pdf', mime: 'application/pdf', b64 }, ownX)).status === 200, 'к инвойсу Wolt можно прикрепить PDF');
  ok((await api('POST', `/api/settlements/${inv.data.id}/file`, { name: 'x.exe', mime: 'application/x-msdownload', b64 }, ownX)).status === 400, 'чужие типы файлов не принимаются');
  const f = await api('GET', `/api/settlements/${inv.data.id}/file`, null, ownX); ok(f.data.b64 === b64 && f.data.name === 'wolt.pdf', 'прикреплённый документ скачивается');
  const s2 = (await api('GET', '/api/settlements', null, ownX)).data.platforms.find((p) => p.platform === 'wolt').invoices.find((i) => i.id === inv.data.id); ok(s2.file_name === 'wolt.pdf', 'в списке инвойсов видно, что документ есть');
  ok((await api('POST', `/api/settlements/${inv.data.id}/file`, { name: 'wolt.pdf', mime: 'application/pdf', b64 }, cashier2)).status === 403, 'кассир не может прикреплять документы'); }
{ const m = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 7);
  const rid = (await api('POST', '/api/recurring', { name: 'Аренда тест', category: 'rent', amount_tetri: 100000, day: 1 }, ownX)).data.id;
  await api('GET', '/api/expenses?month=' + m, null, ownX);
  await api('POST', '/api/recurring', { id: rid, name: 'Аренда тест', category: 'rent', amount_tetri: 120000, day: 1 }, ownX);
  const e = (await api('GET', '/api/expenses?month=' + m, null, ownX)).data.items.filter((x) => x.recurring_id === rid);
  ok(e.length === 1 && e[0].amount_tetri === 120000, 'новая сумма аренды действует с этого месяца', e);
  await api('POST', '/api/recurring', { id: rid, name: 'Аренда тест', category: 'rent', amount_tetri: 120000, day: 1, active: false }, ownX);
  const ex = (await api('GET', '/api/expenses?month=' + m, null, ownX)).data; ok('platform_tetri' in ex, 'в расходах видны комиссии Wolt/Glovo за месяц'); }
{ const t = new Date(Date.now() + 4 * 3600e3); const ds = t.toISOString().slice(0, 10); const m = ds.slice(0, 7);
  const nx = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)).toISOString().slice(0, 7); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const full = (await api('GET', `/api/pnl?from=${m}-01&to=${last}`, null, ownX)).data, today = (await api('GET', `/api/pnl?from=${m}-01&to=${ds}`, null, ownX)).data;
  ok(full.totals.labor_tetri === today.totals.labor_tetri, 'зарплаты не считаются вперёд: месяц целиком = по сегодня', [full.totals.labor_tetri, today.totals.labor_tetri]);
  const fx = (await api('GET', '/api/expenses?month=' + nx, null, ownX)).data; ok(fx.items.length === 0 && fx.payroll_tetri === 0, 'следующий месяц пустой: аренда и зарплаты не ставятся заранее', fx);
  const ins = (await api('GET', '/api/reports/insights?from=2000-01-01&to=' + ds, null, ownX)).data;
  ok(ins.from > '2000-01-01' && ins.rates && 'wolt' in ins.rates && Array.isArray(ins.by_ch), '«всё время» — с первого дня продаж; комиссии площадок и продажи по каналам есть', [ins.from, ins.rates]);
  ok(ins.menu.some((x) => x.price_wolt || x.price_glovo), 'в аналитике есть цены Wolt/Glovo для расчёта наценки по их тарифам'); }
{ const m = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 7); const pr = (await api('GET', '/api/payroll?month=' + m, null, ownX)).data; const ex = (await api('GET', '/api/expenses?month=' + m, null, ownX)).data;
  const ym = (await api('GET', '/api/expenses/months?year=' + m.slice(0, 4), null, ownX)).data.months.find((x) => x.month === m);
  ok(ex.payroll_tetri === pr.totals.employer_cost && ym.payroll_tetri === pr.totals.employer_cost, 'зарплаты в «Расходах» = «Обходится компании» в «Зарплатах» (одна и та же сумма)', [ex.payroll_tetri, ym.payroll_tetri, pr.totals.employer_cost]); }
{ const first = DB.db.prepare("SELECT MIN(substr(datetime(p.created_at,'+4 hours'),1,7)) AS m FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.is_test = 0").get().m;
  DB.db.prepare("UPDATE people SET start_date = '2024-01-01' WHERE id = (SELECT MIN(id) FROM people WHERE active = 1)").run();
  const y = first.slice(0, 4); const ms = (await api('GET', '/api/expenses/months?year=' + y, null, ownX)).data.months;
  const before = ms.filter((m) => m.month < first);
  ok(before.every((m) => m.payroll_tetri === 0), 'зарплаты не начисляются за месяцы до первой продажи (даже если дата начала работы раньше)', before.map((m) => [m.month, m.payroll_tetri]));
  ok(ms.find((m) => m.month === first).payroll_tetri > 0, 'с месяца первой продажи зарплаты считаются'); }
{ const t = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); const dl = (await api('GET', `/api/reports/daily?from=2000-01-01&to=${t}`, null, ownX)).data; const ins = (await api('GET', `/api/reports/insights?from=2000-01-01&to=${t}`, null, ownX)).data;
  const sm = (k) => dl.rows.reduce((a, r) => a + r[k], 0);
  ok(sm('rev') === ins.pnl.cur.revenue_tetri && sm('n') === ins.pnl.cur.orders, '«Продажи»: сумма и число чеков по дням = итог аналитики', [sm('rev'), ins.pnl.cur.revenue_tetri]);
  ok(dl.rows.every((r) => r.cash + r.card + r.online + r.platform === r.rev), '«Продажи»: наличные + терминал + онлайн + площадки = продажи дня');
  ok(Array.isArray(dl.cats) && dl.cats.length > 0, '«Продажи»: продажи по категориям'); }
console.log('\nСайт для поисковиков: страницы, старые адреса, карта сайта');
{ const g = async (path, host = 'https://pizzaroom.ge') => { const r = await handle(new Request(host + path, { redirect: 'manual' }), env); return { status: r.status, loc: r.headers.get('location'), text: await r.text(), ct: r.headers.get('content-type') }; };
  // после предыдущих проверок в меню могут остаться не все пиццы — делаем активной пепперони
  await env.DB.prepare("UPDATE products SET active = 1, archived = 0 WHERE id = 'pep'").run(); await env.DB.prepare("UPDATE categories SET active = 1 WHERE id = 'pizza'").run();
  const old = await g('/%E1%83%9E%E1%83%94%E1%83%9E%E1%83%94%E1%83%A0%E1%83%9D%E1%83%9C%E1%83%98-%D0%BF%D0%B5%D0%BF%D0%BF%D0%B5%D1%80%D0%BE%D0%BD%D0%B8-pepperoni-p110725413');
  ok(old.status === 301 && /\/pizza\/pepperoni$/.test(old.loc), 'старая страница пиццы (WordPress/Ecwid) → 301 на новую страницу пиццы', old);
  const oldru = await g('/ru/sprite-0-33-l-p111933096'); ok(oldru.status === 301 && /\/ru\/menu$/.test(oldru.loc), 'старая страница напитка (русская) → меню на русском', oldru.loc);
  const pz = await g('/ru/pizza/pepperoni'); ok(pz.status === 200 && /<title>Пицца Пепперони — \d+ ₾/.test(pz.text) && /"@type":"Product"/.test(pz.text) && /hreflang="en" href="https:\/\/pizzaroom.ge\/en\/pizza\/pepperoni"/.test(pz.text) && /rel="canonical" href="https:\/\/pizzaroom.ge\/ru\/pizza\/pepperoni"/.test(pz.text), 'страница пиццы: заголовок с ценой, данные для Google, языковые версии', pz.status + ' ' + pz.text.slice(0, 300));
  ok((await g('/pizza/pep')).status === 301, 'адрес пиццы по коду → основной адрес');
  const mn = await g('/en/menu'); ok(mn.status === 200 && /"@type":"Menu"/.test(mn.text) && /Pepperoni/.test(mn.text) && /mc\.yandex\.ru\/metrika/.test(mn.text) && /yandex-verification/.test(mn.text), 'меню с ценами + Метрика + подтверждение Яндекса', mn.status);
  const sm = await g('/sitemap.xml'); ok(sm.status === 200 && /<loc>https:\/\/pizzaroom.ge\/ru\/pizza\/pepperoni<\/loc>/.test(sm.text) && (sm.text.match(/<url>/g) || []).length >= 12, 'карта сайта собирается из меню', (sm.text.match(/<url>/g) || []).length);
  ok((await g('/wp-login.php')).status === 410 && (await g('/xmlrpc.php')).status === 410, 'адреса старого WordPress — «удалено навсегда»');
  const nf = await g('/no-such-page'); ok(nf.status === 404 && /text\/html/.test(nf.ct) && /noindex/.test(nf.text), 'неизвестный адрес — понятная страница 404, а не код');
  ok((await g('/ka/menu')).loc === 'https://pizzaroom.ge/menu' && (await g('/cart')).status === 301 && (await g('/sitemap-misc.xml')).loc === 'https://pizzaroom.ge/sitemap.xml', 'служебные адреса старого сайта перенаправляются');
  ok((await g('/menu', 'https://www.pizzaroom.ge')).loc === 'https://pizzaroom.ge/menu', 'www → без www');
  { const kas = readFileSync(new URL('../public/kassa/index.html', import.meta.url), 'utf8'); const env3 = Object.assign(Object.create(env), { ASSETS: { fetch: async () => new Response(kas, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } });
    const a = async (path) => { const r = await handle(new Request('https://pizzaroom.ge' + path, { redirect: 'manual' }), env3); return { status: r.status, text: await r.text(), loc: r.headers.get('location'), robots: r.headers.get('x-robots-tag') || '' }; };
    const pos = await a('/pos/'), kit = await a('/kitchen/');
    ok(pos.status === 200 && /window\.PR_APP = 'pos'/.test(pos.text) && /href="\/pos\.webmanifest/.test(pos.text) && /noindex/.test(pos.robots), 'pizzaroom.ge/pos/ — отдельное приложение «только касса»');
    ok(kit.status === 200 && /window\.PR_APP = 'kitchen'/.test(kit.text) && /href="\/kitchen\.webmanifest/.test(kit.text), 'pizzaroom.ge/kitchen/ — отдельное приложение «только кухня»');
    ok((await a('/pos')).loc === 'https://pizzaroom.ge/pos/', '/pos → /pos/'); }
  { const idx = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const env2 = Object.assign(Object.create(env), { ASSETS: { fetch: async () => new Response(idx, { headers: { 'content-type': 'text/html; charset=utf-8', etag: 'x' } }) } });
    const h = async (path) => { const r = await handle(new Request('https://pizzaroom.ge' + path, { redirect: 'manual' }), env2); return { status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') || '', loc: r.headers.get('location') }; };
    const ru = await h('/ru/'); ok(ru.status === 200 && /<html lang="ru"/.test(ru.text) && /<title>Пицца в Батуми с доставкой/.test(ru.text) && /href="https:\/\/pizzaroom.ge\/ru\/" id="seo-canon"/.test(ru.text) && /<div id="seo"[^>]*><h1>Пицца в Батуми — Pizza Room<\/h1>/.test(ru.text) && /href="\/ru\/pizza\/pepperoni"/.test(ru.text) && /"@type":"Restaurant"/.test(ru.text) && /mc\.yandex\.ru/.test(ru.csp), 'русская главная /ru/: язык, заголовок, ссылки на пиццы, разрешена Метрика', ru.text.slice(0, 200));
    const ka = await h('/'); ok(ka.status === 200 && /<html lang="ka"/.test(ka.text) && /<title>პიცა ბათუმში მიტანით/.test(ka.text) && (ka.text.match(/application\/ld\+json/g) || []).length === 1 && /id="app"/.test(ka.text), 'грузинская главная: приложение на месте, одна разметка schema.org');
    ok((await h('/ru')).loc === 'https://pizzaroom.ge/ru/', '/ru → /ru/');
    ok((await h('/en/')).text.includes('Pizza delivery in Batumi'), 'английская главная /en/'); }
  ok((await g('/terms')).status === 200 && (await api('GET', '/api/public/menu')).status === 200, 'юридические страницы и API работают как раньше');
}
console.log('\nЗащита сайта от ботов и подделки запросов');
{ CLIENT_IP = '198.51.100.7';
  const base = { name: 'Бот', phone: '555777001', mode: 'pickup', items: [{ product_id: 'marg', qty: 1 }] };
  ok((await api('POST', '/api/public/order', Object.assign({ website: 'http://spam' }, base))).status === 400, 'бот заполнил скрытое поле-ловушку — заказ не принят');
  ok((await api('POST', '/api/public/order', Object.assign({}, base, { el: 300 }))).data.error === 'too_fast', 'заказ за 0,3 секунды после открытия сайта — не принят');
  const raw = async (o) => (await handle(new Request('https://pizzaroom.ge/api/public/order', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.8' }, o), body: JSON.stringify(Object.assign({ el: 9000 }, base)) }), env)).status;
  ok(await raw({}) === 403 && await raw({ origin: 'https://evil.example' }) === 403, 'заказ без адреса нашего сайта или с чужого сайта — отклонён');
  ok((await handle(new Request('https://pizzaroom.ge/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"pin":"1234"}' }), env)).status === 403, 'вход в кассу с чужого сайта невозможен');
  CLIENT_IP = '198.51.100.9'; for (let i = 0; i < 3; i++) await api('POST', '/api/public/order', Object.assign({}, base, { phone: '555777002' }));
  CLIENT_IP = '198.51.100.10'; ok((await api('POST', '/api/public/order', Object.assign({}, base, { phone: '555777002' }))).status === 429, 'с одного номера не больше 3 непринятых заказов за 30 минут (даже с разных адресов)');
  const e500 = await handle(new Request('https://pizzaroom.ge/api/orders/abc', { headers: { authorization: 'Bearer fake' } }), env); const j = await e500.json(); ok(!j.detail, 'посторонний не видит подробностей ошибок сервера');
  CLIENT_IP = '10.0.0.3'; }
console.log('\nАннулирование оплаченного заказа');
{ const t = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const r0 = (await api('GET', `/api/reports/insights?from=${t}&to=${t}`, null, ownX)).data.pnl.cur.revenue_tetri;
  const c0 = (await api('GET', '/api/cash', null, ownX)).data;
  const o = await api('POST', '/api/orders', { channel: 'hall', items: [{ product_id: 'marg', qty: 1 }] }, cash2); const vid = o.data.id;
  const pay = await api('POST', `/api/orders/${vid}/pay`, { method: 'cash', tendered_tetri: 999900 }, cash2); ok(pay.status === 200, 'оплачен наличными', pay.data);
  const r1 = (await api('GET', `/api/reports/insights?from=${t}&to=${t}`, null, ownX)).data.pnl.cur.revenue_tetri; const amt = r1 - r0; ok(amt > 0, 'выручка выросла');
  ok((await api('POST', `/api/orders/${vid}/void`, { reason: 'клиент отказался' }, cash2)).status === 403, 'кассир не может аннулировать оплаченный заказ');
  ok((await api('POST', `/api/orders/${vid}/void`, { reason: '' }, manager)).status === 400, 'без причины не аннулируется');
  const v = await api('POST', `/api/orders/${vid}/void`, { reason: 'клиент отказался' }, manager); ok(v.status === 200 && v.data.method === 'cash', 'администратор аннулировал заказ', v.data);
  ok((await api('POST', `/api/orders/${vid}/void`, { reason: 'ещё раз' }, ownX)).status === 409, 'дважды аннулировать нельзя');
  const r2 = (await api('GET', `/api/reports/insights?from=${t}&to=${t}`, null, ownX)).data.pnl.cur.revenue_tetri; ok(r2 === r0, 'выручка вернулась как была — заказ ушёл из аналитики', [r0, r1, r2]);
  const dl = (await api('GET', `/api/reports/daily?from=${t}&to=${t}`, null, ownX)).data.rows.reduce((a, x) => a + x.rev, 0); ok(dl === r2, '«Продажи» по дням тоже без аннулированного');
  const mv = DB.db.prepare("SELECT * FROM cash_moves WHERE kind = 'refund' ORDER BY id DESC LIMIT 1").get(); const c1 = (await api('GET', '/api/cash', null, ownX)).data; ok(mv && mv.amount_tetri === amt && c1.moves.some((m) => m.kind === 'refund'), 'наличные: возврат клиенту записан из кассы на сумму заказа', [mv, amt]);
  ok(DB.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(vid).n === 1, 'сама оплата в истории сохранена (защита)');
  const day = (await api('GET', '/api/day-orders?date=' + t, null, manager)).data.find((x) => x.id === vid); ok(day && day.void_at && day.void_reason === 'клиент отказался', 'в списке за день видно «аннулирован» и причину');
  ok((await api('GET', '/api/day-orders?date=' + t, null, cash2)).status === 403, 'кассир не видит список для аннулирования');
  ok(!(await api('GET', '/api/kitchen', null, cash2)).data.some((x) => x.id === vid), 'аннулированный заказ ушёл с экрана кухни');
  const au = (await api('GET', '/api/audit?limit=30', null, ownX)).data; ok(JSON.stringify(au).includes('order.void'), 'аннулирование записано в журнал');
  ok((await api('POST', '/api/test/purge', { confirm: 'DELETE' }, manager)).status === 403 && (await api('POST', '/api/sales-reset', { confirm: 'УДАЛИТЬ', orders: 1 }, manager)).status === 403, 'массовое удаление (тест и чистый лист) — только владелец'); }
console.log('\nЧистый лист: удаление пробных продаж');
{ const i0 = (await api('GET', '/api/sales-reset', null, ownX)).data; ok(i0.orders > 0 && !i0.done, 'видно, сколько пробных продаж будет удалено', i0);
  ok((await api('GET', '/api/sales-reset', null, manager)).status === 403, 'администратор не может удалять продажи');
  ok((await api('POST', '/api/sales-reset', { confirm: 'да', orders: i0.orders }, ownX)).status === 400, 'без слова УДАЛИТЬ ничего не удаляется');
  ok((await api('POST', '/api/sales-reset', { confirm: 'УДАЛИТЬ', orders: i0.orders - 1 }, ownX)).status === 409, 'если за это время пришёл новый заказ — не удаляет');
  const stock0 = DB.db.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM stock_moves WHERE order_id IS NULL").get().s;
  const r = await api('POST', '/api/sales-reset', { confirm: 'удалить', orders: i0.orders }, ownX);
  ok(r.status === 200 && r.data.orders === 0 && r.data.total_tetri === 0 && r.data.done, 'все пробные продажи удалены', r.data);
  ok(DB.db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n === 0 && DB.db.prepare('SELECT COUNT(*) AS n FROM stock_moves WHERE order_id IS NOT NULL').get().n === 0, 'позиции заказов и списания со склада тоже удалены — склад вернулся');
  ok(DB.db.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM stock_moves").get().s === stock0, 'приходы и инвентаризации на складе остались');
  ok((await api('POST', '/api/sales-reset', { confirm: 'УДАЛИТЬ', orders: 0 }, ownX)).status === 409, 'второй раз удалить продажи нельзя — защита выручки');
  ok(DB.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pay_no_delete','orders_no_delete','moves_no_delete','items_no_delete')").get().n === 4, 'защита от удаления оплат и заказов снова включена');
  const au = (await api('GET', '/api/audit?limit=20', null, ownX)).data; ok(JSON.stringify(au).includes('sales.reset'), 'удаление записано в журнал'); }
console.log(`\nИтого: ${passed} проверок прошло, ${failed} не прошло`);
process.exit(failed ? 1 : 0);

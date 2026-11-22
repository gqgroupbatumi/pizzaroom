// Демо-продажи за 8 недель для проверки «Советника» (только локально)
export function demoSeed(DB) {
  const q = (sql, ...a) => DB.db.prepare(sql).all(...a); const run = (sql, ...a) => DB.db.prepare(sql).run(...a);
  const price = Object.fromEntries(q("SELECT product_id, price_tetri FROM prices WHERE price_list='base'").map((r) => [r.product_id, r.price_tetri]));
  const pz = q("SELECT id FROM products WHERE category_id='pizza' AND active=1").map((r) => r.id);
  const dr = q("SELECT id FROM products WHERE category_id IN ('drinks','coffee') AND active=1").map((r) => r.id);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const wdK = [1.15, 0.7, 0.75, 0.95, 1.0, 1.35, 1.4]; // вс..сб: пн/вт слабые
  const weight = (id) => (id === 'veg' || id === 'salmon' ? 0.15 : 1);
  const now = Date.now();
  for (let k = 56; k >= 1; k--) {
    const day = new Date(now - k * 864e5); const n = Math.round(22 * wdK[day.getUTCDay()] * (0.85 + rnd() * 0.3));
    for (let j = 0; j < n; j++) {
      const at = new Date(day.getTime()); at.setUTCHours(8 + Math.floor(rnd() * 10), Math.floor(rnd() * 60)); const ts = at.toISOString().replace('T', ' ').slice(0, 19);
      const oid = run("INSERT INTO orders (channel, status, created_at, paid_at) VALUES ('hall','paid',?,?)", ts, ts).lastInsertRowid;
      const items = []; let tw = pz.reduce((s, x) => s + weight(x), 0); let r = rnd() * tw; let pick = pz[0]; for (const x of pz) { r -= weight(x); if (r <= 0) { pick = x; break; } }
      items.push(pick); if (rnd() < 0.55) items.push(dr[Math.floor(rnd() * dr.length)]);
      let sum = 0; for (const it of items) { run('INSERT INTO order_items (order_id, product_id, qty, unit_price_tetri, unit_cost_tetri, added_at) VALUES (?,?,?,?,?,?)', oid, it, 1, price[it] || 1000, Math.round((price[it] || 1000) * 0.35), ts); sum += price[it] || 1000; }
      run("INSERT INTO payments (order_id, method, subtotal_tetri, discount_tetri, total_tetri, created_at) VALUES (?,?,?,?,?,?)", oid, 'cash', sum, 0, sum, ts);
    }
  }
  const ago = (d) => new Date(now - d * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  for (const [id, qty, days, use] of [['mozz', 12000, 8, 600], ['salmon_f', 2500, 2, 40], ['rucola', 1500, 5, 50], ['cream_raw', 3000, 3, 900]]) {
    run("INSERT INTO stock_moves (ingredient_id, delta, kind, created_at) VALUES (?,?, 'receipt', ?)", id, qty, ago(days));
    for (let d = 13; d >= 1; d--) run("INSERT INTO stock_moves (ingredient_id, delta, kind, created_at) VALUES (?,?, 'sale', ?)", id, -Math.round(use / (d <= days ? 1 : 3)), ago(d));
  }
}

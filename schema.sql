-- Pizza Room: база данных (Cloudflare D1 / SQLite)
-- Деньги хранятся в тетри (1 ₾ = 100 тетри), граммы — целыми числами.
-- Журнал, оплаты и движения склада нельзя изменить или удалить: это запрещено триггерами.

PRAGMA foreign_keys = ON;

-- ───────── Сотрудники и доступ ─────────
CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('owner','manager','cashier','cook')),
  pin_hash    TEXT    NOT NULL,
  pin_salt    TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  device      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device      TEXT    NOT NULL,
  ok          INTEGER NOT NULL,
  ip          TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Меню и цены по каналам ─────────
CREATE TABLE IF NOT EXISTS categories (
  id       TEXT PRIMARY KEY,
  sort     INTEGER NOT NULL DEFAULT 0,
  name_ka  TEXT NOT NULL, name_en TEXT NOT NULL, name_ru TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name_ka TEXT NOT NULL, name_en TEXT NOT NULL, name_ru TEXT NOT NULL,
  desc_ka TEXT, desc_en TEXT, desc_ru TEXT,
  size        TEXT,
  photo       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  in_stock    INTEGER NOT NULL DEFAULT 1,
  pack_ing    TEXT,                               -- упаковка со склада (коробка, стакан)
  pack_qty    INTEGER NOT NULL DEFAULT 1,
  pack_mode   TEXT    NOT NULL DEFAULT 'away',    -- away: только навынос/доставка; always: всегда
  archived    INTEGER NOT NULL DEFAULT 0          -- 1 = удалён из меню, история продаж сохранена
);

-- base = зал, самовывоз, своя доставка и сайт; wolt / glovo / bolt — свои цены (дороже из-за комиссии)
CREATE TABLE IF NOT EXISTS prices (
  product_id  TEXT    NOT NULL REFERENCES products(id),
  price_list  TEXT    NOT NULL CHECK (price_list IN ('base','wolt','glovo','bolt')),
  price_tetri INTEGER NOT NULL CHECK (price_tetri >= 0),
  PRIMARY KEY (product_id, price_list)
);

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY CHECK (id IN ('hall','takeaway','delivery','site','wolt','glovo','bolt')),
  price_list     TEXT NOT NULL,
  commission_bp  INTEGER NOT NULL DEFAULT 0   -- комиссия площадки в сотых долях процента (3000 = 30%)
);

-- ───────── Смены ─────────
CREATE TABLE IF NOT EXISTS shifts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id            INTEGER NOT NULL REFERENCES staff(id),
  opened_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  opening_cash_tetri  INTEGER NOT NULL DEFAULT 0,
  closed_at           TEXT,
  counted_cash_tetri  INTEGER,
  expected_cash_tetri INTEGER,
  diff_tetri          INTEGER
);

-- ───────── Заказы ─────────
-- Номер заказа = id: сквозная нумерация, номера не переиспользуются, удалить заказ нельзя.
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel           TEXT    NOT NULL REFERENCES channels(id),
  external_id       TEXT,                    -- номер заказа Wolt / Glovo / сайта
  status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent','paid','cancelled')),
  shift_id          INTEGER REFERENCES shifts(id),
  created_by        INTEGER REFERENCES staff(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at           TEXT,
  paid_at           TEXT,
  cancelled_at      TEXT,
  cancel_reason     TEXT,
  cancel_approved_by INTEGER REFERENCES staff(id),
  discount_bp       INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 3000),
  discount_approved_by INTEGER REFERENCES staff(id),
  customer_phone    TEXT,
  note              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_external ON orders(channel, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  product_id        TEXT    NOT NULL REFERENCES products(id),
  qty               INTEGER NOT NULL CHECK (qty >= 0),
  unit_price_tetri  INTEGER NOT NULL,        -- цена фиксируется в момент добавления, с сервера
  sent              INTEGER NOT NULL DEFAULT 0,
  added_by          INTEGER REFERENCES staff(id),
  added_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  method          TEXT    NOT NULL CHECK (method IN ('cash','card','platform','online')),
  subtotal_tetri  INTEGER NOT NULL,
  discount_tetri  INTEGER NOT NULL,
  total_tetri     INTEGER NOT NULL,
  commission_tetri INTEGER NOT NULL DEFAULT 0,
  shift_id        INTEGER REFERENCES shifts(id),
  staff_id        INTEGER REFERENCES staff(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Фискальный чек привязывается к оплате. Касса печатает его через локальный модуль фискального аппарата
-- и присылает номер. Оплата без фискального чека через несколько минут — сигнал владельцу.
CREATE TABLE IF NOT EXISTS fiscal_receipts (
  order_id      INTEGER PRIMARY KEY REFERENCES orders(id),
  fiscal_number TEXT    NOT NULL,
  staff_id      INTEGER REFERENCES staff(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Подтверждения менеджера: кто попросил, кто разрешил, что именно
CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action        TEXT    NOT NULL,
  order_id      INTEGER REFERENCES orders(id),
  requested_by  INTEGER NOT NULL REFERENCES staff(id),
  approved_by   INTEGER NOT NULL REFERENCES staff(id),
  details       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Склад и рецепты ─────────
CREATE TABLE IF NOT EXISTS ingredients (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  unit            TEXT    NOT NULL CHECK (unit IN ('g','ml','pcs')),
  cost_per_1000_tetri INTEGER NOT NULL DEFAULT 0,   -- цена за кг / л / 1000 шт.
  min_stock       INTEGER NOT NULL DEFAULT 0,
  buy_units       TEXT    NOT NULL DEFAULT '[]',  -- свои единицы закупки: [{"n":"л","q":1000}]
  archived        INTEGER NOT NULL DEFAULT 0,     -- 1 = удалён из списков, история сохранена
  shelf_days      INTEGER NOT NULL DEFAULT 0      -- срок хранения после поставки, дней (0 — не следить)
);

CREATE TABLE IF NOT EXISTS recipes (
  product_id    TEXT    NOT NULL REFERENCES products(id),
  ingredient_id TEXT    NOT NULL REFERENCES ingredients(id),
  qty           INTEGER NOT NULL CHECK (qty > 0),    -- граммы на одну порцию
  PRIMARY KEY (product_id, ingredient_id)
);

-- Остаток = сумма движений. Отдельного поля «остаток», которое можно поправить руками, нет.
CREATE TABLE IF NOT EXISTS stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id TEXT    NOT NULL REFERENCES ingredients(id),
  delta         INTEGER NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('receipt','sale','writeoff','inventory','cancel_return')),
  reason        TEXT,
  order_id      INTEGER REFERENCES orders(id),
  staff_id      INTEGER REFERENCES staff(id),
  approved_by   INTEGER REFERENCES staff(id),
  cost_tetri    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- График работы: W работает, O выходной, V отпуск, S больничный
CREATE TABLE IF NOT EXISTS schedule (
  person_id INTEGER NOT NULL,
  date      TEXT    NOT NULL,
  code      TEXT    NOT NULL,
  PRIMARY KEY (person_id, date)
);

-- Свои заготовки: из чего сделана 1000 единиц (г / мл / шт) заготовки
CREATE TABLE IF NOT EXISTS ingredient_parts (
  parent_id     TEXT NOT NULL,
  child_id      TEXT NOT NULL,
  qty_per_1000  REAL NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);

CREATE VIEW IF NOT EXISTS stock_levels AS
  SELECT i.id, i.name, i.unit, i.min_stock, COALESCE(SUM(m.delta), 0) AS qty
  FROM ingredients i LEFT JOIN stock_moves m ON m.ingredient_id = i.id
  GROUP BY i.id;

-- ───────── Журнал действий (цепочка хешей) ─────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL DEFAULT (datetime('now')),
  staff_id   INTEGER,
  action     TEXT    NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    TEXT,
  prev_hash  TEXT    NOT NULL,
  hash       TEXT    NOT NULL
);

-- ───────── Запреты на изменение истории ─────────
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pay_no_update   BEFORE UPDATE ON payments  BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS pay_no_delete   BEFORE DELETE ON payments  BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS moves_no_update BEFORE UPDATE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock moves are immutable'); END;
CREATE TRIGGER IF NOT EXISTS moves_no_delete BEFORE DELETE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock moves are immutable'); END;
CREATE TRIGGER IF NOT EXISTS fiscal_no_update BEFORE UPDATE ON fiscal_receipts BEGIN SELECT RAISE(ABORT, 'fiscal receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS fiscal_no_delete BEFORE DELETE ON fiscal_receipts BEGIN SELECT RAISE(ABORT, 'fiscal receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approvals_no_change BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS shift_closed_frozen BEFORE UPDATE ON shifts WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'closed shift is frozen'); END;
CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders    BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted, cancel instead'); END;
CREATE TRIGGER IF NOT EXISTS items_no_delete  BEFORE DELETE ON order_items BEGIN SELECT RAISE(ABORT, 'order items cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS paid_order_frozen BEFORE UPDATE ON orders
  WHEN OLD.status IN ('paid','cancelled')
  BEGIN SELECT RAISE(ABORT, 'paid or cancelled order is frozen'); END;
CREATE TRIGGER IF NOT EXISTS paid_items_frozen BEFORE UPDATE ON order_items
  WHEN (SELECT status FROM orders WHERE id = OLD.order_id) IN ('paid','cancelled')
  BEGIN SELECT RAISE(ABORT, 'items of a paid or cancelled order are frozen'); END;

-- ───────── Начальные каналы ─────────
INSERT OR IGNORE INTO channels (id, price_list, commission_bp) VALUES
  ('hall','base',0), ('takeaway','base',0), ('delivery','base',0), ('site','base',0),
  ('wolt','wolt',3000), ('glovo','glovo',3000), ('bolt','bolt',3000);

-- Советник: что сделали / пропустили
CREATE TABLE IF NOT EXISTS advice_log (key TEXT PRIMARY KEY, status TEXT NOT NULL, staff_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')));
-- Секреты (токен Telegram-бота, контакты восстановления) — никогда не отдаются в /api/settings
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Ссылки «новый PIN владельца» (хранится только хеш, 30 минут, одноразовые)
CREATE TABLE IF NOT EXISTS pin_resets (hash TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS kitchen_prints (order_id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));

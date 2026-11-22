-- Начальное меню, цены и склад. Цены ДЕМОНСТРАЦИОННЫЕ — поменяйте в «Управление → Меню и цены».
INSERT OR IGNORE INTO categories (id, sort, name_ka, name_en, name_ru) VALUES ('pizza', 1, 'პიცა', 'Pizza', 'Пицца');
INSERT OR IGNORE INTO products (id, category_id, name_ka, name_en, name_ru, desc_ru, size, sort) VALUES
 ('pep','pizza','პეპერონი','Pepperoni','Пепперони','Томатный соус, моцарелла, пепперони','33 см',1),
 ('marg','pizza','მარგარიტა','Margherita','Маргарита','Томатный соус, моцарелла, базилик','33 см',2),
 ('five','pizza','5 ყველი','5 cheese','5 сыров','Пять сыров на сливочной основе','33 см',3),
 ('ranch','pizza','ქათამი რანჩი','Chicken ranch','Цыплёнок ранч','Соус ранч, курица, моцарелла','33 см',4),
 ('diablo','pizza','პეპერონი დიაბლო','Pepperoni diablo','Пепперони диабло','Пепперони, халапеньо, моцарелла','33 см',5),
 ('hawaii','pizza','ჰავაის','Hawaiian','Гавайская','Ветчина, ананас, моцарелла','33 см',6),
 ('carb','pizza','კარბონარა','Carbonara','Карбонара','Сливочный соус, бекон, моцарелла','33 см',7),
 ('salmon','pizza','ორაგულით','Salmon','С лососем','Лосось, сливочный сыр, моцарелла','33 см',8);
INSERT OR IGNORE INTO prices (product_id, price_list, price_tetri) VALUES
 ('pep','base',2600),('pep','wolt',3300),('pep','glovo',3300),('pep','bolt',3300),
 ('marg','base',2500),('marg','wolt',3300),('marg','glovo',3300),('marg','bolt',3300),
 ('five','base',2800),('five','wolt',3500),('five','glovo',3500),('five','bolt',3500),
 ('ranch','base',2700),('ranch','wolt',3400),('ranch','glovo',3400),('ranch','bolt',3400),
 ('diablo','base',2700),('diablo','wolt',3400),('diablo','glovo',3400),('diablo','bolt',3400),
 ('hawaii','base',2700),('hawaii','wolt',3400),('hawaii','glovo',3400),('hawaii','bolt',3400),
 ('carb','base',3000),('carb','wolt',3800),('carb','glovo',3800),('carb','bolt',3800),
 ('salmon','base',3400),('salmon','wolt',4200),('salmon','glovo',4200),('salmon','bolt',4200);
INSERT OR IGNORE INTO ingredients (id, name, unit, cost_per_1000_tetri, min_stock) VALUES
 ('dough','Тесто','g',240,4000),('mozz','Моцарелла','g',2600,4000),('sauce','Томатный соус','g',900,3000),
 ('pepp','Пепперони','g',3800,1500),('cream','Сливочная основа','g',1400,1500),('chick','Курица','g',1800,2000),('basil','Базилик','g',6000,100);
INSERT OR IGNORE INTO recipes (product_id, ingredient_id, qty) VALUES
 ('pep','dough',280),('pep','sauce',90),('pep','mozz',170),('pep','pepp',70),
 ('marg','dough',280),('marg','sauce',100),('marg','mozz',190),('marg','basil',5),
 ('five','dough',280),('five','cream',80),('five','mozz',180),
 ('ranch','dough',280),('ranch','cream',70),('ranch','mozz',160),('ranch','chick',110),
 ('diablo','dough',280),('diablo','sauce',90),('diablo','mozz',160),('diablo','pepp',80),
 ('hawaii','dough',280),('hawaii','sauce',90),('hawaii','mozz',160),
 ('carb','dough',280),('carb','cream',90),('carb','mozz',160),
 ('salmon','dough',280),('salmon','cream',80),('salmon','mozz',150);

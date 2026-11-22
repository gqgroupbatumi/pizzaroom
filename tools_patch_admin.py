p='/home/claude/srv/public/kassa/index.html'; s=open(p).read()
def rep(a,b):
    global s
    assert a in s, 'MISSING: '+a[:80]; s=s.replace(a,b,1)
rep("const TABS = () => [['orders', L('Заказы сейчас', 'მიმდინარე შეკვეთები')], ['analytics', L('Аналитика', 'ანალიტიკა')],",
"const TABS = () => [['orders', L('Заказы сейчас', 'მიმდინარე შეკვეთები')], ['analytics', L('Аналитика', 'ანალიტიკა')], ['promos', L('Акции и праздники', 'აქციები და დღესასწაულები')], ['customers', L('Клиенты', 'კლიენტები')],")
rep("    if (tab === 'orders') await loadOrders();","""    if (!S.A.hol) { try { S.A.hol = await api('GET', '/api/holidays'); } catch (e) { S.A.hol = []; } }
    if (tab === 'orders') await loadOrders();
    if (tab === 'promos') { S.A.hol = await api('GET', '/api/holidays'); S.A.promos = await api('GET', '/api/promos'); S.A.cat = S.A.cat || await api('GET', '/api/catalog'); }
    if (tab === 'customers') { S.A.cust = await api('GET', '/api/customers'); S.A.wait = await api('GET', '/api/waitlist'); }""")
rep("if (tab === 'stock') { S.A.cat = await api('GET', '/api/catalog'); S.A.moves = await api('GET', '/api/stock/moves?limit=60'); }",
"if (tab === 'stock') { S.A.cat = await api('GET', '/api/catalog'); S.A.moves = await api('GET', '/api/stock/moves?limit=60'); S.A.fc = await api('GET', '/api/stock/forecast'); }")
rep("if (tab === 'settings') S.settings = await api('GET', '/api/settings');","if (tab === 'settings') { S.settings = await api('GET', '/api/settings'); S.A.branches = await api('GET', '/api/branches'); }")
rep("    <main class=\"main\">${body ? body() : ''}</main></div>`;","    <main class=\"main\">${reminder()}${body ? body() : ''}</main></div>`;")
rep("function viewAdmin() {","""function reminder() {
  const due = (S.A.hol || []).filter((h) => !h.promo && h.days_left >= 0 && h.days_left <= 14);
  if (!due.length || S.atab === 'promos') return '';
  return `<div class="note" style="display:flex;justify-content:space-between;align-items:center;gap:12px;background:#FFE8A3;color:var(--ink)"><span>🔔 <b>${L('Скоро праздник без акции', 'მალე დღესასწაულია აქციის გარეშე')}:</b> ${due.map((h) => esc(L(h.ru, h.ka)) + ' — ' + (h.days_left === 0 ? L('сегодня', 'დღეს') : L('через ', '') + h.days_left + L(' дн.', ' დღეში'))).join(' · ')}</span><button class="b bd sm" data-a="tab" data-k="promos">${L('Включить скидку', 'ფასდაკლების ჩართვა')}</button></div>`;
}
function viewPromos() {
  const P = S.A.promos || []; const t = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const st = (p) => !p.active ? ['bad', L('выключена', 'გამორთული')] : p.date_to < t ? ['mid', L('прошла', 'დასრულდა')] : p.date_from > t ? ['mid', L('запланирована', 'დაგეგმილი')] : ['good', L('идёт сейчас', 'მიმდინარეობს')];
  const catName = (id) => { const c = (S.A.cat?.categories || []).find((x) => x.id === id); return c ? L(c.name_ru, c.name_ka) : id; };
  return `<div class="row between"><h1>${L('Акции и праздники', 'აქციები და დღესასწაულები')}</h1><button class="b by" data-a="prNew">+ ${L('Акция', 'აქცია')}</button></div>
  <div class="note">${L('Акция включается и выключается сама в указанные даты — сайт показывает баннер, а сервер сам ставит скидку в чеке. Напоминание о праздниках без акции приходит в админку и утром в Telegram.', 'აქცია თავად ირთვება და ითიშება მითითებულ თარიღებში.')}</div>
  <div class="card"><b>${L('Акции', 'აქციები')}</b><table><tr><th>${L('Название', 'სახელი')}</th><th class="n">%</th><th>${L('Даты', 'თარიღები')}</th><th>${L('Разделы', 'განყოფილებები')}</th><th>${L('Где', 'სად')}</th><th>${L('Статус', 'სტატუსი')}</th><th></th></tr>
  ${P.map((p) => { const [c, n] = st(p); return `<tr><td><b>${esc(L(p.title_ru, p.title_ka))}</b></td><td class="n"><b>−${p.pct}%</b></td><td>${p.date_from} — ${p.date_to}</td><td class="mut">${p.cats.map(catName).join(', ')}</td><td class="mut">${p.channels.map((x) => L(CH_RU[x], CH[x])).join(', ')}</td><td><span class="pos-pill ${c}">${n}</span></td><td><button class="b bw sm" data-a="prEdit" data-id="${p.id}">✎</button></td></tr>`; }).join('') || `<tr><td colspan="7" class="mut">${L('Акций пока нет', 'აქციები ჯერ არ არის')}</td></tr>`}</table></div>
  <div class="card"><b>${L('Календарь праздников на год', 'დღესასწაულების კალენდარი')}</b><table><tr><th>${L('Дата', 'თარიღი')}</th><th>${L('Праздник', 'დღესასწაული')}</th><th class="n">${L('Через', 'დარჩა')}</th><th class="n">${L('Совет', 'რჩევა')}</th><th></th></tr>
  ${(S.A.hol || []).map((h) => `<tr class="${!h.promo && h.days_left <= 14 ? 'low' : ''}"><td style="white-space:nowrap">${h.date}</td><td><b>${esc(L(h.ru, h.ka))}</b></td><td class="n">${h.days_left} ${L('дн.', 'დღე')}</td><td class="n">−${h.pct}%</td>
    <td>${h.promo ? `<span class="pos-pill good">${L('акция есть', 'აქცია არის')}</span>` : `<button class="b by sm" data-a="prHol" data-id="${h.id}">${L('Создать акцию', 'აქციის შექმნა')}</button>`}</td></tr>`).join('')}</table></div>`;
}
function promoForm(p) {
  const C = S.A.cat;
  p = p || { title_ru: '', title_ka: '', title_en: '', pct: 15, date_from: '', date_to: '', cats: ['pizza'], channels: ['site'], banner: 1, active: 1 };
  S.modal = { type: 'form', wide: true, data: p, html: () => `<h3>${p.id ? L('Акция', 'აქცია') : L('Новая акция', 'ახალი აქცია')}</h3>
    <div class="g3"><label class="l">${L('Название (рус.)', 'სახელი (რუს.)')}<input class="f" id="pr_ru" value="${esc(p.title_ru)}"></label><label class="l">${L('Название (груз.)', 'სახელი (ქართ.)')}<input class="f" id="pr_ka" value="${esc(p.title_ka)}"></label><label class="l">${L('Название (англ.)', 'სახელი (ინგლ.)')}<input class="f" id="pr_en" value="${esc(p.title_en)}"></label></div>
    <div class="g3"><label class="l">${L('Скидка, %', 'ფასდაკლება, %')}<select class="f" id="pr_pct">${[5, 10, 15, 20, 25, 30].map((v) => `<option ${Number(p.pct) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="l">${L('С', '-დან')}<input class="f" id="pr_from" type="date" value="${esc(p.date_from)}"></label><label class="l">${L('По (включительно)', '-მდე')}<input class="f" id="pr_to" type="date" value="${esc(p.date_to)}"></label></div>
    <div><b style="font-size:13px">${L('На какие разделы', 'რომელ განყოფილებებზე')}</b><div class="row wrap" style="margin-top:6px">${C.categories.filter((c) => !c.soon).map((c) => `<label class="row" style="background:#fff;border-radius:10px;padding:6px 10px;font-weight:700"><input type="checkbox" data-prc="${c.id}" ${p.cats.includes(c.id) ? 'checked' : ''}> ${esc(L(c.name_ru, c.name_ka))}</label>`).join('')}</div></div>
    <div><b style="font-size:13px">${L('Где действует', 'სად მოქმედებს')}</b><div class="row wrap" style="margin-top:6px">${['site', 'hall', 'takeaway', 'delivery'].map((c) => `<label class="row" style="background:#fff;border-radius:10px;padding:6px 10px;font-weight:700"><input type="checkbox" data-prch="${c}" ${p.channels.includes(c) ? 'checked' : ''}> ${L(CH_RU[c], CH[c])}</label>`).join('')}</div>
      <p class="mut" style="margin:6px 0 0">${L('Wolt и Glovo — скидки настраиваются в их кабинетах.', 'Wolt და Glovo — ფასდაკლება მათ კაბინეტებში.')}</p></div>
    <div class="row wrap"><label class="row" style="font-weight:700"><input type="checkbox" id="pr_banner" ${p.banner ? 'checked' : ''}> ${L('Баннер и окно на сайте', 'ბანერი საიტზე')}</label><label class="row" style="font-weight:700"><input type="checkbox" id="pr_act" ${p.active ? 'checked' : ''}> ${L('Включена', 'ჩართულია')}</label></div>
    <div class="row"><button class="b bo" style="flex:1" data-a="mClose">${L('Отмена', 'გაუქმება')}</button><button class="b bd" style="flex:1" data-a="prSave">${L('Сохранить', 'შენახვა')}</button></div>` };
  render();
}
function viewCustomers() {
  const now = Date.now(); const q = (S.A.cq || '').toLowerCase();
  const list = (S.A.cust || []).filter((c) => !q || (c.phone + ' ' + (c.name || '')).toLowerCase().includes(q));
  const days = (c) => Math.floor((now - Date.parse(c.last_at.replace(' ', 'T') + 'Z')) / 864e5);
  const msg = (c) => encodeURIComponent(L('Здравствуйте, ' + (c.name || '') + '! Скучаем по вам в Pizza Room 🍕 Закажите на pizzaroom.ge — горячая пицца будет у вас через 35–40 минут.', 'გამარჯობა ' + (c.name || '') + '! Pizza Room-ში მოგენატრეთ 🍕 შეუკვეთეთ pizzaroom.ge-ზე.'));
  const sleeping = (S.A.cust || []).filter((c) => days(c) >= 30 && c.orders >= 2).length;
  return `<h1>${L('Клиенты', 'კლიენტები')}</h1>
  <div class="kpis"><div class="kpi"><span>${L('Клиентов с телефоном', 'კლიენტი ტელეფონით')}</span><b>${(S.A.cust || []).length}</b></div><div class="kpi"><span>${L('Постоянные (3+ заказа)', 'მუდმივი (3+)')}</span><b>${(S.A.cust || []).filter((c) => c.orders >= 3).length}</b></div>
    <div class="kpi"><span>${L('«Уснули» — 30+ дней без заказа', '30+ დღე შეკვეთის გარეშე')}</span><b style="color:var(--redink)">${sleeping}</b></div><div class="kpi"><span>${L('Ждут открытия «скоро»', 'ელოდება „მალე“')}</span><b>${(S.A.wait || []).length}</b></div></div>
  <input id="cq" class="f" style="max-width:360px" placeholder="${L('Поиск по телефону или имени', 'ძებნა ტელეფონით ან სახელით')}" value="${esc(S.A.cq || '')}">
  <div class="card" style="padding:6px 8px"><table><tr><th>${L('Клиент', 'კლიენტი')}</th><th class="n">${L('Заказов', 'შეკვეთა')}</th><th class="n">${L('Сумма', 'თანხა')}</th><th class="n">${L('Средний чек', 'საშ. ჩეკი')}</th><th>${L('Последний заказ', 'ბოლო შეკვეთა')}</th><th></th></tr>
  ${list.slice(0, 200).map((c) => { const d = days(c); return `<tr><td><b>${esc(c.name || '—')}</b><div class="mut">${esc(c.phone)}</div></td><td class="n">${c.orders}</td><td class="n">${money(c.total_tetri)}</td><td class="n">${money(Math.round(c.total_tetri / c.orders))}</td>
    <td>${d === 0 ? L('сегодня', 'დღეს') : d + L(' дн. назад', ' დღის წინ')} ${d >= 30 && c.orders >= 2 ? `<span class="pos-pill bad">${L('уснул', 'დაიძინა')}</span>` : c.orders >= 3 ? `<span class="pos-pill good">${L('постоянный', 'მუდმივი')}</span>` : ''}</td>
    <td><a class="b bw sm" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/${esc(c.phone.replace(/\\D/g, ''))}?text=${msg(c)}">WhatsApp</a></td></tr>`; }).join('') || `<tr><td colspan="6" class="mut">${L('Клиенты появятся после заказов с сайта и заказов с телефоном', 'კლიენტები გამოჩნდება შეკვეთების შემდეგ')}</td></tr>`}</table></div>
  <div class="card"><b>${L('Лист ожидания «Скоро»', 'მოლოდინის სია „მალე“')}</b><p class="mut" style="margin:0">${L('Эти люди попросили сообщить об открытии раздела. В день запуска напишите им в WhatsApp — это ваши первые покупатели.', 'ამ ადამიანებმა ითხოვეს შეტყობინება გახსნისას.')}</p>
    <table><tr><th>${L('Телефон', 'ტელეფონი')}</th><th>${L('Раздел', 'განყოფილება')}</th><th>${L('Когда', 'როდის')}</th><th></th></tr>${(S.A.wait || []).map((w) => `<tr><td>${esc(w.phone)}</td><td>${esc(w.name_ru)}</td><td>${esc(w.created_at.slice(0, 10))}</td><td><a class="b bw sm" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/${esc(w.phone.replace(/\\D/g, ''))}">WhatsApp</a></td></tr>`).join('') || `<tr><td colspan="4" class="mut">—</td></tr>`}</table></div>`;
}
function viewAdmin() {""")
rep("const body = { orders: viewOrdersAdm, analytics: viewAnalytics,","const body = { orders: viewOrdersAdm, promos: viewPromos, customers: viewCustomers, analytics: viewAnalytics,")
rep("    case 'aSort': S.A.sort = d.k; return render();","""    case 'aSort': S.A.sort = d.k; return render();
    case 'prNew': return promoForm();
    case 'prEdit': return promoForm(JSON.parse(JSON.stringify(S.A.promos.find((p) => p.id === Number(d.id)))));
    case 'prHol': { const h = S.A.hol.find((x) => x.id === d.id); return promoForm({ title_ru: h.ru, title_ka: h.ka, title_en: h.en, pct: h.pct, date_from: h.from, date_to: h.to, cats: ['pizza'], channels: ['site'], banner: 1, active: 1, holiday: h.id }); }
    case 'prSave': { const p = m.data; const body = { id: p.id, holiday: p.holiday, title_ru: val('pr_ru'), title_ka: val('pr_ka'), title_en: val('pr_en'), pct: Number(val('pr_pct')), date_from: val('pr_from'), date_to: val('pr_to'),
        cats: [...document.querySelectorAll('[data-prc]')].filter((x) => x.checked).map((x) => x.dataset.prc), channels: [...document.querySelectorAll('[data-prch]')].filter((x) => x.checked).map((x) => x.dataset.prch),
        banner: !!document.getElementById('pr_banner')?.checked, active: !!document.getElementById('pr_act')?.checked };
      return run(async () => { await api('POST', '/api/promos', body); S.modal = null; S.A.promos = await api('GET', '/api/promos'); S.A.hol = await api('GET', '/api/holidays'); toast(L('Акция сохранена', 'აქცია შენახულია')); }); }
    case 'repSend': return run(async () => { const r = await api('POST', '/api/daily-report'); S.modal = { type: 'form', html: () => `<h3>${L('Отчёт за вчера', 'გუშინდელი ანგარიში')}</h3><pre style="white-space:pre-wrap;font:600 14px Inter,sans-serif;margin:0">${esc(r.text)}</pre><div class="note">${L('Когда подключим Telegram — такой отчёт будет приходить вам каждое утро сам.', 'Telegram-ის ჩართვის შემდეგ ანგარიში ყოველ დილით მოვა.')}</div><button class="b bd" data-a="mClose">OK</button>` }; });
    case 'brNew': S.modal = { type: 'form', html: () => `<h3>${L('Новый филиал', 'ახალი ფილიალი')}</h3><label class="l">${L('Название', 'სახელი')}<input class="f" id="b_name"></label><label class="l">${L('Адрес', 'მისამართი')}<input class="f" id="b_addr"></label><label class="l">${L('Телефон', 'ტელეფონი')}<input class="f" id="b_phone"></label>
      <div class="note">${L('Филиал появится в базе. Отдельные кассы, склад и отчёты по каждому филиалу включим, когда откроете вторую точку.', 'ფილიალი დაემატება ბაზაში.')}</div><div class="row"><button class="b bo" style="flex:1" data-a="mClose">${L('Отмена', 'გაუქმება')}</button><button class="b bd" style="flex:1" data-a="brSave">${L('Сохранить', 'შენახვა')}</button></div>` }; return render();
    case 'brSave': { const body = { name_ru: val('b_name'), address: val('b_addr'), phone: val('b_phone') }; return run(async () => { await api('POST', '/api/branches', body); S.modal = null; S.A.branches = await api('GET', '/api/branches'); }); }""")
rep("  if (t.id === 'q') { S.q = t.value; render(); return; }","  if (t.id === 'q') { S.q = t.value; render(); return; }\n  if (t.id === 'cq') { S.A.cq = t.value; render(); return; }")
rep("""  <div class="card"><b>${L('Последние движения', 'ბოლო მოძრაობები')}</b>""","""  ${(() => { const F = (S.A.fc || []).filter((x) => x.per_day > 0 || x.buy_qty > 0); if (!F.length) return '';
    const buy = F.filter((x) => x.buy_qty > 0); const tot = buy.reduce((s, x) => s + x.buy_tetri, 0);
    return `<div class="card"><div class="row between"><b>${L('Прогноз: на сколько дней хватит (по расходу за 14 дней)', 'პროგნოზი: რამდენ დღეს ეყოფა')}</b><span class="mut">${L('Закупка на 7 дней', 'შესყიდვა 7 დღეზე')}: <b>${money(tot)}</b></span></div>
    <table><tr><th>${L('Ингредиент', 'ინგრედიენტი')}</th><th class="n">${L('Расход в день', 'დღიური ხარჯი')}</th><th class="n">${L('Хватит на', 'ეყოფა')}</th><th class="n">${L('Купить на неделю', 'კვირაზე საყიდელი')}</th><th class="n">≈ ₾</th></tr>
    ${F.sort((a, b) => (a.days_left ?? 999) - (b.days_left ?? 999)).map((x) => `<tr class="${x.days_left != null && x.days_left < 3 ? 'low' : ''}"><td><b>${esc(x.name)}</b></td><td class="n">${fmtQty(x.per_day, x.unit)}</td><td class="n">${x.days_left == null ? '—' : `<span class="pos-pill ${x.days_left < 3 ? 'bad' : x.days_left < 7 ? 'mid' : 'good'}">${x.days_left} ${L('дн.', 'დღე')}</span>`}</td><td class="n">${x.buy_qty ? fmtQty(x.buy_qty, x.unit) : '—'}</td><td class="n">${x.buy_tetri ? money(x.buy_tetri) : '—'}</td></tr>`).join('')}</table></div>`; })()}
  <div class="card"><b>${L('Последние движения', 'ბოლო მოძრაობები')}</b>""")
rep("""<td class="n">${p.ch.own?.qty || 0} · ${perUnit(p.ch.own)}</td><td class="n">${p.ch.wolt?.qty || 0} · ${perUnit(p.ch.wolt)}</td><td class="n">${p.ch.glovo?.qty || 0} · ${perUnit(p.ch.glovo)}</td></tr>`).join('') || `<tr><td colspan="10" class="mut">${L('Продаж ещё нет', 'გაყიდვები ჯერ არ არის')}</td></tr>`}</table></div></div>`;""",
"""<td class="n">${p.ch.own?.qty || 0} · ${perUnit(p.ch.own)}</td><td class="n">${p.ch.wolt?.qty || 0} · ${perUnit(p.ch.wolt)}</td><td class="n">${p.ch.glovo?.qty || 0} · ${perUnit(p.ch.glovo)}</td></tr>`).join('') || `<tr><td colspan="10" class="mut">${L('Продаж ещё нет', 'გაყიდვები ჯერ არ არის')}</td></tr>`}</table></div></div>
  ${menuMatrix(plist)}
  <div class="row"><button class="b bo" data-a="repSend">${L('Отчёт за вчера (как утром в Telegram)', 'გუშინდელი ანგარიში')}</button></div>`;""")
rep("function viewAnalytics() {","""// Матрица меню (метод Kasavana–Smith): популярность × прибыль с порции
function menuMatrix(plist) {
  const L2 = plist.filter((p) => p.qty > 0); if (L2.length < 3) return '';
  const totQ = L2.reduce((s, p) => s + p.qty, 0); const popLine = (1 / L2.length) * 0.7;
  const cmAvg = L2.reduce((s, p) => s + p.profit, 0) / totQ;
  const Q = { star: [], horse: [], puzzle: [], dog: [] };
  for (const p of L2) { const pop = p.qty / totQ >= popLine; const prof = p.profit / p.qty >= cmAvg; Q[pop && prof ? 'star' : pop ? 'horse' : prof ? 'puzzle' : 'dog'].push(p); }
  const box = (k, title, tip, col) => `<div style="background:${col};border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:6px"><b>${title} · ${Q[k].length}</b><span style="font-size:12px;opacity:.85">${tip}</span><span style="font-weight:700">${Q[k].map((p) => esc(p.name)).join(', ') || '—'}</span></div>`;
  return `<div class="card"><b>${L('Матрица меню: что продвигать, а что менять', 'მენიუს მატრიცა')}</b>
    <p class="mut" style="margin:0">${L('Популярность — доля продаж; прибыль — сколько остаётся с одной порции после комиссии и себестоимости. Средняя прибыль с порции', 'საშუალო მოგება პორციაზე')}: <b>${money(Math.round(cmAvg))}</b></p>
    <div class="g2">${box('star', L('★ Звёзды', '★ ვარსკვლავები'), L('Популярные и прибыльные — держите на виду, первыми в меню', 'პოპულარული და მომგებიანი'), '#DDE7D2')}${box('puzzle', L('? Загадки', '? თავსატეხები'), L('Прибыльные, но берут редко — лучшее фото, место в топе, акция', 'მომგებიანი, მაგრამ იშვიათად'), '#E5EEF9')}
    ${box('horse', L('🐴 Рабочие лошадки', '🐴 მუშა ცხენები'), L('Берут часто, но мало приносят — поднимите цену на 1–2 ₾ или удешевите рецепт', 'ხშირად, მაგრამ ცოტა მოგება'), '#FFF1C9')}${box('dog', L('✕ Слабые', '✕ სუსტები'), L('Редко и невыгодно — переделать или убрать из меню', 'იშვიათად და წამგებიანად'), '#FCE3DE')}</div></div>`;
}
function viewAnalytics() {""")
rep("""  <button class="b bd" style="align-self:flex-start;height:50px" data-a="setSave">${L('Сохранить настройки', 'პარამეტრების შენახვა')}</button>`;""","""  <button class="b bd" style="align-self:flex-start;height:50px" data-a="setSave">${L('Сохранить настройки', 'პარამეტრების შენახვა')}</button>
  <div class="card"><div class="row between"><b>${L('Филиалы (основа для будущей сети)', 'ფილიალები')}</b>${isOwner() ? `<button class="b bw sm" data-a="brNew">+ ${L('Филиал', 'ფილიალი')}</button>` : ''}</div>
    <table><tr><th>${L('Название', 'სახელი')}</th><th>${L('Адрес', 'მისამართი')}</th><th>${L('Телефон', 'ტელეფონი')}</th></tr>${(S.A.branches || []).map((b) => `<tr><td><b>${esc(b.name_ru)}</b></td><td>${esc(b.address || '')}</td><td>${esc(b.phone || '')}</td></tr>`).join('')}</table></div>`;""")
i=s.index("""  <div class="card"><b>${L('Акция на сайте', 'აქცია საიტზე')}</b>"""); j=s.index("""  <button class="b bd" style="align-self:flex-start;height:50px" data-a="setSave">""")
s=s[:i]+"""  <div class="note">${L('Акции и скидки теперь в разделе «Акции и праздники» — с календарём и автоматическим включением.', 'აქციები — განყოფილებაში „აქციები და დღესასწაულები“.')}</div>\n"""+s[j:]
rep("""        promo: { on: val('s_pon') === '1', pct: n('s_ppct'), from: val('s_pfrom'), to: val('s_pto'), title_ru: val('s_pru'), title_ka: val('s_pka'), title_en: val('s_pen') },\n""","")
open(p,'w').write(s)
print('patched')

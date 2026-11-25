import re,shutil,os
import os as _os; _os.chdir(_os.path.dirname(_os.path.abspath(__file__)))
s=open('App.dc.html').read()
helmet=s[s.index('<helmet>')+8:s.index('</helmet>')]
body=s[s.index('</helmet>')+9:s.index('</x-dc>')]
script=re.search(r'<script type="text/x-dc"[^>]*>([\s\S]*?)</script>',s).group(1)
def R(txt,a,b,name):
    assert a in txt, 'MISSING '+name; return txt.replace(a,b,1)
# ---------- markup ----------
i=body.index('<div style="background: #FFF1C9; border-radius: 14px; padding: 10px 12px; font-size: 13px; line-height: 1.4; font-weight: 600">{{L.testMode}}</div>')
j=body.index('</div>',i)+6; body=body[:i]+body[j:]
# find-us map
i=body.index('<sc-if value="{{isMap}}"'); a=body.index('<div style="position: relative; border-radius: 22px; overflow: hidden; background: #E3D3B6">',i)
b=body.index('{{L.mapNote}}</span>',a); b=body.index('</div>',b)+6
body=body[:a]+'<div data-map="find" style="height: 340px; border-radius: 22px; overflow: hidden; background: #E3D3B6; position: relative"></div>'+body[b:]
# tracking map
i=body.index('<sc-if value="{{isStatus}}"'); a=body.index('<div style="position: relative; border-radius: 22px; overflow: hidden; background: #E3D3B6">',i)
b=body.index('{{mapBadge}}</span>',a); b=body.index('</div>',b)+6
body=body[:a]+'<div style="position: relative; border-radius: 22px; overflow: hidden"><div data-map="track" style="height: 280px; background: #E3D3B6"></div><span style="position: absolute; left: 10px; top: 10px; z-index: 500; background: rgba(251,245,234,0.94); border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 700; color: #2A1D13">{{mapBadge}}</span></div>'+body[b:]
# map shows for delivery orders that have coordinates OR always (pizzeria)
# ---------- script ----------
script=R(script,"  readAdmin() {\n    try { const raw = window.localStorage.getItem('pizzaroom_admin_v1'); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }\n  }","  readAdmin() { return window.__PR_ADMIN || null; }\n  afterRender(host) { if (window.PRMap) window.PRMap.attach(host, this); }",'readAdmin')
i=script.index('    const MENU = ['); j=script.index('    ];\n    const prices = A.prices || {};')+7
script=script[:i]+"    const MENU = (window.__PR_MENU || []).map((x) => Object.assign({}, x, { n: { ru: x.n.ru.slice(), en: x.n.en.slice(), ka: x.n.ka.slice() } }));\n"+script[j:]
script=R(script,"[['all', L.tagAll], ['classic', L.tagClassic], ['meat', L.tagMeat], ['cream', L.tagCream], ['drinks', L.tagDrinks]]","[['all', L.tagAll]].concat((window.__PR_CATS || []).map((c) => [c.id, (c['name_' + lang] || c.name_ru) + (c.soon ? ' · ' + L.soonBadge : '') + (c.age18 ? ' · 18+' : '')]))",'tags')
script=R(script,"const featured = ['pep', 'marg', 'five', 'ranch'].map((id) => decorate(byId[id]));","const featured = (['pep', 'marg', 'five', 'ranch'].filter((id) => byId[id]).length ? ['pep', 'marg', 'five', 'ranch'].filter((id) => byId[id]) : MENU.slice(0, 4).map((m) => m.id)).map((id) => decorate(byId[id]));",'featured')
script=R(script,"const hname = (HOL[P.holiday] || HOL.custom)[lang];","const hname = P['title_' + lang] || P.title_ru || (HOL[P.holiday] || HOL.custom)[lang];",'hname')
script=R(script,"const isOpen = this.props.isOpen ?? true;","const isOpen = (window.__PR_ADMIN && window.__PR_ISOPEN) ? window.__PR_ISOPEN(window.__PR_ADMIN.open, window.__PR_ADMIN.close) : true;",'isOpen')
# place -> real API
i=script.index("      try { window.localStorage.setItem('pr_last', JSON.stringify(qty)); } catch (e) {} this.startTrack(); this.setState({ orderAt: Date.now(), track: 0, orderNo:"); j=script.index("\n",i)
script=script[:i]+"""      if (this.state.sending) return; this.setState({ sending: true });
      const meP = this.state.me;
      fetch('/api/public/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, phone: f.phone, mode: this.state.mode, zone: zone.id, address: f.addr, comment: f.com, pay: 'cash', lang, lat: meP ? meP.lat : null, lng: meP ? meP.lon : null, items: Object.keys(qty).map((id) => ({ product_id: id, qty: qty[id] })), combos: (this.state.combos || []).flatMap((c) => Array.from({ length: c.qty }, () => ({ combo_id: c.id, picks: c.picks }))) }) })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (!ok) { this.setState({ sending: false }); const E = (window.PR_ERR[d.error] || {})[lang]; this.flash(E || d.message || 'Error'); return; }
          try { localStorage.setItem('pr_track', JSON.stringify({ token: d.token, id: d.id, mode: this.state.mode, count })); localStorage.setItem('pr_last', JSON.stringify(qty)); } catch (e) {}
          this.setState({ sending: false, token: d.token, live: null, orderAt: Date.now(), orderNo: '№ ' + d.id, status: 0, screen: 'status', lastMode: this.state.mode, lastTotal: d.total_tetri / 100, lastCount: count, qty: {}, combos: [] });
          this.startTrack();
        }).catch(() => { this.setState({ sending: false }); this.flash(L.offline); });"""+script[j:]
script=R(script,"  startTrack() { clearInterval(this._trk); this._trk = setInterval(() => { const t = (this.state.track || 0) + 1; this.setState({ track: t }); if (t >= 60) clearInterval(this._trk); }, 1000); }",
"""  startTrack() {
    clearInterval(this._trk);
    const poll = () => { const t = this.state.token; if (!t) return; fetch('/api/public/order/' + t).then((r) => r.ok ? r.json() : null).then((d) => { if (!d) return; this.setState({ live: d, lastMode: d.mode || this.state.lastMode, lastTotal: d.total_tetri / 100, lastCount: (d.items || []).reduce((a, i) => a + i.qty, 0) }); if (d.status === 'delivered' || d.status === 'cancelled' || (d.mode === 'pickup' && d.status === 'ready')) { clearInterval(this._trk); try { localStorage.removeItem('pr_track'); } catch (e) {} } }).catch(() => {}); };
    poll(); this._trk = setInterval(poll, 8000);
  }""",'startTrack')
script=R(script,"const tr = Math.min(this.state.track || 0, TT);","const LV = this.state.live; const tr = Math.min(LV && LV.created_at ? Math.max(0, (Date.now() - Date.parse(LV.created_at.replace(' ', 'T') + 'Z')) / 60000) : 0, TT);",'tr')
script=R(script,"let stage = 0; while (stage < bounds.length - 1 && tr >= bounds[stage]) stage++;","let stage = LV ? ({ received: 0, cooking: 1, ready: 2, onway: 3, delivered: 4, cancelled: 0 }[LV.status] || 0) : 0; if (!lastDel && stage > 2) stage = 2;",'stage')
script=R(script,"const left = Math.max(0, TT - tr);","const left = Math.max(1, Math.round(TT - tr));",'left')
script=R(script,"const etaD = new Date((this.state.orderAt || Date.now()) + TT * 60000);","const etaD = new Date((LV && LV.created_at ? Date.parse(LV.created_at.replace(' ', 'T') + 'Z') : (this.state.orderAt || Date.now())) + TT * 60000);",'etaD')
script=R(script,"const finished = tr >= TT;","const finished = !!LV && (LV.status === 'delivered' || LV.status === 'cancelled' || (!lastDel && LV.status === 'ready'));",'finished')
script=R(script,"trackRunning: !finished,","trackRunning: false,",'trackRunning')
script=script.replace("trackPct: Math.round(tr / TT * 100) + '%',","trackPct: (finished ? 100 : Math.min(95, Math.round(Math.max(stage / (lastDel ? 4 : 2), tr / TT) * 100))) + '%',")
script=R(script,"etaTitle: finished ?","etaTitle: LV && LV.status === 'cancelled' ? ({ ru: 'Заказ отменён. Позвоните нам: ', en: 'Order cancelled. Call us: ', ka: 'შეკვეთა გაუქმდა. დაგვირეკეთ: ' }[lang] + (A.phone || '')) : finished ?",'etaTitle')
script=R(script,"trackMap: lastDel,","trackMap: true,",'trackMap')
# distance labels from real route
script=R(script,"      timeLabel = '~' + Math.max(3, Math.round(km / 28 * 60 + 2)) + ' ' + L.min;\n    }","      timeLabel = '~' + Math.max(3, Math.round(km / 28 * 60 + 2)) + ' ' + L.min;\n    }\n    if (me && window.PRMap && window.PRMap.route) { const rr = window.PRMap.route; distLabel = (rr.km < 10 ? rr.km.toFixed(1) : Math.round(rr.km)) + ' ' + L.km; timeLabel = '≈' + rr.min + ' ' + L.min; }",'route')
# restore tracking after reload
script=R(script,"    const a = this.readAdmin(); this._last = JSON.stringify(a); this.setState({ admin: a });","    const a = this.readAdmin(); this._last = JSON.stringify(a); this.setState({ admin: a });\n    try { const tk = JSON.parse(localStorage.getItem('pr_track') || 'null'); if (tk && tk.token) { this.setState({ token: tk.token, orderNo: '№ ' + tk.id, lastMode: tk.mode, lastCount: tk.count, screen: 'status' }); this.startTrack(); } } catch (e) {}",'restore')
# live texts
for old,new in [("trackNote: 'Демо: 1 секунда = 1 минута. В рабочей версии курьер передаёт GPS со своего телефона, а время пересчитывается с учётом пробок.'","trackNote: 'Статус обновляется сам. Время примерное; если есть вопрос — нажмите WhatsApp или позвоните.'"),
  ("trackNote: 'Demo: 1 second = 1 minute. In the live version the courier’s phone shares GPS and the time is recalculated with live traffic.'","trackNote: 'The status updates by itself. Times are approximate; questions — tap WhatsApp or call us.'"),
  ("trackNote: 'დემო: 1 წამი = 1 წუთი. სამუშაო ვერსიაში კურიერის ტელეფონი GPS-ს აგზავნის, დრო კი საცობების გათვალისწინებით გადაითვლება.'","trackNote: 'სტატუსი თავისით ახლდება. დრო მიახლოებითია; კითხვისთვის დააჭირეთ WhatsApp-ს ან დაგვირეკეთ.'")]:
    script=R(script,old,new,'note '+new[:10])
script=script.replace("mapNote: 'В рабочем сайте — живая карта с маршрутом'","mapNote: ''")
# размеры на языке посетителя
script=script.replace("m.size ? ' ' + m.size : ''","m.size ? ' ' + window.PR_SZ(m.size, lang) : ''").replace("m.size || L.size","window.PR_SZ(m.size, lang) || L.size")
# профессиональная правка грузинских текстов
KA=[("heroSub: 'თხელი ცომი, იტალიური მოცარელა და პომიდორი, უხვი შიგთავსი ბოლომდე. ვამზადებთ Batumi Mall-ში 2018 წლიდან — წაიღეთ თავად ან მოგიტანთ ბათუმის მასშტაბით.'",
     "heroSub: 'თხელი ცომი, იტალიური მოცარელა და პომიდორი, უხვი შიგთავსი თვით კიდემდე. ვამზადებთ Batumi Mall-ში 2018 წლიდან — გაიტანეთ თავად ან მოგიტანთ ბათუმის ნებისმიერ წერტილში.'"),
    ("delivery: 'მიწოდება'","delivery: 'მიტანა'"),("deliveryFee: 'მიწოდება'","deliveryFee: 'მიტანა'"),
    ("ხარისხის კონტროლი ყოველ ეტაპზე და ყოველი პიცა მზარეულის ხელით. ამიტომ Wolt-ის სტუმრები 9,8-ით გვაფასებენ","ხარისხის კონტროლი ყოველ ეტაპზე და ყოველ პიცას მზარეული ხელით ამზადებს. ამიტომაც Wolt-ის მომხმარებლები 9,8 ქულით გვაფასებენ"),
    ("search: 'იპოვეთ პიცა ან ინგრედიენტი'","search: 'მოძებნეთ პიცა ან ინგრედიენტი'"),
    ("tagCream: 'ნაღების'","tagCream: 'ნაღებიანი'"),
    ("notifyOk: 'მზადაა! გახსნის დღეს მოგწერთ.'","notifyOk: 'გმადლობთ! გახსნის დღეს აუცილებლად მოგწერთ.'"),
    ("ageQ: '18 წლის ხართ?'","ageQ: 'შეგისრულდათ 18 წელი?'"),("ageYes: 'დიახ'","ageYes: 'დიახ, შემისრულდა'"),
    ("კურიერმა შეიძლება მოგთხოვოთ დოკუმენტი.","კურიერმა შეიძლება მოგთხოვოთ პირადობის დამადასტურებელი დოკუმენტი."),
    ("empty: 'კალათა ჯერ ცარიელია'","empty: 'კალათა ცარიელია'"),
    ("backToMenu: 'მენიუდან დამატება'","backToMenu: 'კიდევ დაამატეთ მენიუდან'"),
    ("payCourier: 'ნაღდით ან ბარათით კურიერთან'","payCourier: 'ნაღდი ფულით ან ბარათით კურიერთან'"),
    ("closed: 'ახლა დაკეტილია. შეკვეთებს ვიღებთ გახსნიდან — კალათა შეგიძლიათ წინასწარ შეავსოთ.'","closed: 'ამჟამად დაკეტილი ვართ. შეკვეთებს გახსნისთანავე მივიღებთ — კალათის შევსება შეგიძლიათ წინასწარ.'"),
    ("offline: 'კავშირი არ არის.","offline: 'ინტერნეტთან კავშირი არ არის."),
    ("closedBtn: 'ახლა დაკეტილია'","closedBtn: 'ამჟამად დაკეტილია'"),
    ("howFar: 'რა მანძილია ჩემგან?'","howFar: 'რა მანძილია ჩემამდე?'"),
    ("openIn: 'მარშრუტი აპლიკაციაში'","openIn: 'მარშრუტის გაყვანა:'"),
    ("mapAlt: 'სქემა: Pizza Room, Batumi Mall'","mapAlt: 'რუკა: Pizza Room, Batumi Mall'"),
    ("aboutKicker: 'ჩვენ შესახებ'","aboutKicker: 'ჩვენს შესახებ'"),
    ("reviewSlot: 'აქ გამოჩნდება ნამდვილი შეფასებები Google-დან: სახელი, ქულა, ტექსტი და თარიღი ავტომატურად.'","reviewSlot: 'აქ ავტომატურად გამოჩნდება ნამდვილი შეფასებები Google-დან: სახელი, ქულა, ტექსტი და თარიღი.'"),
]
for a,b in KA:
    assert script.count(a)==1, ('KA',a); script=script.replace(a,b)
# окно акции — только по нажатию на полоску, не при входе
script=R(script,"popupSeen: false, ","popupSeen: true, ",'popup init')
script=R(script,"this.setState({ admin: n, popupSeen: false });","this.setState({ admin: n });",'popup poll')
# ── тексты главной (итальянские продукты подтверждены владельцем; рейтинг 9,8 — по всем службам доставки) ──
import re as _re2
def setKey(script, idx, key, val):
    ms=[m for m in _re2.finditer(r"\b"+key+r": '((?:[^'\\]|\\.)*)'", script)]
    assert len(ms)>=3, ('key',key,len(ms)); m=ms[idx]
    return script[:m.start()]+key+": '"+val.replace("'","\\'")+"'"+script[m.end():]
TX={0:{'heroTitle':'Итальянская пицца в Батуми — доставка за 35–40 минут','heroSub':'Итальянские продукты, тонкое тесто и начинка до самого края. Готовим в Batumi Mall с 2018 года — в службах доставки гости ставят нам 9,8 из 10.',
     'aboutText':'С 2018 года мы делаем одну вещь — пиццу, которую хочется заказать снова. Только итальянские продукты, контроль качества на каждом шаге и каждая пицца руками повара. Поэтому в Wolt, Glovo и других службах доставки гости оценивают нас на 9,8 из 10.',
     'f3':'оценка гостей в службах доставки','n4':'35–40'},
    1:{'heroTitle':'Italian pizza in Batumi — delivered in 35–40 minutes','heroSub':'Italian ingredients, thin crust and toppings right to the edge. Made at Batumi Mall since 2018 — delivery-app guests rate us 9.8 out of 10.',
     'aboutText':'Since 2018 we have done one thing: pizza you want to order again. Only Italian ingredients, quality checks at every step, and every pizza made by a chef’s hands. That is why guests on Wolt, Glovo and other delivery apps rate us 9.8 out of 10.',
     'f3':'guest rating on delivery apps','n4':'35–40'},
    2:{'heroTitle':'იტალიური პიცა ბათუმში — მიტანა 35–40 წუთში','heroSub':'იტალიური პროდუქტები, თხელი ცომი და უხვი შიგთავსი თვით კიდემდე. ვამზადებთ Batumi Mall-ში 2018 წლიდან — მიტანის სერვისებში სტუმრები 10-დან 9,8-ით გვაფასებენ.',
     'aboutText':'2018 წლიდან ერთ საქმეს ვაკეთებთ — პიცას, რომლის ხელახლა შეკვეთაც მოგინდებათ. მხოლოდ იტალიური პროდუქტები, ხარისხის კონტროლი ყოველ ეტაპზე და ყოველ პიცას მზარეული ხელით ამზადებს. ამიტომაც Wolt-ზე, Glovo-ზე და სხვა მიტანის სერვისებში სტუმრები 10-დან 9,8-ით გვაფასებენ.',
     'f3':'სტუმრების შეფასება მიტანის სერვისებში','n4':'35–40'}}
for idx,kv in TX.items():
    for k,v in kv.items(): script=setKey(script,idx,k,v)
# компания + вопросы: подписи
for a,b in [("repeat: 'Повторить прошлый заказ'","partyBadge: 'От 5 пицц', partyTitle: 'Пицца на компанию', partyText: 'День рождения, офис или вечеринка: от 5 пицц — скидка 10% и бесплатная доставка по Батуми. Напишите нам — соберём заказ и привезём к нужному времени.', partyBtn: 'Заказать в WhatsApp', partyMsg: 'Здравствуйте! Хочу заказать пиццу на компанию.', faqTitle: 'Частые вопросы', repeat: 'Повторить прошлый заказ'"),
            ("repeat: 'Repeat your last order'","partyBadge: 'From 5 pizzas', partyTitle: 'Pizza for a group', partyText: 'Birthday, office or party: 5+ pizzas get 10% off and free delivery across Batumi. Message us — we will put the order together and deliver it right on time.', partyBtn: 'Order on WhatsApp', partyMsg: 'Hello! I would like to order pizza for a group.', faqTitle: 'Frequently asked questions', repeat: 'Repeat your last order'"),
            ("repeat: 'წინა შეკვეთის გამეორება'","partyBadge: '5 პიციდან', partyTitle: 'პიცა კომპანიისთვის', partyText: 'დაბადების დღე, ოფისი თუ წვეულება: 5 პიციდან — 10% ფასდაკლება და უფასო მიტანა ბათუმში. მოგვწერეთ — შეკვეთას შევადგენთ და სასურველ დროს მოგიტანთ.', partyBtn: 'შეკვეთა WhatsApp-ით', partyMsg: 'გამარჯობა! მინდა პიცის შეკვეთა კომპანიისთვის.', faqTitle: 'ხშირად დასმული კითხვები', repeat: 'წინა შეკვეთის გამეორება'")]:
    assert script.count(a)==1, a; script=script.replace(a,b)
a="      tabs,\n"
assert a in script
script=script.replace(a,"      partyLink: 'https://wa.me/' + String(A.wa || '995514888800').replace(/\\D/g, '') + '?text=' + encodeURIComponent(L.partyMsg), faq: window.PR_FAQ ? window.PR_FAQ(lang, A, D) : [],\n"+a,1)
# ── комбо ──
a="    const subtotal = lines.reduce((s, l) => s + l.raw, 0);"
assert script.count(a)==1
script=script.replace(a,"""    (this.state.combos || []).forEach((c, i) => lines.push({ name: c.name[lang], img: c.img, qty: c.qty, unit: c.picksText[lang] + ' · ' + fmt(c.price), sum: fmt(c.price * c.qty), raw: c.price * c.qty, full: c.old * c.qty, inc: () => this.comboQty(i, 1), dec: () => this.comboQty(i, -1), remove: () => this.comboQty(i, -99), removeAria: L.remove + ': ' + c.name[lang] }));
    const CBS = (window.__PR_COMBOS || []).map((c) => { const pr = c.price_tetri / 100, old = c.old_price_tetri / 100; return { name: c['name_' + lang] || c.name_ru, desc: c['desc_' + lang] || c.desc_ru || '', price: fmt(pr), old: fmt(old), hasOld: old > pr, pct: '−' + Math.round((1 - pr / old) * 100) + '%', img: window.__TH(c.photo || '/img/pizza-pep-600.webp'), age: !!c.age18, open: () => window.PR_COMBO.open(c.id, this) }; });
"""+a)
a="      tabs,\n"
assert script.count(a)==1
script=script.replace("hasSaving: saving > 0,","hasSaving: saving > 0, savingName: (this.state.combos || []).length ? (promo.pct && this.readAdmin() && this.readAdmin().promo && this.readAdmin().promo.on ? L.discounts : L.comboSave) : promo.name + ' −' + promo.pct + '%',",1)
script=script.replace(a,"      tabs, comboCards: CBS, comboHome: CBS.length > 0, comboMenu: CBS.length > 0 && tag === 'all' && !query,\n")
a="  startTrack() {"
assert script.count(a)==1
script=script.replace(a,"""  comboQty(i, d) { const cs = (this.state.combos || []).map((c) => Object.assign({}, c)); if (!cs[i]) return; cs[i].qty += d; if (cs[i].qty <= 0 || d === -99) cs.splice(i, 1); this.setState({ combos: cs }); }
  startTrack() {""")
for a,b in [("repeat: 'Повторить прошлый заказ'","combos: 'Комбо — выгоднее вместе', comboPick: 'Выбрать', comboSave: 'Выгода комбо', discounts: 'Скидки', repeat: 'Повторить прошлый заказ'"),
            ("repeat: 'Repeat your last order'","combos: 'Combos — better together', comboPick: 'Choose', comboSave: 'Combo saving', discounts: 'Discounts', repeat: 'Repeat your last order'"),
            ("repeat: 'წინა შეკვეთის გამეორება'","combos: 'კომბო — ერთად უფრო მომგებიანია', comboPick: 'არჩევა', comboSave: 'კომბოს დანაზოგი', discounts: 'ფასდაკლებები', repeat: 'წინა შეკვეთის გამეორება'")]:
    assert script.count(a)==1, a; script=script.replace(a,b)
for a,b in [("repeat: 'Повторить прошлый заказ'","devBy: 'Разработка:', devName: 'Гиорги Катамадзе', appTitle: 'Наше приложение Pizza Room', appSub: 'Заказывайте в пару касаний с iPhone и Android', repeat: 'Повторить прошлый заказ'"),
            ("repeat: 'Repeat your last order'","devBy: 'Developed by', devName: 'Giorgi Katamadze', appTitle: 'Get the Pizza Room app', appSub: 'Order in a couple of taps on iPhone and Android', repeat: 'Repeat your last order'"),
            ("repeat: 'წინა შეკვეთის გამეორება'","devBy: 'შემქმნელი:', devName: 'გიორგი ქათამაძე', appTitle: 'ჩვენი აპლიკაცია Pizza Room', appSub: 'შეუკვეთეთ რამდენიმე შეხებით iPhone-სა და Android-ზე', repeat: 'წინა შეკვეთის გამეორება'")]:
    assert script.count(a)==1, a; script=script.replace(a,b)
# fonts: fewer families for speed
helmet=re.sub(r'<link href="https://fonts.googleapis.com/css2[^"]*" rel="stylesheet">','<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&amp;family=Inter:wght@400;500;600;700;800&amp;family=Noto+Sans+Georgian:wght@400;600;800;900&amp;display=swap" rel="stylesheet">',helmet)
M={'350e4ad16609e39931ce67f75b096543':'logo-dark.png','081b705acb3320019dd6a3c45ce7a37a':'hero-square-720.webp'}
for k,v in M.items(): body=body.replace('/_blob/'+k,'/img/'+v)
left=re.findall(r'/_blob/\w+',body+script); assert not left, left
body=body.replace('width: 390px; height: 844px; position: relative;','width: 100%; max-width: 520px; margin: 0 auto; height: 100vh; height: 100dvh; position: relative;',1)

# ── Desktop: настоящий сайт на широком экране + логотип в главном блоке ──
def B(old,new,n=1):
    global body
    assert body.count(old)>=n, ('B',old[:60]); body=body.replace(old,new,n)
body=body.replace('<div style="width: 100%; max-width: 520px;','<div class="pr-root" style="width: 100%; max-width: 520px;',1); assert 'class="pr-root"' in body
B('<div style="position: absolute; left: 0; right: 0; top: 0; bottom: 72px; overflow-y: auto">','<div class="pr-scroll" style="position: absolute; left: 0; right: 0; top: 0; bottom: 72px; overflow-y: auto">')
B('<header style="position: sticky;','<header class="pr-head" style="position: sticky;')
B('<div style="display: flex; background: {{TH.pill}}; border-radius: 999px; padding: 3px">',
  '<nav class="pr-dnav" aria-label="{{L.nav}}"><sc-for list="{{tabs}}" as="tb" hint-placeholder-count="4"><button onClick="{{tb.go}}" aria-current="{{tb.current}}" style="{{tb.style}}">{{tb.label}}<sc-if value="{{tb.badge}}" hint-placeholder-val="{{false}}"><b>{{tb.badgeText}}</b></sc-if></button></sc-for></nav>\n      <div style="display: flex; background: {{TH.pill}}; border-radius: 999px; padding: 3px">')
# убрать «Здесь будет ваше фото»
import re as _re
body=_re.sub(r'\s*<span style="position: absolute; right: 12px; bottom: 12px;[^>]*>\{\{L\.photoSoon\}\}</span>','',body)
# главный блок: логотип + настоящая пицца
B('<section style="padding: 14px 16px 0">\n        <div style="position: relative; border-radius: 24px; overflow: hidden; background: #2B2622">',
  '<div class="pr-hero"><section class="pr-hero-img" style="padding: 14px 16px 0">\n        <div class="pr-hero-card" style="position: relative; border-radius: 24px; overflow: hidden; background: #2B2622">')
B('<img src="/img/hero-square-720.webp" alt="{{L.heroAlt}}" fetchpriority="high" style="display: block; width: 100%; height: 300px; object-fit: cover; object-position: 50% 60%">',
  '<img class="pr-hero-pizza" src="/img/pizza-pep-600.webp" alt="{{L.heroAlt}}" fetchpriority="high"><img class="pr-hero-logo" src="/logo-light.png" alt="Pizza Room">')
B('<section style="padding: 18px 16px 8px; display: flex; flex-direction: column; gap: 10px">','<section class="pr-hero-txt" style="padding: 18px 16px 8px; display: flex; flex-direction: column; gap: 10px">')
# закрыть обёртку героя после блока «Доставка / Самовывоз»
i=body.index('class="pr-hero-txt"'); j=body.index('<section style="padding: 10px 16px 4px">',i); k=body.index('</section>',j)+len('</section>')
body=body[:k]+'</div>'+body[k:]
body=body[:j]+'<section class="pr-hero-ways" style="padding: 10px 16px 4px">'+body[j+len('<section style="padding: 10px 16px 4px">'):]
# блок «Скачайте приложение»
IOS='https://apps.apple.com/app/id1591912533'
AND='https://play.google.com/store/search?q=Pizza%20Room%20Batumi&c=apps'
APPLE='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 .1-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3.1 1.1.1 2.2-.6 2.9-1.4z"/></svg>'
PLAY='<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#34A853" d="M3.6 1.8 13.8 12 3.6 22.2c-.4-.2-.6-.7-.6-1.2V3c0-.5.2-1 .6-1.2z"/><path fill="#FBBC04" d="m17.2 8.6-3.4 3.4 3.4 3.4 3.8-2.2c1-.6 1-1.8 0-2.4z"/><path fill="#4285F4" d="M3.6 1.8c.3-.2.8-.2 1.3.1l12.3 6.7-3.4 3.4z"/><path fill="#EA4335" d="m13.8 12 3.4 3.4-12.3 6.7c-.5.3-1 .3-1.3.1z"/></svg>'
btn='display:inline-flex;align-items:center;gap:8px;height:46px;padding:0 16px;border-radius:12px;background:#FBF5EA;color:#2A1D13;text-decoration:none;font:800 14px Inter,sans-serif'
apps=f'<section class="pr-apps" style="padding: 14px 16px 0"><div style="background:#2A1D13;color:#FBF5EA;border-radius:20px;padding:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap"><img src="/icon-192.png" alt="" width="56" height="56" style="border-radius:14px;flex-shrink:0"><div style="flex:1;min-width:170px;display:flex;flex-direction:column;gap:3px"><b style="font:900 17px Montserrat,Inter,\'Noto Sans Georgian\',sans-serif;color:#FDC134">{{{{L.appTitle}}}}</b><span style="font-size:13px;line-height:1.4;opacity:.9">{{{{L.appSub}}}}</span></div><div style="display:flex;gap:8px;flex-wrap:wrap"><a href="{IOS}" target="_blank" rel="noopener" style="{btn}">{APPLE}App Store</a><a href="{AND}" target="_blank" rel="noopener" style="{btn}">{PLAY}Google Play</a></div></div></section>'
i=body.index('class="pr-hero-ways"'); k=body.index('</section></div>',i)+len('</section></div>')
body=body[:k]+'\n      '+apps+body[k:]
# подпись разработчика внизу главной
i=body.index('<section style="padding: 18px 16px 24px">'); k=body.index('</section>',i)+len('</section>')
body=body[:k]+'\n      <footer class="pr-foot" style="padding: 6px 78px 110px; text-align: center; color: #7A6450; font-size: 12px; line-height: 1.6">© 2018–2026 Pizza Room · Batumi Mall<br>Designed &amp; developed by <b style="color: #2A1D13">GQ Group</b><br><span style="font-weight: 700; letter-spacing: .02em; color: #5C4632">Web &amp; Mobile Development Studio</span></footer>'+body[k:]
# отзывы: убрать заготовки «из API», оставить настоящий рейтинг Wolt и кнопку Google
i=body.index('{{L.reviews}}</h2>'); a=body.index('<div style="display: flex; gap: 8px; overflow-x: auto; padding: 0 16px">',i); g=body.index('<a href="https://www.google.com/maps/search/?api=1&amp;query=Pizza+Room+Batumi+Mall"',a)
body=body[:a]+'<div style="margin: 0 16px; background: #2A1D13; color: #FBF5EA; border-radius: 18px; padding: 16px; display: flex; align-items: center; gap: 14px"><span style="font: 900 40px Montserrat, Inter, sans-serif; color: #FDC134">9,8</span><span style="font-size: 14px; line-height: 1.4">{{L.f3}}</span></div>\n        '+body[g:]
# схемы карт в цветах бренда
body=body.replace('fill="#9CC3CF"','fill="#C9A26A"').replace('fill="#3E6F7D"','fill="#5C4632"')
body=body.replace('<span>{{promo.name}} −{{promo.pct}}%</span><span>−{{savingLabel}}</span>','<span>{{savingName}}</span><span>−{{savingLabel}}</span>')
# полоса комбо
CARD='<button onClick="{{cb.open}}" style="flex: 0 0 260px; border: 0; cursor: pointer; padding: 0; text-align: left; background: #2A1D13; color: #FBF5EA; border-radius: 22px; overflow: hidden; display: flex; flex-direction: column"><span style="position: relative; display: block"><img src="{{cb.img}}" alt="" loading="lazy" style="display: block; width: 100%; height: 170px; object-fit: cover"><sc-if value="{{cb.hasOld}}" hint-placeholder-val="{{true}}"><span style="position: absolute; left: 10px; top: 10px; background: #C8361F; color: #fff; font: 800 13px Inter, sans-serif; padding: 5px 10px; border-radius: 999px">{{cb.pct}}</span></sc-if><sc-if value="{{cb.age}}" hint-placeholder-val="{{false}}"><span style="position: absolute; right: 10px; top: 10px; background: #FBF5EA; color: #2A1D13; font: 800 12px Inter, sans-serif; padding: 5px 9px; border-radius: 999px">18+</span></sc-if></span><span style="padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px"><b style="font: 900 18px Montserrat, Inter, \'Noto Sans Georgian\', sans-serif; color: #FDC134">{{cb.name}}</b><span style="font-size: 13px; line-height: 1.35; opacity: .9; min-height: 35px">{{cb.desc}}</span><span style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px"><span style="display: flex; align-items: baseline; gap: 8px"><b style="font: 900 20px Montserrat, Inter, sans-serif">{{cb.price}}</b><sc-if value="{{cb.hasOld}}" hint-placeholder-val="{{true}}"><s style="opacity: .6; font-size: 14px">{{cb.old}}</s></sc-if></span><span style="background: #FDC134; color: #2A1D13; border-radius: 12px; padding: 8px 12px; font: 800 13px Inter, \'Noto Sans Georgian\', sans-serif">{{L.comboPick}}</span></span></span></button>'
def strip(flag,cls):
    return f'<sc-if value="{{{{{flag}}}}}" hint-placeholder-val="{{{{false}}}}"><section class="{cls}" style="padding: 16px 0 6px"><h2 style="margin: 0 16px 10px; font-family: Montserrat, Inter, \'Noto Sans Georgian\', sans-serif; font-weight: 900; font-size: 22px">{{{{L.combos}}}}</h2><div class="pr-cstrip" style="display: flex; gap: 12px; overflow-x: auto; padding: 0 16px 8px; scroll-snap-type: x mandatory"><sc-for list="{{{{comboCards}}}}" as="cb" hint-placeholder-count="3">{CARD}</sc-for></div></section></sc-if>'
i=body.index('<section class="pr-apps"'); k=body.index('</section>',i)+len('</section>')
body=body[:k]+'\n      '+strip('comboHome','pr-combos')+body[k:]
g=body.index('<section style="padding: 10px 16px 20px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px">')
body=body[:g]+strip('comboMenu','pr-combos')+'\n      '+body[g:]
# блок «Пицца на компанию» после комбо на главной и «Частые вопросы» перед подвалом
PARTY='<section class="pr-party" style="padding: 12px 16px 4px"><div style="background: #FDC134; color: #2A1D13; border-radius: 22px; padding: 18px; display: flex; flex-direction: column; gap: 10px"><span style="align-self: flex-start; background: #2A1D13; color: #FDC134; border-radius: 999px; padding: 5px 11px; font: 800 12px Inter, \'Noto Sans Georgian\', sans-serif">{{L.partyBadge}}</span><b style="font: 900 24px Montserrat, Inter, \'Noto Sans Georgian\', sans-serif">{{L.partyTitle}}</b><span style="font-size: 15px; line-height: 1.45">{{L.partyText}}</span><a href="{{partyLink}}" target="_blank" rel="noopener" style="align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; height: 50px; padding: 0 20px; border-radius: 14px; background: #2A1D13; color: #FBF5EA; text-decoration: none; font: 800 15px Inter, \'Noto Sans Georgian\', sans-serif">{{L.partyBtn}} →</a></div></section>'
i=body.index('<sc-if value="{{comboHome}}"'); k=body.index('</sc-if>',body.index('</section>',i))+len('</sc-if>')
body=body[:k]+'\n      '+PARTY+body[k:]
FAQ='<section class="pr-faq" style="padding: 8px 16px 8px"><h2 style="margin: 0 0 10px; font-family: Montserrat, Inter, \'Noto Sans Georgian\', sans-serif; font-weight: 900; font-size: 22px">{{L.faqTitle}}</h2><div style="display: flex; flex-direction: column; gap: 8px"><sc-for list="{{faq}}" as="fq" hint-placeholder-count="4"><details style="background: #FBF5EA; border-radius: 16px; padding: 14px 16px"><summary style="cursor: pointer; font-weight: 800; list-style: none">{{fq.q}}</summary><p style="margin: 8px 0 0; color: #5C4632; line-height: 1.5; font-size: 14px">{{fq.a}}</p></details></sc-for></div></section>'
f=body.index('<footer class="pr-foot"')
body=body[:f]+FAQ+'\n      '+body[f:]
# сетка меню
B('<section style="padding: 10px 16px 20px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px">','<section class="pr-grid" style="padding: 10px 16px 20px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px">')
B('<nav aria-label="{{L.nav}}" style="position: absolute; left: 0; right: 0; bottom: 0; height: 72px;','<nav class="pr-tabs" aria-label="{{L.nav}}" style="position: absolute; left: 0; right: 0; bottom: 0; height: 72px;')
B('<img src="{{item.big}}" alt="{{item.alt}}" style="display: block; width: 390px; height: 390px; object-fit: cover">','<img src="{{item.big}}" alt="{{item.alt}}" style="display: block; width: 100%; aspect-ratio: 1; max-height: 60vh; object-fit: cover">')

# ── Время работы и корзина: «Открыто/Закрыто» по часам, кнопка «Очистить», корзина старше 12 ч очищается ──
script=R(script,"openLabel: L.open + ' · ' + (A.open || '11:00') + '–' + (A.close || '23:00'),",
  "openLabel: isOpen ? L.open + ' · ' + (A.open || '11:00') + '–' + (A.close || '23:00') : LX.closedAt + ' ' + (A.open || '11:00') + '–' + (A.close || '23:00'), closedText: LX.closedLong.replace('%', (A.open || '11:00') + '–' + (A.close || '23:00')), openPill: isOpen ? 'color: #22562E; background: #DDE7D2;' : 'color: #8A2414; background: #FCE3DE;', openDot: isOpen ? 'background: #2F6B3A;' : 'background: #C0392B;', cartHas: count > 0, clearCart: () => { if (window.confirm(LX.clearQ)) this.setState({ qty: {}, combos: [], screen: 'home' }); }, LX,",'openLabel')
script=R(script,"    const blocked = !isOpen || offline;",
  "    const blocked = !isOpen || offline;\n    const LX = { ru: { closedAt: 'Сейчас закрыто · работаем ежедневно', closedLong: 'Сейчас закрыто. Работаем ежедневно %. Корзину можно собрать заранее — заказ отправите, когда откроемся.', closedShort: 'закрыто до', clear: 'Очистить корзину', clearQ: 'Очистить корзину?' }, en: { closedAt: 'Closed now · open daily', closedLong: 'Closed right now. We are open daily %. You can fill your cart in advance and send the order once we open.', closedShort: 'closed till', clear: 'Clear cart', clearQ: 'Clear the cart?' }, ka: { closedAt: 'ახლა დაკეტილია · ვმუშაობთ ყოველდღე', closedLong: 'ახლა დაკეტილი ვართ. ვმუშაობთ ყოველდღე %. კალათის შევსება შეგიძლიათ წინასწარ — შეკვეთას გაგზავნით, როცა გავიხსნებით.', closedShort: 'დაკეტილია', clear: 'კალათის გასუფთავება', clearQ: 'გავასუფთაოთ კალათა?' } }[lang] || {};",'LX')
script=R(script,"if (this.state.item) showBar = false;",
  "if (showBar && !isOpen && scr !== 'checkout') { barLeft += ' · ' + LX.closedShort + ' ' + (A.open || '11:00'); barStyle = 'background: #DCC7A5; color: #5C4632;'; barPill = 'background: transparent; color: #5C4632;'; }\n    if (this.state.item) showBar = false;",'barClosed')
script=R(script,"if (raw) { const d = JSON.parse(raw); if (d && d.qty) this.setState({",
  "if (raw) { const d = JSON.parse(raw); if (d && d.t && Date.now() - d.t > 12 * 3600e3) d.qty = {}; if (d && d.qty) this.setState({",'cartTtl')
script=R(script,"JSON.stringify({ qty: this.state.qty, mode: this.state.mode, lang: this.state.lang })","JSON.stringify({ qty: this.state.qty, mode: this.state.mode, lang: this.state.lang, t: Date.now() })",'cartSaveT')
B('<span style="align-self: flex-start; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #22562E; background: #DDE7D2; padding: 6px 10px; border-radius: 999px"><span style="width: 7px; height: 7px; border-radius: 999px; background: #2F6B3A"></span>{{openLabel}}</span>',
  '<span style="align-self: flex-start; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; {{openPill}} padding: 6px 10px; border-radius: 999px"><span style="width: 7px; height: 7px; border-radius: 999px; {{openDot}}"></span>{{openLabel}}</span>')
B('<div role="status" style="margin: 12px 16px 0; background: #2A1D13; color: #FBF5EA; border-radius: 14px; padding: 12px 14px; font-size: 14px; line-height: 1.4">{{L.closed}}</div>','<div role="status" style="margin: 12px 16px 0; background: #2A1D13; color: #FBF5EA; border-radius: 14px; padding: 12px 14px; font-size: 14px; line-height: 1.4">{{closedText}}</div>')
B('<div style="position: absolute; left: 12px; right: 76px; bottom: 82px; z-index: 20">','<div class="pr-bar" style="position: absolute; left: 12px; right: 76px; bottom: 82px; z-index: 20">')
i=body.index('<sc-if value="{{cartEmpty}}"'); j=body.index('</sc-if>',i)+len('</sc-if>')
body=body[:j]+'\n        <sc-if value="{{cartHas}}" hint-placeholder-val="{{false}}"><button onClick="{{clearCart}}" style="align-self: flex-end; border: 0; background: transparent; color: #8A2414; font: 700 13px Inter, sans-serif; cursor: pointer; padding: 4px 2px; text-decoration: underline; text-underline-offset: 3px">✕ {{LX.clear}}</button></sc-if>'+body[j:]

# ── временно нет в наличии (стоп-лист из админки / нет у поставщика) ──
for a,b in [("stopNote: 'Сегодня этой пиццы нет — выберите другую.'","stopNote: 'Временно недоступно — ждём поставку. Скоро вернём в меню, а пока выберите что-нибудь другое 🙏'"),
            ("stopNote: 'This pizza is sold out today — please choose another.'","stopNote: 'Temporarily unavailable — we are waiting for a delivery. It will be back soon; for now please choose something else 🙏'"),
            ("stopNote: 'ეს პიცა დღეს ამოიწურა — აირჩიეთ სხვა.'","stopNote: 'დროებით მიუწვდომელია — ველოდებით მიწოდებას. მალე დავაბრუნებთ მენიუში, ჯერჯერობით აირჩიეთ სხვა რამ 🙏'"),
            ("stop: 'Нет в наличии'","stop: 'Временно нет'"),("stop: 'Sold out'","stop: 'Temporarily unavailable'"),("stop: 'ამოიწურა'","stop: 'დროებით არ არის'")]:
    script=R(script,a,b,'stop-'+a[:12])

# ── время доставки в заголовке и цифрах — из настроек админки ──
script=R(script,"const L = T[lang];","window.__PR_LANG = lang; const L = (() => { const L0 = Object.assign({}, T[lang]); const DD = (window.__PR_ADMIN && window.__PR_ADMIN.delivery) || {}; const tt = (DD.tmin || 35) + '\u2013' + (DD.tmax || 40); ['heroTitle', 'n4'].forEach((k) => { if (L0[k]) L0[k] = String(L0[k]).split('35\u201340').join(tt); }); if (window.__PR_DP) { const X = window.__PR_DPT[lang] || window.__PR_DPT.ru; L0.heroTitle = X.hero; L0.delivSub = X.sub; L0.n4 = '\u23F8'; L0.f4 = X.f4; } return L0; })();",'L-delivery')

# ── доставка на паузе (нет курьеров / непогода / много заказов) ──
DPT = """window.__PR_DPT = {
  ru: { title: 'Доставка временно на паузе', hero: 'Итальянская пицца в Батуми — заберите горячей в Batumi Mall', sub: 'временно недоступна', f4: 'доставка на паузе — самовывоз работает', toast: 'Доставка сейчас на паузе — доступен самовывоз',
    couriers: 'Сейчас все курьеры заняты — не хотим, чтобы пицца ехала к вам холодной.', weather: 'Из-за непогоды бережём наших курьеров.', busy: 'У нас сейчас очень много заказов — на время принимаем только самовывоз.', other: 'Доставка временно недоступна.',
    pick: 'Самовывоз из Batumi Mall работает: оформите заказ — он будет горячим к вашему приходу 🍕', until: 'Вернём доставку примерно в ' },
  en: { title: 'Delivery is paused for now', hero: 'Italian pizza in Batumi — pick it up hot at Batumi Mall', sub: 'temporarily unavailable', f4: 'delivery paused — pickup is open', toast: 'Delivery is paused right now — pickup is available',
    couriers: 'All our couriers are busy right now — we don’t want your pizza to arrive cold.', weather: 'Bad weather today — we’re keeping our couriers safe.', busy: 'We’re very busy right now — taking pickup orders only for a while.', other: 'Delivery is temporarily unavailable.',
    pick: 'Pickup at Batumi Mall is open: order now and it will be hot when you arrive 🍕', until: 'Delivery is back at about ' },
  ka: { title: 'მიტანა დროებით შეჩერებულია', hero: 'იტალიური პიცა ბათუმში — წაიღეთ ცხელი Batumi Mall-იდან', sub: 'დროებით მიუწვდომელია', f4: 'მიტანა შეჩერებულია — გატანა მუშაობს', toast: 'მიტანა ახლა შეჩერებულია — ხელმისაწვდომია გატანა',
    couriers: 'ახლა ყველა კურიერი დაკავებულია — არ გვინდა, პიცა ცივი მოგივიდეთ.', weather: 'ცუდი ამინდის გამო ვუფრთხილდებით ჩვენს კურიერებს.', busy: 'ახლა ძალიან ბევრი შეკვეთა გვაქვს — დროებით მხოლოდ გატანას ვიღებთ.', other: 'მიტანა დროებით მიუწვდომელია.',
    pick: 'გატანა Batumi Mall-იდან მუშაობს: შეუკვეთეთ და თქვენს მოსვლამდე ცხელი დაგხვდებათ 🍕', until: 'მიტანას დავაბრუნებთ დაახლოებით ' } };
"""
script = DPT + script
script=R(script,"const isDelivery = this.state.mode === 'delivery';","const DP = window.__PR_DP || null; const DPX = DP ? (window.__PR_DPT[lang] || window.__PR_DPT.ru) : null; const isDelivery = this.state.mode === 'delivery' && !DP;",'dp-isdel')
script=R(script,"setDelivery: () => this.setState({ mode: 'delivery' }),","setDelivery: () => { if (DP) { this.flash(DPX.toast); return; } this.setState({ mode: 'delivery' }); },",'dp-setdel')
script=R(script,"delivCard: isDelivery ? cardOn : cardOff,","delivCard: isDelivery ? cardOn : (DP ? cardOff + ' opacity: 0.45;' : cardOff),",'dp-card')
script=R(script,"delivStyle: isDelivery ? on : off,","delivStyle: isDelivery ? on : (DP ? off + ' opacity: 0.4; text-decoration: line-through;' : off),",'dp-style')
script=R(script,"mode: this.state.mode, zone: zone.id,","mode: isDelivery ? 'delivery' : 'pickup', zone: zone.id,",'dp-order')
script=R(script,"toast: !!this.state.toast, toastText: this.state.toast","toast: !!this.state.toast, toastText: this.state.toast, dpOn: !!DP, dpTitle: DPX ? DPX.title : '', dpText: DPX ? (DP.reason === 'other' && DP.note ? DP.note : DPX[DP.reason] || DPX.other) : '', dpPick: DPX ? DPX.pick : '', dpHasUntil: !!(DP && DP.until_local), dpUntil: DPX && DP.until_local ? DPX.until + DP.until_local : ''",'dp-vals')
DPBOX = '<sc-if value="{{dpOn}}" hint-placeholder-val="{{false}}"><div class="pr-dp" role="status" style="background: #2A1D13; color: #FBF5EA; border-radius: 18px; padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start; border: 2px solid #FDC134"><span style="font-size: 26px; line-height: 1">🛵</span><div style="display: flex; flex-direction: column; gap: 4px"><b style="font: 800 16px Inter, \'Noto Sans Georgian\', sans-serif; color: #FDC134">{{dpTitle}}</b><span style="font-size: 14px; line-height: 1.4">{{dpText}}</span><span style="font-size: 14px; line-height: 1.4; font-weight: 700">{{dpPick}}</span><sc-if value="{{dpHasUntil}}" hint-placeholder-val="{{false}}"><span style="font-size: 13px; opacity: 0.8">⏱ {{dpUntil}}</span></sc-if></div></div></sc-if>'
B('<h1 style="margin: 0; font-family: {{TH.hf}}', DPBOX + '\n        <h1 style="margin: 0; font-family: {{TH.hf}}')
_mg='<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; background: #DCC7A5; border-radius: 16px; padding: 4px">'
assert body.count(_mg)>=1, 'mode grid'
body=body.replace(_mg, DPBOX + _mg)
# ── кнопка «назад» телефона/браузера: возвращает на предыдущий экран сайта, а не выкидывает с сайта ──
HIST = ("if (!this._hb) { this._hb = 1; this._hk = this.state.screen + '|'; try { history.replaceState({ s: this.state.screen, it: null }, ''); } catch (e) {} "
  "window.addEventListener('popstate', (e) => { const st = e.state || { s: 'home' }; let s = st.s || 'home'; "
  "const n = Object.values(this.state.qty || {}).reduce((a, b) => a + b, 0) + (this.state.combos || []).length; "
  "if ((s === 'cart' || s === 'checkout') && !n) s = 'home'; if (s === 'status' && !this.state.token) s = 'home'; "
  "this._hk = s + '|' + (st.it || ''); this.setState({ screen: s, item: st.it || null }); }); } "
  "{ const hk = this.state.screen + '|' + (this.state.item || ''); if (hk !== this._hk) { this._hk = hk; "
  "try { history[this.state.screen === 'status' ? 'replaceState' : 'pushState']({ s: this.state.screen, it: this.state.item || null }, ''); } catch (e) {} } }\n    ")
script=R(script,"const go = (s) => this.setState({ screen: s, item: null });", HIST + "const go = (s) => this.setState({ screen: s, item: null });", 'hist')
# ── «Сначала еда»: сайт открывается сразу на меню (комбо → пиццы → напитки), старая главная = «О нас» ──
import os
if os.environ.get('PR_MENU_FIRST', '1') == '1':
    script=R(script,"this.state = { lang: null, screen: 'home',","this.state = { lang: null, screen: 'menu',",'mf-start')
    script=R(script,"const tabDefs = [['home', L.tabHome], ['menu', L.tabMenu], ['cart', L.tabCart], ['map', L.tabMap]];","const tabDefs = [['menu', L.tabMenu], ['cart', L.tabCart], ['my', ({ ru: 'Мои заказы', en: 'My orders', ka: 'ჩემი შეკვეთები' })[lang] || 'My orders'], ['map', L.tabMap], ['home', ({ ru: 'О нас', en: 'About', ka: 'ჩვენ შესახებ' })[lang] || L.tabHome]];",'mf-tabs')
    script=R(script,"showLogo: scr === 'home', showTitle: scr !== 'home',","showLogo: scr === 'home' || scr === 'menu', showTitle: scr !== 'home' && scr !== 'menu',",'mf-logo')
    script=R(script,"openPromo: () => this.setState({ popupSeen: false, screen: 'home' }),","openPromo: () => this.setState({ popupSeen: false, screen: 'menu' }),",'mf-promo')
    script=R(script,"const popupOpen = promoOn && !!P.popup && !this.state.popupSeen && scr === 'home';","const popupOpen = promoOn && !!P.popup && !this.state.popupSeen && (scr === 'home' || scr === 'menu');",'mf-popup')
    script=script.replace("if ((s === 'cart' || s === 'checkout') && !n) s = 'home'; if (s === 'status' && !this.state.token) s = 'home';","if ((s === 'cart' || s === 'checkout') && !n) s = 'menu'; if (s === 'status' && !this.state.token) s = 'menu';")
    script=script.replace("const st = e.state || { s: 'home' }; let s = st.s || 'home';","const st = e.state || { s: 'menu' }; let s = st.s || 'menu';")
    script=script.replace("if (window.confirm(LX.clearQ)) this.setState({ qty: {}, combos: [], screen: 'home' });","if (window.confirm(LX.clearQ)) this.setState({ qty: {}, combos: [], screen: 'menu' });")
    # компактная строка над поиском: открыто ли сейчас + самовывоз/доставка
    MINFO=('<div class="pr-minfo" style="margin: 10px 16px 0; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 13px; font-weight: 700">'
      '<span style="display: inline-flex; align-items: center; gap: 6px; color: #22562E; background: #DDE7D2; padding: 6px 10px; border-radius: 999px"><span style="width: 7px; height: 7px; border-radius: 999px; background: #2F6B3A"></span>{{openLabel}}</span>'
      '<span style="background: #FBF5EA; padding: 6px 10px; border-radius: 999px">📍 Batumi Mall</span>'
      '<sc-if value="{{dpOn}}" hint-placeholder-val="{{false}}"><span style="background: #2A1D13; color: #FDC134; padding: 6px 10px; border-radius: 999px">🛵 {{dpTitle}}</span></sc-if></div>')
    _m='<sc-if value="{{isMenu}}" hint-placeholder-val="{{false}}">\n      <section style="position: sticky; top: 55px;'
    assert body.count(_m)==1, 'menu section'
    body=body.replace(_m,'<sc-if value="{{isMenu}}" hint-placeholder-val="{{false}}">\n      '+MINFO+'\n      <section class="pr-msticky" style="position: sticky; top: 55px;',1)
# ── «Мой заказ», запоминание клиента, кнопка «Назад», без поиска, разделы меню с новой строки ──
script=R(script,"const go = (s) => this.setState({ screen: s, item: null });",
  "const go = (s) => this.setState({ screen: s, item: null }); window.__PR_GO = go; window.__PR_TRACK = (tk) => { this.setState({ token: tk.token, orderNo: '№ ' + tk.id, lastMode: tk.mode, live: null, status: 0, screen: 'status', item: null }); this.startTrack(); };",'myorder-hooks')
script=R(script,"f: { name: '', phone: '', addr: '', com: '' },",
  "f: (() => { try { const m = JSON.parse(localStorage.getItem('pr_me') || 'null'); if (m) return { name: m.name || '', phone: m.phone || '', addr: m.addr || '', com: '' }; } catch (e) {} return { name: '', phone: '', addr: '', com: '' }; })(),",'remember-me')
script=R(script,"localStorage.setItem('pr_last', JSON.stringify(qty)); } catch (e) {}",
  "localStorage.setItem('pr_last', JSON.stringify(qty)); localStorage.setItem('pr_me', JSON.stringify({ name: f.name, phone: f.phone, addr: f.addr })); } catch (e) {}",'save-me')
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', goBack: () => go(scr === 'checkout' ? 'cart' : 'menu'), findLabel: ({ ru: '📦 Мой заказ', en: '📦 My order', ka: '📦 ჩემი შეკვეთა' })[lang] || '📦', openFind: () => { if (window.__PR_FIND) window.__PR_FIND(); },",'goback')
B('<sc-if value="{{showTitle}}" hint-placeholder-val="{{false}}">\n        <span style="font-family: {{TH.hf}}',
  '<sc-if value="{{showTitle}}" hint-placeholder-val="{{false}}">\n        <button onClick="{{goBack}}" aria-label="{{L.back}}" class="pr-back" style="border: 0; cursor: pointer; width: 42px; height: 42px; border-radius: 999px; background: #FBF5EA; color: #2A1D13; font: 900 20px Inter, sans-serif; flex-shrink: 0">←</button>\n        <span style="font-family: {{TH.hf}}')
# поиск по ингредиентам — убрать
_q=re.search(r'<label for="q".*?</label>', body, flags=re.S); assert _q, 'search'
body=body.replace(_q.group(0),'',1)
# «Все»: каждый раздел (пиццы, напитки, пиво…) начинается с новой строки и с заголовком
script=R(script,"const menu = MENU.filter((m) => (tag === 'all' || m.tags.indexOf(tag) >= 0) && (!query || (m.n.ka.join(' ') + ' ' + m.n.en.join(' ') + ' ' + m.n.ru.join(' ')).toLowerCase().indexOf(query) >= 0)).map(decorate);",
  "const COMBO_L = ({ ru: 'Комбо', en: 'Combos', ka: 'კომბო' })[lang] || 'Combo'; const PARTY_L = ({ ru: 'Для компании', en: 'For a party', ka: 'კომპანიისთვის' })[lang] || 'Party'; const CATS0 = (window.__PR_CATS || []).filter((c) => !c.soon).map((c) => c.id); const ORD = ['pizza'].concat(CATS0.filter((x) => x !== 'pizza')); const base = MENU.filter((m) => (tag === 'all' || m.tags.indexOf(tag) >= 0) && (!query || (m.n.ka.join(' ') + ' ' + m.n.en.join(' ') + ' ' + m.n.ru.join(' ')).toLowerCase().indexOf(query) >= 0)); const menu = []; ORD.forEach((c0) => base.filter((m) => m.tags[0] === c0).forEach((m) => menu.push(Object.assign(decorate(m), { c0 })))); base.filter((m) => ORD.indexOf(m.tags[0]) < 0).forEach((m) => menu.push(Object.assign(decorate(m), { c0: m.tags[0] }))); const catLabel = (c0) => { if (c0 === '__combo') return COMBO_L; if (c0 === '__party') return PARTY_L; const CC = (window.__PR_CATS || []).find((c) => c.id === c0); return CC ? (CC['name_' + lang] || CC.name_ru || c0) : c0; };",'cat-heads')
# вкладка «Мои заказы»: открывает текущий заказ или форму поиска (телефон + имя / номер)
script=R(script,"const activeTab = scr === 'checkout' ? 'cart' : scr;","const activeTab = scr === 'checkout' ? 'cart' : scr === 'status' ? 'my' : scr; let myTk = null; try { myTk = JSON.parse(localStorage.getItem('pr_track') || 'null'); } catch (e) {}",'my-active')
script=R(script,"isMap: k === 'map', current: k === activeTab ? 'page' : 'false',","isMap: k === 'map', isMy: k === 'my', current: k === activeTab ? 'page' : 'false',",'my-flag')
script=R(script,"badge: k === 'cart' && count > 0, badgeText: String(count), go: () => go(k) }));",
  "badge: (k === 'cart' && count > 0) || (k === 'my' && !!(myTk && myTk.token)), badgeText: k === 'my' ? '1' : String(count), go: k === 'my' ? () => { if (window.__PR_FIND) window.__PR_FIND(); } : () => go(k) }));",'my-go')
B('<sc-if value="{{tb.isMap}}" hint-placeholder-val="{{false}}">',
  '<sc-if value="{{tb.isMy}}" hint-placeholder-val="{{false}}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"></path><path d="M3 8l9 5 9-5"></path><path d="M12 13v8"></path></svg></sc-if>\n        <sc-if value="{{tb.isMap}}" hint-placeholder-val="{{false}}">')
body=body.replace('display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); z-index: 25','display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); z-index: 25',1)
# комбо — отдельный раздел меню: сразу после пицц, потом напитки и т.д., «скоро» (суши) — в самом конце
script=R(script,"tags: [['all', L.tagAll]].concat((window.__PR_CATS || []).map((c) => [c.id, (c['name_' + lang] || c.name_ru) + (c.soon ? ' · ' + L.soonBadge : '') + (c.age18 ? ' · 18+' : '')]))",
  "tags: (() => { const CS = (window.__PR_CATS || []); const lab = (c) => [c.id, (c['name_' + lang] || c.name_ru) + (c.soon ? ' · ' + L.soonBadge : '') + (c.age18 ? ' · 18+' : '')]; return [['all', L.tagAll]].concat(CS.filter((c) => c.id === 'pizza').map(lab), (window.__PR_COMBOS || []).some((c) => c.grp !== 'party') ? [['__combo', COMBO_L]] : [], (window.__PR_COMBOS || []).some((c) => c.grp === 'party') ? [['__party', PARTY_L]] : [], CS.filter((c) => c.id !== 'pizza' && !c.soon).map(lab), CS.filter((c) => c.soon).map(lab)); })()",'chips-order')
script=R(script,"img: window.__TH(c.photo || '/img/pizza-pep-600.webp'), age: !!c.age18, open: () => window.PR_COMBO.open(c.id, this) }; });","img: window.__TH(c.photo || '/img/pizza-pep-600.webp'), age: !!c.age18, grp: c.grp || 'combo', open: () => window.PR_COMBO.open(c.id, this) }; });",'cbs-grp')
_cbs=script.index('const CBS = (window.__PR_COMBOS || []).map('); _end=script.index('\n',_cbs)
script=script[:_end]+"\n    { let at = 0; menu.forEach((d, i) => { if (d.c0 === 'pizza') at = i + 1; }); const mk = (cb, c0) => ({ isCombo: true, cb, c0, fade: 'display: none;', img: cb.img, name: cb.name }); const A1 = (tag === 'all' || tag === '__combo') && !query ? CBS.filter((c) => c.grp !== 'party').map((c) => mk(c, '__combo')) : []; const A2 = (tag === 'all' || tag === '__party') && !query ? CBS.filter((c) => c.grp === 'party').map((c) => mk(c, '__party')) : []; menu.splice(at, 0, ...A1, ...A2); }\n    menu.forEach((d, i) => { d.head = tag === 'all' && (i === 0 || menu[i - 1].c0 !== d.c0); d.headLabel = catLabel(d.c0); });"+script[_end:]
script=R(script,"comboMenu: CBS.length > 0 && tag === 'all' && !query,","comboMenu: false,",'combo-strip-off')
GCARD=CARD.replace('{{cb.','{{it.cb.').replace('style="flex: 0 0 260px;','class="pr-gcombo" style="')
B('<sc-for list="{{menu}}" as="it" hint-placeholder-count="6">\n          <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; {{it.fade}}">',
  '<sc-for list="{{menu}}" as="it" hint-placeholder-count="6">\n          <sc-if value="{{it.head}}" hint-placeholder-val="{{false}}"><h2 class="pr-cath" style="grid-column: 1 / -1; margin: 14px 0 0; font-family: Montserrat, Inter, \'Noto Sans Georgian\', sans-serif; font-weight: 900; font-size: 24px">{{it.headLabel}}</h2></sc-if>\n'+'<sc-if value="{{it.isCombo}}" hint-placeholder-val="{{false}}">'+GCARD+'</sc-if>\n          <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; {{it.fade}}">')
# ── «О нас»: красивая история вместо старого большого баннера ──
script = open('story.js', encoding='utf-8').read() + '\n' + script
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', story: (window.__PR_STORY || {})[lang] || (window.__PR_STORY || {}).ru,",'story')
STORY=('<section class="pr-story"><div class="pr-st-hero"><span class="pr-st-k">{{story.kicker}}</span><h1>{{story.title}}</h1><p>{{story.lead}}</p>'
  '<div class="pr-st-nums"><sc-for list="{{story.nums}}" as="nm" hint-placeholder-count="4"><div><b>{{nm.n}}</b><span>{{nm.t}}</span></div></sc-for></div></div>'
  '<h2>{{story.tlTitle}}</h2><div class="pr-st-tl"><sc-for list="{{story.tl}}" as="ev" hint-placeholder-count="4"><div class="pr-st-ev"><b>{{ev.y}}</b><strong>{{ev.t}}</strong><span>{{ev.d}}</span></div></sc-for></div>'
  '<h2>{{story.valTitle}}</h2><div class="pr-st-vals"><sc-for list="{{story.vals}}" as="v" hint-placeholder-count="4"><div class="pr-st-v"><i>{{v.i}}</i><strong>{{v.t}}</strong><span>{{v.d}}</span></div></sc-for></div>'
  '<button onClick="{{goMenu}}" class="pr-st-cta">{{story.cta}}</button></section>')
_h='<sc-if value="{{isHome}}" hint-placeholder-val="{{true}}">'
assert body.count(_h)==1, 'home'
body=body.replace(_h,_h+'\n      '+STORY,1)
# старые блоки главной на странице «О нас» не нужны: баннер, способы получения, комбо, «популярное», старый «о нас»
for _k in ['{{L.popular}}','{{L.aboutKicker}}']:
    _i=body.index(_k); _s=body.rfind('<section',0,_i); body=body[:_s]+'<section class="pr-hide"'+body[_s+len('<section'):]
script=R(script,"soonHome: !!firstSoon,","soonHome: false,",'story-nosoon')
script=R(script,"comboHome: CBS.length > 0,","comboHome: false,",'story-nocombo')
# номер пиццерии в шапке: нажали — сразу звонок
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', phoneLabel: (() => { const d = String(A.phone || '+995514888800').replace(/\\D/g, '').replace(/^995/, ''); return d.length === 9 ? d.slice(0, 3) + ' ' + d.slice(3, 5) + ' ' + d.slice(5, 7) + ' ' + d.slice(7) : d; })(),",'hdr-phone')
_lg='<img src="/img/logo-dark.png" alt="Pizza Room" style="display: block; height: 46px; width: auto">\n      </sc-if>'
assert body.count(_lg)==1, 'logo'
body=body.replace(_lg,_lg+'\n      <a class="pr-hcall" href="{{telHref}}" aria-label="Call"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"></path></svg><span>{{phoneLabel}}</span></a>',1)
# карточка товара: компактное окно по центру, крестик, закрытие по клику мимо и Esc; «Итальянские ингредиенты» — только у пиццы
script=R(script,"closeItem: () => this.setState({ item: null }),","closeItem: () => this.setState({ item: null }), closeItemBg: (ev) => { if (!ev || ev.target === ev.currentTarget) this.setState({ item: null }); }, itemPizza: !!(im && im.tags && im.tags[0] === 'pizza'),",'item-close')
B('<div role="dialog" aria-label="{{item.name}}" style="position: absolute; inset: 0; background: {{TH.bg}}; z-index: 40; display: flex; flex-direction: column">',
  '<div class="pr-itemov" onClick="{{closeItemBg}}"><div class="pr-itemcard" role="dialog" aria-label="{{item.name}}" style="background: {{TH.bg}}; display: flex; flex-direction: column">')
_e='\n  </sc-if>\n\n  <sc-if value="{{popupOpen}}"'
assert body.count(_e)==1, 'item end'
body=body.replace(_e,'</div>'+_e,1)
B('<img src="{{item.big}}" alt="{{item.alt}}" style="display: block; width: 100%; aspect-ratio: 1; max-height: 60vh; object-fit: cover">',
  '<img class="pr-itemimg" src="{{item.big}}" alt="{{item.alt}}" style="display: block; width: 100%; object-fit: cover">')
B('<button onClick="{{closeItem}}" aria-label="{{L.back}}" style="position: absolute; left: 14px; top: 14px; width: 44px; height: 44px;',
  '<button class="pr-itemx" onClick="{{closeItem}}" aria-label="{{L.close}}" style="position: absolute; left: 14px; top: 14px; width: 44px; height: 44px;')
B('<path d="M15 18l-6-6 6-6"></path></svg>\n          </button>\n          <sc-if value="{{item.hasDisc}}"',
  '<path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>\n          </button>\n          <sc-if value="{{item.hasDisc}}"')
B('<span style="height: 34px; padding: 0 12px; border-radius: 999px; background: #FBF5EA; display: flex; align-items: center; font-size: 13px; font-weight: 700">{{L.italian}}</span>',
  '<sc-if value="{{itemPizza}}" hint-placeholder-val="{{true}}"><span style="height: 34px; padding: 0 12px; border-radius: 999px; background: #FBF5EA; display: flex; align-items: center; font-size: 13px; font-weight: 700">{{L.italian}}</span></sc-if>')
# «Мои заказы» — отдельная страница (не окно поверх карты): текущий заказ, заказы с этого телефона, поиск
MYT = "({ ru: { t: 'Мои заказы', p: 'Не видите заказ? Введите телефон и имя, на которые заказывали. Номер заказа — если помните.', ph: 'Телефон', nm: 'Имя, на которое заказывали', id: 'Номер заказа (если помните)', go: 'Найти заказ', recent: 'Заказы с этого телефона', none: 'На этом телефоне заказов пока нет.', err: 'Не получилось — проверьте интернет' }, en: { t: 'My orders', p: 'Can’t see your order? Enter the phone and name you used. Order number — if you remember it.', ph: 'Phone', nm: 'Name on the order', id: 'Order number (optional)', go: 'Find order', recent: 'Orders from this device', none: 'No orders on this device yet.', err: 'Something went wrong — check your connection' }, ka: { t: 'ჩემი შეკვეთები', p: 'ვერ ხედავთ შეკვეთას? შეიყვანეთ ტელეფონი და სახელი, რომლითაც შეუკვეთეთ. ნომერი — თუ გახსოვთ.', ph: 'ტელეფონი', nm: 'სახელი შეკვეთაზე', id: 'შეკვეთის ნომერი (თუ გახსოვთ)', go: 'შეკვეთის მოძებნა', recent: 'შეკვეთები ამ ტელეფონიდან', none: 'ამ ტელეფონზე შეკვეთები ჯერ არ არის.', err: 'ვერ მოხერხდა — შეამოწმეთ ინტერნეტი' } })"
script=R(script,"const titles = { menu: L.tabMenu, cart: L.cart, checkout: L.checkout, status: L.orderNo, map: L.tabMap };",
  "const MY = " + MYT + "[lang] || " + MYT + ".ru; const titles = { menu: L.tabMenu, cart: L.cart, checkout: L.checkout, status: L.orderNo, map: L.tabMap, my: MY.t };",'my-titles')
script=R(script,"window.__PR_GO = go;","window.__PR_GO = go; window.__PR_FIND = () => { let tk = null; try { tk = JSON.parse(localStorage.getItem('pr_track') || 'null'); } catch (e) {} if (tk && tk.token) window.__PR_TRACK(tk); else go('my'); };",'my-find')
script=R(script,"localStorage.setItem('pr_me', JSON.stringify({ name: f.name, phone: f.phone, addr: f.addr }));",
  "localStorage.setItem('pr_me', JSON.stringify({ name: f.name, phone: f.phone, addr: f.addr })); const ho = JSON.parse(localStorage.getItem('pr_orders') || '[]').filter((x) => x.id !== d.id); ho.unshift({ id: d.id, token: d.token, mode: this.state.mode, at: Date.now(), total: d.total_tetri }); localStorage.setItem('pr_orders', JSON.stringify(ho.slice(0, 10)));",'my-history')
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', isMy: scr === 'my', MY, myPh: (this.state.myF || {}).ph != null ? this.state.myF.ph : ((() => { try { return (JSON.parse(localStorage.getItem('pr_me') || '{}') || {}).phone || ''; } catch (e) { return ''; } })()), myNm: (this.state.myF || {}).nm != null ? this.state.myF.nm : ((() => { try { return (JSON.parse(localStorage.getItem('pr_me') || '{}') || {}).name || ''; } catch (e) { return ''; } })()), myId: (this.state.myF || {}).id || '', myMsg: this.state.myMsg || '', onMy: (k) => (ev) => this.setState({ myF: Object.assign({}, this.state.myF || {}, { [k]: ev.target.value }), myMsg: '' }), myList: (() => { let h = []; try { h = JSON.parse(localStorage.getItem('pr_orders') || '[]'); } catch (e) {} return h.filter((x) => Date.now() - x.at < 2 * 864e5).map((x) => ({ label: '№ ' + x.id + ' · ' + new Date(x.at).toLocaleString(lang === 'ka' ? 'ka-GE' : lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (x.total ? ' · ' + fmt(x.total / 100) : ''), open: () => { try { localStorage.setItem('pr_track', JSON.stringify({ token: x.token, id: x.id, mode: x.mode, count: 0 })); } catch (e) {} window.__PR_TRACK({ token: x.token, id: x.id, mode: x.mode }); } })); })(), myFind: () => { const F = Object.assign({ ph: '', nm: '', id: '' }, this.state.myF || {}); let me0 = {}; try { me0 = JSON.parse(localStorage.getItem('pr_me') || '{}') || {}; } catch (e) {} if (this.state.myF == null || this.state.myF.ph == null) F.ph = me0.phone || ''; if (this.state.myF == null || this.state.myF.nm == null) F.nm = me0.name || ''; fetch('/api/public/order/find', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: F.ph, name: F.nm, id: F.id }) }).then((r) => r.json().then((j) => [r.ok, j])).then(([ok2, j]) => { if (!ok2) { this.setState({ myMsg: j.message || MY.err }); return; } const tk = { token: j.token, id: j.id, mode: j.mode, count: 0 }; try { localStorage.setItem('pr_track', JSON.stringify(tk)); } catch (e) {} window.__PR_TRACK(tk); }).catch(() => this.setState({ myMsg: MY.err })); },",'my-binds')
script=R(script,"go: k === 'my' ? () => { if (window.__PR_FIND) window.__PR_FIND(); } : () => go(k) }));","go: k === 'my' ? () => window.__PR_FIND() : () => go(k) }));",'my-tab')
MYPAGE=('<sc-if value="{{isMy}}" hint-placeholder-val="{{false}}"><section class="pr-mypage">'
  '<sc-if value="{{myList.length}}" hint-placeholder-val="{{false}}"><h2>{{MY.recent}}</h2><div class="pr-mylist"><sc-for list="{{myList}}" as="mo" hint-placeholder-count="2"><button onClick="{{mo.open}}"><span>📦 {{mo.label}}</span><b>→</b></button></sc-for></div></sc-if>'
  '<div class="pr-myform"><h2>🔎 {{MY.t}}</h2><p>{{MY.p}}</p>'
  '<input type="tel" inputmode="tel" placeholder="{{MY.ph}}" value="{{myPh}}" onInput="{{onMyPh}}">'
  '<input placeholder="{{MY.nm}}" value="{{myNm}}" onInput="{{onMyNm}}">'
  '<input inputmode="numeric" placeholder="{{MY.id}}" value="{{myId}}" onInput="{{onMyId}}">'
  '<sc-if value="{{myMsg}}" hint-placeholder-val="{{false}}"><span class="pr-myerr">{{myMsg}}</span></sc-if>'
  '<button class="pr-mygo" onClick="{{myFind}}">{{MY.go}}</button></div></section></sc-if>\n    ')
script=R(script,"myMsg: this.state.myMsg || '',","myMsg: this.state.myMsg || '', onMyPh: (ev) => this.setState({ myF: Object.assign({}, this.state.myF || {}, { ph: ev.target.value }), myMsg: '' }), onMyNm: (ev) => this.setState({ myF: Object.assign({}, this.state.myF || {}, { nm: ev.target.value }), myMsg: '' }), onMyId: (ev) => this.setState({ myF: Object.assign({}, this.state.myF || {}, { id: ev.target.value }), myMsg: '' }),",'my-inputs')
_mm='<sc-if value="{{isMenu}}" hint-placeholder-val="{{false}}">'
assert body.count(_mm)==1
body=body.replace(_mm, MYPAGE+_mm,1)
# Быстрее: в сетке меню — маленькие картинки (360 px), большие — только в карточке товара
LIVE=open('live.js').read()
for _a,_b in [("img: p.photo || '/img/hero-square-720.webp'","img: window.__TH(p.photo || '/img/hero-square-720.webp')")]:
    assert LIVE.count(_a)==1, _a; LIVE=LIVE.replace(_a,_b)
LIVE="window.__TH = (u) => (u && /-(c|v3|v6|v7)-600\\.webp$/.test(u) ? u.replace('-600.webp', '-360.webp') : u);\n"+LIVE
# Корзина: напитки предлагаются всегда (все напитки и пиво), видно сколько уже добавлено; переход между экранами — с начала страницы
script=R(script,"upsellOn: count > 0 && !MENU.some((m) => qty[m.id] && m.tags.some((t) => drinkCats.indexOf(t) >= 0)),","upsellOn: count > 0,",'ups-on')
script=R(script,"upsell: MENU.filter((m) => m.tags.some((t) => drinkCats.indexOf(t) >= 0) && !m.stopped).slice(0, 6).map((m) => ({ name: m.n[lang][0] + (m.size ? ' ' + window.PR_SZ(m.size, lang) : ''), price: fmt(priceOf(m)), img: m.img, add: () => addOne(m, 1) })),",
  "upsell: MENU.filter((m) => m.tags.some((t) => drinkCats.indexOf(t) >= 0 || t === 'beer') && !m.stopped).map((m) => ({ name: m.n[lang][0] + (m.size ? ' ' + window.PR_SZ(m.size, lang) : ''), price: fmt(priceOf(m)), img: m.img, q: qty[m.id] || 0, inCart: (qty[m.id] || 0) > 0, add: () => { const e = document.querySelector('.pr-ups'); if (e) window.__upsKeep = { x: e.scrollLeft, y: e.getBoundingClientRect().top }; addOne(m, 1); } })), upsL: () => { const e = document.querySelector('.pr-ups'); if (e) e.scrollBy({ left: -e.clientWidth * 0.8, behavior: 'smooth' }); }, upsR: () => { const e = document.querySelector('.pr-ups'); if (e) e.scrollBy({ left: e.clientWidth * 0.8, behavior: 'smooth' }); },",'ups-list')
script=R(script,"  afterRender(host) { if (window.PRMap) window.PRMap.attach(host, this); }",
  "  afterRender(host) { if (window.PRMap) window.PRMap.attach(host, this); const scr = this.state.screen || 'menu'; if (this._scr !== scr) { const sc = host.querySelector('.pr-scroll') || document.querySelector('.pr-scroll'); this._pos = this._pos || {}; if (sc) { if (this._scr) this._pos[this._scr] = this._lastTop || 0; sc.scrollTop = scr === 'menu' ? (this._pos.menu || 0) : 0; if (!sc._prw) { sc._prw = 1; sc.addEventListener('scroll', () => { this._lastTop = sc.scrollTop; }, { passive: true }); } } this._scr = scr; this._lastTop = sc ? sc.scrollTop : 0; } const ue = host.querySelector('.pr-ups') || document.querySelector('.pr-ups'); if (ue) { const K = window.__upsKeep; if (K) { ue.scrollLeft = K.x; const sc2 = document.querySelector('.pr-scroll'); if (sc2) sc2.scrollTop += ue.getBoundingClientRect().top - K.y; window.__upsKeep = null; } else if (!ue._prx && window.__upsX) ue.scrollLeft = window.__upsX; if (!ue._prx) { ue._prx = 1; ue.addEventListener('scroll', () => { window.__upsX = ue.scrollLeft; }, { passive: true }); } } }",'scroll-top')
_UO='<div style="display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px">\n              <sc-for list="{{upsell}}" as="u" hint-placeholder-count="3">'
assert body.count(_UO)==1, 'ups markup'
body=body.replace(_UO,'<div class="pr-upsw"><button class="pr-upsa" onClick="{{upsL}}" aria-label="‹">‹</button><div class="pr-ups">\n              <sc-for list="{{upsell}}" as="u" hint-placeholder-count="3">',1)
_UC='<span style="font: 800 13px Inter, sans-serif; color: #2A1D13">+ {{u.price}}</span></span>\n                </button>\n              </sc-for>\n            </div>'
assert body.count(_UC)==1, 'ups close'
body=body.replace(_UC,'<span style="font: 800 13px Inter, sans-serif; color: #2A1D13">+ {{u.price}}</span></span><sc-if value="{{u.inCart}}" hint-placeholder-val="{{false}}"><b class="pr-upsq">×{{u.q}}</b></sc-if>\n                </button>\n              </sc-for>\n            </div><button class="pr-upsa" onClick="{{upsR}}" aria-label="›">›</button></div>',1)
# Статус заказа у клиента — по шагам, как в агрегаторах: отправлен → принят → готовится → готов → курьер забрал (через N мин) → доставлен
script=R(script,"    const flow = lastDel ? ['received', 'cooking', 'readyPizza', 'onWay', 'delivered'] : ['received', 'cooking', 'ready'];",
"""    const STL = ({ ru: { sent: 'Заказ отправлен — ждём, пока пиццерия примет', accepted: 'Пиццерия приняла заказ', cooking: 'Пицца готовится', readyPizza: 'Пицца готова — ждёт курьера', ready: 'Готово — можно забирать в пиццерии', onWay: 'Курьер забрал заказ — в пути', delivered: 'Доставлено', pickedUp: 'Заказ получен', mins: 'мин', about: 'примерно через' },
      en: { sent: 'Order sent — waiting for the pizzeria to accept', accepted: 'The pizzeria accepted your order', cooking: 'Pizza is being made', readyPizza: 'Pizza ready — waiting for the courier', ready: 'Ready — pick it up at the pizzeria', onWay: 'Courier picked up your order — on the way', delivered: 'Delivered', pickedUp: 'Picked up', mins: 'min', about: 'in about' },
      ka: { sent: 'შეკვეთა გაგზავნილია — ველოდებით პიცერიის დადასტურებას', accepted: 'პიცერიამ მიიღო შეკვეთა', cooking: 'პიცა მზადდება', readyPizza: 'პიცა მზადაა — ელოდება კურიერს', ready: 'მზადაა — შეგიძლიათ წაიღოთ პიცერიიდან', onWay: 'კურიერმა წაიღო — გზაშია', delivered: 'მიტანილია', pickedUp: 'გატანილია', mins: 'წთ', about: 'დაახლოებით' } })[lang] || {};
    const flow = lastDel ? ['sent', 'accepted', 'cooking', 'readyPizza', 'onWay', 'delivered'] : ['sent', 'accepted', 'cooking', 'ready', 'pickedUp'];""",'st-flow')
script=R(script,"    let stage = LV ? ({ received: 0, cooking: 1, ready: 2, onway: 3, delivered: 4, cancelled: 0 }[LV.status] || 0) : 0; if (!lastDel && stage > 2) stage = 2;",
"""    let stage = LV ? ({ received: 0, accepted: 1, cooking: 2, ready: 3, onway: 4, delivered: lastDel ? 5 : 4, cancelled: 0 }[LV.status] || 0) : 0;
    const outMs = LV && LV.out_at ? Date.parse(LV.out_at.replace(' ', 'T') + 'Z') : 0; const trav = (LV && LV.travel) || 20;
    const onLeft = outMs ? Math.max(1, Math.round(trav - (Date.now() - outMs) / 60000)) : trav;""",'st-stage')
script=R(script,"      return { label: L[k], mark: done ? '✓' : String(i + 1), note: cur ? L.now : '',",
"      return { label: STL[k] || L[k], mark: done ? '✓' : String(i + 1), note: cur ? (k === 'onWay' ? STL.about + ' ' + onLeft + ' ' + STL.mins : L.now) : '',",'st-label')
script=R(script,"    const prog = lastDel ? Math.max(0, Math.min(1, (tr - readyEnd) / Math.max(1, TT - readyEnd))) : 0;",
"    const prog = lastDel && outMs ? Math.max(0, Math.min(1, (Date.now() - outMs) / 60000 / trav)) : (LV && LV.status === 'delivered' ? 1 : 0);",'st-prog')
script=R(script,"    const finished = !!LV && (LV.status === 'delivered' || LV.status === 'cancelled' || (!lastDel && LV.status === 'ready'));",
"    const finished = !!LV && (LV.status === 'delivered' || LV.status === 'cancelled');",'st-fin')
script=R(script,"    const left = Math.max(1, Math.round(TT - tr));\n    const etaD = new Date((LV && LV.created_at ? Date.parse(LV.created_at.replace(' ', 'T') + 'Z') : (this.state.orderAt || Date.now())) + TT * 60000);",
"    const left = outMs ? onLeft : Math.max(1, Math.round(TT - tr));\n    const etaD = outMs ? new Date(outMs + trav * 60000) : new Date((LV && LV.created_at ? Date.parse(LV.created_at.replace(' ', 'T') + 'Z') : (this.state.orderAt || Date.now())) + TT * 60000);",'st-left')
script=R(script,"trackPct: (finished ? 100 : Math.min(95, Math.round(Math.max(stage / (lastDel ? 4 : 2), tr / TT) * 100))) + '%',","trackPct: (finished ? 100 : Math.min(95, Math.round(stage / (flow.length - 1) * 100))) + '%',",'st-pct')
script=R(script,"mapBadge: stage >= 3 ? L.onWay + ' · ' + left + ' ' + L.min : (stage === 2 ? L.readyPizza : L.cooking),","mapBadge: (STL[flow[stage]] || '') + (flow[stage] === 'onWay' ? ' · ' + left + ' ' + L.min : ''),",'st-badge')
script=R(script,": finished ? (lastDel ? L.arrived : L.readyPick) : (lastDel ? L.etaDel : L.etaPick), etaClock, etaLeft: finished ? '' : L.inMin + ' ' + left + ' ' + L.min,",
": (finished || (!lastDel && LV && LV.status === 'ready')) ? (lastDel ? L.arrived : (LV && LV.status === 'delivered' ? STL.pickedUp : L.readyPick)) : (lastDel ? L.etaDel : L.etaPick), etaClock: (finished || (!lastDel && LV && LV.status === 'ready')) ? '✓' : etaClock, etaLeft: (finished || (!lastDel && LV && LV.status === 'ready')) ? '' : L.inMin + ' ' + left + ' ' + L.min,",'st-title')
# Заказ ко времени: «Как можно скорее» или «Ко времени» (сегодня/завтра, шаг 15 минут, в часы работы)
script=R(script,"    const place = () => {\n      const digits = f.phone.replace(/\\D/g, '').replace(/^995/, '');",
"""    const WH = ({ ru: { t: 'Когда приготовить?', asap: 'Как можно скорее', later: 'Ко времени', today: 'Сегодня', tomorrow: 'Завтра', pick: 'Выберите время', note: 'Приготовим точно к выбранному времени', closedNote: 'Сейчас закрыто — можно заказать заранее ко времени' },
      en: { t: 'When should we make it?', asap: 'As soon as possible', later: 'At a set time', today: 'Today', tomorrow: 'Tomorrow', pick: 'Choose a time', note: 'We will have it ready right at the chosen time', closedNote: 'We are closed now — you can pre-order for a set time' },
      ka: { t: 'როდის მოვამზადოთ?', asap: 'რაც შეიძლება მალე', later: 'კონკრეტულ დროზე', today: 'დღეს', tomorrow: 'ხვალ', pick: 'აირჩიეთ დრო', note: 'მოვამზადებთ ზუსტად არჩეულ დროზე', closedNote: 'ახლა დაკეტილია — შეგიძლიათ წინასწარ შეუკვეთოთ კონკრეტულ დროზე' } })[lang] || {};
    const WSL = (() => { const A0 = window.__PR_ADMIN || {}; const pm = (x) => { const a = String(x || '0:0').split(':'); return (+a[0]) * 60 + (+a[1] || 0); }; const o = pm(A0.open || '11:00'), c = pm(A0.close || '23:00');
      const lead = (isDelivery ? 45 : 30) * 60e3; const todayS = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); const out = [];
      let t = Math.ceil((Date.now() + lead) / 9e5) * 9e5; const end = Date.now() + 34 * 3600e3;
      for (; t <= end && out.length < 120; t += 9e5) { const L0 = new Date(t + 4 * 3600e3); const ds = L0.toISOString().slice(0, 10); const hm = L0.toISOString().slice(11, 16); const mm = L0.getUTCHours() * 60 + L0.getUTCMinutes();
        const ok = o === c || (c > o ? (mm >= o + 15 && mm <= c - 15) : (mm >= o + 15 || mm <= c - 15)); if (!ok) continue;
        const v = ds + ' ' + hm; out.push({ v, hm, day: ds === todayS ? WH.today : WH.tomorrow, sel: this.state.at === v }); }
      return out; })();
    const whenLater = !isOpen || !!this.state.later;
    const place = () => {
      if (whenLater && !(this.state.at && WSL.some((x) => x.v === this.state.at))) { this.flash(WH.pick); return; }
      const digits = f.phone.replace(/\\D/g, '').replace(/^995/, '');""",'when-place')
script=R(script,"address: f.addr, comment: f.com, pay: 'cash', lang,","address: f.addr, comment: f.com, pay: 'cash', lang, at: whenLater ? this.state.at : null,",'when-body')
script=R(script,"    const blocked = !isOpen || offline;","    const blocked = (!isOpen && !(this.state.at && WSL.some((x) => x.v === this.state.at))) || offline;",'when-blocked')
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', WH, WSL, whenOpen: isOpen, whenLater, whenClosed: !isOpen, whenNow: () => this.setState({ later: false, at: null }), whenSet: () => this.setState({ later: true }), whenNowSt: !whenLater ? 'background: #2A1D13; color: #FDC134;' : 'background: transparent; color: #2A1D13;', whenLaterSt: whenLater ? 'background: #2A1D13; color: #FDC134;' : 'background: transparent; color: #2A1D13;', whenSlots: WSL.map((x, i) => ({ hm: x.hm, day: (i === 0 || WSL[i - 1].day !== x.day) ? x.day : '', pick: () => this.setState({ later: true, at: x.v }), st: x.sel ? 'background: #FDC134; color: #2A1D13; box-shadow: inset 0 0 0 2px #2A1D13;' : 'background: #FBF5EA; color: #2A1D13;' })),",'when-binds')
_WB=('<div class="pr-when"><b>{{WH.t}}</b>'
 '<sc-if value="{{whenClosed}}" hint-placeholder-val="{{false}}"><span class="pr-whenc">🌙 {{WH.closedNote}}</span></sc-if>'
 '<sc-if value="{{whenOpen}}" hint-placeholder-val="{{true}}"><div class="pr-when2"><button onClick="{{whenNow}}" style="{{whenNowSt}}">⚡ {{WH.asap}}</button><button onClick="{{whenSet}}" style="{{whenLaterSt}}">⏰ {{WH.later}}</button></div></sc-if>'
 '<sc-if value="{{whenLater}}" hint-placeholder-val="{{false}}"><div class="pr-slots"><sc-for list="{{whenSlots}}" as="w" hint-placeholder-count="6"><span class="pr-slotw"><sc-if value="{{w.day}}" hint-placeholder-val="{{false}}"><i>{{w.day}}</i></sc-if><button onClick="{{w.pick}}" style="{{w.st}}">{{w.hm}}</button></span></sc-for></div><span class="pr-whenn">{{WH.note}}</span></sc-if></div>\n        ')
_cn='<label for="c-name"'
assert body.count(_cn)==1, 'c-name'
body=body.replace(_cn,_WB+_cn,1)
# статус: заказ ко времени — показываем выбранное время
script=R(script,"    const left = outMs ? onLeft : Math.max(1, Math.round(TT - tr));","    const wantMs = LV && LV.want_at ? Date.parse(LV.want_at.replace(' ', 'T') + 'Z') : 0;\n    const left = outMs ? onLeft : wantMs ? Math.max(1, Math.round((wantMs - Date.now()) / 60000)) : Math.max(1, Math.round(TT - tr));",'st-want1')
script=R(script,"    const etaD = outMs ? new Date(outMs + trav * 60000) :","    const etaD = outMs ? new Date(outMs + trav * 60000) : wantMs ? new Date(wantMs) :",'st-want2')
script=R(script,"etaLeft: (finished || (!lastDel && LV && LV.status === 'ready')) ? '' : L.inMin + ' ' + left + ' ' + L.min,",
"etaLeft: (finished || (!lastDel && LV && LV.status === 'ready')) ? '' : L.inMin + ' ' + (left >= 90 ? Math.floor(left / 60) + ' ' + ({ ru: 'ч', en: 'h', ka: 'სთ' }[lang] || 'h') + (left % 60 ? ' ' + (left % 60) + ' ' + L.min : '') : left + ' ' + L.min),",'st-hours')
# Данные покупателя: храним только по согласию «Запомнить», не дольше 90 дней; старые заказы и ссылки на них стираются; кнопка «Забыть мои данные»
script=R(script,"localStorage.setItem('pr_me', JSON.stringify({ name: f.name, phone: f.phone, addr: f.addr }));",
  "if (this.state.remember !== false) localStorage.setItem('pr_me', JSON.stringify({ name: f.name, phone: f.phone, addr: f.addr, at: Date.now() })); else localStorage.removeItem('pr_me');",'me-save')
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', RM: ({ ru: { rem: 'Запомнить мои данные на этом устройстве', remNo: 'Не отмечайте на чужом или общем компьютере', forget: 'Забыть мои данные на этом устройстве', forgot: 'Готово: имя, телефон, адрес и история заказов удалены с этого устройства' }, en: { rem: 'Remember my details on this device', remNo: 'Leave unticked on a shared computer', forget: 'Forget my details on this device', forgot: 'Done: name, phone, address and order history removed from this device' }, ka: { rem: 'დაიმახსოვრე ჩემი მონაცემები ამ მოწყობილობაზე', remNo: 'არ მონიშნოთ სხვის ან საერთო კომპიუტერზე', forget: 'წაშალე ჩემი მონაცემები ამ მოწყობილობიდან', forgot: 'მზადაა: სახელი, ტელეფონი, მისამართი და შეკვეთების ისტორია წაიშალა ამ მოწყობილობიდან' } })[lang] || {}, remOn: this.state.remember !== false, remBox: this.state.remember !== false ? 'background: #FDC134' : 'background: #fff', remToggle: () => this.setState({ remember: this.state.remember === false }), forgetMe: () => { ['pr_me', 'pr_orders', 'pr_track', 'pr_last'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} }); this.setState({ f: { name: '', phone: '', addr: '', com: '' }, myF: { ph: '', nm: '', id: '' }, myMsg: '', live: null, forgot: true }); }, forgot: !!this.state.forgot,",'me-binds')
_REM=('<button type="button" class="pr-rem" onClick="{{remToggle}}"><span class="pr-remb" style="{{remBox}}">{{remOn ? "✓" : ""}}</span><span><b>{{RM.rem}}</b><i>{{RM.remNo}}</i></span></button>\n        ')
_cp=body.index('<label for="c-phone"'); _ce=body.index('</label>',_cp)+len('</label>')
body=body[:_ce]+'\n          '+_REM.replace('{{remOn ? "✓" : ""}}','<sc-if value="{{remOn}}" hint-placeholder-val="{{true}}">✓</sc-if>')+body[_ce:]
_mf='<button class="pr-mygo" onClick="{{myFind}}">{{MY.go}}</button></div>'
assert body.count(_mf)==1, 'myfind'
body=body.replace(_mf,_mf+'<button class="pr-forget" onClick="{{forgetMe}}">🧹 {{RM.forget}}</button><sc-if value="{{forgot}}" hint-placeholder-val="{{false}}"><span class="pr-forgot">✓ {{RM.forgot}}</span></sc-if>',1)
# ── Оплата картой онлайн (банк подключается в админке); после оплаты клиент возвращается на страницу заказа
script=R(script,"address: f.addr, comment: f.com, pay: 'cash', lang,","address: f.addr, comment: f.com, pay: (this.state.payOnl && window.__PR_ADMIN && window.__PR_ADMIN.online && window.__PR_ADMIN.online.on) ? 'online' : 'cash', lang,",'pay-body')
script=R(script,"          this.startTrack();\n        }).catch(","          this.startTrack();\n          if (d.pay_url) { try { localStorage.setItem('pizzaroom_demo_v3', JSON.stringify({ qty: {}, mode: this.state.mode, lang: this.state.lang, t: Date.now() })); } catch (e) {} window.location.assign(d.pay_url); }\n        }).catch(",'pay-go')
script=R(script,"title: titles[scr] || '',","title: titles[scr] || '', PY: ({ ru: { card: 'Картой онлайн', cardSub: 'Visa, Mastercard, Apple Pay, Google Pay — на защищённой странице банка', checking: 'Проверяем оплату… Если вы закрыли страницу банка, не оплатив, заказ отменится сам через 30 минут', paid: 'Оплачено картой', failed: 'Оплата не прошла — заказ не отправлен. Оформите заново или оплатите при получении', refunded: 'Деньги возвращены на карту — банк зачислит их в течение 1–10 рабочих дней', terms: 'Условия', refund: 'Возврат', privacy: 'Конфиденциальность' }, en: { card: 'Card online', cardSub: 'Visa, Mastercard, Apple Pay, Google Pay — on the bank’s secure page', checking: 'Checking your payment… If you left the bank page without paying, the order will cancel itself in 30 minutes', paid: 'Paid by card', failed: 'Payment failed — the order was not sent. Please order again or pay on receipt', refunded: 'Money returned to your card — the bank will credit it within 1–10 business days', terms: 'Terms', refund: 'Refunds', privacy: 'Privacy' }, ka: { card: 'ბარათით ონლაინ', cardSub: 'Visa, Mastercard, Apple Pay, Google Pay — ბანკის დაცულ გვერდზე', checking: 'ვამოწმებთ გადახდას… თუ ბანკის გვერდი გადაუხდელად დახურეთ, შეკვეთა თავად გაუქმდება 30 წუთში', paid: 'გადახდილია ბარათით', failed: 'გადახდა ვერ შესრულდა — შეკვეთა არ გაიგზავნა. შეუკვეთეთ თავიდან ან გადაიხადეთ მიღებისას', refunded: 'თანხა დაბრუნდა ბარათზე — ბანკი ჩარიცხავს 1–10 სამუშაო დღეში', terms: 'პირობები', refund: 'დაბრუნება', privacy: 'კონფიდენციალურობა' } })[lang] || {}, LGQ: '?lang=' + lang, coLine: ((() => { const C = (window.__PR_ADMIN && window.__PR_ADMIN.company) || {}; const n = C['name_' + lang] || C.name_en || ''; return n ? n + (C.tin ? ' · ID ' + C.tin : '') : ''; })()), onlOn: !!(window.__PR_ADMIN && window.__PR_ADMIN.online && window.__PR_ADMIN.online.on), onlOff: !(window.__PR_ADMIN && window.__PR_ADMIN.online && window.__PR_ADMIN.online.on), payPickNow: () => this.setState({ payOnl: false }), payPickOnl: () => this.setState({ payOnl: true }), payNowSt: !this.state.payOnl ? 'border: 2px solid #2A1D13; background: #FBF5EA;' : 'border: 1px solid #D9C4A2; background: #fff;', payOnlSt: this.state.payOnl ? 'border: 2px solid #2A1D13; background: #FBF5EA;' : 'border: 1px solid #D9C4A2; background: #fff;', payNowR: !this.state.payOnl ? 'border: 5px solid #2A1D13' : 'border: 2px solid #A8916C', payOnlR: this.state.payOnl ? 'border: 5px solid #2A1D13' : 'border: 2px solid #A8916C', payMsgOn: !!(this.state.live && this.state.live.pay), payMsg: ((p) => p === 'paid' ? '✓ ' + ({ ru: 'Оплачено картой', en: 'Paid by card', ka: 'გადახდილია ბარათით' })[lang] : p === 'failed' ? '✕ ' + (({ ru: 'Оплата не прошла — заказ не отправлен. Оформите заново или оплатите при получении', en: 'Payment failed — the order was not sent. Please order again or pay on receipt', ka: 'გადახდა ვერ შესრულდა — შეკვეთა არ გაიგზავნა. შეუკვეთეთ თავიდან ან გადაიხადეთ მიღებისას' })[lang]) : p === 'refunded' ? '↩ ' + (({ ru: 'Деньги возвращены на карту — банк зачислит их в течение 1–10 рабочих дней', en: 'Money returned to your card — the bank will credit it within 1–10 business days', ka: 'თანხა დაბრუნდა ბარათზე — ბანკი ჩარიცხავს 1–10 სამუშაო დღეში' })[lang]) : '💳 ' + (({ ru: 'Проверяем оплату… Если вы закрыли страницу банка, не оплатив, заказ отменится сам через 30 минут', en: 'Checking your payment… If you left the bank page without paying, the order will cancel itself in 30 minutes', ka: 'ვამოწმებთ გადახდას… თუ ბანკის გვერდი გადაუხდელად დახურეთ, შეკვეთა თავად გაუქმდება 30 წუთში' })[lang]))(this.state.live && this.state.live.pay), payMsgSt: ((p) => p === 'paid' ? 'background: #DDE7D2; color: #2F6B3A;' : p === 'failed' ? 'background: #F6D9D3; color: #8A2414;' : p === 'refunded' ? 'background: #FFF1C9; color: #8A4A00;' : 'background: #FFF1C9; color: #2A1D13;')(this.state.live && this.state.live.pay),",'pay-binds')
_po=('<div style="border: 2px solid #2A1D13; border-radius: 14px; padding: 12px 14px; font-weight: 600; font-size: 15px; background: #FBF5EA; display: flex; align-items: center; gap: 10px"><span style="width: 18px; height: 18px; border-radius: 999px; border: 5px solid #2A1D13; box-sizing: border-box; flex-shrink: 0"></span>{{payNow}}</div>\n          <div style="border: 1px dashed #A8916C; border-radius: 14px; padding: 12px 14px; font-size: 14px; color: #5C4632">{{L.payOnline}}</div>')
assert body.count(_po)==1, 'pay-opts'
body=body.replace(_po,'<sc-if value="{{onlOn}}" hint-placeholder-val="{{false}}"><button type="button" class="pr-payo" onClick="{{payPickNow}}" style="{{payNowSt}}"><span class="pr-payr" style="{{payNowR}}"></span>{{payNow}}</button><button type="button" class="pr-payo" onClick="{{payPickOnl}}" style="{{payOnlSt}}"><span class="pr-payr" style="{{payOnlR}}"></span><span><b>💳 {{PY.card}}</b><i>{{PY.cardSub}}</i></span></button></sc-if><sc-if value="{{onlOff}}" hint-placeholder-val="{{true}}">'+_po+'</sc-if>',1)
_st='<sc-if value="{{isStatus}}" hint-placeholder-val="{{false}}">\n      <section style="padding: 14px 16px 130px; display: flex; flex-direction: column; gap: 12px">'
assert body.count(_st)==1, 'status-sec'
body=body.replace(_st,_st+'<sc-if value="{{payMsgOn}}" hint-placeholder-val="{{false}}"><div class="pr-paymsg" style="{{payMsgSt}}">{{payMsg}}</div></sc-if>',1)
_ft='© 2017–2026 Pizza Room · Batumi Mall<br>'
if body.count(_ft)!=1: _ft='© 2018–2026 Pizza Room · Batumi Mall<br>'
assert body.count(_ft)==1, 'footer'
body=body.replace(_ft,_ft+'<span class="pr-legal"><a href="/terms{{LGQ}}">{{PY.terms}}</a><a href="/refund{{LGQ}}">{{PY.refund}}</a><a href="/privacy{{LGQ}}">{{PY.privacy}}</a></span><sc-if value="{{coLine}}" hint-placeholder-val="{{false}}"><span>{{coLine}}</span><br></sc-if>',1)
# Клиент: имя и фамилия (попадает в раздел «Клиенты» админки)
for a,b in [("name: 'Имя', phone: 'Телефон',","name: 'Имя и фамилия', phone: 'Телефон',"),("name: 'Name', phone: 'Phone',","name: 'Name and surname', phone: 'Phone',"),("name: 'სახელი', phone: 'ტელეფონი',","name: 'სახელი და გვარი', phone: 'ტელეფონი',")]:
    script=R(script,a,b,'name-label')
html=open('shell_live.html').read().replace('<head>', '<head><script>(function(){try{var N=Date.now(),L=localStorage;var m=JSON.parse(L.getItem(\'pr_me\')||\'null\');if(m){if(!m.at){m.at=N;L.setItem(\'pr_me\',JSON.stringify(m));}else if(N-m.at>90*864e5)L.removeItem(\'pr_me\');}var o=JSON.parse(L.getItem(\'pr_orders\')||\'[]\');var o2=o.filter(function(x){return x&&x.at&&N-x.at<2*864e5;});if(o2.length!==o.length){if(o2.length)L.setItem(\'pr_orders\',JSON.stringify(o2));else L.removeItem(\'pr_orders\');}var t=JSON.parse(L.getItem(\'pr_track\')||\'null\');if(t){if(!t.at){t.at=N;L.setItem(\'pr_track\',JSON.stringify(t));}else if(N-t.at>3*864e5)L.removeItem(\'pr_track\');}}catch(e){}})();</script>',1).replace('%%HELMET%%',helmet).replace('%%BODY%%',body).replace('%%RUNTIME%%',open('runtime.js').read()).replace('%%LIVE%%',LIVE).replace('%%CSS%%',open('live.css').read()).replace('%%SCRIPT%%',script)
for _a,_b in [('© 2018–2026','© 2017–2026'),('С 2018 года в Батуми','С 2017 года в Батуми'),('In Batumi since 2018','In Batumi since 2017'),('ბათუმში 2018 წლიდან','ბათუმში 2017 წლიდან')]: html=html.replace(_a,_b)
# шрифты не блокируют показ страницы: сначала текст системным шрифтом, потом подменяется
_fl=re.search(r'<link href="(https://fonts.googleapis.com/css2[^"]*)" rel="stylesheet">',html)
if _fl: html=html.replace(_fl.group(0),'<link href="'+_fl.group(1)+'" rel="stylesheet" media="print" onload="this.media=\'all\'"><noscript><link href="'+_fl.group(1)+'" rel="stylesheet"></noscript>',1)
# комбо на паузе (выключены в админке): на сайте остаются, но с надписью «Временно недоступно» и не открываются
def _r(h, a, b, n=None):
    assert a in h, a[:80]
    return h.replace(a, b)
html=_r(html, "open: () => window.PR_COMBO.open(c.id, this) }", "paused: !!c.paused, live: !c.paused, pick: c.paused ? L.comboOff : L.comboPick, open: () => (c.paused ? null : window.PR_COMBO.open(c.id, this)) }")
_Y='<span style="background: #FDC134; color: #2A1D13; border-radius: 12px; padding: 8px 12px; font: 800 13px Inter, \'Noto Sans Georgian\', sans-serif">{{L.comboPick}}</span>'
assert _Y in html, 'pick span'
_G='<sc-if value="{{cb.live}}" hint-placeholder-val="{{true}}">'+_Y.replace('{{L.comboPick}}','{{cb.pick}}')+'</sc-if><sc-if value="{{cb.paused}}" hint-placeholder-val="{{false}}"><span style="background: #5C4A3B; color: #E8DCC8; border-radius: 12px; padding: 8px 12px; font: 800 13px Inter, \'Noto Sans Georgian\', sans-serif">{{cb.pick}}</span></sc-if>'
html=html.replace(_Y,_G)
html=html.replace('{{cb.pick}}</span></span></span></button></sc-for></div></section></sc-if>', '{{cb.pick}}</span></span></span></button></sc-for></div></section></sc-if>')
# в сетке меню карточка комбо — it.cb
_i=html.index('{{it.cb.price}}'); _j=html.index('<sc-if value="{{cb.live}}"', _i); _k=html.index('</sc-if></sc-if>', _j) if False else html.index('{{cb.pick}}</span></sc-if>', html.index('{{cb.paused}}', _j))+len('{{cb.pick}}</span></sc-if>')
html=html[:_j]+html[_j:_k].replace('{{cb.','{{it.cb.')+html[_k:]
_ov='<sc-if value="{{X.paused}}" hint-placeholder-val="{{false}}"><span style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(20,14,9,0.7); display: flex; align-items: center; justify-content: center; text-align: center; padding: 10px; color: #FBF5EA; font: 900 19px Montserrat, Inter, \'Noto Sans Georgian\', sans-serif">{{X.pick}}</span></sc-if>'
for X in ['cb','it.cb']:
    _a='<img src="{{%s.img}}"' % X; _k=0
    while True:
        _k=html.find(_a,_k)
        if _k<0: break
        _e=html.index('>',_k)+1; html=html[:_e]+_ov.replace('X.',X+'.')+html[_e:]; _k=_e
html=_r(html, "comboPick: 'Выбрать',", "comboPick: 'Выбрать', comboOff: 'Временно недоступно',")
html=_r(html, "comboPick: 'Choose',", "comboPick: 'Choose', comboOff: 'Temporarily unavailable',")
html=_r(html, "comboPick: 'არჩევა',", "comboPick: 'არჩევა', comboOff: 'დროებით მიუწვდომელია',")
# защита от ботов: скрытое поле-ловушка + время на странице до заказа
html=_r(html, "comment: f.com, pay: (this.state.payOnl", "comment: f.com, website: ((document.getElementById('c-web') || {}).value || ''), el: Math.round(performance.now()), pay: (this.state.payOnl")
_cn='<input id="c-name" type="text" autocomplete="name"'
assert _cn in html
html=html.replace(_cn, '<input id="c-web" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0">'+_cn,1)

# SEO: мета-теги, schema.org, ?lang=ru|en, текст для поисковиков внутри #app (приложение его заменяет)
import sys as _sys; _sys.path.insert(0,'seo'); import seo as _seo
html=_r(html, '<title>Pizza Room Batumi — პიცა · Пицца · Pizza · Batumi Mall</title>', '<title>'+_seo.T['ka'][0]+'</title>')
_i=html.index('<meta name="description"'); _e=html.index('>',_i)+1
html=html[:_i]+'<meta name="description" content="'+_seo.H.escape(_seo.T['ka'][1])+'">\n'+_seo.head()+'\n'+_seo.js()+html[_e:]
_i=html.index('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant"'); _e=html.index('</script>',_i)+9
html=html[:_i]+html[_e:]
html=_r(html, '<div id="app"></div>', '<noscript><style>#boot{display:none}</style></noscript><div id="app">'+_seo.body()+'</div>')
html=_r(html, "  var lang = nl === 'ka' ? 'ka' : (nl === 'ru' || nl === 'uk' || nl === 'be' ? 'ru' : 'en');", "  var lang = nl === 'ka' ? 'ka' : (nl === 'ru' || nl === 'uk' || nl === 'be' ? 'ru' : 'en');\n  try { var ql = new URLSearchParams(location.search).get('lang'); var pl = (location.pathname.match(/^\\/(ru|en)(\\/|$)/) || [])[1];\n    if ((ql === 'ru' || ql === 'en') && !pl) { location.replace('/' + ql + '/' + location.hash); } // старые ссылки ?lang=ru → /ru/\n    if (pl) lang = pl; else if (ql === 'ka' || ql === 'ru' || ql === 'en') lang = ql; else if (/bot|crawl|spider|slurp|lighthouse|facebookexternalhit|yandex/i.test(navigator.userAgent)) lang = 'ka'; } catch (e) {}\n  if (window.__PR_SEO) window.__PR_SEO(lang);")
html=_r(html, "    const lang = this.state.lang || this.props.lang || 'ru';\n    const isOpen", "    const lang = this.state.lang || this.props.lang || 'ru';\n    if (window.__PR_SEO) window.__PR_SEO(lang);\n    const isOpen")

# карта: проверка подлинности файлов Leaflet (если на CDN подменят файл — браузер его не запустит)
html=_r(html, "c.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';", "c.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; c.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; c.crossOrigin = '';")
html=_r(html, "s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';", "s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; s.crossOrigin = '';")
open('../../public/index.html','w').write(html)
print('ok',len(html))

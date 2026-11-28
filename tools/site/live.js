// Pizza Room — рабочий сайт: данные из базы, настоящие заказы, карта
window.PR_TZ = 4;
window.__PR_ISOPEN = function (open, close) {
  var n = new Date(Date.now() + window.PR_TZ * 3600e3), m = n.getUTCHours() * 60 + n.getUTCMinutes();
  var p = function (s) { var a = String(s || '0:0').split(':'); return (+a[0]) * 60 + (+a[1] || 0); };
  var o = p(open), c = p(close); return c > o ? (m >= o && m < c) : (m >= o || m < c);
};
window.PRData = {
  load: function () {
    return Promise.all([fetch('/api/public/catalog?t=' + Math.floor(Date.now() / 15000), { cache: 'no-store' }).then(function (r) { return r.json(); }), fetch('/api/public/settings?t=' + Math.floor(Date.now() / 15000), { cache: 'no-store' }).then(function (r) { return r.json(); })]).then(function (res) {
      var cat = res[0], st = res[1];
      window.__PR_CATS = cat.categories;
      window.__PR_COMBOS = cat.combos || [];
      var soonIds = cat.categories.filter(function (c) { return c.soon; }).map(function (c) { return c.id; });
      window.__PR_MENU = cat.products.filter(function (p) { return soonIds.indexOf(p.category_id) < 0; }).map(function (p) {
        var ds = p.desc_ru || '';
        return { id: p.id, price: p.price_tetri / 100, tags: [p.category_id], size: p.size || '', img: p.photo || '/img/hero-square-720.webp', big: (p.photo || '/img/hero-square-720.webp').replace('-600.', '-600.'),
          n: { ru: [p.name_ru, p.desc_ru || ''], en: [p.name_en || p.name_ru, p.desc_en || ""], ka: [p.name_ka || p.name_ru, p.desc_ka || p.desc_en || ""] }, inStock: !!p.in_stock };
      });
      var stop = {}; cat.products.forEach(function (p) { if (!p.in_stock) stop[p.id] = true; });
      var pr = st.promo || {};
      window.__PR_SETTINGS = st; window.__PR_DP = st.dpause || null;
      document.documentElement.classList.toggle('pr-noapps', !st.apps);
      window.__PR_ADMIN = { theme: 'sand', font: 'montserrat', online: st.online || { on: false }, company: st.company || {}, stop: stop, phone: st.info.phone, wa: st.info.wa, open: st.info.open, close: st.info.close, delivery: st.delivery,
        promo: { on: !!pr.on, pct: Number(pr.pct) || 0, scope: 'list', ids: cat.products.filter(function (p) { return (pr.cats || []).indexOf(p.category_id) >= 0 || (pr.cats || []).indexOf(p.id) >= 0; }).map(function (p) { return p.id; }),
          holiday: 'custom', from: pr.from ? pr.from.slice(8, 10) + '.' + pr.from.slice(5, 7) : '', to: pr.to ? pr.to.slice(8, 10) + '.' + pr.to.slice(5, 7) : '', strip: pr.banner !== false, popup: pr.banner !== false, title_ru: pr.title_ru, title_en: pr.title_en, title_ka: pr.title_ka } };
    });
  },
  promoActive: function (pr) { var t = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); return (!pr.from || t >= pr.from) && (!pr.to || t <= pr.to); }
};
// Карта: Leaflet + OpenStreetMap, оформлена под Pizza Room; маршрут — OSRM
window.PRMap = {
  PIZZA: [41.64318, 41.61974], maps: {}, route: null, routeFor: '', loading: null,
  load: function () {
    if (window.L && window.L.map) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = new Promise(function (ok, bad) {
      var c = document.createElement('link'); c.rel = 'stylesheet'; c.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(c);
      var s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
    return this.loading;
  },
  pizzaIcon: function () { return L.divIcon({ className: 'pr-pin', html: '<div class="pr-pin-in"><img src="/icon-192.png" alt=""></div><span>Pizza Room</span>', iconSize: [56, 70], iconAnchor: [28, 62] }); },
  meIcon: function (t) { return L.divIcon({ className: 'pr-me', html: '<div></div><span>' + t + '</span>', iconSize: [80, 40], iconAnchor: [40, 12] }); },
  attach: function (host, comp) {
    var self = this, ph = host.querySelectorAll('[data-map]');
    if (!ph.length) return;
    this.load().then(function () {
      ph.forEach(function (p) {
        var kind = p.getAttribute('data-map'), m = self.maps[kind];
        if (!m) {
          var el = document.createElement('div'); el.className = 'pr-map';
          var map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(self.PIZZA, 14);
          window.PR_DUO(el); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
          L.marker(self.PIZZA, { icon: self.pizzaIcon(), zIndexOffset: 1000 }).addTo(map);
          m = self.maps[kind] = { el: el, map: map, layer: L.layerGroup().addTo(map), key: '' };
        }
        if (m.el.parentNode !== p) { p.appendChild(m.el); setTimeout(function () { m.map.invalidateSize(); }, 30); }
        var me = kind === 'track' ? (comp.state.live && comp.state.live.lat ? { lat: comp.state.live.lat, lon: comp.state.live.lng } : null) : comp.state.me;
        var key = me ? me.lat.toFixed(5) + ',' + me.lon.toFixed(5) : 'none';
        if (key !== m.key) { m.key = key; self.draw(m, me, comp, kind); }
      });
    }).catch(function () { ph.forEach(function (p) { p.innerHTML = '<div style="padding:20px;font:600 14px Inter,sans-serif;color:#5C4632">Карта не загрузилась — проверьте интернет.</div>'; }); });
  },
  draw: function (m, me, comp, kind) {
    var self = this; m.layer.clearLayers();
    if (!me) { m.map.setView(self.PIZZA, 15); if (m.info) { m.map.removeControl(m.info); m.info = null; } return; }
    var lang = comp.state.lang || comp.props.lang || 'ru';
    var T = { ru: ['Вы', 'по прямой', 'км', 'мин'], en: ['You', 'straight line', 'km', 'min'], ka: ['თქვენ', 'პირდაპირ', 'კმ', 'წთ'] }[lang];
    var a = [me.lat, me.lon];
    L.marker(a, { icon: self.meIcon(T[0]) }).addTo(m.layer);
    var line = L.polyline([a, self.PIZZA], { color: '#2A1D13', weight: 2, dashArray: '2 8', opacity: 0.7 }).addTo(m.layer);
    var straight = m.map.distance(a, self.PIZZA) / 1000;
    line.bindTooltip(T[1] + ' ' + straight.toFixed(1).replace('.', lang === 'en' ? '.' : ',') + ' ' + T[2], { permanent: true, direction: 'center', className: 'pr-tip' });
    m.map.fitBounds(L.latLngBounds([a, self.PIZZA]).pad(0.25));
    var url = 'https://router.project-osrm.org/route/v1/driving/' + me.lon + ',' + me.lat + ';' + self.PIZZA[1] + ',' + self.PIZZA[0] + '?overview=full&geometries=geojson';
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.routes || !d.routes[0]) return;
      var rt = d.routes[0], pts = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      L.polyline(pts, { color: '#2A1D13', weight: 7, opacity: 0.9, lineCap: 'round' }).addTo(m.layer);
      L.polyline(pts, { color: '#FDC134', weight: 3, opacity: 1, dashArray: '1 9', lineCap: 'round' }).addTo(m.layer);
      m.map.fitBounds(L.latLngBounds(pts).pad(0.15));
      // время по дороге; в часы пик Батуми добавляем запас
      var h = new Date(Date.now() + 4 * 3600e3).getUTCHours(), rush = (h >= 8 && h < 10) || (h >= 17 && h < 20) ? 1.3 : 1.1;
      self.route = { km: rt.distance / 1000, min: Math.max(3, Math.round(rt.duration / 60 * rush)) };
      var km = (rt.distance / 1000).toFixed(1).replace('.', lang === 'en' ? '.' : ',');
      if (m.info) m.map.removeControl(m.info);
      m.info = L.control({ position: 'topright' }); m.info.onAdd = function () { var d = L.DomUtil.create('div', 'pr-info'); d.innerHTML = '<b>' + km + ' ' + T[2] + '</b><span>≈ ' + self.route.min + ' ' + T[3] + ' 🚗</span>'; return d; }; m.info.addTo(m.map);
      comp.setState({ routeAt: Date.now() });
    }).catch(function () {});
  }
};

// Ошибки заказа на языке посетителя
window.PR_ERR = {
  delivery_paused: { ru: 'Доставка сейчас на паузе — выберите самовывоз из Batumi Mall', en: 'Delivery is paused right now — please choose pickup at Batumi Mall', ka: 'მიტანა ახლა შეჩერებულია — აირჩიეთ გატანა Batumi Mall-იდან' },
  closed: { ru: 'Сейчас мы закрыты — заказ можно сделать в рабочие часы', en: 'We are closed right now — please order during opening hours', ka: 'ახლა დაკეტილი ვართ — შეუკვეთეთ სამუშაო საათებში' },
  bad_phone: { ru: 'Проверьте номер: 9 цифр, начинается с 5', en: 'Check the number: 9 digits starting with 5', ka: 'შეამოწმეთ ნომერი: 9 ციფრი, იწყება 5-ით' },
  too_many: { ru: 'Слишком много заказов подряд — позвоните нам', en: 'Too many orders in a row — please call us', ka: 'ზედმეტად ბევრი შეკვეთა ზედიზედ — დაგვირეკეთ' },
  stopped: { ru: 'Одна из позиций закончилась — уберите её из корзины', en: 'One item just sold out — please remove it from the cart', ka: 'ერთ-ერთი პროდუქტი ამოიწურა — ამოიღეთ კალათიდან' },
  soon: { ru: 'Этот раздел скоро откроется', en: 'This section is coming soon', ka: 'ეს განყოფილება მალე გაიხსნება' },
  bad_zone: { ru: 'Выберите зону доставки', en: 'Choose a delivery zone', ka: 'აირჩიეთ მიტანის ზონა' },
  no_address: { ru: 'Введите адрес', en: 'Enter your address', ka: 'შეიყვანეთ მისამართი' },
  no_name: { ru: 'Введите имя', en: 'Enter your name', ka: 'შეიყვანეთ სახელი' },
  empty: { ru: 'Корзина пустая', en: 'Your cart is empty', ka: 'კალათა ცარიელია' },
  no_online: { ru: 'Оплата картой онлайн сейчас недоступна — выберите оплату при получении', en: 'Online card payment is unavailable right now — please pay on receipt', ka: 'ონლაინ გადახდა ახლა მიუწვდომელია — აირჩიეთ გადახდა მიღებისას' },
  pay_failed: { ru: 'Не удалось открыть оплату картой — попробуйте ещё раз или оплатите при получении', en: 'Could not open card payment — try again or pay on receipt', ka: 'ბარათით გადახდა ვერ გაიხსნა — სცადეთ თავიდან ან გადაიხადეთ მიღებისას' }
};

// Карта в цветах Pizza Room: тёмно-коричневый → карамель → песок → крем
window.PR_DUO = function (host) {
  // фильтр кладём внутрь самой карты: страница перерисовывается и всё лишнее из body удаляет
  var w = document.createElement('div'); w.setAttribute('aria-hidden', 'true');
  w.innerHTML = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0\" height=\"0\" style=\"position:absolute\"><filter id=\"prduo\" color-interpolation-filters=\"sRGB\"><feColorMatrix type=\"saturate\" values=\"0\"/><feComponentTransfer><feFuncR type=\"table\" tableValues=\"0.165 0.176 0.188 0.199 0.211 0.223 0.234 0.246 0.257 0.269 0.281 0.292 0.304 0.315 0.327 0.339 0.35 0.362 0.373 0.385 0.396 0.408 0.42 0.46 0.5 0.54 0.581 0.621 0.661 0.701 0.738 0.768 0.799 0.828 0.853 0.877 0.902 0.92 0.937 0.961 0.984\"/><feFuncG type=\"table\" tableValues=\"0.114 0.122 0.131 0.14 0.149 0.157 0.166 0.175 0.184 0.192 0.201 0.21 0.219 0.227 0.236 0.245 0.253 0.262 0.271 0.28 0.288 0.297 0.306 0.339 0.373 0.407 0.44 0.474 0.507 0.541 0.575 0.612 0.649 0.686 0.724 0.762 0.8 0.833 0.867 0.91 0.953\"/><feFuncB type=\"table\" tableValues=\"0.075 0.08 0.085 0.09 0.095 0.1 0.106 0.111 0.116 0.121 0.126 0.131 0.137 0.142 0.147 0.152 0.157 0.162 0.168 0.173 0.178 0.183 0.188 0.207 0.226 0.246 0.265 0.284 0.303 0.322 0.347 0.38 0.413 0.45 0.504 0.558 0.612 0.667 0.722 0.804 0.886\"/></feComponentTransfer></filter></svg>";
  (host || document.documentElement).appendChild(w.firstChild);
};

// Объём и размер на языке посетителя: «33 см» → «33 სმ» / «33 cm»
window.PR_SZ = function (s, lang) {
  if (!s) return s;
  if (lang === 'ka') return s.replace(/см/g, 'სმ').replace(/\bл\b|л$/g, 'ლ').replace(/(\d) л/g, '$1 ლ');
  if (lang === 'en') return s.replace(/см/g, 'cm').replace(/(\d),(\d)/g, '$1.$2').replace(/ л/g, ' L');
  return s;
};

// ── Выбор пицц и напитков внутри комбо ──
window.PR_COMBO = {
  T: { ru: { add: 'В корзину', adult: 'Мне есть 18 лет', extra: 'доплата', close: 'Закрыть', need18: 'Подтвердите, что вам есть 18 лет' },
       en: { add: 'Add to cart', adult: 'I am 18 or older', extra: 'extra', close: 'Close', need18: 'Please confirm you are 18 or older' },
       ka: { add: 'კალათაში', adult: 'შემისრულდა 18 წელი', extra: 'დამატებით', close: 'დახურვა', need18: 'დაადასტურეთ, რომ 18 წელი შეგისრულდათ' } },
  open: function (id, comp) {
    var c = (window.__PR_COMBOS || []).find(function (x) { return x.id === id; }); if (!c) return;
    var lang = (comp.state && comp.state.lang) || (comp.props && comp.props.lang) || 'ka', T = this.T[lang] || this.T.ru;
    var nm = function (o) { return o[lang] || o.ru || o.name_ru || ''; };
    var picks = c.slots.map(function (s) { return s.options[0].id; });
    var esc = function (t) { return String(t).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); };
    var ov = document.createElement('div'); ov.className = 'pr-cmodal';
    var adult = !!(comp.state && comp.state.adult);
    function total() { var t = c.price_tetri; c.slots.forEach(function (s, k) { var o = s.options.find(function (x) { return x.id === picks[k]; }); t += o ? o.extra : 0; }); return t / 100; }
    function fmt(v) { return (Math.round(v * 100) % 100 === 0 ? String(Math.round(v)) : v.toFixed(2)) + ' ₾'; }
    function draw() {
      var h = '<div class="pr-csheet" role="dialog" aria-label="' + esc(c['name_' + lang] || c.name_ru) + '"><button class="pr-cx" aria-label="' + T.close + '">×</button>' +
        '<img src="' + esc(c.photo || '/img/pizza-pep-600.webp') + '" alt=""><div class="pr-cbody"><h3>' + esc(c['name_' + lang] || c.name_ru) + '</h3><p>' + esc(c['desc_' + lang] || c.desc_ru || '') + '</p>';
      c.slots.forEach(function (s, k) {
        h += '<div class="pr-cslot"><b>' + (k + 1) + '. ' + esc(nm(s)) + '</b><div class="pr-copts">';
        s.options.forEach(function (o) { h += '<button data-k="' + k + '" data-id="' + esc(o.id) + '" class="' + (picks[k] === o.id ? 'on' : '') + '">' + esc(nm(o)) + (o.extra ? ' <i>+' + fmt(o.extra / 100) + '</i>' : '') + '</button>'; });
        h += '</div></div>';
      });
      if (c.age18 && !adult) h += '<label class="pr-cage"><input type="checkbox" id="pr-c18"> ' + T.adult + '</label>';
      h += '<button class="pr-cadd">' + T.add + ' · ' + fmt(total()) + '</button></div></div>';
      ov.innerHTML = h;
    }
    draw(); document.documentElement.appendChild(ov);
    ov.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (e.target === ov || (b && b.classList.contains('pr-cx'))) { ov.remove(); return; }
      if (!b) return;
      if (b.dataset.k) { picks[+b.dataset.k] = b.dataset.id; var sc = ov.querySelector('.pr-csheet').scrollTop; draw(); ov.querySelector('.pr-csheet').scrollTop = sc; return; }
      if (b.classList.contains('pr-cadd')) {
        if (c.age18 && !adult) { var cb = ov.querySelector('#pr-c18'); if (!cb || !cb.checked) { cb && cb.parentNode.classList.add('err'); return; } }
        var pt = {}; ['ru', 'en', 'ka'].forEach(function (L) { pt[L] = c.slots.map(function (s, k) { var o = s.options.find(function (x) { return x.id === picks[k]; }); return o[L] || o.ru; }).join(' + '); });
        var cs = (comp.state.combos || []).slice(), key = c.id + ':' + picks.join(','), ex = cs.findIndex(function (x) { return x.key === key; });
        if (ex >= 0) cs[ex] = Object.assign({}, cs[ex], { qty: cs[ex].qty + 1 });
        else cs.push({ key: key, id: c.id, picks: picks.slice(), qty: 1, price: total(), old: Math.max(total(), c.old_price_tetri / 100 + (total() - c.price_tetri / 100)), img: c.photo, name: { ru: c.name_ru, en: c.name_en || c.name_ru, ka: c.name_ka || c.name_ru }, picksText: pt });
        var st = { combos: cs }; if (c.age18) st.adult = true;
        comp.setState(st); ov.remove();
        if (comp.flash) comp.flash((c['name_' + lang] || c.name_ru) + ' ✓');
      }
    });
  }
};

// Частые вопросы — цены доставки и часы берутся из настроек админки
window.PR_FAQ = function (lang, A, D) {
  var z = (D.zones || []), fee = function (i) { return z[i] ? Number(z[i].fee) : null; };
  var zl = z.map(function (x) { return (x[lang] || x.ru) + ' — ' + x.fee + ' ₾'; }).join(', ');
  var t = (D.tmin || 35) + '–' + (D.tmax || 40), hrs = (A.open || '11:00') + '–' + (A.close || '23:00'), ph = A.phone || '+995514888800';
  var Q = {
    ru: [['Куда вы доставляете и сколько это стоит?', zl + '. Обычно привозим за ' + t + ' минут.'],
         ['Как можно оплатить?', 'Наличными или картой курьеру. В пиццерии — наличными или картой.'],
         ['Во сколько вы работаете?', 'Каждый день ' + hrs + '. Заказы на сайте принимаем в эти часы.'],
         ['Можно забрать самому?', 'Да: Batumi Mall, ул. Зураба Горгиладзе, 88. Закажите на сайте — заберёте без ожидания.'],
         ['Как узнать, где мой заказ?', 'После заказа на сайте открывается страница статуса: видно, когда пиццу готовят, когда она готова и когда курьер в пути.'],
         ['Можно изменить или отменить заказ?', 'Да, сразу позвоните или напишите в WhatsApp: ' + ph + '.'],
         ['Пиво и вино продаёте?', 'Да, только гостям старше 18 лет. Курьер может попросить документ.']],
    en: [['Where do you deliver and how much is it?', zl + '. Usually it takes ' + t + ' minutes.'],
         ['How can I pay?', 'Cash or card to the courier. At the pizzeria — cash or card.'],
         ['What are your opening hours?', 'Every day ' + hrs + '. Online orders are accepted during these hours.'],
         ['Can I pick up my order?', 'Yes: Batumi Mall, 88 Zurab Gorgiladze St. Order online and pick it up without waiting.'],
         ['How do I track my order?', 'After ordering on the site you get a status page: you see when the pizza is being made, when it is ready and when the courier is on the way.'],
         ['Can I change or cancel my order?', 'Yes — call us or message us on WhatsApp right away: ' + ph + '.'],
         ['Do you sell beer and wine?', 'Yes, to guests aged 18+ only. The courier may ask for ID.']],
    ka: [['სად მოგაქვთ და რა ღირს მიტანა?', zl + '. ჩვეულებრივ მოგიტანთ ' + t + ' წუთში.'],
         ['როგორ შეიძლება გადახდა?', 'ნაღდი ფულით ან ბარათით კურიერთან. პიცერიაში — ნაღდით ან ბარათით.'],
         ['რომელ საათებში მუშაობთ?', 'ყოველდღე ' + hrs + '. საიტზე შეკვეთებს ამ საათებში ვიღებთ.'],
         ['შემიძლია თავად წავიღო?', 'დიახ: Batumi Mall, ზურაბ გორგილაძის ქ. 88. შეუკვეთეთ საიტზე და წაიღეთ ლოდინის გარეშე.'],
         ['როგორ გავიგო, სად არის ჩემი შეკვეთა?', 'შეკვეთის შემდეგ საიტზე იხსნება სტატუსის გვერდი: ხედავთ, როდის მზადდება პიცა, როდის არის მზად და როდის არის კურიერი გზაში.'],
         ['შეიძლება შეკვეთის შეცვლა ან გაუქმება?', 'დიახ — დაუყოვნებლივ დაგვირეკეთ ან მოგვწერეთ WhatsApp-ზე: ' + ph + '.'],
         ['ლუდს და ღვინოს ყიდით?', 'დიახ, მხოლოდ 18 წლის ზემოთ სტუმრებზე. კურიერმა შეიძლება მოგთხოვოთ დოკუმენტი.']]
  };
  return (Q[lang] || Q.ru).map(function (x) { return { q: x[0], a: x[1] }; });
};

/* ───── «Не дали чек? Пицца за наш счёт» — кнопка и форма; обращение сразу уходит владельцу ───── */
(function () {
  if (!window.__PR_NOCHECK) return; // кнопка временно выключена (владелец попросил убрать); вернуть: window.__PR_NOCHECK = true
  var TX = {
    ru: { btn: '🧾 Не дали чек?', t: 'Не дали чек? Пицца за наш счёт 🍕', p: 'Если кассир не пробил заказ или вам не выдали чек — сообщите нам. Мы проверим и подарим вам пиццу. Сообщение получит лично владелец.',
      phone: 'Ваш телефон', name: 'Имя (необязательно)', when: 'Когда это было', det: 'Что заказывали и где (в зале, с собой, доставка)', send: 'Отправить', ok: 'Спасибо! Владелец уже получил ваше сообщение — мы свяжемся с вами по телефону.', close: 'Закрыть', err: 'Не получилось отправить — проверьте телефон' },
    en: { btn: '🧾 No receipt?', t: 'No receipt? Pizza is on us 🍕', p: 'If the cashier did not ring up your order or you did not get a receipt, tell us. We will check and give you a free pizza. The owner gets this message personally.',
      phone: 'Your phone', name: 'Name (optional)', when: 'When did it happen', det: 'What you ordered and where (dine-in, takeaway, delivery)', send: 'Send', ok: 'Thank you! The owner already has your message — we will call you.', close: 'Close', err: 'Could not send — please check the phone number' },
    ka: { btn: '🧾 ჩეკი არ მოგცეს?', t: 'ჩეკი არ მოგცეს? პიცა ჩვენზეა 🍕', p: 'თუ მოლარემ შეკვეთა არ გაატარა ან ჩეკი არ მოგცეს — შეგვატყობინეთ. შევამოწმებთ და პიცას გაჩუქებთ. შეტყობინებას პირადად მფლობელი მიიღებს.',
      phone: 'თქვენი ტელეფონი', name: 'სახელი (არასავალდებულო)', when: 'როდის მოხდა', det: 'რა შეუკვეთეთ და სად (დარბაზში, გასატანად, მიტანა)', send: 'გაგზავნა', ok: 'მადლობა! მფლობელმა უკვე მიიღო თქვენი შეტყობინება — დაგიკავშირდებით.', close: 'დახურვა', err: 'ვერ გაიგზავნა — შეამოწმეთ ტელეფონი' }
  };
  function T() { return TX[window.__PR_LANG] || TX.ka; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var st = document.createElement('style');
  st.textContent = '.pr-nc{position:fixed;left:12px;bottom:12px;z-index:40;background:#2A1D13;color:#FDC134;border:0;border-radius:999px;padding:9px 14px;font:700 13px Inter,"Noto Sans Georgian",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer}' +
    '@media(max-width:820px){.pr-nc{bottom:86px;font-size:12px;padding:8px 12px}}' +
    '.pr-ncm{position:fixed;inset:0;z-index:100;background:rgba(42,29,19,.55);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.pr-ncb{background:#FBF5EA;color:#2A1D13;border-radius:22px;max-width:440px;width:100%;padding:20px;display:flex;flex-direction:column;gap:10px;font:500 15px Inter,"Noto Sans Georgian",sans-serif;max-height:92vh;overflow:auto}' +
    '.pr-ncb h3{margin:0;font-size:20px}.pr-ncb label{display:flex;flex-direction:column;gap:4px;font-weight:700;font-size:13px}.pr-ncb input,.pr-ncb textarea{border:1.5px solid #DCC7A5;border-radius:12px;padding:10px 12px;font:500 15px Inter,"Noto Sans Georgian",sans-serif;background:#fff}' +
    '.pr-ncb button{height:48px;border-radius:14px;border:0;font:800 15px Inter,"Noto Sans Georgian",sans-serif;cursor:pointer}.pr-ncb .y{background:#FDC134;color:#2A1D13}.pr-ncb .o{background:transparent;border:1.5px solid #2A1D13}';
  document.head.appendChild(st);
  var b = document.createElement('button'); b.className = 'pr-nc'; b.type = 'button';
  function label() { b.textContent = T().btn; }
  setInterval(label, 1500); label(); document.body.appendChild(b);
  b.onclick = function () {
    var t = T(); var now = new Date(); var pad = function (n) { return String(n).padStart(2, '0'); };
    var w = document.createElement('div'); w.className = 'pr-ncm';
    w.innerHTML = '<div class="pr-ncb" role="dialog" aria-label="' + esc(t.t) + '"><h3>' + esc(t.t) + '</h3><span>' + esc(t.p) + '</span>' +
      '<label>' + esc(t.phone) + '<input id="nc_ph" type="tel" inputmode="tel" placeholder="+995 5__ ___ ___"></label>' +
      '<label>' + esc(t.name) + '<input id="nc_nm"></label>' +
      '<label>' + esc(t.when) + '<input id="nc_w" value="' + pad(now.getDate()) + '.' + pad(now.getMonth() + 1) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '"></label>' +
      '<label>' + esc(t.det) + '<textarea id="nc_d" rows="3"></textarea></label><div id="nc_m" style="font-weight:700"></div>' +
      '<button class="y" id="nc_s">' + esc(t.send) + '</button><button class="o" id="nc_c">' + esc(t.close) + '</button></div>';
    document.body.appendChild(w);
    var close = function () { w.remove(); };
    w.addEventListener('click', function (e) { if (e.target === w) close(); });
    w.querySelector('#nc_c').onclick = close;
    w.querySelector('#nc_s').onclick = function () {
      var btn = this; btn.disabled = true;
      fetch('/api/public/nocheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'nocheck', phone: w.querySelector('#nc_ph').value, name: w.querySelector('#nc_nm').value, happened: w.querySelector('#nc_w').value, details: w.querySelector('#nc_d').value }) })
        .then(function (r) { return r.json().then(function (j) { return [r.ok, j]; }); })
        .then(function (x) { if (!x[0]) throw new Error(x[1].message || t.err);
          w.querySelector('.pr-ncb').innerHTML = '<h3>✓</h3><span style="font-size:17px;font-weight:700">' + esc(t.ok) + '</span><button class="y">' + esc(t.close) + '</button>'; w.querySelector('.pr-ncb button').onclick = close; })
        .catch(function (e) { btn.disabled = false; w.querySelector('#nc_m').textContent = t.err; });
    };
  };
})();
/* ───── «Мой заказ»: открыть текущий заказ или найти его по телефону и номеру ───── */
(function () {
  var TX = {
    ru: { btn: 'Мой заказ', t: 'Найти мой заказ', p: 'Введите телефон и имя, которые указывали при заказе. Номер заказа — если помните.', ph: 'Телефон', nm: 'Имя, на которое заказывали', id: 'Номер заказа (если помните)', go: 'Найти', c: 'Закрыть', err: 'Не получилось — проверьте интернет', none: 'Активного заказа на этом телефоне нет' },
    en: { btn: 'My order', t: 'Find my order', p: 'Enter the phone and name you used for the order. Order number — if you remember it.', ph: 'Phone', nm: 'Name on the order', id: 'Order number (optional)', go: 'Find', c: 'Close', err: 'Something went wrong — check your connection', none: 'No active order on this device' },
    ka: { btn: 'ჩემი შეკვეთა', t: 'ჩემი შეკვეთის პოვნა', p: 'შეიყვანეთ ტელეფონი და სახელი, რომლითაც შეუკვეთეთ. შეკვეთის ნომერი — თუ გახსოვთ.', ph: 'ტელეფონი', nm: 'სახელი შეკვეთაზე', id: 'შეკვეთის ნომერი (თუ გახსოვთ)', go: 'მოძებნა', c: 'დახურვა', err: 'ვერ მოხერხდა — შეამოწმეთ ინტერნეტი', none: 'აქტიური შეკვეთა არ არის' }
  };
  function T() { return TX[window.__PR_LANG] || TX.ka; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function track() { try { return JSON.parse(localStorage.getItem('pr_track') || 'null'); } catch (e) { return null; } }
  var st = document.createElement('style');
  st.textContent = '.pr-my{position:fixed;left:12px;bottom:14px;z-index:40;border:0;border-radius:999px;padding:10px 14px;font:800 14px Inter,"Noto Sans Georgian",sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2);background:#2A1D13;color:#FDC134}' +
    '.pr-my.on{background:#FDC134;color:#2A1D13;animation:prpulse 1.6s infinite}@keyframes prpulse{50%{transform:scale(1.06)}}' +
    '@media(max-width:820px){.pr-my{bottom:86px;font-size:13px;padding:9px 12px}}' +
    '.pr-mym{position:fixed;inset:0;z-index:100;background:rgba(42,29,19,.55);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.pr-myb{background:#FBF5EA;color:#2A1D13;border-radius:22px;max-width:420px;width:100%;padding:20px;display:flex;flex-direction:column;gap:10px;font:500 15px Inter,"Noto Sans Georgian",sans-serif}' +
    '.pr-myb h3{margin:0;font-size:20px}.pr-myb input{height:46px;border-radius:12px;border:1px solid #DCC7A5;padding:0 12px;font:600 16px Inter,sans-serif;background:#fff}' +
    '.pr-myb button{height:48px;border-radius:14px;border:0;font:800 15px Inter,"Noto Sans Georgian",sans-serif;cursor:pointer}.pr-myb .y{background:#FDC134;color:#2A1D13}.pr-myb .o{background:transparent;border:1px solid #2A1D13;color:#2A1D13}';
  document.head.appendChild(st);
  var b = document.createElement('button'); b.className = 'pr-my'; b.type = 'button';
  function upd() { var tk = track(); var on = !!(tk && tk.token); b.textContent = '📦 ' + T().btn + (tk && tk.id ? ' №' + tk.id : ''); b.classList.toggle('on', on); b.style.display = 'none'; } // теперь это вкладка «Мои заказы» в меню сайта // кнопка видна только пока есть активный заказ
  document.body.appendChild(b); upd(); setInterval(upd, 3000);
  b.onclick = window.__PR_FIND = function () {
    var tk = track();
    if (tk && tk.token && window.__PR_TRACK) { window.__PR_TRACK(tk); return; }
    var t = T(), me = {}; try { me = JSON.parse(localStorage.getItem('pr_me') || '{}') || {}; } catch (e) {}
    var w = document.createElement('div'); w.className = 'pr-mym';
    w.innerHTML = '<div class="pr-myb" role="dialog" aria-label="' + esc(t.t) + '"><h3>📦 ' + esc(t.t) + '</h3><span style="color:#5C4632">' + esc(t.p) + '</span>' +
      '<input id="my_ph" type="tel" inputmode="tel" placeholder="' + esc(t.ph) + '" value="' + esc(me.phone || '') + '"><input id="my_nm" placeholder="' + esc(t.nm) + '" value="' + esc(me.name || '') + '"><input id="my_id" inputmode="numeric" placeholder="' + esc(t.id) + '">' +
      '<span id="my_m" style="color:#C0392B;font-weight:700;min-height:18px"></span><button class="y" id="my_go">' + esc(t.go) + '</button><button class="o" id="my_c">' + esc(t.c) + '</button></div>';
    document.body.appendChild(w);
    w.onclick = function (e) { if (e.target === w) w.remove(); };
    w.querySelector('#my_c').onclick = function () { w.remove(); };
    w.querySelector('#my_go').onclick = function () {
      var btn = this; btn.disabled = true;
      fetch('/api/public/order/find', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: w.querySelector('#my_ph').value, name: w.querySelector('#my_nm').value, id: w.querySelector('#my_id').value }) })
        .then(function (r) { return r.json().then(function (j) { return [r.ok, j]; }); })
        .then(function (x) { btn.disabled = false; if (!x[0]) { w.querySelector('#my_m').textContent = x[1].message || t.err; return; }
          var tk2 = { token: x[1].token, id: x[1].id, mode: x[1].mode, count: 0 }; try { localStorage.setItem('pr_track', JSON.stringify(tk2)); } catch (e) {}
          w.remove(); upd(); if (window.__PR_TRACK) window.__PR_TRACK(tk2); })
        .catch(function () { btn.disabled = false; w.querySelector('#my_m').textContent = t.err; });
    };
  };
})();
/* ───── Полоса комбо: стрелки ‹ › и прокрутка колесом мыши (на компьютере карточки не обрезаются) ───── */
(function () {
  var st = document.createElement('style');
  st.textContent = '.pr-combos{position:relative}.pr-carr{position:absolute;top:50%;z-index:6;width:46px;height:46px;border-radius:999px;border:0;background:#FDC134;color:#2A1D13;font:900 24px Inter,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}' +
    '.pr-carr.l{left:6px}.pr-carr.r{right:6px}.pr-carr[hidden]{display:none}@media(hover:none){.pr-carr{display:none}}';
  document.head.appendChild(st);
  function setup(sec) {
    var row = sec.querySelector('.pr-cstrip'); if (!row || row.__pr) return; row.__pr = 1;
    sec.querySelectorAll('.pr-carr').forEach(function (x) { x.remove(); });
    var l = document.createElement('button'), r = document.createElement('button');
    l.className = 'pr-carr l'; r.className = 'pr-carr r'; l.type = r.type = 'button'; l.textContent = '‹'; r.textContent = '›'; l.setAttribute('aria-label', '←'); r.setAttribute('aria-label', '→');
    sec.appendChild(l); sec.appendChild(r);
    var step = function () { return Math.max(280, row.clientWidth * 0.8); };
    l.onclick = function () { row.scrollBy({ left: -step(), behavior: 'smooth' }); };
    r.onclick = function () { row.scrollBy({ left: step(), behavior: 'smooth' }); };
    var upd = function () { var max = row.scrollWidth - row.clientWidth - 4; l.hidden = row.scrollLeft <= 4; r.hidden = max <= 0 || row.scrollLeft >= max;
      var rr = row.getBoundingClientRect(), sr = sec.getBoundingClientRect(); l.style.top = r.style.top = (rr.top - sr.top + rr.height / 2 - 23) + 'px'; };
    row.addEventListener('scroll', upd, { passive: true }); window.addEventListener('resize', upd); upd(); setTimeout(upd, 400);
    row.addEventListener('wheel', function (e) { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { var before = row.scrollLeft; row.scrollLeft += e.deltaY; if (row.scrollLeft !== before) e.preventDefault(); } }, { passive: false });
  }
  setInterval(function () { document.querySelectorAll('.pr-combos').forEach(setup); }, 700);
})();
/* Esc закрывает карточку товара */
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var x = document.querySelector('.pr-itemx'); if (x) x.click(); } });
/* Тестовый режим нового сайта (27.11 – 10.12.2026): полоса сверху + один раз за визит окно «лучше позвоните» */
(function () {
  var END = Date.parse('2026-12-11T00:00:00+04:00'); if (Date.now() >= END) return;
  var lang = /^\/ru(\/|$)/.test(location.pathname) ? 'ru' : /^\/en(\/|$)/.test(location.pathname) ? 'en' : 'ka';
  var T = {
    ru: { bar: 'Новый сайт работает в тестовом режиме до 10 декабря. Чтобы заказ точно приняли — позвоните нам.', call: 'Позвонить', h: 'Новый сайт — тестовый режим', p: 'С 27 ноября по 10 декабря сайт работает в тестовом режиме. Заказ на сайте может не сразу дойти до нас — надёжнее всего позвонить или написать в WhatsApp, и мы сразу всё примем.', wa: 'WhatsApp', ok: 'Понятно, продолжить на сайте' },
    en: { bar: 'Our new website is in test mode until 10 December. To make sure we get your order, please call us.', call: 'Call', h: 'New website — test mode', p: 'From 27 November to 10 December the website runs in test mode. An online order may not reach us right away — the most reliable way is to call or message us on WhatsApp, and we will take your order at once.', wa: 'WhatsApp', ok: 'Got it, continue on the website' },
    ka: { bar: 'ახალი საიტი 10 დეკემბრამდე სატესტო რეჟიმშია. შეკვეთისთვის უმჯობესია დაგვირეკოთ.', call: 'დარეკვა', h: 'ახალი საიტი — სატესტო რეჟიმი', p: '27 ნოემბრიდან 10 დეკემბრამდე საიტი სატესტო რეჟიმში მუშაობს. საიტზე შეკვეთა შეიძლება მაშინვე არ მოგვივიდეს — ყველაზე საიმედოა დაგვირეკოთ ან მოგვწეროთ WhatsApp-ში.', wa: 'WhatsApp', ok: 'გასაგებია, საიტზე გაგრძელება' } }[lang];
  var TEL = 'tel:+995514888800', WA = 'https://wa.me/995514888800';
  var css = '.pr-test{position:sticky;top:0;z-index:2147483000;background:#2A1D13;color:#FFE7A8;font:600 14px/1.35 Inter,"Noto Sans Georgian",system-ui,sans-serif;padding:8px 12px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;text-align:center}' +
    '.pr-test a{background:#F5B82E;color:#2A1D13;text-decoration:none;font-weight:800;border-radius:999px;padding:6px 14px;white-space:nowrap}' +
    '.pr-tm{position:fixed;inset:0;z-index:2147483001;background:rgba(20,12,6,.6);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.pr-tm>div{background:#FBF5EA;color:#2A1D13;border-radius:22px;max-width:420px;width:100%;padding:22px;font:15px/1.5 Inter,"Noto Sans Georgian",system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
    '.pr-tm h3{margin:0 0 8px;font-size:20px}.pr-tm .bt{display:block;text-align:center;text-decoration:none;font-weight:800;border-radius:14px;padding:13px;margin-top:10px;border:0;width:100%;font-size:16px;cursor:pointer;font-family:inherit}';
  function add() {
    if (!document.body || document.querySelector('.pr-test')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var b = document.createElement('div'); b.className = 'pr-test'; b.setAttribute('role', 'status');
    b.innerHTML = '<span>🧪 ' + T.bar + '</span><a href="' + TEL + '">📞 ' + T.call + ' 514 88 88 00</a>';
    document.body.insertBefore(b, document.body.firstChild);
    var seen = false; try { seen = sessionStorage.getItem('pr_test_seen') === '1'; } catch (e) {}
    if (seen || /bot|crawl|spider|lighthouse/i.test(navigator.userAgent)) return;
    var m = document.createElement('div'); m.className = 'pr-tm';
    m.innerHTML = '<div><h3>🧪 ' + T.h + '</h3><p style="margin:0">' + T.p + '</p>' +
      '<a class="bt" style="background:#F5B82E;color:#2A1D13" href="' + TEL + '">📞 ' + T.call + ' +995 514 88 88 00</a>' +
      '<a class="bt" style="background:#25D366;color:#fff" href="' + WA + '" target="_blank" rel="noopener">💬 ' + T.wa + '</a>' +
      '<button class="bt" style="background:transparent;color:#7A6450;font-weight:600" type="button">' + T.ok + '</button></div>';
    m.addEventListener('click', function (e) { if (e.target === m || e.target.tagName === 'BUTTON') { m.remove(); try { sessionStorage.setItem('pr_test_seen', '1'); } catch (x) {} } });
    document.body.appendChild(m);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();

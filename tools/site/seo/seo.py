# -*- coding: utf-8 -*-
# SEO для pizzaroom.ge: мета-теги на 3 языках, schema.org, текст для поисковиков в #app (заменяется приложением при запуске)
import json, html as H
SITE = 'https://pizzaroom.ge'
PIZZAS = [  # id, ka, ru, en, состав (ru), состав (en), цена ₾
 ('carb','კარბონარა','Карбонара','Carbonara','сливочный соус, бекон, моцарелла','cream sauce, bacon, mozzarella',29),
 ('pep','პეპერონი','Пепперони','Pepperoni','томатный соус, моцарелла, пепперони','tomato sauce, mozzarella, pepperoni',25),
 ('pepgrill','პეპერონი გრილი','Пепперони гриль','Grilled pepperoni','пепперони, овощи гриль, моцарелла','pepperoni, grilled vegetables, mozzarella',27),
 ('chorizo','პეპერონი ჩორიზო','Пепперони чоризо','Pepperoni chorizo','пепперони, чоризо, моцарелла','pepperoni, chorizo, mozzarella',25),
 ('diablo','პეპერონი ჰალაპენიო','Пепперони халапеньо','Pepperoni jalapeño','пепперони, халапеньо, моцарелла','pepperoni, jalapeño, mozzarella',26),
 ('marg','მარგარიტა','Маргарита','Margherita','томатный соус, моцарелла, базилик','tomato sauce, mozzarella, basil',25),
 ('hawaii','ჰავაი','Гавайская','Hawaiian','ветчина, ананас, моцарелла','ham, pineapple, mozzarella',26),
 ('bbq','ბარბექიუ','Барбекю','BBQ','соус барбекю, колбаски, лук, моцарелла','BBQ sauce, sausages, onion, mozzarella',27),
 ('chbbq','ბარბექიუ ქათმით','Курица барбекю','Chicken BBQ','соус барбекю, курица, лук, моцарелла','BBQ sauce, chicken, onion, mozzarella',27),
 ('ranch','ქათმის რანჩი','Цыплёнок ранч','Chicken ranch','соус ранч, курица, моцарелла','ranch sauce, chicken, mozzarella',26),
 ('five','5 ყველით','5 сыров','5 cheese','пять сыров на сливочной основе','five cheeses on a cream base',27),
 ('premium','პრემიუმი','Премиум','Premium','фирменная пицца','signature pizza',32),
 ('salmon','ორაგულით','С лососем','Salmon','лосось, сливочный сыр, моцарелла','salmon, cream cheese, mozzarella',32),
 ('burger','პიცა ბურგერი','Пицца-бургер','Burger pizza','говяжий фарш, соус бургер, огурцы, моцарелла','minced beef, burger sauce, pickles, mozzarella',29),
]
T = {
 'ka': ('პიცა ბათუმში მიტანით — Pizza Room · Пицца в Батуми · Pizza Batumi',
        'Pizza Room — ცხელი იტალიური პიცა ბათუმში 2018 წლიდან. შეუკვეთეთ ონლაინ: მიტანა ბათუმში 35–40 წუთში ან წაღება Batumi Mall-დან. Пицца в Батуми с доставкой. Pizza delivery Batumi.'),
 'ru': ('Пицца в Батуми с доставкой — Pizza Room, Batumi Mall',
        'Pizza Room — горячая итальянская пицца в Батуми с 2018 года. Закажите онлайн: доставка пиццы по Батуми за 35–40 минут или самовывоз из Batumi Mall. Пицца 33 см от 25 ₾, комбо, напитки.'),
 'en': ('Pizza delivery in Batumi — Pizza Room, Batumi Mall',
        'Pizza Room — hot Italian pizza in Batumi since 2018. Order online: pizza delivery across Batumi in 35–40 minutes or pick up at Batumi Mall. 33 cm pizza from 25 GEL, combos, drinks.'),
}
LOC = {'ka': 'ka_GE', 'ru': 'ru_RU', 'en': 'en_US'}
def url_of(l): return SITE + '/' if l == 'ka' else SITE + '/' + l + '/'

YM = """<script>(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r)return;}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js','ym');ym(50194066,'init',{clickmap:true,trackLinks:true,accurateTrackBounce:true});</script><noscript><div><img src="https://mc.yandex.ru/watch/50194066" style="position:absolute;left:-9999px" alt=""></div></noscript>"""

def head():
    t, d = T['ka']
    out = ['<meta name="google-site-verification" content="OVrz1XIXhZk1PymRJWYxzijz_QN6MrxeNNkcKdVLz_8">', '<meta name="yandex-verification" content="d02d5d2470bfa713">', '<meta name="yandex-verification" content="a4ba6bc3ac207bd0">',
           f'<meta name="robots" content="index, follow, max-image-preview:large">',
           f'<link rel="canonical" href="{SITE}/" id="seo-canon">']
    for l in ('ka', 'ru', 'en'): out.append(f'<link rel="alternate" hreflang="{l}" href="{url_of(l)}">')
    out.append(f'<link rel="alternate" hreflang="x-default" href="{SITE}/">')
    out += [f'<meta property="og:type" content="restaurant">', f'<meta property="og:site_name" content="Pizza Room">',
            f'<meta property="og:title" content="{H.escape(t)}" id="seo-ogt">', f'<meta property="og:description" content="{H.escape(d)}" id="seo-ogd">',
            f'<meta property="og:url" content="{SITE}/" id="seo-ogu">', f'<meta property="og:image" content="{SITE}/img/og-1200.jpg">',
            '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
            f'<meta property="og:locale" content="ka_GE" id="seo-ogl">', '<meta property="og:locale:alternate" content="ru_RU">', '<meta property="og:locale:alternate" content="en_US">',
            '<meta name="twitter:card" content="summary_large_image">', f'<meta name="twitter:image" content="{SITE}/img/og-1200.jpg">',
            '<meta name="geo.region" content="GE-AJ">', '<meta name="geo.placename" content="Batumi">', '<meta name="geo.position" content="41.64318;41.61974">', '<meta name="ICBM" content="41.64318, 41.61974">',
            '<link rel="apple-touch-icon" href="/apple-touch-icon-v2.png">']
    ld = {
      '@context': 'https://schema.org',
      '@graph': [
        {'@type': 'Restaurant', '@id': SITE + '/#restaurant', 'name': 'Pizza Room', 'alternateName': ['Пицца Рум', 'პიცა რუმი', 'Pizza Room Batumi'],
         'description': T['en'][1], 'url': SITE + '/', 'image': [SITE + '/img/og-1200.jpg', SITE + '/img/hero-square-720.webp'], 'logo': SITE + '/icon-v2-512.png',
         'telephone': '+995514888800', 'priceRange': '25–32 GEL', 'currenciesAccepted': 'GEL', 'paymentAccepted': 'Cash, Credit Card',
         'servesCuisine': ['Pizza', 'Italian'], 'acceptsReservations': False, 'foundingDate': '2018',
         'address': {'@type': 'PostalAddress', 'streetAddress': 'Zurab Gorgiladze St 88, Batumi Mall', 'addressLocality': 'Batumi', 'addressRegion': 'Adjara', 'postalCode': '6010', 'addressCountry': 'GE'},
         'geo': {'@type': 'GeoCoordinates', 'latitude': 41.64318, 'longitude': 41.61974},
         'hasMap': 'https://www.google.com/maps?q=41.64318,41.61974',
         'openingHoursSpecification': [{'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], 'opens': '11:00', 'closes': '23:00'}],
         'areaServed': {'@type': 'City', 'name': 'Batumi'},
         'hasMenu': {'@type': 'Menu', 'name': 'Pizza Room menu', 'url': SITE + '/', 'hasMenuSection': [{'@type': 'MenuSection', 'name': 'Pizza 33 cm',
            'hasMenuItem': [{'@type': 'MenuItem', 'name': p[3], 'alternateName': [p[2], p[1]], 'description': p[5], 'offers': {'@type': 'Offer', 'price': str(p[6]), 'priceCurrency': 'GEL'}} for p in PIZZAS]}]},
         'potentialAction': {'@type': 'OrderAction', 'target': {'@type': 'EntryPoint', 'urlTemplate': SITE + '/', 'inLanguage': ['ka', 'ru', 'en'], 'actionPlatform': ['http://schema.org/DesktopWebPlatform', 'http://schema.org/MobileWebPlatform']}, 'deliveryMethod': ['http://purl.org/goodrelations/v1#DeliveryModeOwnFleet', 'http://purl.org/goodrelations/v1#DeliveryModePickUp']}},
        {'@type': 'WebSite', '@id': SITE + '/#website', 'url': SITE + '/', 'name': 'Pizza Room', 'inLanguage': ['ka', 'ru', 'en'], 'publisher': {'@id': SITE + '/#restaurant'}},
      ]}
    out.append(YM)
    out.append('<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False, separators=(',', ':')) + '</script>')
    return '\n'.join(out)

def body():
    # текст для поисковиков: тот же смысл, что на странице; приложение заменяет его при запуске (host.replaceChildren)
    li = lambda p, l: f'<li><b>{H.escape(p[{"ka":1,"ru":2,"en":3}[l]])}</b> — {H.escape(p[4] if l != "en" else p[5]) if l != "ka" else H.escape(p[2] + " / " + p[3])}, 33 სმ · {p[6]} ₾</li>' if l == 'ka' else f'<li><b>{H.escape(p[{"ka":1,"ru":2,"en":3}[l]])}</b> — {H.escape(p[4] if l == "ru" else p[5])}, 33 {"см" if l == "ru" else "cm"} · {p[6]} ₾</li>'
    S = {
     'ka': ('პიცა ბათუმში — Pizza Room', 'ცხელი იტალიური პიცა Batumi Mall-ში 2018 წლიდან. შეუკვეთეთ საიტზე: მიტანა ბათუმში 35–40 წუთში ან თავად წაღება Batumi Mall-დან (ზურაბ გორგილაძის ქ. 88). ყოველდღე 11:00–23:00. ტელ.: +995 514 88 88 00.', 'პიცის მენიუ'),
     'ru': ('Пицца в Батуми — Pizza Room', 'Горячая итальянская пицца в Batumi Mall с 2018 года. Закажите на сайте: доставка пиццы по Батуми за 35–40 минут или самовывоз из Batumi Mall (ул. Зураба Горгиладзе, 88). Каждый день 11:00–23:00. Телефон: +995 514 88 88 00.', 'Меню пиццы'),
     'en': ('Pizza in Batumi — Pizza Room', 'Hot Italian pizza at Batumi Mall since 2018. Order online: pizza delivery across Batumi in 35–40 minutes or pick-up at Batumi Mall (88 Zurab Gorgiladze St). Open daily 11:00–23:00. Phone: +995 514 88 88 00.', 'Pizza menu'),
    }
    parts = ['<div id="seo" style="max-width:520px;margin:0 auto;padding:16px;font:15px/1.5 Inter,sans-serif;color:#2A1D13">']
    for l in ('ka', 'ru', 'en'):
        h1, p, h2 = S[l]
        tag = 'h1' if l == 'ka' else 'h2'
        parts.append(f'<section lang="{l}"><{tag}>{H.escape(h1)}</{tag}><p>{H.escape(p)}</p><h3>{H.escape(h2)}</h3><ul>' + ''.join(li(x, l) for x in PIZZAS) + '</ul></section>')
    parts.append('<p><a href="/terms">Terms</a> · <a href="/refund">Refund</a> · <a href="/privacy">Privacy</a> · <a href="/menu">მენიუ</a> · <a href="/ru/">Русский</a> · <a href="/en/">English</a> · <a href="/">ქართული</a></p></div>')
    return ''.join(parts)

def js():
    # язык страницы для поисковиков и людей: ?lang=ru / ?lang=en, а также заголовок и описание на языке, который выбран на сайте
    TT = {l: {'t': T[l][0], 'd': T[l][1], 'u': url_of(l), 'o': LOC[l]} for l in T}
    return ('<script>window.__PR_SEO=(function(){var T=' + json.dumps(TT, ensure_ascii=False) + ',last="";'
            'function set(id,attr,v){var e=document.getElementById(id);if(e)e.setAttribute(attr,v);}'
            'return function(l){if(!T[l]||l===last)return;last=l;var x=T[l];document.documentElement.lang=l;document.title=x.t;'
            'var m=document.querySelector(\'meta[name="description"]\');if(m)m.setAttribute("content",x.d);'
            '};})();</script>')

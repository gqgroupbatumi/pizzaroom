// Pizza Room — запуск сервера на Cloudflare одним скриптом.
// Запускается из ZAPUSK-SERVERA.bat. Можно запускать повторно: сделанные шаги пропускаются.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPin } from '../src/worker.js';

const STATE = '.setup-state.json';
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const rl = readline.createInterface({ input: stdin, output: stdout });
const say = (s) => console.log('\n' + s);

function wrangler(args, capture) {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', shell: true, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (capture) process.stdout.write(out);
  return { ok: r.status === 0, out };
}
function must(res, what) { if (!res.ok) { say('ОШИБКА на шаге «' + what + '». Сфотографируйте экран и пришлите в чат Claude.'); process.exit(1); } return res; }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

say('══════ Pizza Room: запуск сервера ══════');

// 1. Вход в Cloudflare
if (!state.login) {
  say('ШАГ 1 из 6. Вход в Cloudflare. Откроется браузер — войдите в свой аккаунт Cloudflare и нажмите «Allow».');
  must(wrangler(['login']), 'вход в Cloudflare');
  state.login = true; saveState();
} else say('ШАГ 1 из 6. Вход в Cloudflare — уже сделан.');

// 2. База данных
let toml = readFileSync('wrangler.toml', 'utf8');
if (toml.includes('ВСТАВИТЬ_ПОСЛЕ_СОЗДАНИЯ_БАЗЫ')) {
  say('ШАГ 2 из 6. Создаю базу данных pizzaroom...');
  let res = wrangler(['d1', 'create', 'pizzaroom'], true);
  let id = (res.out.match(/database_id\s*[=:]\s*"?([0-9a-f-]{36})/i) || [])[1] || (res.ok ? (res.out.match(UUID) || [])[0] : null);
  if (!id) {
    say('База, похоже, уже есть — ищу её...');
    const list = wrangler(['d1', 'list', '--json'], true);
    try { const db = JSON.parse(list.out.slice(list.out.indexOf('['))).find((d) => d.name === 'pizzaroom'); id = db && (db.uuid || db.database_id); } catch (e) { }
  }
  if (!id) { say('Не удалось получить номер базы. Пришлите фото экрана в чат Claude.'); process.exit(1); }
  toml = toml.replace('ВСТАВИТЬ_ПОСЛЕ_СОЗДАНИЯ_БАЗЫ', id); writeFileSync('wrangler.toml', toml);
  say('База создана: ' + id);
} else say('ШАГ 2 из 6. База данных — уже создана.');

// 3. Таблицы и защита истории
if (!state.schema) {
  say('ШАГ 3 из 6. Создаю таблицы и защиту от исправления истории...');
  must(wrangler(['d1', 'execute', 'pizzaroom', '--remote', '--file=schema.sql']), 'таблицы');
  state.schema = true; saveState();
} else say('ШАГ 3 из 6. Таблицы — уже созданы.');

// 4. Начальное меню
if (!state.seed) {
  say('ШАГ 4 из 6. Загружаю начальное меню, цены и рецепты (цены потом поменяете в программе)...');
  must(wrangler(['d1', 'execute', 'pizzaroom', '--remote', '--file=seed.sql']), 'меню');
  state.seed = true; saveState();
} else say('ШАГ 4 из 6. Меню — уже загружено.');

// 5. Владелец
if (!state.owner) {
  say('ШАГ 5 из 6. Создаём владельца — это вы. PIN будет храниться в зашифрованном виде.');
  const name = (await rl.question('Ваше имя: ')).trim() || 'Владелец';
  let pin = '';
  while (true) {
    pin = (await rl.question('Придумайте PIN владельца (4–8 цифр, не 1111/1234): ')).trim();
    if (!/^\d{4,8}$/.test(pin) || ['1111', '1234', '0000', '2222', '9999'].includes(pin)) { console.log('Нужны 4–8 цифр и не простой PIN.'); continue; }
    const again = (await rl.question('Повторите PIN: ')).trim();
    if (again !== pin) { console.log('PIN не совпал, ещё раз.'); continue; }
    break;
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await hashPin(pin, salt);
  writeFileSync('owner.tmp.sql', `INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES ('${name.replace(/'/g, "''")}', 'owner', '${hash}', '${salt}');`);
  const res = wrangler(['d1', 'execute', 'pizzaroom', '--remote', '--file=owner.tmp.sql']);
  try { unlinkSync('owner.tmp.sql'); } catch (e) { }
  must(res, 'владелец');
  state.owner = name; saveState();
  say('Владелец «' + name + '» создан. Сотрудников (менеджера, кассиров) вы добавите в программе.');
} else say('ШАГ 5 из 6. Владелец — уже создан (' + state.owner + ').');

// 6. Выкладка
say('ШАГ 6 из 6. Выкладываю сервер и программу кассы в интернет...');
const dep = must(wrangler(['deploy'], true), 'выкладка');
const url = (dep.out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
state.url = url || state.url; saveState();
rl.close();

say('══════ ГОТОВО ══════');
if (url) say('Адрес вашей системы: ' + url);
say(`Что дальше:
 1) Откройте адрес в Google Chrome или Microsoft Edge.
 2) Справа в адресной строке нажмите значок «Установить приложение» — на компьютере появится Pizza Room со своим значком.
 3) Напишите в чат Claude: «сервер запущен» и адрес — дальше подключаем кассу к базе на сервере.`);

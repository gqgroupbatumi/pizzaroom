// Создаёт SQL для первого владельца: node scripts/make-owner.mjs "Имя" 1234 > owner.sql
import { hashPin } from '../src/worker.js';
const [name, pin] = process.argv.slice(2);
if (!name || !pin) { console.error('Использование: node scripts/make-owner.mjs "Имя" PIN'); process.exit(1); }
const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const hash = await hashPin(pin, salt);
console.log(`INSERT INTO staff (name, role, pin_hash, pin_salt) VALUES ('${name.replace(/'/g, "''")}', 'owner', '${hash}', '${salt}');`);

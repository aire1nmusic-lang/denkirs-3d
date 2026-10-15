// Каталог мебели и декора для 3D-редактора: бесплатные модели Poly Haven (лицензия CC0 — можно использовать без ограничений).
// Скачивает glTF 1k, ужимает (текстуры ≤512, WebP, геометрия meshopt) в один .glb, кладёт миниатюру и каталог f/catalog.json.
// Запуск: node scripts/furniture.mjs [--max 400] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const OUT = 'f';
const args = process.argv.slice(2);
const MAX = +(args.includes('--max') ? args[args.indexOf('--max') + 1] : 400);
const force = args.includes('--force');
// категории Poly Haven → наши разделы каталога
const BAD = /^(lighting|weapons|firearms|food|trees|rocks|grass|ground cover|structures|buildings|ships|creature|rigged|tools|industrial|instrument)$/;
const NAME = [[/sofa|couch|armchair|chair|bench|stool|ottoman|pouf/i, 'Сиденья'], [/table|desk/i, 'Столы'], [/bed\b|bed_/i, 'Кровати'], [/shelf|shelves|cabinet|wardrobe|drawer|dresser|bookcase|cupboard|chest|sideboard/i, 'Хранение']];
const CAT = [['seating', 'Сиденья'], ['table', 'Столы'], ['bed', 'Кровати'], ['shelves', 'Хранение'], ['appliances', 'Кухня и техника'], ['electronics', 'Техника'], ['potted plants', 'Растения'], ['plants', 'Растения'], ['vases', 'Декор'], ['wall decoration', 'Декор'], ['decorative', 'Декор'], ['books', 'Декор'], ['dishes', 'Декор'], ['office', 'Мебель'], ['furniture', 'Мебель'], ['containers', 'Декор']];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, json, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'denkirs-3d-catalog (configurator)' } }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return json ? await r.json() : Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}
function catOf(a) { const cs = a.categories || []; if (cs.some(c => BAD.test(c))) return null; const nm = (a.name || '') + ' ' + Object.keys(a).join(' '); if (cs.includes('furniture') || cs.includes('office')) for (const [re, c] of NAME) if (re.test(a.name || '')) return c; for (const [k, c] of CAT) if (cs.includes(k)) return c; return null; }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const catPath = path.join(OUT, 'catalog.json');
  const old = fs.existsSync(catPath) ? JSON.parse(fs.readFileSync(catPath, 'utf8')) : { items: [] };
  const have = new Map(old.items.map(x => [x.id, x]));
  const all = await get('https://api.polyhaven.com/assets?t=models', true);
  const ids = Object.keys(all).filter(id => catOf(all[id])).sort((a, b) => (all[b].download_count || 0) - (all[a].download_count || 0)).slice(0, MAX);
  console.log('моделей Poly Haven:', Object.keys(all).length, '· подходит для интерьера:', ids.length);
  const items = []; let ok = 0, fail = 0;
  for (const id of ids) {
    const a = all[id], cat = catOf(a);
    if (!force && have.has(id) && fs.existsSync(path.join(OUT, id + '.glb'))) { items.push(Object.assign({}, have.get(id), { cat })); ok++; continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
    try {
      const files = await get('https://api.polyhaven.com/files/' + id, true);
      const g = files && files.gltf && (files.gltf['1k'] || files.gltf['2k']); if (!g || !g.gltf) throw new Error('нет glTF');
      const main = g.gltf, mainName = path.basename(new URL(main.url).pathname);
      fs.writeFileSync(path.join(dir, mainName), await get(main.url));
      for (const [rel, f] of Object.entries(main.include || {})) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, await get(f.url)); }
      const out = path.join(OUT, id + '.glb');
      execFileSync('npx', ['--no-install', 'gltf-transform', 'optimize', path.join(dir, mainName), out, '--texture-size', '512', '--texture-compress', 'webp', '--compress', 'meshopt', '--simplify', 'true', '--simplify-ratio', '0.5'], { stdio: 'pipe', timeout: 300000 });
      const thumb = await get('https://cdn.polyhaven.com/asset_img/thumbs/' + id + '.png?width=256&height=256');
      if (thumb) fs.writeFileSync(path.join(OUT, id + '.png'), thumb);
      const kb = Math.round(fs.statSync(out).size / 1024);
      items.push({ id, name: a.name, cat, kb, by: (Object.keys(a.authors || {})[0] || ''), lic: 'CC0', src: 'polyhaven.com/a/' + id });
      ok++; console.log('ok', id, cat, kb + ' КБ');
    } catch (e) { fail++; console.log('ошибка', id, (e && (e.stderr ? String(e.stderr).slice(0, 200) : e.message)) || e); }
    fs.rmSync(dir, { recursive: true, force: true });
    if (items.length % 20 === 0) fs.writeFileSync(catPath, JSON.stringify({ src: 'Poly Haven, CC0', items }, null, 0));
  }
  fs.writeFileSync(catPath, JSON.stringify({ src: 'Poly Haven, CC0', items }, null, 0));
  console.log(`каталог: ${ok} моделей, ${fail} ошибок, ${Math.round(items.reduce((s, x) => s + (x.kb || 0), 0) / 1024)} МБ`);
}
main().catch(e => { console.error(e); process.exit(1); });

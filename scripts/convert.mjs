// Конвертер 3D-моделей DENKIRS для конфигуратора треков.
// Берёт архивы с docs.denkirs.ru/3d/Denkirs/ (OBJ внутри .rar/.zip), упрощает сетку и пишет компактный .dkm + index.json.
// Запуск: node scripts/convert.mjs [lamps.txt] [--only DK8002,DK8004] [--force]
// Формат .dkm v1 (little-endian):
//   Float32[8]: nV, nI, minX, minY, minZ, maxX, maxY, maxZ   (мм, оси как в OBJ из 3ds Max: Y — вверх)
//   Int16[nV*3]: позиции, квантованы в габарит (-32767..32767), затем выравнивание до 4 байт
//   Uint16[nI] (или Uint32, если nV > 65535): индексы треугольников
import fs from 'node:fs';
import path from 'node:path';
import { createExtractorFromData } from 'node-unrar-js';
import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';

const SRC = 'https://docs.denkirs.ru/3d/Denkirs/';
const SRC_IES = 'https://docs.denkirs.ru/ies/Denkirs/';
const OUT = 'm';
const TARGET = 2500;            // треугольников на модель
const args = process.argv.slice(2);
const listFile = args.find(a => !a.startsWith('--')) || 'lamps.txt';
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean) : [];
const force = args.includes('--force');
const PREF = ['BK', 'WH', 'WB', 'BG', 'DG', 'SB', 'DN'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}

function pickArchive(base, names) {
  const c = names.filter(n => n.split('.')[0].split('-')[0] === base && /\.(rar|zip)$/i.test(n));
  if (!c.length) return null;
  const sfx = n => n.replace(/\.(rar|zip)$/i, '').split('-').slice(1).join('-');
  c.sort((a, b) => { const ia = PREF.indexOf(sfx(a)), ib = PREF.indexOf(sfx(b)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.length - b.length; });
  return c[0];
}

let WASM = null;
async function fileFrom(buf, name, re) {
  if (/\.rar$/i.test(name)) {
    if (!WASM) WASM = fs.readFileSync(path.join(path.dirname(new URL(import.meta.resolve('node-unrar-js')).pathname), 'js', 'unrar.wasm'));
    const ex = await createExtractorFromData({ wasmBinary: WASM, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const out = ex.extract({ files: h => re.test(h.name) });
    const fsx = [...out.files].filter(f => f.extraction).sort((a, b) => a.fileHeader.name.length - b.fileHeader.name.length);
    return fsx[0] ? Buffer.from(fsx[0].extraction) : null;
  }
  if (/\.zip$/i.test(name)) { const z = unzipSync(new Uint8Array(buf), { filter: f => re.test(f.name) }); const k = Object.keys(z).sort((a, b) => a.length - b.length)[0]; return k ? Buffer.from(z[k]) : null; }
  return re.test(name) ? buf : null;
}
async function objFrom(buf, name) {
  if (/\.rar$/i.test(name)) {
    if (!WASM) WASM = fs.readFileSync(path.join(path.dirname(new URL(import.meta.resolve('node-unrar-js')).pathname), 'js', 'unrar.wasm'));
    const ex = await createExtractorFromData({ wasmBinary: WASM, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const out = ex.extract({ files: h => /\.obj$/i.test(h.name) });
    const fsx = [...out.files].filter(f => f.extraction).sort((a, b) => b.extraction.length - a.extraction.length);
    return fsx[0] ? Buffer.from(fsx[0].extraction).toString('utf8') : null;
  }
  const z = unzipSync(new Uint8Array(buf), { filter: f => /\.obj$/i.test(f.name) });
  const k = Object.keys(z).sort((a, b) => z[b].length - z[a].length)[0];
  return k ? Buffer.from(z[k]).toString('utf8') : null;
}

// OBJ → вершины (сварены по сетке 0,05 мм) + индексы
export function parseObj(txt) {
  const V = [], P = [], I = [], map = new Map();
  const weld = vi => { const v = V[vi]; const k = Math.round(v[0] * 20) + ',' + Math.round(v[1] * 20) + ',' + Math.round(v[2] * 20); let j = map.get(k); if (j === undefined) { j = P.length / 3; map.set(k, j); P.push(v[0], v[1], v[2]); } return j; };
  for (const line of txt.split('\n')) {
    if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) { const p = line.trim().split(/\s+/); V.push([+p[1], +p[2], +p[3]]); }
    else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
      const p = line.trim().split(/\s+/).slice(1).map(t => { const n = parseInt(t, 10); return n < 0 ? V.length + n : n - 1; });
      for (let i = 1; i + 1 < p.length; i++) { const a = weld(p[0]), b = weld(p[i]), c = weld(p[i + 1]); if (a !== b && b !== c && a !== c) I.push(a, b, c); }
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

export function simplify(m, target = TARGET) {
  let I = m.idx;
  if (I.length / 3 > target) {
    let [r] = MeshoptSimplifier.simplify(I, m.pos, 3, target * 3, 0.03, []);
    if (r.length / 3 > target * 1.5) [r] = MeshoptSimplifier.simplify(I, m.pos, 3, target * 3, 0.2, []);
    I = r;
  }
  const used = new Map(), np = [], I2 = new Uint32Array(I.length);
  for (let i = 0; i < I.length; i++) { let j = used.get(I[i]); if (j === undefined) { j = np.length / 3; used.set(I[i], j); np.push(m.pos[I[i] * 3], m.pos[I[i] * 3 + 1], m.pos[I[i] * 3 + 2]); } I2[i] = j; }
  return { pos: new Float32Array(np), idx: I2 };
}

export function encode(m) {
  const nV = m.pos.length / 3, nI = m.idx.length, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) { const v = m.pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const q = new Int16Array(nV * 3);
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) { const s = mx[k] - mn[k] || 1; q[i * 3 + k] = Math.round((m.pos[i * 3 + k] - mn[k]) / s * 65534 - 32767); }
  const head = new Float32Array([nV, nI, ...mn, ...mx]), qb = q.byteLength, pad = (4 - (qb % 4)) % 4;
  const ib = nV > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx);
  const buf = Buffer.alloc(32 + qb + pad + ib.byteLength);
  Buffer.from(head.buffer).copy(buf, 0); Buffer.from(q.buffer).copy(buf, 32); Buffer.from(ib.buffer).copy(buf, 32 + qb + pad);
  return { buf, bb: [mn, mx].map(a => a.map(v => Math.round(v * 10) / 10)), tris: nI / 3 };
}

async function main() {
  await MeshoptSimplifier.ready;
  fs.mkdirSync(OUT, { recursive: true });
  const bases = only.length ? only : fs.readFileSync(listFile, 'utf8').split(/\s+/).filter(Boolean);
  const listing = (await get(SRC)).toString('utf8');
  const names = [...new Set([...listing.matchAll(/href="([^"?/]+\.(?:rar|zip))"/gi)].map(m => decodeURIComponent(m[1])))];
  console.log('архивов на сервере:', names.length, '· нужно баз:', bases.length);
  const idxPath = path.join(OUT, 'index.json');
  const index = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
  let ok = 0, miss = 0, fail = 0;
  for (const b of bases) {
    const arc = pickArchive(b, names);
    if (!arc) { miss++; continue; }
    if (!force && index[b] && index[b].src === arc && fs.existsSync(path.join(OUT, b + '.dkm'))) { ok++; continue; }
    try {
      const buf = await get(SRC + encodeURIComponent(arc)); if (!buf) { miss++; continue; }
      const obj = await objFrom(buf, arc); if (!obj) { console.log('нет OBJ в', arc); fail++; continue; }
      const m0 = parseObj(obj), m = simplify(m0), e = encode(m);
      fs.writeFileSync(path.join(OUT, b + '.dkm'), e.buf);
      index[b] = { src: arc, tris: e.tris, bb: e.bb, kb: Math.round(e.buf.length / 1024) };
      ok++; console.log(b, arc, (m0.idx.length / 3) + ' → ' + e.tris + ' треуг.,', index[b].kb + ' КБ', JSON.stringify(e.bb));
      fs.writeFileSync(idxPath, JSON.stringify(index, null, 0));
    } catch (er) { fail++; console.log('ошибка', b, arc, er.message); }
  }
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 0));
  console.log(`модели: ${ok} есть, ${miss} без архива, ${fail} ошибок`);
  /* фотометрия IES — тот же артикул, файл как есть (текст, 5–30 КБ) */
  fs.mkdirSync('ies', { recursive: true });
  const lsI = await get(SRC_IES); const namesI = lsI ? [...new Set([...lsI.toString('utf8').matchAll(/href="([^"?/]+\.(?:rar|zip|ies))"/gi)].map(m => decodeURIComponent(m[1])))] : [];
  const iesIdx = {}; let iOk = 0;
  for (const b of bases) {
    const c = namesI.filter(n => n.split('.')[0].split('-')[0] === b); if (!c.length) continue;
    c.sort((x, y) => { const sx = PREF.indexOf(x.replace(/\.\w+$/, '').split('-').slice(1).join('-')), sy = PREF.indexOf(y.replace(/\.\w+$/, '').split('-').slice(1).join('-')); return (sx < 0 ? 99 : sx) - (sy < 0 ? 99 : sy); });
    try { const buf = await get(SRC_IES + encodeURIComponent(c[0])); if (!buf) continue; const f = await fileFrom(buf, c[0], /\.ies$/i); if (!f) continue; fs.writeFileSync(path.join('ies', b + '.ies'), f); iesIdx[b] = { src: c[0], kb: Math.round(f.length / 1024) }; iOk++; } catch (er) { console.log('IES ошибка', b, er.message); }
  }
  fs.writeFileSync(path.join('ies', 'index.json'), JSON.stringify(iesIdx));
  console.log(`IES: ${iOk} из ${bases.length}`);
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
// Конвертер 3D-моделей DENKIRS для конфигуратора треков.
// Берёт архивы с docs.denkirs.ru/3d/Denkirs/ (OBJ внутри .rar/.zip), упрощает сетку и пишет компактный .dkm + index.json.
// Запуск: node scripts/convert.mjs [lamps.txt] [--only DK8002,DK8004] [--force]
// Формат .dkm v1 (little-endian):
//   Float32[8]: nV, nI, minX, minY, minZ, maxX, maxY, maxZ   (мм, оси как в OBJ из 3ds Max: Y — вверх)
//   Int16[nV*3]: позиции, квантованы в габарит (-32767..32767), затем выравнивание до 4 байт
//   Uint16[nI] (или Uint32, если nV > 65535): индексы треугольников
import fs from 'node:fs';
import path from 'node:path';
import { createExtractorFromData } from 'node-unrar-js';
import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';

const SRC = 'https://docs.denkirs.ru/3d/Denkirs/';
const SRC_IES = 'https://docs.denkirs.ru/ies/Denkirs/';
const OUT = 'm';
const TARGET = 2500;            // треугольников на модель
const args = process.argv.slice(2);
const listFile = args.find(a => !a.startsWith('--')) || 'lamps.txt';
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const force = args.includes('--force');
const PREF = ['BK', 'WH', 'WB', 'BG', 'DG', 'SB', 'DN'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
}

function pickArchive(base, names) {
  const c = names.filter(n => n.split('.')[0].split('-')[0] === base && /\.(rar|zip)$/i.test(n));
  if (!c.length) return null;
  const sfx = n => n.replace(/\.(rar|zip)$/i, '').split('-').slice(1).join('-');
  c.sort((a, b) => { const ia = PREF.indexOf(sfx(a)), ib = PREF.indexOf(sfx(b)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.length - b.length; });
  return c[0];
}

let WASM = null;
async function fileFrom(buf, name, re) {
  if (/\.rar$/i.test(name)) {
    if (!WASM) WASM = fs.readFileSync(path.join(path.dirname(new URL(import.meta.resolve('node-unrar-js')).pathname), 'js', 'unrar.wasm'));
    const ex = await createExtractorFromData({ wasmBinary: WASM, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const out = ex.extract({ files: h => re.test(h.name) });
    const fsx = [...out.files].filter(f => f.extraction).sort((a, b) => a.fileHeader.name.length - b.fileHeader.name.length);
    return fsx[0] ? Buffer.from(fsx[0].extraction) : null;
  }
  if (/\.zip$/i.test(name)) { const z = unzipSync(new Uint8Array(buf), { filter: f => re.test(f.name) }); const k = Object.keys(z).sort((a, b) => a.length - b.length)[0]; return k ? Buffer.from(z[k]) : null; }
  return re.test(name) ? buf : null;
}
async function objFrom(buf, name) {
  if (/\.rar$/i.test(name)) {
    if (!WASM) WASM = fs.readFileSync(path.join(path.dirname(new URL(import.meta.resolve('node-unrar-js')).pathname), 'js', 'unrar.wasm'));
    const ex = await createExtractorFromData({ wasmBinary: WASM, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const out = ex.extract({ files: h => /\.obj$/i.test(h.name) });
    const fsx = [...out.files].filter(f => f.extraction).sort((a, b) => b.extraction.length - a.extraction.length);
    return fsx[0] ? Buffer.from(fsx[0].extraction).toString('utf8') : null;
  }
  const z = unzipSync(new Uint8Array(buf), { filter: f => /\.obj$/i.test(f.name) });
  const k = Object.keys(z).sort((a, b) => z[b].length - z[a].length)[0];
  return k ? Buffer.from(z[k]).toString('utf8') : null;
}

// OBJ → вершины (сварены по сетке 0,05 мм) + индексы
export function parseObj(txt) {
  const V = [], P = [], I = [], map = new Map();
  const weld = vi => { const v = V[vi]; const k = Math.round(v[0] * 20) + ',' + Math.round(v[1] * 20) + ',' + Math.round(v[2] * 20); let j = map.get(k); if (j === undefined) { j = P.length / 3; map.set(k, j); P.push(v[0], v[1], v[2]); } return j; };
  for (const line of txt.split('\n')) {
    if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) { const p = line.trim().split(/\s+/); V.push([+p[1], +p[2], +p[3]]); }
    else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
      const p = line.trim().split(/\s+/).slice(1).map(t => { const n = parseInt(t, 10); return n < 0 ? V.length + n : n - 1; });
      for (let i = 1; i + 1 < p.length; i++) { const a = weld(p[0]), b = weld(p[i]), c = weld(p[i + 1]); if (a !== b && b !== c && a !== c) I.push(a, b, c); }
    }
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(I) };
}

export function simplify(m, target = TARGET) {
  let I = m.idx;
  if (I.length / 3 > target) {
    let [r] = MeshoptSimplifier.simplify(I, m.pos, 3, target * 3, 0.03, []);
    if (r.length / 3 > target * 1.5) [r] = MeshoptSimplifier.simplify(I, m.pos, 3, target * 3, 0.2, []);
    I = r;
  }
  const used = new Map(), np = [], I2 = new Uint32Array(I.length);
  for (let i = 0; i < I.length; i++) { let j = used.get(I[i]); if (j === undefined) { j = np.length / 3; used.set(I[i], j); np.push(m.pos[I[i] * 3], m.pos[I[i] * 3 + 1], m.pos[I[i] * 3 + 2]); } I2[i] = j; }
  return { pos: new Float32Array(np), idx: I2 };
}

export function encode(m) {
  const nV = m.pos.length / 3, nI = m.idx.length, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) { const v = m.pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const q = new Int16Array(nV * 3);
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) { const s = mx[k] - mn[k] || 1; q[i * 3 + k] = Math.round((m.pos[i * 3 + k] - mn[k]) / s * 65534 - 32767); }
  const head = new Float32Array([nV, nI, ...mn, ...mx]), qb = q.byteLength, pad = (4 - (qb % 4)) % 4;
  const ib = nV > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx);
  const buf = Buffer.alloc(32 + qb + pad + ib.byteLength);
  Buffer.from(head.buffer).copy(buf, 0); Buffer.from(q.buffer).copy(buf, 32); Buffer.from(ib.buffer).copy(buf, 32 + qb + pad);
  return { buf, bb: [mn, mx].map(a => a.map(v => Math.round(v * 10) / 10)), tris: nI / 3 };
}

async function main() {
  await MeshoptSimplifier.ready;
  fs.mkdirSync(OUT, { recursive: true });
  const bases = only.length ? only : fs.readFileSync(listFile, 'utf8').split(/\s+/).filter(Boolean);
  const listing = (await get(SRC)).toString('utf8');
  const names = [...new Set([...listing.matchAll(/href="([^"?/]+\.(?:rar|zip))"/gi)].map(m => decodeURIComponent(m[1])))];
  console.log('архивов на сервере:', names.length, '· нужно баз:', bases.length);
  const idxPath = path.join(OUT, 'index.json');
  const index = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
  let ok = 0, miss = 0, fail = 0;
  for (const b of bases) {
    const arc = pickArchive(b, names);
    if (!arc) { miss++; continue; }
    if (!force && index[b] && index[b].src === arc && fs.existsSync(path.join(OUT, b + '.dkm'))) { ok++; continue; }
    try {
      const buf = await get(SRC + encodeURIComponent(arc)); if (!buf) { miss++; continue; }
      const obj = await objFrom(buf, arc); if (!obj) { console.log('нет OBJ в', arc); fail++; continue; }
      const m0 = parseObj(obj), m = simplify(m0), e = encode(m);
      fs.writeFileSync(path.join(OUT, b + '.dkm'), e.buf);
      index[b] = { src: arc, tris: e.tris, bb: e.bb, kb: Math.round(e.buf.length / 1024) };
      ok++; console.log(b, arc, (m0.idx.length / 3) + ' → ' + e.tris + ' треуг.,', index[b].kb + ' КБ', JSON.stringify(e.bb));
      fs.writeFileSync(idxPath, JSON.stringify(index, null, 0));
    } catch (er) { fail++; console.log('ошибка', b, arc, er.message); }
  }
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 0));
  console.log(`модели: ${ok} есть, ${miss} без архива, ${fail} ошибок`);
  /* фотометрия IES — тот же артикул, файл как есть (текст, 5–30 КБ) */
  fs.mkdirSync('ies', { recursive: true });
  const lsI = await get(SRC_IES); const namesI = lsI ? [...new Set([...lsI.toString('utf8').matchAll(/href="([^"?/]+\.(?:rar|zip|ies))"/gi)].map(m => decodeURIComponent(m[1])))] : [];
  const iesIdx = {}; let iOk = 0;
  for (const b of bases) {
    const c = namesI.filter(n => n.split('.')[0].split('-')[0] === b); if (!c.length) continue;
    c.sort((x, y) => { const sx = PREF.indexOf(x.replace(/\.\w+$/, '').split('-').slice(1).join('-')), sy = PREF.indexOf(y.replace(/\.\w+$/, '').split('-').slice(1).join('-')); return (sx < 0 ? 99 : sx) - (sy < 0 ? 99 : sy); });
    try { const buf = await get(SRC_IES + encodeURIComponent(c[0])); if (!buf) continue; const f = await fileFrom(buf, c[0], /\.ies$/i); if (!f) continue; fs.writeFileSync(path.join('ies', b + '.ies'), f); iesIdx[b] = { src: c[0], kb: Math.round(f.length / 1024) }; iOk++; } catch (er) { console.log('IES ошибка', b, er.message); }
  }
  fs.writeFileSync(path.join('ies', 'index.json'), JSON.stringify(iesIdx));
  console.log(`IES: ${iOk} из ${bases.length}`);
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });

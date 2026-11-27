/* Rodinný kalendář – uživatelské rozhraní (Preact + htm). */
import { html, render, useState, useEffect, useRef, useMemo } from "https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js";

const K = window.KalCore, R = window.KalRender, St = window.KalStore;
const TABS = [["kalendar", "Kalendář"], ["fotky", "Fotky"], ["rodina", "Rodina"], ["tisk", "Tisk a záloha"]];
const NOW = new Date();
const defaultYear = () => (NOW.getMonth() >= 8 ? NOW.getFullYear() + 1 : NOW.getFullYear());
const DOW_LONG = ["pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle"];

// =====================================================================
// Stav aplikace (jeden objekt, kořen se překreslí při každé změně)
// =====================================================================
const app = {
  phase: "loading", error: null,
  backend: null, downloads: null, saver: null,
  save: { pending: 0, active: 0, failed: null },
  settings: normSettings(null),
  family: normFamily(null),
  photos: {}, years: {},
  hasRemote: false,
  kal: {}, fonts: {},
  upload: null, toast: null,
  v: 0,
};
const subs = new Set();
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(() => { emitQueued = false; app.v++; subs.forEach((f) => f(app.v)); });
}
function useApp() {
  const [, set] = useState(0);
  useEffect(() => { subs.add(set); return () => subs.delete(set); }, []);
  return app;
}
function toast(text, kind) {
  app.toast = { text, kind: kind || "ok", id: Date.now() };
  emit();
  setTimeout(() => { if (app.toast && Date.now() - app.toast.id > 3500) { app.toast = null; emit(); } }, 4000);
}

function normSettings(d) {
  d = d && typeof d === "object" ? d : {};
  return {
    year: Number.isInteger(+d.year) && +d.year > 1900 && +d.year < 2200 ? +d.year : defaultYear(),
    theme: R.THEMES[d.theme] ? d.theme : "klasik",
    page: Object.assign({}, R.PAGE_DEFAULT, d.page && typeof d.page === "object" ? d.page : {}),
  };
}
function normFamily(d) {
  d = d && typeof d === "object" ? d : {};
  const str = (x) => (typeof x === "string" ? x : "");
  return {
    people: (Array.isArray(d.people) ? d.people : []).filter((p) => p && typeof p.id === "string")
      .map((p) => Object.assign({}, p, { name: str(p.name), born: str(p.born) })),
    events: (Array.isArray(d.events) ? d.events : []).filter((e) => e && typeof e.id === "string")
      .map((e) => Object.assign({}, e, { text: str(e.text), date: str(e.date) })),
    dayEdits: d.dayEdits && typeof d.dayEdits === "object" ? d.dayEdits : {},
  };
}

function onDoc(path, data) {
  if (app.saver && app.saver.pending(path)) return; // vlastní novější úprava má přednost
  if (path === "projekt/nastaveni") { app.settings = normSettings(data); if (data) app.hasRemote = true; }
  else if (path === "projekt/rodina") { app.family = normFamily(data); if (data) app.hasRemote = true; }
  else if (path.startsWith("fotky/")) {
    const id = path.slice(6);
    const next = Object.assign({}, app.photos);
    if (data && typeof data.full === "string") next[id] = Object.assign({}, data, { id, people: Array.isArray(data.people) ? data.people : [] });
    else delete next[id];
    app.photos = next;
  } else if (path.startsWith("roky/")) {
    const next = Object.assign({}, app.years);
    if (data) next[path.slice(5)] = data; else delete next[path.slice(5)];
    app.years = next;
  }
  emit();
}

// ---------- úpravy ----------
const clone = (x) => JSON.parse(JSON.stringify(x));
function saveSettings(patch) { app.settings = Object.assign({}, app.settings, patch); app.saver.queue("projekt/nastaveni", app.settings); emit(); }
function updateFamily(fn) { const f = clone(app.family); fn(f); app.family = f; app.saver.queue("projekt/rodina", f); emit(); }
function yearDoc(y) { return app.years[y || app.settings.year] || { weeks: {}, bonus: [] }; }
function updateYear(fn, y) {
  y = y || app.settings.year;
  const d = clone(yearDoc(y));
  d.weeks = d.weeks || {}; d.bonus = d.bonus || [];
  fn(d);
  app.years = Object.assign({}, app.years, { [y]: d });
  app.saver.queue("roky/" + y, d);
  emit();
}
function putPhoto(meta) {
  app.photos = Object.assign({}, app.photos, { [meta.id]: meta });
  const { id, ...data } = meta;
  app.saver.queue("fotky/" + id, data, 50);
  emit();
}
async function deletePhoto(id) {
  const p = app.photos[id];
  if (!p) return;
  for (const y of Object.keys(app.years)) {
    const d = app.years[y];
    const uses = Object.values(d.weeks || {}).some((w) => (w.L && w.L.photo === id) || (w.R && w.R.photo === id)) || (d.bonus || []).includes(id);
    if (uses) updateYear((dd) => {
      for (const [k, w] of Object.entries(dd.weeks)) { for (const s of ["L", "R"]) if (w[s] && w[s].photo === id) delete w[s]; if (!w.L && !w.R) delete dd.weeks[k]; }
      dd.bonus = dd.bonus.filter((b) => b !== id);
    }, y);
  }
  if (app.family.people.some((x) => x.portrait && x.portrait.photo === id)) updateFamily((f) => { f.people.forEach((x) => { if (x.portrait && x.portrait.photo === id) delete x.portrait; }); });
  const next = Object.assign({}, app.photos); delete next[id]; app.photos = next;
  app.saver.queue("fotky/" + id, null, 0);
  emit();
  await app.backend.deleteBlob(p.full);
  await app.backend.deleteBlob(p.thumb);
}

// ---------- sloty (místa pro fotky) ----------
function parseKey(key) {
  if (key.startsWith("w:")) { const [, monday, side] = key.split(":"); return { kind: "week", monday, side }; }
  if (key.startsWith("cover:")) return { kind: "cover", personId: key.slice(6) };
  if (key.startsWith("bonus:")) return { kind: "bonus", index: +key.slice(6) };
  return {};
}
const person = (id) => app.family.people.find((p) => p.id === id);
function getRef(key) {
  const k = parseKey(key);
  if (k.kind === "week") return ((yearDoc().weeks || {})[k.monday] || {})[k.side] || null;
  if (k.kind === "cover") { const p = person(k.personId); return (p && p.portrait) || null; }
  if (k.kind === "bonus") { const id = (yearDoc().bonus || [])[k.index]; return id ? { photo: id } : null; }
  return null;
}
function setRef(key, ref) {
  const k = parseKey(key);
  if (k.kind === "week") updateYear((d) => {
    const w = (d.weeks[k.monday] = d.weeks[k.monday] || {});
    if (ref) w[k.side] = ref; else delete w[k.side];
    if (!w.L && !w.R) delete d.weeks[k.monday];
  });
  else if (k.kind === "cover") updateFamily((f) => { const p = f.people.find((x) => x.id === k.personId); if (p) { if (ref) p.portrait = ref; else delete p.portrait; } });
  else if (k.kind === "bonus") updateYear((d) => { if (ref) d.bonus[k.index] = ref.photo; else d.bonus.splice(k.index, 1); });
}
function slotLabel(key) {
  const k = parseKey(key);
  if (k.kind === "week") return app.settings.theme === "novy" ? (k.side === "L" ? "Velká fotka" : "Fotka pod dny") : (k.side === "L" ? "Levá fotka" : "Pravá fotka");
  if (k.kind === "cover") { const p = person(k.personId); return "Portrét – " + (p ? p.name : ""); }
  if (k.kind === "bonus") return `Bonusová fotka ${k.index + 1}`;
  return "";
}

// ---------- obrázky ----------
const imgCache = new Map();
function getImg(ref) {
  if (!ref) return null;
  let e = imgCache.get(ref);
  if (!e) {
    e = { state: "loading" };
    imgCache.set(ref, e);
    app.backend.url(ref).then((u) => {
      if (!u) { e.state = "error"; return; }
      const im = new Image();
      im.decoding = "async";
      im.onload = () => { e.state = "ok"; e.img = im; e.w = im.naturalWidth; e.h = im.naturalHeight; e.src = u; emit(); };
      im.onerror = () => { e.state = "error"; emit(); };
      im.src = u;
    }, () => { e.state = "error"; });
  }
  return e.state === "ok" ? e : null;
}
const thumbOf = (photoId) => { const p = app.photos[photoId]; return p ? getImg(p.thumb) : null; };

async function decodeFile(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* zkusíme <img> */ }
  }
  const u = URL.createObjectURL(file);
  try { const im = new Image(); im.src = u; await im.decode(); return im; } finally { setTimeout(() => URL.revokeObjectURL(u), 1000); }
}
async function encodeJpeg(src, maxSide, q) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
  c.width = c.height = 0;
  return { blob, w, h };
}

/** Nahraje fotky: zmenší na tiskovou velikost (2600 px) + náhled, uloží a vrátí jejich záznamy. */
async function importFiles(files, opts) {
  opts = opts || {};
  if (!app.backend.canUpload) { toast("Nemáte oprávnění nahrávat fotky.", "err"); return []; }
  const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!list.length) { toast("Vybrané soubory nejsou fotky.", "err"); return []; }
  const out = [], errors = [];
  app.upload = { done: 0, total: list.length };
  emit();
  for (const f of list) {
    try {
      const src = await decodeFile(f);
      const full = await encodeJpeg(src, 2600, 0.86);
      const thumb = await encodeJpeg(src, 640, 0.8);
      if (src.close) src.close();
      const fullRef = await app.backend.upload(full.blob);
      const thumbRef = await app.backend.upload(thumb.blob, { thumbOf: fullRef });
      const meta = { id: St.newId(), full: fullRef, thumb: thumbRef, w: full.w, h: full.h,
        name: f.name.slice(0, 120), people: (opts.people || []).slice(), added: Date.now() };
      putPhoto(meta);
      out.push(meta);
    } catch (e) {
      errors.push(/\.(heic|heif)$/i.test(f.name) ? `${f.name} (formát HEIC z iPhonu – uložte prosím jako JPG)` : f.name);
    }
    app.upload = { done: app.upload.done + 1, total: list.length };
    emit();
  }
  app.upload = null;
  if (errors.length) toast(`Nepodařilo se nahrát: ${errors.join(", ")}`, "err");
  else toast(out.length === 1 ? "Fotka je nahraná." : `Nahráno ${out.length} fotek.`);
  return out;
}

// ---------- kalendář ----------
const mctx = document.createElement("canvas").getContext("2d");
function measure(s, f, size) { mctx.font = `${size}px "${f}"`; return mctx.measureText(s).width * R.PT; }
function layoutCtx(theme) {
  return { theme: theme || app.settings.theme, page: app.settings.page, year: app.settings.year, photos: app.photos, measure };
}
let calMemo = {};
function calendar() {
  const s = app.settings, f = app.family;
  if (calMemo.year === s.year && calMemo.family === f && calMemo.kal === app.kal) return calMemo.cal;
  const cal = K.buildYear({ year: s.year, people: f.people, events: f.events, dayEdits: f.dayEdits }, app.kal);
  calMemo = { year: s.year, family: f, kal: app.kal, cal };
  return cal;
}
let pagesMemo = {};
function pages() {
  const cal = calendar(), yd = app.years[app.settings.year];
  if (pagesMemo.cal === cal && pagesMemo.yd === yd && pagesMemo.people === app.family.people) return pagesMemo.pages;
  const p = R.buildPages(cal, app.family.people, yd);
  pagesMemo = { cal, yd, people: app.family.people, pages: p };
  return p;
}
/** Kde je která fotka použitá (v aktuálním roce + portréty). */
function usage() {
  const map = new Map();
  const add = (id, label) => { if (!id) return; if (!map.has(id)) map.set(id, []); map.get(id).push(label); };
  for (const p of app.family.people) if (p.portrait) add(p.portrait.photo, "titulka");
  for (const pg of pages()) {
    if (pg.kind === "week") { if (pg.L) add(pg.L.photo, pg.title); if (pg.R) add(pg.R.photo, pg.title); }
    if (pg.kind === "bonus") pg.items.forEach((it) => add(it.photo, "bonusy"));
  }
  return map;
}
function celebrantsOf(week) {
  const out = [];
  for (const d of week.days) if (d) for (const e of d.events) if (e.kind === "birthday") out.push({ personId: e.personId, text: e.text, date: d });
  return out;
}
function photosOfPerson(pid) { return Object.values(app.photos).filter((p) => p.people.includes(pid)).sort((a, b) => b.added - a.added); }

/** Doplní prázdná místa: oslavenci týdne dostanou své fotky, zbytek z neoznačených. Nic nepřepisuje. */
function autoFill() {
  const used = new Set(usage().keys());
  const cal = calendar();
  const celebrateLater = new Set(cal.weeks.flatMap((w) => w.celebrants));
  const ph = Object.values(app.photos).sort((a, b) => a.added - b.added);
  const landscape = (p) => p.w >= p.h;
  let filled = 0;
  updateYear((d) => {
    for (const w of cal.weeks) {
      const slots = d.weeks[w.monday] || {};
      for (const side of ["R", "L"]) {
        if (slots[side]) continue;
        const wantLand = app.settings.theme === "novy" ? side === "R" : false;
        const score = (p) => (landscape(p) === wantLand ? 0 : 1) + (p.people.length === 1 ? 0 : 0.5);
        let cand = ph.filter((p) => !used.has(p.id) && p.people.some((x) => w.celebrants.includes(x))).sort((a, b) => score(a) - score(b));
        if (!cand.length) cand = ph.filter((p) => !used.has(p.id) && !p.people.some((x) => celebrateLater.has(x))).sort((a, b) => score(a) - score(b));
        const pick = cand[0];
        if (!pick) continue;
        slots[side] = { photo: pick.id, crop: { z: 1, x: 0.5, y: 0.45 } };
        used.add(pick.id);
        filled++;
      }
      if (slots.L || slots.R) d.weeks[w.monday] = slots;
    }
  });
  toast(filled ? `Doplněno ${filled} fotek. Zkontrolujte je v náhledu.` : "Není co doplnit – chybí nepoužité fotky.", filled ? "ok" : "warn");
}
function unusedToBonus() {
  const used = usage();
  const ids = Object.values(app.photos).filter((p) => !used.has(p.id)).sort((a, b) => a.added - b.added).map((p) => p.id);
  if (!ids.length) { toast("Všechny fotky už jsou použité.", "warn"); return; }
  updateYear((d) => { d.bonus = d.bonus.concat(ids); });
  toast(`Do bonusů přidáno ${ids.length} fotek.`);
}

// ---------- PDF a soubory ----------
async function loadFull(photoId) {
  const p = app.photos[photoId];
  if (!p) return null;
  const blob = (await app.backend.blob(p.full)) || (await app.backend.blob(p.thumb));
  if (!blob) return null;
  const img = await createImageBitmap(blob);
  return { img, w: img.width, h: img.height };
}
async function buildPdf(onProgress) {
  const { jsPDF } = window.jspdf;
  const pg = app.settings.page, land = pg.w >= pg.h;
  const ctx = layoutCtx();
  const layouts = pages().map((p) => R.layout(p, ctx));
  const fonts = new Set();
  layouts.forEach((L) => L.items.forEach((it) => it.t === "text" && fonts.add(it.f)));
  const doc = new jsPDF({ orientation: land ? "landscape" : "portrait", unit: "mm", format: [pg.w, pg.h], compress: true });
  const bufs = {};
  fonts.forEach((f) => (bufs[f] = app.fonts[f]));
  R.registerFonts(doc, bufs);
  doc.setProperties({ title: `Rodinný kalendář ${app.settings.year}` });
  for (let i = 0; i < layouts.length; i++) {
    if (i) doc.addPage([pg.w, pg.h], land ? "landscape" : "portrait");
    await R.drawPdf(doc, layouts[i], { full: loadFull });
    onProgress(i + 1, layouts.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return doc.output("blob");
}
async function saveFile(filename, blob) {
  if (app.downloads) {
    try { await app.downloads.save({ filename, data: blob }); return true; }
    catch (e) {
      if (e && e.code === "declined") return false;
      if (e && e.code === "rate_limited") { toast("Chvilku počkejte a zkuste to znovu.", "warn"); return false; }
      throw e;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
  return true;
}
async function exportBackup(onProgress) {
  const zip = new window.JSZip();
  const docs = { "projekt/nastaveni": app.settings, "projekt/rodina": app.family };
  for (const [y, d] of Object.entries(app.years)) if (d) docs["roky/" + y] = d;
  const list = Object.values(app.photos);
  for (const p of list) { const { id, ...rest } = p; docs["fotky/" + id] = rest; }
  zip.file("kalendar.json", JSON.stringify({ format: "rodinny-kalendar", v: 1, exported: new Date().toISOString(), docs }, null, 1));
  let i = 0;
  for (const p of list) {
    for (const ref of [p.full, p.thumb]) { const b = await app.backend.blob(ref); if (b) zip.file("fotky/" + ref + ".jpg", b); }
    onProgress(++i, list.length);
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}
async function importBackup(file, onProgress) {
  let data, zip = null;
  if (/\.zip$/i.test(file.name)) {
    zip = await window.JSZip.loadAsync(file);
    const j = zip.file("kalendar.json");
    if (!j) throw new Error("V záloze chybí soubor kalendar.json.");
    data = JSON.parse(await j.async("string"));
  } else data = JSON.parse(await file.text());
  if (!data || data.format !== "rodinny-kalendar" || !data.docs) throw new Error("Tohle není záloha rodinného kalendáře.");
  const docs = data.docs, map = {};
  const photoPaths = Object.keys(docs).filter((p) => p.startsWith("fotky/"));
  let i = 0;
  for (const path of photoPaths) {
    const p = docs[path];
    for (const key of ["full", "thumb"]) {
      const f = zip && zip.file("fotky/" + p[key] + ".jpg");
      if (f) map[p[key]] = await app.backend.upload(new Blob([await f.async("arraybuffer")], { type: "image/jpeg" }),
        key === "thumb" && map[p.full] ? { thumbOf: map[p.full] } : undefined);
    }
    onProgress(++i, photoPaths.length);
  }
  for (const id of Object.keys(app.photos)) if (!docs["fotky/" + id]) { await app.backend.remove("fotky/" + id); onDoc("fotky/" + id, null); }
  for (const [path, d0] of Object.entries(docs)) {
    if (!/^(projekt\/(nastaveni|rodina)|fotky\/[\w.~:@+-]+|roky\/\d{4})$/.test(path)) continue;
    let d = d0;
    if (path.startsWith("fotky/")) d = Object.assign({}, d0, { full: map[d0.full] || d0.full, thumb: map[d0.thumb] || d0.thumb });
    await app.backend.write(path, d);
    onDoc(path, d);
  }
}

// =====================================================================
// Komponenty
// =====================================================================
function Thumb({ photo, size }) {
  const e = photo ? getImg(photo.thumb) : null;
  return e ? html`<img class="thumb" src=${e.src} alt="" loading="lazy" style=${size ? `width:${size}px;height:${size}px` : ""} />`
    : html`<span class="thumb ph" style=${size ? `width:${size}px;height:${size}px` : ""}></span>`;
}

function PageCanvas({ page, theme, interactive, active, activeDay, onPick, onCrop, maxH }) {
  const wrap = useRef(null), cv = useRef(null), drag = useRef(null);
  const [w, setW] = useState(600);
  const [draft, setDraft] = useState(null); // {key, crop} při tažení
  const pg = app.settings.page;
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  let cssW = w, cssH = (w * pg.h) / pg.w;
  if (maxH && cssH > maxH) { cssH = maxH; cssW = (maxH * pg.w) / pg.h; }
  const L = R.layout(page, layoutCtx(theme));
  if (draft) L.items.forEach((it) => { if (it.t === "img" && it.slot === draft.key) it.crop = draft.crop; });
  useEffect(() => {
    const c = cv.current, dpr = Math.min(2.5, window.devicePixelRatio || 1);
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    const g = c.getContext("2d");
    R.drawCanvas(g, L, c.width / pg.w, { image: thumbOf, placeholders: true, active });
    if (activeDay) {
      const d = L.days.find((x) => x.date === activeDay);
      if (d) { g.save(); g.scale(c.width / pg.w, c.width / pg.w); g.strokeStyle = "#F2A900"; g.lineWidth = 0.8; g.strokeRect(d.x + 0.4, d.y + 0.4, d.w - 0.8, d.h - 0.8); g.restore(); }
    }
  });
  const toMm = (ev) => { const r = cv.current.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * pg.w, y: ((ev.clientY - r.top) / r.height) * pg.h, k: pg.w / r.width }; };
  const hit = (p) => L.slots.find((s) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);
  const hitDay = (p) => L.days.find((s) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);
  function down(ev) {
    if (!interactive) return;
    const p = toMm(ev), s = hit(p);
    if (s && s.key === active && s.photo) {
      const im = thumbOf(s.photo);
      if (im) { drag.current = { s, im, x: ev.clientX, y: ev.clientY, k: p.k, crop0: s.crop || { z: 1, x: 0.5, y: 0.5 }, moved: false }; cv.current.setPointerCapture(ev.pointerId); return; }
    }
    drag.current = null;
  }
  function move(ev) {
    const d = drag.current;
    if (!d) return;
    const dx = (ev.clientX - d.x) * d.k, dy = (ev.clientY - d.y) * d.k;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true;
    setDraft({ key: d.s.key, crop: R.panCrop(d.im.w, d.im.h, d.s, d.crop0, dx, dy) });
  }
  function up(ev) {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved && draft) { onCrop && onCrop(d.s.key, draft.crop); setDraft(null); return; }
    setDraft(null);
    if (!interactive) return;
    const p = toMm(ev), s = hit(p);
    if (s) { onPick && onPick({ type: "slot", key: s.key }); return; }
    const day = hitDay(p);
    if (day) { onPick && onPick({ type: "day", date: day.date, md: day.md }); return; }
    onPick && onPick(null);
  }
  const cursor = interactive ? (active && L.slots.some((s) => s.key === active && s.photo) ? "grab" : "pointer") : "default";
  return html`<div class="pc-wrap" ref=${wrap}>
    <canvas ref=${cv} class="pc" style=${`width:${cssW}px;height:${cssH}px;cursor:${cursor}`}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${() => { drag.current = null; setDraft(null); }}
      role="img" aria-label=${`Náhled stránky: ${page.title}`}></canvas>
  </div>`;
}

function FileButton({ label, multiple, onFiles, cls, accept, disabled }) {
  const inp = useRef(null);
  return html`<button class=${"btn " + (cls || "")} disabled=${disabled} onClick=${() => inp.current.click()}>${label}</button>
    <input ref=${inp} type="file" hidden multiple=${!!multiple} accept=${accept || "image/*"}
      onChange=${(e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) onFiles(f); }} />`;
}

function PersonChips({ selected, onToggle, people, highlight }) {
  return html`<div class="chips">${people.map((p) => html`<button key=${p.id}
    class=${"chip" + (selected.includes(p.id) ? " on" : "") + (highlight && highlight.includes(p.id) ? " hl" : "")}
    aria-pressed=${selected.includes(p.id)} onClick=${() => onToggle(p.id)}>${p.name}<small>${p.born ? p.born.slice(0, 4) : ""}</small></button>`)}</div>`;
}

function sortedPeople() {
  return app.family.people.slice().sort((a, b) => a.name.localeCompare(b.name, "cs") || (a.born || "").localeCompare(b.born || ""));
}

// ---------- výběr fotky ----------
function PhotoPicker({ title, prefer, onChoose, onClose }) {
  const used = usage();
  const [filter, setFilter] = useState(prefer && prefer.length ? "pref" : "unused");
  const all = Object.values(app.photos).sort((a, b) => b.added - a.added);
  const list = all.filter((p) => filter === "all" ? true : filter === "unused" ? !used.has(p.id)
    : filter === "pref" ? p.people.some((x) => (prefer || []).includes(x)) : p.people.includes(filter));
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head"><h2>${title}</h2><button class="btn ghost" onClick=${onClose}>Zavřít</button></div>
      <div class="seg wrap">
        ${prefer && prefer.length ? html`<button class=${filter === "pref" ? "on" : ""} onClick=${() => setFilter("pref")}>Doporučené</button>` : null}
        <button class=${filter === "unused" ? "on" : ""} onClick=${() => setFilter("unused")}>Nepoužité</button>
        <button class=${filter === "all" ? "on" : ""} onClick=${() => setFilter("all")}>Všechny</button>
        <select aria-label="Fotky člověka" value=${["pref", "unused", "all"].includes(filter) ? "" : filter} onChange=${(e) => e.target.value && setFilter(e.target.value)}>
          <option value="">Fotky člověka…</option>
          ${sortedPeople().map((p) => html`<option value=${p.id}>${p.name} ${p.born ? "(" + p.born.slice(0, 4) + ")" : ""}</option>`)}
        </select>
        <${FileButton} label="Nahrát z počítače" cls="primary" multiple=${false} onFiles=${async (f) => {
          const m = await importFiles(f, { people: filter && !["pref", "unused", "all"].includes(filter) ? [filter] : [] });
          if (m[0]) onChoose(m[0].id);
        }} />
      </div>
      ${list.length ? html`<div class="pick-grid">${list.map((p) => html`<button key=${p.id} class="pick" onClick=${() => onChoose(p.id)}>
          <${Thumb} photo=${p} />
          <span class="pick-meta">${used.has(p.id) ? html`<em>${used.get(p.id).join(", ")}</em>` : html`<b>nepoužitá</b>`}</span>
        </button>`)}</div>`
        : html`<p class="empty">${filter === "pref" ? "Oslavenci tohoto týdne zatím nemají označené fotky. Nahrajte je tlačítkem výše, nebo zvolte Všechny." : "Tady zatím nic není."}</p>`}
    </div></div>`;
}

// ---------- záložka Kalendář ----------
function CalendarTab() {
  const ps = pages();
  const [idx, setIdx] = useState(() => {
    try { const v = localStorage.getItem("kal.page"); return Math.min(v === null || isNaN(+v) ? 1 : +v, ps.length - 1); } catch (e) { return 1; }
  });
  const [sel, setSel] = useState(null);
  const [picker, setPicker] = useState(null);
  const i = Math.min(idx, ps.length - 1), page = ps[i];
  const go = (n) => { const j = Math.max(0, Math.min(ps.length - 1, n)); setIdx(j); setSel(null); try { localStorage.setItem("kal.page", j); } catch (e) { /* nevadí */ } };
  useEffect(() => {
    const k = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName) || document.querySelector(".modal")) return;
      if (e.key === "ArrowRight") go(i + 1);
      if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const listRef = useRef(null);
  useEffect(() => { const el = listRef.current && listRef.current.querySelector(".pl-item.on"); if (el) el.scrollIntoView({ block: "nearest" }); }, [i]);
  const empty = ps.filter((p) => p.kind === "week" && (!p.L || !p.R)).length;
  return html`<div class="cal-grid">
    <nav class="pagelist" ref=${listRef} aria-label="Stránky kalendáře">
      ${ps.map((p, j) => html`<button key=${p.id} class=${"pl-item" + (j === i ? " on" : "")} onClick=${() => go(j)}>
        <span class="pl-num">${p.kind === "week" ? p.week.isoWeek : p.kind === "cover" ? "T" : "B"}</span>
        <span class="pl-main">
          <b>${p.kind === "week" ? p.week.monthLabel.toLowerCase() : p.title}</b>
          <small>${p.sub}</small>
          ${p.kind === "week" && p.week.celebrants.length ? html`<small class="cel">${celebrantsOf(p.week).map((c) => c.text).join(", ")}</small>` : null}
        </span>
        ${p.kind === "week" ? html`<span class="pl-dots" aria-label=${(p.L ? 1 : 0) + (p.R ? 1 : 0) + " ze 2 fotek"}><i class=${p.L ? "on" : ""}></i><i class=${p.R ? "on" : ""}></i></span>` : null}
      </button>`)}
    </nav>
    <section class="stage">
      <div class="toolbar">
        <button class="btn icon" onClick=${() => go(i - 1)} disabled=${i === 0} aria-label="Předchozí stránka">‹</button>
        <div class="tb-title"><b>${page.kind === "week" ? `${page.week.monthLabel.toLowerCase()} · ${page.title}` : page.title}</b><small>${page.sub} · strana ${i + 1} z ${ps.length}</small></div>
        <button class="btn icon" onClick=${() => go(i + 1)} disabled=${i === ps.length - 1} aria-label="Další stránka">›</button>
        <span class="grow"></span>
        <div class="seg" role="group" aria-label="Vzhled">
          ${Object.values(R.THEMES).map((t) => html`<button class=${app.settings.theme === t.id ? "on" : ""} onClick=${() => saveSettings({ theme: t.id })}>${t.name}</button>`)}
        </div>
        <button class="btn" onClick=${autoFill} disabled=${!app.backend.canUpload} title="Doplní jen prázdná místa, nic nepřepíše">Doplnit fotky (${empty} týdnů chybí)</button>
      </div>
      <${PageCanvas} page=${page} interactive=${app.backend.canUpload} active=${sel && sel.type === "slot" ? sel.key : null}
        activeDay=${sel && sel.type === "day" ? sel.date : null}
        onPick=${setSel} onCrop=${(key, crop) => { const r = getRef(key); if (r) setRef(key, Object.assign({}, r, { crop })); }} />
      <p class="hint">Klikněte na fotku nebo na den. Vybranou fotku posunete tažením myší, šipkami na klávesnici listujete stránky.</p>
    </section>
    <aside class="inspector">
      ${sel && sel.type === "slot" ? html`<${SlotPanel} key=${sel.key} slotKey=${sel.key} page=${page} onPicker=${setPicker} onClose=${() => setSel(null)} />`
        : sel && sel.type === "day" ? html`<${DayPanel} key=${sel.date} date=${sel.date} md=${sel.md} page=${page} onClose=${() => setSel(null)} />`
        : html`<${PagePanel} page=${page} onPick=${setSel} />`}
    </aside>
    ${picker ? html`<${PhotoPicker} ...${picker} onClose=${() => setPicker(null)} />` : null}
  </div>`;
}

function PagePanel({ page, onPick }) {
  if (page.kind === "cover") {
    const without = app.family.people.filter((p) => !p.portrait && !p.noCover);
    const cov = yearDoc().cover || {};
    const setOrder = (order) => updateYear((d) => { d.cover = Object.assign({}, d.cover, { order, seed: (d.cover && d.cover.seed) || Date.now() % 100000 }); });
    return html`<div class="panel"><h3>Titulka</h3>
      <p>Portréty se samy poskládají do mřížky podle toho, kolik jich je, uprostřed je rok.</p>
      <div class="field"><span>Pořadí portrétů</span>
        <div class="seg wrap">${Object.entries(R.COVER_ORDERS).map(([k, label]) => html`<button class=${page.order === k ? "on" : ""} onClick=${() => setOrder(k)}>${label}</button>`)}</div>
        ${page.order === "random" ? html`<button class="btn sm" onClick=${() => updateYear((d) => { d.cover = Object.assign({}, d.cover, { order: "random", seed: 1 + Math.floor(Math.random() * 1e6) }); })}>Zamíchat znovu</button>` : null}
      </div>
      ${without.length ? html`<div class="field"><span>Ještě nemají portrét (${without.length})</span>
          <div class="chips">${without.map((p) => html`<button key=${p.id} class="chip" onClick=${() => onPick({ type: "slot", key: "cover:" + p.id })}>${p.name}<small>${p.born ? p.born.slice(0, 4) : ""}</small></button>`)}</div>
          <small class="muted">Klikněte na jméno a nahrajte nebo vyberte portrét.</small></div>`
        : app.family.people.length ? html`<p class="ok">Portrét má každý.</p>` : null}
      <p class="muted">Na portrét v náhledu klikněte a tažením upravte výřez obličeje. Kdo na titulce být nemá, tomu v záložce <a href="#rodina">Rodina</a> odškrtněte „Na titulce“.</p></div>`;
  }
  if (page.kind === "bonus") return html`<div class="panel"><h3>Bonusy</h3><p>Fotky, které se do týdnů nevešly. Rozloží se samy podle tvaru fotek.</p>
    <button class="btn" onClick=${unusedToBonus}>Přidat všechny nepoužité fotky</button></div>`;
  const cel = celebrantsOf(page.week);
  return html`<div class="panel">
    <h3>Tento týden</h3>
    ${cel.length ? html`<ul class="cel-list">${cel.map((c) => {
      const n = photosOfPerson(c.personId).length;
      return html`<li><b>${c.text}</b> <small>${c.date.day}. ${K.MONTHS_GEN[c.date.month]}</small><br /><small class="muted">${n ? `${n} ${n === 1 ? "fotka" : n < 5 ? "fotky" : "fotek"} v zásobě` : "zatím žádná fotka"}</small></li>`;
    })}</ul>` : html`<p class="muted">Tento týden nikdo z rodiny nemá narozeniny.</p>`}
    <div class="stack">
      <button class="btn" onClick=${() => onPick({ type: "slot", key: page.id + ":L" })}>${page.L ? "Upravit" : "Přidat"} ${slotLabel(page.id + ":L").toLowerCase()}</button>
      <button class="btn" onClick=${() => onPick({ type: "slot", key: page.id + ":R" })}>${page.R ? "Upravit" : "Přidat"} ${slotLabel(page.id + ":R").toLowerCase()}</button>
    </div>
    <p class="muted">Na den klikněte, když chcete upravit jméno, svátek nebo přidat poznámku.</p>
  </div>`;
}

function SlotPanel({ slotKey, page, onPicker, onClose }) {
  const ref = getRef(slotKey);
  const photo = ref && app.photos[ref.photo];
  const k = parseKey(slotKey);
  const prefer = k.kind === "week" && page.week ? page.week.celebrants : k.kind === "cover" ? [k.personId] : [];
  const L = R.layout(page, layoutCtx());
  const slot = L.slots.find((s) => s.key === slotKey);
  const dpi = photo && slot ? R.slotDpi(photo, slot, ref.crop) : null;
  const choose = (id) => {
    const keepCrop = ref && ref.photo === id ? ref.crop : { z: 1, x: 0.5, y: k.kind === "cover" ? 0.4 : 0.45 };
    setRef(slotKey, k.kind === "bonus" ? { photo: id } : { photo: id, crop: keepCrop });
    onPicker(null);
  };
  const crop = (ref && ref.crop) || { z: 1, x: 0.5, y: 0.5 };
  return html`<div class="panel">
    <div class="panel-head"><h3>${slotLabel(slotKey)}</h3><button class="btn ghost sm" onClick=${onClose}>Hotovo</button></div>
    ${photo ? html`<div class="slot-photo"><${Thumb} photo=${photo} /></div>` : html`<p class="muted">Tady zatím fotka není.</p>`}
    <div class="stack">
      <${FileButton} label=${photo ? "Nahrát jinou z počítače" : "Nahrát fotku z počítače"} cls="primary"
        onFiles=${async (f) => { const m = await importFiles(f, { people: k.kind === "cover" ? [k.personId] : [] }); if (m[0]) choose(m[0].id); }} />
      <button class="btn" onClick=${() => onPicker({ title: "Vybrat fotku – " + slotLabel(slotKey).toLowerCase(), prefer, onChoose: choose })}>Vybrat z nahraných fotek</button>
    </div>
    ${photo && k.kind !== "bonus" ? html`
      <label class="field"><span>Přiblížení</span>
        <input type="range" min="1" max="3" step="0.05" value=${crop.z || 1}
          onInput=${(e) => setRef(slotKey, Object.assign({}, ref, { crop: Object.assign({}, crop, { z: +e.target.value }) }))} /></label>
      <p class="muted">Výřez posunete tažením fotky v náhledu.</p>
      <button class="btn ghost sm" onClick=${() => setRef(slotKey, Object.assign({}, ref, { crop: { z: 1, x: 0.5, y: 0.5 } }))}>Vycentrovat</button>` : null}
    ${dpi && dpi < 150 ? html`<p class="warn">Fotka je na tuhle velikost malá (${dpi} DPI), v tisku může být rozmazaná. Zkuste ji méně přiblížit nebo vybrat větší.</p>` : null}
    ${photo ? html`<div class="field"><span>Kdo je na fotce</span>
      <${PersonChips} people=${prefer.length ? app.family.people.filter((p) => prefer.includes(p.id) || photo.people.includes(p.id)) : app.family.people.filter((p) => photo.people.includes(p.id))}
        selected=${photo.people} highlight=${prefer}
        onToggle=${(pid) => putPhoto(Object.assign({}, photo, { people: photo.people.includes(pid) ? photo.people.filter((x) => x !== pid) : photo.people.concat(pid) }))} />
      <small class="muted">Označené fotky umí appka sama rozmístit. Ostatní lidi označíte v záložce Fotky.</small></div>` : null}
    ${photo ? html`<button class="btn danger-ghost" onClick=${() => { setRef(slotKey, null); }}>${k.kind === "bonus" ? "Vyřadit z bonusů" : "Odebrat z tohoto místa"}</button>
      <small class="muted">Fotka zůstane v záložce Fotky.</small>` : null}
  </div>`;
}

function DayPanel({ date, md, page, onClose }) {
  const day = page.week && page.week.days.find((d) => d && d.date === date);
  const [d1, setD1] = useState("");
  const [every, setEvery] = useState(true);
  const [red, setRed] = useState(false);
  if (!day) return null;
  const base = app.kal[md] || {};
  const edit = app.family.dayEdits[md] || {};
  const setEdit = (field, v) => updateFamily((f) => {
    const e = Object.assign({}, f.dayEdits[md] || {});
    if (v === (base[field] || "")) delete e[field]; else e[field] = v;
    if (Object.keys(e).length) f.dayEdits[md] = e; else delete f.dayEdits[md];
  });
  const add = () => {
    if (!d1.trim()) return;
    updateFamily((f) => f.events.push({ id: St.newId(), date: every ? md : date, text: d1.trim(), red }));
    setD1("");
  };
  const ds = new Date(date + "T12:00:00");
  return html`<div class="panel">
    <div class="panel-head"><h3>${DOW_LONG[day.dow]} ${day.day}. ${K.MONTHS_GEN[day.month]}</h3><button class="btn ghost sm" onClick=${onClose}>Hotovo</button></div>
    ${day.holiday ? html`<p class="tag red">Státní svátek: ${day.holiday}</p>` : null}
    <label class="field"><span>Svatý (církevní kalendář)</span>
      <input id=${"saint-" + md} value=${day.saint} onChange=${(e) => setEdit("saint", e.target.value.trim())} /></label>
    <label class="field"><span>Jmeniny</span>
      <input id=${"name-" + md} value=${day.name} onChange=${(e) => setEdit("name", e.target.value.trim())} /></label>
    ${Object.keys(edit).length ? html`<button class="btn ghost sm" onClick=${() => updateFamily((f) => { delete f.dayEdits[md]; })}>Vrátit původní text dne</button>` : null}
    <small class="muted">Úprava textu platí pro tento den každý rok.</small>
    <div class="field"><span>V pravém sloupci</span>
      ${day.events.length ? html`<ul class="ev-list">${day.events.map((e) => html`<li key=${e.text}>
        <span class=${e.kind === "custom" && e.red ? "red" : ""}>${e.text}</span>
        <small class="muted">${e.kind === "birthday" ? "narozeniny – mění se v Rodině" : e.kind === "liturgy" ? "počítá se samo" : ""}</small>
        ${e.kind === "custom" ? html`<button class="btn ghost sm" onClick=${() => updateFamily((f) => { f.events = f.events.filter((x) => x.id !== e.id); })}>Smazat</button>` : null}
      </li>`)}</ul>` : html`<p class="muted">Nic.</p>`}
    </div>
    <div class="field"><span>Přidat poznámku k tomuto dni</span>
      <input id=${"note-" + md} value=${d1} placeholder="např. Výročí svatby" onInput=${(e) => setD1(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && add()} />
      <label class="check"><input type="checkbox" checked=${every} onChange=${(e) => setEvery(e.target.checked)} /> opakovat každý rok</label>
      <label class="check"><input type="checkbox" checked=${red} onChange=${(e) => setRed(e.target.checked)} /> červeně</label>
      <button class="btn" onClick=${add} disabled=${!d1.trim()}>Přidat poznámku</button>
    </div>
    <small class="muted">${ds.toLocaleDateString("cs-CZ")}</small>
  </div>`;
}

// ---------- záložka Fotky ----------
function PhotosTab() {
  const [filter, setFilter] = useState("all");
  const [selId, setSelId] = useState(null);
  const [drag, setDrag] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const used = usage();
  const all = Object.values(app.photos).sort((a, b) => b.added - a.added);
  const people = sortedPeople();
  const count = (pid) => all.filter((p) => p.people.includes(pid)).length;
  const list = all.filter((p) => filter === "all" ? true : filter === "untagged" ? !p.people.length : filter === "unused" ? !used.has(p.id) : p.people.includes(filter));
  const fp = person(filter);
  const sel = selId && app.photos[selId];
  const upload = (files) => importFiles(files, { people: fp ? [fp.id] : [] });
  return html`<div class="ph-grid">
    <nav class="pagelist people-filter" aria-label="Filtr fotek">
      <button class=${"pl-item" + (filter === "all" ? " on" : "")} onClick=${() => setFilter("all")}><span class="pl-main"><b>Všechny fotky</b></span><span class="cnt">${all.length}</span></button>
      <button class=${"pl-item" + (filter === "unused" ? " on" : "")} onClick=${() => setFilter("unused")}><span class="pl-main"><b>Nepoužité</b></span><span class="cnt">${all.filter((p) => !used.has(p.id)).length}</span></button>
      <button class=${"pl-item" + (filter === "untagged" ? " on" : "")} onClick=${() => setFilter("untagged")}><span class="pl-main"><b>Neoznačené</b></span><span class="cnt">${all.filter((p) => !p.people.length).length}</span></button>
      <div class="pl-sep">Podle lidí</div>
      ${people.map((p) => html`<button key=${p.id} class=${"pl-item" + (filter === p.id ? " on" : "")} onClick=${() => setFilter(p.id)}>
        <span class="pl-main"><b>${p.name}</b><small>${p.born ? p.born.slice(0, 4) : ""}</small></span><span class=${"cnt" + (count(p.id) ? "" : " zero")}>${count(p.id)}</span></button>`)}
    </nav>
    <section class="stage">
      <div class=${"drop" + (drag ? " over" : "")}
        onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
        onDrop=${(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
        <div><b>Přetáhněte sem fotky</b> nebo <${FileButton} label="vyberte z počítače" cls="primary sm" multiple=${true} onFiles=${upload} disabled=${!app.backend.canUpload} /></div>
        <small>${fp ? html`Nové fotky se rovnou označí: <b>${fp.name}</b>` : "Tip: vlevo vyberte člověka a jeho fotky nahrajte rovnou k němu."}</small>
      </div>
      ${app.upload ? html`<div class="progress"><span style=${`width:${(app.upload.done / app.upload.total) * 100}%`}></span><small>Nahrávám ${app.upload.done} z ${app.upload.total}…</small></div>` : null}
      ${list.length ? html`<div class="pick-grid big">${list.map((p) => html`<button key=${p.id} class=${"pick" + (selId === p.id ? " on" : "")} onClick=${() => { setSelId(p.id); setConfirmDel(false); }}>
          <${Thumb} photo=${p} />
          <span class="pick-meta">${used.has(p.id) ? html`<em>${used.get(p.id).join(", ")}</em>` : html`<b>nepoužitá</b>`}
            ${p.people.length ? html`<br /><small>${p.people.map((x) => (person(x) || {}).name).filter(Boolean).join(", ")}</small>` : null}</span>
        </button>`)}</div>`
        : html`<p class="empty">${all.length ? "V tomhle výběru nejsou žádné fotky." : "Zatím tu nejsou žádné fotky. Přetáhněte je sem z počítače."}</p>`}
    </section>
    <aside class="inspector">
      ${sel ? html`<div class="panel">
        <div class="panel-head"><h3>Fotka</h3><button class="btn ghost sm" onClick=${() => setSelId(null)}>Zavřít</button></div>
        <div class="slot-photo"><${Thumb} photo=${sel} /></div>
        <small class="muted">${sel.name} · ${sel.w} × ${sel.h} px</small>
        <p>${used.has(sel.id) ? "Použitá: " + used.get(sel.id).join(", ") : "Zatím nikde nepoužitá."}</p>
        <div class="field"><span>Kdo je na fotce</span>
          <${PersonChips} people=${people} selected=${sel.people}
            onToggle=${(pid) => putPhoto(Object.assign({}, sel, { people: sel.people.includes(pid) ? sel.people.filter((x) => x !== pid) : sel.people.concat(pid) }))} /></div>
        ${sel.people.length ? html`<div class="field"><span>Použít jako portrét na titulku</span>
          <div class="chips">${sel.people.map((pid) => { const p = person(pid); return p ? html`<button class="chip" onClick=${() => { updateFamily((f) => { const x = f.people.find((q) => q.id === pid); x.portrait = { photo: sel.id, crop: { z: 1.3, x: 0.5, y: 0.4 } }; }); toast(`Portrét pro ${p.name} je nastavený. Výřez upravíte na titulce.`); }}>${p.name}</button>` : null; })}</div></div>` : null}
        <button class="btn" onClick=${() => { updateYear((d) => { if (!d.bonus.includes(sel.id)) d.bonus.push(sel.id); }); toast("Přidáno do bonusů."); }}>Dát do bonusů</button>
        ${confirmDel ? html`<div class="confirm"><p>Fotku smazat úplně? Zmizí i z kalendáře.</p>
            <button class="btn danger" onClick=${() => { deletePhoto(sel.id); setSelId(null); toast("Fotka je smazaná."); }}>Ano, smazat</button>
            <button class="btn ghost" onClick=${() => setConfirmDel(false)}>Nechat</button></div>`
          : html`<button class="btn danger-ghost" onClick=${() => setConfirmDel(true)}>Smazat fotku</button>`}
      </div>` : html`<div class="panel"><h3>Fotky</h3>
        <p>Sem patří všechny fotky do kalendáře. Když u fotky označíte, kdo na ní je, tlačítko <b>Doplnit fotky</b> v Kalendáři ji samo dá do týdne, kdy má ten člověk narozeniny.</p>
        <p class="muted">Fotky se při nahrání zmenší na velikost vhodnou pro tisk, originály v počítači zůstanou.</p></div>`}
    </aside>
  </div>`;
}

// ---------- záložka Rodina ----------
function FamilyTab() {
  const [sort, setSort] = useState("date");
  const [picker, setPicker] = useState(null);
  const [del, setDel] = useState(null);
  const y = app.settings.year;
  const people = app.family.people.slice().sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name, "cs")
    : (a, b) => (a.born || "").slice(5).localeCompare((b.born || "").slice(5)) || a.name.localeCompare(b.name, "cs"));
  const upd = (id, patch) => updateFamily((f) => { Object.assign(f.people.find((p) => p.id === id), patch); });
  const age = (p) => { const m = /^(\d{4})-/.exec(p.born || ""); return m ? y - +m[1] : null; };
  const evs = app.family.events.slice().sort((a, b) => a.date.slice(-5).localeCompare(b.date.slice(-5)));
  return html`<div class="family">
    <section class="card">
      <div class="card-head"><h2>Rodina <small>${people.length} lidí</small></h2>
        <div class="seg"><button class=${sort === "date" ? "on" : ""} onClick=${() => setSort("date")}>Podle data</button><button class=${sort === "name" ? "on" : ""} onClick=${() => setSort("name")}>Podle jména</button></div>
        <button class="btn primary" onClick=${() => updateFamily((f) => f.people.unshift({ id: St.newId(), name: "", born: "" }))}>Přidat člověka</button>
      </div>
      <p class="muted">Jméno se napíše do kalendáře přesně takhle (třeba „maminka“ nebo „Vašek P.“). Věk se dopočítá sám pro rok ${y}.</p>
      <div class="table-wrap"><table class="people">
        <thead><tr><th>Jméno v kalendáři</th><th>Narozen(a)</th><th>V roce ${y}</th><th>Portrét</th><th>Na titulce</th><th></th></tr></thead>
        <tbody>${people.map((p) => html`<tr key=${p.id}>
          <td><input id=${"pn-" + p.id} value=${p.name} placeholder="Jméno" aria-label="Jméno" onChange=${(e) => upd(p.id, { name: e.target.value.trim() })} /></td>
          <td><input id=${"pb-" + p.id} type="date" value=${/^\d{4}-\d{2}-\d{2}$/.test(p.born) ? p.born : ""} aria-label="Datum narození" onChange=${(e) => upd(p.id, { born: e.target.value })} /></td>
          <td class="num">${age(p) != null && age(p) > 0 ? `${age(p)} ${K.yearsWord(age(p))}` : "–"}</td>
          <td><button class="portrait-btn" onClick=${() => setPicker({ title: "Portrét – " + (p.name || "nový člověk"), prefer: [p.id], onChoose: (id) => { upd(p.id, { portrait: { photo: id, crop: { z: 1.3, x: 0.5, y: 0.4 } } }); setPicker(null); } })}>
            ${p.portrait && app.photos[p.portrait.photo] ? html`<${Thumb} photo=${app.photos[p.portrait.photo]} size=${40} />` : html`<span class="thumb ph" style="width:40px;height:40px"></span>`}
            <small>${p.portrait ? "změnit" : "vybrat"}</small></button></td>
          <td><input type="checkbox" checked=${!p.noCover} aria-label="Na titulce" onChange=${(e) => upd(p.id, { noCover: !e.target.checked })} /></td>
          <td>${del === p.id ? html`<span class="confirm-inline">Smazat? <button class="btn danger sm" onClick=${() => { updateFamily((f) => { f.people = f.people.filter((x) => x.id !== p.id); }); setDel(null); }}>Ano</button><button class="btn ghost sm" onClick=${() => setDel(null)}>Ne</button></span>`
            : html`<button class="btn ghost sm" onClick=${() => setDel(p.id)} aria-label=${"Smazat " + p.name}>Smazat</button>`}</td>
        </tr>`)}</tbody></table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Vlastní poznámky v kalendáři</h2>
        <button class="btn" onClick=${() => updateFamily((f) => f.events.push({ id: St.newId(), date: "01-01", text: "", red: false }))}>Přidat poznámku</button></div>
      <p class="muted">Výročí, upozornění a podobně. Píšou se do pravého sloupce. Poznámku přidáte i kliknutím na den v náhledu.</p>
      ${evs.length ? html`<div class="table-wrap"><table class="people">
        <thead><tr><th>Datum</th><th>Text</th><th>Každý rok</th><th>Červeně</th><th></th></tr></thead>
        <tbody>${evs.map((e) => {
          const yearly = /^\d{2}-\d{2}$/.test(e.date);
          const val = yearly ? `${y}-${e.date}` : e.date;
          const updE = (patch) => updateFamily((f) => Object.assign(f.events.find((x) => x.id === e.id), patch));
          return html`<tr key=${e.id}>
            <td><input type="date" value=${val} onChange=${(ev) => ev.target.value && updE({ date: yearly ? ev.target.value.slice(5) : ev.target.value })} /></td>
            <td><input id=${"et-" + e.id} class="wide" value=${e.text} onChange=${(ev) => updE({ text: ev.target.value.trim() })} /></td>
            <td><input type="checkbox" checked=${yearly} onChange=${(ev) => updE({ date: ev.target.checked ? val.slice(5) : `${y}-${val.slice(5)}` })} /></td>
            <td><input type="checkbox" checked=${!!e.red} onChange=${(ev) => updE({ red: ev.target.checked })} /></td>
            <td><button class="btn ghost sm" onClick=${() => updateFamily((f) => { f.events = f.events.filter((x) => x.id !== e.id); })}>Smazat</button></td>
          </tr>`;
        })}</tbody></table></div>` : html`<p class="empty">Zatím žádné.</p>`}
    </section>
    ${Object.keys(app.family.dayEdits).length ? html`<section class="card"><div class="card-head"><h2>Upravené dny</h2></div>
      <p class="muted">Dny, kde jste přepsali svatého nebo jmeniny.</p>
      <ul class="ev-list">${Object.entries(app.family.dayEdits).sort().map(([md, e]) => html`<li key=${md}><b>${+md.slice(3)}. ${+md.slice(0, 2)}.</b> ${[e.saint, e.name].filter(Boolean).join(" · ")}
        <button class="btn ghost sm" onClick=${() => updateFamily((f) => { delete f.dayEdits[md]; })}>Vrátit původní</button></li>`)}</ul></section>` : null}
    ${picker ? html`<${PhotoPicker} ...${picker} onClose=${() => setPicker(null)} />` : null}
  </div>`;
}

// ---------- záložka Tisk ----------
function PrintTab() {
  const ps = pages();
  const firstFull = ps.findIndex((p) => p.kind === "week" && p.L && p.R);
  const [sample, setSample] = useState(firstFull > 0 ? firstFull : 1);
  const [pdf, setPdf] = useState(null); // {state, done, total, blob}
  const [bk, setBk] = useState(null);
  const [usageInfo, setUsageInfo] = useState(null);
  useEffect(() => { app.backend.usage().then(setUsageInfo); }, [Object.keys(app.photos).length]);
  const weeks = ps.filter((p) => p.kind === "week");
  const missing = weeks.filter((p) => !p.L || !p.R);
  const noPortrait = app.family.people.filter((p) => !p.portrait && !p.noCover);
  const ctx = layoutCtx();
  const lowRes = [];
  for (const p of ps) {
    if (p.kind !== "week") continue;
    const L = R.layout(p, ctx);
    for (const s of L.slots) { const ph = s.photo && app.photos[s.photo]; const d = ph && R.slotDpi(ph, s, s.crop); if (d && d < 150) lowRes.push(p.title); }
  }
  const make = async () => {
    setPdf({ state: "run", done: 0, total: ps.length });
    try {
      const blob = await buildPdf((done, total) => setPdf({ state: "run", done, total }));
      setPdf({ state: "done", blob });
    } catch (e) { console.error(e); setPdf({ state: "err", msg: String((e && e.message) || e) }); }
  };
  const mb = (b) => (b / 1048576).toFixed(b > 1048576 * 10 ? 0 : 1).replace(".", ",") + " MB";
  return html`<div class="print">
    <section class="card">
      <div class="card-head"><h2>Vzhled</h2>
        <label class="inline">Ukázka:
          <select value=${sample} onChange=${(e) => setSample(+e.target.value)}>${ps.map((p, j) => html`<option value=${j}>${p.kind === "week" ? `${p.title} (${p.sub})` : p.title}</option>`)}</select></label></div>
      <div class="compare">${Object.values(R.THEMES).map((t) => html`<div class=${"theme-card" + (app.settings.theme === t.id ? " on" : "")}>
        <${PageCanvas} page=${ps[Math.min(sample, ps.length - 1)]} theme=${t.id} interactive=${false} />
        <div class="theme-foot"><div><b>${t.name}</b><small>${t.note}</small></div>
          ${app.settings.theme === t.id ? html`<span class="tag">Vybraný</span>` : html`<button class="btn primary" onClick=${() => saveSettings({ theme: t.id })}>Použít</button>`}</div>
      </div>`)}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Kontrola před tiskem</h2></div>
      <ul class="checks">
        <li class=${missing.length ? "warn" : "ok"}>${missing.length ? `${missing.length} z ${weeks.length} týdnů nemá obě fotky (týdny ${missing.slice(0, 12).map((p) => p.week.isoWeek).join(", ")}${missing.length > 12 ? " a další" : ""}).` : "Všechny týdny mají obě fotky."}</li>
        <li class=${noPortrait.length ? "warn" : "ok"}>${noPortrait.length ? `Bez portrétu na titulce: ${noPortrait.map((p) => p.name).join(", ")}` : "Titulka je kompletní."}</li>
        <li class=${lowRes.length ? "warn" : "ok"}>${lowRes.length ? `Možná rozmazané fotky: ${[...new Set(lowRes)].join(", ")}` : "Rozlišení fotek je v pořádku."}</li>
      </ul>
    </section>
    <section class="card">
      <div class="card-head"><h2>PDF pro tisk</h2></div>
      <p>Celý kalendář ${app.settings.year} jako jedno PDF: ${ps.length} stran A4 na šířku, fotky v tiskovém rozlišení. Trvá to zhruba minutu.</p>
      ${!pdf || pdf.state === "err" ? html`<button class="btn primary big" onClick=${make}>Vytvořit PDF</button>` : null}
      ${pdf && pdf.state === "run" ? html`<div class="progress"><span style=${`width:${(pdf.done / pdf.total) * 100}%`}></span><small>Strana ${pdf.done} z ${pdf.total}…</small></div>` : null}
      ${pdf && pdf.state === "done" ? html`<div class="stack row">
        <button class="btn primary big" onClick=${async () => { try { if (await saveFile(`Rodinny-kalendar-${app.settings.year}.pdf`, pdf.blob)) toast("PDF je uložené ve Stažených souborech."); } catch (e) { toast("Uložení se nepovedlo: " + ((e && e.code) || e), "err"); } }}>Uložit PDF (${mb(pdf.blob.size)})</button>
        <button class="btn ghost" onClick=${() => setPdf(null)}>Vytvořit znovu</button></div>` : null}
      ${pdf && pdf.state === "err" ? html`<p class="warn">PDF se nepodařilo vytvořit: ${pdf.msg}</p>` : null}
    </section>
    <section class="card">
      <div class="card-head"><h2>Záloha</h2></div>
      ${app.backend.kind === "cloud" ? html`<p>Kalendář i fotky jsou uložené online. Zálohu si můžete stáhnout pro jistotu, nebo když chcete kalendář přenést jinam.</p>`
        : app.backend.kind === "github" ? html`<p>Kalendář i fotky se ukládají na GitHub do repozitáře <b>${St.GitHubBackend.label(app.backend.cfg)}</b>, každá změna zvlášť, takže se dá vrátit i starší verze. Zálohu do počítače si můžete stáhnout navíc.</p>`
        : html`<p class="warn">Kalendář je uložený jen v tomto prohlížeči. Stahujte si zálohu, ať o nic nepřijdete.</p>`}
      ${usageInfo && usageInfo.maxBytes ? html`<p class="muted">Místo na fotky: ${mb(usageInfo.bytes)} z ${mb(usageInfo.maxBytes)}</p>` : null}
      ${bk && bk.state === "run" ? html`<div class="progress"><span style=${`width:${(bk.done / Math.max(1, bk.total)) * 100}%`}></span><small>${bk.label} ${bk.done} z ${bk.total}…</small></div>` : null}
      <div class="stack row">
        <button class="btn" disabled=${bk && bk.state === "run"} onClick=${async () => {
          setBk({ state: "run", label: "Balím fotky", done: 0, total: Object.keys(app.photos).length });
          try {
            const blob = await exportBackup((done, total) => setBk({ state: "run", label: "Balím fotky", done, total }));
            setBk({ state: "save", blob });
          } catch (e) { setBk(null); toast("Záloha se nepovedla: " + ((e && e.message) || e), "err"); }
        }}>Připravit zálohu</button>
        ${bk && bk.state === "save" ? html`<button class="btn primary" onClick=${async () => { if (await saveFile(`kalendar-zaloha-${new Date().toISOString().slice(0, 10)}.zip`, bk.blob)) { toast("Záloha je uložená."); setBk(null); } }}>Uložit zálohu (${mb(bk.blob.size)})</button>` : null}
        ${bk && bk.state === "confirm" ? html`<span class="confirm-inline">Obnovit ze zálohy „${bk.file.name}“? Současný obsah se nahradí.
            <button class="btn danger sm" onClick=${async () => {
              const file = bk.file;
              setBk({ state: "run", label: "Obnovuji fotky", done: 0, total: 1 });
              try { await importBackup(file, (done, total) => setBk({ state: "run", label: "Obnovuji fotky", done, total })); toast("Záloha je obnovená."); }
              catch (e) { toast("Obnovení se nepovedlo: " + ((e && e.message) || e), "err"); }
              setBk(null);
            }}>Ano, obnovit</button><button class="btn ghost sm" onClick=${() => setBk(null)}>Ne</button></span>`
          : html`<${FileButton} label="Obnovit ze zálohy" accept=".zip,.json" onFiles=${(f) => setBk({ state: "confirm", file: f[0] })} disabled=${!app.backend.canUpload} />`}
      </div>
      ${app.backend.kind === "github" ? html`<div class="stack row">
        ${bk && bk.state === "forget" ? html`<span class="confirm-inline">Odpojit tento počítač? Data na GitHubu zůstanou, jen tady bude potřeba znovu vložit klíč.
            <button class="btn danger sm" onClick=${() => { St.forgetToken(); location.reload(); }}>Odpojit</button><button class="btn ghost sm" onClick=${() => setBk(null)}>Ne</button></span>`
          : html`<button class="btn ghost" onClick=${() => setBk({ state: "forget" })}>Odpojit tento počítač od GitHubu</button>`}
      </div>` : null}
    </section>
  </div>`;
}

function TokenSetup({ cfg }) {
  const [token, setToken] = useState("");
  const [state, setState] = useState(null); // null | "checking" | text chyby
  const submit = async (e) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setState("checking");
    const err = await St.GitHubBackend.check(cfg, t);
    if (err) { setState(err); return; }
    if (!St.saveToken(t)) { setState("Tento prohlížeč nedovolí klíč uložit. Nepoužíváte anonymní okno?"); return; }
    location.reload();
  };
  return html`<div class="splash setup">
    <div class="mark big" aria-hidden="true"><i></i></div>
    <h2>Rodinný kalendář</h2>
    <p>Tento počítač ještě není připojený k úložišti kalendáře.<br />Vložte přístupový klíč, který jste dostali. Stačí to udělat jednou.</p>
    <form class="stack" onSubmit=${submit}>
      <label class="field"><span>Přístupový klíč</span>
        <input id="gh-token" type="password" autocomplete="off" spellcheck="false" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder="github_pat_…" /></label>
      <button class="btn primary big" type="submit" disabled=${!token.trim() || state === "checking"}>${state === "checking" ? "Ověřuji…" : "Připojit"}</button>
      ${state && state !== "checking" ? html`<p class="warn">${state}</p>` : null}
    </form>
    <small class="muted">Ukládá se do repozitáře ${St.GitHubBackend.label(cfg)}.</small>
  </div>`;
}

// ---------- kostra ----------
function Header({ tab }) {
  const s = app.save;
  const status = s.failed ? html`<span class="save err">Neuloženo – zkontrolujte připojení</span>`
    : s.pending || s.active ? html`<span class="save busy">Ukládám…</span>` : html`<span class="save ok">Uloženo</span>`;
  const y = app.settings.year;
  return html`<header class="top">
    <div class="top-in">
      <div class="brand"><span class="mark" aria-hidden="true"><i></i>${String(y).slice(2)}</span><span>Rodinný kalendář</span></div>
      <div class="year" role="group" aria-label="Rok">
        <button class="btn icon" onClick=${() => saveSettings({ year: y - 1 })} aria-label="Předchozí rok">‹</button>
        <b>${y}</b>
        <button class="btn icon" onClick=${() => saveSettings({ year: y + 1 })} aria-label="Další rok">›</button>
      </div>
      <nav class="tabs">${TABS.map(([id, label]) => html`<a href=${"#" + id} class=${tab === id ? "on" : ""} aria-current=${tab === id ? "page" : null}>${label}</a>`)}</nav>
      <span class="grow"></span>
      ${status}
    </div>
  </header>`;
}

function Banner() {
  const b = app.backend;
  if (b.kind === "cloud" && !b.canUpload) return html`<div class="banner warn">Kalendář si teď jen prohlížíte. Pro nahrávání fotek je potřeba přístup „Editor“ – požádejte toho, kdo vám poslal odkaz.</div>`;
  if (b.kind === "local") return html`<div class="banner">Kalendář se ukládá jen v tomto prohlížeči na tomto počítači. Občas si stáhněte zálohu v záložce <a href="#tisk">Tisk a záloha</a>.</div>`;
  if (b.kind === "memory") return html`<div class="banner warn">Tento prohlížeč nedovolí nic uložit – po zavření stránky se práce ztratí. Na konci si stáhněte zálohu.</div>`;
  if (!app.family.people.length) return html`<div class="banner">Kalendář je zatím bez rodiny. Začněte v záložce <a href="#rodina">Rodina</a>, nebo obnovte zálohu v <a href="#tisk">Tisk a záloha</a>.</div>`;
  return null;
}

function App() {
  useApp();
  const [tab, setTab] = useState(() => (TABS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : "kalendar"));
  useEffect(() => {
    const h = () => { const t = location.hash.slice(1); if (TABS.some(([id]) => id === t)) setTab(t); };
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  if (app.phase === "loading") return html`<div class="splash"><div class="mark big" aria-hidden="true"><i></i></div><p>Otevírám kalendář…</p></div>`;
  if (app.phase === "setup") return html`<${TokenSetup} cfg=${app.setup} />`;
  if (app.phase === "error" && app.errorCode === "auth") return html`<div class="splash"><p><b>Klíč k úložišti přestal platit.</b></p><p>Požádejte o nový toho, kdo vám kalendář nastavil, a vložte ho znovu.</p>
    <button class="btn primary" onClick=${() => { St.forgetToken(); location.reload(); }}>Vložit nový klíč</button></div>`;
  if (app.phase === "error") return html`<div class="splash"><p><b>Kalendář se nepodařilo otevřít.</b></p><p>${app.error}</p><button class="btn primary" onClick=${() => location.reload()}>Zkusit znovu</button></div>`;
  return html`<${Header} tab=${tab} />
    <${Banner} />
    <main class=${"main tab-" + tab}>
      ${tab === "kalendar" ? html`<${CalendarTab} />` : tab === "fotky" ? html`<${PhotosTab} />` : tab === "rodina" ? html`<${FamilyTab} />` : html`<${PrintTab} />`}
    </main>
    ${app.toast ? html`<div class=${"toast " + app.toast.kind} role="status">${app.toast.text}</div>` : null}`;
}

// =====================================================================
// Start
// =====================================================================
async function loadFonts() {
  const entries = Object.entries(R.FONT_FILES);
  const bufs = await Promise.all(entries.map(([, u]) => fetch(u).then((r) => { if (!r.ok) throw new Error("písmo " + u); return r.arrayBuffer(); })));
  const faces = [];
  entries.forEach(([k], i) => { app.fonts[k] = bufs[i]; faces.push(new FontFace(k, bufs[i])); });
  const ui = [["Kal Sans", "asans-400", "400", "normal"], ["Kal Sans", "asans-500", "500", "normal"], ["Kal Sans", "asans-700", "700", "normal"],
    ["Kal Sans", "asans-400i", "400", "italic"], ["Kal Serif", "lora-500", "500", "normal"], ["Kal Serif", "lora-700", "700", "normal"]];
  for (const [fam, k, wgt, st] of ui) faces.push(new FontFace(fam, app.fonts[k], { weight: wgt, style: st }));
  for (const f of faces) document.fonts.add(f);
  await Promise.all(faces.map((f) => f.load()));
}

async function start() {
  render(html`<${App} />`, document.getElementById("app"));
  try {
    const [, kal, conn] = await Promise.all([
      loadFonts(),
      fetch("kalendarium.json").then((r) => r.json()),
      St.connect(),
    ]);
    app.kal = kal;
    if (conn.needsToken) { app.phase = "setup"; app.setup = conn.needsToken; emit(); return; }
    app.backend = conn.backend;
    app.downloads = conn.downloads;
    app.saver = St.Saver(() => app.backend, (s) => { app.save = s; emit(); });
    await new Promise((res, rej) => app.backend.start(onDoc, res, rej));
    app.phase = "ready";
  } catch (e) {
    console.error(e);
    app.phase = "error";
    app.errorCode = e && e.code;
    app.error = e === "timeout" ? "Úložiště neodpovídá. Zkontrolujte připojení k internetu." : "Zkuste stránku obnovit. (" + ((e && e.message) || e) + ")";
  }
  emit();
  window.__kalendar = { app, importFiles, importBackup, autoFill, unusedToBonus, buildPdf, setRef, updateFamily };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && app.saver) app.saver.flush(); });
  window.addEventListener("beforeunload", (e) => { if (app.save.pending || app.save.active) { e.preventDefault(); e.returnValue = ""; } });
}
start();

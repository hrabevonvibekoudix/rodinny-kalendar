/* Rodinný kalendář – rozvržení stránek a vykreslení.
   Jedno rozvržení (v milimetrech) se kreslí do náhledu (canvas) i do PDF (jsPDF),
   takže náhled odpovídá tisku. Globálně jako window.KalRender. */
(function (root) {
  "use strict";
  const PT = 25.4 / 72; // mm na typografický bod

  const FONT_FILES = {
    "arimo-400": "fonts/arimo-400.ttf",
    "arimo-700": "fonts/arimo-700.ttf",
    "lora-500": "fonts/lora-500.ttf",
    "lora-700": "fonts/lora-700.ttf",
    "lora-400i": "fonts/lora-400i.ttf",
    "asans-400": "fonts/asans-400.ttf",
    "asans-500": "fonts/asans-500.ttf",
    "asans-700": "fonts/asans-700.ttf",
    "asans-400i": "fonts/asans-400i.ttf",
  };

  // Nový vzhled: každý měsíc má svou tlumenou barvu (zima modrá → jaro zelená → léto → podzim → jedle).
  const MONTH_ACCENT = ["#3B6EA5", "#5A62A8", "#3C8C68", "#5F8F2F", "#B04A7A", "#2C8A97",
    "#B8731A", "#7A8A26", "#8C6A2C", "#A4472D", "#6A5A8C", "#2D6B57"];

  const THEMES = {
    klasik: {
      id: "klasik", name: "Klasický", note: "Rozložení jako dosud: fotka – dny – fotka, tyrkysové rámečky.",
      teal: "#2F8299", blue: "#1F45D1", red: "#E0261E", ink: "#111111", out: "#F1F5F6",
    },
    novy: {
      id: "novy", name: "Nový", note: "Barva podle měsíce, zaoblené fotky, víc vzduchu.",
      ink: "#1E2226", muted: "#6A7077", hair: "#D8DCE0", red: "#C0262D",
    },
  };

  // Stránka jako máma tiskne: 297 × 182 mm, hřebenová vazba nahoře (bind = volný pruh pro vazbu).
  // sheet: "a4cut" = tisk na A4 a odstřižení spodku, "exact" = PDF přesně ve velikosti stránky.
  const PAGE_DEFAULT = { w: 297, h: 182, m: 10, bind: 16, sheet: "a4cut" };

  /** Na jaký papír se PDF tiskne a kde se stříhá. */
  function sheetFor(page) {
    const p = Object.assign({}, PAGE_DEFAULT, page);
    if (p.sheet === "a4cut" && Math.abs(p.w - 297) < 0.6 && p.h < 209.5) return { w: 297, h: 210, cutY: p.h };
    return { w: p.w, h: p.h, cutY: null };
  }

  // ---------- pomocné ----------
  function mix(hex, t) { // smíchá barvu s bílou: t=0 bílá, t=1 původní
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = (c) => Math.round(255 - (255 - c) * t).toString(16).padStart(2, "0");
    return "#" + f(r) + f(g) + f(b);
  }

  function rangeLabel(week) {
    const K = root.KalCore;
    const days = week.days.filter(Boolean);
    const a = days[0], b = days[days.length - 1];
    if (a === b) return `${a.day}. ${K.MONTHS_GEN[a.month]}`;
    if (a.month === b.month) return `${a.day}.–${b.day}. ${K.MONTHS_GEN[a.month]}`;
    return `${a.day}. ${K.MONTHS_GEN[a.month]} – ${b.day}. ${K.MONTHS_GEN[b.month]}`;
  }

  /** Text, který se zmenší, aby se vešel do maxW (mm). */
  function fitText(measure, s, f, size, maxW, minRatio) {
    if (!maxW || !measure) return size;
    const w = measure(s, f, size);
    if (w <= maxW) return size;
    return Math.max(size * (minRatio || 0.6), size * maxW / w);
  }

  function T(L, x, y, s, f, size, c, a, maxW, minRatio) {
    if (!s) return;
    const sz = fitText(L.measure, s, f, size, maxW, minRatio);
    L.items.push({ t: "text", x, y, s, f, size: sz, c, a: a || "left", maxW });
  }

  // ---------- stránky ----------
  const COVER_ORDERS = { young: "Od nejmladšího", old: "Od nejstaršího", random: "Náhodně", name: "Podle jména" };
  function shuffle(arr, seed) { // stejné semínko = stejné pořadí, dokud se nezamíchá znovu
    let s = seed >>> 0 || 1;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  /**
   * Seznam stránek kalendáře.
   * cal = KalCore.buildYear(...), people = [...], yearDoc = {weeks:{}, bonus:[]}
   */
  function buildPages(cal, people, yearDoc, opts) {
    const pages = [];
    const doc = yearDoc || {};
    // jen naplněné portréty; mřížka se přizpůsobí jejich počtu
    const cov = doc.cover || {};
    const order = COVER_ORDERS[cov.order] ? cov.order : "young";
    let portraits = (people || [])
      .filter((p) => !p.noCover && p.portrait && p.portrait.photo)
      .map((p) => ({ personId: p.id, name: p.name, born: p.born || "", photo: p.portrait.photo, crop: p.portrait.crop }));
    if (order === "young") portraits.sort((a, b) => b.born.localeCompare(a.born));
    else if (order === "old") portraits.sort((a, b) => (a.born || "9").localeCompare(b.born || "9"));
    else if (order === "name") portraits.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    else if (order === "random") portraits = shuffle(portraits.sort((a, b) => a.personId.localeCompare(b.personId)), cov.seed || 1);
    const wanted = (people || []).filter((p) => !p.noCover).length;
    pages.push({ kind: "cover", id: "cover", title: "Titulka", sub: `${portraits.length} z ${wanted} portrétů`, portraits, order });
    for (const w of cal.weeks) {
      const slots = (doc.weeks || {})[w.monday] || {};
      pages.push({
        kind: "week", id: "w:" + w.monday, week: w,
        title: `${w.isoWeek}. týden`, sub: rangeLabel(w),
        L: slots.L || null, R: slots.R || null,
      });
    }
    const bonus = (doc.bonus || []).filter(Boolean);
    const per = (opts && opts.bonusPerPage) || 14;
    for (let i = 0; i * per < bonus.length; i++) {
      pages.push({ kind: "bonus", id: "b:" + i, title: "Bonusy", sub: `${Math.min(per, bonus.length - i * per)} fotek`,
        items: bonus.slice(i * per, (i + 1) * per).map((photo, k) => ({ photo, index: i * per + k })) });
    }
    return pages;
  }

  /**
   * Rozvrhne stránku. ctx = {theme, page:{w,h,m}, year, photos:{id:meta}, measure(text,font,pt)->mm, people}
   * Vrací {items, slots, days}; slots/days slouží k proklikávání v náhledu.
   */
  function layout(page, ctx) {
    const pg = Object.assign({}, PAGE_DEFAULT, ctx.page);
    const top = Math.max(pg.m, pg.bind || 0);
    // obsahový rámeček: nahoře pruh pro vazbu, jinde okraj m
    const L = { items: [], slots: [], days: [], measure: ctx.measure, W: pg.w, H: pg.h, m: pg.m, bind: pg.bind || 0,
      x0: pg.m, y0: top, CW: pg.w - 2 * pg.m, CH: pg.h - top - pg.m };
    const th = THEMES[ctx.theme] || THEMES.klasik;
    if (page.kind === "cover") (th.id === "novy" ? coverNovy : coverKlasik)(L, page, ctx, th);
    else if (page.kind === "week") (th.id === "novy" ? weekNovy : weekKlasik)(L, page, ctx, th);
    else if (page.kind === "bonus") bonusPage(L, page, ctx, th);
    return L;
  }

  function slotImg(L, key, x, y, w, h, ref, extra) {
    const it = Object.assign({ t: "img", slot: key, x, y, w, h, photo: ref && ref.photo, crop: ref && ref.crop }, extra || {});
    L.items.push(it);
    L.slots.push({ key, x, y, w, h, r: it.r || 0, photo: it.photo, crop: it.crop });
  }

  // ----- týden: klasický (jako mámin Excel) -----
  function weekKlasik(L, page, ctx, th) {
    const { x0, CW, CH } = L;
    const m = x0;
    const wl = CW * 0.31, wd = CW * 0.38, wr = CW - wl - wd;
    const hh = 14;
    const bh = Math.min(CH - hh, wl / 0.72); // fotky zhruba 3:4 jako dosud
    const y0 = L.y0 + (CH - hh - bh) / 2; // blok svisle doprostřed pod vazbu
    const by = y0 + hh, mx = m + wl;
    const w = page.week;

    T(L, mx + 3, y0 + 10.5, w.monthLabel, "arimo-700", 24, th.teal, "left", wd * 0.66);
    T(L, mx + wd - 2, y0 + 10.5, `${w.isoWeek}. týden`, "arimo-700", 14, th.teal, "right");

    slotImg(L, page.id + ":L", m, by, wl, bh, page.L, { frame: { c: th.teal, lw: 0.5 } });
    slotImg(L, page.id + ":R", mx + wd, by, wr, bh, page.R, { frame: { c: th.teal, lw: 0.5 } });

    const rh = bh / 7;
    w.days.forEach((d, i) => {
      const ry = by + i * rh;
      if (!d) { L.items.push({ t: "rect", x: mx, y: ry, w: wd, h: rh, fill: th.out }); return; }
      L.days.push({ date: d.date, md: d.md, x: mx, y: ry, w: wd, h: rh });
      const col = d.red ? th.red : th.ink;
      T(L, mx + 12.5, ry + rh * 0.72, String(d.day), "arimo-700", 23, col, "right");
      T(L, mx + 14, ry + rh * 0.72, d.dowLabel, "arimo-700", 13, d.red ? th.red : th.blue, "left");
      const tx = mx + 25, tw = wd - 27;
      T(L, tx, ry + 3.6, d.saint, "arimo-400", 7.5, th.ink, "left", tw);
      T(L, tx, ry + 7.4, d.name, "arimo-700", 8.5, th.ink, "left", tw);
      const ev = d.events;
      ev.slice().reverse().forEach((e, k) => {
        const red = e.kind === "custom" && e.red;
        const size = ev.length > 2 ? 7.5 : 8.8;
        T(L, mx + wd - 2, ry + rh - 2.4 - k * (size * PT + 0.8), e.text, "arimo-700", size, red ? th.red : th.ink, "right", wd - 26);
      });
    });
    // mřížka tabulky
    for (let i = 0; i <= 7; i++) L.items.push({ t: "line", x1: mx, y1: by + i * rh, x2: mx + wd, y2: by + i * rh, c: th.teal, lw: 0.9 });
    L.items.push({ t: "line", x1: mx, y1: by, x2: mx, y2: by + bh, c: th.teal, lw: 0.9 });
    L.items.push({ t: "line", x1: mx + wd, y1: by, x2: mx + wd, y2: by + bh, c: th.teal, lw: 0.9 });
  }

  // ----- týden: nový vzhled -----
  const monthTitle = (w) => w.monthLabel.toLowerCase().replace(/^./, (c) => c.toUpperCase());

  function weekNovy(L, page, ctx, th) {
    if (L.CW / L.CH > 1.45) return weekNovyWide(L, page, ctx, th);
    return weekNovyTall(L, page, ctx, th);
  }

  /** Široká stránka (máma: 297 × 182 s vazbou): hlavička přes celou šířku, pod ní fotka – dny – fotka. */
  function weekNovyWide(L, page, ctx, th) {
    const { x0, y0, CW, CH } = L;
    const w = page.week;
    const acc = MONTH_ACCENT[w.months[w.months.length - 1]];
    const g = 5, hh = 19;
    const wl = CW * 0.34, wd = CW * 0.345, wr = CW - wl - wd - 2 * g;
    const by = y0 + hh, bh = CH - hh;
    const dx = x0 + wl + g;

    T(L, x0, y0 + 11, monthTitle(w), "lora-700", 30, acc, "left", wl + wd);
    T(L, x0 + CW, y0 + 11, `${w.isoWeek}. týden`, "lora-500", 15, acc, "right");
    T(L, x0 + CW, y0 + 15.6, rangeLabel(w), "asans-500", 8.5, th.muted, "right");
    L.items.push({ t: "line", x1: x0, y1: by - 2.5, x2: x0 + CW, y2: by - 2.5, c: acc, lw: 0.5 });

    slotImg(L, page.id + ":L", x0, by, wl, bh, page.L, { r: 2 });
    slotImg(L, page.id + ":R", dx + wd + g, by, wr, bh, page.R, { r: 2 });

    const rh = bh / 7;
    w.days.forEach((d, i) => {
      const ry = by + i * rh;
      if (i) L.items.push({ t: "line", x1: dx, y1: ry, x2: dx + wd, y2: ry, c: th.hair, lw: 0.25 });
      if (!d) { L.items.push({ t: "rect", x: dx, y: ry + 0.5, w: wd, h: rh - 1, fill: "#F5F6F7" }); return; }
      L.days.push({ date: d.date, md: d.md, x: dx, y: ry, w: wd, h: rh });
      if (d.dow >= 5 || d.red) L.items.push({ t: "rect", x: dx, y: ry + 0.4, w: wd, h: rh - 0.8, fill: mix(d.red ? th.red : acc, 0.07) });
      const col = d.red ? th.red : th.ink;
      const base = ry + Math.min(rh * 0.62, 11.5);
      T(L, dx + 11, base, String(d.day), "lora-700", 20, col, "right");
      T(L, dx + 12.6, base, d.dowLabel.toUpperCase(), "asans-700", 7, d.red ? th.red : th.muted, "left");
      const tx = dx + 21.5, tw = wd - 22.5;
      T(L, tx, ry + 4.6, d.saint, "asans-400i", 7, th.muted, "left", tw, 0.55);
      T(L, tx, ry + 8.8, d.name, "asans-700", 9, th.ink, "left", tw, 0.6);
      const many = d.events.length > 2;
      const step = many ? 2.9 : 3.5;
      let yy = ry + 8.8 + (many ? 3.2 : 3.9);
      for (const e of d.events) {
        if (yy > ry + rh - 0.6) break;
        const f = e.kind === "liturgy" ? "lora-400i" : "asans-700";
        const c = e.kind === "birthday" ? acc : e.kind === "custom" && e.red ? th.red : e.kind === "liturgy" ? th.muted : th.ink;
        const indent = e.kind === "birthday" ? 2.6 : 0;
        if (e.kind === "birthday") L.items.push({ t: "circle", cx: tx + 0.85, cy: yy - (many ? 0.8 : 1), rad: 0.85, fill: acc });
        T(L, tx + indent, yy, e.text, f, many ? 7 : 8, c, "left", tw - indent, 0.6);
        yy += step;
      }
    });
  }

  /** Vysoká stránka (celá A4): velká fotka přes celou výšku, vpravo dny a pod nimi menší fotka. */
  function weekNovyTall(L, page, ctx, th) {
    const { x0, y0, CW, CH } = L;
    const m = x0;
    const w = page.week;
    const acc = MONTH_ACCENT[w.months[w.months.length - 1]];
    const lw = CW * 0.555, gap = 7;
    const rx = m + lw + gap, rw = CW - lw - gap;

    slotImg(L, page.id + ":L", m, y0, lw, CH, page.L, { r: 2 });

    // hlavička
    T(L, rx, y0 + 10.5, monthTitle(w), "lora-700", 30, acc, "left", rw - 30);
    T(L, rx + rw, y0 + 10.5, String(w.isoWeek), "lora-500", 30, mix(acc, 0.35), "right");
    T(L, rx, y0 + 17, `${w.isoWeek}. týden  ·  ${rangeLabel(w)}`, "asans-500", 9, th.muted, "left", rw);

    const top = y0 + 22, rh = Math.min(13.2, (CH - 22 - 35) / 7);
    w.days.forEach((d, i) => {
      const ry = top + i * rh;
      L.items.push({ t: "line", x1: rx, y1: ry, x2: rx + rw, y2: ry, c: i === 0 ? acc : th.hair, lw: i === 0 ? 0.5 : 0.25 });
      if (!d) { L.items.push({ t: "rect", x: rx, y: ry + 0.4, w: rw, h: rh - 0.8, fill: "#F5F6F7" }); return; }
      L.days.push({ date: d.date, md: d.md, x: rx, y: ry, w: rw, h: rh });
      if (d.dow >= 5 || d.red) L.items.push({ t: "rect", x: rx, y: ry + 0.3, w: rw, h: rh - 0.6, fill: mix(d.red ? th.red : acc, 0.06) });
      const col = d.red ? th.red : th.ink;
      T(L, rx + 10, ry + 9, String(d.day), "lora-700", 19, col, "right");
      T(L, rx + 12, ry + 8.6, d.dowLabel.toUpperCase(), "asans-700", 7, d.red ? th.red : th.muted, "left");

      // události vpravo, jejich šířka určí, kolik místa zbude na jména
      const ev = d.events.map((e) => {
        const f = e.kind === "birthday" ? "asans-700" : e.kind === "liturgy" ? "lora-400i" : "asans-700";
        const size = d.events.length > 2 ? 7.2 : e.kind === "liturgy" ? 8.4 : 8.6;
        const c = e.kind === "birthday" ? acc : e.kind === "custom" && e.red ? th.red : e.kind === "liturgy" ? th.muted : th.ink;
        return { e, f, size, c };
      });
      const maxEv = rw * 0.5;
      let evW = 0;
      for (const x of ev) {
        x.size = fitText(L.measure, x.e.text, x.f, x.size, maxEv - (x.e.kind === "birthday" ? 3 : 0), 0.7);
        evW = Math.max(evW, (L.measure ? L.measure(x.e.text, x.f, x.size) : 30) + (x.e.kind === "birthday" ? 3 : 0));
      }
      const lineH = (s) => s * PT + 1.1;
      const totalH = ev.reduce((a, x) => a + lineH(x.size), 0);
      let yy = ry + rh / 2 - totalH / 2;
      for (const x of ev) {
        yy += lineH(x.size);
        L.items.push({ t: "text", x: rx + rw - 1, y: yy - 1.1, s: x.e.text, f: x.f, size: x.size, c: x.c, a: "right" });
        if (x.e.kind === "birthday") {
          const tw = L.measure ? L.measure(x.e.text, x.f, x.size) : 20;
          L.items.push({ t: "circle", cx: rx + rw - 1 - tw - 1.9, cy: yy - 1.1 - x.size * PT * 0.33, rad: 0.85, fill: acc });
        }
      }
      const tx = rx + 21, tw = Math.max(20, rw - 21 - (ev.length ? evW + 3 : 0));
      T(L, tx, ry + 5.2, d.saint, "asans-400i", 7.2, th.muted, "left", tw, 0.55);
      T(L, tx, ry + 9.6, d.name, "asans-700", 9, th.ink, "left", tw, 0.6);
    });
    const end = top + 7 * rh;
    L.items.push({ t: "line", x1: rx, y1: end, x2: rx + rw, y2: end, c: th.hair, lw: 0.25 });
    const py = end + 5;
    slotImg(L, page.id + ":R", rx, py, rw, y0 + CH - py, page.R, { r: 2 });
  }

  // ----- titulka -----
  function coverGrid(n, CW, CH, gap) {
    let best = null;
    for (let cols = 3; cols <= 12; cols++) {
      for (let rows = 2; rows <= 9; rows++) {
        const cells = cols * rows - 2;
        if (cells < Math.max(n, 6)) continue;
        const s = Math.min((CW - gap * (cols - 1)) / cols, (CH - gap * (rows - 1)) / rows);
        const empty = cells - n;
        const score = s - empty * 0.8;
        if (!best || score > best.score) best = { cols, rows, s, score };
      }
    }
    return best;
  }

  function coverLayout(L, page, ctx, th, gap, r) {
    const { CW, CH } = L;
    const ps = page.portraits;
    const g = coverGrid(ps.length, CW, CH, gap);
    const gw = g.cols * g.s + gap * (g.cols - 1), gh = g.rows * g.s + gap * (g.rows - 1);
    const x0 = L.x0 + (CW - gw) / 2, y0 = L.y0 + (CH - gh) / 2;
    const yr = Math.floor((g.rows - 1) / 2), yc = Math.floor((g.cols - 2) / 2);
    let k = 0;
    const cells = [];
    for (let rI = 0; rI < g.rows; rI++) for (let c = 0; c < g.cols; c++) {
      if (rI === yr && (c === yc || c === yc + 1)) continue;
      cells.push({ x: x0 + c * (g.s + gap), y: y0 + rI * (g.s + gap) });
    }
    // když je portrétů méně než políček, prázdná políčka nechá až na konci
    for (const cell of cells) {
      const p = ps[k++];
      if (p) slotImg(L, "cover:" + p.personId, cell.x, cell.y, g.s, g.s, p, { r, frame: th.id === "klasik" ? { c: th.teal, lw: 0.35 } : null });
      else L.items.push({ t: "empty", x: cell.x, y: cell.y, w: g.s, h: g.s, r });
    }
    return { x: x0 + yc * (g.s + gap), y: y0 + yr * (g.s + gap), w: g.s * 2 + gap, h: g.s };
  }

  function coverKlasik(L, page, ctx, th) {
    const b = coverLayout(L, page, ctx, th, 0, 0);
    L.items.push({ t: "rect", x: b.x, y: b.y, w: b.w, h: b.h, stroke: th.teal, lw: 0.35 });
    T(L, b.x + b.w / 2, b.y + b.h / 2 + b.h * 0.19, String(ctx.year), "arimo-400", Math.min(64, b.h * 1.55), th.teal, "center");
  }

  function coverNovy(L, page, ctx, th) {
    const b = coverLayout(L, page, ctx, th, 2, 1.4);
    T(L, b.x + b.w / 2, b.y + b.h * 0.34, "R O D I N N Ý   K A L E N D Á Ř", "asans-700", 7, th.muted, "center", b.w - 4);
    T(L, b.x + b.w / 2, b.y + b.h * 0.8, String(ctx.year), "lora-700", Math.min(60, b.h * 1.35), MONTH_ACCENT[0], "center");
  }

  // ----- bonusy: koláž -----
  function justify(aspects, bx, by, bw, bh, gap) {
    const n = aspects.length;
    if (!n) return [];
    let best = null;
    for (let k = 1; k <= Math.min(n, 6); k++) {
      const rows = partition(aspects, k);
      const hs = rows.map((r) => (bw - gap * (r.length - 1)) / r.reduce((a, i) => a + aspects[i], 0));
      const total = hs.reduce((a, b) => a + b, 0) + gap * (k - 1);
      const score = Math.abs(Math.log(total / bh));
      if (!best || score < best.score) best = { rows, hs, total, score };
    }
    const f = Math.min(1, (bh - gap * (best.rows.length - 1)) / (best.total - gap * (best.rows.length - 1)));
    const out = [];
    let y = by + (bh - (best.hs.reduce((a, b) => a + b * f, 0) + gap * (best.rows.length - 1))) / 2;
    best.rows.forEach((row, ri) => {
      const h = best.hs[ri] * f;
      const rowW = row.reduce((a, i) => a + aspects[i] * h, 0) + gap * (row.length - 1);
      let x = bx + (bw - rowW) / 2;
      for (const i of row) { const w = aspects[i] * h; out[i] = { x, y, w, h }; x += w + gap; }
      y += h + gap;
    });
    return out;
  }

  function partition(a, k) { // lineární rozdělení posloupnosti do k řádků s co nejvyrovnanějším součtem
    const n = a.length;
    if (k >= n) return a.map((_, i) => [i]);
    const pre = [0];
    for (const x of a) pre.push(pre[pre.length - 1] + x);
    const cost = (i, j) => { const s = pre[j] - pre[i]; const t = pre[n] / k; return (s - t) * (s - t); };
    const dp = Array.from({ length: k + 1 }, () => Array(n + 1).fill(Infinity));
    const cut = Array.from({ length: k + 1 }, () => Array(n + 1).fill(0));
    dp[0][0] = 0;
    for (let r = 1; r <= k; r++) for (let j = r; j <= n; j++) for (let i = r - 1; i < j; i++) {
      const v = dp[r - 1][i] + cost(i, j);
      if (v < dp[r][j]) { dp[r][j] = v; cut[r][j] = i; }
    }
    const rows = [];
    let j = n;
    for (let r = k; r >= 1; r--) { const i = cut[r][j]; rows.unshift([...Array(j - i).keys()].map((x) => x + i)); j = i; }
    return rows;
  }

  function bonusPage(L, page, ctx, th) {
    const { W, x0, y0, CW, CH } = L;
    const m = x0;
    const klas = th.id === "klasik";
    const gap = klas ? 0 : 2.5;
    const capH = klas ? 12 : 14;
    const by = klas ? y0 : y0 + capH;
    const aspects = page.items.map((it) => {
      const p = ctx.photos[it.photo];
      return p && p.w && p.h ? Math.min(2.4, Math.max(0.5, p.w / p.h)) : 1.333;
    });
    const rects = justify(aspects, m, by, CW, CH - capH, gap);
    page.items.forEach((it, i) => {
      const r = rects[i];
      slotImg(L, "bonus:" + it.index, r.x, r.y, r.w, r.h, { photo: it.photo }, klas ? { frame: { c: th.teal, lw: 0.35 } } : { r: 1.4 });
    });
    if (klas) T(L, W / 2, y0 + CH - 2, "B O N U S Y   -   C O   S E   N E V E Š L O", "arimo-700", 13, th.teal, "center", CW);
    else {
      T(L, m, y0 + 8.5, "Bonusy", "lora-700", 22, MONTH_ACCENT[11], "left");
      T(L, m + (L.measure ? L.measure("Bonusy", "lora-700", 22) : 30) + 4, y0 + 8.5, "co se do týdnů nevešlo", "lora-400i", 12, th.muted, "left");
    }
  }

  // ---------- geometrie fotky ve slotu ----------
  function coverRect(iw, ih, slot, crop) {
    const z = Math.max(1, (crop && crop.z) || 1);
    const s = Math.max(slot.w / iw, slot.h / ih) * z; // mm na pixel
    const dw = iw * s, dh = ih * s;
    let dx = slot.x + slot.w / 2 - ((crop && crop.x != null) ? crop.x : 0.5) * dw;
    let dy = slot.y + slot.h / 2 - ((crop && crop.y != null) ? crop.y : 0.5) * dh;
    dx = Math.min(slot.x, Math.max(slot.x + slot.w - dw, dx));
    dy = Math.min(slot.y, Math.max(slot.y + slot.h - dh, dy));
    return { dx, dy, dw, dh, s };
  }

  /** Posun ořezu o (ddx, ddy) mm; vrací nový crop. */
  function panCrop(iw, ih, slot, crop, ddx, ddy) {
    const r = coverRect(iw, ih, slot, crop);
    const nx = (slot.x + slot.w / 2 - (r.dx + ddx)) / r.dw;
    const ny = (slot.y + slot.h / 2 - (r.dy + ddy)) / r.dh;
    const hx = slot.w / 2 / r.dw, hy = slot.h / 2 / r.dh;
    return { z: (crop && crop.z) || 1, x: clamp(nx, hx, 1 - hx), y: clamp(ny, hy, 1 - hy) };
  }
  const clamp = (v, a, b) => (a > b ? 0.5 : Math.min(b, Math.max(a, v)));

  /** Efektivní rozlišení fotky ve slotu (DPI) – pod ~150 hrozí rozmazání v tisku. */
  function slotDpi(photo, slot, crop) {
    if (!photo || !photo.w) return null;
    const r = coverRect(photo.w, photo.h, slot, crop);
    return Math.round(25.4 / r.s);
  }

  // ---------- vykreslení do canvasu ----------
  function roundRectPath(g, x, y, w, h, r) {
    g.beginPath();
    if (!r) { g.rect(x, y, w, h); return; }
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  /**
   * g = CanvasRenderingContext2D, scale = px na mm.
   * opts.image(photoId) -> {img, w, h} | null (načtený náhled), opts.placeholders, opts.active (klíč vybraného slotu)
   */
  function drawCanvas(g, L, scale, opts) {
    opts = opts || {};
    g.save();
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = "#FFFFFF";
    g.fillRect(0, 0, L.W, L.H);
    g.textBaseline = "alphabetic";
    if (opts.placeholders && L.bind >= 8) { // jen v náhledu: kde bude hřebenová vazba
      g.fillStyle = "#E3E6E8";
      for (let x = 7; x < L.W - 5; x += 14.28) { roundRectPath(g, x, 3.2, 3.4, 2.2, 0.8); g.fill(); }
    }
    for (const it of L.items) {
      if (it.t === "rect") {
        roundRectPath(g, it.x, it.y, it.w, it.h, it.r || 0);
        if (it.fill) { g.fillStyle = it.fill; g.fill(); }
        if (it.stroke) { g.strokeStyle = it.stroke; g.lineWidth = it.lw || 0.3; g.stroke(); }
      } else if (it.t === "line") {
        g.beginPath(); g.moveTo(it.x1, it.y1); g.lineTo(it.x2, it.y2);
        g.strokeStyle = it.c; g.lineWidth = it.lw; g.stroke();
      } else if (it.t === "circle") {
        g.beginPath(); g.arc(it.cx, it.cy, it.rad, 0, Math.PI * 2); g.fillStyle = it.fill; g.fill();
      } else if (it.t === "text") {
        g.font = `${it.size * PT}px "${it.f}"`;
        g.fillStyle = it.c;
        g.textAlign = it.a;
        g.fillText(it.s, it.x, it.y);
      } else if (it.t === "empty") {
        if (opts.placeholders) {
          roundRectPath(g, it.x, it.y, it.w, it.h, it.r || 0);
          g.fillStyle = "#F2F3F4"; g.fill();
        }
      } else if (it.t === "img") {
        const im = it.photo && opts.image ? opts.image(it.photo) : null;
        g.save();
        roundRectPath(g, it.x, it.y, it.w, it.h, it.r || 0);
        g.clip();
        if (im && im.img) {
          const r = coverRect(im.w, im.h, it, it.crop);
          g.drawImage(im.img, r.dx, r.dy, r.dw, r.dh);
        } else if (opts.placeholders) {
          g.fillStyle = it.photo ? "#E9ECEF" : "#F1EFEA";
          g.fillRect(it.x, it.y, it.w, it.h);
          if (!it.photo && it.w > 12) {
            const label = it.label || (it.slot.startsWith("cover") ? "portrét" : "+ fotka");
            let size = Math.min(11, it.w / 4.5) * PT;
            g.font = `${size}px "asans-500"`;
            const tw = g.measureText(label).width;
            if (tw > it.w - 3) { size *= (it.w - 3) / tw; g.font = `${size}px "asans-500"`; }
            g.fillStyle = "#8F897F";
            g.textAlign = "center";
            g.fillText(label, it.x + it.w / 2, it.y + it.h / 2 + size * 0.35);
          }
        }
        g.restore();
        if (it.frame) {
          g.strokeStyle = it.frame.c; g.lineWidth = it.frame.lw;
          roundRectPath(g, it.x, it.y, it.w, it.h, it.r || 0); g.stroke();
        }
        if (opts.active && opts.active === it.slot) {
          g.strokeStyle = "#F2A900"; g.lineWidth = 1.2;
          roundRectPath(g, it.x + 0.6, it.y + 0.6, it.w - 1.2, it.h - 1.2, it.r || 0); g.stroke();
        }
      }
    }
    g.restore();
  }

  // ---------- PDF ----------
  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function registerFonts(doc, buffers) {
    for (const [key, buf] of Object.entries(buffers)) {
      doc.addFileToVFS(key + ".ttf", b64(buf));
      doc.addFont(key + ".ttf", key, "normal");
    }
  }

  async function canvasToJpeg(c, q) {
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", q));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Vykreslí jednu stránku do jsPDF. opts.full(photoId) -> Promise<{img, w, h}> (plné rozlišení)
   */
  async function drawPdf(doc, L, opts) {
    for (const it of L.items) {
      if (it.t === "rect") {
        const style = it.fill && it.stroke ? "FD" : it.fill ? "F" : "S";
        if (it.fill) doc.setFillColor(it.fill);
        if (it.stroke) { doc.setDrawColor(it.stroke); doc.setLineWidth(it.lw || 0.3); }
        if (it.r) doc.roundedRect(it.x, it.y, it.w, it.h, it.r, it.r, style);
        else doc.rect(it.x, it.y, it.w, it.h, style);
      } else if (it.t === "line") {
        doc.setDrawColor(it.c); doc.setLineWidth(it.lw);
        doc.line(it.x1, it.y1, it.x2, it.y2);
      } else if (it.t === "circle") {
        doc.setFillColor(it.fill); doc.circle(it.cx, it.cy, it.rad, "F");
      } else if (it.t === "text") {
        doc.setFont(it.f, "normal"); doc.setFontSize(it.size); doc.setTextColor(it.c);
        doc.text(it.s, it.x, it.y, it.a === "left" ? { baseline: "alphabetic" } : { align: it.a, baseline: "alphabetic" });
      } else if (it.t === "img") {
        const im = it.photo ? await opts.full(it.photo) : null;
        if (!im) {
          if (it.frame) { doc.setDrawColor(it.frame.c); doc.setLineWidth(it.frame.lw); doc.rect(it.x, it.y, it.w, it.h, "S"); }
          continue;
        }
        const r = coverRect(im.w, im.h, it, it.crop);
        const sx = (it.x - r.dx) / r.s, sy = (it.y - r.dy) / r.s, sw = it.w / r.s, sh = it.h / r.s;
        const dpi = opts.dpi || 300;
        const tw = Math.max(16, Math.round(Math.min(it.w / 25.4 * dpi, sw)));
        const tht = Math.max(16, Math.round(tw * it.h / it.w));
        const c = document.createElement("canvas");
        c.width = tw; c.height = tht;
        const g = c.getContext("2d");
        g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, tw, tht);
        if (it.r) { g.save(); roundRectPath(g, 0, 0, tw, tht, it.r * tw / it.w); g.clip(); }
        g.imageSmoothingQuality = "high";
        g.drawImage(im.img, sx, sy, sw, sh, 0, 0, tw, tht);
        if (it.r) g.restore();
        const jpg = await canvasToJpeg(c, 0.9);
        doc.addImage(jpg, "JPEG", it.x, it.y, it.w, it.h, undefined, "NONE");
        c.width = c.height = 0;
        if (it.frame) {
          doc.setDrawColor(it.frame.c); doc.setLineWidth(it.frame.lw);
          doc.rect(it.x, it.y, it.w, it.h, "S");
        }
      }
    }
  }

  const api = { PT, FONT_FILES, THEMES, MONTH_ACCENT, PAGE_DEFAULT, COVER_ORDERS, sheetFor, buildPages, layout, drawCanvas, drawPdf, registerFonts,
    coverRect, panCrop, slotDpi, rangeLabel, justify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KalRender = api;
})(typeof window !== "undefined" ? window : globalThis);

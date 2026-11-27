/* Rodinný kalendář – ukládání.
   CloudBackend: sdílená databáze a úložiště fotek artefaktu (máma přihlášená jako Editor).
   LocalBackend: IndexedDB v prohlížeči (bez přihlášení), MemoryBackend: když prohlížeč nic neuloží.
   Všechny mají stejné rozhraní; globálně window.KalStore. */
(function (root) {
  "use strict";

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ASSET_ID = /^[0-9a-f]{32}$/;

  // ---------- Cloud ----------
  function CloudBackend(db, assets) {
    this.kind = "cloud";
    this.db = db;
    this.assets = assets;
    this.canUpload = !!assets;
    this.unsubs = [];
  }
  CloudBackend.prototype.start = function (onDoc, onReady, onError) {
    let pending = 4, done = false;
    const ready = () => { if (!done && --pending <= 0) { done = true; clearTimeout(timer); onReady(); } };
    const timer = setTimeout(() => { if (!done) onError("timeout"); }, 10000);
    const fail = (e) => { clearTimeout(timer); onError((e && e.code) || "unavailable"); };
    for (const path of ["projekt/nastaveni", "projekt/rodina"]) {
      let first = true;
      this.unsubs.push(this.db.doc(path).onSnapshot((s) => {
        onDoc(path, s.exists ? s.data() : null);
        if (first) { first = false; ready(); }
      }, fail));
    }
    for (const col of ["fotky", "roky"]) {
      let first = true;
      this.unsubs.push(this.db.collection(col).onSnapshot((qs) => {
        for (const ch of qs.docChanges()) onDoc(col + "/" + ch.doc.id, ch.type === "removed" ? null : ch.doc.data());
        if (first) { first = false; ready(); }
      }, fail));
    }
  };
  CloudBackend.prototype.write = function (path, data) { return this.db.doc(path).set(data); };
  CloudBackend.prototype.remove = function (path) { return this.db.doc(path).delete(); };
  CloudBackend.prototype.upload = async function (blob) {
    const r = await this.assets.upload(blob);
    return r.id;
  };
  CloudBackend.prototype.url = async function (ref) { return ASSET_ID.test(ref) ? "/_blob/" + ref : null; };
  CloudBackend.prototype.blob = async function (ref) {
    const u = await this.url(ref);
    if (!u) return null;
    const r = await fetch(u);
    return r.ok ? r.blob() : null;
  };
  CloudBackend.prototype.deleteBlob = async function (ref) {
    if (this.assets && ASSET_ID.test(ref)) { try { await this.assets.delete(ref); } catch (e) { /* cizí nebo už smazaná */ } }
  };
  CloudBackend.prototype.usage = async function () {
    if (!this.assets) return null;
    try { return (await this.assets.list()).usage; } catch (e) { return null; }
  };

  // ---------- IndexedDB ----------
  function idb(dbName) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("docs"); r.result.createObjectStore("blobs"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (db, store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && typeof out === "object" && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

  function LocalBackend(db) {
    this.kind = "local";
    this.idb = db;
    this.canUpload = true;
    this.urls = new Map();
  }
  LocalBackend.open = async function () {
    if (!root.indexedDB) throw new Error("no-idb");
    const db = await idb("rodinny-kalendar");
    await tx(db, "docs", "readwrite", (s) => s.put(Date.now(), "__probe"));
    return new LocalBackend(db);
  };
  LocalBackend.prototype.start = async function (onDoc, onReady, onError) {
    try {
      const keys = await tx(this.idb, "docs", "readonly", (s) => s.getAllKeys());
      const vals = await tx(this.idb, "docs", "readonly", (s) => s.getAll());
      keys.forEach((k, i) => { if (k !== "__probe") onDoc(k, vals[i]); });
      onReady();
    } catch (e) { onError("local"); }
  };
  LocalBackend.prototype.write = function (path, data) { return tx(this.idb, "docs", "readwrite", (s) => s.put(data, path)); };
  LocalBackend.prototype.remove = function (path) { return tx(this.idb, "docs", "readwrite", (s) => s.delete(path)); };
  LocalBackend.prototype.upload = async function (blob) {
    const id = "l" + newId();
    await tx(this.idb, "blobs", "readwrite", (s) => s.put(blob, id));
    return id;
  };
  LocalBackend.prototype.blob = function (ref) { return tx(this.idb, "blobs", "readonly", (s) => s.get(ref)); };
  LocalBackend.prototype.url = async function (ref) {
    if (this.urls.has(ref)) return this.urls.get(ref);
    const b = await this.blob(ref);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    this.urls.set(ref, u);
    return u;
  };
  LocalBackend.prototype.deleteBlob = async function (ref) {
    await tx(this.idb, "blobs", "readwrite", (s) => s.delete(ref));
    if (this.urls.has(ref)) { URL.revokeObjectURL(this.urls.get(ref)); this.urls.delete(ref); }
  };
  LocalBackend.prototype.usage = async function () {
    try {
      const e = await navigator.storage.estimate();
      return { bytes: e.usage, maxBytes: e.quota };
    } catch (x) { return null; }
  };

  // ---------- jen v paměti ----------
  function MemoryBackend() {
    this.kind = "memory";
    this.canUpload = true;
    this.docs = new Map();
    this.blobs = new Map();
  }
  MemoryBackend.prototype.start = function (onDoc, onReady) { onReady(); };
  MemoryBackend.prototype.write = async function (p, d) { this.docs.set(p, d); };
  MemoryBackend.prototype.remove = async function (p) { this.docs.delete(p); };
  MemoryBackend.prototype.upload = async function (blob) { const id = "m" + newId(); this.blobs.set(id, { blob, url: URL.createObjectURL(blob) }); return id; };
  MemoryBackend.prototype.blob = async function (ref) { return (this.blobs.get(ref) || {}).blob || null; };
  MemoryBackend.prototype.url = async function (ref) { return (this.blobs.get(ref) || {}).url || null; };
  MemoryBackend.prototype.deleteBlob = async function (ref) { this.blobs.delete(ref); };
  MemoryBackend.prototype.usage = async function () { return null; };

  // ---------- GitHub (soukromé repo: kalendar.json + složka foto/) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (code, detail) => Object.assign(new Error(detail || code), { code });
  function b64bytes(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const b64utf8 = (str) => b64bytes(new TextEncoder().encode(str));
  const utf8b64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  async function blobB64(blob) { return b64bytes(new Uint8Array(await blob.arrayBuffer())); }
  async function makeThumb(blob) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
  }

  const TOKEN_KEY = "kal.githubToken";
  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function saveToken(t) { try { localStorage.setItem(TOKEN_KEY, t); return true; } catch (e) { return false; } }
  function forgetToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* nic */ } }

  function GitHubBackend(cfg, token, cache) {
    this.kind = "github";
    this.canUpload = true;
    this.cfg = cfg;
    this.token = token;
    this.api = (cfg.api || "https://api.github.com").replace(/\/$/, "");
    this.repo = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
    this.branch = cfg.branch || "main";
    this.file = cfg.file || "kalendar.json";
    this.cache = cache; // IndexedDB s fotkami, ať se nestahují pořád dokola
    this.docs = {};
    this.sha = null;
    this.dirty = new Map();
    this.waiters = [];
    this.flushTimer = null;
    this.flushing = null;
    this.writeQueue = Promise.resolve();
    this.lastWrite = 0;
    this.loading = new Map();
    this.urls = new Map();
    this.onDoc = null;
  }
  GitHubBackend.label = (cfg) => `${cfg.owner}/${cfg.repo}`;

  /** Jeden požadavek na GitHub API; zápisy jdou postupně a s odstupem (GitHub omezuje rychlost). */
  GitHubBackend.prototype.req = function (method, path, opts) {
    opts = opts || {};
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        if (method !== "GET") {
          const wait = this.lastWrite + 900 - Date.now();
          if (wait > 0) await sleep(wait);
          this.lastWrite = Date.now();
        }
        let r;
        try {
          r = await fetch(this.api + path, {
            method, cache: "no-store",
            headers: Object.assign({ Authorization: "Bearer " + this.token, "X-GitHub-Api-Version": "2022-11-28",
              Accept: opts.raw ? "application/vnd.github.raw" : "application/vnd.github+json" },
            opts.body ? { "Content-Type": "application/json" } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
          });
        } catch (e) {
          if (attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
          throw fail("offline", "GitHub neodpovídá");
        }
        if ((r.status === 403 || r.status === 429) && attempt < 6) {
          const text = await r.clone().text();
          if (r.status === 429 || /rate limit/i.test(text)) {
            const ra = +r.headers.get("retry-after") || 0;
            const reset = +r.headers.get("x-ratelimit-reset") || 0;
            const ms = ra ? ra * 1000 : reset ? Math.max(5000, reset * 1000 - Date.now()) : 60000;
            await sleep(Math.min(ms, 15 * 60000));
            continue;
          }
        }
        if (r.status >= 500 && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
        return r;
      }
    };
    if (method === "GET") return run();
    const p = this.writeQueue.then(run, run);
    this.writeQueue = p.catch(() => {});
    return p;
  };

  async function ghError(r) {
    if (r.status === 401) return fail("auth", "Klíč k GitHubu neplatí nebo vypršel.");
    if (r.status === 403 || r.status === 404) return fail("access", "Klíč nemá právo zapisovat do datového repozitáře.");
    let msg = "";
    try { msg = (await r.json()).message || ""; } catch (e) { /* nic */ }
    return fail("http_" + r.status, msg || "GitHub vrátil chybu " + r.status);
  }

  /** Ověří klíč: vrací null, nebo text chyby pro obrazovku nastavení. */
  GitHubBackend.check = async function (cfg, token) {
    const be = new GitHubBackend(cfg, token, null);
    let r;
    try { r = await be.req("GET", be.repo); } catch (e) { return "GitHub teď neodpovídá. Zkontrolujte připojení k internetu."; }
    if (r.status === 401) return "Tenhle klíč GitHub nezná. Zkontrolujte, že je vložený celý.";
    if (r.status === 404 || r.status === 403) return `Klíč nemá přístup k repozitáři ${GitHubBackend.label(cfg)}.`;
    if (!r.ok) return "GitHub vrátil chybu " + r.status + ".";
    return null;
  };

  GitHubBackend.prototype.readFile = async function () {
    const r = await this.req("GET", `${this.repo}/contents/${this.file}?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) {
      const repo = await this.req("GET", this.repo);
      if (!repo.ok) throw await ghError(repo);
      return { sha: null, docs: {} };
    }
    if (!r.ok) throw await ghError(r);
    const j = await r.json();
    let text;
    if (j.content && j.encoding === "base64") text = utf8b64(j.content);
    else {
      const raw = await this.req("GET", `${this.repo}/contents/${this.file}?ref=${encodeURIComponent(this.branch)}`, { raw: true });
      if (!raw.ok) throw await ghError(raw);
      text = await raw.text();
    }
    const data = JSON.parse(text || "{}");
    return { sha: j.sha, docs: (data && data.docs) || {} };
  };

  GitHubBackend.prototype.start = async function (onDoc, onReady, onError) {
    this.onDoc = onDoc;
    try {
      const f = await this.readFile();
      this.sha = f.sha;
      this.docs = f.docs;
      for (const [p, d] of Object.entries(this.docs)) onDoc(p, d);
      onReady();
    } catch (e) { onError(e); return; }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { if (this.dirty.size) { clearTimeout(this.flushTimer); this.flush(); } }
      else if (!this.dirty.size && !this.flushing) this.pull().catch(() => {});
    });
  };

  /** Načte, co mezitím uložil někdo jiný (z jiného počítače), a pošle změny do aplikace. */
  GitHubBackend.prototype.pull = async function () {
    const f = await this.readFile();
    if (f.sha === this.sha) return;
    const before = this.docs;
    this.sha = f.sha;
    this.docs = f.docs;
    if (!this.onDoc) return;
    const paths = new Set([...Object.keys(before), ...Object.keys(f.docs)]);
    for (const p of paths) {
      if (this.dirty.has(p)) continue;
      if (JSON.stringify(before[p]) !== JSON.stringify(f.docs[p])) this.onDoc(p, f.docs[p] || null);
    }
  };

  GitHubBackend.prototype.write = function (path, data) { return this.schedule(path, data); };
  GitHubBackend.prototype.remove = function (path) { return this.schedule(path, null); };
  GitHubBackend.prototype.schedule = function (path, data) {
    this.dirty.set(path, data);
    return new Promise((res, rej) => {
      this.waiters.push({ res, rej });
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 2500); // víc úprav = jeden commit
    });
  };
  GitHubBackend.prototype.flush = async function () {
    while (this.flushing) await this.flushing.catch(() => {});
    if (!this.dirty.size) { this.waiters.splice(0).forEach((w) => w.res()); return; }
    const waiters = this.waiters.splice(0);
    const batch = new Map(this.dirty);
    this.dirty.clear();
    const names = [...batch.keys()].map((p) => p.replace(/^projekt\//, "").replace(/^fotky\/.*/, "fotky"));
    const message = "Kalendář: " + [...new Set(names)].slice(0, 6).join(", ");
    this.flushing = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const docs = Object.assign({}, this.docs);
        for (const [p, d] of batch) { if (d === null) delete docs[p]; else docs[p] = d; }
        const body = { message, branch: this.branch,
          content: b64utf8(JSON.stringify({ format: "rodinny-kalendar", v: 1, saved: new Date().toISOString(), docs }, null, 1)) };
        if (this.sha) body.sha = this.sha;
        const r = await this.req("PUT", `${this.repo}/contents/${this.file}`, { body });
        if (r.ok) { this.sha = (await r.json()).content.sha; this.docs = docs; return; }
        if (r.status === 409 || r.status === 422) { await this.pull(); continue; } // mezitím uložil někdo jiný
        throw await ghError(r);
      }
      throw fail("conflict", "Nepodařilo se sloučit změny s GitHubem.");
    })();
    try {
      await this.flushing;
      waiters.forEach((w) => w.res());
    } catch (e) {
      for (const [p, d] of batch) if (!this.dirty.has(p)) this.dirty.set(p, d);
      waiters.forEach((w) => w.rej(e));
    } finally { this.flushing = null; }
  };

  GitHubBackend.prototype.cacheGet = async function (ref) {
    if (!this.cache) return null;
    try { return (await tx(this.cache, "blobs", "readonly", (s) => s.get(ref))) || null; } catch (e) { return null; }
  };
  GitHubBackend.prototype.cachePut = async function (ref, blob) {
    if (!this.cache) return;
    try { await tx(this.cache, "blobs", "readwrite", (s) => s.put(blob, ref)); } catch (e) { /* mezipaměť je jen pomůcka */ }
  };
  GitHubBackend.prototype.upload = async function (blob, opts) {
    if (opts && opts.thumbOf) { // náhled se na GitHub neukládá, dá se kdykoli vyrobit z fotky
      const ref = "t-" + opts.thumbOf;
      await this.cachePut(ref, blob);
      return ref;
    }
    const ref = "g" + newId();
    const r = await this.req("PUT", `${this.repo}/contents/foto/${ref}.jpg`,
      { body: { message: "Fotka " + ref, branch: this.branch, content: await blobB64(blob) } });
    if (!r.ok) throw await ghError(r);
    await this.cachePut(ref, blob);
    return ref;
  };
  GitHubBackend.prototype.blob = function (ref) {
    if (!/^(t-)?g[a-z0-9]+$/.test(ref || "")) return Promise.resolve(null);
    if (this.loading.has(ref)) return this.loading.get(ref);
    const p = (async () => {
      const hit = await this.cacheGet(ref);
      if (hit) return hit;
      if (ref.startsWith("t-")) {
        const full = await this.blob(ref.slice(2));
        if (!full) return null;
        const t = await makeThumb(full);
        await this.cachePut(ref, t);
        return t;
      }
      const r = await this.req("GET", `${this.repo}/contents/foto/${ref}.jpg?ref=${encodeURIComponent(this.branch)}`, { raw: true });
      if (!r.ok) return null;
      const b = new Blob([await r.arrayBuffer()], { type: "image/jpeg" });
      await this.cachePut(ref, b);
      return b;
    })();
    this.loading.set(ref, p);
    p.finally(() => this.loading.delete(ref));
    return p;
  };
  GitHubBackend.prototype.url = async function (ref) {
    if (this.urls.has(ref)) return this.urls.get(ref);
    const b = await this.blob(ref);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    this.urls.set(ref, u);
    return u;
  };
  GitHubBackend.prototype.deleteBlob = async function (ref) {
    if (this.cache) { try { await tx(this.cache, "blobs", "readwrite", (s) => s.delete(ref)); } catch (e) { /* nic */ } }
    if (!ref || ref.startsWith("t-")) return;
    const path = `${this.repo}/contents/foto/${ref}.jpg`;
    const r = await this.req("GET", path + `?ref=${encodeURIComponent(this.branch)}`);
    if (!r.ok) return;
    const sha = (await r.json()).sha;
    await this.req("DELETE", path, { body: { message: "Smazaná fotka " + ref, sha, branch: this.branch } });
  };
  GitHubBackend.prototype.usage = async function () {
    try {
      const r = await this.req("GET", this.repo);
      const j = await r.json();
      return { bytes: (j.size || 0) * 1024, maxBytes: 1024 * 1024 * 1024 };
    } catch (e) { return null; }
  };

  async function loadConfig() {
    try {
      const r = await fetch("config.json", { cache: "no-store" });
      if (!r.ok) return null;
      const c = await r.json();
      return c && c.github && c.github.owner && c.github.repo ? c : null;
    } catch (e) { return null; }
  }

  /** Vybere úložiště podle toho, co prohlížeč a Claude dovolí. */
  async function connect() {
    let caps = {};
    if (root.claude && typeof root.claude.use === "function") {
      const get = (n) => root.claude.use(n).catch(() => null);
      const [db, assets, downloads] = await Promise.all([get("db"), get("assets"), get("downloads")]);
      caps = { db, assets, downloads };
    }
    if (caps.db) return { backend: new CloudBackend(caps.db, caps.assets), downloads: caps.downloads };
    const cfg = await loadConfig();
    if (cfg) {
      const token = readToken();
      if (!token) return { needsToken: cfg.github };
      let cache = null;
      try { cache = await idb("rodinny-kalendar-github"); } catch (e) { /* bez mezipaměti */ }
      return { backend: new GitHubBackend(cfg.github, token, cache), downloads: null };
    }
    try { return { backend: await LocalBackend.open(), downloads: caps.downloads || null }; }
    catch (e) { return { backend: new MemoryBackend(), downloads: caps.downloads || null }; }
  }

  /** Ukládá s krátkým zpožděním, vždy jen jeden zápis na dokument najednou. */
  function Saver(getBackend, onStatus) {
    const jobs = new Map(); // path -> {data, timer, running, tries}
    let active = 0, failed = null;
    const status = () => onStatus({ pending: jobs.size, active, failed });
    async function run(path) {
      const j = jobs.get(path);
      if (!j || j.running) return;
      j.running = true; j.timer = null;
      const data = j.data;
      active++; status();
      let ok = true;
      try {
        if (data === null) await getBackend().remove(path);
        else await getBackend().write(path, data);
        failed = null;
        j.tries = 0;
      } catch (e) {
        ok = false;
        failed = (e && (e.message || e.code)) || "chyba";
        j.tries = (j.tries || 0) + 1;
      }
      active--;
      j.running = false;
      if (!ok) { // zkusíme znovu, s rostoucím odstupem (max. minuta)
        if (!j.timer) j.timer = setTimeout(() => run(path), Math.min(60000, 3000 * 2 ** (j.tries - 1)));
      } else if (j.data !== data) { if (!j.timer) j.timer = setTimeout(() => run(path), 300); }
      else jobs.delete(path);
      status();
    }
    return {
      queue(path, data, delay) {
        let j = jobs.get(path);
        if (!j) { j = { data, timer: null, running: false }; jobs.set(path, j); }
        j.data = data;
        if (j.timer) clearTimeout(j.timer);
        if (!j.running) j.timer = setTimeout(() => run(path), delay == null ? 700 : delay);
        status();
      },
      pending: (path) => jobs.has(path),
      flush() {
        for (const [p, j] of jobs) { if (j.timer && !j.tries) { clearTimeout(j.timer); run(p); } }
      },
    };
  }

  root.KalStore = { connect, Saver, newId, CloudBackend, LocalBackend, MemoryBackend, GitHubBackend, saveToken, forgetToken, readToken };
})(window);

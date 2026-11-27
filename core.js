/* Rodinný kalendář – výpočet roku: týdny, svátky, Velikonoce, liturgické neděle, narozeniny.
   Čisté funkce bez DOM; v prohlížeči jako window.KalCore, v Node přes module.exports. */
(function (root) {
  "use strict";

  const MONTHS = ["LEDEN", "ÚNOR", "BŘEZEN", "DUBEN", "KVĚTEN", "ČERVEN", "ČERVENEC", "SRPEN", "ZÁŘÍ", "ŘÍJEN", "LISTOPAD", "PROSINEC"];
  const MONTHS_GEN = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
  const DOW = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

  // Datum bez časových pásem: počítáme v UTC.
  const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const add = (date, n) => new Date(date.getTime() + n * 86400000);
  const iso = (date) => date.toISOString().slice(0, 10);
  const md = (date) => iso(date).slice(5);
  const dow = (date) => (date.getUTCDay() + 6) % 7; // 0 = pondělí
  const sundayOnOrAfter = (date) => add(date, (7 - ((date.getUTCDay()) % 7)) % 7);
  const sundayAfter = (date) => sundayOnOrAfter(add(date, 1));
  const weeksBetween = (a, b) => Math.round((b - a) / (7 * 86400000));

  function easter(y) {
    // Anonymní gregoriánský algoritmus (Meeus/Jones/Butcher)
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return D(y, month, day);
  }

  function isoWeek(date) {
    const thu = add(date, 3 - dow(date));
    const jan4 = D(thu.getUTCFullYear(), 1, 4);
    return 1 + Math.round((thu - add(jan4, -dow(jan4))) / (7 * 86400000));
  }

  /** Státní svátky (červené číslo dne). Vrací {"YYYY-MM-DD": název}. */
  function stateHolidays(y) {
    const E = easter(y);
    const h = {};
    [["01-01", "Nový rok"], ["05-01", "Svátek práce"], ["05-08", "Den vítězství"], ["07-05", "Cyril a Metoděj"],
     ["07-06", "Mistr Jan Hus"], ["09-28", "Den české státnosti"], ["10-28", "Vznik ČSR"],
     ["11-17", "Den boje za svobodu a demokracii"], ["12-24", "Štědrý den"], ["12-25", "1. svátek vánoční"],
     ["12-26", "2. svátek vánoční"]].forEach(([d, n]) => (h[`${y}-${d}`] = n));
    h[iso(add(E, -2))] = "Velký pátek";
    h[iso(add(E, 1))] = "Velikonoční pondělí";
    return h;
  }

  /** Liturgické texty do pravého sloupce. Vrací {"YYYY-MM-DD": text}. */
  function liturgy(y) {
    const out = {};
    const put = (date, text) => { if (date.getUTCFullYear() === y) out[iso(date)] = text; };
    const E = easter(y);
    const ash = add(E, -46);

    // Vánoční doba na začátku roku
    for (let d = 2; d <= 5; d++) if (dow(D(y, 1, d)) === 6) put(D(y, 1, d), "2. neděle po Narození Páně");
    put(D(y, 1, 6), "Zjevení Páně");
    const baptism = sundayAfter(D(y, 1, 6));
    put(baptism, "Křtu Páně");

    // Mezidobí před postem
    let n = 2;
    for (let s = add(baptism, 7); s < ash; s = add(s, 7)) put(s, `${n++}. neděle v mezidobí`);

    // Postní a velikonoční doba
    put(ash, "Popeleční středa");
    for (let i = 1; i <= 5; i++) put(add(E, -49 + 7 * i), `${i}. neděle postní`);
    put(add(E, -7), "Květná neděle");
    put(add(E, -3), "Zelený čtvrtek");
    put(add(E, -2), "Velký pátek");
    put(add(E, -1), "Bílá sobota");
    put(E, "Zmrtvýchvstání Páně");
    put(add(E, 1), "Pondělí velikonoční");
    for (let i = 2; i <= 7; i++) put(add(E, 7 * (i - 1)), `${i}. neděle velikonoční`);
    put(add(E, 39), "Nanebevstoupení Páně");
    put(add(E, 49), "Seslání Ducha svatého");
    put(add(E, 56), "Nejsvětější Trojice");
    put(add(E, 60), "Těla a krve Páně");

    // Advent, Kristus Král a mezidobí po Letnicích (číslováno pozpátku od 34. neděle)
    const christmas = D(y, 12, 25);
    const adv4 = add(christmas, -(dow(christmas) === 6 ? 7 : dow(christmas) + 1));
    const adv1 = add(adv4, -21);
    for (let i = 0; i < 4; i++) put(add(adv1, 7 * i), `${i + 1}. neděle adventní`);
    const king = add(adv1, -7);
    put(king, "Ježíše Krista Krále");
    for (let s = add(E, 63); s < king; s = add(s, 7)) put(s, `${34 - weeksBetween(s, king)}. neděle v mezidobí`);

    // Vánoce
    put(christmas, "Narození Páně");
    let family = null;
    for (let d = 26; d <= 31; d++) if (dow(D(y, 12, d)) === 6) family = D(y, 12, d);
    put(family || D(y, 12, 30), "Svaté rodiny");
    return out;
  }

  /** Česky: 1 rok, 2–4 roky, 5+ let */
  function yearsWord(n) {
    if (n === 1) return "rok";
    if (n >= 2 && n <= 4) return "roky";
    return "let";
  }

  /** Narozeniny osob v daném roce. person: {id, name, born: "YYYY-MM-DD" | "--MM-DD"} */
  function birthdays(y, people) {
    const out = {};
    for (const p of people || []) {
      if (!p || !p.born || p.hidden) continue;
      const m = /^(\d{4}|--)-?(\d{2})-(\d{2})$/.exec(p.born.trim());
      if (!m) continue;
      let mm = +m[2], dd = +m[3];
      if (mm === 2 && dd === 29 && !isLeap(y)) dd = 28;
      const key = iso(D(y, mm, dd));
      const by = m[1] === "--" ? null : +m[1];
      const age = by ? y - by : null;
      let text = p.name;
      if (age && age > 0) text += ` ${age} ${yearsWord(age)}`;
      (out[key] = out[key] || []).push({ text, personId: p.id, age });
    }
    return out;
  }

  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  /** Vlastní události: {id, date: "MM-DD" (každý rok) | "YYYY-MM-DD" (jednou), text, red} */
  function customEvents(y, events) {
    const out = {};
    for (const e of events || []) {
      if (!e || !e.date || !e.text) continue;
      let key = null;
      if (/^\d{2}-\d{2}$/.test(e.date)) key = `${y}-${e.date}`;
      else if (e.date.startsWith(`${y}-`)) key = e.date;
      if (key) (out[key] = out[key] || []).push(e);
    }
    return out;
  }

  /**
   * Sestaví celý rok po týdnech.
   * project: {year, people, events, dayEdits: {"MM-DD": {saint, name}}, hideLiturgy}
   * kal: {"MM-DD": {saint, name}}
   */
  function buildYear(project, kal) {
    const y = project.year;
    const hol = stateHolidays(y);
    const lit = project.hideLiturgy ? {} : liturgy(y);
    const bd = birthdays(y, project.people);
    const ce = customEvents(y, project.events);
    const edits = project.dayEdits || {};
    const first = add(D(y, 1, 1), -dow(D(y, 1, 1)));
    const last = D(y, 12, 31);
    const weeks = [];
    for (let mon = first; mon <= last; mon = add(mon, 7)) {
      const days = [];
      const months = new Set();
      for (let i = 0; i < 7; i++) {
        const date = add(mon, i);
        if (date.getUTCFullYear() !== y) { days.push(null); continue; }
        const key = iso(date), k = md(date);
        months.add(date.getUTCMonth());
        const base = Object.assign({ saint: "", name: "" }, kal[k] || {}, edits[k] || {});
        const events = [];
        for (const b of bd[key] || []) events.push({ kind: "birthday", text: b.text, personId: b.personId });
        if (lit[key]) events.push({ kind: "liturgy", text: lit[key] });
        for (const c of ce[key] || []) events.push({ kind: "custom", text: c.text, red: !!c.red, id: c.id });
        days.push({
          date: key, md: k, day: date.getUTCDate(), month: date.getUTCMonth(), dow: i, dowLabel: DOW[i],
          red: i === 6 || !!hol[key], holiday: hol[key] || null,
          saint: base.saint, name: base.name, events,
        });
      }
      const ms = [...months].sort((a, b) => a - b);
      weeks.push({
        index: weeks.length, monday: iso(mon), isoWeek: isoWeek(mon),
        monthLabel: ms.map((m) => MONTHS[m]).join(", "), months: ms, days,
        celebrants: days.flatMap((d) => (d ? d.events.filter((e) => e.kind === "birthday").map((e) => e.personId) : [])),
      });
    }
    return { year: y, weeks, easter: iso(easter(y)) };
  }

  const api = { MONTHS, MONTHS_GEN, DOW, easter, isoWeek, stateHolidays, liturgy, birthdays, customEvents, buildYear, yearsWord, iso };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KalCore = api;
})(typeof window !== "undefined" ? window : globalThis);

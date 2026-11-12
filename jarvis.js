"use strict";
// Atlas: de automatische piloot. Draait op de server, ook als niemand de app open heeft.
// Doet zelf wat in Beheer → Atlas aan staat, en legt de rest als vraag (met één klik) aan kantoor voor.

const DEFAULTS = { aan: false, proef: true, orders: true, waakhond: true, kansen: true, assign: true, invoice: true, reminders: true, updateUren: 2, van: 7, tot: 19, weekend: false, herinneringNa: 3, herinneringOm: 14, maxHerinneringen: 3 };
const LIVE = ["Gepland", "Naar laadplaats", "Laden", "Naar losplaats", "Lossen"];
const ACTIVE = LIVE.slice(1);

module.exports = function createJarvis(x) {
  const { phoneAlert = () => {}, officeOnline = () => false, store, push, mail, ai, here, db, emit, emitOffice, notifyOrderChange, createConcept, saveFile, readFile, absOn, todayLocal, fdate, fdt, eurS, ogm, lineText, calcTotals, bedrijf, uid, pdf, ubl, TZ } = x;
  const cfg = () => ({ ...DEFAULTS, ...(store.get("config", "jarvis") || {}) });
  const z = n => String(n).padStart(2, "0");
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); };
  const dateOf = s => String(s || "").slice(0, 10);
  const nowParts = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map(a => [a.type, a.value])); return { h: +p.hour % 24, m: +p.minute, wd: p.weekday }; };
  const workTime = () => { const c = cfg(), n = nowParts(); if (!c.weekend && (n.wd === "Sat" || n.wd === "Sun")) return false; return n.h >= c.van && n.h < c.tot; };
  const driverName = id => (store.get("drivers", id) || {}).naam || "?";
  const hasLogin = did => !!db.prepare("SELECT 1 FROM users WHERE role='driver' AND active=1 AND driverId=?").get(did);

  // ---------- wat Atlas nu doet (voor het muisje in de app) ----------
  function act(text, target = {}, quiet = false) { try { emitOffice({ type: "jact", text, target, quiet, at: new Date().toISOString() }); } catch {} }
  // ---------- logboek ----------
  function log(soort, tekst, extra = {}) {
    const id = uid(), item = { at: new Date().toISOString(), soort, tekst, ...extra };
    store.put("jarvis", id, item); emitOffice({ type: "jarvis", item: { ...item, id } });
    if (soort !== "update") act(tekst, extra.open ? { view: "jarvis", id } : extra.ref ? { col: extra.ref.col, id: extra.ref.id } : { view: "jarvis" });
    return id;
  }
  const hasOpen = key => store.all("jarvis").some(j => j.open && !j.klaar && j.key === key);
  // Niet opnieuw vragen wat al open staat, of wat jij net zelf op "Klaar" zette.
  function ask(key, tekst, actie, opt = {}) {
    const rust = /^(verval|lucy|mail|wijz)-/.test(key) ? 3650 * 864e5 : 24 * 3600e3;
    if (store.all("jarvis").some(j => j.key === key && j.open && (!j.klaar || (j.note !== "opgelost" && Date.now() - new Date(j.klaar).getTime() < rust)))) return;
    log("vraag", tekst, { open: true, key, actie: actie || null, ...opt });
    try { phoneAlert(key, tekst); } catch {}
  }
  function closeKey(key, note) { for (const j of store.all("jarvis").filter(j => j.open && !j.klaar && j.key === key)) { const d = store.patch("jarvis", j.id, { klaar: new Date().toISOString(), door: "Atlas", note: note || "opgelost" }); emitOffice({ type: "jarvis", item: d }); } }
  function prune() { const all = store.all("jarvis").sort((a, b) => b.at.localeCompare(a.at)); for (const j of all.slice(600)) if (!j.open || j.klaar) store.del("jarvis", j.id); }

  // ---------- chauffeur kiezen (rekening houdend met uren en rijtijd) ----------
  const span = o => { const f = dateOf(o.laaddatum) || todayLocal(), t = dateOf(o.losdatum) || f; return [f, t < f ? f : t]; };
  function absentIn(did, [f, t]) { for (let d = f; d <= t; d = addDays(d, 1)) { const a = absOn(did, d); if (a) return a; } return null; }
  // lokale Belgische tijd "YYYY-MM-DDTHH:MM" → tijdstip
  function localMs(str, defTime) {
    let s = String(str || ""); if (!s) return null; if (s.length <= 10) s += "T" + defTime;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s); if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const off = d => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(d)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - d; };
    return guess - off(guess);
  }
  async function placeOf(q) { if (!q || !here.configured()) return null; try { return await here.geocode(q); } catch { return null; } }
  const km = (a, b) => { const R = 6371, t = Math.PI / 180, dl = (b.lat - a.lat) * t, dn = (b.lng - a.lng) * t, s = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
  const roadH = k => k * 1.25 / 65; // hemelsbreed → weg, gemiddeld 65 km/u voor een vrachtwagen
  const laadQ = o => (o.laadadres || o.laadplaats || "").replace(/\n/g, ", "), losQ = o => (o.losadres || o.losplaats || "").replace(/\n/g, ", ");
  let winCache = new Map();
  async function win(o) {
    const key = o.id + "|" + o.laaddatum + "|" + o.losdatum; if (winCache.has(key)) return winCache.get(key);
    const a = localMs(o.laaddatum, "08:00") ?? localMs(todayLocal(), "08:00");
    let b = o.losdatum ? localMs(o.losdatum, "17:00") : null;
    const L = await placeOf(laadQ(o)), U = await placeOf(losQ(o));
    if (!b || b <= a) b = a + ((L && U ? roadH(km(L, U)) : 6) + 2) * 3600e3; // laden + rijden + lossen
    const w = { a, b, L, U }; winCache.set(key, w); return w;
  }
  // Is de chauffeur vrij voor deze rit? Geeft null of de reden waarom niet.
  async function conflict(did, o) {
    const w = await win(o), others = store.all("orders").filter(x => x.id !== o.id && x.chauffeurId === did && LIVE.includes(x.status));
    let prev = null, next = null;
    for (const x of others) {
      const wx = await win(x);
      if (wx.a < w.b + 1800e3 && w.a < wx.b + 1800e3) return `heeft al rit ${x.ref} op dat moment`;
      if (wx.b <= w.a && (!prev || wx.b > prev.w.b)) prev = { x, w: wx };
      if (wx.a >= w.b && (!next || wx.a < next.w.a)) next = { x, w: wx };
    }
    if (prev && prev.w.U && w.L && prev.w.b + roadH(km(prev.w.U, w.L)) * 3600e3 > w.a) return `raakt na rit ${prev.x.ref} niet op tijd in ${o.laadplaats}`;
    if (next && w.U && next.w.L && w.b + roadH(km(w.U, next.w.L)) * 3600e3 > next.w.a) return `haalt daarna rit ${next.x.ref} niet meer`;
    return null;
  }
  async function vehicleFree(vid, o) {
    const w = await win(o);
    for (const x of store.all("orders").filter(x => x.id !== o.id && x.voertuigId === vid && LIVE.includes(x.status))) { const wx = await win(x); if (wx.a < w.b + 1800e3 && w.a < wx.b + 1800e3) return false; }
    return true;
  }
  async function pickDriver(o, exclude = []) {
    const s = span(o), all = store.all("orders"), w = await win(o);
    const cands = [];
    for (const d of store.all("drivers")) { if (exclude.includes(d.id) || d.actief === false || !hasLogin(d.id) || absentIn(d.id, s)) continue; if (!(await conflict(d.id, o))) cands.push(d); }
    if (!cands.length) return null;
    const scored = [];
    for (const d of cands) {
      let where = null, why = "";
      const prev = all.filter(x => x.chauffeurId === d.id && x.id !== o.id && x.status !== "Geannuleerd" && (localMs(x.losdatum || x.laaddatum, "17:00") || 0) <= w.a).sort((a, b) => String(b.losdatum || b.laaddatum).localeCompare(String(a.losdatum || a.laaddatum)))[0];
      const p = db.prepare("SELECT lat,lng,at FROM positions WHERE driverId=?").get(d.id);
      const prevW = prev ? await win(prev) : null;
      if (p && Date.now() - p.at < 2 * 3600e3 && w.a - Date.now() < 12 * 3600e3 && (!prevW || prevW.b < Date.now())) { where = p; why = "staat nu het dichtst"; }
      else if (prevW && prevW.U) { where = prevW.U; why = (km(prevW.U, w.L || prevW.U) < 60 ? "lost vlak ervoor in " : "laatst gelost in ") + prev.losplaats; }
      const dist = w.L && where ? km(w.L, where) : null;
      const load = all.filter(x => x.chauffeurId === d.id && x.status !== "Geannuleerd" && dateOf(x.laaddatum) >= addDays(s[0], -7) && dateOf(x.laaddatum) <= s[0]).length;
      scored.push({ d, dist, load, why: dist != null ? `${why} (${Math.round(dist)} km van de laadplaats)` : load ? `minst ritten deze week (${load})` : "is vrij" });
    }
    scored.sort((a, b) => (a.dist ?? 1e6) - (b.dist ?? 1e6) || a.load - b.load);
    const best = scored[0];
    const vehicles = store.all("vehicles").filter(v => v.type !== "Oplegger");
    const last = all.filter(x => x.chauffeurId === best.d.id && x.voertuigId).sort((a, b) => String(b.laaddatum).localeCompare(String(a.laaddatum)))[0];
    let vid = "";
    for (const v of [...new Set([o.voertuigId, best.d.voertuigId, last && last.voertuigId, ...vehicles.map(v => v.id)].filter(Boolean))]) if (store.get("vehicles", v) && await vehicleFree(v, o)) { vid = v; break; }
    return { driverId: best.d.id, vehicleId: vid || o.voertuigId || "", why: best.why, dist: best.dist };
  }
  function assign(o, pick, reden) {
    const prev = store.get("orders", o.id);
    const upd = store.patch("orders", o.id, { chauffeurId: pick.driverId, voertuigId: pick.vehicleId || prev.voertuigId || "", gezien: prev.chauffeurId === pick.driverId ? prev.gezien : null, jarvis: { toegewezen: new Date().toISOString(), reden } });
    emit("orders", o.id, upd, prev); notifyOrderChange(upd, prev);
    return upd;
  }

  // ---------- 1. PDF-orders uit de mail ----------
  const q = () => store.setting("jarvisMailQ") || [];
  function onNewMail(items) {
    if (!cfg().aan) return;
    const add = items.filter(m => !/notify\.railway|no-?reply@accounts\.google|mailer-daemon/i.test(m.from || "")).map(m => ({ uid: m.uid, from: m.from, fromName: m.fromName || "", subject: m.subject || "", date: m.date || new Date().toISOString(), hasAtt: !!m.hasAtt }));
    if (add.length) { store.setting("jarvisMailQ", [...q(), ...add].slice(-100)); setTimeout(() => tick("mail"), 2000); }
  }
  function findKlant(r, senderEmail) {
    const C = store.all("customers"), em = String(r.klantEmail || senderEmail || "").toLowerCase(), dom = em.split("@")[1] || "", nm = String(r.klantNaam || "").toLowerCase();
    return C.find(c => [c.email, c.emailFactuur].some(x => x && x.toLowerCase() === em))
      || (dom && !/gmail|hotmail|outlook|yahoo|icloud|live\./.test(dom) ? C.find(c => [c.email, c.emailFactuur].some(x => x && x.toLowerCase().endsWith("@" + dom))) : null)
      || (nm.length > 2 ? C.find(c => c.naam && (c.naam.toLowerCase().includes(nm.slice(0, 12)) || nm.includes(c.naam.toLowerCase().slice(0, 12)))) : null);
  }
  function nextRef() { const d = new Date(), p = "R-" + String(d.getFullYear()).slice(2) + z(d.getMonth() + 1) + "-"; const n = store.all("orders").filter(o => (o.ref || "").startsWith(p)).map(o => +o.ref.slice(p.length) || 0); return p + String((n.length ? Math.max(...n) : 0) + 1).padStart(3, "0"); }
  function findOrderFor(t, m) {
    const O = store.all("orders").filter(o => o.status !== "Geannuleerd");
    if (t.ref) { const r = t.ref.trim().toLowerCase(); const o = O.find(o => [o.ref, o.referentieKlant].some(x => x && String(x).toLowerCase() === r)) || O.find(o => [o.ref, o.referentieKlant].some(x => x && r.includes(String(x).toLowerCase()))); if (o) return o; }
    const txt = ((m.subject || "") + " " + (m.text || "")).toLowerCase();
    const hit = O.filter(o => [o.ref, o.referentieKlant].some(x => x && String(x).length > 3 && txt.includes(String(x).toLowerCase())));
    if (hit.length === 1) return hit[0];
    const k = findKlant({}, m.from); const open = k ? O.filter(o => o.klantId === k.id && LIVE.includes(o.status)) : [];
    return open.length === 1 ? open[0] : null;
  }
  function makeOrder(r, k0, { m, item, f, fileName, who, via }) {
    let k = k0;
    if (!k && r.klantNaam) { const kid = uid(); k = store.put("customers", kid, { naam: r.klantNaam, email: r.klantEmail || m.from || "", btw: r.klantBtw || "", adres: r.klantAdres || "", termijn: 30, jarvis: true }); emit("customers", kid, k, null); log("klant", `Nieuwe klant aangemaakt: ${k.naam}.`, { ref: { col: "customers", id: kid } }); }
    const id = uid();
    const o = store.put("orders", id, { ref: nextRef(), status: "Gepland", klantId: k ? k.id : "", laadplaats: r.laadplaats || "", laadadres: r.laadadres || "", laaddatum: String(r.laaddatum || "").slice(0, 16), losplaats: r.losplaats || "", losadres: r.losadres || "", losdatum: String(r.losdatum || "").slice(0, 16),
      goederen: r.goederen || "", colli: r.colli ?? "", gewicht: r.gewicht ?? "", adr: r.adr ? "ja" : "", prijs: r.prijs ?? "", wachtTarief: r.wachtTarief ?? "", vrijeUren: r.vrijeUren ?? "", referentieKlant: r.referentieKlant || "", notities: r.notities || "",
      ...(f ? { opdrachtPdf: { id: f.id, name: fileName } } : {}), bron: m.subject || fileName || "mail", from: m.from, aangemaakt: new Date().toISOString(), jarvis: { uitMail: true, mail: "inbox-" + item.uid } });
    emit("orders", id, o, null);
    const ml = store.put("maillog", uid(), { threadId: "inbox-" + item.uid, orderId: id, subject: m.subject || "", to: "", date: new Date().toISOString(), kind: "in", from: m.from }); emit("maillog", ml.id, ml, null);
    log("rit", `${via === "de PDF" ? "Order-PDF" : via === "de mail" ? "Mail" : "Prijsvraag"} van ${who} omgezet naar rit ${o.ref}: ${o.laadplaats} → ${o.losplaats}, laden ${fdt(o.laaddatum)}${o.prijs !== "" && o.prijs != null ? ", " + eurS(o.prijs) : ""}.`, { ref: { col: "orders", id } });
    return o;
  }
  const mailAct = uidN => ({ type: "mail", key: "inbox-" + uidN, label: "Mail openen" });
  async function processMail(item) {
    const seen = store.setting("jarvisSeen") || [];
    if (seen.includes(item.uid)) return;
    store.setting("jarvisSeen", [...seen, item.uid].slice(-1000));
    act(`Ik open een nieuwe mail van ${item.fromName || item.from}…`, { view: "mail", key: "inbox-" + item.uid });
    const c = cfg(), m = await mail.getMessage("inbox", item.uid), who = m.fromName || m.from;
    act(`Ik lees de mail van ${who}: "${m.subject || "(geen onderwerp)"}"`, { view: "mail", key: "inbox-" + item.uid });
    // 1. sorteren: wat is het en is het dringend?
    const t = await ai.triageMail({ from: m.from, fromName: m.fromName, subject: m.subject, text: m.text, attachments: m.attachments.map(a => a.name), company: bedrijf().naam || "Ghotra Transport", today: todayLocal(), klanten: store.all("customers").map(k => k.naam) });
    const info = store.put("mailinfo", "inbox-" + item.uid, { uid: item.uid, box: "inbox", from: m.from, fromName: m.fromName || "", subject: m.subject || "", date: m.date || item.date, hasAtt: m.attachments.length > 0, ...t, at: new Date().toISOString() });
    emitOffice({ type: "mailinfo", item: { ...info, id: "inbox-" + item.uid } });
    act(`Gesorteerd: ${({ ritorder: "ritorder", ritwijziging: "ritwijziging", prijsvraag: "prijsvraag", vraag: "vraag", factuur: "factuur", administratie: "administratie", reclame: "reclame" })[t.soort] || "overig"}${t.dringend ? " · DRINGEND" : ""}${t.soort === "ritorder" ? ". Ik maak de rit aan…" : t.soort === "prijsvraag" ? ". Ik zoek vorige prijzen en de afstand op…" : t.soort === "reclame" ? ". Laat ik liggen." : ""}`, { view: "mail", key: "inbox-" + item.uid });
    if (t.soort === "ritwijziging") {
      const o = findOrderFor(t, m);
      const wat = o ? `rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}${o.chauffeurId ? ", " + driverName(o.chauffeurId) : ""})` : "een rit" + (t.ref ? " (" + t.ref + ")" : "");
      const tekst = `${t.dringend ? "🔴 " : ""}${who} ${t.annulering ? "annuleert" : "wijzigt"} ${wat}: ${String(t.samenvatting || m.subject || "").replace(/\.?\s*$/, ".")}`;
      if (o && t.annulering && LIVE.includes(o.status)) ask("mail-" + item.uid, tekst, { type: "cancel", id: o.id, key: "inbox-" + item.uid, label: "Annuleer rit " + o.ref });
      else ask("mail-" + item.uid, tekst + (o ? " Pas de rit aan in de app." : ""), o ? { type: "order", id: o.id, key: "inbox-" + item.uid } : mailAct(item.uid));
    } else if (t.dringend) ask("mail-" + item.uid, `🔴 Dringende mail van ${who}: ${t.samenvatting || m.subject}${t.reden ? " (" + t.reden + ")" : ""}`, mailAct(item.uid));
    if (t.soort === "prijsvraag") return prijsvraag(m, item, who);
    if (t.soort !== "ritorder" || !c.orders) return;
    // 2. ritorder → rit(ten) maken, uit de PDF of anders uit de mailtekst
    const pdfs = m.attachments.filter(a => /pdf/i.test(a.type) || /\.pdf$/i.test(a.name)).slice(0, 3);
    const sources = pdfs.length ? pdfs : [null];
    let made = 0;
    for (const a of sources) {
      let att = null, f = null;
      if (a) { att = await mail.getAttachment("inbox", item.uid, a.idx); f = saveFile(att.bytes, att.name, "application/pdf", "jarvis"); }
      const label = a ? `de order "${a.name}"` : "de mailtekst";
      let r;
      try { r = await ai.orderFromFile({ buf: att ? att.bytes : null, type: "application/pdf", name: a ? att.name : "mailtekst", company: bedrijf().naam || "Ghotra Transport", today: todayLocal(), sender: (m.fromName || "") + " <" + m.from + ">", subject: m.subject, body: m.text }); }
      catch (e) { ask("mail-" + item.uid + "-" + (a ? a.idx : 0), `Ik kon ${label} van ${who} niet lezen (${e.message}). Kijk de mail even na.`, mailAct(item.uid)); continue; }
      if (r.isOpdracht === false) continue;
      const k0 = findKlant(r, m.from);
      if (r.referentieKlant && store.all("orders").some(o => o.referentieKlant === r.referentieKlant && (!k0 || o.klantId === k0.id))) { log("rit", `Order ${r.referentieKlant} van ${who} bestond al; ik heb geen dubbele rit gemaakt.`); continue; }
      const missing = [["laadplaats", "laadplaats"], ["laaddatum", "laaddatum"], ["losplaats", "losplaats"]].filter(([k]) => !r[k]).map(x => x[1]);
      if (missing.length) { ask("mail-" + item.uid + "-" + (a ? a.idx : 0), `In ${label} van ${who} ontbreekt: ${missing.join(", ")}. Open de mail en maak de rit zelf aan.`, mailAct(item.uid)); continue; }
      const o = makeOrder(r, k0, { m, item, f, fileName: att && att.name, who, via: a ? "de PDF" : "de mail" }), id = o.id; made++;
      if (o.prijs === "" || o.prijs == null) ask("prijs-" + id, `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}) heeft geen prijs in de order. Vul de prijs in, anders kan ik niet factureren.`, { type: "order", id });
    }
    if (made) { const p = store.get("mailinfo", "inbox-" + item.uid); const d = store.patch("mailinfo", "inbox-" + item.uid, { ritten: made }); emitOffice({ type: "mailinfo", item: d }); }
  }

  // ---------- prijsvraag: klant vraagt onze prijs of stelt een prijs voor → jij beslist ----------
  const city = s => String(s || "").split(",")[0].trim().toLowerCase();
  async function prijsvraag(m, item, who) {
    const pdfA = m.attachments.find(a => /pdf/i.test(a.type) || /\.pdf$/i.test(a.name));
    let att = null, f = null, r = {};
    if (pdfA) { att = await mail.getAttachment("inbox", item.uid, pdfA.idx); f = saveFile(att.bytes, att.name, "application/pdf", "jarvis"); }
    try { r = await ai.orderFromFile({ buf: att ? att.bytes : null, type: "application/pdf", name: att ? att.name : "mailtekst", company: bedrijf().naam || "Ghotra Transport", today: todayLocal(), sender: (m.fromName || "") + " <" + m.from + ">", subject: m.subject, body: m.text }); } catch { r = {}; }
    const bod = +r.prijs > 0 ? +r.prijs : null;
    // doorgestuurd vanuit je eigen mailbox? dan is de klant wie in de mail/PDF staat
    const own = String(m.from || "").toLowerCase() === String(mail.config().user || "").toLowerCase();
    if (own) { who = r.klantNaam || who; }
    const replyTo = own ? (r.klantEmail || "") : m.from;
    // wat reden we vroeger op deze route?
    const same = store.all("orders").filter(o => +o.prijs > 0 && o.status !== "Geannuleerd" && city(o.laadplaats) && city(o.laadplaats) === city(r.laadplaats) && city(o.losplaats) === city(r.losplaats)).sort((a, b) => String(b.laaddatum).localeCompare(String(a.laaddatum)));
    let kmTxt = "", kmVal = null;
    const L = await placeOf(r.laadadres || r.laadplaats), U = await placeOf(r.losadres || r.losplaats);
    if (L && U) { kmVal = Math.round(km(L, U) * 1.25); kmTxt = `± ${kmVal} km`; }
    const hist = same.length ? `Vorige keer: ${same.slice(0, 3).map(o => eurS(o.prijs) + " (" + o.ref + ")").join(", ")}.` : "Nog nooit gereden op deze route.";
    const perKm = bod && kmVal ? ` = ${(bod / kmVal).toFixed(2).replace(".", ",")} €/km` : "";
    const rit = r.laadplaats && r.losplaats ? `${r.laadplaats} → ${r.losplaats}${r.laaddatum ? " op " + fdt(r.laaddatum) : ""}${r.goederen ? " (" + r.goederen + (r.gewicht ? ", " + r.gewicht + " kg" : "") + ")" : ""}` : "een transport (details in de mail)";
    const tekst = `💶 ${who} ${bod ? `biedt ${eurS(bod)} voor` : "vraagt een prijs voor"} ${rit}. ${kmTxt ? kmTxt + perKm + ". " : ""}${hist} ${bod ? "Ga je akkoord?" : "Welke prijs wil je voorstellen?"}`;
    ask("offer-" + item.uid, tekst, { type: "offer", key: "inbox-" + item.uid, bod, km: kmVal, vorige: same.slice(0, 3).map(o => +o.prijs), order: { ...r, prijs: bod }, fileId: f ? f.id : "", fileName: att ? att.name : "", to: replyTo, fromName: own ? (r.klantNaam || "") : (m.fromName || ""), subject: m.subject || "", messageId: m.messageId || "", references: m.references || "", rit });
  }
  // jouw beslissing uitvoeren: mail sturen (na jouw klik) en bij akkoord de rit aanmaken
  async function offer(id, b, user) {
    const j = store.get("jarvis", id); if (!j || !j.actie || j.actie.type !== "offer") throw Object.assign(new Error("Niet gevonden"), { status: 404 });
    if (j.klaar) throw Object.assign(new Error("Deze prijsvraag is al afgehandeld"), { status: 409 });
    const a = j.actie, besluit = b.besluit, bedrag = +b.bedrag || null, who = user.name || user.email;
    if (!["akkoord", "voorstel", "weigeren"].includes(besluit)) throw Object.assign(new Error("Kies akkoord, voorstel of weigeren"), { status: 400 });
    if (besluit !== "weigeren" && !(bedrag > 0)) throw Object.assign(new Error("Vul een bedrag in"), { status: 400 });
    const to = String(b.to || a.to || "").split(/[,;\s]+/).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)); if (!to.length) throw Object.assign(new Error("Geen geldig mailadres"), { status: 400 });
    await mail.send({ to, cc: [], subject: b.subject || ("Re: " + a.subject), text: String(b.body || ""), attachments: [], inReplyTo: a.messageId || "", references: ((a.references || "") + " " + (a.messageId || "")).trim() });
    let extra = "";
    if (besluit === "akkoord") {
      const r = a.order || {};
      if (r.laadplaats && r.losplaats) {
        const f = a.fileId ? { id: a.fileId } : null, uidN = +String(a.key || "").split("-").pop() || 0;
        const o = makeOrder({ ...r, prijs: bedrag }, findKlant(r, a.to), { m: { from: a.to, subject: a.subject }, item: { uid: uidN }, f, fileName: a.fileName, who: a.fromName || a.to, via: "jouw akkoord op de prijsvraag" });
        extra = ` Rit ${o.ref} is aangemaakt en wordt ingepland.`; a._orderId = o.id;
        setTimeout(() => tick("offer"), 1500);
      } else extra = " Maak de rit aan zodra de klant de gegevens stuurt.";
    }
    const d = store.patch("jarvis", id, { klaar: new Date().toISOString(), door: who, besluit, bedrag }); emitOffice({ type: "jarvis", item: d });
    if (a.key && store.get("mailinfo", a.key)) { const mi = store.patch("mailinfo", a.key, { dringend: false, afgehandeld: new Date().toISOString(), door: who }); emitOffice({ type: "mailinfo", item: mi }); }
    const prijsRef = a._orderId ? { ref: { col: "orders", id: a._orderId } } : { actie: { key: a.key } };
    log("prijs", besluit === "akkoord" ? `Akkoord ${eurS(bedrag)} gemaild naar ${a.fromName || a.to} voor ${a.rit} (door ${who}).${extra}` : besluit === "voorstel" ? `Prijsvoorstel ${eurS(bedrag)} gemaild naar ${a.fromName || a.to} voor ${a.rit} (door ${who}).` : `${a.fromName || a.to} gemaild dat we ${a.rit} niet kunnen doen (door ${who}).`, prijsRef);
    return d;
  }

  // ---------- 2 + 3. toewijzen en ziekte opvangen ----------
  async function planning() {
    const c = cfg(), auto = c.assign && !c.proef, today = todayLocal(), horizon = addDays(today, 3);
    for (const o of store.all("orders").filter(o => o.status === "Gepland")) {
      const f = dateOf(o.laaddatum); if (!f || f < today) continue;
      // ziek of afwezig → overdragen
      if (o.chauffeurId) {
        const a = absentIn(o.chauffeurId, span(o)); if (!a) continue;
        const was = driverName(o.chauffeurId);
        if (!hasOpen("ziek-" + o.id)) act(`${was} is ${a.type.toLowerCase()}. Ik zoek iemand anders voor ${o.ref}…`, { col: "orders", id: o.id });
        const pick = await pickDriver(o, [o.chauffeurId]);
        if (pick && auto) { try { phoneAlert("ziek-" + o.id, `${was} is ${a.type.toLowerCase()}. Rit ${o.ref} heb ik aan ${driverName(pick.driverId)} gegeven.`); } catch {} assign(o, pick, `${was} is ${a.type.toLowerCase()}`); log("ziek", `${was} is ${a.type.toLowerCase()}: rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) gaat nu naar ${driverName(pick.driverId)} (${pick.why}).`, { ref: { col: "orders", id: o.id } }); closeKey("ziek-" + o.id); }
        else if (pick) ask("ziek-" + o.id, `${was} is ${a.type.toLowerCase()} maar heeft rit ${o.ref} (${fdt(o.laaddatum)}). Voorstel: ${driverName(pick.driverId)} (${pick.why}).`, { type: "assign", id: o.id, driverId: pick.driverId, vehicleId: pick.vehicleId, label: "Geef aan " + driverName(pick.driverId) });
        else ask("ziek-" + o.id, `${was} is ${a.type.toLowerCase()} maar heeft rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}). Er is geen andere chauffeur vrij. Zoek een oplossing of een onderaannemer.`, { type: "order", id: o.id });
        continue;
      }
      if (f > horizon) continue;
      if (!hasOpen("plan-" + o.id)) act(`Ik zoek een vrije chauffeur voor ${o.ref} (${o.laadplaats} → ${o.losplaats})…`, { col: "orders", id: o.id });
      const pick = await pickDriver(o);
      const ver = pick && pick.dist != null && pick.dist > 300;
      if (pick && auto && !ver) { assign(o, pick, pick.why); log("toewijzing", `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) naar de app van ${driverName(pick.driverId)} gestuurd${pick.vehicleId ? ", met " + ((store.get("vehicles", pick.vehicleId) || {}).kenteken || "") : ""}: ${pick.why}.`, { ref: { col: "orders", id: o.id } }); closeKey("plan-" + o.id); }
      else if (pick) ask("plan-" + o.id, `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) heeft nog geen chauffeur. ${ver ? "De dichtstbijzijnde vrije chauffeur is ver weg: " : "Voorstel: "}${driverName(pick.driverId)} (${pick.why}).${ver ? " Misschien beter een onderaannemer of een retourrit?" : ""}`, { type: "assign", id: o.id, driverId: pick.driverId, vehicleId: pick.vehicleId, label: "Geef aan " + driverName(pick.driverId) });
      else if (f <= addDays(today, 1)) ask("plan-" + o.id, `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) heeft nog geen chauffeur en niemand is vrij.`, { type: "order", id: o.id });
    }
    // chauffeur ziek tijdens een lopende rit
    for (const o of store.all("orders").filter(o => ACTIVE.includes(o.status) && o.chauffeurId && absOn(o.chauffeurId, today)))
      ask("ziek-" + o.id, `${driverName(o.chauffeurId)} is ziek gemeld terwijl rit ${o.ref} bezig is (${o.status}). Bel hem even: moet iemand de vracht overnemen?`, { type: "order", id: o.id });
  }

  // ---------- 4. facturen ----------
  function invoiceParts(i) {
    const k = store.get("customers", i.klantId) || {}, lines = i.lines || (i.orderIds || []).map(id => store.get("orders", id)).filter(Boolean).map(o => ({ orderId: o.id, omschrijving: lineText(o), bedrag: +o.prijs || 0 }));
    return { k, lines, b: bedrijf() };
  }
  const pdfOf = i => { const { k, lines, b } = invoiceParts(i); return pdf.invoicePdf(i, { bedrijf: b, klant: k, lines, fdate, eur: eurS, ogm: ogm(i.nr) }); };
  function cmrAtts(i) { const out = []; for (const id of i.orderIds || []) { const o = store.get("orders", id); if (!o || !o.cmr) continue; const f = readFile(o.cmr.id); if (f && f.buf.length < 8e6) out.push({ o, f }); } return out; }
  // Facturen: Atlas controleert en zet klaar; jij keurt goed en verstuurt.
  async function invoices() { for (const i of store.all("invoices").filter(i => i.status === "Concept")) checkInvoice(i); }
  function checkInvoice(i) {
    const { k, lines, b } = invoiceParts(i), chk = i.cmrCheck, tot = calcTotals(lines, i.btw);
    const open = { type: "invoice", id: i.id, label: "Nakijken en versturen" };
    if (!chk) { if (Date.now() - new Date(i.aangemaakt || 0).getTime() > 3600e3) ask("inv-" + i.id, `Conceptfactuur ${i.nr} voor ${k.naam || "?"} (${eurS(tot.totaal)}) staat klaar, maar de CMR kon niet automatisch gecontroleerd worden. Kijk de CMR zelf even na.`, open); return; }
    if (chk.conclusie !== "ok") { ask("inv-" + i.id, `⚠️ CMR bij factuur ${i.nr} (${k.naam || "?"}) is niet in orde: ${chk.samenvatting || chk.verschillen || chk.voorbehoud || "nakijken"}. Niet zomaar versturen.`, open); return; }
    if (!lines.length || lines.some(l => !(+l.bedrag > 0) && l.soort !== "wacht")) { ask("inv-" + i.id, `Factuur ${i.nr} (${k.naam || "?"}) heeft een lijn zonder bedrag. Vul de prijs aan voor je verstuurt.`, open); return; }
    const missing = [];
    if (ubl.isBE(k)) missing.push(...ubl.problems(b, k));
    else if (!(i.aan || k.emailFactuur || k.email)) missing.push("mailadres van de klant");
    const wacht = lines.filter(l => l.soort === "wacht").reduce((s, l) => s + (+l.bedrag || 0), 0);
    ask("inv-" + i.id, `🧾 Factuurconcept ${i.nr} voor ${k.naam || "?"} (${eurS(tot.totaal)}${wacht ? ", waarvan " + eurS(wacht) + " wachttijd" : ""}) is klaar en moet je nog goedkeuren. CMR is in orde: ${chk.samenvatting || "getekend, geen voorbehoud"}.${ubl.isBE(k) ? " Belgische klant: kies \"Goedkeuren · e-factuur (Peppol)\" voor Lucy." : ""}${missing.length ? " Vul eerst nog aan: " + missing.join(", ") + "." : ""}`, open);
  }
  function finalize(i, upd) {
    const prev = store.get("invoices", i.id), d = store.patch("invoices", i.id, { ...upd, status: "Open", jarvis: { goedgekeurd: new Date().toISOString() } }); emit("invoices", i.id, d, prev);
    for (const oid of i.orderIds || []) { const p = store.get("orders", oid); if (p) emit("orders", oid, store.patch("orders", oid, { status: "Gefactureerd", factuurId: i.id }), p); }
  }

  // ---------- 5. betalingsherinneringen ----------
  async function reminders() { for (const i of store.all("invoices").filter(i => i.status === "Open" && i.vervaldatum && i.vervaldatum < todayLocal())) await remindOne(i, true, false); }
  async function remindOne(i, dry, force) {
    const c = cfg(), today = todayLocal(), b = bedrijf();
    {
      const h = i.herinneringen || [], last = h[h.length - 1];
      if (!force) {
        if (i.vervaldatum < addDays(today, -120)) return;
        if (addDays(i.vervaldatum, c.herinneringNa) > today) return;
        if (last && addDays(last.slice(0, 10), c.herinneringOm) > today) return;
      }
      const k = store.get("customers", i.klantId) || {};
      if (h.length >= c.maxHerinneringen) { ask("betaal-" + i.id, `Factuur ${i.nr} van ${k.naam || "?"} (${eurS(i.totaal)}) is na ${h.length} herinneringen nog niet betaald (vervallen ${fdate(i.vervaldatum)}). Tijd om te bellen?`, { type: "invoice", id: i.id }); return; }
      const to = String(i.aan || k.emailFactuur || k.email || "").split(/[,;\s]+/).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
      if (!to.length) return;
      const sig = `\n\nMet vriendelijke groeten,\n${b.naam || "Ghotra Transport"}${b.tel ? "\n" + b.tel : ""}`;
      if (dry) { ask("rem-" + i.id + "-" + h.length, `💶 Factuur ${i.nr} van ${k.naam} (${eurS(i.totaal)}) is ${Math.round((new Date(today) - new Date(i.vervaldatum)) / 864e5)} dagen te laat betaald. Ik heb een ${h.length ? (h.length + 1) + "e " : ""}herinnering klaargezet voor ${to.join(", ")}.`, { type: "remind", id: i.id, n: h.length, label: "Herinnering nakijken" }); return; }
      const subject = `${h.length ? (h.length + 1) + "e herinnering" : "Herinnering"} factuur ${i.nr}`;
      const body = `Beste${k.contact ? " " + k.contact : ""},\n\nVolgens onze gegevens staat factuur ${i.nr} van ${fdate(i.datum)} (${eurS(i.totaal)}) nog open. De vervaldatum was ${fdate(i.vervaldatum)}.\nWilt u de betaling nakijken${b.iban ? " en het bedrag overmaken op " + b.iban : ""} met mededeling ${i.ogm || ogm(i.nr)}?\n\nIs de betaling al onderweg, dan mag u dit bericht negeren.` + sig;
      try { await mail.send({ to, cc: [], subject, text: body, attachments: [{ filename: `Factuur-${i.nr}.pdf`, mime: "application/pdf", bytes: pdfOf(i) }] }); }
      catch (e) { log("fout", `Herinnering voor ${i.nr} versturen lukte niet: ${e.message}`); return; }
      const prev = store.get("invoices", i.id); emit("invoices", i.id, store.patch("invoices", i.id, { herinneringen: [...h, new Date().toISOString()] }), prev);
      store.put("maillog", uid(), { threadId: "", invoiceId: i.id, subject, to: to.join(", "), date: new Date().toISOString(), kind: "sent" });
      log("herinnering", `${subject} verstuurd naar ${k.naam} (${eurS(i.totaal)}, ${Math.round((new Date(today) - new Date(i.vervaldatum)) / 864e5)} dagen te laat).`, { ref: { col: "invoices", id: i.id } });
    }
  }

  // ---------- 7. waakhond: rit niet gezien, niet vertrokken, CMR vergeten ----------
  async function waakhond() {
    const now = Date.now();
    for (const o of store.all("orders").filter(o => o.chauffeurId && LIVE.includes(o.status))) {
      const a = localMs(o.laaddatum, "08:00"); if (!a) continue;
      const wd = o.waak || {}, set = upd => { const p = store.get("orders", o.id); emit("orders", o.id, store.patch("orders", o.id, { waak: { ...(p.waak || {}), ...upd } }), p); };
      const dn = driverName(o.chauffeurId), tijd = fdt(o.laaddatum);
      if (o.status === "Gepland" && !o.gezien && !wd.eerst) { set({ eerst: new Date().toISOString() }); continue; }
      const grace = wd.eerst && now - new Date(wd.eerst).getTime() > 15 * 60e3;
      if (o.status === "Gepland" && !o.gezien && grace) {
        if (a - now < 3 * 3600e3 && a - now > -6 * 3600e3 && !wd.gezienPush) { push.notifyDriver(o.chauffeurId, { title: `Rit ${o.ref} · laden ${tijd}`, body: `${o.laadplaats} → ${o.losplaats}. Open de app om je rit te bekijken.`, url: "/chauffeur#rit-" + o.id }); set({ gezienPush: new Date().toISOString() }); }
        if (a - now < 3600e3 && a - now > -6 * 3600e3) ask("waak-gezien-" + o.id, `${dn} heeft rit ${o.ref} (laden ${tijd} in ${o.laadplaats}) nog niet geopend in de app. Bel hem even.`, { type: "order", id: o.id });
      }
      if (o.status === "Gepland" && now - a > 30 * 60e3 && now - a < 12 * 3600e3) ask("waak-start-" + o.id, `Rit ${o.ref}: laden was om ${tijd}, maar ${dn} heeft nog niet op "Naar laadplaats" gedrukt. Is hij vertrokken?`, { type: "order", id: o.id });
      const g = o.tijden && o.tijden.Gelost;
      if (g && !o.cmr) {
        const since = now - new Date(g).getTime();
        if (since > 20 * 60e3 && !wd.cmrPush) { push.notifyDriver(o.chauffeurId, { title: `CMR-foto voor ${o.ref}`, body: "Vergeet de foto van de getekende CMR niet. Zonder CMR kunnen we niet factureren.", url: "/chauffeur#rit-" + o.id }); set({ cmrPush: new Date().toISOString() }); }
        if (since > 3 * 3600e3) ask("waak-cmr-" + o.id, `Rit ${o.ref} is al ${Math.round(since / 3600e3)} uur gelost maar ${dn} heeft nog geen CMR-foto gestuurd.`, { type: "order", id: o.id });
      }
    }
  }

  // ---------- 8. vervaldatums (rijbewijs, code 95, keuring, documenten) ----------
  function vervaldatums() {
    const today = todayLocal(), lim = addDays(today, 30);
    const chk = (col, id, field, date, what) => { if (!date || date > lim) return; const late = date < today; ask(`verval-${col}-${id}-${field}-${date}`, `${what} ${late ? "is vervallen sinds" : "vervalt op"} ${fdate(date)}.`, { type: "verval", col, id, field, date }); };
    for (const d of store.all("drivers")) { chk("drivers", d.id, "rijbewijs", d.rijbewijs, `Rijbewijs van ${d.naam}`); chk("drivers", d.id, "code95", d.code95, `Code 95 van ${d.naam}`); }
    for (const v of store.all("vehicles")) chk("vehicles", v.id, "keuring", v.keuring, `Keuring van ${v.kenteken}`);
    for (const d of store.all("documents")) chk("documents", d.id, "vervaldatum", d.vervaldatum, `${d.naam}`);
  }

  // ---------- opruimen: vragen die intussen opgelost zijn sluiten ----------
  function opruimen() {
    for (const j of store.all("jarvis").filter(j => j.open && !j.klaar && j.key)) {
      const k = j.key, id = k.replace(/^[a-z]+-(?:[a-z]+-)?/, ""), a = j.actie || {};
      const O = a.id ? store.get("orders", a.id) : null, I = a.id ? store.get("invoices", a.id) : null;
      let done = false;
      if (/^prijs-/.test(k)) { const o = store.get("orders", id); done = !o || o.status === "Geannuleerd" || (o.prijs !== "" && o.prijs != null); }
      else if (/^plan-/.test(k)) { const o = store.get("orders", id); done = !o || !!o.chauffeurId || o.status !== "Gepland"; }
      else if (/^ziek-/.test(k)) { const o = store.get("orders", id); done = !o || !LIVE.includes(o.status) || !absentIn(o.chauffeurId, span(o)); }
      else if (/^inv-/.test(k)) { const i = store.get("invoices", id); done = !i || i.status !== "Concept"; }
      else if (/^offer-/.test(k)) done = false;
      else if (/^sub-/.test(k)) { const o = store.get("orders", id); done = !o || !!o.chauffeurId || !LIVE.includes(o.status); }
      else if (/^retour-/.test(k)) done = !O || !LIVE.includes(O.status);
      else if (/^(betaal|lucy)-/.test(k)) { const i = store.get("invoices", id); done = !i || i.status === "Betaald"; }
      else if (/^rem-/.test(k)) { done = !I || I.status !== "Open" || (I.herinneringen || []).length > (a.n || 0); }
      else if (/^waak-gezien-/.test(k)) done = !O || !!O.gezien || O.status !== "Gepland";
      else if (/^waak-start-/.test(k)) done = !O || O.status !== "Gepland";
      else if (/^waak-cmr-/.test(k)) done = !O || !!O.cmr;
      else if (/^verval-/.test(k)) { const r = store.get(a.col, a.id); done = !r || r[a.field] !== a.date; }
      else if (/^mail-/.test(k) && a.key && /^🔴/.test(j.tekst)) { const mi = store.get("mailinfo", a.key); done = !!(mi && mi.afgehandeld); if (a.type === "cancel" && O && O.status === "Geannuleerd") done = true; }
      else if (a.type === "cancel") done = !O || O.status === "Geannuleerd";
      if (done) { const d = store.patch("jarvis", j.id, { klaar: new Date().toISOString(), door: "Atlas", note: "opgelost" }); emitOffice({ type: "jarvis", item: d }); }
    }
  }

  // ---------- 9. kansen: onderaannemers, nieuwe klanten, retourvracht (Atlas zoekt op het internet) ----------
  const searching = new Set();
  function saveKansen(list, soort, extra = {}) {
    const have = store.all("kansen"), out = [], weg = (store.setting("kansenGewist") || []);
    for (const b of list) {
      const naam = String(b.naam || "").trim(); if (!naam) continue;
      if (have.some(k => k.soort === soort && k.naam.toLowerCase() === naam.toLowerCase() && (k.voorRit || "") === (extra.voorRit || ""))) continue;
      if (weg.includes(naam.toLowerCase())) continue;
      const id = uid(), k = store.put("kansen", id, { soort, naam, plaats: b.plaats || "", sector: b.sector || "", telefoon: b.telefoon || "", email: b.email || "", website: b.website || "", waarom: b.waarom || "", status: "nieuw", at: new Date().toISOString(), ...extra });
      out.push(k);
    }
    if (out.length) emitOffice({ type: "kansen" });
    setTimeout(() => checkAllLinks(10), 500);
    return out;
  }
  // Websites controleren: bestaat het adres echt? Anders een adres uit de bronnen, of later een zoeklink.
  const fixUrl = u => { u = String(u || "").trim().replace(/^[<(\["']+|[>)\]"',.;]+$/g, "").split(/\s+/)[0]; if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, ""); try { const x = new URL(u); return x.protocol.startsWith("http") && x.hostname.includes(".") ? x.href : ""; } catch { return ""; } };
  async function reachable(u) {
    if (!u) return false;
    try { const r = await fetch(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (Ghotra Atlas linkcheck)", accept: "text/html" } }); try { r.body && r.body.cancel && r.body.cancel(); } catch {} return r.status < 500; }
    catch { return false; }
  }
  async function checkLinks(k) {
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
    const srcs = (k.bronnen || []).map(b => b.url).filter(Boolean), words = String(k.naam || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !/transport|logistic|logistics|group|cargo|gmbh|bvba/.test(w));
    const out = {};
    for (const f of ["website", "aanmelden"]) {
      let u = fixUrl(k[f]);
      if (u && !(await reachable(u))) { const w = u.replace("://", "://www."); u = !/\/\/www\./.test(u) && await reachable(w) ? w : ""; }
      if (!u && f === "website") { const m = srcs.find(s => words.some(w => host(s).includes(w))); if (m && await reachable(m)) u = "https://" + new URL(m).hostname + "/"; }
      out[f] = u; out[f + "Ok"] = !!u;
    }
    const d = store.patch("kansen", k.id, { website: out.website || "", aanmelden: out.aanmelden || "", webOk: out.websiteOk, linksGecontroleerd: new Date().toISOString() });
    emitOffice({ type: "kansen" }); return d;
  }
  async function checkAllLinks(max = 6) { for (const k of store.all("kansen").filter(k => !k.linksGecontroleerd).slice(0, max)) { try { await checkLinks(k); } catch {} } }
  const kList = l => l.slice(0, 4).map(b => b.naam + (b.plaats ? " (" + b.plaats + ")" : "") + (b.telefoon ? " " + b.telefoon : "")).join(", ");
  const SYS_ZOEK = "Je bent een ervaren dispatcher en zakenontwikkelaar voor een Belgisch transportbedrijf (trekker met oplegger, internationaal Benelux/Frankrijk/Duitsland). Je zoekt op het internet naar echte bedrijven met hun contactgegevens. Verzin nooit bedrijven, telefoonnummers of e-mailadressen: laat een veld leeg als je het niet vond. Antwoord aan het einde met alleen het gevraagde JSON-blok.";
  async function zoekOnderaannemers(o, reden) {
    if (!ai.configured() || searching.has("sub-" + o.id) || store.all("kansen").some(k => k.voorRit === o.id)) return;
    searching.add("sub-" + o.id);
    try {
      act(`Niemand vrij voor ${o.ref}. Ik zoek vervoerders rond ${o.laadplaats}…`, { col: "orders", id: o.id });
      const r = await ai.research({ system: SYS_ZOEK, maxUses: 5, prompt: `Zoek 3 tot 5 transportbedrijven met eigen vrachtwagens (trekker + oplegger) in de buurt van ${(o.laadadres || o.laadplaats).replace(/\n/g, ", ")} die als onderaannemer/charter deze vracht kunnen rijden: ${o.laadplaats} → ${o.losplaats}, laden ${fdt(o.laaddatum)}${o.goederen ? ", " + o.goederen : ""}${o.gewicht ? ", " + o.gewicht + " kg" : ""}${o.adr ? ", ADR" : ""}. Kies bij voorkeur bedrijven die ook richting ${o.losplaats} rijden.
JSON: {"bedrijven":[{"naam":"","plaats":"","telefoon":"","email":"","website":"","waarom":"één korte zin"}]}` });
      const list = ((r.data && r.data.bedrijven) || []).filter(b => b && b.naam).slice(0, 5);
      const saved = saveKansen(list, "onderaannemer", { voorRit: o.id, rit: `${o.ref} ${o.laadplaats} → ${o.losplaats}`, bronnen: r.sources.slice(0, 6) });
      if (saved.length) ask("sub-" + o.id, `🔎 ${reden} Voor ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) vond ik ${saved.length} mogelijke onderaannemers: ${kList(saved)}. Bel er eentje, of geef de rit toch aan een eigen chauffeur.`, { type: "kansen", id: o.id, label: "Bekijk de vervoerders" });
      else log("kansen", `Ik vond geen geschikte onderaannemers rond ${o.laadplaats} voor ${o.ref}.`, { ref: { col: "orders", id: o.id } });
    } catch (e) { log("fout", `Onderaannemers zoeken lukte niet: ${e.message}`); }
    finally { searching.delete("sub-" + o.id); }
  }
  async function zoekKlanten(handmatig) {
    if (!ai.configured()) throw Object.assign(new Error("AI is niet gekoppeld"), { status: 409 });
    if (searching.has("klanten")) return { bezig: true }; searching.add("klanten");
    try {
      const b = bedrijf(), O = store.all("orders"), lanes = {};
      for (const o of O) { const k = `${(o.laadplaats || "").split(",")[0]} → ${(o.losplaats || "").split(",")[0]}`; lanes[k] = (lanes[k] || 0) + 1; }
      const top = Object.entries(lanes).sort((a, z) => z[1] - a[1]).slice(0, 5).map(x => x[0]).join("; ");
      const known = store.all("customers").map(c => c.naam).concat(store.all("kansen").filter(k => k.soort === "klant").map(k => k.naam), store.setting("kansenGewist") || []);
      act("Ik zoek nieuwe klanten op het internet…", { view: "jarvis" });
      const r = await ai.research({ system: SYS_ZOEK, maxUses: 6, prompt: `Ons bedrijf: ${b.naam || "Ghotra Transport"}, ${String(b.adres || "Antwerpen").replace(/\n/g, ", ")}. Wij rijden met trekker + oplegger (13,6 m), nationaal en internationaal.${top ? " Onze huidige routes: " + top + "." : ""}
Zoek 5 tot 8 bedrijven die regelmatig volle vrachten (FTL) laten vervoeren en die een goede nieuwe klant voor ons kunnen zijn: verladers (productie, groothandel, distributiecentra) binnen ongeveer 60 km van ons, of op onze routes. Geen andere transportbedrijven of expediteurs. Sla deze bekende namen over: ${known.slice(0, 60).join(", ") || "(geen)"}.
Geef per bedrijf naam, plaats, sector, telefoon, e-mail (algemeen of logistiek), website en één zin waarom ze interessant zijn (bv. wat ze vervoeren).
JSON: {"bedrijven":[{"naam":"","plaats":"","sector":"","telefoon":"","email":"","website":"","waarom":""}]}` });
      const saved = saveKansen(((r.data && r.data.bedrijven) || []).filter(x => x && x.naam).slice(0, 8), "klant", { bronnen: r.sources.slice(0, 8) });
      store.setting("jarvisKlantenGezocht", new Date().toISOString());
      if (saved.length) log("kansen", `Ik vond ${saved.length} mogelijke nieuwe klanten: ${kList(saved)}. Je vindt ze onder Kansen.`, { actie: { type: "kansen" } });
      else log("kansen", "Ik vond deze keer geen nieuwe klanten.");
      return { gevonden: saved.length };
    } finally { searching.delete("klanten"); }
  }
  // Vaste opdrachtgevers: grote logistieke bedrijven die op lange termijn met onderaannemers (charters) werken.
  async function zoekPartners() {
    if (!ai.configured()) throw Object.assign(new Error("AI is niet gekoppeld"), { status: 409 });
    if (searching.has("partners")) return { bezig: true }; searching.add("partners");
    try {
      const b = bedrijf(), v = store.all("vehicles").filter(x => x.type !== "Oplegger").length || store.all("drivers").length || 1;
      const known = store.all("customers").map(c => c.naam).concat(store.all("kansen").filter(k => k.soort === "partner").map(k => k.naam), store.setting("kansenGewist") || []);
      act("Ik zoek betrouwbare vaste opdrachtgevers in Europa…", { view: "jarvis" });
      const r = await ai.research({ system: SYS_ZOEK, maxUses: 8, schema: '{"bedrijven":[{"naam":"","land":"","plaats":"","telefoon":"","email":"","website":"","aanmelden":"","betrouwbaarheid":"","waarom":""}]}', prompt: `Ons bedrijf: ${b.naam || "Ghotra Transport"}, ${String(b.adres || "Antwerpen, België").replace(/\n/g, ", ")}. Wij zijn een kleine vervoerder met ongeveer ${v} trekker(s) + oplegger (13,6 m, tautliner), internationaal rijden mag.
Zoek 5 tot 8 grote, betrouwbare logistieke bedrijven en expediteurs in Europa (België, Nederland, Duitsland, Frankrijk, Polen, Litouwen, …) die op lange termijn met vaste onderaannemers/charters werken en kleine vervoerders aannemen (bv. zoals DSV, Ewals Cargo Care, Girteka, Raben, Kuehne+Nagel, Jan de Rijk, H.Essers — maar zoek ook minder bekende, liefst met routes vanuit of naar de Benelux). Sla deze namen over: ${known.slice(0, 80).join(", ") || "(geen)"}.
Betrouwbaar betekent: lang actief, groot, bekende naam, certificaten (bv. ISO, TAPA, SQAS), goede betaalreputatie of vaste betaaltermijnen, een officieel programma om als vervoerder/subcontractor aan te sluiten.
Geef per bedrijf: naam, land, plaats (hoofdkantoor of vestiging die vervoerders zoekt), telefoon, e-mail (carrier/subcontracting/aankoop transport), website, "aanmelden": de link naar hun pagina of formulier om je als vervoerder/charter aan te melden (als je die vond), "betrouwbaarheid": één zin met de concrete reden, en "waarom": één zin waarom het bij ons past (routes, type vracht, vaste ritten).
JSON: {"bedrijven":[{"naam":"","land":"","plaats":"","telefoon":"","email":"","website":"","aanmelden":"","betrouwbaarheid":"","waarom":""}]}` });
      if (!r.data) { log("fout", "Ik vond resultaten maar kon ze niet goed lezen. Probeer \"Zoek vaste opdrachtgevers\" nog eens."); return { gevonden: 0, fout: true }; }
      const list = ((r.data && r.data.bedrijven) || []).filter(x => x && x.naam).slice(0, 8).map(x => ({ ...x, plaats: [x.plaats, x.land].filter(Boolean).join(", "), sector: "logistiek / onderaanneming" }));
      const saved = saveKansen(list, "partner", { bronnen: r.sources.slice(0, 10) });
      for (const k of saved) { const src = list.find(x => x.naam === k.naam) || {}; store.patch("kansen", k.id, { aanmelden: src.aanmelden || "", betrouwbaarheid: src.betrouwbaarheid || "", land: src.land || "" }); }
      store.setting("jarvisPartnersGezocht", new Date().toISOString());
      log("kansen", saved.length ? `Ik vond ${saved.length} betrouwbare bedrijven die met vaste onderaannemers werken: ${kList(saved)}. Je vindt ze onder Kansen → Vaste opdrachtgevers.` : "Ik vond deze week geen nieuwe vaste opdrachtgevers.", { actie: { type: "kansen" } });
      if (saved.length) emitOffice({ type: "kansen" });
      return { gevonden: saved.length };
    } finally { searching.delete("partners"); }
  }
  // Chauffeurs werven: uitzendkantoren, rekruteerders en vacaturesites voor CE-chauffeurs, plus een vacaturetekst.
  async function zoekChauffeurs() {
    if (!ai.configured()) throw Object.assign(new Error("AI is niet gekoppeld"), { status: 409 });
    if (searching.has("chauffeurs")) return { bezig: true }; searching.add("chauffeurs");
    try {
      const b = bedrijf(), known = store.all("kansen").filter(k => k.soort === "chauffeur").map(k => k.naam).concat(store.setting("kansenGewist") || []);
      act("Ik zoek manieren om chauffeurs te vinden…", { view: "kansen" });
      const r = await ai.research({ system: SYS_ZOEK, maxUses: 8, schema: '{"bedrijven":[{"naam":"","sector":"","land":"","plaats":"","telefoon":"","email":"","website":"","aanmelden":"","betrouwbaarheid":"","waarom":""}]}', prompt: `Ons bedrijf: ${b.naam || "Ghotra Transport"}, ${String(b.adres || "Antwerpen, België").replace(/\n/g, ", ")}. Wij zoeken vrachtwagenchauffeurs met rijbewijs CE en code 95 voor trekker-oplegger, nationaal en internationaal (Benelux, Frankrijk, Duitsland).
Zoek 6 tot 8 betrouwbare manieren om goede chauffeurs te vinden: uitzendkantoren en rekruteringsbureaus die gespecialiseerd zijn in vrachtwagenchauffeurs (in België en Nederland, en ook in landen waar veel CE-chauffeurs vandaan komen zoals Polen, Litouwen, Roemenië of Portugal, liefst met ervaring in plaatsing in België), en de beste vacaturesites of jobplatformen waar CE-chauffeurs zoeken (bv. VDAB, Jobat, Indeed, gespecialiseerde transportjobsites). Sla over: ${known.slice(0, 60).join(", ") || "(geen)"}.
Geef per item: naam, sector ("uitzendkantoor", "rekruteringsbureau", "vacaturesite" of "opleidingscentrum"), land, plaats, telefoon, e-mail, website, "aanmelden": de link om een vacature te plaatsen of contact op te nemen als werkgever, "betrouwbaarheid": één zin met de concrete reden, "waarom": één zin.
Houd elke tekst kort.
JSON: {"bedrijven":[{"naam":"","sector":"","land":"","plaats":"","telefoon":"","email":"","website":"","aanmelden":"","betrouwbaarheid":"","waarom":""}]}` });
      const list = ((r.data && r.data.bedrijven) || []).filter(x => x && x.naam).slice(0, 8).map(x => ({ ...x, plaats: [x.plaats, x.land].filter(Boolean).join(", ") }));
      const saved = saveKansen(list, "chauffeur", { bronnen: r.sources.slice(0, 10) });
      for (const k of saved) { const src = list.find(x => x.naam === k.naam) || {}; store.patch("kansen", k.id, { aanmelden: src.aanmelden || "", betrouwbaarheid: src.betrouwbaarheid || "", land: src.land || "" }); }
      if (!r.data) { log("fout", "Ik vond resultaten maar kon ze niet goed lezen. Probeer \"Zoek chauffeurs\" nog eens."); return { gevonden: 0, fout: true }; }
      // vacaturetekst apart laten schrijven (korter en betrouwbaarder)
      try {
        const v = await ai.write({ prompt: `Schrijf een korte, aantrekkelijke vacature voor ${b.naam || "Ghotra Transport"} (${String(b.adres || "België").replace(/\n/g, ", ")}): vrachtwagenchauffeur CE met code 95, trekker-oplegger, nationaal en internationaal (Benelux, Frankrijk, Duitsland). Structuur: titel, wie we zijn (1 zin), wat je doet, wat we bieden, wat we vragen, hoe solliciteren. Laat loon en contactgegevens als [invullen]. Maximaal 180 woorden. Geef eerst de Nederlandse versie, dan een regel met alleen ===EN===, dan dezelfde vacature in het Engels.`, maxTokens: 1500 });
        const [nl, en] = String(v || "").split(/\n?===EN===\n?/);
        if (nl && nl.trim()) store.setting("vacatureTekst", { nl: nl.trim(), en: (en || "").trim(), at: new Date().toISOString() });
      } catch {}
      log("kansen", saved.length ? `Ik vond ${saved.length} manieren om chauffeurs te vinden: ${kList(saved)}. Een vacaturetekst staat klaar onder Kansen → Chauffeurs.` : "Ik vond geen nieuwe kanalen om chauffeurs te vinden.", { actie: { type: "kansen" } });
      emitOffice({ type: "kansen" });
      return { gevonden: saved.length };
    } finally { searching.delete("chauffeurs"); }
  }
  // Vrachtwagens zoeken: echte advertenties op tweedehandssites, volgens je zoekprofiel.
  const VTYPE = { bakwagen_schuifzeil: "bakwagen (motorwagen/bakwagen) met schuifzeilen / curtainsider (Pritsche/Plane, Schiebeplane, tautliner)", bakwagen_gesloten: "bakwagen met gesloten opbouw (koffer/box)", trekker: "trekker (Sattelzugmaschine, tractor unit) 4x2", oplegger: "oplegger tautliner/schuifzeil (Curtainsider-Auflieger)" };
  async function zoekVoertuigen(profiel) {
    if (!ai.configured()) throw Object.assign(new Error("AI is niet gekoppeld"), { status: 409 });
    const p = { type: "bakwagen_schuifzeil", landen: "België, Nederland, Duitsland", ...(profiel || store.setting("voertuigZoek") || {}) };
    if (searching.has("voertuigen")) return { bezig: true }; searching.add("voertuigen");
    try {
      store.setting("voertuigZoek", { ...p, laatst: new Date().toISOString() });
      const known = store.all("kansen").filter(k => k.soort === "voertuig").map(k => k.website).filter(Boolean);
      const wens = [p.mtm ? `toegelaten massa (MTM) ongeveer ${p.mtm} ton` : "", p.laadvermogen ? `laadvermogen minstens ${p.laadvermogen} kg` : "", p.opbouw ? `opbouwlengte ${p.opbouw} m` : "", p.bak ? (p.bak === "automaat" ? "automatische versnellingsbak" : "manuele versnellingsbak") : "", p.merken ? `merk: ${p.merken}` : "", p.maxPrijs ? `maximaal € ${p.maxPrijs} (excl. btw)` : "", p.vanafJaar ? `bouwjaar ${p.vanafJaar} of nieuwer` : "", p.maxKm ? `hooguit ${p.maxKm} km` : "", p.euro6 ? "Euro 6" : "", p.laadklep ? "met laadklep" : "", p.extra || ""].filter(Boolean).join(", ");
      act(`Ik zoek ${(VTYPE[p.type] || p.type).split(" (")[0]}…`, { view: "kansen" });
      const r = await ai.research({ system: SYS_ZOEK + " Je zoekt tweedehands bedrijfsvoertuigen voor een transportbedrijf. Geef alleen echte advertenties die je online vond, met hun echte link; verzin nooit prijzen of kilometerstanden.", maxUses: 10,
        schema: '{"voertuigen":[{"titel":"","merk":"","model":"","bouwjaar":"","km":"","prijs":"","land":"","plaats":"","verkoper":"","telefoon":"","link":"","kenmerken":"","waarom":""}]}',
        prompt: `Zoek 6 tot 10 te koop staande ${VTYPE[p.type] || p.type}${wens ? ": " + wens : ""}. Landen: ${p.landen || "België, Nederland, Duitsland"}.
Zoek op sites met advertenties voor bedrijfsvoertuigen, zoals Truckscout24, mobile.de (Nutzfahrzeuge), AutoScout24 Trucks, Mascus, Trucksnl, 2dehands/2ememain, Marktplaats, Via Mobilis en de voorraadpagina's van truckdealers.
Geef per voertuig: titel, merk, model, bouwjaar, km (kilometerstand), prijs (met munt, excl. of incl. btw zoals vermeld), land, plaats, verkoper (bedrijf), telefoon (als vermeld), link (directe link naar de advertentie), kenmerken (bv. opbouwlengte, laadvermogen, laadklep, euronorm, versnellingsbak) en waarom (één zin: waarom interessant of let op).
${known.length ? "Sla deze advertenties over: " + known.slice(-40).join(" ") : ""}
JSON: {"voertuigen":[{"titel":"","merk":"","model":"","bouwjaar":"","km":"","prijs":"","land":"","plaats":"","verkoper":"","telefoon":"","link":"","kenmerken":"","waarom":""}]}` });
      if (!r.data) { log("fout", "Ik vond advertenties maar kon ze niet goed lezen. Probeer \"Zoek vrachtwagens\" nog eens."); return { gevonden: 0, fout: true }; }
      const list = ((r.data.voertuigen) || []).filter(v => v && (v.titel || v.merk) && v.link).slice(0, 10)
        .filter(v => !known.includes(fixUrl(v.link)))
        .map(v => ({ naam: v.titel || [v.merk, v.model].filter(Boolean).join(" "), plaats: [v.plaats, v.land].filter(Boolean).join(", "), sector: v.kenmerken || "", telefoon: v.telefoon || "", website: v.link, waarom: v.waarom || "", _v: v }));
      const saved = saveKansen(list, "voertuig", { bronnen: r.sources.slice(0, 10), zoekType: p.type });
      for (const k of saved) { const v = (list.find(x => x.naam === k.naam) || {})._v || {}; store.patch("kansen", k.id, { prijs: String(v.prijs || ""), bouwjaar: String(v.bouwjaar || ""), km: String(v.km || ""), verkoper: v.verkoper || "", merk: v.merk || "", website: fixUrl(v.link) }); }
      log("kansen", saved.length ? `Ik vond ${saved.length} ${saved.length === 1 ? "nieuwe vrachtwagen" : "nieuwe vrachtwagens"} te koop: ${saved.slice(0, 3).map(k => k.naam).join(", ")}${saved.length > 3 ? "…" : ""}. Bekijk ze onder Kansen → Vrachtwagens.` : "Ik vond geen nieuwe vrachtwagens die passen bij je zoekopdracht.", { actie: { type: "kansen" } });
      emitOffice({ type: "kansen" });
      return { gevonden: saved.length };
    } finally { searching.delete("voertuigen"); }
  }
  // Lege terugrit: vrachtwagen lost ver van huis en heeft daarna nog niets.
  let homePos = null;
  async function retourCheck() {
    if (!homePos) homePos = await placeOf(String(bedrijf().adres || "").replace(/\n/g, ", ")); if (!homePos) return;
    const O = store.all("orders");
    for (const o of O.filter(o => o.chauffeurId && [...ACTIVE, "Gepland"].includes(o.status))) {
      const w = await win(o); if (!w.U || w.a - Date.now() > 3 * 864e5) continue;
      const afstand = km(homePos, w.U); if (afstand < 250) continue;
      let next = false; for (const x of O.filter(x => x.id !== o.id && x.chauffeurId === o.chauffeurId && LIVE.includes(x.status))) { const wx = await win(x); if (wx.a >= w.b - 3600e3 && wx.a - w.b < 36 * 3600e3) { next = true; break; } }
      if (next) { closeKey("retour-" + o.id); continue; }
      ask("retour-" + o.id, `🔁 ${driverName(o.chauffeurId)} lost ${fdt(o.losdatum || o.laaddatum)} in ${o.losplaats}, ${Math.round(afstand * 1.2)} km van huis, en heeft daarna nog geen rit. Zal ik retourvracht zoeken richting België?`, { type: "retour", id: o.id, label: "Zoek retourvracht" });
    }
  }
  async function zoekRetour(o) {
    if (!ai.configured()) throw Object.assign(new Error("AI is niet gekoppeld"), { status: 409 });
    act(`Ik zoek retourvracht vanuit ${o.losplaats}…`, { col: "orders", id: o.id });
    const thuis = String(bedrijf().adres || "België").replace(/\n/g, ", ");
    const bestaande = store.all("customers").map(c => c.naam).slice(0, 40).join(", ");
    const r = await ai.research({ system: SYS_ZOEK, maxUses: 6, prompt: `Onze vrachtwagen (trekker + oplegger 13,6 m) staat leeg in ${o.losplaats} vanaf ${fdt(o.losdatum || o.laaddatum)} en moet terug naar ${thuis}.
Zoek 4 tot 6 bedrijven in of rond ${o.losplaats} (verladers, productie, distributiecentra, of expediteurs die retourladingen naar België/Benelux uitbesteden) die we kunnen contacteren voor een retourvracht. Vermeld ook als een van onze klanten (${bestaande || "geen"}) daar actief is.
JSON: {"bedrijven":[{"naam":"","plaats":"","sector":"","telefoon":"","email":"","website":"","waarom":""}]}` });
    const saved = saveKansen(((r.data && r.data.bedrijven) || []).filter(x => x && x.naam).slice(0, 6), "retour", { voorRit: o.id, rit: `${o.ref}: leeg in ${o.losplaats}`, bronnen: r.sources.slice(0, 8) });
    log("kansen", saved.length ? `Retourvracht vanuit ${o.losplaats}: ${saved.length} bedrijven om te contacteren: ${kList(saved)}.` : `Ik vond geen retourvracht-kansen rond ${o.losplaats}.`, { ref: { col: "orders", id: o.id }, actie: { type: "kansen" } });
    return saved.length;
  }

  // ---------- 6. update om de x uur ----------
  function facts(since) {
    const today = todayLocal(), O = store.all("orders"), I = store.all("invoices");
    const done = store.all("jarvis").filter(j => j.at >= since && j.soort !== "update").sort((a, b) => a.at.localeCompare(b.at)).map(j => (j.open ? "VRAAG: " : "") + j.tekst);
    const open = store.all("jarvis").filter(j => j.open && !j.klaar).map(j => j.tekst);
    const bezig = O.filter(o => ACTIVE.includes(o.status)).map(o => `${o.ref} ${driverName(o.chauffeurId)}: ${o.status} (${o.laadplaats} → ${o.losplaats})`);
    const vandaag = O.filter(o => o.status === "Gepland" && dateOf(o.laaddatum) === today).map(o => `${o.ref} ${o.laadplaats} → ${o.losplaats} ${String(o.laaddatum).slice(11, 16)} ${o.chauffeurId ? driverName(o.chauffeurId) : "ZONDER chauffeur"}`);
    const gelost = O.filter(o => o.tijden && o.tijden.Gelost && o.tijden.Gelost >= since).map(o => `${o.ref} gelost in ${o.losplaats}`);
    const teLaat = I.filter(i => i.status === "Open" && i.vervaldatum && i.vervaldatum < today);
    const afwezig = store.all("drivers").filter(d => absOn(d.id, today)).map(d => `${d.naam} (${absOn(d.id, today).type})`);
    const verloopt = [...store.all("drivers").flatMap(d => [["rijbewijs", d.rijbewijs], ["code 95", d.code95]].filter(([, v]) => v && v <= addDays(today, 30)).map(([n, v]) => `${n} ${d.naam} ${v}`)),
      ...store.all("vehicles").filter(v => v.keuring && v.keuring <= addDays(today, 30)).map(v => `keuring ${v.kenteken} ${v.keuring}`),
      ...store.all("documents").filter(d => d.vervaldatum && d.vervaldatum <= addDays(today, 30)).map(d => `${d.naam} ${d.vervaldatum}`)];
    return { sinds: since, gedaan: done, openVragen: open, bezig, vandaagGepland: vandaag, gelost, teLaatBetaald: { aantal: teLaat.length, bedrag: teLaat.reduce((s, i) => s + (+i.totaal || 0), 0) }, afwezigVandaag: afwezig, verlooptBinnen30Dagen: verloopt };
  }
  async function update(force) {
    const c = cfg(), st = store.setting("jarvisUpdate") || {};
    if (!force) { if (!workTime()) return; if (st.last && Date.now() - new Date(st.last).getTime() < c.updateUren * 3600e3 - 120e3) return; }
    const since = st.last || new Date(Date.now() - c.updateUren * 3600e3).toISOString();
    const F = facts(since); let text = "";
    if (ai.configured()) {
      try { text = (await ai.write({ system: "Je bent Atlas, de assistent van transportbedrijf " + (bedrijf().naam || "Ghotra Transport") + ". Je schrijft een korte update voor de zaakvoerder in eenvoudig Vlaams-Nederlands. Geen inleiding, geen afsluiter. Eerst wat je zelf geregeld hebt, dan wat hij moet doen (alleen als er open vragen zijn), dan de stand van zaken. Maximaal 8 korte regels, elke regel begint met een passend emoji.", prompt: "Gegevens (JSON):\n" + JSON.stringify(F) })).trim(); } catch (e) { text = ""; }
    }
    if (!text) text = [F.gedaan.length ? `✅ Geregeld: ${F.gedaan.length} ${F.gedaan.length === 1 ? "ding" : "dingen"}` : "✅ Niets nieuws te regelen", F.openVragen.length ? `❓ ${F.openVragen.length} vraag/vragen voor jou` : "", F.bezig.length ? `🚛 Onderweg: ${F.bezig.length}` : "", F.gelost.length ? `📦 Gelost: ${F.gelost.join(", ")}` : "", F.teLaatBetaald.aantal ? `💶 Te laat betaald: ${F.teLaatBetaald.aantal} (${eurS(F.teLaatBetaald.bedrag)})` : "", F.afwezigVandaag.length ? `🤒 Afwezig: ${F.afwezigVandaag.join(", ")}` : ""].filter(Boolean).join("\n");
    store.setting("jarvisUpdate", { last: new Date().toISOString() });
    const n = nowParts();
    log("update", text, { titel: `Update van ${z(n.h)}:${z(n.m)}` });
    const open = store.all("jarvis").filter(j => j.open && !j.klaar).length;
    const kort = text.split("\n").slice(0, 4).join("\n") + (open ? `\n❓ ${open} ${open === 1 ? "vraag wacht" : "vragen wachten"} op jou` : "");
    for (const u of db.prepare("SELECT id FROM users WHERE active=1 AND role IN ('admin','dispatch')").all()) if (!officeOnline(u.id)) push.notify(u.id, { title: `Atlas · update ${z(n.h)}:${z(n.m)}`, body: kort, url: "/dispatch#vandaag" });
    return text;
  }

  // ---------- hoofdlus ----------
  let busy = false, lastRun = {};
  async function tick(why) {
    if (busy) return; const c = cfg(); if (!c.aan) { if (store.setting("jarvisWasOn")) store.setting("jarvisWasOn", false); return; }
    busy = true; winCache = new Map();
    // net aangezet? dan eerst de mails van de laatste 24 uur lezen, zonder dat je moet klikken
    if (!store.setting("jarvisWasOn")) { store.setting("jarvisWasOn", true); busy = false; try { await catchup(); } catch (e) { console.error("Atlas inhalen:", e.message); } return; }
    act("Ik controleer mail, planning, ritten en facturen…", { view: "vandaag" }, true);
    try {
      if (mail.configured() && ai.configured()) {
        let item; while ((item = q()[0])) { store.setting("jarvisMailQ", q().slice(1)); try { await processMail(item); } catch (e) { log("fout", `Mail "${item.subject}" verwerken lukte niet: ${e.message}`); } }
      }
      await step("planning", planning);
      if (c.waakhond) await step("waakhond", waakhond);
      await step("vervaldatums", async () => vervaldatums());
      if (c.kansen !== false) {
        await step("retourvracht", retourCheck);
        await step("links controleren", () => checkAllLinks(4));
        const n = nowParts(), lastK = store.setting("jarvisKlantenGezocht");
        for (const k of store.all("kansen").filter(k => k.soort === "klant")) store.del("kansen", k.id); // klanten zoeken staat uit
        const vz = store.setting("voertuigZoek");
        if (vz && vz.volgen && n.h >= 8 && workTime() && (!vz.laatst || Date.now() - new Date(vz.laatst).getTime() > 20 * 3600e3)) step("vrachtwagens zoeken", () => zoekVoertuigen(vz));
        const lastP = store.setting("jarvisPartnersGezocht");
        if (n.wd === "Wed" && n.h >= 9 && workTime() && (!lastP || Date.now() - new Date(lastP).getTime() > 6 * 864e5)) step("vaste opdrachtgevers zoeken", () => zoekPartners());
      }
      if (c.invoice) await step("facturen", invoices);
      if (c.reminders && workTime() && Date.now() - (lastRun.rem || 0) > 3600e3) { lastRun.rem = Date.now(); await step("herinneringen", reminders); }
      await step("opruimen", async () => opruimen());
      await step("update", () => update(false));
      prune();
    } finally { busy = false; }
  }
  async function step(name, fn) { try { await fn(); } catch (e) { console.error("Atlas " + name + ":", e); log("fout", `Atlas (${name}): ${e.message}`); } }

  // Mails van de laatste 24 uur die Atlas nog niet las alsnog laten lezen.
  async function catchup() {
    if (!mail.configured()) throw Object.assign(new Error("Mail is niet gekoppeld"), { status: 409 });
    const r = await mail.list({ box: "inbox", page: 0, size: 30 }), seen = store.setting("jarvisSeen") || [], since = Date.now() - 24 * 3600e3;
    const fresh = (r.items || []).filter(m => !seen.includes(m.uid) && !q().some(x => x.uid === m.uid) && (!m.date || new Date(m.date).getTime() > since) && !/notify\.railway|no-?reply@accounts\.google|mailer-daemon/i.test(m.from || ""));
    const keep = cfg().aan; if (!keep) throw Object.assign(new Error("Zet Atlas eerst aan"), { status: 409 });
    store.setting("jarvisMailQ", [...q(), ...fresh.map(m => ({ uid: m.uid, from: m.from, fromName: m.fromName || "", subject: m.subject || "", date: m.date, hasAtt: !!m.hasAtt }))].slice(-100));
    act(`Ik lees ${fresh.length} ${fresh.length === 1 ? "mail" : "mails"} van vandaag…`, { view: "mail" });
    setTimeout(() => tick("catchup"), 500);
    return { aantal: fresh.length };
  }

  // een vraag afhandelen vanuit de app
  async function resolve(id, action, user) {
    const j = store.get("jarvis", id); if (!j) throw Object.assign(new Error("Niet gevonden"), { status: 404 });
    if (action === "doe" && j.actie && j.actie.type === "assign") {
      const o = store.get("orders", j.actie.id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 });
      if (absentIn(j.actie.driverId, span(o)) || await conflict(j.actie.driverId, o)) throw Object.assign(new Error(driverName(j.actie.driverId) + " is intussen niet meer vrij"), { status: 409 });
      assign(o, { driverId: j.actie.driverId, vehicleId: j.actie.vehicleId }, "goedgekeurd door " + (user.name || user.email));
      log("toewijzing", `Rit ${o.ref} gegeven aan ${driverName(j.actie.driverId)} (goedgekeurd door ${user.name || user.email}).`, { ref: { col: "orders", id: o.id } });
    }
    if (action === "doe" && j.actie && j.actie.type === "retour") { const o = store.get("orders", j.actie.id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 }); await zoekRetour(o); }
    if (action === "doe" && j.actie && j.actie.type === "cancel") {
      const o = store.get("orders", j.actie.id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 });
      const upd = store.patch("orders", o.id, { status: "Geannuleerd", geannuleerd: { at: new Date().toISOString(), door: user.name || user.email } }); emit("orders", o.id, upd, o);
      if (o.chauffeurId) push.notifyDriver(o.chauffeurId, { title: `Rit ${o.ref} geannuleerd`, body: `${o.laadplaats} → ${o.losplaats} gaat niet door.`, url: "/chauffeur" });
      log("rit", `Rit ${o.ref} geannuleerd (goedgekeurd door ${user.name || user.email})${o.chauffeurId ? "; " + driverName(o.chauffeurId) + " kreeg een melding" : ""}.`, { ref: { col: "orders", id: o.id } });
    }
    if (j.actie && j.actie.key && store.get("mailinfo", j.actie.key)) { const mi = store.patch("mailinfo", j.actie.key, { dringend: false, afgehandeld: new Date().toISOString(), door: user.name || user.email }); emitOffice({ type: "mailinfo", item: mi }); }
    const d = store.patch("jarvis", id, { klaar: new Date().toISOString(), door: user.name || user.email }); emitOffice({ type: "jarvis", item: d });
    return d;
  }

  // Tools voor de chat: Atlas kan op jouw vraag ook iets doen.
  function tools(user) {
    const who = user.name || user.email;
    const findO = ref => { const r = String(ref || "").trim().toLowerCase(); return store.all("orders").find(o => [o.ref, o.referentieKlant].some(x => x && String(x).toLowerCase() === r)); };
    const findD = n => { const q = String(n || "").trim().toLowerCase(); const D = store.all("drivers"); return D.find(d => (d.naam || "").toLowerCase() === q) || D.find(d => (d.naam || "").toLowerCase().includes(q)) || D.find(d => q.includes((d.naam || "").toLowerCase().split(" ")[0])); };
    return [
      { name: "chauffeur_voorstel", description: "Stelt de beste vrije chauffeur en vrachtwagen voor een rit voor (rekening met afwezigheid, andere ritten, rijtijd en afstand). Wijzigt niets.", inputSchema: { type: "object", properties: { ref: { type: "string", description: "ritref (R-…) of referentie van de klant" } }, required: ["ref"] },
        execute: async a => { const o = findO(a.ref); if (!o) return { fout: "rit niet gevonden" }; winCache = new Map(); const p = await pickDriver(o, []); return p ? { chauffeur: driverName(p.driverId), voertuig: (store.get("vehicles", p.vehicleId) || {}).kenteken || "", waarom: p.why } : { fout: "niemand is vrij voor deze rit" }; } },
      { name: "rit_toewijzen", description: "Geeft een rit aan een chauffeur (en optioneel vrachtwagen); de chauffeur krijgt een melding in zijn app. Alleen gebruiken als de gebruiker dat uitdrukkelijk vraagt.", inputSchema: { type: "object", properties: { ref: { type: "string" }, chauffeur: { type: "string", description: "naam van de chauffeur" }, kenteken: { type: "string" } }, required: ["ref", "chauffeur"] },
        execute: async a => { const o = findO(a.ref); if (!o) return { fout: "rit niet gevonden" }; const d = findD(a.chauffeur); if (!d) return { fout: "chauffeur niet gevonden" };
          winCache = new Map(); const ab = absentIn(d.id, span(o)); if (ab) return { fout: `${d.naam} is ${ab.type.toLowerCase()}` }; const c = await conflict(d.id, o); if (c) return { fout: `${d.naam} ${c}` };
          const v = a.kenteken ? store.all("vehicles").find(v => (v.kenteken || "").replace(/\W/g, "").toLowerCase() === String(a.kenteken).replace(/\W/g, "").toLowerCase()) : null;
          assign(o, { driverId: d.id, vehicleId: v ? v.id : (o.voertuigId || d.voertuigId || "") }, "gevraagd door " + who);
          log("toewijzing", `Rit ${o.ref} gegeven aan ${d.naam} (gevraagd door ${who} in de chat).`, { ref: { col: "orders", id: o.id } });
          return { ok: true, rit: o.ref, chauffeur: d.naam, heeftApp: hasLogin(d.id) }; } },
      { name: "rit_annuleren", description: "Annuleert een rit en verwittigt de chauffeur. Alleen als de gebruiker dat uitdrukkelijk vraagt.", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
        execute: async a => { const o = findO(a.ref); if (!o) return { fout: "rit niet gevonden" }; if (!LIVE.includes(o.status)) return { fout: "rit heeft status " + o.status };
          const upd = store.patch("orders", o.id, { status: "Geannuleerd", geannuleerd: { at: new Date().toISOString(), door: who } }); emit("orders", o.id, upd, o);
          if (o.chauffeurId) push.notifyDriver(o.chauffeurId, { title: `Rit ${o.ref} geannuleerd`, body: `${o.laadplaats} → ${o.losplaats} gaat niet door.`, url: "/chauffeur" });
          log("rit", `Rit ${o.ref} geannuleerd (gevraagd door ${who} in de chat).`, { ref: { col: "orders", id: o.id } }); return { ok: true }; } },
      { name: "factuur_betaald", description: "Zet een factuur op betaald (bv. als de gebruiker zegt dat het geld binnen is).", inputSchema: { type: "object", properties: { nr: { type: "string" } }, required: ["nr"] },
        execute: async a => { const i = store.all("invoices").find(i => String(i.nr).toLowerCase() === String(a.nr).trim().toLowerCase()); if (!i) return { fout: "factuur niet gevonden" };
          const d = store.patch("invoices", i.id, { status: "Betaald", betaaldOp: todayLocal() }); emit("invoices", i.id, d, i); log("factuur", `Factuur ${i.nr} op betaald gezet (door ${who}).`, { ref: { col: "invoices", id: i.id } }); return { ok: true }; } },
      { name: "zoek_vaste_opdrachtgevers", description: "Zoekt op het internet betrouwbare logistieke bedrijven in Europa die op lange termijn met onderaannemers (vervoerders zoals wij) werken, met contact en aanmeldlink. Bewaart ze onder Kansen. Duurt ongeveer een minuut.", inputSchema: { type: "object", properties: {} },
        execute: async () => { await zoekPartners(); return { kansen: store.all("kansen").filter(k => k.soort === "partner" && k.status === "nieuw").slice(-8).map(k => ({ naam: k.naam, plaats: k.plaats, telefoon: k.telefoon, email: k.email, aanmelden: k.aanmelden, betrouwbaarheid: k.betrouwbaarheid })) }; } },
      { name: "zoek_vrachtwagens", description: "Zoekt op tweedehandssites echte advertenties van te koop staande vrachtwagens en bewaart ze onder Kansen → Vrachtwagens. type: bakwagen_schuifzeil, bakwagen_gesloten, trekker of oplegger.", inputSchema: { type: "object", properties: { type: { type: "string" }, maxPrijs: { type: "number" }, vanafJaar: { type: "number" }, maxKm: { type: "number" }, euro6: { type: "boolean" }, laadklep: { type: "boolean" }, landen: { type: "string" }, extra: { type: "string" } } },
        execute: async a => { const r = await zoekVoertuigen({ ...(store.setting("voertuigZoek") || {}), ...a }); return { gevonden: r.gevonden, voertuigen: store.all("kansen").filter(k => k.soort === "voertuig" && k.status === "nieuw").slice(-8).map(k => ({ titel: k.naam, prijs: k.prijs, bouwjaar: k.bouwjaar, km: k.km, plaats: k.plaats, link: k.website })) }; } },
      { name: "zoek_chauffeurs", description: "Zoekt op het internet uitzendkantoren, rekruteerders en vacaturesites om CE-chauffeurs te vinden, en schrijft een vacaturetekst. Bewaart alles onder Kansen → Chauffeurs. Duurt ongeveer een minuut.", inputSchema: { type: "object", properties: {} },
        execute: async () => { await zoekChauffeurs(); return { kanalen: store.all("kansen").filter(k => k.soort === "chauffeur" && k.status === "nieuw").slice(-8).map(k => ({ naam: k.naam, sector: k.sector, plaats: k.plaats, telefoon: k.telefoon, website: k.website })), vacature: (store.setting("vacatureTekst") || {}).nl || "" }; } },
      { name: "kansen", description: "Lijst van gevonden kansen: vaste opdrachtgevers die met onderaannemers werken, kanalen om chauffeurs te vinden, en retourvracht, met contactgegevens en status.", inputSchema: { type: "object", properties: { soort: { type: "string", description: "partner, chauffeur of retour" } } },
        execute: async a => store.all("kansen").filter(k => k.soort !== "klant" && (!a.soort || k.soort === a.soort)).slice(-20).map(k => ({ soort: k.soort, naam: k.naam, plaats: k.plaats, telefoon: k.telefoon, email: k.email, aanmelden: k.aanmelden || "", betrouwbaarheid: k.betrouwbaarheid || "", status: k.status, rit: k.rit || "", waarom: k.waarom })) },
      { name: "jarvis_status", description: "Wat Atlas de laatste uren deed en welke vragen nog openstaan.", inputSchema: { type: "object", properties: {} },
        execute: async () => { const all = store.all("jarvis").sort((a, b) => b.at.localeCompare(a.at)); return { modus: cfg().aan ? (cfg().proef ? "proefmodus" : "automatisch") : "uit", openVragen: all.filter(j => j.open && !j.klaar).map(j => j.tekst), recent: all.filter(j => !j.open && j.soort !== "update").slice(0, 15).map(j => j.at.slice(0, 16) + " " + j.tekst) }; } },
    ];
  }

  const timer = setInterval(() => tick("timer"), 3 * 60 * 1000);
  setTimeout(() => tick("start"), 20000);
  return { zoekVoertuigen, whenIdle: async () => { for (let i = 0; i < 300 && (busy || q().length); i++) await new Promise(r => setTimeout(r, 2000)); }, tick, onNewMail, update, resolve, offer, catchup, zoekKlanten, zoekPartners, zoekChauffeurs, zoekOnderaannemers: async id => { const o = store.get("orders", id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 }); await zoekOnderaannemers(o, "Op jouw vraag."); }, cfg, tools, note: (t, fout) => log(fout ? "fout" : "telefoon", t), DEFAULTS, kick: () => setTimeout(() => tick("kick"), 1500), stop: () => clearInterval(timer), _pickDriver: pickDriver };
};

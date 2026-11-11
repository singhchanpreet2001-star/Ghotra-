"use strict";
// Jarvis: de automatische piloot. Draait op de server, ook als niemand de app open heeft.
// Doet zelf wat in Beheer → Jarvis aan staat, en legt de rest als vraag (met één klik) aan kantoor voor.

const DEFAULTS = { aan: false, proef: true, orders: true, bevestiging: true, waakhond: true, assign: true, invoice: true, reminders: true, updateUren: 2, van: 7, tot: 19, weekend: false, herinneringNa: 3, herinneringOm: 14, maxHerinneringen: 3 };
const LIVE = ["Gepland", "Naar laadplaats", "Laden", "Naar losplaats", "Lossen"];
const ACTIVE = LIVE.slice(1);

module.exports = function createJarvis(x) {
  const { store, push, mail, ai, here, db, emit, emitOffice, notifyOrderChange, createConcept, saveFile, readFile, absOn, todayLocal, fdate, fdt, eurS, ogm, lineText, calcTotals, bedrijf, uid, pdf, ubl, TZ } = x;
  const cfg = () => ({ ...DEFAULTS, ...(store.get("config", "jarvis") || {}) });
  const z = n => String(n).padStart(2, "0");
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); };
  const dateOf = s => String(s || "").slice(0, 10);
  const nowParts = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map(a => [a.type, a.value])); return { h: +p.hour % 24, m: +p.minute, wd: p.weekday }; };
  const workTime = () => { const c = cfg(), n = nowParts(); if (!c.weekend && (n.wd === "Sat" || n.wd === "Sun")) return false; return n.h >= c.van && n.h < c.tot; };
  const driverName = id => (store.get("drivers", id) || {}).naam || "?";
  const hasLogin = did => !!db.prepare("SELECT 1 FROM users WHERE role='driver' AND active=1 AND driverId=?").get(did);

  // ---------- logboek ----------
  function log(soort, tekst, extra = {}) {
    const id = uid(), item = { at: new Date().toISOString(), soort, tekst, ...extra };
    store.put("jarvis", id, item); emitOffice({ type: "jarvis", item: { ...item, id } });
    if (extra.open && (workTime() || /^🔴/.test(tekst) || extra.altijd)) push.notifyRole(["admin", "dispatch"], { title: /^🔴/.test(tekst) ? "🔴 Dringende mail" : "Jarvis vraagt je iets", body: tekst.replace(/^🔴\s*/, "").slice(0, 180), url: "/dispatch#jarvis" });
    return id;
  }
  const hasOpen = key => store.all("jarvis").some(j => j.open && !j.klaar && j.key === key);
  // Niet opnieuw vragen wat al open staat, of wat jij net zelf op "Klaar" zette.
  function ask(key, tekst, actie, opt = {}) {
    const rust = /^(verval|lucy|mail|wijz)-/.test(key) ? 3650 * 864e5 : 24 * 3600e3;
    if (store.all("jarvis").some(j => j.key === key && j.open && (!j.klaar || (j.note !== "opgelost" && Date.now() - new Date(j.klaar).getTime() < rust)))) return;
    log("vraag", tekst, { open: true, key, actie: actie || null, ...opt });
  }
  function closeKey(key, note) { for (const j of store.all("jarvis").filter(j => j.open && !j.klaar && j.key === key)) { const d = store.patch("jarvis", j.id, { klaar: new Date().toISOString(), door: "Jarvis", note: note || "opgelost" }); emitOffice({ type: "jarvis", item: d }); } }
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
    const me = String(mail.config().user || "").toLowerCase();
    const add = items.filter(m => m.from !== me).map(m => ({ uid: m.uid, from: m.from, fromName: m.fromName || "", subject: m.subject || "", date: m.date || new Date().toISOString(), hasAtt: !!m.hasAtt }));
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
  const mailAct = uidN => ({ type: "mail", key: "inbox-" + uidN, label: "Mail openen" });
  async function processMail(item) {
    const seen = store.setting("jarvisSeen") || [];
    if (seen.includes(item.uid)) return;
    store.setting("jarvisSeen", [...seen, item.uid].slice(-1000));
    const c = cfg(), m = await mail.getMessage("inbox", item.uid), who = m.fromName || m.from;
    // 1. sorteren: wat is het en is het dringend?
    const t = await ai.triageMail({ from: m.from, fromName: m.fromName, subject: m.subject, text: m.text, attachments: m.attachments.map(a => a.name), company: bedrijf().naam || "Ghotra Transport", today: todayLocal(), klanten: store.all("customers").map(k => k.naam) });
    const info = store.put("mailinfo", "inbox-" + item.uid, { uid: item.uid, box: "inbox", from: m.from, fromName: m.fromName || "", subject: m.subject || "", date: m.date || item.date, hasAtt: m.attachments.length > 0, ...t, at: new Date().toISOString() });
    emitOffice({ type: "mailinfo", item: { ...info, id: "inbox-" + item.uid } });
    if (t.soort === "ritwijziging") {
      const o = findOrderFor(t, m);
      const wat = o ? `rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}${o.chauffeurId ? ", " + driverName(o.chauffeurId) : ""})` : "een rit" + (t.ref ? " (" + t.ref + ")" : "");
      const tekst = `${t.dringend ? "🔴 " : ""}${who} ${t.annulering ? "annuleert" : "wijzigt"} ${wat}: ${String(t.samenvatting || m.subject || "").replace(/\.?\s*$/, ".")}`;
      if (o && t.annulering && LIVE.includes(o.status)) ask("mail-" + item.uid, tekst, { type: "cancel", id: o.id, key: "inbox-" + item.uid, label: "Annuleer rit " + o.ref });
      else ask("mail-" + item.uid, tekst + (o ? " Pas de rit aan in de app." : ""), o ? { type: "order", id: o.id, key: "inbox-" + item.uid } : mailAct(item.uid));
    } else if (t.dringend) ask("mail-" + item.uid, `🔴 Dringende mail van ${who}: ${t.samenvatting || m.subject}${t.reden ? " (" + t.reden + ")" : ""}`, mailAct(item.uid));
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
      let k = k0;
      if (!k && r.klantNaam) { const kid = uid(); k = store.put("customers", kid, { naam: r.klantNaam, email: r.klantEmail || m.from || "", btw: r.klantBtw || "", adres: r.klantAdres || "", termijn: 30, jarvis: true }); emit("customers", kid, k, null); log("klant", `Nieuwe klant aangemaakt: ${k.naam}.`, { ref: { col: "customers", id: kid } }); }
      const id = uid();
      const o = store.put("orders", id, { ref: nextRef(), status: "Gepland", klantId: k ? k.id : "", laadplaats: r.laadplaats || "", laadadres: r.laadadres || "", laaddatum: String(r.laaddatum || "").slice(0, 16), losplaats: r.losplaats || "", losadres: r.losadres || "", losdatum: String(r.losdatum || "").slice(0, 16),
        goederen: r.goederen || "", colli: r.colli ?? "", gewicht: r.gewicht ?? "", adr: r.adr ? "ja" : "", prijs: r.prijs ?? "", wachtTarief: r.wachtTarief ?? "", vrijeUren: r.vrijeUren ?? "", referentieKlant: r.referentieKlant || "", notities: r.notities || "",
        ...(f ? { opdrachtPdf: { id: f.id, name: att.name } } : {}), bron: m.subject || (a ? a.name : "mail"), from: m.from, aangemaakt: new Date().toISOString(), jarvis: { uitMail: true, mail: "inbox-" + item.uid } });
      emit("orders", id, o, null); made++;
      const ml = store.put("maillog", uid(), { threadId: "inbox-" + item.uid, orderId: id, subject: m.subject || "", to: "", date: new Date().toISOString(), kind: "in", from: m.from }); emit("maillog", ml.id, ml, null);
      log("rit", `Nieuwe rit ${o.ref} uit ${a ? "de PDF" : "de mail"} van ${who}: ${o.laadplaats} → ${o.losplaats}, laden ${fdt(o.laaddatum)}${o.prijs !== "" ? ", " + eurS(o.prijs) : ""}.`, { ref: { col: "orders", id } });
      if (o.prijs === "" || o.prijs == null) ask("prijs-" + id, `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}) heeft geen prijs in de order. Vul de prijs in, anders kan ik niet factureren.`, { type: "order", id });
    }
    if (made && c.bevestiging && !c.proef && mail.configured()) {
      const mine = store.all("orders").filter(o => o.jarvis && o.jarvis.mail === "inbox-" + item.uid), b = bedrijf();
      const lines = mine.map(o => `• ${o.referentieKlant ? "Uw ref. " + o.referentieKlant + " – " : ""}onze ref. ${o.ref}: laden ${o.laadplaats} ${fdt(o.laaddatum)}, lossen ${o.losplaats}${o.losdatum ? " " + fdt(o.losdatum) : ""}${o.prijs !== "" && o.prijs != null ? ", " + eurS(o.prijs) + " excl. btw" : ""}`).join("\n");
      const body = `Goedendag,\n\nBedankt voor uw opdracht. Wij bevestigen:\n\n${lines}\n\nWij laten het weten zodra de zending geleverd is.\n\nMet vriendelijke groeten,\n${b.naam || "Ghotra Transport"}${b.tel ? "\n" + b.tel : ""}`;
      try { await mail.send({ to: [m.from], cc: [], subject: /^re:/i.test(m.subject || "") ? m.subject : "Re: " + (m.subject || "Uw opdracht"), text: body, attachments: [], inReplyTo: m.messageId || "", references: ((m.references || "") + " " + (m.messageId || "")).trim() }); log("rit", `Bevestiging gestuurd naar ${who} voor ${mine.map(o => o.ref).join(", ")}.`); }
      catch (e) { log("fout", `Bevestiging naar ${who} versturen lukte niet: ${e.message}`); }
    }
    if (made) { const p = store.get("mailinfo", "inbox-" + item.uid); const d = store.patch("mailinfo", "inbox-" + item.uid, { ritten: made }); emitOffice({ type: "mailinfo", item: d }); }
  }

  // ---------- 2 + 3. toewijzen en ziekte opvangen ----------
  async function planning() {
    const c = cfg(), auto = c.assign && !c.proef, today = todayLocal(), horizon = addDays(today, 3);
    for (const o of store.all("orders").filter(o => o.status === "Gepland")) {
      const f = dateOf(o.laaddatum); if (!f || f < today) continue;
      // ziek of afwezig → overdragen
      if (o.chauffeurId) {
        const a = absentIn(o.chauffeurId, span(o)); if (!a) continue;
        const was = driverName(o.chauffeurId), pick = await pickDriver(o, [o.chauffeurId]);
        if (pick && auto) { assign(o, pick, `${was} is ${a.type.toLowerCase()}`); log("ziek", `${was} is ${a.type.toLowerCase()}: rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) gaat nu naar ${driverName(pick.driverId)} (${pick.why}).`, { ref: { col: "orders", id: o.id } }); closeKey("ziek-" + o.id); }
        else if (pick) ask("ziek-" + o.id, `${was} is ${a.type.toLowerCase()} maar heeft rit ${o.ref} (${fdt(o.laaddatum)}). Voorstel: ${driverName(pick.driverId)} (${pick.why}).`, { type: "assign", id: o.id, driverId: pick.driverId, vehicleId: pick.vehicleId, label: "Geef aan " + driverName(pick.driverId) });
        else ask("ziek-" + o.id, `${was} is ${a.type.toLowerCase()} maar heeft rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}). Er is geen andere chauffeur vrij. Zoek een oplossing of een onderaannemer.`, { type: "order", id: o.id });
        continue;
      }
      if (f > horizon) continue;
      const pick = await pickDriver(o);
      const ver = pick && pick.dist != null && pick.dist > 300;
      if (pick && auto && !ver) { assign(o, pick, pick.why); log("toewijzing", `Rit ${o.ref} (${o.laadplaats} → ${o.losplaats}, ${fdt(o.laaddatum)}) gegeven aan ${driverName(pick.driverId)}${pick.vehicleId ? " met " + ((store.get("vehicles", pick.vehicleId) || {}).kenteken || "") : ""}: ${pick.why}.`, { ref: { col: "orders", id: o.id } }); closeKey("plan-" + o.id); }
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
  async function invoices() { const c = cfg(); for (const i of store.all("invoices").filter(i => i.status === "Concept")) await invoiceOne(i, c.proef); }
  async function invoiceOne(i, dry) {
    const today = todayLocal();
    {
      const { k, lines, b } = invoiceParts(i), chk = i.cmrCheck;
      if (!chk) { if (Date.now() - new Date(i.aangemaakt || 0).getTime() > 3600e3) ask("inv-" + i.id, `Conceptfactuur ${i.nr} voor ${k.naam || "?"} wacht op jou: de CMR kon niet automatisch gecontroleerd worden.`, { type: "invoice", id: i.id }); return; }
      if (chk.conclusie !== "ok") { ask("inv-" + i.id, `CMR bij factuur ${i.nr} (${k.naam || "?"}) nakijken: ${chk.samenvatting || chk.verschillen || chk.voorbehoud || "niet in orde"}.`, { type: "invoice", id: i.id }); return; }
      if (!lines.length || lines.some(l => !(+l.bedrag > 0) && l.soort !== "wacht")) { ask("inv-" + i.id, `Factuur ${i.nr} (${k.naam || "?"}) heeft een lijn zonder bedrag. Vul de prijs aan.`, { type: "invoice", id: i.id }); return; }
      const be = ubl.isBE(k);
      const datum = today, verval = addDays(today, +i.termijn || +k.termijn || 30);
      const tot = calcTotals(lines, i.btw), fin = { ...i, lines, datum, vervaldatum: verval, ...tot };
      if (be) {
        const pr = ubl.problems(b, k); if (pr.length) { ask("inv-" + i.id, `E-factuur ${i.nr} (${k.naam}) kan ik nog niet maken. Vul eerst aan: ${pr.join(", ")}.`, { type: "invoice", id: i.id }); return; }
        if (dry) { ask("inv-" + i.id, `Proefmodus: CMR van ${i.nr} is in orde. Ik zou factuur ${i.nr} voor ${k.naam} (${eurS(tot.totaal)}) goedkeuren en het e-factuurbestand voor Lucy maken.`, { type: "sendinv", id: i.id, label: "Doe maar" }); return; }
        const atts = [{ id: i.nr, description: "Factuur " + i.nr, filename: `Factuur-${i.nr}.pdf`, mime: "application/pdf", bytes: pdfOf(fin) },
          ...cmrAtts(i).filter(x => x.f.buf.length < 4e6).map(({ o, f }) => ({ id: "CMR-" + o.ref, description: "Ondertekende CMR rit " + o.ref, filename: `CMR-${o.ref}${f.meta.type === "application/pdf" ? ".pdf" : ".jpg"}`, mime: f.meta.type === "application/pdf" ? "application/pdf" : "image/jpeg", bytes: f.buf }))];
        const refs = [...new Set((i.orderIds || []).map(id => (store.get("orders", id) || {}).referentieKlant).filter(Boolean))];
        const xml = ubl.xml(fin, { bedrijf: b, klant: k, lines, totals: tot, ogm: ogm(i.nr), refs, atts });
        const xf = saveFile(Buffer.from(xml, "utf-8"), `Factuur-${i.nr}.xml`, "application/xml", "jarvis");
        finalize(i, { lines, datum, vervaldatum: verval, ...tot, peppol: { gemaakt: new Date().toISOString(), fileId: xf.id } });
        log("factuur", `Factuur ${i.nr} voor ${k.naam} (${eurS(tot.totaal)}) goedgekeurd. Belgische klant: het e-factuurbestand staat klaar voor Lucy.`, { ref: { col: "invoices", id: i.id } });
        ask("lucy-" + i.id, `Lever e-factuur ${i.nr} (${k.naam}, ${eurS(tot.totaal)}) aan in Lucy om ze via Peppol te versturen.`, { type: "download", fileId: xf.id, name: `Factuur-${i.nr}.xml`, id: i.id, label: "Download voor Lucy" });
        closeKey("inv-" + i.id);
      } else {
        const to = String(i.aan || k.emailFactuur || k.email || "").split(/[,;\s]+/).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        if (!to.length) { ask("inv-" + i.id, `Factuur ${i.nr} (${k.naam || "?"}) is klaar, maar de klant heeft geen mailadres. Vul het in en verstuur.`, { type: "invoice", id: i.id }); return; }
        if (!mail.configured()) { ask("inv-" + i.id, `Factuur ${i.nr} is klaar, maar mail is niet ingesteld.`, { type: "invoice", id: i.id }); return; }
        if (dry) { ask("inv-" + i.id, `Proefmodus: CMR van ${i.nr} is in orde. Ik zou factuur ${i.nr} (${eurS(tot.totaal)}) met CMR mailen naar ${k.naam} (${to.join(", ")}).`, { type: "sendinv", id: i.id, label: "Verstuur" }); return; }
        const sig = `\n\nMet vriendelijke groeten,\n${b.naam || "Ghotra Transport"}${b.tel ? "\n" + b.tel : ""}`;
        const subject = `Factuur ${i.nr} – ${b.naam || "Ghotra Transport"}`;
        const body = `Beste${k.contact ? " " + k.contact : ""},\n\nIn bijlage vindt u factuur ${i.nr} van ${fdate(datum)} voor ${eurS(tot.totaal)}${cmrAtts(i).length ? ", met de ondertekende CMR" : ""}.\nGelieve te betalen vóór ${fdate(verval)}${b.iban ? " op " + b.iban : ""} met mededeling ${ogm(i.nr)}.` + sig;
        const attachments = [{ filename: `Factuur-${i.nr}.pdf`, mime: "application/pdf", bytes: pdfOf(fin) }, ...cmrAtts(i).map(({ o, f }) => ({ filename: `CMR-${o.ref}${f.meta.type === "application/pdf" ? ".pdf" : ".jpg"}`, mime: f.meta.type, bytes: f.buf }))];
        try { await mail.send({ to, cc: [], subject, text: body, attachments }); }
        catch (e) { ask("inv-" + i.id, `Factuur ${i.nr} versturen lukte niet: ${e.message}`, { type: "invoice", id: i.id }); return; }
        finalize(i, { lines, datum, vervaldatum: verval, ...tot, verstuurd: new Date().toISOString(), aan: to.join(", ") });
        store.put("maillog", uid(), { threadId: "", orderId: (i.orderIds || [])[0] || "", invoiceId: i.id, subject, to: to.join(", "), date: new Date().toISOString(), kind: "sent" });
        log("factuur", `Factuur ${i.nr} (${eurS(tot.totaal)}) met CMR verstuurd naar ${k.naam} (${to.join(", ")}).`, { ref: { col: "invoices", id: i.id } });
        closeKey("inv-" + i.id);
      }
    }
  }
  function finalize(i, upd) {
    const prev = store.get("invoices", i.id), d = store.patch("invoices", i.id, { ...upd, status: "Open", jarvis: { goedgekeurd: new Date().toISOString() } }); emit("invoices", i.id, d, prev);
    for (const oid of i.orderIds || []) { const p = store.get("orders", oid); if (p) emit("orders", oid, store.patch("orders", oid, { status: "Gefactureerd", factuurId: i.id }), p); }
  }

  // ---------- 5. betalingsherinneringen ----------
  async function reminders() { const c = cfg(); if (!mail.configured()) return; for (const i of store.all("invoices").filter(i => i.status === "Open" && i.vervaldatum && i.vervaldatum < todayLocal())) await remindOne(i, c.proef, false); }
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
      if (dry) { ask("rem-" + i.id + "-" + h.length, `Proefmodus: factuur ${i.nr} van ${k.naam} (${eurS(i.totaal)}) is ${Math.round((new Date(today) - new Date(i.vervaldatum)) / 864e5)} dagen te laat. Ik zou een ${h.length ? (h.length + 1) + "e " : ""}herinnering mailen naar ${to.join(", ")}.`, { type: "remind", id: i.id, label: "Verstuur herinnering" }); return; }
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
      else if (/^(betaal|lucy)-/.test(k)) { const i = store.get("invoices", id); done = !i || i.status === "Betaald"; }
      else if (/^rem-/.test(k)) { done = !I || I.status !== "Open"; }
      else if (/^waak-gezien-/.test(k)) done = !O || !!O.gezien || O.status !== "Gepland";
      else if (/^waak-start-/.test(k)) done = !O || O.status !== "Gepland";
      else if (/^waak-cmr-/.test(k)) done = !O || !!O.cmr;
      else if (/^verval-/.test(k)) { const r = store.get(a.col, a.id); done = !r || r[a.field] !== a.date; }
      else if (/^mail-/.test(k) && a.key && /^🔴/.test(j.tekst)) { const mi = store.get("mailinfo", a.key); done = !!(mi && mi.afgehandeld); if (a.type === "cancel" && O && O.status === "Geannuleerd") done = true; }
      else if (a.type === "cancel") done = !O || O.status === "Geannuleerd";
      if (done) { const d = store.patch("jarvis", j.id, { klaar: new Date().toISOString(), door: "Jarvis", note: "opgelost" }); emitOffice({ type: "jarvis", item: d }); }
    }
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
      try { text = (await ai.write({ system: "Je bent Jarvis, de assistent van transportbedrijf " + (bedrijf().naam || "Ghotra Transport") + ". Je schrijft een korte update voor de zaakvoerder in eenvoudig Vlaams-Nederlands. Geen inleiding, geen afsluiter. Eerst wat je zelf geregeld hebt, dan wat hij moet doen (alleen als er open vragen zijn), dan de stand van zaken. Maximaal 8 korte regels, elke regel begint met een passend emoji.", prompt: "Gegevens (JSON):\n" + JSON.stringify(F) })).trim(); } catch (e) { text = ""; }
    }
    if (!text) text = [F.gedaan.length ? `✅ Geregeld: ${F.gedaan.length} ${F.gedaan.length === 1 ? "ding" : "dingen"}` : "✅ Niets nieuws te regelen", F.openVragen.length ? `❓ ${F.openVragen.length} vraag/vragen voor jou` : "", F.bezig.length ? `🚛 Onderweg: ${F.bezig.length}` : "", F.gelost.length ? `📦 Gelost: ${F.gelost.join(", ")}` : "", F.teLaatBetaald.aantal ? `💶 Te laat betaald: ${F.teLaatBetaald.aantal} (${eurS(F.teLaatBetaald.bedrag)})` : "", F.afwezigVandaag.length ? `🤒 Afwezig: ${F.afwezigVandaag.join(", ")}` : ""].filter(Boolean).join("\n");
    store.setting("jarvisUpdate", { last: new Date().toISOString() });
    const n = nowParts();
    log("update", text, { titel: `Update van ${z(n.h)}:${z(n.m)}` });
    push.notifyRole(["admin", "dispatch"], { title: `Jarvis · update ${z(n.h)}:${z(n.m)}`, body: text.split("\n").slice(0, 4).join("\n"), url: "/dispatch#jarvis" });
    return text;
  }

  // ---------- hoofdlus ----------
  let busy = false, lastRun = {};
  async function tick(why) {
    if (busy) return; const c = cfg(); if (!c.aan) return;
    busy = true; winCache = new Map();
    try {
      if (mail.configured() && ai.configured()) {
        let item; while ((item = q()[0])) { store.setting("jarvisMailQ", q().slice(1)); try { await processMail(item); } catch (e) { log("fout", `Mail "${item.subject}" verwerken lukte niet: ${e.message}`); } }
      }
      await step("planning", planning);
      if (c.waakhond) await step("waakhond", waakhond);
      await step("vervaldatums", async () => vervaldatums());
      if (c.invoice) await step("facturen", invoices);
      if (c.reminders && workTime() && Date.now() - (lastRun.rem || 0) > 3600e3) { lastRun.rem = Date.now(); await step("herinneringen", reminders); }
      await step("opruimen", async () => opruimen());
      await step("update", () => update(false));
      prune();
    } finally { busy = false; }
  }
  async function step(name, fn) { try { await fn(); } catch (e) { console.error("Jarvis " + name + ":", e); log("fout", `Jarvis (${name}): ${e.message}`); } }

  // een vraag afhandelen vanuit de app
  async function resolve(id, action, user) {
    const j = store.get("jarvis", id); if (!j) throw Object.assign(new Error("Niet gevonden"), { status: 404 });
    if (action === "doe" && j.actie && j.actie.type === "assign") {
      const o = store.get("orders", j.actie.id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 });
      if (absentIn(j.actie.driverId, span(o)) || await conflict(j.actie.driverId, o)) throw Object.assign(new Error(driverName(j.actie.driverId) + " is intussen niet meer vrij"), { status: 409 });
      assign(o, { driverId: j.actie.driverId, vehicleId: j.actie.vehicleId }, "goedgekeurd door " + (user.name || user.email));
      log("toewijzing", `Rit ${o.ref} gegeven aan ${driverName(j.actie.driverId)} (goedgekeurd door ${user.name || user.email}).`, { ref: { col: "orders", id: o.id } });
    }
    if (action === "doe" && j.actie && j.actie.type === "cancel") {
      const o = store.get("orders", j.actie.id); if (!o) throw Object.assign(new Error("Rit niet gevonden"), { status: 404 });
      const upd = store.patch("orders", o.id, { status: "Geannuleerd", geannuleerd: { at: new Date().toISOString(), door: user.name || user.email } }); emit("orders", o.id, upd, o);
      if (o.chauffeurId) push.notifyDriver(o.chauffeurId, { title: `Rit ${o.ref} geannuleerd`, body: `${o.laadplaats} → ${o.losplaats} gaat niet door.`, url: "/chauffeur" });
      log("rit", `Rit ${o.ref} geannuleerd (goedgekeurd door ${user.name || user.email})${o.chauffeurId ? "; " + driverName(o.chauffeurId) + " kreeg een melding" : ""}.`, { ref: { col: "orders", id: o.id } });
    }
    if (action === "doe" && j.actie && j.actie.type === "sendinv") { const i = store.get("invoices", j.actie.id); if (!i || i.status !== "Concept") throw Object.assign(new Error("Deze factuur is al afgehandeld"), { status: 409 }); closeKey("inv-" + i.id); await invoiceOne(i, false); }
    if (action === "doe" && j.actie && j.actie.type === "remind") { const i = store.get("invoices", j.actie.id); if (!i || i.status !== "Open") throw Object.assign(new Error("Deze factuur staat niet meer open"), { status: 409 }); await remindOne(i, false, true); }
    if (j.actie && j.actie.key && store.get("mailinfo", j.actie.key)) { const mi = store.patch("mailinfo", j.actie.key, { dringend: false, afgehandeld: new Date().toISOString(), door: user.name || user.email }); emitOffice({ type: "mailinfo", item: mi }); }
    const d = store.patch("jarvis", id, { klaar: new Date().toISOString(), door: user.name || user.email }); emitOffice({ type: "jarvis", item: d });
    return d;
  }

  // Tools voor de chat: Jarvis kan op jouw vraag ook iets doen.
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
      { name: "jarvis_status", description: "Wat Jarvis de laatste uren deed en welke vragen nog openstaan.", inputSchema: { type: "object", properties: {} },
        execute: async () => { const all = store.all("jarvis").sort((a, b) => b.at.localeCompare(a.at)); return { modus: cfg().aan ? (cfg().proef ? "proefmodus" : "automatisch") : "uit", openVragen: all.filter(j => j.open && !j.klaar).map(j => j.tekst), recent: all.filter(j => !j.open && j.soort !== "update").slice(0, 15).map(j => j.at.slice(0, 16) + " " + j.tekst) }; } },
    ];
  }

  const timer = setInterval(() => tick("timer"), 3 * 60 * 1000);
  setTimeout(() => tick("start"), 20000);
  return { tick, onNewMail, update, resolve, cfg, tools, DEFAULTS, kick: () => setTimeout(() => tick("kick"), 1500), stop: () => clearInterval(timer), _pickDriver: pickDriver };
};

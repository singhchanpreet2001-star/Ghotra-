"use strict";
// Ghotra Transport — server voor de dispatch (kantoor) en de chauffeursapp.
// Geen externe pakketten nodig: alleen Node.js 22.13 of nieuwer.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/db");
const auth = require("./lib/auth");
const mail = require("./lib/mail");
const ai = require("./lib/ai");
const push = require("./lib/push");
const here = require("./lib/here");

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const { db, FILE_DIR, COLS, uid } = store;

// ---------- eerste beheerder ----------
if (auth.userCount() === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  try { auth.createUser({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || "Beheerder", role: "admin", password: process.env.ADMIN_PASSWORD }); console.log("Beheerder aangemaakt:", process.env.ADMIN_EMAIL); }
  catch (e) { console.error("Kon beheerder niet aanmaken:", e.message); }
}

// ---------- hulpfuncties ----------
const FLOW = ["Gepland", "Naar laadplaats", "Laden", "Naar losplaats", "Lossen", "Gelost"];
const ACTIVE = ["Naar laadplaats", "Laden", "Naar losplaats", "Lossen"];
const z = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
const TZ = process.env.TZ_NAME || "Europe/Brussels";
const todayLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
const fdate = s => s ? new Date(String(s).length > 10 ? s : s + "T12:00:00").toLocaleDateString("nl-BE", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "—";
const fdt = s => s ? new Date(s).toLocaleString("nl-BE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const r2 = n => Math.round((+n || 0) * 100) / 100;
function ogm(nr) { const d = String(nr).replace(/\D/g, "").slice(-10).padStart(10, "0"); let c = Number(BigInt(d) % 97n); if (c === 0) c = 97; const s = d + z(c); return "+++" + s.slice(0, 3) + "/" + s.slice(3, 7) + "/" + s.slice(7) + "+++"; }
function nextInvNr() { const y = new Date().getFullYear(), p = "F" + y + "-"; const n = store.all("invoices").filter(i => (i.nr || "").startsWith(p)).map(i => +i.nr.slice(p.length) || 0); return p + String((n.length ? Math.max(...n) : 0) + 1).padStart(4, "0"); }
const lineText = o => `Transport ${o.laadplaats || "?"} → ${o.losplaats || "?"} · rit ${o.ref}${o.referentieKlant ? " · uw ref. " + o.referentieKlant : ""} · geladen ${fdate(String(o.laaddatum || "").slice(0, 10))}`;
const calcTotals = (lines, btw) => { const sub = r2(lines.reduce((s, l) => s + (+l.bedrag || 0), 0)), b = r2(sub * (btw === "21" ? 0.21 : 0)); return { subtotaal: sub, btwBedrag: b, totaal: r2(sub + b) }; };
const bedrijf = () => store.get("config", "bedrijf") || {};

// Wachttijd: tijd ter plaatse boven de vrije tijd, per laad- en losplaats.
const numOrNull = v => (v === "" || v == null || isNaN(+v)) ? null : +v;
const fmin = m => { m = Math.round(m); const h = Math.floor(m / 60), mm = m % 60; return h && mm ? `${h} u ${z(mm)}` : h ? `${h} u` : `${mm} min`; };
const eurS = n => new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(+n || 0);
function waitLines(o) {
  const c = store.get("config", "facturatie") || {}; if (c.aan === "nee") return [];
  const vrij = numOrNull(o.vrijeUren) ?? numOrNull(c.vrijeUren) ?? 2, tarief = numOrNull(o.wachtTarief) ?? numOrNull(c.uurTarief), afr = numOrNull(c.afronding) || 15;
  if (!tarief) return [];
  const t = o.tijden || {};
  return [["Laden", t.Laden, t["Naar losplaats"], o.laadplaats], ["Lossen", t.Lossen, t.Gelost, o.losplaats]].map(([n, a, b, pl]) => {
    if (!a || !b) return null; const mins = (new Date(b) - new Date(a)) / 60000; const over = Math.max(0, mins - vrij * 60); if (!(over > 0)) return null;
    const extra = Math.ceil(over / afr) * afr, bedrag = r2(extra / 60 * tarief);
    return { orderId: o.id, soort: "wacht", omschrijving: `Wachttijd ${n.toLowerCase()} ${pl} · rit ${o.ref}: ${fmin(mins)} ter plaatse, ${fmin(vrij * 60)} vrij → ${fmin(extra)} × ${eurS(tarief)}/u`, bedrag };
  }).filter(Boolean);
}

function createConcept(klantId, orderIds, cmrCheck) {
  const k = store.get("customers", klantId) || {};
  const os = orderIds.map(id => store.get("orders", id)).filter(Boolean);
  const lines = os.flatMap(o => [{ orderId: o.id, omschrijving: lineText(o), bedrag: +o.prijs || 0 }, ...waitLines(o)]);
  const btw = /^BE/i.test(k.btw || "") || !k.btw ? "21" : "0v";
  const datum = todayLocal(), termijn = +k.termijn || 30, nr = nextInvNr(), id = uid();
  const inv = { nr, klantId, orderIds: os.map(o => o.id), lines, datum, termijn, vervaldatum: addDays(datum, termijn), btw, ...calcTotals(lines, btw), status: "Concept", ogm: ogm(nr), aangemaakt: new Date().toISOString(), ...(cmrCheck ? { cmrCheck } : {}) };
  emit("invoices", id, store.put("invoices", id, inv), null);
  for (const o of os) { const prev = store.get("orders", o.id); emit("orders", o.id, store.patch("orders", o.id, { factuurId: id }), prev); }
  return id;
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function sse(res, obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} }
function driverVisible(o, driverId) {
  if (!o || o.chauffeurId !== driverId || o.status === "Geannuleerd") return false;
  if (["Gelost", "Gefactureerd"].includes(o.status)) { const t = (o.tijden || {}).Gelost || (o.cmr || {}).at; if (t && Date.now() - new Date(t).getTime() > 3 * 864e5) return false; }
  return true;
}
function driverOrder(o) {
  const v = o.voertuigId ? store.get("vehicles", o.voertuigId) : null, k = o.klantId ? store.get("customers", o.klantId) : null;
  const pick = ["id", "ref", "status", "laadplaats", "laadadres", "laaddatum", "losplaats", "losadres", "losdatum", "goederen", "colli", "gewicht", "adr", "notities", "referentieKlant", "tijden", "gezien"];
  const out = {}; pick.forEach(f => { if (o[f] !== undefined) out[f] = o[f]; });
  out.klantNaam = k ? k.naam : "";
  out.voertuig = v ? { kenteken: v.kenteken, type: v.type, hoogte: v.hoogte, breedte: v.breedte, lengte: v.lengte, massa: v.massa } : null;
  out.cmr = o.cmr ? { id: o.cmr.id, name: o.cmr.name, type: o.cmr.type, at: o.cmr.at } : null;
  out.opdrachtPdf = o.opdrachtPdf ? { id: o.opdrachtPdf.id, name: o.opdrachtPdf.name } : null;
  return out;
}
function emit(col, id, doc, prev) {
  for (const c of clients) {
    if (auth.isOffice(c.user)) sse(c.res, { type: "rec", col, id, doc: doc || null });
    else if (c.user.role === "driver" && col === "orders") {
      const d = c.user.driverId;
      if ((doc && doc.chauffeurId === d) || (prev && prev.chauffeurId === d)) sse(c.res, { type: "order", id, order: driverVisible(doc, d) ? driverOrder(doc) : null });
    }
  }
}
function emitOffice(obj) { for (const c of clients) if (auth.isOffice(c.user)) sse(c.res, obj); }
setInterval(() => { for (const c of clients) { try { c.res.write(": ping\n\n"); } catch {} } }, 25000);

// Pushmelding naar de chauffeur bij toewijzen, wegnemen of wijzigen van een rit.
function notifyOrderChange(o, prev) {
  if (!o && prev && prev.chauffeurId) return push.notifyDriver(prev.chauffeurId, { title: `Rit ${prev.ref} geannuleerd`, body: `${prev.laadplaats} → ${prev.losplaats} staat niet meer op je lijst.`, url: "/chauffeur" });
  if (!o) return;
  const when = fdt(o.laaddatum);
  if (o.chauffeurId && (!prev || prev.chauffeurId !== o.chauffeurId)) push.notifyDriver(o.chauffeurId, { title: `Nieuwe rit ${o.ref}`, body: `${o.laadplaats} → ${o.losplaats} · laden ${when}`, url: "/chauffeur#rit-" + o.id });
  if (prev && prev.chauffeurId && prev.chauffeurId !== o.chauffeurId) push.notifyDriver(prev.chauffeurId, { title: `Rit ${prev.ref} is aan iemand anders gegeven`, body: `${prev.laadplaats} → ${prev.losplaats}`, url: "/chauffeur" });
  if (prev && o.chauffeurId && prev.chauffeurId === o.chauffeurId && ["laaddatum", "laadadres", "laadplaats", "losdatum", "losadres", "losplaats", "notities"].some(f => (prev[f] || "") !== (o[f] || "")) && !["Gelost", "Gefactureerd"].includes(o.status))
    push.notifyDriver(o.chauffeurId, { title: `Rit ${o.ref} gewijzigd`, body: `${o.laadplaats} → ${o.losplaats} · laden ${when}`, url: "/chauffeur#rit-" + o.id });
}

// ---------- bestanden ----------
function saveFile(buf, name, type, owner) {
  const id = uid();
  fs.writeFileSync(path.join(FILE_DIR, id), buf);
  db.prepare("INSERT INTO files(id,name,type,size,created,owner) VALUES(?,?,?,?,?,?)").run(id, String(name || "bestand").slice(0, 200), type || "application/octet-stream", buf.length, Date.now(), owner || "");
  return { id, name, type, size: buf.length };
}
function readFile(id) {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  const meta = db.prepare("SELECT * FROM files WHERE id=?").get(id); if (!meta) return null;
  const p = path.join(FILE_DIR, id); if (!fs.existsSync(p)) return null;
  return { meta, buf: fs.readFileSync(p) };
}
function deleteFile(id) { if (!/^[a-z0-9]+$/i.test(id)) return; db.prepare("DELETE FROM files WHERE id=?").run(id); try { fs.unlinkSync(path.join(FILE_DIR, id)); } catch {} }
function driverMayRead(user, fileId) {
  return store.all("orders").some(o => o.chauffeurId === user.driverId && ((o.cmr && o.cmr.id === fileId) || (o.opdrachtPdf && o.opdrachtPdf.id === fileId)));
}

// ---------- CMR verwerken: opslaan, controleren, conceptfactuur ----------
async function processCmr(orderId, buf, type, name, byUser, wait) {
  const o = store.get("orders", orderId); if (!o) throw httpErr(404, "Rit niet gevonden");
  const f = saveFile(buf, name, type, byUser.id);
  const now = new Date().toISOString();
  const prev = o;
  const upd = store.patch("orders", orderId, { cmr: { id: f.id, name: f.name, type: f.type, size: f.size, at: now, door: byUser.name || byUser.email }, status: o.status === "Gefactureerd" ? "Gefactureerd" : "Gelost", tijden: { Gelost: (o.tijden || {}).Gelost || now }, cmrCheck: null, cmrCheckErr: "" });
  emit("orders", orderId, upd, prev);
  if (byUser.role === "driver") push.notifyRole(["admin", "dispatch"], { title: `CMR ontvangen voor ${o.ref}`, body: `${o.laadplaats} → ${o.losplaats} is gelost. De conceptfactuur staat klaar ter controle.`, url: "/dispatch#facturen" });
  const job = (async () => {
    let check = null;
    if (ai.configured()) {
      try { check = await ai.checkCmr({ buf, type, order: o }); const p2 = store.get("orders", orderId); emit("orders", orderId, store.patch("orders", orderId, { cmrCheck: check, cmrCheckErr: "" }), p2); }
      catch (e) { const p2 = store.get("orders", orderId); emit("orders", orderId, store.patch("orders", orderId, { cmrCheckErr: e.message }), p2); }
    }
    const fresh = store.get("orders", orderId);
    let invoiceId = fresh.factuurId || null;
    if (invoiceId) { const inv = store.get("invoices", invoiceId); if (inv && inv.status === "Concept" && check) emit("invoices", invoiceId, store.patch("invoices", invoiceId, { cmrCheck: check }), inv); }
    else if (fresh.klantId) invoiceId = createConcept(fresh.klantId, [orderId], check);
    return { invoiceId, check };
  })();
  if (wait) return { ...(await job), order: store.get("orders", orderId) };
  job.catch(e => console.error("CMR-verwerking:", e.message));
  return { order: store.get("orders", orderId) };
}

// ---------- assistent: tools over de eigen gegevens ----------
function absOn(did, day) { return store.all("absences").find(a => a.chauffeurId === did && a.van && a.van <= day && (!a.tot || a.tot >= day)) || null; }
function aiTools() {
  const orders = () => store.all("orders"), byId = (c, id) => id ? store.get(c, id) : null;
  const invStatus = i => i.status === "Betaald" ? "Betaald" : i.status === "Concept" ? "Concept" : (i.vervaldatum && i.vervaldatum < todayLocal() ? "Te laat" : "Open");
  return [
    { name: "ritten", description: "Zoekt ritten. Optioneel: status, datum_van/datum_tot (YYYY-MM-DD, op laaddatum), zoek (vrije tekst in ref, plaats, klant, chauffeur, kenteken).", inputSchema: { type: "object", properties: { status: { type: "string" }, datum_van: { type: "string" }, datum_tot: { type: "string" }, zoek: { type: "string" } } },
      execute: a => orders().filter(o => (!a.status || o.status === a.status) && (!a.datum_van || String(o.laaddatum).slice(0, 10) >= a.datum_van) && (!a.datum_tot || String(o.laaddatum).slice(0, 10) <= a.datum_tot) && (!a.zoek || [o.ref, o.laadplaats, o.losplaats, o.goederen, o.referentieKlant, (byId("customers", o.klantId) || {}).naam, (byId("drivers", o.chauffeurId) || {}).naam, (byId("vehicles", o.voertuigId) || {}).kenteken].join(" ").toLowerCase().includes(String(a.zoek).toLowerCase()))).slice(0, 40)
        .map(o => ({ ref: o.ref, status: o.status, klant: (byId("customers", o.klantId) || {}).naam, van: o.laadplaats, naar: o.losplaats, laden: o.laaddatum, lossen: o.losdatum, chauffeur: (byId("drivers", o.chauffeurId) || {}).naam || null, prijs: o.prijs, cmr: !!o.cmr, tijden: o.tijden || {} })) },
    { name: "facturen", description: "Facturen met status (Concept, Open, Te laat, Betaald), klant, bedrag, vervaldatum.", inputSchema: { type: "object", properties: { status: { type: "string" } } },
      execute: a => store.all("invoices").map(i => ({ nr: i.nr, status: invStatus(i), klant: (byId("customers", i.klantId) || {}).naam, totaal: i.totaal, vervaldatum: i.vervaldatum })).filter(i => !a.status || i.status === a.status).slice(0, 60) },
    { name: "chauffeurs_en_afwezigheden", description: "Chauffeurs met vervaldatums en afwezigheden. Optioneel datum (YYYY-MM-DD) om te zien wie die dag beschikbaar is.", inputSchema: { type: "object", properties: { datum: { type: "string" } } },
      execute: a => { const day = a.datum || todayLocal(); return { datum: day, chauffeurs: store.all("drivers").map(d => ({ naam: d.naam, afwezig: (absOn(d.id, day) || {}).type || null, rijbewijs: d.rijbewijs, code95: d.code95 })), afwezigheden: store.all("absences").map(x => ({ chauffeur: (byId("drivers", x.chauffeurId) || {}).naam, soort: x.type, van: x.van, tot: x.tot || "tot nader bericht" })) }; } },
    { name: "klanten_voertuigen_documenten", description: "Klanten, voertuigen (keuring, maten) en bedrijfsdocumenten met vervaldatum.", inputSchema: { type: "object", properties: {} },
      execute: () => ({ klanten: store.all("customers").map(c => ({ naam: c.naam, email: c.email, btw: c.btw })), voertuigen: store.all("vehicles").map(v => ({ kenteken: v.kenteken, type: v.type, keuring: v.keuring })), documenten: store.all("documents").map(d => ({ naam: d.naam, soort: d.categorie, geldig_tot: d.vervaldatum || null })) }) },
    { name: "zoek_mail", description: "Zoekt in de mailbox (Gmail-zoeksyntax bij Gmail). Geeft afzender, onderwerp en datum van max. 10 berichten.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async a => { if (!mail.configured()) return { fout: "mail niet ingesteld" }; const r = await mail.list({ q: a.query, size: 10 }); return r.items.map(m => ({ van: m.fromName, onderwerp: m.subject, datum: m.date, ongelezen: m.unread })); } },
  ];
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function httpErr(status, msg, code) { return Object.assign(new Error(msg), { status, code }); }
function send(res, status, obj, headers = {}) { const b = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(b); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(httpErr(413, "Bestand of bericht is te groot")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
async function jsonBody(req) { const b = await readBody(req, 30 * 1024 * 1024); if (!b.length) return {}; try { return JSON.parse(b.toString("utf-8")); } catch { throw httpErr(400, "Ongeldige gegevens"); } }
function serveFile(res, file, extraHeaders = {}) {
  const p = path.join(PUB, file);
  if (!p.startsWith(PUB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("Niet gevonden"); }
  const ext = path.extname(p);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" || file === "sw.js" ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff", ...extraHeaders });
  fs.createReadStream(p).pipe(res);
}
const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };

const routes = [];
const on = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, opts });
const need = (u, kind) => {
  if (!u) throw httpErr(401, "Niet aangemeld");
  if (kind === "office" && !auth.isOffice(u)) throw httpErr(403, "Geen toegang");
  if (kind === "admin" && u.role !== "admin") throw httpErr(403, "Alleen een beheerder kan dit");
  if (kind === "driver" && u.role !== "driver") throw httpErr(403, "Alleen voor chauffeurs");
};

// --- pagina's ---
on("GET", "/", (req, res, u) => redirect(res, !u ? (auth.userCount() ? "/login" : "/login#setup") : auth.isOffice(u) ? "/dispatch" : "/chauffeur"));
on("GET", "/login", (req, res) => serveFile(res, "login.html"));
on("GET", "/dispatch", (req, res, u) => !u ? redirect(res, "/login") : !auth.isOffice(u) ? redirect(res, "/chauffeur") : serveFile(res, "dispatch.html"));
on("GET", "/chauffeur", (req, res, u) => !u ? redirect(res, "/login") : u.role !== "driver" ? redirect(res, "/dispatch") : serveFile(res, "driver.html"));
on("GET", "/sw.js", (req, res) => serveFile(res, "sw.js", { "service-worker-allowed": "/" }));
on("GET", "/health", (req, res) => send(res, 200, { ok: true }));

// --- aanmelden ---
on("GET", "/api/setup", (req, res) => send(res, 200, { needed: auth.userCount() === 0 }));
on("POST", "/api/setup", async (req, res) => {
  if (auth.userCount() > 0) throw httpErr(403, "De app is al ingesteld");
  const b = await jsonBody(req);
  const u = auth.createUser({ email: b.email, name: b.name, role: "admin", password: b.password });
  const t = auth.createSession(u.id);
  send(res, 200, { user: u }, { "set-cookie": auth.sessionCookie(req, t) });
});
on("POST", "/api/login", async (req, res) => {
  const b = await jsonBody(req);
  const key = (req.socket.remoteAddress || "") + "|" + String(b.email || "").toLowerCase();
  if (auth.tooMany(key)) throw httpErr(429, "Te veel mislukte pogingen. Wacht een kwartier en probeer opnieuw.");
  const u = auth.findByEmail(b.email);
  if (!u || !u.active || !auth.verifyPassword(b.password, u.pass)) { auth.noteFail(key); throw httpErr(401, "E-mailadres of wachtwoord klopt niet"); }
  auth.clearFail(key);
  const t = auth.createSession(u.id);
  send(res, 200, { user: auth.publicUser(u), go: auth.isOffice(u) ? "/dispatch" : "/chauffeur" }, { "set-cookie": auth.sessionCookie(req, t) });
});
on("POST", "/api/logout", (req, res, u) => { if (u) auth.endSession(u.token); send(res, 200, { ok: true }, { "set-cookie": auth.sessionCookie(req, "", true) }); });
on("GET", "/api/me", (req, res, u) => { need(u); const { token, ...me } = u; send(res, 200, { user: me }); });
on("POST", "/api/me/password", async (req, res, u) => {
  need(u); const b = await jsonBody(req); const full = auth.findById(u.id);
  if (!auth.verifyPassword(b.current, full.pass)) throw httpErr(400, "Huidig wachtwoord klopt niet");
  auth.updateUser(u.id, { password: b.password }); const t = auth.createSession(u.id);
  send(res, 200, { ok: true }, { "set-cookie": auth.sessionCookie(req, t) });
});

// --- live ---
on("GET", "/api/events", (req, res, u) => {
  need(u);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write("retry: 4000\n\n");
  const c = { res, user: u }; clients.add(c);
  req.on("close", () => clients.delete(c));
});

// --- kantoor: gegevens ---
on("GET", "/api/data", (req, res, u) => {
  need(u, "office");
  const out = {}; COLS.forEach(c => out[c] = store.all(c));
  out.bedrijf = bedrijf(); out.facturatie = store.get("config", "facturatie") || {}; delete out.config;
  out.positions = db.prepare("SELECT * FROM positions").all();
  out.status = { mail: mail.configured(), mailGmail: /gmail\.com$/i.test(mail.config().imapHost), mailUser: mail.config().user, ai: ai.configured(), here: here.configured() };
  send(res, 200, out);
});
on("PUT", "/api/c/:col/:id", async (req, res, u, p) => {
  need(u, "office"); if (!COLS.includes(p.col)) throw httpErr(404, "Onbekende collectie");
  const b = await jsonBody(req); const prev = store.get(p.col, p.id);
  const doc = store.put(p.col, p.id, b); emit(p.col, p.id, doc, prev);
  if (p.col === "orders") notifyOrderChange(doc, prev);
  send(res, 200, doc);
});
on("PATCH", "/api/c/:col/:id", async (req, res, u, p) => {
  need(u, "office"); if (!COLS.includes(p.col)) throw httpErr(404, "Onbekende collectie");
  const b = await jsonBody(req); const prev = store.get(p.col, p.id); if (!prev) throw httpErr(404, "Niet gevonden");
  const doc = store.patch(p.col, p.id, b); emit(p.col, p.id, doc, prev);
  if (p.col === "orders") notifyOrderChange(doc, prev);
  send(res, 200, doc);
});
on("DELETE", "/api/c/:col/:id", (req, res, u, p) => {
  need(u, "office"); if (!COLS.includes(p.col)) throw httpErr(404, "Onbekende collectie");
  const prev = store.del(p.col, p.id); emit(p.col, p.id, null, prev);
  if (p.col === "orders") notifyOrderChange(null, prev);
  send(res, 200, { ok: true });
});

// --- bestanden ---
on("POST", "/api/files", async (req, res, u) => {
  need(u, "office");
  const buf = await readBody(req, 25 * 1024 * 1024); if (!buf.length) throw httpErr(400, "Leeg bestand");
  send(res, 200, saveFile(buf, decodeURIComponent(req.headers["x-filename"] || "bestand"), String(req.headers["content-type"] || "application/octet-stream").split(";")[0], u.id));
});
on("GET", "/api/files/:id", (req, res, u, p) => {
  need(u);
  if (!auth.isOffice(u) && !driverMayRead(u, p.id)) throw httpErr(403, "Geen toegang tot dit bestand");
  const f = readFile(p.id); if (!f) throw httpErr(404, "Bestand niet gevonden");
  const safe = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.meta.type);
  res.writeHead(200, { "content-type": f.meta.type, "content-length": f.buf.length, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
    "content-disposition": `${safe && !("download" in Object.fromEntries(new URL(req.url, "http://x").searchParams)) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:" });
  res.end(f.buf);
});
on("DELETE", "/api/files/:id", (req, res, u, p) => { need(u, "office"); deleteFile(p.id); send(res, 200, { ok: true }); });

// --- CMR (kantoor of de eigen chauffeur) ---
on("POST", "/api/orders/:id/cmr", async (req, res, u, p) => {
  need(u);
  const o = store.get("orders", p.id); if (!o) throw httpErr(404, "Rit niet gevonden");
  if (!auth.isOffice(u) && !(u.role === "driver" && o.chauffeurId === u.driverId)) throw httpErr(403, "Geen toegang tot deze rit");
  const buf = await readBody(req, 25 * 1024 * 1024); if (!buf.length) throw httpErr(400, "Leeg bestand");
  const type = String(req.headers["content-type"] || "image/jpeg").split(";")[0];
  if (!/^(image\/|application\/pdf)/.test(type)) throw httpErr(400, "Upload een foto of pdf van de CMR");
  const r = await processCmr(p.id, buf, type, decodeURIComponent(req.headers["x-filename"] || "cmr"), u, new URL(req.url, "http://x").searchParams.get("wait") === "1");
  send(res, 200, u.role === "driver" ? { ok: true, order: driverOrder(r.order) } : r);
});

// --- gebruikers ---
on("GET", "/api/users", (req, res, u) => { need(u, "office"); send(res, 200, auth.listUsers()); });
on("POST", "/api/users", async (req, res, u) => {
  need(u, "office"); const b = await jsonBody(req);
  if (b.role !== "driver" && u.role !== "admin") throw httpErr(403, "Alleen een beheerder kan kantoorlogins maken");
  if (b.role === "driver" && !store.get("drivers", b.driverId)) throw httpErr(400, "Chauffeur niet gevonden");
  try { send(res, 200, auth.createUser(b)); } catch (e) { throw httpErr(400, e.message); }
});
on("PATCH", "/api/users/:id", async (req, res, u, p) => {
  need(u, "office"); const t = auth.findById(p.id); if (!t) throw httpErr(404, "Login niet gevonden");
  if (t.role !== "driver" && u.role !== "admin") throw httpErr(403, "Alleen een beheerder kan kantoorlogins wijzigen");
  const b = await jsonBody(req);
  if (t.id === u.id && b.active === false) throw httpErr(400, "Je kunt jezelf niet uitschakelen");
  try { send(res, 200, auth.updateUser(p.id, b)); } catch (e) { throw httpErr(400, e.message); }
});
on("DELETE", "/api/users/:id", (req, res, u, p) => {
  need(u, "office"); const t = auth.findById(p.id); if (!t) throw httpErr(404, "Login niet gevonden");
  if (t.role !== "driver" && u.role !== "admin") throw httpErr(403, "Alleen een beheerder kan kantoorlogins verwijderen");
  if (t.id === u.id) throw httpErr(400, "Je kunt je eigen login niet verwijderen");
  auth.deleteUser(p.id); send(res, 200, { ok: true });
});

// --- koppelingen instellen (beheerder) ---
on("GET", "/api/settings", (req, res, u) => {
  need(u, "admin"); const m = mail.config(), a = ai.config();
  send(res, 200, {
    mail: { user: m.user, fromName: m.fromName, imapHost: m.imapHost, imapPort: m.imapPort, smtpHost: m.smtpHost, smtpPort: m.smtpPort, hasPass: !!m.pass, viaEnv: !!process.env.MAIL_USER },
    ai: { model: a.model, hasKey: !!a.key, viaEnv: !!process.env.ANTHROPIC_API_KEY },
    here: { hasKey: here.configured(), viaEnv: !!process.env.HERE_API_KEY },
  });
});
on("PUT", "/api/settings/:name", async (req, res, u, p) => {
  need(u, "admin"); const b = await jsonBody(req); const cur = store.setting(p.name) || {};
  if (p.name === "mail") store.setting("mail", { ...cur, user: String(b.user || "").trim(), fromName: String(b.fromName || "").trim(), imapHost: String(b.imapHost || "").trim(), imapPort: +b.imapPort || 993, smtpHost: String(b.smtpHost || "").trim(), smtpPort: +b.smtpPort || 465, ...(b.pass ? { pass: String(b.pass).replace(/\s+/g, "") } : {}) });
  else if (p.name === "ai") store.setting("ai", { ...cur, model: String(b.model || cur.model || "claude-sonnet-5-5").trim(), ...(b.key ? { key: String(b.key).trim() } : {}) });
  else if (p.name === "here") store.setting("here", { ...cur, ...(b.key ? { key: String(b.key).trim() } : {}) });
  else throw httpErr(404, "Onbekende instelling");
  send(res, 200, { ok: true });
});
on("POST", "/api/settings/mail/test", async (req, res, u) => { need(u, "admin"); try { send(res, 200, await mail.test()); } catch (e) { throw httpErr(400, e.message); } });

// --- mail (kantoor) ---
const mailErr = e => { throw httpErr(e.code === "not_configured" ? 409 : e.code === "not_found" ? 404 : 502, e.message, e.code); };
on("GET", "/api/mail/list", async (req, res, u) => {
  need(u, "office"); const s = new URL(req.url, "http://x").searchParams;
  try { send(res, 200, await mail.list({ box: s.get("box") === "sent" ? "sent" : "inbox", q: s.get("q") || "", unread: s.get("unread") === "1", page: +s.get("page") || 0, size: 25 })); } catch (e) { mailErr(e); }
});
on("GET", "/api/mail/msg/:box/:uid", async (req, res, u, p) => { need(u, "office"); try { send(res, 200, await mail.getMessage(p.box === "sent" ? "sent" : "inbox", +p.uid)); } catch (e) { mailErr(e); } });
on("POST", "/api/mail/attachment", async (req, res, u) => {
  need(u, "office"); const b = await jsonBody(req);
  try { const a = await mail.getAttachment(b.box === "sent" ? "sent" : "inbox", +b.uid, +b.idx); send(res, 200, saveFile(a.bytes, a.name, a.type, u.id)); } catch (e) { mailErr(e); }
});
on("POST", "/api/mail/send", async (req, res, u) => {
  need(u, "office"); const b = await jsonBody(req);
  const ok = s => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
  const to = (b.to || []).map(String).filter(Boolean), cc = (b.cc || []).map(String).filter(Boolean);
  if (!to.length || [...to, ...cc].some(x => !ok(x))) throw httpErr(400, "Controleer de e-mailadressen");
  const atts = [];
  for (const a of b.attachments || []) {
    if (a.fileId) { const f = readFile(a.fileId); if (!f) throw httpErr(400, "Bijlage niet gevonden"); atts.push({ filename: a.filename || f.meta.name, mime: f.meta.type, bytes: f.buf }); }
    else if (a.base64) atts.push({ filename: a.filename || "bijlage", mime: a.mime || "application/octet-stream", bytes: Buffer.from(a.base64, "base64") });
  }
  if (atts.reduce((s, a) => s + a.bytes.length, 0) > 24 * 1024 * 1024) throw httpErr(400, "De bijlagen samen zijn groter dan 24 MB");
  try { send(res, 200, await mail.send({ to, cc, subject: String(b.subject || ""), text: String(b.body || ""), attachments: atts, inReplyTo: b.inReplyTo || "", references: b.references || "" })); } catch (e) { mailErr(e); }
});
on("GET", "/api/mail/unseen", async (req, res, u) => { need(u, "office"); try { send(res, 200, { unseen: await mail.unseenCount() }); } catch (e) { mailErr(e); } });

// --- AI (kantoor) ---
const aiErr = e => { throw httpErr(e.code === "not_configured" ? 409 : 502, e.message, e.code); };
on("POST", "/api/ai/order", async (req, res, u) => {
  need(u, "office"); const b = await jsonBody(req); const f = readFile(b.fileId); if (!f) throw httpErr(404, "Bestand niet gevonden");
  if (!/^(application\/pdf|image\/)/.test(f.meta.type)) throw httpErr(400, "Alleen pdf of foto");
  try { send(res, 200, await ai.orderFromFile({ buf: f.buf, type: f.meta.type, name: f.meta.name, company: bedrijf().naam || "Ghotra Transport", today: todayLocal(), sender: b.sender, subject: b.subject, body: b.body })); } catch (e) { aiErr(e); }
});
on("POST", "/api/ai/cmr/:id", async (req, res, u, p) => {
  need(u, "office"); const o = store.get("orders", p.id); if (!o || !o.cmr) throw httpErr(404, "Geen CMR bij deze rit");
  const f = readFile(o.cmr.id); if (!f) throw httpErr(404, "CMR-bestand niet gevonden");
  try {
    const check = await ai.checkCmr({ buf: f.buf, type: f.meta.type, order: o });
    emit("orders", o.id, store.patch("orders", o.id, { cmrCheck: check, cmrCheckErr: "" }), o);
    const inv = o.factuurId && store.get("invoices", o.factuurId); if (inv && inv.status === "Concept") emit("invoices", inv.id, store.patch("invoices", inv.id, { cmrCheck: check }), inv);
    send(res, 200, check);
  } catch (e) { aiErr(e); }
});
on("POST", "/api/ai/chat", async (req, res, u) => {
  need(u, "office"); const b = await jsonBody(req);
  const b2 = bedrijf();
  const system = `Je bent de assistent in Ghotra Dispatch, de planningsapp van transportbedrijf ${b2.naam || "Ghotra Transport"}. Vandaag is ${new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ })}.
Beantwoord vragen over ritten, chauffeurs, afwezigheden, voertuigen, klanten, facturen, documenten en mail. Gebruik de tools en verzin niets. Antwoord kort en concreet in de taal van de gebruiker (standaard Nederlands), zonder markdown; gewone zinnen of korte opsommingen met streepjes. Bedragen in euro.
Je kunt zelf niets wijzigen of versturen; zeg welk tabblad of welke knop daarvoor dient (Vandaag, Ritten, Planning, Mail, Facturen, Beheer).`;
  const msgs = (b.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant") && m.content).slice(-14);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw httpErr(400, "Geen vraag");
  try { send(res, 200, { text: await ai.chat({ system, messages: msgs, tools: aiTools() }) }); } catch (e) { aiErr(e); }
});

// --- routes en posities ---
on("GET", "/api/route/:id", async (req, res, u, p) => {
  need(u);
  const o = store.get("orders", p.id); if (!o) throw httpErr(404, "Rit niet gevonden");
  if (!auth.isOffice(u) && o.chauffeurId !== u.driverId) throw httpErr(403, "Geen toegang tot deze rit");
  const s = new URL(req.url, "http://x").searchParams;
  const leg = s.get("leg") || "full";
  const laad = (o.laadadres || o.laadplaats || "").replace(/\n/g, ", "), los = (o.losadres || o.losplaats || "").replace(/\n/g, ", ");
  const gmaps = (a, b) => "https://www.google.com/maps/dir/?api=1&travelmode=driving" + (a ? "&origin=" + encodeURIComponent(a) : "") + "&destination=" + encodeURIComponent(b);
  const fallback = { configured: false, links: { laad: gmaps("", laad), los: gmaps(laad, los) } };
  if (!here.configured()) return send(res, 200, fallback);
  try {
    let from = null; const fp = (s.get("from") || "").split(",").map(Number);
    if (fp.length === 2 && fp.every(Number.isFinite)) from = { lat: fp[0], lng: fp[1], label: "Huidige positie" };
    const A = await here.geocode(laad), B = await here.geocode(los);
    if (!A || !B) throw httpErr(422, `Adres niet gevonden: ${!A ? laad : los}. Vul een volledig adres in bij de rit.`);
    const start = leg === "los" ? (from || A) : leg === "laad" ? (from || A) : A;
    const end = leg === "laad" ? A : B;
    const v = o.voertuigId ? store.get("vehicles", o.voertuigId) || {} : {};
    const r = start === end || (Math.abs(start.lat - end.lat) < 1e-4 && Math.abs(start.lng - end.lng) < 1e-4) ? null : await here.truckRoute(start, end, v, !!o.adr);
    send(res, 200, { configured: true, leg, start, end, laad: A, los: B, route: r, vehicle: { hoogte: v.hoogte, breedte: v.breedte, lengte: v.lengte, massa: v.massa }, links: fallback.links });
  } catch (e) { if (e.status) throw e; throw httpErr(502, e.message); }
});
on("POST", "/api/driver/position", async (req, res, u) => {
  need(u, "driver"); const b = await jsonBody(req);
  if (![b.lat, b.lng].every(Number.isFinite)) throw httpErr(400, "Ongeldige positie");
  db.prepare("INSERT INTO positions(driverId,lat,lng,acc,at,orderId) VALUES(?,?,?,?,?,?) ON CONFLICT(driverId) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,acc=excluded.acc,at=excluded.at,orderId=excluded.orderId")
    .run(u.driverId, b.lat, b.lng, +b.acc || null, Date.now(), b.orderId || null);
  emitOffice({ type: "pos", pos: { driverId: u.driverId, lat: b.lat, lng: b.lng, acc: +b.acc || null, at: Date.now(), orderId: b.orderId || null } });
  send(res, 200, { ok: true });
});

// --- chauffeur ---
on("GET", "/api/driver/me", (req, res, u) => {
  need(u, "driver"); const d = store.get("drivers", u.driverId) || {}; const b = bedrijf();
  send(res, 200, { user: { name: u.name, email: u.email }, driver: { id: u.driverId, naam: d.naam || u.name, tel: d.tel || "" }, bedrijf: { naam: b.naam || "Ghotra Transport", tel: b.tel || "" }, afwezig: absOn(u.driverId, todayLocal()), push: { key: push.keys().pub } });
});
on("GET", "/api/driver/orders", (req, res, u) => {
  need(u, "driver");
  send(res, 200, store.all("orders").filter(o => driverVisible(o, u.driverId)).map(driverOrder).sort((a, b) => String(a.laaddatum || "").localeCompare(String(b.laaddatum || ""))));
});
on("POST", "/api/driver/orders/:id/seen", (req, res, u, p) => {
  need(u, "driver"); const o = store.get("orders", p.id); if (!o || o.chauffeurId !== u.driverId) throw httpErr(404, "Rit niet gevonden");
  if (!o.gezien) emit("orders", o.id, store.patch("orders", o.id, { gezien: new Date().toISOString() }), o);
  send(res, 200, { ok: true });
});
on("POST", "/api/driver/orders/:id/status", async (req, res, u, p) => {
  need(u, "driver"); const b = await jsonBody(req);
  const o = store.get("orders", p.id); if (!o || o.chauffeurId !== u.driverId) throw httpErr(404, "Rit niet gevonden");
  const cur = FLOW.indexOf(o.status), next = FLOW.indexOf(b.status);
  if (next < 1 || next > 4) throw httpErr(400, "Deze stap kan niet");
  if (next !== cur + 1 && next !== cur - 1) throw httpErr(409, "De rit staat al op een andere stap. Vernieuw de pagina.");
  const upd = store.patch("orders", o.id, next > cur ? { status: b.status, tijden: { [b.status]: new Date().toISOString() } } : { status: b.status });
  emit("orders", o.id, upd, o);
  send(res, 200, driverOrder(upd));
});
on("POST", "/api/driver/orders/:id/gelost", (req, res, u, p) => {
  need(u, "driver"); const o = store.get("orders", p.id); if (!o || o.chauffeurId !== u.driverId) throw httpErr(404, "Rit niet gevonden");
  if (o.status !== "Lossen") throw httpErr(409, "De rit staat niet op lossen. Vernieuw de pagina.");
  const upd = (o.tijden || {}).Gelost ? o : store.patch("orders", o.id, { tijden: { Gelost: new Date().toISOString() } });
  if (upd !== o) emit("orders", o.id, upd, o);
  send(res, 200, driverOrder(upd));
});
on("POST", "/api/driver/ziek", async (req, res, u) => {
  need(u, "driver"); const b = await jsonBody(req);
  const today = todayLocal();
  if (absOn(u.driverId, today)) throw httpErr(409, "Je bent vandaag al afwezig gemeld");
  const id = uid(), d = store.get("drivers", u.driverId) || {};
  const doc = store.put("absences", id, { chauffeurId: u.driverId, type: "Ziek", van: today, tot: /^\d{4}-\d{2}-\d{2}$/.test(b.tot || "") ? b.tot : "", notitie: ("Gemeld via chauffeursapp. " + String(b.notitie || "")).trim(), gemeld: new Date().toISOString() });
  emit("absences", id, doc, null);
  push.notifyRole(["admin", "dispatch"], { title: `${d.naam || u.name} meldt zich ziek`, body: "Controleer de planning: ritten van vandaag hebben een andere chauffeur nodig.", url: "/dispatch#planning" });
  send(res, 200, { ok: true });
});

// --- pushmeldingen ---
on("GET", "/api/push/key", (req, res, u) => { need(u); send(res, 200, { key: push.keys().pub }); });
on("POST", "/api/push/subscribe", async (req, res, u) => { need(u); const b = await jsonBody(req); try { push.subscribe(u.id, b.endpoint); } catch (e) { throw httpErr(400, e.message); } send(res, 200, { ok: true }); });
on("POST", "/api/push/unsubscribe", async (req, res, u) => { need(u); const b = await jsonBody(req); push.unsubscribe(b.endpoint); send(res, 200, { ok: true }); });
on("GET", "/api/notifications/pending", (req, res, u) => { need(u); send(res, 200, push.pending(u.id)); });
on("POST", "/api/push/test", (req, res, u) => { need(u); push.notify(u.id, { title: "Meldingen werken", body: "Je krijgt voortaan een melding bij nieuwe of gewijzigde ritten.", url: auth.isOffice(u) ? "/dispatch" : "/chauffeur" }); send(res, 200, { ok: true }); });

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let u = null;
  try {
    u = auth.userFromReq(req);
    // Bescherming tegen verzoeken vanaf andere websites.
    if (!["GET", "HEAD"].includes(req.method) && url.pathname.startsWith("/api/") && req.headers["x-ghotra"] !== "1") throw httpErr(403, "Ongeldig verzoek");
    for (const r of routes) {
      if (r.method !== req.method && !(req.method === "HEAD" && r.method === "GET")) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      const params = {}; for (const [k, v] of Object.entries(m.groups || {})) params[k] = decodeURIComponent(v);
      return await r.handler(req, res, u, params);
    }
    if (req.method === "GET" && /^\/(assets\/[\w.\-\/]+|manifest-(dispatch|chauffeur)\.webmanifest|icon\.svg|favicon\.ico)$/.test(url.pathname)) return serveFile(res, url.pathname.slice(1));
    throw httpErr(404, "Niet gevonden");
  } catch (e) {
    if (!e.status) console.error(req.method, url.pathname, e);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (!url.pathname.startsWith("/api/") && e.status === 404) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Pagina niet gevonden"); }
    send(res, e.status || 500, { error: e.status ? e.message : "Er ging iets mis op de server", code: e.code || null });
  }
});
server.requestTimeout = 180000;
server.listen(PORT, () => console.log(`Ghotra draait op poort ${PORT} · gegevens in ${store.DATA_DIR}`));

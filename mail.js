"use strict";
// Mail: lezen via IMAP, versturen via SMTP. Werkt met Gmail/Google Workspace (app-wachtwoord) en elke andere mailbox.
const tls = require("tls");
const net = require("net");
const { parseMessage, parseHeaders, parseAddress, decodeWords, buildMessage } = require("./mime");
const { setting } = require("./db");

function config() {
  const s = setting("mail") || {};
  const user = process.env.MAIL_USER || s.user || "";
  // Leeg = Google (Gmail of Google Workspace, ook met eigen domein).
  const isGoogle = true;
  return {
    relayUrl: process.env.MAIL_RELAY_URL || s.relayUrl || "", relayKey: process.env.MAIL_RELAY_KEY || s.relayKey || "",
    user, pass: process.env.MAIL_PASS || s.pass || "",
    fromName: process.env.MAIL_FROM_NAME || s.fromName || "",
    imapHost: process.env.MAIL_IMAP_HOST || s.imapHost || (isGoogle ? "imap.gmail.com" : ""),
    imapPort: +(process.env.MAIL_IMAP_PORT || s.imapPort || 993),
    smtpHost: process.env.MAIL_SMTP_HOST || s.smtpHost || (isGoogle ? "smtp.gmail.com" : ""),
    smtpPort: +(process.env.MAIL_SMTP_PORT || s.smtpPort || 465),
  };
}
const configured = () => { const c = config(); return !!(c.user && c.pass && c.imapHost && (c.relayUrl || c.smtpHost)); };
function netMsg(e, what) {
  const code = (e && (e.code || "")) + " " + String(e && e.message || "");
  if (/ETIMEDOUT|time-out|timed out|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(code))
    return what === "smtp" ? "Railway blokkeert uitgaande mail (SMTP) op je huidige abonnement. Gebruik de Google-verzendhulp hieronder, of neem Railway Pro." : "De mailserver is niet bereikbaar (IMAP, poort 993).";
  return String(e && e.message || e);
}
const isGmail = c => /gmail\.com$/i.test(c.imapHost);

// ---------------- IMAP ----------------
class Imap {
  constructor(c) { this.c = c; this.buf = Buffer.alloc(0); this.tagN = 0; this.cur = null; this.item = null; }
  connect() {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { rej(new Error("Mailserver reageert niet (time-out)")); this.close(); }, 20000);
      this.sock = tls.connect({ host: this.c.imapHost, port: this.c.imapPort, servername: this.c.imapHost }, () => {});
      this.sock.on("error", e => { clearTimeout(to); if (this.cur) this.cur.rej(e); else rej(e); });
      this.sock.on("data", d => this.onData(d));
      this.greet = () => { clearTimeout(to); res(); };
    });
  }
  close() { try { this.sock.destroy(); } catch {} }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.need) {
        if (this.buf.length < this.need) return;
        this.item.lits.push(this.buf.subarray(0, this.need)); this.item.text += "\x00LIT" + (this.item.lits.length - 1) + "\x00";
        this.buf = this.buf.subarray(this.need); this.need = 0; continue;
      }
      const i = this.buf.indexOf("\r\n"); if (i < 0) return;
      const line = this.buf.subarray(0, i).toString("latin1"); this.buf = this.buf.subarray(i + 2);
      if (!this.item) this.item = { text: "", lits: [] };
      const m = /\{(\d+)\}$/.exec(line);
      if (m) { this.item.text += line.slice(0, m.index); this.need = +m[1]; continue; }
      this.item.text += line; const it = this.item; this.item = null; this.onItem(it);
    }
  }
  onItem(it) {
    if (this.greet) { const g = this.greet; this.greet = null; if (/^\* (OK|PREAUTH)/i.test(it.text)) g(); else if (this.cur) this.cur.rej(new Error(it.text)); return; }
    if (it.text.startsWith("+") && this.cont) { const c = this.cont; this.cont = null; c(); return; }
    if (this.cur && it.text.startsWith(this.cur.tag + " ")) {
      const cur = this.cur; this.cur = null;
      if (/^\S+ OK/i.test(it.text)) cur.res(cur.items); else cur.rej(new Error(it.text.replace(/^\S+ (NO|BAD)\s*/i, "").replace(/^\[[^\]]*\]\s*/, "") || "IMAP-fout"));
      return;
    }
    if (this.cur) this.cur.items.push(it);
  }
  cmd(text, literal) {
    return new Promise((res, rej) => {
      const tag = "G" + (++this.tagN);
      this.cur = { tag, items: [], res, rej };
      if (literal) { this.cont = () => this.sock.write(Buffer.concat([literal, Buffer.from("\r\n")])); }
      this.sock.write(`${tag} ${text}\r\n`);
    });
  }
}
const quote = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

async function withImap(fn) {
  const c = config();
  if (!configured()) throw Object.assign(new Error("Mail is nog niet ingesteld"), { code: "not_configured" });
  const im = new Imap(c);
  await im.connect();
  const timer = setTimeout(() => im.close(), 60000);
  try {
    await im.cmd(`LOGIN ${quote(c.user)} ${quote(c.pass)}`).catch(e => { throw Object.assign(new Error("Inloggen bij de mailbox mislukt. Controleer het e-mailadres en het app-wachtwoord."), { code: "auth" }); });
    return await fn(im, c);
  } finally { clearTimeout(timer); im.cmd("LOGOUT").catch(() => {}); setTimeout(() => im.close(), 300); }
}

let boxCache = null;
async function resolveBox(im, which) {
  if (which !== "sent") return "INBOX";
  if (boxCache) return boxCache;
  const items = await im.cmd('LIST "" "*"');
  for (const it of items) { const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(it.text); if (m && /\\Sent/i.test(m[1])) { boxCache = m[2].trim(); return boxCache; } }
  for (const it of items) { const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(it.text); if (m && /sent|verzonden/i.test(m[2])) { boxCache = m[2].trim(); return boxCache; } }
  return "INBOX";
}

function parseFetch(it) {
  const t = it.text;
  const uid = +(/UID (\d+)/.exec(t) || [])[1];
  const flags = ((/FLAGS \(([^)]*)\)/.exec(t) || [])[1] || "").split(/\s+/).filter(Boolean);
  const date = (/INTERNALDATE "([^"]+)"/.exec(t) || [])[1];
  const size = +(/RFC822\.SIZE (\d+)/.exec(t) || [])[1] || 0;
  return { uid, flags, date: date ? new Date(date).toISOString() : null, size, lits: it.lits };
}

async function list({ box = "inbox", q = "", unread = false, page = 0, size = 25 } = {}) {
  return withImap(async (im, c) => {
    const name = await resolveBox(im, box);
    await im.cmd(`EXAMINE ${name.startsWith('"') ? name : quote(name)}`);
    let crit = "ALL";
    if (q) crit = isGmail(c) ? `X-GM-RAW ${quote(q + (unread ? " is:unread" : ""))}` : `${unread ? "UNSEEN " : ""}TEXT ${quote(q)}`;
    else if (unread) crit = "UNSEEN";
    const res = await im.cmd(`UID SEARCH ${crit}`);
    const uids = [];
    res.forEach(it => { const m = /^\* SEARCH ?(.*)$/i.exec(it.text); if (m) m[1].split(/\s+/).filter(Boolean).forEach(u => uids.push(+u)); });
    uids.sort((a, b) => b - a);
    const slice = uids.slice(page * size, page * size + size);
    if (!slice.length) return { items: [], next: null, total: uids.length };
    const out = await fetchHeaders(im, slice);
    return { items: out, next: uids.length > (page + 1) * size ? page + 1 : null, total: uids.length };
  });
}

async function fetchHeaders(im, uids) {
  const items = await im.cmd(`UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE MESSAGE-ID)])`);
  return items.filter(it => / FETCH /i.test(it.text)).map(it => {
    const f = parseFetch(it); const h = parseHeaders(f.lits[0] ? f.lits[0].toString("latin1") : "");
    const from = parseAddress(h.from);
    return { uid: f.uid, from: from.email, fromName: from.name || from.email, to: decodeWords(h.to || ""), subject: decodeWords(h.subject || ""), date: f.date || (h.date ? new Date(h.date).toISOString() : null),
      unread: !f.flags.some(x => /\\Seen/i.test(x)), hasAtt: /multipart\/(mixed|related)/i.test(h["content-type"] || ""), messageId: h["message-id"] || "" };
  }).sort((a, b) => b.uid - a.uid);
}

// Nieuwe berichten in de inbox sinds lastUid. Eerste keer (lastUid 0): alleen het startpunt bepalen.
async function newSince(lastUid) {
  return withImap(async im => {
    const st = await im.cmd('STATUS INBOX (UIDNEXT UIDVALIDITY)');
    const t = st.map(x => x.text).join(" ");
    const uidNext = +(/UIDNEXT (\d+)/i.exec(t) || [])[1] || 0, validity = +(/UIDVALIDITY (\d+)/i.exec(t) || [])[1] || 0;
    if (!lastUid || !uidNext || uidNext - 1 <= lastUid) return { last: uidNext ? uidNext - 1 : lastUid, validity, items: [] };
    await im.cmd("EXAMINE INBOX");
    const r = await im.cmd(`UID SEARCH UID ${lastUid + 1}:*`);
    const uids = []; r.forEach(it => { const m = /^\* SEARCH ?(.*)$/i.exec(it.text); if (m) m[1].split(/\s+/).filter(Boolean).forEach(u => { if (+u > lastUid) uids.push(+u); }); });
    if (!uids.length) return { last: uidNext - 1, validity, items: [] };
    const items = await fetchHeaders(im, uids.slice(-20));
    return { last: Math.max(uidNext - 1, ...uids), validity, items };
  });
}

async function unseenCount() {
  return withImap(async im => { const r = await im.cmd('STATUS INBOX (UNSEEN)'); const m = /UNSEEN (\d+)/i.exec(r.map(x => x.text).join(" ")); return m ? +m[1] : 0; });
}

async function fetchRaw(box, uid, markSeen) {
  return withImap(async im => {
    const name = await resolveBox(im, box);
    await im.cmd(`${markSeen ? "SELECT" : "EXAMINE"} ${name.startsWith('"') ? name : quote(name)}`);
    const items = await im.cmd(`UID FETCH ${+uid} (UID FLAGS ${markSeen ? "BODY[]" : "BODY.PEEK[]"})`);
    const it = items.find(x => / FETCH /i.test(x.text) && x.lits.length);
    if (!it) throw Object.assign(new Error("Bericht niet gevonden"), { code: "not_found" });
    return Buffer.from(it.lits[it.lits.length - 1]);
  });
}
async function getMessage(box, uid) {
  const raw = await fetchRaw(box, uid, true);
  const m = parseMessage(raw); const h = m.headers; const from = parseAddress(h.from);
  return { uid: +uid, box, from: from.email, fromName: from.name || from.email, to: decodeWords(h.to || ""), cc: decodeWords(h.cc || ""), subject: decodeWords(h.subject || ""),
    date: h.date ? new Date(h.date).toISOString() : null, messageId: h["message-id"] || "", references: h.references || "", text: m.text || "",
    attachments: m.attachments.map(a => ({ idx: a.idx, name: a.name, type: a.type, size: a.size })) };
}
async function getAttachment(box, uid, idx) {
  const raw = await fetchRaw(box, uid, false);
  const a = parseMessage(raw).attachments.find(x => x.idx === +idx);
  if (!a) throw Object.assign(new Error("Bijlage niet gevonden"), { code: "not_found" });
  return a;
}

// ---------------- SMTP ----------------
function smtpSession(c) {
  return new Promise((resolve, reject) => {
    let sock, buf = "", waiter = null;
    const onData = d => { buf += d.toString("utf-8"); const lines = buf.split("\r\n"); if (lines.length < 2) return; const done = lines.slice(0, -1).findIndex(l => /^\d{3} /.test(l));
      if (done >= 0 && waiter) { const reply = lines.slice(0, done + 1).join("\n"); buf = lines.slice(done + 1).join("\r\n"); const w = waiter; waiter = null; w(reply); } };
    const read = () => new Promise(r => { waiter = r; onData(Buffer.alloc(0)); });
    const send = async (line, expect) => { sock.write(line + "\r\n"); const r = await read(); if (expect && !expect.test(r)) throw new Error("Mailserver weigerde: " + r.split("\n").pop()); return r; };
    const attach = s => { sock = s; sock.on("data", onData); sock.on("error", e => reject(e)); };
    const secure = c.smtpPort === 465;
    const s0 = secure ? tls.connect({ host: c.smtpHost, port: c.smtpPort, servername: c.smtpHost }) : net.connect({ host: c.smtpHost, port: c.smtpPort });
    attach(s0);
    s0.setTimeout(30000, () => { reject(new Error("Mailserver reageert niet (time-out)")); s0.destroy(); });
    s0.once(secure ? "secureConnect" : "connect", async () => {
      try {
        await read();
        await send("EHLO ghotra.app", /^250/m);
        if (!secure) {
          await send("STARTTLS", /^220/);
          s0.removeListener("data", onData);
          const s1 = tls.connect({ socket: s0, servername: c.smtpHost });
          await new Promise((r, j) => { s1.once("secureConnect", r); s1.once("error", j); });
          attach(s1); await send("EHLO ghotra.app", /^250/m);
        }
        resolve({ send, close: () => { try { sock.write("QUIT\r\n"); sock.end(); } catch {} } });
      } catch (e) { reject(e); }
    });
  });
}
async function relayCall(c, payload) {
  const r = await fetch(c.relayUrl, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: c.relayKey, ...payload }), redirect: "follow", signal: AbortSignal.timeout(90000) });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { throw new Error(/<html/i.test(txt) ? "Het Google-hulpscript antwoordt niet goed. Controleer bij Implementeren: 'Uitvoeren als: Ik' en 'Toegang: Iedereen', en gebruik de URL die eindigt op /exec." : "Onverwacht antwoord van het Google-hulpscript"); }
  if (!j.ok) throw new Error("Google-hulpscript: " + (j.error || "fout"));
  return j;
}
async function send({ to, cc, subject, text, attachments, inReplyTo, references }) {
  const c = config();
  if (!configured()) throw Object.assign(new Error("Mail is nog niet ingesteld"), { code: "not_configured" });
  if (c.relayUrl) {
    await relayCall(c, { to, cc: cc || [], subject, body: text, fromName: c.fromName, attachments: (attachments || []).map(a => ({ name: a.filename, mime: a.mime || "application/octet-stream", data: Buffer.from(a.bytes).toString("base64") })) });
    return { messageId: "" };
  }
  const { raw, messageId } = buildMessage({ from: c.user, fromName: c.fromName, to, cc, subject, text, attachments, inReplyTo, references });
  const s = await smtpSession(c).catch(e => { throw new Error(netMsg(e, "smtp")); });
  try {
    const auth = Buffer.from("\0" + c.user + "\0" + c.pass, "utf-8").toString("base64");
    await s.send("AUTH PLAIN " + auth, /^235/).catch(() => { throw Object.assign(new Error("Inloggen bij de uitgaande mailserver mislukt. Controleer het app-wachtwoord."), { code: "auth" }); });
    await s.send(`MAIL FROM:<${c.user}>`, /^250/);
    for (const r of [...to, ...(cc || [])]) await s.send(`RCPT TO:<${r}>`, /^25[01]/);
    await s.send("DATA", /^354/);
    await s.send(raw.replace(/\r\n\./g, "\r\n..") + "\r\n.", /^250/);
  } finally { s.close(); }
  // Gmail bewaart verzonden mail zelf; bij andere providers zetten we een kopie in Verzonden.
  if (!isGmail(c)) {
    withImap(async im => { const name = await resolveBox(im, "sent"); if (name === "INBOX") return; const lit = Buffer.from(raw, "utf-8"); await im.cmd(`APPEND ${name.startsWith('"') ? name : quote(name)} (\\Seen) {${lit.length}}`, lit); }).catch(() => {});
  }
  return { messageId };
}

// Test lezen (IMAP) en versturen (hulpscript of SMTP) apart, met duidelijke uitleg.
async function test() {
  const c = config(); const out = { lezen: "", versturen: "", unseen: null, ok: false };
  try { out.unseen = await unseenCount(); out.lezen = "ok"; } catch (e) { out.lezen = /Inloggen/.test(e.message) ? e.message : netMsg(e, "imap"); }
  try {
    if (c.relayUrl) { const j = await relayCall(c, { ping: true }); out.versturen = "ok"; out.via = "Google-hulpscript" + (j.email ? " (" + j.email + ")" : ""); }
    else {
      const s = await Promise.race([smtpSession(c), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("time-out"), { code: "ETIMEDOUT" })), 12000))]);
      try { const auth = Buffer.from("\0" + c.user + "\0" + c.pass, "utf-8").toString("base64"); await s.send("AUTH PLAIN " + auth, /^235/).catch(() => { throw new Error("Inloggen bij de uitgaande mailserver mislukt. Controleer het app-wachtwoord."); }); } finally { s.close(); }
      out.versturen = "ok"; out.via = "SMTP";
    }
  } catch (e) { out.versturen = netMsg(e, "smtp"); }
  out.ok = out.lezen === "ok" && out.versturen === "ok";
  return out;
}

module.exports = { config, configured, newSince, list, getMessage, getAttachment, send, unseenCount, test };

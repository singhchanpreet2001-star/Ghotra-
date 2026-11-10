"use strict";
// Pushmeldingen via de browser (Web Push met VAPID). Er wordt geen inhoud meegestuurd:
// de service worker haalt na een "por" zelf de openstaande meldingen op.
const crypto = require("crypto");
const { db, setting } = require("./db");

const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function keys() {
  let k = setting("vapid");
  if (!k) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    k = { priv: privateKey.export({ format: "pem", type: "pkcs8" }), pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])) };
    setting("vapid", k);
  }
  return k;
}
function jwt(aud) {
  const k = keys();
  const subject = process.env.VAPID_SUBJECT || ("mailto:" + (process.env.ADMIN_EMAIL || "info@example.com"));
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: k.priv, dsaEncoding: "ieee-p1363" });
  return head + "." + body + "." + b64u(sig);
}

function subscribe(userId, endpoint) {
  if (!/^https:\/\//.test(endpoint || "")) throw new Error("Ongeldig abonnement");
  db.prepare("INSERT INTO push(endpoint,userId,created) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET userId=excluded.userId").run(endpoint, userId, Date.now());
}
function unsubscribe(endpoint) { db.prepare("DELETE FROM push WHERE endpoint=?").run(endpoint); }

async function poke(endpoint) {
  const aud = new URL(endpoint).origin;
  const r = await fetch(endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", Authorization: `vapid t=${jwt(aud)}, k=${keys().pub}`, "Content-Length": "0" }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404 || r.status === 410) unsubscribe(endpoint);
  return r.status;
}

// Melding opslaan en het toestel van de gebruiker porren.
function notify(userId, { title, body, url }) {
  db.prepare("INSERT INTO notifs(userId,title,body,url,created) VALUES(?,?,?,?,?)").run(userId, title, body || "", url || "/", Date.now());
  const subs = db.prepare("SELECT endpoint FROM push WHERE userId=?").all(userId);
  subs.forEach(s => poke(s.endpoint).catch(() => {}));
}
function notifyRole(roles, msg) { db.prepare(`SELECT id FROM users WHERE active=1 AND role IN (${roles.map(() => "?").join(",")})`).all(...roles).forEach(u => notify(u.id, msg)); }
function notifyDriver(driverId, msg) { const u = db.prepare("SELECT id FROM users WHERE active=1 AND role='driver' AND driverId=?").get(driverId); if (u) notify(u.id, msg); }

function pending(userId) {
  const rows = db.prepare("SELECT id,title,body,url,created FROM notifs WHERE userId=? AND delivered=0 AND created>? ORDER BY id").all(userId, Date.now() - 3 * 864e5);
  if (rows.length) db.prepare(`UPDATE notifs SET delivered=1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map(r => r.id));
  return rows;
}

module.exports = { keys, subscribe, unsubscribe, notify, notifyRole, notifyDriver, pending };

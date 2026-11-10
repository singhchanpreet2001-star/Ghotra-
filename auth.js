"use strict";
// Logins: wachtwoorden met scrypt, sessies als willekeurig token in een HttpOnly-cookie.
const crypto = require("crypto");
const { db, uid } = require("./db");

const SESSION_DAYS = 45;
const OFFICE = ["admin", "dispatch"];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}
function verifyPassword(pw, stored) {
  try {
    const [, s, h] = String(stored).split("$");
    const hash = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(hash, Buffer.from(h, "hex"));
  } catch { return false; }
}

const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, driverId: u.driverId || null, active: !!u.active, created: u.created });
const isOffice = u => !!u && OFFICE.includes(u.role);

function userCount() { return db.prepare("SELECT COUNT(*) n FROM users").get().n; }
function findByEmail(email) { return db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(String(email || "").trim().toLowerCase()); }
function findById(id) { return db.prepare("SELECT * FROM users WHERE id=?").get(id); }
function listUsers() { return db.prepare("SELECT * FROM users ORDER BY role, name").all().map(publicUser); }

function validPassword(pw) { return typeof pw === "string" && pw.length >= 8; }

function createUser({ email, name, role, driverId, password }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Ongeldig e-mailadres");
  if (!["admin", "dispatch", "driver"].includes(role)) throw new Error("Ongeldige rol");
  if (!validPassword(password)) throw new Error("Wachtwoord moet minstens 8 tekens hebben");
  if (findByEmail(email)) throw new Error("Er bestaat al een login met dit e-mailadres");
  if (role === "driver" && !driverId) throw new Error("Een chauffeurslogin moet aan een chauffeur gekoppeld zijn");
  if (role === "driver" && db.prepare("SELECT 1 FROM users WHERE driverId=? AND active=1").get(driverId)) throw new Error("Deze chauffeur heeft al een login");
  const id = uid();
  db.prepare("INSERT INTO users(id,email,name,role,driverId,pass,created,active) VALUES(?,?,?,?,?,?,?,1)")
    .run(id, email, String(name || "").trim(), role, role === "driver" ? driverId : null, hashPassword(password), Date.now());
  return publicUser(findById(id));
}
function updateUser(id, { email, name, password, active }) {
  const u = findById(id); if (!u) throw new Error("Login niet gevonden");
  if (email !== undefined) {
    email = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Ongeldig e-mailadres");
    const other = findByEmail(email); if (other && other.id !== id) throw new Error("Dit e-mailadres is al in gebruik");
    db.prepare("UPDATE users SET email=? WHERE id=?").run(email, id);
  }
  if (name !== undefined) db.prepare("UPDATE users SET name=? WHERE id=?").run(String(name).trim(), id);
  if (password) { if (!validPassword(password)) throw new Error("Wachtwoord moet minstens 8 tekens hebben"); db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPassword(password), id); endSessionsFor(id); }
  if (active !== undefined) { db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, id); if (!active) endSessionsFor(id); }
  return publicUser(findById(id));
}
function deleteUser(id) { endSessionsFor(id); db.prepare("DELETE FROM push WHERE userId=?").run(id); db.prepare("DELETE FROM users WHERE id=?").run(id); }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,userId,expires) VALUES(?,?,?)").run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
function endSession(token) { db.prepare("DELETE FROM sessions WHERE token=?").run(token); }
function endSessionsFor(userId) { db.prepare("DELETE FROM sessions WHERE userId=?").run(userId); }

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function userFromReq(req) {
  const t = parseCookies(req).gs;
  if (!t) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(t);
  if (!s || s.expires < Date.now()) { if (s) endSession(t); return null; }
  const u = findById(s.userId);
  if (!u || !u.active) return null;
  return { ...publicUser(u), token: t };
}
function sessionCookie(req, token, clear) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") || process.env.COOKIE_SECURE === "1";
  return `gs=${clear ? "" : token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

// Eenvoudige rem op wachtwoorden raden: max 8 mislukte pogingen per 15 minuten per IP + e-mail.
const fails = new Map();
function tooMany(key) { const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; }
function noteFail(key) { const f = fails.get(key); if (!f || Date.now() - f.t > 15 * 60e3) fails.set(key, { n: 1, t: Date.now() }); else f.n++; }
function clearFail(key) { fails.delete(key); }

module.exports = { hashPassword, verifyPassword, publicUser, isOffice, userCount, findByEmail, findById, listUsers, createUser, updateUser, deleteUser, createSession, endSession, userFromReq, sessionCookie, tooMany, noteFail, clearFail };

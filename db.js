"use strict";
// Opslag: één SQLite-bestand (ingebouwd in Node 22). Zakelijke gegevens staan als JSON-documenten per collectie.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const FILE_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILE_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "ghotra.db"));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS records(col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(col,id));
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL, driverId TEXT, pass TEXT NOT NULL, created INTEGER, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, userId TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push(endpoint TEXT PRIMARY KEY, userId TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, title TEXT, body TEXT, url TEXT, created INTEGER, delivered INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, created INTEGER, owner TEXT);
CREATE TABLE IF NOT EXISTS positions(driverId TEXT PRIMARY KEY, lat REAL, lng REAL, acc REAL, at INTEGER, orderId TEXT);
CREATE TABLE IF NOT EXISTS geocache(q TEXT PRIMARY KEY, lat REAL, lng REAL, label TEXT);
`);

// Collecties die kantoor mag lezen en schrijven.
const COLS = ["orders", "customers", "drivers", "vehicles", "invoices", "maillog", "documents", "absences", "config"];

const uid = () => Date.now().toString(36) + require("crypto").randomBytes(5).toString("hex");

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

const q = {
  all: db.prepare("SELECT id,data FROM records WHERE col=?"),
  get: db.prepare("SELECT data FROM records WHERE col=? AND id=?"),
  put: db.prepare("INSERT INTO records(col,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated"),
  del: db.prepare("DELETE FROM records WHERE col=? AND id=?"),
};

function all(col) { return q.all.all(col).map(r => ({ ...JSON.parse(r.data), id: r.id })); }
function get(col, id) { const r = q.get.get(col, id); return r ? { ...JSON.parse(r.data), id } : null; }
function put(col, id, data) { const d = { ...data }; delete d.id; q.put.run(col, id, JSON.stringify(d), Date.now()); return { ...d, id }; }
function patch(col, id, partial) { const cur = get(col, id); if (!cur) return null; delete cur.id; return put(col, id, deepMerge(cur, partial)); }
function del(col, id) { const prev = get(col, id); q.del.run(col, id); return prev; }

function setting(k, v) {
  if (v === undefined) { const r = db.prepare("SELECT v FROM settings WHERE k=?").get(k); return r ? JSON.parse(r.v) : null; }
  db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));
  return v;
}

module.exports = { db, DATA_DIR, FILE_DIR, COLS, uid, all, get, put, patch, del, deepMerge, setting };

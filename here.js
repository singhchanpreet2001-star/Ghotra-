"use strict";
// Vrachtwagenroutes via HERE (houdt rekening met hoogte, breedte, lengte, gewicht, ADR en actuele verkeersinfo).
const { db, setting } = require("./db");

function config() { const s = setting("here") || {}; return { key: process.env.HERE_API_KEY || s.key || "" }; }
const configured = () => !!config().key;

// HERE "flexible polyline" decoderen naar [[lat,lng],...]
const TABLE = (() => { const t = {}; "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("").forEach((c, i) => t[c] = i); return t; })();
function decodePolyline(enc) {
  const vals = []; let res = 0, shift = 0;
  for (const ch of enc) { const v = TABLE[ch]; if (v === undefined) throw new Error("Ongeldige polyline"); res += (v & 31) * 2 ** shift; if (v & 32) shift += 5; else { vals.push(res); res = 0; shift = 0; } }
  const header = vals[1]; const prec = header % 16; const third = Math.floor(header / 16) % 8;
  const f = 10 ** prec, step = third ? 3 : 2, out = [];
  const signed = v => (v % 2 ? -(v + 1) / 2 : v / 2);
  let lat = 0, lng = 0;
  for (let i = 2; i + 1 < vals.length; i += step) { lat += signed(vals[i]); lng += signed(vals[i + 1]); out.push([+(lat / f).toFixed(prec), +(lng / f).toFixed(prec)]); }
  return out;
}

async function geocode(q) {
  q = String(q || "").replace(/\s+/g, " ").trim(); if (!q) return null;
  const c = db.prepare("SELECT lat,lng,label FROM geocache WHERE q=?").get(q.toLowerCase());
  if (c) return c;
  const r = await fetch(`https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(q)}&limit=1&lang=nl-BE&apiKey=${encodeURIComponent(config().key)}`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("De HERE-sleutel is ongeldig."), { code: "auth" });
  const j = await r.json().catch(() => ({}));
  const it = (j.items || [])[0]; if (!it) return null;
  const out = { lat: it.position.lat, lng: it.position.lng, label: it.address && it.address.label || q };
  db.prepare("INSERT OR REPLACE INTO geocache(q,lat,lng,label) VALUES(?,?,?,?)").run(q.toLowerCase(), out.lat, out.lng, out.label);
  return out;
}

// vehicle: {hoogte (m), breedte (m), lengte (m), massa (ton)}, adr: boolean
async function truckRoute(from, to, vehicle = {}, adr = false) {
  const p = new URLSearchParams({ transportMode: "truck", origin: `${from.lat},${from.lng}`, destination: `${to.lat},${to.lng}`, return: "polyline,summary,actions,instructions", lang: "nl-BE", departureTime: "now", apiKey: config().key });
  const cm = v => Math.round(+v * 100);
  if (+vehicle.hoogte) p.set("vehicle[height]", cm(vehicle.hoogte));
  if (+vehicle.breedte) p.set("vehicle[width]", cm(vehicle.breedte));
  if (+vehicle.lengte) p.set("vehicle[length]", cm(vehicle.lengte));
  if (+vehicle.massa) p.set("vehicle[grossWeight]", Math.round(+vehicle.massa * 1000));
  if (adr) p.set("vehicle[tunnelCategory]", "C");
  const r = await fetch("https://router.hereapi.com/v8/routes?" + p.toString(), { signal: AbortSignal.timeout(20000) });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("De HERE-sleutel is ongeldig."), { code: "auth" });
  const j = await r.json().catch(() => ({}));
  const route = (j.routes || [])[0];
  if (!route) throw Object.assign(new Error((j.notices && j.notices[0] && j.notices[0].title) || "Geen route gevonden"), { code: "no_route" });
  let coords = [], length = 0, duration = 0, base = 0; const steps = [], notices = [];
  for (const s of route.sections) {
    const pts = decodePolyline(s.polyline); const offset = coords.length;
    coords = coords.concat(pts);
    length += s.summary.length; duration += s.summary.duration; base += s.summary.baseDuration || s.summary.duration;
    (s.actions || []).forEach(a => steps.push({ text: a.instruction || a.action, length: a.length || 0, duration: a.duration || 0, at: offset + (a.offset || 0), action: a.action, direction: a.direction || "" }));
    (s.notices || []).forEach(n => notices.push({ title: n.title || n.code, code: n.code, severity: n.severity }));
  }
  return { coords, length, duration, trafficDelay: Math.max(0, duration - base), steps, notices };
}

module.exports = { config, configured, geocode, truckRoute, decodePolyline };

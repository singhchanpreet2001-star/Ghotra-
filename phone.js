"use strict";
// Jarvis aan de telefoon (via Twilio): Jarvis belt jou bij problemen, en je kunt met hem praten of hem zelf bellen.
const crypto = require("crypto");

const DEF = { aan: false, sid: "", token: "", nummer: "", gsm: "", stem: "Polly.Ruben", taal: "nl-NL", van: 6, tot: 22,
  situaties: { ziek: true, dringend: true, geenChauffeur: true, nietVertrokken: true, cmrProbleem: false } };

module.exports = function createPhone({ store, ai, TZ, publicBase }) {
  const cfg = () => { const s = store.setting("telefoon") || {}; const c = { ...DEF, ...s, situaties: { ...DEF.situaties, ...(s.situaties || {}) } };
    if (process.env.TWILIO_ACCOUNT_SID) c.sid = process.env.TWILIO_ACCOUNT_SID; if (process.env.TWILIO_AUTH_TOKEN) c.token = process.env.TWILIO_AUTH_TOKEN; return c; };
  const configured = () => { const c = cfg(); return !!(c.sid && c.token && c.nummer && c.gsm); };
  const norm = n => String(n || "").replace(/[^\d+]/g, "").replace(/^00/, "+").replace(/^0(\d{8,9})$/, "+32$1");
  const nums = () => cfg().gsm.split(/[,;]+/).map(norm).filter(n => n.length > 6);
  const allowed = from => nums().includes(norm(from));
  const xml = s => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
  const hourNow = () => +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date());

  // ---------- gesprekken ----------
  const calls = new Map(); // callId → { conv, intro, pending, answer, busy, silent, at }
  setInterval(() => { for (const [k, v] of calls) if (Date.now() - v.at > 2 * 3600e3) calls.delete(k); }, 600e3).unref();
  let tools = () => [], who = () => ({ name: "Chanpreet (telefoon)", email: "telefoon" }), onLog = () => {};
  function setup(o) { if (o.tools) tools = o.tools; if (o.who) who = o.who; if (o.onLog) onLog = o.onLog; }

  function say(text) { const c = cfg(); return `<Say voice="${xml(c.stem)}" language="${xml(c.taal)}">${xml(text)}</Say>`; }
  function listen(id, text) {
    const c = cfg(), url = `${publicBase()}/api/phone/voice?call=${encodeURIComponent(id)}`;
    return `<Response><Gather input="speech" language="${xml(c.taal)}" speechTimeout="auto" action="${xml(url)}" method="POST" actionOnEmptyResult="true">${say(text)}</Gather><Redirect method="POST">${xml(url)}&amp;stil=1</Redirect></Response>`;
  }
  const hangup = text => `<Response>${say(text)}<Hangup/></Response>`;
  const SYSTEM = () => `Je bent Jarvis, de dispatcher van transportbedrijf Ghotra Transport, en je praat aan de telefoon met de zaakvoerder. Vandaag is ${new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}.
Antwoord kort en natuurlijk zoals in een telefoongesprek: één tot drie zinnen, geen opsommingen, geen symbolen, bedragen voluit (bv. "zeshonderdvijftig euro"), tijden als "acht uur" of "half tien". Gebruik de tools en verzin niets.
Je mag op duidelijke vraag een rit toewijzen, een rit annuleren of een factuur op betaald zetten; herhaal kort wat je gaat doen en doe het pas als hij het bevestigt. Prijzen naar klanten, facturen versturen en mails sturen doe je niet: zeg dat hij dat in de app doet.
Eindig met een korte vraag als er nog iets te beslissen is.`;

  async function think(id) {
    const s = calls.get(id); if (!s || s.busy) return; s.busy = true;
    try { s.answer = (await ai.chat({ system: SYSTEM(), messages: s.conv.slice(-16), tools: tools(who()) })).replace(/[*_#`]/g, "").slice(0, 900); }
    catch (e) { s.answer = "Sorry, dat lukte niet: " + (e.message || "onbekende fout") + ". Probeer het nog eens of kijk in de app."; }
    s.conv.push({ role: "assistant", content: s.answer }); s.busy = false;
  }
  const BYE = /^(nee[ ,.]*)?(dank je|dankje|bedankt|merci|dat is alles|da's alles|tot later|tot straks|doei|daag|dag jarvis|salut|stop|niets|nee dank)/i;

  // Twilio roept dit aan bij elke stap van het gesprek. Geeft TwiML terug.
  async function voice(p, q) {
    let id = q.get("call") || "";
    if (!id) { // inkomend: alleen je eigen gsm-nummer(s)
      if (!allowed(p.From)) return hangup("Dit nummer is niet gekend. Tot ziens.");
      id = "in-" + (p.CallSid || crypto.randomBytes(6).toString("hex"));
      calls.set(id, { conv: [], at: Date.now(), silent: 0 });
      onLog(`📞 Je belde Jarvis.`);
      return listen(id, "Hallo, met Jarvis. Waarmee kan ik helpen?");
    }
    const s = calls.get(id); if (!s) return hangup("Dit gesprek is verlopen. Bel gerust opnieuw.");
    s.at = Date.now();
    if (q.get("intro") === "1") return listen(id, s.intro);
    if (q.get("wacht")) { // antwoord van de AI ophalen
      if (s.busy) return `<Response><Pause length="2"/><Redirect method="POST">${xml(`${publicBase()}/api/phone/voice?call=${encodeURIComponent(id)}&wacht=${+q.get("wacht") + 1}`)}</Redirect></Response>`;
      return listen(id, s.answer || "Ik heb geen antwoord gevonden.");
    }
    const heard = String(p.SpeechResult || "").trim();
    if (!heard) { s.silent++; return s.silent >= 2 ? hangup("Ik hoor niets meer. Ik leg in, tot later.") : listen(id, "Ben je er nog? Zeg maar wat ik moet doen."); }
    s.silent = 0;
    if (BYE.test(heard)) return hangup("Oké, tot later.");
    s.conv.push({ role: "user", content: heard }); s.answer = ""; think(id);
    return `<Response>${say("Momentje.")}<Redirect method="POST">${xml(`${publicBase()}/api/phone/voice?call=${encodeURIComponent(id)}&wacht=1`)}</Redirect></Response>`;
  }

  // Handtekening van Twilio controleren (zodat niemand anders je Jarvis kan aansturen).
  function validSignature(url, params, sig) {
    const c = cfg(); if (!c.token || !sig) return false;
    const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
    const expect = crypto.createHmac("sha1", c.token).update(Buffer.from(data, "utf-8")).digest("base64");
    const a = Buffer.from(expect), b = Buffer.from(String(sig));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- Jarvis belt jou ----------
  async function dial(text, why) {
    const c = cfg(); if (!configured()) throw Object.assign(new Error("Telefoon is nog niet ingesteld"), { status: 409 });
    const to = nums()[0]; if (!to) throw Object.assign(new Error("Vul je gsm-nummer in"), { status: 400 });
    const id = "out-" + crypto.randomBytes(8).toString("hex");
    const intro = `Hallo, met Jarvis van Ghotra. ${text} Wat wil je dat ik doe?`;
    calls.set(id, { conv: [{ role: "assistant", content: intro }], intro, at: Date.now(), silent: 0 });
    const body = new URLSearchParams({ To: to, From: norm(c.nummer), Url: `${publicBase()}/api/phone/voice?call=${id}&intro=1`, Method: "POST", Timeout: "30" });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Calls.json`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(c.sid + ":" + c.token).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Twilio weigerde de oproep (${r.status}): ${j.message || "onbekende fout"}`), { status: 502 });
    onLog(`📞 Jarvis belde je: ${text}`);
    return { ok: true, sid: j.sid, why };
  }
  // Probleem melden: bundelt meldingen en belt hooguit om de 10 minuten.
  let queue = [], timer = null, last = 0;
  function alert(soort, text) {
    const c = cfg(); if (!c.aan || !configured() || !c.situaties[soort]) return false;
    const h = hourNow(); if (soort !== "ziek" && (h < c.van || h >= c.tot)) return false;
    queue.push(text.replace(/^🔴\s*/, "").replace(/[^\p{L}\p{N}\s.,:;!?€()'’-]/gu, ""));
    const go = () => { timer = null; const items = queue.splice(0); if (!items.length) return; last = Date.now();
      const text = items.length === 1 ? items[0] : `Er zijn ${items.length} dingen. ` + items.map((t, i) => `${i + 1}: ${t}`).join(" ");
      dial(text.slice(0, 700), soort).catch(e => onLog(`📞 Bellen lukte niet: ${e.message}`, true)); };
    if (!timer) timer = setTimeout(go, Math.max(20000, 600e3 - (Date.now() - last)));
    return true;
  }
  return { cfg, configured, voice, validSignature, dial, alert, setup, DEF };
};

"use strict";
// AI via de Anthropic API: opdracht-PDF uitlezen, CMR controleren, assistent.
const { setting } = require("./db");

function config() {
  const s = setting("ai") || {};
  return { key: process.env.ANTHROPIC_API_KEY || s.key || "", model: process.env.ANTHROPIC_MODEL || s.model || "claude-sonnet-5-5", version: process.env.ANTHROPIC_VERSION || "2023-06-01" };
}
const configured = () => !!config().key;

async function call({ system, messages, tools, maxTokens = 2000 }) {
  const c = config();
  if (!c.key) throw Object.assign(new Error("AI is nog niet ingesteld"), { code: "not_configured" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": c.version },
    body: JSON.stringify({ model: c.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages, ...(tools ? { tools } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || ("HTTP " + r.status);
    throw Object.assign(new Error(r.status === 401 ? "De AI-sleutel is ongeldig." : r.status === 429 ? "Even te veel AI-aanvragen; probeer zo opnieuw." : "AI-fout: " + msg), { code: r.status === 401 ? "auth" : "ai_error" });
  }
  return j;
}
const textOf = j => (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
function jsonOf(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("AI gaf geen bruikbaar antwoord");
  return JSON.parse(s.slice(a, b + 1));
}
function fileBlock(buf, type) {
  const data = buf.toString("base64");
  if (type === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  const mt = /png/.test(type) ? "image/png" : /webp/.test(type) ? "image/webp" : /gif/.test(type) ? "image/gif" : "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mt, data } };
}

const ORDER_SCHEMA = `{"isOpdracht":boolean,"klantNaam":string,"klantEmail":string,"klantBtw":string,"klantAdres":string,"referentieKlant":string,"laadplaats":string,"laadadres":string,"laaddatum":string,"losplaats":string,"losadres":string,"losdatum":string,"goederen":string,"colli":number|null,"gewicht":number|null,"adr":boolean,"prijs":number|null,"wachtTarief":number|null,"vrijeUren":number|null,"notities":string}`;

async function orderFromFile({ buf, type, name, company, today, sender, subject, body }) {
  const prompt = `Je leest een transportopdracht (vrachtorder) die bij transportbedrijf ${company} binnenkwam. Haal de ritgegevens eruit.
Antwoord met alleen JSON volgens dit schema, zonder andere tekst:
${ORDER_SCHEMA}
Regels:
- isOpdracht = true alleen als dit document echt een transportopdracht/vrachtorder of boekingsbevestiging voor een rit is. Bij een factuur, CMR, offerte-aanvraag, nieuwsbrief, prijslijst of ander document: false.
- klant = de opdrachtgever die de vracht bestelt en betaalt, niet de laad- of losplaats en niet ${company} zelf.
- laadplaats/losplaats kort als "Stad, landcode" (bv. "Antwerpen, BE"); laadadres/losadres volledig met bedrijfsnaam, straat, postcode en plaats.
- datums als YYYY-MM-DDTHH:MM in lokale tijd; is alleen een dag bekend, gebruik 08:00 voor laden en 17:00 voor lossen. Onbekend: "". Vandaag is ${today}.
- gewicht in kg, prijs = afgesproken vrachtprijs excl. btw in euro. Onbekend: null.
- adr true bij gevaarlijke stoffen, ADR-klasse of UN-nummer.
- wachtTarief = vergoeding per uur wachttijd/standgeld als die vermeld staat; vrijeUren = gratis laad- of lostijd in uren als vermeld (bv. "2 uur vrij"). Onbekend: null.
- notities: tijdvensters, laad-/losreferenties, bijzondere instructies (kort).
${sender ? "Afzender van de mail: " + sender + "\n" : ""}${subject ? "Onderwerp: " + subject + "\n" : ""}${body ? "Mailtekst:\n" + String(body).slice(0, 3000) + "\n" : ""}Bestand: ${name}`;
  const j = await call({ messages: [{ role: "user", content: buf ? [fileBlock(buf, type), { type: "text", text: prompt }] : [{ type: "text", text: prompt }] }], maxTokens: 1500 });
  return jsonOf(textOf(j));
}

// Elke binnenkomende mail sorteren: is het een ritorder, is het dringend?
async function triageMail({ from, fromName, subject, text, attachments, company, today, klanten }) {
  const prompt = `Je bent de dispatcher van transportbedrijf ${company}. Sorteer deze binnenkomende mail. Vandaag is ${today}.
Antwoord met alleen JSON: {"soort":"ritorder"|"ritwijziging"|"prijsvraag"|"vraag"|"factuur"|"administratie"|"reclame"|"anders","dringend":boolean,"annulering":boolean,"reden":string,"samenvatting":string,"ref":string}
- "ritorder": een vaste, bevestigde transportopdracht of boeking voor ons (in een PDF-bijlage of in de mailtekst zelf), met een afgesproken prijs of zonder vraag over de prijs.
- "prijsvraag": de klant vraagt wat wij vragen voor een transport (offerte-aanvraag), of stelt zelf een prijs voor en vraagt of wij akkoord gaan, of onderhandelt over de prijs. Elke mail waarin ons akkoord op een prijs gevraagd wordt is een prijsvraag, ook met een vrachtorder in bijlage.
- "ritwijziging": een wijziging, annulering of uitstel van een bestaande rit; zet in "ref" de ritreferentie (onze R-… of die van de klant) als die vermeld staat. annulering = true alleen als de rit helemaal niet meer doorgaat.
- "vraag": andere vraag van een klant of chauffeur (geen prijsvraag).
- "factuur": factuur, creditnota, betaling of aanmaning (van of aan ons).
- "administratie": overheid, verzekering, bank, leasing, leverancier, boekhouder.
- "reclame": nieuwsbrief, marketing, automatische meldingen zonder actie.
- dringend = true alleen als er vandaag of morgen actie nodig is: spoedrit, wijziging of annulering van een rit voor vandaag/morgen, klacht, schade, ongeval, chauffeur in nood, douane/politie/blokkade, laatste aanmaning, deadline vandaag. Reclame en gewone facturen zijn nooit dringend.
- reden: waarom dringend (kort, leeg als niet dringend). samenvatting: één korte Nederlandse zin.
Bekende klanten: ${(klanten || []).slice(0, 80).join(", ") || "(nog geen)"}
Van: ${fromName || ""} <${from || ""}>
Onderwerp: ${subject || ""}
Bijlagen: ${(attachments || []).join(", ") || "geen"}
Tekst:
${String(text || "").slice(0, 4000)}`;
  const r = jsonOf(textOf(await call({ messages: [{ role: "user", content: prompt }], maxTokens: 400 })));
  const S = ["ritorder", "ritwijziging", "prijsvraag", "vraag", "factuur", "administratie", "reclame", "anders"];
  return { soort: S.includes(r.soort) ? r.soort : "anders", dringend: !!r.dringend && r.soort !== "reclame", annulering: r.soort === "ritwijziging" && !!r.annulering, reden: String(r.reden || ""), samenvatting: String(r.samenvatting || ""), ref: String(r.ref || "") };
}

async function checkCmr({ buf, type, order }) {
  const o = order;
  const prompt = `Dit is een foto of scan van een CMR-vrachtbrief na levering. Controleer hem voor facturatie.
Verwachte rit: ref ${o.ref}${o.referentieKlant ? " (klantref. " + o.referentieKlant + ")" : ""}, van ${o.laadplaats} naar ${o.losplaats}, geladen ${String(o.laaddatum || "").slice(0, 10)}, lading "${o.goederen || "?"}", ${o.colli || "?"} colli, ${o.gewicht || "?"} kg.
Let op: vak 24 (ontvangst door geadresseerde: handtekening/stempel en datum), vak 18 en 24 voor voorbehoud (schade, tekort, opmerkingen), aantallen (vak 7) en gewicht (vak 11), en of laad- en losplaats overeenkomen.
Antwoord met alleen JSON:
{"leesbaar":boolean,"ontvangstGetekend":boolean,"ontvanger":string,"datumOntvangst":string,"voorbehoud":string,"colliOpCmr":string,"gewichtOpCmr":string,"komtOvereen":boolean,"verschillen":string,"conclusie":"ok"|"controleren","samenvatting":string}
"conclusie" is alleen "ok" als de CMR leesbaar is, getekend is voor ontvangst, er geen voorbehoud is en de gegevens overeenkomen. "samenvatting": één korte Nederlandse zin. Laat "verschillen" en "voorbehoud" leeg als er geen zijn.`;
  const j = await call({ messages: [{ role: "user", content: [fileBlock(buf, type), { type: "text", text: prompt }] }], maxTokens: 800 });
  const r = jsonOf(textOf(j));
  return { conclusie: r.conclusie === "ok" ? "ok" : "controleren", samenvatting: String(r.samenvatting || ""), verschillen: String(r.verschillen || ""), voorbehoud: String(r.voorbehoud || ""),
    ontvangstGetekend: !!r.ontvangstGetekend, datumOntvangst: String(r.datumOntvangst || ""), ontvanger: String(r.ontvanger || ""), at: new Date().toISOString() };
}

// Assistent met tools die in de server draaien (alleen lezen).
const WEB = (max = 5) => ({ type: "web_search_20250305", name: "web_search", max_uses: max, user_location: { type: "approximate", country: "BE", timezone: "Europe/Brussels" } });
async function chat({ system, messages, tools, web = false }) {
  const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })).concat(web ? [WEB(4)] : []);
  const conv = messages.map(m => ({ role: m.role, content: String(m.content) }));
  for (let round = 0; round < 6; round++) {
    const j = await call({ system, messages: conv, tools: defs, maxTokens: 1500 });
    if (j.stop_reason === "pause_turn") { conv.push({ role: "assistant", content: j.content }); continue; }
    if (j.stop_reason !== "tool_use") return textOf(j) || "(geen antwoord)";
    conv.push({ role: "assistant", content: j.content });
    const results = [];
    for (const b of j.content.filter(x => x.type === "tool_use")) {
      const t = tools.find(x => x.name === b.name);
      let out;
      try { out = t ? await t.execute(b.input || {}) : { fout: "onbekende tool" }; } catch (e) { out = { fout: String(e.message || e) }; }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 30000) });
    }
    conv.push({ role: "user", content: results });
  }
  return "Dat duurde te lang. Stel je vraag iets specifieker.";
}

// Korte tekst schrijven zonder tools (voor de updates van Jarvis).
async function write({ system, prompt, maxTokens = 600 }) { return textOf(await call({ system, messages: [{ role: "user", content: prompt }], maxTokens })); }

// Op het internet zoeken (bv. onderaannemers of nieuwe klanten). Geeft het JSON-antwoord en de bronnen terug.
async function research({ system, prompt, maxUses = 6 }) {
  const messages = [{ role: "user", content: prompt }], sources = new Map();
  for (let i = 0; i < 5; i++) {
    const j = await call({ system, messages, tools: [WEB(maxUses)], maxTokens: 4000 });
    for (const b of j.content || []) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) sources.set(r.url, r.title || r.url);
    if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: j.content }); continue; }
    const text = textOf(j); let data = null; try { data = jsonOf(text); } catch { data = null; }
    return { text, data, sources: [...sources].map(([url, title]) => ({ url, title })) };
  }
  throw new Error("Zoeken duurde te lang");
}

module.exports = { config, configured, orderFromFile, triageMail, checkCmr, chat, write, research };

"use strict";
// Eenvoudige PDF-maker op de server (Helvetica, A4), zodat Atlas facturen kan versturen zonder browser.

const W = {
  n: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  b: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
};
// Tekst naar WinAnsi (de codering van de standaardlettertypes).
const MAP = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
function enc(s) {
  s = String(s ?? "").replace(/→/g, "->").replace(/[  ]/g, " ");
  const out = [];
  for (const ch of s) { const c = ch.codePointAt(0); if (MAP[ch]) out.push(MAP[ch]); else if (c < 256) out.push(c); else out.push(63); }
  return out;
}
function width(s, size, bold) { const t = bold ? W.b : W.n; return enc(s).reduce((a, c) => a + (c >= 32 && c <= 126 ? t[c - 32] : 556), 0) * size / 1000; }
function esc(bytes) { return bytes.map(c => c === 40 || c === 41 || c === 92 ? "\\" + String.fromCharCode(c) : c < 32 || c > 126 ? "\\" + c.toString(8).padStart(3, "0") : String.fromCharCode(c)).join(""); }
function wrap(s, maxW, size, bold) {
  const out = [];
  for (const para of String(s ?? "").split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + " " + w : w;
      if (width(t, size, bold) <= maxW || !line) line = t; else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

class Doc {
  constructor() { this.pages = []; this.add(); }
  add() { this.cur = []; this.pages.push(this.cur); }
  // mm-coördinaten (oorsprong linksboven), zoals jsPDF.
  text(s, x, y, { size = 10, bold = false, align = "left", color = [17, 17, 17] } = {}) {
    let px = x * 2.83465; const py = (297 - y) * 2.83465;
    const w = width(s, size, bold); if (align === "right") px -= w; else if (align === "center") px -= w / 2;
    this.cur.push(`BT ${color.map(c => (c / 255).toFixed(3)).join(" ")} rg /${bold ? "F2" : "F1"} ${size} Tf ${px.toFixed(2)} ${py.toFixed(2)} Td (${esc(enc(s))}) Tj ET`);
  }
  rect(x, y, w, h, { fill = null, stroke = null } = {}) {
    const k = 2.83465, c = v => v.map(n => (n / 255).toFixed(3)).join(" ");
    this.cur.push(`${fill ? c(fill) + " rg " : ""}${stroke ? c(stroke) + " RG 0.5 w " : ""}${(x * k).toFixed(2)} ${((297 - y - h) * k).toFixed(2)} ${(w * k).toFixed(2)} ${(h * k).toFixed(2)} re ${fill && stroke ? "B" : fill ? "f" : "S"}`);
  }
  line(x1, y1, x2, y2, color = [220, 220, 220]) { const k = 2.83465; this.cur.push(`${color.map(n => (n / 255).toFixed(3)).join(" ")} RG 0.5 w ${(x1 * k).toFixed(2)} ${((297 - y1) * k).toFixed(2)} m ${(x2 * k).toFixed(2)} ${((297 - y2) * k).toFixed(2)} l S`); }
  output() {
    const objs = [];
    const fonts = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
    // 1 catalog, 2 pages, 3-4 fonts, dan per pagina: page + content
    const n = this.pages.length, pageIds = this.pages.map((_, i) => 5 + i * 2);
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map(i => i + " 0 R").join(" ")}] /Count ${n} >>`;
    objs[3] = fonts[0]; objs[4] = fonts[1];
    this.pages.forEach((p, i) => {
      const content = Buffer.from(p.join("\n"), "latin1");
      objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
      objs[6 + i * 2] = Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]);
    });
    const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")]; const offs = []; let len = parts[0].length;
    for (let i = 1; i < objs.length; i++) {
      offs[i] = len; const body = Buffer.isBuffer(objs[i]) ? objs[i] : Buffer.from(objs[i], "latin1");
      const b = Buffer.concat([Buffer.from(`${i} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]); parts.push(b); len += b.length;
    }
    const xref = [`xref\n0 ${objs.length}\n0000000000 65535 f \n`, ...offs.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n")].join("");
    parts.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}

// Factuur in dezelfde opmaak als in de kantoor-app.
function invoicePdf(i, { bedrijf: b = {}, klant: k = {}, lines = [], fdate = s => s, eur = n => n, ogm = "" } = {}) {
  const d = new Doc(), orange = [194, 65, 12];
  d.text(b.naam || "Ghotra Transport", 15, 20, { size: 16, bold: true });
  d.text("FACTUUR", 195, 20, { size: 22, bold: true, align: "right", color: orange });
  let y = 26;
  (b.adres || "").split("\n").concat([b.btw ? "Btw " + b.btw : "", b.email || "", b.tel || ""]).filter(Boolean).forEach(l => { d.text(l, 15, y, { size: 9.5 }); y += 4.5; });
  ["Nr. " + i.nr, "Datum " + fdate(i.datum), "Vervaldatum " + fdate(i.vervaldatum)].forEach((l, n) => d.text(l, 195, 27 + n * 4.5, { size: 9.5, align: "right" }));
  y = Math.max(y, 40) + 6; const ky = y;
  d.rect(15, y, 95, 30, { stroke: [210, 210, 210] });
  d.text("FACTUUR AAN", 19, y + 5, { size: 8, color: [120, 120, 120] });
  d.text(k.naam || "", 19, y + 10.5, { size: 10, bold: true });
  let yy = y + 15.5; (k.adres || "").split("\n").concat([k.btw ? "Btw " + k.btw : ""]).filter(Boolean).slice(0, 3).forEach(l => { d.text(l, 19, yy, { size: 9.5 }); yy += 4.5; });
  y = ky + 38; d.rect(15, y, 180, 8, { fill: [243, 243, 243] });
  d.text("Omschrijving", 18, y + 5.5, { size: 9.5, bold: true }); d.text("Bedrag", 192, y + 5.5, { size: 9.5, bold: true, align: "right" }); y += 12;
  for (const l of lines) {
    const t = wrap(l.omschrijving, 140 * 2.83465, 9.5);
    if (y + t.length * 4.6 > 265) { d.add(); y = 20; }
    t.forEach((s, n) => d.text(s, 18, y + n * 4.6, { size: 9.5 }));
    d.text(eur(l.bedrag), 192, y, { size: 9.5, align: "right" });
    y += t.length * 4.6 + 3; d.line(15, y - 1.5, 195, y - 1.5, [235, 235, 235]); y += 2;
  }
  y += 4;
  const row = (a, v, bold) => { d.text(a, 150, y, { size: 9.5, bold, align: "right" }); d.text(eur(v), 192, y, { size: 9.5, bold, align: "right" }); y += 6; };
  row("Subtotaal", i.subtotaal); row(i.btw === "21" ? "Btw 21%" : i.btw === "0v" ? "Btw verlegd" : "Vrijgesteld", i.btwBedrag);
  d.line(120, y - 3.5, 195, y - 3.5, [17, 17, 17]); row("Totaal", i.totaal, true);
  y += 6;
  const pay = wrap(`Gelieve ${eur(i.totaal)} te betalen voor ${fdate(i.vervaldatum)}${b.iban ? " op rekening " + b.iban : ""} met mededeling ${i.ogm || ogm}.`, 170 * 2.83465, 9.5);
  d.rect(15, y, 180, pay.length * 4.8 + 6, { fill: [255, 247, 237] });
  pay.forEach((s, n) => d.text(s, 19, y + 5.5 + n * 4.8, { size: 9.5 })); y += pay.length * 4.8 + 12;
  if (i.btw === "0v") d.text("Btw verlegd: de btw is verschuldigd door de medecontractant (art. 196 Richtlijn 2006/112/EG).", 15, y, { size: 8, color: [90, 90, 90] });
  if (i.btw === "0x") d.text("Vrijgesteld van btw: internationaal goederenvervoer.", 15, y, { size: 8, color: [90, 90, 90] });
  return d.output();
}

module.exports = { Doc, invoicePdf, wrap, width };

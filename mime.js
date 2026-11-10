"use strict";
// MIME: e-mails uit elkaar halen (tekst + bijlagen) en nieuwe e-mails samenstellen.
const crypto = require("crypto");

function decodeCharset(buf, cs) {
  cs = String(cs || "utf-8").toLowerCase().replace(/^"|"$/g, "");
  if (cs === "us-ascii" || cs === "ascii") cs = "utf-8";
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
function decodeWords(s) {
  return String(s || "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (m, cs, enc, t) => {
    try {
      const buf = enc.toUpperCase() === "B" ? Buffer.from(t, "base64")
        : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return decodeCharset(buf, cs);
    } catch { return t; }
  });
}
function qpDecode(s) { return Buffer.from(String(s).replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), "latin1"); }

function parseHeaders(head) {
  const h = {};
  head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach(l => { const i = l.indexOf(":"); if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = l.slice(i + 1).trim(); } });
  return h;
}
function param(h, name) {
  if (!h) return "";
  // RFC 2231: name*=utf-8''... of name*0*=...
  const parts = [];
  const re = new RegExp("(?:^|;)\\s*" + name + "\\*(\\d+)?(\\*)?\\s*=\\s*(\"[^\"]*\"|[^;]+)", "gi");
  let m; while ((m = re.exec(h))) parts.push({ n: +(m[1] || 0), enc: !!m[2] || !m[1], v: m[3].trim().replace(/^"|"$/g, "") });
  if (parts.length) {
    parts.sort((a, b) => a.n - b.n);
    const v = parts.map(p => p.v).join("");
    const mm = /^([^']*)'[^']*'(.*)$/.exec(v);
    const raw = mm ? mm[2] : v, cs = (mm && mm[1]) || "utf-8";
    return decodeCharset(Buffer.from(raw.replace(/%([0-9A-F]{2})/gi, (x, hh) => String.fromCharCode(parseInt(hh, 16))), "latin1"), cs);
  }
  const m2 = new RegExp("(?:^|;)\\s*" + name + "\\s*=\\s*(\"([^\"]*)\"|[^;]+)", "i").exec(h);
  return m2 ? decodeWords((m2[2] ?? m2[1]).trim()) : "";
}

function htmlToText(html) {
  return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// raw: Buffer met het volledige bericht
function parseMessage(raw) {
  const str = raw.toString("latin1");
  const out = { headers: {}, text: "", html: "", attachments: [] };
  let idx = 0;
  (function walk(part, top) {
    const sep = part.search(/\r?\n\r?\n/);
    const head = sep < 0 ? part : part.slice(0, sep);
    const body = sep < 0 ? "" : part.slice(sep).replace(/^\r?\n\r?\n/, "");
    const h = parseHeaders(head);
    if (top) out.headers = h;
    const ct = h["content-type"] || "text/plain";
    const type = ct.split(";")[0].trim().toLowerCase();
    const te = (h["content-transfer-encoding"] || "").toLowerCase();
    if (type.startsWith("multipart/")) {
      const bd = param(ct, "boundary"); if (!bd) return;
      const segs = body.split("--" + bd);
      segs.slice(1).forEach(seg => { if (seg.startsWith("--")) return; walk(seg.replace(/^\r?\n/, ""), false); });
      return;
    }
    if (type === "message/rfc822") { walk(body, false); return; }
    const bytes = te === "base64" ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64") : te === "quoted-printable" ? qpDecode(body) : Buffer.from(body, "latin1");
    const disp = h["content-disposition"] || "";
    const name = param(disp, "filename") || param(ct, "name");
    const isAtt = /^attachment/i.test(disp) || (name && !/^text\/(plain|html)$/.test(type)) || (!type.startsWith("text/") && type !== "multipart/alternative");
    if (isAtt) { out.attachments.push({ idx: idx++, name: name || ("bijlage-" + idx + (type === "application/pdf" ? ".pdf" : "")), type, size: bytes.length, bytes }); return; }
    const text = decodeCharset(bytes, param(ct, "charset"));
    if (type === "text/html") { if (!out.html) out.html = text; } else if (!out.text) out.text = text;
  })(str, true);
  if (!out.text && out.html) out.text = htmlToText(out.html);
  return out;
}

function parseAddress(v) {
  const s = decodeWords(v || "");
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(s);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: "", email: s.trim().toLowerCase() };
}

// ---------- samenstellen ----------
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf-8").toString("base64") + "?=";
const b64lines = buf => buf.toString("base64").replace(/.{1,76}/g, "$&\r\n");
function buildMessage({ from, fromName, to, cc, subject, text, html, attachments, inReplyTo, references }) {
  const bd = "=_ghotra_" + crypto.randomBytes(12).toString("hex");
  const alt = "=_alt_" + crypto.randomBytes(12).toString("hex");
  const domain = String(from).split("@")[1] || "ghotra.local";
  const msgId = `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString("hex")}@${domain}>`;
  const h = [
    `From: ${fromName ? `${encWord(fromName)} <${from}>` : from}`,
    `To: ${to.join(", ")}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encWord(subject || "")}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${msgId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${bd}"`,
  ];
  let body = `--${bd}\r\n`;
  if (html) {
    body += `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(text || "", "utf-8"))}--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(html, "utf-8"))}--${alt}--\r\n`;
  } else {
    body += `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(text || "", "utf-8"))}`;
  }
  for (const a of attachments || []) {
    const fn = String(a.filename || "bijlage").replace(/["\r\n]/g, "");
    body += `--${bd}\r\nContent-Type: ${a.mime || "application/octet-stream"}; name="${encWord(fn)}"\r\nContent-Disposition: attachment; filename="${encWord(fn)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(a.bytes)}`;
  }
  body += `--${bd}--\r\n`;
  return { raw: h.join("\r\n") + "\r\n\r\n" + body, messageId: msgId };
}

module.exports = { parseMessage, parseHeaders, parseAddress, decodeWords, buildMessage, htmlToText };

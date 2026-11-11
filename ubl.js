"use strict";
// Peppol BIS Billing 3.0 (UBL) op de server, gelijk aan de versie in de kantoor-app.
const xmlEsc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const amt = n => (Math.round((+n || 0) * 100) / 100).toFixed(2);
const vatDigits = b => String(b || "").replace(/[^0-9]/g, "");
function splitAdres(a, btw) {
  const lines = String(a || "").split(/\n|,\s*/).map(x => x.trim()).filter(Boolean); let pc = "", city = "", street = lines[0] || "";
  for (const l of lines) { const m = /^(?:[A-Z]{1,2}-)?(\d{4,5})\s+(.+)$/.exec(l); if (m) { pc = m[1]; city = m[2]; if (l === street) street = ""; } }
  return { street, pc, city, country: String(btw || "BE").replace(/\s/g, "").slice(0, 2).toUpperCase() || "BE" };
}
function partyXml(name, adres, btw) {
  const a = splitAdres(adres, btw), v = String(btw || "").replace(/[\s.]/g, "").toUpperCase(), kbo = vatDigits(v);
  return `<cac:Party><cbc:EndpointID schemeID="0208">${xmlEsc(kbo)}</cbc:EndpointID><cac:PartyName><cbc:Name>${xmlEsc(name)}</cbc:Name></cac:PartyName><cac:PostalAddress>${a.street ? `<cbc:StreetName>${xmlEsc(a.street)}</cbc:StreetName>` : ""}${a.city ? `<cbc:CityName>${xmlEsc(a.city)}</cbc:CityName>` : ""}${a.pc ? `<cbc:PostalZone>${xmlEsc(a.pc)}</cbc:PostalZone>` : ""}<cac:Country><cbc:IdentificationCode>${xmlEsc(a.country)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${xmlEsc(v)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(name)}</cbc:RegistrationName><cbc:CompanyID schemeID="0208">${xmlEsc(kbo)}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party>`;
}
function taxCat(btw) { if (btw === "21") return { id: "S", pct: "21", reason: "" }; if (btw === "0v") return { id: "AE", pct: "0", reason: "Btw verlegd – medecontractant" }; return { id: "E", pct: "0", reason: "Vrijgesteld – internationaal goederenvervoer" }; }
function problems(b, k) {
  const p = [];
  if (!vatDigits(b.btw)) p.push("btw-nummer van je bedrijf"); if (!b.adres) p.push("adres van je bedrijf"); if (!b.iban) p.push("IBAN van je bedrijf");
  if (!vatDigits(k.btw)) p.push("btw-nummer van de klant"); if (!k.adres) p.push("adres van de klant"); return p;
}
// atts: [{id, description, filename, mime, bytes}]
function xml(i, { bedrijf: b = {}, klant: k = {}, lines = [], totals, ogm = "", refs = [], atts = [] }) {
  const tc = taxCat(i.btw), t = totals, cat = `<cbc:ID>${tc.id}</cbc:ID><cbc:Percent>${tc.pct}</cbc:Percent>`;
  const docs = atts.map(a => `<cac:AdditionalDocumentReference><cbc:ID>${xmlEsc(a.id)}</cbc:ID><cbc:DocumentDescription>${xmlEsc(a.description)}</cbc:DocumentDescription><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="${a.mime}" filename="${xmlEsc(a.filename)}">${Buffer.from(a.bytes).toString("base64")}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${xmlEsc(i.nr)}</cbc:ID>
<cbc:IssueDate>${xmlEsc(i.datum)}</cbc:IssueDate>
<cbc:DueDate>${xmlEsc(i.vervaldatum)}</cbc:DueDate>
<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
${tc.reason ? `<cbc:Note>${xmlEsc(tc.reason)}</cbc:Note>\n` : ""}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cbc:BuyerReference>${xmlEsc(refs.join(", ") || i.nr)}</cbc:BuyerReference>
${docs.join("\n")}
<cac:AccountingSupplierParty>${partyXml(b.naam || "Ghotra Transport", b.adres, b.btw)}</cac:AccountingSupplierParty>
<cac:AccountingCustomerParty>${partyXml(k.naam || "", k.adres, k.btw)}</cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode name="Overschrijving">30</cbc:PaymentMeansCode><cbc:PaymentID>${xmlEsc(i.ogm || ogm)}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${xmlEsc(String(b.iban || "").replace(/\s/g, ""))}</cbc:ID><cbc:Name>${xmlEsc(b.naam || "")}</cbc:Name></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:PaymentTerms><cbc:Note>Betaling binnen ${xmlEsc(i.termijn || 30)} dagen, uiterlijk ${xmlEsc(i.vervaldatum)}</cbc:Note></cac:PaymentTerms>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${amt(t.btwBedrag)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${amt(t.btwBedrag)}</cbc:TaxAmount><cac:TaxCategory>${cat}${tc.reason ? `<cbc:TaxExemptionReason>${xmlEsc(tc.reason)}</cbc:TaxExemptionReason>` : ""}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${amt(t.totaal)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${amt(t.totaal)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines.map((l, n) => `<cac:InvoiceLine><cbc:ID>${n + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">${amt(l.bedrag)}</cbc:LineExtensionAmount><cac:Item><cbc:Description>${xmlEsc(l.omschrijving)}</cbc:Description><cbc:Name>${xmlEsc(String(l.omschrijving).split(" · ")[0].slice(0, 100))}</cbc:Name><cac:ClassifiedTaxCategory>${cat}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${amt(l.bedrag)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join("\n")}
</Invoice>`;
}
module.exports = { xml, problems, isBE: k => /^BE/i.test(String((k || {}).btw || "").replace(/\s/g, "")) };

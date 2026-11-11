
"use strict";
/* ---------- basics ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const eur=n=>new Intl.NumberFormat("nl-BE",{style:"currency",currency:"EUR"}).format(+n||0);
const r2=n=>Math.round((+n||0)*100)/100;
const z=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate());
const TODAY=()=>ymd(new Date());
const dateOf=s=>s?String(s).slice(0,10):"";
const hm=s=>s&&s.length>10?s.slice(11,16):"";
const fdate=s=>s?new Date(s.length>10?s:s+"T12:00").toLocaleDateString("nl-BE",{day:"numeric",month:"short",year:"numeric"}):"—";
const fdt=s=>s?new Date(s).toLocaleString("nl-BE",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—";
const ftime=s=>s?new Date(s).toLocaleString("nl-BE",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"";
const daysUntil=s=>Math.round((new Date(s+"T00:00")-new Date(TODAY()+"T00:00"))/864e5);
const addDays=(s,n)=>{const d=new Date(s+"T12:00");d.setDate(d.getDate()+n);return ymd(d)};
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const isMail=s=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
const splitMails=s=>String(s||"").split(/[,;\s]+/).map(x=>x.trim()).filter(Boolean);
function b64bytes(u8){let s="";for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s)}
const blobUrl=id=>"/api/files/"+encodeURIComponent(id);
const fsize=n=>n>1e6?(n/1e6).toFixed(1)+" MB":Math.max(1,Math.round(n/1e3))+" kB";

const FLOW=["Gepland","Naar laadplaats","Laden","Naar losplaats","Lossen","Gelost"];
const ACTIVE=["Naar laadplaats","Laden","Naar losplaats","Lossen"];
const STAT=[...FLOW,"Gefactureerd","Geannuleerd"];
const LEGACY={Geladen:"Laden",Onderweg:"Naar losplaats"};
const sCls=s=>"s-"+String(s||"").toLowerCase().replace(/\s/g,"");
const COLS=["orders","customers","drivers","vehicles","invoices","maillog","documents","absences"];
const DOCCAT=["Vergunning","Verzekering","CMR-verzekering","Kentekenbewijs","Keuring","Contract","Boekhouding","Overig"];

const S={orders:[],customers:[],drivers:[],vehicles:[],invoices:[],maillog:[],documents:[],absences:[],bedrijf:{},cal:{mode:"maand",y:new Date().getFullYear(),m:new Date().getMonth(),driver:""},
  loaded:{},dbState:"wait",dbErr:null,slow:false,
  view:"vandaag",rFilter:"komend",rQuery:"",fFilter:"open",
  mail:{state:"idle",threads:[],q:"",box:"inbox",unread:false,err:null,next:null,label:"Inbox"},me:null,users:[],positions:[],status:{},settings:null,sheet:null,
  ai:{open:false,turns:[],busy:false}};
let db=true,mcp=false,downloads=true,assets=true,sample=false;

/* ---------- lookups ---------- */
const byId=(col,id)=>S[col].find(x=>x.id===id);
const klant=o=>byId("customers",o.klantId);
const chauffeur=o=>byId("drivers",o.chauffeurId);
const voertuig=o=>byId("vehicles",o.voertuigId);
function invStatus(i){if(i.status==="Betaald")return"Betaald";if(i.status==="Concept")return"Concept";return i.vervaldatum&&daysUntil(i.vervaldatum)<0?"Te laat":"Open"}
function nextRef(){const d=new Date(),p="R-"+String(d.getFullYear()).slice(2)+z(d.getMonth()+1)+"-";
  const n=S.orders.filter(o=>(o.ref||"").startsWith(p)).map(o=>+o.ref.slice(p.length)||0);return p+String((n.length?Math.max(...n):0)+1).padStart(3,"0")}
function nextInvNr(){const y=new Date().getFullYear(),p="F"+y+"-";
  const n=S.invoices.filter(i=>(i.nr||"").startsWith(p)).map(i=>+i.nr.slice(p.length)||0);return p+String((n.length?Math.max(...n):0)+1).padStart(4,"0")}
/* Belgische gestructureerde mededeling +++123/4567/89012+++ */
function ogm(nr){const d=String(nr).replace(/\D/g,"").slice(-10).padStart(10,"0");let c=Number(BigInt(d)%97n);if(c===0)c=97;const s=d+z(c);return"+++"+s.slice(0,3)+"/"+s.slice(3,7)+"/"+s.slice(7)+"+++"}
function lineText(o){return `Transport ${o.laadplaats||"?"} → ${o.losplaats||"?"} · rit ${o.ref}${o.referentieKlant?" · uw ref. "+o.referentieKlant:""} · geladen ${fdate(dateOf(o.laaddatum))}`}
function invLines(i){if(i.lines)return i.lines;return (i.orderIds||[]).map(id=>byId("orders",id)).filter(Boolean).map(o=>({orderId:o.id,omschrijving:lineText(o),bedrag:+o.prijs||0}))}
function calcTotals(lines,btw){const sub=r2(lines.reduce((s,l)=>s+(+l.bedrag||0),0)),b=r2(sub*(btw==="21"?0.21:0));return{subtotaal:sub,btwBedrag:b,totaal:r2(sub+b)}}

/* ---------- icons ---------- */
const I={
 vandaag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
 planning:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2"/></svg>',
 ritten:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6h13v10H1zM14 10h4l3 3v3h-7z"/><circle cx="5.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>',
 mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>',
 facturen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h5"/></svg>',
 meer:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.5 3.5 5.2"/></svg>',
 x:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};
const NAV=[["vandaag","Vandaag"],["ritten","Ritten"],["planning","Planning"],["mail","Mail"],["facturen","Facturen"],["meer","Beheer"]];
const SUBVIEWS={documenten:"Documenten",klanten:"Klanten",chauffeurs:"Chauffeurs",voertuigen:"Voertuigen",bedrijf:"Bedrijfsgegevens",kaart:"Vloot live",facturatie:"Facturatie",gebruikers:"Logins",koppelingen:"Koppelingen"};

/* ---------- toast ---------- */
let tt;function toast(m){const t=$("#toast");t.textContent=m;t.hidden=false;clearTimeout(tt);tt=setTimeout(()=>t.hidden=true,3600)}

/* ---------- libraries (loaded when first needed) ---------- */
const LIB={jspdf:"https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",leafletJs:"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",leafletCss:"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css"};
const loaded={};
function loadScript(u){return loaded[u]||(loaded[u]=new Promise((res,rej)=>{const s=document.createElement("script");s.src=u;s.onload=res;s.onerror=()=>{delete loaded[u];rej(new Error("Bibliotheek kon niet laden"))};document.head.appendChild(s)}))}
function loadCss(u){if(loaded[u])return;loaded[u]=1;const l=document.createElement("link");l.rel="stylesheet";l.href=u;document.head.appendChild(l)}
async function jsPDF(){await loadScript(LIB.jspdf);return window.jspdf.jsPDF}
async function loadLeaflet(){loadCss(LIB.leafletCss);await loadScript(LIB.leafletJs);return window.L}
async function shrinkImage(file,max=2000){try{const bmp=await createImageBitmap(file);const s=Math.min(1,max/Math.max(bmp.width,bmp.height));const c=document.createElement("canvas");c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,"image/jpeg",.82))}catch(e){return file}}

/* ---------- data: praat met de eigen server ---------- */
async function api(path,opt={}){
  const isJson=opt.json!==undefined;
  let r;
  try{r=await fetch(path,{method:opt.method||(isJson?"POST":"GET"),headers:{"x-ghotra":"1",...(isJson?{"content-type":"application/json"}:{}),...(opt.headers||{})},body:isJson?JSON.stringify(opt.json):opt.body,credentials:"same-origin"})}
  catch(e){throw{code:"offline",message:"Geen verbinding met de server. Controleer je internet."}}
  if(r.status===401&&!opt.noRedirect){location.href="/login";throw{code:"auth",message:"Niet aangemeld"}}
  const ct=r.headers.get("content-type")||"";const j=ct.includes("json")?await r.json().catch(()=>({})):{};
  if(!r.ok)throw{code:j.code||("http_"+r.status),status:r.status,message:j.error||("Fout "+r.status)};
  return j}
function dbMsg(e){return (e&&e.message)||"Opslaan mislukt. Controleer je verbinding en probeer opnieuw."}
const recentLocal=new Map();
function applyLocal(col,id,doc){
  if(col==="config"){if(id==="bedrijf")S.bedrijf=doc?{...doc}:{};if(id==="facturatie")S.facturatie=doc?{...doc}:{};return}
  const arr=S[col];if(!arr)return;const i=arr.findIndex(x=>x.id===id);
  if(doc){const d={...doc,id};if(col==="orders"&&LEGACY[d.status])d.status=LEGACY[d.status];if(i>=0)arr[i]=d;else arr.push(d)}else if(i>=0)arr.splice(i,1)}
let liveT;function liveRender(){clearTimeout(liveT);liveT=setTimeout(()=>{render();if(S.sheet&&["order","invoice","doc","docview","conflicts"].includes(S.sheet.type))renderSheet()},30)}
async function put(col,id,data){recentLocal.set(col+":"+id,Date.now());try{const d=await api(`/api/c/${col}/${encodeURIComponent(id)}`,{method:"PUT",json:data});applyLocal(col,id,d);liveRender();return true}catch(e){toast(dbMsg(e));return false}}
async function patch(col,id,data){recentLocal.set(col+":"+id,Date.now());try{const d=await api(`/api/c/${col}/${encodeURIComponent(id)}`,{method:"PATCH",json:data});applyLocal(col,id,d);liveRender();return true}catch(e){toast(dbMsg(e));return false}}
async function del(col,id){recentLocal.set(col+":"+id,Date.now());try{await api(`/api/c/${col}/${encodeURIComponent(id)}`,{method:"DELETE"});applyLocal(col,id,null);liveRender();return true}catch(e){toast(dbMsg(e));return false}}
async function upload(blob,name){const r=await api("/api/files",{method:"POST",body:blob,headers:{"content-type":blob.type||"application/octet-stream","x-filename":encodeURIComponent(name||blob.name||"bestand")}});return r.id}
function upMsg(e){return (e&&e.message)||"Uploaden lukte niet. Probeer opnieuw."}
async function reloadData(){const d=await api("/api/data");COLS.forEach(c=>{S[c]=(d[c]||[]).map(x=>c==="orders"&&LEGACY[x.status]?{...x,status:LEGACY[x.status]}:x);S.loaded[c]=true});S.bedrijf=d.bedrijf||{};S.facturatie=d.facturatie||{};S.positions=d.positions||[];S.status=d.status||{};mcp=!!S.status.mail;sample=!!S.status.ai}

/* ---------- navigation ---------- */
function go(v){S.view=v;if(location.hash!=="#"+v)location.hash=v;render();window.scrollTo(0,0);if(v==="mail"&&S.mail.state==="idle")loadMail()}
window.addEventListener("hashchange",()=>{const v=location.hash.slice(1);if(v&&v!==S.view&&(NAV.some(n=>n[0]===v)||SUBVIEWS[v]))go(v)});
function navHTML(){const unread=S.mail.threads.filter(t=>isUnread(t)).length;
  const cur=SUBVIEWS[S.view]?"meer":S.view;
  return NAV.map(([k,l])=>`<a href="#${k}" ${cur===k?'aria-current="page"':""}>${I[k]}${l}${k==="mail"&&unread?`<span class="dot">${unread>9?"9+":unread}</span>`:""}</a>`).join("")}

/* ---------- render ---------- */
function render(){
  $("#tabbar").innerHTML=navHTML();
  $("#rail").innerHTML='<span class="logo" aria-hidden="true">G</span>'+navHTML();
  const titles={vandaag:"Vandaag",ritten:"Ritten",planning:"Planning",mail:"Mail",facturen:"Facturen",meer:"Beheer",...SUBVIEWS};
  $("#title").textContent=titles[S.view]||"";
  $("#addBtn").hidden=["meer","bedrijf","koppelingen","facturatie","kaart"].includes(S.view);
  $("#aiBtn").hidden=!S.me;
  const v=$("#view");
  if(!db&&S.dbState==="off"){v.innerHTML=`<div class="notice err"><b>Server niet bereikbaar</b>Herlaad de pagina.</div>`;return}
  if(S.dbErr){v.innerHTML=`<div class="notice err"><b>Gegevens niet bereikbaar</b>De verbinding met de opslag is verbroken. Herlaad de pagina.</div>`;return}
  const fn={vandaag:vVandaag,ritten:vRitten,planning:vPlanning,mail:vMail,facturen:vFacturen,meer:vMeer,documenten:vDocumenten,kaart:vKaart,facturatie:vFacturatie,gebruikers:vGebruikers,koppelingen:vKoppelingen,klanten:vKlanten,chauffeurs:vChauffeurs,voertuigen:vVoertuigen,bedrijf:vBedrijf}[S.view]||vVandaag;
  v.innerHTML=(S.status&&S.status.storageWarning?`<div class="notice err"><b>Let op: gegevens worden niet bewaard</b>${esc(S.status.storageWarning)}<span>Oplossing in Railway: open je service → <b>Settings → Volumes → Add Volume</b> met pad <b>/data</b>, en zet bij <b>Variables</b> DATA_DIR op /data.</span></div>`:"")+(S.slow&&!allLoaded()?`<div class="notice">Gegevens zijn nog niet bereikbaar. Wat je ziet kan onvolledig zijn.</div>`:"")+fn();
  if(S.view==="kaart")drawFleet();else if(fleetMap){fleetMap.remove();fleetMap=null;fleetMarkers={};fleetTrail=null}
  if(S.view==="planning"&&S.cal.mode==="maand"){const box=v.querySelector(".calbox"),key=S.cal.y+"-"+S.cal.m;if(box){if(S._rosterKey===key&&S._rosterScroll!=null)box.scrollLeft=S._rosterScroll;else{const td=box.querySelector("thead th.td");box.scrollLeft=td?Math.max(0,td.offsetLeft-box.querySelector(".nm").offsetWidth-60):0;S._rosterKey=key;S._rosterScroll=box.scrollLeft}box.onscroll=()=>{S._rosterScroll=box.scrollLeft}}}
}
const allLoaded=()=>COLS.every(c=>S.loaded[c]);
const hasVoorbeeld=()=>COLS.some(c=>S[c].some(x=>x.voorbeeld));
const vbTag=x=>x.voorbeeld?' <span class="tag">Voorbeeld</span>':"";

function orderRow(o,opt={}){const k=klant(o),c=chauffeur(o),t=voertuig(o);
  const d=dateOf(o.laaddatum),isToday=d===TODAY();
  return `<button class="row" data-act="order" data-id="${o.id}">
   <span class="time">${isToday?`<b>${esc(hm(o.laaddatum)||"—")}</b>vandaag`:`<b>${esc(hm(o.laaddatum)||"")}</b>${d?new Date(d+"T12:00").toLocaleDateString("nl-BE",{day:"numeric",month:"short"}):"—"}`}</span>
   <span class="grow"><span class="t1"><span class="route">${esc(o.laadplaats||"?")}<i>→</i>${esc(o.losplaats||"?")}</span>${o.adr?' <span class="tag adr">ADR</span>':""}${o.cmr?' <span class="tag">CMR</span>':""}${vbTag(o)}</span>
   <span class="t2"><span class="ref">${esc(o.ref)}</span> · ${esc(k?k.naam:"Geen klant")}${opt.noDriver?"":" · "+(c?esc(c.naam):'<span style="color:var(--warn)">geen chauffeur</span>')}${t?` · <span class="plate">${esc(t.kenteken)}</span>`:""}</span></span>
   <span class="pill ${sCls(o.status)}">${esc(o.status||"Gepland")}</span></button>`}

function vVandaag(){
  const t=TODAY(),act=S.orders.filter(o=>o.status!=="Geannuleerd");
  const vandaag=act.filter(o=>dateOf(o.laaddatum)===t||dateOf(o.losdatum)===t||ACTIVE.includes(o.status));
  const onderweg=act.filter(o=>ACTIVE.includes(o.status)).length;
  const open=S.invoices.filter(i=>["Open","Te laat"].includes(invStatus(i)));
  const openSum=open.reduce((s,i)=>s+(+i.totaal||0),0);
  const unread=S.mail.threads.filter(isUnread).length;
  const lanes={};vandaag.forEach(o=>{const k=o.chauffeurId&&chauffeur(o)?o.chauffeurId:"_";(lanes[k]=lanes[k]||[]).push(o)});
  const sorted=Object.keys(lanes).sort((a,b)=>a==="_"?-1:b==="_"?1:(byId("drivers",a).naam||"").localeCompare(byId("drivers",b).naam||""));
  const board=sorted.map(k=>{const d=k==="_"?null:byId("drivers",k);const os=lanes[k].sort((a,b)=>(a.laaddatum||"").localeCompare(b.laaddatum||""));
    return `<div class="lane ${d?"":"unassigned"}"><div class="lane-h"><span class="grow">${d?esc(d.naam):"Nog geen chauffeur"}</span>${d&&absOn(d.id,t)?`<span class="pill s-ziek">${esc(absOn(d.id,t).type)}</span>`:""}${d&&d.tel?`<span class="mono muted" style="font-size:12px">${esc(d.tel)}</span>`:""}</div>${os.map(o=>orderRow(o,{noDriver:1})).join("")}</div>`}).join("");
  const al=alerts();
  return `
  <div class="lbl">${new Date().toLocaleDateString("nl-BE",{weekday:"long",day:"numeric",month:"long"})}</div>
  <div class="kpis">
    <button class="kpi" data-act="nav" data-v="ritten"><span class="lbl">Ritten vandaag</span><span class="v">${vandaag.length}</span></button>
    <button class="kpi" data-act="nav" data-v="ritten"><span class="lbl">Onderweg</span><span class="v">${onderweg}</span></button>
    <button class="kpi" data-act="nav" data-v="facturen"><span class="lbl">Openstaand</span><span class="v small">${eur(openSum)}</span></button>
    <button class="kpi" data-act="nav" data-v="mail"><span class="lbl">Ongelezen mail</span><span class="v">${S.mail.state==="ok"?unread:"–"}</span></button>
  </div>
  ${S.drivers.length?`<section class="sec"><div class="sec-h"><h2>Beschikbaarheid</h2><button class="btn sm" data-act="nav" data-v="planning">Kalender</button></div><div class="avail">${S.drivers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||"")).map(d=>{const st=driverStatus(d),a=absOn(d.id,t);return `<button class="av ${sCls(st)}" data-act="${a?"edit-absences":"newabs"}" data-id="${a?a.id:d.id}" title="${a?esc(abLabel(a)):"Ziekte of verlof ingeven"}"><i></i><span>${esc(d.naam)}<br><small>${esc(a?abLabel(a):st)}</small></span></button>`}).join("")}</div></section>`:""}
  ${fleetCard()}
  <section class="sec"><div class="sec-h"><h2>Planning per chauffeur</h2><small>${vandaag.length} ritten</small></div>
   ${vandaag.length?`<div class="board">${board}</div>`:`<div class="list"><div class="empty">Geen ritten voor vandaag gepland.<button class="btn primary sm" data-act="new" data-col="orders">Rit plannen</button></div></div>`}</section>
  <section class="sec"><div class="sec-h"><h2>Aandacht nodig</h2><small>${al.length||""}</small></div>
   <div class="list">${al.length?al.map(a=>`<button class="row alert" data-act="${a.act}" data-id="${a.id||""}" data-v="${a.v||""}"><span class="sev ${a.sev}"></span><span class="grow"><span class="t1">${a.t}</span><span class="t2">${a.s}</span></span></button>`).join(""):`<div class="empty">Alles in orde: geen vervallen documenten, openstaande facturen of ritten zonder chauffeur.</div>`}</div></section>
  ${hasVoorbeeld()?`<div class="notice">De gegevens met het label <span class="tag">Voorbeeld</span> zijn testgegevens. Je kunt ze wissen onder Beheer.</div>`:""}`;
}
function alerts(){const out=[];
  const doc=(sev,t,s,act,id,v)=>out.push({sev,t,s,act,id,v});
  S.invoices.filter(i=>i.status==="Concept").forEach(i=>{const k=byId("customers",i.klantId);doc("info",`Conceptfactuur ${esc(i.nr)} wacht op controle`,`${esc(k?k.naam:"")} · ${eur(i.totaal)}${i.cmrCheck?" · CMR "+(i.cmrCheck.conclusie==="ok"?"in orde":"nakijken"):""}`,"review",i.id)});
  orderConflicts().forEach(x=>{const d=byId("drivers",x.o.chauffeurId);doc("bad",`${esc(d?d.naam:"Chauffeur")} is ${esc(x.a.type.toLowerCase())} maar staat op rit ${esc(x.o.ref)}`,`${esc(x.o.laadplaats)} → ${esc(x.o.losplaats)} · ${fdt(x.o.laaddatum)} · kies een andere chauffeur`,"order",x.o.id)});
  S.orders.filter(o=>o.status==="Lossen"&&!o.cmr).forEach(o=>doc("warn",`Rit ${esc(o.ref)} wacht op CMR`,`${esc(o.losplaats)} · lossen gestart ${ftime((o.tijden||{}).Lossen)}`,"order",o.id));
  S.orders.filter(o=>!o.chauffeurId&&o.status==="Gepland"&&dateOf(o.laaddatum)&&daysUntil(dateOf(o.laaddatum))<=2).forEach(o=>doc("warn",`Rit ${esc(o.ref)} heeft geen chauffeur`,`${esc(o.laadplaats)} → ${esc(o.losplaats)} · laden ${fdt(o.laaddatum)}`,"order",o.id));
  S.drivers.forEach(d=>[["rijbewijs","Rijbewijs"],["code95","Code 95"]].forEach(([k,l])=>{if(d[k]){const n=daysUntil(d[k]);if(n<=30)doc(n<0?"bad":"warn",`${l} van ${esc(d.naam)} ${n<0?"is vervallen":"vervalt over "+n+" dagen"}`,fdate(d[k]),"edit-drivers",d.id)}}));
  S.vehicles.forEach(v=>{if(v.keuring){const n=daysUntil(v.keuring);if(n<=30)doc(n<0?"bad":"warn",`Keuring ${esc(v.kenteken)} ${n<0?"is vervallen":"over "+n+" dagen"}`,fdate(v.keuring),"edit-vehicles",v.id)}});
  S.documents.forEach(d=>{if(d.vervaldatum){const n=daysUntil(d.vervaldatum);if(n<=45)doc(n<0?"bad":"warn",`${esc(d.naam)} ${n<0?"is vervallen":"vervalt over "+n+" dagen"}`,`${esc(d.categorie||"Document")} · ${fdate(d.vervaldatum)}`,"docview",d.id)}});
  S.invoices.filter(i=>invStatus(i)==="Te laat").forEach(i=>{const k=byId("customers",i.klantId);doc("bad",`Factuur ${esc(i.nr)} is te laat`,`${esc(k?k.naam:"")} · ${eur(i.totaal)} · vervallen ${fdate(i.vervaldatum)}`,"invoice",i.id)});
  const tobill=S.orders.filter(o=>o.status==="Gelost"&&!o.factuurId).length;
  if(tobill)doc("info",`${tobill} geloste ${tobill===1?"rit":"ritten"} nog te factureren`,"Maak een factuur per klant","new-invoice");
  return out}

function vRitten(){
  const t=TODAY(),q=S.rQuery.toLowerCase();
  let os=S.orders.slice();
  const f={vandaag:o=>dateOf(o.laaddatum)===t,komend:o=>!["Gelost","Gefactureerd","Geannuleerd"].includes(o.status),afgerond:o=>["Gelost","Gefactureerd"].includes(o.status),alles:()=>true}[S.rFilter];
  os=os.filter(f);
  if(q)os=os.filter(o=>[o.ref,o.laadplaats,o.losplaats,o.goederen,o.referentieKlant,klant(o)?.naam,chauffeur(o)?.naam,voertuig(o)?.kenteken].join(" ").toLowerCase().includes(q));
  os.sort((a,b)=>S.rFilter==="afgerond"||S.rFilter==="alles"?(b.laaddatum||"").localeCompare(a.laaddatum||""):(a.laaddatum||"").localeCompare(b.laaddatum||""));
  const chips=[["komend","Lopend"],["vandaag","Vandaag"],["afgerond","Afgerond"],["alles","Alles"]];
  return `<div class="actions"><label class="btn sm">Opdracht-PDF uploaden<input type="file" accept="application/pdf" data-file="orderpdf"></label><button class="btn sm" data-act="mailpreset" data-q="has:attachment filename:pdf in:inbox" data-l="Met PDF" data-go="1">PDF-opdrachten in mail</button></div>
  <div class="search"><input id="rq" type="search" placeholder="Zoek op ref, plaats, klant, kenteken…" value="${esc(S.rQuery)}" data-input="rq"></div>
  <div class="chips">${chips.map(([k,l])=>`<button class="chip" data-act="rf" data-v="${k}" aria-pressed="${S.rFilter===k}">${l}</button>`).join("")}</div>
  <div class="list">${os.length?os.map(o=>orderRow(o)).join(""):`<div class="empty">${S.orders.length?"Geen ritten in deze selectie.":"Nog geen ritten. Plan je eerste rit met de oranje knop of upload een opdracht-PDF."}${S.orders.length?"":'<button class="btn primary sm" data-act="new" data-col="orders">Rit plannen</button>'}</div>`}</div>`}

function vFacturen(){
  let is=S.invoices.slice().sort((a,b)=>(b.nr||"").localeCompare(a.nr||""));
  if(S.fFilter==="open")is=is.filter(i=>invStatus(i)!=="Betaald");
  if(S.fFilter==="concept")is=is.filter(i=>i.status==="Concept");
  const tobill=S.orders.filter(o=>o.status==="Gelost"&&!o.factuurId);
  const openSum=S.invoices.filter(i=>["Open","Te laat"].includes(invStatus(i))).reduce((s,i)=>s+(+i.totaal||0),0);
  const late=S.invoices.filter(i=>invStatus(i)==="Te laat").reduce((s,i)=>s+(+i.totaal||0),0);
  const conc=S.invoices.filter(i=>i.status==="Concept").length;
  return `<div class="kpis">
    <div class="kpi"><span class="lbl">Openstaand</span><span class="v small">${eur(openSum)}</span></div>
    <div class="kpi"><span class="lbl">Te laat</span><span class="v small" style="color:${late?"var(--bad)":"inherit"}">${eur(late)}</span></div>
    <button class="kpi" data-act="ff" data-v="concept"><span class="lbl">Te controleren</span><span class="v">${conc}</span></button>
    <button class="kpi" data-act="new-invoice"><span class="lbl">Te factureren</span><span class="v">${tobill.length}</span></button></div>
  <div class="chips">${[["open","Open"],["concept","Concept"],["alles","Alle facturen"]].map(([k,l])=>`<button class="chip" data-act="ff" data-v="${k}" aria-pressed="${S.fFilter===k}">${l}</button>`).join("")}</div>
  <div class="list">${is.length?is.map(i=>{const k=byId("customers",i.klantId),st=invStatus(i);return `<button class="row" data-act="${st==="Concept"?"review":"invoice"}" data-id="${i.id}"><span class="grow"><span class="t1"><span class="mono">${esc(i.nr)}</span> · ${esc(k?k.naam:"?")}${vbTag(i)}</span><span class="t2">${fdate(i.datum)} · vervalt ${fdate(i.vervaldatum)} · ${invLines(i).length} rit(ten)</span></span><span class="num" style="font-weight:600">${eur(i.totaal)}</span><span class="pill ${sCls(st)}">${st}</span></button>`}).join(""):`<div class="empty">${S.fFilter==="alles"?"Nog geen facturen.":"Geen facturen in deze selectie."}${tobill.length?'<button class="btn primary sm" data-act="new-invoice">Factuur maken</button>':""}</div>`}</div>`}

function vMeer(){
  const items=[["documenten","Documenten",S.documents.length+" bestanden · vergunningen, verzekeringen, contracten"],["klanten","Klanten",S.customers.length+" klanten"],["chauffeurs","Chauffeurs",S.drivers.length+" chauffeurs"],["voertuigen","Voertuigen",S.vehicles.length+" voertuigen"],["bedrijf","Bedrijfsgegevens","Gebruikt op facturen en CMR"]];
  return `<div class="list">${items.map(([k,l,s])=>`<button class="row" data-act="nav" data-v="${k}"><span class="grow"><span class="t1">${l}</span><span class="t2">${s}</span></span><span class="muted">›</span></button>`).join("")}</div>
  ${hasVoorbeeld()?`<section class="sec"><h2>Voorbeeldgegevens</h2><div class="notice">De ritten, klanten, chauffeurs en voertuigen met het label <span class="tag">Voorbeeld</span> zijn testgegevens zodat je kunt zien hoe de app werkt.<div><button class="btn danger" data-act="wipe">Voorbeeldgegevens wissen</button></div></div></section>`:""}
  <section class="sec"><h2>Mail</h2><div class="notice">De mailbox is het Gmail-account dat in Claude gekoppeld is (Instellingen → Connectors). Wissel je later naar je officiële adres, ook met een eigen domein via Google Workspace, dan koppel je dat account en werkt deze app er meteen mee.</div></section>
  <section class="sec"><h2>Chauffeursapp</h2><div class="notice">Komt later. De ritstappen (naar laadplaats, laden, naar losplaats, lossen, CMR) kun je nu al hier aantikken; de tijden worden per rit bewaard.</div></section>`}

function expChip(d,l){if(!d)return"";const n=daysUntil(d);const c=n<0?"var(--bad)":n<=30?"var(--warn)":"var(--muted)";return `<span style="color:${c}">${l?l+" ":""}${fdate(d)}</span>`}
function vDocumenten(){const groups={};S.documents.forEach(d=>{(groups[d.categorie||"Overig"]=groups[d.categorie||"Overig"]||[]).push(d)});
  const cats=DOCCAT.filter(c=>groups[c]).concat(Object.keys(groups).filter(c=>!DOCCAT.includes(c)));
  return `<div class="actions"><button class="btn primary" data-act="newdoc">Document uploaden</button></div>
  ${cats.length?cats.map(c=>`<section class="sec"><div class="sec-h"><h2>${esc(c)}</h2><small>${groups[c].length}</small></div><div class="list">${groups[c].sort((a,b)=>(a.naam||"").localeCompare(b.naam||"")).map(d=>`<button class="row" data-act="docview" data-id="${d.id}"><span class="grow"><span class="t1">${esc(d.naam)}</span><span class="t2">${[d.asset?esc(d.asset.name||""):"",d.gekoppeld?esc(d.gekoppeld):"",d.vervaldatum?expChip(d.vervaldatum,"Geldig tot"):""].filter(Boolean).join(" · ")}</span></span><span class="muted">›</span></button>`).join("")}</div></section>`).join(""):`<div class="list"><div class="empty">Nog geen documenten. Upload je vergunning, CMR-verzekering, kentekenbewijzen en contracten. Met een vervaldatum krijg je op tijd een seintje.</div></div>`}`}
function vKlanten(){const cs=S.customers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||""));
  return `<div class="list">${cs.length?cs.map(c=>{const n=S.orders.filter(o=>o.klantId===c.id).length;return `<button class="row" data-act="edit-customers" data-id="${c.id}"><span class="grow"><span class="t1">${esc(c.naam)}${vbTag(c)}</span><span class="t2">${esc([c.contact,c.emailFactuur||c.email,c.btw].filter(Boolean).join(" · ")||"Geen gegevens")}</span></span><span class="t2 muted">${n} rit${n===1?"":"ten"}</span></button>`}).join(""):`<div class="empty">Nog geen klanten.<button class="btn primary sm" data-act="new" data-col="customers">Klant toevoegen</button></div>`}</div>`}
function vChauffeurs(){const ds=S.drivers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||""));
  return `<div class="list">${ds.length?ds.map(d=>`<button class="row" data-act="edit-drivers" data-id="${d.id}"><span class="grow"><span class="t1">${esc(d.naam)}${vbTag(d)}</span><span class="t2">${[esc(d.tel),expChip(d.rijbewijs,"Rijbewijs"),expChip(d.code95,"Code 95")].filter(Boolean).join(" · ")}</span></span>${(()=>{const st=driverStatus(d);return `<span class="pill ${sCls(st)}">${esc(st)}</span>`})()}</button>`).join(""):`<div class="empty">Nog geen chauffeurs.<button class="btn primary sm" data-act="new" data-col="drivers">Chauffeur toevoegen</button></div>`}</div>`}
function vVoertuigen(){const vs=S.vehicles.slice().sort((a,b)=>(a.kenteken||"").localeCompare(b.kenteken||""));
  return `<div class="list">${vs.length?vs.map(v=>`<button class="row" data-act="edit-vehicles" data-id="${v.id}"><span class="plate">${esc(v.kenteken)}</span><span class="grow"><span class="t1">${esc([v.type,v.merk].filter(Boolean).join(" · "))}${vbTag(v)}</span><span class="t2">${[v.km?Number(v.km).toLocaleString("nl-BE")+" km":"",expChip(v.keuring,"Keuring")].filter(Boolean).join(" · ")}</span></span></button>`).join(""):`<div class="empty">Nog geen voertuigen.<button class="btn primary sm" data-act="new" data-col="vehicles">Voertuig toevoegen</button></div>`}</div>`}
function vBedrijf(){const b=S.bedrijf;return `<form class="form" data-form="bedrijf">${F.bedrijf.fields.map(f=>fieldHTML(f,b)).join("")}<div class="full actions"><button class="btn primary" type="submit">Opslaan</button></div></form>`}

/* ---------- availability & planning ---------- */
const ABTYPES=["Ziek","Verlof","Opleiding","Andere"];
const abCls=t=>"ab-"+String(t||"andere").toLowerCase();
function absInRange(did,from,to){if(!did||!from)return null;to=to&&to>=from?to:from;return S.absences.find(a=>a.chauffeurId===did&&a.van&&a.van<=to&&(!a.tot||a.tot>=from))||null}
const absOn=(did,day)=>absInRange(did,day,day);
function abLabel(a){return a.type+(a.tot?(a.tot===a.van?" op "+fdate(a.van):" t/m "+fdate(a.tot)):" tot nader bericht")}
function driverStatus(d){const a=absOn(d.id,TODAY());if(a)return a.type;return S.orders.some(o=>o.chauffeurId===d.id&&ACTIVE.includes(o.status))?"Op rit":"Beschikbaar"}
function orderSpan(o){const f=dateOf(o.laaddatum)||TODAY(),t=dateOf(o.losdatum)||f;return[f,t<f?f:t]}
function driverOpts(from,to,current){return [["","Nog niet toegewezen"],...S.drivers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||"")).map(d=>{const a=absInRange(d.id,from,to);return[d.id,d.naam+(a?" — "+abLabel(a):""),!!a&&d.id!==current]})]}
function orderConflicts(){return S.orders.filter(o=>o.chauffeurId&&["Gepland",...ACTIVE].includes(o.status)).map(o=>{const[f,t]=orderSpan(o);return{o,a:absInRange(o.chauffeurId,f,t)}}).filter(x=>x.a)}
/* Belgische wettelijke feestdagen */
const HOL={};
function holidays(y){if(HOL[y])return HOL[y];const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  const easter=ymd(new Date(y,mo-1,da));const r={};
  [["01-01","Nieuwjaar"],["05-01","Dag van de Arbeid"],["07-21","Nationale feestdag"],["08-15","O.L.V. Hemelvaart"],["11-01","Allerheiligen"],["11-11","Wapenstilstand"],["12-25","Kerstmis"]].forEach(([md,n])=>r[y+"-"+md]=n);
  r[addDays(easter,1)]="Paasmaandag";r[addDays(easter,39)]="O.L.H. Hemelvaart";r[addDays(easter,50)]="Pinkstermaandag";return HOL[y]=r}
const MONTHS=["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const WD=["zo","ma","di","wo","do","vr","za"];

function vPlanning(){const c=S.cal;
  const period=c.mode==="maand"?MONTHS[c.m]+" "+c.y:String(c.y);
  const up=S.absences.filter(a=>!a.tot||a.tot>=TODAY()).sort((a,b)=>(a.van||"").localeCompare(b.van||""));
  const conf=orderConflicts();
  return `<div class="calbar"><div class="chips">${[["maand","Maand"],["jaar","Jaar"]].map(([k,l])=>`<button class="chip" data-act="calmode" data-v="${k}" aria-pressed="${c.mode===k}">${l}</button>`).join("")}</div>
   <span style="flex:1"></span><button class="navbtn" data-act="calnav" data-v="-1" aria-label="Vorige">‹</button><span class="period">${esc(period)}</span><button class="navbtn" data-act="calnav" data-v="1" aria-label="Volgende">›</button><button class="btn sm" data-act="caltoday">Vandaag</button></div>
  ${conf.length?`<div class="notice err"><b>${conf.length} ${conf.length===1?"rit heeft":"ritten hebben"} een afwezige chauffeur</b>${conf.slice(0,4).map(x=>`<span>${esc(x.o.ref)} · ${esc((byId("drivers",x.o.chauffeurId)||{}).naam||"")} is ${esc(abLabel(x.a).toLowerCase())}</span>`).join("")}<div><button class="btn sm" data-act="conflicts">Ritten herverdelen</button></div></div>`:""}
  ${c.mode==="maand"?monthRoster(c.y,c.m):yearView(c.y)}
  <div class="legend"><span><i style="background:var(--bad)"></i>Ziek</span><span><i style="background:var(--warn)"></i>Verlof</span><span><i style="background:var(--vio)"></i>Opleiding</span><span><i style="background:var(--plan)"></i>Andere</span><span><i style="background:var(--accent);height:5px"></i>Rit gepland of bezig (verdwijnt na Gelost)</span><span><i style="background:none;box-shadow:inset 0 -2px 0 var(--warn)"></i>Feestdag</span></div>
  <section class="sec"><div class="sec-h"><h2>Afwezigheden</h2><button class="btn sm primary" data-act="newabs">Ziekte of verlof ingeven</button></div>
   <div class="list">${up.length?up.map(a=>{const d=byId("drivers",a.chauffeurId);return `<button class="row" data-act="edit-absences" data-id="${a.id}"><span class="grow"><span class="t1">${esc(d?d.naam:"Onbekende chauffeur")}</span><span class="t2">${a.tot?fdate(a.van)+" – "+fdate(a.tot):"vanaf "+fdate(a.van)+" · tot nader bericht"}${a.notitie?" · "+esc(a.notitie):""}</span></span><span class="pill ${sCls(a.type)}">${esc(a.type)}</span></button>`}).join(""):`<div class="empty">Geen lopende of geplande afwezigheden. Tik op een vakje in de kalender of op de knop hierboven om ziekte of verlof in te geven.</div>`}</div></section>`}

function monthRoster(y,m){const n=new Date(y,m+1,0).getDate(),hol=holidays(y),today=TODAY();
  const days=[...Array(n)].map((_,i)=>{const dt=new Date(y,m,i+1),s=ymd(dt),w=dt.getDay();return{s,i:i+1,wd:WD[w],we:w===0||w===6,hol:hol[s],td:s===today}});
  const drivers=S.drivers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||""));
  if(!drivers.length)return `<div class="calbox"><div class="empty">Nog geen chauffeurs. Voeg ze toe onder Beheer → Chauffeurs.<button class="btn sm primary" data-act="new" data-col="drivers">Chauffeur toevoegen</button></div></div>`;
  const cls=d=>[d.we?"we":"",d.hol?"hol":"",d.td?"td":""].join(" ");
  const rows=drivers.map(dr=>`<tr><th class="nm" scope="row" title="${esc(dr.naam)}">${esc(dr.naam)}</th>${days.map(d=>{const a=absOn(dr.id,d.s);
     const rides=a?0:S.orders.filter(o=>o.chauffeurId===dr.id&&["Gepland",...ACTIVE].includes(o.status)&&(()=>{const[f,t]=orderSpan(o);return f<=d.s&&t>=d.s})()).length;
     const tip=a?`${dr.naam}: ${abLabel(a)}`:rides?`${dr.naam}: ${rides} lopende rit(ten)`:`${dr.naam}: beschikbaar`;
     return `<td class="${cls(d)}"><button class="cell ${a?abCls(a.type):""}" data-act="calcell" data-id="${dr.id}" data-v="${d.s}" title="${esc(tip+(d.hol?" · "+d.hol:""))}" aria-label="${esc(tip+" op "+fdate(d.s))}">${a?a.type[0]:rides?`<span class="rit ${rides>1?"n2":""}"></span>`:""}</button></td>`}).join("")}</tr>`).join("");
  const foot=days.map(d=>{const free=drivers.filter(dr=>!absOn(dr.id,d.s)).length;return `<td class="${cls(d)} ${free<drivers.length/2?"low":""}">${free}</td>`}).join("");
  return `<div class="calbox"><table class="roster"><thead><tr><th class="nm">Chauffeur</th>${days.map(d=>`<th class="${cls(d)}" ${d.hol?`title="${esc(d.hol)}"`:""}>${d.wd}<b>${d.i}</b></th>`).join("")}</tr></thead>
   <tbody>${rows}</tbody><tfoot><tr><th class="nm">Beschikbaar</th>${foot}</tr></tfoot></table></div>`}

function yearView(y){const hol=holidays(y),today=TODAY(),one=S.cal.driver&&byId("drivers",S.cal.driver);
  const sel=`<label class="field" for="cal_dr" style="max-width:320px"><span class="lbl">Toon</span><select id="cal_dr" data-act-change="caldriver"><option value="">Alle chauffeurs (aantal afwezig)</option>${S.drivers.map(d=>`<option value="${d.id}" ${d.id===S.cal.driver?"selected":""}>${esc(d.naam)}</option>`).join("")}</select></label>`;
  const months=MONTHS.map((mn,m)=>{const n=new Date(y,m+1,0).getDate(),lead=(new Date(y,m,1).getDay()+6)%7;
    let cells=["ma","di","wo","do","vr","za","zo"].map(w=>`<span class="wd">${w}</span>`).join("")+"<span></span>".repeat(lead);
    for(let i=1;i<=n;i++){const dt=new Date(y,m,i),s=ymd(dt),w=dt.getDay();let c=[w===0||w===6?"we":"",hol[s]?"hol":"",s===today?"td":""],tip=hol[s]||"";
      if(one){const a=absOn(one.id,s);if(a){c.push(abCls(a.type));tip=(tip?tip+" · ":"")+a.type}}
      else{const k=S.drivers.filter(d=>absOn(d.id,s)).length;if(k){c.push(k>=3?"h3":k===2?"h2":"h1");tip=(tip?tip+" · ":"")+k+" afwezig"}}
      cells+=`<button class="${c.join(" ")}" data-act="calday" data-v="${s}" title="${esc(fdate(s)+(tip?" · "+tip:""))}">${i}</button>`}
    return `<div class="calbox mini"><h3><button data-act="calmonth" data-v="${m}">${mn}</button></h3><div class="mg">${cells}</div></div>`}).join("");
  return sel+`<div class="years">${months}</div>`}

function shConflicts(){const conf=orderConflicts();
  return sheetWrap("Ritten herverdelen",conf.length?`<div class="notice warn">Deze ritten staan op een chauffeur die dan afwezig is. Open de rit, kies <b>Bewerken</b> en wijs een andere chauffeur toe; afwezige chauffeurs zijn daar uitgegrijsd.</div><div class="list">${conf.map(x=>orderRow(x.o)).join("")}</div>`:`<div class="notice ok">Geen conflicten meer: alle ritten hebben een beschikbare chauffeur.</div>`)}

/* ---------- forms ---------- */
const F={
 orders:{t:"Rit",fields:[
  {k:"klantId",l:"Klant",t:"select",req:1,full:1,opts:()=>[["","Kies een klant"],...(S.sheet&&S.sheet.newKlant&&S.sheet.newKlant.naam?[["__new","+ Nieuwe klant: "+S.sheet.newKlant.naam]]:[]),...S.customers.map(c=>[c.id,c.naam])]},
  {k:"laadplaats",l:"Laadplaats",ph:"Antwerpen, BE",req:1},{k:"laaddatum",l:"Laden",t:"datetime-local",req:1},
  {k:"losplaats",l:"Losplaats",ph:"Lyon, FR",req:1},{k:"losdatum",l:"Lossen",t:"datetime-local"},
  {k:"laadadres",l:"Laadadres",t:"textarea",ph:"Straat, postcode, plaats, laadreferentie"},{k:"losadres",l:"Losadres",t:"textarea",ph:"Straat, postcode, plaats, losreferentie"},
  {k:"goederen",l:"Goederen",ph:"33 europallets drank",full:1},
  {k:"colli",l:"Pallets / colli",t:"number"},{k:"gewicht",l:"Brutogewicht (kg)",t:"number"},
  {k:"chauffeurId",l:"Chauffeur",t:"select",opts:o=>{const[f,t]=orderSpan(o||{});return driverOpts(f,t,(o||{}).chauffeurId)}},
  {k:"voertuigId",l:"Voertuig",t:"select",opts:()=>[["","—"],...S.vehicles.map(v=>[v.id,v.kenteken+(v.type?" · "+v.type:"")])]},
  {k:"prijs",l:"Prijs excl. btw (€)",t:"number",step:"0.01"},{k:"status",l:"Status",t:"select",opts:()=>STAT.map(s=>[s,s])},
  {k:"wachtTarief",l:"Wachttijd € per uur",t:"number",step:"0.01",ph:"standaard uit Beheer"},{k:"vrijeUren",l:"Vrije wachttijd (uren)",t:"number",step:"0.25",ph:"standaard uit Beheer"},
  {k:"referentieKlant",l:"Referentie klant"},{k:"adr",l:"ADR (gevaarlijke stoffen)",t:"select",opts:()=>[["","Nee"],["ja","Ja"]]},
  {k:"notities",l:"Notities",t:"textarea",full:1}]},
 customers:{t:"Klant",fields:[{k:"naam",l:"Bedrijfsnaam",req:1,full:1},{k:"contact",l:"Contactpersoon"},{k:"tel",l:"Telefoon",t:"tel"},
  {k:"email",l:"E-mail (opdrachten)",t:"email"},{k:"emailFactuur",l:"E-mail facturen",t:"email"},{k:"btw",l:"Btw-nummer",ph:"BE0123.456.789"},{k:"termijn",l:"Betaaltermijn (dagen)",t:"number",ph:"30"},{k:"adres",l:"Adres",t:"textarea",full:1}]},
 drivers:{t:"Chauffeur",fields:[{k:"naam",l:"Naam",req:1,full:1},{k:"tel",l:"Telefoon",t:"tel"},{k:"email",l:"E-mail",t:"email"},
  {k:"rijbewijs",l:"Rijbewijs geldig tot",t:"date"},{k:"code95",l:"Code 95 geldig tot",t:"date"}]},
 vehicles:{t:"Voertuig",fields:[{k:"kenteken",l:"Kenteken",req:1,ph:"1-ABC-123"},{k:"type",l:"Type",t:"select",opts:()=>["Trekker","Oplegger","Bakwagen","Bestelwagen"].map(s=>[s,s])},
  {k:"merk",l:"Merk / model"},{k:"km",l:"Kilometerstand",t:"number"},{k:"keuring",l:"Keuring geldig tot",t:"date"},
  {k:"hoogte",l:"Hoogte (m)",t:"number",step:"0.01",ph:"4.00"},{k:"breedte",l:"Breedte (m)",t:"number",step:"0.01",ph:"2.55"},{k:"lengte",l:"Lengte combinatie (m)",t:"number",step:"0.01",ph:"16.50"},{k:"massa",l:"Max. massa (ton)",t:"number",step:"0.1",ph:"40"},
  {k:"notities",l:"Notities",t:"textarea",full:1}]},
 bedrijf:{t:"Bedrijf",fields:[{k:"naam",l:"Bedrijfsnaam",ph:"Ghotra Transport",full:1},{k:"adres",l:"Adres",t:"textarea",full:1},{k:"btw",l:"Btw-nummer"},{k:"iban",l:"IBAN"},{k:"email",l:"E-mail"},{k:"tel",l:"Telefoon"}]},
 absences:{t:"Afwezigheid",fields:[{k:"chauffeurId",l:"Chauffeur",t:"select",req:1,full:1,opts:()=>[["","Kies een chauffeur"],...S.drivers.map(d=>[d.id,d.naam])]},{k:"type",l:"Soort",t:"select",opts:()=>ABTYPES.map(t=>[t,t])},{k:"van",l:"Van",t:"date",req:1},{k:"tot",l:"Tot en met (leeg = tot nader bericht)",t:"date"},{k:"notitie",l:"Notitie",t:"textarea",full:1,ph:"Bv. doktersattest tot vrijdag"}]},
 facturatie:{t:"Facturatie",fields:[{k:"aan",l:"Wachttijd automatisch factureren",t:"select",full:1,opts:()=>[["ja","Ja"],["nee","Nee"]]},{k:"vrijeUren",l:"Vrije tijd per laad- of losplaats (uren)",t:"number",step:"0.25"},{k:"uurTarief",l:"Standaardtarief wachttijd (€ per uur)",t:"number",step:"0.01",ph:"45"},
  {k:"afronding",l:"Afronden",t:"select",full:1,opts:()=>[["15","Per begonnen kwartier"],["30","Per begonnen halfuur"],["60","Per begonnen uur"],["1","Op de minuut"]]}]},
 documents:{t:"Document",fields:[{k:"naam",l:"Naam",req:1,full:1,ph:"Communautaire vergunning"},{k:"categorie",l:"Soort",t:"select",opts:()=>DOCCAT.map(c=>[c,c])},{k:"vervaldatum",l:"Geldig tot",t:"date"},
  {k:"gekoppeld",l:"Hoort bij",t:"select",opts:()=>[["","Het bedrijf"],...S.vehicles.map(v=>[v.kenteken,v.kenteken]),...S.drivers.map(d=>[d.naam,d.naam])]},{k:"notities",l:"Notities",t:"textarea",full:1}]}
};
function fieldHTML(f,o){const v=o[f.k]??"",id="f_"+f.k,full=f.full||f.t==="textarea"?" full":"";
  let inp;
  if(f.t==="select")inp=`<select id="${id}" name="${f.k}" ${f.req?"required":""}>${f.opts(o).map(([a,b,dis])=>`<option value="${esc(a)}" ${String(v)===String(a)?"selected":""} ${dis?"disabled":""}>${esc(b)}</option>`).join("")}</select>`;
  else if(f.t==="textarea")inp=`<textarea id="${id}" name="${f.k}" placeholder="${esc(f.ph||"")}">${esc(v)}</textarea>`;
  else inp=`<input id="${id}" name="${f.k}" type="${f.t||"text"}" ${f.step?`step="${f.step}"`:""} value="${esc(v)}" placeholder="${esc(f.ph||"")}" ${f.req?"required":""}>`;
  return `<label class="field${full}" for="${id}"><span class="lbl">${esc(f.l)}${f.req?" *":""}</span>${inp}</label>`}
function readForm(form,spec){const o={};spec.fields.forEach(f=>{const el=form.elements[f.k];if(!el)return;let v=el.value.trim();if(f.t==="number")v=v===""?"":Number(v);o[f.k]=v});return o}

/* ---------- sheet ---------- */
function openSheet(sh){S.sheet=sh;renderSheet();$("#sheet").hidden=false;document.body.style.overflow="hidden"}
function closeSheet(){S.sheet=null;$("#sheet").hidden=true;document.body.style.overflow=""}
function sheetWrap(title,body){return `<div class="panel-h"><h2>${title}</h2><button class="close" data-act="close" aria-label="Sluiten">${I.x}</button></div><div class="panel-b">${body}</div>`}
function renderSheet(){const sh=S.sheet;if(!sh)return;const p=$("#panel");
  const r={form:shForm,order:shOrder,invoice:shInvoice,newInvoice:shNewInvoice,thread:shThread,compose:shCompose,doc:shDoc,busy:shBusy,review:shReview,docnew:shDocNew,docview:shDocView,conflicts:shConflicts}[sh.type];p.innerHTML=r(sh);
  if(["form","compose","docnew"].includes(sh.type)){const first=p.querySelector("input:not([type=hidden]):not([type=file]),select,textarea");if(first)setTimeout(()=>first.focus({preventScroll:true}),50)}}
function shBusy(sh){return sheetWrap(esc(sh.title||"Bezig"),sh.done?`<div class="notice ${sh.err?"err":""}">${esc(sh.msg||"")}</div>`:`<div class="busy"><span class="spin"></span><div>${esc(sh.msg||"")}</div>${sh.sub?`<div style="font-size:12.5px">${esc(sh.sub)}</div>`:""}</div>`)}
function busy(title,msg,sub){if(S.sheet&&S.sheet.type==="busy"&&S.sheet.title===title&&!S.sheet.done){S.sheet.msg=msg;S.sheet.sub=sub;renderSheet()}else openSheet({type:"busy",title,msg,sub})}
function failed(title,msg){openSheet({type:"busy",title,msg,done:1,err:1})}

function shForm(sh){const spec=F[sh.col],o=sh.id?byId(sh.col,sh.id)||{}:{...(sh.preset||{})};
  if(sh.col==="orders"&&!S.customers.length&&!(sh.newKlant&&sh.newKlant.naam))return sheetWrap("Nieuwe rit",`<div class="notice">Voeg eerst een klant toe; elke rit hoort bij een klant. Of upload een opdracht-PDF: dan maakt de app de klant voor je aan.</div><div class="actions"><button class="btn primary" data-act="new" data-col="customers">Klant toevoegen</button><label class="btn">Opdracht-PDF uploaden<input type="file" accept="application/pdf" data-file="orderpdf"></label></div>`);
  const title=sh.id?spec.t+(o.ref?" "+esc(o.ref):"")+" bewerken":"Nieuwe "+spec.t.toLowerCase();
  const pre=sh.col==="orders"&&!sh.id?(sh.fromPdf?`<div class="notice ok"><b>Gelezen uit ${esc(sh.fromPdf)}</b>Controleer de velden en vul aan wat ontbreekt.${sh.missing&&sh.missing.length?" Niet gevonden: "+esc(sh.missing.join(", "))+".":""}</div>`:`<div class="actions"><label class="btn sm">Uit PDF invullen<input type="file" accept="application/pdf" data-file="orderpdf"></label><button type="button" class="btn sm" data-act="mailpreset" data-q="has:attachment filename:pdf in:inbox" data-l="Met PDF" data-go="1">PDF uit mail</button></div>`):"";
  return sheetWrap(title,`${pre}<form class="form" data-form="entity">${spec.fields.map(f=>fieldHTML(f,o)).join("")}
   <div class="full actions"><button class="btn primary" type="submit">${sh.id?"Opslaan":"Toevoegen"}</button>${sh.id?`<button type="button" class="btn danger" data-act="delete" data-col="${sh.col}" data-id="${sh.id}">Verwijderen</button>`:""}</div></form>`)}

function cmrBlock(o){const c=o.cmrCheck;
  if(!o.cmr)return `<div class="notice ${o.status==="Lossen"?"warn":""}"><b>CMR nog niet ontvangen</b>Een foto of scan van de ondertekende CMR is verplicht om de rit af te sluiten. De app controleert de CMR en maakt een conceptfactuur.<div><label class="btn primary">CMR uploaden<input id="cmr_in" type="file" accept="image/*,application/pdf" data-file="cmr" data-id="${o.id}"></label></div></div>`;
  const img=(o.cmr.type||"").startsWith("image/");
  return `<div class="msg"><div class="msg-h"><b>CMR ontvangen</b><span>${ftime(o.cmr.at)}</span></div>
   ${img?`<img class="thumb" src="${blobUrl(o.cmr.id)}" alt="CMR van rit ${esc(o.ref)}">`:""}
   ${c&&c.conclusie?`<div><span class="pill ${c.conclusie==="ok"?"s-ok":"s-controleren"}">${c.conclusie==="ok"?"CMR in orde":"Nakijken"}</span></div><div style="font-size:13.5px">${esc(c.samenvatting||"")}</div>${c.verschillen?`<div style="font-size:13px;color:var(--bad)">${esc(c.verschillen)}</div>`:""}${c.voorbehoud?`<div style="font-size:13px"><b>Voorbehoud ontvanger:</b> ${esc(c.voorbehoud)}</div>`:""}`:o.cmrCheckErr?`<div class="muted" style="font-size:13px">Automatische controle lukte niet: ${esc(o.cmrCheckErr)}</div>`:""}
   <div class="actions"><a class="btn sm" href="${blobUrl(o.cmr.id)}" target="_blank" rel="noopener">Openen</a><label class="btn sm">Andere CMR uploaden<input type="file" accept="image/*,application/pdf" data-file="cmr" data-id="${o.id}"></label>${sample?`<button class="btn sm" data-act="recheck" data-id="${o.id}">${c?"Opnieuw controleren":"Controleren"}</button>`:""}</div></div>`}

function shOrder(sh){const o=byId("orders",sh.id);if(!o)return sheetWrap("Rit",'<div class="notice">Deze rit bestaat niet meer.</div>');
  const k=klant(o),c=chauffeur(o),v=voertuig(o),inv=o.factuurId&&byId("invoices",o.factuurId);
  const idx=FLOW.indexOf(o.status),tij=o.tijden||{};
  const mails=S.maillog.filter(m=>m.orderId===o.id).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const tl=FLOW.slice(1).filter(s=>tij[s]);
  return sheetWrap(`<span class="mono">${esc(o.ref)}</span> ${o.adr?'<span class="tag adr">ADR</span>':""}`,`
  <div class="route" style="font-family:var(--f-head);font-size:22px">${esc(o.laadplaats)}<i>→</i>${esc(o.losplaats)}</div>
  ${o.status==="Geannuleerd"||o.status==="Gefactureerd"?`<div><span class="pill ${sCls(o.status)}">${esc(o.status)}</span></div>`:
  `<div class="stepper">${FLOW.map((s,i)=>`<button data-act="setstatus" data-id="${o.id}" data-v="${s}" class="${i<idx?"done":i===idx?"cur":""}">${s}${tij[s]?`<small>${new Date(tij[s]).toLocaleTimeString("nl-BE",{hour:"2-digit",minute:"2-digit"})}</small>`:""}</button>`).join("")}</div>`}
  ${tl.length?`<section class="sec"><span class="lbl">Tijden</span><div class="timeline">${tl.map(s=>`<div><span>${s}</span><span class="mono">${ftime(tij[s])}</span></div>`).join("")}</div></section>`:""}
  ${waitSummaryHTML(o)}
  ${["Lossen","Gelost","Gefactureerd"].includes(o.status)||o.cmr?cmrBlock(o):""}
  ${assignBlock(o)}
  ${routeBlock(o,v)}
  <dl class="kv">
   <dt>Klant</dt><dd>${esc(k?k.naam:"—")}${o.referentieKlant?` <span class="muted">· ref ${esc(o.referentieKlant)}</span>`:""}</dd>
   <dt>Laden</dt><dd>${fdt(o.laaddatum)}${o.laadadres?`<br><span class="muted">${esc(o.laadadres)}</span>`:""}</dd>
   <dt>Lossen</dt><dd>${fdt(o.losdatum)}${o.losadres?`<br><span class="muted">${esc(o.losadres)}</span>`:""}</dd>
   <dt>Lading</dt><dd>${esc(o.goederen||"—")}${o.colli?` · ${o.colli} colli`:""}${o.gewicht?` · ${Number(o.gewicht).toLocaleString("nl-BE")} kg`:""}</dd>
   <dt>Chauffeur</dt><dd>${c?esc(c.naam)+(c.tel?` · <span class="mono">${esc(c.tel)}</span>`:""):'<span style="color:var(--warn)">Nog niet toegewezen</span>'}</dd>
   <dt>Voertuig</dt><dd>${v?`<span class="plate">${esc(v.kenteken)}</span> ${esc(v.type||"")}`:"—"}</dd>
   <dt>Prijs</dt><dd class="num">${o.prijs!==""&&o.prijs!=null?eur(o.prijs)+" excl. btw":"—"}</dd>
   ${o.opdrachtPdf?`<dt>Opdracht</dt><dd><a href="${blobUrl(o.opdrachtPdf.id)}" target="_blank" rel="noopener">${esc(o.opdrachtPdf.name||"Opdracht-PDF")}</a></dd>`:""}
   ${inv?`<dt>Factuur</dt><dd><button class="btn sm" data-act="${inv.status==="Concept"?"review":"invoice"}" data-id="${inv.id}">${esc(inv.nr)} · ${esc(invStatus(inv))}</button></dd>`:""}
   ${o.notities?`<dt>Notities</dt><dd style="white-space:pre-wrap">${esc(o.notities)}</dd>`:""}
  </dl>
  <div class="actions">
   <button class="btn" data-act="edit-orders" data-id="${o.id}">Bewerken</button>
   <button class="btn" data-act="cmr" data-id="${o.id}">Blanco CMR</button>
   ${!o.factuurId&&o.status!=="Geannuleerd"?`<button class="btn" data-act="new-invoice" data-klant="${o.klantId}" data-order="${o.id}">Factuur maken</button>`:""}
  </div>
  <section class="sec"><div class="sec-h"><h2>Mail</h2><button class="btn sm" data-act="mailsearch" data-q="&quot;${esc(o.ref)}&quot;${o.referentieKlant?` OR &quot;${esc(o.referentieKlant)}&quot;`:""}">Zoek in mail</button></div>
   <div class="actions">
    <button class="btn sm" data-act="compose" data-tpl="bevestiging" data-id="${o.id}">Ritbevestiging aan klant</button>
    <button class="btn sm" data-act="compose" data-tpl="geleverd" data-id="${o.id}">Levering gemeld</button>
   </div>
   ${mails.length?`<div class="list">${mails.map(m=>`<button class="row" ${m.threadId?`data-act="thread" data-id="${esc(m.threadId)}"`:""}><span class="grow"><span class="t1">${esc(m.subject||"(geen onderwerp)")}</span><span class="t2">${m.kind==="sent"?"Verzonden aan "+esc(m.to||""):"Van "+esc(m.from||"")} · ${fdt(m.date)}</span></span></button>`).join("")}</div>`:`<div class="muted" style="font-size:13px">Nog geen mails aan deze rit gekoppeld.</div>`}
  </section>
  <div><button class="btn danger" data-act="delete" data-col="orders" data-id="${o.id}">Rit verwijderen</button></div>`)}

function mapsUrl(from,to){return "https://www.google.com/maps/dir/?api=1&travelmode=driving"+(from?"&origin="+encodeURIComponent(from):"")+"&destination="+encodeURIComponent(to)}
function routeBlock(o,v){const la=(o.laadadres||o.laadplaats||"").replace(/\n/g,", "),lo=(o.losadres||o.losplaats||"").replace(/\n/g,", ");if(!la&&!lo)return"";
  const dims=v?[v.hoogte?"h "+v.hoogte+" m":"",v.breedte?"b "+v.breedte+" m":"",v.lengte?"l "+v.lengte+" m":"",v.massa?v.massa+" t":""].filter(Boolean).join(" · "):"";
  return `<section class="sec"><span class="lbl">Route</span><div class="actions"><a class="btn" href="${esc(mapsUrl("",la))}" target="_blank" rel="noopener">Naar laadplaats</a><a class="btn" href="${esc(mapsUrl(la,lo))}" target="_blank" rel="noopener">Laad- naar losplaats</a></div>
   <div class="muted" style="font-size:12.5px">Opent Google Maps met een autoroute: houdt geen rekening met hoogte, breedte, gewicht of verboden voor vrachtwagens.${dims?" Maten voertuig: "+esc(dims)+(o.adr?" · ADR":"")+".":v?" Vul de maten van "+esc(v.kenteken)+" in bij Voertuigen.":""}</div></section>`}
function shInvoice(sh){const i=byId("invoices",sh.id);if(!i)return sheetWrap("Factuur",'<div class="notice">Deze factuur bestaat niet meer.</div>');
  const k=byId("customers",i.klantId),st=invStatus(i);
  return sheetWrap(`Factuur <span class="mono">${esc(i.nr)}</span>`,`
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="pill ${sCls(st)}">${st}</span><span class="muted">${esc(k?k.naam:"")}${i.verstuurd?" · verstuurd naar "+esc(i.aan||"")+" op "+ftime(i.verstuurd):""}</span></div>
  <div class="docprev">${invoiceDoc(i,true)}</div>
  <div class="actions">
   ${st!=="Betaald"?`<button class="btn primary" data-act="paid" data-id="${i.id}">Markeer als betaald</button>`:`<button class="btn" data-act="unpaid" data-id="${i.id}">Terug naar open</button>`}
   <button class="btn" data-act="compose" data-tpl="factuur" data-id="${i.id}">Mail naar klant</button>
   <button class="btn" data-act="dl-invoice" data-id="${i.id}">Download pdf</button>${isBEklant(k)?`<button class="btn" data-act="dl-ubl" data-id="${i.id}">E-factuur (Peppol)${i.peppol?" ✓":""}</button>`:""}
   ${st==="Te laat"?`<button class="btn" data-act="compose" data-tpl="herinnering" data-id="${i.id}">Herinnering sturen</button>`:""}
  </div>
  <div><button class="btn danger" data-act="delete" data-col="invoices" data-id="${i.id}">Factuur verwijderen</button></div>`)}

function shNewInvoice(sh){const kid=sh.klantId||"";
  const cands=kid?S.orders.filter(o=>o.klantId===kid&&!o.factuurId&&o.status!=="Geannuleerd").sort((a,b)=>(a.laaddatum||"").localeCompare(b.laaddatum||"")):[];
  const klanten=S.customers.filter(c=>S.orders.some(o=>o.klantId===c.id&&!o.factuurId&&o.status!=="Geannuleerd"));
  return sheetWrap("Nieuwe factuur",`
  <form class="form" data-form="invoice">
   <label class="field full" for="inv_k"><span class="lbl">Klant *</span><select id="inv_k" name="klantId" data-act-change="invklant" required><option value="">Kies een klant</option>${klanten.map(c=>`<option value="${c.id}" ${c.id===kid?"selected":""}>${esc(c.naam)}</option>`).join("")}</select></label>
   ${kid?`<div class="field full"><span class="lbl">Ritten op deze factuur</span><div class="checks">${cands.length?cands.map(o=>`<label><input type="checkbox" name="o" value="${o.id}" ${o.status==="Gelost"||o.id===sh.orderId?"checked":""}><span><b class="mono" style="font-size:12.5px">${esc(o.ref)}</b> ${esc(o.laadplaats)} → ${esc(o.losplaats)}<br><span class="muted" style="font-size:12.5px">${fdate(dateOf(o.laaddatum))} · ${esc(o.status)} · ${o.prijs!==""&&o.prijs!=null?eur(o.prijs):"geen prijs"}${o.cmr?" · CMR ✓":""}</span></span></label>`).join(""):'<div class="muted">Geen ritten om te factureren.</div>'}</div></div>
   <div class="full actions"><button class="btn primary" type="submit">Conceptfactuur maken</button></div>`:""}
  </form>`)}

/* ---------- invoice review ("conceptfactuur controleren") ---------- */
function shReview(sh){const i=byId("invoices",sh.id);if(!i)return sheetWrap("Conceptfactuur",'<div class="notice">Deze factuur bestaat niet meer.</div>');
  const k=byId("customers",i.klantId)||{},lines=invLines(i),orders=[...new Set(lines.map(l=>l.orderId))].map(id=>byId("orders",id)).filter(Boolean);
  const cmrs=orders.filter(o=>o.cmr);const checks=orders.filter(o=>o.cmrCheck&&o.cmrCheck.conclusie);
  const aan=i.aan||k.emailFactuur||k.email||"";const t=calcTotals(lines,i.btw);const b=S.bedrijf;
  const mailBody=i.mailBody||`Beste${k.contact?" "+k.contact:""},\n\nIn bijlage vindt u factuur ${i.nr} voor ${orders.length===1?"rit "+orders[0].ref+(orders[0].referentieKlant?" (uw ref. "+orders[0].referentieKlant+")":""):orders.length+" ritten"}${cmrs.length?", samen met de ondertekende CMR"+(cmrs.length>1?"'s":""):""}.\n\nGelieve het bedrag te betalen vóór de vervaldatum${b.iban?" op "+b.iban:""} met de gestructureerde mededeling op de factuur.\n\nMet vriendelijke groeten,\n${b.naam||"Ghotra Transport"}${b.tel?"\n"+b.tel:""}`;
  return sheetWrap(`Conceptfactuur <span class="mono">${esc(i.nr)}</span>`,`
  ${checks.length?checks.map(o=>{const c=o.cmrCheck;return `<div class="notice ${c.conclusie==="ok"?"ok":"warn"}"><b>CMR ${esc(o.ref)}: ${c.conclusie==="ok"?"in orde":"nakijken"}</b>${esc(c.samenvatting||"")}${c.verschillen?"<br>"+esc(c.verschillen):""}${c.voorbehoud?"<br><b>Voorbehoud:</b> "+esc(c.voorbehoud):""}<div><a class="btn sm" href="${blobUrl(o.cmr.id)}" target="_blank" rel="noopener">CMR bekijken</a></div></div>`}).join(""):orders.some(o=>!o.cmr)?`<div class="notice warn">Niet alle ritten op deze factuur hebben een CMR.</div>`:""}
  <form class="form" data-form="review" id="rvForm">
   <div class="field full"><span class="lbl">Klant</span><div style="font-weight:600">${esc(k.naam||"?")}${k.btw?` <span class="muted mono" style="font-weight:400">${esc(k.btw)}</span>`:""}</div></div>
   <label class="field full" for="rv_aan"><span class="lbl">Factuur mailen naar</span><input id="rv_aan" name="aan" value="${esc(aan)}" inputmode="email" placeholder="boekhouding@klant.be"></label>
   ${aan!==(k.emailFactuur||"")?`<label class="chk full"><input type="checkbox" name="bewaarAan" ${!k.emailFactuur?"checked":""}><span>Bewaar dit adres als factuuradres van ${esc(k.naam||"de klant")}</span></label>`:""}
   <div class="field full"><span class="lbl">Regels</span><div class="lines">${lines.map((l,n)=>`<div class="line"><textarea name="om_${n}" rows="2" aria-label="Omschrijving regel ${n+1}">${esc(l.omschrijving)}</textarea><input name="bd_${n}" type="number" step="0.01" value="${esc(l.bedrag)}" aria-label="Bedrag regel ${n+1}" data-recalc="1"></div>`).join("")}</div></div>
   <label class="field" for="rv_d"><span class="lbl">Factuurdatum</span><input id="rv_d" type="date" name="datum" value="${esc(i.datum||TODAY())}"></label>
   <label class="field" for="rv_t"><span class="lbl">Betaaltermijn (dagen)</span><input id="rv_t" type="number" name="termijn" value="${esc(i.termijn||k.termijn||30)}"></label>
   <label class="field full" for="rv_b"><span class="lbl">Btw</span><select id="rv_b" name="btw" data-recalc="1">${[["21","21% (binnenlands)"],["0v","0% – btw verlegd (klant in andere EU-lidstaat)"],["0x","0% – vrijgesteld internationaal vervoer"]].map(([a,l])=>`<option value="${a}" ${i.btw===a?"selected":""}>${l}</option>`).join("")}</select></label>
   <div class="totals full" id="rvTot">${totHTML(t)}</div>
   <label class="field full" for="rv_s"><span class="lbl">Onderwerp mail</span><input id="rv_s" name="subject" value="${esc(i.mailSubject||`Factuur ${i.nr} – ${b.naam||"Ghotra Transport"}`)}"></label>
   <label class="field full" for="rv_m"><span class="lbl">Bericht</span><textarea id="rv_m" name="body" rows="8">${esc(mailBody)}</textarea></label>
   ${isBEklant(k)?`<div class="full notice"><b>Belgische klant: factuur via Peppol</b>Met "e-factuur (Peppol)" maakt de app het officiële e-factuurbestand, met de factuur-pdf en de CMR erin. Lever het aan in Lucy om het via Peppol te versturen. Mailen kan daarnaast nog altijd.</div>`:""}<div class="field full"><span class="lbl">Bijlagen</span><div class="checks"><label><input type="checkbox" checked disabled><span>Factuur-${esc(i.nr)}.pdf</span></label>${cmrs.map(o=>`<label><input type="checkbox" name="cmr_${o.id}" checked><span>CMR ${esc(o.ref)} (${esc(o.cmr.name||"")}${o.cmr.size?", "+fsize(o.cmr.size):""})</span></label>`).join("")}</div></div>
   <div class="full actions">${isBEklant(k)?`<button class="btn primary" type="submit" name="mode" value="peppol">Goedkeuren · e-factuur (Peppol)</button>`:""}<button class="btn ${isBEklant(k)?"":"primary"}" type="submit" name="mode" value="send" id="rvSend">Goedkeuren en versturen per mail</button><button class="btn" type="submit" name="mode" value="approve">Goedkeuren zonder mail</button><button class="btn" type="submit" name="mode" value="save">Concept bewaren</button></div>
   ${!mcp?'<div class="full notice">Mail is nog niet ingesteld (Beheer → Koppelingen).</div>':""}
  </form>
  <div class="actions"><button class="btn sm" data-act="dl-invoice" data-id="${i.id}">Voorbeeld als pdf</button><button class="btn danger sm" data-act="delete" data-col="invoices" data-id="${i.id}">Concept verwijderen</button></div>`)}
function totHTML(t){return `<span>Subtotaal</span><span>${eur(t.subtotaal)}</span><span>Btw</span><span>${eur(t.btwBedrag)}</span><span class="big">Totaal</span><span class="big">${eur(t.totaal)}</span>`}
function readReview(f,i){const lines=invLines(i).map((l,n)=>({orderId:l.orderId,omschrijving:f.elements["om_"+n].value.trim(),bedrag:r2(f.elements["bd_"+n].value)}));
  const btw=f.elements.btw.value,datum=f.elements.datum.value||TODAY(),termijn=+f.elements.termijn.value||30;
  return{lines,btw,datum,termijn,vervaldatum:addDays(datum,termijn),...calcTotals(lines,btw),aan:f.elements.aan.value.trim(),mailSubject:f.elements.subject.value,mailBody:f.elements.body.value}}

async function createConcept(klantId,orderIds,cmrCheck){const k=byId("customers",klantId)||{};const os=orderIds.map(id=>byId("orders",id)).filter(Boolean);
  const lines=os.flatMap(o=>[{orderId:o.id,omschrijving:lineText(o),bedrag:+o.prijs||0},...waitLines(o)]);
  const btw=/^BE/i.test(k.btw||"")||!k.btw?"21":"0v";const datum=TODAY(),termijn=+k.termijn||30;
  const nr=nextInvNr(),id=uid();
  const inv={nr,klantId,orderIds:os.map(o=>o.id),lines,datum,termijn,vervaldatum:addDays(datum,termijn),btw,...calcTotals(lines,btw),status:"Concept",ogm:ogm(nr),aangemaakt:new Date().toISOString(),...(cmrCheck?{cmrCheck}:{})};
  if(!await put("invoices",id,inv))return null;
  for(const o of os)await patch("orders",o.id,{factuurId:id});
  return id}

/* ---------- documents ---------- */
const BTWTXT={"21":"Btw 21%","0v":"Btw verlegd – art. 196 Richtlijn 2006/112/EG","0x":"Vrijgesteld – internationaal goederenvervoer"};
function invoiceDoc(i,preview){const b=S.bedrijf,k=byId("customers",i.klantId)||{},lines=invLines(i);
  const st='font-family:Helvetica,Arial,sans-serif;color:#111;font-size:13px;line-height:1.45';
  return `<div style="${st};padding:${preview?"18px":"40px"};max-width:760px;margin:0 auto">
  <table style="width:100%;border-collapse:collapse"><tr><td style="vertical-align:top"><div style="font-size:20px;font-weight:700;letter-spacing:.02em">${esc(b.naam||"Ghotra Transport")}</div><div style="white-space:pre-line;color:#444">${esc(b.adres||"")}</div><div style="color:#444">${b.btw?"Btw "+esc(b.btw):""}${b.email?"<br>"+esc(b.email):""}${b.tel?"<br>"+esc(b.tel):""}</div></td>
  <td style="vertical-align:top;text-align:right"><div style="font-size:26px;font-weight:700;color:#c2410c">FACTUUR</div><div>Nr. <b>${esc(i.nr)}</b><br>Datum ${fdate(i.datum)}<br>Vervaldatum ${fdate(i.vervaldatum)}</div></td></tr></table>
  <div style="margin:20px 0;padding:12px;border:1px solid #ddd;border-radius:4px"><div style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Factuur aan</div><b>${esc(k.naam||"")}</b><div style="white-space:pre-line">${esc(k.adres||"")}</div>${k.btw?"Btw "+esc(k.btw):""}</div>
  <table style="width:100%;border-collapse:collapse;margin-top:6px"><thead><tr style="background:#f3f3f3;text-align:left"><th style="padding:7px 8px">Omschrijving</th><th style="padding:7px 8px;text-align:right;white-space:nowrap">Bedrag</th></tr></thead><tbody>
  ${lines.map(l=>`<tr><td style="padding:7px 8px;border-bottom:1px solid #eee;white-space:pre-line">${esc(l.omschrijving)}</td><td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${eur(l.bedrag)}</td></tr>`).join("")}
  </tbody></table>
  <table style="margin-left:auto;margin-top:12px;border-collapse:collapse;min-width:240px">
   <tr><td style="padding:3px 8px">Subtotaal</td><td style="padding:3px 8px;text-align:right">${eur(i.subtotaal)}</td></tr>
   <tr><td style="padding:3px 8px">${esc(BTWTXT[i.btw]||"Btw")}</td><td style="padding:3px 8px;text-align:right">${eur(i.btwBedrag)}</td></tr>
   <tr><td style="padding:6px 8px;font-weight:700;border-top:2px solid #111">Totaal</td><td style="padding:6px 8px;text-align:right;font-weight:700;border-top:2px solid #111">${eur(i.totaal)}</td></tr></table>
  <div style="margin-top:22px;padding:12px;background:#fff7ed;border-radius:4px">Gelieve ${eur(i.totaal)} te betalen vóór ${fdate(i.vervaldatum)}${b.iban?` op rekening <b>${esc(b.iban)}</b>`:""} met mededeling <b style="font-family:monospace">${esc(i.ogm||ogm(i.nr))}</b>.</div>
  ${i.btw==="0v"?'<div style="margin-top:8px;font-size:11.5px;color:#555">Btw verlegd: de btw is verschuldigd door de medecontractant (art. 196 Richtlijn 2006/112/EG).</div>':""}</div>`}

const pdfTxt=s=>String(s??"").replace(/→/g,"-").replace(/[–—]/g,"-").replace(/[^\x00-\xFF]/g,"");
const pdfEur=n=>"EUR "+(+n||0).toLocaleString("nl-BE",{minimumFractionDigits:2,maximumFractionDigits:2});
async function invoicePdf(i){const J=await jsPDF();const d=new J({unit:"mm",format:"a4"});const b=S.bedrijf,k=byId("customers",i.klantId)||{},lines=invLines(i);
  d.setFont("helvetica","bold");d.setFontSize(16);d.text(pdfTxt(b.naam||"Ghotra Transport"),15,20);
  d.setFontSize(22);d.setTextColor(194,65,12);d.text("FACTUUR",195,20,{align:"right"});d.setTextColor(17);
  d.setFont("helvetica","normal");d.setFontSize(9.5);let y=26;
  (b.adres||"").split("\n").concat([b.btw?"Btw "+b.btw:"",b.email||"",b.tel||""]).filter(Boolean).forEach(l=>{d.text(pdfTxt(l),15,y);y+=4.5});
  d.text(["Nr. "+i.nr,"Datum "+fdate(i.datum),"Vervaldatum "+fdate(i.vervaldatum)].map(pdfTxt),195,27,{align:"right"});
  y=Math.max(y,40)+6;const ky=y;d.setDrawColor(210);d.roundedRect(15,y,95,30,1.5,1.5);
  d.setFontSize(8);d.setTextColor(120);d.text("FACTUUR AAN",19,y+5);d.setTextColor(17);d.setFontSize(10);d.setFont("helvetica","bold");d.text(pdfTxt(k.naam||""),19,y+10.5);d.setFont("helvetica","normal");d.setFontSize(9.5);
  let yy=y+15.5;(k.adres||"").split("\n").concat([k.btw?"Btw "+k.btw:""]).filter(Boolean).slice(0,3).forEach(l=>{d.text(pdfTxt(l),19,yy);yy+=4.5});
  y=ky+38;d.setFillColor(243,243,243);d.rect(15,y,180,8,"F");d.setFont("helvetica","bold");d.text("Omschrijving",18,y+5.5);d.text("Bedrag",192,y+5.5,{align:"right"});d.setFont("helvetica","normal");y+=12;
  lines.forEach(l=>{const t=d.splitTextToSize(pdfTxt(l.omschrijving),140);if(y+t.length*4.6>265){d.addPage();y=20}d.text(t,18,y);d.text(pdfEur(l.bedrag),192,y,{align:"right"});y+=t.length*4.6+3;d.setDrawColor(235);d.line(15,y-1.5,195,y-1.5);y+=2});
  y+=4;const row=(a,v,bold)=>{d.setFont("helvetica",bold?"bold":"normal");d.text(pdfTxt(a),150,y,{align:"right"});d.text(pdfEur(v),192,y,{align:"right"});y+=6};
  row("Subtotaal",i.subtotaal);row(i.btw==="21"?"Btw 21%":i.btw==="0v"?"Btw verlegd":"Vrijgesteld",i.btwBedrag);d.setDrawColor(17);d.line(120,y-3.5,195,y-3.5);row("Totaal",i.totaal,1);
  y+=6;d.setFillColor(255,247,237);const pay=d.splitTextToSize(pdfTxt(`Gelieve ${pdfEur(i.totaal)} te betalen voor ${fdate(i.vervaldatum)}${b.iban?" op rekening "+b.iban:""} met mededeling ${i.ogm||ogm(i.nr)}.`),170);
  d.rect(15,y,180,pay.length*4.8+6,"F");d.setFont("helvetica","normal");d.text(pay,19,y+5.5);y+=pay.length*4.8+12;
  if(i.btw==="0v"){d.setFontSize(8);d.setTextColor(90);d.text(pdfTxt("Btw verlegd: de btw is verschuldigd door de medecontractant (art. 196 Richtlijn 2006/112/EG)."),15,y)}
  if(i.btw==="0x"){d.setFontSize(8);d.setTextColor(90);d.text(pdfTxt("Vrijgesteld van btw: internationaal goederenvervoer."),15,y)}
  return new Uint8Array(d.output("arraybuffer"))}

function cmrDoc(o){const b=S.bedrijf,k=klant(o)||{},v=voertuig(o),c=chauffeur(o);
  const box=(n,l,val,span)=>`<td ${span?`colspan="${span}"`:""} style="border:1px solid #333;vertical-align:top;padding:5px 7px;height:58px"><div style="font-size:9.5px;color:#555"><b style="color:#b8121b">${n}</b> ${l}</div><div style="white-space:pre-line;font-size:12.5px;margin-top:2px">${val||""}</div></td>`;
  return `<div style="font-family:Helvetica,Arial,sans-serif;color:#111;padding:14px;max-width:820px;margin:0 auto">
  <table style="width:100%;border-collapse:collapse"><tr><td style="font-size:22px;font-weight:700;letter-spacing:.06em;padding-bottom:6px">CMR</td><td style="text-align:right;font-size:11px;color:#555">Internationale vrachtbrief · Verdrag CMR 1956<br>Nr. <b style="color:#111;font-size:13px">${esc(o.cmrNr||o.ref)}</b></td></tr></table>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed">
   <tr>${box(1,"Afzender (naam, adres, land)",esc((k.naam||"")+(o.laadadres?"\n"+o.laadadres:"")))}${box(16,"Vervoerder (naam, adres, land)",esc((b.naam||"Ghotra Transport")+(b.adres?"\n"+b.adres:"")))}</tr>
   <tr>${box(2,"Geadresseerde (naam, adres, land)",esc(o.losadres||o.losplaats))}${box(17,"Opvolgende vervoerders","")}</tr>
   <tr>${box(3,"Plaats van aflevering der goederen",esc(o.losplaats))}${box(18,"Voorbehoud en opmerkingen van de vervoerder","")}</tr>
   <tr>${box(4,"Plaats en datum van inontvangstneming",esc(o.laadplaats+"\n"+fdate(dateOf(o.laaddatum))))}${box(13,"Instructies van de afzender",esc(o.notities||""))}</tr>
   <tr>${box(5,"Bijgevoegde documenten",o.referentieKlant?"Ref. "+esc(o.referentieKlant):"")}${box(25,"Kenteken / chauffeur",esc((v?v.kenteken:"")+(c?"\n"+c.naam:"")))}</tr>
  </table>
  <table style="width:100%;border-collapse:collapse;margin-top:-1px"><tr style="font-size:9.5px;color:#555">
   <td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">6</b> Merken en nummers</td><td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">7</b> Aantal colli</td><td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">8</b> Wijze van verpakking</td><td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">9</b> Aard der goederen</td><td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">11</b> Brutogewicht kg</td><td style="border:1px solid #333;padding:4px 6px"><b style="color:#b8121b">12</b> Volume m³</td></tr>
   <tr style="font-size:12.5px;height:70px;vertical-align:top"><td style="border:1px solid #333;padding:6px">${esc(o.ref)}</td><td style="border:1px solid #333;padding:6px">${esc(o.colli||"")}</td><td style="border:1px solid #333;padding:6px">${o.colli?"Pallets":""}</td><td style="border:1px solid #333;padding:6px">${esc(o.goederen||"")}${o.adr?"<br><b>ADR</b>":""}</td><td style="border:1px solid #333;padding:6px">${o.gewicht?Number(o.gewicht).toLocaleString("nl-BE"):""}</td><td style="border:1px solid #333;padding:6px"></td></tr></table>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:-1px"><tr>
   ${box(21,"Opgemaakt te / op",esc(o.laadplaats+"  "+fdate(dateOf(o.laaddatum))),3)}</tr><tr>
   <td style="border:1px solid #333;padding:5px 7px;height:80px;vertical-align:top;font-size:9.5px;color:#555"><b style="color:#b8121b">22</b> Handtekening en stempel afzender</td>
   <td style="border:1px solid #333;padding:5px 7px;vertical-align:top;font-size:9.5px;color:#555"><b style="color:#b8121b">23</b> Handtekening en stempel vervoerder</td>
   <td style="border:1px solid #333;padding:5px 7px;vertical-align:top;font-size:9.5px;color:#555"><b style="color:#b8121b">24</b> Goederen ontvangen · plaats, datum, handtekening geadresseerde</td></tr></table></div>`}
function shDoc(sh){const o=byId("orders",sh.id);if(!o)return sheetWrap("CMR","");
  return sheetWrap(`Blanco CMR <span class="mono">${esc(o.ref)}</span>`,`<div class="docprev">${cmrDoc(o)}</div><div class="actions"><button class="btn primary" data-act="dl-cmr" data-id="${o.id}">Download CMR</button><button class="btn" data-act="order" data-id="${o.id}">Terug naar rit</button></div><div class="muted" style="font-size:12.5px">Vooraf ingevulde CMR om af te drukken. Het bestand opent in je browser.</div>`)}
function fullDoc(title,inner){return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>@page{size:A4;margin:12mm}body{margin:0;background:#fff}</style></head><body>${inner}</body></html>`}

/* documents vault sheets */
function shDocNew(sh){const o=sh.preset||{};
  return sheetWrap(sh.id?"Document bewerken":sh.file?"Document bewaren":"Document uploaden",`<form class="form" data-form="docnew">
   ${sh.id?"":sh.file?`<div class="full att"><b>${esc(sh.file.name)}</b><span class="muted">${fsize(sh.file.size)}</span></div>`:`<label class="field full" for="d_file"><span class="lbl">Bestand *</span><input id="d_file" type="file" name="file" required accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx"></label>`}
   ${F.documents.fields.map(f=>fieldHTML(f,o)).join("")}
   <div class="full actions"><button class="btn primary" type="submit">Opslaan</button></div></form>`)}
function shDocView(sh){const d=byId("documents",sh.id);if(!d)return sheetWrap("Document",'<div class="notice">Dit document bestaat niet meer.</div>');
  const a=d.asset||{},img=(a.type||"").startsWith("image/");
  return sheetWrap(esc(d.naam),`<dl class="kv"><dt>Soort</dt><dd>${esc(d.categorie||"Overig")}</dd><dt>Geldig tot</dt><dd>${d.vervaldatum?expChip(d.vervaldatum,""):"—"}</dd><dt>Hoort bij</dt><dd>${esc(d.gekoppeld||"Het bedrijf")}</dd><dt>Bestand</dt><dd>${esc(a.name||"")}${a.size?" · "+fsize(a.size):""}</dd><dt>Geüpload</dt><dd>${ftime(d.geupload)}</dd>${d.notities?`<dt>Notities</dt><dd style="white-space:pre-wrap">${esc(d.notities)}</dd>`:""}</dl>
   ${img&&a.id?`<img class="thumb" src="${blobUrl(a.id)}" alt="${esc(d.naam)}">`:""}
   <div class="actions">${a.id?`<a class="btn primary" href="${blobUrl(a.id)}" target="_blank" rel="noopener">Openen</a><button class="btn" data-act="dl-asset" data-id="${d.id}">Download</button><button class="btn" data-act="compose-doc" data-id="${d.id}">Mailen</button>`:""}<button class="btn" data-act="editdoc" data-id="${d.id}">Bewerken</button></div>
   <div><button class="btn danger" data-act="deldoc" data-id="${d.id}">Document verwijderen</button></div>`)}
async function assetBytes(id){const r=await fetch(blobUrl(id));if(!r.ok)throw new Error("Bestand niet bereikbaar");return new Uint8Array(await r.arrayBuffer())}

/* ---------- Mail (eigen mailbox via de server) ---------- */
const isUnread=m=>!!(m&&m.unread);
const senderName=m=>(m&&(m.fromName||m.from))||"";
const mailKey=(box,uid)=>box+"-"+uid;
function mailErr(e){const c=e&&e.code;if(c==="not_configured")return"Mail is nog niet ingesteld. Een beheerder doet dat onder Beheer → Koppelingen.";return (e&&e.message)||"Mail ophalen lukte niet."}
function relDate(s){if(!s)return"";const d=new Date(s),now=new Date();if(ymd(d)===ymd(now))return d.toLocaleTimeString("nl-BE",{hour:"2-digit",minute:"2-digit"});return d.toLocaleDateString("nl-BE",{day:"numeric",month:"short"})}
async function loadMail(more){
  if(!mcp){S.mail.state="nomcp";render();return}
  S.mail.state=more?"more":"loading";S.mail.err=null;if(!more){S.mail.threads=[];S.mail.next=null}render();
  try{const r=await api(`/api/mail/list?box=${S.mail.box}&q=${encodeURIComponent(S.mail.q||"")}&unread=${S.mail.unread?1:0}&page=${more?S.mail.next:0}`);
    S.mail.threads=(more?S.mail.threads:[]).concat((r.items||[]).map(x=>({...x,box:S.mail.box})));S.mail.next=r.next;S.mail.state="ok"}
  catch(e){S.mail.state="err";S.mail.err=e}
  render()}
function vMail(){const m=S.mail,gm=S.status&&S.status.mailGmail;
  const presets=[["Inbox","inbox","",0],["Ongelezen","inbox","",1],...(gm?[["Met PDF","inbox","has:attachment filename:pdf",0]]:[]),["Verzonden","sent","",0]];
  let body="";
  if(m.state==="nomcp")body=`<div class="notice"><b>Mail is nog niet ingesteld</b>${S.me&&S.me.role==="admin"?`Koppel je mailbox onder Beheer → Koppelingen. Ritten, klanten en facturen werken intussen gewoon.<div><button class="btn sm primary" data-act="nav" data-v="koppelingen">Mail instellen</button></div>`:"Vraag de beheerder om de mailbox te koppelen."}</div>`;
  else if(m.state==="loading")body=`<div class="loading"><span class="spin"></span> Mail ophalen…</div>`;
  else if(m.state==="err")body=`<div class="notice err">${esc(mailErr(m.err))}<div><button class="btn sm" data-act="mailreload">Opnieuw proberen</button></div></div>`;
  else if(m.state==="ok"||m.state==="more"){
    body=`<div class="list">${m.threads.length?m.threads.map(t=>{const key=mailKey(t.box,t.uid);const lk=S.maillog.find(x=>x.threadId===key&&x.orderId),lo=lk&&byId("orders",lk.orderId);
      return `<button class="row ${t.unread?"unread":""}" data-act="thread" data-id="${esc(key)}"><span class="udot"></span><span class="grow"><span class="t1">${esc(t.box==="sent"?"Aan: "+t.to:senderName(t))}</span><span class="t2" style="color:var(--ink)">${t.hasAtt?"📎 ":""}${esc(t.subject||"(geen onderwerp)")}${lo?` <span class="tag">${esc(lo.ref)}</span>`:""}</span></span><span class="mdate">${relDate(t.date)}</span></button>`}).join(""):`<div class="empty">Geen mails gevonden.</div>`}</div>
    ${m.next!=null?`<div><button class="btn" data-act="mailmore" ${m.state==="more"?"disabled":""}>${m.state==="more"?"Laden…":"Meer laden"}</button></div>`:""}`}
  return `<form class="search" data-form="mailsearch"><input id="mq" type="search" name="q" placeholder="${gm?"Zoek in Gmail: naam, ref, from:…":"Zoek in je mail"}" value="${esc(m.q||"")}"><button class="btn" type="submit">Zoek</button></form>
  <div class="chips">${presets.map(([l,box,q,un])=>`<button class="chip" data-act="mailpreset" data-box="${box}" data-q="${esc(q)}" data-unread="${un}" data-l="${esc(l)}" aria-pressed="${m.label===l}">${l}</button>`).join("")}<button class="chip" data-act="mailreload" aria-label="Vernieuwen">↻ Vernieuwen</button></div>
  ${body}`}

const isPdfAtt=a=>/\.pdf$/i.test(a.name||"")||/pdf/i.test(a.type||"");
function shThread(sh){
  if(sh.state==="loading")return sheetWrap("Mail",'<div class="busy"><span class="spin"></span>Bericht openen…</div>');
  if(sh.state==="err")return sheetWrap("Mail",`<div class="notice err">${esc(mailErr(sh.err))}</div><div><button class="btn" data-act="thread" data-id="${esc(sh.id)}">Opnieuw proberen</button></div>`);
  const m=sh.data||{};
  const link=S.maillog.find(x=>x.threadId===sh.id&&x.orderId);
  const orders=S.orders.slice().sort((a,b)=>(b.laaddatum||"").localeCompare(a.laaddatum||"")).slice(0,80);
  return sheetWrap(esc(m.subject||"(geen onderwerp)"),`
  <article class="msg"><div class="msg-h"><span><b>${esc(senderName(m))}</b><br>${esc(m.from||"")}${m.to?`<br>aan ${esc(m.to)}`:""}</span><span>${fdt(m.date)}</span></div>
   <div class="msg-body">${esc((m.text||"").replace(/\n{3,}/g,"\n\n").trim())}</div>
   ${(m.attachments||[]).map(a=>`<div class="att"><b>📎 ${esc(a.name)}</b><span class="muted">${fsize(a.size)}</span>${isPdfAtt(a)||/^image\//.test(a.type)?`<button class="btn sm primary" data-act="pdf2order" data-idx="${a.idx}" data-name="${esc(a.name)}">Rit maken</button>`:""}<button class="btn sm" data-act="att2doc" data-idx="${a.idx}" data-name="${esc(a.name)}">Bewaar bij documenten</button></div>`).join("")}</article>
  ${m.box!=="sent"?`<form class="sec" data-form="reply"><label class="lbl" for="rp_body">Antwoord</label><textarea id="rp_body" name="body" rows="5" placeholder="Typ je antwoord…" required></textarea>
   <div class="actions"><button class="btn primary" type="submit" id="rp_send">Verstuur antwoord</button><label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" name="all" style="width:auto"> Allen beantwoorden</label></div></form>`:""}
  <section class="sec"><span class="lbl">Koppel aan rit</span><div class="search"><select id="lk_o" data-act-change="linkorder"><option value="">— geen —</option>${orders.map(o=>`<option value="${o.id}" ${link&&link.orderId===o.id?"selected":""}>${esc(o.ref)} · ${esc(o.laadplaats)} → ${esc(o.losplaats)}</option>`).join("")}</select></div></section>`)}
async function openThread(key){const i=key.lastIndexOf("-"),box=key.slice(0,i),uid=key.slice(i+1);
  openSheet({type:"thread",id:key,state:"loading"});
  try{const m=await api(`/api/mail/msg/${box}/${uid}`);
    const t=S.mail.threads.find(x=>x.box===box&&String(x.uid)===uid);if(t&&t.unread){t.unread=false;render()}
    if(S.sheet&&S.sheet.id===key){S.sheet.state="ok";S.sheet.data={...m,box};renderSheet()}}
  catch(e){if(S.sheet&&S.sheet.id===key){S.sheet.state="err";S.sheet.err=e;renderSheet()}}}
async function mailAttachmentFile(idx){const m=S.sheet&&S.sheet.data;if(!m)throw{message:"Geen bericht open"};return api("/api/mail/attachment",{method:"POST",json:{box:m.box,uid:m.uid,idx:+idx}})}

/* ---------- AI: rit uit PDF ---------- */
async function importOrderPdf(src,name,ctx={}){
  if(!sample){toast("Automatisch uitlezen is nog niet ingesteld (Beheer → Koppelingen). Vul de rit met de hand in.");return}
  busy("Opdracht lezen","Bestand opslaan…",name);
  let fileId=src&&src.fileId;
  if(!fileId){try{fileId=await upload(new Blob([src],{type:/\.pdf$/i.test(name)?"application/pdf":"image/jpeg"}),name)}catch(e){failed("Opdracht lezen",upMsg(e));return}}
  busy("Opdracht lezen","Claude leest de opdracht…","Dit duurt meestal 10 tot 30 seconden.");
  let r;try{r=await api("/api/ai/order",{method:"POST",json:{fileId,sender:ctx.sender||"",subject:ctx.subject||"",body:ctx.body||""}})}
  catch(e){failed("Opdracht lezen",(e.message||"Uitlezen lukte niet")+" Vul de rit met de hand in.");return}
  r=r&&typeof r==="object"?r:{};
  const em=String(r.klantEmail||ctx.senderEmail||"").toLowerCase(),dom=em.split("@")[1]||"",nm=String(r.klantNaam||"").toLowerCase();
  const k=S.customers.find(c=>[c.email,c.emailFactuur].some(x=>x&&x.toLowerCase()===em))
    ||(dom&&!/gmail|hotmail|outlook|yahoo|icloud|live\./.test(dom)?S.customers.find(c=>[c.email,c.emailFactuur].some(x=>x&&x.toLowerCase().endsWith("@"+dom))):null)
    ||(nm.length>2?S.customers.find(c=>c.naam&&(c.naam.toLowerCase().includes(nm.slice(0,12))||nm.includes(c.naam.toLowerCase().slice(0,12)))):null);
  const preset={status:"Gepland",klantId:k?k.id:(r.klantNaam?"__new":""),laadplaats:r.laadplaats||"",laadadres:r.laadadres||"",laaddatum:String(r.laaddatum||"").slice(0,16),losplaats:r.losplaats||"",losadres:r.losadres||"",losdatum:String(r.losdatum||"").slice(0,16),
    goederen:r.goederen||"",colli:r.colli??"",gewicht:r.gewicht??"",adr:r.adr?"ja":"",prijs:r.prijs??"",wachtTarief:r.wachtTarief??"",vrijeUren:r.vrijeUren??"",referentieKlant:r.referentieKlant||"",notities:r.notities||""};
  const missing=[["laadplaats","laadplaats"],["laaddatum","laaddatum"],["losplaats","losplaats"],["prijs","prijs"]].filter(([f])=>preset[f]===""||preset[f]==null).map(x=>x[1]);
  openSheet({type:"form",col:"orders",preset,fromPdf:name,missing,newKlant:k?null:{naam:r.klantNaam||"",email:r.klantEmail||ctx.senderEmail||"",btw:r.klantBtw||"",adres:r.klantAdres||""},
    extra:{opdrachtPdf:{id:fileId,name},threadId:ctx.threadId||"",bron:ctx.subject||name,from:ctx.senderEmail||""}})}

/* ---------- CMR: uploaden → controle → conceptfactuur (op de server) ---------- */
async function handleCmr(orderId,file){const o=byId("orders",orderId);if(!o)return;
  const isPdf=/pdf/.test(file.type)||/\.pdf$/i.test(file.name);
  busy("CMR verwerken","CMR opslaan…",file.name);
  const blob=isPdf?file:await shrinkImage(file);
  busy("CMR verwerken",sample?"CMR controleren en conceptfactuur maken…":"Conceptfactuur maken…",sample?"Dit duurt meestal 10 tot 30 seconden.":"");
  try{const r=await api(`/api/orders/${encodeURIComponent(orderId)}/cmr?wait=1`,{method:"POST",body:blob,headers:{"content-type":isPdf?"application/pdf":"image/jpeg","x-filename":encodeURIComponent(isPdf?file.name:(file.name||"cmr").replace(/\.[^.]+$/,"")+".jpg")}});
    recentLocal.set("orders:"+orderId,Date.now());await reloadData();render();
    if(r.invoiceId&&byId("invoices",r.invoiceId)&&byId("invoices",r.invoiceId).status==="Concept"){toast(r.check?(r.check.conclusie==="ok"?"CMR in orde, conceptfactuur klaar":"Conceptfactuur klaar, kijk de CMR na"):"Conceptfactuur klaar");openSheet({type:"review",id:r.invoiceId})}
    else openSheet({type:"order",id:orderId})}
  catch(e){openSheet({type:"order",id:orderId});toast(e.message||"Uploaden lukte niet")}}

/* ---------- mail templates ---------- */
function tpl(kind,id){const b=S.bedrijf,sig="\n\nMet vriendelijke groeten,\n"+(b.naam||"Ghotra Transport")+(b.tel?"\n"+b.tel:"");
  if(kind==="factuur"||kind==="herinnering"){const i=byId("invoices",id),k=byId("customers",i.klantId)||{};
    const base={to:i.aan||k.emailFactuur||k.email||"",pdfInvoice:i.id,invoiceId:i.id};
    if(kind==="factuur")return{...base,subject:`Factuur ${i.nr} – ${b.naam||"Ghotra Transport"}`,body:`Beste${k.contact?" "+k.contact:""},\n\nIn bijlage vindt u factuur ${i.nr} van ${fdate(i.datum)} voor ${eur(i.totaal)}.\nGelieve te betalen vóór ${fdate(i.vervaldatum)}${b.iban?" op "+b.iban:""} met mededeling ${i.ogm||ogm(i.nr)}.`+sig};
    return{...base,subject:`Herinnering factuur ${i.nr}`,body:`Beste${k.contact?" "+k.contact:""},\n\nVolgens onze gegevens staat factuur ${i.nr} van ${fdate(i.datum)} (${eur(i.totaal)}) nog open. De vervaldatum was ${fdate(i.vervaldatum)}.\nWilt u de betaling nakijken${b.iban?" en het bedrag overmaken op "+b.iban:""} met mededeling ${i.ogm||ogm(i.nr)}?\n\nIs de betaling al onderweg, dan mag u dit bericht negeren.`+sig}}
  if(kind==="doc"){const d=byId("documents",id);return{to:"",subject:d.naam,body:`Goedendag,\n\nIn bijlage: ${d.naam}.`+sig,assetDoc:d.id}}
  const o=byId("orders",id),k=klant(o)||{},c=chauffeur(o)||{},v=voertuig(o);
  const sum=`Rit: ${o.ref}${o.referentieKlant?" (uw ref. "+o.referentieKlant+")":""}\nLaden: ${o.laadplaats} – ${fdt(o.laaddatum)}${o.laadadres?"\n  "+o.laadadres.replace(/\n/g,", "):""}\nLossen: ${o.losplaats}${o.losdatum?" – "+fdt(o.losdatum):""}${o.losadres?"\n  "+o.losadres.replace(/\n/g,", "):""}\nLading: ${o.goederen||"—"}${o.colli?", "+o.colli+" colli":""}${o.gewicht?", "+o.gewicht+" kg":""}${o.adr?" (ADR)":""}`;
  if(kind==="bevestiging")return{to:k.email||"",subject:`Ritbevestiging ${o.ref} ${o.laadplaats} → ${o.losplaats}`,body:`Beste${k.contact?" "+k.contact:""},\n\nHierbij bevestigen wij de volgende opdracht:\n\n${sum}${v?"\nVoertuig: "+v.kenteken:""}${o.prijs?"\nPrijs: "+eur(o.prijs)+" excl. btw":""}`+sig,orderId:o.id};
  if(kind==="chauffeur")return{to:c.email||"",subject:`Opdracht ${o.ref}: ${o.laadplaats} → ${o.losplaats}`,body:`Hoi${c.naam?" "+c.naam.split(" ")[0]:""},\n\nNieuwe opdracht voor jou:\n\n${sum}${v?"\nVoertuig: "+v.kenteken:""}${o.notities?"\n\nOpmerkingen: "+o.notities:""}\n\nLaat even weten als je geladen hebt.`+sig,orderId:o.id};
  return{to:k.email||"",subject:`Geleverd: ${o.ref} ${o.losplaats}`,body:`Beste${k.contact?" "+k.contact:""},\n\nDe zending ${o.ref}${o.referentieKlant?" (uw ref. "+o.referentieKlant+")":""} is afgeleverd in ${o.losplaats}${o.losdatum?" op "+fdt(o.losdatum):""}.${o.cmr?" De ondertekende CMR zit in bijlage.":""}`+sig,orderId:o.id,cmrOf:o.cmr?o.id:""}}

function shCompose(sh){const d=sh.draft;const atts=[];if(d.pdfInvoice){const i=byId("invoices",d.pdfInvoice);if(i)atts.push("Factuur-"+i.nr+".pdf")}if(d.assetDoc){const x=byId("documents",d.assetDoc);if(x&&x.asset)atts.push(x.asset.name)}if(d.cmrOf){const o=byId("orders",d.cmrOf);if(o)atts.push("CMR "+o.ref)}
  return sheetWrap("Nieuwe mail",`<form class="form" data-form="compose">
   <label class="field full" for="c_to"><span class="lbl">Aan *</span><input id="c_to" name="to" type="text" inputmode="email" value="${esc(d.to||"")}" placeholder="naam@bedrijf.be, …" required></label>
   <label class="field full" for="c_cc"><span class="lbl">Cc</span><input id="c_cc" name="cc" type="text" inputmode="email" value="${esc(d.cc||"")}"></label>
   <label class="field full" for="c_s"><span class="lbl">Onderwerp</span><input id="c_s" name="subject" value="${esc(d.subject||"")}"></label>
   <label class="field full" for="c_b"><span class="lbl">Bericht</span><textarea id="c_b" name="body" rows="12">${esc(d.body||"")}</textarea></label>
   ${atts.length?`<div class="full muted" style="font-size:13px">📎 ${atts.map(esc).join(", ")}</div>`:""}
   <label class="field full" for="c_o"><span class="lbl">Koppel aan rit</span><select id="c_o" name="orderId"><option value="">— geen —</option>${S.orders.slice().sort((a,b)=>(b.laaddatum||"").localeCompare(a.laaddatum||"")).slice(0,60).map(o=>`<option value="${o.id}" ${d.orderId===o.id?"selected":""}>${esc(o.ref)} · ${esc(o.laadplaats)} → ${esc(o.losplaats)}</option>`).join("")}</select></label>
   <div class="full actions"><button class="btn primary" type="submit" id="c_send">Versturen</button></div>
   ${!mcp?'<div class="full notice">Mail is nog niet ingesteld (Beheer → Koppelingen).</div>':""}
  </form>`)}

/* ---------- assistant ---------- */
function renderAi(){const p=$("#aiPanel");if(!S.ai.open){p.hidden=true;return}p.hidden=false;
  const turns=S.ai.turns;
  p.innerHTML=`<div class="ai-h"><b>Assistent</b>${turns.length?`<button class="btn sm" data-act="ai-clear">Wissen</button>`:""}<button class="close" data-act="ai" aria-label="Sluiten">${I.x}</button></div>
  <div class="ai-log" id="aiLog">${turns.length?turns.map(t=>`<div class="bub ${t.role==="user"?"me":"ai"}">${esc(t.content)}</div>`).join(""):`<div class="muted" style="font-size:13px">Vraag iets over je ritten, planning, facturen, documenten of mail.</div><div class="ai-sugg">${["Wie is er morgen beschikbaar?","Wat staat er vandaag gepland?","Welke facturen zijn te laat?","Zijn er nieuwe opdrachten in de mail?"].map(q=>`<button data-act="ai-ask" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`}${S.ai.busy?`<div class="bub ai"><span class="spin"></span></div>`:""}</div>
  <form class="ai-f" data-form="ai"><input id="aiIn" name="q" placeholder="Stel een vraag…" autocomplete="off" ${S.ai.busy?"disabled":""}><button class="btn primary" type="submit" ${S.ai.busy?"disabled":""}>Vraag</button></form>`;
  const log=$("#aiLog");log.scrollTop=log.scrollHeight;if(!S.ai.busy)setTimeout(()=>{const i=$("#aiIn");i&&i.focus({preventScroll:true})},30)}
async function aiAsk(q){q=String(q||"").trim();if(!q||S.ai.busy)return;
  if(!sample){S.ai.turns.push({role:"user",content:q},{role:"assistant",content:"De assistent is nog niet ingesteld. Een beheerder voegt de AI-sleutel toe onder Beheer → Koppelingen."});renderAi();return}
  S.ai.turns.push({role:"user",content:q});S.ai.busy=true;renderAi();
  try{const r=await api("/api/ai/chat",{method:"POST",json:{messages:S.ai.turns.slice(-12)}});S.ai.turns.push({role:"assistant",content:r.text||"(geen antwoord)"})}
  catch(e){S.ai.turns.push({role:"assistant",content:e.message||"Dat lukte niet. Probeer het opnieuw."})}
  S.ai.busy=false;renderAi()}

/* ---------- actions ---------- */
async function setStatus(id,s){const o=byId("orders",id);if(!o||o.status===s)return;
  if(s==="Gelost"&&!o.cmr){toast("Upload eerst de ondertekende CMR");
    if(o.status!=="Lossen")await patch("orders",id,{status:"Lossen",tijden:{Lossen:(o.tijden||{}).Lossen||new Date().toISOString()}});
    setTimeout(()=>{const i=$("#cmr_in");i&&i.click()},250);return}
  const now=new Date().toISOString();
  if(await patch("orders",id,{status:s,tijden:{[s]:now}}))toast(`${o.ref}: ${s}`)}
const ACT={
 nav:d=>{closeSheet();go(d.v)},
 close:()=>closeSheet(),
 add:()=>{const m={vandaag:"orders",ritten:"orders",klanten:"customers",chauffeurs:"drivers",voertuigen:"vehicles"}[S.view];
   if(S.view==="mail")return ACT.compose({});if(S.view==="facturen")return ACT["new-invoice"]({});if(S.view==="documenten")return ACT.newdoc();if(S.view==="planning")return ACT.newabs({});if(S.view==="gebruikers")return ACT.newuser();
   openSheet({type:"form",col:m||"orders",preset:m==="orders"||!m?{status:"Gepland",laaddatum:TODAY()+"T08:00"}:{}})},
 new:d=>openSheet({type:"form",col:d.col,preset:d.col==="orders"?{status:"Gepland",laaddatum:TODAY()+"T08:00"}:{}}),
 order:d=>openSheet({type:"order",id:d.id}),
 invoice:d=>openSheet({type:"invoice",id:d.id}),
 review:d=>openSheet({type:"review",id:d.id}),
 "edit-orders":d=>openSheet({type:"form",col:"orders",id:d.id}),
 "edit-customers":d=>openSheet({type:"form",col:"customers",id:d.id}),
 "edit-drivers":d=>openSheet({type:"form",col:"drivers",id:d.id}),
 "edit-vehicles":d=>openSheet({type:"form",col:"vehicles",id:d.id}),
 "new-invoice":d=>openSheet({type:"newInvoice",klantId:d.klant||"",orderId:d.order||""}),
 rf:d=>{S.rFilter=d.v;render()}, ff:d=>{S.fFilter=d.v;render()},
 setstatus:d=>setStatus(d.id,d.v),
 delete:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");const t=btn.textContent;btn.textContent="Zeker? Tik nogmaals";setTimeout(()=>{if(btn.isConnected){btn.classList.remove("armed");btn.textContent=t}},4000);return}
   if(d.col==="invoices"){const i=byId("invoices",d.id);for(const oid of (i&&i.orderIds)||[]){const o=byId("orders",oid);if(o&&o.factuurId===d.id)await patch("orders",oid,{factuurId:"",status:o.status==="Gefactureerd"?"Gelost":o.status})}}
   if(await del(d.col,d.id)){closeSheet();toast("Verwijderd")}},
 cmr:d=>openSheet({type:"doc",id:d.id}),
 recheck:async d=>{const o=byId("orders",d.id);if(!o||!o.cmr)return;busy("CMR verwerken","Bestand ophalen…","");
   try{const bytes=await assetBytes(o.cmr.id);const c=await checkCmr(o.id,new Blob([bytes],{type:o.cmr.type}),o.cmr.type==="application/pdf");
     const inv=o.factuurId&&byId("invoices",o.factuurId);if(c&&inv&&inv.status==="Concept")await patch("invoices",inv.id,{cmrCheck:c})}catch(e){toast("CMR kon niet geladen worden")}
   openSheet({type:"order",id:d.id})},
 "dl-cmr":d=>{const o=byId("orders",d.id);saveFile("CMR-"+o.ref+".html",fullDoc("CMR "+o.ref,cmrDoc(o)))},
 "dl-invoice":async d=>{const i=byId("invoices",d.id);try{saveFile("Factuur-"+i.nr+".pdf",await invoicePdf(i))}catch(e){toast("PDF maken lukte niet: "+(e.message||e))}},
 "dl-asset":async d=>{const x=byId("documents",d.id);try{saveFile(x.asset.name||"document",new Blob([await assetBytes(x.asset.id)],{type:x.asset.type}))}catch(e){toast("Download lukte niet. Gebruik Openen.")}},
 paid:async d=>{if(await patch("invoices",d.id,{status:"Betaald",betaaldOp:TODAY()})){toast("Gemarkeerd als betaald");renderSheet()}},
 unpaid:async d=>{if(await patch("invoices",d.id,{status:"Open",betaaldOp:""})){renderSheet()}},
 compose:d=>{const draft=d.tpl?tpl(d.tpl,d.id):{to:"",subject:"",body:""};openSheet({type:"compose",draft})},
 "compose-doc":d=>openSheet({type:"compose",draft:tpl("doc",d.id)}),
  mailreload:()=>loadMail(),
 mailmore:()=>loadMail(true),
 mailpreset:d=>{S.mail.q=d.q;S.mail.label=d.l;if(d.go){closeSheet();S.view="mail";if(location.hash!=="#mail")location.hash="mail"}loadMail()},
 mailsearch:d=>{closeSheet();S.mail.q=d.q;S.mail.label="";S.view="mail";if(location.hash!=="#mail")location.hash="mail";loadMail()},
 pdf2order:async d=>{const t=(S.sheet&&S.sheet.data)||{},m=(t.messages||[]).find(x=>x.id===d.msg)||{};busy("Opdracht lezen","PDF uit de mail halen…",d.name);
   try{const p=await mailAttachment(d.msg,d.name);const em=(m.sender||"").toLowerCase();
     await importOrderPdf(p.bytes,p.name,{sender:senderName(m)+" <"+em+">",senderEmail:em,subject:m.subject||"",body:m.plaintextBody||m.snippet||"",threadId:t.id||m.threadId||""})}
   catch(e){failed("Opdracht lezen",e&&e.code?mailErr(e):((e&&e.message)||"De bijlage kon niet gelezen worden."))}},
 att2doc:async d=>{busy("Bijlage bewaren","Bijlage uit de mail halen…",d.name);
   try{const p=await mailAttachment(d.msg,d.name);openSheet({type:"docnew",file:new File([p.bytes],p.name,{type:p.type||"application/octet-stream"}),preset:{naam:p.name.replace(/\.[^.]+$/,""),categorie:"Overig"}})}
   catch(e){failed("Bijlage bewaren",e&&e.code?mailErr(e):((e&&e.message)||"De bijlage kon niet gelezen worden."))}},
 newdoc:()=>openSheet({type:"docnew",preset:{categorie:"Vergunning"}}),
 newabs:d=>{const isDriver=d&&d.id&&byId("drivers",d.id);openSheet({type:"form",col:"absences",preset:{chauffeurId:isDriver?d.id:"",type:isDriver?"Ziek":"Verlof",van:TODAY(),tot:isDriver?"":TODAY()}})},
 "edit-absences":d=>openSheet({type:"form",col:"absences",id:d.id}),
 calmode:d=>{S.cal.mode=d.v;render()},
 calnav:d=>{const c=S.cal,k=+d.v;if(c.mode==="maand"){c.m+=k;if(c.m<0){c.m=11;c.y--}if(c.m>11){c.m=0;c.y++}}else c.y+=k;render()},
 caltoday:()=>{const n=new Date();S.cal.y=n.getFullYear();S.cal.m=n.getMonth();render()},
 calmonth:d=>{S.cal.mode="maand";S.cal.m=+d.v;render()},
 calday:d=>{const dt=new Date(d.v+"T12:00");S.cal.mode="maand";S.cal.y=dt.getFullYear();S.cal.m=dt.getMonth();render()},
 calcell:d=>{const a=absOn(d.id,d.v);if(a)openSheet({type:"form",col:"absences",id:a.id});else openSheet({type:"form",col:"absences",preset:{chauffeurId:d.id,type:"Verlof",van:d.v,tot:d.v}})},
 conflicts:()=>openSheet({type:"conflicts"}),
 docview:d=>openSheet({type:"docview",id:d.id}),
 editdoc:d=>{const x=byId("documents",d.id);openSheet({type:"docnew",id:d.id,preset:x})},
 deldoc:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Zeker? Tik nogmaals";return}
   const x=byId("documents",d.id);if(await del("documents",d.id)){if(x&&x.asset&&assets)assets.delete(x.asset.id).catch(()=>{});closeSheet();toast("Document verwijderd")}},
 ai:()=>{S.ai.open=!S.ai.open;renderAi()},
 "ai-ask":d=>aiAsk(d.q),
 "ai-clear":()=>{if(S.ai.busy)return;S.ai.turns=[];renderAi()},
 wipe:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Zeker? Tik nogmaals";return}
   btn.disabled=true;for(const c of COLS)for(const x of S[c].filter(x=>x.voorbeeld))await del(c,x.id);toast("Voorbeeldgegevens gewist")}
};
document.addEventListener("click",e=>{const b=e.target.closest("[data-act]");if(!b||b.tagName==="SELECT")return;const f=ACT[b.dataset.act];if(f){e.preventDefault();f(b.dataset,b,e)}});
document.addEventListener("change",async e=>{const el=e.target;
  if(el.type==="file"&&el.dataset.file&&el.files&&el.files[0]){const file=el.files[0],kind=el.dataset.file,oid=el.dataset.id;el.value="";
    if(kind==="orderpdf")importOrderPdf(new Uint8Array(await file.arrayBuffer()),file.name);
    if(kind==="cmr")handleCmr(oid,file);
    return}
  if((el.id==="f_laaddatum"||el.id==="f_losdatum")&&S.sheet&&S.sheet.type==="form"&&S.sheet.col==="orders"){const f=el.form,sel=f&&f.elements.chauffeurId;if(sel){const[fr,to]=orderSpan({laaddatum:f.elements.laaddatum.value,losdatum:f.elements.losdatum.value});const cur=sel.value,old=S.sheet.id?(byId("orders",S.sheet.id)||{}).chauffeurId:"";
      sel.innerHTML=driverOpts(fr,to,old).map(([v,l,dis])=>`<option value="${esc(v)}" ${v===cur?"selected":""} ${dis?"disabled":""}>${esc(l)}</option>`).join("");
      if(cur&&absInRange(cur,fr,to)){sel.value="";toast((byId("drivers",cur)||{}).naam+" is dan afwezig; kies een andere chauffeur")}}}
  const a=el.dataset.actChange;
  if(a==="caldriver"){S.cal.driver=el.value;render();return}
  if(a==="invklant"){S.sheet.klantId=el.value;S.sheet.orderId="";renderSheet()}
  if(a==="linkorder"&&S.sheet&&S.sheet.type==="thread"){const m=S.sheet.data||{},oid=el.value;
    if(await put("maillog",S.sheet.id,{threadId:S.sheet.id,orderId:oid,subject:m.subject||"",from:senderName(m),date:m.date||new Date().toISOString(),kind:"link"}))toast(oid?"Gekoppeld aan "+byId("orders",oid).ref:"Koppeling verwijderd")}});
let rqT;document.addEventListener("input",e=>{
  if(e.target.dataset.input==="rq"){S.rQuery=e.target.value;clearTimeout(rqT);rqT=setTimeout(()=>{const pos=e.target.selectionStart;render();const el=$("#rq");if(el){el.focus();el.setSelectionRange(pos,pos)}},200)}
  if(e.target.dataset.recalc&&S.sheet&&S.sheet.type==="review"){const i=byId("invoices",S.sheet.id),f=$("#rvForm");if(i&&f)$("#rvTot").innerHTML=totHTML(readReview(f,i))}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(S.ai.open){S.ai.open=false;renderAi()}else if(S.sheet)closeSheet()}});

const SUBMIT={
 entity:async f=>{const sh=S.sheet,spec=F[sh.col],data=readForm(f,spec);const btn=f.querySelector("[type=submit]");btn.disabled=true;
   if(sh.col==="orders"){
     if(data.klantId==="__new"){const nk=sh.newKlant||{},kid=uid();if(!await put("customers",kid,{naam:nk.naam,email:nk.email||"",btw:nk.btw||"",adres:nk.adres||"",termijn:30})){btn.disabled=false;return}data.klantId=kid}
     if(!sh.id){data.ref=nextRef();data.aangemaakt=new Date().toISOString();data.tijden={};if(sh.extra){if(sh.extra.opdrachtPdf)data.opdrachtPdf=sh.extra.opdrachtPdf;if(sh.extra.bron)data.bron=sh.extra.bron}}}
   if(sh.col==="vehicles")data.kenteken=String(data.kenteken||"").toUpperCase();
   if(sh.col==="orders"&&data.chauffeurId){const[fr,to]=orderSpan(data),a=absInRange(data.chauffeurId,fr,to),old=sh.id?(byId("orders",sh.id)||{}).chauffeurId:"";if(a&&data.chauffeurId!==old){toast((byId("drivers",data.chauffeurId)||{}).naam+" is "+abLabel(a).toLowerCase()+"; kies een andere chauffeur");btn.disabled=false;return}}
   if(sh.col==="absences"&&data.tot&&data.tot<data.van){toast("De einddatum ligt voor de begindatum");btn.disabled=false;return}
   const id=sh.id||uid(),old=sh.id?byId(sh.col,sh.id):{};const rec={...old,...data};delete rec.id;
   if(await put(sh.col,id,rec)){toast(sh.id?"Opgeslagen":spec.t+" toegevoegd");
     if(sh.col==="orders"&&sh.extra&&sh.extra.threadId)put("maillog",sh.extra.threadId,{threadId:sh.extra.threadId,orderId:id,subject:sh.extra.bron||"",from:sh.extra.from||"",date:new Date().toISOString(),kind:"link"});
     if(sh.col==="orders")openSheet({type:"order",id});
     else if(sh.col==="absences"&&orderConflicts().some(x=>x.o.chauffeurId===data.chauffeurId))openSheet({type:"conflicts"});
     else closeSheet()}else btn.disabled=false},
 invoice:async f=>{const sh=S.sheet,ids=[...f.querySelectorAll("input[name=o]:checked")].map(x=>x.value);
   if(!ids.length){toast("Kies minstens één rit");return}f.querySelector("[type=submit]").disabled=true;
   const id=await createConcept(sh.klantId,ids);if(id)openSheet({type:"review",id})},
 mailsearch:f=>{const q=f.elements.q.value.trim();S.mail.q=q||"in:inbox";S.mail.label=q?"":"Inbox";loadMail()},
 ai:f=>{const q=f.elements.q.value;aiAsk(q)}
};
document.addEventListener("submit",e=>{e.preventDefault();const f=e.target,h=SUBMIT[f.dataset.form];if(h)h(f,e.submitter)});

/* ================= eigen server: aanvullingen en vervangingen ================= */
async function saveFile(name,data){try{const blob=data instanceof Blob?data:new Blob([data],{type:/\.pdf$/i.test(name)?"application/pdf":/\.html?$/i.test(name)?"text/html":/\.xml$/i.test(name)?"application/xml":"application/octet-stream"});
  const u=URL.createObjectURL(blob);const a=document.createElement("a");a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);toast("Bestand gedownload")}catch(e){toast("Downloaden lukte niet")}}
async function buildAttachments(spec){const out=[],notes=[];
  if(spec.invoiceId){const i=byId("invoices",spec.invoiceId);if(i)out.push({filename:"Factuur-"+i.nr+".pdf",mime:"application/pdf",base64:b64bytes(await invoicePdf(i))})}
  for(const oid of spec.cmrOrders||[]){const o=byId("orders",oid);if(o&&o.cmr)out.push({fileId:o.cmr.id,filename:"CMR-"+o.ref+(o.cmr.type==="application/pdf"?".pdf":".jpg")})}
  if(spec.docId){const d=byId("documents",spec.docId);if(d&&d.asset)out.push({fileId:d.asset.id,filename:d.asset.name})}
  return{attachments:out,notes}}
function go(v){if(S.sheet)closeSheet();S.view=v;if(location.hash!=="#"+v)location.hash=v;render();window.scrollTo(0,0);if(v==="mail"&&S.mail.state==="idle")loadMail();if(v==="koppelingen")loadSettings();if(v==="gebruikers")loadUsers()}

function orderRow(o,opt={}){const k=klant(o),c=chauffeur(o),t=voertuig(o);
  const d=dateOf(o.laaddatum),isToday=d===TODAY();
  const notSeen=o.chauffeurId&&!o.gezien&&o.status==="Gepland"&&hasLogin(o.chauffeurId);
  return `<button class="row" data-act="order" data-id="${o.id}">
   <span class="time">${isToday?`<b>${esc(hm(o.laaddatum)||"—")}</b>vandaag`:`<b>${esc(hm(o.laaddatum)||"")}</b>${d?new Date(d+"T12:00").toLocaleDateString("nl-BE",{day:"numeric",month:"short"}):"—"}`}</span>
   <span class="grow"><span class="t1"><span class="route">${esc(o.laadplaats||"?")}<i>→</i>${esc(o.losplaats||"?")}</span>${o.adr?' <span class="tag adr">ADR</span>':""}${o.cmr?' <span class="tag">CMR</span>':""}${notSeen?' <span class="tag">Niet gezien</span>':""}${vbTag(o)}</span>
   <span class="t2"><span class="ref">${esc(o.ref)}</span> · ${esc(k?k.naam:"Geen klant")}${opt.noDriver?"":" · "+(c?esc(c.naam):'<span style="color:var(--warn)">geen chauffeur</span>')}${t?` · <span class="plate">${esc(t.kenteken)}</span>`:""}</span></span>
   <span class="pill ${sCls(o.status)}">${esc(o.status||"Gepland")}</span></button>`}
const hasLogin=did=>(S.users||[]).some(u=>u.role==="driver"&&u.driverId===did&&u.active);
const ago=ms=>{const m=Math.round((Date.now()-ms)/60000);return m<1?"zojuist":m<60?m+" min geleden":m<1440?Math.round(m/60)+" u geleden":Math.round(m/1440)+" d geleden"};
function routeBlock(o,v){const la=(o.laadadres||o.laadplaats||""),lo=(o.losadres||o.losplaats||"");if(!la&&!lo)return"";
  const pos=o.chauffeurId&&(S.positions||[]).find(p=>p.driverId===o.chauffeurId);
  const dims=v?[v.hoogte?"h "+v.hoogte+" m":"",v.breedte?"b "+v.breedte+" m":"",v.lengte?"l "+v.lengte+" m":"",v.massa?v.massa+" t":""].filter(Boolean).join(" · "):"";
  return `<section class="sec"><span class="lbl">Route en opvolging</span><div class="actions"><button class="btn" data-act="route" data-id="${o.id}">${S.status&&S.status.here?"Vrachtwagenroute bekijken":"Route bekijken"}</button></div>
   <div class="muted" style="font-size:12.5px">${[o.chauffeurId?(o.gezien?"Gezien door chauffeur "+ftime(o.gezien):hasLogin(o.chauffeurId)?"Nog niet gezien door de chauffeur":"Chauffeur heeft nog geen login voor de app"):"",pos?"Laatste positie "+ago(pos.at):"",dims?"Voertuig: "+esc(dims)+(o.adr?" · ADR":""):""].filter(Boolean).join(" · ")}</div></section>`}

/* ---------- route & kaart ---------- */
async function openRoute(id){openSheet({type:"route",id,state:"loading"});
  try{const d=await api(`/api/route/${encodeURIComponent(id)}?leg=full`);if(S.sheet&&S.sheet.id===id){S.sheet.state="ok";S.sheet.data=d;renderSheet()}}
  catch(e){if(S.sheet&&S.sheet.id===id){S.sheet.state="err";S.sheet.err=e;renderSheet()}}}
const fdur=s=>{const h=Math.floor(s/3600),m=Math.round(s%3600/60);return h?h+" u "+z(m)+" min":m+" min"};
function gLinks(o){const la=(o.laadadres||o.laadplaats||"").replace(/\n/g,", "),lo=(o.losadres||o.losplaats||"").replace(/\n/g,", ");const g=(a,b)=>"https://www.google.com/maps/dir/?api=1&travelmode=driving"+(a?"&origin="+encodeURIComponent(a):"")+"&destination="+encodeURIComponent(b);
  return `<div class="actions"><a class="btn" href="${esc(g("",la))}" target="_blank" rel="noopener">Google Maps: naar laadplaats</a><a class="btn" href="${esc(g(la,lo))}" target="_blank" rel="noopener">Google Maps: laad → los</a></div>`}
function shRoute(sh){const o=byId("orders",sh.id)||{};const t=`Route <span class="mono">${esc(o.ref||"")}</span>`;
  if(sh.state==="loading")return sheetWrap(t,'<div class="busy"><span class="spin"></span>Vrachtwagenroute berekenen…</div>');
  if(sh.state==="err")return sheetWrap(t,`<div class="notice err">${esc(sh.err.message||"Route berekenen lukte niet")}</div>${gLinks(o)}`);
  const d=sh.data||{};
  if(!d.configured)return sheetWrap(t,`<div class="notice"><b>Vrachtwagenroutes zijn nog niet ingesteld</b>Met een HERE-sleutel (Beheer → Koppelingen) berekent de app routes met hoogte, breedte, gewicht, ADR en wegenwerken. Intussen kun je Google Maps gebruiken; dat is een autoroute.</div>${gLinks(o)}`);
  const r=d.route;
  return sheetWrap(t,`${r?`<div class="rsum"><b>${(r.length/1000).toFixed(0)} km</b><b>${fdur(r.duration)}</b>${r.trafficDelay>120?`<span class="pill s-laden">+${fdur(r.trafficDelay)} verkeer</span>`:""}<span class="muted">${esc([d.vehicle.hoogte?"h "+d.vehicle.hoogte+" m":"",d.vehicle.breedte?"b "+d.vehicle.breedte+" m":"",d.vehicle.lengte?"l "+d.vehicle.lengte+" m":"",d.vehicle.massa?d.vehicle.massa+" t":""].filter(Boolean).join(" · ")||"Geen voertuigmaten ingevuld: route zonder vrachtwagenbeperkingen")}</span></div>`:""}
   ${r&&r.notices.length?`<div class="notice warn"><b>Let op</b>${r.notices.map(n=>esc(n.title)).join("<br>")}</div>`:""}
   <div id="map" class="map"></div>
   ${r?`<section class="sec"><span class="lbl">Instructies</span><div class="steps">${r.steps.slice(0,80).map(s=>`<div><span>${esc(s.text)}</span><small>${s.length>=1000?(s.length/1000).toFixed(1)+" km":s.length+" m"}</small></div>`).join("")}</div></section>`:""}
   ${gLinks(o)}`)}
let routeMap=null,truckMarker=null;
let routeDraw=0;
async function drawRoute(){const sh=S.sheet;if(!sh||sh.type!=="route"||sh.state!=="ok"||!sh.data.configured)return;const d=sh.data;const my=++routeDraw;
  try{const L=await loadLeaflet();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(my!==routeDraw||S.sheet!==sh)return;
    const el=$("#panel #map");if(!el)return;if(routeMap){try{routeMap.remove()}catch(e){}routeMap=null}truckMarker=null;if(el._leaflet_id)el._leaflet_id=null;
    routeMap=L.map(el,{zoomControl:true,attributionControl:true});
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(routeMap);
    const pts=d.route?d.route.coords:[[d.laad.lat,d.laad.lng],[d.los.lat,d.los.lng]];
    const line=L.polyline(pts,{color:getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#0d9466",weight:5,opacity:.9}).addTo(routeMap);
    L.circleMarker([d.laad.lat,d.laad.lng],{radius:9,color:"#fff",weight:3,fillColor:"#a96608",fillOpacity:1}).addTo(routeMap).bindTooltip("Laden: "+d.laad.label);
    L.circleMarker([d.los.lat,d.los.lng],{radius:9,color:"#fff",weight:3,fillColor:"#c2352f",fillOpacity:1}).addTo(routeMap).bindTooltip("Lossen: "+d.los.label);
    const fit=()=>{if(!routeMap)return;routeMap.invalidateSize();routeMap.fitBounds(line.getBounds(),{padding:[24,24]})};fit();setTimeout(fit,250);setTimeout(fit,800);updateTruck()}catch(e){console.error(e);const el=$("#panel #map");if(el)el.outerHTML=`<div class="notice">De kaart kon niet laden. ${esc(e.message||"")}</div>`}}
function updateTruck(){const sh=S.sheet;if(!routeMap||!sh||sh.type!=="route")return;const o=byId("orders",sh.id);const p=o&&(S.positions||[]).find(x=>x.driverId===o.chauffeurId);if(!p)return;
  const L=window.L;if(truckMarker)truckMarker.setLatLng([p.lat,p.lng]);else truckMarker=L.circleMarker([p.lat,p.lng],{radius:8,color:"#fff",weight:3,fillColor:"#7c4dcc",fillOpacity:1}).addTo(routeMap);
  truckMarker.bindTooltip(((chauffeur(o)||{}).naam||"Chauffeur")+" · "+ago(p.at))}

/* ---------- logins ---------- */
function genPassword(){const a="abcdefghjkmnpqrstuvwxyz23456789";const r=crypto.getRandomValues(new Uint32Array(10));return Array.from(r,x=>a[x%a.length]).join("").replace(/(.{5})/,"$1-")}
async function loadUsers(){try{S.users=await api("/api/users");if(S.view==="gebruikers")render();if(S.sheet)renderSheet()}catch(e){}}
function driverLoginBlock(did){const u=(S.users||[]).find(x=>x.role==="driver"&&x.driverId===did);const d=byId("drivers",did)||{};
  if(u)return `<section class="sec"><h2>Login chauffeursapp</h2><div class="notice ${u.active?"ok":"warn"}"><b>${esc(u.email)}</b>${u.active?"Deze chauffeur logt in op de chauffeursapp en ziet alleen zijn eigen ritten.":"Deze login is uitgeschakeld."}<div class="actions"><button class="btn sm" data-act="userpwd" data-id="${u.id}">Nieuw wachtwoord</button><button class="btn sm" data-act="usertoggle" data-id="${u.id}">${u.active?"Uitschakelen":"Inschakelen"}</button></div></div></section>`;
  return `<section class="sec"><h2>Login chauffeursapp</h2><form class="form" data-form="drvlogin" data-driver="${did}"><label class="field full" for="dl_mail"><span class="lbl">E-mailadres van de chauffeur</span><input id="dl_mail" name="email" type="email" required value="${esc(d.email||"")}"></label><div class="full actions"><button class="btn primary" type="submit">Login aanmaken</button></div><div class="full muted" style="font-size:12.5px">De app maakt een wachtwoord dat je aan de chauffeur geeft. Hij ziet alleen zijn eigen ritten en kan niet in de dispatch.</div></form></section>`}
function shPwd(sh){const url=location.origin+"/login";
  return sheetWrap("Inloggegevens",`<div class="notice ok"><b>${esc(sh.title||"Login klaar")}</b>Geef deze gegevens aan ${esc(sh.name||"de gebruiker")}. Het wachtwoord wordt maar één keer getoond.</div>
   <dl class="kv"><dt>Adres</dt><dd><span class="mono">${esc(url)}</span></dd><dt>E-mail</dt><dd>${esc(sh.email)}</dd><dt>Wachtwoord</dt><dd><div class="pwd" id="pwdv">${esc(sh.pwd)}</div></dd></dl>
   <div class="actions"><button class="btn primary" data-act="copy" data-v="${esc(`${url}\nE-mail: ${sh.email}\nWachtwoord: ${sh.pwd}`)}">Kopiëren</button>${mcp?`<button class="btn" data-act="pwdmail">Per mail sturen</button>`:""}<button class="btn" data-act="close">Klaar</button></div>
   <div class="muted" style="font-size:12.5px">Op de telefoon of tablet: open het adres, log in en kies "Zet op beginscherm" om de app te installeren. Daarna "Meldingen aanzetten" in de app.</div>`)}
function shNewUser(){return sheetWrap("Kantoorlogin toevoegen",`<form class="form" data-form="newuser"><label class="field full" for="nu_n"><span class="lbl">Naam *</span><input id="nu_n" name="name" required></label><label class="field full" for="nu_e"><span class="lbl">E-mailadres *</span><input id="nu_e" name="email" type="email" required></label>
  <label class="field full" for="nu_r"><span class="lbl">Rol</span><select id="nu_r" name="role"><option value="dispatch">Dispatch (planning, ritten, mail, facturen)</option><option value="admin">Beheerder (ook logins en koppelingen)</option></select></label><div class="full actions"><button class="btn primary" type="submit">Login aanmaken</button></div></form>`)}
function shAccount(){const m=S.me||{};return sheetWrap("Mijn account",`<dl class="kv"><dt>Naam</dt><dd>${esc(m.name||"")}</dd><dt>E-mail</dt><dd>${esc(m.email||"")}</dd><dt>Rol</dt><dd>${m.role==="admin"?"Beheerder":"Dispatch"}</dd></dl>
  <form class="form" data-form="pwd"><label class="field full" for="pw_c"><span class="lbl">Huidig wachtwoord</span><input id="pw_c" name="current" type="password" autocomplete="current-password" required></label><label class="field full" for="pw_n"><span class="lbl">Nieuw wachtwoord (min. 8 tekens)</span><input id="pw_n" name="password" type="password" autocomplete="new-password" minlength="8" required></label><div class="full actions"><button class="btn primary" type="submit">Wachtwoord wijzigen</button></div></form>
  <div class="actions"><button class="btn" data-act="pushon">Meldingen op dit toestel aanzetten</button><button class="btn danger" data-act="logout">Afmelden</button></div>`)}
function vGebruikers(){const us=S.users||[];const admin=S.me&&S.me.role==="admin";
  const office=us.filter(u=>u.role!=="driver"),drv=us.filter(u=>u.role==="driver");
  const row=u=>{const d=u.driverId&&byId("drivers",u.driverId);return `<div class="row"><span class="grow"><span class="t1">${esc(u.name||(d&&d.naam)||u.email)}${u.id===(S.me||{}).id?' <span class="tag">jij</span>':""}</span><span class="t2">${esc(u.email)} · ${u.role==="admin"?"Beheerder":u.role==="dispatch"?"Dispatch":"Chauffeur"+(d?" · "+esc(d.naam):"")}</span></span>
    ${(u.role==="driver"||admin)&&u.id!==(S.me||{}).id?`<button class="btn sm" data-act="userpwd" data-id="${u.id}">Wachtwoord</button><button class="btn sm" data-act="usertoggle" data-id="${u.id}">${u.active?"Uit":"Aan"}</button><button class="btn sm danger" data-act="userdel" data-id="${u.id}">Verwijder</button>`:""}<span class="pill ${u.active?"s-beschikbaar":"s-geannuleerd"}">${u.active?"Actief":"Uit"}</span></div>`};
  return `<div class="notice">Kantoor logt in op de dispatch. Chauffeurs loggen in op de chauffeursapp en zien alleen hun eigen ritten. Een chauffeurslogin maak je bij <b>Beheer → Chauffeurs</b> → kies de chauffeur.</div>
  <section class="sec"><div class="sec-h"><h2>Kantoor</h2>${admin?'<button class="btn sm primary" data-act="newuser">Kantoorlogin toevoegen</button>':""}</div><div class="list">${office.map(row).join("")||'<div class="empty">Geen kantoorlogins.</div>'}</div></section>
  <section class="sec"><div class="sec-h"><h2>Chauffeurs</h2><button class="btn sm" data-act="nav" data-v="chauffeurs">Naar chauffeurs</button></div><div class="list">${drv.map(row).join("")||'<div class="empty">Nog geen chauffeurslogins.</div>'}</div></section>`}

/* ---------- koppelingen ---------- */
async function loadSettings(){if(!S.me||S.me.role!=="admin")return;try{S.settings=await api("/api/settings");if(S.view==="koppelingen")render()}catch(e){toast(e.message)}}
function relayScript(key){return `const KEY = '${key}';

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.key !== KEY) return out({ ok: false, error: 'Ongeldige sleutel' });
  if (d.ping) return out({ ok: true, email: Session.getActiveUser().getEmail(), quota: MailApp.getRemainingDailyQuota() });
  const opts = {};
  if (d.fromName) opts.name = d.fromName;
  if (d.cc && d.cc.length) opts.cc = d.cc.join(',');
  if (d.attachments && d.attachments.length)
    opts.attachments = d.attachments.map(a => Utilities.newBlob(Utilities.base64Decode(a.data), a.mime, a.name));
  GmailApp.sendEmail(d.to.join(','), d.subject || '', d.body || '', opts);
  return out({ ok: true });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}`}
function vKoppelingen(){const st=S.status||{},admin=S.me&&S.me.role==="admin",s=S.settings;
  const dot=on=>`<span class="status-dot ${on?"on":"off"}"></span>${on?"Actief":"Niet ingesteld"}`;
  if(!admin)return `<div class="list"><div class="row"><span class="grow"><span class="t1">Mail</span></span>${dot(st.mail)}</div><div class="row"><span class="grow"><span class="t1">AI (PDF, CMR, assistent)</span></span>${dot(st.ai)}</div><div class="row"><span class="grow"><span class="t1">Vrachtwagenroutes</span></span>${dot(st.here)}</div></div><div class="notice">Alleen een beheerder kan koppelingen instellen.</div>`;
  if(!s)return `<div class="loading"><span class="spin"></span></div>`;
  const m=s.mail;
  return `<section class="sec"><div class="sec-h"><h2>Mail</h2><span>${dot(st.mail)}</span></div>
   ${m.viaEnv?'<div class="notice">Ingesteld via Railway-variabelen. Wijzig het daar.</div>':`<form class="form" data-form="setmail">
    <label class="field" for="sm_u"><span class="lbl">E-mailadres</span><input id="sm_u" name="user" type="email" value="${esc(m.user)}" placeholder="planning@jouwbedrijf.be"></label>
    <label class="field" for="sm_p"><span class="lbl">App-wachtwoord</span><input id="sm_p" name="pass" type="password" autocomplete="new-password" placeholder="${m.hasPass?"•••• opgeslagen (leeg laten = behouden)":"16 tekens van Google"}"></label>
    <label class="field full" for="sm_f"><span class="lbl">Naam afzender</span><input id="sm_f" name="fromName" value="${esc(m.fromName||S.bedrijf.naam||"")}" placeholder="Ghotra Transport"></label>
    <label class="field" for="sm_ih"><span class="lbl">IMAP-server (inkomend)</span><input id="sm_ih" name="imapHost" value="${esc(m.imapHost)}" placeholder="leeg = Google (imap.gmail.com)"></label><label class="field" for="sm_ip"><span class="lbl">IMAP-poort</span><input id="sm_ip" name="imapPort" type="number" value="${esc(m.imapPort||993)}"></label>
    <label class="field" for="sm_sh"><span class="lbl">SMTP-server (uitgaand)</span><input id="sm_sh" name="smtpHost" value="${esc(m.smtpHost)}" placeholder="leeg = Google (smtp.gmail.com)"></label><label class="field" for="sm_sp"><span class="lbl">SMTP-poort</span><input id="sm_sp" name="smtpPort" type="number" value="${esc(m.smtpPort||465)}"></label>
    <div class="full actions"><button class="btn primary" type="submit">Opslaan</button><button class="btn" type="button" data-act="mailtest">Verbinding testen</button></div>
    <div class="full muted" style="font-size:12.5px">Gmail of Google Workspace (ook met eigen domein): zet tweestapsverificatie aan en maak een app-wachtwoord via myaccount.google.com/apppasswords. Laat de servers leeg, dan gebruikt de app die van Google. Andere provider: vul de IMAP- en SMTP-gegevens van je provider in.</div>
    ${S.mailTest?`<div class="full notice ${S.mailTest.ok?"ok":"warn"}"><b>Testresultaat</b><span>Mail lezen: ${S.mailTest.lezen==="ok"?"✓ in orde"+(S.mailTest.unseen!=null?" ("+S.mailTest.unseen+" ongelezen)":""):esc(S.mailTest.lezen)}</span><span>Mail versturen: ${S.mailTest.versturen==="ok"?"✓ in orde via "+esc(S.mailTest.via||""):esc(S.mailTest.versturen)}</span></div>`:""}
    <div class="full sec" style="margin-top:6px"><h2 style="font-size:15px">Versturen via Google-hulpscript</h2>
     <div class="muted" style="font-size:13px">Nodig als Railway uitgaande mail blokkeert (Hobby-abonnement). De app verstuurt dan via je eigen Google-account; mails staan gewoon in Gmail bij Verzonden.</div>
     <ol style="margin:0;padding-left:20px;font-size:13.5px;display:flex;flex-direction:column;gap:4px">
      <li>Ga naar <b>script.google.com</b> (aangemeld met je zakelijke Google-account) → <b>Nieuw project</b>.</li>
      <li>Wis alles en plak het script hieronder (knop <b>Script kopiëren</b>). Klik op 💾 Opslaan.</li>
      <li>Klik rechtsboven op <b>Implementeren → Nieuwe implementatie</b> → tandwiel → <b>Web-app</b>. Uitvoeren als: <b>Ik</b>. Toegang: <b>Iedereen</b>. Klik op <b>Implementeren</b>.</li>
      <li>Geef toestemming. Zie je "Google heeft deze app niet geverifieerd": <b>Geavanceerd → Ga naar … (onveilig)</b>. Het is je eigen script.</li>
      <li>Kopieer de <b>URL van de web-app</b> (eindigt op /exec), plak hem hieronder, klik op Opslaan en daarna op Verbinding testen.</li></ol>
     <pre id="relayCode" style="background:var(--sunk);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:11.5px;overflow-x:auto;max-height:180px;margin:0">${esc(relayScript(m.relayKey||""))}</pre>
     <div><button class="btn sm" type="button" data-act="copyscript">Script kopiëren</button></div>
     <label class="field" for="sm_rl"><span class="lbl">URL van de web-app</span><input id="sm_rl" name="relayUrl" value="${esc(m.relayUrl||"")}" placeholder="https://script.google.com/macros/s/…/exec"></label>
     <div class="actions"><button class="btn primary" type="submit">Opslaan</button><button class="btn" type="button" data-act="mailtest">Verbinding testen</button></div></div></form>`}</section>
  <section class="sec"><div class="sec-h"><h2>AI: PDF-opdrachten, CMR-controle, assistent</h2><span>${dot(st.ai)}</span></div>
   ${s.ai.viaEnv?'<div class="notice">Ingesteld via Railway-variabelen.</div>':`<form class="form" data-form="setai"><label class="field full" for="sa_k"><span class="lbl">Anthropic API-sleutel</span><input id="sa_k" name="key" type="password" autocomplete="off" placeholder="${s.ai.hasKey?"•••• opgeslagen (leeg laten = behouden)":"sk-ant-…"}"></label>
    <label class="field full" for="sa_m"><span class="lbl">Model</span><input id="sa_m" name="model" value="${esc(s.ai.model)}"></label><div class="full actions"><button class="btn primary" type="submit">Opslaan</button></div>
    <div class="full muted" style="font-size:12.5px">Maak een sleutel op console.anthropic.com → API Keys. Je betaalt per gebruik.</div></form>`}</section>
  <section class="sec"><div class="sec-h"><h2>Vrachtwagenroutes</h2><span>${dot(st.here)}</span></div>
   ${s.here.viaEnv?'<div class="notice">Ingesteld via Railway-variabelen.</div>':`<form class="form" data-form="sethere"><label class="field full" for="sh_k"><span class="lbl">HERE API-sleutel</span><input id="sh_k" name="key" type="password" autocomplete="off" placeholder="${s.here.hasKey?"•••• opgeslagen (leeg laten = behouden)":"sleutel van platform.here.com"}"></label><div class="full actions"><button class="btn primary" type="submit">Opslaan</button><button class="btn" type="button" data-act="heretest">Route testen</button></div>
    <div class="full muted" style="font-size:12.5px">Maak een gratis account op platform.here.com en een API-sleutel. Vul daarna bij elk voertuig hoogte, breedte, lengte en massa in.</div></form>`}${S.hereTest?`<div class="notice ${S.hereTest.ok?"ok":"err"}">${esc(S.hereTest.msg)}</div>`:""}${s.here.viaEnv&&s.here.hasKey?'<div class="actions"><button class="btn" type="button" data-act="heretest">Route testen</button></div>':""}</section>`}

function vMeer(){const admin=S.me&&S.me.role==="admin",st=S.status||{};
  const items=[["documenten","Documenten",S.documents.length+" bestanden · vergunningen, verzekeringen, contracten"],["klanten","Klanten",S.customers.length+" klanten"],["chauffeurs","Chauffeurs",S.drivers.length+" chauffeurs · logins voor de chauffeursapp"],["voertuigen","Voertuigen",S.vehicles.length+" voertuigen"],["bedrijf","Bedrijfsgegevens","Gebruikt op facturen en CMR"],["facturatie","Facturatie","Wachttijd: "+(waitCfg().aan?fmin(waitCfg().vrij*60)+" vrij"+(waitCfg().tarief?" · "+eur(waitCfg().tarief)+"/u":" · nog geen tarief"):"uit")],["gebruikers","Logins",(S.users||[]).length+" logins voor kantoor en chauffeurs"],["koppelingen","Koppelingen",[st.mail?"mail ✓":"mail —",st.ai?"AI ✓":"AI —",st.here?"routes ✓":"routes —"].join(" · ")]];
  return `<div class="list">${items.map(([k,l,s])=>`<button class="row" data-act="nav" data-v="${k}"><span class="grow"><span class="t1">${l}</span><span class="t2">${s}</span></span><span class="muted">›</span></button>`).join("")}</div>
  <section class="sec"><h2>Mijn account</h2><div class="list"><button class="row" data-act="account"><span class="grow"><span class="t1">${esc((S.me||{}).name||(S.me||{}).email||"")}</span><span class="t2">${esc((S.me||{}).email||"")} · ${admin?"Beheerder":"Dispatch"}</span></span><span class="muted">›</span></button></div></section>
  ${hasVoorbeeld()?`<section class="sec"><h2>Voorbeeldgegevens</h2><div class="notice">Gegevens met het label <span class="tag">Voorbeeld</span> zijn testgegevens.<div><button class="btn danger" data-act="wipe">Voorbeeldgegevens wissen</button></div></div></section>`:""}`}

function renderSheet(){const sh=S.sheet;if(!sh)return;const p=$("#panel");
  const r={form:shForm,order:shOrder,invoice:shInvoice,newInvoice:shNewInvoice,thread:shThread,compose:shCompose,doc:shDoc,busy:shBusy,review:shReview,docnew:shDocNew,docview:shDocView,conflicts:shConflicts,route:shRoute,pwd:shPwd,newuser:shNewUser,account:shAccount}[sh.type];
  if(sh.type==="route"&&routeMap&&p.querySelector("#map")&&sh.state==="ok")return;
  if(routeMap&&sh.type!=="route"){routeMap.remove();routeMap=null;truckMarker=null}
  p.innerHTML=r(sh);
  if(sh.type==="form"&&sh.col==="drivers"&&sh.id)p.querySelector(".panel-b").insertAdjacentHTML("beforeend",driverLoginBlock(sh.id));
  if(sh.type==="route")drawRoute();
  if(["form","compose","docnew","newuser"].includes(sh.type)){const first=p.querySelector("input:not([type=hidden]):not([type=file]),select,textarea");if(first)setTimeout(()=>first.focus({preventScroll:true}),50)}}
function closeSheet(){if(routeMap){routeMap.remove();routeMap=null;truckMarker=null}S.sheet=null;$("#sheet").hidden=true;document.body.style.overflow=""}

/* ---------- meldingen (push) ---------- */
async function enablePush(){
  if(!("serviceWorker" in navigator)||!("PushManager" in window)){toast(/iPhone|iPad/.test(navigator.userAgent)?"Zet de app eerst op je beginscherm (Deel → Zet op beginscherm) en open hem van daaruit.":"Deze browser ondersteunt geen meldingen.");return}
  try{const perm=await Notification.requestPermission();if(perm!=="granted"){toast("Meldingen zijn niet toegestaan in de browser.");return}
    const reg=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;
    const {key}=await api("/api/push/key");const raw=Uint8Array.from(atob(key.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
    const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:raw});
    await api("/api/push/subscribe",{method:"POST",json:{endpoint:sub.endpoint}});await api("/api/push/test",{method:"POST",json:{}});toast("Meldingen staan aan")}
  catch(e){toast("Meldingen aanzetten lukte niet: "+(e.message||e))}}

/* ---------- acties: aanvullingen ---------- */
Object.assign(ACT,{
 thread:d=>{if(!mcp){toast("Mail is nog niet ingesteld.");return}openThread(d.id)},
 mailreload:()=>loadMail(),
 mailpreset:d=>{const gm=S.status&&S.status.mailGmail;S.mail.box=d.box||"inbox";S.mail.unread=d.unread==="1";S.mail.q=d.q&&(gm||!/^has:/.test(d.q))?d.q:"";S.mail.label=d.l;if(d.go){closeSheet();S.view="mail";if(location.hash!=="#mail")location.hash="mail"}loadMail()},
 mailsearch:d=>{const gm=S.status&&S.status.mailGmail;closeSheet();S.mail.box="inbox";S.mail.unread=false;S.mail.q=gm?d.q:String(d.q||"").replace(/"/g,"").split(" OR ")[0];S.mail.label="";S.view="mail";if(location.hash!=="#mail")location.hash="mail";loadMail()},
 pdf2order:async d=>{const m={...(S.sheet&&S.sheet.data||{})},key=S.sheet&&S.sheet.id;busy("Opdracht lezen","Bijlage uit de mail halen…",d.name);
   try{const f=await api("/api/mail/attachment",{method:"POST",json:{box:m.box,uid:m.uid,idx:+d.idx}});await importOrderPdf({fileId:f.id},f.name,{sender:senderName(m)+" <"+(m.from||"")+">",senderEmail:m.from||"",subject:m.subject||"",body:m.text||"",threadId:key})}
   catch(e){failed("Opdracht lezen",mailErr(e))}},
 att2doc:async d=>{const m={...(S.sheet&&S.sheet.data||{})};busy("Bijlage bewaren","Bijlage uit de mail halen…",d.name);
   try{const f=await api("/api/mail/attachment",{method:"POST",json:{box:m.box,uid:m.uid,idx:+d.idx}});openSheet({type:"docnew",fileId:f.id,file:{name:f.name,size:f.size,type:f.type},preset:{naam:f.name.replace(/\.[^.]+$/,""),categorie:"Overig"}})}
   catch(e){failed("Bijlage bewaren",mailErr(e))}},
 recheck:async d=>{busy("CMR verwerken","Claude controleert de CMR…","");try{await api(`/api/ai/cmr/${encodeURIComponent(d.id)}`,{method:"POST",json:{}});await reloadData()}catch(e){toast(e.message||"Controle lukte niet")}openSheet({type:"order",id:d.id})},
 deldoc:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Zeker? Tik nogmaals";return}
   const x=byId("documents",d.id);if(await del("documents",d.id)){if(x&&x.asset)api(`/api/files/${x.asset.id}`,{method:"DELETE"}).catch(()=>{});closeSheet();toast("Document verwijderd")}},
 route:d=>openRoute(d.id),
 assign:async d=>{const o=byId("orders",d.id);if(!o)return;const did=$("#as_d_"+d.id).value,vid=$("#as_v_"+d.id).value;
   if(!did){toast("Kies een chauffeur");return}
   const [f,t]=orderSpan(o),a=absInRange(did,f,t);if(a&&did!==o.chauffeurId){toast((byId("drivers",did)||{}).naam+" is "+abLabel(a).toLowerCase());return}
   if(did===o.chauffeurId&&vid===(o.voertuigId||"")){toast("Er is niets gewijzigd");return}
   const upd={chauffeurId:did,voertuigId:vid};if(did!==o.chauffeurId)upd.gezien=null;
   if(await patch("orders",o.id,upd)){const n=(byId("drivers",did)||{}).naam||"de chauffeur";toast(hasLogin(did)?`Rit ${o.ref} staat in de app van ${n}`:`Toegewezen aan ${n}, maar hij heeft nog geen login voor de app`);renderSheet()}},
 unassign:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Zeker? Tik nogmaals";return}
   const o=byId("orders",d.id);if(await patch("orders",d.id,{chauffeurId:"",gezien:null})){toast(`Rit ${o.ref} weggehaald bij de chauffeur`);renderSheet()}},
 fleetfocus:async d=>{if(!fleetMap)return;const L=window.L;const p=(S.positions||[]).find(x=>x.driverId===d.id);if(fleetTrail){fleetTrail.remove();fleetTrail=null}
   try{const pts=await api(`/api/track/${encodeURIComponent(d.id)}`);if(pts.length>1){fleetTrail=L.polyline(pts.map(x=>[x.lat,x.lng]),{color:"#7c4dcc",weight:4,opacity:.75}).addTo(fleetMap);fleetTrail._drv=d.id}}catch(e){}
   if(fleetTrail)fleetMap.fitBounds(fleetTrail.getBounds().extend(p?[p.lat,p.lng]:fleetTrail.getBounds().getCenter()),{padding:[30,30],maxZoom:14});else if(p)fleetMap.setView([p.lat,p.lng],13);else toast("Nog geen positie van deze chauffeur");
   if(p&&fleetMarkers[d.id])fleetMarkers[d.id].openTooltip();$("#fleetMap").scrollIntoView({behavior:"smooth",block:"start"})},
 account:()=>openSheet({type:"account"}),
 newuser:()=>openSheet({type:"newuser"}),
 logout:async()=>{try{await api("/api/logout",{method:"POST",json:{}})}catch(e){}location.href="/login"},
 pushon:()=>enablePush(),
 copy:async d=>{try{await navigator.clipboard.writeText(d.v);toast("Gekopieerd")}catch(e){const el=$("#pwdv");if(el){const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r)}toast("Kopieer de geselecteerde tekst")}},
 pwdmail:()=>{const sh=S.sheet;const url=location.origin+"/login";openSheet({type:"compose",draft:{to:sh.email,subject:"Je login voor de "+(sh.role==="driver"?"chauffeursapp":"dispatch")+" van "+(S.bedrijf.naam||"Ghotra Transport"),body:`Hallo ${sh.name||""},\n\nJe kunt inloggen op ${url}\nE-mail: ${sh.email}\nWachtwoord: ${sh.pwd}\n\nOp je telefoon of tablet: open de link, log in en kies "Zet op beginscherm". Zet daarna in de app de meldingen aan, dan krijg je een seintje bij een nieuwe rit.\n\nMet vriendelijke groeten,\n${S.bedrijf.naam||"Ghotra Transport"}`}})},
 userpwd:async(d,btn)=>{const u=(S.users||[]).find(x=>x.id===d.id);if(!u)return;if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Nieuw wachtwoord maken?";return}
   const pwd=genPassword();try{await api(`/api/users/${u.id}`,{method:"PATCH",json:{password:pwd}});openSheet({type:"pwd",title:"Nieuw wachtwoord ingesteld",email:u.email,pwd,name:u.name,role:u.role})}catch(e){toast(e.message)}},
 usertoggle:async d=>{const u=(S.users||[]).find(x=>x.id===d.id);if(!u)return;try{await api(`/api/users/${u.id}`,{method:"PATCH",json:{active:!u.active}});await loadUsers();toast(u.active?"Login uitgeschakeld":"Login ingeschakeld")}catch(e){toast(e.message)}},
 userdel:async(d,btn)=>{if(!btn.classList.contains("armed")){btn.classList.add("armed");btn.textContent="Zeker?";return}try{await api(`/api/users/${d.id}`,{method:"DELETE"});await loadUsers();toast("Login verwijderd")}catch(e){toast(e.message)}},
 heretest:async(d,btn)=>{btn.disabled=true;btn.textContent="Testen…";try{S.hereTest=await api("/api/settings/here/test",{method:"POST",json:{}});render();toast(S.hereTest.ok?"Vrachtwagenroutes werken":"Routes nog niet in orde, zie uitleg")}catch(e){toast(e.message)}btn.disabled=false;btn.textContent="Route testen"},
 mailtest:async(d,btn)=>{btn.disabled=true;btn.textContent="Testen…";try{const r=await api("/api/settings/mail/test",{method:"POST",json:{}});S.mailTest=r;render();toast(r.ok?"Mail werkt: lezen en versturen in orde":"Mail nog niet volledig in orde, zie uitleg")}catch(e){toast(e.message)}btn.disabled=false;btn.textContent="Verbinding testen"},
 copyscript:async()=>{const t=$("#relayCode").textContent;try{await navigator.clipboard.writeText(t);toast("Script gekopieerd")}catch(e){const r=document.createRange();r.selectNodeContents($("#relayCode"));const sl=getSelection();sl.removeAllRanges();sl.addRange(r);toast("Kopieer de geselecteerde tekst")}}
});

/* ---------- formulieren: aanvullingen ---------- */
Object.assign(SUBMIT,{
 bedrijf:async f=>{const data=readForm(f,F.bedrijf);if(await put("config","bedrijf",data))toast("Bedrijfsgegevens opgeslagen")},
 facturatie:async f=>{const data=readForm(f,F.facturatie);if(await put("config","facturatie",data)){toast("Facturatie-instellingen opgeslagen");render()}},
 docnew:async f=>{const sh=S.sheet,data=readForm(f,F.documents);const btn=f.querySelector("[type=submit]");
   if(sh.id){btn.disabled=true;if(await patch("documents",sh.id,data)){toast("Opgeslagen");openSheet({type:"docview",id:sh.id})}else btn.disabled=false;return}
   btn.disabled=true;btn.textContent="Opslaan…";
   try{let asset;
     if(sh.fileId)asset={id:sh.fileId,name:sh.file.name,type:sh.file.type,size:sh.file.size};
     else{const file=sh.file||(f.elements.file&&f.elements.file.files[0]);if(!file){toast("Kies een bestand");btn.disabled=false;btn.textContent="Opslaan";return}
       const blob=(file.type||"").startsWith("image/")&&file.size>2.5e6?await shrinkImage(file,2400):file;asset={id:await upload(blob,file.name),name:file.name,type:blob.type||file.type||"application/octet-stream",size:blob.size}}
     const docId=uid();if(await put("documents",docId,{...data,asset,geupload:new Date().toISOString()})){toast("Document bewaard");openSheet({type:"docview",id:docId})}else{btn.disabled=false;btn.textContent="Opslaan"}}
   catch(e){toast(upMsg(e));btn.disabled=false;btn.textContent="Opslaan"}},
 reply:async f=>{const sh=S.sheet,m=sh.data||{};const body=f.elements.body.value.trim();if(!body)return;const btn=$("#rp_send");btn.disabled=true;btn.textContent="Versturen…";
   const me=String((S.status||{}).mailUser||"").toLowerCase(),emails=s=>(String(s||"").match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g)||[]).map(x=>x.toLowerCase());
   const cc=f.elements.all.checked?[...new Set([...emails(m.to),...emails(m.cc)])].filter(x=>x!==me&&x!==m.from):[];
   const quoted=`\n\nOp ${fdt(m.date)} schreef ${senderName(m)}:\n`+String(m.text||"").split("\n").slice(0,40).map(l=>"> "+l).join("\n");
   try{await api("/api/mail/send",{method:"POST",json:{to:[m.from],cc,subject:/^re:/i.test(m.subject||"")?m.subject:"Re: "+(m.subject||""),body:body+quoted,inReplyTo:m.messageId||"",references:m.references||""}});
     toast("Antwoord verstuurd");const lk=S.maillog.find(x=>x.threadId===sh.id&&x.orderId);if(lk)put("maillog",uid(),{threadId:sh.id,orderId:lk.orderId,subject:"Re: "+(m.subject||""),to:m.from,date:new Date().toISOString(),kind:"sent"});closeSheet()}
   catch(e){btn.disabled=false;btn.textContent="Verstuur antwoord";toast(mailErr(e))}},
 compose:async f=>{const d=S.sheet.draft;
   const to=splitMails(f.elements.to.value),cc=splitMails(f.elements.cc.value),bad=[...to,...cc].filter(x=>!isMail(x));
   if(!to.length||bad.length){toast(bad.length?"Ongeldig adres: "+bad[0]:"Vul een ontvanger in");return}
   if(!mcp){toast("Mail is nog niet ingesteld (Beheer → Koppelingen).");return}
   const btn=f.querySelector("[type=submit]");btn.disabled=true;btn.textContent="Versturen…";
   try{const {attachments}=await buildAttachments({invoiceId:d.pdfInvoice,cmrOrders:d.cmrOf?[d.cmrOf]:[],docId:d.assetDoc});
     await api("/api/mail/send",{method:"POST",json:{to,cc,subject:f.elements.subject.value,body:f.elements.body.value,attachments}});
     const oid=f.elements.orderId.value;
     if(oid||d.invoiceId)put("maillog",uid(),{threadId:"",orderId:oid||"",invoiceId:d.invoiceId||"",subject:f.elements.subject.value,to:to.join(", "),date:new Date().toISOString(),kind:"sent"});
     if(d.invoiceId)patch("invoices",d.invoiceId,{verstuurd:new Date().toISOString(),aan:to.join(", ")});
     toast("Mail verstuurd");closeSheet()}
   catch(e){btn.disabled=false;btn.textContent="Versturen";toast(mailErr(e))}},
 review:async(f,sub)=>{const mode=(sub&&sub.value)||"save",i=byId("invoices",S.sheet.id);if(!i)return;const r=readReview(f,i),k=byId("customers",i.klantId)||{};
   const btns=f.querySelectorAll("[type=submit]");btns.forEach(b=>b.disabled=true);const re=()=>btns.forEach(b=>b.disabled=false);
   if(mode==="send"){const to=splitMails(r.aan),bad=to.filter(x=>!isMail(x));if(!to.length||bad.length){toast(bad.length?"Ongeldig adres: "+bad[0]:"Vul het mailadres van de klant in");re();return}if(!mcp){toast("Mail is nog niet ingesteld (Beheer → Koppelingen).");re();return}}
   if(mode==="peppol"){const pr=ublProblems({...i,...r});if(pr.length){toast("Vul eerst aan: "+pr.join(", "));re();return}}
   if(f.elements.bewaarAan&&f.elements.bewaarAan.checked&&isMail(r.aan)&&k.id)patch("customers",k.id,{emailFactuur:r.aan});
   if(!await patch("invoices",i.id,{...r,status:mode==="save"?"Concept":"Open"})){re();return}
   if(mode==="save"){toast("Concept bewaard");closeSheet();return}
   for(const oid of i.orderIds||[])await patch("orders",oid,{status:"Gefactureerd",factuurId:i.id});
   if(mode==="approve"){toast("Factuur "+i.nr+" goedgekeurd");openSheet({type:"invoice",id:i.id});return}
   if(mode==="peppol"){const ok=await downloadUbl(byId("invoices",i.id)||i);toast(ok?"Goedgekeurd. Lever het bestand Factuur-"+i.nr+".xml aan in Lucy om via Peppol te versturen.":"Goedgekeurd, maar de e-factuur is nog niet gemaakt.");openSheet({type:"invoice",id:i.id});return}
   $("#rvSend").textContent="Versturen…";
   try{const cmrOrders=(i.orderIds||[]).filter(oid=>f.elements["cmr_"+oid]&&f.elements["cmr_"+oid].checked);
     const {attachments}=await buildAttachments({invoiceId:i.id,cmrOrders});
     await api("/api/mail/send",{method:"POST",json:{to:splitMails(r.aan),subject:r.mailSubject,body:r.mailBody,attachments}});
     const now=new Date().toISOString();await patch("invoices",i.id,{verstuurd:now});
     put("maillog",uid(),{threadId:"",orderId:(i.orderIds||[])[0]||"",invoiceId:i.id,subject:r.mailSubject,to:r.aan,date:now,kind:"sent"});
     toast("Factuur "+i.nr+" verstuurd");openSheet({type:"invoice",id:i.id})}
   catch(e){toast(mailErr(e));openSheet({type:"invoice",id:i.id})}},
 drvlogin:async f=>{const did=f.dataset.driver,d=byId("drivers",did)||{},email=f.elements.email.value.trim(),pwd=genPassword();const btn=f.querySelector("[type=submit]");btn.disabled=true;
   try{await api("/api/users",{method:"POST",json:{email,name:d.naam||"",role:"driver",driverId:did,password:pwd}});if(!d.email)patch("drivers",did,{email});await loadUsers();openSheet({type:"pwd",title:"Login voor "+(d.naam||"chauffeur")+" aangemaakt",email,pwd,name:d.naam,role:"driver"})}
   catch(e){toast(e.message);btn.disabled=false}},
 newuser:async f=>{const pwd=genPassword(),b={name:f.elements.name.value.trim(),email:f.elements.email.value.trim(),role:f.elements.role.value,password:pwd};const btn=f.querySelector("[type=submit]");btn.disabled=true;
   try{await api("/api/users",{method:"POST",json:b});await loadUsers();openSheet({type:"pwd",title:"Kantoorlogin aangemaakt",email:b.email,pwd,name:b.name,role:b.role})}catch(e){toast(e.message);btn.disabled=false}},
 pwd:async f=>{try{await api("/api/me/password",{method:"POST",json:{current:f.elements.current.value,password:f.elements.password.value}});toast("Wachtwoord gewijzigd");closeSheet()}catch(e){toast(e.message)}},
 setmail:async f=>{const b=Object.fromEntries(new FormData(f));try{await api("/api/settings/mail",{method:"PUT",json:b});await reloadData();await loadSettings();toast("Mail opgeslagen. Test de verbinding.");S.mail.state="idle"}catch(e){toast(e.message)}},
 setai:async f=>{const b=Object.fromEntries(new FormData(f));try{await api("/api/settings/ai",{method:"PUT",json:b});await reloadData();await loadSettings();toast("AI-instelling opgeslagen")}catch(e){toast(e.message)}},
 sethere:async f=>{const b=Object.fromEntries(new FormData(f));try{await api("/api/settings/here",{method:"PUT",json:b});await reloadData();await loadSettings();toast("Routes ingesteld")}catch(e){toast(e.message)}}
});



/* ---------- wachttijd (standtijd boven de vrije tijd) ---------- */
const numOrNull=v=>v===""||v==null||isNaN(+v)?null:+v;
const fmin=m=>{m=Math.round(m);const h=Math.floor(m/60),mm=m%60;return h&&mm?`${h} u ${z(mm)}`:h?`${h} u`:`${mm} min`};
function waitCfg(){const c=S.facturatie||{};return{aan:c.aan!=="nee",vrij:numOrNull(c.vrijeUren)??2,tarief:numOrNull(c.uurTarief),afr:numOrNull(c.afronding)||15}}
function waitStops(o){const t=o.tijden||{},c=waitCfg(),vrij=numOrNull(o.vrijeUren)??c.vrij,tarief=numOrNull(o.wachtTarief)??c.tarief;
  return [["Laden",t.Laden,t["Naar losplaats"],o.laadplaats],["Lossen",t.Lossen,t.Gelost,o.losplaats]].map(([n,a,b,pl])=>{if(!a||!b)return null;const mins=(new Date(b)-new Date(a))/60000;if(!(mins>0))return null;
    const over=Math.max(0,mins-vrij*60),extra=over>0?Math.ceil(over/c.afr)*c.afr:0;return{stop:n,plaats:pl,mins,vrij,extra,tarief,bedrag:tarief&&c.aan?r2(extra/60*tarief):0}}).filter(Boolean)}
function waitLines(o){return waitStops(o).filter(w=>w.extra>0&&w.bedrag>0).map(w=>({orderId:o.id,soort:"wacht",omschrijving:`Wachttijd ${w.stop.toLowerCase()} ${w.plaats} · rit ${o.ref}: ${fmin(w.mins)} ter plaatse, ${fmin(w.vrij*60)} vrij → ${fmin(w.extra)} × ${eur(w.tarief)}/u`,bedrag:w.bedrag}))}
function waitSummaryHTML(o){const ws=waitStops(o);if(!ws.length)return"";
  return `<section class="sec"><span class="lbl">Standtijd</span><div class="timeline">${ws.map(w=>`<div><span>${w.stop} ${esc(w.plaats)}: ${fmin(w.mins)}</span><span class="mono" style="${w.extra>0?"color:var(--warn)":""}">${w.extra>0?(w.bedrag?"wachttijd "+fmin(w.extra)+" · "+eur(w.bedrag):"wachttijd "+fmin(w.extra)+" · geen tarief"):"binnen vrije tijd"}</span></div>`).join("")}</div></section>`}
function vFacturatie(){const v={aan:"ja",vrijeUren:2,afronding:"15",...(S.facturatie||{})};const ex=numOrNull(v.uurTarief)||45,vr=numOrNull(v.vrijeUren)??2;
  return `<form class="form" data-form="facturatie">${F.facturatie.fields.map(f=>fieldHTML(f,v)).join("")}<div class="full actions"><button class="btn primary" type="submit">Opslaan</button></div></form>
  <div class="notice"><b>Zo werkt het</b>De app meet per laad- en losplaats de tijd tussen de knoppen van de chauffeur: bij laden van "start laden" tot "geladen · vertrek", bij lossen van "start lossen" tot "gelost". Wat boven de vrije tijd gaat, komt als extra regel op de conceptfactuur. Per rit kun je een eigen tarief of vrije tijd invullen; leeg = deze standaard.<br><br>Voorbeeld: aangekomen 08:00, vertrokken 10:40 = 2 u 40 ter plaatse. Met ${fmin(vr*60)} vrij en afronding per kwartier wordt ${fmin(Math.ceil(Math.max(0,160-vr*60)/15)*15)} × ${eur(ex)} = ${eur(Math.ceil(Math.max(0,160-vr*60)/15)*15/60*ex)}.</div>`}



/* ---------- rit toewijzen aan chauffeur (via de app, niet via mail) ---------- */
function assignBlock(o){if(["Gefactureerd","Geannuleerd"].includes(o.status))return"";
  const c=chauffeur(o),v=voertuig(o),[f,t]=orderSpan(o),login=c&&hasLogin(c.id);
  const opts=driverOpts(f,t,o.chauffeurId);
  const vopts=[["","— geen voertuig —"],...S.vehicles.slice().sort((a,b)=>(a.kenteken||"").localeCompare(b.kenteken||"")).map(x=>[x.id,x.kenteken+(x.type?" · "+x.type:"")])];
  const state=!c?`<div class="notice warn" style="margin:0"><b>Nog geen chauffeur</b>Kies een chauffeur en klik op Toewijzen. Hij krijgt de rit meteen in zijn app, met een melding.</div>`
    :!login?`<div class="notice warn" style="margin:0"><b>${esc(c.naam)} heeft nog geen login voor de app</b>Maak er een aan bij Beheer → Chauffeurs, anders ziet hij de rit niet.<div><button class="btn sm" data-act="edit-drivers" data-id="${c.id}">Login aanmaken</button></div></div>`
    :`<div class="notice ${o.gezien?"ok":""}" style="margin:0"><b>In de app van ${esc(c.naam)}</b>${o.gezien?"Gezien op "+ftime(o.gezien):"Verstuurd, nog niet geopend door de chauffeur"}${o.status!=="Gepland"?" · "+esc(o.status):""}</div>`;
  return `<section class="sec"><span class="lbl">Chauffeur en voertuig</span>${state}
   <div class="search"><select id="as_d_${o.id}" aria-label="Chauffeur">${opts.map(([a,b,dis])=>`<option value="${esc(a)}" ${a===(o.chauffeurId||"")?"selected":""} ${dis?"disabled":""}>${esc(b)}</option>`).join("")}</select>
   <select id="as_v_${o.id}" aria-label="Voertuig">${vopts.map(([a,b])=>`<option value="${esc(a)}" ${a===(o.voertuigId||"")?"selected":""}>${esc(b)}</option>`).join("")}</select></div>
   <div class="actions"><button class="btn primary" data-act="assign" data-id="${o.id}">${c?"Wijziging naar de app sturen":"Toewijzen en naar de app sturen"}</button>${c?`<button class="btn" data-act="unassign" data-id="${o.id}">Chauffeur weghalen</button>`:""}</div></section>`}

/* ---------- live kaart van de vloot ---------- */
let fleetMap=null,fleetMarkers={},fleetTrail=null;
const posAge=p=>Date.now()-p.at;
const posCls=p=>posAge(p)<5*60e3?"live":posAge(p)<60*60e3?"recent":"oud";
function fleetRows(){return S.drivers.slice().sort((a,b)=>(a.naam||"").localeCompare(b.naam||"")).map(d=>{const p=(S.positions||[]).find(x=>x.driverId===d.id);const o=S.orders.find(x=>x.chauffeurId===d.id&&ACTIVE.includes(x.status))||(p&&p.orderId&&byId("orders",p.orderId));const v=o&&voertuig(o);return{d,p,o,v}})}
function fleetCard(){const rows=fleetRows().filter(r=>r.p);const live=rows.filter(r=>posCls(r.p)==="live").length;
  return `<section class="sec"><div class="sec-h"><h2>Vloot live</h2><button class="btn sm" data-act="nav" data-v="kaart">Kaart openen</button></div>
   <button class="kpi" data-act="nav" data-v="kaart" style="flex-direction:row;align-items:center;gap:14px"><span class="v">${live}</span><span><b>${live===1?"vrachtwagen":"vrachtwagens"} live op de kaart</b><br><span class="muted" style="font-size:12.5px">${rows.length?rows.length+" met een positie · ":"Nog geen posities. "}${rows.length?"tik om te volgen":"Zet tabletmodus aan in de chauffeursapp."}</span></span></button></section>`}
function vKaart(){const rows=fleetRows();
  return `<div id="fleetMap" class="map" style="height:min(62vh,560px)"></div>
  <div class="list">${rows.map(r=>{const c=r.p?posCls(r.p):"";return `<button class="row" data-act="fleetfocus" data-id="${r.d.id}"><span class="status-dot ${c==="live"?"on":"off"}" style="${c==="recent"?"background:var(--warn)":""}"></span><span class="grow"><span class="t1">${esc(r.d.naam)}${r.v?` <span class="plate">${esc(r.v.kenteken)}</span>`:""}</span><span class="t2">${r.o?esc(r.o.ref)+" · "+esc(r.o.status)+" · "+esc(r.o.laadplaats)+" → "+esc(r.o.losplaats):"Geen actieve rit"}</span></span><span class="t2 muted">${r.p?ago(r.p.at)+(r.p.speed!=null&&posAge(r.p)<5*60e3?" · "+Math.round(r.p.speed*3.6)+" km/u":""):"geen positie"}</span></button>`}).join("")||'<div class="empty">Nog geen chauffeurs.</div>'}</div>
  <div class="notice"><b>Zo werkt het</b>De positie komt van de chauffeursapp. Zet op de tablet in de vrachtwagen <b>Menu → Tabletmodus</b> aan, laat de app open en de tablet aan de lader. Dan gaat de positie elke 30 seconden naar hier, ook zonder rit. Tik op een chauffeur voor zijn spoor van vandaag.</div>`}
function truckIcon(L,r){const c=!r.p?"#9aa49e":posCls(r.p)==="live"?(r.o?"#7c4dcc":"#0d9466"):posCls(r.p)==="recent"?"#a96608":"#9aa49e";
  return L.divIcon({className:"",iconSize:[0,0],html:`<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center"><div style="background:${c};color:#fff;font:600 12px Inter,sans-serif;padding:3px 8px;border-radius:8px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3)">🚛 ${esc((r.d.naam||"").split(" ")[0])}${r.v?" · "+esc(r.v.kenteken):""}</div><div style="width:0;height:0;border:6px solid transparent;border-top-color:${c}"></div></div>`})}
async function drawFleet(){const el=$("#fleetMap");if(!el)return;let L;try{L=await loadLeaflet()}catch(e){el.outerHTML='<div class="notice">De kaart kon niet laden.</div>';return}
  if(fleetMap&&fleetMap.getContainer()!==el){fleetMap.remove();fleetMap=null;fleetMarkers={};fleetTrail=null}
  const first=!fleetMap;
  if(first){fleetMap=L.map(el);L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(fleetMap);fleetMap.setView([50.85,4.35],8)}
  const rows=fleetRows().filter(r=>r.p),seen=new Set();
  rows.forEach(r=>{seen.add(r.d.id);const ll=[r.p.lat,r.p.lng];const tip=`${r.d.naam}${r.v?" · "+r.v.kenteken:""}<br>${r.o?r.o.ref+" · "+r.o.status:"Geen actieve rit"}<br>${ago(r.p.at)}`;
    if(fleetMarkers[r.d.id])fleetMarkers[r.d.id].setLatLng(ll).setIcon(truckIcon(L,r)).setTooltipContent(tip);
    else fleetMarkers[r.d.id]=L.marker(ll,{icon:truckIcon(L,r)}).addTo(fleetMap).bindTooltip(tip,{direction:"top",offset:[0,-30]}).on("click",()=>ACT.fleetfocus({id:r.d.id}))});
  Object.keys(fleetMarkers).forEach(k=>{if(!seen.has(k)){fleetMarkers[k].remove();delete fleetMarkers[k]}});
  if(first&&rows.length)fleetMap.fitBounds(L.latLngBounds(rows.map(r=>[r.p.lat,r.p.lng])).pad(.3),{maxZoom:12})}

/* ---------- e-factuur (Peppol BIS Billing 3.0 / UBL) ---------- */
const isBEklant=k=>/^BE/i.test(String((k||{}).btw||"").replace(/\s/g,""));
const xmlEsc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
const amt=n=>(Math.round((+n||0)*100)/100).toFixed(2);
function splitAdres(a,btw){const lines=String(a||"").split(/\n|,\s*/).map(x=>x.trim()).filter(Boolean);let pc="",city="",street=lines[0]||"";
  for(const l of lines){const m=/^(?:[A-Z]{1,2}-)?(\d{4,5})\s+(.+)$/.exec(l);if(m){pc=m[1];city=m[2];if(l===street)street=""}}
  return{street,pc,city,country:String(btw||"BE").replace(/\s/g,"").slice(0,2).toUpperCase()||"BE"}}
const vatDigits=b=>String(b||"").replace(/[^0-9]/g,"");
function partyXml(name,adres,btw){const a=splitAdres(adres,btw),v=String(btw||"").replace(/[\s.]/g,"").toUpperCase(),kbo=vatDigits(v);
  return `<cac:Party><cbc:EndpointID schemeID="0208">${xmlEsc(kbo)}</cbc:EndpointID><cac:PartyName><cbc:Name>${xmlEsc(name)}</cbc:Name></cac:PartyName><cac:PostalAddress>${a.street?`<cbc:StreetName>${xmlEsc(a.street)}</cbc:StreetName>`:""}${a.city?`<cbc:CityName>${xmlEsc(a.city)}</cbc:CityName>`:""}${a.pc?`<cbc:PostalZone>${xmlEsc(a.pc)}</cbc:PostalZone>`:""}<cac:Country><cbc:IdentificationCode>${xmlEsc(a.country)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${xmlEsc(v)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(name)}</cbc:RegistrationName><cbc:CompanyID schemeID="0208">${xmlEsc(kbo)}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party>`}
function taxCat(btw){if(btw==="21")return{id:"S",pct:"21",reason:""};if(btw==="0v")return{id:"AE",pct:"0",reason:"Btw verlegd – medecontractant"};return{id:"E",pct:"0",reason:"Vrijgesteld – internationaal goederenvervoer"}}
function ublProblems(i){const b=S.bedrijf||{},k=byId("customers",i.klantId)||{},p=[];
  if(!vatDigits(b.btw))p.push("btw-nummer van je bedrijf (Beheer → Bedrijfsgegevens)");if(!b.adres)p.push("adres van je bedrijf");if(!b.iban)p.push("IBAN van je bedrijf");
  if(!vatDigits(k.btw))p.push("btw-nummer van de klant");if(!k.adres)p.push("adres van de klant");return p}
async function ublXml(i){const b=S.bedrijf||{},k=byId("customers",i.klantId)||{},lines=invLines(i),tc=taxCat(i.btw),t=calcTotals(lines,i.btw);
  const pdf=b64bytes(await invoicePdf(i));
  const atts=[`<cac:AdditionalDocumentReference><cbc:ID>${xmlEsc(i.nr)}</cbc:ID><cbc:DocumentDescription>Factuur ${xmlEsc(i.nr)}</cbc:DocumentDescription><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="Factuur-${xmlEsc(i.nr)}.pdf">${pdf}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`];
  for(const id of i.orderIds||[]){const o=byId("orders",id);if(!o||!o.cmr)continue;try{const bytes=await assetBytes(o.cmr.id);if(bytes.length>4e6)continue;const mime=o.cmr.type==="application/pdf"?"application/pdf":"image/jpeg";
    atts.push(`<cac:AdditionalDocumentReference><cbc:ID>CMR-${xmlEsc(o.ref)}</cbc:ID><cbc:DocumentDescription>Ondertekende CMR rit ${xmlEsc(o.ref)}</cbc:DocumentDescription><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="${mime}" filename="CMR-${xmlEsc(o.ref)}${mime==="application/pdf"?".pdf":".jpg"}">${b64bytes(bytes)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`)}catch(e){}}
  const refs=[...new Set((i.orderIds||[]).map(id=>(byId("orders",id)||{}).referentieKlant).filter(Boolean))];
  const cat=`<cbc:ID>${tc.id}</cbc:ID><cbc:Percent>${tc.pct}</cbc:Percent>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${xmlEsc(i.nr)}</cbc:ID>
<cbc:IssueDate>${xmlEsc(i.datum)}</cbc:IssueDate>
<cbc:DueDate>${xmlEsc(i.vervaldatum)}</cbc:DueDate>
<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
${tc.reason?`<cbc:Note>${xmlEsc(tc.reason)}</cbc:Note>\n`:""}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cbc:BuyerReference>${xmlEsc(refs.join(", ")||i.nr)}</cbc:BuyerReference>
${atts.join("\n")}
<cac:AccountingSupplierParty>${partyXml(b.naam||"Ghotra Transport",b.adres,b.btw)}</cac:AccountingSupplierParty>
<cac:AccountingCustomerParty>${partyXml(k.naam||"",k.adres,k.btw)}</cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode name="Overschrijving">30</cbc:PaymentMeansCode><cbc:PaymentID>${xmlEsc(i.ogm||ogm(i.nr))}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${xmlEsc(String(b.iban||"").replace(/\s/g,""))}</cbc:ID><cbc:Name>${xmlEsc(b.naam||"")}</cbc:Name></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:PaymentTerms><cbc:Note>Betaling binnen ${xmlEsc(i.termijn||30)} dagen, uiterlijk ${xmlEsc(i.vervaldatum)}</cbc:Note></cac:PaymentTerms>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${amt(t.btwBedrag)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${amt(t.btwBedrag)}</cbc:TaxAmount><cac:TaxCategory>${cat}${tc.reason?`<cbc:TaxExemptionReason>${xmlEsc(tc.reason)}</cbc:TaxExemptionReason>`:""}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${amt(t.subtotaal)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${amt(t.totaal)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${amt(t.totaal)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines.map((l,n)=>`<cac:InvoiceLine><cbc:ID>${n+1}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">${amt(l.bedrag)}</cbc:LineExtensionAmount><cac:Item><cbc:Description>${xmlEsc(l.omschrijving)}</cbc:Description><cbc:Name>${xmlEsc(String(l.omschrijving).split(" · ")[0].slice(0,100))}</cbc:Name><cac:ClassifiedTaxCategory>${cat}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${amt(l.bedrag)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join("\n")}
</Invoice>`}
async function downloadUbl(i){const p=ublProblems(i);if(p.length){toast("Vul eerst aan: "+p.join(", "));return false}
  try{await saveFile("Factuur-"+i.nr+".xml",new Blob([await ublXml(i)],{type:"application/xml"}));patch("invoices",i.id,{peppol:{gemaakt:new Date().toISOString()}});return true}catch(e){toast("E-factuur maken lukte niet: "+(e.message||e));return false}}
ACT["dl-ubl"]=async d=>{const i=byId("invoices",d.id);if(i&&await downloadUbl(i))toast("E-factuur gedownload. Lever ze aan in Lucy om via Peppol te versturen.")};

/* ---------- live updates ---------- */
function startEvents(){let had=false;const es=new EventSource("/api/events");
  es.onopen=()=>{if(had)reloadData().then(render).catch(()=>{});had=true};
  es.onmessage=ev=>{let m;try{m=JSON.parse(ev.data)}catch(e){return}
    if(m.type==="rec"){const mine=Date.now()-(recentLocal.get(m.col+":"+m.id)||0)<6000;
      const prev=["orders","absences","invoices"].includes(m.col)?byId(m.col,m.id):null;
      applyLocal(m.col,m.id,m.doc);
      if(!mine&&m.doc){const d=m.doc;
        if(m.col==="orders"&&prev){const st=LEGACY[d.status]||d.status,c=byId("drivers",d.chauffeurId);
          if(prev.status!==st)toast(`${d.ref}: ${c?c.naam+" · ":""}${st}`);else if(!prev.gezien&&d.gezien)toast(`${d.ref} is gezien door ${c?c.naam:"de chauffeur"}`)}
        if(m.col==="absences"&&!prev){const c=byId("drivers",d.chauffeurId);toast(`${c?c.naam:"Een chauffeur"}: ${d.type.toLowerCase()} gemeld`)}
        if(m.col==="invoices"&&!prev&&d.status==="Concept")toast(`Conceptfactuur ${d.nr} klaar ter controle`)}
      liveRender()}
    if(m.type==="mail"){const items=m.items||[];if(!items.length)return;
      if(S.mail.box==="inbox"&&!S.mail.q&&(S.mail.state==="ok"||S.mail.state==="more")){const have=new Set(S.mail.threads.map(t=>t.box+"-"+t.uid));S.mail.threads=items.filter(t=>!have.has(t.box+"-"+t.uid)).concat(S.mail.threads)}
      else if(S.view!=="mail"){S.mail.state="idle"}
      const f=items[0];toast(items.length===1?`Nieuwe mail van ${f.fromName||f.from}: ${f.subject||"(geen onderwerp)"}`:`${items.length} nieuwe mails`);
      render();return}
    if(m.type==="pos"){S.positions=S.positions||[];const i=S.positions.findIndex(p=>p.driverId===m.pos.driverId);if(i>=0)S.positions[i]=m.pos;else S.positions.push(m.pos);updateTruck();if(S.view==="kaart"&&fleetMap)drawFleet();if(fleetTrail&&fleetTrail._drv===m.pos.driverId)fleetTrail.addLatLng([m.pos.lat,m.pos.lng])}}}

/* ---------- boot ---------- */
(async function boot(){
  const h=location.hash.slice(1);if(h&&(NAV.some(n=>n[0]===h)||SUBVIEWS[h]))S.view=h;
  render();
  try{S.me=(await api("/api/me")).user}catch(e){return}
  try{await reloadData();S.dbState="on"}catch(e){S.dbErr=e.code||"fout";render();return}
  if(!mcp)S.mail.state="nomcp";
  render();
  loadUsers();
  startEvents();
  if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});
  if(S.view==="koppelingen")loadSettings();
  if(mcp)loadMail();
  if(false)setInterval(()=>{if(mcp&&S.view!=="mail"&&document.visibilityState==="visible")api(`/api/mail/list?box=inbox&page=0`).then(r=>{if(S.mail.box==="inbox"&&!S.mail.q&&!S.mail.unread){S.mail.threads=(r.items||[]).map(x=>({...x,box:"inbox"}));S.mail.next=r.next;S.mail.state="ok";render()}}).catch(()=>{})},120000);
})();


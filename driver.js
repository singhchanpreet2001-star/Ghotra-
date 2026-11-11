"use strict";
/* Ghotra Chauffeur — eigen ritten, stappen, CMR, route, meldingen. */
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const z=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate());
const TODAY=()=>ymd(new Date());
const fdt=s=>s?new Date(s).toLocaleString("nl-BE",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—";
const ftime=s=>s?new Date(s).toLocaleTimeString("nl-BE",{hour:"2-digit",minute:"2-digit"}):"";
const fdur=s=>{const h=Math.floor(s/3600),m=Math.round(s%3600/60);return h?h+" u "+z(m):m+" min"};
const fkm=m=>m>=1000?(m/1000).toFixed(m>=10000?0:1)+" km":Math.round(m/10)*10+" m";

const FLOW=["Gepland","Naar laadplaats","Laden","Naar losplaats","Lossen","Gelost"];
const ACTIVE=["Naar laadplaats","Laden","Naar losplaats","Lossen"];
const NEXT={"Gepland":["Naar laadplaats","Vertrek naar laadplaats"],"Naar laadplaats":["Laden","Aangekomen · start laden"],"Laden":["Naar losplaats","Geladen · vertrek naar losplaats"],"Naar losplaats":["Lossen","Aangekomen · start lossen"]};
const sCls=s=>"s-"+String(s||"").toLowerCase().replace(/\s/g,"");

const S={me:null,orders:[],busy:false,seen:new Set(),geo:null,lastPos:null,lastSent:0};

let tt;function toast(m){const t=$("#toast");t.textContent=m;t.hidden=false;clearTimeout(tt);tt=setTimeout(()=>t.hidden=true,3800)}
async function api(path,opt={}){const isJson=opt.json!==undefined;let r;
  try{r=await fetch(path,{method:opt.method||(isJson?"POST":"GET"),headers:{"x-ghotra":"1",...(isJson?{"content-type":"application/json"}:{}),...(opt.headers||{})},body:isJson?JSON.stringify(opt.json):opt.body,credentials:"same-origin"})}
  catch(e){throw{message:"Geen verbinding. Controleer je internet en probeer opnieuw."}}
  if(r.status===401){location.href="/login";throw{message:"Niet aangemeld"}}
  const j=(r.headers.get("content-type")||"").includes("json")?await r.json().catch(()=>({})):{};
  if(!r.ok)throw{status:r.status,message:j.error||("Fout "+r.status)};return j}

const byId=id=>S.orders.find(o=>o.id===id);
function current(){return S.orders.find(o=>ACTIVE.includes(o.status))||S.orders.filter(o=>o.status==="Gepland").sort((a,b)=>String(a.laaddatum).localeCompare(String(b.laaddatum)))[0]||null}
function steps(o){const i=FLOW.indexOf(o.status);return `<div class="drv-step">${FLOW.slice(1).map((s,k)=>`<span class="${k<i?"on":""}" title="${s}"></span>`).join("")}</div>`}
const addr=(o,which)=>(which==="laad"?(o.laadadres||o.laadplaats):(o.losadres||o.losplaats)||"").replace(/\n/g,", ");
const gmaps=dest=>"https://www.google.com/maps/dir/?api=1&travelmode=driving&destination="+encodeURIComponent(dest);

/* ---------- views ---------- */
function render(){setTimeout(geoBadge,0);
  const h=location.hash.slice(1);
  if(h.startsWith("route-"))return;
  closeMapView();
  if(h.startsWith("rit-")&&byId(h.slice(4)))return renderDetail(byId(h.slice(4)));
  renderHome()}
function bannerHTML(){let s="";
  if(S.me&&S.me.afwezig)s+=`<div class="notice warn"><b>Je staat vandaag als ${esc(S.me.afwezig.type.toLowerCase())} gemeld</b>${S.me.afwezig.tot?"Tot en met "+new Date(S.me.afwezig.tot+"T12:00").toLocaleDateString("nl-BE",{day:"numeric",month:"long"}):"Tot nader bericht"}. Kantoor plant je ritten om.</div>`;
  if(!("Notification" in window)||Notification.permission!=="granted")s+=`<div class="notice"><b>Zet meldingen aan</b>Dan krijg je meteen een seintje bij een nieuwe of gewijzigde rit.${/iPhone|iPad/.test(navigator.userAgent)&&!navigator.standalone?" Op iPhone of iPad: zet deze app eerst op je beginscherm (Deel-knop → Zet op beginscherm) en open hem van daaruit.":""}<div><button class="btn primary sm" data-act="pushon">Meldingen aanzetten</button></div></div>`;
  return s}
function rideCard(o,isCur){const nw=!o.gezien&&!S.seen.has(o.id);
  return `<button class="ridecard ${isCur?"cur":""}" data-act="open" data-id="${o.id}">
   <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="ref">${esc(o.ref)}${nw?' <span class="tag new">Nieuw</span>':""}${o.adr?' <span class="tag adr">ADR</span>':""}</span><span class="pill ${sCls(o.status)}">${esc(o.status)}</span></div>
   <div class="route">${esc(o.laadplaats)}<i>→</i>${esc(o.losplaats)}</div>
   ${steps(o)}
   <div class="meta"><span>Laden ${fdt(o.laaddatum)}</span>${o.losdatum?`<span>Lossen ${fdt(o.losdatum)}</span>`:""}${o.voertuig?`<span class="plate">${esc(o.voertuig.kenteken)}</span>`:""}</div></button>`}
function renderHome(){
  const first=(S.me&&S.me.driver&&S.me.driver.naam||"").split(" ")[0];
  $("#hello").textContent=first?"Hoi "+first:"Mijn ritten";
  const cur=current();
  const open=S.orders.filter(o=>o!==cur&&!["Gelost","Gefactureerd"].includes(o.status)).sort((a,b)=>String(a.laaddatum).localeCompare(String(b.laaddatum)));
  const done=S.orders.filter(o=>["Gelost","Gefactureerd"].includes(o.status));
  $("#view").innerHTML=`<div class="lbl">${new Date().toLocaleDateString("nl-BE",{weekday:"long",day:"numeric",month:"long"})}</div>
   ${bannerHTML()}
   ${cur?`<section class="sec"><h2>${ACTIVE.includes(cur.status)?"Bezig":"Volgende rit"}</h2>${rideCard(cur,true)}</section>`:`<div class="notice"><b>Geen ritten</b>Je hebt op dit moment geen ritten. Je krijgt een melding zodra kantoor er een toewijst.</div>`}
   ${open.length?`<section class="sec"><h2>Daarna</h2>${open.map(o=>rideCard(o,false)).join("")}</section>`:""}
   ${done.length?`<section class="sec"><h2>Afgerond</h2>${done.map(o=>rideCard(o,false)).join("")}</section>`:""}`;
  if(cur&&NEXT[cur.status]||cur&&cur.status==="Lossen"){$("#act").hidden=false;$("#actInner").innerHTML=actionHTML(cur)}else $("#act").hidden=true}
function actionHTML(o){
  if(o.status==="Lossen"&&!(o.tijden||{}).Gelost)return `<button class="bigbtn" data-act="gelost" data-id="${o.id}" ${S.busy?"disabled":""}>Gelost · lossen klaar</button>`;
  if(o.status==="Lossen")return cmrButtons(o);
  const n=NEXT[o.status];if(!n)return"";
  return `<button class="bigbtn" data-act="step" data-id="${o.id}" data-v="${n[0]}" ${S.busy?"disabled":""}>${esc(n[1])}</button>`}
function cmrButtons(o){return `<label class="bigbtn">📷 CMR fotograferen<input type="file" accept="image/*" capture="environment" data-file="cmr" data-id="${o.id}"></label><label class="btn" style="justify-content:center">CMR uit bestanden kiezen (foto of pdf)<input type="file" accept="image/*,application/pdf" data-file="cmr" data-id="${o.id}" hidden></label>`}
function cmrPopup(o){sheet("CMR-foto",`<div class="notice ok"><b>Gelost om ${ftime((o.tijden||{}).Gelost)}</b>Maak nu een foto van de ondertekende CMR. Zonder CMR is de rit niet afgerond.</div><div style="display:flex;flex-direction:column;gap:8px">${cmrButtons(o)}</div><div class="muted" style="font-size:12.5px;text-align:center">Leg de CMR plat, in goed licht, met vak 24 (handtekening ontvanger) goed leesbaar.</div>`)}
function renderDetail(o){
  $("#hello").textContent=o.ref;
  if(!o.gezien&&!S.seen.has(o.id)){S.seen.add(o.id);api(`/api/driver/orders/${o.id}/seen`,{method:"POST",json:{}}).catch(()=>{})}
  const i=FLOW.indexOf(o.status),tij=o.tijden||{};
  const legLaad=FLOW.indexOf(o.status)<=1;
  $("#view").innerHTML=`<div><button class="btn sm" data-act="home">‹ Mijn ritten</button></div>
   <div class="drv-cur">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="ref">${esc(o.ref)}${o.referentieKlant?" · ref. "+esc(o.referentieKlant):""}</span><span class="pill ${sCls(o.status)}">${esc(o.status)}</span></div>
    <div class="route">${esc(o.laadplaats)}<i>→</i>${esc(o.losplaats)}</div>${steps(o)}
    <button class="bigbtn" style="background:var(--ink);color:var(--bg)" data-act="route" data-id="${o.id}">🧭 Route ${legLaad?"naar laadplaats":"naar losplaats"}</button>
   </div>
   <div class="list">
    <div class="row place"><span class="pin ${i>=2?"on":""}">L</span><span class="grow"><b>Laden · ${fdt(o.laaddatum)}</b><span style="white-space:pre-wrap">${esc(o.laadadres||o.laadplaats)}</span></span><a class="btn sm" href="${esc(gmaps(addr(o,"laad")))}" target="_blank" rel="noopener">Maps</a></div>
    <div class="row place"><span class="pin ${i>=4?"on":""}">U</span><span class="grow"><b>Lossen${o.losdatum?" · "+fdt(o.losdatum):""}</b><span style="white-space:pre-wrap">${esc(o.losadres||o.losplaats)}</span></span><a class="btn sm" href="${esc(gmaps(addr(o,"los")))}" target="_blank" rel="noopener">Maps</a></div>
   </div>
   <dl class="kv">
    <dt>Klant</dt><dd>${esc(o.klantNaam||"—")}</dd>
    <dt>Lading</dt><dd>${esc(o.goederen||"—")}${o.colli?` · ${o.colli} colli`:""}${o.gewicht?` · ${Number(o.gewicht).toLocaleString("nl-BE")} kg`:""}${o.adr?' · <span class="tag adr">ADR</span>':""}</dd>
    <dt>Voertuig</dt><dd>${o.voertuig?`<span class="plate">${esc(o.voertuig.kenteken)}</span> ${esc(o.voertuig.type||"")}`:"—"}</dd>
    ${o.notities?`<dt>Opmerkingen</dt><dd style="white-space:pre-wrap">${esc(o.notities)}</dd>`:""}
    ${o.opdrachtPdf?`<dt>Opdracht</dt><dd><a href="/api/files/${encodeURIComponent(o.opdrachtPdf.id)}" target="_blank" rel="noopener">${esc(o.opdrachtPdf.name||"Opdracht openen")}</a></dd>`:""}
   </dl>
   ${FLOW.slice(1).some(s=>tij[s])?`<section class="sec"><span class="lbl">Tijden</span><div class="timeline">${FLOW.slice(1).filter(s=>tij[s]).map(s=>`<div><span>${s}</span><span class="mono">${fdt(tij[s])}</span></div>`).join("")}</div></section>`:""}
   ${(o.status==="Laden"||o.status==="Lossen")&&tij[o.status]?`<div class="notice"><b>Ter plaatse sinds ${ftime(tij[o.status])}</b>${o.status==="Laden"?"Tik op \"Geladen · vertrek\" zodra je vertrekt, dan klopt de wachttijd.":tij.Gelost?"Gelost om "+ftime(tij.Gelost)+". Maak nog de CMR-foto.":"Tik op \"Gelost\" zodra het lossen klaar is, dan klopt de wachttijd."}</div>`:""}
   ${o.cmr?`<section class="sec"><span class="lbl">CMR</span><div class="notice ok"><b>CMR doorgestuurd naar kantoor</b>${fdt(o.cmr.at)}</div>${/^image\//.test(o.cmr.type)?`<img class="preview" src="/api/files/${encodeURIComponent(o.cmr.id)}" alt="CMR">`:`<a class="btn" href="/api/files/${encodeURIComponent(o.cmr.id)}" target="_blank" rel="noopener">CMR openen</a>`}</section>`:""}
   ${i>1&&i<5?`<div style="text-align:center"><button class="linkbtn" data-act="back" data-id="${o.id}" data-v="${FLOW[i-1]}">Per ongeluk getikt? Terug naar "${FLOW[i-1]}"</button></div>`:""}`;
  const a=actionHTML(o);if(a){$("#act").hidden=false;$("#actInner").innerHTML=a}else $("#act").hidden=true;
  window.scrollTo(0,0)}

/* ---------- route & navigatie ---------- */
let map=null,meMarker=null,routeData=null,follow=true;
function closeMapView(){if(map){map.remove();map=null;meMarker=null}$("#mapview").hidden=true;document.body.style.overflow=""}
function loadCss(u){if(document.querySelector(`link[href="${u}"]`))return;const l=document.createElement("link");l.rel="stylesheet";l.href=u;document.head.appendChild(l)}
function loadScript(u){return new Promise((res,rej)=>{if(window.L)return res();const s=document.createElement("script");s.src=u;s.onload=res;s.onerror=()=>rej(new Error("Kaart kon niet laden"));document.head.appendChild(s)})}
async function openRoute(o){
  const mv=$("#mapview");mv.hidden=false;document.body.style.overflow="hidden";$("#act").hidden=true;
  mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.ref)} · ${FLOW.indexOf(o.status)<=1?esc(o.laadplaats):esc(o.losplaats)}</b></div><div class="busy" style="flex:1"><span class="spin"></span>Vrachtwagenroute berekenen…</div>`;
  startGeo();
  const pos=await firstPosition(6000);
  const leg=FLOW.indexOf(o.status)<=1?"laad":"los";
  let d;try{d=await api(`/api/route/${o.id}?leg=${leg}${pos?`&from=${pos.lat},${pos.lng}`:""}`)}
  catch(e){mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button></div><div class="dwrap"><div class="notice err">${esc(e.message)}</div><a class="bigbtn" href="${esc(gmaps(addr(o,leg)))}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;return}
  if(!d.configured){mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button></div><div class="dwrap"><div class="notice"><b>Vrachtwagenroutes zijn nog niet ingesteld door kantoor</b>Google Maps toont een autoroute: let zelf op hoogte, breedte en gewicht.</div><a class="bigbtn" href="${esc(gmaps(addr(o,leg)))}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;return}
  routeData=d;const r=d.route;
  mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r?`${fkm(r.length)} · ${fdur(r.duration)}`:"Je bent er"}</b>${r&&r.trafficDelay>120?`<span class="pill s-laden">+${fdur(r.trafficDelay)}</span>`:""}</div>
   ${r?`<div class="next" id="nextStep"><span>${esc((r.steps[0]||{}).text||"Volg de route")}</span><small></small></div>`:""}
   ${r&&r.notices.length?`<div class="notice warn" style="border-radius:0"><b>Let op</b>${r.notices.map(n=>esc(n.title)).join("<br>")}</div>`:""}
   <div id="dmap" class="map"></div>
   <div class="foot"><button class="btn sm" data-act="follow" id="followBtn">${follow?"Volgen aan":"Volgen uit"}</button><button class="btn sm" data-act="recalc" data-id="${o.id}">Opnieuw berekenen</button><span class="muted" style="font-size:12px;flex:1">${esc([d.vehicle.hoogte?"h "+d.vehicle.hoogte+" m":"",d.vehicle.breedte?"b "+d.vehicle.breedte+" m":"",d.vehicle.massa?d.vehicle.massa+" t":""].filter(Boolean).join(" · ")||"Geen voertuigmaten bekend")}</span><a class="btn sm" href="${esc(gmaps(addr(o,leg)))}" target="_blank" rel="noopener">Google Maps</a></div>`;
  try{loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css");await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js")}catch(e){$("#dmap").outerHTML='<div class="notice">De kaart kon niet laden.</div>';return}
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const el=$("#dmap");if(!el)return;
  const L=window.L;if(map){try{map.remove()}catch(e){}map=null}if(el._leaflet_id)el._leaflet_id=null;
  map=L.map(el,{zoomControl:false});L.control.zoom({position:"bottomright"}).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);
  const pts=r?r.coords:[[d.end.lat,d.end.lng]];
  const line=L.polyline(pts,{color:"#0d9466",weight:7,opacity:.9}).addTo(map);
  L.circleMarker([d.end.lat,d.end.lng],{radius:10,color:"#fff",weight:3,fillColor:leg==="laad"?"#a96608":"#c2352f",fillOpacity:1}).addTo(map).bindTooltip(d.end.label);
  map.on("dragstart",()=>{follow=false;const b=$("#followBtn");if(b)b.textContent="Volgen uit"});
  const fit=()=>{if(!map)return;map.invalidateSize();if(r)map.fitBounds(line.getBounds(),{padding:[30,30]});else map.setView([d.end.lat,d.end.lng],15)};fit();setTimeout(fit,250);
  if(S.lastPos)onPos(S.lastPos)}
function dist(a,b){const R=6371e3,t=Math.PI/180,dl=(b[0]-a[0])*t,dn=(b[1]-a[1])*t,x=Math.sin(dl/2)**2+Math.cos(a[0]*t)*Math.cos(b[0]*t)*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function onPos(p){S.lastPos=p;
  if(map&&window.L){const L=window.L;if(!meMarker)meMarker=L.circleMarker([p.lat,p.lng],{radius:9,color:"#fff",weight:3,fillColor:"#7c4dcc",fillOpacity:1}).addTo(map);else meMarker.setLatLng([p.lat,p.lng]);
    if(follow)map.setView([p.lat,p.lng],Math.max(map.getZoom(),15),{animate:true});
    const r=routeData&&routeData.route;if(r){let best=0,bd=1e12;for(let i=0;i<r.coords.length;i+=Math.max(1,Math.floor(r.coords.length/2000))){const d=dist([p.lat,p.lng],r.coords[i]);if(d<bd){bd=d;best=i}}
      const st=r.steps.find(s=>s.at>best)||r.steps[r.steps.length-1];const el=$("#nextStep");if(el&&st){el.querySelector("span").textContent=st.text;el.querySelector("small").textContent=fkm(dist([p.lat,p.lng],r.coords[Math.min(st.at,r.coords.length-1)]))}}}
  sendPos(p)}
/* Positie: elke 30 s tijdens een rit of in tabletmodus (de tablet blijft in de vrachtwagen). */
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}};const lsSet=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}};
const tabletMode=()=>lsGet("ghotra_tablet")==="1";
const sharing=()=>tabletMode()||S.orders.some(o=>ACTIVE.includes(o.status));
function sendPos(p){if(!sharing())return;if(Date.now()-S.lastSent<30000)return;S.lastSent=Date.now();const cur=S.orders.find(o=>ACTIVE.includes(o.status));
  api("/api/driver/position",{method:"POST",json:{lat:p.lat,lng:p.lng,acc:p.acc,speed:p.speed,orderId:cur?cur.id:null}}).then(()=>{S.posOk=Date.now();geoBadge()}).catch(()=>{})}
function startGeo(){if(S.geo!=null||!("geolocation" in navigator))return;S.geo=navigator.geolocation.watchPosition(x=>onPos({lat:x.coords.latitude,lng:x.coords.longitude,acc:x.coords.accuracy,speed:x.coords.speed}),e=>{S.geoErr=e.code===1?"Locatie geweigerd":"Geen GPS-signaal";geoBadge()},{enableHighAccuracy:true,maximumAge:10000,timeout:30000})}
let wake=null;async function keepAwake(){if(!tabletMode()||!("wakeLock" in navigator)||document.visibilityState!=="visible")return;try{if(!wake){wake=await navigator.wakeLock.request("screen");wake.addEventListener("release",()=>{wake=null})}}catch(e){}}
function geoBadge(){const h=$("#hello");if(!h)return;let b=$("#geoB");if(!sharing()){if(b)b.remove();return}if(!b){b=document.createElement("span");b.id="geoB";b.style.cssText="font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;flex:none";h.after(b)}
  const ok=S.posOk&&Date.now()-S.posOk<120000;b.textContent=ok?"📍 Live":S.geoErr?"📍 "+S.geoErr:"📍 Zoeken…";b.style.background=ok?"var(--ok-soft)":"var(--warn-soft)";b.style.color=ok?"var(--ok)":"var(--warn)"}
function firstPosition(ms){if(S.lastPos)return Promise.resolve(S.lastPos);return new Promise(res=>{if(!("geolocation" in navigator))return res(null);const t=setTimeout(()=>res(S.lastPos),ms);navigator.geolocation.getCurrentPosition(x=>{clearTimeout(t);res({lat:x.coords.latitude,lng:x.coords.longitude,acc:x.coords.accuracy})},()=>{clearTimeout(t);res(null)},{enableHighAccuracy:true,timeout:ms,maximumAge:30000})})}

/* ---------- sheets ---------- */
function sheet(title,body){$("#panel").innerHTML=`<div class="panel-h"><h2>${title}</h2><button class="close" data-act="close" aria-label="Sluiten">✕</button></div><div class="panel-b">${body}</div>`;$("#sheet").hidden=false}
function closeSheet(){$("#sheet").hidden=true}
function menu(){const b=S.me&&S.me.bedrijf||{};
  sheet("Menu",`<div class="list">
   <button class="row" data-act="pushon"><span class="grow"><span class="t1">Meldingen aanzetten</span><span class="t2">Seintje bij een nieuwe of gewijzigde rit</span></span></button>
   <button class="row" data-act="tablet"><span class="grow"><span class="t1">Tabletmodus: ${tabletMode()?"aan":"uit"}</span><span class="t2">Voor de tablet die in de vrachtwagen blijft: scherm blijft aan en de positie gaat altijd naar kantoor</span></span><span class="pill ${tabletMode()?"s-gelost":"s-gefactureerd"}">${tabletMode()?"Aan":"Uit"}</span></button>
   <button class="row" data-act="ziek"><span class="grow"><span class="t1">Ziek melden</span><span class="t2">Kantoor krijgt meteen een bericht</span></span></button>
   ${b.tel?`<a class="row" href="tel:${esc(b.tel.replace(/\s/g,""))}"><span class="grow"><span class="t1">Bel kantoor</span><span class="t2 mono">${esc(b.tel)}</span></span></a>`:""}
   <button class="row" data-act="pwd"><span class="grow"><span class="t1">Wachtwoord wijzigen</span></span></button>
   <button class="row" data-act="logout"><span class="grow"><span class="t1" style="color:var(--bad)">Afmelden</span><span class="t2">${esc(S.me&&S.me.user.email||"")}</span></span></button></div>`)}
function ziekSheet(){sheet("Ziek melden",`<form class="form" data-form="ziek" style="grid-template-columns:1fr"><div class="notice">Je wordt vanaf vandaag als ziek gemeld. Kantoor krijgt een melding en plant je ritten om.</div>
  <label class="field" for="zk_t"><span class="lbl">Tot en met (leeg = weet ik nog niet)</span><input id="zk_t" name="tot" type="date" min="${TODAY()}"></label>
  <label class="field" for="zk_n"><span class="lbl">Opmerking voor kantoor</span><textarea id="zk_n" name="notitie" rows="3"></textarea></label>
  <button class="bigbtn" type="submit" style="background:var(--bad);color:#fff">Ziek melden</button></form>`)}
function pwdSheet(){sheet("Wachtwoord wijzigen",`<form class="form" data-form="pwd" style="grid-template-columns:1fr"><label class="field" for="pw_c"><span class="lbl">Huidig wachtwoord</span><input id="pw_c" name="current" type="password" autocomplete="current-password" required></label><label class="field" for="pw_n"><span class="lbl">Nieuw wachtwoord (min. 8 tekens)</span><input id="pw_n" name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="bigbtn" type="submit">Opslaan</button></form>`)}

/* ---------- acties ---------- */
async function enablePush(){
  if(!("serviceWorker" in navigator)||!("PushManager" in window)){toast(/iPhone|iPad/.test(navigator.userAgent)?"Zet de app eerst op je beginscherm (Deel → Zet op beginscherm) en open hem van daaruit.":"Deze browser ondersteunt geen meldingen.");return}
  try{const perm=await Notification.requestPermission();if(perm!=="granted"){toast("Meldingen zijn niet toegestaan. Zet ze aan in de instellingen van je toestel.");return}
    const reg=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;
    const key=S.me.push.key;const raw=Uint8Array.from(atob(key.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
    const sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:raw});
    await api("/api/push/subscribe",{method:"POST",json:{endpoint:sub.endpoint}});await api("/api/push/test",{method:"POST",json:{}});toast("Meldingen staan aan");closeSheet();render()}
  catch(e){toast("Meldingen aanzetten lukte niet: "+(e.message||e))}}
async function setStep(id,status){if(S.busy)return;S.busy=true;
  try{const o=await api(`/api/driver/orders/${id}/status`,{method:"POST",json:{status}});upsert(o);if(ACTIVE.includes(o.status))startGeo();if(navigator.vibrate)navigator.vibrate(30);toast(o.ref+": "+o.status)}
  catch(e){toast(e.message);await loadOrders()}
  S.busy=false;render()}
async function shrinkImage(file,max=2000){try{const bmp=await createImageBitmap(file);const s=Math.min(1,max/Math.max(bmp.width,bmp.height));const c=document.createElement("canvas");c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,"image/jpeg",.82))}catch(e){return file}}
async function uploadCmr(id,file){const o=byId(id);if(!o)return;
  const isPdf=/pdf/.test(file.type)||/\.pdf$/i.test(file.name);
  sheet("CMR versturen",`<div class="busy"><span class="spin"></span>CMR versturen naar kantoor…</div>`);
  try{const blob=isPdf?file:await shrinkImage(file);
    const r=await api(`/api/orders/${id}/cmr`,{method:"POST",body:blob,headers:{"content-type":isPdf?"application/pdf":"image/jpeg","x-filename":encodeURIComponent(isPdf?file.name:"CMR-"+o.ref+".jpg")}});
    if(r.order)upsert(r.order);closeSheet();if(navigator.vibrate)navigator.vibrate([40,40,40]);toast("CMR verstuurd. Rit afgerond, bedankt!");location.hash="";render()}
  catch(e){sheet("CMR versturen",`<div class="notice err"><b>Versturen lukte niet</b>${esc(e.message)}</div><label class="bigbtn">Opnieuw proberen<input type="file" accept="image/*,application/pdf" data-file="cmr" data-id="${id}" hidden></label>`)}}
function upsert(o){const i=S.orders.findIndex(x=>x.id===o.id);if(i>=0)S.orders[i]=o;else S.orders.push(o)}
async function loadOrders(){S.orders=await api("/api/driver/orders")}

const ACT={
 menu:()=>menu(), close:()=>closeSheet(), home:()=>{location.hash=""},
 open:d=>{location.hash="rit-"+d.id},
 step:d=>setStep(d.id,d.v),
 gelost:async d=>{if(S.busy)return;S.busy=true;try{const o=await api(`/api/driver/orders/${d.id}/gelost`,{method:"POST",json:{}});upsert(o);if(navigator.vibrate)navigator.vibrate(30);S.busy=false;render();cmrPopup(o)}catch(e){S.busy=false;toast(e.message);await loadOrders();render()}},
 back:d=>setStep(d.id,d.v),
 route:d=>{location.hash="route-"+d.id},
 closemap:()=>{history.length>1?history.back():location.hash="rit-"+(location.hash.slice(7))},
 follow:()=>{follow=!follow;const b=$("#followBtn");if(b)b.textContent=follow?"Volgen aan":"Volgen uit";if(follow&&S.lastPos)onPos(S.lastPos)},
 recalc:d=>{const o=byId(d.id);if(o)openRoute(o)},
 pushon:()=>enablePush(),
 tablet:async()=>{const on=!tabletMode();lsSet("ghotra_tablet",on?"1":null);if(on){startGeo();await keepAwake();toast("Tabletmodus aan: laat de app open en de tablet aan de lader")}else{if(wake){wake.release().catch(()=>{});wake=null}toast("Tabletmodus uit")}geoBadge();menu()},
 ziek:()=>ziekSheet(), pwd:()=>pwdSheet(),
 logout:async()=>{try{await api("/api/logout",{method:"POST",json:{}})}catch(e){}location.href="/login"}
};
document.addEventListener("click",e=>{const b=e.target.closest("[data-act]");if(!b)return;const f=ACT[b.dataset.act];if(f){e.preventDefault();f(b.dataset,b)}});
document.addEventListener("change",e=>{const el=e.target;if(el.type==="file"&&el.dataset.file==="cmr"&&el.files&&el.files[0]){const f=el.files[0],id=el.dataset.id;el.value="";uploadCmr(id,f)}});
document.addEventListener("submit",async e=>{e.preventDefault();const f=e.target,b=f.querySelector("[type=submit]");b.disabled=true;
  try{if(f.dataset.form==="ziek"){await api("/api/driver/ziek",{method:"POST",json:{tot:f.elements.tot.value,notitie:f.elements.notitie.value}});S.me=await api("/api/driver/me");closeSheet();toast("Ziekmelding doorgegeven. Beterschap!");render()}
    if(f.dataset.form==="pwd"){await api("/api/me/password",{method:"POST",json:{current:f.elements.current.value,password:f.elements.password.value}});closeSheet();toast("Wachtwoord gewijzigd")}}
  catch(err){toast(err.message);b.disabled=false}});
window.addEventListener("hashchange",()=>{const h=location.hash.slice(1);if(h.startsWith("route-")){const o=byId(h.slice(6));if(o)openRoute(o);else location.hash=""}else render()});

/* ---------- live ---------- */
function startEvents(){let had=false;const es=new EventSource("/api/events");
  es.onopen=()=>{if(had)loadOrders().then(render).catch(()=>{});had=true};
  es.onmessage=ev=>{let m;try{m=JSON.parse(ev.data)}catch(e){return}if(m.type!=="order")return;
    const prev=byId(m.id);
    if(m.order){upsert(m.order);if(!prev){toast("Nieuwe rit: "+m.order.laadplaats+" → "+m.order.losplaats);if(navigator.vibrate)navigator.vibrate([80,60,80])}}
    else if(prev){S.orders=S.orders.filter(o=>o.id!==m.id);toast("Rit "+prev.ref+" staat niet meer op je lijst");if(location.hash==="#rit-"+m.id)location.hash=""}
    if(!location.hash.startsWith("#route-"))render()}}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")loadOrders().then(()=>{if(!location.hash.startsWith("#route-"))render()}).catch(()=>{})});

(async function boot(){
  try{S.me=await api("/api/driver/me");await loadOrders()}catch(e){$("#view").innerHTML=`<div class="notice err">${esc(e.message||"Laden lukte niet")}</div>`;return}
  if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});
  const h=location.hash.slice(1);
  if(h.startsWith("route-")&&byId(h.slice(6)))openRoute(byId(h.slice(6)));else render();
  startEvents();
  if(sharing())startGeo();keepAwake();geoBadge();setInterval(geoBadge,30000);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")keepAwake()});
  setInterval(()=>{if(document.visibilityState==="visible")loadOrders().then(()=>{if(!location.hash.startsWith("#route-"))render()}).catch(()=>{})},120000);
})();

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

/* ---------- route & navigatie (zoals Maps: pijl, kaart draait mee, volgende afslag, stem, live verkeer) ---------- */
let map=null,meMarker=null,routeData=null,routeLine=null,trafficLayer=null,endMarker=null,follow=true;
const NAV={o:null,leg:null,cum:[],idx:0,heading:0,rot:0,prev:null,off:0,lastRecalc:0,spoken:{},timers:[],wake:null,arrived:false,busy:false};
const voiceOn=()=>lsGet("ghotra_voice")!=="0";
const stripRij=t=>String(t||"").replace(/\s*Rij [\d.,]+\s*k?m door\.?\s*$/i,"").trim()||String(t||"");
function closeMapView(){window.removeEventListener("resize",layoutMap);NAV.timers.forEach(clearInterval);NAV.timers=[];if(NAV.wake){NAV.wake.release().catch(()=>{});NAV.wake=null}try{speechSynthesis.cancel()}catch(e){}
  if(map){map.remove();map=null;meMarker=null;routeLine=null;trafficLayer=null;endMarker=null}NAV.o=null;$("#mapview").hidden=true;document.body.style.overflow=""}
function loadCss(u){if(document.querySelector(`link[href="${u}"]`))return;const l=document.createElement("link");l.rel="stylesheet";l.href=u;document.head.appendChild(l)}
function loadScript(u){return new Promise((res,rej)=>{if(window.L&&window.L.map)return res();const s=document.createElement("script");s.src=u;s.onload=res;s.onerror=()=>rej(new Error("Kaart kon niet laden"));document.head.appendChild(s)})}
function dist(a,b){const R=6371e3,t=Math.PI/180,dl=(b[0]-a[0])*t,dn=(b[1]-a[1])*t,x=Math.sin(dl/2)**2+Math.cos(a[0]*t)*Math.cos(b[0]*t)*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function bearing(a,b){const t=Math.PI/180,y=Math.sin((b[1]-a[1])*t)*Math.cos(b[0]*t),x=Math.cos(a[0]*t)*Math.sin(b[0]*t)-Math.sin(a[0]*t)*Math.cos(b[0]*t)*Math.cos((b[1]-a[1])*t);return(Math.atan2(y,x)/t+360)%360}
function manIcon(st){if(!st)return"";const a=st.action||"",d=st.direction||"",sv=st.severity||"";
  if(a==="arrive")return'<svg viewBox="0 0 24 24" width="38" height="38" fill="currentColor"><path d="M5 21V4h9l.4 2H20v9h-6l-.4-2H7v8z"/></svg>';
  if(/roundabout/i.test(a))return`<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="13" r="4.5"/><path d="M12 8.5V2M9 5l3-3 3 3"/></svg>${st.exit?`<b style="font-size:14px;margin-left:-8px">${st.exit}</b>`:""}`;
  let ang=0;if(/uturn/i.test(a))ang=180;else if(d==="left")ang=sv==="light"?-45:sv==="heavy"?-135:-90;else if(d==="right")ang=sv==="light"?45:sv==="heavy"?135:90;
  return`<svg viewBox="0 0 24 24" width="38" height="38" style="transform:rotate(${ang}deg)" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V4M5 10l7-7 7 7"/></svg>`}
function say(t){if(!voiceOn()||!("speechSynthesis" in window))return;try{const u=new SpeechSynthesisUtterance(t);u.lang="nl-BE";u.rate=1;speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}
async function navWake(){try{if("wakeLock" in navigator&&!NAV.wake&&document.visibilityState==="visible"){NAV.wake=await navigator.wakeLock.request("screen");NAV.wake.addEventListener("release",()=>{NAV.wake=null})}}catch(e){}}
function hinderHTML(r){const inc=(r&&r.incidents)||[],no=(r&&r.notices)||[];if(!inc.length&&!no.length)return"";
  return `<details class="hinder"><summary>⚠ ${inc.length?inc.length+" "+(inc.length===1?"melding":"meldingen")+" op je route (werken, file, ongeval)":"Let op"}</summary>${[...inc.map(i=>esc(i.text)),...no.map(n=>esc(n.title))].slice(0,8).map(x=>`<div>${x}</div>`).join("")}</details>`}
async function openRoute(o){
  closeMapView();NAV.o=o;NAV.leg=FLOW.indexOf(o.status)<=1?"laad":"los";NAV.arrived=false;NAV.spoken={};NAV.idx=0;NAV.off=0;follow=true;
  const mv=$("#mapview");mv.hidden=false;document.body.style.overflow="hidden";$("#act").hidden=true;
  const dest=NAV.leg==="laad"?o.laadplaats:o.losplaats;
  mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.ref)} · ${esc(dest)}</b></div><div class="busy" style="flex:1"><span class="spin"></span>Vrachtwagenroute berekenen…</div>`;
  startGeo();navWake();
  const pos=await firstPosition(6000);if(NAV.o!==o)return;
  let d;try{d=await api(`/api/route/${o.id}?leg=${NAV.leg}${pos?`&from=${pos.lat},${pos.lng}`:""}`)}
  catch(e){mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button></div><div class="dwrap"><div class="notice err">${esc(e.message)}</div><a class="bigbtn" href="${esc(gmaps(addr(o,NAV.leg)))}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;return}
  if(NAV.o!==o)return;
  if(!d.configured){mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button></div><div class="dwrap"><div class="notice"><b>Vrachtwagenroutes zijn nog niet ingesteld door kantoor</b>Google Maps toont een autoroute: let zelf op hoogte, breedte en gewicht.</div><a class="bigbtn" href="${esc(gmaps(addr(o,NAV.leg)))}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;return}
  const v=d.vehicle||{};
  mv.innerHTML=`<div class="bar"><button class="btn sm" data-act="closemap">‹ Terug</button><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dest)}</b><button class="btn sm" data-act="voice" id="voiceBtn" aria-label="Stem">${voiceOn()?"🔊":"🔇"}</button></div>
   <div class="next" id="nextStep"><span class="mi" id="nsIcon">${manIcon((d.route&&d.route.steps[0])||null)}</span><span class="nd" id="nsDist"></span><span class="nt" id="nsText">${esc(stripRij(d.route&&d.route.steps[0]&&d.route.steps[0].text)||"Volg de route")}</span></div>
   <div id="hinder">${hinderHTML(d.route)}</div>
   <div class="navwrap" id="navwrap"><div id="dmap"></div>
    <div class="navbtns"><button class="nbtn" data-act="zoom" data-v="1" aria-label="Inzoomen">+</button><button class="nbtn" data-act="zoom" data-v="-1" aria-label="Uitzoomen">−</button></div>
    <button class="nbtn wide" data-act="navmode" id="navBtn">Overzicht</button>
    <div class="spd" id="spd"><b>0</b><small>km/u</small></div>
    <div class="attr">© OpenStreetMap · verkeer HERE</div></div>
   <div class="foot"><span class="eta"><b id="etaT">--:--</b><small id="etaR"></small></span><span class="muted" style="font-size:12px;flex:1;min-width:0">${esc([v.hoogte?"h "+v.hoogte+" m":"",v.breedte?"b "+v.breedte+" m":"",v.massa?v.massa+" t":""].filter(Boolean).join(" · ")||"Geen voertuigmaten bekend")}</span><button class="btn sm" data-act="recalc" data-id="${o.id}">↻ Herbereken</button><a class="btn sm" href="${esc(gmaps(addr(o,NAV.leg)))}" target="_blank" rel="noopener">Google Maps</a></div>`;
  try{loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css");await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js")}catch(e){$("#dmap").outerHTML='<div class="notice">De kaart kon niet laden.</div>';return}
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const el=$("#dmap");if(!el||NAV.o!==o)return;
  const L=window.L;if(el._leaflet_id)el._leaflet_id=null;
  map=L.map(el,{zoomControl:false,attributionControl:false,touchZoom:"center",scrollWheelZoom:"center",doubleClickZoom:"center",zoomSnap:0.5});
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
  trafficLayer=L.tileLayer("/api/traffic/{z}/{x}/{y}?t="+Date.now(),{maxZoom:19,minZoom:5,opacity:.9});
  map.on("dragstart",()=>{if(follow)setNavMode(false)});
  setRoute(d);
  meMarker=L.marker([0,0],{icon:L.divIcon({className:"",iconSize:[0,0],html:'<div class="arw" style="transform:translate(-50%,-50%)"><svg viewBox="0 0 40 40" width="44" height="44"><circle cx="20" cy="20" r="18" fill="rgba(13,148,102,.18)"/><path d="M20 5 L32 33 L20 26 L8 33 Z" fill="#0d9466" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg></div>'}),interactive:false,zIndexOffset:1000});
  layoutMap();map.setView(pos?[pos.lat,pos.lng]:(d.start?[d.start.lat,d.start.lng]:[d.end.lat,d.end.lng]),17,{animate:false});
  if(!S.lastPos&&pos)S.lastPos=pos;setNavMode(!!S.lastPos);
  window.addEventListener("resize",layoutMap);
  // Verkeerskleuren alleen in Overzicht (spaart HERE-verbruik); de route zelf rekent altijd met live verkeer.
  NAV.timers.push(setInterval(()=>{if(trafficLayer&&!follow)trafficLayer.setUrl("/api/traffic/{z}/{x}/{y}?t="+Date.now())},600000));
  NAV.timers.push(setInterval(()=>{if((S.lastPos&&S.lastPos.speed||0)>3)recalc(true)},900000))}
function setRoute(d){routeData=d;const r=d.route,L=window.L;const cum=[0];
  if(r)for(let i=1;i<r.coords.length;i++)cum.push(cum[i-1]+dist(r.coords[i-1],r.coords[i]));NAV.cum=cum;NAV.idx=0;NAV.off=0;
  const pts=r?r.coords:[[d.end.lat,d.end.lng]];
  if(routeLine)routeLine.setLatLngs(pts);else routeLine=L.polyline(pts,{color:"#0d9466",weight:9,opacity:.85,lineCap:"round"}).addTo(map);
  if(endMarker)endMarker.setLatLng([d.end.lat,d.end.lng]);else endMarker=L.circleMarker([d.end.lat,d.end.lng],{radius:11,color:"#fff",weight:3,fillColor:NAV.leg==="laad"?"#a96608":"#c2352f",fillOpacity:1}).addTo(map);
  const h=$("#hinder");if(h)h.innerHTML=hinderHTML(r)}
async function recalc(silent){const o=NAV.o;if(!o||NAV.busy)return;const p=S.lastPos;NAV.busy=true;NAV.lastRecalc=Date.now();
  try{const d=await api(`/api/route/${o.id}?leg=${NAV.leg}${p?`&from=${p.lat},${p.lng}`:""}`);if(NAV.o!==o||!map||!d.configured)return;
    const old=routeData&&routeData.route;setRoute(d);
    if(d.route&&old&&silent&&d.route.trafficDelay-old.trafficDelay>300){toast("Meer file op je route: +"+fdur(d.route.trafficDelay));say("Let op, er is meer file op je route.")}
    if(!silent)toast("Route opnieuw berekend");if(S.lastPos)onPos(S.lastPos)}
  catch(e){if(!silent)toast(e.message)}finally{NAV.busy=false}}
function layoutMap(){const w=$("#navwrap"),el=$("#dmap");if(!w||!el||!map)return;const W=w.clientWidth,H=w.clientHeight;
  if(follow){const D=Math.ceil(2*Math.hypot(W/2,H*0.72))+40;Object.assign(el.style,{width:D+"px",height:D+"px",left:(W/2-D/2)+"px",top:(H*0.72-D/2)+"px",transform:`rotate(${-NAV.rot}deg)`})}
  else Object.assign(el.style,{width:W+"px",height:H+"px",left:"0px",top:"0px",transform:"none"});
  map.invalidateSize({pan:false})}
function setNavMode(on){follow=on;const b=$("#navBtn");if(b)b.textContent=on?"Overzicht":"▲ Navigeren";if(!map)return;if(trafficLayer){if(on&&trafficLayer._map)trafficLayer.remove();else if(!on&&!trafficLayer._map)trafficLayer.addTo(map)}
  if(on){map.dragging.disable();layoutMap();if(S.lastPos){map.setView([S.lastPos.lat,S.lastPos.lng],Math.max(map.getZoom(),16),{animate:false});onPos(S.lastPos)}}
  else{map.dragging.enable();layoutMap();const r=routeData&&routeData.route;if(r&&routeLine){const rest=r.coords.slice(NAV.idx);map.fitBounds(window.L.latLngBounds(rest.length>1?rest:r.coords),{padding:[40,40]})}}}
function nearest(ll){const c=routeData&&routeData.route&&routeData.route.coords;if(!c||!c.length)return{i:0,d:Infinity};let bi=NAV.idx,bd=Infinity;
  const scan=(a,b,s)=>{for(let i=Math.max(0,a);i<Math.min(c.length,b);i+=s){const d=dist(ll,c[i]);if(d<bd){bd=d;bi=i}}};
  scan(NAV.idx-20,NAV.idx+800,1);if(bd>150){scan(0,c.length,Math.max(1,Math.floor(c.length/3000)));scan(bi-60,bi+60,1)}return{i:bi,d:bd}}
function onPos(p){S.lastPos=p;
  if(map&&window.L&&NAV.o){const ll=[p.lat,p.lng],r=routeData&&routeData.route;
    // rijrichting
    if(p.heading!=null&&isFinite(p.heading)&&(p.speed||0)>1.5)NAV.heading=p.heading;
    else if(NAV.prev&&dist(NAV.prev,ll)>12)NAV.heading=bearing(NAV.prev,ll);
    if(!NAV.prev||dist(NAV.prev,ll)>12)NAV.prev=ll;
    const n=nearest(ll);
    if(n.d<40&&r){NAV.idx=Math.max(NAV.idx,n.i);if((p.speed||0)<1.5&&!(p.heading>=0)&&NAV.idx+1<r.coords.length)NAV.heading=bearing(r.coords[NAV.idx],r.coords[Math.min(NAV.idx+3,r.coords.length-1)])}
    else if(r&&n.d<150)NAV.idx=n.i;
    const delta=((NAV.heading-NAV.rot)%360+540)%360-180;NAV.rot+=delta;
    meMarker.setLatLng(ll);if(!meMarker._map)meMarker.addTo(map);const a=meMarker.getElement()&&meMarker.getElement().querySelector(".arw");if(a)a.style.transform=`translate(-50%,-50%) rotate(${NAV.rot}deg)`;
    if(follow){const el=$("#dmap");if(el)el.style.transform=`rotate(${-NAV.rot}deg)`;map.setView(ll,map.getZoom(),{animate:true,duration:0.8})}
    const sp=$("#spd b");if(sp)sp.textContent=p.speed!=null&&isFinite(p.speed)?Math.round(p.speed*3.6):"–";
    if(r){const cum=NAV.cum,last=r.coords.length-1,rem=Math.max(0,cum[last]-cum[NAV.idx]+(n.d<150?0:n.d));
      const eta=new Date(Date.now()+r.duration*1000*(r.length?rem/r.length:0));
      const et=$("#etaT"),er=$("#etaR");if(et)et.textContent=String(eta.getHours()).padStart(2,"0")+":"+String(eta.getMinutes()).padStart(2,"0");if(er)er.textContent=fkm(rem)+" · "+fdur(r.duration*(r.length?rem/r.length:0));
      const endD=dist(ll,[routeData.end.lat,routeData.end.lng]);
      if(endD<150||rem<120){if(!NAV.arrived){NAV.arrived=true;say("Je bent op je bestemming.");const ns=$("#nextStep");if(ns)ns.innerHTML=`<span class="mi">${manIcon({action:"arrive"})}</span><span class="nt">Je bent op je bestemming</span>`}}
      else{const k=r.steps.findIndex(s=>s.at>NAV.idx),st=r.steps[k<0?r.steps.length-1:k];
        if(st){const sd=Math.max(0,cum[Math.min(st.at,last)]-cum[NAV.idx]),txt=stripRij(st.text);
          const ic=$("#nsIcon"),dd=$("#nsDist"),tt=$("#nsText");if(ic&&ic.dataset.k!==String(k)){ic.innerHTML=manIcon(st);ic.dataset.k=String(k);tt.textContent=txt}if(dd)dd.textContent=fkm(sd);
          const far=(p.speed||0)>16?1200:500;
          if(sd<far&&sd>far*0.6&&!NAV.spoken[k+"f"]){NAV.spoken[k+"f"]=1;say("Over "+fkm(Math.round(sd/100)*100||sd).replace("km","kilometer").replace(" m"," meter")+", "+txt)}
          if(sd<(p.speed||0)*6+40&&!NAV.spoken[k+"n"]){NAV.spoken[k+"n"]=1;NAV.spoken[k+"f"]=1;say(txt)}}}
      // van de route af: na 4 metingen opnieuw berekenen
      if(n.d>70&&(p.acc||0)<60){if(++NAV.off>=4&&Date.now()-NAV.lastRecalc>25000){NAV.off=0;say("Route wordt opnieuw berekend.");recalc(true)}}else NAV.off=0}}
  sendPos(p)}
/* Positie: elke 30 s tijdens een rit of in tabletmodus (de tablet blijft in de vrachtwagen). */
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}};const lsSet=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}};
const tabletMode=()=>lsGet("ghotra_tablet")==="1";
const sharing=()=>tabletMode()||S.orders.some(o=>ACTIVE.includes(o.status));
function sendPos(p){if(!sharing())return;if(Date.now()-S.lastSent<30000)return;S.lastSent=Date.now();const cur=S.orders.find(o=>ACTIVE.includes(o.status));
  api("/api/driver/position",{method:"POST",json:{lat:p.lat,lng:p.lng,acc:p.acc,speed:p.speed,orderId:cur?cur.id:null}}).then(()=>{S.posOk=Date.now();geoBadge()}).catch(()=>{})}
function startGeo(){if(S.geo!=null||!("geolocation" in navigator))return;S.geo=navigator.geolocation.watchPosition(x=>onPos({lat:x.coords.latitude,lng:x.coords.longitude,acc:x.coords.accuracy,speed:x.coords.speed,heading:x.coords.heading}),e=>{S.geoErr=e.code===1?"Locatie geweigerd":"Geen GPS-signaal";geoBadge()},{enableHighAccuracy:true,maximumAge:1000,timeout:30000})}
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
 navmode:()=>setNavMode(!follow),
 zoom:d=>{if(map)map.setZoom(map.getZoom()+(+d.v),{animate:true})},
 voice:()=>{const on=!voiceOn();lsSet("ghotra_voice",on?null:"0");const b=$("#voiceBtn");if(b)b.textContent=on?"🔊":"🔇";toast(on?"Stem aan":"Stem uit");if(on)say("Stem staat aan.")},
 recalc:()=>recalc(false),
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

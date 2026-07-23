import { useState, useCallback, useMemo, useRef, useEffect, lazy, Suspense } from "react";
import { db, storage, auth } from "./firebase.js";
import { collection, doc, getDocs, addDoc, updateDoc, deleteDoc, getDoc, setDoc, increment, onSnapshot, where, query } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
const TimesheetsPage = lazy(() => import("./TimesheetsPage.jsx"));
const SafetyPage = lazy(() => import("./SafetyPage.jsx"));
const CompanyDocsPage = lazy(() => import("./CompanyDocsPage.jsx"));
const MobileApp = lazy(() => import("./MobileApp.jsx"));
const EventsPage = lazy(() => import("./EventsPage.jsx"));
const QuotesPage = lazy(() => import("./QuotesPage.jsx"));
const IFTAPage = lazy(() => import("./IFTAPage.jsx"));
import { APP_NAME, APP_VERSION, COMPANY_NAME, DIVISIONS, ACCT_EMAILS as CFG_ACCT_EMAILS, REPORTS_EMAIL, CLOUD_FUNCTIONS, BOL_COMPANY_LABEL } from "./client.config.js";

// ═══ CLOUD FUNCTION URLS (2nd Gen) ═══
const CF_URLS = CLOUD_FUNCTIONS;
async function callCloudFn(name, data) {
  const senderEmail = auth?.currentUser?.email || "manny@diamondbackexpress.com";
  const res = await fetch(CF_URLS[name], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({...data, senderEmail}),
  });
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(err.error || "Cloud function failed"); }
  return res.json();
}

/*  DBX DISPATCH v6 — Diamond Back Express
    Firebase Firestore + Storage — real-time sync across devices
    EmailJS, PDF export, mobile responsive, address DB, unit selectors, equipment docs */

// ═══ CONFIG ═══
const EMAILJS = { serviceId:"service_aykab3n", templateId:"template_0ki8tnf", publicKey:"Z_0IMv8efUHLnxcUy" };
const DIVS = DIVISIONS;
const STATUSES = ["unassigned","assigned","in-transit","ready-to-bill","closed","no-charge","invoiced","cancelled"];
const S_LABEL = { unassigned:"Unassigned", assigned:"Assigned / In Progress", "in-transit":"In Transit", "ready-to-bill":"Ready to Bill", closed:"Closed", "no-charge":"Closed – No Charge", invoiced:"Invoiced", cancelled:"Cancelled",
  // legacy — kept for existing orders
  "pod-received":"Ready to Bill", completed:"Ready to Bill", "completed-noinvoice":"Ready to Bill" };
const S_COLOR = { unassigned:"#ef4444", assigned:"#f59e0b", "in-transit":"#8b5cf6", "ready-to-bill":"#f97316", closed:"#22c55e", invoiced:"#06b6d4", cancelled:"#64748b",
  // legacy
  "pod-received":"#f97316", completed:"#f97316", "completed-noinvoice":"#f97316", "no-charge":"#14b8a6" };
const CURRS = [{ v:"CAD", s:"$" },{ v:"USD", s:"$" },{ v:"EUR", s:"€" },{ v:"GBP", s:"£" }];
const csym = c => (CURRS.find(x=>x.v===c)||CURRS[0]).s;

// ═══ ACCOUNTING EMAIL PRESETS — edit this list to add/remove recipients ═══
const ACCT_EMAILS = CFG_ACCT_EMAILS;

// ═══ UTILS ═══
const uid = () => Math.random().toString(36).slice(2,10);
const td = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const tn = () => new Date().toTimeString().slice(0,5);
const fd = d => d ? new Date(d+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";
const fm = (v,c) => v ? `${csym(c)}${parseFloat(v).toFixed(2)}` : "";

// ═══ FIREBASE HELPERS ═══
const COLLECTIONS = ["clients","drivers","trucks","trailers","locations","orders","stickers","events"];

async function loadAllData() {
  const data = { clients:[], drivers:[], trucks:[], trailers:[], locations:[], orders:[], stickers:[], events:[] };
  for (const col of COLLECTIONS) {
    try {
      const snap = await getDocs(collection(db, col));
      data[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) { console.warn(`Failed to load ${col}:`, e.code||e.message); }
  }
  // Get BOL counter
  try {
    const counterDoc = await getDoc(doc(db, "config", "counters"));
    data.nBol = counterDoc.exists() ? (counterDoc.data().nBol || 2000) : 2000;
  } catch(e) { data.nBol = 2000; }
  return data;
}

async function fbSave(col, item) {
  const { id, ...rest } = item;
  if (id && id.length > 5) {
    await updateDoc(doc(db, col, id), rest);
    return id;
  }
  const ref = await addDoc(collection(db, col), rest);
  return ref.id;
}

async function fbDelete(col, id) {
  await deleteDoc(doc(db, col, id));
}

async function getNextBol() {
  const counterRef = doc(db, "config", "counters");
  const snap = await getDoc(counterRef);
  let n;
  if (snap.exists()) {
    n = snap.data().nBol || 2000;
    // Use atomic increment to prevent race conditions
    await updateDoc(counterRef, { nBol: increment(1) });
  } else {
    n = 2000;
    await setDoc(counterRef, { nBol: 2001 });
  }
  return String(n);
}

// Upload file to Firebase Storage, return { name, type, url, path }
async function uploadFile(file, folder) {
  const path = `${folder}/${Date.now()}_${file.name}`;
  const sRef = storageRef(storage, path);
  await uploadBytes(sRef, file);
  const url = await getDownloadURL(sRef);
  return { name: file.name, type: file.type, url, path };
}

// ═══ EMAILJS SENDER ═══
async function sendEmail(to, subject, htmlBody) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service_id: EMAILJS.serviceId, template_id: EMAILJS.templateId, user_id: EMAILJS.publicKey,
      template_params: { to_email: to, subject, body: htmlBody }
    })
  });
  if (!res.ok) throw new Error("Email failed");
  return true;
}

// ═══ PDF HTML BUILDER (reusable for email + print) ═══
function buildBolHtml(o, divInfo, includePod=false, includePricing=false, driverIndex=0, client=null) {
  const isEvent = o.orderType === "event";
  const allDrivers = [{drvName:o.drvName?.split(", ")[0]||o.drvName, drvEmail:o.drvEmail, trkUnit:o.trkUnit, trkPlate:o.trkPlate, trlUnit:o.trlUnit, trlPlate:o.trlPlate}, ...(o.extraDrivers||[])];
  const drv = allDrivers[driverIndex] || allDrivers[0];
  const caDiv = DIVS[0]; const usDiv = DIVS[1];
  const billingDiv = divInfo || DIVS.find(d=>d.id===o.divId) || DIVS[0];
  const safeRef = typeof o.ref === "string" ? o.ref : (o.ref?.value || "");
  const items = (o.items||[]).filter(i=>i.desc||i.pcs||i.wt||i.l||i.w||i.h);
  const itemRows = items.map(i => `<tr>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.pcs||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.desc||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.wt||"—"} ${i.wUnit||""}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.l||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.w||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.h||"—"}</td>
  </tr>`).join("");
  const podSection = (o.podBy && includePod) ? `<div style="border:2px solid #22c55e;border-radius:8px;padding:14px;margin-top:20px;margin-bottom:16px"><div style="font-weight:700;font-size:11px;color:#22c55e;text-transform:uppercase;margin-bottom:6px">Proof of Delivery</div><div style="font-size:13px;line-height:1.6">Received by: <strong>${o.podBy}</strong><br>Date: ${fd(o.podDate)}<br>Time: ${o.podTime||"—"}</div></div>` : "";
  const p = o.price||{}; const sym = ({CAD:"$",USD:"$",EUR:"€",GBP:"£"})[p.cur||"CAD"]||"$";

  // ── Event pricing section ──
  // Shows: Transport block (base + fuel + tax) + Additional charges (lines with per-line tax) + Grand Total
  const resolveLineTax = (taxMode, taxCustom) => ({
    pct: taxMode==="HST"?13 : taxMode==="GST"?5 : taxMode==="CUSTOM"?(parseFloat(taxCustom)||0) : 0,
    label: taxMode==="HST"?"HST (13%)" : taxMode==="GST"?"GST (5%)" : taxMode==="CUSTOM"?`Tax (${taxCustom||0}%)` : null,
  });
  const eventLines = (p.eventLines||[]).filter(l=>l.desc||parseFloat(l.unitPrice)>0);
  const eventPricingSection = (isEvent && includePricing) ? (() => {
    // Transport
    const baseAmt2=parseFloat(p.base)||0;
    const fuelPct2=parseFloat(p.fuelPct)||0;
    const fuelAmt2=baseAmt2*(fuelPct2/100);
    const transSub=baseAmt2+fuelAmt2;
    const transTax=resolveLineTax(p.taxMode,p.taxCustom);
    const transTaxAmt=transSub*(transTax.pct/100);
    const transTotal=transSub+transTaxAmt;
    const hasTransport=baseAmt2>0;
    // Lines
    const linesCalc=eventLines.map(l=>{
      const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
      const lt=resolveLineTax(l.taxMode,l.taxCustom);
      const lta=lb*(lt.pct/100);
      return{...l,lb,lta,ltot:lb+lta,lt};
    });
    const hasLines=linesCalc.length>0;
    const linesTotal=linesCalc.reduce((s,l)=>s+l.ltot,0);
    const grandTotal=(hasTransport?transTotal:0)+(hasLines?linesTotal:0);
    if(!hasTransport&&!hasLines) return "";
    const th=`padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.3px;font-weight:700;background:#f1f5f9`;
    const thR=`${th};text-align:right`;
    const td=`padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px`;
    const tdR=`${td};text-align:right`;
    let html=`<div style="margin-bottom:16px">`;
    // Transport section
    if(hasTransport){
      html+=`<div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">Transport Charge</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:${hasLines?8:0}px">
        <thead><tr><th style="${th}">Description</th><th style="${thR}">Amount</th></tr></thead>
        <tbody>
          ${p.transDesc?`<tr><td style="${td};color:#555;font-style:italic" colspan="2">${p.transDesc}</td></tr>`:""}
          <tr><td style="${td}">Base Price</td><td style="${tdR};font-weight:600">${sym}${baseAmt2.toFixed(2)}</td></tr>
          ${fuelAmt2>0?`<tr><td style="${td}">Fuel Surcharge (${fuelPct2}%)</td><td style="${tdR}">${sym}${fuelAmt2.toFixed(2)}</td></tr>`:""}
          ${transTaxAmt>0?`<tr><td style="${td}">${transTax.label}</td><td style="${tdR}">${sym}${transTaxAmt.toFixed(2)}</td></tr>`:""}
        </tbody>
      </table>
      ${hasLines?`<div style="text-align:right;font-size:11px;color:#555;margin-bottom:10px">Transport Subtotal: <strong>${sym}${transTotal.toFixed(2)}</strong></div>`:""}`;
    }
    // Additional charges
    if(hasLines){
      html+=`<div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">Additional Charges</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="${th}">Description</th>
          <th style="${thR}">Qty</th>
          <th style="${thR}">Unit Price</th>
          <th style="${thR}">Tax</th>
          <th style="${thR}">Amount</th>
        </tr></thead>
        <tbody>${linesCalc.map(l=>`
          <tr>
            <td style="${td}">${l.desc||"Charge"}</td>
            <td style="${tdR}">${l.qty}</td>
            <td style="${tdR}">${sym}${parseFloat(l.unitPrice).toFixed(2)}</td>
            <td style="${tdR};font-size:10px;color:#888">${l.lt.label||"—"}</td>
            <td style="${tdR};font-weight:600">${sym}${l.ltot.toFixed(2)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    }
    // Grand total
    html+=`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 8px;background:#f8fafc;margin-top:4px;border-top:2px solid #e2e8f0">
        <span style="font-weight:700;font-size:12px;color:#dc2626;text-transform:uppercase">Total ${p.cur||"CAD"}</span>
        <span style="font-weight:700;font-size:15px;color:#dc2626">${sym}${grandTotal.toFixed(2)} ${p.cur||"CAD"}</span>
      </div>
      ${o.poNumber?`<div style="margin-top:8px;font-size:11px;color:#666">PO #: <strong>${o.poNumber}</strong></div>`:""}
    </div>`;
    return html;
  })() : "";

  // Regular pricing section
  const baseAmt=parseFloat(p.base)||0; const fuelPct=parseFloat(p.fuelPct)||0; const fuelAmt=baseAmt*(fuelPct/100);
  const ocCalc2=(c)=>{const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {ltp,lbase,ltax:lbase*(ltp/100)};};
  const otherBaseTotal=(p.other||[]).reduce((s,c)=>s+ocCalc2(c).lbase,0);
  const otherTaxTotal=(p.other||[]).reduce((s,c)=>s+ocCalc2(c).ltax,0);
  const taxPct=p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):({NONE:0,HST:13,GST:5,GBP:20}[p.taxMode]||0);
  const taxAmt=(baseAmt+fuelAmt)*(taxPct/100); const total=baseAmt+fuelAmt+taxAmt+otherBaseTotal+otherTaxTotal;
  const pricingSection = (!isEvent && includePricing && p.base && parseFloat(p.base)>0) ? `
<div style="border:2px solid #dc2626;border-radius:8px;padding:14px;margin-bottom:16px">
  <div style="font-weight:700;font-size:11px;color:#dc2626;text-transform:uppercase;margin-bottom:10px">Pricing (${p.cur||"CAD"})</div>
  ${p.transDesc?`<div style="font-size:11px;color:#000;margin-bottom:8px"><strong>Description:</strong> ${p.transDesc}</div>`:""}
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    <tr><td style="padding:3px 0;color:#666">Base Price</td><td style="text-align:right;font-weight:600">${sym}${baseAmt.toFixed(2)}</td></tr>
    ${fuelAmt>0?`<tr><td style="padding:3px 0;color:#666">Fuel Surcharge (${fuelPct}%)</td><td style="text-align:right">${sym}${fuelAmt.toFixed(2)}</td></tr>`:""}
    ${taxAmt>0?`<tr><td style="padding:3px 0;color:#666">Tax on Base (${taxPct}%)</td><td style="text-align:right">${sym}${taxAmt.toFixed(2)}</td></tr>`:""}
    ${(p.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0).map(c=>{const cc=ocCalc2(c);const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");const lbl=(c.desc||"Charge")+(hasQty?` (${parseFloat(c.qty)||0} × ${sym}${(parseFloat(c.unitPrice)||0).toFixed(2)})`:"");return `<tr><td style="padding:3px 0;color:#666">${lbl}</td><td style="text-align:right">${sym}${cc.lbase.toFixed(2)}</td></tr>${cc.ltax>0?`<tr><td style="padding:1px 0 1px 12px;color:#999;font-size:10px">Tax (${cc.ltp}%)</td><td style="text-align:right;color:#999;font-size:10px">${sym}${cc.ltax.toFixed(2)}</td></tr>`:""}`;}).join("")}
    <tr style="border-top:1.5px solid #cbd5e1"><td style="padding:6px 0 0;font-weight:700;font-size:14px">Total</td><td style="text-align:right;font-weight:700;font-size:14px">${sym}${total.toFixed(2)} ${p.cur||"CAD"}</td></tr>
  </table>
  ${o.poNumber?`<div style="margin-top:8px;font-size:11px;color:#666">PO #: <strong>${o.poNumber}</strong></div>`:""}
</div>` : "";

  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#000;max-width:800px">

<!-- Header -->
<div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:20px;align-items:center;border-bottom:2px solid #dc2626;padding-bottom:14px;margin-bottom:0">
  <img src="${LOGO}" style="height:56px;object-fit:contain" alt="${APP_NAME}">
  <div style="text-align:center;font-size:10px;line-height:1.7;color:#444"><b style="font-size:11px;color:#000">${caDiv.name}</b><br>${caDiv.addr.replace(/\n/g,"<br>")}</div>
  <div style="text-align:right;font-size:10px;line-height:1.7;color:#444"><b style="font-size:11px;color:#000">${usDiv.name}</b><br>${usDiv.addr.replace(/\n/g,"<br>")}</div>
</div>

<!-- BOL Info Bar -->
<div style="display:flex;justify-content:space-between;align-items:flex-start;background:#f8fafc;border:1.5px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:20px 18px 14px;margin-bottom:18px">
  <div>
    <div style="font-size:30px;font-weight:900;letter-spacing:-1px;color:#dc2626;line-height:1">BOL ${o.bol}</div>
    ${isEvent&&o.eventName?`<div style="font-size:15px;font-weight:700;color:#111;margin-top:4px">${o.eventName}</div>`:""}
    <div style="color:#555;font-size:12px;margin-top:6px">Bill to: <strong style="color:#000">${o.billTo||o.cliName||"DBX"}</strong></div>
    ${client?`${[client.street,[client.city,client.provState].filter(Boolean).join(", "),client.postalZip,client.country].filter(Boolean).map(l=>`<div style="font-size:11px;color:#555">${l}</div>`).join("")}${client.email?`<div style="font-size:11px;color:#555">${client.email}</div>`:""}`:""}
    ${isEvent&&(o.pickCo||o.pickAddr)?`<div style="font-size:11px;color:#555;margin-top:6px"><strong>Location:</strong> ${o.pickCo||""}</div>${o.pickAddr?`<div style="font-size:11px;color:#555;white-space:pre-line">${o.pickAddr}</div>`:""}`:""}
  </div>
  <div style="text-align:right;font-size:12px;line-height:2;color:#333">
    <div><span style="font-weight:700;color:#dc2626">Date:</span> ${fd(o.reqDate||o.pickDate)}</div>
    ${safeRef?`<div><span style="font-weight:700;color:#dc2626">Ref:</span> ${safeRef}</div>`:""}
    ${o.poNumber?`<div><span style="font-weight:700;color:#dc2626">PO #:</span> ${o.poNumber}</div>`:""}
    ${!isEvent&&drv.drvName?`<div><span style="font-weight:700">Driver:</span> ${drv.drvName}</div>`:""}
    ${!isEvent&&drv.trkUnit?`<div><span style="font-weight:700">Truck:</span> Unit ${drv.trkUnit}${drv.trkPlate?` &nbsp;|&nbsp; Plate: ${drv.trkPlate}`:""}</div>`:""}
    ${!isEvent&&drv.trlUnit?`<div><span style="font-weight:700">Trailer:</span> Unit ${drv.trlUnit}${drv.trlPlate?` &nbsp;|&nbsp; Plate: ${drv.trlPlate}`:""}</div>`:""}
    <div style="margin-top:6px;font-size:11px;font-weight:700;color:#000">${billingDiv.name}</div>
  </div>
</div>

<!-- Pickup / Delivery — transport only -->
${!isEvent?(()=>{
  const picks = o.pickStops || [{co:o.pickCo||"", addr:o.pickAddr||"", date:o.pickDate||""}];
  const dels = o.delStops || [{co:o.delCo||"", addr:o.delAddr||"", date:o.delDate||""}];
  const maxRows = Math.max(picks.length, dels.length);
  return Array.from({length:maxRows}, (_,i) => {
    const pk = picks[i]; const dl = dels[i];
    const pLabel = picks.length>1 ? `Pick Up — Stop ${i+1}` : "Pick Up";
    const dLabel = dels.length>1 ? `Delivery — Stop ${i+1}` : "Delivery";
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px">
  ${pk ? `<div style="border:1.5px solid #cbd5e1;border-radius:8px;padding:14px;min-height:80px;background:#f8fafc">
    <div style="font-weight:700;font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;letter-spacing:0.5px">${pLabel}${pk.date?` <span style="color:#000;font-size:13px;font-weight:700;text-transform:none;letter-spacing:0">— ${fd(pk.date)}</span>`:""}</div>
    ${pk.co?`<div style="font-weight:700;font-size:14px;margin-bottom:3px">${pk.co}</div>`:""}
    <div style="font-size:12px;line-height:1.6;color:#334155">${(pk.addr||"—").replace(/\n/g,"<br>")}</div>
    ${pk.contact?`<div style="font-size:11px;color:#475569;margin-top:5px">👤 ${pk.contact}${pk.phone?` &nbsp;·&nbsp; 📞 ${pk.phone}`:""}</div>`:pk.phone?`<div style="font-size:11px;color:#475569;margin-top:5px">📞 ${pk.phone}</div>`:""}
    ${pk.notes?`<div style="font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:5px 8px;margin-top:6px;line-height:1.5;white-space:pre-wrap">📌 ${pk.notes}</div>`:""}
  </div>` : `<div></div>`}
  ${dl ? `<div style="border:1.5px solid #cbd5e1;border-radius:8px;padding:14px;min-height:80px;background:#f8fafc">
    <div style="font-weight:700;font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;letter-spacing:0.5px">${dLabel}${dl.date?` <span style="color:#000;font-size:13px;font-weight:700;text-transform:none;letter-spacing:0">— ${fd(dl.date)}</span>`:""}</div>
    ${dl.co?`<div style="font-weight:700;font-size:14px;margin-bottom:3px">${dl.co}</div>`:""}
    <div style="font-size:12px;line-height:1.6;color:#334155">${(dl.addr||"—").replace(/\n/g,"<br>")}</div>
    ${dl.contact?`<div style="font-size:11px;color:#475569;margin-top:5px">👤 ${dl.contact}${dl.phone?` &nbsp;·&nbsp; 📞 ${dl.phone}`:""}</div>`:dl.phone?`<div style="font-size:11px;color:#475569;margin-top:5px">📞 ${dl.phone}</div>`:""}
    ${dl.notes?`<div style="font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:5px 8px;margin-top:6px;line-height:1.5;white-space:pre-wrap">📌 ${dl.notes}</div>`:""}
  </div>` : `<div></div>`}
</div>`;
  }).join("");
})():""}

<!-- Items — transport only -->
${!isEvent&&items.length?`<table style="width:100%;border-collapse:collapse;margin-bottom:18px">
  <thead><tr>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px">Pces</th>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px;width:45%">Description</th>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px">Weight</th>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px">Length</th>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px">Width</th>
    <th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.3px">Height</th>
  </tr></thead>
  <tbody>${itemRows}</tbody>
</table>`:""}

<!-- Notes -->
${o.notes?'<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:6px;padding:14px;font-size:12px;margin-bottom:18px;white-space:pre-line;line-height:1.6"><b style="font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#64748b">Information / Notes</b><br><br>'+o.notes+'</div>':''}

<!-- Event Pricing -->
${eventPricingSection}

<!-- Regular Pricing -->
${pricingSection}

<!-- POD -->
${podSection}
${!isEvent?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:100px">
  <div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Signature and name in print</div></div>
  <div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Date and Time</div></div>
</div>`:""}

</div>`;
}

async function downloadBolPdf(o, divInfo, includePod=false, includePricing=false, driverIndex=0, client=null) {
  // Generate PDF using buildBolHtml — opens in a new window for browser print/save
  const html = buildBolHtml(o, divInfo, includePod, includePricing, driverIndex, client);
  const w = window.open("", "_blank");
  if (!w) { alert("Please allow popups to view the PDF."); return; }
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>BOL ${o.bol}</title>
    <style>
      @media print { body { margin: 0; } .no-print { display: none !important; } }
      body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 24px; background: #fff; }
    </style>
  </head><body>
    ${html}
    <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 4px 12px rgba(220,38,38,0.4)">
        🖨 Print / Save as PDF
      </button>
    </div>
  </body></html>`);
  w.document.close();
}
const downloadBolPdfWithPod = downloadBolPdf; // same function — POD info already on order

// ═══ STYLES ═══
const T = { bg:"#020817", card:"#0f172a", surface:"#1e293b", border:"#1e293b", hover:"#0f172a", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b", red:"#dc2626", redDk:"#b91c1c", redDim:"rgba(220,38,38,0.1)", green:"#22c55e", greenDim:"rgba(34,197,94,0.1)", amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)", blue:"#3b82f6" };
const Tbg = T.bg;
const sIn = { width:"100%", padding:"8px 10px", background:T["bg"], border:`1px solid ${T.border}`, borderRadius:6, color:T.text, fontSize:13, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };
const sLbl = { display:"block", fontSize:10, fontWeight:600, color:T.muted, marginBottom:3, textTransform:"uppercase", letterSpacing:0.5 };
const sCrd = { background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:16, marginBottom:12 };
const sBtn = { display:"inline-flex", alignItems:"center", gap:6, padding:"8px 14px", border:"none", borderRadius:8, color:"#fff", fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"inherit" };
const bP = { ...sBtn, background:`linear-gradient(135deg,${T.red},${T.redDk})` };
const bS = { ...sBtn, background:"#e2e8f0", border:`1px solid #94a3b8`, color:"#0f172a", fontWeight:500 };
const bD = { ...sBtn, background:"transparent", border:"1px solid #fca5a5", color:"#ef4444" };

// ═══ ICONS ═══
const Icons = {
  plus:<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  back:<><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
  edit:<><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
  eye:<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
  search:<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
  mail:<><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></>,
  check:<><polyline points="20 6 9 17 4 12"/></>,
  file:<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
  truck:<><rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></>,
  users:<><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/></>,
  dash:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  clip:<><path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.19 9.19a1 1 0 01-1.41-1.41l9.19-9.19"/></>,
  dl:<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,
  dollar:<><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></>,
  map:<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></>,
  pdf:<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>,
  sync:<><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></>,
  chart:<><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>,
  calendar:<><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>,
  barcode:<><rect x="2" y="4" width="2" height="16"/><rect x="6" y="4" width="1" height="16"/><rect x="9" y="4" width="2" height="16"/><rect x="13" y="4" width="1" height="16"/><rect x="16" y="4" width="3" height="16"/><rect x="21" y="4" width="1" height="16"/></>,
  shield:<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></>,
};
const Ic = ({n, s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{Icons[n]}</svg>;
const Badge = ({s, billingType, poRequired, poNumber, orderType}) => {
  const isLegacyClosed = ["no-charge"].includes(s);
  const isClosed = s==="closed" || isLegacyClosed;
  const isNoCharge = billingType==="no-charge" || s==="no-charge";
  const bg = s==="invoiced" ? "#06b6d4" : isClosed ? (isNoCharge ? "#14b8a6" : "#22c55e") : (S_COLOR[s]||"#666");
  const label = s==="invoiced" ? "Invoiced" : isClosed ? (isNoCharge ? "Closed – No Charge" : "Closed") : (S_LABEL[s]||s);
  const needsDarkText = ["#f59e0b","#22c55e","#14b8a6","#06b6d4","#f97316"].includes(bg) || (isClosed && isNoCharge) || s==="assigned";
  const showPo = poRequired && !poNumber && ["ready-to-bill","pod-received","completed"].includes(s);
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,flexWrap:"nowrap"}}>
    <span style={{display:"inline-block",padding:"2px 10px",borderRadius:20,fontSize:10,fontWeight:600,color:needsDarkText?"#000":"#fff",background:bg,whiteSpace:"nowrap"}}>{label}</span>
    {orderType==="event" && <span style={{display:"inline-block",padding:"2px 8px",borderRadius:20,fontSize:9,fontWeight:700,color:"#fff",background:"#8b5cf6",whiteSpace:"nowrap"}}>📋 Project</span>}
    {showPo && <span style={{display:"inline-block",padding:"2px 8px",borderRadius:20,fontSize:9,fontWeight:700,color:"#000",background:"#f97316",whiteSpace:"nowrap"}}>⚠ PO needed</span>}
  </span>;
};
const Field = ({l, children}) => <div style={{marginBottom:10}}><label style={sLbl}>{l}</label>{children}</div>;
// ═══ SEARCHABLE SELECT (type-anywhere filter; substring match) ═══
// options: [{value, label, sub?}]  value=id, label=main text, sub=secondary (e.g. city) — both searched
function SearchSelect({ options, value, onChange, placeholder="Search...", emptyLabel="Select..." }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef(null);
  const selected = options.find(o => o.value === value);
  useEffect(() => {
    if(!open) return;
    const onDoc = e => { if(wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const ql = q.trim().toLowerCase();
  const filtered = ql ? options.filter(o => (`${o.label} ${o.sub||""}`).toLowerCase().includes(ql)) : options;
  return <div ref={wrapRef} style={{position:"relative"}}>
    <div onClick={()=>{setOpen(o=>!o);setQ("");}} style={{...sIn,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",minHeight:34}}>
      <span style={{color:selected?T.text:T.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selected?selected.label+(selected.sub?` — ${selected.sub}`:""):emptyLabel}</span>
      <span style={{color:T.muted,fontSize:10,marginLeft:6}}>▾</span>
    </div>
    {open && <div style={{position:"absolute",top:"calc(100% + 2px)",left:0,right:0,zIndex:50,background:T.card,border:`1px solid ${T.border}`,borderRadius:6,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",maxHeight:280,display:"flex",flexDirection:"column"}}>
      <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder={placeholder} style={{...sIn,borderRadius:"6px 6px 0 0",borderWidth:"0 0 1px 0"}} />
      <div style={{overflowY:"auto"}}>
        {value && <div onClick={()=>{onChange("");setOpen(false);setQ("");}} style={{padding:"7px 10px",fontSize:12,color:T.muted,cursor:"pointer",fontStyle:"italic"}}>— Clear selection —</div>}
        {filtered.length===0 && <div style={{padding:"10px",fontSize:12,color:T.muted}}>No matches</div>}
        {filtered.map(o => <div key={o.value} onClick={()=>{onChange(o.value);setOpen(false);setQ("");}} style={{padding:"7px 10px",fontSize:12,cursor:"pointer",background:o.value===value?T.surface:"transparent",borderBottom:`1px solid ${T.border}`}} onMouseEnter={e=>e.currentTarget.style.background=T.hover} onMouseLeave={e=>e.currentTarget.style.background=o.value===value?T.surface:"transparent"}>
          {o.label}{o.sub?<span style={{color:T.muted}}> — {o.sub}</span>:""}
        </div>)}
      </div>
    </div>}
  </div>;
}
const PageHdr = ({title, children}) => <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,flexWrap:"wrap"}}><h1 style={{fontSize:18,fontWeight:700,margin:0}}>{title}</h1>{children}</div>;

// ═══ DATE PICKER WITH CALENDAR ═══
function DatePicker({value, onChange, placeholder}) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const parsed = value ? new Date(value+"T12:00:00") : null;
  const [viewYear, setViewYear] = useState(parsed?.getFullYear() || new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.getMonth() ?? new Date().getMonth());
  useEffect(() => { if (!open) return; const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [open]);
  useEffect(() => { if (open && parsed) { setViewYear(parsed.getFullYear()); setViewMonth(parsed.getMonth()); } }, [open]);
  const DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const cells = [];
  for (let i=0; i<firstDay; i++) cells.push(null);
  for (let d=1; d<=daysInMonth; d++) cells.push(d);
  const pick = d => { const mm=String(viewMonth+1).padStart(2,"0"); const dd=String(d).padStart(2,"0"); onChange(`${viewYear}-${mm}-${dd}`); setOpen(false); };
  const prevM = () => { if (viewMonth===0) { setViewMonth(11); setViewYear(y=>y-1); } else setViewMonth(m=>m-1); };
  const nextM = () => { if (viewMonth===11) { setViewMonth(0); setViewYear(y=>y+1); } else setViewMonth(m=>m+1); };
  const selDay = parsed ? parsed.getDate() : null;
  const selMonth = parsed ? parsed.getMonth() : null;
  const selYear = parsed ? parsed.getFullYear() : null;
  const today = new Date(); const todayD = today.getDate(); const todayM = today.getMonth(); const todayY = today.getFullYear();
  const display = parsed ? parsed.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
  return <div ref={ref} style={{position:"relative"}}>
    <div style={{...sIn,display:"flex",alignItems:"center",cursor:"pointer",gap:6}} onClick={()=>setOpen(!open)}>
      <Ic n="calendar" s={14}/>
      <span style={{flex:1,color:display?T.text:T.dim}}>{display || placeholder || "Select date..."}</span>
      {value && <button onClick={e=>{e.stopPropagation();onChange("");}} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14,padding:0}}>×</button>}
    </div>
    {open && <div style={{position:"absolute",top:"100%",left:0,zIndex:999,marginTop:4,background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:10,width:260,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <button onClick={prevM} style={{background:"none",border:"none",color:T.text,cursor:"pointer",fontSize:16,padding:"2px 6px"}}>‹</button>
        <span style={{fontSize:12,fontWeight:600,color:T.text}}>{MONTHS[viewMonth]} {viewYear}</span>
        <button onClick={nextM} style={{background:"none",border:"none",color:T.text,cursor:"pointer",fontSize:16,padding:"2px 6px"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,textAlign:"center"}}>
        {DAYS.map(d=><div key={d} style={{fontSize:9,fontWeight:600,color:T.dim,padding:4}}>{d}</div>)}
        {cells.map((d,i)=>{
          if (!d) return <div key={`e${i}`}/>;
          const isSel = d===selDay && viewMonth===selMonth && viewYear===selYear;
          const isToday = d===todayD && viewMonth===todayM && viewYear===todayY;
          return <div key={i} onClick={()=>pick(d)} style={{padding:5,fontSize:11,borderRadius:4,cursor:"pointer",fontWeight:isSel?700:isToday?600:400,background:isSel?T.red:isToday?"rgba(14,165,233,0.15)":"transparent",color:isSel?"#fff":isToday?T.red:T.text,transition:"background 0.1s"}}
            onMouseEnter={e=>{if(!isSel)e.target.style.background=T.hover}} onMouseLeave={e=>{if(!isSel)e.target.style.background=isSel?T.red:isToday?"rgba(14,165,233,0.15)":"transparent"}}>{d}</div>;
        })}
      </div>
      <div style={{marginTop:6,textAlign:"center"}}>
        <button onClick={()=>{const t=new Date();pick(t.getDate());setViewMonth(t.getMonth());setViewYear(t.getFullYear());}} style={{fontSize:10,color:T.red,background:"none",border:"none",cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>Today</button>
      </div>
    </div>}
  </div>;
}

// ═══ CONFIRM MODAL ═══
function ConfirmModal({show, title, message, onConfirm, onCancel, confirmLabel, confirmColor}) {
  if (!show) return null;
  return <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onCancel}>
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:24,maxWidth:360,width:"100%",boxShadow:"0 8px 30px rgba(0,0,0,0.4)"}} onClick={e=>e.stopPropagation()}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:8,color:confirmColor||"#ef4444"}}>{title||"Confirm"}</div>
      <div style={{fontSize:13,color:T.muted,marginBottom:20,lineHeight:1.5}}>{message||"Are you sure?"}</div>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
        <button style={{...bS,padding:"8px 18px",fontSize:12}} onClick={onCancel}>Cancel</button>
        <button style={{...sBtn,background:confirmColor||"#ef4444",padding:"8px 18px",fontSize:12}} onClick={onConfirm}>{confirmLabel||"Delete"}</button>
      </div>
    </div>
  </div>;
}

function useConfirm() {
  const [state, setState] = useState({show:false, title:"", message:"", resolve:null, confirmLabel:"Delete", confirmColor:"#ef4444"});
  const confirm = (title, message, opts={}) => new Promise(resolve => {
    setState({show:true, title, message, resolve, confirmLabel:opts.confirmLabel||"Delete", confirmColor:opts.confirmColor||"#ef4444"});
  });
  const handleConfirm = () => { state.resolve?.(true); setState(s=>({...s,show:false})); };
  const handleCancel = () => { state.resolve?.(false); setState(s=>({...s,show:false})); };
  const modal = <ConfirmModal show={state.show} title={state.title} message={state.message} onConfirm={handleConfirm} onCancel={handleCancel} confirmLabel={state.confirmLabel} confirmColor={state.confirmColor}/>;
  return { confirm, modal };
}

// ═══ RESPONSIVE CSS ═══
const RCSS = `@media(max-width:768px){.dbx-app aside{width:56px!important}.dbx-app .nav-lbl{display:none!important}.dbx-app .sidebar-ft{display:none!important}.dbx-app .brand-txt{display:none!important}}@media print{.dbx-app aside,.no-print{display:none!important}.dbx-app main{overflow:visible!important}} input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none!important;margin:0} input[type=number]{-moz-appearance:textfield!important}`;

// ═══ LOGO ═══
const LOGO = "https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410";


// ═══ MAIN APP ═══
export default function App() {
  // Auth state
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [isMobile, setIsMobile] = useState(()=>typeof window !== "undefined" && window.innerWidth <= 768);
  useEffect(()=>{
    const check = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", check);
    return ()=>window.removeEventListener("resize", check);
  },[]);

  // Demo mode — read-only access for prospects
  const isDemo = user?.email === "demo@cargodx.ca";

  // App state — must be declared before any returns
  const [dbData, setDbData] = useState({ clients:[], drivers:[], trucks:[], trailers:[], locations:[], orders:[], stickers:[], events:[], nBol:2000 });
  const [pg, setPg] = useState("dashboard");
  const [sub, setSub] = useState(null);
  const [q, setQ] = useState("");
  const [flt, setFlt] = useState("all");
  const [multiFlts, setMultiFlts] = useState([]);
  const [highlightBol, setHighlightBol] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showBolModal, setShowBolModal] = useState(false);
  const { confirm: cfm, modal: cfmModal } = useConfirm();

  // Listen for auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
    return () => unsub();
  }, []);

  // Load data from Firestore when authenticated
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let unsubs = [];
    // Safety timeout — if loading takes more than 15s, force-show the app anyway
    const safetyTimer = setTimeout(() => setLoading(false), 15000);
    async function init() {
      try {
        const data = await loadAllData();
        setDbData(data);
      } catch (e) { console.error("Load error:", e); }
      clearTimeout(safetyTimer);
      setLoading(false);

      // Set up real-time listeners for each collection
      for (const col of COLLECTIONS) {
        const unsub = onSnapshot(collection(db, col), snap => {
          const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          setDbData(prev => ({ ...prev, [col]: items }));
        }, err => { console.warn(`Listener ${col}:`, err.code); });
        unsubs.push(unsub);
      }
    }
    init();
    return () => unsubs.forEach(u => u());
  }, [user]);

  const handleLogin = async (e) => {
    if(e && e.preventDefault) e.preventDefault();
    if(!loginEmail.trim() || !loginPass.trim()) { setLoginErr("Please enter your email and password."); return; }
    setLoggingIn(true); setLoginErr("");
    try {
      await signInWithEmailAndPassword(auth, loginEmail, loginPass);
      localStorage.setItem("dbx_last_activity", String(Date.now()));
    } catch(err) {
      console.error("Login error:", err.code, err.message);
      setLoginErr(err.code==="auth/invalid-credential"||err.code==="auth/wrong-password"||err.code==="auth/user-not-found"?"Invalid email or password":err.code==="auth/too-many-requests"?"Too many attempts. Try again later.":err.code==="auth/invalid-email"?"Invalid email address.":`Login failed: ${err.code}`);
    }
    setLoggingIn(false);
  };

  const handleLogout = async () => { await signOut(auth); };

  // ── Auto-logoff after 12 hours of inactivity (security) ──
  useEffect(() => {
    if (!user) return;
    const TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
    let timer = null;
    const reset = () => {
      if (timer) clearTimeout(timer);
      localStorage.setItem("dbx_last_activity", String(Date.now()));
      timer = setTimeout(async () => {
        await signOut(auth);
        alert("You've been signed out due to inactivity. Please log in again.");
      }, TIMEOUT_MS);
    };
    // Only check elapsed time if user was previously active — not on fresh logins
    const last = parseInt(localStorage.getItem("dbx_last_activity") || "0", 10);
    if (last > 0 && (Date.now() - last) > TIMEOUT_MS) {
      signOut(auth);
      return;
    }
    const events = ["mousedown", "keydown", "touchstart", "scroll", "mousemove"];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [user]);

  if (authLoading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T["bg"],color:T.text,fontFamily:"'Inter',system-ui,sans-serif"}}><div style={{fontSize:14}}>Loading...</div></div>;

  if (!user) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T["bg"],fontFamily:"'Inter',system-ui,sans-serif"}}>
    <div style={{width:360,padding:36,background:T.card,borderRadius:12,border:`1px solid ${T.border}`}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
          <img src="https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410" alt="DBX" style={{height:70,borderRadius:8,marginBottom:4}}/>
        </div>
        <div style={{fontSize:20,fontWeight:700,color:T.red,marginBottom:2}}>{APP_NAME}</div>
        <div style={{fontSize:11,color:T.muted}}>{COMPANY_NAME}</div>
      </div>
      <div>
        <div style={{marginBottom:12}}><label style={sLbl}>Email</label><input style={sIn} type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="your@email.com" onKeyDown={e=>e.key==="Enter"&&handleLogin(e)}/></div>
        <div style={{marginBottom:16}}><label style={sLbl}>Password</label><input style={sIn} type="password" value={loginPass} onChange={e=>setLoginPass(e.target.value)} placeholder="Enter password" onKeyDown={e=>e.key==="Enter"&&handleLogin(e)}/></div>
        {loginErr && <div style={{fontSize:11,color:"#ef4444",marginBottom:12,textAlign:"center"}}>{loginErr}</div>}
        <button onClick={handleLogin} disabled={loggingIn} style={{...bP,width:"100%",padding:"12px 0",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>{loggingIn?"Signing in...":"Sign In"}</button>
      </div>
    </div>
  </div>;

  // ── Authenticated App ──

  const go = (p,s=null,opts={}) => { setPg(p); setSub(s); setQ(""); const initF=opts.initFlt||"all"; setFlt(initF); setMultiFlts(initF!=="all"?[initF]:[]); if(opts.highlightBol) setHighlightBol(opts.highlightBol); else setHighlightBol(null); };

  // ── Firebase CRUD wrappers ──
  const saveColl = async (col, list) => {
    if (isDemo) { alert("Demo mode — read only. Contact us to get your own account!"); return; }
    // For simple CRUD pages (clients, drivers, locations) — diff and sync
    const prev = dbData[col];
    const prevIds = new Set(prev.map(x=>x.id));
    const newIds = new Set(list.map(x=>x.id));

    // Deleted
    for (const item of prev) {
      if (!newIds.has(item.id)) await fbDelete(col, item.id);
    }
    // Added or updated
    for (const item of list) {
      if (!prevIds.has(item.id)) {
        // New item — add to Firestore
        const { id: _oldId, ...rest } = item;
        const ref = await addDoc(collection(db, col), rest);
        item.id = ref.id; // update with Firestore ID
      } else {
        const orig = prev.find(x=>x.id===item.id);
        if (JSON.stringify(orig) !== JSON.stringify(item)) {
          const { id, ...rest } = item;
          await updateDoc(doc(db, col, id), rest);
        }
      }
    }
    // Real-time listener will update state
  };

  // Order helpers
  // Opens the BOL number choice modal
  const newOrd = () => setShowBolModal(true);

  // Actually creates the order — customBol optional
  const createOrd = async (customBol) => {
    setShowBolModal(false);
    setSaving(true);
    try {
      const bol = customBol || await getNextBol();
      const o = { bol, status:"unassigned", divId:"", cliId:"", cliName:"", billTo:"", reqDate:td(), pickDate:"", delDate:"", ref:"",
        drvId:"", drvName:"", drvEmail:"", trkId:"", trkUnit:"", trkPlate:"", trlId:"", trlUnit:"",
        pickCo:"", pickAddr:"", delCo:"", delAddr:"",
        customsType:"", stickerId:"", stickerNum:"",
        items:[{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}], notes:"", files:[], specReqs:[], specReqCustom:"",
        podBy:"", podDate:"", podTime:"",
        price:{cur:"CAD",base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[{desc:"",amt:""}]},
        created:new Date().toISOString() };
      // Don't save to Firestore yet — only on Save Order click
      go("oe",{o,mode:"new"});
    } catch(e) { console.error(e); alert("Error creating order"); }
    setSaving(false);
  };

  const dupOrd = async (source, copies, dates) => {
    setSaving(true);
    try {
      const {id, bol:_bol, status:_s, drvId:_d, drvName:_dn, drvEmail:_de, trkId:_tk, trkUnit:_tu, trkPlate:_tp,
        trlId:_tl, trlUnit:_tlu, trlPlate:_tlp, extraDrivers:_ex,
        podBy:_pb, podDate:_pd, podTime:_pt, billingType:_bt, noInvoiceReason:_nir, price:_pr, ...rest} = source;
      const lastBol = {current: null};
      for(let i=0;i<copies;i++) {
        const bol = await getNextBol();
        lastBol.current = bol;
        const pickDate = dates[i] ? dates[i].toISOString().split("T")[0] : "";
        // Update pickStops and delStops dates if they exist
        const pickStops = (rest.pickStops||[]).map((s,si)=>si===0?{...s,date:pickDate}:s);
        const newOrder = {...rest, bol, status:"unassigned",
          drvId:"", drvName:"", drvEmail:"", trkId:"", trkUnit:"", trkPlate:"",
          trlId:"", trlUnit:"", trlPlate:"", extraDrivers:[],
          podBy:"", podDate:"", podTime:"", billingType:"", noInvoiceReason:"",
          price:{cur:"CAD",base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[{desc:"",amt:""}]},
          pickDate, delDate:"", reqDate:pickDate||td(),
          pickStops: pickStops.length>0 ? pickStops : rest.pickStops,
          created:new Date().toISOString()};
        await savOrd(newOrder);
      }
      alert(`✓ Created ${copies} duplicate order${copies>1?"s":""}!`);
      go("ol", null, {highlightBol: lastBol.current});
    } catch(e) { console.error(e); alert("Error duplicating order: "+e.message); }
    setSaving(false);
  };

  const savOrd = async (o, opts={}) => {
    if (isDemo) { alert("Demo mode — read only. Contact us to get your own account!"); return; }
    // Safety: if order has a bol but no id, try to find id from dbData
    if (!o.id && o.bol) {
      const found = dbData.orders.find(x => x.bol === o.bol);
      if (found?.id) o = { ...o, id: found.id };
    }
    setSaving(true);
    try {
      const { id, ...rest } = o;
      let savedId = id;

      // Track sticker changes — find old order to compare
      const oldOrder = id ? dbData.orders.find(x=>x.id===id) : null;
      const oldStickerId = oldOrder?.stickerId;
      const newStickerId = o.stickerId;

      // If sticker changed, release old one and assign new one
      if (oldStickerId && oldStickerId !== newStickerId) {
        try { await updateDoc(doc(db, "stickers", oldStickerId), { status:"available", bolNum:"", orderId:"" }); } catch {}
      }
      if (newStickerId && newStickerId !== oldStickerId) {
        try { await updateDoc(doc(db, "stickers", newStickerId), { status:"assigned", bolNum:o.bol, orderId:id||"" }); } catch {}
      }

      if (id) {
        await updateDoc(doc(db, "orders", id), rest);
      } else {
        const ref = await addDoc(collection(db, "orders"), rest);
        savedId = ref.id;
        o = {...o, id: savedId};
        // Update sticker with order ID now that we have it
        if (newStickerId) {
          try { await updateDoc(doc(db, "stickers", newStickerId), { status:"assigned", bolNum:o.bol, orderId:savedId }); } catch {}
        }
        // Auto-email BOL PDF on new order creation (non-blocking)
        const autoCli = dbData.clients.find(c=>c.id===o.cliId)||null;
        const autoDiv = DIVS.find(d=>d.id===o.divId)||null;
        callCloudFn("sendBolEmail", {
          order: { ...o, divName: autoDiv?.name || "" },
          client: autoCli ? { name:autoCli.name||"", street:autoCli.street||"", city:autoCli.city||"", provState:autoCli.provState||"", postalZip:autoCli.postalZip||"", country:autoCli.country||"", email:autoCli.billingEmail||autoCli.email||"" } : null,
          toEmail: REPORTS_EMAIL,
          subject: `BOL ${o.bol} — ${o.cliName||"CargoDX"} — Created`,
          includeAttachments: true,
        }).catch(emailErr => console.warn("Auto-email failed (non-blocking):", emailErr));
      }
      if (opts.stayOnEdit) { return; }
      // Update dbData locally so OrderDetail shows new data immediately
      setDbData(prev => ({...prev, orders: prev.orders.map(x=>x.id===o.id?o:x)}));
      go("od", o);
    } catch(e) { console.error(e); alert("Error saving order"); }
    setSaving(false);
  };

  const delOrd = async (id) => {
    const ok = await cfm("Delete Order", "Are you sure you want to delete this order? All attached files will also be removed. This cannot be undone.");
    if (!ok) return;
    setSaving(true);
    try {
      // Delete associated files from Storage
      const order = dbData.orders.find(x=>x.id===id);
      if (order?.files) {
        for (const f of order.files) {
          if (f.path) {
            try { await deleteObject(storageRef(storage, f.path)); } catch {}
          }
        }
      }
      // Release sticker if assigned
      if (order?.stickerId) {
        try { await updateDoc(doc(db, "stickers", order.stickerId), { status:"available", bolNum:"", orderId:"" }); } catch {}
      }
      await fbDelete("orders", id);
      go("ol");
    } catch(e) { console.error(e); alert("Error deleting order"); }
    setSaving(false);
  };

  const setStat = async (id, s) => {
    try {
      await updateDoc(doc(db, "orders", id), { status: s });
      // Update sticker status
      const order = dbData.orders.find(x=>x.id===id);
      if (order?.stickerId) {
        if (s === "invoiced") {
          // Only mark as used when sent to accounting
          try { await updateDoc(doc(db, "stickers", order.stickerId), { status:"used" }); } catch {}
        }
        if (s === "cancelled") {
          try { await updateDoc(doc(db, "stickers", order.stickerId), { status:"available", bolNum:"", orderId:"" }); } catch {}
        }
      }
      if (sub) setSub(p => ({...p, status: s}));
    } catch(e) { console.error(e); }
  };

  const orders = dbData.orders.filter(o => {
    const s = q.toLowerCase();
    const m = !s || [o.bol,o.cliName,o.drvName,o.delAddr,o.pickAddr,o.ref,o.status,o.pickCo,o.delCo].join(" ").toLowerCase().includes(s);
    return m;
  }).sort((a,b)=>new Date(b.created)-new Date(a.created));

  const cnt = s => dbData.orders.filter(o=>o.status===s).length;
  const nav = [{id:"dashboard",l:"Dashboard",i:"dash"},{id:"ol",l:"Orders",i:"file"},{id:"cr",l:"Live Crew",i:"users"},{id:"cl",l:"Clients",i:"users"},{id:"lo",l:"Locations",i:"map"},{id:"eq",l:"Equipment",i:"truck"},{id:"dr",l:"Drivers / Employees / Suppliers",i:"users"},{id:"pp",l:"PAPS / PARS",i:"barcode"},{id:"ts",l:"Timesheets",i:"calendar"},{id:"sf",l:"Safety",i:"shield"},{id:"ifta",l:"IFTA Fuel Tax",i:"chart"},{id:"ev",l:"Events",i:"calendar"},{id:"qt",l:"Quotes",i:"file"},{id:"rp",l:"Reports",i:"chart"},{id:"sr",l:"Search",i:"search"},{id:"cd",l:"Documents",i:"file"},{id:"ed",l:"Employee Docs",i:"users"}];
  const isOrd = pg.startsWith("o");



  const savOrdMobile = async (o) => {
    if (isDemo) { alert("Demo mode — read only."); return null; }
    const { id, ...rest } = o;
    try {
      if (id) {
        await updateDoc(doc(db,"orders",id), rest);
        setDbData(prev=>({...prev, orders:prev.orders.map(x=>x.id===id?o:x)}));
        return o;
      } else {
        const ref = await addDoc(collection(db,"orders"), rest);
        const saved = {...o, id:ref.id};
        setDbData(prev=>({...prev, orders:[...prev.orders, saved]}));
        // Send BOL email (non-blocking)
        const autoCli = dbData.clients.find(c=>c.id===saved.cliId)||null;
        const autoDiv = DIVS.find(d=>d.id===saved.divId)||null;
        callCloudFn("sendBolEmail", {
          order: { ...saved, divName: autoDiv?.name || "" },
          client: autoCli ? { name:autoCli.name||"", street:autoCli.street||"", city:autoCli.city||"", provState:autoCli.provState||"", postalZip:autoCli.postalZip||"", country:autoCli.country||"", email:autoCli.billingEmail||autoCli.email||"" } : null,
          toEmail: REPORTS_EMAIL,
          subject: `BOL ${saved.bol} — ${saved.cliName||"DBX"} — Created (Mobile)`,
          includeAttachments: true,
        }).catch(e=>console.warn("Mobile auto-email failed:", e));
        return saved;
      }
    } catch(e) { alert("Error saving order"); return null; }
  };

  // On mobile: show MobileApp immediately without waiting for full desktop load
  if (isMobile && user) return (
    <div style={{position:"fixed",inset:0,zIndex:99999,background:"#0f172a"}}>
      <Suspense fallback={<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T.bg,color:T.muted,fontSize:14}}>Loading...</div>}><MobileApp db={dbData} savOrd={savOrdMobile} saveColl={saveColl} onExitMobile={()=>setIsMobile(false)}/></Suspense>
    </div>
  );

  if (loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T["bg"],color:T.text,fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>
    <div style={{textAlign:"center"}}>
      <img src={LOGO} alt={APP_NAME} style={{height:48,borderRadius:8,marginBottom:16}}/>
      <div style={{fontSize:14,color:T.muted}}>{`Loading ${APP_NAME}...`}</div>
      <div style={{marginTop:12,width:40,height:40,border:`3px solid ${T.border}`,borderTopColor:T.red,borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"12px auto"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  </div>;

  return (
    <div className="dbx-app" style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"'IBM Plex Sans',system-ui,sans-serif",background:T["bg"],color:T.text,overflow:"hidden"}}>
      {isDemo && <div style={{background:"linear-gradient(135deg,#dc2626,#7f1d1d)",padding:"8px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,zIndex:100}}>
        <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>👀 Demo Mode — Read Only &nbsp;·&nbsp; <span style={{fontWeight:400,opacity:0.9}}>You're exploring CargoDX. No changes can be saved.</span></div>
        <a href="mailto:mannydesl1@gmail.com" style={{fontSize:12,fontWeight:700,color:"#fff",background:"rgba(255,255,255,0.2)",padding:"4px 14px",borderRadius:20,textDecoration:"none",whiteSpace:"nowrap"}}>Get your own account →</a>
      </div>}
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
      <style>{RCSS}</style>
      <style>{`input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0} input[type=number]{-moz-appearance:textfield}`}</style>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* Saving overlay */}
      {saving && <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.3)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"20px 32px",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:20,height:20,border:`2px solid ${T.border}`,borderTopColor:T.red,borderRadius:"50%",animation:"spin 0.6s linear infinite"}}/>
          <span style={{fontSize:13,color:T.muted}}>Saving...</span>
        </div>
      </div>}
      {cfmModal}
      {showBolModal && <BolNumberModal nextBol={dbData.orders} onClose={()=>setShowBolModal(false)} onConfirm={createOrd} existingBols={dbData.orders.map(o=>String(o.bol))}/>}

      {/* SIDEBAR */}
      <aside style={{width:210,background:"#0f172a",borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",flexShrink:0,transition:"width 0.2s"}}>
        <div style={{padding:"18px 12px",borderBottom:`1px solid #1e293b`,display:"flex",alignItems:"center",justifyContent:"center",background:"#0f0f0f",minHeight:76}}>
          <img src="https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410" alt="DBX" style={{height:52,borderRadius:6,objectFit:"contain"}}/>
        </div>
        <nav style={{flex:1,padding:"6px 4px",overflowY:"auto",minHeight:0}}>
          {nav.map(n => <button key={n.id} onClick={()=>go(n.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:6,cursor:"pointer",marginBottom:1,background:(pg===n.id||(isOrd&&n.id==="ol"))?"rgba(220,38,38,0.15)":"transparent",color:(pg===n.id||(isOrd&&n.id==="ol"))?"#dc2626":T.muted,border:"none",width:"100%",textAlign:"left",fontFamily:"inherit",fontSize:12,fontWeight:500}}>
            <Ic n={n.i} s={15}/><span className="nav-lbl">{n.l}</span>
          </button>)}
          <button onClick={()=>setIsMobile(true)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:6,cursor:"pointer",marginTop:6,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,width:"100%",textAlign:"left",fontFamily:"inherit",fontSize:12,fontWeight:500}}>
            <span style={{fontSize:14,lineHeight:1}}>📱</span><span className="nav-lbl">Mobile View</span>
          </button>
        </nav>
        <div className="sidebar-ft" style={{padding:10,borderTop:`1px solid ${T.border}`,fontSize:8,color:T.dim}}>
          <div style={{fontSize:9,color:T.muted,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user.email}</div>
          <button onClick={handleLogout} style={{background:"none",border:`1px solid ${T.border}`,color:T.muted,cursor:"pointer",padding:"4px 8px",borderRadius:4,fontSize:9,fontFamily:"inherit",width:"100%"}}>Sign Out</button>
          <div style={{marginTop:4}}>`${APP_NAME} ${APP_VERSION}`</div>
          <div style={{color:"#22c55e",fontSize:7,marginTop:2}}>● Firestore synced</div>
        </div>
      </aside>

      {/* MAIN */}
      <main style={{flex:1,overflow:"auto",padding:0}}>
        {pg==="dashboard" && <Dashboard db={dbData} cnt={cnt} go={go} newOrd={newOrd}/>}
        {pg==="ol" && <OrderList orders={orders} q={q} setQ={setQ} flt={flt} setFlt={setFlt} multiFlts={multiFlts} setMultiFlts={setMultiFlts} go={go} newOrd={newOrd} db={dbData} highlightBol={highlightBol}/>}
        {pg==="oe" && sub && <OrderEdit data={sub} db={dbData} savOrd={savOrd} go={go}/>}
        {pg==="od" && sub && <OrderDetail o={dbData.orders.find(x=>x.id===sub.id)||sub} db={dbData} go={go} setStat={setStat} delOrd={delOrd} savOrd={savOrd} dupOrd={dupOrd}/>}
        {pg==="oa" && sub && <AssignOrder o={dbData.orders.find(x=>x.id===sub.id)||sub} db={dbData} savOrd={savOrd} go={go}/>}
        {pg==="op" && sub && <PodEntry o={dbData.orders.find(x=>x.id===sub.id)||sub} savOrd={savOrd} go={go}/>}
        {pg==="opr" && sub && <PricingEntry o={dbData.orders.find(x=>x.id===sub.id)||sub} db={dbData} savOrd={savOrd} go={go}/>}
        {pg==="cl" && <CrudPage title="Clients" items={dbData.clients} fields={[{k:"name",l:"Company Name"},{k:"street",l:"Street Address"},{k:"city",l:"City"},{k:"provState",l:"Province / State"},{k:"country",l:"Country"},{k:"postalZip",l:"Postal / Zip Code"},{k:"contact",l:"Contact Person"},{k:"phone",l:"Phone"},{k:"email",l:"Email"},{k:"billingEmail",l:"Billing Email"},{k:"preferredCurrency",l:"Preferred Invoicing Currency",tp:"select",opts:["","CAD","USD","EUR","GBP"]},{k:"notes",l:"Internal Notes",tp:"textarea"}]} save={l=>saveColl("clients",l)} orders={dbData.orders} orderKey="cliId"/>}
        {pg==="lo" && <CrudPage title="Locations" items={dbData.locations} fields={[{k:"company",l:"Company Name"},{k:"street",l:"Street Address"},{k:"city",l:"City"},{k:"provState",l:"Province / State"},{k:"country",l:"Country"},{k:"postalZip",l:"Postal / Zip Code"},{k:"distanceKm",l:"Distance from Base (km)",tp:"number"},{k:"contact",l:"Contact Person"},{k:"phone",l:"Phone"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} save={l=>saveColl("locations",l)}/>}
        {pg==="dr" && <DriversPage items={dbData.drivers} save={l=>saveColl("drivers",l)} col="drivers"/>}
        {pg==="ts" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><TimesheetsPage/></Suspense>}
        {pg==="sf" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><SafetyPage/></Suspense>}
        {pg==="ev" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><EventsPage/></Suspense>}
        {pg==="cr" && <CrewPage fireDb={db}/>}
        {pg==="sr" && <SearchPage db={dbData} go={go}/>}
        {pg==="cd" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><CompanyDocsPage/></Suspense>}
        {pg==="ed" && <EmployeeDocsPage/>}
        {pg==="rp" && <ReportsPage db={dbData} go={go}/>}
        {pg==="qt" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><QuotesPage clients={dbData.clients||[]}/></Suspense>}
        {pg==="ifta" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><IFTAPage trucks={db.trucks}/></Suspense>}
        {pg==="eq" && <EquipPage db={dbData} saveColl={saveColl}/>}
        {pg==="pp" && <PapsParsPage db={dbData} savOrd={savOrd}/>}
      </main>
    </div>
    {/* Mobile overlay */}
    {isMobile && <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:99999}}>
      <Suspense fallback={<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T.bg,color:T.muted,fontSize:14}}>Loading...</div>}><MobileApp db={dbData} savOrd={savOrdMobile} saveColl={saveColl} onExitMobile={()=>setIsMobile(false)}/></Suspense>
    </div>}
    </div>
  );
}

// ═══ DASHBOARD ═══
// Sort helper for a section
function useDashSort(orders) {
  const [sort, setSort] = useState("created_desc"); // default: newest first
  const toggle = (key) => setSort(s => {
    if (s === key+"_asc") return key+"_desc";
    if (s === key+"_desc") return key+"_asc";
    return key+"_asc";
  });
  const arrow = (key) => sort.startsWith(key) ? (sort.endsWith("_asc") ? " ↑" : " ↓") : " ↕";
  const sorted = [...orders].sort((a,b) => {
    const dir = sort.endsWith("_asc") ? 1 : -1;
    const key = sort.replace(/_asc|_desc$/,"");
    if (key === "bol") return dir * ((parseInt(a.bol)||0) - (parseInt(b.bol)||0));
    if (key === "client") return dir * (a.cliName||"").toLowerCase().localeCompare((b.cliName||"").toLowerCase());
    if (key === "pickdate") {
      const da = a.pickDate ? new Date(a.pickDate+"T12:00:00") : new Date(0);
      const db2 = b.pickDate ? new Date(b.pickDate+"T12:00:00") : new Date(0);
      return dir * (da - db2);
    }
    // default: created date desc
    return new Date(b.created) - new Date(a.created);
  });
  return { sorted, sort, toggle, arrow };
}

// Sort buttons row
function SortBar({toggle, arrow}) {
  const btnStyle = (key) => ({
    padding:"2px 8px", borderRadius:4, border:`1px solid ${T.border}`,
    background:"transparent", color:T.muted, fontSize:9, cursor:"pointer",
    fontFamily:"inherit", fontWeight:500, whiteSpace:"nowrap"
  });
  return <div style={{display:"flex",gap:4,marginBottom:8,flexWrap:"wrap",alignItems:"center"}}>
    <span style={{fontSize:9,color:T.dim,marginRight:2}}>Sort:</span>
    <button style={btnStyle("bol")} onClick={()=>toggle("bol")}>BOL #{arrow("bol")}</button>
    <button style={btnStyle("client")} onClick={()=>toggle("client")}>Client A–Z{arrow("client")}</button>
    <button style={btnStyle("pickdate")} onClick={()=>toggle("pickdate")}>Pickup Date{arrow("pickdate")}</button>
  </div>;
}


// ── 7-Day Pickup Calendar ──
function DashSection({title, color, count, children}) {
  const [open, setOpen] = useState(false);
  return <div style={sCrd}>
    <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",marginBottom:open?8:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{color,fontSize:13}}>●</span>
        <span style={{fontSize:13,fontWeight:600,color}}>{title}</span>
        <span style={{fontSize:10,padding:"1px 7px",borderRadius:10,background:color+"22",color,fontWeight:700}}>{count}</span>
      </div>
      <span style={{color:T.muted,fontSize:11,userSelect:"none"}}>{open?"▲":"▼"}</span>
    </div>
    {open && children}
  </div>;
}

function UpcomingPickups({orders, go}) {
  const days = [];
  const today = new Date();
  today.setHours(0,0,0,0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = d.toISOString().slice(0,10);
    const label = i===0?"Today":i===1?"Tomorrow":d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
    const dayOrders = orders.filter(o => 
      o.pickDate === dateStr && 
      ["unassigned","assigned"].includes(o.status)
    );
    days.push({dateStr, label, orders:dayOrders, isToday:i===0, isTomorrow:i===1});
  }
  const hasAny = days.some(d=>d.orders.length>0);
  if (!hasAny) return null;
  return <div style={{marginBottom:20}}>
    <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:0.5,marginBottom:10}}>Upcoming Pickups — Next 7 Days</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
      {days.map(d => (
        <div key={d.dateStr} style={{background:T.card,border:`2px solid ${d.isToday?"#ef4444":d.isTomorrow?"#eab308":T.border}`,borderRadius:10,padding:"10px 12px",height:160,display:"flex",flexDirection:"column",opacity:d.orders.length===0?0.4:1}}>
          <div style={{fontSize:10,fontWeight:700,color:d.isToday?"#ef4444":d.isTomorrow?"#eab308":T.muted,textTransform:"uppercase",marginBottom:6}}>{d.label}</div>
          <div style={{flex:1,overflowY:"auto"}}>
            {d.orders.length===0 && <div style={{fontSize:11,color:T.dim}}>No pickups</div>}
            {d.orders.map(o=><div key={o.id} onClick={()=>go("od",o)} style={{cursor:"pointer",padding:"5px 6px",borderRadius:5,background:T.bg,marginBottom:4,fontSize:11,border:`1px solid ${T.border}`}}>
              <div style={{fontWeight:600,color:T.text}}>BOL {o.bol}</div>
              <div style={{color:T.muted,fontSize:10}}>{o.ref||o.pickCo||o.cliName||"—"}</div>
              <div style={{marginTop:2}}><span style={{padding:"1px 6px",borderRadius:10,fontSize:9,fontWeight:600,color:"#fff",background:S_COLOR[o.status]||"#666"}}>{S_LABEL[o.status]||o.status}</span></div>
            </div>)}
          </div>
        </div>
      ))}
    </div>
  </div>;
}

function BolNumberModal({ onClose, onConfirm, existingBols=[] }) {
  const [mode, setMode] = useState("auto"); // "auto" | "custom"
  const [customBol, setCustomBol] = useState("");
  const trimmed = customBol.trim();
  const isDup = mode==="custom" && trimmed && existingBols.includes(trimmed);
  const canCreate = mode==="auto" || (trimmed && !isDup);
  const submit = () => { if(!canCreate) return; onConfirm(mode==="custom" ? trimmed : undefined); };
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div style={{background:T.card,borderRadius:12,padding:24,width:"100%",maxWidth:420,border:`1px solid ${T.border}`,boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
        <div style={{fontSize:16,fontWeight:700,color:T.text}}>New Order — BOL Number</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:T.dim,fontSize:20,cursor:"pointer",lineHeight:1}}>×</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        <button onClick={()=>setMode("auto")} style={{textAlign:"left",padding:"12px 14px",borderRadius:8,border:`1.5px solid ${mode==="auto"?T.red:T.border}`,background:mode==="auto"?"rgba(220,38,38,0.08)":"transparent",color:T.text,cursor:"pointer",fontFamily:"inherit"}}>
          <div style={{fontSize:13,fontWeight:700,color:mode==="auto"?T.red:T.text}}>Auto-generate</div>
          <div style={{fontSize:11,color:T.muted,marginTop:2}}>Use the next BOL number in sequence</div>
        </button>
        <button onClick={()=>setMode("custom")} style={{textAlign:"left",padding:"12px 14px",borderRadius:8,border:`1.5px solid ${mode==="custom"?T.red:T.border}`,background:mode==="custom"?"rgba(220,38,38,0.08)":"transparent",color:T.text,cursor:"pointer",fontFamily:"inherit"}}>
          <div style={{fontSize:13,fontWeight:700,color:mode==="custom"?T.red:T.text}}>Custom BOL #</div>
          <div style={{fontSize:11,color:T.muted,marginTop:2}}>Enter your own BOL number</div>
        </button>
      </div>
      {mode==="custom" && <div style={{marginBottom:16}}>
        <input autoFocus value={customBol} onChange={e=>setCustomBol(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit();}} placeholder="e.g. 2099 or DBX-2099"
          style={{width:"100%",padding:"10px 12px",borderRadius:7,border:`1px solid ${isDup?"#ef4444":T.border}`,background:T.bg,color:T.text,fontSize:14,fontFamily:"'IBM Plex Mono', monospace",boxSizing:"border-box",outline:"none"}}/>
        {isDup && <div style={{fontSize:11,color:"#ef4444",marginTop:6,fontWeight:600}}>⚠ BOL {trimmed} already exists. Choose a different number.</div>}
      </div>}
      <div style={{display:"flex",gap:8}}>
        <button onClick={submit} disabled={!canCreate} style={{flex:1,padding:"11px",borderRadius:8,border:"none",background:T.red,color:"#fff",fontWeight:700,fontSize:13,cursor:canCreate?"pointer":"not-allowed",opacity:canCreate?1:0.5,fontFamily:"inherit"}}>Create Order</button>
        <button onClick={onClose} style={{padding:"11px 20px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"inherit",fontSize:13}}>Cancel</button>
      </div>
    </div>
  </div>;
}

function Dashboard({db, cnt, go, newOrd}) {
  const [dashFilter, setDashFilter] = useState([]);
  const [divFilter, setDivFilter] = useState("all");
  const [cliFilter, setCliFilter] = useState("all");

  const clientOptions = [...new Map(db.orders.map(o=>{const cli=db.clients.find(c2=>c2.id===o.cliId); return [o.cliId,{id:o.cliId,name:o.cliName,city:cli?.city||o.pickCity||""}];})).values()].filter(c=>c.name).sort((a,b)=>a.name.localeCompare(b.name));

  const filtered = db.orders.filter(o=>{
    if(divFilter!=="all" && o.divId!==divFilter) return false;
    if(cliFilter!=="all" && o.cliId!==cliFilter) return false;
    return true;
  });

  const ua = filtered.filter(o=>o.status==="unassigned");
  const assigned = filtered.filter(o=>o.status==="assigned");
  const inTransit = filtered.filter(o=>o.status==="in-transit");
  const readyToBill = filtered.filter(o=>["ready-to-bill","pod-received","completed","completed-noinvoice"].includes(o.status));
  const closed = filtered.filter(o=>o.status==="closed" && o.billingType!=="no-charge");
  const noCharge = filtered.filter(o=>o.status==="no-charge" || o.billingType==="no-charge");

  const noneSelected = dashFilter.length===0;
  const showUa         = noneSelected || dashFilter.includes("unassigned");
  const showAssigned   = noneSelected || dashFilter.includes("assigned");
  const showIt         = noneSelected || dashFilter.includes("in-transit");
  const showRtb        = noneSelected || dashFilter.includes("ready-to-bill");
  const showClosed     = noneSelected || dashFilter.includes("closed");
  const showNoCharge   = noneSelected || dashFilter.includes("no-charge");

  const uaSort = useDashSort(ua);
  const assignedSort = useDashSort(assigned);
  const itSort = useDashSort(inTransit);
  const rtbSort = useDashSort(readyToBill);
  const closedSort = useDashSort(closed);
  const noChargeSort = useDashSort(noCharge);

  const selStyle = {...sIn, width:"auto", minWidth:140, fontSize:11, padding:"5px 8px"};
  const hasFilter = divFilter!=="all"||cliFilter!=="all";

  return <div style={{padding:20}}>
    <PageHdr title="Dashboard"><button style={bP} onClick={newOrd}><Ic n="plus" s={14}/> New Order</button></PageHdr>
    <div style={{display:"grid",gridTemplateColumns:"220px 1fr",gap:16,marginBottom:20,alignItems:"start"}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8}}>
        {[{l:"Total Orders",v:db.orders.length,c:"#3b82f6",flt:null},{l:"Unassigned",v:cnt("unassigned"),c:"#ef4444",flt:"unassigned"},{l:"Assigned / In Progress",v:cnt("assigned"),c:"#f59e0b",flt:"assigned"},{l:"In Transit",v:cnt("in-transit"),c:"#8b5cf6",flt:"in-transit"},{l:"Ready to Bill",v:cnt("ready-to-bill")+cnt("pod-received")+cnt("completed")+cnt("completed-noinvoice"),c:"#f97316",flt:"ready-to-bill"},{l:"Closed",v:db.orders.filter(o=>o.status==="closed"&&o.billingType!=="no-charge").length,c:"#22c55e",flt:"closed"},{l:"Closed – No Charge",v:db.orders.filter(o=>o.status==="no-charge"||o.billingType==="no-charge").length,c:"#14b8a6",flt:"no-charge"},{l:"Invoiced",v:cnt("invoiced"),c:"#06b6d4",flt:"invoiced"}].map(s =>
          <div key={s.l} onClick={()=>s.flt && go("ol",null,{initFlt:s.flt})} style={{...sCrd,cursor:s.flt?"pointer":"default",padding:"10px 14px"}}>
            <div style={{fontSize:10,color:T.muted,textTransform:"uppercase"}}>{s.l}</div>
            <div style={{fontSize:24,fontWeight:700,color:s.c,marginTop:2}}>{s.v}</div>
          </div>
        )}
      </div>
      <UpcomingPickups orders={db.orders} go={go}/>
    </div>

    {/* Division + Client filters */}
    <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      <span style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase"}}>Filter:</span>
      <select style={selStyle} value={divFilter} onChange={e=>{setDivFilter(e.target.value);}}>
        <option value="all">All Divisions</option>
        {[...DIVS].sort((a,b)=>(a.short||"").localeCompare(b.short||"")).map(d=><option key={d.id} value={d.id}>{d.short}</option>)}
      </select>
      <select style={selStyle} value={cliFilter} onChange={e=>setCliFilter(e.target.value)}>
        <option value="all">All Clients</option>
        {clientOptions.map(c=><option key={c.id} value={c.id}>{c.name}{c.city?" — "+c.city:""}</option>)}
      </select>
      {hasFilter && <button onClick={()=>{setDivFilter("all");setCliFilter("all");}} style={{fontSize:10,color:T.red,background:"none",border:`1px solid ${T.red}`,borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit"}}>✕ Clear</button>}
      {hasFilter && <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>Showing {filtered.length} of {db.orders.length} orders</span>}
    </div>

    {/* Upcoming orders alert */}
    {(() => {
      const today = new Date(); today.setHours(0,0,0,0);
      const upcoming = filtered.filter(o => {
        if (["ready-to-bill","closed","invoiced","no-charge","cancelled"].includes(o.status)) return false;
        const pDate = o.pickDate ? new Date(o.pickDate+"T12:00:00") : null;
        if (!pDate) return false;
        const diff = Math.floor((pDate - today) / (1000*60*60*24));
        return diff >= 0 && diff <= 3;
      }).sort((a,b) => new Date(a.pickDate+"T12:00:00") - new Date(b.pickDate+"T12:00:00"));

      if (upcoming.length === 0) return null;
      return <div style={{...sCrd,borderColor:"#f97316",marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:8,color:"#f97316"}}>⚠ Upcoming Pickups (Next 3 Days)</div>
        <DashTable rows={upcoming} cols={["BOL","Division","Client","Ref","Pickup Date","Driver","Status"]} render={o => {
          const pDate = new Date(o.pickDate+"T12:00:00");
          const today2 = new Date(); today2.setHours(0,0,0,0);
          const diff = Math.floor((pDate - today2) / (1000*60*60*24));
          const urgency = diff === 0 ? {bg:"#ef444418",color:"#ef4444",label:"TODAY"} : diff === 1 ? {bg:"#f9731618",color:"#f97316",label:"TOMORROW"} : {bg:"#eab30818",color:"#eab308",label:`In ${diff} days`};
          return <tr key={o.id} style={{cursor:"pointer",background:urgency.bg}} onClick={()=>go("od",o)}>
            <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
            <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
            <td style={{padding:6,fontSize:12}}>{o.cliName||"—"}</td>
            <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
            <td style={{padding:6,fontSize:11}}>{fd(o.pickDate)} <span style={{fontWeight:700,color:urgency.color,fontSize:10}}>{urgency.label}</span></td>
            <td style={{padding:6,fontSize:12}}>{o.drvName||<span style={{color:"#ef4444",fontWeight:600}}>Not assigned</span>}</td>
            <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
          </tr>;
        }}/>
      </div>;
    })()}

    {/* Dashboard view filter — multi-select */}
    <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      <span style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase",marginRight:2}}>Status:</span>
      {[{k:"unassigned",l:"Unassigned",c:"#ef4444"},{k:"assigned",l:"Assigned / In Progress",c:"#f59e0b"},{k:"in-transit",l:"In Transit",c:"#8b5cf6"},{k:"ready-to-bill",l:"Ready to Bill",c:"#f97316"},{k:"closed",l:"Closed",c:"#22c55e"},{k:"no-charge",l:"Closed – No Charge",c:"#14b8a6"}].map(f=>{
        const active = dashFilter.includes(f.k);
        return <button key={f.k} onClick={()=>setDashFilter(prev=>prev.includes(f.k)?prev.filter(x=>x!==f.k):[...prev,f.k])} style={{padding:"4px 10px",borderRadius:5,border:`1px solid ${active?f.c:T.border}`,background:active?`${f.c}22`:"transparent",color:active?f.c:T.muted,fontSize:10,cursor:"pointer",fontWeight:active?600:500,fontFamily:"inherit",transition:"all 0.15s"}}>{f.l}</button>;
      })}
      {dashFilter.length>0 && <button onClick={()=>setDashFilter([])} style={{fontSize:10,color:T.red,background:"none",border:`1px solid ${T.red}`,borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit"}}>✕ Clear</button>}
    </div>

    {showUa && ua.length>0 && <DashSection title="Unassigned BOLs" color="#ef4444" count={ua.length}>
      <SortBar toggle={uaSort.toggle} arrow={uaSort.arrow}/>
      <DashTable rows={uaSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName||"—"}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}

    {showAssigned && assigned.length>0 && <DashSection title="Assigned / In Progress" color="#f59e0b" count={assigned.length}>
      <SortBar toggle={assignedSort.toggle} arrow={assignedSort.arrow}/>
      <DashTable rows={assignedSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Driver","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:12}}>{o.drvName||"—"}</td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}

    {showIt && inTransit.length>0 && <DashSection title="In Transit" color="#8b5cf6" count={inTransit.length}>
      <SortBar toggle={itSort.toggle} arrow={itSort.arrow}/>
      <DashTable rows={itSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Driver","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:12}}>{o.drvName||"—"}</td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}

    {showRtb && readyToBill.length>0 && <DashSection title="Ready to Bill" color="#f97316" count={readyToBill.length}>
      <SortBar toggle={rtbSort.toggle} arrow={rtbSort.arrow}/>
      <DashTable rows={rtbSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Driver","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:12}}>{o.drvName||"—"}</td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}

    {showClosed && closed.length>0 && <DashSection title="Closed" color="#22c55e" count={closed.length}>
      <SortBar toggle={closedSort.toggle} arrow={closedSort.arrow}/>
      <DashTable rows={closedSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Billing","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:11}}>{o.billingType==="no-charge"?<span style={{color:"#14b8a6",fontWeight:600}}>No Charge</span>:o.price?.base?<span style={{color:"#22c55e",fontWeight:600}}>{csym(o.price.cur)}{parseFloat(o.price.base).toFixed(2)} {o.price.cur||"CAD"}</span>:"—"}</td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}

    {showNoCharge && noCharge.length>0 && <DashSection title="Closed – No Charge" color="#14b8a6" count={noCharge.length}>
      <SortBar toggle={noChargeSort.toggle} arrow={noChargeSort.arrow}/>
      <DashTable rows={noChargeSort.sorted} cols={["BOL","Division","Client","Ref","Pickup","Delivery","Billing","Notes","Status"]} render={o => <tr key={o.id} style={{cursor:"pointer",borderBottom:`1px solid ${T.border}`}} onClick={()=>go("od",o)}>
        <td style={{padding:6,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
        <td style={{padding:6,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
        <td style={{padding:6,fontSize:12}}>{o.cliName}</td>
        <td style={{padding:6,fontSize:11}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
        <td style={{padding:6,fontSize:11}}><div>{o.pickCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.pickDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><div>{o.delCo||"—"}</div><div style={{fontSize:11,color:T.text}}>{fd(o.delDate)}</div></td>
        <td style={{padding:6,fontSize:11}}><span style={{color:"#14b8a6",fontWeight:600}}>No Charge</span></td>
        <td style={{padding:6,fontSize:11,fontWeight:600,color:"#f97316"}}>{o.price?.pricingNotes||""}</td>
        <td style={{padding:6}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
      </tr>}/>
    </DashSection>}
  </div>;
}
function DashTable({rows, cols, render}) {
  return <table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{cols.map(c=><th key={c} style={{textAlign:"left",padding:"4px 6px",fontSize:9,fontWeight:600,color:T.muted,textTransform:"uppercase",borderBottom:`1px solid ${T.border}`}}>{c}</th>)}</tr></thead><tbody>{rows.map(render)}</tbody></table>;
}

// ═══ ORDER LIST ═══
function OrderList({orders, q, setQ, flt, setFlt, multiFlts, setMultiFlts, go, newOrd, db, highlightBol}) {
  const [sort, setSort] = useState("bol_desc");
  const toggleFlt = (s) => {
    if (s === "all") { setMultiFlts([]); setFlt("all"); return; }
    setMultiFlts(prev => prev.includes(s) ? prev.filter(x=>x!==s) : [...prev,s]);
  };
  const [divFilter, setDivFilter] = useState("all");
  const [cliFilter, setCliFilter] = useState("all");
  const [evtFilter, setEvtFilter] = useState("all");
  const toggleSort = (key) => setSort(s => s===key+"_asc" ? key+"_desc" : key+"_asc");
  const arrow = (key) => sort.startsWith(key) ? (sort.endsWith("_asc") ? " ↑" : " ↓") : " ↕";

  // Client list from orders
  const clientOptions = [...new Map(orders.map(o=>{const cli=db.clients.find(c2=>c2.id===o.cliId); return [o.cliId,{id:o.cliId,name:o.cliName,city:cli?.city||o.pickCity||""}];})).values()].filter(c=>c.name).sort((a,b)=>a.name.localeCompare(b.name));
  // Event options — from the canonical Events list (db.events)
  const eventOptions = [...(db.events||[])].filter(e=>e.name).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const hasFilter = divFilter!=="all"||cliFilter!=="all"||evtFilter!=="all";

  const sorted = [...orders].filter(o=>{
    if(divFilter!=="all" && o.divId!==divFilter) return false;
    if(cliFilter!=="all" && o.cliId!==cliFilter) return false;
    if(evtFilter!=="all"){ if(o.linkedEventId!==evtFilter && o.linkedEventName!==evtFilter) return false; }
    if(multiFlts.length>0){
      const m=multiFlts.some(f=>{
        if(f==="ready-to-bill") return ["ready-to-bill","pod-received","completed","completed-noinvoice"].includes(o.status);
        if(f==="closed") return o.status==="closed" && o.billingType!=="no-charge";
        if(f==="no-charge") return o.status==="no-charge" || o.billingType==="no-charge";
        return o.status===f;
      });
      if(!m) return false;
    }
    return true;
  }).sort((a,b) => {
    // Always pin highlighted BOL to top
    if(highlightBol) {
      if(a.bol===highlightBol) return -1;
      if(b.bol===highlightBol) return 1;
    }
    const dir = sort.endsWith("_asc") ? 1 : -1;
    const key = sort.replace(/_asc|_desc$/,"");
    if (key==="bol") return dir * ((parseInt(a.bol)||0)-(parseInt(b.bol)||0));
    if (key==="client") return dir * (a.cliName||"").toLowerCase().localeCompare((b.cliName||"").toLowerCase());
    if (key==="pickdate") { const da=a.pickDate?new Date(a.pickDate+"T12:00:00"):new Date(0); const db2=b.pickDate?new Date(b.pickDate+"T12:00:00"):new Date(0); return dir*(da-db2); }
    if (key==="deldate") { const da=a.delDate?new Date(a.delDate+"T12:00:00"):new Date(0); const db2=b.delDate?new Date(b.delDate+"T12:00:00"):new Date(0); return dir*(da-db2); }
    return 0;
  });
  const selStyle = {...sIn, width:"auto", minWidth:140, fontSize:11, padding:"5px 8px"};
  return <div style={{padding:20}}>
    <PageHdr title="Orders / BOL"><button style={bP} onClick={newOrd}><Ic n="plus" s={14}/> New Order</button></PageHdr>
    <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:T.card,border:`1px solid ${T.border}`,borderRadius:6,flex:1,maxWidth:260}}>
        <Ic n="search" s={13}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search..." style={{background:"transparent",border:"none",color:T.text,fontSize:12,outline:"none",width:"100%",fontFamily:"inherit"}}/>
      </div>
      {["all",...STATUSES].map(s=>{const isA=s==="all"?multiFlts.length===0:multiFlts.includes(s);return <button key={s} onClick={()=>toggleFlt(s)} style={{padding:"3px 8px",borderRadius:4,border:`1px solid ${isA?T.red:T.border}`,background:isA?"rgba(220,38,38,0.08)":"transparent",color:isA?T.red:T.muted,fontSize:10,cursor:"pointer",fontWeight:500,fontFamily:"inherit"}}>{S_LABEL[s]||"All"}</button>;})}
    </div>
    <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <span style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase"}}>Filter:</span>
      <select style={selStyle} value={divFilter} onChange={e=>setDivFilter(e.target.value)}>
        <option value="all">All Divisions</option>
        {[...DIVS].sort((a,b)=>(a.short||"").localeCompare(b.short||"")).map(d=><option key={d.id} value={d.id}>{d.short}</option>)}
      </select>
      <select style={selStyle} value={cliFilter} onChange={e=>setCliFilter(e.target.value)}>
        <option value="all">All Clients</option>
        {clientOptions.map(c=><option key={c.id} value={c.id}>{c.name}{c.city?" — "+c.city:""}</option>)}
      </select>
      {eventOptions.length>0 && <select style={selStyle} value={evtFilter} onChange={e=>setEvtFilter(e.target.value)}>
        <option value="all">All Events</option>
        {eventOptions.map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}
      </select>}
      {hasFilter && <button onClick={()=>{setDivFilter("all");setCliFilter("all");setEvtFilter("all");}} style={{fontSize:10,color:T.red,background:"none",border:`1px solid ${T.red}`,borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit"}}>✕ Clear</button>}
      {hasFilter && <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>Showing {sorted.length} orders</span>}
    </div>
    <div style={{...sCrd,padding:0,overflow:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",minWidth:500}}>
        <thead><tr>
          {(()=>{const thS=(key)=>({textAlign:"left",padding:"8px",fontSize:9,fontWeight:600,color:sort.startsWith(key)?T.text:T.muted,textTransform:"uppercase",borderBottom:`1px solid ${T.border}`,cursor:"pointer",userSelect:"none",whiteSpace:"nowrap"});const thPlain={textAlign:"left",padding:"8px",fontSize:9,fontWeight:600,color:T.muted,textTransform:"uppercase",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"};return<>
          <th style={thS("bol")} onClick={()=>toggleSort("bol")}>BOL#{arrow("bol")}</th>
          <th style={thPlain}>Status</th>
          <th style={thPlain}>Division</th>
          <th style={thS("client")} onClick={()=>toggleSort("client")}>Client{arrow("client")}</th>
          <th style={thS("pickdate")} onClick={()=>toggleSort("pickdate")}>Pickup Date{arrow("pickdate")}</th>
          <th style={thS("deldate")} onClick={()=>toggleSort("deldate")}>Delivery Date{arrow("deldate")}</th>
          <th style={thPlain}>Driver</th>
          <th style={thPlain}>Event</th>
          <th style={thPlain}>Ref</th>
          </>})()}
        </tr></thead>
        <tbody>
          {sorted.length===0 && <tr><td colSpan={10} style={{padding:24,textAlign:"center",color:T.dim,fontSize:12}}>No orders found</td></tr>}
          {sorted.map(o=><tr key={o.id} onClick={()=>go("od",o)} style={{cursor:"pointer",borderBottom:`1px solid ${T.hover}`,background:o.bol===highlightBol?"rgba(34,197,94,0.08)":"transparent",outline:o.bol===highlightBol?`1px solid #22c55e`:"none"}}>
            <td style={{padding:8,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
            <td style={{padding:8}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
            <td style={{padding:8,fontSize:11}}>{DIVS.find(d=>d.id===o.divId)?.short||"—"}</td>
            <td style={{padding:8,fontSize:12}}>{o.cliName||"—"}</td>
            <td style={{padding:8,fontSize:11}}>{fd(o.pickDate)||"—"}</td>
            <td style={{padding:8,fontSize:11}}>{fd(o.delDate)||"—"}</td>
            <td style={{padding:8,fontSize:12}}>{o.drvName||"—"}</td>
            <td style={{padding:8,fontSize:11}}>{o.linkedEventName ? <span style={{color:"#8b5cf6",fontWeight:600}}>{o.linkedEventName}</span> : "—"}</td>
            <td style={{padding:8,fontSize:11}}>{o.ref||"—"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

// ═══ ORDER EDIT ═══
function OrderEdit({data, db, savOrd, go}) {
  const [o, setO] = useState({...data.o, items:[...data.o.items.map(i=>({...i}))]});
  const isNew = data.mode==="new";
  const set = (k,v) => setO(p=>({...p,[k]:v}));
  const setItem = (i,k,v) => { const its=[...o.items]; its[i]={...its[i],[k]:v}; setO(p=>({...p,items:its})); };
  // ── Per-stop items + pricing helpers (multi-stop transport — new client model) ──
  const blankStopItem = () => ({pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"});
  const blankStopPrice = () => ({base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[]});
  const setStopField = (which,i,k,v) => setO(p=>{const arr=[...(p[which]||[])]; arr[i]={...arr[i],[k]:v}; return {...p,[which]:arr};});
  const setStopItem = (which,i,j,k,v) => setO(p=>{const arr=[...(p[which]||[])]; const its=[...(arr[i]?.items||[])]; its[j]={...its[j],[k]:v}; arr[i]={...arr[i],items:its}; return {...p,[which]:arr};});
  const addStopItem = (which,i) => setO(p=>{const arr=[...(p[which]||[])]; const its=[...(arr[i]?.items||[]),blankStopItem()]; arr[i]={...arr[i],items:its}; return {...p,[which]:arr};});
  const delStopItem = (which,i,j) => setO(p=>{const arr=[...(p[which]||[])]; const its=(arr[i]?.items||[]).filter((_,x)=>x!==j); arr[i]={...arr[i],items:its}; return {...p,[which]:arr};});
  const setStopPrice = (which,i,k,v) => setO(p=>{const arr=[...(p[which]||[])]; arr[i]={...arr[i],price:{...(arr[i]?.price||blankStopPrice()),[k]:v}}; return {...p,[which]:arr};});
  const setStopPriceOther = (which,i,j,k,v) => setO(p=>{const arr=[...(p[which]||[])]; const pr=arr[i]?.price||blankStopPrice(); const oc=[...(pr.other||[])]; oc[j]={...oc[j],[k]:v}; arr[i]={...arr[i],price:{...pr,other:oc}}; return {...p,[which]:arr};});
  const addStopPriceOther = (which,i) => setO(p=>{const arr=[...(p[which]||[])]; const pr=arr[i]?.price||blankStopPrice(); arr[i]={...arr[i],price:{...pr,other:[...(pr.other||[]),{desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}]}}; return {...p,[which]:arr};});
  const delStopPriceOther = (which,i,j) => setO(p=>{const arr=[...(p[which]||[])]; const pr=arr[i]?.price||blankStopPrice(); arr[i]={...arr[i],price:{...pr,other:(pr.other||[]).filter((_,x)=>x!==j)}}; return {...p,[which]:arr};});
  const calcStopTotal = (price) => {
    const pr = price||{}; const baseAmt=parseFloat(pr.base)||0; const fuelAmt=pr.fuelModel==="liter"?(parseFloat(pr.fuelAmt)||0):(baseAmt*((parseFloat(pr.fuelPct)||0)/100)); const subtotal=baseAmt+fuelAmt;
    const ocCalc=(c)=>{const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {lbase,ltax:lbase*(ltp/100)};};
    const otherBase=(pr.other||[]).reduce((s,c)=>s+ocCalc(c).lbase,0); const otherTax=(pr.other||[]).reduce((s,c)=>s+ocCalc(c).ltax,0);
    const taxPct=pr.taxMode==="CUSTOM"?(parseFloat(pr.taxCustom)||0):pr.taxMode==="HST"?13:pr.taxMode==="GST"?5:0;
    const taxAmt=pr.taxMode==="NONE"||!pr.taxMode?0:subtotal*(taxPct/100);
    return {baseAmt,fuelAmt,otherBase,otherTax,taxAmt,total:subtotal+taxAmt+otherBase+otherTax};
  };
  const sumStopPcs = (stop) => (stop?.items||[]).reduce((s,it)=>s+(parseFloat(it.pcs)||0),0);
  // Inline renderer: per-stop ITEMS table + PRICING panel. `which`="pickStops"|"delStops".
  const renderStopDetail = (which,stop,si) => {
    const items = stop.items||[];
    const nPick=(o.pickStops||[{}]).length, nDel=(o.delStops||[{}]).length;
    // Pricing attaches to the multi side: multi-delivery -> price per delivery; multi-pickup -> price per pickup.
    // Default to delivery side when both are multi.
    const pricingSide = nDel>=nPick ? "delStops" : "pickStops";
    const showPricing = which===pricingSide;
    const st = calcStopTotal(stop.price);
    const sym = csym(o.price?.cur || "CAD");
    return <div style={{marginTop:8,borderTop:`1px dashed ${T.border}`,paddingTop:8}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
        <div style={{fontSize:10,fontWeight:700,color:T.muted}}>ITEMS{items.length>0?` · ${sumStopPcs(stop)} pcs`:""}</div>
        <button style={{...bS,padding:"2px 8px",fontSize:9}} onClick={()=>addStopItem(which,si)}><Ic n="plus" s={9}/> Row</button>
      </div>
      {items.map((it,j)=><div key={j} style={{background:T["bg"],borderRadius:6,padding:8,marginBottom:5,position:"relative"}}>
        <button onClick={()=>delStopItem(which,si,j)} style={{position:"absolute",top:4,right:6,background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:13}}>×</button>
        <div style={{display:"grid",gridTemplateColumns:"56px 1fr",gap:5,marginBottom:5}}>
          <div><label style={{...sLbl,fontSize:8}}>Pces</label><input style={{...sIn,padding:"4px 6px"}} value={it.pcs} onChange={e=>setStopItem(which,si,j,"pcs",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Description</label><input style={{...sIn,padding:"4px 6px"}} value={it.desc} onChange={e=>setStopItem(which,si,j,"desc",e.target.value)}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 70px",gap:5,marginBottom:5}}>
          <div><label style={{...sLbl,fontSize:8}}>Weight</label><input style={{...sIn,padding:"4px 6px"}} value={it.wt} onChange={e=>setStopItem(which,si,j,"wt",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Unit</label><select style={{...sIn,padding:"4px 6px"}} value={it.wUnit||"lbs"} onChange={e=>setStopItem(which,si,j,"wUnit",e.target.value)}><option value="lbs">lbs</option><option value="kg">kg</option></select></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 60px",gap:5}}>
          <div><label style={{...sLbl,fontSize:8}}>L</label><input style={{...sIn,padding:"4px 6px"}} value={it.l} onChange={e=>setStopItem(which,si,j,"l",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>W</label><input style={{...sIn,padding:"4px 6px"}} value={it.w} onChange={e=>setStopItem(which,si,j,"w",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>H</label><input style={{...sIn,padding:"4px 6px"}} value={it.h} onChange={e=>setStopItem(which,si,j,"h",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Unit</label><select style={{...sIn,padding:"4px 6px"}} value={it.dUnit||"in"} onChange={e=>setStopItem(which,si,j,"dUnit",e.target.value)}><option value="in">in</option><option value="cm">cm</option></select></div>
        </div>
      </div>)}
      <div style={{marginTop:6}}>
        <label style={{...sLbl,fontSize:8}}>Stop Notes</label>
        <textarea style={{...sIn,padding:"5px 6px",minHeight:38,resize:"vertical"}} value={stop.notes||""} onChange={e=>setStopField(which,si,"notes",e.target.value)} placeholder="Notes for this stop (appears on BOL)..."/>
      </div>
      {showPricing && (stop.price?.base || (stop.price?.other||[]).some(c=>c.desc||parseFloat(c.unitPrice)>0)) && <div style={{marginTop:8,background:T["bg"],borderRadius:6,padding:8}}>
        <div style={{fontSize:10,fontWeight:700,color:T.muted,marginBottom:4}}>PRICING (read-only — use Edit Pricing to change)</div>
        {(parseFloat(stop.price?.base)||0)>0 && <div style={{fontSize:11,marginBottom:2}}>Base: {sym}{parseFloat(stop.price.base).toFixed(2)}{stop.price.fuelModel==="liter"&&stop.price.liters?` · Fuel: ${stop.price.liters}L = ${sym}${(parseFloat(stop.price.fuelAmt)||0).toFixed(2)}`:stop.price.fuelPct&&parseFloat(stop.price.fuelPct)>0?` · Fuel: ${stop.price.fuelPct}%`:""}</div>}
        {(stop.price?.other||[]).filter(c=>c.desc||parseFloat(c.unitPrice)>0).map((c,k)=><div key={k} style={{fontSize:11,color:T.muted}}>{c.desc}: {sym}{((parseFloat(c.qty)||1)*(parseFloat(c.unitPrice)||0)).toFixed(2)}</div>)}
        {st.total>0 && <div style={{fontSize:12,fontWeight:700,marginTop:4}}>Stop Total: {sym}{st.total.toFixed(2)}</div>}
      </div>}
    </div>;
  };
  // Determine which side holds item detail: the "many" side. Both if both multi.
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [orderType, setOrderType] = useState(data.o.orderType||"transport");

  // Event pricing state
  const ep = o.price||{}; const sep=(k,v)=>setO(p=>({...p,price:{...(p.price||{}),[k]:v}}));
  const [evtLines, setEvtLines] = useState(ep.eventLines||[{id:"1",desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}]);
  const evtTotal = evtLines.reduce((s,l)=>s+(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0),0);
  const selEvt=(i,k,v)=>{const el=[...evtLines];el[i]={...el[i],[k]:v};setEvtLines(el);};

  // Upload files to Firebase Storage
  const addFiles = async (files) => {
    setUploading(true);
    try {
      const newFiles = [...(o.files||[])];
      for (const file of Array.from(files)) {
        const result = await uploadFile(file, `orders/${o.id||"new"}`);
        newFiles.push(result);
      }
      setO(p => ({...p, files: newFiles}));
    } catch(e) { console.error(e); alert("File upload failed"); }
    setUploading(false);
  };

  const removeFile = async (idx) => {
    const file = o.files[idx];
    if (file.path) {
      try { await deleteObject(storageRef(storage, file.path)); } catch {}
    }
    setO(p => ({...p, files: p.files.filter((_,j)=>j!==idx)}));
  };

  const isTransport = orderType === "transport";
  const hasPickup = isTransport ? (o.pickStops||[{co:o.pickCo}]).some(s=>s.co||s.addr) : true;
  const hasDelivery = isTransport ? (o.delStops||[{co:o.delCo}]).some(s=>s.co||s.addr) : true;
  const ok = o.divId && o.cliId && hasPickup && hasDelivery;
  const locs = db.locations || [];
  const pickLoc = id => { const loc=locs.find(l=>l.id===id); if(!loc) return; const addr=[loc.street,loc.city,[loc.provState,loc.postalZip].filter(Boolean).join(" "),loc.country].filter(Boolean).join("\n"); set("pickCo",loc.company||""); set("pickAddr",addr); };
  const delLoc = id => { const loc=locs.find(l=>l.id===id); if(!loc) return; const addr=[loc.street,loc.city,[loc.provState,loc.postalZip].filter(Boolean).join(" "),loc.country].filter(Boolean).join("\n"); set("delCo",loc.company||""); set("delAddr",addr); };

  // ── EVENT/PROJECT SAVE ──
  const saveEvent = async () => {
    if(!o.divId||!o.cliId) { alert("Please select a Division and Client."); return; }
    const filledLines = evtLines.filter(l=>l.desc||parseFloat(l.unitPrice)>0||parseFloat(l.qty)>1);
    const hasPrice = filledLines.some(l=>parseFloat(l.unitPrice)>0) || (parseFloat(o.price?.base)||0)>0;
    const saveData = {
      ...o,
      orderType:"event",
      status: o.status && o.status!=="unassigned" ? o.status : "unassigned",
      price:{
        ...(o.price||{}),
        cur: o.price?.cur||"CAD",
        eventLines: filledLines,
        useEventPricing: true,
        // preserve transport fields exactly as entered — do NOT overwrite base with evtTotal
      },
    };
    await savOrd(saveData);
  };

  // ── EVENT/PROJECT FORM ──
  if(orderType==="event") return <div style={{padding:20,maxWidth:700}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
      <button onClick={()=>go(isNew?"ol":"od",isNew?null:o)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{isNew?`New Project — BOL ${o.bol}`:`Edit BOL ${o.bol}`}</h1>
    </div>

    {/* Order type toggle */}
    <div style={{display:"flex",gap:8,marginBottom:16}}>
      <button onClick={()=>!isNew?null:setOrderType("transport")} style={{flex:1,padding:"10px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:isNew?T.muted:"#475569",fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:isNew?"pointer":"not-allowed",opacity:isNew?1:0.4}} title={isNew?"":"Use the Convert button in the order detail to switch types"}>🚛 Transport Order</button>
      <button style={{flex:1,padding:"10px",borderRadius:8,border:"1px solid #0ea5e9",background:"rgba(14,165,233,0.1)",color:"#0ea5e9",fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>📋 Project</button>
    </div>

    {/* Division & Client */}
    <div style={{...sCrd,border:!ok?`1px solid ${T.red}`:`1px solid ${T.border}`,marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.red}}>DIVISION & CLIENT (required)</div>
      <Field l="Division *"><select style={sIn} value={o.divId} onChange={e=>{const selDiv=DIVS.find(d=>d.id===e.target.value);set("divId",e.target.value);const selCli=db.clients.find(x=>x.id===o.cliId);if(selCli?.preferredCurrency){sep("cur",selCli.preferredCurrency);}else{sep("cur",(/USA|U\.S|LLC|USD/i.test(selDiv?.name||""))?"USD":"CAD");}}}><option value="">Select division...</option>{[...DIVS].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field l="Client *"><SearchSelect options={[...db.clients].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(c=>({value:c.id,label:`${c.name||"(no name)"}${c.preferredCurrency?` (${c.preferredCurrency})`:""}`,sub:c.city}))} value={o.cliId} emptyLabel="Select client..." placeholder="Type client name or city..." onChange={id=>{
        const c=db.clients.find(x=>x.id===id);
        set("cliId",id); set("cliName",c?.name||"");
        if(c?.name) set("billTo",c.name);
        if(c?.preferredCurrency) sep("cur",c.preferredCurrency);
      }} /></Field>
      <Field l="Assign to Event (optional)"><select style={sIn} value={o.linkedEventId||""} onChange={e=>{const ev=(db.events||[]).find(x=>x.id===e.target.value);set("linkedEventId",e.target.value||"");set("linkedEventName",ev?.name||"");}}><option value="">— No event —</option>{[...(db.events||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}</select></Field>
      <div style={{marginTop:4,marginBottom:2}}>
        <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <input type="checkbox" checked={!!o.poRequired} onChange={e=>set("poRequired",e.target.checked)} style={{accentColor:T.red,width:14,height:14}}/>
          <span style={{fontSize:12,fontWeight:600,color:"#f97316"}}>PO Required before invoicing</span>
        </label>
      </div>
      {o.poRequired && <Field l="PO Number">
        <input style={{...sIn,borderColor:o.poRequired&&!o.poNumber?"#f97316":T.border}} value={o.poNumber||""} onChange={e=>set("poNumber",e.target.value)} placeholder="Enter PO #"/>
      </Field>}
    </div>

    {/* Project Info */}
    <div style={{...sCrd,marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.muted}}>PROJECT INFO</div>
      <Field l="Project Name *"><input style={sIn} value={o.eventName||""} onChange={e=>set("eventName",e.target.value)} placeholder="e.g. Miami Grand Prix 2026"/></Field>
      <Field l="Reference #"><input style={sIn} value={o.ref||""} onChange={e=>set("ref",e.target.value)}/></Field>
      <Field l="Bill To"><input style={sIn} value={o.billTo||""} onChange={e=>set("billTo",e.target.value)}/></Field>
      <Field l="Date"><DatePicker value={o.reqDate||""} onChange={v=>set("reqDate",v)} placeholder="Select date..."/></Field>
      <Field l="Location (optional)"><select style={sIn} value={o.locId||""} onChange={e=>{
        const loc=(db.locations||[]).find(l=>l.id===e.target.value);
        set("locId",e.target.value||"");
        if(loc){
          set("pickCo",loc.company||"");
          set("pickAddr",[loc.street,loc.city,loc.provState,loc.postalZip,loc.country].filter(Boolean).join(", "));
        } else {
          set("pickCo","");
          set("pickAddr","");
        }
      }}>
        <option value="">— No location —</option>
        {[...(db.locations||[])].sort((a,b)=>(a.company||"").localeCompare(b.company||"")).map(loc=><option key={loc.id} value={loc.id}>{loc.company}{loc.city?` — ${loc.city}`:""}</option>)}
      </select></Field>
      <Field l="Notes"><textarea style={{...sIn,minHeight:70,resize:"vertical"}} value={o.notes||""} onChange={e=>set("notes",e.target.value)} placeholder="Project details, scope of work..."/></Field>
    </div>

    {/* Pricing */}
    <div style={{...sCrd,marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:12,color:T.muted}}>PRICING</div>

      <Field l="Currency"><select style={{...sIn,maxWidth:180}} value={o.price?.cur||"CAD"} onChange={e=>sep("cur",e.target.value)}>{CURRS.map(c=><option key={c.v} value={c.v}>{c.v} ({c.s})</option>)}</select></Field>

      {/* Transport Charge */}
      <div style={{marginTop:10,padding:"12px",background:"rgba(220,38,38,0.04)",borderRadius:8,border:`1px solid ${T.border}`}}>
        <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Transport Charge <span style={{fontSize:9,fontWeight:400,color:T.dim,textTransform:"none"}}>(leave empty if no transport charge)</span></div>
        <Field l={`Base Price (${csym(o.price?.cur||"CAD")})`}>
          <input style={sIn} type="number" step="0.01" value={o.price?.base||""} onChange={e=>sep("base",e.target.value)} placeholder="Leave empty if no transport charge"/>
        </Field>
        {(parseFloat(o.price?.base)||0)>0 && <>
          <Field l="Transport Description">
            <input style={sIn} value={o.price?.transDesc||""} onChange={e=>sep("transDesc",e.target.value)} placeholder="e.g. 10 trucks × $1,000 — Montreal to Toronto"/>
          </Field>
          <Field l="Fuel Surcharge (%)">
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <input style={{...sIn,maxWidth:100}} type="number" step="0.1" value={o.price?.fuelPct||""} onChange={e=>sep("fuelPct",e.target.value)} placeholder="0"/>
              <span style={{fontSize:11,color:T.muted}}>%</span>
              {(parseFloat(o.price?.base)||0)*(parseFloat(o.price?.fuelPct)||0)/100>0 &&
                <span style={{fontSize:11,color:T.text}}>= {csym(o.price?.cur||"CAD")}{((parseFloat(o.price?.base)||0)*(parseFloat(o.price?.fuelPct)||0)/100).toFixed(2)}</span>}
            </div>
          </Field>
          <Field l="Tax (if applicable)">
            <select style={sIn} value={o.price?.taxMode||"NONE"} onChange={e=>sep("taxMode",e.target.value)}>
              {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
            </select>
          </Field>
          {o.price?.taxMode==="CUSTOM" && <Field l="Custom Tax (%)"><input style={{...sIn,maxWidth:120}} type="number" step="0.01" value={o.price?.taxCustom||""} onChange={e=>sep("taxCustom",e.target.value)} placeholder="e.g. 20"/></Field>}
          {(()=>{
            const sym=csym(o.price?.cur||"CAD");
            const base=parseFloat(o.price?.base)||0;
            const fuel=base*(parseFloat(o.price?.fuelPct)||0)/100;
            const tp=o.price?.taxMode==="HST"?13:o.price?.taxMode==="GST"?5:o.price?.taxMode==="CUSTOM"?(parseFloat(o.price?.taxCustom)||0):0;
            const tax=(base+fuel)*(tp/100);
            const tot=base+fuel+tax;
            return <div style={{borderTop:`1px solid ${T.border}`,marginTop:8,paddingTop:8}}>
              {tax>0&&<div style={{fontSize:11,color:T.muted,marginBottom:2}}>Base: {sym}{base.toFixed(2)}{fuel>0?` + Fuel: ${sym}${fuel.toFixed(2)}`:""} + Tax ({tp}%): {sym}{tax.toFixed(2)}</div>}
              <div style={{fontSize:15,fontWeight:700}}>{sym}{tot.toFixed(2)} <span style={{fontSize:11,color:T.muted}}>{o.price?.cur||"CAD"}</span>{tax>0&&<span style={{fontSize:10,color:T.muted,marginLeft:4}}>(incl. tax)</span>}</div>
            </div>;
          })()}
        </>}
      </div>

      {/* Additional Charges */}
      <div style={{marginTop:12}}>
        <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Additional Charges</div>
        <div style={{fontSize:11,color:T.muted,marginBottom:8}}>Ground crew, supervisors, other services — each line can have its own tax.</div>

        {/* Column headers */}
        <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:4}}>
          {["Description","Qty","Unit Price","Tax","Total",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=1&&i<=4?"right":"left"}}>{h}</div>)}
        </div>

        {evtLines.map((line,idx)=>{
          const sym=csym(o.price?.cur||"CAD");
          const ltp=line.taxMode==="HST"?13:line.taxMode==="GST"?5:line.taxMode==="CUSTOM"?(parseFloat(line.taxCustom)||0):0;
          const lbase=(parseFloat(line.qty)||0)*(parseFloat(line.unitPrice)||0);
          const ltax=lbase*(ltp/100);
          const ltot=lbase+ltax;
          return <div key={line.id||idx} style={{marginBottom:6}}>
            <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,alignItems:"center"}}>
              <input style={sIn} value={line.desc} onChange={e=>selEvt(idx,"desc",e.target.value)} placeholder="Description..."/>
              <input style={{...sIn,textAlign:"right"}} type="number" value={line.qty} onChange={e=>selEvt(idx,"qty",e.target.value)} placeholder="1"/>
              <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={line.unitPrice} onChange={e=>selEvt(idx,"unitPrice",e.target.value)} placeholder="0.00"/>
              <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={line.taxMode||"NONE"} onChange={e=>selEvt(idx,"taxMode",e.target.value)}>
                {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
              </select>
              <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:ltot>0?"#22c55e":T.dim}}>{sym}{ltot.toFixed(2)}</div>
              <button onClick={()=>setEvtLines(evtLines.filter((_,j)=>j!==idx))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
            </div>
            {ltax>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:30}}>Tax ({ltp}%): {sym}{ltax.toFixed(2)} · Base: {sym}{lbase.toFixed(2)}</div>}
          </div>;
        })}

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
          <button style={{...bS,padding:"4px 10px",fontSize:11}} onClick={()=>setEvtLines([...evtLines,{id:Date.now().toString(),desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}])}><Ic n="plus" s={10}/> Add Line</button>
          {(()=>{
            const sym=csym(o.price?.cur||"CAD");
            const addlTotal=evtLines.reduce((s,l)=>{
              const ltp=l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
              const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
              return s+lb+lb*(ltp/100);
            },0);
            const base=parseFloat(o.price?.base)||0;
            const fuel=base*(parseFloat(o.price?.fuelPct)||0)/100;
            const tp=o.price?.taxMode==="HST"?13:o.price?.taxMode==="GST"?5:o.price?.taxMode==="CUSTOM"?(parseFloat(o.price?.taxCustom)||0):0;
            const tax=(base+fuel)*(tp/100);
            const transport=base+fuel+tax;
            const grand=transport+addlTotal;
            return <div style={{textAlign:"right"}}>
              {addlTotal>0&&<div style={{fontSize:11,color:T.muted}}>Additional: {sym}{addlTotal.toFixed(2)}</div>}
              <div style={{fontSize:14,fontWeight:700,color:"#0ea5e9"}}>Grand Total: {sym}{grand.toFixed(2)} {o.price?.cur||"CAD"}</div>
            </div>;
          })()}
        </div>
      </div>
    </div>

    {/* Attachments */}
    <div style={{...sCrd,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.muted}}>ATTACHMENTS</div>
      <DropZone label="Files" uploading={uploading} fileRef={fileRef} onFiles={addFiles}/>
      {(o.files||[]).map((f,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:T.surface,borderRadius:6,marginBottom:4,marginTop:4}}>
        <Ic n="file" s={12}/><span style={{fontSize:11,flex:1,color:T.text}}>{f.name}</span>
        <button onClick={()=>removeFile(i)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:13}}>×</button>
      </div>)}
    </div>

    <div style={{display:"flex",gap:8}}>
      <button style={{...sBtn,background:"#0ea5e9"}} onClick={saveEvent}><Ic n="check" s={13}/> Save</button>
      <button style={bS} onClick={()=>go(isNew?"ol":"od",isNew?null:o)}>Cancel</button>
    </div>
  </div>;

  return <div style={{padding:20,maxWidth:700}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
      <button onClick={()=>go(isNew?"ol":"od",isNew?null:o)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{isNew?`New Order — BOL ${o.bol}`:`Edit BOL ${o.bol}`}</h1>
    </div>

    {/* Order type toggle */}
    {isNew && <div style={{display:"flex",gap:8,marginBottom:16}}>
      <button style={{flex:1,padding:"10px",borderRadius:8,border:"1px solid #0ea5e9",background:"rgba(14,165,233,0.1)",color:"#0ea5e9",fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>🚛 Transport Order</button>
      <button onClick={()=>setOrderType("event")} style={{flex:1,padding:"10px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>📋 Project</button>
    </div>}

    {/* Division & Client */}
    <div style={{...sCrd, border:!ok?`1px solid ${T.red}`:`1px solid ${T.border}`}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.red}}>DIVISION & CLIENT (required)</div>
      <Field l="Division *"><select style={sIn} value={o.divId} onChange={e=>{const selDiv=DIVS.find(d=>d.id===e.target.value);set("divId",e.target.value);const selCli=db.clients.find(x=>x.id===o.cliId);if(selCli?.preferredCurrency){sep("cur",selCli.preferredCurrency);}else{sep("cur",(/USA|U\.S|LLC|USD/i.test(selDiv?.name||""))?"USD":"CAD");}}}><option value="">Select division...</option>{[...DIVS].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field l="Client *"><SearchSelect options={[...db.clients].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(c=>({value:c.id,label:`${c.name||"(no name)"}${c.preferredCurrency?` (${c.preferredCurrency})`:""}`,sub:c.city}))} value={o.cliId} emptyLabel="Select client..." placeholder="Type client name or city..." onChange={id=>{
        const c=db.clients.find(x=>x.id===id);
        set("cliId",id); set("cliName",c?.name||"");
        if(c?.name) set("billTo",c.name);
        if(c?.preferredCurrency) sep("cur",c.preferredCurrency);
      }} /></Field>
      <Field l="Assign to Event (optional)"><select style={sIn} value={o.linkedEventId||""} onChange={e=>{const ev=(db.events||[]).find(x=>x.id===e.target.value);set("linkedEventId",e.target.value||"");set("linkedEventName",ev?.name||"");}}><option value="">— No event —</option>{[...(db.events||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}</select></Field>
      <div style={{marginTop:4,marginBottom:2}}>
        <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <input type="checkbox" checked={!!o.poRequired} onChange={e=>set("poRequired",e.target.checked)} style={{accentColor:T.red,width:14,height:14}}/>
          <span style={{fontSize:12,fontWeight:600,color:"#f97316"}}>PO Required before invoicing</span>
        </label>
      </div>
      {o.poRequired && <Field l="PO Number">
        <input style={{...sIn,borderColor:o.poRequired&&!o.poNumber?"#f97316":T.border}} value={o.poNumber||""} onChange={e=>set("poNumber",e.target.value)} placeholder="Enter PO # (required before invoicing)"/>
        {o.poRequired && !o.poNumber && <div style={{fontSize:10,color:"#f97316",marginTop:3}}>⚠ PO # needed before you can complete & invoice</div>}
      </Field>}
    </div>

    {/* Shipment Info */}
    <div style={sCrd}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.muted}}>SHIPMENT INFO</div>
      <Field l="Bill To"><input style={sIn} value={o.billTo} onChange={e=>set("billTo",e.target.value)}/></Field>
      <Field l="Reference #"><input style={sIn} value={o.ref} onChange={e=>set("ref",e.target.value)}/></Field>
      <Field l="Request Date"><DatePicker value={o.reqDate} onChange={v=>set("reqDate",v)} placeholder="Select request date..."/></Field>
    </div>

    {/* Customs — PAPS/PARS */}
    <div style={sCrd}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.muted}}>CUSTOMS</div>
      <Field l="Customs Type"><select style={sIn} value={o.customsType||""} onChange={e=>{
        set("customsType",e.target.value);
        if(!e.target.value){set("stickerId","");set("stickerNum","");}
      }}><option value="">None</option><option value="PAPS">PAPS — USA bound</option><option value="PARS">PARS — Canada bound</option></select></Field>
      {o.customsType && (() => {
        const avail = (db.stickers||[]).filter(s=>s.type===o.customsType && (s.status==="available" || s.id===o.stickerId)).sort((a,b)=>a.seq-b.seq);
        return <Field l={`${o.customsType} Sticker Number`}>
          <select style={sIn} value={o.stickerId||""} onChange={e=>{
            const st=(db.stickers||[]).find(s=>s.id===e.target.value);
            set("stickerId",e.target.value);
            set("stickerNum",st?.fullNum||"");
          }}>
            <option value="">Select available {o.customsType}...</option>
            {avail.map(s=><option key={s.id} value={s.id}>{s.fullNum}</option>)}
          </select>
          {o.stickerNum && <div style={{marginTop:4,fontSize:11,color:"#22c55e",fontFamily:"'IBM Plex Mono'"}}>{o.stickerNum}</div>}
          {avail.length===0 && <div style={{marginTop:4,fontSize:10,color:T.red}}>No available {o.customsType} stickers. Add more in PAPS/PARS inventory.</div>}
        </Field>;
      })()}
    </div>

    {/* Pickup Stops */}
    {(o.pickStops||[{co:o.pickCo||"",addr:o.pickAddr||"",date:o.pickDate||""}]).map((stop,si)=><div key={si} style={sCrd}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:600,color:T.muted}}>{(o.pickStops||[]).length>1||si>0?`PICK UP — STOP ${si+1}`:"PICK UP"}</div>
        {si>0 && <button onClick={()=>setO(p=>({...p,pickStops:p.pickStops.filter((_,j)=>j!==si)}))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:700}}>✕ Remove</button>}
      </div>
      {locs.length>0 && <Field l="Quick Select"><SearchSelect options={[...locs].sort((a,b)=>(a.company||"").localeCompare(b.company||"")).map(l=>({value:l.id,label:`${l.company||"(no name)"}${l.distanceKm?` (${l.distanceKm}km)`:""}`,sub:l.city}))} value="" emptyLabel="Search saved locations..." placeholder="Type name, city or number..." onChange={id=>{const l=locs.find(x=>x.id===id);if(!l)return;const stops=[...(o.pickStops||[{co:o.pickCo||"",addr:o.pickAddr||"",date:o.pickDate||""}])];const curPrice=stops[si]?.price||{};stops[si]={...stops[si],co:l.company||"",addr:[l.street,l.city,l.provState,l.postalZip,l.country].filter(Boolean).join("\n"),contact:l.contact||stops[si]?.contact||"",phone:l.phone||stops[si]?.phone||"",notes:l.notes||stops[si]?.notes||"",price:{...curPrice,km:l.distanceKm||curPrice.km||""}};setO(p=>({...p,pickStops:stops}));}} /></Field>}
      <Field l="Company Name"><input style={sIn} value={stop.co||""} onChange={e=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],co:e.target.value};setO(p=>({...p,pickStops:stops}))}}/></Field>
      <Field l="Address"><textarea style={{...sIn,resize:"vertical"}} rows={3} value={stop.addr||""} onChange={e=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],addr:e.target.value};setO(p=>({...p,pickStops:stops}))}}/></Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <Field l="Contact Person"><input style={sIn} value={stop.contact||""} placeholder="Name..." onChange={e=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],contact:e.target.value};setO(p=>({...p,pickStops:stops}))}}/></Field>
        <Field l="Phone"><input style={sIn} value={stop.phone||""} placeholder="Phone..." onChange={e=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],phone:e.target.value};setO(p=>({...p,pickStops:stops}))}}/></Field>
      </div>
      <Field l="Stop Notes / Requirements"><textarea style={{...sIn,resize:"vertical",minHeight:52}} rows={2} value={stop.notes||""} placeholder="Business hours, access requirements, special instructions..." onChange={e=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],notes:e.target.value};setO(p=>({...p,pickStops:stops}))}}/></Field>
      <Field l="Pickup Date"><DatePicker value={stop.date||""} onChange={v=>{const stops=[...(o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}])];stops[si]={...stops[si],date:v};setO(p=>({...p,pickStops:stops}))}}/></Field>
      {(() => {
        const nPick=(o.pickStops||[{}]).length, nDel=(o.delStops||[{}]).length;
        const isMulti = nPick>1 || nDel>1;
        if(!isMulti) return null; // single pickup + single delivery -> old order-level items table is used instead
        // Pickups hold item detail when they are the multi side
        if(nPick>1) return renderStopDetail("pickStops",stop,si);
        // Single pickup feeding multiple deliveries -> auto-sum the delivery portions
        const totalPcs=(o.delStops||[]).reduce((s,ds)=>s+sumStopPcs(ds),0);
        return totalPcs>0 ? <div style={{marginTop:8,borderTop:`1px dashed ${T.border}`,paddingTop:8,fontSize:11,color:T.muted}}>Auto-total loaded: <b style={{color:T.text}}>{totalPcs} pcs</b> <span style={{fontSize:9}}>(sum of all delivery stops)</span></div> : null;
      })()}
    </div>)}
    <button onClick={()=>setO(p=>({...p,pickStops:[...(p.pickStops||[{co:p.pickCo||"",addr:p.pickAddr||"",date:p.pickDate||""}]),{co:"",addr:"",date:""}]}))} style={{...bS,width:"100%",textAlign:"center",marginBottom:8}}>+ Add Pickup Stop</button>

    {/* Delivery Stops */}
    {(o.delStops||[{co:o.delCo||"",addr:o.delAddr||"",date:o.delDate||""}]).map((stop,si)=><div key={si} style={sCrd}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:600,color:T.muted}}>{(o.delStops||[]).length>1||si>0?`DELIVERY — STOP ${si+1}`:"DELIVERY"}</div>
        {si>0 && <button onClick={()=>setO(p=>({...p,delStops:p.delStops.filter((_,j)=>j!==si)}))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:700}}>✕ Remove</button>}
      </div>
      {locs.length>0 && <Field l="Quick Select"><SearchSelect options={[...locs].sort((a,b)=>(a.company||"").localeCompare(b.company||"")).map(l=>({value:l.id,label:`${l.company||"(no name)"}${l.distanceKm?` (${l.distanceKm}km)`:""}`,sub:l.city}))} value="" emptyLabel="Search saved locations..." placeholder="Type name, city or number..." onChange={id=>{const l=locs.find(x=>x.id===id);if(!l)return;const stops=[...(o.delStops||[{co:o.delCo||"",addr:o.delAddr||"",date:o.delDate||""}])];const curPrice=stops[si]?.price||{};stops[si]={...stops[si],co:l.company||"",addr:[l.street,l.city,l.provState,l.postalZip,l.country].filter(Boolean).join("\n"),contact:l.contact||stops[si]?.contact||"",phone:l.phone||stops[si]?.phone||"",notes:l.notes||stops[si]?.notes||"",price:{...curPrice,km:l.distanceKm||curPrice.km||""}};setO(p=>({...p,delStops:stops}));}} /></Field>}
      <Field l="Company Name"><input style={sIn} value={stop.co||""} onChange={e=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],co:e.target.value};setO(p=>({...p,delStops:stops}))}}/></Field>
      <Field l="Address"><textarea style={{...sIn,resize:"vertical"}} rows={3} value={stop.addr||""} onChange={e=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],addr:e.target.value};setO(p=>({...p,delStops:stops}))}}/></Field>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <Field l="Contact Person"><input style={sIn} value={stop.contact||""} placeholder="Name..." onChange={e=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],contact:e.target.value};setO(p=>({...p,delStops:stops}))}}/></Field>
        <Field l="Phone"><input style={sIn} value={stop.phone||""} placeholder="Phone..." onChange={e=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],phone:e.target.value};setO(p=>({...p,delStops:stops}))}}/></Field>
      </div>
      <Field l="Stop Notes / Requirements"><textarea style={{...sIn,resize:"vertical",minHeight:52}} rows={2} value={stop.notes||""} placeholder="Business hours, access requirements, special instructions..." onChange={e=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],notes:e.target.value};setO(p=>({...p,delStops:stops}))}}/></Field>
      <Field l="Delivery Date"><DatePicker value={stop.date||""} onChange={v=>{const stops=[...(o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}])];stops[si]={...stops[si],date:v};setO(p=>({...p,delStops:stops}))}}/></Field>
      {(() => {
        const nPick=(o.pickStops||[{}]).length, nDel=(o.delStops||[{}]).length;
        const isMulti = nPick>1 || nDel>1;
        if(!isMulti) return null; // single pickup + single delivery -> old order-level items table is used instead
        if(nDel>1) return renderStopDetail("delStops",stop,si);
        // Single delivery receiving from multiple pickups -> auto-sum the pickup portions
        const totalPcs=(o.pickStops||[]).reduce((s,ps)=>s+sumStopPcs(ps),0);
        return totalPcs>0 ? <div style={{marginTop:8,borderTop:`1px dashed ${T.border}`,paddingTop:8,fontSize:11,color:T.muted}}>Auto-total received: <b style={{color:T.text}}>{totalPcs} pcs</b> <span style={{fontSize:9}}>(sum of all pickup stops)</span></div> : null;
      })()}
    </div>)}

    {/* Items — LEGACY order-level table. Only shown for old orders that already have order-level items
        and no per-stop items yet. New multi-stop orders use per-stop items inside each stop block. */}
    {(() => {
      const nPick=(o.pickStops||[{}]).length, nDel=(o.delStops||[{}]).length;
      const isMulti = nPick>1 || nDel>1;
      if(isMulti) return null; // multi-stop -> items are entered per-stop instead
      return <div style={sCrd}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:600,color:T.muted}}>ITEMS</div>
        <button style={{...bS,padding:"3px 8px",fontSize:10}} onClick={()=>setO(p=>({...p,items:[...p.items,{pcs:"",desc:"",wt:"",wUnit:o.items[0]?.wUnit||"lbs",l:"",w:"",h:"",dUnit:o.items[0]?.dUnit||"in"}]}))}><Ic n="plus" s={10}/> Row</button>
      </div>
      {o.items.map((it,i) => <div key={i} style={{background:T["bg"],borderRadius:8,padding:10,marginBottom:6,position:"relative"}}>
        <button onClick={()=>setO(p=>({...p,items:p.items.filter((_,j)=>j!==i)}))} style={{position:"absolute",top:6,right:8,background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14}}>×</button>
        <div style={{display:"grid",gridTemplateColumns:"60px 1fr",gap:6,marginBottom:6}}>
          <div><label style={{...sLbl,fontSize:8}}>Pces</label><input style={{...sIn,padding:"5px 6px"}} value={it.pcs} onChange={e=>setItem(i,"pcs",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Description</label><input style={{...sIn,padding:"5px 6px"}} value={it.desc} onChange={e=>setItem(i,"desc",e.target.value)}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:6,marginBottom:6}}>
          <div><label style={{...sLbl,fontSize:8}}>Weight</label><input style={{...sIn,padding:"5px 6px"}} value={it.wt} onChange={e=>setItem(i,"wt",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Unit</label><select style={{...sIn,padding:"5px 6px"}} value={it.wUnit||"lbs"} onChange={e=>setItem(i,"wUnit",e.target.value)}><option value="lbs">lbs</option><option value="kg">kg</option></select></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 70px",gap:6}}>
          <div><label style={{...sLbl,fontSize:8}}>L</label><input style={{...sIn,padding:"5px 6px"}} value={it.l} onChange={e=>setItem(i,"l",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>W</label><input style={{...sIn,padding:"5px 6px"}} value={it.w} onChange={e=>setItem(i,"w",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>H</label><input style={{...sIn,padding:"5px 6px"}} value={it.h} onChange={e=>setItem(i,"h",e.target.value)}/></div>
          <div><label style={{...sLbl,fontSize:8}}>Unit</label><select style={{...sIn,padding:"5px 6px"}} value={it.dUnit||"in"} onChange={e=>setItem(i,"dUnit",e.target.value)}><option value="in">in</option><option value="cm">cm</option></select></div>
        </div>
      </div>)}
    </div>;
    })()}

    {/* + Add Delivery Stop — placed here so it appears below the items section */}
    <button onClick={()=>setO(p=>({...p,delStops:[...(p.delStops||[{co:p.delCo||"",addr:p.delAddr||"",date:p.delDate||""}]),{co:"",addr:"",date:"",items:[blankStopItem()]}]}))} style={{...bS,width:"100%",textAlign:"center",marginBottom:8}}>+ Add Delivery Stop</button>

    {/* Order grand total bar — sum of all stop totals on the pricing (multi) side */}
    {(() => {
      const nPick=(o.pickStops||[{}]).length, nDel=(o.delStops||[{}]).length;
      const isMulti = nPick>1 || nDel>1;
      if(!isMulti) return null;
      const pricingSide = nDel>=nPick ? "delStops" : "pickStops";
      const stops = o[pricingSide]||[];
      const grand = stops.reduce((s,st)=>s+calcStopTotal(st.price).total,0);
      const anyStopPricing = stops.some(st=>st.price && (parseFloat(st.price.base)>0 || (st.price.other||[]).some(c=>parseFloat(c.unitPrice)>0)));
      if(!anyStopPricing) return null;
      const sym=csym(o.price?.cur||"CAD");
      const label = pricingSide==="delStops" ? "Delivery Stop" : "Pickup Stop";
      return <div style={{...sCrd,borderColor:"#0ea5e9"}}>
        <div style={{fontSize:11,fontWeight:600,color:T.muted,marginBottom:6}}>ORDER TOTAL (all stops)</div>
        {stops.map((st,i)=>{const t=calcStopTotal(st.price).total; return t>0?<div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}><span style={{color:T.muted}}>{st.co||`${label} ${i+1}`}</span><span>{sym}{t.toFixed(2)}</span></div>:null;})}
        <div style={{borderTop:`1px solid ${T.border}`,marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:700}}><span>Grand Total</span><span style={{color:"#0ea5e9"}}>{sym}{grand.toFixed(2)} {o.price?.cur||"CAD"}</span></div>
      </div>;
    })()}

    {/* Pricing (optional — collapsible) — only for NEW orders in single-stop mode; existing orders use Edit Pricing button */}
    {isNew && !((o.pickStops||[{}]).length>1 || (o.delStops||[{}]).length>1) &&
    <div style={sCrd}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}} onClick={()=>set("_showPrice",!o._showPrice)}>
        <div style={{fontSize:11,fontWeight:600,color:T.muted}}>PRICING / NOTES (INTERNAL ONLY)</div>
        <span style={{fontSize:12,color:T.muted}}>{o._showPrice?"▾":"▸"}</span>
      </div>
      {(o._showPrice || (o.price && (parseFloat(o.price?.base)>0 || o.price?.pricingNotes))) && (() => {
        const dp = {cur:"CAD",base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[{desc:"",amt:""}]};
        const pr = {...dp,...(o.price||{}), other:[...(o.price?.other||[{desc:"",amt:""}])]};
        const spr = (k,v) => set("price",{...pr,[k]:v});
        const socp = (i,k,v) => { const oc=[...pr.other]; oc[i]={...oc[i],[k]:v}; spr("other",oc); };
        const sym = csym(pr.cur);
        const baseAmt = parseFloat(pr.base)||0;
        const fuelPct = parseFloat(pr.fuelPct)||0;
        const fuelAmt = baseAmt * (fuelPct/100);
        const subtotal = baseAmt + fuelAmt;
        const ocCalcI=(c)=>{const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {ltp,lbase,ltax:lbase*(ltp/100),ltot:lbase+lbase*(ltp/100)};};
        const otherBaseI = pr.other.reduce((s,c)=>s+ocCalcI(c).lbase,0);
        const otherTaxI = pr.other.reduce((s,c)=>s+ocCalcI(c).ltax,0);
        const otherTotal = otherBaseI + otherTaxI;
        const tm = TAX_MODES.find(t=>t.k===pr.taxMode)||TAX_MODES[0];
        const taxPct = pr.taxMode==="CUSTOM"?(parseFloat(pr.taxCustom)||0):tm.pct;
        const taxAmt = pr.taxMode==="NONE"?0:subtotal*(taxPct/100);
        const total = subtotal + taxAmt + otherTotal;
        return <div style={{marginTop:10}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            <Field l="Currency"><select style={sIn} value={pr.cur} onChange={e=>spr("cur",e.target.value)}>{CURRS.map(c=><option key={c.v} value={c.v}>{c.v} ({c.s})</option>)}</select></Field>
          </div>
          <div style={{padding:"12px",background:"rgba(220,38,38,0.04)",borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Transport Charge</div>
            <Field l={`Base Price (${sym})`}><input style={sIn} type="number" step="0.01" value={pr.base} onChange={e=>spr("base",e.target.value)} placeholder="0.00"/></Field>
            {baseAmt>0 && <>
              <Field l="Transport Description"><input style={sIn} value={pr.transDesc||""} onChange={e=>spr("transDesc",e.target.value)} placeholder="e.g. 10 trucks × $1,000 — Montreal to Toronto"/></Field>
              <Field l="Fuel Surcharge (%)">
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <input style={{...sIn,maxWidth:100}} type="number" step="0.1" value={pr.fuelPct} onChange={e=>spr("fuelPct",e.target.value)} placeholder="0"/>
                  <span style={{fontSize:11,color:T.muted}}>%</span>
                  {fuelAmt>0 && <span style={{fontSize:11,color:T.text}}>= {sym}{fuelAmt.toFixed(2)}</span>}
                </div>
              </Field>
            </>}
          </div>
          <div style={{marginTop:12}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:4}}>
              <label style={sLbl}>Accessorial Charges</label>
              <button style={{...bS,padding:"2px 6px",fontSize:9}} onClick={()=>spr("other",[...pr.other,{desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}])}><Ic n="plus" s={9}/> Add</button>
            </div>
            <div style={{fontSize:11,color:T.muted,marginBottom:6}}>Extra services — each line can have its own tax.</div>
            {pr.other.length>0 && <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:4}}>
              {["Description","Qty","Unit Price","Tax","Total",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=1&&i<=4?"right":"left"}}>{h}</div>)}
            </div>}
            {pr.other.map((oc,i)=>{
              const ltp=oc.taxMode==="HST"?13:oc.taxMode==="GST"?5:oc.taxMode==="CUSTOM"?(parseFloat(oc.taxCustom)||0):0;
              const lbase=(oc.qty!==undefined||oc.unitPrice!==undefined)?(parseFloat(oc.qty)||0)*(parseFloat(oc.unitPrice)||0):(parseFloat(oc.amt)||0);
              const ltax=lbase*(ltp/100); const ltot=lbase+ltax;
              return <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:3,alignItems:"center"}}>
              <input style={{...sIn,padding:"5px 8px"}} placeholder="Description" value={oc.desc} onChange={e=>socp(i,"desc",e.target.value)}/>
              <input style={{...sIn,padding:"5px 6px",textAlign:"right"}} type="number" placeholder="1" value={oc.qty!==undefined?oc.qty:""} onChange={e=>socp(i,"qty",e.target.value)}/>
              <input style={{...sIn,padding:"5px 6px",textAlign:"right"}} type="number" step="0.01" placeholder="0.00" value={oc.unitPrice!==undefined?oc.unitPrice:(oc.amt||"")} onChange={e=>socp(i,"unitPrice",e.target.value)}/>
              <select style={{...sIn,padding:"5px 4px",fontSize:10}} value={oc.taxMode||"NONE"} onChange={e=>socp(i,"taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select>
              <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:ltot>0?"#22c55e":T.dim}}>{sym}{ltot.toFixed(2)}</div>
              <button onClick={()=>spr("other",pr.other.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14}}>×</button>
            </div>;})}
            <button style={{...bS,padding:"4px 10px",fontSize:11,marginTop:4}} onClick={()=>spr("other",[...pr.other,{desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}])}><Ic n="plus" s={10}/> Add Line</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:6}}>
            <Field l="Tax on Base+FSC"><select style={sIn} value={pr.taxMode} onChange={e=>spr("taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select></Field>
            {pr.taxMode==="CUSTOM" && <Field l="Custom Tax (%)"><input style={sIn} type="number" step="0.01" value={pr.taxCustom} onChange={e=>spr("taxCustom",e.target.value)} placeholder="e.g. 20"/></Field>}
          </div>
          {total>0 && <div style={{borderTop:`1px solid ${T.border}`,paddingTop:8,marginTop:8}}>
            <div style={{fontSize:10,color:T.muted}}>Base: {sym}{baseAmt.toFixed(2)}{fuelAmt>0?` + Fuel: ${sym}${fuelAmt.toFixed(2)}`:""}{otherTotal>0?` + Other: ${sym}${otherTotal.toFixed(2)}`:""}{taxAmt>0?` + Tax: ${sym}${taxAmt.toFixed(2)}`:""}</div>
            <div style={{fontSize:16,fontWeight:700,marginTop:2}}>Total: {sym}{total.toFixed(2)} <span style={{fontSize:10,color:T.muted}}>{pr.cur}</span></div>
          </div>}
          <Field l="Pricing Notes (internal only)"><textarea style={{...sIn,minHeight:50,resize:"vertical"}} value={pr.pricingNotes||""} onChange={e=>spr("pricingNotes",e.target.value)} placeholder="Rate agreements, negotiation details, special pricing terms..."/></Field>
        </div>;
      })()}
    </div>}

    {/* Notes */}
    <div style={sCrd}>
      <Field l="Special Requirements">
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
          {["Tail Gate","Step Deck","Flat Bed","Trailer","2 Man","Inside Delivery","Unpacking","Liftgate","Appointment Required","Hazmat","Oversized","Refrigerated"].map(req=>{
            const active = (o.specReqs||[]).includes(req);
            return <button key={req} type="button" onClick={()=>{
              const cur = o.specReqs||[];
              set("specReqs", active ? cur.filter(r=>r!==req) : [...cur,req]);
            }} style={{padding:"4px 10px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",border:`1px solid ${active?T.red:T.border}`,background:active?`rgba(14,165,233,0.1)`:"transparent",color:active?T.red:T.muted,fontFamily:"inherit",transition:"all 0.15s"}}>
              {req}
            </button>;
          })}
        </div>
        <input style={sIn} value={o.specReqCustom||""} onChange={e=>set("specReqCustom",e.target.value)} placeholder="Custom requirement..."/>
      </Field>
    </div>
    <div style={sCrd}><Field l="Notes / Information"><textarea style={{...sIn,resize:"vertical",minHeight:120}} rows={6} value={o.notes} onChange={e=>set("notes",e.target.value)} placeholder="AWB numbers, special instructions, truck/plate info..."/></Field></div>

    {/* Attachments — Firebase Storage */}
    <div style={sCrd}>
      <DropZone label="Attachments" uploading={uploading} docKey="files" fileRef={fileRef} onFiles={addFiles} />
      {(o.files||[]).length > 0 &&
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:6}}>{o.files.map((a,i)=><div key={i} style={{padding:"4px 8px",background:T["bg"],borderRadius:5,fontSize:11,display:"flex",alignItems:"center",gap:4}}><Ic n="file" s={11}/>{a.name}<button onClick={()=>removeFile(i)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12}}>×</button></div>)}</div>}
    </div>

    <div style={{display:"flex",gap:8}}>
      <button style={{...bP,opacity:ok?1:0.4}} disabled={!ok} onClick={()=>{
        const {_showPrice,...clean}=o;
        const p0 = (clean.pickStops||[])[0]||{};
        const d0 = (clean.delStops||[])[0]||{};
        savOrd({...clean,
          pickCo:p0.co||clean.pickCo||"", pickAddr:p0.addr||clean.pickAddr||"", pickDate:p0.date||clean.pickDate||"",
          delCo:d0.co||clean.delCo||"", delAddr:d0.addr||clean.delAddr||"", delDate:d0.date||clean.delDate||""
        });
      }}>Save Order</button>
      <button style={bS} onClick={()=>go(isNew?"ol":"od",isNew?null:o)}>Cancel</button>
      {!ok && <div style={{fontSize:11,color:"#ef4444",marginTop:6}}>{[!o.divId&&"Division",!o.cliId&&"Client",isTransport&&!hasPickup&&"Pickup location",isTransport&&!hasDelivery&&"Delivery location"].filter(Boolean).join(", ")} required</div>}
    </div>
  </div>;
}

// ═══ ASSIGN ORDER ═══
function AssignOrder({o:io, db, savOrd, go}) {
  const emptyDriver = {drvId:"",drvName:"",drvEmail:"",drvPhone:"",trkId:"",trkUnit:"",trkPlate:"",trlId:"",trlUnit:"",trlPlate:"",sendEmail:false};
  const [primary, setPrimary] = useState({drvId:io.drvId||"",drvName:io.drvName||"",drvEmail:io.drvEmail||"",drvPhone:io.drvPhone||"",trkId:io.trkId||"",trkUnit:io.trkUnit||"",trkPlate:io.trkPlate||"",trlId:io.trlId||"",trlUnit:io.trlUnit||"",trlPlate:io.trlPlate||"",pushToApp:io.pushToApp===true,sendEmail:io.sendEmail!==undefined?io.sendEmail:!!io.drvEmail});
  const [extras, setExtras] = useState((io.extraDrivers||[]).map(e=>({...e,sendEmail:e.sendEmail!==undefined?e.sendEmail:!!e.drvEmail})));
  const [emailSending, setEmailSending] = useState(false);
  const [emailStatus, setEmailStatus] = useState(""); // "sent" | "failed" | ""
  const [sentTo, setSentTo] = useState([]); // list of addresses actually emailed

  const setP = (k,v) => setPrimary(p=>({...p,[k]:v}));
  const setE = (i,k,v) => setExtras(ex=>ex.map((e,j)=>j===i?{...e,[k]:v}:e));
  const addDriver = () => setExtras(ex=>[...ex,{...emptyDriver}]);
  const removeDriver = i => setExtras(ex=>ex.filter((_,j)=>j!==i));

  const drivers = db.drivers.filter(d=>d.isDriver!==false).sort((a,b)=>(a.name||"").toLowerCase().localeCompare((b.name||"").toLowerCase()));
  const trucks = [...db.trucks].sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0));
  const trailers = [...db.trailers].sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0));

  const DriverRow = ({drv, setDrv, label, onRemove, onDriverChange}) => <div style={{...sCrd,borderColor:T.border,marginBottom:10}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
      <div style={{fontSize:11,fontWeight:600,color:T.muted}}>{label}</div>
      {onRemove && <button onClick={onRemove} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:700}}>✕ Remove</button>}
    </div>
    <Field l="Driver"><select style={sIn} value={drv.drvId} onChange={e=>{const d=db.drivers.find(x=>x.id===e.target.value);setDrv("drvId",e.target.value);setDrv("drvName",d?.name||"");setDrv("drvEmail",d?.email||"");setDrv("drvPhone",d?.phone||"");setDrv("sendEmail",!!(d?.email));if(onDriverChange)onDriverChange(d);}}><option value="">Select driver...</option>{drivers.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
    <Field l="Truck"><select style={sIn} value={drv.trkId} onChange={e=>{const t=trucks.find(x=>x.id===e.target.value);setDrv("trkId",e.target.value);setDrv("trkUnit",t?.unit||"");setDrv("trkPlate",t?.plate||"")}}><option value="">Select truck...</option>{trucks.map(t=><option key={t.id} value={t.id}>{t.unit} — {t.plate}</option>)}</select></Field>
    <Field l="Trailer"><select style={sIn} value={drv.trlId} onChange={e=>{const t=trailers.find(x=>x.id===e.target.value);setDrv("trlId",e.target.value);setDrv("trlUnit",t?.unit||"");setDrv("trlPlate",t?.plate||"")}}><option value="">Select trailer...</option>{trailers.map(t=><option key={t.id} value={t.id}>{t.unit}{t.plate?` — ${t.plate}`:""}</option>)}</select></Field>
    {/* Per-driver email toggle */}
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
      <div>
        <div style={{fontSize:12,fontWeight:600,color:T.text}}>✉️ Email this driver</div>
        <div style={{fontSize:11,color:T.muted,marginTop:2}}>{drv.drvEmail ? `Send BOL to ${drv.drvEmail}` : "No email on file for this driver"}</div>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:8,cursor:drv.drvEmail?"pointer":"default"}}>
        <input type="checkbox" checked={!!drv.sendEmail && !!drv.drvEmail} disabled={!drv.drvEmail}
          onChange={e=>setDrv("sendEmail",e.target.checked)}
          style={{width:18,height:18,accentColor:T.red,cursor:drv.drvEmail?"pointer":"not-allowed"}}/>
        <span style={{fontSize:12,color:drv.drvEmail?T.muted:T.dim}}>{drv.sendEmail&&drv.drvEmail?"Yes":"No"}</span>
      </label>
    </div>
  </div>;

  const save = async () => {
    const allDrivers = [primary, ...extras];
    // Drivers flagged for email that actually have an address
    const emailTargets = allDrivers.filter(d=>d.sendEmail && d.drvEmail);

    // Confirm before sending — you can't unsend it
    if (emailTargets.length > 0) {
      const list = emailTargets.map(d=>`• ${d.drvName||"Driver"} — ${d.drvEmail}`).join("\n");
      const ok = window.confirm(
        `Send BOL ${io.bol} assignment by email to:\n\n${list}\n\nThis will email ${emailTargets.length===1?"this driver":"these drivers"} immediately.`
      );
      if (!ok) return;
    }

    const saved = {...io, ...primary, extraDrivers:extras, status:"assigned",
      drvName: allDrivers.filter(d=>d.drvName).map(d=>d.drvName).join(", ")
    };
    savOrd(saved);

    // Send an assignment email to each toggled driver individually
    if (emailTargets.length > 0) {
      setEmailSending(true);
      const senderEmail = auth?.currentUser?.email || REPORTS_EMAIL;
      const okSent = [];
      const failed = [];
      // driverIndex matches position in [primary, ...extras] so each BOL shows the right unit
      for (let i = 0; i < allDrivers.length; i++) {
        const d = allDrivers[i];
        if (!(d.sendEmail && d.drvEmail)) continue;
        try {
          await fetch(CF_URLS.sendBolEmail, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({
              order: saved,
              toEmail: d.drvEmail,
              driverIndex: i,
              senderEmail,
              subject: `Your assignment — BOL ${io.bol}`,
              includePod: false,
              includeAttachments: false,
            })
          });
          okSent.push(d.drvEmail);
        } catch(e) {
          console.error(`Driver email failed for ${d.drvEmail}:`, e);
          failed.push(d.drvEmail);
        }
      }
      setSentTo(okSent);
      setEmailStatus(failed.length===0 ? "sent" : (okSent.length>0 ? "partial" : "failed"));
      setEmailSending(false);
      // Navigate back to order after short delay so the success banner is visible
      setTimeout(() => go("od", saved), 1500);
    } else {
      // No email — navigate back to order detail immediately
      go("od", saved);
    }
  };

  return <div style={{padding:20,maxWidth:520}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
      <button onClick={()=>go("od",io)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>Assign BOL {io.bol}</h1>
    </div>
    <DriverRow drv={primary} setDrv={setP} label="Driver 1 (Primary)"/>
    {extras.map((e,i)=><DriverRow key={i} drv={e} setDrv={(k,v)=>setE(i,k,v)} label={`Driver ${i+2}`} onRemove={()=>removeDriver(i)}/>)}
    <button onClick={addDriver} style={{...bS,marginBottom:14,width:"100%",textAlign:"center"}}>+ Add Another Driver</button>

    {/* Push to app toggle */}
    <div style={{...sCrd,marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div>
        <div style={{fontSize:13,fontWeight:600,color:T.text}}>📱 Push to Driver App</div>
        <div style={{fontSize:11,color:T.muted,marginTop:2}}>Send this order to the driver's timesheet app</div>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
        <input type="checkbox" checked={!!primary.pushToApp} onChange={e=>setP("pushToApp",e.target.checked)} style={{width:18,height:18,accentColor:T.red,cursor:"pointer"}}/>
        <span style={{fontSize:12,color:T.muted}}>{primary.pushToApp?"Yes":"No"}</span>
      </label>
    </div>
    <div style={{display:"flex",gap:8}}>
      <button style={{...sBtn,background:"#3b82f6",opacity:emailSending?0.7:1}} onClick={save} disabled={emailSending}>
        <Ic n="check" s={13}/> {emailSending?"Sending...":"Assign"}
      </button>
      {io.drvId && <button style={{...sBtn,background:"#64748b"}} onClick={()=>savOrd({...io,drvId:"",drvName:"",drvEmail:"",trkId:"",trkUnit:"",trkPlate:"",trlId:"",trlUnit:"",trlPlate:"",extraDrivers:[],status:"unassigned"})}>Unassign All</button>}
      <button style={bS} onClick={()=>go("od",io)}>Cancel</button>
    </div>
    {emailStatus==="sent" && <div style={{marginTop:10,padding:"8px 12px",background:"rgba(34,197,94,0.1)",border:"1px solid #22c55e",borderRadius:6,fontSize:12,color:"#15803d",fontWeight:500}}>✅ Assignment email sent to {sentTo.join(", ")}</div>}
    {emailStatus==="partial" && <div style={{marginTop:10,padding:"8px 12px",background:"rgba(245,158,11,0.1)",border:"1px solid #f59e0b",borderRadius:6,fontSize:12,color:"#b45309",fontWeight:500}}>⚠️ Sent to {sentTo.join(", ")}, but some emails failed — check addresses and re-send.</div>}
    {emailStatus==="failed" && <div style={{marginTop:10,padding:"8px 12px",background:"rgba(239,68,68,0.1)",border:"1px solid #ef4444",borderRadius:6,fontSize:12,color:"#dc2626",fontWeight:500}}>⚠️ Email failed — check driver email addresses and try again</div>}
  </div>;
}

// ═══ POD ENTRY ═══
function PodEntry({o:io, savOrd, go}) {
  const nPick=(io.pickStops||[]).length, nDel=(io.delStops||[]).length;
  const isMultiStop = nPick>1 || nDel>1;
  const podSide = nDel>=nPick ? "delStops" : "pickStops";
  const sideLabel = podSide==="delStops" ? "Delivery" : "Pickup";
  // Seed per-stop pod objects with sensible date/time defaults (don't overwrite existing)
  const seed = (io[podSide]||[]).map(s=>({...s, pod:{by:s.pod?.by||"", date:s.pod?.date||"", time:s.pod?.time||""}}));
  const [o,setO] = useState({...io,podDate:io.podDate||td(),podTime:io.podTime||tn(),[podSide]:isMultiStop?seed:(io[podSide]||[])});
  const set=(k,v)=>setO(p=>({...p,[k]:v}));
  const setStopPod=(i,k,v)=>setO(p=>{const arr=[...(p[podSide]||[])]; arr[i]={...arr[i],pod:{...(arr[i].pod||{}),[k]:v}}; return {...p,[podSide]:arr};});
  const stampNow=(i)=>setO(p=>{const arr=[...(p[podSide]||[])]; arr[i]={...arr[i],pod:{...(arr[i].pod||{}),date:arr[i].pod?.date||td(),time:tn()}}; return {...p,[podSide]:arr};});

  if(!isMultiStop) {
    return <div style={{padding:20,maxWidth:500}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}><button onClick={()=>go("od",o)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button><h1 style={{fontSize:18,fontWeight:700,margin:0}}>POD — BOL {o.bol}</h1></div>
      <div style={sCrd}>
        <Field l="Received By (Name)"><input style={sIn} value={o.podBy} onChange={e=>set("podBy",e.target.value)} placeholder="Full name"/></Field>
        <Field l="Date Received"><DatePicker value={o.podDate} onChange={v=>set("podDate",v)} placeholder="Select date received..."/></Field>
        <Field l="Time Received"><input style={sIn} type="time" value={o.podTime} onChange={e=>set("podTime",e.target.value)}/></Field>
        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button style={{...sBtn,background:"#22c55e"}} onClick={()=>savOrd({...o,status:"ready-to-bill"})}><Ic n="check" s={13}/> Submit POD</button>
          <button style={bS} onClick={()=>go("od",o)}>Cancel</button>
        </div>
      </div>
    </div>;
  }

  const stops = o[podSide]||[];
  const doneCount = stops.filter(s=>s.pod?.by).length;
  return <div style={{padding:20,maxWidth:560}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><button onClick={()=>go("od",o)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button><h1 style={{fontSize:18,fontWeight:700,margin:0}}>POD — BOL {o.bol}</h1></div>
    <div style={{fontSize:12,color:T.muted,marginBottom:14}}>Enter proof of delivery for each stop. <b style={{color:doneCount===stops.length?"#22c55e":T.text}}>{doneCount} of {stops.length}</b> recorded.</div>
    {stops.map((s,i)=>{
      const done=!!s.pod?.by;
      return <div key={i} style={{...sCrd,marginBottom:10,borderColor:done?"#22c55e":T.border}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700}}>{sideLabel} Stop {i+1}{s.co?` — ${s.co}`:""}</div>
          {done ? <span style={{fontSize:10,fontWeight:700,color:"#22c55e",textTransform:"uppercase"}}>✓ Delivered</span> : <span style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase"}}>Pending</span>}
        </div>
        <Field l="Received By (Name)"><input style={sIn} value={s.pod?.by||""} onChange={e=>setStopPod(i,"by",e.target.value)} placeholder="Full name"/></Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <Field l="Date Received"><DatePicker value={s.pod?.date||""} onChange={v=>setStopPod(i,"date",v)} placeholder="Date..."/></Field>
          <Field l="Time Received"><input style={sIn} type="time" value={s.pod?.time||""} onChange={e=>setStopPod(i,"time",e.target.value)}/></Field>
        </div>
        <button style={{...bS,marginTop:4,fontSize:11}} onClick={()=>stampNow(i)}>Stamp now</button>
      </div>;
    })}
    <div style={{display:"flex",gap:8,marginTop:6}}>
      <button style={{...sBtn,background:"#22c55e"}} onClick={()=>savOrd({...o})}><Ic n="check" s={13}/> Save POD</button>
      <button style={bS} onClick={()=>go("od",o)}>Cancel</button>
    </div>
    <div style={{fontSize:11,color:T.muted,marginTop:10}}>Saving POD does not change the order status — move to Ready to Bill from the order screen when you decide.</div>
  </div>;
}

// ═══ TAX PRESETS ═══
const TAX_MODES = [
  {k:"NONE",l:"No tax / Exempt",pct:0},
  {k:"HST",l:"HST Ontario (13%)",pct:13},
  {k:"GST",l:"GST only (5%)",pct:5},
  {k:"CUSTOM",l:"Custom %",pct:0},
];
// Xero tax code mapping
const xeroTaxCode = (k) => k==="HST"?"OUTPUT2":k==="GST"?"OUTPUT":"NONE";

// Builds Xero CSV string from order + pricing — used both for download button and email attachment
function buildXeroCsvString(o, p) {
  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const invoiceDate = fmt(today);
  const due = new Date(today); due.setDate(due.getDate()+30);
  const dueDate = fmt(due);
  const xeroInvNum = `DBX-${o.bol}`;
  const xeroRef = ["BOL "+o.bol, o.poNumber?"PO "+o.poNumber:"", o.ref].filter(Boolean).join(" ");
  const cur = p.cur||"CAD";
  const contact = o.cliName||"";
  const hdr = ["ContactName","EmailAddress","POAddressLine1","POCity","POPostalCode","POCountry","InvoiceNumber","Reference","InvoiceDate","DueDate","InventoryItemCode","Description","Quantity","UnitAmount","AccountCode","TaxType","TrackingName1","TrackingOption1","Currency","BrandingTheme"];
  const rows = [hdr];
  const row = (desc,qty,unit,tax) => [contact,"","","","","",xeroInvNum,xeroRef,invoiceDate,dueDate,"",desc,String(qty),unit,"4000",xeroTaxCode(tax||"NONE"),"","",cur,""];
  const hasBase = p.base && parseFloat(p.base)>0;
  const hasEvtLines = (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0);
  // ── Multi-stop: pricing lives per-stop on the multi side (delStops or pickStops) ──
  const nPick=(o.pickStops||[]).length, nDel=(o.delStops||[]).length;
  const isMultiStop = nPick>1 || nDel>1;
  if(isMultiStop && !(p.useEventPricing||hasEvtLines)) {
    const priceSide = nDel>=nPick ? "delStops" : "pickStops";
    const stops = o[priceSide]||[];
    const sideLabel = priceSide==="delStops" ? "Delivery" : "Pickup";
    stops.forEach((st,i)=>{
      const sp=st.price||{};
      const sbase=parseFloat(sp.base||0);
      const sfuel = sp.fuelModel==="liter" ? (parseFloat(sp.fuelAmt)||0) : (sbase*((parseFloat(sp.fuelPct)||0)/100));
      const fuelDesc = sp.fuelModel==="liter" ? `Fuel (${sp.liters||"?"}L)` : "Fuel Surcharge";
      const stopName = st.co || `${sideLabel} Stop ${i+1}`;
      if(sbase>0) rows.push(row(`${stopName} — Transport Charge`,1,sbase.toFixed(2),sp.taxMode));
      if(sfuel>0) rows.push(row(`${stopName} — ${fuelDesc}`,1,sfuel.toFixed(2),"NONE"));
      (sp.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0).forEach(c=>{
        const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");
        const qty=hasQty?(parseFloat(c.qty)||0):1;
        const unit=hasQty?(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);
        rows.push(row(`${stopName} — ${c.desc||"Additional Charge"}`,qty,unit.toFixed(2),c.taxMode||"NONE"));
      });
    });
    return rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  }
  if(p.useEventPricing || hasEvtLines) {
    if(hasBase) {
      const base=parseFloat(p.base||0), fuelP=parseFloat(p.fuelPct||0), fuel=base*(fuelP/100);
      rows.push(row(p.transDesc||"Transport Charge",1,base.toFixed(2),p.taxMode));
      if(fuel>0) rows.push(row("Fuel Surcharge",1,fuel.toFixed(2),"NONE"));
    }
    (p.eventLines||[]).filter(l=>l.desc&&parseFloat(l.unitPrice)>0).forEach(l=>{
      rows.push(row(l.desc,parseFloat(l.qty)||1,(parseFloat(l.unitPrice)||0).toFixed(2),l.taxMode||"NONE"));
    });
  } else {
    const routeDesc = [o.pickCo?`from ${o.pickCo}`:"",o.pickCity||"",o.delCo?`to ${o.delCo}`:"",o.delCity||""].filter(Boolean).join(" ");
    const mainDesc = o.notes||routeDesc||`Freight Services - BOL ${o.bol}`;
    const base=parseFloat(p.base||0), fuelP=parseFloat(p.fuelPct||0), fuel=base*(fuelP/100);
    if(base>0) rows.push(row(p.transDesc||mainDesc,1,base.toFixed(2),p.taxMode));
    if(fuel>0) rows.push(row("Fuel Surcharge",1,fuel.toFixed(2),"NONE"));
    (p.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0).forEach(c=>{
      const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");
      const qty=hasQty?(parseFloat(c.qty)||0):1;
      const unit=hasQty?(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);
      rows.push(row(c.desc||"Additional Charge",qty,unit.toFixed(2),c.taxMode||"NONE"));
    });
  }
  return rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
}

const emptyEventLine = () => ({id:Math.random().toString(36).slice(2), desc:"", qty:"1", unitPrice:"", taxMode:"NONE"});

// ═══ PRICING ═══
function PricingEntry({o:io, db, savOrd, go}) {
  const dp = {cur:"CAD",base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[{desc:"",amt:""}],eventLines:[],useEventPricing:false};
  // Resolve currency: client preference > division > saved value > CAD
  const _cli = db.clients.find(c=>c.id===io.cliId);
  const _div = DIVS.find(d=>d.id===io.divId);
  const resolvedCur = io.price?.cur && io.price.cur!=="CAD" ? io.price.cur
    : _cli?.preferredCurrency ? _cli.preferredCurrency
    : (/USA|U\.S|LLC|USD/i.test(_div?.name||"")) ? "USD"
    : io.price?.cur || "CAD";
  const [o,setO] = useState({...io, price:{...dp,...(io.price||{}), cur: resolvedCur, transDesc: io.price?.transDesc||"", pricingNotes: io.price?.pricingNotes||"", other:[...(io.price?.other||[{desc:"",amt:""}])], eventLines:[...(io.price?.eventLines||[])], useEventPricing:io.price?.useEventPricing||false}});
  const [sending,setSending] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);
  const [showEventPricing, setShowEventPricing] = useState(io.price?.useEventPricing||false);
  const [expandedStops, setExpandedStops] = useState({});
  const p = o.price; const sp=(k,v)=>setO(pr=>({...pr,price:{...pr.price,[k]:v}}));
  const soc=(i,k,v)=>{const oc=[...p.other];oc[i]={...oc[i],[k]:v};sp("other",oc)};
  const sel=(i,k,v)=>{const el=[...p.eventLines];el[i]={...el[i],[k]:v};sp("eventLines",el)};
  // ── Multi-stop pricing (mirrors order-creation per-stop model) ──
  const nPick=(o.pickStops||[]).length, nDel=(o.delStops||[]).length;
  const isMultiStop = nPick>1 || nDel>1;
  const priceSide = nDel>=nPick ? "delStops" : "pickStops"; // multi side holds pricing
  const setStP = (i,k,v)=>setO(pr=>{const arr=[...(pr[priceSide]||[])]; arr[i]={...arr[i],price:{...(arr[i]?.price||{base:"",fuelPct:"",taxMode:"NONE",taxCustom:"",other:[]}),[k]:v}}; return {...pr,[priceSide]:arr};});
  const setStOc=(i,j,k,v)=>setO(pr=>{const arr=[...(pr[priceSide]||[])]; const pp=arr[i]?.price||{other:[]}; const oc=[...(pp.other||[])]; oc[j]={...oc[j],[k]:v}; arr[i]={...arr[i],price:{...pp,other:oc}}; return {...pr,[priceSide]:arr};});
  const addStOc=(i)=>setO(pr=>{const arr=[...(pr[priceSide]||[])]; const pp=arr[i]?.price||{other:[]}; arr[i]={...arr[i],price:{...pp,other:[...(pp.other||[]),{desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}]}}; return {...pr,[priceSide]:arr};});
  const delStOc=(i,j)=>setO(pr=>{const arr=[...(pr[priceSide]||[])]; const pp=arr[i]?.price||{other:[]}; arr[i]={...arr[i],price:{...pp,other:(pp.other||[]).filter((_,x)=>x!==j)}}; return {...pr,[priceSide]:arr};});
  const calcStop=(price)=>{const pr=price||{}; const b=parseFloat(pr.base)||0; const f=pr.fuelModel==="liter"?(parseFloat(pr.fuelAmt)||0):(b*((parseFloat(pr.fuelPct)||0)/100)); const sub=b+f;
    const oc=(c)=>{const lt=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lb=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {lb,lt:lb*(lt/100)};};
    const ob=(pr.other||[]).reduce((s,c)=>s+oc(c).lb,0); const ot=(pr.other||[]).reduce((s,c)=>s+oc(c).lt,0);
    const tp=pr.taxMode==="CUSTOM"?(parseFloat(pr.taxCustom)||0):pr.taxMode==="HST"?13:pr.taxMode==="GST"?5:0;
    const tx=(!pr.taxMode||pr.taxMode==="NONE")?0:sub*(tp/100);
    return {b,f,ob,ot,tx,total:sub+tx+ob+ot};};
  const orderGrandTotal = (o[priceSide]||[]).reduce((s,st)=>s+calcStop(st.price).total,0);
  const sym = csym(p.cur);
  const isEvent = io.orderType === "event";

  // ── Client pricing schedule (auto-fill, always overridable) ──
  const schedClient = db.clients.find(c=>c.id===o.cliId);
  const sched = (schedClient?.pricingSchedule && schedClient.pricingSchedule.enabled) ? schedClient.pricingSchedule : null;
  // Compute a stop's base from km using the schedule: max(minCharge, baseFee + perKm*km); extra stops use perExtraStop
  const schedBaseFor = (km) => {
    if(!sched) return "";
    const k = parseFloat(km)||0;
    const calc = (parseFloat(sched.baseFee)||0) + (parseFloat(sched.perKm)||0)*k;
    const withMin = sched.minCharge ? Math.max(parseFloat(sched.minCharge)||0, calc) : calc;
    return withMin.toFixed(2);
  };
  // Apply schedule to a single stop (base from km, default fuel/tax, auto accessorials)
  const applySchedToStop = (i) => {
    if(!sched) return;
    setO(pr=>{
      const arr=[...(pr[priceSide]||[])];
      const st=arr[i]||{}; const stp=st.price||{};
      const base = schedBaseFor(stp.km);
      const autoAcc = (sched.accessorials||[]).filter(a=>a.auto && (a.desc||a.unitPrice)).map(a=>({desc:a.desc||"",qty:"1",unitPrice:a.unitPrice||"",taxMode:a.taxMode||"NONE"}));
      // Extra stop fee as a visible, removable accessorial line (only for stops after the first)
      if(i>0 && sched.perExtraStop) {
        autoAcc.push({desc:"Extra Stop",qty:"1",unitPrice:sched.perExtraStop,taxMode:"NONE"});
      }
      // Merge auto accessorials without duplicating ones already present by desc
      const existing = stp.other||[];
      const existingDescs = new Set(existing.map(o=>(o.desc||"").toLowerCase()));
      const mergedOther = [...existing, ...autoAcc.filter(a=>!existingDescs.has((a.desc||"").toLowerCase()))];
      // Fuel: per-liter model calculates from km; FSC% uses percentage on base
      let fuelFields = {};
      if(sched.fuelModel==="liter") {
        const km = parseFloat(stp.km)||0;
        const lpk = parseFloat(sched.litersPerKm)||0;
        const ppl = parseFloat(sched.fuelPricePerLiter)||0;
        const liters = +(km * lpk).toFixed(2);
        const fuelAmt = +(liters * ppl).toFixed(2);
        fuelFields = { fuelModel:"liter", liters, fuelAmt, fuelPct:"" };
      } else {
        fuelFields = { fuelModel:"pct", fuelPct: stp.fuelPct||sched.fuelPct||"", fuelAmt:"", liters:"" };
      }
      arr[i]={...st, price:{...stp, base, ...fuelFields, taxMode: stp.taxMode&&stp.taxMode!=="NONE"?stp.taxMode:(sched.taxMode||"NONE"), other: mergedOther}};
      return {...pr,[priceSide]:arr};
    });
  };
  const applySchedAllStops = () => { if(!sched) return; (o[priceSide]||[]).forEach((_,i)=>applySchedToStop(i)); };

  // Calculate totals
  const baseAmt = parseFloat(p.base)||0;
  const fuelPct = parseFloat(p.fuelPct)||0;
  const fuelAmt = baseAmt * (fuelPct/100);
  const subtotal = baseAmt + fuelAmt;
  // Helper: compute an "other" line base (qty×unit, or legacy amt) and its own tax
  const ocCalc = (c)=>{
    const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0;
    const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);
    const ltax=lbase*(ltp/100);
    return {lbase,ltax,ltot:lbase+ltax};
  };
  const otherBaseTotal = p.other.reduce((s,c)=>s+ocCalc(c).lbase,0);
  const otherTaxTotal = p.other.reduce((s,c)=>s+ocCalc(c).ltax,0);
  const otherTotal = otherBaseTotal + otherTaxTotal;
  const eventTotal = (p.eventLines||[]).reduce((s,l)=>s+(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0),0);
  const taxMode = TAX_MODES.find(t=>t.k===p.taxMode)||TAX_MODES[0];
  const taxPct = p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):taxMode.pct;
  // Base tax applies ONLY to base+fuel now; each other line carries its own tax
  const taxAmt = p.taxMode==="NONE"?0:subtotal*(taxPct/100);
  const transportTotal = subtotal + taxAmt + otherTotal; // base+fuel+baseTax + (other lines incl their tax)
  const total = transportTotal; // used for display

  const emailAcct = async (emails, message="", attachCsv=false) => {
    setSending(true);
    const div = DIVS.find(d=>d.id===o.divId);
    const cli = db.clients.find(c=>c.id===o.cliId);
    const xeroCSVBase64 = attachCsv ? btoa(unescape(encodeURIComponent(buildXeroCsvString(o, p)))) : null;
    try {
      for(const email of emails) {
        await callCloudFn("sendInvoiceEmail", {
          order: { ...o, divName: div?.name || "" },
          pricing: { ...p, billingEmail: cli?.billingEmail || "" },
          client: cli ? { name:cli.name||"", street:cli.street||"", city:cli.city||"", provState:cli.provState||"", postalZip:cli.postalZip||"", country:cli.country||"", email:cli.billingEmail||cli.email||"" } : null,
          toEmail: email,
          subject: `Invoice — BOL ${o.bol} — ${o.cliName}`,
          orderFiles: (o.files||[]).map(f=>({name:f.name, url:f.url||f.data})),
          emailMsg: message,
          xeroCSVBase64,
          xeroCSVFilename: `Xero_BOL${o.bol}.csv`,
        });
      }
      alert(`Invoice emailed to: ${emails.join(", ")}`);
    } catch(e) { console.error(e); alert("Failed to send. Check Cloud Function setup."); }
    setSending(false);
  };

  return <><div style={{padding:20,maxWidth:600}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}><button onClick={()=>go("od",o)} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button><h1 style={{fontSize:18,fontWeight:700,margin:0}}>Pricing — BOL {o.bol}</h1></div>

    {/* Order summary — visible while entering pricing */}
    <div style={{...sCrd,borderColor:"#334155",marginBottom:12,fontSize:12}}>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:8}}>Order Summary</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
        {[["Client",o.cliName],["Reference",o.ref],["Pickup",nPick>1?`${nPick} pickups`:`${o.pickStops?.[0]?.co||o.pickCo||"—"} · ${fd(o.pickStops?.[0]?.date||o.pickDate)||"—"}`],["Delivery",nDel>1?`${nDel} deliveries`:`${o.delStops?.[0]?.co||o.delCo||"—"} · ${fd(o.delStops?.[0]?.date||o.delDate)||"—"}`],["Driver",o.drvName||"—"],["Division",DIVS.find(d=>d.id===o.divId)?.short||"—"]].map(([l,v])=><div key={l}><span style={{color:T.muted,fontSize:10}}>{l}: </span><span>{v}</span></div>)}
      </div>
      {o.poRequired && <div style={{marginTop:8,padding:"5px 10px",borderRadius:5,background:o.poNumber?"rgba(34,197,94,0.08)":"rgba(249,115,22,0.1)",border:`1px solid ${o.poNumber?"#22c55e":"#f97316"}`}}>
        <span style={{fontSize:11,color:T.muted}}>PO #: </span>
        {o.poNumber ? <strong style={{color:"#22c55e"}}>{o.poNumber}</strong> : <span style={{color:"#f97316",fontWeight:600}}>⚠ Required — not entered yet</span>}
      </div>}
      {(() => {
        const _nP=(o.pickStops||[]).length, _nD=(o.delStops||[]).length;
        const _multi=_nP>1||_nD>1;
        if(_multi){
          const side=_nD>=_nP?"delStops":"pickStops"; const sts=o[side]||[];
          const done=sts.filter(s=>s.pod?.by).length;
          if(done===0) return null;
          return <div style={{marginTop:6,fontSize:11,color:done===sts.length?"#22c55e":"#f97316"}}>POD: {done} of {sts.length} stops delivered</div>;
        }
        return o.podBy ? <div style={{marginTop:6,fontSize:11,color:"#22c55e"}}>✓ POD: Received by <strong>{o.podBy}</strong> — {fd(o.podDate)} {o.podTime}</div> : null;
      })()}
    </div>

    <div style={sCrd}>
      <Field l="Currency"><select style={{...sIn,maxWidth:180}} value={p.cur} onChange={e=>sp("cur",e.target.value)}>{CURRS.map(c=><option key={c.v} value={c.v}>{c.v} ({c.s})</option>)}</select></Field>

      {/* Transport Charge block — single-stop only; multi-stop uses per-stop pricing below */}
      {!isMultiStop && <div style={{marginTop:12,padding:"12px",background:"rgba(220,38,38,0.04)",borderRadius:8,border:`1px solid ${T.border}`}}>
        <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Transport Charge {isEvent&&<span style={{fontSize:9,fontWeight:400,color:T.dim,textTransform:"none"}}>(leave empty if no transport charge)</span>}</div>

        <Field l={`Base Price (${sym})`}><input style={sIn} type="number" step="0.01" value={p.base} onChange={e=>sp("base",e.target.value)} placeholder={isEvent?"Leave empty if no transport charge":"0.00"}/></Field>

        {baseAmt>0 && <>
          <Field l="Transport Description">
            <input style={sIn} value={p.transDesc||""} onChange={e=>sp("transDesc",e.target.value)} placeholder="e.g. 10 trucks × $1,000 — Montreal to Toronto"/>
          </Field>
          <Field l="Fuel Surcharge (%)">
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <input style={{...sIn,maxWidth:100}} type="number" step="0.1" value={p.fuelPct} onChange={e=>sp("fuelPct",e.target.value)} placeholder="0"/>
              <span style={{fontSize:11,color:T.muted}}>%</span>
              {fuelAmt>0 && <span style={{fontSize:11,color:T.text}}>= {sym}{fuelAmt.toFixed(2)}</span>}
            </div>
          </Field>

          <div style={{marginTop:12}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:4}}>
              <label style={sLbl}>Accessorial Charges</label>
            </div>
            <div style={{fontSize:11,color:T.muted,marginBottom:8}}>Extra services — each line can have its own tax.</div>
            <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:4}}>
              {["Description","Qty","Unit Price","Tax","Total",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=1&&i<=4?"right":"left"}}>{h}</div>)}
            </div>
            {p.other.map((oc,i)=>{
              const ltp=oc.taxMode==="HST"?13:oc.taxMode==="GST"?5:oc.taxMode==="CUSTOM"?(parseFloat(oc.taxCustom)||0):0;
              const lqty=oc.qty!==undefined&&oc.qty!==""?parseFloat(oc.qty)||0:(oc.amt&&!oc.unitPrice?1:0);
              const lunit=oc.unitPrice!==undefined&&oc.unitPrice!==""?parseFloat(oc.unitPrice)||0:(parseFloat(oc.amt)||0);
              const lbase=(oc.qty!==undefined||oc.unitPrice!==undefined)?(parseFloat(oc.qty)||0)*(parseFloat(oc.unitPrice)||0):(parseFloat(oc.amt)||0);
              const ltax=lbase*(ltp/100);
              const ltot=lbase+ltax;
              return <div key={i} style={{marginBottom:6}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,alignItems:"center"}}>
                  <input style={sIn} placeholder="Description..." value={oc.desc} onChange={e=>soc(i,"desc",e.target.value)}/>
                  <input style={{...sIn,textAlign:"right"}} type="number" value={oc.qty!==undefined?oc.qty:""} onChange={e=>soc(i,"qty",e.target.value)} placeholder="1"/>
                  <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={oc.unitPrice!==undefined?oc.unitPrice:(oc.amt||"")} onChange={e=>soc(i,"unitPrice",e.target.value)} placeholder="0.00"/>
                  <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={oc.taxMode||"NONE"} onChange={e=>soc(i,"taxMode",e.target.value)}>
                    {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
                  </select>
                  <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:ltot>0?"#22c55e":T.dim}}>{sym}{ltot.toFixed(2)}</div>
                  <button onClick={()=>sp("other",p.other.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
                </div>
                {ltax>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:30}}>Tax ({ltp}%): {sym}{ltax.toFixed(2)} · Base: {sym}{lbase.toFixed(2)}</div>}
                {oc.taxMode==="CUSTOM"&&<div style={{display:"flex",justifyContent:"flex-end",marginTop:2}}><input style={{...sIn,width:120,fontSize:10}} type="number" step="0.01" placeholder="Custom tax %" value={oc.taxCustom||""} onChange={e=>soc(i,"taxCustom",e.target.value)}/></div>}
              </div>;
            })}
            <button style={{...bS,padding:"4px 10px",fontSize:11,marginTop:4}} onClick={()=>sp("other",[...p.other,{desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}])}><Ic n="plus" s={10}/> Add Line</button>
          </div>

          {/* Tax on transport base — only shown when base > 0 */}
          <Field l="Tax on Base+FSC">
            <select style={sIn} value={p.taxMode} onChange={e=>sp("taxMode",e.target.value)}>
              {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
            </select>
          </Field>
          {p.taxMode==="CUSTOM" && <Field l="Custom Tax (%)"><input style={{...sIn,maxWidth:120}} type="number" step="0.01" value={p.taxCustom} onChange={e=>sp("taxCustom",e.target.value)} placeholder="e.g. 20"/></Field>}

          {/* Transport total */}
          <div style={{borderTop:`1px solid ${T.border}`,marginTop:10,paddingTop:8}}>
            {taxAmt>0 && <div style={{fontSize:11,color:T.muted,marginBottom:2}}>
              Base: {sym}{baseAmt.toFixed(2)}
              {fuelAmt>0&&<> + Fuel: {sym}{fuelAmt.toFixed(2)}</>}
              {otherTotal>0&&<> + Other: {sym}{otherTotal.toFixed(2)}</>}
              {taxAmt>0&&<> + Tax ({taxPct}%): {sym}{taxAmt.toFixed(2)}</>}
            </div>}
            <div style={{fontSize:16,fontWeight:700,color:T.text}}>
              {sym}{transportTotal.toFixed(2)} <span style={{fontSize:11,color:T.muted}}>{p.cur}</span>
              {taxAmt>0&&<span style={{fontSize:10,color:T.muted,marginLeft:4}}>(incl. tax)</span>}
            </div>
          </div>
        </>}
      </div>}

      {/* Multi-stop per-stop pricing */}
      {isMultiStop && <div style={{marginTop:12}}>
        <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Per-Stop Pricing — {priceSide==="delStops"?"Delivery":"Pickup"} Stops</div>
        {sched && <div style={{marginBottom:10,padding:"10px 12px",background:"rgba(14,165,233,0.08)",border:`1px solid #0ea5e9`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:11,color:T.text}}><b style={{color:"#0ea5e9"}}>{schedClient.name}</b> has a rate schedule{sched.perKm?` (${sym}${sched.perKm}/km`:""}{sched.perExtraStop?`, ${sym}${sched.perExtraStop}/extra stop)`:sched.perKm?")":""}. Enter km per stop, then auto-fill.</div>
          <button style={{...bP,padding:"7px 12px",fontSize:11,whiteSpace:"nowrap"}} onClick={applySchedAllStops}><Ic n="dollar" s={11}/> Auto-fill all stops</button>
        </div>}
        {(o[priceSide]||[]).map((st,i)=>{
          const stc=calcStop(st.price); const pr=st.price||{};
          return <div key={i} style={{marginBottom:10,padding:12,background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
            <div onClick={()=>setExpandedStops(p=>({...p,[i]:!p[i]}))} style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",marginBottom:8}}>
              <div style={{fontSize:11,fontWeight:700}}>{priceSide==="delStops"?"Delivery":"Pickup"} Stop {i+1}{st.co?` — ${st.co}`:""}</div>
              <span style={{fontSize:11,color:T.muted}}>{expandedStops[i]?"▾ details":"▸ details"}</span>
            </div>
            {expandedStops[i] && <div style={{marginBottom:10,padding:8,background:T["bg"],borderRadius:6,fontSize:11,color:T.muted}}>
              {st.addr && <div style={{whiteSpace:"pre-line",marginBottom:(st.items||[]).filter(it=>it.desc||it.pcs).length?6:0}}>{st.addr}</div>}
              {(st.items||[]).filter(it=>it.desc||it.pcs).map((it,j)=><div key={j} style={{color:T.text}}>{it.pcs||"—"} × {it.desc||"—"}{it.wt?` — ${it.wt} ${it.wUnit||"lbs"}`:""}{(it.l||it.w||it.h)?` — ${it.l||"?"}×${it.w||"?"}×${it.h||"?"} ${it.dUnit||"in"}`:""}</div>)}
              {st.notes && <div style={{marginTop:6,fontStyle:"italic"}}>Notes: {st.notes}</div>}
              {!st.addr && !(st.items||[]).length && <div>No stop details entered.</div>}
            </div>}
            {sched && <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:8,alignItems:"end",padding:"8px",background:T["bg"],borderRadius:6,border:`1px dashed ${T.red}`}}>
              <Field l={`Distance (km)${i>0?" — extra stop":""}`}><input style={sIn} type="number" step="0.1" value={pr.km||""} onChange={e=>setStP(i,"km",e.target.value)} placeholder={i===0?"e.g. 150":"leg km (optional)"}/></Field>
              <button style={{...bP,padding:"8px 12px",fontSize:11,whiteSpace:"nowrap"}} onClick={()=>applySchedToStop(i)}><Ic n="dollar" s={11}/> Auto-fill rate</button>
            </div>}
            <div style={{padding:"12px",background:"rgba(220,38,38,0.04)",borderRadius:8,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>Transport Charge</div>
              <Field l={`Base Price (${sym})`}><input style={sIn} type="number" step="0.01" value={pr.base||""} onChange={e=>setStP(i,"base",e.target.value)} placeholder="0.00"/></Field>
              {(parseFloat(pr.base)||0)>0 && <>
                <Field l="Transport Description"><input style={sIn} value={pr.transDesc||""} onChange={e=>setStP(i,"transDesc",e.target.value)} placeholder="e.g. Brampton to Lindsay"/></Field>
                {pr.fuelModel==="liter"
                  ? <div style={{display:"grid",gridTemplateColumns:"1fr 90px 90px",gap:8,marginBottom:8}}>
                      <Field l="Fuel — Liters"><input style={sIn} type="number" step="0.01" value={pr.liters||""} onChange={e=>setStP(i,"liters",e.target.value)} placeholder="0"/></Field>
                      <Field l={`Fuel (${sym})`}><input style={sIn} type="number" step="0.01" value={pr.fuelAmt||""} onChange={e=>setStP(i,"fuelAmt",e.target.value)} placeholder="0.00"/></Field>
                      <div/>
                    </div>
                  : <Field l="Fuel Surcharge (%)">
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <input style={{...sIn,maxWidth:100}} type="number" step="0.1" value={pr.fuelPct||""} onChange={e=>setStP(i,"fuelPct",e.target.value)} placeholder="0"/>
                        <span style={{fontSize:11,color:T.muted}}>%</span>
                        {stc.f>0 && <span style={{fontSize:11,color:T.text}}>= {sym}{stc.f.toFixed(2)}</span>}
                      </div>
                    </Field>}
                {pr.fuelModel==="liter" && parseFloat(pr.liters)>0 && <div style={{fontSize:11,color:T.muted,marginBottom:6}}>Fuel: {pr.liters}L × {sym}{sched?.fuelPricePerLiter||"?"}/L = {sym}{(parseFloat(pr.fuelAmt)||0).toFixed(2)}</div>}
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:4}}>
                    <label style={sLbl}>Accessorial Charges</label>
                  </div>
                  <div style={{fontSize:11,color:T.muted,marginBottom:8}}>Extra services — each line can have its own tax.</div>
                  <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:4}}>
                    {["Description","Qty","Unit Price","Tax","Total",""].map((h,k)=><div key={k} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:k>=1&&k<=4?"right":"left"}}>{h}</div>)}
                  </div>
                  {(pr.other||[]).map((oc,j)=>{
                    const ltp=oc.taxMode==="HST"?13:oc.taxMode==="GST"?5:oc.taxMode==="CUSTOM"?(parseFloat(oc.taxCustom)||0):0;
                    const lbase=(oc.qty!==undefined||oc.unitPrice!==undefined)?(parseFloat(oc.qty)||0)*(parseFloat(oc.unitPrice)||0):(parseFloat(oc.amt)||0);
                    const ltax=lbase*(ltp/100); const ltot=lbase+ltax;
                    return <div key={j} style={{marginBottom:6}}>
                      <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,alignItems:"center"}}>
                        <input style={sIn} placeholder="Description..." value={oc.desc} onChange={e=>setStOc(i,j,"desc",e.target.value)}/>
                        <input style={{...sIn,textAlign:"right"}} type="number" value={oc.qty!==undefined?oc.qty:""} onChange={e=>setStOc(i,j,"qty",e.target.value)} placeholder="1"/>
                        <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={oc.unitPrice!==undefined?oc.unitPrice:""} onChange={e=>setStOc(i,j,"unitPrice",e.target.value)} placeholder="0.00"/>
                        <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={oc.taxMode||"NONE"} onChange={e=>setStOc(i,j,"taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select>
                        <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:ltot>0?"#22c55e":T.dim}}>{sym}{ltot.toFixed(2)}</div>
                        <button onClick={()=>delStOc(i,j)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
                      </div>
                      {ltax>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:30}}>Tax ({ltp}%): {sym}{ltax.toFixed(2)} · Base: {sym}{lbase.toFixed(2)}</div>}
                    </div>;
                  })}
                  <button style={{...bS,padding:"4px 10px",fontSize:11,marginTop:4}} onClick={()=>addStOc(i)}><Ic n="plus" s={10}/> Add Line</button>
                </div>
                <Field l="Tax on Base+FSC"><select style={sIn} value={pr.taxMode||"NONE"} onChange={e=>setStP(i,"taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select></Field>
                {pr.taxMode==="CUSTOM" && <Field l="Custom Tax (%)"><input style={sIn} type="number" step="0.01" value={pr.taxCustom||""} onChange={e=>setStP(i,"taxCustom",e.target.value)} placeholder="e.g. 20"/></Field>}
              </>}
            </div>
            {stc.total>0 && <div style={{borderTop:`1px solid ${T.border}`,marginTop:8,paddingTop:6,fontSize:13,fontWeight:700}}>Stop Total: {sym}{stc.total.toFixed(2)}</div>}
          </div>;
        })}
        <div style={{...sCrd,borderColor:"#0ea5e9",marginTop:4}}>
          <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>Order Total (all stops)</div>
          {(o[priceSide]||[]).map((st,i)=>{const t=calcStop(st.price).total;return t>0?<div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}><span style={{color:T.muted}}>{st.co||`Stop ${i+1}`}</span><span>{sym}{t.toFixed(2)}</span></div>:null;})}
          <div style={{borderTop:`1px solid ${T.border}`,marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:700}}><span>Grand Total</span><span style={{color:"#0ea5e9"}}>{sym}{orderGrandTotal.toFixed(2)} {p.cur}</span></div>
        </div>
      </div>}

      <Field l="Pricing Notes (internal only)"><textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={p.pricingNotes||""} onChange={e=>sp("pricingNotes",e.target.value)} placeholder="Rate agreements, negotiation details, special pricing terms..."/></Field>

      {/* Additional Charges / Event Lines — only for event orders */}
      {isEvent && <div style={{borderTop:`1px solid ${T.border}`,marginTop:14,paddingTop:12}}>
        <button onClick={()=>{
          const newVal = !showEventPricing;
          setShowEventPricing(newVal);
          sp("useEventPricing", newVal);
          if(newVal && (p.eventLines||[]).length===0) sp("eventLines",[emptyEventLine()]);
        }} style={{...bS,width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:showEventPricing?"rgba(14,165,233,0.08)":"transparent",border:`1px solid ${showEventPricing?"#0ea5e9":T.border}`}}>
          <span style={{color:showEventPricing?"#0ea5e9":T.muted,fontWeight:600,fontSize:12}}>📋 Additional Charges {showEventPricing?"(Active)":"(Optional)"}</span>
          <span style={{color:T.muted}}>{showEventPricing?"▲":"▼"}</span>
        </button>

        {showEventPricing && <div style={{marginTop:10,padding:12,background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
          <div style={{fontSize:11,color:T.muted,marginBottom:10}}>Ground crew, limo service, supervisors, other charges — each line can have its own tax.</div>

          {/* Column headers */}
          <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,marginBottom:4}}>
            {["Description","Qty","Unit Price","Tax","Total",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=1&&i<=4?"right":"left"}}>{h}</div>)}
          </div>

          {(p.eventLines||[]).map((line,idx)=>{
            const lineTaxPct = line.taxMode==="HST"?13:line.taxMode==="GST"?5:line.taxMode==="CUSTOM"?(parseFloat(line.taxCustom)||0):0;
            const lineBase=(parseFloat(line.qty)||0)*(parseFloat(line.unitPrice)||0);
            const lineTaxAmt=lineBase*(lineTaxPct/100);
            const lineTotal=lineBase+lineTaxAmt;
            return <div key={line.id||idx} style={{marginBottom:6}}>
              <div style={{display:"grid",gridTemplateColumns:"2fr 60px 80px 130px 70px 24px",gap:6,alignItems:"center"}}>
                <input style={sIn} value={line.desc} onChange={e=>sel(idx,"desc",e.target.value)} placeholder="Description..."/>
                <input style={{...sIn,textAlign:"right"}} type="number" value={line.qty} onChange={e=>sel(idx,"qty",e.target.value)} placeholder="1"/>
                <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={line.unitPrice} onChange={e=>sel(idx,"unitPrice",e.target.value)} placeholder="0.00"/>
                <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={line.taxMode||"NONE"} onChange={e=>sel(idx,"taxMode",e.target.value)}>
                  {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
                </select>
                <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:lineTotal>0?"#22c55e":T.dim}}>{sym}{lineTotal.toFixed(2)}</div>
                <button onClick={()=>sp("eventLines",(p.eventLines||[]).filter((_,j)=>j!==idx))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
              </div>
              {lineTaxAmt>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:34}}>
                Tax ({lineTaxPct}%): {sym}{lineTaxAmt.toFixed(2)} · Base: {sym}{lineBase.toFixed(2)}
              </div>}
            </div>;
          })}

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
            <button style={{...bS,padding:"4px 10px",fontSize:11}} onClick={()=>sp("eventLines",[...(p.eventLines||[]),emptyEventLine()])}><Ic n="plus" s={10}/> Add Line</button>
            <div style={{textAlign:"right"}}>
              {(()=>{
                const addlTotal=(p.eventLines||[]).reduce((s,l)=>{
                  const ltp=l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
                  const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
                  return s+lb+lb*(ltp/100);
                },0);
                const grandTotal=transportTotal+addlTotal;
                return <>
                  <div style={{fontSize:12,color:T.muted}}>Additional: {sym}{addlTotal.toFixed(2)}</div>
                  <div style={{fontSize:14,fontWeight:700,color:"#0ea5e9"}}>Grand Total: {sym}{grandTotal.toFixed(2)} {p.cur}</div>
                </>;
              })()}
            </div>
          </div>
        </div>}
      </div>}
      <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
        <button style={{...sBtn,background:"#0ea5e9"}} onClick={()=>{savOrd({...o,status:"completed"});go("od",o);}}><Ic n="dollar" s={13}/> Save Pricing</button>
        <button style={bS} onClick={()=>go("od",o)}>Cancel</button>
      </div>
    </div>
  </div>
  {showEmailModal && <AccountingEmailModal
    showCsvOption={!!(p.base && parseFloat(p.base)>0) || (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0)}
    onSend={async(emails,msg,attachCsv)=>{setShowEmailModal(false);if(pendingSave)await savOrd({...o,status:"completed"});await emailAcct(emails,msg,attachCsv);setPendingSave(false);}}
    onSkipEmail={async()=>{setShowEmailModal(false);await savOrd({...o,status:"closed",billingType:"invoiced"});setPendingSave(false);go("ol",null,{highlightBol:o.bol});}}
    onCancel={()=>{setShowEmailModal(false);setPendingSave(false);}}
  />}
  </>;
}

// ═══ DUPLICATE ORDER MODAL ═══
function DuplicateModal({o, onConfirm, onCancel}) {
  const [copies, setCopies] = useState(1);
  const [mode, setMode] = useState("weekday"); // weekday | copies
  const [weekday, setWeekday] = useState(1); // 0=Sun, 1=Mon...
  const [startDate, setStartDate] = useState("");
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  // Calculate next N occurrences of the chosen weekday from startDate
  const getOccurrences = () => {
    if(!startDate) return [];
    const base = new Date(startDate+"T12:00:00");
    const dates = [];
    let current = new Date(base);
    // Find first occurrence of chosen weekday on or after startDate
    while(current.getDay() !== parseInt(weekday)) {
      current.setDate(current.getDate()+1);
    }
    for(let i=0;i<copies;i++) {
      dates.push(new Date(current));
      current.setDate(current.getDate()+7);
    }
    return dates;
  };

  const occurrences = mode==="weekday" ? getOccurrences() : [];
  const canConfirm = copies>=1 && copies<=20 && (mode==="copies" || startDate);

  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:24,width:400,maxWidth:"95vw",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Duplicate BOL {o.bol}</div>
      <div style={{fontSize:11,color:T.muted,marginBottom:16}}>New orders will copy all details except dates, driver, and status (Unassigned).</div>

      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <button onClick={()=>setMode("weekday")} style={{flex:1,padding:"8px",borderRadius:6,border:`1px solid ${mode==="weekday"?T.red:T.border}`,background:mode==="weekday"?"rgba(220,38,38,0.08)":"transparent",color:mode==="weekday"?T.red:T.muted,fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>Repeat on weekday</button>
        <button onClick={()=>setMode("copies")} style={{flex:1,padding:"8px",borderRadius:6,border:`1px solid ${mode==="copies"?T.red:T.border}`,background:mode==="copies"?"rgba(220,38,38,0.08)":"transparent",color:mode==="copies"?T.red:T.muted,fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>Just duplicate</button>
      </div>

      {mode==="weekday" && <>
        <div style={{marginBottom:10}}>
          <label style={sLbl}>Repeat on</label>
          <select style={sIn} value={weekday} onChange={e=>setWeekday(e.target.value)}>
            {DAYS.map((d,i)=><option key={i} value={i}>{d}</option>)}
          </select>
        </div>
        <div style={{marginBottom:10}}>
          <label style={sLbl}>Starting from</label>
          <DatePicker value={startDate} onChange={v=>setStartDate(v)} placeholder="Select start date..."/>
        </div>
      </>}

      <div style={{marginBottom:14}}>
        <label style={sLbl}>Number of copies (max 20)</label>
        <input type="number" min={1} max={20} style={sIn} value={copies} onChange={e=>setCopies(Math.min(20,Math.max(1,parseInt(e.target.value)||1)))}/>
      </div>

      {mode==="weekday" && occurrences.length>0 && <div style={{...sCrd,padding:10,marginBottom:14,background:T["bg"]}}>
        <div style={{fontSize:10,color:T.muted,fontWeight:600,marginBottom:6,textTransform:"uppercase"}}>Will create {copies} order{copies>1?"s":""}:</div>
        {occurrences.map((d,i)=><div key={i} style={{fontSize:11,color:T.text,marginBottom:2}}>
          #{i+1} — {DAYS[d.getDay()]} {d.toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"})}
        </div>)}
      </div>}

      {mode==="copies" && <div style={{...sCrd,padding:10,marginBottom:14,background:T["bg"]}}>
        <div style={{fontSize:11,color:T.muted}}>{copies} blank cop{copies>1?"ies":"y"} will be created with no dates set — you can fill them in after.</div>
      </div>}

      <div style={{display:"flex",gap:8}}>
        <button style={{...sBtn,background:"#3b82f6",opacity:canConfirm?1:0.4,cursor:canConfirm?"pointer":"not-allowed"}} disabled={!canConfirm} onClick={()=>onConfirm(copies, mode==="weekday"?occurrences:[])}>
          <Ic n="plus" s={13}/> Create {copies} Order{copies>1?"s":""}
        </button>
        <button style={bS} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>;
}

// ═══ NO INVOICE REASON MODAL ═══
function NoInvoiceReasonModal({onConfirm, onCancel}) {
  const [reason, setReason] = useState("");
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:24,width:380,maxWidth:"90vw",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Complete at No Charge</div>
      <div style={{fontSize:11,color:T.muted,marginBottom:16}}>Please provide a reason — this will be saved with the order.</div>
      <Field l="Reason (required)">
        <textarea style={{...sIn,minHeight:70,resize:"vertical"}} value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. Internal move, no charge, owner operator, etc."/>
      </Field>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <button style={{...sBtn,background:"#eab308",color:"#000",opacity:reason.trim()?1:0.4,cursor:reason.trim()?"pointer":"not-allowed"}} disabled={!reason.trim()} onClick={()=>onConfirm(reason.trim())}>✓ Confirm</button>
        <button style={bS} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>;
}

// ═══ ACCOUNTING EMAIL MODAL ═══
function AccountingEmailModal({onSend, onCancel, onSkipEmail, showCsvOption=false}) {
  const [checked, setChecked] = useState(ACCT_EMAILS.map(()=>false));
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState("");
  const [attachCsv, setAttachCsv] = useState(showCsvOption);
  const allSelected = checked.every(Boolean);
  const toggle = i => setChecked(c => c.map((v,j)=>j===i?!v:v));
  const toggleAll = () => setChecked(ACCT_EMAILS.map(()=>!allSelected));
  const selected = ACCT_EMAILS.filter((_,i)=>checked[i]).map(x=>x.email);
  if(custom.trim()) selected.push(...custom.split(",").map(e=>e.trim()).filter(Boolean));
  const canSend = selected.length > 0;
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:24,width:400,maxWidth:"90vw",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Send Invoice to Accounting</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{fontSize:11,color:T.muted}}>Select recipients</div>
        <button onClick={toggleAll} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:4,color:T.muted,fontSize:10,cursor:"pointer",padding:"2px 8px",fontFamily:"inherit"}}>{allSelected?"Deselect All":"Select All"}</button>
      </div>
      {ACCT_EMAILS.map((a,i)=><label key={a.email} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:6,cursor:"pointer",background:checked[i]?"rgba(220,38,38,0.08)":"transparent",border:`1px solid ${checked[i]?T.red:T.border}`,marginBottom:6}}>
        <input type="checkbox" checked={checked[i]} onChange={()=>toggle(i)} style={{accentColor:T.red,width:14,height:14}}/>
        <div>
          <div style={{fontSize:12,fontWeight:500}}>{a.label}</div>
          <div style={{fontSize:10,color:T.muted}}>{a.email}</div>
        </div>
      </label>)}
      <div style={{marginTop:10,marginBottom:10}}>
        <label style={sLbl}>Other email(s) — comma separated</label>
        <input style={sIn} value={custom} onChange={e=>setCustom(e.target.value)} placeholder="other@example.com, another@example.com"/>
      </div>
      <div style={{marginBottom:16}}>
        <label style={sLbl}>Message to accounting <span style={{color:T.dim,fontWeight:400}}>(optional — included in email body)</span></label>
        <textarea
          style={{...sIn, minHeight:72, resize:"vertical"}}
          value={message}
          onChange={e=>setMessage(e.target.value)}
          placeholder="e.g. Please process this invoice by end of week. PO# attached."
        />
      </div>
      {showCsvOption && <div style={{marginBottom:14}}>
        <label style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,cursor:"pointer",background:attachCsv?"rgba(0,181,216,0.08)":"transparent",border:`1px solid ${attachCsv?"#00B5D8":T.border}`}}>
          <input type="checkbox" checked={attachCsv} onChange={e=>setAttachCsv(e.target.checked)} style={{accentColor:"#00B5D8",width:14,height:14}}/>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:attachCsv?"#00B5D8":T.muted}}>🔗 Attach Xero CSV</div>
            <div style={{fontSize:10,color:T.dim}}>Xero_BOL{/* bol# filled at send time */}.csv will be included as an attachment</div>
          </div>
        </label>
      </div>}
      <div style={{display:"flex",gap:8}}>
        <button style={{...sBtn,background:"#06b6d4",opacity:canSend?1:0.4,cursor:canSend?"pointer":"not-allowed"}} disabled={!canSend} onClick={()=>onSend(selected, message.trim(), attachCsv)}>
          <Ic n="mail" s={13}/> Send to {selected.length} recipient{selected.length!==1?"s":""}
        </button>
        <button style={bS} onClick={onCancel}>Cancel</button>
      </div>
      {onSkipEmail && <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}}>
        <button style={{...bS,width:"100%",borderColor:"#22c55e",color:"#22c55e",justifyContent:"center",opacity:canSend?0.3:1,cursor:canSend?"not-allowed":"pointer"}} disabled={canSend} onClick={onSkipEmail}>
          <Ic n="check" s={13}/> Mark Invoiced — No Email
        </button>
        <div style={{fontSize:10,color:T.dim,marginTop:6,textAlign:"center"}}>{canSend?"Uncheck all recipients to use this option":"For orders already invoiced in Xero — closes without sending"}</div>
      </div>}
    </div>
  </div>;
}

// ═══ STATUS CHANGER ═══
const STATUS_FLOW = [
  {s:"unassigned", l:"Unassigned", c:"#ef4444"},
  {s:"assigned", l:"Assigned / In Progress", c:"#f59e0b"},
  {s:"in-transit", l:"In Transit", c:"#8b5cf6"},
  {s:"ready-to-bill", l:"Ready to Bill", c:"#f97316"},
  {s:"closed", l:"Closed", c:"#22c55e"},
  {s:"invoiced", l:"Invoiced", c:"#06b6d4"},
  {s:"cancelled", l:"Cancelled", c:"#64748b"},
];
// Statuses that can be moved backward to (ordered by pipeline position)
const STATUS_ORDER = ["unassigned","assigned","in-transit","ready-to-bill","closed","invoiced","cancelled"];
function StatusChanger({current, onChange, orderType}) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(()=>{
    if(!open) return;
    const h = e => { if(ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return ()=>document.removeEventListener("mousedown", h);
  },[open]);
  // Map legacy statuses to their equivalent position
  const LEGACY_MAP = {"completed":"ready-to-bill","pod-received":"ready-to-bill","completed-noinvoice":"ready-to-bill","no-charge":"closed"};
  const mapped = LEGACY_MAP[current] || current;
  const currentIdx = STATUS_ORDER.indexOf(mapped);
  // For event orders — only allow moving back to ready-to-bill or unassigned
  const allowed = STATUS_FLOW.filter(x => {
    if(x.s === current) return false;
    if(x.s === "cancelled") return false;
    if(orderType === "event") return ["unassigned","assigned","ready-to-bill"].includes(x.s) && STATUS_ORDER.indexOf(x.s) < currentIdx;
    return STATUS_ORDER.indexOf(x.s) < currentIdx;
  });
  if(allowed.length === 0) return null;
  const prevStatus = allowed[allowed.length-1]; // most recent previous step
  return <div ref={ref} style={{position:"relative",display:"inline-block"}}>
    <button style={{...bS,borderColor:"#334155"}} onClick={()=>setOpen(o=>!o)}>
      ⟳ Move Back Status{allowed.length===1?` to ${prevStatus.l}`:""} <span style={{fontSize:9,marginLeft:2}}>▼</span>
    </button>
    {open && <div style={{position:"absolute",top:"100%",right:0,zIndex:999,marginTop:4,background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:6,minWidth:220,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
      <div style={{fontSize:9,color:T.dim,padding:"4px 8px",textTransform:"uppercase",fontWeight:600,letterSpacing:0.5}}>Move order back to</div>
      {allowed.map(x=><button key={x.s} onClick={()=>{setOpen(false);onChange(x.s);}} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 12px",background:"transparent",border:"none",color:T.text,fontSize:12,cursor:"pointer",borderRadius:4,fontFamily:"inherit"}}>
        <span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:x.c,marginRight:8}}/>
        {x.l}
      </button>)}
    </div>}
  </div>;
}

// ═══ INVOICED MODAL ═══
function InvoicedModal({onSave, onClose, initNum="", initDate="", clientBillingEmail=[], order}) {
  const [invNum, setInvNum] = useState(initNum);
  const [invDate, setInvDate] = useState(initDate||new Date().toISOString().slice(0,10));
  const [xeroFile, setXeroFile] = useState(null);
  const [xeroUrl, setXeroUrl] = useState(order?.xeroInvoiceUrl||null);
  const [xeroFileName, setXeroFileName] = useState(order?.xeroInvoiceFile||null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sendPkg, setSendPkg] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const initEmails = Array.isArray(clientBillingEmail) ? clientBillingEmail : (clientBillingEmail ? [clientBillingEmail] : []);
  const [emails, setEmails] = useState(initEmails);
  // Accounting team — all checked by default
  const [acctChecked, setAcctChecked] = useState(ACCT_EMAILS.map(()=>true));
  const [saving, setSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");

  const handleFile = async (file) => {
    if(!file || file.type!=="application/pdf") { alert("Please upload a PDF file."); return; }
    setXeroFile(file);
    setUploading(true);
    try {
      const result = await uploadFile(file, `invoices/${order?.bol||"order"}`);
      setXeroUrl(result.url);
      setXeroFileName(result.name);
    } catch(e) { alert("Upload failed: "+e.message); setXeroFile(null); }
    setUploading(false);
  };

  const addEmail = () => {
    const e = emailInput.trim();
    if(e && !emails.includes(e)) setEmails(p=>[...p,e]);
    setEmailInput("");
  };

  const allEmails = [...new Set([...emails, ...ACCT_EMAILS.filter((_,i)=>acctChecked[i]).map(a=>a.email)])];

  const handleSave = async () => {
    setSaving(true);
    await onSave(invNum, invDate, xeroUrl, xeroFileName, sendPkg, allEmails, emailMsg);
    setSaving(false);
  };

  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:T.card,borderRadius:12,padding:24,width:"100%",maxWidth:480,boxShadow:"0 20px 60px rgba(0,0,0,0.5)",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:16}}>✓ Mark as Invoiced</div>

      {/* Invoice # and date */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div>
          <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:4}}>Invoice # (optional)</label>
          <input value={invNum} onChange={e=>setInvNum(e.target.value)} placeholder="e.g. INV-2026-001"
            style={{width:"100%",padding:"8px 10px",borderRadius:6,border:`1px solid ${T.border}`,background:T.bg,color:T.text,fontSize:12,fontFamily:"inherit",boxSizing:"border-box"}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:4}}>Invoice Sent Date</label>
          <input type="date" value={invDate} onChange={e=>setInvDate(e.target.value)}
            style={{width:"100%",padding:"8px 10px",borderRadius:6,border:"1px solid #0ea5e9",background:"#1e293b",color:"#f1f5f9",fontSize:12,fontFamily:"inherit",boxSizing:"border-box",colorScheme:"dark"}}/>
        </div>
      </div>

      {/* Xero invoice upload */}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:6}}>Xero Invoice PDF (optional)</label>
        <div
          onDragOver={e=>{e.preventDefault();setDragging(true);}}
          onDragLeave={()=>setDragging(false)}
          onDrop={e=>{e.preventDefault();setDragging(false);handleFile(e.dataTransfer.files[0]);}}
          style={{border:`2px dashed ${dragging?"#0ea5e9":xeroUrl?"#22c55e":T.border}`,borderRadius:8,padding:"16px",textAlign:"center",cursor:"pointer",background:dragging?"rgba(14,165,233,0.05)":xeroUrl?"rgba(34,197,94,0.05)":"transparent",transition:"all 0.2s"}}
          onClick={()=>document.getElementById("xeroFileInput").click()}>
          {uploading
            ? <div style={{fontSize:12,color:"#0ea5e9"}}>⏳ Uploading to Firebase...</div>
            : xeroUrl
              ? <div style={{fontSize:12,color:"#22c55e",fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <span>✅ {xeroFileName||"Xero invoice uploaded"}<br/><span style={{fontSize:10,color:T.muted,fontWeight:400}}>Click to replace</span></span>
                  <span onClick={e=>{e.stopPropagation();setXeroUrl(null);setXeroFileName(null);setXeroFile(null);}} style={{marginLeft:8,color:"#ef4444",fontSize:11,fontWeight:700,cursor:"pointer",padding:"2px 6px",borderRadius:4,border:"1px solid #ef4444",background:"rgba(239,68,68,0.08)"}} title="Remove Xero PDF">✕ Remove</span>
                </div>
              : <div style={{fontSize:12,color:T.muted}}>📎 Drop Xero invoice PDF here<br/><span style={{fontSize:11}}>or click to browse</span></div>
          }
        </div>
        <input id="xeroFileInput" type="file" accept="application/pdf" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
      </div>

      {/* Send package toggle */}
      <div style={{marginBottom:14,padding:"10px 12px",borderRadius:8,border:`1px solid ${T.border}`,background:T.surface}}>
        <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
          <input type="checkbox" checked={sendPkg} onChange={e=>setSendPkg(e.target.checked)} style={{width:16,height:16,cursor:"pointer"}}/>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:T.text}}>Send invoice package to client</div>
            <div style={{fontSize:10,color:T.muted,marginTop:2}}>BOL {xeroUrl?"+ Xero invoice PDF ":""} will be emailed</div>
          </div>
        </label>
      </div>

      {/* Email list */}
      {sendPkg && <div style={{marginBottom:14}}>
        {/* Client billing emails */}
        <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:6}}>Client recipients</label>
        <div style={{display:"flex",gap:6,marginBottom:6}}>
          <input value={emailInput} onChange={e=>setEmailInput(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"||e.key===","){e.preventDefault();addEmail();}}}
            placeholder="Add client email..."
            style={{padding:"7px 10px",borderRadius:6,border:`1px solid ${T.border}`,background:T.bg,color:T.text,fontSize:12,fontFamily:"inherit",flex:1}}/>
          <button onClick={addEmail} style={{padding:"7px 14px",borderRadius:6,background:"#334155",color:"#f1f5f9",border:`1px solid ${T.border}`,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>Add</button>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
          {emails.map(e=><div key={e} style={{display:"flex",alignItems:"center",gap:4,background:"rgba(14,165,233,0.1)",border:"1px solid #0ea5e9",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#0ea5e9"}}>
            {e}<button onClick={()=>setEmails(p=>p.filter(x=>x!==e))} style={{background:"none",border:"none",color:"#0ea5e9",cursor:"pointer",fontSize:12,padding:0,lineHeight:1,marginLeft:2}}>×</button>
          </div>)}
          {emails.length===0 && <div style={{fontSize:11,color:T.muted}}>No client emails — package will only go to DBX team</div>}
        </div>

        {/* DBX accounting team */}
        <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:6}}>DBX team (uncheck to exclude)</label>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {ACCT_EMAILS.map((a,i)=>(
            <label key={a.email} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:6,cursor:"pointer",background:acctChecked[i]?"rgba(220,38,38,0.06)":"transparent",border:`1px solid ${acctChecked[i]?T.red:T.border}`}}>
              <input type="checkbox" checked={acctChecked[i]} onChange={()=>setAcctChecked(p=>p.map((v,j)=>j===i?!v:v))} style={{accentColor:T.red,width:13,height:13,cursor:"pointer"}}/>
              <span style={{fontSize:11,color:T.text,flex:1}}>{a.label}</span>
              <span style={{fontSize:10,color:T.muted}}>{a.email}</span>
            </label>
          ))}
        </div>
        {allEmails.length===0 && <div style={{fontSize:11,color:"#ef4444",marginTop:6}}>⚠ No recipients selected</div>}
      </div>}

      {/* Optional message to client */}
      {sendPkg && <div style={{marginBottom:14}}>
        <label style={{fontSize:11,color:T.muted,display:"block",marginBottom:4}}>Message to client (optional)</label>
        <textarea value={emailMsg} onChange={e=>setEmailMsg(e.target.value)}
          placeholder={`e.g. Hi, please find attached our invoice ${invNum} for your records.`}
          style={{width:"100%",padding:"8px 10px",borderRadius:6,border:`1px solid ${T.border}`,background:T.bg,color:T.text,fontSize:12,fontFamily:"inherit",boxSizing:"border-box",minHeight:70,resize:"vertical",outline:"none"}}/>
      </div>}

      <div style={{display:"flex",gap:8,marginTop:4}}>
        <button onClick={handleSave} disabled={saving||uploading||(sendPkg&&allEmails.length===0)}
          style={{flex:1,padding:"9px",borderRadius:7,background:"#0ea5e9",color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:600,fontFamily:"inherit",opacity:(saving||uploading||(sendPkg&&emails.length===0))?0.6:1}}>
          {saving?"Saving...":uploading?"Uploading...":"Confirm"}
        </button>
        <button onClick={onClose} style={{flex:1,padding:"9px",borderRadius:7,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,cursor:"pointer",fontSize:13,fontFamily:"inherit"}}>Cancel</button>
      </div>
    </div>
  </div>;
}

// ═══ PO EDITOR — inline edit on order detail ═══
function PoEditor({o, savOrd}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(o.poNumber||"");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    await savOrd({...o, poNumber:val.trim()});
    setSaving(false);
    setEditing(false);
  };
  return <div style={{marginTop:8,marginBottom:4,padding:"8px 10px",borderRadius:6,background:o.poNumber?"rgba(34,197,94,0.08)":"rgba(249,115,22,0.08)",border:`1px solid ${o.poNumber?"#22c55e":"#f97316"}`}}>
    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <span style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase"}}>PO #</span>
      {!editing
        ? <>
            {o.poNumber
              ? <>
                  <strong style={{fontSize:12,color:"#22c55e"}}>{o.poNumber}</strong>
                  <button onClick={()=>{setVal(o.poNumber||"");setEditing(true);}} style={{marginLeft:"auto",fontSize:10,padding:"2px 8px",borderRadius:4,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"inherit"}}>Edit</button>
                </>
              : <>
                  <span style={{fontSize:11,color:"#f97316",fontWeight:600}}>⚠ Not yet entered</span>
                  <button onClick={()=>{setVal("");setEditing(true);}} style={{fontSize:11,padding:"4px 12px",borderRadius:5,border:"none",background:"#f97316",color:"#fff",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>+ Enter PO #</button>
                </>
            }
          </>
        : <>
            <input autoFocus value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")save();if(e.key==="Escape")setEditing(false);}}
              style={{...sIn,flex:1,minWidth:120,padding:"4px 8px",fontSize:12}} placeholder="Enter PO number..."/>
            <button onClick={save} disabled={saving} style={{...sBtn,background:"#22c55e",padding:"4px 10px",fontSize:11}}>{saving?"Saving...":"Save"}</button>
            <button onClick={()=>setEditing(false)} style={{...bS,padding:"4px 10px",fontSize:11}}>Cancel</button>
          </>
      }
    </div>
  </div>;
}

// ═══ ORDER DETAIL ═══
function OrderDetail({o, db, go, setStat, delOrd, savOrd, dupOrd}) {
  const [sending, setSending] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [showDupModal, setShowDupModal] = useState(false);
  const [showInvoicedModal, setShowInvoicedModal] = useState(false);
  const div = DIVS.find(d=>d.id===o.divId); const p=o.price||{}; const sym=csym(p.cur);
  const isEvent = o.orderType === "event";
  const cli = db.clients.find(c=>c.id===o.cliId) || null;
  // Check for pricing: order-level (base, eventLines) OR per-stop (delStops/pickStops with price.base)
  const _nP=(o.pickStops||[]).length, _nD=(o.delStops||[]).length;
  const _priceSide=_nD>=_nP?"delStops":"pickStops";
  const _checkStopPrice = (stops) => (stops||[]).some(st=>{
    const pr=st.price||{}; const b=parseFloat(pr.base)||0;
    const f=pr.fuelModel==="liter"?(parseFloat(pr.fuelAmt)||0):(b*((parseFloat(pr.fuelPct)||0)/100));
    const oth=(pr.other||[]).reduce((s,c)=>{const lb=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);return s+lb;},0);
    return (b+f+oth)>0;
  });
  const hasStopPricing = _checkStopPrice(o.delStops) || _checkStopPrice(o.pickStops);
  const hasOrderPrice = (parseFloat(o.price?.base)||0)>0;
  const hasEvtLinesPrice = (o.price?.eventLines||[]).some(l=>parseFloat(l.unitPrice)>0);
  const hasAnyPricing = hasOrderPrice || hasEvtLinesPrice || hasStopPricing;

  const allOrderDrivers = [{drvName:o.drvName?.split(", ")[0]||o.drvName, drvEmail:o.drvEmail, trkUnit:o.trkUnit, trkPlate:o.trkPlate, trlUnit:o.trlUnit, trlPlate:o.trlPlate}, ...(o.extraDrivers||[])].filter(d=>d.drvName);
  const emailDriver = async (driverIdx=0) => {
    const drv = allOrderDrivers[driverIdx];
    const email = drv?.drvEmail || prompt(`Email for ${drv?.drvName||"driver"}:`); if(!email) return;
    setSending(true);
    try {
      await callCloudFn("sendBolEmail", {
        order: { ...o, divName: div?.name || "" },
        client: cli ? { name:cli.name||"", street:cli.street||"", city:cli.city||"", provState:cli.provState||"", postalZip:cli.postalZip||"", country:cli.country||"", email:cli.billingEmail||cli.email||"" } : null,
        toEmail: email,
        subject: `BOL ${o.bol} — ${o.cliName}`,
        includeAttachments: true,
      });
      alert(`BOL PDF emailed to ${drv?.drvName||"driver"}!`);
    } catch(e) { console.error(e); alert("Failed to send. Check Cloud Function setup."); }
    setSending(false);
  };

  const emailAcctFromDetail = async (emails, message="", attachCsv=false) => {
    setSending(true);
    const cli = db.clients.find(c=>c.id===o.cliId);
    const xeroCSVBase64 = attachCsv ? btoa(unescape(encodeURIComponent(buildXeroCsvString(o, p)))) : null;
    try {
      for(const email of emails) {
        await callCloudFn("sendInvoiceEmail", {
          order: { ...o, divName: div?.name || "" },
          pricing: { ...p, billingEmail: cli?.billingEmail || "" },
          client: cli ? {
            name: cli.name||"",
            street: cli.street||"",
            city: cli.city||"",
            provState: cli.provState||"",
            postalZip: cli.postalZip||"",
            country: cli.country||"",
            contact: cli.contact||"",
            phone: cli.phone||"",
            email: cli.billingEmail||cli.email||"",
          } : null,
          toEmail: email,
          subject: `Invoice — BOL ${o.bol} — ${o.cliName}`,
          orderFiles: (o.files||[]).map(f=>({name:f.name, url:f.url||f.data})),
          emailMsg: message,
          xeroCSVBase64,
          xeroCSVFilename: `Xero_BOL${o.bol}.csv`,
        });
      }
      alert(`Invoice emailed to: ${emails.join(", ")}`);
    } catch(e) { console.error(e); alert("Failed to send. Check Cloud Function setup."); }
    setSending(false);
  };

  // Confirm popup + change status + go back to orders list
  const confirmStatus = async (newStatus, msg, extraFields={}) => {
    if(!window.confirm(msg)) return;
    const updated = {...o, status:newStatus, ...extraFields};
    await savOrd(updated);
    go("od", updated);
  };

  return <><div style={{padding:20}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
      <button onClick={()=>go("ol")} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex"}}><Ic n="back"/></button>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>BOL {o.bol}</h1>
      <Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/>
      {div && <span style={{fontSize:10,color:T.muted,background:T["bg"],padding:"2px 8px",borderRadius:10}}>{div.short}</span>}
    </div>

    {/* Action buttons */}
    <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}} className="no-print">
      {/* PDF buttons — one per driver */}
      {(()=>{
        const allDrv = [{drvName:o.drvName?.split(", ")[0]||o.drvName||"Driver 1"}, ...(o.extraDrivers||[])];
        const hasMulti = allDrv.length > 1;
        return allDrv.map((d,i)=><span key={i} style={{display:"inline-flex",gap:4,flexWrap:"wrap"}}>
          {hasMulti && <span style={{fontSize:10,color:T.muted,alignSelf:"center",whiteSpace:"nowrap"}}>{d.drvName||`Driver ${i+1}`}:</span>}
          <button style={bS} onClick={()=>downloadBolPdf(o,div,false,false,i,cli)}><Ic n="pdf" s={13}/> PDF</button>
          {isEvent
            ? <button style={bS} onClick={()=>downloadBolPdf(o,div,false,true,i,cli)}><Ic n="pdf" s={13}/> +Price</button>
            : o.price?.base && parseFloat(o.price.base)>0 && <button style={bS} onClick={()=>downloadBolPdf(o,div,false,true,i,cli)}><Ic n="pdf" s={13}/> +Price</button>}
          {o.podBy && <button style={bS} onClick={()=>downloadBolPdf(o,div,true,false,i,cli)}><Ic n="pdf" s={13}/> +POD</button>}
          {o.podBy && o.price?.base && parseFloat(o.price.base)>0 && <button style={bS} onClick={()=>downloadBolPdf(o,div,true,true,i,cli)}><Ic n="pdf" s={13}/> +POD+Price</button>}
        </span>);
      })()}
      <button style={bS} onClick={()=>go("oe",{o:{...o,items:[...o.items.map(i=>({...i}))]},mode:"edit"})}><Ic n="edit" s={13}/> Edit</button>

      {/* UNASSIGNED */}
      {o.status==="unassigned" && <>
        {!isEvent && <button style={{...sBtn,background:"#3b82f6"}} onClick={()=>go("oa",o)}><Ic n="truck" s={13}/> Assign</button>}
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="edit" s={13}/> Enter POD</button>}
        {isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {o.price?.base?"Edit Pricing":"+ Add Pricing"}</button>}
        {isEvent && <button style={{...sBtn,background:"#f59e0b",color:"#000"}} onClick={()=>confirmStatus("assigned",`Mark BOL ${o.bol} as In Progress?`)}>▶ In Progress</button>}
      </>}

      {/* ASSIGNED / IN PROGRESS */}
      {o.status==="assigned" && <>
        {!isEvent && <button style={{...sBtn,background:"#3b82f6"}} onClick={()=>go("oa",o)}><Ic n="edit" s={13}/> Reassign</button>}
        {!isEvent && <button style={{...sBtn,background:"#8b5cf6"}} onClick={()=>confirmStatus("in-transit",`Move BOL ${o.bol} to In Transit?`)}>In Transit</button>}
        {!isEvent && allOrderDrivers.map((d,i)=><button key={i} style={bS} disabled={sending} onClick={()=>emailDriver(i)}><Ic n="mail" s={13}/> Email {allOrderDrivers.length>1?d.drvName||`Driver ${i+1}`:"Driver"}</button>)}
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="edit" s={13}/> Enter POD</button>}
        {isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {o.price?.base?"Edit Pricing":"+ Add Pricing"}</button>}
        {isEvent && <button style={{...sBtn,background:"#f97316"}} onClick={()=>confirmStatus("ready-to-bill",`Mark BOL ${o.bol} as Ready to Bill?`)}>Ready to Bill</button>}
      </>}

      {/* IN TRANSIT */}
      {o.status==="in-transit" && <>
        {!isEvent && <button style={{...sBtn,background:"#0ea5e9"}} onClick={async()=>{
          const noPod = !o.podBy;
          const msg = noPod
            ? `No POD information has been entered.\n\nAre you sure you want to mark BOL ${o.bol} as Ready to Bill?`
            : `Mark BOL ${o.bol} as Ready to Bill?`;
          await confirmStatus("ready-to-bill", msg);
        }}>Ready to Bill</button>}
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="check" s={13}/> {o.podBy?"Edit POD":"Enter POD"}</button>}
        {!isEvent && allOrderDrivers.map((d,i)=><button key={i} style={bS} disabled={sending} onClick={()=>emailDriver(i)}><Ic n="mail" s={13}/> {allOrderDrivers.length>1?`Email ${d.drvName||`Driver ${i+1}`}`:"Email Driver"}</button>)}
        {isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {o.price?.base?"Edit Pricing":"+ Add Pricing"}</button>}
        {isEvent && <button style={{...sBtn,background:"#0ea5e9"}} onClick={()=>confirmStatus("ready-to-bill",`Mark BOL ${o.bol} as Ready to Bill?`)}>Ready to Bill</button>}
      </>}

      {/* READY TO BILL — legacy statuses treated same */}
      {["ready-to-bill","pod-received","completed","completed-noinvoice"].includes(o.status) && <>
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="edit" s={13}/> {o.podBy?"Edit POD":"Enter POD"}</button>}
        <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {hasAnyPricing?"Edit Pricing":"Add Pricing"}</button>
        {(()=>{
          const evtLinesTotal = (o.price?.eventLines||[]).reduce((s,l)=>(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0)+s,0);
          const hasPrice = hasAnyPricing || evtLinesTotal>0;
          return hasPrice
          ? <button style={{...sBtn,background:"#22c55e"}} disabled={sending} onClick={()=>{
              if(o.poRequired && !o.poNumber) {
                if(!window.confirm("⚠ This order requires a PO number.\n\nContinue without PO?")) return;
              }
              setShowEmailModal(true);
            }}><Ic n="mail" s={13}/> {sending?"Sending...":"Invoice & Email Accounting"}</button>
          : <span style={{fontSize:11,color:"#ef4444",alignSelf:"center"}}>⚠ Enter a price &gt; $0 to invoice</span>;
        })()}
        {o.poRequired && !o.poNumber && hasAnyPricing && <span style={{fontSize:11,color:"#f97316",alignSelf:"center"}}>⚠ PO # missing</span>}
        {(()=>{
          const hasPricing = hasAnyPricing;
          return hasPricing
            ? <button style={{...sBtn,background:"#eab308",color:"#000",opacity:0.4,cursor:"not-allowed"}} disabled title="Remove pricing first">✓ Close at No Charge</button>
            : <button style={{...sBtn,background:"#eab308",color:"#000"}} onClick={()=>setShowReasonModal(true)}>✓ Close at No Charge</button>;
        })()}
      </>}

      {/* CLOSED */}
      {o.status==="closed" && o.billingType!=="no-charge" && <button style={{...sBtn,background:"#0ea5e9",color:"#fff",border:"none"}} onClick={()=>setShowInvoicedModal(true)}><Ic n="check" s={13}/> Mark as Invoiced</button>}
      {o.status==="invoiced" && <button onClick={()=>setShowInvoicedModal(true)} style={{padding:"6px 12px",borderRadius:6,background:"rgba(14,165,233,0.1)",color:"#0ea5e9",fontSize:11,fontWeight:600,border:"1px solid #0ea5e9",cursor:"pointer",fontFamily:"inherit"}}>✓ Invoiced{o.invoiceNum?" — #"+o.invoiceNum:""}{o.invoiceDate?" on "+o.invoiceDate:""} ✎</button>}
      {(o.status==="closed"||o.status==="invoiced") && o.billingType!=="no-charge" && (()=>{
        const p = o.price||{};
        if(!hasAnyPricing) return null;
        return <button style={{...sBtn,background:"#00B5D8",color:"#fff",border:"none"}} onClick={()=>{
          const csv = buildXeroCsvString(o, p);
          const blob = new Blob([csv],{type:"text/csv"});
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href=url; a.download=`Xero_BOL${o.bol}.csv`; a.click();
          URL.revokeObjectURL(url);
        }}>🔗 Xero</button>;
      })()}
      {["closed","invoiced","no-charge"].includes(o.status) && <>
        {o.billingType!=="no-charge" && o.status!=="no-charge" && <>
          <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> Edit Pricing</button>
          <button style={{...sBtn,background:"#06b6d4"}} disabled={sending} onClick={()=>setShowEmailModal(true)}><Ic n="mail" s={13}/> {sending?"Sending...":"Email Accounting"}</button>
        </>}
      </>}
      <StatusChanger current={o.status} orderType={o.orderType} onChange={async(s)=>{
        const label = S_LABEL[s]||s;
        if(!window.confirm(`Move BOL ${o.bol} back to "${label}"?`)) return;
        const backBeforePod = ["unassigned","assigned","in-transit"].includes(s);
        const clearPod = backBeforePod ? {podBy:"",podDate:"",podTime:""} : {};
        const clearBilling = {billingType:"",noInvoiceReason:""};
        if(backBeforePod && ["ready-to-bill","closed"].includes(o.status) && o.price?.base) {
          if(!window.confirm("This will also clear the pricing and POD. Continue?")) return;
          await savOrd({...o,status:s,price:{},...clearPod,...clearBilling});
        } else {
          await savOrd({...o,status:s,...clearPod,...clearBilling});
        }
        go("ol",null,{highlightBol:o.bol});
      }}/>
    </div>

    {/* Info cards */}
    <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>Shipment</div>
      {[["Client",o.cliName],["Bill To",o.billTo],["Reference",o.ref],["Request Date",fd(o.reqDate)],["Pickup Date",fd(o.pickDate)],["Delivery Date",fd(o.delDate)]].map(([l,v])=><div key={l} style={{fontSize:12,marginBottom:3}}><span style={{color:T.muted,marginRight:4}}>{l}:</span>{v||"—"}</div>)}
      {o.linkedEventName && <div style={{fontSize:12,marginBottom:3}}><span style={{color:T.muted,marginRight:4}}>Event:</span><span style={{color:"#8b5cf6",fontWeight:600}}>{o.linkedEventName}</span></div>}
      {o.poRequired && <PoEditor o={o} savOrd={savOrd}/>}
      {o.stickerNum && <div style={{fontSize:12,marginBottom:3}}><span style={{color:T.muted,marginRight:4}}>{o.customsType}:</span><span style={{fontWeight:600,fontFamily:"'IBM Plex Mono'",color:o.customsType==="PAPS"?"#3b82f6":"#22c55e"}}>{o.stickerNum}</span></div>}
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,paddingTop:6,borderTop:`1px solid ${T.border}`}}>
        <span style={{fontSize:11,color:T.muted,whiteSpace:"nowrap"}}>Event:</span>
        <select style={{...sIn,fontSize:11,padding:"3px 6px",flex:1}} value={o.linkedEventId||""} onChange={async e=>{
          const ev=(db.events||[]).find(x=>x.id===e.target.value);
          await savOrd({...o,linkedEventId:e.target.value||"",linkedEventName:ev?.name||""});
        }}>
          <option value="">— No event —</option>
          {[...(db.events||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}
        </select>
      </div>
    </div>

    {!isEvent && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>Transport</div>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,marginBottom:4}}>DRIVER 1</div>
      {[["Driver",o.drvName?.split(", ")[0]||o.drvName],["Truck Unit",o.trkUnit],["Truck Plate",o.trkPlate],["Trailer Unit",o.trlUnit],["Trailer Plate",o.trlPlate]].map(([l,v])=><div key={l} style={{fontSize:12,marginBottom:2}}><span style={{color:T.muted,marginRight:4}}>{l}:</span>{v||"—"}</div>)}
      {(o.extraDrivers||[]).map((d,i)=><div key={i} style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
        <div style={{fontSize:10,fontWeight:600,color:T.muted,marginBottom:4}}>DRIVER {i+2}</div>
        {[["Driver",d.drvName],["Truck Unit",d.trkUnit],["Truck Plate",d.trkPlate],["Trailer Unit",d.trlUnit],["Trailer Plate",d.trlPlate]].map(([l,v])=><div key={l} style={{fontSize:12,marginBottom:2}}><span style={{color:T.muted,marginRight:4}}>{l}:</span>{v||"—"}</div>)}
      </div>)}
    </div>}

    {!isEvent && (o.pickStops||[{co:o.pickCo,addr:o.pickAddr,date:o.pickDate}]).map((s,i)=>{
      const stp=s.price||{}; const sb=parseFloat(stp.base)||0; const sf=stp.fuelModel==="liter"?(parseFloat(stp.fuelAmt)||0):(sb*((parseFloat(stp.fuelPct)||0)/100));
      const soc=(stp.other||[]).reduce((a,c)=>{const lt=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0;const lb=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);return a+lb+lb*(lt/100);},0);
      const stax=(stp.taxMode&&stp.taxMode!=="NONE")?(sb+sf)*((stp.taxMode==="HST"?13:stp.taxMode==="GST"?5:stp.taxMode==="CUSTOM"?(parseFloat(stp.taxCustom)||0):0)/100):0;
      const stopTot=sb+sf+soc+stax; const sym=csym(o.price?.cur||"CAD");
      return <div key={i} style={sCrd}>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>{(o.pickStops||[]).length>1?`Pick Up — Stop ${i+1}`:"Pick Up"}{s.date?` · ${fd(s.date)}`:""}</div>
      {s.co && <div style={{fontSize:12,fontWeight:600}}>{s.co}</div>}
      <div style={{fontSize:12,whiteSpace:"pre-line"}}>{s.addr||"—"}</div>
      {(s.items||[]).filter(it=>it.desc||it.pcs).length>0 && <div style={{marginTop:8,borderTop:`1px dashed ${T.border}`,paddingTop:6}}>
        <div style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Items</div>
        {(s.items||[]).filter(it=>it.desc||it.pcs).map((it,j)=><div key={j} style={{fontSize:12,marginBottom:2}}>{it.pcs||"—"} × {it.desc||"—"}{it.wt?` — ${it.wt} ${it.wUnit||"lbs"}`:""}{(it.l||it.w||it.h)?` — ${it.l||"?"}×${it.w||"?"}×${it.h||"?"} ${it.dUnit||"in"}`:""}</div>)}
      </div>}
      {stopTot>0 && <div style={{marginTop:6,fontSize:12,fontWeight:600,color:"#0ea5e9"}}>Stop Total: {sym}{stopTot.toFixed(2)}</div>}
      {s.notes && <div style={{marginTop:6,fontSize:11,color:T.muted,whiteSpace:"pre-line"}}><span style={{fontWeight:700}}>Notes: </span>{s.notes}</div>}
    </div>;})}

    {!isEvent && (o.delStops||[{co:o.delCo,addr:o.delAddr,date:o.delDate}]).map((s,i)=>{
      const stp=s.price||{}; const sb=parseFloat(stp.base)||0; const sf=stp.fuelModel==="liter"?(parseFloat(stp.fuelAmt)||0):(sb*((parseFloat(stp.fuelPct)||0)/100));
      const soc=(stp.other||[]).reduce((a,c)=>{const lt=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0;const lb=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);return a+lb+lb*(lt/100);},0);
      const stax=(stp.taxMode&&stp.taxMode!=="NONE")?(sb+sf)*((stp.taxMode==="HST"?13:stp.taxMode==="GST"?5:stp.taxMode==="CUSTOM"?(parseFloat(stp.taxCustom)||0):0)/100):0;
      const stopTot=sb+sf+soc+stax; const sym=csym(o.price?.cur||"CAD");
      return <div key={i} style={sCrd}>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>{(o.delStops||[]).length>1?`Delivery — Stop ${i+1}`:"Delivery"}{s.date?` · ${fd(s.date)}`:""}</div>
      {s.co && <div style={{fontSize:12,fontWeight:600}}>{s.co}</div>}
      <div style={{fontSize:12,whiteSpace:"pre-line"}}>{s.addr||"—"}</div>
      {(s.items||[]).filter(it=>it.desc||it.pcs).length>0 && <div style={{marginTop:8,borderTop:`1px dashed ${T.border}`,paddingTop:6}}>
        <div style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Items</div>
        {(s.items||[]).filter(it=>it.desc||it.pcs).map((it,j)=><div key={j} style={{fontSize:12,marginBottom:2}}>{it.pcs||"—"} × {it.desc||"—"}{it.wt?` — ${it.wt} ${it.wUnit||"lbs"}`:""}{(it.l||it.w||it.h)?` — ${it.l||"?"}×${it.w||"?"}×${it.h||"?"} ${it.dUnit||"in"}`:""}</div>)}
      </div>}
      {stopTot>0 && <div style={{marginTop:6,fontSize:12,fontWeight:600,color:"#0ea5e9"}}>Stop Total: {sym}{stopTot.toFixed(2)}</div>}
      {s.notes && <div style={{marginTop:6,fontSize:11,color:T.muted,whiteSpace:"pre-line"}}><span style={{fontWeight:700}}>Notes: </span>{s.notes}</div>}
      {s.pod?.by
        ? <div style={{marginTop:6,fontSize:11,color:"#22c55e"}}>✓ POD: Received by <strong>{s.pod.by}</strong>{s.pod.date?` — ${fd(s.pod.date)}`:""}{s.pod.time?` ${s.pod.time}`:""}</div>
        : <div style={{marginTop:6,fontSize:11,color:T.muted}}>○ POD pending</div>}
    </div>;})}

    {isEvent && o.notes && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Description / Scope of Work</div><div style={{fontSize:12,whiteSpace:"pre-line"}}>{o.notes}</div></div>}
    {o.xeroInvoiceUrl && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Xero Invoice</div><a href={o.xeroInvoiceUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"#0ea5e9",display:"flex",alignItems:"center",gap:4,textDecoration:"none"}}><Ic n="dl" s={12}/>{o.xeroInvoiceFile||"Xero Invoice PDF"}</a></div>}
    {o.podBy && <div style={{...sCrd,borderColor:"#22c55e"}}><div style={{fontSize:10,fontWeight:600,color:"#22c55e",textTransform:"uppercase",marginBottom:4}}>Proof of Delivery</div><div style={{fontSize:12}}>Received by: <strong>{o.podBy}</strong> — {fd(o.podDate)} {o.podTime}</div>{o.podNote&&<div style={{fontSize:11,color:T.muted,marginTop:4}}>Note: {o.podNote}</div>}</div>}
    {o.noInvoiceReason && !["ready-to-bill","closed"].includes(o.status) || (o.noInvoiceReason && o.status==="closed" && o.billingType==="no-charge") ? <div style={{...sCrd,borderColor:"#eab308"}}><div style={{fontSize:10,fontWeight:600,color:"#eab308",textTransform:"uppercase",marginBottom:4}}>No Charge Reason</div><div style={{fontSize:12}}>{o.noInvoiceReason}</div></div> : null}

    {(p.base||isEvent) && (parseFloat(p.base)>0 || (p.eventLines||[]).some(l=>l.desc||parseFloat(l.unitPrice)>0)) && <div style={{...sCrd,borderColor:"#dc2626"}}>
      <div style={{fontSize:10,fontWeight:600,color:"#dc2626",textTransform:"uppercase",marginBottom:8}}>Pricing ({p.cur||"CAD"})</div>
      {(()=>{
        const baseAmt=parseFloat(p.base)||0;
        const fuelPct=parseFloat(p.fuelPct)||0;
        const fuelAmt=baseAmt*(fuelPct/100);
        const subtotal=baseAmt+fuelAmt;
        const taxModeObj=TAX_MODES.find(t=>t.k===p.taxMode)||TAX_MODES[0];
        const taxPct=p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):taxModeObj.pct;
        const taxAmt=p.taxMode==="NONE"?0:subtotal*(taxPct/100);
        const ocCalcD=(c)=>{const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {ltp,lbase,ltax:lbase*(ltp/100),ltot:lbase+lbase*(ltp/100)};};
        const otherCharges=(p.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0);
        const otherTotalD=otherCharges.reduce((s,c)=>s+ocCalcD(c).ltot,0);
        const transportTotal=subtotal+taxAmt+otherTotalD;
        const hasTransport=baseAmt>0;
        const evtLines=(p.eventLines||[]).filter(l=>l.desc||parseFloat(l.unitPrice)>0);
        const linesCalc=evtLines.map(l=>{
          const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
          const ltp=l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
          const ltaxLabel=l.taxMode==="HST"?"HST 13%":l.taxMode==="GST"?"GST 5%":l.taxMode==="CUSTOM"?`Tax ${l.taxCustom||0}%`:"";
          return{...l,lb,ltax:lb*(ltp/100),ltot:lb+lb*(ltp/100),ltaxLabel};
        });
        const hasLines=linesCalc.length>0;
        const linesTotal=linesCalc.reduce((s,l)=>s+l.ltot,0);
        const grandTotal=(hasTransport?transportTotal:0)+(hasLines?linesTotal:0);
        return <div style={{fontSize:12}}>
          {/* Transport section */}
          {hasTransport && <div style={{marginBottom:hasLines?10:0}}>
            {isEvent && <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4}}>Transport Charge</div>}
            {p.transDesc && <div style={{fontSize:11,color:T.muted,fontStyle:"italic",marginBottom:4}}>{p.transDesc}</div>}
            <div>Base: {fm(p.base,p.cur)}</div>
            {fuelPct>0 && <div>Fuel Surcharge ({fuelPct}%): {sym}{fuelAmt.toFixed(2)}</div>}
            {taxAmt>0 && <div>Tax on Base ({taxPct}% {p.taxMode}): {sym}{taxAmt.toFixed(2)}</div>}
            {otherCharges.map((c,i)=>{const cc=ocCalcD(c);const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");return <div key={i}>{c.desc||"Charge"}{hasQty?` (${parseFloat(c.qty)||0} × ${sym}${(parseFloat(c.unitPrice)||0).toFixed(2)})`:""}: {sym}{cc.lbase.toFixed(2)}{cc.ltax>0?<span style={{color:T.muted}}> + tax ({cc.ltp}%) {sym}{cc.ltax.toFixed(2)}</span>:""}</div>;})}
            {!hasLines && <div style={{fontWeight:700,marginTop:4,fontSize:14}}>Total: {sym}{transportTotal.toFixed(2)} {p.cur||"CAD"}</div>}
            {hasLines && <div style={{fontSize:11,color:T.muted,marginTop:2}}>Transport subtotal: {sym}{transportTotal.toFixed(2)}</div>}
          </div>}
          {/* Additional charges */}
          {hasLines && <div style={{marginTop:hasTransport?8:0}}>
            {isEvent && <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:6}}>Additional Charges</div>}
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
                <th style={{textAlign:"left",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 0",paddingRight:8}}>Description</th>
                <th style={{textAlign:"right",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 4px"}}>Qty</th>
                <th style={{textAlign:"right",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 4px"}}>Unit</th>
                <th style={{textAlign:"right",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 0"}}>Total</th>
              </tr></thead>
              <tbody>
                {linesCalc.map((l,i)=><tr key={i} style={{borderBottom:`1px solid ${T.border}`}}>
                  <td style={{padding:"4px 8px 4px 0",fontSize:11}}>
                    {l.desc}{l.ltax>0&&<span style={{fontSize:9,color:T.muted,marginLeft:4}}>({l.ltaxLabel})</span>}
                  </td>
                  <td style={{textAlign:"right",padding:"4px",fontSize:11,color:T.muted}}>{l.qty}</td>
                  <td style={{textAlign:"right",padding:"4px",fontSize:11,color:T.muted}}>{sym}{parseFloat(l.unitPrice).toFixed(2)}</td>
                  <td style={{textAlign:"right",padding:"4px 0",fontWeight:600,fontSize:11,color:"#22c55e"}}>{sym}{l.ltot.toFixed(2)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
          {/* Grand total */}
          {(hasTransport||hasLines) && <div style={{fontWeight:700,marginTop:8,fontSize:14,borderTop:`1px solid ${T.border}`,paddingTop:6}}>
            {hasLines?`Grand Total: ${sym}${grandTotal.toFixed(2)} ${p.cur||"CAD"}`:`Total: ${sym}${transportTotal.toFixed(2)} ${p.cur||"CAD"}`}
          </div>}
          {p.pricingNotes && <div style={{fontSize:12,fontWeight:600,color:"#f97316",marginTop:6,background:T.hover,padding:"6px 10px",borderRadius:4}}>📝 {p.pricingNotes}</div>}
        </div>;
      })()}
    </div>}

    {o.items?.some(i=>i.desc) && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Items</div>
      {o.items.filter(i=>i.desc).map((it,i)=><div key={i} style={{fontSize:12,marginBottom:4,padding:6,background:T["bg"],borderRadius:4}}>{it.pcs||"—"} × {it.desc} — {it.wt||"—"} {it.wUnit||"lbs"} — {it.l}×{it.w}×{it.h} {it.dUnit||"in"}</div>)}</div>}

    {((o.specReqs||[]).length>0||o.specReqCustom) && <div style={sCrd}>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:8}}>Special Requirements</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {(o.specReqs||[]).map(r=><span key={r} style={{padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,background:`rgba(14,165,233,0.1)`,color:T.red,border:`1px solid ${T.red}`}}>{r}</span>)}
        {o.specReqCustom && <span style={{padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,background:`rgba(14,165,233,0.1)`,color:T.red,border:`1px solid ${T.red}`}}>{o.specReqCustom}</span>}
      </div>
    </div>}
    {!isEvent && o.notes && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Notes</div><div style={{fontSize:12,whiteSpace:"pre-line"}}>{o.notes}</div></div>}

    {(o.files||[]).length>0 && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Attachments</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{o.files.map((a,i)=><a key={i} href={a.url||a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{padding:"4px 8px",background:T["bg"],borderRadius:5,fontSize:11,display:"flex",alignItems:"center",gap:4,color:T.text,textDecoration:"none"}}><Ic n="dl" s={11}/>{a.name}</a>)}</div></div>}

    <div style={{marginTop:16,display:"flex",gap:8,flexWrap:"wrap"}} className="no-print">
      <button style={{...bS,borderColor:"#3b82f6",color:"#3b82f6"}} onClick={()=>setShowDupModal(true)}>⧉ Duplicate Order</button>
      <button style={{...bS,borderColor:"#8b5cf6",color:"#8b5cf6"}} onClick={async()=>{
        const newType = isEvent ? "transport" : "event";
        const label = isEvent ? "Transport" : "Event";
        if(!window.confirm(`Convert BOL ${o.bol} to a ${label} order?\n\nAll existing data will be kept. This cannot be undone.`)) return;
        await savOrd({...o, orderType: newType});
      }}>⇄ Convert to {isEvent?"Transport":"Event"}</button>
      {(o.status==="closed"||o.status==="invoiced") && o.billingType!=="no-charge" && o.status!=="no-charge" && o.price?.base && parseFloat(o.price.base)>0
        ? <span style={{fontSize:11,color:"#64748b",fontStyle:"italic"}}>🔒 Cannot delete — order has been closed and sent to accounting.</span>
        : <button style={bD} onClick={()=>delOrd(o.id)}>Delete Order</button>
      }
    </div>
  </div>
  {showEmailModal && <AccountingEmailModal
    showCsvOption={!!(p.base && parseFloat(p.base)>0) || (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0)}
    onSend={async(emails,msg,attachCsv)=>{setShowEmailModal(false);await emailAcctFromDetail(emails,msg,attachCsv);if(["ready-to-bill","pod-received","completed","completed-noinvoice"].includes(o.status)){await savOrd({...o,status:"closed",billingType:"invoiced"});go("ol",null,{highlightBol:o.bol});}}}
    onSkipEmail={async()=>{setShowEmailModal(false);await savOrd({...o,status:"closed",billingType:"invoiced"});go("ol",null,{highlightBol:o.bol});}}
    onCancel={()=>setShowEmailModal(false)}
  />}
  {showInvoicedModal && <InvoicedModal
    initNum={o.invoiceNum||""}
    initDate={o.invoiceDate||""}
    clientBillingEmail={db.clients.find(c=>c.id===o.cliId)?.billingEmails || (db.clients.find(c=>c.id===o.cliId)?.billingEmail ? [db.clients.find(c=>c.id===o.cliId).billingEmail] : [])}
    order={o}
    onClose={()=>setShowInvoicedModal(false)}
    onSave={async(num,date,xeroUrl,xeroFileName,sendPkg,emails,emailMsg)=>{
      await savOrd({...o,status:"invoiced",invoiceNum:num||"",invoiceDate:date||"",xeroInvoiceUrl:xeroUrl||null,xeroInvoiceFile:xeroFileName||null});
      setShowInvoicedModal(false);
      if(sendPkg && emails.length>0) {
        setSending(true);
        try {
          for(const email of emails) {
            await callCloudFn("sendInvoiceEmail",{
              order:{...o,divName:div?.name||""},
              pricing:{...p,billingEmail:email},
              client:db.clients.find(c=>c.id===o.cliId)||null,
              toEmail:email,
              subject:`Invoice — BOL ${o.bol} — ${o.cliName}`,
              orderFiles:(o.files||[]).map(f=>({name:f.name,url:f.url||f.data})),
              xeroInvoiceUrl:xeroUrl||null,
              xeroInvoiceFileName:xeroFileName||null,
              emailMsg:emailMsg||"",
            });
          }
          alert(`Invoice package sent to: ${emails.join(", ")}`);
        } catch(e) { console.error(e); alert("Save succeeded but email failed: "+e.message); }
        setSending(false);
      }
    }}/> }
  {showReasonModal && <NoInvoiceReasonModal
    onConfirm={async(reason)=>{setShowReasonModal(false);await savOrd({...o,status:"closed",billingType:"no-charge",noInvoiceReason:reason});go("ol",null,{highlightBol:o.bol});}}
    onCancel={()=>setShowReasonModal(false)}
  />}
  {showDupModal && <DuplicateModal
    o={o}
    onConfirm={async(copies,dates)=>{setShowDupModal(false);await dupOrd(o,copies,dates);}}
    onCancel={()=>setShowDupModal(false)}
  />}
  </>;
}

// ═══ CLIENT DOCUMENT DROP ZONE ═══
function ClientDocDropZone({itemId, docs, onUploaded, onDelete}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const handleFiles = async (files) => {
    if(!files?.length) return;
    setUploading(true);
    try {
      for(const file of Array.from(files)) {
        const path = `clients/${itemId}/${Date.now()}_${file.name}`;
        const ref = storageRef(storage, path);
        await uploadBytes(ref, file);
        const url = await getDownloadURL(ref);
        await onUploaded({name:file.name, url, path, uploadedAt:new Date().toISOString()});
      }
    } catch(e) { console.error(e); alert("Upload failed"); }
    setUploading(false);
  };

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    handleFiles(e.dataTransfer?.files);
  };

  return <div>
    {/* Drop zone */}
    <div
      onDragEnter={e=>{e.preventDefault();e.stopPropagation();setDragging(true);}}
      onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragging(true);}}
      onDragLeave={e=>{e.preventDefault();e.stopPropagation();setDragging(false);}}
      onDrop={handleDrop}
      style={{border:`2px dashed ${dragging?"#3b82f6":T.border}`,borderRadius:8,padding:"18px 14px",textAlign:"center",background:dragging?"rgba(59,130,246,0.06)":Tbg,transition:"all 0.15s",marginBottom:10,cursor:"pointer"}}
      onClick={()=>fileRef.current?.click()}
    >
      <input ref={fileRef} type="file" multiple accept="*/*" style={{display:"none"}} onChange={e=>handleFiles(e.target.files)}/>
      <div style={{fontSize:22,marginBottom:6}}>{uploading?"⏳":"📂"}</div>
      <div style={{fontSize:12,fontWeight:600,color:dragging?"#3b82f6":T.muted}}>
        {uploading?"Uploading...":"Drop files here or click to upload"}
      </div>
      <div style={{fontSize:10,color:T.dim,marginTop:3}}>PDF, Word, images — any file type</div>
    </div>

    {/* Existing documents */}
    {docs.length>0 && <div>
      {docs.map((d,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:T.hover,borderRadius:6,marginBottom:5}}>
        <span style={{fontSize:16}}>📄</span>
        <span style={{fontSize:12,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</span>
        <span style={{fontSize:10,color:T.dim,whiteSpace:"nowrap"}}>{d.uploadedAt?new Date(d.uploadedAt).toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"}):""}</span>
        <button onClick={e=>{e.stopPropagation();window.open(d.url,"_blank");}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:"1px solid #3b82f6",background:"transparent",color:"#3b82f6",cursor:"pointer",fontFamily:"inherit",fontWeight:600,whiteSpace:"nowrap"}}>📄 Open</button>
        <button onClick={e=>{e.stopPropagation();onDelete(d.path);}} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:"0 2px",lineHeight:1,flexShrink:0}}>×</button>
      </div>)}
    </div>}
    {docs.length===0 && !uploading && <div style={{fontSize:11,color:T.dim,fontStyle:"italic"}}>No documents uploaded yet</div>}
  </div>;
}

// ═══ CRUD PAGE ═══
function BillingEmailInput({emails, onChange}) {
  const [input, setInput] = useState("");
  const add = () => {
    const e = input.trim();
    if(!e) return;
    onChange([...new Set([...emails, e])]);
    setInput("");
  };
  return <div>
    <div style={{display:"flex",gap:6,marginBottom:6}}>
      <input value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"||e.key===","){e.preventDefault();add();}}}
        placeholder="Add billing email..." style={{...sIn,flex:1}}/>
      <button onClick={add} style={{padding:"7px 12px",borderRadius:6,background:"#334155",color:"#f1f5f9",border:`1px solid ${T.border}`,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>Add</button>
    </div>
    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
      {emails.map((e,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:4,background:"rgba(14,165,233,0.1)",border:"1px solid #0ea5e9",borderRadius:20,padding:"3px 10px",fontSize:11,color:"#0ea5e9"}}>
        {e}
        <button onClick={()=>onChange(emails.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#0ea5e9",cursor:"pointer",fontSize:12,padding:0,lineHeight:1,marginLeft:2}}>×</button>
      </div>)}
    </div>
    {emails.length===0 && <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>No billing emails added yet</div>}
  </div>;
}

function CrudPage({title, items, fields, save, orders, orderKey}) {
  const [ed, setEd] = useState(null);
  const [fmData, setFmData] = useState({});
  const [saving, setSaving] = useState(false);
  const [srch, setSrch] = useState("");
  const { confirm: cfm, modal: cfmModal } = useConfirm();
  const formRef = useRef(null);
  const isClients = title === "Clients";
  const startNew = () => { const f={}; fields.forEach(x=>f[x.k]=""); setFmData(f); setEd("new"); setTimeout(() => { const el = formRef.current; if(el) { el.scrollIntoView({ behavior:"smooth", block:"start" }); const main = el.closest("main"); if(main) main.scrollTop = 0; } }, 100); };
  const startEdit = item => { setFmData({...item}); setEd(item.id); setTimeout(() => { const el = formRef.current; if(el) { el.scrollIntoView({ behavior:"smooth", block:"start" }); const main = el.closest("main"); if(main) main.scrollTop = 0; } }, 100); };
  const doSave = async () => {
    setSaving(true);
    try {
      if(ed==="new") await save([...items,{...fmData,id:uid()}]);
      else await save(items.map(x => {
        if (x.id !== ed) return x;
        const merged = {};
        Object.keys(x).forEach(k => { merged[k] = x[k]; });
        Object.keys(fmData).forEach(k => { merged[k] = fmData[k]; });
        return merged;
      }));
      setEd(null);
    } catch(e) { console.error(e); alert("Save error"); }
    setSaving(false);
  };
  const doDelete = async (id) => {
    const ok = await cfm("Delete Item", "Are you sure you want to delete this item? This cannot be undone.");
    if (!ok) return;
    setSaving(true);
    try { await save(items.filter(x=>x.id!==id)); } catch(e) { console.error(e); }
    setSaving(false);
  };

  const filtered = items.filter(item => {
    if (!srch) return true;
    const s = srch.toLowerCase();
    return fields.some(f => (item[f.k]||"").toLowerCase().includes(s));
  }).sort((a,b) => {
    const aName = (a.name||a.company||a[fields[0].k]||"").toLowerCase();
    const bName = (b.name||b.company||b[fields[0].k]||"").toLowerCase();
    return aName.localeCompare(bName);
  });

  const doSaveWithDupeCheck = async () => {
    const nameKey = fields[0].k;
    const newName = (fmData[nameKey]||"").trim().toLowerCase();
    if (newName) {
      const dupes = items.filter(x => x.id !== ed && (x[nameKey]||"").trim().toLowerCase() === newName);
      if (dupes.length > 0) {
        const ok = await cfm("Duplicate Entry", `"${fmData[nameKey]}" already exists. Do you want to save it anyway?`, {confirmLabel:"Save Anyway", confirmColor:"#3b82f6"});
        if (!ok) return;
      }
    }
    await doSave();
  };

  return <div style={{padding:20}}>
    {cfmModal}
    <PageHdr title={title}><button style={bP} onClick={startNew}><Ic n="plus" s={14}/> Add</button></PageHdr>
    <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:T.card,border:`1px solid ${T.border}`,borderRadius:6,maxWidth:300,marginBottom:12}}>
      <Ic n="search" s={13}/><input value={srch} onChange={e=>setSrch(e.target.value)} placeholder={`Search ${title.toLowerCase()}...`} style={{background:"transparent",border:"none",color:T.text,fontSize:12,outline:"none",width:"100%",fontFamily:"inherit"}}/>
      {srch && <button onClick={()=>setSrch("")} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14}}>×</button>}
    </div>
    {ed && <div ref={formRef} style={sCrd}>
      {fields.map(f => {
        if(isClients && f.k === "billingEmail") {
          const emails = (fmData.billingEmails||[]).length > 0
            ? fmData.billingEmails
            : (fmData.billingEmail ? [fmData.billingEmail] : []);
          return <Field key={f.k} l="Billing Emails">
            <BillingEmailInput
              emails={emails}
              onChange={updated => setFmData(p=>({...p, billingEmails: updated, billingEmail: updated[0]||""}))}
            />
          </Field>;
        }
        if(f.tp==="select") return <Field key={f.k} l={f.l}><select style={sIn} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}>{(f.opts||[]).map(o=><option key={o} value={o}>{o||"— None —"}</option>)}</select></Field>;
        return <Field key={f.k} l={f.l}>{f.tp==="textarea" ? <textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/> : <input style={sIn} type={f.tp||"text"} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>}</Field>;
      })}

      {/* Pricing Schedule — clients only. Optional; if enabled, orders for this client auto-calc pricing (always overridable per order). */}
      {isClients && (() => {
        const ps = fmData.pricingSchedule || {};
        const setPs = (k,v) => setFmData(p=>({...p, pricingSchedule:{...(p.pricingSchedule||{}), [k]:v}}));
        const setPsAcc = (i,k,v) => setFmData(p=>{const acc=[...((p.pricingSchedule||{}).accessorials||[])]; acc[i]={...acc[i],[k]:v}; return {...p,pricingSchedule:{...(p.pricingSchedule||{}),accessorials:acc}};});
        const addPsAcc = () => setFmData(p=>({...p,pricingSchedule:{...(p.pricingSchedule||{}),accessorials:[...((p.pricingSchedule||{}).accessorials||[]),{desc:"",unitPrice:"",taxMode:"NONE",auto:false}]}}));
        const delPsAcc = (i) => setFmData(p=>({...p,pricingSchedule:{...(p.pricingSchedule||{}),accessorials:((p.pricingSchedule||{}).accessorials||[]).filter((_,j)=>j!==i)}}));
        return <div style={{marginTop:14,border:`1px solid ${T.border}`,borderRadius:8,padding:14,background:T.surface}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:ps.enabled?12:0}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em"}}>Pricing Schedule</div>
              <div style={{fontSize:11,color:T.muted,marginTop:2}}>Optional. When on, orders for this client auto-fill pricing from these rates — you can still override on any order.</div>
            </div>
            <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",flexShrink:0,marginLeft:12}}>
              <input type="checkbox" checked={!!ps.enabled} onChange={e=>setPs("enabled",e.target.checked)} style={{width:18,height:18,accentColor:T.red,cursor:"pointer"}}/>
              <span style={{fontSize:12,color:T.muted}}>{ps.enabled?"On":"Off"}</span>
            </label>
          </div>
          {ps.enabled && <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <Field l="Rate per km ($)"><input style={sIn} type="number" step="0.01" value={ps.perKm||""} onChange={e=>setPs("perKm",e.target.value)} placeholder="e.g. 2.50"/></Field>
              <Field l="Flat Base Fee ($)"><input style={sIn} type="number" step="0.01" value={ps.baseFee||""} onChange={e=>setPs("baseFee",e.target.value)} placeholder="optional"/></Field>
              <Field l="Minimum Charge ($)"><input style={sIn} type="number" step="0.01" value={ps.minCharge||""} onChange={e=>setPs("minCharge",e.target.value)} placeholder="optional"/></Field>
              <Field l="Per Extra Stop ($)"><input style={sIn} type="number" step="0.01" value={ps.perExtraStop||""} onChange={e=>setPs("perExtraStop",e.target.value)} placeholder="e.g. 75.00"/></Field>
            </div>
            <div style={{marginBottom:10,padding:10,background:T["bg"],borderRadius:6}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase"}}>Fuel Model</div>
                <select style={{...sIn,width:"auto",padding:"4px 8px",fontSize:11}} value={ps.fuelModel||"pct"} onChange={e=>{setPs("fuelModel",e.target.value);}}>
                  <option value="pct">FSC % on base</option>
                  <option value="liter">Per-liter (L/km × $/L)</option>
                </select>
              </div>
              {(ps.fuelModel||"pct")==="pct" && <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8}}>
                <Field l="Default Fuel Surcharge (%)"><input style={sIn} type="number" step="0.1" value={ps.fuelPct||""} onChange={e=>setPs("fuelPct",e.target.value)} placeholder="e.g. 15"/></Field>
              </div>}
              {ps.fuelModel==="liter" && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <Field l="Consumption Rate (L/km)"><input style={sIn} type="number" step="0.01" value={ps.litersPerKm||""} onChange={e=>setPs("litersPerKm",e.target.value)} placeholder="e.g. 0.38"/></Field>
                <Field l="Fuel Price ($/L) — update weekly"><input style={{...sIn,borderColor:"#f97316"}} type="number" step="0.01" value={ps.fuelPricePerLiter||""} onChange={e=>setPs("fuelPricePerLiter",e.target.value)} placeholder="e.g. 2.07"/></Field>
              </div>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <Field l="Default Tax"><select style={sIn} value={ps.taxMode||"NONE"} onChange={e=>setPs("taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select></Field>
            </div>
            <div style={{fontSize:11,color:T.muted,marginBottom:8,fontStyle:"italic"}}>Base = (Base Fee + Rate/km × distance), Minimum Charge applied if higher. Fuel: FSC% = base × %, or Per-liter = km × L/km × $/L. Distance is entered per order for now — Google Maps auto-distance later.</div>
            <div style={{marginTop:6}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase"}}>Default Accessorial Charges</div>
                <button type="button" style={{...bS,padding:"3px 8px",fontSize:10}} onClick={addPsAcc}><Ic n="plus" s={10}/> Add</button>
              </div>
              {((ps.accessorials)||[]).map((a,i)=><div key={i} style={{display:"grid",gridTemplateColumns:"2fr 90px 110px 60px 24px",gap:6,marginBottom:4,alignItems:"center"}}>
                <input style={{...sIn,padding:"6px 8px"}} placeholder="e.g. Pump truck" value={a.desc||""} onChange={e=>setPsAcc(i,"desc",e.target.value)}/>
                <input style={{...sIn,padding:"6px 8px",textAlign:"right"}} type="number" step="0.01" placeholder="$ unit" value={a.unitPrice||""} onChange={e=>setPsAcc(i,"unitPrice",e.target.value)}/>
                <select style={{...sIn,padding:"6px 4px",fontSize:11}} value={a.taxMode||"NONE"} onChange={e=>setPsAcc(i,"taxMode",e.target.value)}>{TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}</select>
                <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:T.muted,cursor:"pointer"}}><input type="checkbox" checked={!!a.auto} onChange={e=>setPsAcc(i,"auto",e.target.checked)} style={{accentColor:T.red}}/>Auto</label>
                <button type="button" onClick={()=>delPsAcc(i)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14}}>×</button>
              </div>)}
              {((ps.accessorials)||[]).length===0 && <div style={{fontSize:11,color:T.muted}}>No default accessorials. Add ones like tailgate or pump truck that recur for this client.</div>}
            </div>
          </>}
        </div>;
      })()}

      {/* Document upload — clients only */}
      {isClients && ed !== "new" && <div style={{marginTop:10}}>
        <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>Documents</div>
        <ClientDocDropZone itemId={ed} docs={items.find(x=>x.id===ed)?.docs||[]} onUploaded={async(doc)=>{
          const item = items.find(x=>x.id===ed);
          await save(items.map(x=>x.id===ed?{...item,docs:[...(item.docs||[]),doc]}:x));
        }} onDelete={async(docPath)=>{
          const ok = await cfm("Delete Document","Remove this document? This cannot be undone.");
          if(!ok) return;
          try { await deleteObject(storageRef(storage,docPath)); } catch{}
          const item = items.find(x=>x.id===ed);
          await save(items.map(x=>x.id===ed?{...item,docs:(item.docs||[]).filter(d=>d.path!==docPath)}:x));
        }}/>
      </div>}

      <div style={{display:"flex",gap:8,marginTop:12}}><button style={bP} disabled={saving} onClick={doSaveWithDupeCheck}>{saving?"Saving...":"Save"}</button><button style={bS} onClick={()=>setEd(null)}>Cancel</button></div>
    </div>}
    {srch && <div style={{fontSize:11,color:T.muted,marginBottom:6}}>{filtered.length} of {items.length}</div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10,maxWidth:600}}>
      {filtered.map(item => {
        const cnt = orders ? orders.filter(o=>o[orderKey]===item.id).length : null;
        return <div key={item.id} style={sCrd}>
          <div style={{display:"flex",justifyContent:"space-between"}}><div style={{fontSize:14,fontWeight:600}}>{item.name||item.company||item[fields[0].k]}</div>{cnt!==null&&<span style={{fontSize:10,color:T.muted,background:T["bg"],padding:"2px 8px",borderRadius:10}}>{cnt} orders</span>}</div>
          {fields.slice(1).filter(f=>f.tp!=="textarea").map(f=>item[f.k]?<div key={f.k} style={{fontSize:11,color:T.muted,marginTop:2}}>{f.l}: {item[f.k]}</div>:null)}
          {item.notes && <div style={{fontSize:10,color:T.dim,marginTop:4,fontStyle:"italic",background:T.hover,padding:"4px 8px",borderRadius:4}}>📝 {item.notes}</div>}

          {/* Documents section — clients only */}
          {isClients && <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>Documents ({(item.docs||[]).length})</span>
              <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontWeight:600}}>
                <Ic n="clip" s={10}/> Upload
                <input type="file" accept="*/*" style={{display:"none"}} onChange={async e=>{
                  const file = e.target.files[0]; if(!file) return;
                  e.target.value="";
                  try {
                    const path = `clients/${item.id}/${Date.now()}_${file.name}`;
                    const r = storageRef(storage, path);
                    await uploadBytes(r, file);
                    const url = await getDownloadURL(r);
                    const d = {name:file.name,url,path,uploadedAt:new Date().toISOString()};
                    await save(items.map(x=>x.id===item.id?{...item,docs:[...(item.docs||[]),d]}:x));
                  } catch(e){ console.error(e); alert("Upload failed"); }
                }}/>
              </label>
            </div>
            {(item.docs||[]).length===0 && <div style={{fontSize:11,color:T.dim,fontStyle:"italic"}}>No documents yet</div>}
            {(item.docs||[]).map((d,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",background:T.hover,borderRadius:5,marginBottom:4}}>
              <span style={{fontSize:11,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</span>
              <a href={d.url} target="_blank" rel="noopener noreferrer" onClick={e=>{e.stopPropagation();window.open(d.url,"_blank");}} style={{fontSize:10,color:"#3b82f6",textDecoration:"none",fontWeight:600,whiteSpace:"nowrap"}}>📄 Open</a>
              <button onClick={async()=>{
                const ok = await cfm("Delete Document","Remove this document? This cannot be undone.");
                if(!ok) return;
                try { await deleteObject(storageRef(storage,d.path)); } catch{}
                await save(items.map(x=>x.id===item.id?{...item,docs:(item.docs||[]).filter(dd=>dd.path!==d.path)}:x));
              }} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1}}>×</button>
            </div>)}
          </div>}

          <div style={{display:"flex",gap:6,marginTop:8}}>
            <button style={{...bS,padding:"3px 8px",fontSize:10}} onClick={()=>startEdit(item)}>Edit</button>
            <button style={{...bD,padding:"3px 8px",fontSize:10}} onClick={()=>doDelete(item.id)}>Delete</button>
          </div>
        </div>;
      })}
    </div>
  </div>;
}

// ═══ DROP ZONE (drag & drop + click button) ═══
function DropZone({label, uploading, docKey, fileRef, onFiles}) {
  const [dragging, setDragging] = useState(false);
  const handleDrag = (e, entering) => { e.preventDefault(); e.stopPropagation(); setDragging(entering); };
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDragging(false);
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  };
  return <div style={{ marginTop: 6 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <label style={{ ...sLbl, margin: 0 }}>{label}</label>
      <button style={{ ...bS, padding: "3px 8px", fontSize: 10 }} disabled={uploading} onClick={() => fileRef?.current?.click()}><Ic n="clip" s={10} /> {uploading ? "Uploading..." : "Upload"}</button>
    </div>
    <div
      onDragEnter={e => handleDrag(e, true)} onDragOver={e => handleDrag(e, true)}
      onDragLeave={e => handleDrag(e, false)} onDrop={handleDrop}
      style={{
        border: `1.5px dashed ${dragging ? "#22c55e" : T.border}`,
        borderRadius: 6, padding: "8px", textAlign: "center",
        background: dragging ? "rgba(34,197,94,0.06)" : "transparent",
        transition: "all 0.15s ease",
      }}
    >
      <div style={{ fontSize: 10, color: dragging ? "#22c55e" : T.dim }}>
        {dragging ? "Drop files here" : "or drag & drop files here"}
      </div>
    </div>
    <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />
  </div>;
}

// ═══ DRIVERS PAGE (with certifications + expiry tracking) ═══
function DriversPage({items, save, col}) {
  const [ed, setEd] = useState(null);
  const [fm, setFm] = useState({});
  const [pinSaved, setPinSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [srch, setSrch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [certsOpen, setCertsOpen] = useState(false); // Certifications & Checks section collapsed by default
  const { confirm: cfm, modal: cfmModal } = useConfirm();
  const formRef = useRef(null);
  // Refs keyed by docKey for reliable matching
  const fileRefs = { acrDocs: useRef(), hazmatDocs: useRef(), crimDocs: useRef(), bgDocs: useRef(), conductDocs: useRef(), licenseDocs: useRef(), docs: useRef() };

  const CERTS = [
    { k: "acrDate", l: "ACR Training", months: 12, docKey: "acrDocs" },
    { k: "hazmatDate", l: "HazMat Training", months: 36, docKey: "hazmatDocs" },
    { k: "crimDate", l: "Criminal Record Check", months: 60, docKey: "crimDocs" },
    { k: "bgDate", l: "Background Verification", months: 0, docKey: "bgDocs" },
    { k: "conductDate", l: "Code of Conduct", months: 0, docKey: "conductDocs" },
    { k: "licenseExpiry", l: "Driver's Licence", direct: true, docKey: "licenseDocs" },
  ];

  const normalizePhone = p => (p||"").replace(/[\s\-().+]/g,"");
  const startNew = () => { setFm({ name:"", phone:"", email:"", license:"", isDriver:true, isEmployee:false, isSupplier:false, contactPerson:"", street:"", city:"", provState:"", postalZip:"", country:"", serviceType:"", acrDate:"", hazmatDate:"", crimDate:"", bgDate:"", conductDate:"", licenseExpiry:"", alertsMuted:false, alertsMutedUntil:"", alertsMutedReason:"", logRestricted:false, driverLog:false, acrDocs:[], hazmatDocs:[], crimDocs:[], bgDocs:[], conductDocs:[], licenseDocs:[], docs:[], employeeId:"", pin:"" }); setEd("new"); setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); };
  const startEdit = item => {
    setCertsOpen(false);
    setFm({ ...item, acrDocs:item.acrDocs||[], hazmatDocs:item.hazmatDocs||[], crimDocs:item.crimDocs||[], bgDocs:item.bgDocs||[], conductDocs:item.conductDocs||[], licenseDocs:item.licenseDocs||[], docs:item.docs||[] });
    setEd(item.id);
    setTimeout(() => { const el = formRef.current; if(el) { el.scrollIntoView({ behavior:"smooth", block:"start" }); const main = el.closest("main"); if(main) main.scrollTop = 0; } }, 100);
  };

  // Direct Firestore write — uses setDoc with merge for Safari compatibility
  const writeDriver = async (id, data) => {
    const { id: _id, ...rest } = data;
    // Always normalize phone before saving
    if(rest.phone) rest.phone = normalizePhone(rest.phone);
    console.log("writeDriver - id:", id);
    console.log("writeDriver - acrDate:", rest.acrDate, "hazmatDate:", rest.hazmatDate, "crimDate:", rest.crimDate, "bgDate:", rest.bgDate);
    await setDoc(doc(db, col, id), rest, { merge: true });
    console.log("writeDriver - setDoc SUCCESS");
  };

  // Save without closing the form
  // Sync payCfg to employees collection by matching email, name, or phone
  const syncPayCfgToEmployees = async (driverData) => {
    if (!driverData.payCfg) return;
    try {
      const normalize = s => (s||"").toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/g,"");
      const empSnap = await getDocs(collection(db, "employees"));
      const matches = empSnap.docs.filter(d => {
        const e = d.data();
        if (driverData.email && e.email && e.email.toLowerCase().trim() === driverData.email.toLowerCase().trim()) return true;
        if (driverData.name && e.name && normalize(e.name) === normalize(driverData.name)) return true;
        if (driverData.phone && e.phone && normalize(e.phone) === normalize(driverData.phone)) return true;
        return false;
      });
      for (const empDoc of matches) {
        await updateDoc(doc(db, "employees", empDoc.id), { payCfg: driverData.payCfg });
      }
      if (matches.length === 0) {
        // No existing employee doc — create one so future timesheet entries work
        if (driverData.email) {
          await setDoc(doc(db, "employees", driverData.email), {
            email: driverData.email,
            name: driverData.name || "",
            phone: normalizePhone(driverData.phone),
            payCfg: driverData.payCfg,
          }, { merge: true });
        }
      }
    } catch(e) { console.warn("syncPayCfg failed:", e); }
  };

  // When a driver's email changes, cascade-update all their timesheet entries
  const cascadeEmailUpdate = async (driverId, newEmail) => {
    if(!newEmail) return;
    const oldDriver = items.find(d => d.id === driverId);
    const oldEmail = oldDriver?.email;
    if(!oldEmail || oldEmail.toLowerCase().trim() === newEmail.toLowerCase().trim()) return;
    try {
      const snap = await getDocs(query(collection(db,"timesheets"), where("employeeEmail","==",oldEmail)));
      if(!snap.empty) {
        await Promise.all(snap.docs.map(d => updateDoc(doc(db,"timesheets",d.id), { employeeEmail: newEmail })));
        console.log(`cascadeEmailUpdate: updated ${snap.docs.length} timesheet entries from ${oldEmail} -> ${newEmail}`);
      }
    } catch(e) { console.warn("cascadeEmailUpdate failed:", e); }
  };

  const doSaveStay = async () => {
    // Duplicate check
    const newName = (fm.name||"").trim().toLowerCase();
    if (newName) {
      const dupes = items.filter(x => x.id !== ed && (x.name||"").trim().toLowerCase() === newName);
      if (dupes.length > 0) {
        const ok = await cfm("Duplicate Entry", `"${fm.name}" already exists. Do you want to save anyway?`, {confirmLabel:"Save Anyway", confirmColor:"#3b82f6"});
        if (!ok) { return; }
      }
    }
    console.log("doSaveStay called - ed:", ed, "fm:", JSON.stringify(fm).slice(0, 200));
    setSaving(true);
    try {
      if (ed === "new") {
        const { id: _oldId, ...rest } = fm;
        console.log("Creating new driver with data:", Object.keys(rest));
        const ref = await addDoc(collection(db, col), rest);
        const newId = ref.id;
        console.log("New driver created with Firestore ID:", newId);
        setEd(newId);
        setFm(prev => ({ ...prev, id: newId }));
        await syncPayCfgToEmployees(rest);
        alert("Driver created!");
      } else {
        console.log("Updating existing driver:", ed);
        await writeDriver(ed, fm);
        await syncPayCfgToEmployees(fm);
        await cascadeEmailUpdate(ed, fm.email);
        alert("Saved!");
      }
    } catch (e) { console.error("doSaveStay ERROR:", e); alert("Save error: " + e.message); }
    setSaving(false);
  };

  // Save and close
  const doSaveAll = async () => {
    // Duplicate check
    const newName = (fm.name||"").trim().toLowerCase();
    if (newName && ed === "new") {
      const dupes = items.filter(x => (x.name||"").trim().toLowerCase() === newName);
      if (dupes.length > 0) {
        const ok = await cfm("Duplicate Entry", `"${fm.name}" already exists. Do you want to save anyway?`, {confirmLabel:"Save Anyway", confirmColor:"#3b82f6"});
        if (!ok) return;
      }
    }
    setSaving(true);
    try {
      if (ed === "new") {
        const { id: _oldId, ...rest } = fm;
        await addDoc(collection(db, col), rest);
        await syncPayCfgToEmployees(rest);
      } else {
        await writeDriver(ed, fm);
        await syncPayCfgToEmployees(fm);
        await cascadeEmailUpdate(ed, fm.email);
      }
      setEd(null);
    } catch (e) { console.error(e); alert("Save error: " + e.message); }
    setSaving(false);
  };

  // Save just the Employee ID + PIN without closing the form
  const saveAccessFields = async () => {
    if (ed === "new") { alert("Please save the new driver first using the main Save button at the bottom."); return; }
    setSaving(true);
    try {
      await writeDriver(ed, fm);
      setPinSaved(true);
      setTimeout(()=>setPinSaved(false), 2500);
    } catch (e) { console.error(e); alert("Save error: " + e.message); }
    setSaving(false);
  };

  const doDelete = async (id) => {
    setSaving(true);
    try { await deleteDoc(doc(db, col, id)); } catch (e) { console.error(e); alert("Delete error"); }
    setSaving(false);
  };

  const addFile = async (files, docKey) => {
    setUploading(true);
    try {
      const nd = [...(fm[docKey] || [])];
      for (const file of Array.from(files)) {
        const result = await uploadFile(file, `drivers/${docKey}`);
        nd.push(result);
      }
      setFm(p => ({ ...p, [docKey]: nd }));
    } catch (e) { console.error(e); alert("Upload failed"); }
    setUploading(false);
  };

  const removeFile = async (docKey, idx) => {
    const d = fm[docKey][idx];
    if (d.path) { try { await deleteObject(storageRef(storage, d.path)); } catch {} }
    setFm(p => ({ ...p, [docKey]: p[docKey].filter((_, j) => j !== idx) }));
  };

  // Expiry calculation: date + months (months=0 means no expiry)
  const calcExpiry = (dateStr, months) => {
    if (!dateStr || months === 0) return null;
    const d = new Date(dateStr + "T12:00:00");
    d.setMonth(d.getMonth() + months);
    return d;
  };
  // `direct` certs (e.g. driver's licence) store the expiry date itself rather
  // than a start date + renewal interval.
  const resolveExp = (dateStr, months, direct) => {
    if (!dateStr) return null;
    if (direct) return new Date(dateStr + "T12:00:00");
    return calcExpiry(dateStr, months);
  };
  const expColor = (dateStr, months, direct) => {
    if (!direct && months === 0) return dateStr ? "#22c55e" : null;
    const exp = resolveExp(dateStr, months, direct);
    if (!exp) return null;
    const diff = Math.floor((exp - new Date()) / (1000 * 60 * 60 * 24));
    if (diff < 0) return "#ef4444";
    if (diff <= 30) return "#eab308";
    if (diff <= 90) return "#f97316";
    return "#22c55e";
  };
  const expLabel = (dateStr, months, direct) => {
    if (!direct && months === 0) return dateStr ? "Done" : "";
    const exp = resolveExp(dateStr, months, direct);
    if (!exp) return "";
    const diff = Math.floor((exp - new Date()) / (1000 * 60 * 60 * 24));
    if (diff < 0) return "EXPIRED";
    if (diff <= 90) return `${diff}d left`;
    return "Valid";
  };
  const expDate = (dateStr, months, direct) => {
    if (direct) return dateStr || "";
    if (months === 0) return dateStr || "";
    const exp = calcExpiry(dateStr, months);
    return exp ? exp.toISOString().slice(0, 10) : "";
  };

  const filtered = items.filter(item => {
    if (!srch) return true;
    const s = srch.toLowerCase();
    return ["name","phone","email","license"].some(k => (item[k] || "").toLowerCase().includes(s));
  }).filter(item => {
    if (roleFilter === "all") return true;
    if (roleFilter === "drivers") return item.isDriver !== false && !item.isSupplier;
    if (roleFilter === "employees") return item.isEmployee === true && !item.isSupplier;
    if (roleFilter === "suppliers") return item.isSupplier === true;
    return true;
  }).sort((a,b) => (a.name||"").toLowerCase().localeCompare((b.name||"").toLowerCase()));

  // Collect all upcoming expirations for alert banner
  const alerts = [];
  const todayIso = new Date().toLocaleDateString("en-CA");
  const isMuted = p => p.alertsMuted === true && !(p.alertsMutedUntil && p.alertsMutedUntil < todayIso);
  items.forEach(drv => {
    if (isMuted(drv)) return; // alerts paused for this person
    CERTS.forEach(c => {
      if (!drv[c.k]) return;
      if (!c.direct && c.months === 0) return;
      const ec = expColor(drv[c.k], c.months, c.direct);
      if (ec === "#ef4444" || ec === "#eab308" || ec === "#f97316") {
        alerts.push({ name: drv.name, cert: c.l, color: ec, label: expLabel(drv[c.k], c.months, c.direct), due: expDate(drv[c.k], c.months, c.direct) });
      }
    });
  });

  const docChip = (docKey, i, a) => (
    <div key={i} style={{ padding: "2px 6px", background: T["bg"], borderRadius: 3, fontSize: 9, display: "flex", alignItems: "center", gap: 2 }}>
      <a href={a.url || a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{ color: T.text, textDecoration: "none", display: "flex", alignItems: "center", gap: 2 }}><Ic n="dl" s={9} />{a.name}</a>
      {ed && <button onClick={() => removeFile(docKey, i)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 11 }}>×</button>}
    </div>
  );

  return <div style={{ padding: 20 }}>
    {cfmModal}
    <PageHdr title="Drivers / Employees / Suppliers"><button style={bP} onClick={startNew}><Ic n="plus" s={14} /> Add</button></PageHdr>

    {/* Search */}
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, maxWidth: 300, marginBottom: 8 }}>
      <Ic n="search" s={13} /><input value={srch} onChange={e => setSrch(e.target.value)} placeholder="Search drivers..." style={{ background: "transparent", border: "none", color: T.text, fontSize: 12, outline: "none", width: "100%", fontFamily: "inherit" }} />
      {srch && <button onClick={() => setSrch("")} style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: 14 }}>×</button>}
    </div>

    {/* Role filter */}
    <div style={{display:"flex",gap:4,marginBottom:12}}>
      {[{k:"all",l:"All"},{k:"drivers",l:"Drivers"},{k:"employees",l:"Employees"},{k:"suppliers",l:"Suppliers"}].map(f=><button key={f.k} onClick={()=>setRoleFilter(f.k)} style={{padding:"4px 12px",borderRadius:5,border:`1px solid ${roleFilter===f.k?T.red:T.border}`,background:roleFilter===f.k?"rgba(220,38,38,0.08)":"transparent",color:roleFilter===f.k?T.red:T.muted,fontSize:10,cursor:"pointer",fontWeight:500,fontFamily:"inherit"}}>{f.l}</button>)}
    </div>

    {/* Expiry alerts */}
    {alerts.length > 0 && <div style={{ ...sCrd, borderColor: "#eab308", marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#eab308", textTransform: "uppercase", marginBottom: 6 }}>Certification Alerts</div>
      {alerts.map((a, i) => (
        <div key={i} style={{ fontSize: 11, color: a.color, marginBottom: 3 }}>
          <span style={{ fontWeight: 600 }}>{a.name}</span> — {a.cert}: <span style={{ fontWeight: 700 }}>{a.label}</span> (due {fd(a.due)})
        </div>
      ))}
    </div>}

    {/* Edit / Add form */}
    {ed && <div ref={formRef} style={sCrd}>
      <Field l="Full Name"><input style={sIn} value={fm.name || ""} onChange={e => setFm(p => ({ ...p, name: e.target.value }))} /></Field>
      <div style={{display:"flex",gap:16,marginBottom:10}}>
        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:T.text}}>
          <input type="checkbox" checked={fm.isDriver!==false} onChange={e=>setFm(p=>({...p,isDriver:e.target.checked}))} style={{accentColor:T.red}}/> Driver
        </label>
        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:T.text}}>
          <input type="checkbox" checked={fm.isEmployee===true} onChange={e=>setFm(p=>({...p,isEmployee:e.target.checked}))} style={{accentColor:T.red}}/> Employee
        </label>
        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:T.text}}>
          <input type="checkbox" checked={fm.isSupplier===true} onChange={e=>setFm(p=>({...p,isSupplier:e.target.checked}))} style={{accentColor:"#f97316"}}/> Supplier
        </label>
      </div>
      <Field l="Phone"><input style={sIn} value={fm.phone || ""} onChange={e => setFm(p => ({ ...p, phone: normalizePhone(e.target.value) }))} /></Field>
      <Field l="Email"><input style={sIn} value={fm.email || ""} onChange={e => setFm(p => ({ ...p, email: e.target.value }))} /></Field>
      {fm.isSupplier && <>
        <Field l="Contact Person"><input style={sIn} value={fm.contactPerson || ""} onChange={e => setFm(p => ({ ...p, contactPerson: e.target.value }))} placeholder="e.g. John Smith"/></Field>
        <Field l="Service Type"><input style={sIn} value={fm.serviceType || ""} onChange={e => setFm(p => ({ ...p, serviceType: e.target.value }))} placeholder="e.g. Trucking, Customs Broker"/></Field>
        <Field l="Street Address"><input style={sIn} value={fm.street || ""} onChange={e => setFm(p => ({ ...p, street: e.target.value }))} placeholder="e.g. 123 Main St"/></Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <Field l="City"><input style={sIn} value={fm.city || ""} onChange={e => setFm(p => ({ ...p, city: e.target.value }))} placeholder="e.g. Montreal"/></Field>
          <Field l="Province / State"><input style={sIn} value={fm.provState || ""} onChange={e => setFm(p => ({ ...p, provState: e.target.value }))} placeholder="e.g. QC"/></Field>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <Field l="Postal / ZIP"><input style={sIn} value={fm.postalZip || ""} onChange={e => setFm(p => ({ ...p, postalZip: e.target.value }))} placeholder="e.g. H3B 1A1"/></Field>
          <Field l="Country"><input style={sIn} value={fm.country || ""} onChange={e => setFm(p => ({ ...p, country: e.target.value }))} placeholder="e.g. Canada"/></Field>
        </div>
      </>}
      {!fm.isSupplier && <Field l="License Class"><input style={sIn} value={fm.license || ""} onChange={e => setFm(p => ({ ...p, license: e.target.value }))} /></Field>}
      <Field l="Internal Notes"><textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fm.notes || ""} onChange={e => setFm(p => ({ ...p, notes: e.target.value }))} /></Field>

      {!fm.isSupplier && <>
      {/* Driver App Access */}
      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4,marginBottom:12}}>
        <div style={{fontSize:10,fontWeight:600,color:T.red,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>🔑 Driver App Access</div>
        <Field l="Employee ID" note="Used to log into the driver app (e.g. truck unit number)">
          <input style={sIn} autoComplete="off" value={fm.employeeId || ""} onChange={e => setFm(p => ({ ...p, employeeId: e.target.value }))} placeholder="e.g. 26-23"/>
        </Field>
        <Field l="PIN (4-6 digits)" note="Driver enters this PIN to access their orders on their phone">
          <input style={{...sIn,letterSpacing:"0.2em"}} autoComplete="off" type="text" inputMode="numeric" maxLength={6} value={fm.pin || ""} onChange={e => setFm(p => ({ ...p, pin: e.target.value.replace(/\D/g,"") }))} placeholder="e.g. 1234"/>
        </Field>
        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:8}}>
          <button onClick={saveAccessFields} disabled={saving} style={{...sBtn,background:"#dc2626",padding:"7px 16px",fontSize:12}}>
            <Ic n="check" s={13}/> {saving?"Saving...":"Save Access"}
          </button>
          {pinSaved && <span style={{fontSize:12,color:"#22c55e",fontWeight:600}}>✓ Saved</span>}
        </div>
      </div>

      {/* Pay Configuration */}
      <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginTop:4,marginBottom:12}}>
        <div style={{fontSize:10,fontWeight:600,color:"#22c55e",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>💰 Pay Configuration</div>
        <div style={{fontSize:11,color:T.dim,marginBottom:12}}>Default pay rates for timesheets. Can be overridden per event in the Timesheets page.</div>

                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Hourly Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="0.25" value={fm.payCfg?.hourly||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",hourly:e.target.value}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/h</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Working Day Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.workDay||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",workDay:e.target.value}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Non-Working Day Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.nonWorkDay||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",nonWorkDay:e.target.value}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Per Diem</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.perDiem||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",perDiem:e.target.value}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Trip Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.tripRate||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",tripRate:e.target.value}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/trip</span>
          </div>
        <button style={{...bP,padding:"5px 14px",fontSize:10,marginTop:4}} disabled={saving} onClick={doSaveStay}>{saving?"Saving...":"Save Pay Config"}</button>
      </div>

      {!fm.isSupplier && <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", marginBottom: 8 }}>Portal Access</div>
        <div style={{ marginBottom: 10, padding: 12, background: T["bg"], borderRadius: 8,
          border: `1px solid ${fm.logRestricted ? "#dc2626" : T.border}` }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.text, cursor: "pointer" }}>
            <input type="checkbox" checked={fm.logRestricted === true} style={{ accentColor: "#dc2626" }}
              onChange={e => setFm(p => ({ ...p, logRestricted: e.target.checked }))} />
            <span style={{ fontWeight: 600 }}>Restrict Daily Log tab</span>
          </label>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 4, marginLeft: 24 }}>
            Hides the daily hours/log workflow in this person's employee portal. They keep access to
            Orders, Equipment, and Documents. Takes effect next time they open the app.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.text, cursor: "pointer", marginTop: 12 }}>
            <input type="checkbox" checked={fm.driverLog === true} style={{ accentColor: "#3b82f6" }}
              onChange={e => setFm(p => ({ ...p, driverLog: e.target.checked }))} />
            <span style={{ fontWeight: 600 }}>Driver log (hide Expenses &amp; Summary)</span>
          </label>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 4, marginLeft: 24 }}>
            In the daily log, hides the Expenses and Summary steps so this person only sees Registration
            and the clock in/out. Everything else in their portal stays the same.
          </div>
          <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>
            {saving ? "Saving..." : "Save Portal Access"}
          </button>
        </div>
      </div>}

      <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 14, paddingTop: 12 }}>
        {/* Collapsible header — shows an at-a-glance summary while closed */}
        {(() => {
          const set = CERTS.filter(c => fm[c.k]).length;
          const worst = CERTS.reduce((acc, c) => {
            if (!fm[c.k]) return acc;
            if (!c.direct && c.months === 0) return acc; // never expires
            const col = expColor(fm[c.k], c.months, c.direct);
            if (col === "#ef4444") return "expired";
            if (col === "#eab308" && acc !== "expired") return "soon";
            return acc;
          }, null);
          const sumColor = worst === "expired" ? "#ef4444" : worst === "soon" ? "#eab308" : T.dim;
          const sumText = worst === "expired" ? "· needs attention"
            : worst === "soon" ? "· expiring soon" : "";
          return <div onClick={() => setCertsOpen(o => !o)} style={{ display: "flex", alignItems: "center",
            gap: 8, cursor: "pointer", userSelect: "none", marginBottom: certsOpen ? 8 : 0,
            padding: "6px 8px", borderRadius: 6, background: certsOpen ? "transparent" : T["bg"],
            border: `1px solid ${certsOpen ? "transparent" : T.border}` }}>
            <span style={{ fontSize: 11, color: T.muted, transform: certsOpen ? "rotate(90deg)" : "none",
              transition: "transform .15s", display: "inline-block" }}>▶</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase" }}>Certifications & Checks</span>
            <span style={{ fontSize: 10, color: sumColor, marginLeft: "auto", fontWeight: 600 }}>
              {set} of {CERTS.length} on file {sumText}
              {fm.alertsMuted ? " · alerts paused" : ""}
            </span>
          </div>;
        })()}

        {certsOpen && <>
        {/* Pause expiry alert emails for this person (sick leave, LOA, etc.) */}
        <div style={{ marginBottom: 10, padding: 12, background: T["bg"], borderRadius: 8,
          border: `1px solid ${fm.alertsMuted ? "#f59e0b" : T.border}` }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.text, cursor: "pointer" }}>
            <input type="checkbox" checked={fm.alertsMuted === true} style={{ accentColor: "#f59e0b" }}
              onChange={e => setFm(p => ({ ...p, alertsMuted: e.target.checked,
                ...(e.target.checked ? {} : { alertsMutedUntil: "", alertsMutedReason: "" }) }))} />
            <span style={{ fontWeight: 600 }}>Pause expiry alert emails</span>
          </label>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 4, marginLeft: 24 }}>
            Stops this person's certification reminders to the team. Their dates keep tracking normally
            and still appear on reports — only the emails pause.
          </div>
          {fm.alertsMuted && <div style={{ marginTop: 10, marginLeft: 24 }}>
            <Field l="Resume alerts on (optional)">
              <DatePicker value={fm.alertsMutedUntil || ""} onChange={v => setFm(p => ({ ...p, alertsMutedUntil: v }))} placeholder="Leave blank to pause indefinitely..." />
              <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>
                {fm.alertsMutedUntil
                  ? `Alerts resume automatically on ${fd(fm.alertsMutedUntil)}.`
                  : "No end date — alerts stay paused until you uncheck this box."}
              </div>
            </Field>
            <Field l="Reason (optional)">
              <input style={sIn} value={fm.alertsMutedReason || ""} placeholder="e.g. Sick leave, LOA, seasonal layoff"
                onChange={e => setFm(p => ({ ...p, alertsMutedReason: e.target.value }))} />
            </Field>
          </div>}
          <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>
            {saving ? "Saving..." : "Save Alert Settings"}
          </button>
        </div>
        {CERTS.map(c => (
          <div key={c.k} style={{ marginBottom: 6, padding: 12, background: T["bg"], borderRadius: 8, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", marginBottom: 6 }}>{c.l}</div>
            {c.direct && <Field l="Licence Class">
              <input style={sIn} value={fm.license || ""} onChange={e => setFm(p => ({ ...p, license: e.target.value }))} placeholder="e.g. AZ, DZ, G" />
            </Field>}
            <Field l={c.direct ? "Expiration Date" : "Date Completed"}>
              <DatePicker value={fm[c.k] || ""} onChange={v => setFm(p => ({ ...p, [c.k]: v }))} placeholder="Select date..." />
              {fm[c.k] && c.direct && <div style={{ fontSize: 10, marginTop: 3, color: expColor(fm[c.k], 0, true) || T.muted }}>
                Expires: {fd(fm[c.k])} — {expLabel(fm[c.k], 0, true)}
              </div>}
              {fm[c.k] && !c.direct && c.months > 0 && <div style={{ fontSize: 10, marginTop: 3, color: expColor(fm[c.k], c.months) || T.muted }}>
                Expires: {fd(expDate(fm[c.k], c.months))} — Renewal every {c.months} months — {expLabel(fm[c.k], c.months)}
              </div>}
              {fm[c.k] && !c.direct && c.months === 0 && <div style={{ fontSize: 10, marginTop: 3, color: "#22c55e" }}>
                Completed on {fd(fm[c.k])} — No renewal required
              </div>}
            </Field>
            <DropZone label="Certificate / Document" uploading={uploading} docKey={c.docKey} fileRef={fileRefs[c.docKey]} onFiles={files => addFile(files, c.docKey)} />
            {(fm[c.docKey] || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>{fm[c.docKey].map((a, i) => docChip(c.docKey, i, a))}</div>}
            <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : `Save ${c.l}`}</button>
          </div>
        ))}
        </>}
      </div>
      </>}

      {/* General docs */}
      <div style={{ marginTop: 10, padding: 12, background: T["bg"], borderRadius: 8, border: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", marginBottom: 6 }}>Other Documents</div>
        <DropZone label="Documents" uploading={uploading} docKey="docs" fileRef={fileRefs.docs} onFiles={files => addFile(files, "docs")} />
        {(fm.docs || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>{fm.docs.map((a, i) => docChip("docs", i, a))}</div>}
        <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : "Save Documents"}</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}><button style={{...bP, padding:"8px 20px"}} disabled={saving} onClick={doSaveAll}>{saving ? "Saving..." : "Save All & Close"}</button><button style={bS} onClick={() => setEd(null)}>Cancel</button></div>
    </div>}

    {/* Driver cards */}
    {srch && <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>{filtered.length} of {items.length}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, maxWidth: 600 }}>
      {filtered.map(item => (
        <div key={item.id} style={sCrd}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {item.name || "—"}
            <span style={{marginLeft:8}}>
              {item.isSupplier && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"#f9731618",color:"#f97316",border:"1px solid #f97316",marginRight:3,fontWeight:600}}>Supplier</span>}
              {!item.isSupplier && item.isDriver!==false && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"#3b82f618",color:"#3b82f6",border:"1px solid #3b82f6",marginRight:3,fontWeight:600}}>Driver</span>}
              {!item.isSupplier && item.isEmployee && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"#8b5cf618",color:"#8b5cf6",border:"1px solid #8b5cf6",fontWeight:600,marginRight:3}}>Employee</span>}
              {isMuted(item) && <span title={[item.alertsMutedReason, item.alertsMutedUntil ? `until ${fd(item.alertsMutedUntil)}` : "indefinite"].filter(Boolean).join(" — ")} style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(245,158,11,0.12)",color:"#f59e0b",border:"1px solid #f59e0b",marginRight:3,fontWeight:600}}>🔕 Alerts paused</span>}
              {!item.isSupplier && item.logRestricted && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(220,38,38,0.1)",color:"#dc2626",border:"1px solid #dc2626",marginRight:3,fontWeight:600}}>🔒 Log restricted</span>}
              {!item.isSupplier && item.driverLog && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(59,130,246,0.1)",color:"#3b82f6",border:"1px solid #3b82f6",marginRight:3,fontWeight:600}}>🚚 Driver log</span>}
              {!item.isSupplier && item.employeeId && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(14,165,233,0.1)",color:"#0ea5e9",border:"1px solid #0ea5e9",marginRight:3,fontWeight:600}}>ID: {item.employeeId}</span>}
              {!item.isSupplier && item.pin && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(34,197,94,0.1)",color:"#22c55e",border:"1px solid #22c55e",fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>PIN: {item.pin}</span>}
            </span>
          </div>
          {item.phone && <div style={{ fontSize: 11, color: T.muted }}>Phone: {item.phone}</div>}
          {item.email && <div style={{ fontSize: 11, color: T.muted }}>Email: {item.email}</div>}
          {item.isSupplier && item.contactPerson && <div style={{ fontSize: 11, color: T.muted }}>Contact: {item.contactPerson}</div>}
          {item.isSupplier && item.serviceType && <div style={{ fontSize: 11, color: "#f97316" }}>Service: {item.serviceType}</div>}
          {item.isSupplier && (item.street||item.city) && <div style={{ fontSize: 11, color: T.dim }}>📍 {[item.street,item.city,item.provState,item.postalZip,item.country].filter(Boolean).join(", ")}</div>}
          {!item.isSupplier && item.license && <div style={{ fontSize: 11, color: T.muted }}>License: {item.license}</div>}
          {item.notes && <div style={{fontSize:10,color:T.dim,marginTop:4,fontStyle:"italic",background:T.hover,padding:"4px 8px",borderRadius:4}}>📝 {item.notes}</div>}
          {/* Duplicate warning */}
          {items.some(other => other.id!==item.id && (
            (item.phone && other.phone && item.phone.replace(/\D/g,"")===(other.phone||"").replace(/\D/g,"")) ||
            (item.email && other.email && item.email.toLowerCase().trim()===other.email.toLowerCase().trim())
          )) && <div style={{fontSize:10,marginTop:4,padding:"3px 8px",borderRadius:5,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",color:"#ef4444",display:"inline-block"}}>
            ⚠️ Possible duplicate
          </div>}
          {!item.isSupplier && item.payCfg && <div style={{fontSize:10,marginTop:4,padding:"3px 8px",borderRadius:5,background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.3)",color:"#22c55e",display:"inline-block"}}>
            💰 {(() => {
                const cfg = item.payCfg;
                const parts = [];
                if(cfg.hourly) parts.push("$"+parseFloat(cfg.hourly).toFixed(2)+"/h");
                if(cfg.workDay) parts.push("$"+parseFloat(cfg.workDay).toFixed(0)+"/day");
                if(cfg.nonWorkDay) parts.push("$"+parseFloat(cfg.nonWorkDay).toFixed(0)+"/NW");
                if(cfg.perDiem) parts.push("$"+parseFloat(cfg.perDiem).toFixed(0)+" diem");
                if(cfg.tripRate) parts.push("$"+parseFloat(cfg.tripRate).toFixed(0)+"/trip");
                return parts.length ? parts.join(" · ") : "Configured";
              })()}
          </div>}
          {/* Cert badges */}
          {!item.isSupplier && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {CERTS.map(c => {
              const ec = expColor(item[c.k], c.months, c.direct);
              const el = expLabel(item[c.k], c.months, c.direct);
              const shortLabel = c.l.replace(" Training", "").replace(" Check", "").replace(" Verification", "");
              return <div key={c.k} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: ec ? ec + "18" : Tbg, color: ec || T.dim, border: `1px solid ${ec || T.border}` }}>
                {shortLabel}: {item[c.k] ? ((c.direct || c.months > 0)
                  ? <><span style={{ fontWeight: 700 }}>{el}</span> <span style={{ color: T.muted }}>({fd(expDate(item[c.k], c.months, c.direct))})</span></>
                  : <><span style={{ fontWeight: 700 }}>Done</span> <span style={{ color: T.muted }}>({fd(item[c.k])})</span></>
                ) : <span style={{ color: T.dim }}>Not set</span>}
              </div>;
            })}
          </div>}

          {/* Doc links */}
          {CERTS.map(c => (item[c.docKey] || []).length > 0 && <div key={c.docKey} style={{ marginTop: 4 }}>
            <div style={{ fontSize: 9, color: T.muted }}>{c.l} docs:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{item[c.docKey].map((a, i) => (
              <a key={i} href={a.url || a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{ padding: "2px 6px", background: T["bg"], borderRadius: 3, fontSize: 9, display: "flex", alignItems: "center", gap: 2, color: T.text, textDecoration: "none" }}><Ic n="dl" s={9} />{a.name}</a>
            ))}</div>
          </div>)}
          {(item.docs || []).length > 0 && <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 9, color: T.muted }}>Other docs:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{item.docs.map((a, i) => (
              <a key={i} href={a.url || a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{ padding: "2px 6px", background: T["bg"], borderRadius: 3, fontSize: 9, display: "flex", alignItems: "center", gap: 2, color: T.text, textDecoration: "none" }}><Ic n="dl" s={9} />{a.name}</a>
            ))}</div>
          </div>}

          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
            <button style={{ ...bS, padding: "6px 18px", fontSize: 11 }} onClick={() => startEdit(item)}>✏️ Edit</button>
            <button style={{ ...bD, padding: "6px 18px", fontSize: 11 }} onClick={async () => {
              const ok = await cfm("Delete Employee", `Are you sure you want to permanently delete ${item.name||"this employee"}?\n\nThis will remove their profile and all uploaded certificates. This cannot be undone.`);
              if(!ok) return;
              await doDelete(item.id);
            }}>🗑 Delete</button>
          </div>
        </div>
      ))}
    </div>
  </div>;
}

// ═══ EQUIPMENT PAGE ═══

function VehicleHistory() {
  const [unitSearch, setUnitSearch] = useState("");
  const [unitType, setUnitType] = useState("truck"); // "truck" or "trailer"
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const fd2 = (d) => d ? new Date(d+"T12:00:00").toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric",year:"numeric"}) : "—";
  const fh = (h) => { const hrs=Math.floor(h||0), mins=Math.round(((h||0)-hrs)*60); return `${hrs}h${mins>0?` ${mins}m`:""}`; };

  const search = async () => {
    if (!unitSearch.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const field = unitType === "truck" ? "truckUnit" : "trailerUnit";
      const snap = await getDocs(query(
        collection(db, "timesheets"),
        where(field, "==", unitSearch.trim()),
        orderBy("date", "desc")
      ));
      setResults(snap.docs.map(d => ({id:d.id,...d.data()})));
    } catch(e) {
      console.error(e);
      // fallback: fetch all and filter client-side (in case index not ready)
      try {
        const snap = await getDocs(query(collection(db,"timesheets"), orderBy("date","desc")));
        const field = unitType === "truck" ? "truckUnit" : "trailerUnit";
        const all = snap.docs.map(d=>({id:d.id,...d.data()}));
        setResults(all.filter(e=>(e[field]||"").trim().toLowerCase()===unitSearch.trim().toLowerCase()));
      } catch(e2) { console.error(e2); }
    }
    setLoading(false);
  };

  const overnight = (e) => e.startTime && e.endTime && (()=>{
    const [sh,sm]=e.startTime.split(":").map(Number);
    const [eh,em]=e.endTime.split(":").map(Number);
    return (eh*60+em) < (sh*60+sm);
  })();

  const bS2 = {padding:"8px 14px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6};
  const bP2 = {...bS2,background:T.redDim,border:`1px solid ${T.red}`,color:T.red};

  return <div>
    <div style={{marginBottom:16}}>
      <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4}}>Vehicle History Lookup</div>
      <div style={{fontSize:12,color:T.muted,marginBottom:16}}>Search who drove a specific truck or pulled a specific trailer on any date.</div>

      {/* Search controls */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:20}}>
        {/* Type toggle */}
        <div style={{display:"flex",gap:0,borderRadius:7,overflow:"hidden",border:`1px solid ${T.border}`}}>
          {["truck","trailer"].map(t=>(
            <button key={t} onClick={()=>setUnitType(t)} style={{padding:"8px 14px",background:unitType===t?T.red:"transparent",color:unitType===t?"#fff":T.muted,border:"none",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textTransform:"capitalize"}}>
              {t==="truck"?"🚛 Truck":"🚚 Trailer"}
            </button>
          ))}
        </div>
        {/* Unit input */}
        <div style={{display:"flex",alignItems:"center",gap:8,background:T.surface,border:`1px solid ${T.border}`,borderRadius:7,padding:"8px 12px",flex:1,maxWidth:280}}>
          <Ic n="search" s={13}/>
          <input
            value={unitSearch}
            onChange={e=>setUnitSearch(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&search()}
            placeholder={unitType==="truck"?"e.g. 26-23":"e.g. T-45"}
            style={{background:"transparent",border:"none",color:T.text,fontSize:13,outline:"none",width:"100%",fontFamily:"inherit"}}
          />
          {unitSearch && <button onClick={()=>{setUnitSearch("");setResults([]);setSearched(false);}} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14,padding:0}}>×</button>}
        </div>
        <button onClick={search} disabled={loading||!unitSearch.trim()} style={{...bP2,opacity:!unitSearch.trim()?0.5:1}}>
          {loading ? "Searching..." : "Search"}
        </button>
      </div>
    </div>

    {/* Results */}
    {loading && <div style={{color:T.muted,fontSize:13,padding:"20px 0"}}>Searching timesheet records...</div>}

    {!loading && searched && results.length === 0 && (
      <div style={{color:T.muted,fontSize:13,padding:"20px 0",textAlign:"center"}}>
        No timesheet entries found for {unitType} unit <strong style={{color:T.text}}>"{unitSearch}"</strong>.
      </div>
    )}

    {!loading && results.length > 0 && (
      <div>
        <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginBottom:10}}>
          {results.length} entr{results.length===1?"y":"ies"} found for {unitType} <span style={{color:T.red}}>"{unitSearch}"</span>
        </div>
        {results.map(e => {
          const h = (()=>{
            if(!e.startTime||!e.endTime) return 0;
            const [sh,sm]=e.startTime.split(":").map(Number);
            const [eh,em]=e.endTime.split(":").map(Number);
            let mins=(eh*60+em)-(sh*60+sm);
            if(mins<=0) mins+=24*60;
            return +(mins/60).toFixed(2);
          })();
          const isOvernight = overnight(e);
          return <div key={e.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",marginBottom:10}}>
            {/* Header row */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:8}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:34,height:34,borderRadius:"50%",background:T.surface,display:"flex",alignItems:"center",justifyContent:"center",color:T.muted,flexShrink:0}}>
                  <Ic n="user" s={16}/>
                </div>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:T.text}}>{e.employeeName}</div>
                  <div style={{fontSize:11,color:T.muted,marginTop:1}}>{e.employeeEmail}{e.employeePhone?` · ${e.employeePhone}`:""}</div>
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:15,fontWeight:700,color:T.red,fontFamily:"'IBM Plex Mono',monospace"}}>{fh(h)}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:1}}>{fd2(e.date)}</div>
              </div>
            </div>
            {/* Details grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:e.notes?10:0}}>
              {e.startTime && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Time</div>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>{e.startTime} → {e.endTime}{isOvernight&&<span style={{color:T.amber,marginLeft:4}}>☽</span>}</div>
              </div>}
              {e.event && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Event</div>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>{e.event}</div>
              </div>}
              {e.truckUnit && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Truck</div>
                <div style={{fontSize:12,fontWeight:600,color:unitType==="truck"?T.red:T.text}}>🚛 {e.truckUnit}</div>
              </div>}
              {e.trailerUnit && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Trailer</div>
                <div style={{fontSize:12,fontWeight:600,color:unitType==="trailer"?T.red:T.text}}>🚚 {e.trailerUnit}</div>
              </div>}
              {(e.kmStart||e.kmEnd) && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>KM</div>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>{e.kmStart||"?"} → {e.kmEnd||"?"}{e.kmTotal!=null?` (+${e.kmTotal})`:""}</div>
              </div>}
              {e.breakMinutes && <div style={{background:T.surface,borderRadius:6,padding:"6px 10px"}}>
                <div style={{fontSize:9,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Break</div>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>{e.breakMinutes} min</div>
              </div>}
            </div>
            {/* Notes */}
            {e.notes && <div style={{marginTop:8,padding:"8px 10px",background:T.surface,borderRadius:6,fontSize:12,color:T.muted,lineHeight:1.6}}>
              <span style={{fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600,marginRight:6}}>Notes:</span>{e.notes}
            </div>}
            {/* GPS */}
            {(e.gpsIn?.method==="button"||e.gpsOut?.method==="button") && <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap"}}>
              {e.gpsIn?.method==="button" && <a href={`https://www.google.com/maps?q=${e.gpsIn.lat},${e.gpsIn.lng}`} target="_blank" rel="noreferrer" style={{fontSize:11,color:"#60a5fa",fontWeight:600,textDecoration:"none"}}>📍 Clock-in location</a>}
              {e.gpsOut?.method==="button" && <a href={`https://www.google.com/maps?q=${e.gpsOut.lat},${e.gpsOut.lng}`} target="_blank" rel="noreferrer" style={{fontSize:11,color:"#60a5fa",fontWeight:600,textDecoration:"none"}}>📍 Clock-out location</a>}
            </div>}
          </div>;
        })}
      </div>
    )}
  </div>;
}

function EquipPage({db, saveColl}) {
  const [tab, setTab] = useState("trucks");
  return <div style={{padding:20}}>
    <h1 style={{fontSize:18,fontWeight:700,margin:0,marginBottom:12}}>Equipment</h1>
    <div style={{display:"flex",gap:6,marginBottom:12}}>{["trucks","trailers","history"].map(t=><button key={t} onClick={()=>setTab(t)} style={{padding:"6px 12px",borderRadius:6,background:tab===t?T.border:"transparent",border:`1px solid ${tab===t?"#334155":T.border}`,color:tab===t?T.text:T.muted,fontSize:12,cursor:"pointer",textTransform:"capitalize",fontFamily:"inherit"}}>{t==="history"?"Vehicle History":t}</button>)}</div>
    {tab==="trucks" && <EquipList title="Trucks" items={db.trucks} col="trucks" fields={[{k:"unit",l:"Unit #"},{k:"plate",l:"Plate #"},{k:"year",l:"Year",tp:"number"},{k:"make",l:"Make"},{k:"model",l:"Model"},{k:"type",l:"Type"},{k:"vin",l:"VIN"},{k:"safetyExp",l:"Safety Expiration",tp:"date"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} saveColl={saveColl}/>}
    {tab==="trailers" && <EquipList title="Trailers" items={db.trailers} col="trailers" fields={[{k:"unit",l:"Unit #"},{k:"plate",l:"Plate #"},{k:"year",l:"Year",tp:"number"},{k:"make",l:"Make"},{k:"model",l:"Model"},{k:"type",l:"Type"},{k:"vin",l:"VIN"},{k:"safetyExp",l:"Safety Expiration",tp:"date"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} saveColl={saveColl}/>}
    {tab==="history" && <VehicleHistory/>}
  </div>;
}

function EquipList({title, items, col, fields, saveColl}) {
  const [ed,setEd] = useState(null);
  const [fmData,setFmData] = useState({});
  const [saving,setSaving] = useState(false);
  const [uploading,setUploading] = useState(false);
  const [srch, setSrch] = useState("");
  const { confirm: cfm, modal: cfmModal } = useConfirm();
  const fileRef = useRef();
  const formRef = useRef(null);

  const startNew = () => { const f={}; fields.forEach(x=>f[x.k]=""); f.docs=[]; setFmData(f); setEd("new"); setTimeout(() => { const el = formRef.current; if(el) { el.scrollIntoView({ behavior:"smooth", block:"start" }); const main = el.closest("main"); if(main) main.scrollTop = 0; } }, 100); };
  const startEdit = item => { setFmData({...item,docs:item.docs||[]}); setEd(item.id); setTimeout(() => { const el = formRef.current; if(el) { el.scrollIntoView({ behavior:"smooth", block:"start" }); const main = el.closest("main"); if(main) main.scrollTop = 0; } }, 100); };

  const doSave = async () => {
    // Duplicate check on unit number
    const newUnit = (fmData.unit||"").trim().toLowerCase();
    if (newUnit) {
      const dupes = items.filter(x => x.id !== ed && (x.unit||"").trim().toLowerCase() === newUnit);
      if (dupes.length > 0) {
        const ok = await cfm("Duplicate Entry", `Unit "${fmData.unit}" already exists. Do you want to save anyway?`, {confirmLabel:"Save Anyway", confirmColor:"#3b82f6"});
        if (!ok) return;
      }
    }
    setSaving(true);
    try {
      if(ed==="new") await saveColl(col, [...items,{...fmData,id:uid()}]);
      else await saveColl(col, items.map(x => {
        if (x.id !== ed) return x;
        const merged = {};
        Object.keys(x).forEach(k => { merged[k] = x[k]; });
        Object.keys(fmData).forEach(k => { merged[k] = fmData[k]; });
        return merged;
      }));
      setEd(null);
    } catch(e) { console.error(e); alert("Save error"); }
    setSaving(false);
  };

  const addFiles = async (files) => {
    setUploading(true);
    try {
      const nd = [...(fmData.docs||[])];
      for (const file of Array.from(files)) {
        const result = await uploadFile(file, `equipment/${col}`);
        nd.push(result);
      }
      setFmData(p => ({...p, docs: nd}));
    } catch(e) { console.error(e); alert("Upload failed"); }
    setUploading(false);
  };

  const removeDoc = async (idx) => {
    const d = fmData.docs[idx];
    if (d.path) { try { await deleteObject(storageRef(storage, d.path)); } catch {} }
    setFmData(p => ({...p, docs: p.docs.filter((_,j)=>j!==idx)}));
  };

  const expColor = d => { if(!d) return null; const diff=Math.floor((new Date(d+"T12:00:00")-new Date())/(1000*60*60*24)); if(diff<0) return"#ef4444"; if(diff<=30) return"#eab308"; if(diff<=90) return"#f97316"; return"#22c55e"; };
  const expLabel = d => { if(!d) return""; const diff=Math.floor((new Date(d+"T12:00:00")-new Date())/(1000*60*60*24)); if(diff<0) return"EXPIRED"; if(diff<=30) return`${diff}d left`; if(diff<=90) return`${diff}d left`; return`Valid`; };

  // Safety alerts
  const safetyAlerts = items.filter(item => {
    if (!item.safetyExp) return false;
    const ec = expColor(item.safetyExp);
    return ec === "#ef4444" || ec === "#eab308" || ec === "#f97316";
  });

  return <div>
    {cfmModal}
    <PageHdr title={title}><button style={bP} onClick={startNew}><Ic n="plus" s={14}/> Add</button></PageHdr>
    <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:T.card,border:`1px solid ${T.border}`,borderRadius:6,maxWidth:300,marginBottom:12}}>
      <Ic n="search" s={13}/><input value={srch} onChange={e=>setSrch(e.target.value)} placeholder={`Search ${title.toLowerCase()}...`} style={{background:"transparent",border:"none",color:T.text,fontSize:12,outline:"none",width:"100%",fontFamily:"inherit"}}/>
      {srch && <button onClick={()=>setSrch("")} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:14}}>×</button>}
    </div>
    {/* Safety alerts */}
    {safetyAlerts.length > 0 && <div style={{...sCrd, borderColor:"#eab308", marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:700,color:"#eab308",textTransform:"uppercase",marginBottom:6}}>Safety Expiration Alerts</div>
      {safetyAlerts.map(item => {
        const ec = expColor(item.safetyExp);
        return <div key={item.id} style={{fontSize:11,color:ec,marginBottom:3}}>
          <span style={{fontWeight:600}}>{item.unit}</span> — Safety: <span style={{fontWeight:700}}>{expLabel(item.safetyExp)}</span> (expires {fd(item.safetyExp)})
        </div>;
      })}
    </div>}
    {ed && <div ref={formRef} style={sCrd}>
      {fields.map(f=><Field key={f.k} l={f.l}>{f.tp==="textarea" ? <textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/> : <input style={sIn} type={f.tp||"text"} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>}</Field>)}
      <div style={{marginTop:8}}>
        <DropZone label="Documents" uploading={uploading} docKey="docs" fileRef={fileRef} onFiles={addFiles} />
        {(fmData.docs||[]).length>0 &&
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>{fmData.docs.map((a,i)=><div key={i} style={{padding:"3px 8px",background:T["bg"],borderRadius:4,fontSize:10,display:"flex",alignItems:"center",gap:3}}><Ic n="file" s={10}/>{a.name}<button onClick={()=>removeDoc(i)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:11}}>×</button></div>)}</div>}
      </div>
      <div style={{display:"flex",gap:8,marginTop:10}}><button style={bP} disabled={saving} onClick={doSave}>{saving?"Saving...":"Save"}</button><button style={bS} onClick={()=>setEd(null)}>Cancel</button></div>
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10,maxWidth:600}}>
      {items.filter(item => {
        if (!srch) return true;
        const s = srch.toLowerCase();
        return fields.some(f => String(item[f.k]??"").toLowerCase().includes(s));
      }).sort((a,b) => (a.unit||"").toLowerCase().localeCompare((b.unit||"").toLowerCase())).map(item => {
        const ec = expColor(item.safetyExp);
        return <div key={item.id} style={sCrd}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div style={{fontSize:14,fontWeight:600}}>{item.unit}</div>
            {item.safetyExp && <span style={{fontSize:10,fontWeight:600,color:ec,background:ec+"18",padding:"2px 8px",borderRadius:10}}>{expLabel(item.safetyExp)}</span>}
          </div>
          {fields.slice(1).filter(f=>f.k!=="safetyExp"&&f.tp!=="textarea").map(f=>item[f.k]?<div key={f.k} style={{fontSize:11,color:T.muted,marginTop:2}}>{f.l}: {item[f.k]}</div>:null)}
          {item.safetyExp && <div style={{fontSize:11,color:T.muted,marginTop:2}}>Safety Exp: {fd(item.safetyExp)}</div>}
          {item.notes && <div style={{fontSize:10,color:T.dim,marginTop:4,fontStyle:"italic",background:T.hover,padding:"4px 8px",borderRadius:4}}>📝 {item.notes}</div>}
          {(item.docs||[]).length>0 && <div style={{marginTop:4}}>
            <div style={{fontSize:9,color:T.muted,marginBottom:2}}>Docs ({item.docs.length}):</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:3}}>{item.docs.map((a,i)=><a key={i} href={a.url||a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{padding:"2px 6px",background:T["bg"],borderRadius:3,fontSize:9,display:"flex",alignItems:"center",gap:2,color:T.text,textDecoration:"none"}}><Ic n="dl" s={9}/>{a.name}</a>)}</div>
          </div>}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
            <button style={{...bS,padding:"6px 14px",fontSize:11}} onClick={()=>startEdit(item)}>Edit</button>
            <button style={{...bD,padding:"6px 14px",fontSize:11}} onClick={async()=>{const ok=await cfm("Delete Equipment","Are you sure you want to delete this unit? All attached documents will also be removed. This cannot be undone.");if(ok){setSaving(true);try{await saveColl(col,items.filter(x=>x.id!==item.id))}catch{}setSaving(false)}}}>Delete</button>
          </div>
        </div>;
      })}
    </div>
  </div>;
}

// ═══ CREW PAGE ═══
function CrewPage({fireDb}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(fireDb, "sessions"));
      const today = new Date().toISOString().slice(0,10);
      const all = snap.docs.map(d => ({id: d.id, ...d.data()}));
      // Auto-expire sessions older than today
      for(const s of all) {
        if(s.date && s.date < today) {
          await deleteDoc(doc(fireDb, "sessions", s.id));
        }
      }
      setSessions(all.filter(s => !s.date || s.date >= today));
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const deleteSession = async (id) => {
    try {
      await deleteDoc(doc(fireDb, "sessions", id));
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch(e) { console.error(e); }
  };

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  }, []);

  const calcHours = (clockIn, clockOut) => {
    if(!clockIn || !clockOut) return null;
    const [h1,m1] = clockIn.split(":").map(Number);
    const [h2,m2] = clockOut.split(":").map(Number);
    const mins = (h2*60+m2) - (h1*60+m1);
    if(mins <= 0) return null;
    return (mins/60).toFixed(1);
  };

  const active = sessions.filter(s => s.status === "active");
  const done = sessions.filter(s => s.status === "clocked-out");

  return <div style={{padding:24,maxWidth:900}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
      <div>
        <h1 style={{fontSize:22,fontWeight:700,margin:0,color:T.text}}>🟢 Live Crew</h1>
        <div style={{fontSize:12,color:T.muted,marginTop:4}}>Auto-refreshes every 30 seconds · Sessions older than today are auto-removed</div>
      </div>
      <button onClick={loadSessions} style={{...bS,padding:"8px 16px"}}>↻ Refresh</button>
    </div>

    {loading && <div style={{color:T.muted,fontSize:14}}>Loading...</div>}

    {/* Active */}
    {!loading && <div style={{marginBottom:28}}>
      <div style={{fontSize:11,fontWeight:700,color:"#22c55e",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>
        🟢 Currently Working ({active.length})
      </div>
      {active.length === 0 && <div style={{color:T.muted,fontSize:13}}>No one clocked in right now</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
        {active.map(s => <div key={s.id} style={{...sCrd,borderLeft:"3px solid #22c55e"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(34,197,94,0.15)",border:"2px solid #22c55e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"#22c55e",flexShrink:0}}>
              {s.name?.charAt(0).toUpperCase()}
            </div>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:T.text}}>{s.name}</div>
              <div style={{fontSize:11,color:T.muted}}>{s.event||"Daily Operations"}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{background:"rgba(34,197,94,0.1)",color:"#22c55e",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,border:"1px solid #22c55e"}}>ACTIVE</div>
              <button onClick={()=>{ if(window.confirm(`Remove ${s.name} from Live Crew?`)) deleteSession(s.id); }} style={{background:"none",border:"1px solid "+T.border,borderRadius:6,padding:"2px 6px",cursor:"pointer",color:T.muted,fontSize:11}}>✕</button>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:12,marginBottom:8}}>
            <div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:2}}>CLOCK IN</div>
              <div style={{fontWeight:700,color:"#22c55e"}}>{s.clockIn||"—"}</div>
            </div>
            <div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:2}}>CURRENT TRUCK</div>
              <div style={{fontWeight:700,color:T.text}}>{s.truck||"—"}</div>
            </div>
            <div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:2}}>CURRENT TRAILER</div>
              <div style={{fontWeight:700,color:T.text}}>{s.trailer||"—"}</div>
            </div>
            {s.kmStart&&<div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:2}}>START KM</div>
              <div style={{fontWeight:700,color:T.text}}>{s.kmStart}</div>
            </div>}
          </div>
          {s.unitLog&&s.unitLog.length>0&&<div style={{marginBottom:6}}>
            <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:T.muted,marginBottom:4}}>Previous Units</div>
            {s.unitLog.map((u,i)=>(
              <div key={i} style={{fontSize:11,color:T.muted,display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${T.border}`}}>
                <span>{u.truck&&`🚛 ${u.truck}`}{u.trailer&&` TRL: ${u.trailer}`}{u.kmTotal!=null&&` (+${u.kmTotal.toFixed(0)}km)`}</span>
                <span style={{fontSize:10,color:T.dim}}>{u.time}</span>
              </div>
            ))}
          </div>}
          <div style={{fontSize:10,color:T.dim,marginTop:4}}>{s.date}</div>
        </div>)}
      </div>
    </div>}

    {/* Clocked Out */}
    {!loading && done.length > 0 && <div>
      <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>
        ✅ Clocked Out Today ({done.length})
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
        {done.map(s => {
          const hrs = calcHours(s.clockIn, s.clockOut);
          return <div key={s.id} style={{...sCrd,borderLeft:"3px solid "+T.border,opacity:0.8}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:T.hover,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:T.muted,flexShrink:0}}>
                {s.name?.charAt(0).toUpperCase()}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,color:T.text}}>{s.name}</div>
                <div style={{fontSize:11,color:T.muted}}>{s.event||"Daily Operations"}</div>
              </div>
              <button onClick={()=>{ if(window.confirm(`Remove ${s.name} from Live Crew?`)) deleteSession(s.id); }} style={{background:"none",border:"1px solid "+T.border,borderRadius:6,padding:"2px 6px",cursor:"pointer",color:T.muted,fontSize:11}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:12}}>
              <div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:2}}>CLOCK IN</div>
                <div style={{fontWeight:600,color:T.text}}>{s.clockIn||"—"}</div>
              </div>
              <div style={{background:T.hover,borderRadius:6,padding:"6px 8px"}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:2}}>CLOCK OUT</div>
                <div style={{fontWeight:600,color:T.text}}>{s.clockOut||"—"}</div>
              </div>
            </div>
            {hrs && <div style={{fontSize:12,color:T.text,fontWeight:600,marginTop:6}}>Total: {hrs}h</div>}
            {(s.truck||s.trailer)&&<div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
              {s.truck&&<span style={{fontSize:11,color:T.muted}}>🚛 {s.truck}</span>}
              {s.trailer&&<span style={{fontSize:11,color:T.muted}}>TRL: {s.trailer}</span>}
            </div>}
            {s.unitLog&&s.unitLog.length>0&&<div style={{marginTop:6}}>
              <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:T.muted,marginBottom:4}}>All Units Used</div>
              {s.unitLog.map((u,i)=>(
                <div key={i} style={{fontSize:11,color:T.muted,display:"flex",justifyContent:"space-between",padding:"2px 0"}}>
                  <span>{u.truck&&`🚛 ${u.truck}`}{u.trailer&&` TRL: ${u.trailer}`}{u.kmTotal!=null&&` (+${u.kmTotal.toFixed(0)}km)`}</span>
                  <span style={{fontSize:10,color:T.dim}}>{u.time}</span>
                </div>
              ))}
            </div>}
            <button onClick={()=>{ if(window.confirm(`Remove ${s.name} from Live Crew?`)) deleteSession(s.id); }} style={{...bD,marginTop:8,width:"100%",fontSize:11,padding:"4px"}}>Remove</button>
          </div>;
        })}
      </div>
    </div>}
  </div>;
}

// ═══ REPORTS PAGE ═══
// ═══════════════════════════════════════════════════════════════════════════
// ROSTER & EQUIPMENT REPORTS
// PDF via print-window (same approach as BOL), Excel via SheetJS (xlsx).
// ═══════════════════════════════════════════════════════════════════════════

const RPT_CERTS = [
  { k: "acrDate", l: "ACR Training", months: 12 },
  { k: "hazmatDate", l: "HazMat Training", months: 36 },
  { k: "crimDate", l: "Criminal Record Check", months: 60 },
  { k: "bgDate", l: "Background Verification", months: 0 },
  { k: "conductDate", l: "Code of Conduct", months: 0 },
  { k: "licenseExpiry", l: "Driver's Licence", direct: true },
];

// Resolve a cert's effective expiry date (YYYY-MM-DD) or "" when N/A.
function rptExpDate(dateStr, months, direct) {
  if (!dateStr) return "";
  if (direct) return dateStr;
  if (!months) return dateStr;
  const d = new Date(dateStr + "T12:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function rptDaysLeft(expStr) {
  if (!expStr) return null;
  return Math.floor((new Date(expStr + "T12:00:00") - new Date()) / (1000 * 60 * 60 * 24));
}
function rptStatus(dateStr, months, direct) {
  if (!dateStr) return { txt: "Not set", color: "#94a3b8" };
  if (!direct && months === 0) return { txt: "Done", color: "#16a34a" };
  const exp = rptExpDate(dateStr, months, direct);
  const dl = rptDaysLeft(exp);
  if (dl === null) return { txt: "Not set", color: "#94a3b8" };
  if (dl < 0) return { txt: `EXPIRED ${Math.abs(dl)}d ago`, color: "#dc2626" };
  if (dl <= 30) return { txt: `${dl}d left`, color: "#ca8a04" };
  if (dl <= 90) return { txt: `${dl}d left`, color: "#ea580c" };
  return { txt: "Valid", color: "#16a34a" };
}

const rptFmtPay = (cfg) => {
  if (!cfg) return "";
  const parts = [];
  if (cfg.hourly) parts.push(`Hourly: $${cfg.hourly}/hr`);
  if (cfg.workDay) parts.push(`Work Day: $${cfg.workDay}`);
  if (cfg.nonWorkDay) parts.push(`Non-Work Day: $${cfg.nonWorkDay}`);
  if (cfg.perDiem) parts.push(`Per Diem: $${cfg.perDiem}`);
  if (cfg.tripRate) parts.push(`Trip Rate: $${cfg.tripRate}`);
  return parts.join(" | ");
};

const rptRole = (p) => {
  if (p.isSupplier) return "Supplier";
  const r = [];
  if (p.isDriver !== false) r.push("Driver");
  if (p.isEmployee) r.push("Employee");
  return r.join(" / ") || "—";
};

const rptAddr = (p) => [p.street, p.city, p.provState, p.postalZip, p.country].filter(Boolean).join(", ");

// ─── Field maps: every stored field, in report order ───
function rptPersonRows(p) {
  const rows = [
    ["Name", p.name || ""],
    ["Role", rptRole(p)],
    ["Phone", p.phone || ""],
    ["Email", p.email || ""],
  ];
  if (p.isSupplier) {
    rows.push(["Contact Person", p.contactPerson || ""]);
    rows.push(["Service Type", p.serviceType || ""]);
  } else {
    rows.push(["Licence Class", p.license || ""]);
    rows.push(["Employee ID", p.employeeId || ""]);
    rows.push(["PIN", p.pin || ""]);
  }
  rows.push(["Address", rptAddr(p)]);
  if (!p.isSupplier) {
    rows.push(["Pay Configuration", rptFmtPay(p.payCfg)]);
    RPT_CERTS.forEach(c => {
      const exp = rptExpDate(p[c.k], c.months, c.direct);
      const st = rptStatus(p[c.k], c.months, c.direct);
      const base = c.direct ? "" : (p[c.k] ? `Completed ${fd(p[c.k])}` : "");
      const expTxt = exp ? `Expires ${fd(exp)}` : "";
      rows.push([c.l, [base, expTxt, st.txt].filter(Boolean).join(" — ")]);
    });
  }
  const docCount = ["acrDocs","hazmatDocs","crimDocs","bgDocs","conductDocs","licenseDocs","docs"]
    .reduce((s,k) => s + (p[k]||[]).length, 0);
  if (!p.isSupplier && p.alertsMuted) {
    const until = p.alertsMutedUntil ? `until ${fd(p.alertsMutedUntil)}` : "indefinite";
    rows.push(["Expiry Alerts", `PAUSED (${until})${p.alertsMutedReason ? ` — ${p.alertsMutedReason}` : ""}`]);
  }
  if (!p.isSupplier) rows.push(["Portal Daily Log", p.logRestricted ? "RESTRICTED" : (p.driverLog ? "Driver log (no Expenses/Summary)" : "Full")]);
  rows.push(["Documents on File", String(docCount)]);
  return rows;
}

function rptUnitRows(u) {
  const st = u.safetyExp ? rptStatus(u.safetyExp, 0, true) : null;
  return [
    ["Unit #", u.unit || ""],
    ["Plate #", u.plate || ""],
    ["Year", u.year != null ? String(u.year) : ""],
    ["Make", u.make || ""],
    ["Model", u.model || ""],
    ["Type", u.type || ""],
    ["VIN", u.vin || ""],
    ["Safety Expiration", u.safetyExp ? `${fd(u.safetyExp)} — ${st.txt}` : ""],
    ["Internal Notes", u.notes || ""],
    ["Documents on File", String((u.docs || []).length)],
  ];
}

// ─── Flat columns for multi-record (summary) reports ───
const RPT_UNIT_COLS = [
  ["Unit #", u => u.unit || ""],
  ["Plate #", u => u.plate || ""],
  ["Year", u => u.year != null ? String(u.year) : ""],
  ["Make", u => u.make || ""],
  ["Model", u => u.model || ""],
  ["Type", u => u.type || ""],
  ["VIN", u => u.vin || ""],
  ["Safety Exp", u => u.safetyExp ? fd(u.safetyExp) : ""],
  ["Safety Status", u => u.safetyExp ? rptStatus(u.safetyExp, 0, true).txt : "Not set"],
  ["Notes", u => u.notes || ""],
  ["Docs", u => String((u.docs || []).length)],
];

const RPT_PERSON_COLS = [
  ["Name", p => p.name || ""],
  ["Role", p => rptRole(p)],
  ["Phone", p => p.phone || ""],
  ["Email", p => p.email || ""],
  ["Licence Class", p => p.license || ""],
  ["Employee ID", p => p.employeeId || ""],
  ["PIN", p => p.pin || ""],
  ["Contact Person", p => p.contactPerson || ""],
  ["Service Type", p => p.serviceType || ""],
  ["Address", p => rptAddr(p)],
  ["Pay Configuration", p => rptFmtPay(p.payCfg)],
  ...RPT_CERTS.map(c => [c.l, p => {
    const exp = rptExpDate(p[c.k], c.months, c.direct);
    const st = rptStatus(p[c.k], c.months, c.direct);
    return exp ? `${fd(exp)} (${st.txt})` : st.txt;
  }]),
  ["Expiry Alerts", p => p.alertsMuted
    ? `PAUSED${p.alertsMutedUntil ? ` until ${fd(p.alertsMutedUntil)}` : ""}${p.alertsMutedReason ? ` — ${p.alertsMutedReason}` : ""}`
    : "Active"],
  ["Portal Daily Log", p => p.logRestricted ? "Restricted" : (p.driverLog ? "Driver log" : "Full")],
  ["Docs", p => String(["acrDocs","hazmatDocs","crimDocs","bgDocs","conductDocs","licenseDocs","docs"].reduce((s,k)=>s+(p[k]||[]).length,0))],
];

// ─── PDF (print window) ───
const rptEsc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function rptOpenPdf(title, bodyHtml) {
  const w = window.open("", "_blank");
  if (!w) { alert("Please allow popups to view the PDF."); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${rptEsc(title)}</title>
  <style>
    @page { size: landscape; margin: 12mm; }
    @media print {
      body { margin:0; padding:0 }
      .no-print { display:none !important }
      .rec { page-break-inside: avoid }
      /* Repeat the DBX header band on every printed page. */
      .hd { position: fixed; top:0; left:0; right:0; background:#fff; margin:0; }
      /* Reserve room so page-one content doesn't slide under the fixed header. */
      .content { padding-top: 86px; }
      /* Repeat column headers on every page and keep rows from splitting. */
      thead { display: table-header-group; }
      tbody tr { page-break-inside: avoid; }
    }
    body { font-family:'Helvetica Neue',Arial,sans-serif; margin:0; padding:24px; background:#fff; color:#0f172a }
    .hd { display:flex; align-items:center; gap:16px; border-bottom:3px solid #dc2626; padding-bottom:12px; margin-bottom:18px }
    .hd img { height:54px }
    .hd h1 { margin:0; font-size:20px; font-weight:700 }
    .hd .meta { margin-left:auto; text-align:right; font-size:11px; color:#64748b }
    table { border-collapse:collapse; width:100%; font-size:10px; margin-bottom:18px }
    th,td { border:1px solid #cbd5e1; padding:5px 7px; text-align:left; vertical-align:top }
    th { background:#f1f5f9; font-weight:700; font-size:9px; text-transform:uppercase; letter-spacing:.4px }
    /* -webkit-print-color-adjust keeps header shading from being dropped by the printer. */
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tr:nth-child(even) td { background:#f8fafc }
    .rec { margin-bottom:22px }
    .rec h2 { font-size:14px; margin:0 0 8px; padding-bottom:5px; border-bottom:2px solid #e2e8f0 }
    .kv { width:100%; font-size:11px }
    .kv td:first-child { width:210px; font-weight:600; background:#f8fafc; color:#475569 }
    .ft { margin-top:20px; font-size:9px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:8px }
  </style></head><body>
    <div class="hd">
      <img src="${LOGO}" alt="DBX"/>
      <h1>${rptEsc(title)}</h1>
      <div class="meta">Diamond Back Express Inc.<br/>Generated ${new Date().toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"})}</div>
    </div>
    <div class="content">
    ${bodyHtml}
    <div class="ft">Confidential — internal use only. Diamond Back Express Inc. / CargoDX.</div>
    </div>
    <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 4px 12px rgba(220,38,38,.4)">🖨 Print / Save as PDF</button>
    </div>
  </body></html>`);
  w.document.close();
}

function rptTableHtml(cols, rows) {
  // <thead> is what makes the browser repeat column headers on every printed page.
  const head = `<thead><tr>${cols.map(c => `<th>${rptEsc(c[0])}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${rptEsc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function rptDetailHtml(records, titleFn, rowsFn) {
  return records.map(r => `<div class="rec"><h2>${rptEsc(titleFn(r))}</h2><table class="kv">${
    rowsFn(r).map(([k,v]) => `<tr><td>${rptEsc(k)}</td><td>${rptEsc(v)}</td></tr>`).join("")
  }</table></div>`).join("");
}

// ─── Excel (SheetJS, lazy-loaded) ───
async function rptExcel(filename, sheets) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, aoa }) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const widths = (aoa[0] || []).map((_, i) =>
      ({ wch: Math.min(46, Math.max(12, ...aoa.map(r => String(r[i] ?? "").length + 2))) }));
    ws["!cols"] = widths;
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  });
  XLSX.writeFile(wb, filename);
}

const rptAoaFlat = (cols, rows) => [cols.map(c => c[0]), ...rows.map(r => cols.map(c => c[1](r)))];
const rptAoaDetail = (records, titleFn, rowsFn) => {
  const out = [];
  records.forEach((r, i) => {
    if (i) out.push([]);
    out.push([titleFn(r)]);
    rowsFn(r).forEach(([k, v]) => out.push([k, v]));
  });
  return out;
};

function RosterEquipReports({ db }) {
  const [scope, setScope] = useState("equipment"); // equipment | people
  const [cat, setCat] = useState("trucks");        // trucks|trailers|all  /  drivers|employees|suppliers|all
  const [mode, setMode] = useState("all");         // all | selected
  const [sel, setSel] = useState([]);
  const [detail, setDetail] = useState(true);
  const [busy, setBusy] = useState(false);

  const trucks = (db.trucks || []).map(t => ({ ...t, _kind: "Truck" }));
  const trailers = (db.trailers || []).map(t => ({ ...t, _kind: "Trailer" }));
  const people = db.drivers || [];

  const pool = useMemo(() => {
    if (scope === "equipment") {
      const arr = cat === "trucks" ? trucks : cat === "trailers" ? trailers : [...trucks, ...trailers];
      return [...arr].sort((a, b) => String(a.unit || "").localeCompare(String(b.unit || ""), undefined, { numeric: true }));
    }
    const arr = people.filter(p => {
      if (cat === "drivers") return p.isDriver !== false && !p.isSupplier;
      if (cat === "employees") return p.isEmployee === true && !p.isSupplier;
      if (cat === "suppliers") return p.isSupplier === true;
      return true;
    });
    return [...arr].sort((a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
  }, [scope, cat, db.trucks, db.trailers, db.drivers]);

  useEffect(() => { setSel([]); }, [scope, cat]);

  const chosen = mode === "all" ? pool : pool.filter(x => sel.includes(x.id));
  const isEquip = scope === "equipment";
  const label = x => isEquip ? `${x._kind || "Unit"} ${x.unit || "(no unit #)"}` : (x.name || "(unnamed)");
  const catLabel = { trucks:"Trucks", trailers:"Trailers", all: isEquip ? "All Units" : "All People",
                     drivers:"Drivers", employees:"Employees", suppliers:"Suppliers" }[cat] || "";
  const title = `${isEquip ? "Equipment" : "Roster"} Report — ${catLabel}${mode === "selected" ? ` (${chosen.length} selected)` : ""}`;
  const cols = isEquip ? RPT_UNIT_COLS : RPT_PERSON_COLS;
  const rowsFn = isEquip ? rptUnitRows : rptPersonRows;
  const stamp = new Date().toISOString().slice(0, 10);

  const doPdf = () => {
    if (!chosen.length) return alert("Nothing selected.");
    rptOpenPdf(title, detail
      ? rptDetailHtml(chosen, label, rowsFn)
      : rptTableHtml(cols, chosen));
  };
  const doExcel = async () => {
    if (!chosen.length) return alert("Nothing selected.");
    setBusy(true);
    try {
      const aoa = detail ? rptAoaDetail(chosen, label, rowsFn) : rptAoaFlat(cols, chosen);
      await rptExcel(`${isEquip ? "equipment" : "roster"}-${cat}-${stamp}.xlsx`,
        [{ name: catLabel || "Report", aoa }]);
    } catch (e) { console.error(e); alert("Excel export failed. Is the 'xlsx' package installed?"); }
    setBusy(false);
  };
  // Single-record shortcut
  const onePdf = (x) => rptOpenPdf(`${label(x)} — Detail`, rptDetailHtml([x], label, rowsFn));
  const oneExcel = async (x) => {
    setBusy(true);
    try { await rptExcel(`${(isEquip ? (x.unit||"unit") : (x.name||"record")).replace(/[^\w\-]+/g,"_")}-${stamp}.xlsx`,
      [{ name: "Detail", aoa: rptAoaDetail([x], label, rowsFn) }]); }
    catch (e) { console.error(e); alert("Excel export failed. Is the 'xlsx' package installed?"); }
    setBusy(false);
  };

  const tabBtn = (active, onClick, children) => (
    <button onClick={onClick} style={{ padding:"6px 14px", borderRadius:6, background: active ? T.border : "transparent",
      border:`1px solid ${active ? "#334155" : T.border}`, color: active ? T.text : T.muted, fontSize:12,
      cursor:"pointer", fontFamily:"inherit", fontWeight: active ? 600 : 400 }}>{children}</button>
  );

  return <div>
    <div style={{ ...sCrd }}>
      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", marginBottom:8 }}>Report Type</div>
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
        {tabBtn(scope==="equipment", ()=>{setScope("equipment");setCat("trucks");}, "Equipment")}
        {tabBtn(scope==="people", ()=>{setScope("people");setCat("drivers");}, "Drivers / Employees / Suppliers")}
      </div>

      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", marginBottom:8 }}>Category</div>
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
        {(isEquip ? [["trucks","Trucks"],["trailers","Trailers"],["all","All Units"]]
                  : [["drivers","Drivers"],["employees","Employees"],["suppliers","Suppliers"],["all","All"]])
          .map(([k,l]) => <span key={k}>{tabBtn(cat===k, ()=>setCat(k), l)}</span>)}
      </div>

      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", marginBottom:8 }}>Scope</div>
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
        {tabBtn(mode==="all", ()=>setMode("all"), `All in category (${pool.length})`)}
        {tabBtn(mode==="selected", ()=>setMode("selected"), `Choose specific (${sel.length})`)}
      </div>

      <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:T.text, marginBottom:12, cursor:"pointer" }}>
        <input type="checkbox" checked={detail} onChange={e=>setDetail(e.target.checked)} style={{ accentColor:T.red }}/>
        Full detail (every field per record). Uncheck for a compact one-row-per-record table.
      </label>

      {mode==="selected" && <div style={{ maxHeight:280, overflowY:"auto", border:`1px solid ${T.border}`, borderRadius:8, padding:8, marginBottom:12 }}>
        <div style={{ display:"flex", gap:8, marginBottom:8 }}>
          <button style={{...bS, padding:"4px 10px", fontSize:11}} onClick={()=>setSel(pool.map(x=>x.id))}>Select all</button>
          <button style={{...bS, padding:"4px 10px", fontSize:11}} onClick={()=>setSel([])}>Clear</button>
        </div>
        {pool.length === 0 && <div style={{ fontSize:12, color:T.dim, padding:6 }}>Nothing in this category.</div>}
        {pool.map(x => <label key={x.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 6px", fontSize:12, color:T.text, cursor:"pointer" }}>
          <input type="checkbox" checked={sel.includes(x.id)} style={{ accentColor:T.red }}
            onChange={e => setSel(p => e.target.checked ? [...p, x.id] : p.filter(i => i !== x.id))}/>
          {label(x)}
        </label>)}
      </div>}

      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        <button style={bP} disabled={busy} onClick={doPdf}><Ic n="file" s={14}/> Generate PDF ({chosen.length})</button>
        <button style={{...bS}} disabled={busy} onClick={doExcel}>{busy ? "Working..." : `Generate Excel (${chosen.length})`}</button>
      </div>
    </div>

    <div style={sCrd}>
      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", marginBottom:8 }}>
        Per-record reports ({pool.length})
      </div>
      {pool.length === 0 && <div style={{ fontSize:12, color:T.dim }}>Nothing in this category.</div>}
      <div style={{ display:"grid", gap:6 }}>
        {pool.map(x => <div key={x.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px",
          background:T["bg"], border:`1px solid ${T.border}`, borderRadius:6 }}>
          <div style={{ fontSize:12, fontWeight:600, flex:1 }}>{label(x)}</div>
          <button style={{...bS, padding:"4px 10px", fontSize:11}} onClick={()=>onePdf(x)}>PDF</button>
          <button style={{...bS, padding:"4px 10px", fontSize:11}} disabled={busy} onClick={()=>oneExcel(x)}>Excel</button>
        </div>)}
      </div>
    </div>
  </div>;
}

function ReportsPage({db, go}) {
  const [rptView, setRptView] = useState("orders"); // orders | roster
  const [period, setPeriod] = useState("month"); // day, week, month, year, custom, all
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [groupBy, setGroupBy] = useState("summary"); // summary, client, driver, division, daily, weekly, monthly
  const [curFilter, setCurFilter] = useState("ALL");
  const [cliFilter, setCliFilter] = useState("ALL");
  const [drvFilter, setDrvFilter] = useState("ALL");
  const [divFilter, setDivFilter] = useState("ALL");
  const [evtFilter, setEvtFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState(["ready-to-bill","closed","invoiced"]);

  // Date range calculation
  const now = new Date();
  let rangeFrom, rangeTo;
  if (period === "day") {
    rangeFrom = td();
    rangeTo = td();
  } else if (period === "week") {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay());
    rangeFrom = d.toISOString().slice(0,10);
    rangeTo = td();
  } else if (period === "month") {
    rangeFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
    rangeTo = td();
  } else if (period === "lastmonth") {
    const lm = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const lme = new Date(now.getFullYear(), now.getMonth(), 0);
    rangeFrom = lm.toISOString().slice(0,10);
    rangeTo = lme.toISOString().slice(0,10);
  } else if (period === "year") {
    rangeFrom = `${now.getFullYear()}-01-01`;
    rangeTo = td();
  } else if (period === "custom") {
    rangeFrom = customFrom || "2020-01-01";
    rangeTo = customTo || td();
  } else {
    rangeFrom = "2020-01-01";
    rangeTo = "2099-12-31";
  }

  // Calculate total for an order
  const calcTotal = (o) => {
    const p = o.price || {};
    const baseAmt = parseFloat(p.base) || 0;
    const fuelPct = parseFloat(p.fuelPct) || 0;
    const fuelAmt = baseAmt * (fuelPct / 100);
    const subtotal = baseAmt + fuelAmt;
    const otherTotal = (p.other || []).reduce((s, c) => s + (parseFloat(c.amt) || 0), 0);
    const taxModeObj = TAX_MODES.find(t => t.k === p.taxMode) || TAX_MODES[0];
    const taxPct = p.taxMode === "CUSTOM" ? (parseFloat(p.taxCustom) || 0) : taxModeObj.pct;
    const taxAmt = p.taxMode === "NONE" ? 0 : (subtotal + otherTotal) * (taxPct / 100);
    const transportTotal = subtotal + otherTotal + taxAmt;
    // Add event lines with their individual taxes
    const evtLinesTotal = (p.eventLines || []).filter(l => l.desc).reduce((s, l) => {
      const lb = (parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0);
      const ltp = l.taxMode === "HST" ? 13 : l.taxMode === "GST" ? 5 : l.taxMode === "CUSTOM" ? (parseFloat(l.taxCustom) || 0) : 0;
      return s + lb + lb * (ltp / 100);
    }, 0);
    return transportTotal + evtLinesTotal;
  };

  // Filter orders that have pricing and fall within date range
  const pricedOrders = db.orders.filter(o => {
    const p = o.price || {};
    const hasBase = p.base && parseFloat(p.base) > 0;
    const hasEvtLines = (p.eventLines || []).some(l => l.desc && parseFloat(l.unitPrice) > 0);
    if (!hasBase && !hasEvtLines) return false;
    if (statusFilter.length > 0 && !statusFilter.includes(o.status)) return false;
    const d = o.pickDate || o.pickStops?.[0]?.date || o.delDate || o.delStops?.[0]?.date || o.reqDate || (o.created ? o.created.slice(0,10) : "");
    if (!d) return false;
    if (d < rangeFrom || d > rangeTo) return false;
    if (curFilter !== "ALL" && (p.cur || "CAD") !== curFilter) return false;
    if (cliFilter !== "ALL" && o.cliId !== cliFilter) return false;
    if (drvFilter !== "ALL" && o.drvId !== drvFilter) return false;
    if (divFilter !== "ALL" && o.divId !== divFilter) return false;
    if (evtFilter !== "ALL") {
      const ev = (db.events||[]).find(e=>e.id===evtFilter);
      const matchById = o.linkedEventId === evtFilter;
      const matchByName = ev && o.linkedEventName && o.linkedEventName === ev.name;
      if (!matchById && !matchByName) return false;
    }
    return true;
  });

  // Group by currency
  const byCurrency = {};
  pricedOrders.forEach(o => {
    const cur = (o.price?.cur) || "CAD";
    if (!byCurrency[cur]) byCurrency[cur] = { orders: [], total: 0 };
    const t = calcTotal(o);
    byCurrency[cur].orders.push({ ...o, _total: t });
    byCurrency[cur].total += t;
  });

  // Build grouped rows
  const buildRows = () => {
    const rows = [];
    if (groupBy === "summary") {
      Object.entries(byCurrency).forEach(([cur, data]) => {
        rows.push({ label: `Total (${cur})`, count: data.orders.length, total: data.total, cur });
      });
    } else if (groupBy === "client") {
      const byClient = {};
      pricedOrders.forEach(o => {
        const key = `${o.cliName || "Unknown"}|||${(o.price?.cur) || "CAD"}`;
        if (!byClient[key]) byClient[key] = { count: 0, total: 0, cur: (o.price?.cur) || "CAD", name: o.cliName || "Unknown" };
        byClient[key].count++;
        byClient[key].total += calcTotal(o);
      });
      Object.values(byClient).sort((a, b) => b.total - a.total).forEach(r => rows.push({ label: r.name, count: r.count, total: r.total, cur: r.cur }));
    } else if (groupBy === "driver") {
      const byDrv = {};
      pricedOrders.forEach(o => {
        const key = `${o.drvName || "Unassigned"}|||${(o.price?.cur) || "CAD"}`;
        if (!byDrv[key]) byDrv[key] = { count: 0, total: 0, cur: (o.price?.cur) || "CAD", name: o.drvName || "Unassigned" };
        byDrv[key].count++;
        byDrv[key].total += calcTotal(o);
      });
      Object.values(byDrv).sort((a, b) => b.total - a.total).forEach(r => rows.push({ label: r.name, count: r.count, total: r.total, cur: r.cur }));
    } else if (groupBy === "division") {
      const byDiv = {};
      pricedOrders.forEach(o => {
        const div = DIVS.find(d => d.id === o.divId);
        const name = div ? div.short : "No Division";
        const key = `${name}|||${(o.price?.cur) || "CAD"}`;
        if (!byDiv[key]) byDiv[key] = { count: 0, total: 0, cur: (o.price?.cur) || "CAD", name };
        byDiv[key].count++;
        byDiv[key].total += calcTotal(o);
      });
      Object.values(byDiv).sort((a, b) => b.total - a.total).forEach(r => rows.push({ label: r.name, count: r.count, total: r.total, cur: r.cur }));
    } else if (groupBy === "daily" || groupBy === "weekly" || groupBy === "monthly") {
      const byPeriod = {};
      pricedOrders.forEach(o => {
        let key;
        const d = o.delDate || o.delStops?.[0]?.date || o.reqDate || o.pickDate || (o.created ? o.created.slice(0,10) : "");
        if (groupBy === "daily") key = d;
        else if (groupBy === "weekly") {
          const dt = new Date(d + "T12:00:00");
          const day = dt.getDay();
          dt.setDate(dt.getDate() - day);
          key = "Week of " + dt.toISOString().slice(0, 10);
        } else {
          key = d.slice(0, 7);
        }
        const cur = (o.price?.cur) || "CAD";
        const gKey = `${key}|||${cur}`;
        if (!byPeriod[gKey]) byPeriod[gKey] = { count: 0, total: 0, cur, name: key };
        byPeriod[gKey].count++;
        byPeriod[gKey].total += calcTotal(o);
      });
      Object.values(byPeriod).sort((a, b) => a.name > b.name ? -1 : 1).forEach(r => rows.push({ label: r.name, count: r.count, total: r.total, cur: r.cur }));
    }
    return rows;
  };

  const rows = buildRows();
  const grandTotals = {};
  rows.forEach(r => {
    if (!grandTotals[r.cur]) grandTotals[r.cur] = { total: 0, count: 0 };
    grandTotals[r.cur].total += r.total;
    grandTotals[r.cur].count += r.count;
  });

  // CSV content builder
  const buildCSV = () => {
    const header = "Group,Orders,Total,Currency\n";
    const body = rows.map(r => `"${r.label}",${r.count},${r.total.toFixed(2)},${r.cur}`).join("\n");
    const footer = "\n\n" + Object.entries(grandTotals).map(([c, d]) => `"GRAND TOTAL (${c})",${d.count},${d.total.toFixed(2)},${c}`).join("\n");
    return header + body + footer;
  };

  // PDF HTML builder
  const buildReportHTML = () => {
    const periodLabel = `${fd(rangeFrom)} — ${fd(rangeTo)}`;
    const totalsHTML = Object.entries(grandTotals).map(([c, d]) =>
      `<div style="display:inline-block;border:2px solid #0ea5e9;border-radius:8px;padding:12px 20px;margin:0 10px 10px 0"><div style="font-size:10px;font-weight:700;color:#0ea5e9;text-transform:uppercase;margin-bottom:4px">Total Revenue (${c})</div><div style="font-size:22px;font-weight:700">${csym(c)}${d.total.toFixed(2)}</div><div style="font-size:11px;color:#666;margin-top:2px">${d.count} order${d.count!==1?"s":""}</div></div>`
    ).join("");
    const tableRows = rows.map(r =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #ddd">${r.label}</td><td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${r.count}</td><td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;font-weight:700">${csym(r.cur)}${r.total.toFixed(2)}</td><td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;color:#888">${r.cur}</td></tr>`
    ).join("");
    const detailRows = pricedOrders.sort((a,b)=>b.reqDate>a.reqDate?1:-1).map(o => {
      const t = calcTotal(o); const cur = (o.price?.cur)||"CAD";
      return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-weight:600">${o.bol}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${fd(o.reqDate)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${o.cliName||"—"}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${(typeof o.ref==="string"?o.ref:o.ref?.value||"")||"—"}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${csym(cur)}${t.toFixed(2)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;color:#888">${cur}</td></tr>`;
    }).join("");

    const evtLabel = evtFilter !== "ALL" ? (db.events||[]).find(e=>e.id===evtFilter)?.name || "" : "";
    return `<html><head><title>${APP_NAME} Report</title><style>body{font-family:Arial,sans-serif;margin:30px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#f1f5f9;text-align:left;padding:8px 10px;font-weight:700}@media print{body{margin:15px}}</style></head><body>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><img src="${LOGO}" style="height:40px;border-radius:4px"/><div><div style="font-weight:800;font-size:16px">${APP_NAME} — REPORT</div><div style="font-size:11px;color:#666">${COMPANY_NAME}</div></div></div>
<hr style="border:none;border-top:3px solid #dc2626;margin:10px 0 16px"/>
<div style="font-size:12px;color:#555;margin-bottom:4px"><b>Period:</b> ${periodLabel} &nbsp;&nbsp; <b>Group by:</b> ${groupBy} &nbsp;&nbsp; <b>Orders:</b> ${pricedOrders.length}${evtLabel?` &nbsp;&nbsp; <b>Event:</b> ${evtLabel}`:""}</div>
<div style="margin:14px 0">${totalsHTML}</div>
${rows.length>0?`<table><thead><tr><th>Breakdown</th><th style="text-align:right">Orders</th><th style="text-align:right">Total</th><th style="text-align:right">Currency</th></tr></thead><tbody>${tableRows}</tbody></table>`:""}
${pricedOrders.length>0?`<h3 style="margin-top:20px;font-size:13px">Order Details</h3><table><thead><tr><th>BOL</th><th>Date</th><th>Client</th><th>Ref</th><th style="text-align:right">Total</th><th>Cur</th></tr></thead><tbody>${detailRows}</tbody></table>`:""}
</body></html>`;
  };

  // Download handler
  const downloadReport = (fmt) => {
    if (fmt === "csv") {
      const blob = new Blob([buildCSV()], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `${APP_NAME.replace(/ /g,"_")}_Report_${groupBy}_${rangeFrom}_${rangeTo}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } else {
      const w = window.open("", "_blank");
      w.document.write(buildReportHTML());
      w.document.close();
      setTimeout(() => w.print(), 400);
    }
  };

  // Email report
  const [showDetail, setShowDetail] = useState(false);

  const selStyle = { ...sIn, maxWidth: 180, fontSize: 11, padding: "5px 8px" };
  const filterBox = { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, alignItems: "flex-end" };

  return <div style={{ padding: 20 }}>
    <PageHdr title="Reports">
      {rptView==="orders" && <>
        <button style={bP} onClick={()=>downloadReport("csv")}><Ic n="dl" s={14}/> CSV</button>
        <button style={{...bP,background:"#7c3aed"}} onClick={()=>downloadReport("pdf")}><Ic n="pdf" s={14}/> PDF</button>
      </>}
    </PageHdr>

    <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
      {[["orders","Orders & Revenue"],["roster","Equipment & Roster"]].map(([k,l])=>
        <button key={k} onClick={()=>setRptView(k)} style={{padding:"6px 14px",borderRadius:6,
          background:rptView===k?T.border:"transparent",border:`1px solid ${rptView===k?"#334155":T.border}`,
          color:rptView===k?T.text:T.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit",
          fontWeight:rptView===k?600:400}}>{l}</button>)}
    </div>

    {rptView==="roster" && <RosterEquipReports db={db}/>}
    {rptView==="orders" && <>

    {/* Filters row 1 — Period */}
    <div style={filterBox}>
      <div><label style={{...sLbl, marginBottom: 2}}>Period</label>
        <select style={selStyle} value={period} onChange={e => setPeriod(e.target.value)}>
          <option value="day">Today</option><option value="week">This Week</option><option value="month">This Month</option>
          <option value="lastmonth">Last Month</option><option value="year">This Year</option><option value="custom">Custom Range</option><option value="all">All Time</option>
        </select></div>
      {period === "custom" && <>
        <div><label style={{...sLbl, marginBottom: 2}}>From</label><DatePicker value={customFrom} onChange={v => setCustomFrom(v)} placeholder="From date..."/></div>
        <div><label style={{...sLbl, marginBottom: 2}}>To</label><DatePicker value={customTo} onChange={v => setCustomTo(v)} placeholder="To date..."/></div>
      </>}
      <div><label style={{...sLbl, marginBottom: 2}}>Group By</label>
        <select style={selStyle} value={groupBy} onChange={e => setGroupBy(e.target.value)}>
          <option value="summary">Summary</option><option value="client">Client</option><option value="driver">Driver</option>
          <option value="division">Division</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select></div>
      <div><label style={{...sLbl, marginBottom: 2}}>Currency</label>
        <select style={selStyle} value={curFilter} onChange={e => setCurFilter(e.target.value)}>
          <option value="ALL">All Currencies</option>{CURRS.map(c => <option key={c.v} value={c.v}>{c.v}</option>)}
        </select></div>
    </div>

    {/* Filters row 2 — Client / Driver / Division / Status */}
    <div style={filterBox}>
      <div><label style={{...sLbl, marginBottom: 2}}>Client</label>
        <select style={selStyle} value={cliFilter} onChange={e => setCliFilter(e.target.value)}>
          <option value="ALL">All Clients</option>{[...db.clients].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(c => <option key={c.id} value={c.id}>{c.name}{c.city?" — "+c.city:""}</option>)}
        </select></div>
      <div><label style={{...sLbl, marginBottom: 2}}>Event</label>
        <select style={selStyle} value={evtFilter} onChange={e => { setEvtFilter(e.target.value); if(e.target.value !== "ALL") { setPeriod("all"); setStatusFilter([]); } }}>
          <option value="ALL">All Events</option>{[...(db.events||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(ev => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
        </select></div>
      <div><label style={{...sLbl, marginBottom: 2}}>Driver</label>
        <select style={selStyle} value={drvFilter} onChange={e => setDrvFilter(e.target.value)}>
          <option value="ALL">All Drivers</option>{db.drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select></div>
      <div><label style={{...sLbl, marginBottom: 2}}>Division</label>
        <select style={selStyle} value={divFilter} onChange={e => setDivFilter(e.target.value)}>
          <option value="ALL">All Divisions</option>{DIVS.map(d => <option key={d.id} value={d.id}>{d.short}</option>)}
        </select></div>
      <div>
        <label style={{...sLbl, marginBottom: 2}}>Status</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:2}}>
          {[{k:"all",l:"All"},{k:"closed",l:"Closed"},{k:"invoiced",l:"Invoiced"},{k:"ready-to-bill",l:"Ready to Bill"},{k:"in-transit",l:"In Transit"},{k:"assigned",l:"Assigned / In Progress"},{k:"unassigned",l:"Unassigned"}].map(s=>(
            <button key={s.k} onClick={()=>{
              if(s.k==="all"){ setStatusFilter([]); return; }
              setStatusFilter(prev=>prev.includes(s.k)?prev.filter(x=>x!==s.k):[...prev,s.k]);
            }} style={{
              padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",
              border:`1px solid ${s.k==="all"?(statusFilter.length===0?"#0ea5e9":T.border):(statusFilter.includes(s.k)?"#0ea5e9":T.border)}`,
              background:s.k==="all"?(statusFilter.length===0?"rgba(14,165,233,0.1)":"transparent"):(statusFilter.includes(s.k)?"rgba(14,165,233,0.1)":"transparent"),
              color:s.k==="all"?(statusFilter.length===0?"#0ea5e9":T.muted):(statusFilter.includes(s.k)?"#0ea5e9":T.muted),
            }}>{s.l}</button>
          ))}
        </div>
      </div>
    </div>

    {/* Period label */}
    <div style={{fontSize:11,color:T.muted,marginBottom:12}}>
      {fd(rangeFrom)} — {fd(rangeTo)} · {pricedOrders.length} order{pricedOrders.length!==1?"s":""}
    </div>

    {/* Grand totals cards */}
    <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
      {Object.entries(grandTotals).map(([cur, d]) => (
        <div key={cur} style={{...sCrd, borderColor:"#0ea5e9", minWidth:160, flex:"0 0 auto"}}>
          <div style={{fontSize:10,fontWeight:600,color:"#dc2626",textTransform:"uppercase",marginBottom:4}}>Total Revenue ({cur})</div>
          <div style={{fontSize:22,fontWeight:700}}>{csym(cur)}{d.total.toFixed(2)}</div>
          <div style={{fontSize:11,color:T.muted,marginTop:2}}>{d.count} order{d.count!==1?"s":""}</div>
        </div>
      ))}
      {Object.keys(grandTotals).length===0 && <div style={{...sCrd, color:T.muted}}>No completed/invoiced orders with pricing in this period.</div>}
    </div>

    {/* Grouped table */}
    {rows.length > 0 && <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,overflow:"hidden",maxWidth:700,marginBottom:16}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{background:T.hover,textAlign:"left"}}>
          <th style={{padding:"8px 10px",fontWeight:600}}>{groupBy==="summary"?"":"Breakdown"}</th>
          <th style={{padding:"8px 10px",fontWeight:600,textAlign:"right"}}>Orders</th>
          <th style={{padding:"8px 10px",fontWeight:600,textAlign:"right"}}>Total</th>
          <th style={{padding:"8px 10px",fontWeight:600,textAlign:"right"}}>Currency</th>
        </tr></thead>
        <tbody>{rows.map((r,i)=><tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
          <td style={{padding:"7px 10px"}}>{r.label}</td>
          <td style={{padding:"7px 10px",textAlign:"right"}}>{r.count}</td>
          <td style={{padding:"7px 10px",textAlign:"right",fontWeight:600}}>{csym(r.cur)}{r.total.toFixed(2)}</td>
          <td style={{padding:"7px 10px",textAlign:"right",color:T.muted}}>{r.cur}</td>
        </tr>)}</tbody>
      </table>
    </div>}

    {/* Toggle detail list */}
    {pricedOrders.length > 0 && <div>
      <button style={{...bS,fontSize:11,marginBottom:10}} onClick={()=>setShowDetail(!showDetail)}>{showDetail?"Hide":"Show"} Order Details ({pricedOrders.length})</button>
      {showDetail && <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,overflow:"auto",maxWidth:900}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead><tr style={{background:T.hover,textAlign:"left"}}>
            <th style={{padding:"6px 8px"}}>BOL</th><th style={{padding:"6px 8px"}}>Date</th><th style={{padding:"6px 8px"}}>Client</th>
            <th style={{padding:"6px 8px"}}>Reference</th><th style={{padding:"6px 8px"}}>Status</th>
            <th style={{padding:"6px 8px",textAlign:"right"}}>Total</th><th style={{padding:"6px 8px"}}>Cur</th>
          </tr></thead>
          <tbody>{pricedOrders.sort((a,b)=>b.reqDate>a.reqDate?1:-1).map(o=>{
            const t=calcTotal(o); const cur=(o.price?.cur)||"CAD";
            return <tr key={o.id} style={{borderTop:`1px solid ${T.border}`,cursor:"pointer"}} onClick={()=>go("od",o)}>
              <td style={{padding:"5px 8px",fontWeight:600}}>{o.bol}</td>
              <td style={{padding:"5px 8px"}}>{fd(o.reqDate)}</td>
              <td style={{padding:"5px 8px"}}>{o.cliName||"—"}</td>
              <td style={{padding:"5px 8px"}}>{o.ref||"—"}</td>
              <td style={{padding:"5px 8px"}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
              <td style={{padding:"5px 8px",textAlign:"right",fontWeight:600}}>{csym(cur)}{t.toFixed(2)}</td>
              <td style={{padding:"5px 8px",color:T.muted}}>{cur}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    </div>}
    </>}
  </div>;
}

// ═══ SEARCH PAGE ═══
function SearchPage({db, go}) {
  const [bolQ, setBolQ] = useState("");
  const [cliQ, setCliQ] = useState("");
  const [refQ, setRefQ] = useState("");
  const [drvQ, setDrvQ] = useState("");
  const [statQ, setStatQ] = useState("all");

  const results = db.orders.filter(o => {
    if (bolQ && !o.bol.toLowerCase().includes(bolQ.toLowerCase())) return false;
    if (cliQ && !o.cliName.toLowerCase().includes(cliQ.toLowerCase())) return false;
    if (refQ && !(o.ref||"").toLowerCase().includes(refQ.toLowerCase())) return false;
    if (drvQ && !(o.drvName||"").toLowerCase().includes(drvQ.toLowerCase())) return false;
    if (statQ !== "all" && o.status !== statQ) return false;
    return true;
  }).sort((a,b) => new Date(b.created) - new Date(a.created));

  const hasFilter = bolQ || cliQ || refQ || drvQ || statQ !== "all";

  return <div style={{padding:20}}>
    <PageHdr title="Search Orders"/>

    <div style={sCrd}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.muted}}>SEARCH CRITERIA</div>
      <Field l="BOL #"><input style={sIn} value={bolQ} onChange={e=>setBolQ(e.target.value)} placeholder="e.g. 2001"/></Field>
      <Field l="Client Name"><input style={sIn} value={cliQ} onChange={e=>setCliQ(e.target.value)} placeholder="e.g. DHL"/></Field>
      <Field l="Reference #"><input style={sIn} value={refQ} onChange={e=>setRefQ(e.target.value)} placeholder="e.g. PO-12345"/></Field>
      <Field l="Driver Name"><input style={sIn} value={drvQ} onChange={e=>setDrvQ(e.target.value)} placeholder="e.g. Steve"/></Field>
      <Field l="Status">
        <select style={sIn} value={statQ} onChange={e=>setStatQ(e.target.value)}>
          <option value="all">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{S_LABEL[s]}</option>)}
        </select>
      </Field>
      {hasFilter && <button style={{...bS,padding:"4px 10px",fontSize:11,marginTop:4}} onClick={()=>{setBolQ("");setCliQ("");setRefQ("");setDrvQ("");setStatQ("all")}}>Clear All</button>}
    </div>

    <div style={{fontSize:12,color:T.muted,marginBottom:8}}>{hasFilter ? `${results.length} result${results.length!==1?"s":""}` : `${db.orders.length} total orders`}</div>

    <div style={{...sCrd,padding:0,overflow:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",minWidth:500}}>
        <thead><tr>{["BOL","Status","Client","Driver","Reference","Date"].map(h=><th key={h} style={{textAlign:"left",padding:"8px",fontSize:9,fontWeight:600,color:T.muted,textTransform:"uppercase",borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
        <tbody>
          {results.length===0 && <tr><td colSpan={6} style={{padding:24,textAlign:"center",color:T.dim,fontSize:12}}>No orders match your search</td></tr>}
          {results.map(o => <tr key={o.id} onClick={()=>go("od",o)} style={{cursor:"pointer",borderBottom:`1px solid ${T.hover}`}}>
            <td style={{padding:8,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}</td>
            <td style={{padding:8}}><Badge s={o.status} billingType={o.billingType} poRequired={o.poRequired} poNumber={o.poNumber} orderType={o.orderType}/></td>
            <td style={{padding:8,fontSize:12}}>{o.cliName||"—"}</td>
            <td style={{padding:8,fontSize:12}}>{o.drvName||"—"}</td>
            <td style={{padding:8,fontSize:11,color:T.muted}}>{o.orderType==="event"&&o.eventName ? <><span style={{color:"#8b5cf6",fontWeight:600}}>{o.eventName}</span>{o.ref?<span style={{color:"#94a3b8",fontSize:10}}> · {o.ref}</span>:""}</> : o.ref||"—"}</td>
            <td style={{padding:8,fontSize:11,color:T.muted}}>{fd(o.reqDate)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

// ═══ PAPS / PARS INVENTORY ═══
const db_ref = db;
function papsCheckDigit(seq) { return seq % 7; }

function PapsParsPage({db:dbData, savOrd}) {
  const [tab, setTab] = useState("PAPS");
  const [addMode, setAddMode] = useState(false);
  const [startNum, setStartNum] = useState("");
  const [endNum, setEndNum] = useState("");
  const [adding, setAdding] = useState(false);
  const [srch, setSrch] = useState("");
  const [filterSt, setFilterSt] = useState("all");
  const { confirm: cfm, modal: cfmModal } = useConfirm();

  const stickers = (dbData.stickers||[]).filter(s=>s.type===tab);
  const filtered = stickers.filter(s => {
    const matchSt = filterSt==="all" || s.status===filterSt;
    const matchQ = !srch || s.fullNum.toLowerCase().includes(srch.toLowerCase()) || (s.bolNum||"").toLowerCase().includes(srch.toLowerCase());
    return matchSt && matchQ;
  }).sort((a,b)=>a.seq-b.seq);

  const counts = { available:stickers.filter(s=>s.status==="available").length, assigned:stickers.filter(s=>s.status==="assigned").length, used:stickers.filter(s=>s.status==="used").length };

  const addBatch = async () => {
    const s = parseInt(startNum); const e = parseInt(endNum);
    if (isNaN(s)||isNaN(e)||e<s) { alert("Enter valid start and end numbers"); return; }
    if (e-s>500) { alert("Maximum 500 stickers per batch"); return; }

    const existingSeqs = new Set(stickers.map(st=>st.seq));
    const dupes = [];
    for (let i=s;i<=e;i++) { if(existingSeqs.has(i)) dupes.push(i); }
    if (dupes.length>0) { alert(`These numbers already exist: ${dupes.slice(0,5).join(", ")}${dupes.length>5?"...":""}`); return; }

    setAdding(true);
    try {
      for (let i=s; i<=e; i++) {
        let fullNum;
        if (tab==="PAPS") {
          const cd = papsCheckDigit(i);
          fullNum = `DBES${String(i).padStart(6,"0")} ${cd}`;
        } else {
          fullNum = `70BF PARS ${String(i).padStart(6,"0")}`;
        }
        await addDoc(collection(db_ref, "stickers"), {
          type: tab, seq: i, fullNum, status: "available", bolNum: "", orderId: "", created: new Date().toISOString()
        });
      }
      setStartNum(""); setEndNum(""); setAddMode(false);
    } catch(err) { console.error(err); alert("Error adding stickers"); }
    setAdding(false);
  };

  const deleteSticker = async (s) => {
    if (s.status==="assigned") { alert("Cannot delete an assigned sticker. Remove it from the order first."); return; }
    const ok = await cfm("Delete Sticker", `Delete ${s.fullNum}? This cannot be undone.`);
    if (!ok) return;
    try { await fbDelete("stickers", s.id); } catch(err) { console.error(err); alert("Error deleting sticker"); }
  };

  const markUsed = async (s) => {
    try { await updateDoc(doc(db_ref, "stickers", s.id), { status:"used" }); } catch(err) { console.error(err); alert("Error updating sticker"); }
  };

  const markAvailable = async (s) => {
    try { await updateDoc(doc(db_ref, "stickers", s.id), { status:"available", bolNum:"", orderId:"" }); } catch(err) { console.error(err); alert("Error updating sticker"); }
  };

  const downloadSingleSticker = (s) => {
    const w = window.open("","_blank","width=500,height=300");
    if (!w) { alert("Please allow popups"); return; }
    const isPaps = s.type === "PAPS";
    // PARS: barcode encodes without spaces; PAPS: remove check digit space
    const barcodeData = isPaps ? s.fullNum.replace(" ","") : s.fullNum.replace(/\s/g,"");
    // PARS: CBSA approved 12cm x 3.5cm; PAPS: 63mm x 28mm
    const pageW = isPaps ? "63mm" : "12cm";
    const pageH = isPaps ? "28mm" : "3.5cm";
    const html = `<!DOCTYPE html><html><head><title>${s.fullNum}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${pageW};height:${pageH};overflow:hidden}
body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
@media print{.no-print{display:none!important;position:absolute;left:-9999px}@page{size:${pageW} ${pageH};margin:0}html,body{width:${pageW};height:${pageH};overflow:hidden}}
@media screen{html,body{width:auto;height:auto;overflow:visible}body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}}
svg{display:block}
</style></head><body>
${isPaps ? `
<div style="width:${pageW};height:${pageH};box-sizing:border-box;position:relative;overflow:hidden;background:#fff">
  <div style="position:absolute;top:0;right:0;width:17mm;height:11mm;border-left:1.5px solid #000;border-bottom:1.5px solid #000">
    <div style="font-size:5pt;font-weight:700;text-align:center;padding:0.5mm 0;letter-spacing:0.3px">FILER CODE</div>
  </div>
  <div style="padding:2mm 2.5mm 1.5mm 2.5mm;display:flex;flex-direction:column;height:100%">
    <div style="font-size:6.5pt;font-weight:700;letter-spacing:0.3px;margin-top:5mm">DIAMOND BACK EXPRESS INC</div>
    <div style="font-size:15pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:1px;margin-top:0.5mm">${s.fullNum}</div>
    <div style="margin-top:0.5mm;flex:1;display:flex;align-items:flex-start"><svg id="barcode"></svg></div>
  </div>
</div>
` : `
<div style="width:${pageW};height:${pageH};box-sizing:border-box;overflow:hidden;background:#fff;display:flex;flex-direction:column">
  <div style="height:3mm;flex-shrink:0"></div>
  <div style="padding:0 4mm;flex-shrink:0"><svg id="barcode"></svg></div>
  <div style="height:1mm;flex-shrink:0"></div>
  <div style="padding:0 4mm;flex-shrink:0"><div style="font-size:14pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:1.5px">${s.fullNum}</div></div>
  <div style="padding:0.5mm 4mm 0;flex-shrink:0"><div style="font-size:8pt;font-weight:700;letter-spacing:0.4px">DIAMOND BACK EXPRESS INC</div></div>
</div>
`}
<div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%)"><button onclick="window.print()" style="padding:10px 24px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Print / Save as PDF</button></div>
<script>
JsBarcode("#barcode","${barcodeData}",{format:"CODE128",width:${isPaps?"1.3":"2"},height:${isPaps?28:45},displayValue:false,margin:0,background:"#ffffff",lineColor:"#000000"});
<\/script>
</body></html>`;
    w.document.write(html);
    w.document.close();
  };

  const stColor = { available:"#22c55e", assigned:"#3b82f6", used:"#64748b" };
  const stLabel = { available:"Available", assigned:"Assigned", used:"Used" };

  const downloadStickerSheet = (stickerList) => {
    if (!stickerList || stickerList.length===0) { alert("No stickers to print"); return; }
    const w = window.open("","_blank","width=800,height=1000");
    if (!w) { alert("Please allow popups to download sticker sheet"); return; }

    const cols = 3, rows = 10, perPage = cols * rows;
    const pages = [];
    for (let i=0; i<stickerList.length; i+=perPage) {
      pages.push(stickerList.slice(i, i+perPage));
    }

    const isPaps = tab === "PAPS";
    // PARS sheets: smaller cells to fit on A4 (3 cols), proportional to 12cm x 3.5cm
    const cellW = isPaps ? "63mm" : "60mm";
    const cellH = isPaps ? "28mm" : "27mm";

    const buildSticker = (s, idx) => {
      const barcodeData = isPaps ? s.fullNum.replace(" ","") : s.fullNum.replace(/\s/g,"");
      const bcId = `bc${idx}`;
      if (isPaps) {
        return `<div style="width:${cellW};height:${cellH};border:1px solid #999;box-sizing:border-box;position:relative;overflow:hidden;page-break-inside:avoid">
          <div style="position:absolute;top:0;right:0;width:14mm;height:9mm;border-left:1px solid #000;border-bottom:1px solid #000">
            <div style="font-size:4pt;font-weight:700;text-align:center;padding:0.3mm 0;letter-spacing:0.2px">FILER CODE</div>
          </div>
          <div style="padding:1.5mm 2mm 1mm 2mm;display:flex;flex-direction:column;height:100%">
            <div style="font-size:5.5pt;font-weight:700;letter-spacing:0.3px;margin-top:4mm">DIAMOND BACK EXPRESS INC</div>
            <div style="font-size:12pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:0.8px;margin-top:0.3mm">${s.fullNum}</div>
            <div style="margin-top:0.3mm;flex:1;display:flex;align-items:flex-start"><svg id="${bcId}" data-barcode="${barcodeData}"></svg></div>
          </div>
        </div>`;
      } else {
        // CBSA-approved PARS layout: barcode on top, number under barcode left-aligned, company name at bottom
        return `<div style="width:${cellW};height:${cellH};border:1px solid #999;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;page-break-inside:avoid">
          <div style="height:2mm;flex-shrink:0"></div>
          <div style="padding:0 3mm;flex-shrink:0"><svg id="${bcId}" data-barcode="${barcodeData}"></svg></div>
          <div style="height:0.5mm;flex-shrink:0"></div>
          <div style="padding:0 3mm;flex-shrink:0"><div style="font-size:10pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:0.8px">${s.fullNum}</div></div>
          <div style="padding:0.3mm 3mm 0;flex-shrink:0"><div style="font-size:5.5pt;font-weight:700;letter-spacing:0.3px">DIAMOND BACK EXPRESS INC</div></div>
        </div>`;
      }
    };

    let globalIdx = 0;
    const pagesHtml = pages.map(pageStickers => {
      let gridHtml = "";
      for (let r=0; r<rows; r++) {
        let rowHtml = "";
        for (let c=0; c<cols; c++) {
          const idx = r * cols + c;
          if (idx < pageStickers.length) {
            rowHtml += buildSticker(pageStickers[idx], globalIdx++);
          }
        }
        gridHtml += `<div style="display:flex;justify-content:center;gap:1mm">${rowHtml}</div>`;
      }
      return `<div style="page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0;padding:5mm 0">${gridHtml}</div>`;
    }).join("");

    const html = `<!DOCTYPE html><html><head><title>${tab} Stickers — ${BOL_COMPANY_LABEL}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#000}
@media print{body{padding:0}button{display:none!important}.no-print{display:none!important}}
@page{size:A4;margin:3mm}
svg{max-width:100%}
</style></head><body>
<div class="no-print" style="padding:10px;text-align:center;background:#f0f0f0;margin-bottom:10px">
  <button onclick="window.print()" style="padding:10px 24px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Print / Save as PDF</button>
  <span style="margin-left:12px;font-size:12px;color:#666">${stickerList.length} stickers — ${pages.length} page(s)</span>
</div>
${pagesHtml}
<script>
document.querySelectorAll("svg[data-barcode]").forEach(function(el){
  JsBarcode(el, el.getAttribute("data-barcode"), {format:"CODE128",width:${isPaps?"1.0":"1.4"},height:${isPaps?20:30},displayValue:false,margin:0,background:"#ffffff",lineColor:"#000000"});
});
<\/script>
</body></html>`;
    w.document.write(html);
    w.document.close();
  };

  return <div style={{padding:20}}>
    {cfmModal}
    <PageHdr title="PAPS / PARS Inventory">
      {filtered.length>0 && <button style={bS} onClick={()=>downloadStickerSheet(filtered)}><Ic n="pdf" s={13}/> Download Sticker Sheet ({filtered.length})</button>}
    </PageHdr>

    <div style={{display:"flex",gap:6,marginBottom:16}}>
      {["PAPS","PARS"].map(t=><button key={t} onClick={()=>{setTab(t);setFilterSt("all");setSrch("")}} style={{padding:"8px 20px",borderRadius:8,border:`1px solid ${tab===t?T.red:T.border}`,background:tab===t?"rgba(220,38,38,0.08)":"transparent",color:tab===t?T.red:T.muted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{t}</button>)}
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,maxWidth:500,marginBottom:16}}>
      {[{l:"Available",v:counts.available,c:"#22c55e"},{l:"Assigned",v:counts.assigned,c:"#3b82f6"},{l:"Used",v:counts.used,c:"#64748b"}].map(s=>
        <div key={s.l} style={sCrd}><div style={{fontSize:10,color:T.muted,textTransform:"uppercase"}}>{s.l}</div><div style={{fontSize:24,fontWeight:700,color:s.c,marginTop:2}}>{s.v}</div></div>
      )}
    </div>

    {!addMode ? <button style={bP} onClick={()=>setAddMode(true)}><Ic n="plus" s={14}/> Add {tab} Stickers</button>
    : <div style={{...sCrd,borderColor:T.red}}>
      <div style={{fontSize:11,fontWeight:600,marginBottom:8,color:T.red}}>ADD {tab} BATCH</div>
      <div style={{fontSize:10,color:T.muted,marginBottom:8}}>
        {tab==="PAPS" ? "Enter sequence numbers only (e.g. 3053). Check digit is auto-calculated." : "Enter sequence numbers only (e.g. 2100). Format: 70BF PARS 002100"}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <Field l="Start Number"><input style={sIn} type="number" value={startNum} onChange={e=>setStartNum(e.target.value)} placeholder={tab==="PAPS"?"e.g. 3053":"e.g. 2100"}/></Field>
        <Field l="End Number"><input style={sIn} type="number" value={endNum} onChange={e=>setEndNum(e.target.value)} placeholder={tab==="PAPS"?"e.g. 3100":"e.g. 2150"}/></Field>
      </div>
      {startNum && endNum && parseInt(endNum)>=parseInt(startNum) && <div style={{fontSize:10,color:T.muted,marginBottom:8}}>
        This will add <strong style={{color:T.text}}>{parseInt(endNum)-parseInt(startNum)+1}</strong> stickers.
        {tab==="PAPS" && <span> Preview: <strong style={{fontFamily:"'IBM Plex Mono'",color:T.text}}>DBES{String(parseInt(startNum)).padStart(6,"0")} {papsCheckDigit(parseInt(startNum))}</strong> to <strong style={{fontFamily:"'IBM Plex Mono'",color:T.text}}>DBES{String(parseInt(endNum)).padStart(6,"0")} {papsCheckDigit(parseInt(endNum))}</strong></span>}
        {tab==="PARS" && <span> Preview: <strong style={{fontFamily:"'IBM Plex Mono'",color:T.text}}>70BF PARS {String(parseInt(startNum)).padStart(6,"0")}</strong> to <strong style={{fontFamily:"'IBM Plex Mono'",color:T.text}}>70BF PARS {String(parseInt(endNum)).padStart(6,"0")}</strong></span>}
      </div>}
      <div style={{display:"flex",gap:8}}>
        <button style={bP} onClick={addBatch} disabled={adding}>{adding?"Adding...":"Add Batch"}</button>
        <button style={bS} onClick={()=>{setAddMode(false);setStartNum("");setEndNum("")}}>Cancel</button>
      </div>
    </div>}

    <div style={{display:"flex",gap:8,marginTop:16,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <input style={{...sIn,maxWidth:250}} value={srch} onChange={e=>setSrch(e.target.value)} placeholder="Search number or BOL..."/>
      <div style={{display:"flex",gap:4}}>
        {["all","available","assigned","used"].map(f=><button key={f} onClick={()=>setFilterSt(f)} style={{padding:"4px 10px",borderRadius:5,border:`1px solid ${filterSt===f?T.red:T.border}`,background:filterSt===f?"rgba(220,38,38,0.08)":"transparent",color:filterSt===f?T.red:T.muted,fontSize:10,cursor:"pointer",fontWeight:500,fontFamily:"inherit",textTransform:"capitalize"}}>{f}</button>)}
      </div>
    </div>

    <div style={{...sCrd,padding:0,overflow:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",minWidth:500}}>
        <thead><tr>{[tab+" Number","Status","BOL #","Actions"].map(h=><th key={h} style={{textAlign:"left",padding:"8px",fontSize:9,fontWeight:600,color:T.muted,textTransform:"uppercase",borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
        <tbody>
          {filtered.length===0 && <tr><td colSpan={4} style={{padding:24,textAlign:"center",color:T.dim,fontSize:12}}>No {tab} stickers found</td></tr>}
          {filtered.map(s=><tr key={s.id} style={{borderBottom:`1px solid ${T.hover}`}}>
            <td style={{padding:8,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{s.fullNum}</td>
            <td style={{padding:8}}><span style={{display:"inline-block",padding:"2px 10px",borderRadius:20,fontSize:10,fontWeight:600,color:"#fff",background:stColor[s.status]||"#666",whiteSpace:"nowrap"}}>{stLabel[s.status]||s.status}</span></td>
            <td style={{padding:8,fontSize:12,fontFamily:"'IBM Plex Mono'",fontWeight:s.bolNum?600:400,color:s.bolNum?T.text:T.dim}}>{s.bolNum?`BOL ${s.bolNum}`:"—"}</td>
            <td style={{padding:8}}>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                <button onClick={()=>downloadSingleSticker(s)} title="Download" style={{background:"none",border:`1px solid ${T.border}`,color:T.muted,cursor:"pointer",borderRadius:4,padding:"2px 6px",fontSize:10,fontFamily:"inherit"}}>⬇</button>
                {s.status==="available" && <button onClick={()=>markUsed(s)} title="Mark as Used" style={{background:"none",border:"1px solid #64748b",color:"#64748b",cursor:"pointer",borderRadius:4,padding:"2px 6px",fontSize:10,fontFamily:"inherit"}}>Used</button>}
                {s.status==="used" && !s.bolNum && <button onClick={()=>markAvailable(s)} title="Mark as Available" style={{background:"none",border:"1px solid #22c55e",color:"#22c55e",cursor:"pointer",borderRadius:4,padding:"2px 6px",fontSize:10,fontFamily:"inherit"}}>Avail</button>}
                {s.status==="available" && <button onClick={()=>deleteSticker(s)} title="Delete" style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,padding:"2px 4px"}}>×</button>}
              </div>
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

// ── Employee Documents Page ──
function EmployeeDocsPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const snap = await getDocs(collection(db, "employees"));
        const emps = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.documents && e.documents.length > 0);
        setEmployees(emps);
        
      } catch(e) { console.error(e); }
      setLoading(false);
    }
    load();
  }, []);

  const DOC_LABELS = { void_cheque: "Void Cheque", drivers_licence: "Driver's Licence", headshot: "Headshot", other: "Other" };

  const removeDoc = async (empId, docIndex) => {
    if (!window.confirm("Remove this document?")) return;
    const emp = employees.find(e => e.id === empId);
    if (!emp) return;
    const newDocs = emp.documents.filter((_, i) => i !== docIndex);
    await updateDoc(doc(db, "employees", empId), { documents: newDocs });
    setEmployees(prev => prev.map(e => e.id === empId ? {...e, documents: newDocs} : e).filter(e => e.documents && e.documents.length > 0));
  };

  const removeEmployee = async (empId) => {
    if (!window.confirm("Remove this employee and all their documents?")) return;
    await updateDoc(doc(db, "employees", empId), { documents: [] });
    setEmployees(prev => prev.filter(e => e.id !== empId));
  };
  const downloadFile = async (url, fileName) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'document';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch(e) { window.open(url, '_blank'); }
  };

  const filtered = employees.filter(e => {
    if (search && !e.name?.toLowerCase().includes(search.toLowerCase()) && !e.email?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{padding:"0 0 40px"}}>
      <div style={{marginBottom:16}}>
        <h2 style={{fontSize:18,fontWeight:700,color:T.text,marginBottom:4}}>Employee Documents</h2>
        <p style={{fontSize:12,color:T.muted}}>Documents uploaded by employees during registration.</p>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name or email..."
          style={{padding:"7px 10px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,fontSize:12,fontFamily:"inherit",minWidth:200}}/>
        
      </div>

      {loading && <div style={{color:T.muted,fontSize:13}}>Loading...</div>}
      {!loading && filtered.length === 0 && <div style={{color:T.muted,fontSize:13}}>No employee documents found.</div>}

      {filtered.map(emp => (
        <div key={emp.id} style={{marginBottom:16,padding:"14px 16px",borderRadius:10,border:`1px solid ${T.border}`,background:T.surface}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(220,38,38,0.1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>👤</div>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text}}>{emp.name}</div>
                <button onClick={()=>removeEmployee(emp.id)} style={{padding:"2px 8px",borderRadius:5,background:"none",color:T.muted,fontSize:10,border:`1px solid ${T.border}`,cursor:"pointer",fontFamily:"inherit"}}>Remove All</button>
              </div>
              <div style={{fontSize:11,color:T.muted}}>{emp.email||emp.phone} {emp.event ? `· ${emp.event}` : ""}</div>
            </div>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {(emp.documents||[]).map((doc, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:7,border:`1px solid ${T.border}`,background:T.bg,marginBottom:4}}>
                <span>📄</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:T.text}}>{DOC_LABELS[doc.docId] || doc.label || doc.docId}</div>
                  <div style={{fontSize:10,color:T.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.fileName}</div>
                </div>
                <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{padding:"4px 10px",borderRadius:5,background:"rgba(220,38,38,0.1)",color:T.red,fontSize:11,fontWeight:600,textDecoration:"none",whiteSpace:"nowrap"}}>View</a>
                <button onClick={()=>downloadFile(doc.url, doc.fileName)} style={{padding:"4px 10px",borderRadius:5,background:T.red,color:"#fff",fontSize:11,fontWeight:600,border:"none",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>⬇ Download</button>
                <button onClick={()=>removeDoc(emp.id, i)} style={{padding:"4px 8px",borderRadius:5,background:"none",color:"#ef4444",fontSize:13,fontWeight:700,border:"1px solid #ef4444",cursor:"pointer",fontFamily:"inherit"}}>×</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}



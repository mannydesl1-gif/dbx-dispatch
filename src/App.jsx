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
const LettersPage = lazy(() => import("./LettersPage.jsx"));
const IFTAPage = lazy(() => import("./IFTAPage.jsx"));
const AdminPage = lazy(() => import("./AdminPage.jsx"));
import { APP_NAME, APP_VERSION, COMPANY_NAME, DIVISIONS, ACCT_EMAILS as CFG_ACCT_EMAILS, REPORTS_EMAIL, CLOUD_FUNCTIONS, BOL_COMPANY_LABEL, DEFAULT_TERMS } from "./client.config.js";

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

// Full one-click backup: fetches EVERY collection fresh from Firestore (so the
// backup is complete and current, not limited to what's loaded in the UI) and
// downloads a single timestamped JSON file. Restorable later if ever needed.
async function backupAllData() {
  const backupCollections = [
    // Core (App.jsx)
    "clients","drivers","employees","trucks","trailers","locations",
    "orders","stickers","events","quotes",
    // Timesheets tab
    "timesheets","expenses","driver_shared_docs",
    // Letters + Company Docs tabs
    "letters","company_docs",
    // Safety tab
    "safetyFlags","safetyReports",
    // IFTA tab
    "iftaFuelCards","iftaRates","iftaReports","iftaUploads",
    // Equipment maintenance/repairs
    "maintenance",
  ];
  const backup = {
    _meta: {
      app: "DBX Dispatch",
      backupVersion: 1,
      createdAt: new Date().toISOString(),
    },
  };
  let totalRecords = 0;
  for (const col of backupCollections) {
    try {
      const snap = await getDocs(collection(db, col));
      backup[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      totalRecords += backup[col].length;
    } catch (e) {
      console.warn(`Backup: failed to read ${col}:`, e.code || e.message);
      backup[col] = [];
    }
  }
  // Include counters/settings config docs (not regular collections)
  try { const c = await getDoc(doc(db, "config", "counters")); backup._config_counters = c.exists() ? c.data() : null; } catch { backup._config_counters = null; }
  // The settings collection holds app config (cert config, report columns, etc.)
  try { const s = await getDocs(collection(db, "settings")); backup.settings = s.docs.map(d => ({ id: d.id, ...d.data() })); totalRecords += backup.settings.length; } catch { backup.settings = []; }
  backup._meta.totalRecords = totalRecords;

  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `DBX_Backup_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  // Record the backup date so the app can remind you when it's been a while.
  try { await setDoc(doc(db, "config", "backupMeta"), { lastBackup: new Date().toISOString(), totalRecords }, { merge: true }); } catch(e){ console.warn("Could not record backup date:", e); }
  return { totalRecords, collections: backupCollections.length };
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

// ═══ FX: live rate fetch + snapshot builder (module-level so invoice-time can
// recompute today's rate, matching the in-editor pricing logic exactly) ═══
async function fetchFxRatesLive() {
  // Returns { rates: {CUR: rateVsUSD, USD:1}, fxDate: "YYYY-MM-DD HH:MM" } or null on failure.
  try {
    const res = await fetch(`https://v6.exchangerate-api.com/v6/f33d099aa4e8c96e5a16d497/latest/USD`);
    const data = await res.json();
    if (!data || !data.conversion_rates) return null;
    return {
      rates: { ...data.conversion_rates, USD: 1 },
      fxDate: data.time_last_update_utc ? data.time_last_update_utc.slice(0, 16) : new Date().toISOString().slice(0, 10),
    };
  } catch (e) { console.error("FX live fetch failed", e); return null; }
}

function fxConvertToTargetM(byCur, targetCur, rates) {
  // Same math as the in-editor fxConvertToTarget. Returns null if a needed rate is missing.
  let total = 0;
  for (const [cur, amt] of Object.entries(byCur)) {
    const rFrom = cur === "USD" ? 1 : rates[cur];
    const rTo = targetCur === "USD" ? 1 : rates[targetCur];
    if (!rFrom || !rTo) return null;
    total += (amt / rFrom) * rTo;
  }
  return total;
}

// Convert ONE amount from its native currency to the invoice/target currency using
// the rates LOCKED on the order's fxSnapshot. Rates are USD-based (units of CUR per
// 1 USD, USD:1). Returns { val, rate, ok }:
//   ok=false  → no usable rate (caller shows native amount, flags "rate n/a")
//   rate      → effective native→target multiplier actually applied
// Legacy fallback: snapshots saved before rates were stored can still convert a
// SINGLE-currency order using the implied rate convertedBase/nativeSum.
function fxLineToTarget(amtNative, nativeCur, snap) {
  const target = (snap && snap.target) || nativeCur;
  if (!nativeCur || nativeCur === target) return { val: amtNative, rate: 1, ok: true };
  const rates = snap && snap.rates;
  if (rates) {
    const rFrom = nativeCur === "USD" ? 1 : rates[nativeCur];
    const rTo = target === "USD" ? 1 : rates[target];
    if (rFrom && rTo) return { val: (amtNative / rFrom) * rTo, rate: rTo / rFrom, ok: true };
  }
  // Legacy single-currency implied rate.
  if (snap && snap.byCur && Object.keys(snap.byCur).length === 1
      && snap.convertedBase != null) {
    const only = Object.keys(snap.byCur)[0];
    const nativeSum = snap.byCur[only];
    if (only === nativeCur && nativeSum) {
      const implied = snap.convertedBase / nativeSum;
      return { val: amtNative * implied, rate: implied, ok: true };
    }
  }
  return { val: amtNative, rate: null, ok: false };
}

// Sum a set of native line totals after converting EACH to the target currency
// and rounding to 2 decimals, so the displayed/exported subtotal always equals the
// sum of the rounded line totals shown (Xero recomputes from lines, so they must
// foot). lines: [{ltot, currency}]. Returns { target, rows:[{rounded, cur, ok...}],
// sum } where sum is in the target currency.
function fxConvertedLineSum(lines, snap) {
  const target = (snap && snap.target) || null;
  let sum = 0;
  const rows = (lines || []).map(l => {
    const cur = l.currency || (snap && snap.cur) || "CAD";
    const r = fxLineToTarget(l.ltot, cur, snap || {});
    const rounded = Math.round(r.val * 100) / 100;
    sum += rounded;
    return { conv: r.val, rounded, cur, ok: r.ok, rate: r.rate, native: l.ltot };
  });
  return { target, rows, sum: Math.round(sum * 100) / 100 };
}


function buildFxSnapshotFromOrder(order, rates, fxDate) {
  // Rebuild the fxSnapshot from an order's event lines using freshly-fetched
  // rates — mirrors the in-editor snapshot build so the invoice matches the BOL.
  const p = order.price || {};
  const evtLines = (p.eventLines || []).filter(l => l.desc || parseFloat(l.unitPrice) > 0 || parseFloat(l.qty) > 1);
  const byCur = {};
  evtLines.forEach(l => {
    const cur = l.currency || p.cur || "CAD";
    const ltp = l.taxMode === "HST" ? 13 : l.taxMode === "GST" ? 5 : l.taxMode === "CUSTOM" ? (parseFloat(l.taxCustom) || 0) : 0;
    const lb = (parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0);
    const amt = lb + lb * (ltp / 100);
    if (amt) byCur[cur] = (byCur[cur] || 0) + amt;
  });
  const target = p.totalCurrency || p.cur || "CAD";
  const convertedBase = fxConvertToTargetM(byCur, target, rates);
  const adjMode = p.adjMode || "pct";
  const adjVal = parseFloat(p.adjVal) || 0;
  const adjAmount = (convertedBase != null && adjVal !== 0) ? (adjMode === "pct" ? convertedBase * (adjVal / 100) : adjVal) : 0;
  const grand = convertedBase != null ? convertedBase + adjAmount : null;
  return {
    byCur, target, convertedBase, adjMode, adjVal,
    adjLabel: p.adjLabel || "Adjustment", adjAmount, grand, fxDate,
    multi: Object.keys(byCur).length > 1,
    applies: (Object.keys(byCur).length > 1) || (adjVal !== 0)
      || (Object.keys(byCur).length === 1 && Object.keys(byCur)[0] !== target),
  };
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
  // POD section: single order-level POD (o.podBy) OR per-stop PODs (multi-stop
  // transport orders store POD on each delivery/pickup stop as stop.pod).
  let podSection = "";
  if (includePod) {
    if (o.podBy) {
      podSection = `<div style="border:2px solid #22c55e;border-radius:8px;padding:14px;margin-top:20px;margin-bottom:16px"><div style="font-weight:700;font-size:11px;color:#22c55e;text-transform:uppercase;margin-bottom:6px">Proof of Delivery</div><div style="font-size:13px;line-height:1.6">Received by: <strong>${o.podBy}</strong><br>Date: ${fd(o.podDate)}<br>Time: ${o.podTime||"—"}</div></div>`;
    } else {
      const podStops = ((o.delStops||[]).concat(o.pickStops||[])).filter(st => st && st.pod && st.pod.by);
      if (podStops.length) {
        const rows = podStops.map(st => `<div style="font-size:13px;line-height:1.6;padding:8px 0;border-bottom:1px solid #d1fae5"><strong>${st.co||st.company||st.name||"Stop"}</strong><br>Received by: <strong>${st.pod.by}</strong>${st.pod.date?` &nbsp;·&nbsp; ${fd(st.pod.date)}`:""}${st.pod.time?` ${st.pod.time}`:""}</div>`).join("");
        podSection = `<div style="border:2px solid #22c55e;border-radius:8px;padding:14px;margin-top:20px;margin-bottom:16px"><div style="font-weight:700;font-size:11px;color:#22c55e;text-transform:uppercase;margin-bottom:6px">Proof of Delivery</div>${rows}</div>`;
      }
    }
  }
  // A digital POD exists on this order (order-level or any stop). The blank
  // signature line is the PAPER POD, so it's only shown when no digital POD was
  // recorded — never both. Keyed off the raw data, not podSection (which depends
  // on includePod), so the gate holds even when the POD isn't rendered.
  const hasPod = !!o.podBy || ((o.delStops||[]).concat(o.pickStops||[])).some(st => st && st.pod && st.pod.by);

  // CBSA-approved customs barcode label (PARS 12cm×3.5cm / PAPS 63mm×28mm) — reuses
  // the SAME dimensions, layout and barcode data rule as the standalone sticker
  // generator so it matches what CBSA approved. The <svg> carries data-barcode; the
  // print window (downloadBolPdf) runs JsBarcode over it after load.
  const customsLabel = (o.stickerNum && o.customsType) ? (() => {
    const isPaps = o.customsType === "PAPS";
    const barcodeData = isPaps ? o.stickerNum.replace(" ", "") : o.stickerNum.replace(/\s/g, "");
    const pageW = isPaps ? "63mm" : "12cm";
    const pageH = isPaps ? "28mm" : "3.5cm";
    const inner = isPaps ? `
      <div style="width:${pageW};height:${pageH};box-sizing:border-box;position:relative;overflow:hidden;background:#fff;border:1px solid #999">
        <div style="position:absolute;top:0;right:0;width:17mm;height:11mm;border-left:1.5px solid #000;border-bottom:1.5px solid #000">
          <div style="font-size:5pt;font-weight:700;text-align:center;padding:0.5mm 0;letter-spacing:0.3px">FILER CODE</div>
        </div>
        <div style="padding:2mm 2.5mm 1.5mm 2.5mm;display:flex;flex-direction:column;height:100%">
          <div style="font-size:6.5pt;font-weight:700;letter-spacing:0.3px;margin-top:5mm">DIAMOND BACK EXPRESS INC</div>
          <div style="font-size:15pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:1px;margin-top:0.5mm">${o.stickerNum}</div>
          <div style="margin-top:0.5mm;flex:1;display:flex;align-items:flex-start"><svg class="bol-customs-bc" data-barcode="${barcodeData}" data-paps="1"></svg></div>
        </div>
      </div>` : `
      <div style="width:${pageW};height:${pageH};box-sizing:border-box;overflow:hidden;background:#fff;display:flex;flex-direction:column;border:1px solid #999">
        <div style="height:3mm;flex-shrink:0"></div>
        <div style="padding:0 4mm;flex-shrink:0"><svg class="bol-customs-bc" data-barcode="${barcodeData}" data-paps="0"></svg></div>
        <div style="height:1mm;flex-shrink:0"></div>
        <div style="padding:0 4mm;flex-shrink:0"><div style="font-size:14pt;font-weight:700;font-family:'Courier New',monospace;letter-spacing:1.5px">${o.stickerNum}</div></div>
        <div style="padding:0.5mm 4mm 0;flex-shrink:0"><div style="font-size:8pt;font-weight:700;letter-spacing:0.4px">DIAMOND BACK EXPRESS INC</div></div>
      </div>`;
    return `<div class="bol-card" style="margin-bottom:18px;page-break-inside:avoid">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">${o.customsType} — Customs Barcode</div>
      ${inner}
    </div>`;
  })() : "";
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
      const fxSymPdf = (c) => c==="EUR"?"€":c==="GBP"?"£":c==="ZAR"?"R":c==="SGD"?"S$":c==="AED"?"AED ":"$";
      html+=`<div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">Additional Charges</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="${th}">Description</th>
          <th style="${thR}">Qty</th>
          <th style="${thR}">Unit Price</th>
          <th style="${thR}">Cur</th>
          <th style="${thR}">Tax</th>
          <th style="${thR}">Amount</th>
        </tr></thead>
        <tbody>${linesCalc.map(l=>{const lc=l.currency||p.cur||"CAD";const ls=fxSymPdf(lc);
          const snap2=p.fxSnapshot; const tgt=(snap2&&snap2.target)||lc; const showConv=lc!==tgt;
          const conv=fxLineToTarget(l.ltot,lc,snap2||{}); const tsym=fxSymPdf(tgt);
          const amtCell = showConv
            ? (conv.ok
                ? `${tsym}${(Math.round(conv.val*100)/100).toFixed(2)}<div style="font-size:9px;color:#999;font-weight:400">was ${ls}${l.ltot.toFixed(2)} ${lc}</div>`
                : `${ls}${l.ltot.toFixed(2)} ${lc}<div style="font-size:9px;color:#b45309;font-weight:400">rate n/a</div>`)
            : `${ls}${l.ltot.toFixed(2)}`;
          return `
          <tr>
            <td style="${td}">${l.desc||"Charge"}</td>
            <td style="${tdR}">${l.qty}</td>
            <td style="${tdR}">${ls}${parseFloat(l.unitPrice).toFixed(2)}</td>
            <td style="${tdR};font-size:10px;color:#888">${lc}</td>
            <td style="${tdR};font-size:10px;color:#888">${l.lt.label||"—"}</td>
            <td style="${tdR};font-weight:600">${amtCell}</td>
          </tr>`;}).join("")}
        </tbody>
      </table>`;
    }
    // Grand total — multi-currency snapshot when present, else single-currency.
    const fxSymPdf2 = (c) => c==="EUR"?"€":c==="GBP"?"£":c==="ZAR"?"R":c==="SGD"?"S$":c==="AED"?"AED ":"$";
    const snap = p.fxSnapshot;
    if (snap && (snap.applies || snap.multi) && snap.grand != null) {
      const tSym = fxSymPdf2(snap.target);
      const footed = fxConvertedLineSum(linesCalc, snap);
      const anyMissing = footed.rows.some(r=>!r.ok);
      const convSub = footed.sum;
      const adjAmt = snap.adjVal ? (snap.adjMode==="pct" ? Math.round(convSub*(snap.adjVal/100)*100)/100 : (parseFloat(snap.adjVal)||0)) : 0;
      const grand = Math.round((convSub + adjAmt)*100)/100;
      html += `<div style="margin-top:10px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
        <div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px">Subtotals by Currency (as entered)</div>
        ${Object.entries(snap.byCur||{}).map(([c,a])=>`<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:#555">${c}</span><span style="font-weight:600">${fxSymPdf2(c)}${a.toFixed(2)} ${c}</span></div>`).join("")}
        <div style="border-top:1px solid #e2e8f0;margin-top:8px;padding-top:8px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#555;margin-bottom:2px"><span>Subtotal (${snap.target})</span><span>${tSym}${convSub.toFixed(2)}</span></div>
          ${snap.adjVal ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:${adjAmt<0?"#b45309":"#555"};margin-bottom:4px"><span>${snap.adjLabel} (${snap.adjMode==="pct"?`${snap.adjVal}%`:"flat"})</span><span>${adjAmt<0?"−":""}${tSym}${Math.abs(adjAmt).toFixed(2)}</span></div>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-weight:700;font-size:13px;color:#dc2626;text-transform:uppercase">Grand Total ${snap.target}</span>
            <span style="font-weight:800;font-size:16px;color:#dc2626">${tSym}${grand.toFixed(2)} ${snap.target}</span>
          </div>
        </div>
        ${anyMissing?`<div style="font-size:9px;color:#b45309;margin-top:6px">Some lines have no locked rate — re-save this order to lock exchange rates.</div>`:""}
        ${snap.fxDate?`<div style="font-size:9px;color:#999;margin-top:6px">Converted using exchange rates as of ${snap.fxDate} UTC.</div>`:""}
      </div>
      ${o.poNumber?`<div style="margin-top:8px;font-size:11px;color:#666">PO #: <strong>${o.poNumber}</strong></div>`:""}
    </div>`;
    } else {
      // Build a Subtotal / tax-by-rate / Total summary. Amounts on each line are
      // tax-inclusive (ltot = base + tax), so we sum the bases for the subtotal
      // and group each line's tax by its label — works for any mix of tax types
      // (GST/HST/custom/exempt). Transport (if present) is included the same way.
      let subTotal = 0; const taxByLabel = {};
      if(hasTransport){ subTotal += transSub; if(transTaxAmt>0){ const tl=transTax.label||"Tax"; taxByLabel[tl]=(taxByLabel[tl]||0)+transTaxAmt; } }
      if(hasLines){ linesCalc.forEach(l=>{ subTotal += l.lb; if(l.lta>0){ const tl=l.lt.label||"Tax"; taxByLabel[tl]=(taxByLabel[tl]||0)+l.lta; } }); }
      const taxRows = Object.entries(taxByLabel).map(([lbl,amt])=>
        `<tr><td style="padding:2px 8px;font-size:11px;color:#555">${lbl}</td><td style="padding:2px 8px;text-align:right;font-size:11px;color:#555">${sym}${amt.toFixed(2)}</td></tr>`
      ).join("");
      html+=`<div style="margin-top:4px;background:#f8fafc;border-top:2px solid #e2e8f0;padding:8px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:2px 8px;font-size:11px;color:#555">Subtotal</td><td style="padding:2px 8px;text-align:right;font-size:11px;color:#555">${sym}${subTotal.toFixed(2)}</td></tr>
          ${taxRows}
          <tr><td style="padding:6px 8px 2px;font-weight:700;font-size:12px;color:#dc2626;text-transform:uppercase;border-top:1px solid #e2e8f0">Total ${p.cur||"CAD"}</td><td style="padding:6px 8px 2px;text-align:right;font-weight:700;font-size:15px;color:#dc2626;border-top:1px solid #e2e8f0">${sym}${grandTotal.toFixed(2)} ${p.cur||"CAD"}</td></tr>
        </table>
      </div>
      ${o.poNumber?`<div style="margin-top:8px;font-size:11px;color:#666">PO #: <strong>${o.poNumber}</strong></div>`:""}
    </div>`;
    }
    return html;
  })() : "";

  // Regular pricing section
  const baseAmt=parseFloat(p.base)||0; const fuelPct=parseFloat(p.fuelPct)||0; const fuelAmt=baseAmt*(fuelPct/100);
  const ocCalc2=(c)=>{const ltp=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0; const lbase=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0); return {ltp,lbase,ltax:lbase*(ltp/100)};};
  const otherBaseTotal=(p.other||[]).reduce((s,c)=>s+ocCalc2(c).lbase,0);
  const otherTaxTotal=(p.other||[]).reduce((s,c)=>s+ocCalc2(c).ltax,0);
  const taxPct=p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):({NONE:0,HST:13,GST:5,GBP:20}[p.taxMode]||0);
  const taxAmt=(baseAmt+fuelAmt)*(taxPct/100); const total=baseAmt+fuelAmt+taxAmt+otherBaseTotal+otherTaxTotal;
  const _hasOtherPx = (p.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0);
  // Per-stop surcharges (multi-stop): each stop's price adds on top of the order price.
  const _stopTot = (pr)=>{pr=pr||{};const b=parseFloat(pr.base)||0;const f=pr.fuelModel==="liter"?(parseFloat(pr.fuelAmt)||0):(b*((parseFloat(pr.fuelPct)||0)/100));const ob=(pr.other||[]).reduce((s,c)=>{const lb=(c.qty!==undefined||c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);const lt=c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0;return s+lb+lb*(lt/100);},0);const tp=pr.taxMode==="CUSTOM"?(parseFloat(pr.taxCustom)||0):pr.taxMode==="HST"?13:pr.taxMode==="GST"?5:0;const tx=(!pr.taxMode||pr.taxMode==="NONE")?0:(b+f)*(tp/100);return b+f+tx+ob;};
  const _surStops = ((o.delStops||[]).concat(o.pickStops||[])).map((st,i)=>({name:st.co||st.company||st.name||`Stop ${i+1}`,amt:_stopTot(st.price)})).filter(s=>s.amt>0);
  const _stopSurTotal = _surStops.reduce((s,x)=>s+x.amt,0);
  const grandWithStops = total + _stopSurTotal;
  const pricingSection = (!isEvent && includePricing && ((p.base && parseFloat(p.base)>0) || _hasOtherPx || parseFloat(p.fuelPct)>0 || _stopSurTotal>0)) ? `
<div style="border:2px solid #dc2626;border-radius:8px;padding:14px;margin-bottom:16px">
  <div style="font-weight:700;font-size:11px;color:#dc2626;text-transform:uppercase;margin-bottom:10px">Pricing (${p.cur||"CAD"})</div>
  ${p.transDesc?`<div style="font-size:11px;color:#000;margin-bottom:8px"><strong>Description:</strong> ${p.transDesc}</div>`:""}
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    ${baseAmt>0?`<tr><td style="padding:3px 0;color:#666">Base Price</td><td style="text-align:right;font-weight:600">${sym}${baseAmt.toFixed(2)}</td></tr>`:""}
    ${fuelAmt>0?`<tr><td style="padding:3px 0;color:#666">Fuel Surcharge (${fuelPct}%)</td><td style="text-align:right">${sym}${fuelAmt.toFixed(2)}</td></tr>`:""}
    ${taxAmt>0?`<tr><td style="padding:3px 0;color:#666">Tax on Base (${taxPct}%)</td><td style="text-align:right">${sym}${taxAmt.toFixed(2)}</td></tr>`:""}
    ${(p.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0).map(c=>{const cc=ocCalc2(c);const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");const lbl=(c.desc||"Charge")+(hasQty?` (${parseFloat(c.qty)||0} × ${sym}${(parseFloat(c.unitPrice)||0).toFixed(2)})`:"");return `<tr><td style="padding:3px 0;color:#666">${lbl}</td><td style="text-align:right">${sym}${cc.lbase.toFixed(2)}</td></tr>${cc.ltax>0?`<tr><td style="padding:1px 0 1px 12px;color:#999;font-size:10px">Tax (${cc.ltp}%)</td><td style="text-align:right;color:#999;font-size:10px">${sym}${cc.ltax.toFixed(2)}</td></tr>`:""}`;}).join("")}
    ${_surStops.map(s=>`<tr><td style="padding:3px 0;color:#666">Surcharge — ${s.name}</td><td style="text-align:right">${sym}${s.amt.toFixed(2)}</td></tr>`).join("")}
    <tr style="border-top:1.5px solid #cbd5e1"><td style="padding:6px 0 0;font-weight:700;font-size:14px">Total</td><td style="text-align:right;font-weight:700;font-size:14px">${sym}${grandWithStops.toFixed(2)} ${p.cur||"CAD"}</td></tr>
  </table>
  ${o.poNumber?`<div style="margin-top:8px;font-size:11px;color:#666">PO #: <strong>${o.poNumber}</strong></div>`:""}
</div>` : "";

  return `<div class="bol-page" style="font-family:'Helvetica Neue',Arial,sans-serif;color:#000;max-width:800px;display:flex;flex-direction:column;min-height:255mm">

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
  // Per-stop items: prefer stop.items; fall back to the order-level o.items on
  // the first pickup only, so single-stop and older orders still show items.
  const stopItems = (stop, isFirstPick) => {
    let list = (stop && stop.items) ? stop.items : [];
    list = list.filter(i => i && (i.desc||i.pcs||i.wt||i.l||i.w||i.h));
    if (!list.length && isFirstPick) list = (o.items||[]).filter(i => i.desc||i.pcs||i.wt||i.l||i.w||i.h);
    return list;
  };
  // Compact item table rendered inside a stop card.
  const stopItemsTable = (list) => {
    if (!list.length) return "";
    const th = "background:#f1f5f9;padding:4px 7px;text-align:left;font-weight:700;font-size:9px;border-bottom:1.5px solid #cbd5e1;text-transform:uppercase;letter-spacing:0.2px";
    const td = "padding:4px 7px;font-size:11px;border-bottom:1px solid #eef2f7";
    const rows = list.map(i => `<tr>
      <td style="${td}">${i.pcs||"—"}</td>
      <td style="${td}">${i.desc||"—"}</td>
      <td style="${td}">${i.wt?`${i.wt} ${i.wUnit||""}`.trim():"—"}</td>
    </tr>`).join("");
    return `<table style="width:100%;border-collapse:collapse;margin-top:8px">
      <thead><tr><th style="${th}">Pces</th><th style="${th};width:55%">Description</th><th style="${th}">Weight</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  };
  // Order totals — sum pieces and weight across every stop's items (one unit per
  // order, per Manuel). De-duplicate: if the first pickup fell back to o.items,
  // don't also count o.items again elsewhere.
  const allStopItems = (() => {
    const collected = [];
    picks.forEach((s,i) => collected.push(...stopItems(s, i===0)));
    dels.forEach((s) => collected.push(...stopItems(s, false)));
    return collected;
  })();
  const totalPcs = allStopItems.reduce((s,i)=> s + (parseFloat(i.pcs)||0), 0);
  const totalWt = allStopItems.reduce((s,i)=> s + (parseFloat(i.wt)||0), 0);
  const wtUnit = (allStopItems.find(i=>i.wUnit)||{}).wUnit || "";
  const totalsLine = (!isEvent && allStopItems.length) ? `<div class="bol-totals" style="display:flex;justify-content:flex-end;gap:24px;padding:8px 12px;background:#fff;border:1px solid #d5dae1;border-radius:6px;margin-bottom:18px;font-size:12px">
    <span><b style="color:#64748b;text-transform:uppercase;font-size:10px;letter-spacing:0.3px">Total Pieces:</b> <b style="font-size:14px">${totalPcs}</b></span>
    ${totalWt>0?`<span><b style="color:#64748b;text-transform:uppercase;font-size:10px;letter-spacing:0.3px">Total Weight:</b> <b style="font-size:14px">${totalWt} ${wtUnit}</b></span>`:""}
  </div>` : "";
  return Array.from({length:maxRows}, (_,i) => {
    const pk = picks[i]; const dl = dels[i];
    const pLabel = picks.length>1 ? `Pick Up — Stop ${i+1}` : "Pick Up";
    const dLabel = dels.length>1 ? `Delivery — Stop ${i+1}` : "Delivery";
    const noteBox = (n) => `<div style="font-size:11px;color:#92620a;background:#fffdf5;border:1px solid #fce9a8;border-radius:4px;padding:6px 9px;margin-top:8px;line-height:1.5;white-space:pre-wrap"><span style="font-weight:700;font-size:9px;text-transform:uppercase;color:#b45309">Notes:</span> ${n}</div>`;
    const card = (s, label, isFirstPick) => s ? `<div class="bol-card" style="border:1px solid #d5dae1;border-radius:8px;padding:14px;min-height:80px;background:#fff">
    <div style="font-weight:700;font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;letter-spacing:0.5px">${label}${s.date?` <span style="color:#000;font-size:13px;font-weight:700;text-transform:none;letter-spacing:0">— ${fd(s.date)}</span>`:""}</div>
    ${s.co?`<div style="font-weight:700;font-size:14px;margin-bottom:3px">${s.co}</div>`:""}
    <div style="font-size:12px;line-height:1.6;color:#334155">${(s.addr||"—").replace(/\n/g,"<br>")}</div>
    ${s.contact?`<div style="font-size:11px;color:#475569;margin-top:5px">${s.contact}${s.phone?` &nbsp;·&nbsp; ${s.phone}`:""}</div>`:s.phone?`<div style="font-size:11px;color:#475569;margin-top:5px">${s.phone}</div>`:""}
    ${s.notes?noteBox(s.notes):""}
    ${stopItemsTable(stopItems(s, isFirstPick))}
  </div>` : `<div></div>`;
    return `<div class="bol-row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px">
  ${card(pk, pLabel, i===0)}
  ${card(dl, dLabel, false)}
</div>`;
  }).join("") + totalsLine;
})():""}

<!-- Items now render per-stop inside each stop card; order totals shown after the grid -->

<!-- Notes -->
${o.notes?'<div class="bol-notes" style="background:#fff;border:1px solid #d5dae1;border-radius:6px;padding:14px;font-size:12px;margin-bottom:18px;white-space:pre-line;line-height:1.6"><b style="font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#64748b">Information / Notes</b><br><br>'+o.notes+'</div>':''}
${customsLabel}

<!-- Event Pricing -->
${eventPricingSection}

<!-- Regular Pricing -->
${pricingSection}

<!-- POD -->
${podSection}
${(()=>{
  // Footer = signature (paper POD) + terms, as ONE unit pinned to the bottom of
  // the page. margin-top:auto pushes it to the bottom of the flex column on a
  // short (1-page) BOL; break-inside:avoid keeps it whole so on a 2-page BOL it
  // flows to page 2 and sits at the bottom there instead of splitting.
  const sign = (!isEvent && !hasPod) ? `<div class="bol-sign" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;page-break-inside:avoid">
  <div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Signature and name in print</div></div>
  <div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Date and Time</div></div>
</div>` : "";
  const t = termsOrDefault(o.terms);
  const terms = (t && t.trim()) ? `<div class="bol-terms" style="margin-top:${sign?"28px":"0"};padding-top:8px;border-top:1px solid #e2e8f0"><div style="font-size:7px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Terms &amp; Conditions</div><div style="font-size:7.5px;color:#94a3b8;line-height:1.35;white-space:pre-line">${t.replace(/</g,"&lt;")}</div></div>` : "";
  return (sign || terms) ? `<div class="bol-footer" style="margin-top:auto;padding-top:40px;page-break-inside:avoid">${sign}${terms}</div>` : "";
})()}

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
      @page { margin: 12mm; }
      @media print {
        body { margin: 0; padding: 0; }
        .no-print { display: none !important; }
        /* Keep stop rows, cards, totals, signature and footer from splitting across pages */
        .bol-row, .bol-card, .bol-totals, .bol-sign, .bol-notes, .bol-footer, .bol-terms { page-break-inside: avoid; break-inside: avoid; }
      }
      body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 24px; background: #fff; }
    </style>
  </head><body>
    ${html}
    <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 4px 12px rgba(220,38,38,0.4)">
        🖨 Print / Save as PDF
      </button>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
    <script>
      // Render the CBSA customs barcode(s) using the SAME parameters as the
      // approved standalone sticker (CODE128, width 2 / PAPS 1.3, height 45 / 28).
      (function(){
        function draw(){
          if(typeof JsBarcode==="undefined"){ setTimeout(draw,80); return; }
          document.querySelectorAll(".bol-customs-bc").forEach(function(el){
            var data=el.getAttribute("data-barcode"); var isPaps=el.getAttribute("data-paps")==="1";
            try{ JsBarcode(el,data,{format:"CODE128",width:isPaps?1.3:2,height:isPaps?28:45,displayValue:false,margin:0,background:"#ffffff",lineColor:"#000000"}); }catch(e){}
          });
        }
        draw();
      })();
    <\/script>
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
  settings:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
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
  warn:<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
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

  // Convert an accepted quote into a pre-filled order and open the order editor.
  // orderType: "transport" (pickup/delivery) or "event" (project line items).
  const convertQuoteToOrder = async (quote, orderType) => {
    setSaving(true);
    try {
      const bol = await getNextBol();
      const isEvent = orderType === "event";
      // Bill To = client name only (the address is captured on the client record;
      // cramming the address lines here renders as one run-on string).
      const billTo = quote.cliName || "";
      const pickAddr = [quote.shipperStreet, [quote.shipperCity, quote.shipperProvState].filter(Boolean).join(", "),
        quote.shipperPostalZip, quote.shipperCountry].filter(Boolean).join("\n");
      const delAddr = [quote.consigneeStreet, [quote.consigneeCity, quote.consigneeProvState].filter(Boolean).join(", "),
        quote.consigneePostalZip, quote.consigneeCountry].filter(Boolean).join("\n");
      const items = (quote.freight||[]).filter(fr=>fr.desc||fr.pieces||fr.weight||fr.length||fr.commodity)
        .map(fr=>({ pcs:fr.pieces||"", desc:fr.desc||fr.commodity||"", wt:fr.weight||"", wUnit:fr.weightUnit||"lbs",
          l:fr.length||"", w:fr.width||"", h:fr.height||"", dUnit:fr.dimUnit||"in" }));
      const cur = quote.totalCurrency || quote.currency || "CAD";
      const eventLines = (quote.lines||[]).filter(l=>l.desc||parseFloat(l.unitPrice)>0)
        .map(l=>({ id:(l.id||Date.now().toString()+Math.random().toString(36).slice(2,6)), desc:l.desc||"", qty:l.qty||"1",
          unitPrice:l.unitPrice||"", currency:l.currency||cur, taxMode:l.taxMode||"NONE" }));
      const linesTotal = eventLines.reduce((s,l)=>s+(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0),0);
      const notes = [quote.scopeOfWork, quote.notes].filter(t=>t&&t.trim()).join("\n\n");

      const baseO = {
        bol, status:"unassigned",
        divId: quote.divId||"", cliId: quote.cliId||"", cliName: quote.cliName||"",
        billTo, reqDate: td(), ref: quote.clientRef||quote.quoteNum||"",
        drvId:"", drvName:"", drvEmail:"", trkId:"", trkUnit:"", trkPlate:"", trlId:"", trlUnit:"",
        customsType:"", stickerId:"", stickerNum:"",
        notes, files: quote.attachments||[], specReqs:[], specReqCustom:"",
        terms: termsOrDefault(quote.terms),
        podBy:"", podDate:"", podTime:"",
        fromQuote: quote.id || quote.quoteNum || null,
        created:new Date().toISOString(),
      };

      let o;
      if (isEvent) {
        o = { ...baseO, orderType:"event", eventName: quote.project||quote.quoteNum||"",
          pickCo: quote.shipperName||"", pickAddr, pickDate:"", delCo: quote.consigneeName||"", delAddr, delDate:"",
          items: items.length?items:[{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}],
          price:{ cur, base:"", fuelPct:"", taxMode:"NONE", taxCustom:"", other:[{desc:"",amt:""}],
            eventLines: eventLines.length?eventLines:[{id:Date.now().toString(),desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}],
            useEventPricing:true, totalCurrency:cur } };
      } else {
        // Transport order: map the quote's priced lines into per-line accessorial
        // charges (the order's price.other[]). Base price left blank for you to
        // set the line-haul rate; each quote line becomes an accessorial charge
        // with its description, qty, and unit price. Accessorials don't carry a
        // per-line currency (they use the order currency), so a line in a
        // different currency than the order's is flagged in its description.
        const accessorials = eventLines.map(l => {
          const offCur = l.currency && l.currency !== cur;
          return {
            desc: (l.desc||"Charge") + (offCur ? ` (quoted ${l.currency})` : ""),
            qty: l.qty || "1",
            unitPrice: l.unitPrice || "",
            taxMode: l.taxMode || "NONE",
          };
        });
        o = { ...baseO, pickDate:"", delDate:"",
          pickCo: quote.shipperName||"", pickAddr, delCo: quote.consigneeName||"", delAddr,
          items: items.length?items:[{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}],
          price:{ cur, base:"", fuelPct:"", taxMode:"NONE", taxCustom:"",
            other: accessorials.length ? accessorials : [{desc:"",amt:""}] } };
      }
      go("oe",{o,mode:"new"});
    } catch(e) { console.error("convert quote failed:", e); alert("Error converting quote to order"); }
    setSaving(false);
  };

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
        items:[{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}], notes:"", terms:termsOrDefault(undefined), files:[], specReqs:[], specReqCustom:"",
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
        podBy:_pb, podDate:_pd, podTime:_pt, billingType:_bt, noInvoiceReason:_nir, price:_pr,
        xeroInvoiceUrl:_xu, xeroInvoiceFile:_xf, invoiceNum:_in, invoiceDate:_id2, files:_files, dispatchNotes:_dnotes, ...rest} = source;
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
          xeroInvoiceUrl:null, xeroInvoiceFile:null, invoiceNum:"", invoiceDate:"", files:[], dispatchNotes:"",
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
    const m = !s || [o.bol,o.cliName,o.drvName,o.delAddr,o.pickAddr,o.ref,o.status,o.pickCo,o.delCo,o.invoiceNum].join(" ").toLowerCase().includes(s);
    return m;
  }).sort((a,b)=>new Date(b.created)-new Date(a.created));

  const cnt = s => dbData.orders.filter(o=>o.status===s).length;
  const nav = [{id:"dashboard",l:"Dashboard",i:"dash"},{id:"ol",l:"Orders",i:"file"},{id:"cr",l:"Live Crew",i:"users"},{id:"cl",l:"Clients",i:"users"},{id:"lo",l:"Locations",i:"map"},{id:"eq",l:"Equipment",i:"truck"},{id:"dr",l:"Drivers / Employees / Suppliers",i:"users"},{id:"pp",l:"PAPS / PARS",i:"barcode"},{id:"ts",l:"Timesheets",i:"calendar"},{id:"sf",l:"Safety",i:"shield"},{id:"ifta",l:"IFTA Fuel Tax",i:"chart"},{id:"ev",l:"Events",i:"calendar"},{id:"qt",l:"Quotes",i:"file"},{id:"lt",l:"Letters",i:"file"},{id:"rp",l:"Reports",i:"chart"},{id:"sr",l:"Search",i:"search"},{id:"cd",l:"Documents",i:"file"},{id:"ed",l:"Employee Docs",i:"users"},{id:"xp",l:"Expirations",i:"warn"},{id:"ad",l:"Admin",i:"settings"}];
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
      <BackupReminder/>
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
        {pg==="cl" && <CrudPage title="Clients" items={dbData.clients} fields={[{k:"name",l:"Company Name"},{k:"street",l:"Street Address"},{k:"city",l:"City"},{k:"provState",l:"Province / State"},{k:"country",l:"Country"},{k:"postalZip",l:"Postal / Zip Code"},{k:"contact",l:"Contact Person"},{k:"phone",l:"Phone"},{k:"email",l:"Email"},{k:"billingEmail",l:"Billing Email"},{k:"preferredCurrency",l:"Preferred Invoicing Currency",tp:"select",opts:["","CAD","USD","EUR","GBP"]},{k:"poRequired",l:"Purchase Order",tp:"checkbox",cbLabel:"PO required before invoicing"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} save={l=>saveColl("clients",l)} orders={dbData.orders} orderKey="cliId"/>}
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
        {pg==="qt" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><QuotesPage clients={dbData.clients||[]} onConvertToOrder={convertQuoteToOrder}/></Suspense>}
        {pg==="lt" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><LettersPage/></Suspense>}
        {pg==="ifta" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><IFTAPage trucks={db.trucks}/></Suspense>}
        {pg==="ad" && <Suspense fallback={<div style={{padding:20,color:T.muted,fontSize:13}}>Loading...</div>}><AdminPage/></Suspense>}
        {pg==="eq" && <EquipPage db={dbData} saveColl={saveColl}/>}
        {pg==="xp" && <div style={{padding:20}}><h1 style={{fontSize:18,fontWeight:700,margin:0,marginBottom:12}}>Expirations</h1><ExpirationsTab db={dbData}/></div>}
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

function BackupReminder() {
  const [days, setDays] = useState(null);   // days since last backup, or Infinity if never
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    getDoc(doc(db, "config", "backupMeta"))
      .then(snap => {
        if (!alive) return;
        const last = snap.exists() ? snap.data().lastBackup : null;
        if (!last) { setDays(Infinity); return; }
        const d = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
        setDays(d);
      })
      .catch(() => { if (alive) setDays(null); });
    return () => { alive = false; };
  }, []);
  // Only warn when it's been > 7 days (or never). Session-dismissible.
  if (dismissed || days === null || days <= 7) return null;
  const never = days === Infinity;
  return <div style={{ background:"linear-gradient(135deg,#b45309,#92400e)", padding:"8px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, zIndex:100 }}>
    <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>
      ⚠️ {never ? "You haven't backed up your data yet." : `Your last backup was ${days} days ago.`} &nbsp;·&nbsp;
      <span style={{ fontWeight:400, opacity:0.92 }}>Go to the Dashboard and click "Backup Data" to save a fresh copy.</span>
    </div>
    <button onClick={()=>setDismissed(true)} style={{ fontSize:12, fontWeight:700, color:"#fff", background:"rgba(255,255,255,0.2)", padding:"4px 14px", borderRadius:20, border:"none", cursor:"pointer", whiteSpace:"nowrap" }}>Dismiss</button>
  </div>;
}

function BackupButton() {
  const [state, setState] = useState("idle"); // idle | working | done
  const run = async () => {
    if (state === "working") return;
    setState("working");
    try {
      const res = await backupAllData();
      setState("done");
      setTimeout(() => setState("idle"), 4000);
      console.log(`Backup complete: ${res.totalRecords} records`);
    } catch (e) {
      console.error("Backup failed:", e);
      alert("Backup failed. Please check your connection and try again.");
      setState("idle");
    }
  };
  return <button style={{...bS, marginRight: 8, opacity: state === "working" ? 0.6 : 1, ...(state === "done" ? { borderColor: "#22c55e", color: "#22c55e" } : {}) }} onClick={run} disabled={state === "working"}>
    <Ic n={state === "done" ? "check" : "file"} s={14}/> {state === "working" ? "Backing up…" : state === "done" ? "Backup saved" : "Backup Data"}
  </button>;
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
    <PageHdr title="Dashboard"><BackupButton/><button style={bP} onClick={newOrd}><Ic n="plus" s={14}/> New Order</button></PageHdr>
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
            <td style={{padding:8,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}{o.dispatchNotes&&o.dispatchNotes.trim()?<span title={o.dispatchNotes} style={{marginLeft:5,fontSize:11,cursor:"help"}}>📝</span>:null}</td>
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

  // ── Multi-currency for project lines (same engine as PricingEntry/Quotes) ──
  const FX_CURRENCIES = ["USD","CAD","EUR","GBP","ZAR","SGD","AED"];
  const fxSym = (c) => c==="EUR"?"€":c==="GBP"?"£":c==="ZAR"?"R":c==="SGD"?"S$":c==="AED"?"AED ":"$";
  const [fxRates, setFxRates] = useState({});
  const [fxLoading, setFxLoading] = useState(false);
  const [fxDate, setFxDate] = useState("");
  const fetchFxRates = async () => {
    setFxLoading(true);
    try {
      const res = await fetch(`https://v6.exchangerate-api.com/v6/f33d099aa4e8c96e5a16d497/latest/USD`);
      const data = await res.json();
      setFxRates({ ...data.conversion_rates, USD: 1 });
      setFxDate(data.time_last_update_utc ? data.time_last_update_utc.slice(0,16) : new Date().toISOString().slice(0,10));
    } catch(e) { console.error("FX fetch failed", e); }
    setFxLoading(false);
  };
  const evtSubtotalByCurrency = () => {
    const map = {};
    evtLines.forEach(l => {
      const cur = l.currency || o.price?.cur || "CAD";
      const ltp = l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
      const lb = (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
      const amt = lb + lb*(ltp/100);
      if (amt===0) return;
      map[cur] = (map[cur]||0) + amt;
    });
    return map;
  };
  const fxConvertToTarget = (byCur, targetCur, rates) => {
    let total = 0;
    for (const [cur, amt] of Object.entries(byCur)) {
      const rFrom = cur==="USD"?1:rates[cur];
      const rTo = targetCur==="USD"?1:rates[targetCur];
      if (!rFrom || !rTo) return null;
      total += (amt/rFrom)*rTo;
    }
    return total;
  };
  const evtCurrenciesUsed = () => {
    const s = new Set(evtLines.filter(l=>l.desc||parseFloat(l.unitPrice)>0).map(l=>l.currency||o.price?.cur||"CAD"));
    return [...s];
  };
  useEffect(() => { if (Object.keys(fxRates).length===0) fetchFxRates(); }, []);
  useEffect(() => { fetchFxRates(); }, [o.price?.totalCurrency]);


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
    // FX snapshot so the PDF renders the same multi-currency total shown here.
    const byCur = {};
    filledLines.forEach(l => {
      const cur = l.currency || o.price?.cur || "CAD";
      const ltp = l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
      const lb = (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
      const amt = lb + lb*(ltp/100);
      if (amt) byCur[cur] = (byCur[cur]||0) + amt;
    });
    const fxTarget = o.price?.totalCurrency || o.price?.cur || "CAD";
    const convertedBase = fxConvertToTarget(byCur, fxTarget, fxRates);
    const fxAdjMode = o.price?.adjMode || "pct";
    const fxAdjVal = parseFloat(o.price?.adjVal)||0;
    const fxAdjAmount = (convertedBase!=null && fxAdjVal!==0) ? (fxAdjMode==="pct"?convertedBase*(fxAdjVal/100):fxAdjVal) : 0;
    const fxGrand = convertedBase!=null ? convertedBase + fxAdjAmount : null;
    const fxSnapshot = {
      byCur, target: fxTarget, convertedBase, adjMode: fxAdjMode, adjVal: fxAdjVal,
      adjLabel: o.price?.adjLabel || "Adjustment", adjAmount: fxAdjAmount, grand: fxGrand,
      fxDate, multi: Object.keys(byCur).length > 1,
      // Locked per-currency rates (USD-based: units of CUR per 1 USD, USD:1) so
      // each LINE can be converted to the target at the SAME rate shown on the BOL,
      // and stays fixed for this order regardless of later rate moves. Re-save an
      // old order once to populate this.
      rates: { ...fxRates, USD: 1 }, rateBase: "USD",
      // Snapshot "applies" (drives PDF/detail) whenever a real conversion or
      // adjustment happened: multiple currencies, an adjustment, or the target
      // currency differs from the lines' currency. Single-currency, no-fee,
      // same-target orders fall back to the plain total.
      applies: (Object.keys(byCur).length > 1) || (fxAdjVal !== 0)
        || (Object.keys(byCur).length === 1 && Object.keys(byCur)[0] !== fxTarget),
    };
    const saveData = {
      ...o,
      orderType:"event",
      status: o.status && o.status!=="unassigned" ? o.status : "unassigned",
      price:{
        ...(o.price||{}),
        cur: o.price?.cur||"CAD",
        eventLines: filledLines,
        useEventPricing: true,
        fxSnapshot,
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
        if(c?.poRequired) set("poRequired",true);
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
      <Field l="Terms & Conditions (shown at bottom of PDF)"><textarea style={{...sIn,minHeight:70,resize:"vertical",fontSize:11}} value={termsOrDefault(o.terms)} onChange={e=>set("terms",e.target.value)} placeholder="Standard terms & conditions..."/></Field>
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
        <div style={{display:"grid",gridTemplateColumns:"2fr 50px 74px 72px 110px 78px 24px",gap:6,marginBottom:4}}>
          {["Description","Qty","Unit Price","Cur","Tax","Total",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=1&&i<=5?"right":"left"}}>{h}</div>)}
        </div>

        {evtLines.map((line,idx)=>{
          const lineCur=line.currency||o.price?.cur||"CAD";
          const sym=fxSym(lineCur);
          const ltp=line.taxMode==="HST"?13:line.taxMode==="GST"?5:line.taxMode==="CUSTOM"?(parseFloat(line.taxCustom)||0):0;
          const lbase=(parseFloat(line.qty)||0)*(parseFloat(line.unitPrice)||0);
          const ltax=lbase*(ltp/100);
          const ltot=lbase+ltax;
          return <div key={line.id||idx} style={{marginBottom:6}}>
            <div style={{display:"grid",gridTemplateColumns:"2fr 50px 74px 72px 110px 78px 24px",gap:6,alignItems:"center"}}>
              <input style={sIn} value={line.desc} onChange={e=>selEvt(idx,"desc",e.target.value)} placeholder="Description..."/>
              <input style={{...sIn,textAlign:"right"}} type="number" value={line.qty} onChange={e=>selEvt(idx,"qty",e.target.value)} placeholder="1"/>
              <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={line.unitPrice} onChange={e=>selEvt(idx,"unitPrice",e.target.value)} placeholder="0.00"/>
              <select style={{...sIn,fontSize:10,padding:"5px 4px"}} value={lineCur} onChange={e=>selEvt(idx,"currency",e.target.value)}>
                {FX_CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={line.taxMode||"NONE"} onChange={e=>selEvt(idx,"taxMode",e.target.value)}>
                {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
              </select>
              <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:ltot>0?"#22c55e":T.dim}}>{sym}{ltot.toFixed(2)}</div>
              <button onClick={()=>setEvtLines(evtLines.filter((_,j)=>j!==idx))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
            </div>
            {ltax>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:30}}>Tax ({ltp}%): {sym}{ltax.toFixed(2)} · Base: {sym}{lbase.toFixed(2)}</div>}
          </div>;
        })}

        <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
          <button style={{...bS,padding:"4px 10px",fontSize:11}} onClick={()=>setEvtLines([...evtLines,{id:Date.now().toString(),desc:"",qty:"1",unitPrice:"",taxMode:"NONE"}])}><Ic n="plus" s={10}/> Add Line</button>
        </div>

        {/* Multi-currency grand total */}
        {(()=>{
          const byCur = evtSubtotalByCurrency();
          const curList = Object.keys(byCur);
          if (!curList.length) return null;
          const target = o.price?.totalCurrency || o.price?.cur || "CAD";
          const targetSym = fxSym(target);
          const multi = evtCurrenciesUsed().length > 1;
          const convertedBase = fxConvertToTarget(byCur, target, fxRates);
          const adjMode = o.price?.adjMode || "pct";
          const adjVal = parseFloat(o.price?.adjVal)||0;
          const adjLabel = o.price?.adjLabel || "Adjustment";
          let adjAmount = 0;
          if (convertedBase!=null && adjVal!==0) adjAmount = adjMode==="pct" ? convertedBase*(adjVal/100) : adjVal;
          const grand = convertedBase!=null ? convertedBase + adjAmount : null;
          return <div style={{marginTop:10,padding:12,background:T["bg"],borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:6}}>Subtotals by currency</div>
            {curList.map(c=>(
              <div key={c} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}>
                <span style={{color:T.muted}}>{c}</span>
                <span style={{fontWeight:600}}>{fxSym(c)}{byCur[c].toFixed(2)} {c}</span>
              </div>
            ))}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
              <div>
                <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Grand total in</div>
                <select style={{...sIn,fontSize:12}} value={target} onChange={e=>sep("totalCurrency",e.target.value)}>
                  {FX_CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Adjustment name</div>
                <input style={{...sIn,fontSize:12}} value={o.price?.adjLabel||""} onChange={e=>sep("adjLabel",e.target.value)} placeholder="e.g. Admin Fee, Discount"/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"90px 1fr",gap:8,marginTop:8}}>
              <select style={{...sIn,fontSize:12}} value={adjMode} onChange={e=>sep("adjMode",e.target.value)}>
                <option value="pct">%</option>
                <option value="flat">Flat {target}</option>
              </select>
              <input style={{...sIn,fontSize:12,textAlign:"right"}} type="number" step="0.01" value={o.price?.adjVal||""} onChange={e=>sep("adjVal",e.target.value)} placeholder={adjMode==="pct"?"e.g. 10 or -5":"amount (− to reduce)"}/>
            </div>
            {multi && <div style={{fontSize:10,color:T.dim,marginTop:8}}>
              {fxLoading ? "Fetching exchange rates…"
                : convertedBase==null ? "⚠ Exchange rates unavailable — check connection."
                : `Converted using rates ${fxDate?`as of ${fxDate} UTC`:"(live)"}. `}
              {!fxLoading && <button style={{background:"none",border:"none",color:"#0ea5e9",cursor:"pointer",fontSize:10,padding:0,textDecoration:"underline"}} onClick={fetchFxRates}>refresh</button>}
            </div>}
            <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
              {convertedBase!=null && adjVal!==0 && <>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.muted,marginBottom:2}}>
                  <span>Subtotal ({target})</span><span>{targetSym}{convertedBase.toFixed(2)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:adjAmount<0?"#f59e0b":T.muted,marginBottom:4}}>
                  <span>{adjLabel} ({adjMode==="pct"?`${adjVal}%`:"flat"})</span>
                  <span>{adjAmount<0?"−":""}{targetSym}{Math.abs(adjAmount).toFixed(2)}</span>
                </div>
              </>}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <span style={{fontSize:13,fontWeight:700}}>Grand Total</span>
                <span style={{fontSize:16,fontWeight:800,color:"#0ea5e9"}}>{grand!=null?`${targetSym}${grand.toFixed(2)} ${target}`:"—"}</span>
              </div>
            </div>
          </div>;
        })()}
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
        if(c?.poRequired) set("poRequired",true);
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
      {(o._showPrice || (o.price && (parseFloat(o.price?.base)>0 || o.price?.pricingNotes || (o.price?.other||[]).some(c=>c.desc||parseFloat(c.unitPrice)>0||parseFloat(c.amt)>0)))) && (() => {
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
    <div style={sCrd}><Field l="Notes / Information"><textarea style={{...sIn,resize:"vertical",minHeight:120}} rows={6} value={o.notes} onChange={e=>set("notes",e.target.value)} placeholder="AWB numbers, special instructions, truck/plate info..."/></Field>
    <Field l="Terms & Conditions (shown at bottom of PDF)"><textarea style={{...sIn,resize:"vertical",minHeight:80,fontSize:11}} rows={4} value={termsOrDefault(o.terms)} onChange={e=>set("terms",e.target.value)} placeholder="Standard terms & conditions..."/></Field></div>

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

  const drivers = db.drivers.filter(d=>d.isDriver!==false && d.archived!==true).sort((a,b)=>(a.name||"").toLowerCase().localeCompare((b.name||"").toLowerCase()));
  const trucks = [...db.trucks].filter(t=>t.archived!==true).sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0));
  const trailers = [...db.trailers].filter(t=>t.archived!==true).sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0));

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
              includeAttachments: true,
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
  const row = (desc,qty,unit,tax,rowCur) => [contact,"","","","","",xeroInvNum,xeroRef,invoiceDate,dueDate,"",desc,String(qty),unit,"4000",xeroTaxCode(tax||"NONE"),"","",rowCur||cur,""];
  const hasBase = p.base && parseFloat(p.base)>0;
  const hasEvtLines = (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0);
  // ── Multi-stop: pricing lives per-stop on the multi side (delStops or pickStops) ──
  const nPick=(o.pickStops||[]).length, nDel=(o.delStops||[]).length;
  const isMultiStop = nPick>1 || nDel>1;
  if(isMultiStop && !(p.useEventPricing||hasEvtLines)) {
    // Order-level price (whole-BOL) first — this is the primary price on multi-stop
    // orders. Per-stop entries below are optional surcharges.
    const olBase=parseFloat(p.base||0);
    const olFuel=p.fuelModel==="liter"?(parseFloat(p.fuelAmt)||0):(olBase*((parseFloat(p.fuelPct)||0)/100));
    if(olBase>0) rows.push(row(p.transDesc||"Transport Charge",1,olBase.toFixed(2),p.taxMode));
    if(olFuel>0) rows.push(row(p.fuelModel==="liter"?`Fuel (${p.liters||"?"}L)`:"Fuel Surcharge",1,olFuel.toFixed(2),"NONE"));
    (p.other||[]).filter(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0).forEach(c=>{
      const hasQty=(c.qty!==undefined&&c.qty!=="")||(c.unitPrice!==undefined&&c.unitPrice!=="");
      const qty=hasQty?(parseFloat(c.qty)||0):1;
      const unit=hasQty?(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);
      rows.push(row(c.desc||"Additional Charge",qty,unit.toFixed(2),c.taxMode||"NONE"));
    });
    // Per-stop surcharges (both sides), labeled by stop.
    const allStops=(o.pickStops||[]).map((s,i)=>({s,label:`Pickup Stop ${i+1}`})).concat((o.delStops||[]).map((s,i)=>({s,label:`Delivery Stop ${i+1}`})));
    allStops.forEach(({s:st,label})=>{
      const sp=st.price||{};
      const sbase=parseFloat(sp.base||0);
      const sfuel = sp.fuelModel==="liter" ? (parseFloat(sp.fuelAmt)||0) : (sbase*((parseFloat(sp.fuelPct)||0)/100));
      const fuelDesc = sp.fuelModel==="liter" ? `Fuel (${sp.liters||"?"}L)` : "Fuel Surcharge";
      const stopName = st.co || label;
      if(sbase>0) rows.push(row(`${stopName} — Surcharge`,1,sbase.toFixed(2),sp.taxMode));
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
    // Xero rejects mixed currencies on one invoice, so every row must be in the
    // invoice (target) currency. Lines already IN the target keep qty × unit and
    // their tax type (fully tax-correct). Lines in another currency are converted
    // at the order's LOCKED snapshot rate to a single qty-1, tax-inclusive row in
    // the target currency (TaxType NONE — the converted figure is final, Xero must
    // not recompute tax on it). Foots exactly to the BOL/PDF.
    const snap = p.fxSnapshot;
    const target = (snap && snap.target) || cur;
    if(hasBase) {
      const base=parseFloat(p.base||0), fuelP=parseFloat(p.fuelPct||0), fuel=base*(fuelP/100);
      // Transport is in the order's cur; convert if it differs from target.
      const tconv = fxLineToTarget(base, cur, snap||{});
      const fconv = fxLineToTarget(fuel, cur, snap||{});
      if(cur===target){
        rows.push(row(p.transDesc||"Transport Charge",1,base.toFixed(2),p.taxMode,target));
        if(fuel>0) rows.push(row("Fuel Surcharge",1,fuel.toFixed(2),"NONE",target));
      } else {
        rows.push(row((p.transDesc||"Transport Charge")+` (${cur} ${base.toFixed(2)} @ ${snap&&snap.fxDate?snap.fxDate:"rate"})`,1,(Math.round(tconv.val*100)/100).toFixed(2),"NONE",target));
        if(fuel>0) rows.push(row(`Fuel Surcharge (${cur} ${fuel.toFixed(2)})`,1,(Math.round(fconv.val*100)/100).toFixed(2),"NONE",target));
      }
    }
    (p.eventLines||[]).filter(l=>l.desc&&parseFloat(l.unitPrice)>0).forEach(l=>{
      const lc = l.currency||cur;
      if(lc===target){
        // Same currency as invoice — keep native qty × unit and tax type.
        rows.push(row(l.desc,parseFloat(l.qty)||1,(parseFloat(l.unitPrice)||0).toFixed(2),l.taxMode||"NONE",target));
      } else {
        // Different currency — convert the tax-inclusive line total to one qty-1 row.
        const ltp = l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
        const lb = (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
        const ltot = lb + lb*(ltp/100);
        const conv = fxLineToTarget(ltot, lc, snap||{});
        const val = conv.ok ? (Math.round(conv.val*100)/100) : ltot;
        const note = ` (${lc} ${ltot.toFixed(2)}${l.qty&&parseFloat(l.qty)!==1?` = ${l.qty}×${(parseFloat(l.unitPrice)||0).toFixed(2)}`:""}${conv.ok?` @ ${snap&&snap.fxDate?snap.fxDate:"locked rate"}`:" — RATE N/A"})`;
        rows.push(row(l.desc+note,1,val.toFixed(2),"NONE",target));
      }
    });
    // Admin fee / adjustment as its own row so the CSV total matches the BOL.
    if(snap && snap.adjVal){
      const footed = fxConvertedLineSum(
        (p.eventLines||[]).filter(l=>l.desc&&parseFloat(l.unitPrice)>0).map(l=>{
          const ltp=l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
          const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
          return {ltot:lb+lb*(ltp/100), currency:l.currency||cur};
        }), snap);
      const adjAmt = snap.adjMode==="pct" ? Math.round(footed.sum*(snap.adjVal/100)*100)/100 : (parseFloat(snap.adjVal)||0);
      if(adjAmt) rows.push(row(`${snap.adjLabel||"Adjustment"}${snap.adjMode==="pct"?` (${snap.adjVal}%)`:""}`,1,adjAmt.toFixed(2),"NONE",target));
    }
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
  const _anyStopSurcharge = ((io.delStops||[]).concat(io.pickStops||[])).some(st=>st&&st.price&&(parseFloat(st.price.base)>0||(st.price.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0)));
  const [showStopSurcharges, setShowStopSurcharges] = useState(_anyStopSurcharge);
  const p = o.price; const sp=(k,v)=>setO(pr=>({...pr,price:{...pr.price,[k]:v}}));
  const soc=(i,k,v)=>{const oc=[...p.other];oc[i]={...oc[i],[k]:v};sp("other",oc)};
  const sel=(i,k,v)=>{const el=[...p.eventLines];el[i]={...el[i],[k]:v};sp("eventLines",el)};

  // ── Multi-currency for project/event lines (same engine as QuotesPage) ──
  // Rates fetched FROM USD base: { CAD:1.36, EUR:0.92, ... } meaning 1 USD = X.
  const FX_CURRENCIES = ["USD","CAD","EUR","GBP","ZAR","SGD","AED"];
  const fxSym = (c) => c==="EUR"?"€":c==="GBP"?"£":c==="ZAR"?"R":c==="SGD"?"S$":c==="AED"?"AED ":"$";
  const [fxRates, setFxRates] = useState({});
  const [fxLoading, setFxLoading] = useState(false);
  const [fxDate, setFxDate] = useState("");
  const fetchFxRates = async () => {
    setFxLoading(true);
    try {
      const res = await fetch(`https://v6.exchangerate-api.com/v6/f33d099aa4e8c96e5a16d497/latest/USD`);
      const data = await res.json();
      setFxRates({ ...data.conversion_rates, USD: 1 });
      setFxDate(data.time_last_update_utc ? data.time_last_update_utc.slice(0,16) : new Date().toISOString().slice(0,10));
    } catch(e) { console.error("FX fetch failed", e); }
    setFxLoading(false);
  };
  // Per-currency subtotals across event lines (line currency falls back to p.cur).
  // Includes each line's own tax so the subtotal is the real payable per currency.
  const evtSubtotalByCurrency = () => {
    const map = {};
    (p.eventLines||[]).forEach(l => {
      const cur = l.currency || p.cur || "CAD";
      const ltp = l.taxMode==="HST"?13:l.taxMode==="GST"?5:l.taxMode==="CUSTOM"?(parseFloat(l.taxCustom)||0):0;
      const lb = (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
      const amt = lb + lb*(ltp/100);
      if (amt===0) return;
      map[cur] = (map[cur]||0) + amt;
    });
    return map;
  };
  // Convert a {cur:amt} map into a single target currency using USD-base rates.
  const fxConvertToTarget = (byCur, targetCur, rates) => {
    let total = 0;
    for (const [cur, amt] of Object.entries(byCur)) {
      const rFrom = cur==="USD" ? 1 : rates[cur];
      const rTo = targetCur==="USD" ? 1 : rates[targetCur];
      if (!rFrom || !rTo) return null;
      total += (amt / rFrom) * rTo;
    }
    return total;
  };
  // Whether more than one currency is actually in play on the lines.
  const evtCurrenciesUsed = () => {
    const s = new Set((p.eventLines||[]).filter(l=>l.desc||parseFloat(l.unitPrice)>0).map(l=>l.currency||p.cur||"CAD"));
    return [...s];
  };
  // Fetch rates when the event pricing panel is shown or the target changes.
  useEffect(() => { if (showEventPricing && Object.keys(fxRates).length===0) fetchFxRates(); }, [showEventPricing]);
  useEffect(() => { if (showEventPricing && (p.totalCurrency)) fetchFxRates(); }, [p.totalCurrency]);

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
  // Multi-stop model: order-level price (o.price) is the whole-BOL price; per-stop
  // prices are optional SURCHARGES added on top. stopSurchargeTotal sums them.
  const stopSurchargeTotal = orderGrandTotal;
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
  // Multi-stop: whole-BOL grand total = order-level price + optional per-stop surcharges.
  const multiStopGrandTotal = total + stopSurchargeTotal;

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
      {<div style={{marginTop:12,padding:"12px",background:"rgba(220,38,38,0.04)",borderRadius:8,border:`1px solid ${T.border}`}}>
        <div style={{fontSize:10,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>{isMultiStop?"Order Price (whole BOL)":"Transport Charge"} {isEvent&&<span style={{fontSize:9,fontWeight:400,color:T.dim,textTransform:"none"}}>(leave empty if no transport charge)</span>}</div>

        <Field l={`Base Price (${sym})`}><input style={sIn} type="number" step="0.01" value={p.base} onChange={e=>sp("base",e.target.value)} placeholder={isEvent?"Leave empty if no transport charge":"0.00"}/></Field>

        {(baseAmt>0
          || (p.other||[]).some(oc=>oc.desc||parseFloat(oc.amt)>0||parseFloat(oc.unitPrice)>0)
          || parseFloat(p.fuelPct)>0
          || (p.transDesc||"").trim()
        ) && <>
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
        <button onClick={()=>setShowStopSurcharges(v=>!v)} style={{...bS,width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:showStopSurcharges?"rgba(220,38,38,0.06)":"transparent",border:`1px solid ${showStopSurcharges?T.red:T.border}`,marginBottom:showStopSurcharges?10:0}}>
          <span style={{color:showStopSurcharges?T.red:T.muted,fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em"}}>Per-Stop Surcharges (optional){stopSurchargeTotal>0?` — ${sym}${stopSurchargeTotal.toFixed(2)}`:""}</span>
          <span style={{color:T.muted}}>{showStopSurcharges?"▲":"▼"}</span>
        </button>
        {showStopSurcharges && <div>
        <div style={{fontSize:11,color:T.muted,marginBottom:10}}>Add an extra charge to a specific {priceSide==="delStops"?"delivery":"pickup"} stop — on top of the order price above.</div>
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
            {stc.total>0 && <div style={{borderTop:`1px solid ${T.border}`,marginTop:8,paddingTop:6,fontSize:13,fontWeight:700}}>Stop Surcharge: {sym}{stc.total.toFixed(2)}</div>}
          </div>;
        })}
        </div>}
        <div style={{...sCrd,borderColor:"#0ea5e9",marginTop:10}}>
          <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:6}}>Order Total</div>
          {total>0 && <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}><span style={{color:T.muted}}>Order price (whole BOL)</span><span>{sym}{total.toFixed(2)}</span></div>}
          {(o[priceSide]||[]).map((st,i)=>{const t=calcStop(st.price).total;return t>0?<div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}><span style={{color:T.muted}}>Surcharge — {st.co||`Stop ${i+1}`}</span><span>{sym}{t.toFixed(2)}</span></div>:null;})}
          <div style={{borderTop:`1px solid ${T.border}`,marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:700}}><span>Grand Total</span><span style={{color:"#0ea5e9"}}>{sym}{multiStopGrandTotal.toFixed(2)} {p.cur}</span></div>
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
            const lineCur=line.currency||p.cur||"CAD";
            const lineSym=fxSym(lineCur);
            return <div key={line.id||idx} style={{marginBottom:6}}>
              <div style={{display:"grid",gridTemplateColumns:"2fr 50px 74px 72px 110px 78px 24px",gap:6,alignItems:"center"}}>
                <input style={sIn} value={line.desc} onChange={e=>sel(idx,"desc",e.target.value)} placeholder="Description..."/>
                <input style={{...sIn,textAlign:"right"}} type="number" value={line.qty} onChange={e=>sel(idx,"qty",e.target.value)} placeholder="1"/>
                <input style={{...sIn,textAlign:"right"}} type="number" step="0.01" value={line.unitPrice} onChange={e=>sel(idx,"unitPrice",e.target.value)} placeholder="0.00"/>
                <select style={{...sIn,fontSize:10,padding:"5px 4px"}} value={lineCur} onChange={e=>sel(idx,"currency",e.target.value)}>
                  {FX_CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
                <select style={{...sIn,fontSize:10,padding:"5px 6px"}} value={line.taxMode||"NONE"} onChange={e=>sel(idx,"taxMode",e.target.value)}>
                  {TAX_MODES.map(t=><option key={t.k} value={t.k}>{t.l}</option>)}
                </select>
                <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:lineTotal>0?"#22c55e":T.dim}}>{lineSym}{lineTotal.toFixed(2)}</div>
                <button onClick={()=>sp("eventLines",(p.eventLines||[]).filter((_,j)=>j!==idx))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:0}}>×</button>
              </div>
              {lineTaxAmt>0&&<div style={{fontSize:10,color:T.muted,textAlign:"right",marginTop:1,paddingRight:34}}>
                Tax ({lineTaxPct}%): {lineSym}{lineTaxAmt.toFixed(2)} · Base: {lineSym}{lineBase.toFixed(2)}
              </div>}
            </div>;
          })}

          <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
            <button style={{...bS,padding:"4px 10px",fontSize:11}} onClick={()=>sp("eventLines",[...(p.eventLines||[]),emptyEventLine()])}><Ic n="plus" s={10}/> Add Line</button>
          </div>

          {/* Multi-currency grand total (same engine as Quotes). Shows a subtotal
              per currency, an optional named adjustment (% or flat), then the
              converted grand total in the chosen target currency. */}
          {(()=>{
            const byCur = evtSubtotalByCurrency();
            const curList = Object.keys(byCur);
            if (!curList.length) return null;
            const target = p.totalCurrency || p.cur || "CAD";
            const targetSym = fxSym(target);
            const multi = evtCurrenciesUsed().length > 1;
            const convertedBase = fxConvertToTarget(byCur, target, fxRates); // pre-adjustment
            // Adjustment: named, either % of the converted total or a flat amount
            // in the target currency. Positive adds, negative reduces.
            const adjMode = p.adjMode || "pct"; // "pct" | "flat"
            const adjVal = parseFloat(p.adjVal)||0;
            const adjLabel = p.adjLabel || "Adjustment";
            let adjAmount = 0;
            if (convertedBase!=null && adjVal!==0) {
              adjAmount = adjMode==="pct" ? convertedBase*(adjVal/100) : adjVal;
            }
            const grand = convertedBase!=null ? convertedBase + adjAmount : null;
            return <div style={{marginTop:10,padding:12,background:T["bg"],borderRadius:8,border:`1px solid ${T.border}`}}>
              {/* Per-currency subtotals */}
              <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:6}}>Subtotals by currency</div>
              {curList.map(c=>(
                <div key={c} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}>
                  <span style={{color:T.muted}}>{c}</span>
                  <span style={{fontWeight:600}}>{fxSym(c)}{byCur[c].toFixed(2)} {c}</span>
                </div>
              ))}

              {/* Target currency + adjustment controls */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                <div>
                  <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Grand total in</div>
                  <select style={{...sIn,fontSize:12}} value={target} onChange={e=>sp("totalCurrency",e.target.value)}>
                    {FX_CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:10,color:T.muted,marginBottom:3}}>Adjustment name</div>
                  <input style={{...sIn,fontSize:12}} value={p.adjLabel||""} onChange={e=>sp("adjLabel",e.target.value)} placeholder="e.g. Admin Fee, Discount"/>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"90px 1fr",gap:8,marginTop:8}}>
                <select style={{...sIn,fontSize:12}} value={adjMode} onChange={e=>sp("adjMode",e.target.value)}>
                  <option value="pct">%</option>
                  <option value="flat">Flat {target}</option>
                </select>
                <input style={{...sIn,fontSize:12,textAlign:"right"}} type="number" step="0.01" value={p.adjVal||""} onChange={e=>sp("adjVal",e.target.value)} placeholder={adjMode==="pct"?"e.g. 10 or -5":"amount (− to reduce)"}/>
              </div>

              {/* FX status */}
              {multi && <div style={{fontSize:10,color:T.dim,marginTop:8}}>
                {fxLoading ? "Fetching exchange rates…"
                  : convertedBase==null ? "⚠ Exchange rates unavailable — check connection, or amounts stay in their own currency."
                  : `Converted using rates ${fxDate?`as of ${fxDate} UTC`:"(live)"}. `}
                {!fxLoading && <button style={{background:"none",border:"none",color:"#0ea5e9",cursor:"pointer",fontSize:10,padding:0,textDecoration:"underline"}} onClick={fetchFxRates}>refresh</button>}
              </div>}

              {/* Totals */}
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                {convertedBase!=null && (adjVal!==0) && <>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.muted,marginBottom:2}}>
                    <span>Subtotal ({target})</span><span>{targetSym}{convertedBase.toFixed(2)}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:adjAmount<0?"#f59e0b":T.muted,marginBottom:4}}>
                    <span>{adjLabel} ({adjMode==="pct"?`${adjVal}%`:"flat"})</span>
                    <span>{adjAmount<0?"−":""}{targetSym}{Math.abs(adjAmount).toFixed(2)}</span>
                  </div>
                </>}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                  <span style={{fontSize:13,fontWeight:700}}>Grand Total</span>
                  <span style={{fontSize:16,fontWeight:800,color:"#0ea5e9"}}>{grand!=null?`${targetSym}${grand.toFixed(2)} ${target}`:"—"}</span>
                </div>
                {transportTotal>0 && <div style={{fontSize:10,color:T.dim,marginTop:4}}>Note: transport pricing ({sym}{transportTotal.toFixed(2)} {p.cur}) is tracked separately from these project lines.</div>}
              </div>
            </div>;
          })()}
        </div>}
      </div>}
      <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
        <button style={{...sBtn,background:"#0ea5e9"}} onClick={()=>{
          // Snapshot the multi-currency computation so the PDF (which has no live
          // FX access) renders exactly what was shown here at save time.
          const byCur = evtSubtotalByCurrency();
          const target = p.totalCurrency || p.cur || "CAD";
          const convertedBase = fxConvertToTarget(byCur, target, fxRates);
          const adjMode = p.adjMode || "pct";
          const adjVal = parseFloat(p.adjVal)||0;
          const adjAmount = (convertedBase!=null && adjVal!==0) ? (adjMode==="pct"?convertedBase*(adjVal/100):adjVal) : 0;
          const grand = convertedBase!=null ? convertedBase+adjAmount : null;
          const fxSnapshot = {
            byCur, target, convertedBase, adjMode, adjVal,
            adjLabel: p.adjLabel||"Adjustment", adjAmount, grand,
            fxDate, multi: evtCurrenciesUsed().length>1,
            rates: { ...fxRates, USD: 1 }, rateBase: "USD",
            applies: (Object.keys(byCur).length > 1) || (adjVal !== 0)
              || (Object.keys(byCur).length === 1 && Object.keys(byCur)[0] !== target),
          };
          // Save pricing WITHOUT changing status — you can price at any stage and
          // stay there. (Previously this forced status:"completed", bumping the
          // order to Ready to Bill on every pricing save.)
          const oToSave = {...o, price:{...o.price, fxSnapshot}};
          savOrd(oToSave); go("od", oToSave);
        }}><Ic n="dollar" s={13}/> Save Pricing</button>
        <button style={bS} onClick={()=>go("od",o)}>Cancel</button>
      </div>
    </div>
  </div>
  {showEmailModal && <AccountingEmailModal
    showCsvOption={!!(p.base && parseFloat(p.base)>0) || (p.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0) || (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0) || ((o.pickStops||[]).concat(o.delStops||[])).some(st=>st&&st.price&&(parseFloat(st.price.base)>0||(st.price.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0)))}
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
  const [attachCsv, setAttachCsv] = useState(true);  // Xero CSV ticked by default
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
        <button style={{...sBtn,background:"#06b6d4",opacity:canSend?1:0.4,cursor:canSend?"pointer":"not-allowed"}} disabled={!canSend} onClick={()=>onSend(selected, message.trim(), attachCsv && showCsvOption)}>
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

// Inline internal-notes card shown on the order detail at ANY status. Saves to
// order.dispatchNotes via savOrd — never shown on the BOL/invoice PDF. Lets Manuel
// jot follow-ups ("PO request emailed Sept 17") without opening Edit.
function DispatchNotesCard({o, savOrd}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(o.dispatchNotes||"");
  const [saving, setSaving] = useState(false);
  const has = !!(o.dispatchNotes && o.dispatchNotes.trim());
  const save = async () => {
    setSaving(true);
    await savOrd({...o, dispatchNotes: val.replace(/\s+$/,"")});
    setSaving(false);
    setEditing(false);
  };
  const startEdit = () => { setVal(o.dispatchNotes||""); setEditing(true); };
  // Prepend a dated stamp on its own line to jot a quick follow-up.
  const stamp = () => {
    const d = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
    setVal(v => (v && v.trim() ? v.replace(/\s+$/,"")+"\n" : "") + `${d}: `);
  };
  return <div style={sCrd}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:has||editing?6:0}}>
      <div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase"}}>Dispatch Notes <span style={{color:T.dim,fontWeight:400,textTransform:"none"}}>· internal, not on PDF</span></div>
      {!editing && <button onClick={startEdit} style={{fontSize:10,padding:"2px 10px",borderRadius:4,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"inherit"}}>{has?"Edit":"+ Add note"}</button>}
    </div>
    {!editing
      ? (has
          ? <div style={{fontSize:12,whiteSpace:"pre-line",lineHeight:1.5,color:T.text}}>{o.dispatchNotes}</div>
          : <div style={{fontSize:11,color:T.dim,fontStyle:"italic"}}>No notes yet — add follow-ups, PO chase dates, reminders…</div>)
      : <>
          <textarea autoFocus value={val} onChange={e=>setVal(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))save();if(e.key==="Escape")setEditing(false);}}
            style={{...sIn,width:"100%",minHeight:90,resize:"vertical",fontSize:12,lineHeight:1.5}}
            placeholder={"e.g. PO request emailed to client Sept 17\nFollow up if no reply by Sept 22"}/>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,flexWrap:"wrap"}}>
            <button onClick={stamp} type="button" style={{...bS,padding:"4px 10px",fontSize:11}}>+ Date stamp</button>
            <div style={{marginLeft:"auto",display:"flex",gap:8}}>
              <button onClick={()=>setEditing(false)} style={{...bS,padding:"4px 12px",fontSize:11}}>Cancel</button>
              <button onClick={save} disabled={saving} style={{...sBtn,background:"#22c55e",padding:"4px 14px",fontSize:11}}>{saving?"Saving…":"Save"}</button>
            </div>
          </div>
          <div style={{fontSize:9,color:T.dim,marginTop:4}}>⌘/Ctrl+Enter to save · Esc to cancel</div>
        </>}
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
  // Accessorial-only pricing (base blank, charges in price.other[]) counts too —
  // e.g. a quote converted to a transport order puts everything in other[].
  const hasOtherPrice = (o.price?.other||[]).some(c=>{
    const lb = (c.qty!==undefined||c.unitPrice!==undefined) ? (parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0) : (parseFloat(c.amt)||0);
    return lb>0;
  });
  const hasEvtLinesPrice = (o.price?.eventLines||[]).some(l=>parseFloat(l.unitPrice)>0);
  const hasAnyPricing = hasOrderPrice || hasOtherPrice || hasEvtLinesPrice || hasStopPricing;
  // POD exists if the order has a single POD (o.podBy) OR any stop has a POD
  // (multi-stop transport orders store POD per delivery/pickup stop as stop.pod.by).
  const hasAnyPod = !!o.podBy || ((o.delStops||[]).concat(o.pickStops||[])).some(st => st && st.pod && st.pod.by);

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
    // FX: if this order uses a currency conversion, pull TODAY's rate now (at
    // invoice time), rebuild the snapshot, and save it back so the record matches
    // exactly what accounting receives. Falls back to the stored snapshot if the
    // live fetch fails, so invoicing is never blocked.
    let orderForInvoice = o;
    const existingSnap = o.price && o.price.fxSnapshot;
    if (existingSnap && (existingSnap.applies || existingSnap.multi)) {
      const live = await fetchFxRatesLive();
      if (live) {
        const freshSnap = buildFxSnapshotFromOrder(o, live.rates, live.fxDate);
        if (freshSnap.grand != null) {
          orderForInvoice = { ...o, price: { ...o.price, fxSnapshot: freshSnap } };
          try { await savOrd(orderForInvoice); } catch(saveErr){ console.warn("FX snapshot save-back failed (email still uses fresh rate):", saveErr); }
        }
      } else {
        console.warn("Live FX fetch failed at invoice time — using stored snapshot.");
      }
    }
    const oSend = orderForInvoice;
    const xeroCSVBase64 = attachCsv ? btoa(unescape(encodeURIComponent(buildXeroCsvString(oSend, oSend.price||p)))) : null;
    try {
      for(const email of emails) {
        await callCloudFn("sendInvoiceEmail", {
          order: { ...oSend, divName: div?.name || "" },
          pricing: { ...(oSend.price||p), billingEmail: cli?.billingEmail || "" },
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
          {hasAnyPricing && <button style={bS} onClick={()=>downloadBolPdf(o,div,false,true,i,cli)}><Ic n="pdf" s={13}/> +Price</button>}
          {hasAnyPod && <button style={bS} onClick={()=>downloadBolPdf(o,div,true,false,i,cli)}><Ic n="pdf" s={13}/> +POD</button>}
          {hasAnyPod && hasAnyPricing && <button style={bS} onClick={()=>downloadBolPdf(o,div,true,true,i,cli)}><Ic n="pdf" s={13}/> +POD+Price</button>}
        </span>);
      })()}
      <button style={bS} onClick={()=>go("oe",{o:{...o,items:[...o.items.map(i=>({...i}))]},mode:"edit"})}><Ic n="edit" s={13}/> Edit</button>

      {/* UNASSIGNED */}
      {o.status==="unassigned" && <>
        {!isEvent && <button style={{...sBtn,background:"#3b82f6"}} onClick={()=>go("oa",o)}><Ic n="truck" s={13}/> Assign</button>}
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="edit" s={13}/> Enter POD</button>}
        {!isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {hasAnyPricing?"Edit Pricing":"+ Add Pricing"}</button>}
        {isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {o.price?.base?"Edit Pricing":"+ Add Pricing"}</button>}
        {isEvent && <button style={{...sBtn,background:"#f59e0b",color:"#000"}} onClick={()=>confirmStatus("assigned",`Mark BOL ${o.bol} as In Progress?`)}>▶ In Progress</button>}
      </>}

      {/* ASSIGNED / IN PROGRESS */}
      {o.status==="assigned" && <>
        {!isEvent && <button style={{...sBtn,background:"#3b82f6"}} onClick={()=>go("oa",o)}><Ic n="edit" s={13}/> Reassign</button>}
        {!isEvent && <button style={{...sBtn,background:"#8b5cf6"}} onClick={()=>confirmStatus("in-transit",`Move BOL ${o.bol} to In Transit?`)}>In Transit</button>}
        {!isEvent && allOrderDrivers.map((d,i)=><button key={i} style={bS} disabled={sending} onClick={()=>emailDriver(i)}><Ic n="mail" s={13}/> Email {allOrderDrivers.length>1?d.drvName||`Driver ${i+1}`:"Driver"}</button>)}
        {!isEvent && <button style={bS} onClick={()=>go("op",o)}><Ic n="edit" s={13}/> Enter POD</button>}
        {!isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {hasAnyPricing?"Edit Pricing":"+ Add Pricing"}</button>}
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
        {!isEvent && <button style={bS} onClick={()=>go("opr",o)}><Ic n="dollar" s={13}/> {hasAnyPricing?"Edit Pricing":"+ Add Pricing"}</button>}
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

    <DispatchNotesCard o={o} savOrd={savOrd}/>

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
    {o.xeroInvoiceUrl && <div style={sCrd}><div style={{fontSize:10,fontWeight:600,color:T.muted,textTransform:"uppercase",marginBottom:4,display:"flex",alignItems:"center",justifyContent:"space-between"}}><span>Xero Invoice</span><button onClick={async()=>{if(!window.confirm(`Remove the Xero invoice attachment from BOL ${o.bol}?\n\nThis only detaches it from this order — the file in Xero is not deleted.`))return;await savOrd({...o,xeroInvoiceUrl:null,xeroInvoiceFile:null});}} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:600,padding:0,fontFamily:"inherit"}}>× Remove</button></div><a href={o.xeroInvoiceUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"#0ea5e9",display:"flex",alignItems:"center",gap:4,textDecoration:"none"}}><Ic n="dl" s={12}/>{o.xeroInvoiceFile||"Xero Invoice PDF"}</a></div>}
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
                <th style={{textAlign:"right",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 4px"}}>Cur</th>
                <th style={{textAlign:"right",fontSize:9,color:T.muted,fontWeight:700,textTransform:"uppercase",padding:"2px 0"}}>Total</th>
              </tr></thead>
              <tbody>
                {linesCalc.map((l,i)=>{const lc=l.currency||p.cur||"CAD";const ls=csym(lc);
                  const snap=p.fxSnapshot; const tgt=(snap&&snap.target)||lc;
                  const conv=fxLineToTarget(l.ltot,lc,snap||{}); const tsym=csym(tgt);
                  const showConv=lc!==tgt;
                  return <tr key={i} style={{borderBottom:`1px solid ${T.border}`}}>
                  <td style={{padding:"4px 8px 4px 0",fontSize:11}}>
                    {l.desc}{l.ltax>0&&<span style={{fontSize:9,color:T.muted,marginLeft:4}}>({l.ltaxLabel})</span>}
                  </td>
                  <td style={{textAlign:"right",padding:"4px",fontSize:11,color:T.muted}}>{l.qty}</td>
                  <td style={{textAlign:"right",padding:"4px",fontSize:11,color:T.muted}}>{ls}{parseFloat(l.unitPrice).toFixed(2)}</td>
                  <td style={{textAlign:"right",padding:"4px",fontSize:10,color:T.muted}}>{lc}</td>
                  <td style={{textAlign:"right",padding:"4px 0",fontWeight:600,fontSize:11,color:"#22c55e"}}>
                    {showConv
                      ? (conv.ok
                          ? <>{tsym}{conv.val.toFixed(2)}<div style={{fontSize:9,color:T.muted,fontWeight:400}}>was {ls}{l.ltot.toFixed(2)} {lc}</div></>
                          : <>{ls}{l.ltot.toFixed(2)} {lc}<div style={{fontSize:9,color:"#f59e0b",fontWeight:400}}>rate n/a — re-save order</div></>)
                      : <>{ls}{l.ltot.toFixed(2)}</>}
                  </td>
                </tr>;})}
              </tbody>
            </table>
          </div>}
          {/* Grand total — use FX snapshot when a conversion/adjustment applies */}
          {(hasTransport||hasLines) && (()=>{
            const snap = p.fxSnapshot;
            if (snap && (snap.applies || snap.multi) && snap.grand!=null) {
              const tsym = csym(snap.target);
              // Foot the subtotal to the SUM of the rounded converted line totals
              // shown above, so lines add up exactly (Xero recomputes from lines).
              const footed = fxConvertedLineSum(linesCalc, snap);
              const anyMissing = footed.rows.some(r=>!r.ok);
              // Converted subtotal = rounded line sum (+ transport already in target).
              const convSub = footed.sum;
              const adjAmt = snap.adjVal ? (snap.adjMode==="pct" ? Math.round(convSub*(snap.adjVal/100)*100)/100 : (parseFloat(snap.adjVal)||0)) : 0;
              const grand = Math.round((convSub + adjAmt)*100)/100;
              return <div style={{marginTop:8,borderTop:`1px solid ${T.border}`,paddingTop:6}}>
                <div style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.3px",marginBottom:4}}>Subtotals by currency (as entered)</div>
                {Object.entries(snap.byCur||{}).map(([c,a])=>(
                  <div key={c} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.muted,marginBottom:2}}>
                    <span>{c}</span><span>{csym(c)}{a.toFixed(2)} {c}</span>
                  </div>
                ))}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.muted,marginTop:4}}><span>Subtotal ({snap.target})</span><span>{tsym}{convSub.toFixed(2)}</span></div>
                {snap.adjVal ? <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:adjAmt<0?"#f59e0b":T.muted}}><span>{snap.adjLabel} ({snap.adjMode==="pct"?`${snap.adjVal}%`:"flat"})</span><span>{adjAmt<0?"−":""}{tsym}{Math.abs(adjAmt).toFixed(2)}</span></div> : null}
                <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:14,marginTop:4}}><span>Grand Total</span><span style={{color:"#0ea5e9"}}>{tsym}{grand.toFixed(2)} {snap.target}</span></div>
                {anyMissing && <div style={{fontSize:10,color:"#f59e0b",marginTop:4}}>Some lines have no locked rate — re-save this order to lock exchange rates.</div>}
                {snap.fxDate && <div style={{fontSize:9,color:T.dim,marginTop:4}}>Converted at rates as of {snap.fxDate} UTC.</div>}
              </div>;
            }
            return <div style={{fontWeight:700,marginTop:8,fontSize:14,borderTop:`1px solid ${T.border}`,paddingTop:6}}>
              {hasLines?`Grand Total: ${sym}${grandTotal.toFixed(2)} ${p.cur||"CAD"}`:`Total: ${sym}${transportTotal.toFixed(2)} ${p.cur||"CAD"}`}
            </div>;
          })()}
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
    showCsvOption={!!(p.base && parseFloat(p.base)>0) || (p.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0) || (p.eventLines||[]).some(l=>l.desc&&parseFloat(l.unitPrice)>0) || ((o.pickStops||[]).concat(o.delStops||[])).some(st=>st&&st.price&&(parseFloat(st.price.base)>0||(st.price.other||[]).some(c=>c.desc||parseFloat(c.amt)>0||parseFloat(c.unitPrice)>0)))}
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
      const uploaded = [];
      for(const file of Array.from(files)) {
        const path = `clients/${itemId}/${Date.now()}_${file.name}`;
        const ref = storageRef(storage, path);
        await uploadBytes(ref, file);
        const url = await getDownloadURL(ref);
        uploaded.push({name:file.name, url, path, uploadedAt:new Date().toISOString()});
      }
      // Append ALL uploaded docs in a single call so multiple files dropped at once
      // don't clobber each other (each per-file save would start from stale docs).
      if(uploaded.length) await onUploaded(uploaded);
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
        <span style={{fontSize:16,flexShrink:0}}>📄</span>
        <span style={{fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"55%"}}>{d.name}</span>
        <button onClick={e=>{e.stopPropagation();window.open(d.url,"_blank");}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:"1px solid #3b82f6",background:"transparent",color:"#3b82f6",cursor:"pointer",fontFamily:"inherit",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>📄 Open</button>
        <span style={{fontSize:10,color:T.dim,whiteSpace:"nowrap",marginLeft:"auto"}}>{d.uploadedAt?new Date(d.uploadedAt).toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"}):""}</span>
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
    return fields.some(f => String(item[f.k] ?? "").toLowerCase().includes(s));
  }).sort((a,b) => {
    const aName = String(a.name||a.company||a[fields[0].k]||"").toLowerCase();
    const bName = String(b.name||b.company||b[fields[0].k]||"").toLowerCase();
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
        if(f.tp==="checkbox") return <Field key={f.k} l={f.l}>
          <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"6px 0"}}>
            <input type="checkbox" checked={!!fmData[f.k]} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.checked}))} style={{accentColor:T.red,width:16,height:16}}/>
            <span style={{fontSize:13,color:T.text}}>{f.cbLabel||"Yes"}</span>
          </label>
        </Field>;
        return <Field key={f.k} l={f.l}>{
          f.tp==="textarea"
            ? <textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>
            : f.tp==="date"
              ? <DatePicker value={fmData[f.k]||""} onChange={v=>setFmData(p=>({...p,[f.k]:v}))} placeholder="Select date..."/>
              : <input style={sIn} type={f.tp||"text"} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>
        }</Field>;
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
        <ClientDocDropZone itemId={ed} docs={items.find(x=>x.id===ed)?.docs||[]} onUploaded={async(newDocs)=>{
          const item = items.find(x=>x.id===ed);
          const add = Array.isArray(newDocs) ? newDocs : [newDocs];
          await save(items.map(x=>x.id===ed?{...item,docs:[...(item.docs||[]),...add]}:x));
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
                <input type="file" multiple accept="*/*" style={{display:"none"}} onChange={async e=>{
                  const files = Array.from(e.target.files||[]); if(!files.length) return;
                  e.target.value="";
                  try {
                    const added = [];
                    for(const file of files){
                      const path = `clients/${item.id}/${Date.now()}_${file.name}`;
                      const r = storageRef(storage, path);
                      await uploadBytes(r, file);
                      const url = await getDownloadURL(r);
                      added.push({name:file.name,url,path,uploadedAt:new Date().toISOString()});
                    }
                    if(added.length) await save(items.map(x=>x.id===item.id?{...item,docs:[...(item.docs||[]),...added]}:x));
                  } catch(e){ console.error(e); alert("Upload failed"); }
                }}/>
              </label>
            </div>
            {(item.docs||[]).length===0 && <div style={{fontSize:11,color:T.dim,fontStyle:"italic"}}>No documents yet</div>}
            {(item.docs||[]).map((d,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",background:T.hover,borderRadius:5,marginBottom:4}}>
              <span style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"60%"}}>{d.name}</span>
              <a href={d.url} target="_blank" rel="noopener noreferrer" onClick={e=>{e.stopPropagation();window.open(d.url,"_blank");}} style={{fontSize:10,color:"#3b82f6",textDecoration:"none",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>📄 Open</a>
              <button onClick={async()=>{
                const ok = await cfm("Delete Document","Remove this document? This cannot be undone.");
                if(!ok) return;
                try { await deleteObject(storageRef(storage,d.path)); } catch{}
                await save(items.map(x=>x.id===item.id?{...item,docs:(item.docs||[]).filter(dd=>dd.path!==d.path)}:x));
              }} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,padding:"0 2px",lineHeight:1,marginLeft:"auto"}}>×</button>
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

// ═══ SHARED DOCS (company → driver, read-only in the timesheet app) ═══
// Uploads to Storage and writes to the SEPARATE `driver_shared_docs` collection,
// tagged with the driver's employeeId (trimmed+lowercased — the exact key the
// timesheet login matches on). Kept apart from the person record's own `docs`
// array and from `employee_documents` (which is the driver→manager direction),
// so the driver app can read only what's deliberately shared here.
function SharedDocsSection({ employeeId, driverName }) {
  const empKey = String(employeeId || "").trim().toLowerCase();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    if (!empKey) { setDocs([]); setLoading(false); return; }
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "driver_shared_docs"), where("employeeId", "==", empKey)));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a,b) => (b.uploadedAt||0) - (a.uploadedAt||0));
      setDocs(list);
    } catch (e) { console.error("shared docs load failed:", e); }
    setLoading(false);
  }, [empKey]);
  useEffect(() => { load(); }, [load]);

  const onFiles = async (files) => {
    if (!empKey || !files || !files.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const up = await uploadFile(file, `driver_shared_docs/${empKey}`);
        await addDoc(collection(db, "driver_shared_docs"), {
          employeeId: empKey,
          driverName: driverName || "",
          label: (label.trim() || file.name),
          name: up.name, type: up.type, url: up.url, path: up.path,
          uploadedAt: Date.now(),
        });
      }
      setLabel("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) { console.error("shared doc upload failed:", e); alert("Upload failed — try again."); }
    setBusy(false);
  };

  const remove = async (d) => {
    if (!window.confirm(`Remove "${d.label}" from this driver's app? This deletes the file.`)) return;
    setBusy(true);
    try {
      if (d.path) { try { await deleteObject(storageRef(storage, d.path)); } catch {} }
      await deleteDoc(doc(db, "driver_shared_docs", d.id));
      setDocs(ds => ds.filter(x => x.id !== d.id));
    } catch (e) { console.error("shared doc delete failed:", e); alert("Could not remove — try again."); }
    setBusy(false);
  };

  return <div style={{ marginTop: 10, padding: 12, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: T.green, marginBottom: 2 }}>📤 Documents Shared With This Driver</div>
    <div style={{ fontSize: 10, color: T.muted, marginBottom: 8 }}>
      The driver sees these read-only in their timesheet app (e.g. to show at customs). They can view &amp; download, not edit or delete.
    </div>

    {!empKey ? (
      <div style={{ fontSize: 11, color: T.amber, background: T.amberDim, border: `1px solid ${T.amber}`, borderRadius: 6, padding: "8px 10px" }}>
        Set this person's <strong>Employee ID</strong> (in Portal Access above) and save first — shared documents are tied to it so the right driver sees them.
      </div>
    ) : <>
      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (e.g. Drug screen — Aug 2026)"
        style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, padding: "7px 10px", fontFamily: "inherit", outline: "none", marginBottom: 4 }} />
      <div style={{ fontSize: 9, color: T.dim, marginBottom: 6 }}>Tip: set the label before dropping the file; blank uses the filename.</div>
      <DropZone label="Share a document" uploading={busy} docKey="__shared__" fileRef={fileRef} onFiles={onFiles} />

      {loading ? <div style={{ fontSize: 11, color: T.muted }}>Loading…</div>
        : docs.length === 0 ? <div style={{ fontSize: 11, color: T.dim, fontStyle: "italic" }}>Nothing shared with this driver yet.</div>
        : docs.map(d => <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: T.hover, borderRadius: 5, marginBottom: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.text, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</div>
              <div style={{ fontSize: 10, color: T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
            </div>
            <a href={d.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: T.blue, textDecoration: "none", whiteSpace: "nowrap" }}>View</a>
            <button onClick={() => remove(d)} disabled={busy} style={{ fontSize: 11, color: T.red, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Remove</button>
          </div>)}
    </>}
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

// ═══════════════════════════════════════════════════════════════════════════
// BUILT-IN CERT CONFIG — makes the hardcoded certifications renamable and lets
// their behaviour mode be changed from Admin, live, without a code change.
//
// AdminPage writes settings/certConfig { certs: { <k>: {label?, mode?, months?} } }.
// Only overridden certs appear in that doc; anything absent uses the default
// below. Three modes map onto the existing {months, direct} engine:
//   "complete" → months:0, direct:false   (date recorded, never expires)
//   "window"   → months:N, direct:false   (expiry = completion + N months)
//   "direct"   → direct:true              (the stored date IS the expiry)
// Everything downstream (form, badges, reports, digest) reads the merged shape,
// so a rename or a window change recomputes everywhere at once.
// ═══════════════════════════════════════════════════════════════════════════

// The immutable defaults. `k` is the Firestore field on each person record;
// docKey holds its uploaded documents. These never change — overrides layer on.
const CERT_DEFAULTS = [
  { k: "acrDate",       l: "ACR Training",           months: 12, docKey: "acrDocs" },
  { k: "hazmatDate",    l: "HazMat Training",        months: 36, docKey: "hazmatDocs" },
  { k: "crimDate",      l: "Criminal Record Check",  months: 60, docKey: "crimDocs" },
  { k: "bgDate",        l: "Background Verification", months: 0, docKey: "bgDocs" },
  { k: "conductDate",   l: "Code of Conduct",        months: 0, docKey: "conductDocs" },
  { k: "licenseExpiry", l: "Driver's Licence",       direct: true, docKey: "licenseDocs" },
];

// Translate a stored mode + months into the {months, direct} the engine wants.
function certModeToShape(mode, months) {
  if (mode === "direct")   return { direct: true, months: 0 };
  if (mode === "complete") return { direct: false, months: 0 };
  if (mode === "window")   return { direct: false, months: Number(months) || 12 };
  return null; // unknown → caller keeps the default
}
// Report a cert's current mode from its default shape (for the Admin UI's
// starting value when no override exists yet).
function certShapeToMode(def) {
  if (def.direct) return "direct";
  if (Number(def.months) > 0) return "window";
  return "complete";
}

// Merge settings/certConfig over CERT_DEFAULTS → the effective cert list.
function mergeCerts(config) {
  const over = (config && config.certs) || {};
  return CERT_DEFAULTS.map(def => {
    const o = over[def.k];
    if (!o) return { ...def };
    const merged = { ...def };
    if (o.label && String(o.label).trim()) merged.l = String(o.label).trim();
    const shape = o.mode ? certModeToShape(o.mode, o.months) : null;
    if (shape) { merged.direct = shape.direct; merged.months = shape.months; }
    return merged;
  });
}

// Live subscription to certConfig, returning the merged effective cert list.
// Returns CERT_DEFAULTS until the first snapshot lands.
function useCerts() {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "certConfig"),
      snap => setConfig(snap.exists() ? snap.data() : { certs: {} }),
      err => { console.warn("certConfig load failed:", err); });
    return () => unsub();
  }, []);
  return useMemo(() => mergeCerts(config), [config]);
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILT-IN FIELD LAYOUT — rename or remove (hide) the standard fields on the
// person and equipment forms, from Admin, live. Writes settings/fieldLayout
// { fields: { <key>: {label?, hidden?} } }. Only overridden keys appear.
//
// Load-bearing fields (name, phone, email, unit, pin) can be renamed but never
// hidden — hiding them would break duplicate detection, login, or equipment
// sorting. FIELD_PROTECTED enforces that on the read side too, so even a
// hand-edited config can't hide them.
// ═══════════════════════════════════════════════════════════════════════════
const FIELD_PROTECTED = new Set(["name", "phone", "email", "unit", "pin"]);

// Default labels for every renamable/hideable built-in field, by key.
const FIELD_DEFAULTS = {
  // People
  name: "Full Name", phone: "Phone", email: "Email",
  contactPerson: "Contact Person", serviceType: "Service Type",
  license: "License Class", notes: "Internal Notes", address: "Address",
  // Equipment
  unit: "Unit #", plate: "Plate #", year: "Year", make: "Make",
  model: "Model", type: "Type", vin: "VIN", safetyExp: "Safety Expiration",
};

// Live subscription to the field layout. Returns { fields: {...} }.
function useFieldLayout() {
  const [layout, setLayout] = useState({ fields: {} });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "fieldLayout"),
      snap => setLayout(snap.exists() ? (snap.data() || { fields: {} }) : { fields: {} }),
      err => { console.warn("fieldLayout load failed:", err); });
    return () => unsub();
  }, []);
  return layout;
}

// Effective label for a field key given the layout (falls back to default).
function fieldLabel(layout, key) {
  const o = (layout && layout.fields && layout.fields[key]) || {};
  return (o.label && String(o.label).trim()) || FIELD_DEFAULTS[key] || key;
}
// Is a field hidden? Protected keys can never be hidden regardless of config.
function fieldHidden(layout, key) {
  if (FIELD_PROTECTED.has(key)) return false;
  const o = (layout && layout.fields && layout.fields[key]) || {};
  return !!o.hidden;
}
// Module-level (non-hook) readers for the report code, kept live by a
// subscription the same way RPT_CERTS is. Reports run on a click, well after
// the first snapshot, so a mutable module variable is correct here.
let FIELD_LAYOUT_LIVE = { fields: {} };
try {
  onSnapshot(doc(db, "settings", "fieldLayout"),
    snap => { FIELD_LAYOUT_LIVE = snap.exists() ? (snap.data() || { fields: {} }) : { fields: {} }; },
    err => { console.warn("fieldLayout (reports) load failed:", err); });
} catch (e) { console.warn("fieldLayout subscription skipped:", e); }
function rptFieldLabel(key) { return fieldLabel(FIELD_LAYOUT_LIVE, key); }
function rptFieldHidden(key) { return fieldHidden(FIELD_LAYOUT_LIVE, key); }

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM FIELDS — consumption layer for definitions authored in AdminPage.jsx
//
// AdminPage writes settings/customFields { fields:[ {id,label,targets,kind,
// docs,alert,alertDays}, ... ] }. Everything below READS those defs and makes
// them show up on forms, on reports, and (server side, separately) in alerts.
//
// A field's value lives on the record under its own id (e.g. driver.cf_abc123).
// If docs are enabled, uploads live under `${id}Docs`, matching the acrDocs
// convention already used for built-in certs.
// ═══════════════════════════════════════════════════════════════════════════

// Load the custom-field defs once and keep them fresh in real time, so a field
// added in Admin appears on forms without a page reload. Returns [] until the
// first snapshot arrives, so callers can render nothing meanwhile.
function useCustomFields() {
  const [defs, setDefs] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "customFields"),
      snap => setDefs(snap.exists() ? (snap.data().fields || []) : []),
      err => { console.warn("customFields load failed:", err); });
    return () => unsub();
  }, []);
  return defs;
}

// Named general-profile sections authored in AdminPage (settings/sections).
// Each: { id, label, targets:[...] }. Fields reference a section by its id via
// field.section; fields with no matching section fall into a default block.
function useSections() {
  const [secs, setSecs] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "sections"),
      snap => setSecs(snap.exists() ? (snap.data().sections || []) : []),
      err => { console.warn("sections load failed:", err); });
    return () => unsub();
  }, []);
  return secs;
}

// Group a list of field defs into ordered named sections for one record type.
// Returns [{ id, label, fields:[...] }]. Fields whose section is missing or not
// applicable to this target collect under a trailing "Custom Fields" block, so
// nothing an operator created before sections existed ever disappears.
function groupBySection(fields, sections, target) {
  const applicableSecs = (sections || []).filter(s => (s.targets || []).includes(target));
  const byId = new Map(applicableSecs.map(s => [s.id, { id: s.id, label: s.label, fields: [] }]));
  const loose = [];
  (fields || []).forEach(f => {
    const g = f.section && byId.get(f.section);
    if (g) g.fields.push(f); else loose.push(f);
  });
  const out = applicableSecs.map(s => byId.get(s.id)).filter(g => g.fields.length);
  if (loose.length) out.push({ id: "__loose", label: "Custom Fields", fields: loose });
  return out;
}

// Fields for one or more targets, split by which form area they belong to.
// Accepts a single target ("trucks") or a list (["drivers","employees"]) and
// de-dupes so a driver+employee sees each field once.
//   general: shown in the General Profile area (default block or a section)
//   certs:   shown in the Certifications & Checks area
// Backward-compat: older defs have no `area`. An expiry-kind field with no area
// was previously shown in the certs block, so it maps to certs; everything else
// maps to general.
function cfForTarget(defs, target) {
  const targets = Array.isArray(target) ? target : [target];
  const seen = new Set();
  const all = (defs || []).filter(f => {
    if (!(f.targets || []).some(t => targets.includes(t))) return false;
    if (seen.has(f.id)) return false;
    seen.add(f.id); return true;
  });
  const areaOf = f => f.area || (f.kind === "expiry" ? "certs" : "general");
  return {
    all,
    certs:   all.filter(f => areaOf(f) === "certs"),
    general: all.filter(f => areaOf(f) === "general"),
    // legacy aliases kept so existing call sites don't break
    expiry:  all.filter(f => areaOf(f) === "certs"),
    plain:   all.filter(f => areaOf(f) === "general"),
  };
}

// Which custom-field targets apply to a person record (they can be both a
// driver and an employee; suppliers are exclusive).
function cfPersonTargets(p) {
  if (p.isSupplier) return ["suppliers"];
  const t = [];
  if (p.isDriver !== false) t.push("drivers");
  if (p.isEmployee) t.push("employees");
  return t.length ? t : ["drivers"];
}

// Expiry helpers for custom expiry fields (the value IS the expiry date).
function cfExpColor(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((new Date(dateStr + "T12:00:00") - new Date()) / 864e5);
  if (diff < 0) return "#ef4444";
  if (diff <= 30) return "#eab308";
  if (diff <= 90) return "#f97316";
  return "#22c55e";
}
function cfExpLabel(dateStr) {
  if (!dateStr) return "";
  const diff = Math.floor((new Date(dateStr + "T12:00:00") - new Date()) / 864e5);
  if (diff < 0) return "EXPIRED";
  if (diff <= 90) return `${diff}d left`;
  return "Valid";
}

// Renders the inputs for a set of custom field defs against a form object `fm`,
// wiring changes back through setFm. Reuses the same DropZone as built-in docs.
// `onFiles(files, docKey)` and `removeFile(docKey, idx)` are supplied by the
// host component so uploads follow its existing storage-path convention.
function CustomFieldInputs({ fieldDefs, fm, setFm, uploading, onFiles, removeFile, fileRefs, editing, saveBtn, plain }) {
  if (!fieldDefs.length) return null;
  return fieldDefs.map(f => {
    const val = fm[f.id] ?? "";
    const docs = fm[`${f.id}Docs`] || [];
    // Plain mode: render as a normal built-in-style field (grey label, plain
    // input, no card/blue label/"· custom"), so General Profile fields blend in
    // with Name/Email/etc. Only used for simple text/number general fields.
    if (plain) {
      return (
        <Field key={f.id} l={f.label}>
          {f.kind === "number"
            ? <input style={sIn} type="number" value={val} onChange={e => setFm(p => ({ ...p, [f.id]: e.target.value }))} />
            : <input style={sIn} value={val} onChange={e => setFm(p => ({ ...p, [f.id]: e.target.value }))} />}
        </Field>
      );
    }
    return (
      <div key={f.id} style={{ marginBottom: 6, padding: 12, background: T["bg"], borderRadius: 8, border: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", marginBottom: 6 }}>
          {f.label}
          <span style={{ fontSize: 9, color: T.dim, fontWeight: 400, marginLeft: 6 }}>· custom</span>
        </div>
        {f.kind === "text" &&
          <input style={sIn} value={val} onChange={e => setFm(p => ({ ...p, [f.id]: e.target.value }))} />}
        {f.kind === "number" &&
          <input style={sIn} type="number" value={val} onChange={e => setFm(p => ({ ...p, [f.id]: e.target.value }))} />}
        {(f.kind === "date" || f.kind === "expiry") &&
          <div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase", marginBottom: 3 }}>
            {f.kind === "expiry" && f.certMode !== "window" ? "Expiration Date" : "Date Completed"}
          </div>}
        {(f.kind === "date" || f.kind === "expiry") &&
          <DatePicker value={val} onChange={v => setFm(p => ({ ...p, [f.id]: v }))} placeholder="Select date..." />}
        {/* Direct expiry: the value IS the expiry date. */}
        {f.kind === "expiry" && f.certMode !== "window" && val &&
          <div style={{ fontSize: 10, marginTop: 3, color: cfExpColor(val) || T.muted }}>
            Expires: {fd(val)} — {cfExpLabel(val)}{f.alert ? ` · alerts on (${f.alertDays}d)` : ""}
          </div>}
        {/* Window: value is the completion date, expiry = completion + months. */}
        {f.kind === "expiry" && f.certMode === "window" && val && (() => {
          const exp = expDate(val, f.months || 12);
          return <div style={{ fontSize: 10, marginTop: 3, color: cfExpColor(exp) || T.muted }}>
            Completed {fd(val)} — Expires {fd(exp)} — Renewal every {f.months} months — {cfExpLabel(exp)}{f.alert ? " · alerts on" : ""}
          </div>;
        })()}
        {f.kind === "date" && val &&
          <div style={{ fontSize: 10, marginTop: 3, color: "#22c55e" }}>Completed on {fd(val)} — No renewal required</div>}
        {f.docs && <>
          <DropZone label="Document" uploading={uploading} docKey={`${f.id}Docs`}
            fileRef={fileRefs?.[`${f.id}Docs`]} onFiles={files => onFiles(files, `${f.id}Docs`)} />
          {docs.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
            {docs.map((a, i) => (
              <div key={i} style={{ padding: "2px 6px", background: T["bg"], borderRadius: 3, fontSize: 9, display: "flex", alignItems: "center", gap: 2 }}>
                <a href={a.url || a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{ color: T.text, textDecoration: "none", display: "flex", alignItems: "center", gap: 2 }}><Ic n="dl" s={9} />{a.name}</a>
                {editing && <button onClick={() => removeFile(`${f.id}Docs`, i)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 11 }}>×</button>}
              </div>
            ))}
          </div>}
        </>}
        {saveBtn}
      </div>
    );
  });
}

// ─── Report helpers for custom fields ───
// Render a custom field's value for reports (detail rows + flat table cells).
function cfReportValue(f, rec) {
  const v = rec[f.id];
  if (v == null || v === "") {
    return f.docs ? (rec[`${f.id}Docs`]?.length ? `${rec[`${f.id}Docs`].length} doc(s)` : "") : "";
  }
  if (f.kind === "expiry") {
    // Window mode: value is the completion date; expiry = completion + months.
    if (f.certMode === "window") {
      const exp = expDate(v, f.months || 12);
      return `${fd(v)} → ${fd(exp)} (${cfExpLabel(exp)})`;
    }
    const lbl = cfExpLabel(v);
    return `${fd(v)}${lbl ? ` (${lbl})` : ""}`;
  }
  if (f.kind === "date") return fd(v);
  return String(v);
}
// Column tuples [label, fn] for the custom fields targeting a given scope.
function cfColsFor(defs, target) {
  return (defs || [])
    .filter(f => (f.targets || []).includes(target))
    .map(f => [f.label, rec => cfReportValue(f, rec)]);
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
  const customDefs = useCustomFields();
  // Refs keyed by docKey for reliable matching. Custom-field doc refs are added
  // lazily via a Proxy-like getter so any cf_<id>Docs key resolves to a stable ref.
  const cfRefStore = useRef({});
  const fileRefs = useMemo(() => {
    const base = { acrDocs: { current: null }, hazmatDocs: { current: null }, crimDocs: { current: null }, bgDocs: { current: null }, conductDocs: { current: null }, licenseDocs: { current: null }, docs: { current: null } };
    return new Proxy(base, { get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && k.endsWith("Docs")) {
        if (!cfRefStore.current[k]) cfRefStore.current[k] = { current: null };
        return cfRefStore.current[k];
      }
      return undefined;
    }});
  }, []);

  const CERTS = useCerts();
  const layout = useFieldLayout();
  const sections = useSections();
  const fL = k => fieldLabel(layout, k);
  const fH = k => fieldHidden(layout, k);

  const normalizePhone = p => (p||"").replace(/[\s\-().+]/g,"");
  const startNew = () => { setFm({ name:"", phone:"", email:"", license:"", isDriver:true, isEmployee:false, isSupplier:false, contactPerson:"", street:"", city:"", provState:"", postalZip:"", country:"", serviceType:"", acrDate:"", hazmatDate:"", crimDate:"", bgDate:"", conductDate:"", licenseExpiry:"", alertsMuted:false, alertsMutedUntil:"", alertsMutedReason:"", certSnooze:{}, logRestricted:false, driverLog:false, archived:false, acrDocs:[], hazmatDocs:[], crimDocs:[], bgDocs:[], conductDocs:[], licenseDocs:[], docs:[], employeeId:"", pin:"" }); setEd("new"); setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100); };
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
    if (roleFilter === "archived") return item.archived === true;
    if (item.archived === true) return false; // archived people hidden from all active chips
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
      {[{k:"all",l:"All"},{k:"drivers",l:"Drivers"},{k:"employees",l:"Employees"},{k:"suppliers",l:"Suppliers"},{k:"archived",l:"Archived"}].map(f=><button key={f.k} onClick={()=>setRoleFilter(f.k)} style={{padding:"4px 12px",borderRadius:5,border:`1px solid ${roleFilter===f.k?T.red:T.border}`,background:roleFilter===f.k?"rgba(220,38,38,0.08)":"transparent",color:roleFilter===f.k?T.red:T.muted,fontSize:10,cursor:"pointer",fontWeight:500,fontFamily:"inherit"}}>{f.l}</button>)}
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
      <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>General Profile</div>
      <Field l={fL("name")}><input style={sIn} value={fm.name || ""} onChange={e => setFm(p => ({ ...p, name: e.target.value }))} /></Field>
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
      <Field l={fL("phone")}><input style={sIn} value={fm.phone || ""} onChange={e => setFm(p => ({ ...p, phone: normalizePhone(e.target.value) }))} /></Field>
      <Field l={fL("email")}><input style={sIn} value={fm.email || ""} onChange={e => setFm(p => ({ ...p, email: e.target.value }))} /></Field>
      {fm.isSupplier && <>
        {!fH("contactPerson") && <Field l={fL("contactPerson")}><input style={sIn} value={fm.contactPerson || ""} onChange={e => setFm(p => ({ ...p, contactPerson: e.target.value }))} placeholder="e.g. John Smith"/></Field>}
        {!fH("serviceType") && <Field l={fL("serviceType")}><input style={sIn} value={fm.serviceType || ""} onChange={e => setFm(p => ({ ...p, serviceType: e.target.value }))} placeholder="e.g. Trucking, Customs Broker"/></Field>}
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
      {!fm.isSupplier && !fH("license") && <Field l={fL("license")}><input style={sIn} value={fm.license || ""} onChange={e => setFm(p => ({ ...p, license: e.target.value }))} /></Field>}
      {!fH("notes") && <Field l={fL("notes")}><textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fm.notes || ""} onChange={e => setFm(p => ({ ...p, notes: e.target.value }))} /></Field>}

      {/* General Profile custom fields. Fields you assigned to a named section
          render under that section's header. Fields with no section blend
          straight into General Profile — no "Custom Fields" sub-header — since
          you already chose General Profile when creating them. */}
      {(() => {
        const grp = cfForTarget(customDefs, cfPersonTargets(fm));
        const here = grp.general;
        if (!here.length) return null;
        const primaryTarget = fm.isSupplier ? "suppliers" : (fm.isEmployee && fm.isDriver === false ? "employees" : "drivers");
        const groups = groupBySection(here, sections, primaryTarget);
        return groups.map(g => {
          const loose = g.id === "__loose";
          const inputs = <CustomFieldInputs fieldDefs={g.fields} fm={fm} setFm={setFm} uploading={uploading}
            onFiles={addFile} removeFile={removeFile} fileRefs={fileRefs} editing={ed} plain />;
          // Loose (unassigned) fields: no header, no divider — part of General Profile.
          if (loose) return <div key={g.id}>{inputs}</div>;
          // Named section: its own headed block.
          return (
            <div key={g.id} style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", marginBottom: 8 }}>{g.label}</div>
              {inputs}
            </div>
          );
        });
      })()}

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
            <input type="number" min="0" step="0.25" value={fm.payCfg?.hourly||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",hourly:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/h</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Working Day Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.workDay||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",workDay:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Non-Working Day Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.nonWorkDay||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",nonWorkDay:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Traveling Day Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.travelDay||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",travelDay:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Per Diem</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.perDiem||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",perDiem:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
              style={{...sIn,width:100,padding:"5px 8px",fontSize:12}} placeholder="0.00"/>
            <span style={{fontSize:12,color:T.muted}}>/day</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,width:160,flexShrink:0}}>Trip Rate</span>
            <span style={{fontSize:12,color:T.muted}}>$</span>
            <input type="number" min="0" step="1" value={fm.payCfg?.tripRate||""} onChange={e=>setFm(p=>({...p,payCfg:{...(p.payCfg||{}),type:"mixed",tripRate:e.target.value===""?"":(parseFloat(e.target.value)||0)}}))}
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
              {(() => {
                const snz = (fm.certSnooze || {})[c.k] || "";
                const active = snz && todayIso <= snz;
                const setSnz = v => setFm(p => {
                  const next = { ...(p.certSnooze || {}) };
                  if (v) next[c.k] = v; else delete next[c.k];
                  return { ...p, certSnooze: next };
                });
                return <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${T.border}` }}>
                  {active ? <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: "rgba(245,158,11,0.12)", color: "#f59e0b", border: "1px solid #f59e0b", fontWeight: 600 }}>
                      🔕 Reminders snoozed — resume {fd(snz)}
                    </span>
                    <button type="button" style={{ ...bS, padding: "4px 10px", fontSize: 10 }} onClick={() => setSnz("")}>Resume now</button>
                  </div> : <div>
                    <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>Snooze this reminder until (other certs keep alerting):</div>
                    <div style={{ maxWidth: 200 }}>
                      <DatePicker value={snz} onChange={setSnz} placeholder="Pick a resume date..." />
                    </div>
                  </div>}
                </div>;
              })()}
            </Field>
            <DropZone label="Certificate / Document" uploading={uploading} docKey={c.docKey} fileRef={fileRefs[c.docKey]} onFiles={files => addFile(files, c.docKey)} />
            {(fm[c.docKey] || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>{fm[c.docKey].map((a, i) => docChip(c.docKey, i, a))}</div>}
            <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : `Save ${c.l}`}</button>
          </div>
        ))}
        {/* Custom expiry fields for this person type live alongside the built-in
            certs so they share the same expiry look and the alert opt-in. */}
        <CustomFieldInputs
          fieldDefs={cfForTarget(customDefs, cfPersonTargets(fm)).expiry}
          fm={fm} setFm={setFm} uploading={uploading} onFiles={addFile} removeFile={removeFile}
          fileRefs={fileRefs} editing={ed}
          saveBtn={<button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : "Save"}</button>} />

        {/* Other Documents — general, non-cert docs (moved inside the collapse) */}
        <div style={{ marginTop: 10, padding: 12, background: T["bg"], borderRadius: 8, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", marginBottom: 6 }}>Other Documents</div>
          <DropZone label="Documents" uploading={uploading} docKey="docs" fileRef={fileRefs.docs} onFiles={files => addFile(files, "docs")} />
          {(fm.docs || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>{fm.docs.map((a, i) => docChip("docs", i, a))}</div>}
          <button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : "Save Documents"}</button>
        </div>

        {/* Company → driver shared docs (read-only in the timesheet app) */}
        <SharedDocsSection employeeId={fm.employeeId} driverName={fm.name} />
        </>}
      </div>
      </>}

      {/* Suppliers get an (empty for now) Certifications & Checks section too,
          so custom certs can be added here in a later step. Same collapsible
          look as drivers/employees. */}
      {fm.isSupplier && <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 14, paddingTop: 12 }}>
        <div onClick={() => setCertsOpen(o => !o)} style={{ display: "flex", alignItems: "center",
          gap: 8, cursor: "pointer", userSelect: "none", marginBottom: certsOpen ? 8 : 0,
          padding: "6px 8px", borderRadius: 6, background: certsOpen ? "transparent" : T["bg"],
          border: `1px solid ${certsOpen ? "transparent" : T.border}` }}>
          <span style={{ fontSize: 11, color: T.muted, transform: certsOpen ? "rotate(90deg)" : "none",
            transition: "transform .15s", display: "inline-block" }}>▶</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase" }}>Certifications & Checks</span>
        </div>
        {certsOpen && (() => {
          const certFields = cfForTarget(customDefs, "suppliers").certs;
          if (!certFields.length) return <div style={{ fontSize: 11, color: T.dim, padding: "8px 8px 4px" }}>
            No certifications set up for suppliers yet. Add one from Admin → Add a Field.
          </div>;
          return <CustomFieldInputs fieldDefs={certFields} fm={fm} setFm={setFm} uploading={uploading}
            onFiles={addFile} removeFile={removeFile} fileRefs={fileRefs} editing={ed}
            saveBtn={<button style={{ ...bP, padding: "5px 14px", fontSize: 10, marginTop: 8 }} disabled={saving} onClick={doSaveStay}>{saving ? "Saving..." : "Save"}</button>} />;
        })()}
      </div>}

      {/* General docs + shared docs moved into the collapsible Certifications & Checks section above */}

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
              {item.archived === true && <span style={{fontSize:9,padding:"1px 6px",borderRadius:10,background:"rgba(148,163,184,0.15)",color:"#94a3b8",border:"1px solid #94a3b8",marginRight:3,fontWeight:600}}>📦 Archived</span>}
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
                if(cfg.travelDay) parts.push("$"+parseFloat(cfg.travelDay).toFixed(0)+"/travel");
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
              const snz = (item.certSnooze || {})[c.k] || "";
              const snoozed = snz && todayIso <= snz;
              return <div key={c.k} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: ec ? ec + "18" : Tbg, color: ec || T.dim, border: `1px solid ${ec || T.border}` }}>
                {shortLabel}: {item[c.k] ? ((c.direct || c.months > 0)
                  ? <><span style={{ fontWeight: 700 }}>{el}</span> <span style={{ color: T.muted }}>({fd(expDate(item[c.k], c.months, c.direct))})</span></>
                  : <><span style={{ fontWeight: 700 }}>Done</span> <span style={{ color: T.muted }}>({fd(item[c.k])})</span></>
                ) : <span style={{ color: T.dim }}>Not set</span>}
                {snoozed && <span title={`Reminders snoozed until ${fd(snz)}`} style={{ marginLeft: 4 }}>🔕</span>}
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
          {/* Custom-field documents (view/download only on the card) */}
          {cfForTarget(customDefs, cfPersonTargets(item)).all.filter(f=>f.docs&&(item[`${f.id}Docs`]||[]).length>0).map(f=>(
            <div key={f.id} style={{ marginTop: 4 }}>
              <div style={{ fontSize: 9, color: T.muted }}>{f.label} ({(item[`${f.id}Docs`]||[]).length}):</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{(item[`${f.id}Docs`]||[]).map((a, i) => (
                <a key={i} href={a.url || a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{ padding: "2px 6px", background: T["bg"], borderRadius: 3, fontSize: 9, display: "flex", alignItems: "center", gap: 2, color: T.text, textDecoration: "none" }}><Ic n="dl" s={9} />{a.name}</a>
              ))}</div>
            </div>
          ))}

          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
            {item.archived === true ? (
              <button style={{ ...bS, padding: "6px 18px", fontSize: 11 }} onClick={async () => {
                await writeDriver(item.id, { archived: false });
              }}>♻️ Restore</button>
            ) : (
              <button style={{ ...bS, padding: "6px 18px", fontSize: 11 }} onClick={async () => {
                const ok = await cfm("Archive", `Archive ${item.name||"this person"}?\n\nThey'll be hidden from the active list and roster reports, but all their information and timesheet history is kept. You can restore them anytime from the Archived tab.`, { confirmLabel: "Archive", confirmColor: "#f59e0b" });
                if(!ok) return;
                await writeDriver(item.id, { archived: true });
              }}>📦 Archive</button>
            )}
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

// ═══ MAINTENANCE & REPAIRS ═══
// Tracks repair/maintenance records per equipment unit (maintenance collection):
// { unitId, unitType, unitLabel, date, description, cost, vendor, invoiceNum }.
// Provides a fleet spend report (time-windowed) and a per-unit repair history.
function MaintenancePage({ db: data }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);          // selected unit for drill-in
  const [win, setWin] = useState("12mo");        // 30d | 6mo | 12mo | all | custom
  const [fleetSearch, setFleetSearch] = useState("");
  const [hideEmpty, setHideEmpty] = useState(true);  // collapse units with no records
  const [collapsedGroups, setCollapsedGroups] = useState({});  // "truck"/"trailer" collapsed?
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [editRec, setEditRec] = useState(null);  // record being added/edited
  const [saving, setSaving] = useState(false);
  const { confirm: cfm, modal: cfmModal } = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "maintenance"));
      setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error("maintenance load failed:", e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // All units (trucks + trailers), non-archived, for the fleet list + picker.
  const units = [
    ...(data.trucks || []).filter(t => t.archived !== true).map(t => ({ id: t.id, type: "truck", label: t.unit || t.plate || "Truck", sub: [t.year, t.make, t.model].filter(Boolean).join(" ") })),
    ...(data.trailers || []).filter(t => t.archived !== true).map(t => ({ id: t.id, type: "trailer", label: t.unit || t.plate || "Trailer", sub: [t.year, t.make, t.model].filter(Boolean).join(" ") })),
  ];

  // Date window → cutoff (or null for all-time / custom handled separately).
  const inWindow = (dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr + "T12:00:00");
    if (win === "all") return true;
    if (win === "custom") {
      if (customFrom && d < new Date(customFrom + "T00:00:00")) return false;
      if (customTo && d > new Date(customTo + "T23:59:59")) return false;
      return true;
    }
    const days = win === "30d" ? 30 : win === "6mo" ? 182 : 365;
    return d >= new Date(Date.now() - days * 86400000);
  };

  const unitSpend = (unitId) => records.filter(r => r.unitId === unitId && inWindow(r.date)).reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
  const unitCount = (unitId) => records.filter(r => r.unitId === unitId && inWindow(r.date)).length;
  const fleetTotal = units.reduce((s, u) => s + unitSpend(u.id), 0);

  const winLabel = { "30d": "Last 30 days", "6mo": "Last 6 months", "12mo": "Last 12 months", "all": "All time", "custom": "Custom range" }[win];

  const saveRec = async () => {
    if (saving) return;
    const r = editRec;
    if (!r.date || !(parseFloat(r.cost) > 0)) { alert("Please enter at least a date and a cost."); return; }
    setSaving(true);
    try {
      const unit = units.find(u => u.id === r.unitId) || {};
      const payload = { unitId: r.unitId, unitType: unit.type || r.unitType || "", unitLabel: unit.label || r.unitLabel || "", date: r.date, description: r.description || "", cost: parseFloat(r.cost) || 0, vendor: r.vendor || "", invoiceNum: r.invoiceNum || "", updatedAt: Date.now() };
      if (r.id) { await updateDoc(doc(db, "maintenance", r.id), payload); setRecords(rs => rs.map(x => x.id === r.id ? { ...x, ...payload } : x)); }
      else { payload.createdAt = Date.now(); const ref = await addDoc(collection(db, "maintenance"), payload); setRecords(rs => [{ id: ref.id, ...payload }, ...rs]); }
      setEditRec(null);
    } catch (e) { console.error("save maintenance failed:", e); alert("Couldn't save. " + (e.code || e.message || "")); }
    setSaving(false);
  };

  const delRec = async (id) => {
    if (!(await cfm("Delete record", "Delete this maintenance record? This can't be undone.", { confirmLabel: "Delete", confirmColor: T.red }))) return;
    try { await deleteDoc(doc(db, "maintenance", id)); setRecords(rs => rs.filter(x => x.id !== id)); }
    catch (e) { console.error("delete maintenance failed:", e); }
  };

  const winButtons = <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
    {[["30d", "30 days"], ["6mo", "6 months"], ["12mo", "12 months"], ["all", "All time"], ["custom", "Custom"]].map(([k, l]) =>
      <button key={k} onClick={() => setWin(k)} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${win === k ? T.red : T.border}`, background: win === k ? "rgba(220,38,38,0.08)" : "transparent", color: win === k ? T.red : T.muted, fontSize: 11, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>{l}</button>)}
    {win === "custom" && <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ ...sIn, width: "auto", fontSize: 11, padding: "5px 8px" }} />
      <span style={{ color: T.muted, fontSize: 11 }}>to</span>
      <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ ...sIn, width: "auto", fontSize: 11, padding: "5px 8px" }} />
    </span>}
  </div>;

  // ── Add/Edit record modal ──
  const recModal = editRec && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={e => { if (e.target === e.currentTarget) setEditRec(null); }}>
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, width: 460, maxWidth: "100%" }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>{editRec.id ? "Edit" : "Add"} Maintenance Record</div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Unit</label>
        <SearchSelect
          options={units.map(u => ({ value: u.id, label: `${u.label} (${u.type})`, sub: u.sub }))}
          value={editRec.unitId || ""}
          emptyLabel="Select unit..."
          placeholder="Type unit #, make or model..."
          onChange={id => setEditRec(p => ({ ...p, unitId: id }))}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div><label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Date</label><DatePicker value={editRec.date || ""} onChange={v => setEditRec(p => ({ ...p, date: v }))} placeholder="Select date..." /></div>
        <div><label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Cost ($)</label><input type="number" step="0.01" style={sIn} value={editRec.cost || ""} onChange={e => setEditRec(p => ({ ...p, cost: e.target.value }))} placeholder="0.00" /></div>
      </div>
      <div style={{ marginBottom: 10 }}><label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Description</label><input style={sIn} value={editRec.description || ""} onChange={e => setEditRec(p => ({ ...p, description: e.target.value }))} placeholder="e.g. Brake job, oil change, tire replacement" /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div><label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Vendor</label><input style={sIn} value={editRec.vendor || ""} onChange={e => setEditRec(p => ({ ...p, vendor: e.target.value }))} placeholder="Shop / supplier" /></div>
        <div><label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 4 }}>Invoice #</label><input style={sIn} value={editRec.invoiceNum || ""} onChange={e => setEditRec(p => ({ ...p, invoiceNum: e.target.value }))} placeholder="Invoice number" /></div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={{ ...sBtn, background: T.red }} disabled={saving} onClick={saveRec}>{saving ? "Saving…" : "Save Record"}</button>
        <button style={{ ...sBtn, background: T.surface, color: T.muted }} onClick={() => setEditRec(null)}>Cancel</button>
      </div>
    </div>
  </div>;

  // ── Per-unit drill-in view ──
  if (sel) {
    const unit = units.find(u => u.id === sel) || {};
    const unitRecs = records.filter(r => r.unitId === sel).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const shown = unitRecs.filter(r => inWindow(r.date));
    const total = shown.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
    return <div>
      {cfmModal}{recModal}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button style={{ ...sBtn, background: T.surface, color: T.muted }} onClick={() => setSel(null)}>← Fleet</button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{unit.label} <span style={{ fontSize: 12, color: T.muted, fontWeight: 400 }}>({unit.type}){unit.sub ? ` · ${unit.sub}` : ""}</span></div>
        <button style={{ ...sBtn, background: T.red, marginLeft: "auto" }} onClick={() => setEditRec({ unitId: sel, date: new Date().toLocaleDateString("en-CA") })}>+ Add Record</button>
      </div>
      {winButtons}
      <div style={{ background: "rgba(220,38,38,0.06)", border: `1px solid ${T.red}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{winLabel} — Total Spend</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.red }}>${total.toFixed(2)}</div>
        <div style={{ fontSize: 12, color: T.muted }}>{shown.length} record{shown.length !== 1 ? "s" : ""}</div>
      </div>
      {shown.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 13 }}>No maintenance records in this window.</div>
        : shown.map(r => <div key={r.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{r.description || "(no description)"}</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{fd(r.date)}{r.vendor ? ` · ${r.vendor}` : ""}{r.invoiceNum ? ` · Inv# ${r.invoiceNum}` : ""}</div>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>${(parseFloat(r.cost) || 0).toFixed(2)}</div>
          <button style={{ ...sBtn, background: T.surface, color: T.muted, padding: "6px 10px" }} onClick={() => setEditRec(r)}>Edit</button>
          <button style={{ ...sBtn, background: "transparent", color: T.red, padding: "6px 10px" }} onClick={() => delRec(r.id)}>✕</button>
        </div>)}
    </div>;
  }

  // ── Fleet report view ──
  const ranked = units.map(u => ({ ...u, spend: unitSpend(u.id), count: unitCount(u.id) })).sort((a, b) => b.spend - a.spend);
  // Search: match on unit label/make/model, OR on any of the unit's records
  // (invoice #, vendor, description) — so searching an invoice/vendor finds its unit.
  const fq = fleetSearch.trim().toLowerCase();
  const unitMatchesSearch = (u) => {
    if (!fq) return true;
    if (`${u.label} ${u.sub || ""} ${u.type}`.toLowerCase().includes(fq)) return true;
    return records.some(r => r.unitId === u.id && [r.invoiceNum, r.vendor, r.description].some(v => String(v || "").toLowerCase().includes(fq)));
  };
  const visible = ranked.filter(u => unitMatchesSearch(u) && (!hideEmpty || u.count > 0 || fq));
  return <div>
    {cfmModal}{recModal}
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>Fleet Maintenance</div>
      <button style={{ ...sBtn, background: T.red, marginLeft: "auto" }} onClick={() => setEditRec({ unitId: "", date: new Date().toLocaleDateString("en-CA") })}>+ Add Record</button>
    </div>
    {winButtons}
    <div style={{ background: "rgba(220,38,38,0.06)", border: `1px solid ${T.red}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{winLabel} — Total Fleet Spend</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: T.red }}>${fleetTotal.toFixed(2)}</div>
    </div>
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
      <input value={fleetSearch} onChange={e => setFleetSearch(e.target.value)} placeholder="Search unit #, invoice #, vendor, or description..." style={{ ...sIn, flex: 1, minWidth: 220 }} />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.muted, cursor: "pointer", whiteSpace: "nowrap" }}>
        <input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} style={{ accentColor: T.red, width: 15, height: 15 }} />
        Hide units with no records
      </label>
    </div>
    {loading ? <div style={{ padding: 20, color: T.muted, fontSize: 13 }}>Loading…</div>
      : <div>
        {visible.length === 0 && <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 13 }}>{fq ? "No units match your search." : "No maintenance spend recorded in this window. Click \"+ Add Record\" to log a repair."}</div>}
        {[["trailer", "Trailers"], ["truck", "Trucks"]].map(([typeKey, typeLabel]) => {
          const grp = visible.filter(u => u.type === typeKey);
          if (grp.length === 0) return null;
          const grpTotal = grp.reduce((s, u) => s + u.spend, 0);
          const isCollapsed = !!collapsedGroups[typeKey];
          return <div key={typeKey} style={{ marginBottom: 14 }}>
            <button onClick={() => setCollapsedGroups(c => ({ ...c, [typeKey]: !c[typeKey] }))} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer", fontFamily: "inherit", marginBottom: isCollapsed ? 0 : 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text, textTransform: "uppercase", letterSpacing: "0.05em" }}>{typeLabel} <span style={{ color: T.muted, fontWeight: 400 }}>({grp.length})</span></span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: grpTotal > 0 ? T.red : T.dim }}>${grpTotal.toFixed(2)}</span>
                <span style={{ color: T.muted }}>{isCollapsed ? "▼" : "▲"}</span>
              </span>
            </button>
            {!isCollapsed && grp.map(u => <button key={u.id} onClick={() => setSel(u.id)} style={{ width: "100%", textAlign: "left", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 8, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{u.label} <span style={{ fontSize: 11, color: T.muted, fontWeight: 400 }}>({u.type})</span></div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{u.sub || "—"} · {u.count} record{u.count !== 1 ? "s" : ""}</div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: u.spend > 0 ? T.red : T.dim }}>${u.spend.toFixed(2)}</div>
            </button>)}
          </div>;
        })}
      </div>}
  </div>;
}

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

// ─── EXPIRATIONS TAB ─────────────────────────────────────────────────────────
// Consolidated read-only view of everything with an expiry date: personnel
// certs (from drivers), truck & trailer safety, and custom expiry fields.
// Groups by type, defaults to expired + within-30-days, filterable to wider
// windows, and prints to PDF via the same window.print() pattern used by the
// BOL / roster / revenue reports. No emails, no mute logic — pure pull.
function ExpirationsTab({ db }) {
  const certs = useCerts();
  const customDefs = useCustomFields();
  const [windowDays, setWindowDays] = useState(30); // "expiring soon" horizon
  const [view, setView] = useState("due");          // "due" = expired+soon, "all", "expired"
  const [grp, setGrp] = useState("all");             // "people" | "equipment" | "all"
  const [sortKey, setSortKey] = useState("days");    // "unit" | "item" | "days" | "overdue"
  const [sortDir, setSortDir] = useState("asc");     // "asc" | "desc"
  const toggleSort = (key, defaultDir = "asc") => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(defaultDir); }
  };

  // Self-contained expiry math (mirrors DriversPage's resolveExp/expLabel so the
  // numbers always agree with the yellow alert boxes, without depending on that
  // component's internals).
  const resolveExp = (dateStr, months, direct) => {
    if (!dateStr) return null;
    let d;
    if (direct) {
      d = new Date(dateStr + "T12:00:00");
    } else {
      if (!months) return null; // months 0 / undefined → no expiry (e.g. "completed" certs)
      d = new Date(dateStr + "T12:00:00");
      if (!isNaN(d)) d.setMonth(d.getMonth() + Number(months));
    }
    return isNaN(d) ? null : d; // guard malformed date strings → treat as no date, never crash
  };
  const daysLeft = exp => (exp && !isNaN(exp)) ? Math.floor((exp - new Date()) / 864e5) : null;
  const statusOf = dl => dl == null ? null : dl < 0 ? "expired" : dl <= windowDays ? "soon" : "valid";

  // Build a flat list of { group, unit, item, expStr, days, status } rows.
  const rows = [];
  const pushRow = (group, unit, item, exp) => {
    const dl = daysLeft(exp);
    const st = statusOf(dl);
    if (!st) return;                       // no expiry date (or unparseable) → skip
    if (view === "expired" && st !== "expired") return; // expired-only view
    if (view === "due" && st === "valid") return; // hide valid unless "all"
    rows.push({
      group, unit, item,
      expStr: (exp && !isNaN(exp)) ? fd(exp.toISOString().slice(0, 10)) : "—",
      days: dl,
      status: st,
    });
  };

  // Personnel certifications (built-in + custom expiry fields on people).
  (db.drivers || []).filter(p => !p.archived).forEach(p => {
    const who = p.name || "(unnamed)";
    certs.forEach(c => pushRow("Personnel", who, c.l, resolveExp(p[c.k], c.months, c.direct)));
    cfForTarget(customDefs, cfPersonTargets(p)).certs.forEach(f => {
      const v = p[f.id];
      if (!v) return;
      const exp = f.certMode === "window"
        ? resolveExp(v, f.months || 12, false)
        : new Date(v + "T12:00:00");
      pushRow("Personnel", who, f.label, exp);
    });
  });

  // Truck & trailer safety (+ any custom expiry fields on equipment).
  [["trucks", "Trucks"], ["trailers", "Trailers"]].forEach(([col, label]) => {
    (db[col] || []).filter(u => !u.archived).forEach(u => {
      const unit = u.unit || u.plate || "(no unit #)";
      pushRow(label, unit, "Safety Inspection", u.safetyExp ? new Date(u.safetyExp + "T12:00:00") : null);
      cfForTarget(customDefs, col).certs.forEach(f => {
        const v = u[f.id];
        if (!v) return;
        const exp = f.certMode === "window"
          ? resolveExp(v, f.months || 12, false)
          : new Date(v + "T12:00:00");
        pushRow(label, unit, f.label, exp);
      });
    });
  });

  // Sort each group by the chosen order.
  // Column-driven sort. "days" ascending = soonest first; "overdue" = longest-expired first.
  const dirMul = sortDir === "asc" ? 1 : -1;
  const baseCmp = {
    unit: (a, b) => a.unit.localeCompare(b.unit),
    item: (a, b) => (a.item || "").localeCompare(b.item || "") || a.unit.localeCompare(b.unit),
    days: (a, b) => (a.days ?? 1e9) - (b.days ?? 1e9),
    overdue: (a, b) => (a.days ?? 1e9) - (b.days ?? 1e9), // ascending = most-negative (longest expired) first
  }[sortKey] || ((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  rows.sort((a, b) => dirMul * baseCmp(a, b));

  // People / Equipment / All switch decides which sections show.
  const groupsFor = grp === "people" ? ["Personnel"]
    : grp === "equipment" ? ["Trucks", "Trailers"]
    : ["Personnel", "Trucks", "Trailers"];
  const byGroup = groupsFor.map(g => [g, rows.filter(r => r.group === g)]).filter(([, r]) => r.length);
  const expiredCount = rows.filter(r => r.status === "expired" && groupsFor.includes(r.group)).length;
  const soonCount = rows.filter(r => r.status === "soon" && groupsFor.includes(r.group)).length;

  const stColor = s => s === "expired" ? "#ef4444" : s === "soon" ? "#eab308" : "#22c55e";
  const stLabel = r => r.status === "expired"
    ? `EXPIRED ${Math.abs(r.days)}d ago`
    : r.days === 0 ? "Expires today" : `${r.days}d left`;

  // Print-to-PDF: open a clean HTML window and invoke the browser print dialog,
  // exactly like the roster/revenue reports elsewhere in this file.
  const printReport = () => {
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const grpLbl = grp === "people" ? "People" : grp === "equipment" ? "Equipment" : "People + Equipment";
    const scopeLbl = (view === "expired"
      ? "Expired items only"
      : view === "due"
      ? `Expired + expiring within ${windowDays} days`
      : "All tracked items") + " · " + grpLbl;
    const sections = byGroup.map(([g, rs]) => `
      <h2 style="font-size:14px;margin:18px 0 6px;color:#dc2626">${g} (${rs.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f1f5f9"><th style="text-align:left;border:1px solid #cbd5e1;padding:5px">Unit / Name</th><th style="text-align:left;border:1px solid #cbd5e1;padding:5px">Item</th><th style="text-align:left;border:1px solid #cbd5e1;padding:5px">Expires</th><th style="text-align:left;border:1px solid #cbd5e1;padding:5px">Status</th></tr>
        ${rs.map(r => `<tr>
          <td style="border:1px solid #cbd5e1;padding:5px"><b>${r.unit}</b></td>
          <td style="border:1px solid #cbd5e1;padding:5px">${r.item}</td>
          <td style="border:1px solid #cbd5e1;padding:5px">${r.expStr}</td>
          <td style="border:1px solid #cbd5e1;padding:5px;color:${stColor(r.status)};font-weight:700">${stLabel(r)}</td>
        </tr>`).join("")}
      </table>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>DBX Expirations — ${today}</title>
      <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#0f172a}
      h1{font-size:18px;margin:0 0 2px}.sub{color:#64748b;font-size:12px;margin-bottom:4px}
      @media print{.no-print{display:none!important}}@page{margin:14mm}</style></head><body>
      <h1>⚠️ DBX — Certification &amp; Safety Expirations</h1>
      <div class="sub">${scopeLbl} · ${expiredCount} expired, ${soonCount} expiring soon · Generated ${today}</div>
      ${sections || '<p style="color:#64748b">Nothing in this window.</p>'}
      <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%)">
        <button onclick="window.print()" style="padding:10px 24px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">🖨 Print / Save as PDF</button>
      </div></body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
    else alert("Please allow pop-ups to generate the report.");
  };

  const chip = (active, label, onClick) => (
    <button onClick={onClick} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${active ? T.red : T.border}`, background: active ? "rgba(220,38,38,0.08)" : "transparent", color: active ? T.red : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {chip(view === "expired", "Expired only", () => setView("expired"))}
          {chip(view === "due", "Expired + soon", () => setView("due"))}
          {chip(view === "all", "All", () => setView("all"))}
        </div>
        {view === "due" && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Window</span>
          {[30, 60, 90].map(d => chip(windowDays === d, `${d}d`, () => setWindowDays(d)))}
        </div>}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Show</span>
          {chip(grp === "people", "People", () => setGrp("people"))}
          {chip(grp === "equipment", "Equipment", () => setGrp("equipment"))}
          {chip(grp === "all", "All", () => setGrp("all"))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={printReport} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: T.red, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Generate PDF Report</button>
      </div>

      <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>
        <span style={{ color: "#ef4444", fontWeight: 700 }}>{expiredCount} expired</span>
        {" · "}
        <span style={{ color: "#eab308", fontWeight: 700 }}>{soonCount} expiring soon</span>
      </div>

      {byGroup.length === 0 && <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 13 }}>Nothing to show in this window.</div>}

      {byGroup.map(([g, rs]) => {
        const arrow = key => sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕";
        const hCell = (label, key, extra, defaultDir) => (
          <div onClick={() => toggleSort(key, defaultDir)} style={{ ...extra, cursor: "pointer", color: sortKey === key ? T.text : T.muted, fontWeight: 700, fontSize: 10, textTransform: "uppercase", userSelect: "none" }}>{label}{arrow(key)}</div>
        );
        return (
          <div key={g} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>{g} <span style={{ color: T.muted, fontWeight: 400 }}>({rs.length})</span></div>
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
              {/* sortable header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderBottom: `1px solid ${T.border}`, background: T.hover }}>
                {hCell("Name", "unit", { minWidth: 120 })}
                {hCell("Item", "item", { flex: 1 })}
                {hCell("Expires", "days", { minWidth: 110 }, "asc")}
                {hCell("Status", "overdue", { minWidth: 120, textAlign: "right" }, "asc")}
              </div>
              {rs.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i ? `1px solid ${T.border}` : "none", fontSize: 12 }}>
                  <div style={{ fontWeight: 700, minWidth: 120, color: T.text }}>{r.unit}</div>
                  <div style={{ flex: 1, color: T.muted }}>{r.item}</div>
                  <div style={{ color: T.muted, minWidth: 110 }}>{r.expStr}</div>
                  <div style={{ color: stColor(r.status), fontWeight: 700, minWidth: 120, textAlign: "right" }}>{stLabel(r)}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EquipPage({db, saveColl}) {
  const [tab, setTab] = useState("trucks");
  return <div style={{padding:20}}>
    <h1 style={{fontSize:18,fontWeight:700,margin:0,marginBottom:12}}>Equipment</h1>
    <div style={{display:"flex",gap:6,marginBottom:12}}>{["trucks","trailers","maintenance","history"].map(t=><button key={t} onClick={()=>setTab(t)} style={{padding:"6px 12px",borderRadius:6,background:tab===t?T.border:"transparent",border:`1px solid ${tab===t?"#334155":T.border}`,color:tab===t?T.text:T.muted,fontSize:12,cursor:"pointer",textTransform:"capitalize",fontFamily:"inherit"}}>{t==="history"?"Vehicle History":t==="maintenance"?"Maintenance & Repairs":t}</button>)}</div>
    {tab==="trucks" && <EquipList title="Trucks" items={db.trucks} col="trucks" fields={[{k:"unit",l:"Unit #"},{k:"plate",l:"Plate #"},{k:"year",l:"Year",tp:"number"},{k:"make",l:"Make"},{k:"model",l:"Model"},{k:"type",l:"Type"},{k:"vin",l:"VIN"},{k:"safetyExp",l:"Safety Expiration",tp:"date"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} saveColl={saveColl}/>}
    {tab==="trailers" && <EquipList title="Trailers" items={db.trailers} col="trailers" fields={[{k:"unit",l:"Unit #"},{k:"plate",l:"Plate #"},{k:"year",l:"Year",tp:"number"},{k:"make",l:"Make"},{k:"model",l:"Model"},{k:"type",l:"Type"},{k:"vin",l:"VIN"},{k:"safetyExp",l:"Safety Expiration",tp:"date"},{k:"notes",l:"Internal Notes",tp:"textarea"}]} saveColl={saveColl}/>}
    {tab==="maintenance" && <MaintenancePage db={db}/>}
    {tab==="history" && <VehicleHistory/>}
  </div>;
}

function EquipList({title, items, col, fields, saveColl}) {
  const [ed,setEd] = useState(null);
  const [fmData,setFmData] = useState({});
  const [saving,setSaving] = useState(false);
  const [uploading,setUploading] = useState(false);
  const [srch, setSrch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const { confirm: cfm, modal: cfmModal } = useConfirm();
  const fileRef = useRef();
  const formRef = useRef(null);
  const customDefs = useCustomFields();
  // col is "trucks" or "trailers" — the custom-field target key matches.
  const cfGroup = cfForTarget(customDefs, col);
  const layout = useFieldLayout();
  const sections = useSections();
  const [equipCertsOpen, setEquipCertsOpen] = useState(false);
  // Dynamic refs for custom-field doc uploads, same Proxy trick as DriversPage.
  const cfRefStore = useRef({});
  const cfFileRefs = useMemo(() => new Proxy({}, { get(_t, k) {
    if (typeof k === "string" && k.endsWith("Docs")) {
      if (!cfRefStore.current[k]) cfRefStore.current[k] = { current: null };
      return cfRefStore.current[k];
    }
    return undefined;
  }}), []);

  // Upload/remove for a custom-field doc key on the equipment form.
  const addCfFile = async (files, docKey) => {
    setUploading(true);
    try {
      const nd = [...(fmData[docKey] || [])];
      for (const file of Array.from(files)) nd.push(await uploadFile(file, `equipment/${col}`));
      setFmData(p => ({ ...p, [docKey]: nd }));
    } catch (e) { console.error(e); alert("Upload failed"); }
    setUploading(false);
  };
  const removeCfFile = async (docKey, idx) => {
    const d = fmData[docKey]?.[idx];
    if (d?.path) { try { await deleteObject(storageRef(storage, d.path)); } catch {} }
    setFmData(p => ({ ...p, [docKey]: (p[docKey] || []).filter((_, j) => j !== idx) }));
  };

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
    <div style={{display:"flex",gap:6,marginBottom:10}}>
      {[{k:false,l:"Active"},{k:true,l:"Archived"}].map(f=><button key={String(f.k)} onClick={()=>setShowArchived(f.k)} style={{padding:"4px 12px",borderRadius:5,border:`1px solid ${showArchived===f.k?T.red:T.border}`,background:showArchived===f.k?"rgba(220,38,38,0.08)":"transparent",color:showArchived===f.k?T.red:T.muted,fontSize:10,cursor:"pointer",fontWeight:500,fontFamily:"inherit"}}>{f.l}</button>)}
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
      <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>General Profile</div>
      {fields.filter(f => !fieldHidden(layout, f.k)).map(f=><Field key={f.k} l={fieldLabel(layout, f.k) !== f.k ? fieldLabel(layout, f.k) : f.l}>{
        f.tp==="textarea"
          ? <textarea style={{...sIn,minHeight:60,resize:"vertical"}} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>
          : f.tp==="date"
            ? <DatePicker value={fmData[f.k]||""} onChange={v=>setFmData(p=>({...p,[f.k]:v}))} placeholder="Select date..."/>
            : <input style={sIn} type={f.tp||"text"} value={fmData[f.k]||""} onChange={e=>setFmData(p=>({...p,[f.k]:e.target.value}))}/>
      }</Field>)}
      {cfGroup.general.length > 0 && groupBySection(cfGroup.general, sections, col).map(g => {
        const loose = g.id === "__loose";
        const inputs = <CustomFieldInputs fieldDefs={g.fields} fm={fmData} setFm={setFmData} uploading={uploading}
          onFiles={addCfFile} removeFile={removeCfFile} fileRefs={cfFileRefs} editing={ed} plain />;
        if (loose) return <div key={g.id}>{inputs}</div>;
        return (
          <div key={g.id} style={{ borderTop:`1px solid ${T.border}`, marginTop:8, paddingTop:10, marginBottom:4 }}>
            <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", marginBottom:8 }}>{g.label}</div>
            {inputs}
          </div>
        );
      })}
      {/* Empty-for-now Certifications & Checks section — same collapsible look
          as people; custom equipment certs will render here in a later step. */}
      <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 14, paddingTop: 12 }}>
        <div onClick={() => setEquipCertsOpen(o => !o)} style={{ display: "flex", alignItems: "center",
          gap: 8, cursor: "pointer", userSelect: "none", marginBottom: equipCertsOpen ? 8 : 0,
          padding: "6px 8px", borderRadius: 6, background: equipCertsOpen ? "transparent" : T["bg"],
          border: `1px solid ${equipCertsOpen ? "transparent" : T.border}` }}>
          <span style={{ fontSize: 11, color: T.muted, transform: equipCertsOpen ? "rotate(90deg)" : "none",
            transition: "transform .15s", display: "inline-block" }}>▶</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase" }}>Certifications & Checks</span>
        </div>
        {equipCertsOpen && (() => {
          const certFields = cfGroup.certs;
          if (!certFields.length) return <div style={{ fontSize: 11, color: T.dim, padding: "8px 8px 4px" }}>
            No certifications set up for equipment yet. Add one from Admin → Add a Field.
          </div>;
          return <CustomFieldInputs fieldDefs={certFields} fm={fmData} setFm={setFmData} uploading={uploading}
            onFiles={addCfFile} removeFile={removeCfFile} fileRefs={cfFileRefs} editing={ed} />;
        })()}
      </div>
      <div style={{marginTop:8}}>
        <DropZone label="Documents" uploading={uploading} docKey="docs" fileRef={fileRef} onFiles={addFiles} />
        {(fmData.docs||[]).length>0 &&
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>{fmData.docs.map((a,i)=><div key={i} style={{padding:"3px 8px",background:T["bg"],borderRadius:4,fontSize:10,display:"flex",alignItems:"center",gap:3}}><a href={a.url||a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{color:T.text,textDecoration:"none",display:"flex",alignItems:"center",gap:3}}><Ic n="dl" s={10}/>{a.name}</a><button onClick={()=>removeDoc(i)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:11}}>×</button></div>)}</div>}
      </div>
      <div style={{display:"flex",gap:8,marginTop:10}}><button style={bP} disabled={saving} onClick={doSave}>{saving?"Saving...":"Save"}</button><button style={bS} onClick={()=>setEd(null)}>Cancel</button></div>
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10,maxWidth:600}}>
      {items.filter(item => {
        if ((item.archived===true) !== showArchived) return false;
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
          {/* Custom-field documents (e.g. a custom "Safety certificate" cert field) */}
          {cfGroup.all.filter(f=>f.docs&&(item[`${f.id}Docs`]||[]).length>0).map(f=>(
            <div key={f.id} style={{marginTop:4}}>
              <div style={{fontSize:9,color:T.muted,marginBottom:2}}>{f.label} ({(item[`${f.id}Docs`]||[]).length}):</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:3}}>{(item[`${f.id}Docs`]||[]).map((a,i)=><a key={i} href={a.url||a.data} download={a.name} target="_blank" rel="noopener noreferrer" style={{padding:"2px 6px",background:T["bg"],borderRadius:3,fontSize:9,display:"flex",alignItems:"center",gap:2,color:T.text,textDecoration:"none"}}><Ic n="dl" s={9}/>{a.name}</a>)}</div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button style={{...bS,padding:"6px 14px",fontSize:11}} onClick={()=>startEdit(item)}>Edit</button>
              {item.archived===true ? (
                <button style={{...bS,padding:"6px 14px",fontSize:11}} onClick={async()=>{setSaving(true);try{await saveColl(col,items.map(x=>x.id===item.id?{...x,archived:false}:x))}catch{}setSaving(false)}}>♻️ Restore</button>
              ) : (
                <button style={{...bS,padding:"6px 14px",fontSize:11}} onClick={async()=>{const ok=await cfm("Archive",`Archive unit ${item.unit||"this unit"}?\n\nIt'll be hidden from the active list, equipment reports, and assignment dropdowns, but all its info and history is kept. You can restore it anytime from the Archived tab.`,{confirmLabel:"Archive",confirmColor:"#f59e0b"});if(ok){setSaving(true);try{await saveColl(col,items.map(x=>x.id===item.id?{...x,archived:true}:x))}catch{}setSaving(false)}}}>📦 Archive</button>
              )}
            </div>
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

// RPT_CERTS mirrors CERT_DEFAULTS but without docKey (reports don't need it).
// It is kept live by a module-level subscription to settings/certConfig, so
// renames and mode/window changes flow into every report the moment they save.
// Report functions read this at call time (reports run on a button click, well
// after the first snapshot), so a plain mutable module variable is correct here.
let RPT_CERTS = mergeCerts(null).map(c => ({ k: c.k, l: c.l, months: c.months, direct: c.direct }));
try {
  onSnapshot(doc(db, "settings", "certConfig"),
    snap => { RPT_CERTS = mergeCerts(snap.exists() ? snap.data() : { certs: {} })
                .map(c => ({ k: c.k, l: c.l, months: c.months, direct: c.direct })); },
    err => { console.warn("certConfig (reports) load failed:", err); });
} catch (e) { console.warn("certConfig subscription skipped:", e); }

// Live default Terms & Conditions — authored in AdminPage (settings/orderTerms),
// falls back to the built-in DEFAULT_TERMS until an admin saves a custom value.
// Forms and PDFs read termsOrDefault(o.terms) so what admins set here is used.
let ORDER_TERMS_LIVE = DEFAULT_TERMS;
try {
  onSnapshot(doc(db, "settings", "orderTerms"),
    snap => { const t = snap.exists() ? snap.data().text : undefined; ORDER_TERMS_LIVE = (t!==undefined && t!==null) ? t : DEFAULT_TERMS; },
    err => { console.warn("orderTerms load failed:", err); });
} catch (e) { console.warn("orderTerms subscription skipped:", e); }
// Use the record's own saved terms if present, else the live admin default.
function termsOrDefault(t) { return (t !== undefined && t !== null) ? t : ORDER_TERMS_LIVE; }

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
  if (cfg.travelDay) parts.push(`Traveling Day: $${cfg.travelDay}`);
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
    [rptFieldLabel("name"), p.name || ""],
    ["Role", rptRole(p)],
    [rptFieldLabel("phone"), p.phone || ""],
    [rptFieldLabel("email"), p.email || ""],
  ];
  if (p.isSupplier) {
    if (!rptFieldHidden("contactPerson")) rows.push([rptFieldLabel("contactPerson"), p.contactPerson || ""]);
    if (!rptFieldHidden("serviceType")) rows.push([rptFieldLabel("serviceType"), p.serviceType || ""]);
  } else {
    if (!rptFieldHidden("license")) rows.push([rptFieldLabel("license"), p.license || ""]);
    rows.push(["Employee ID", p.employeeId || ""]);
    rows.push(["PIN", p.pin || ""]);
  }
  if (!rptFieldHidden("address")) rows.push([rptFieldLabel("address"), rptAddr(p)]);
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
  const rows = [];
  const add = (key, defLabel, val) => { if (!rptFieldHidden(key)) rows.push([rptFieldLabel(key) || defLabel, val]); };
  add("unit", "Unit #", u.unit || "");
  add("plate", "Plate #", u.plate || "");
  add("year", "Year", u.year != null ? String(u.year) : "");
  add("make", "Make", u.make || "");
  add("model", "Model", u.model || "");
  add("type", "Type", u.type || "");
  add("vin", "VIN", u.vin || "");
  add("safetyExp", "Safety Expiration", u.safetyExp ? `${fd(u.safetyExp)} — ${st.txt}` : "");
  add("notes", "Internal Notes", u.notes || "");
  rows.push(["Documents on File", String((u.docs || []).length)]);
  return rows;
}

// ─── Flat columns for multi-record (summary) reports ───
// Built live so equipment field renames/hides from Admin are reflected. Called
// at report time. Safety Status is derived (not a stored field) so it follows
// the Safety Expiration label/hide. Unit # is protected (never hidden).
function rptUnitCols() {
  const all = [
    ["unit",      rptFieldLabel("unit"),      u => u.unit || ""],
    ["plate",     rptFieldLabel("plate"),     u => u.plate || ""],
    ["year",      rptFieldLabel("year"),      u => u.year != null ? String(u.year) : ""],
    ["make",      rptFieldLabel("make"),      u => u.make || ""],
    ["model",     rptFieldLabel("model"),     u => u.model || ""],
    ["type",      rptFieldLabel("type"),      u => u.type || ""],
    ["vin",       rptFieldLabel("vin"),       u => u.vin || ""],
    ["safetyExp", rptFieldLabel("safetyExp") === "Safety Expiration" ? "Safety Exp" : rptFieldLabel("safetyExp"), u => u.safetyExp ? fd(u.safetyExp) : ""],
    ["safetyExp", `${rptFieldLabel("safetyExp") === "Safety Expiration" ? "Safety" : rptFieldLabel("safetyExp")} Status`, u => u.safetyExp ? rptStatus(u.safetyExp, 0, true).txt : "Not set"],
    ["notes",     rptFieldLabel("notes"),     u => u.notes || ""],
  ];
  return all.filter(c => !rptFieldHidden(c[0])).map(c => [c[1], c[2]]);
}

// Column pieces, assembled per category by rptPersonCols() below. Labels are
// live-resolved so Admin renames flow into reports; Name/Phone/Email are
// protected (never hidden). Each is a getter returning a [label, fn] tuple.
const RPT_COL_NAME    = () => [rptFieldLabel("name"), p => p.name || ""];
const RPT_COL_ROLE    = () => ["Role", p => rptRole(p)];
const RPT_COL_PHONE   = () => [rptFieldLabel("phone"), p => p.phone || ""];
const RPT_COL_EMAIL   = () => [rptFieldLabel("email"), p => p.email || ""];
const RPT_COL_ADDRESS = () => [rptFieldLabel("address"), p => rptAddr(p)];
const RPT_COL_DOCS    = () => ["Docs", p => String(["acrDocs","hazmatDocs","crimDocs","bgDocs","conductDocs","licenseDocs","docs"].reduce((s,k)=>s+(p[k]||[]).length,0))];

// Supplier-only fields (hideable via layout).
const RPT_SUPPLIER_COLS = () => [
  ...(!rptFieldHidden("contactPerson") ? [[rptFieldLabel("contactPerson"), p => p.contactPerson || ""]] : []),
  ...(!rptFieldHidden("serviceType") ? [[rptFieldLabel("serviceType"), p => p.serviceType || ""]] : []),
];

// Driver/employee-only fields
// Employee ID and PIN deliberately excluded — Manuel looks those up in dispatch,
// and they consumed width the phone/email columns needed.
const RPT_STAFF_COLS = () => [
  ...(!rptFieldHidden("license") ? [[rptFieldLabel("license"), p => p.license || ""]] : []),
  ["Pay Configuration", p => rptFmtPay(p.payCfg)],
];

// Built live from the current RPT_CERTS so renames/mode changes are reflected.
// Called at report time, not captured at module load.
function rptCertCols() {
  return RPT_CERTS.map(c => [c.l, p => {
    const exp = rptExpDate(p[c.k], c.months, c.direct);
    const st = rptStatus(p[c.k], c.months, c.direct);
    return exp ? `${fd(exp)} (${st.txt})` : st.txt;
  }]);
}

// Portal/alert status — shown only in the per-record detail layout, not in the
// wide table reports (dropped there to keep the printed table within the page).
const RPT_PORTAL_COLS = [
  ["Expiry Alerts", p => p.alertsMuted
    ? `PAUSED${p.alertsMutedUntil ? ` until ${fd(p.alertsMutedUntil)}` : ""}${p.alertsMutedReason ? ` — ${p.alertsMutedReason}` : ""}`
    : "Active"],
  ["Portal Daily Log", p => p.logRestricted ? "Restricted" : (p.driverLog ? "Driver log" : "Full")],
];

// Build the column set for a category. Suppliers have no certifications, PIN,
// licence or pay config; drivers/employees have no contact person or service
// type. Dropping the inapplicable ones keeps the table narrow enough to fit
// the printed page — 21 fixed columns overflow landscape Letter regardless of
// margin, which is what was cutting off the last column.
function rptPersonCols(cat, records) {
  let cols;
  // Role is omitted — the report title already says Drivers / Employees /
  // Suppliers. It is kept for the "all" category, where the mix matters.
  if (cat === "suppliers") {
    cols = [RPT_COL_NAME(), RPT_COL_PHONE(), RPT_COL_EMAIL(),
            ...RPT_SUPPLIER_COLS(), RPT_COL_ADDRESS()];
  } else if (cat === "all") {
    cols = [RPT_COL_NAME(), RPT_COL_ROLE(), RPT_COL_PHONE(), RPT_COL_EMAIL(),
            ...RPT_STAFF_COLS(), RPT_COL_ADDRESS(), ...rptCertCols()];
    if ((records || []).some(p => p.isSupplier)) {
      cols.splice(4, 0, ...RPT_SUPPLIER_COLS());
    }
  } else {
    cols = [RPT_COL_NAME(), RPT_COL_PHONE(), RPT_COL_EMAIL(),
            ...RPT_STAFF_COLS(), RPT_COL_ADDRESS(), ...rptCertCols()];
  }
  return rptDropEmptyCols(cols, records);
}

// Remove columns that are blank for every record in the report. Empty columns
// still consume width under table-layout:fixed, which is what forced phone
// numbers and emails to wrap. Name and Role are always kept — matched by the
// current (possibly renamed) Name label plus "Role".
function rptDropEmptyCols(cols, records) {
  const keepLabels = new Set([rptFieldLabel("name"), "Role"]);
  const list = records || [];
  if (!list.length) return cols;
  return cols.filter(c => {
    if (keepLabels.has(c[0])) return true;
    return list.some(r => {
      const v = c[1](r);
      // Cert columns render "Not set" when absent — treat that as empty too.
      return v && String(v).trim() !== "" && String(v).trim() !== "Not set";
    });
  });
}

// Kept for the per-record detail layout, which lists every field vertically.
// (Currently unused — the detail layout builds from rptPersonRows — but kept
// valid so it doesn't reference the removed RPT_CERT_COLS constant.)
function rptPersonCols_detail() {
  return [
    RPT_COL_NAME(), RPT_COL_ROLE(), RPT_COL_PHONE(), RPT_COL_EMAIL(),
    ...RPT_STAFF_COLS(), ...RPT_SUPPLIER_COLS(), RPT_COL_ADDRESS(),
    ...rptCertCols(), ...RPT_PORTAL_COLS, RPT_COL_DOCS(),
  ];
}

// ─── PDF (print window) ───
const rptEsc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// standaloneHeader=true renders the DBX band once at the top of the document
// (used by the per-record detail layout). For table reports it is false and the
// band is embedded in <thead> instead, so it repeats on every page.
function rptOpenPdf(title, bodyHtml, standaloneHeader = true, countLabel = "") {
  const w = window.open("", "_blank");
  if (!w) { alert("Please allow popups to view the PDF."); return; }
  const stamp = new Date().toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"});
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${rptEsc(title)}</title>
  <style>
    /* Generous top margin so the repeated header row (logo band + column
       headers) always has room at the top of continuation pages — without it
       the 54px logo is clipped by the page edge. */
    @page { size: landscape; margin: 14mm 14mm 10mm; }
    @media print {
      body { margin:0; padding:0 }
      .no-print { display:none !important }
      .rec { page-break-inside: avoid }
      /* The DBX band and the column headers both live inside <thead>, so the
         browser repeats them on every page AND reserves their height on every
         page. A fixed-position header can't do the latter — padding only
         applies once, which left continuation pages clipped. */
      thead { display: table-header-group; }
      /* break-inside is the modern property — page-break-inside alone is
         ignored on table rows in current Chrome, which let the last row on a
         page get sliced in half instead of moving whole to the next page. */
      tbody tr { page-break-inside: avoid; break-inside: avoid; }
      tbody td { page-break-inside: avoid; break-inside: avoid; }
      /* Standalone header only shows for the detail (per-record) layout,
         which has no repeating table. */
      .hd-standalone { page-break-after: avoid; }
    }
    body { font-family:'Helvetica Neue',Arial,sans-serif; margin:0; padding:24px; background:#fff; color:#0f172a }
    .hd { display:flex; align-items:center; gap:16px; border-bottom:3px solid #dc2626; padding-bottom:12px; margin-bottom:18px }
    /* Size the logo by WIDTH with height auto — capping height and using
       object-fit:contain inside a flex row squashed the wide DBX mark. */
    .hd img { width:150px; height:auto; max-height:60px; display:block; flex:0 0 auto }
    .hd h1 { margin:0; font-size:20px; font-weight:700 }
    .hd .count { background:#dc2626; color:#fff; font-size:13px; font-weight:800;
                 padding:5px 14px; border-radius:14px; white-space:nowrap;
                 -webkit-print-color-adjust:exact; print-color-adjust:exact }
    .hd .meta { margin-left:auto; text-align:right; font-size:11px; color:#64748b }
    /* Header band rendered inside <thead> so it repeats per page. */
    /* Top padding is what stops the logo being clipped at the top of every
       continuation page — the repeated thead row otherwise starts flush against
       the page edge. */
    th.hdcell { border:none !important; padding:4mm 0 10px !important; background:#fff !important;
                color:#0f172a !important; text-align:left !important; font-size:inherit !important;
                vertical-align:middle !important; }
    th.hdcell .hd { margin-bottom:0 }
    /* table-layout:fixed keeps the table inside the printable width, but with
       equal column widths phone numbers and emails wrap badly. Explicit widths
       (below, via colgroup) give each column space proportional to its content. */
    table { border-collapse:collapse; width:100%; font-size:10px; margin-bottom:18px;
            table-layout:fixed }
    /* break-word only, never mid-word: avoids "a@balochi@hotmail.com" splitting
       into three lines. Long unbroken strings shrink instead. */
    td { word-wrap:break-word; overflow-wrap:break-word; hyphens:none;
         font-size:9px; line-height:1.3 }
    /* Headers wrap only between words — overflow-wrap:normal stops "CRIMINAL"
       being split as "CRIMINA / L". Slightly tighter tracking helps them fit. */
    /* Header labels are the longest strings in the narrowest cells, so they get
       a smaller size than the body text (9px) to fit on fewer lines. */
    th { overflow-wrap:normal; word-break:normal; hyphens:none;
         font-size:7px; line-height:1.2; letter-spacing:0 !important; padding:5px 3px }
    /* Phone numbers should never break across lines. */
    td.nowrap, th.nowrap { white-space:nowrap }
    /* Centered by default; .txt columns (names, emails, addresses) stay left
       so long values remain readable. */
    th,td { border:1px solid #cbd5e1; padding:5px 7px; text-align:center; vertical-align:middle }
    td.txt, th.txt { text-align:left }
    th { background:#1e293b; color:#fff; font-weight:700; font-size:9px; text-transform:uppercase;
         letter-spacing:.4px; -webkit-print-color-adjust:exact; print-color-adjust:exact }
    /* -webkit-print-color-adjust keeps header shading from being dropped by the printer. */
    th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tbody tr:nth-child(even) td { background:#f8fafc;
         -webkit-print-color-adjust:exact; print-color-adjust:exact }
    .rec { margin-bottom:22px }
    .rec h2 { font-size:14px; margin:0 0 8px; padding-bottom:5px; border-bottom:2px solid #e2e8f0 }
    .kv { width:100%; font-size:11px }
    .kv td { text-align:left }
    .kv td:first-child { width:210px; font-weight:600; background:#f8fafc; color:#475569;
         -webkit-print-color-adjust:exact; print-color-adjust:exact }
    .ft { margin-top:20px; font-size:9px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:8px }
  </style></head><body>
    ${standaloneHeader ? `<div class="hd hd-standalone">
      <img src="${LOGO}" alt="DBX"/>
      <h1>${rptEsc(title)}</h1>
      ${countLabel ? `<div class="count">${rptEsc(countLabel)}</div>` : ""}
      <div class="meta">Diamond Back Express Inc.<br/>Generated ${stamp}</div>
    </div>` : ""}
    ${bodyHtml}
    <div class="ft">Confidential — internal use only. Diamond Back Express Inc. / CargoDX.</div>
    <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 4px 12px rgba(220,38,38,.4)">🖨 Print / Save as PDF</button>
    </div>
  </body></html>`);
  w.document.close();
}

// Relative column widths (arbitrary units, normalised to 100% at render time).
// Sized to actual content: emails and addresses need room, Role/PIN do not.
// Without these, table-layout:fixed gives every column equal width and phone
// numbers and emails wrap onto 2-3 lines.
const RPT_COL_WIDTH = {
  // Sized to actual content. Phone fits "555-555-5555" and no more; VIN needs
  // room for a full 17-character number on one line.
  "Name": 15, "Role": 6, "Phone": 8, "Email": 22,
  "Licence Class": 4, "Employee ID": 8, "PIN": 5,
  "Pay Configuration": 12, "Address": 14,
  "Contact Person": 12, "Service Type": 12,
  "ACR Training": 9, "HazMat Training": 9, "Criminal Record Check": 9,
  "Background Verification": 9, "Code of Conduct": 9, "Driver's Licence": 9,
  "Expiry Alerts": 9, "Portal Daily Log": 8, "Docs": 4,
  // Equipment columns
  "Unit #": 7, "Plate #": 7, "Year": 4, "Make": 9, "Model": 9, "Type": 7,
  "VIN": 18, "Safety Exp": 8, "Safety Status": 8, "Notes": 16,
};
const rptColWidth = label => RPT_COL_WIDTH[label] || 8;

// Shorter labels for the wide table layout — the full names ("Background
// Verification", "Criminal Record Check") force very narrow columns.
const RPT_SHORT_LABEL = {
  "Criminal Record Check": "Criminal Check",
  "Background Verification": "Background",
  "Driver's Licence": "Licence Exp",
  "Pay Configuration": "Pay Config",
  "Licence Class": "Class",
  "Employee ID": "Emp ID",
  "ACR Training": "ACR",
  "HazMat Training": "HazMat",
  "Code of Conduct": "Conduct",
};
const rptShort = label => RPT_SHORT_LABEL[label] || label;

// Phone must stay on one line.
const RPT_NOWRAP_COLS = new Set(["Phone", "Role", "PIN", "Licence Class",
  "Employee ID", "VIN", "Year", "Plate #", "Unit #", "Safety Exp"]);

// Columns holding long free text stay left-aligned; everything else centers.
const RPT_TXT_COLS = new Set(["Address", "Client", "Contact Person", "Email", "Expiry Alerts", "Make", "Model", "Name", "Notes", "Pay Configuration", "Ref", "Service Type"]);

// The DBX band markup, for embedding inside <thead> so it repeats per page.
// countLabel e.g. "46 Trailers" — shown as a pill beside the title so the total
// is visible at the top of every page.
function rptHeaderBand(title, countLabel) {
  return `<div class="hd">
      <img src="${LOGO}" alt="DBX"/>
      <h1>${rptEsc(title)}</h1>
      ${countLabel ? `<div class="count">${rptEsc(countLabel)}</div>` : ""}
      <div class="meta">Diamond Back Express Inc.<br/>Generated ${new Date().toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"})}</div>
    </div>`;
}

function rptTableHtml(cols, rows, headerBandHtml) {
  // Everything inside <thead> is repeated by the browser at the top of EVERY
  // printed page, and its height is reserved on every page. Putting the DBX
  // band here (rather than fixed-positioning it) is what stops continuation
  // pages from being clipped.
  const band = headerBandHtml
    ? `<tr><th class="hdcell" colspan="${cols.length}">${headerBandHtml}</th></tr>`
    : "";
  const isTxt = label => RPT_TXT_COLS.has(label);
  // Normalise the relative widths to percentages so the row always totals 100%.
  const wTotal = cols.reduce((s, c) => s + rptColWidth(c[0]), 0);
  const group = `<colgroup>${cols.map(c =>
    `<col style="width:${(rptColWidth(c[0]) / wTotal * 100).toFixed(2)}%"/>`).join("")}</colgroup>`;
  const cls = label => {
    const parts = [];
    if (isTxt(label)) parts.push("txt");
    if (RPT_NOWRAP_COLS.has(label)) parts.push("nowrap");
    return parts.length ? ` class="${parts.join(" ")}"` : "";
  };
  const head = `<thead>${band}<tr>${cols.map(c => `<th${cls(c[0])}>${rptEsc(rptShort(c[0]))}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows.map(r => `<tr>${cols.map(c => `<td${cls(c[0])}>${rptEsc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${group}${head}${body}</table>`;
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

// Reads Admin → Report Columns. Returns { scopeId: [labels] } or {}.
async function loadReportColumns() {
  try {
    const snap = await getDoc(doc(db, "settings", "reportColumns"));
    return snap.exists() ? (snap.data().scopes || {}) : {};
  } catch (e) { console.warn("reportColumns load failed:", e); return {}; }
}

// Apply a saved column selection to a built column list. `chosenLabels` is the
// array the admin ticked for this scope; when absent, all columns show (current
// behaviour). Order follows the built list, not the saved order, so new custom
// fields still appear in a sensible place.
function applyColumnPicks(cols, chosenLabels) {
  if (!chosenLabels || !chosenLabels.length) return cols;
  const keep = new Set(chosenLabels);
  // Migration safety: older saved selections used "Name" for the name column,
  // which the report now labels via rptFieldLabel("name") (default "Full Name").
  // Treat the two as equivalent so a previously-saved pick still matches.
  if (keep.has("Name")) keep.add("Full Name");
  if (keep.has("Full Name")) keep.add("Name");
  if (keep.has("Licence Class")) keep.add("License Class"); // old British spelling
  const filtered = cols.filter(c => keep.has(c[0]));
  // Never let a pick leave zero columns — fall back to the full set.
  return filtered.length ? filtered : cols;
}

function RosterEquipReports({ db }) {
  const [scope, setScope] = useState("equipment"); // equipment | people
  const [cat, setCat] = useState("trucks");        // trucks|trailers|all  /  drivers|employees|suppliers|all
  const [mode, setMode] = useState("all");         // all | selected
  const [sel, setSel] = useState([]);
  const [detail, setDetail] = useState(true);
  const [busy, setBusy] = useState(false);
  const customDefs = useCustomFields();
  // Report-column selections authored in Admin → Report Columns.
  // NB: the `db` prop here is the dispatch data object, which shadows the
  // Firestore instance. loadReportColumns() closes over the real Firestore db.
  const [colSel, setColSel] = useState({});
  useEffect(() => {
    let live = true;
    loadReportColumns().then(s => { if (live) setColSel(s); });
    return () => { live = false; };
  }, []);

  const trucks = (db.trucks || []).map(t => ({ ...t, _kind: "Truck" }));
  const trailers = (db.trailers || []).map(t => ({ ...t, _kind: "Trailer" }));
  const people = db.drivers || [];

  const pool = useMemo(() => {
    if (scope === "equipment") {
      const base = cat === "trucks" ? trucks : cat === "trailers" ? trailers : [...trucks, ...trailers];
      const arr = base.filter(u => u.archived !== true); // archived units excluded from equipment reports
      return [...arr].sort((a, b) => String(a.unit || "").localeCompare(String(b.unit || ""), undefined, { numeric: true }));
    }
    const arr = people.filter(p => {
      if (p.archived === true) return false; // archived people excluded from roster reports
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
  // Custom-field columns for this category. For the person "all" view, gather
  // fields across every person target; otherwise use the single category key.
  const cfTargetsForCat = isEquip
    ? (cat === "all" ? ["trucks", "trailers"] : [cat])
    : (cat === "all" ? ["drivers", "employees", "suppliers"] : [cat]);
  const cfCols = (() => {
    const seen = new Set(); const out = [];
    cfTargetsForCat.forEach(t => cfColsFor(customDefs, t).forEach(c => {
      if (seen.has(c[0])) return; seen.add(c[0]); out.push(c);
    }));
    return out;
  })();
  const cfDefsForCat = cfForTarget(customDefs, cfTargetsForCat).all;

  // Columns adapt to the category so inapplicable fields are dropped, then the
  // Admin → Report Columns picker (if any) is applied for this scope.
  // Admin configures per specific scope (trucks/trailers/drivers/employees/
  // suppliers) — there's no "all" scope. So for an "All" report, combine the
  // member scopes' picks (union: a column shows if ANY member scope keeps it),
  // which is why "All Units"/"All People" previously ignored the picker.
  const memberScopes = isEquip
    ? (cat === "all" ? ["trucks", "trailers"] : [cat])
    : (cat === "all" ? ["drivers", "employees", "suppliers"] : [cat]);
  const effectivePicks = (() => {
    const picks = memberScopes.map(s => colSel[s]).filter(p => p && p.length);
    if (!picks.length) return colSel[cat]; // no member picks → undefined = show all
    return [...new Set(picks.flat())]; // union of all member scopes' chosen labels
  })();
  const builtCols = isEquip ? rptUnitCols() : rptPersonCols(cat, chosen);
  const cols = applyColumnPicks([...builtCols, ...cfCols], effectivePicks);
  // Detail (per-record) layout: append custom-field rows after built-in ones.
  // Same column picks apply — a row (label/value pair) is dropped if its label
  // isn't in the effective picks, so hiding a column hides it in detail too.
  const rowKeep = (() => {
    if (!effectivePicks || !effectivePicks.length) return null; // null = keep all
    const keep = new Set(effectivePicks);
    if (keep.has("Name")) keep.add("Full Name");
    if (keep.has("Full Name")) keep.add("Name");
    if (keep.has("Licence Class")) keep.add("License Class");
    return keep;
  })();
  const filterRows = rows => rowKeep ? rows.filter(r => rowKeep.has(r[0])) : rows;
  const rowsFn = isEquip
    ? (u => filterRows([...rptUnitRows(u), ...cfDefsForCat.map(f => [f.label, cfReportValue(f, u)])]))
    : (p => {
        const applicable = cfForTarget(customDefs, cfPersonTargets(p)).all;
        return filterRows([...rptPersonRows(p), ...applicable.map(f => [f.label, cfReportValue(f, p)])]);
      });
  const stamp = new Date().toISOString().slice(0, 10);

  // Total shown in the report header, e.g. "46 Trailers" / "31 Drivers".
  const NOUN = {
    trucks: ["Truck","Trucks"], trailers: ["Trailer","Trailers"],
    drivers: ["Driver","Drivers"], employees: ["Employee","Employees"],
    suppliers: ["Supplier","Suppliers"],
    all: isEquip ? ["Unit","Units"] : ["Person","People"],
  }[cat] || ["Record","Records"];
  const countLabel = `${chosen.length} ${chosen.length === 1 ? NOUN[0] : NOUN[1]}`;

  const doPdf = () => {
    if (!chosen.length) return alert("Nothing selected.");
    if (detail) {
      // Per-record layout: single header at the top of the document.
      rptOpenPdf(title, rptDetailHtml(chosen, label, rowsFn), true, countLabel);
    } else {
      // Table layout: header band goes inside <thead> so it repeats per page.
      rptOpenPdf(title, rptTableHtml(cols, chosen, rptHeaderBand(title, countLabel)), false, countLabel);
    }
  };
  const doExcel = async () => {
    if (!chosen.length) return alert("Nothing selected.");
    setBusy(true);
    try {
      // Prepend the title and total so the count is visible in Excel too.
      const aoa = [[title], [countLabel], []].concat(
        detail ? rptAoaDetail(chosen, label, rowsFn) : rptAoaFlat(cols, chosen)
      );
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

// ═══ MAINTENANCE & REPAIRS REPORT ═══
// All maintenance records filtered by date range + unit, printable to PDF.
// Columns honour the "maintenance" scope saved in Admin → Report Columns.
function MaintenanceReport({ db: data }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("year");   // month | lastmonth | year | last12 | custom | all
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [unitFilter, setUnitFilter] = useState("ALL");
  const [colPicks, setColPicks] = useState(null);  // saved column selection for "maintenance"

  useEffect(() => {
    getDocs(collection(db, "maintenance"))
      .then(s => setRecords(s.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(e => console.error("maintenance report load:", e))
      .finally(() => setLoading(false));
    loadReportColumns().then(scopes => setColPicks((scopes || {}).maintenance || null));
  }, []);

  const now = new Date();
  let rangeFrom, rangeTo;
  if (period === "month") { rangeFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`; rangeTo = td(); }
  else if (period === "lastmonth") { const lm = new Date(now.getFullYear(), now.getMonth()-1, 1); const lme = new Date(now.getFullYear(), now.getMonth(), 0); rangeFrom = lm.toISOString().slice(0,10); rangeTo = lme.toISOString().slice(0,10); }
  else if (period === "year") { rangeFrom = `${now.getFullYear()}-01-01`; rangeTo = td(); }
  else if (period === "last12") { const d = new Date(now); d.setFullYear(d.getFullYear()-1); rangeFrom = d.toISOString().slice(0,10); rangeTo = td(); }
  else if (period === "custom") { rangeFrom = customFrom || "2000-01-01"; rangeTo = customTo || td(); }
  else { rangeFrom = "2000-01-01"; rangeTo = "2099-12-31"; }

  const inRange = (r) => r.date && r.date >= rangeFrom && r.date <= rangeTo;
  const filtered = records.filter(r => inRange(r) && (unitFilter === "ALL" || r.unitId === unitFilter))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const totalSpend = filtered.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);

  // Unit options for the filter (from records + current fleet).
  const unitMap = {};
  records.forEach(r => { if (r.unitId) unitMap[r.unitId] = r.unitLabel || r.unitId; });
  (data.trucks || []).concat(data.trailers || []).forEach(u => { unitMap[u.id] = u.unit || u.plate || unitMap[u.id] || u.id; });
  const unitOpts = Object.entries(unitMap).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  const fdr = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : "";

  // Column definitions: [label, valueFn, relWidth]
  const allCols = [
    ["Date", r => fdr(r.date)],
    ["Unit", r => r.unitLabel || ""],
    ["Type", r => r.unitType || ""],
    ["Description", r => r.description || ""],
    ["Vendor", r => r.vendor || ""],
    ["Invoice #", r => r.invoiceNum || ""],
    ["Cost", r => `$${(parseFloat(r.cost) || 0).toFixed(2)}`],
  ];
  const cols = applyColumnPicks(allCols, colPicks);

  const periodLabel = { month: "This Month", lastmonth: "Last Month", year: "This Year", last12: "Last 12 Months", custom: `${fdr(rangeFrom)} – ${fdr(rangeTo)}`, all: "All Time" }[period];
  const countLabel = `${filtered.length} record${filtered.length !== 1 ? "s" : ""} · Total $${totalSpend.toFixed(2)}`;

  const printPdf = () => {
    // rptTableHtml expects columns as [label, valueFn] and calls valueFn(row)
    // itself, with rows being the raw records. Append a synthetic total record
    // and give it its own value functions via a wrapper column set.
    const dataRows = [...filtered, { __total: true }];
    const pdfCols = cols.map(c => [c[0], (r) => r.__total ? (c[0] === "Cost" ? `$${totalSpend.toFixed(2)}` : (c === cols[0] ? "TOTAL" : "")) : c[1](r)]);
    const title = `Maintenance & Repairs — ${periodLabel}`;
    rptOpenPdf(title, rptTableHtml(pdfCols, dataRows, rptHeaderBand(title, countLabel)), false, countLabel);
  };

  const selStyle = { ...sIn, width: "auto", minWidth: 150 };
  return <div>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
      <div><label style={{ ...sLbl, marginBottom: 2 }}>Period</label>
        <select style={selStyle} value={period} onChange={e => setPeriod(e.target.value)}>
          <option value="month">This Month</option>
          <option value="lastmonth">Last Month</option>
          <option value="year">This Year</option>
          <option value="last12">Last 12 Months</option>
          <option value="custom">Custom Range</option>
          <option value="all">All Time</option>
        </select>
      </div>
      {period === "custom" && <>
        <div><label style={{ ...sLbl, marginBottom: 2 }}>From</label><input type="date" style={selStyle} value={customFrom} onChange={e => setCustomFrom(e.target.value)} /></div>
        <div><label style={{ ...sLbl, marginBottom: 2 }}>To</label><input type="date" style={selStyle} value={customTo} onChange={e => setCustomTo(e.target.value)} /></div>
      </>}
      <div style={{ minWidth: 240 }}><label style={{ ...sLbl, marginBottom: 2 }}>Unit</label>
        <SearchSelect
          options={[{ value: "ALL", label: "All Units" }, ...unitOpts.map(([id, label]) => ({ value: id, label: String(label) }))]}
          value={unitFilter}
          emptyLabel="All Units"
          placeholder="Type unit # to filter..."
          onChange={id => setUnitFilter(id || "ALL")}
        />
      </div>
      <button style={{ ...sBtn, background: T.red }} onClick={printPdf} disabled={filtered.length === 0}><Ic n="file" s={14} /> Print PDF</button>
    </div>

    <div style={{ background: "rgba(220,38,38,0.06)", border: `1px solid ${T.red}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{periodLabel} — Total Maintenance Spend</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: T.red }}>${totalSpend.toFixed(2)}</div>
      <div style={{ fontSize: 12, color: T.muted }}>{filtered.length} record{filtered.length !== 1 ? "s" : ""}</div>
    </div>

    {loading ? <div style={{ padding: 20, color: T.muted, fontSize: 13 }}>Loading…</div>
      : filtered.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: T.muted, fontSize: 13 }}>No maintenance records in this range.</div>
        : <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr>{cols.map(c => <th key={c[0]} style={{ textAlign: c[0] === "Cost" ? "right" : "left", padding: "8px 10px", borderBottom: `2px solid ${T.border}`, color: T.muted, fontSize: 10, textTransform: "uppercase" }}>{c[0]}</th>)}</tr></thead>
            <tbody>
              {filtered.map(r => <tr key={r.id}>{cols.map(c => <td key={c[0]} style={{ textAlign: c[0] === "Cost" ? "right" : "left", padding: "7px 10px", borderBottom: `1px solid ${T.border}` }}>{c[1](r)}</td>)}</tr>)}
              <tr style={{ fontWeight: 700 }}>{cols.map((c, i) => <td key={c[0]} style={{ textAlign: c[0] === "Cost" ? "right" : "left", padding: "8px 10px", borderTop: `2px solid ${T.border}`, color: T.red }}>{i === 0 ? "TOTAL" : c[0] === "Cost" ? `$${totalSpend.toFixed(2)}` : ""}</td>)}</tr>
            </tbody>
          </table>
        </div>}
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
    const snap = p.fxSnapshot;
    // If a multi-currency / FX conversion applies, return the SAME footed grand
    // total the order detail, BOL PDF, and Xero CSV show — converted to the target
    // (invoice) currency, with the admin-fee/adjustment applied. Otherwise fall
    // back to the plain native sum below.
    if (snap && (snap.applies || snap.multi) && snap.grand != null) {
      const evForSum = (p.eventLines || []).filter(l => l.desc).map(l => {
        const lb = (parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0);
        const ltp = l.taxMode === "HST" ? 13 : l.taxMode === "GST" ? 5 : l.taxMode === "CUSTOM" ? (parseFloat(l.taxCustom) || 0) : 0;
        return { ltot: lb + lb * (ltp / 100), currency: l.currency || p.cur || "CAD" };
      });
      // Include transport base+fuel as a line in the order's own currency.
      const baseAmt0 = parseFloat(p.base) || 0;
      if (baseAmt0 > 0) {
        const fuel0 = baseAmt0 * ((parseFloat(p.fuelPct) || 0) / 100);
        const tax0 = p.taxMode && p.taxMode !== "NONE" ? (baseAmt0 + fuel0) * (((p.taxMode==="HST"?13:p.taxMode==="GST"?5:p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):0))/100) : 0;
        evForSum.unshift({ ltot: baseAmt0 + fuel0 + tax0, currency: p.cur || "CAD" });
      }
      const footed = fxConvertedLineSum(evForSum, snap);
      const adjAmt = snap.adjVal ? (snap.adjMode === "pct" ? Math.round(footed.sum * (snap.adjVal / 100) * 100) / 100 : (parseFloat(snap.adjVal) || 0)) : 0;
      return Math.round((footed.sum + adjAmt) * 100) / 100;
    }
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
  // Displayed currency for an order in the report: the FX target when a conversion
  // applies, else the order's own price currency.
  const orderCur = (o) => {
    const p = o.price || {};
    const snap = p.fxSnapshot;
    if (snap && (snap.applies || snap.multi) && snap.target) return snap.target;
    return p.cur || "CAD";
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
    if (curFilter !== "ALL" && orderCur(o) !== curFilter) return false;
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
    const cur = orderCur(o);
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
    const nf = n => n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
    const totalsHTML = Object.entries(grandTotals).map(([c, d]) =>
      `<div class="kpi"><div class="lbl">Total Revenue (${c})</div><div class="val">${csym(c)}${nf(d.total)}</div><div class="sub">${d.count} order${d.count!==1?"s":""}</div></div>`
    ).join("");
    const tableRows = rows.map(r =>
      `<tr><td class="txt">${r.label}</td><td>${r.count}</td><td class="num">${csym(r.cur)}${nf(r.total)}</td><td class="muted">${r.cur}</td></tr>`
    ).join("");
    const detailRows = [...pricedOrders].sort((a,b)=>
      String(a.bol||"").localeCompare(String(b.bol||""), undefined, { numeric: true })
    ).map(o => {
      const t = calcTotal(o); const cur = orderCur(o);
      return `<tr><td style="font-weight:700">${o.bol}</td><td>${o.invoiceNum||"—"}</td><td>${fd(o.reqDate)}</td><td class="txt">${o.cliName||"—"}</td><td class="txt">${(typeof o.ref==="string"?o.ref:o.ref?.value||"")||"—"}</td><td class="num">${csym(cur)}${nf(t)}</td><td class="muted">${cur}</td></tr>`;
    }).join("");

    const evtLabel = evtFilter !== "ALL" ? (db.events||[]).find(e=>e.id===evtFilter)?.name || "" : "";
    const genStamp = new Date().toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"});
    return `<html><head><title>${APP_NAME} Report</title><style>
  /* Left/right margin 0 so the browser can't inject its own date/URL header
     and footer. 30mm top reserves the running-header strip on EVERY page. */
  @page{size:letter;margin:30mm 0 16mm}
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:0 14mm;color:#0f172a;font-size:12px}

  /* Running header: repeats on every printed page, drawn into the @page strip. */
  .rhead{display:flex;align-items:center;gap:12px;padding:10mm 14mm 8px;
         border-bottom:3px solid #dc2626;background:#fff;margin-bottom:14px}
  .rhead img{height:40px;border-radius:4px}
  .rhead .t1{font-weight:800;font-size:16px;letter-spacing:-.2px}
  .rhead .t2{font-size:11px;color:#64748b}
  .rhead .meta{margin-left:auto;text-align:right;font-size:10px;color:#94a3b8;line-height:1.5}

  .subhead{font-size:11px;color:#475569;margin-bottom:14px;padding-bottom:10px;
           border-bottom:1px solid #e2e8f0}
  .subhead b{color:#0f172a}

  /* KPI cards */
  .kpis{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}
  .kpi{flex:1;min-width:150px;border:1px solid #e2e8f0;border-top:3px solid #0ea5e9;
       border-radius:6px;padding:12px 16px;background:#f8fafc}
  .kpi .lbl{font-size:9px;font-weight:700;color:#0ea5e9;text-transform:uppercase;
            letter-spacing:.6px;margin-bottom:5px}
  .kpi .val{font-size:21px;font-weight:800;letter-spacing:-.5px;color:#0f172a}
  .kpi .sub{font-size:10px;color:#94a3b8;margin-top:3px}

  h3{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#475569;
     margin:22px 0 8px;padding-bottom:5px;border-bottom:2px solid #e2e8f0}

  table{width:100%;border-collapse:collapse;font-size:11px}
  thead{display:table-header-group}
  th{background:#1e293b;color:#fff;text-align:center;padding:7px 8px;font-weight:700;
     font-size:9px;text-transform:uppercase;letter-spacing:.5px;
     -webkit-print-color-adjust:exact;print-color-adjust:exact}
  td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:center;vertical-align:middle}
  /* Zebra striping for easier row tracking across wide tables. */
  tbody tr:nth-child(even){background:#f8fafc;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  tbody tr{page-break-inside:avoid}
  /* Money right-aligned so decimals line up; long text left-aligned to read. */
  .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .txt{text-align:left}
  .muted{color:#94a3b8;font-size:10px}
  .totrow td{border-top:2px solid #1e293b;font-weight:800;background:#f1f5f9;
             -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .ft{margin-top:18px;padding-top:8px;border-top:1px solid #e2e8f0;
      font-size:9px;color:#94a3b8}
  @media print{.no-print{display:none!important}}
</style></head><body>
<div class="rhead">
  <img src="${LOGO}"/>
  <div><div class="t1">${APP_NAME} — REPORT</div><div class="t2">${COMPANY_NAME}</div></div>
  <div class="meta">Generated ${genStamp}<br/>${periodLabel}</div>
</div>
<div class="subhead"><b>Period:</b> ${periodLabel} &nbsp;&nbsp;·&nbsp;&nbsp; <b>Group by:</b> ${groupBy} &nbsp;&nbsp;·&nbsp;&nbsp; <b>Orders:</b> ${pricedOrders.length}${evtLabel?` &nbsp;&nbsp;·&nbsp;&nbsp; <b>Event:</b> ${evtLabel}`:""}</div>
<div class="kpis">${totalsHTML}</div>
${rows.length>0?`<h3>Revenue Breakdown</h3><table><thead><tr><th class="txt">Breakdown</th><th>Orders</th><th>Total</th><th>Currency</th></tr></thead><tbody>${tableRows}</tbody></table>`:""}
${pricedOrders.length>0?`<h3>Order Details</h3><table><thead><tr><th>BOL</th><th>Invoice #</th><th>Date</th><th class="txt">Client</th><th class="txt">Ref</th><th>Total</th><th>Cur</th></tr></thead><tbody>${detailRows}</tbody></table>`:""}
<div class="ft">Confidential — internal use only. ${COMPANY_NAME}</div>
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
      {[["orders","Orders & Revenue"],["roster","Equipment & Roster"],["maintenance","Maintenance & Repairs"]].map(([k,l])=>
        <button key={k} onClick={()=>setRptView(k)} style={{padding:"6px 14px",borderRadius:6,
          background:rptView===k?T.border:"transparent",border:`1px solid ${rptView===k?"#334155":T.border}`,
          color:rptView===k?T.text:T.muted,fontSize:12,cursor:"pointer",fontFamily:"inherit",
          fontWeight:rptView===k?600:400}}>{l}</button>)}
    </div>

    {rptView==="roster" && <RosterEquipReports db={db}/>}
    {rptView==="maintenance" && <MaintenanceReport db={db}/>}
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
            <th style={{padding:"6px 8px"}}>BOL</th><th style={{padding:"6px 8px"}}>Invoice #</th><th style={{padding:"6px 8px"}}>Date</th><th style={{padding:"6px 8px"}}>Client</th>
            <th style={{padding:"6px 8px"}}>Reference</th><th style={{padding:"6px 8px"}}>Status</th>
            <th style={{padding:"6px 8px",textAlign:"right"}}>Total</th><th style={{padding:"6px 8px"}}>Cur</th>
          </tr></thead>
          <tbody>{[...pricedOrders].sort((a,b)=>
            String(a.bol||"").localeCompare(String(b.bol||""), undefined, { numeric: true })
          ).map(o=>{
            const t=calcTotal(o); const cur=orderCur(o);
            return <tr key={o.id} style={{borderTop:`1px solid ${T.border}`,cursor:"pointer"}} onClick={()=>go("od",o)}>
              <td style={{padding:"5px 8px",fontWeight:600}}>{o.bol}</td>
              <td style={{padding:"5px 8px",color:o.invoiceNum?T.text:T.dim}}>{o.invoiceNum||"—"}</td>
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
            <td style={{padding:8,fontSize:12,fontWeight:600,fontFamily:"'IBM Plex Mono'"}}>{o.bol}{o.dispatchNotes&&o.dispatchNotes.trim()?<span title={o.dispatchNotes} style={{marginLeft:5,fontSize:11,cursor:"help"}}>📝</span>:null}</td>
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



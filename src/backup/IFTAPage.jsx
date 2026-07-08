import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "./firebase.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, setDoc, getDoc, query, orderBy, where
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// ── Theme ──────────────────────────────────────────────────────────────────
const T = {
  red:"#dc2626", black:"#0f0f0f", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b",
  border:"#1e293b", hover:"#0f172a", card:"#0f172a", surface:"#1e293b", bg:"#020817",
  green:"#22c55e", greenDim:"rgba(34,197,94,0.1)", amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)",
  redDim:"rgba(220,38,38,0.1)", blue:"#0ea5e9", blueDim:"rgba(14,165,233,0.1)",
};

// ── Constants ───────────────────────────────────────────────────────────────
const GALLONS_TO_LITRES = 3.78541;
const MILES_TO_KM = 1.60934;

// Acceptable L/100km range for heavy trucks in IFTA audit context
const FUEL_ECON_MIN = 20;  // L/100km (too low = suspiciously efficient)
const FUEL_ECON_MAX = 80;  // L/100km (too high = implausibly thirsty)

// ── IFTA Tax Rates ──────────────────────────────────────────────────────────
// Rates in CAD per litre (the unit Ontario's IFTA form uses for all jurisdictions)
// Canadian provinces: direct CAD/L from IFTA Inc. matrix Q2 2026
// US states: converted from USD/gallon → CAD/litre (rate × 1.3984 ÷ 3.785)
// Exchange rate Q2 2026: 1 USD = 1.3984 CAD (source: federalreserve.gov via IFTA Inc.)
// Source: IFTA Inc. Tax Rate Matrix Q2 2026 — iftach.org
const IFTA_RATES_Q2_2026 = {
  AB:0.3575, BC:0.4125, MB:0.3437, NB:0.4248, NL:0.2612,
  NS:0.4235, ON:0.2475, PE:0.3891, QC:0.5555, SK:0.4125,
  AL:0.1145, AZ:0.0961, AR:0.1053, CA:0.3587, CO:0.1238,
  CT:0.1844, DE:0.0813, FL:0.1514, GA:0.1378, ID:0.1182,
  IL:0.2727, IN:0.2328, IA:0.1201, KS:0.0961, KY:0.0813,
  LA:0.0739, ME:0.1153, MD:0.1727, MA:0.0887, MI:0.1936,
  MN:0.1204, MS:0.0887, MO:0.1090, MT:0.1099, NE:0.1175,
  NV:0.0998, NH:0.0820, NJ:0.2073, NM:0.0776, NY:0.1406,
  NC:0.1515, ND:0.0850, OH:0.1736, OK:0.0702, OR:0.0000,
  PA:0.2738, RI:0.1478, SC:0.1034, SD:0.1034, TN:0.0998,
  TX:0.0739, UT:0.1400, VT:0.1145, VA:0.1208, WA:0.2158,
  WV:0.1319, WI:0.1216, WY:0.0887,
};
// Surcharges — filed on separate Schedule 2 (KY and VA only, Q2 2026)
const IFTA_SURCHARGES_Q2_2026 = { KY:0.0388, VA:0.0528 };
// Add future quarters here — the module will auto-select the most recent
const RATE_TABLES      = { "Q2 2026": IFTA_RATES_Q2_2026 };
const SURCHARGE_TABLES = { "Q2 2026": IFTA_SURCHARGES_Q2_2026 };
// These are fallback seeds only — live rates come from Firestore (iftaRates collection)
function getRatesForQuarter(q, liveRates)      { return liveRates?.[q] || RATE_TABLES[q]      || RATE_TABLES[Object.keys(RATE_TABLES).sort().reverse()[0]]      || {}; }
function getSurchargesForQuarter(q, liveSurch) { return liveSurch?.[q] || SURCHARGE_TABLES[q] || SURCHARGE_TABLES[Object.keys(SURCHARGE_TABLES).sort().reverse()[0]] || {}; }

// ── IFTA member jurisdictions (for validation)
const IFTA_JURISDICTIONS = new Set([
  "AB","BC","MB","NB","NL","NS","ON","PE","QC","SK",
  "AL","AR","AZ","CA","CO","CT","DE","FL","GA","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY","DC",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n, dec=1) => n == null || isNaN(n) ? "—" : Number(n).toFixed(dec);
const fmtL = (n) => n == null || isNaN(n) ? "—" : `${Number(n).toFixed(0)} L`;
const fmtKm = (n) => n == null || isNaN(n) ? "—" : `${Number(n).toFixed(0)} km`;
const today = () => new Date().toISOString().slice(0,10);

// Auto-convert Nomad unit ID → Geotab dash format
// e.g. "1906" → "19-06", "23-15" → "23-15", "1201327" → null (Pipeline card)
function nomadToGeotab(unitStr) {
  const u = String(unitStr || "").trim();
  if (!u || u === "nan" || u === "undefined") return null;
  if (/^\d{2}-\d{2}$/.test(u)) return u; // already correct
  if (/^\d{4}$/.test(u)) return u.slice(0,2) + "-" + u.slice(2); // 2009 → 20-09
  if (/^\d{5}$/.test(u)) return u.slice(0,2) + "-" + u.slice(2); // edge case
  return null; // Pipeline/WEX anomaly IDs — needs manual mapping
}

// Parse a date string in MM/DD/YYYY or ISO format
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0,10);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  return null;
}

function quarterOf(dateStr) {
  if (!dateStr) return null;
  const m = parseInt(dateStr.slice(5,7));
  const y = dateStr.slice(0,4);
  if (m <= 3) return `Q1 ${y}`;
  if (m <= 6) return `Q2 ${y}`;
  if (m <= 9) return `Q3 ${y}`;
  return `Q4 ${y}`;
}

// ── Excel parsing ────────────────────────────────────────────────────────────

function detectNomadFile(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false });
  const h = (rows[0]||[]).map(v => String(v).toLowerCase());
  if (h.includes("trx id") || h.includes("transaction number")) return "nomad";
  return null;
}

function detectGeotabFile(wb) {
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false });
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const vals = (rows[i]||[]).map(v => String(v).toLowerCase());
      if (vals.some(v => v.includes("jurisdiction")) && vals.some(v => v.includes("distance"))) {
        return { type:"geotab", sheet:sn, headerRow:i };
      }
    }
  }
  return null;
}

// Parse Nomad fuel card export (CAN or USA)
function parseNomadFile(wb, fuelCardMap) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false });
  if (!rows.length) return { transactions:[], errors:[] };

  const header = rows[0].map(v => String(v).trim());
  const col = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

  // Detect CAN vs USA by looking for "Transaction Number" vs "TRX ID"
  const isCAN = header.some(h => h.toLowerCase().includes("transaction number"));

  const idxDate    = isCAN ? col("Transaction Date (Local Time)") : col("Date");
  const idxUnit    = col("Unit Number");
  const idxCard    = col("Card Number");
  const idxDriver  = isCAN ? col("Driver Name") : col("Driver Name");
  const idxState   = col("State");
  const idxProduct = isCAN ? col("Product Type") : col("Product");
  const idxVolume  = col("Volume");
  const idxUoM     = isCAN ? col("UoM") : -1;
  const idxNetwork = col("Network");
  const idxTotal   = col("Total");

  const transactions = [];
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idxVolume]) continue;

    const productRaw = String(r[idxProduct]||"").trim();
    // Skip DEF (Diesel Exhaust Fluid) and Reefer — only count diesel fuel
    const isDiesel = isCAN
      ? productRaw === "Diesel"
      : productRaw.includes("Diesel") && !productRaw.includes("Exhaust");
    if (!isDiesel) continue;

    const unitRaw  = String(r[idxUnit]||"").trim();
    const cardRaw  = String(r[idxCard]||"").trim();
    const dateStr  = parseDate(String(r[idxDate]||"").trim());
    const volume   = parseFloat(r[idxVolume]) || 0;
    const state    = String(r[idxState]||"").trim().toUpperCase();
    const driver   = String(r[idxDriver]||"").trim();
    const network  = String(r[idxNetwork]||"").trim();
    const total    = parseFloat(r[idxTotal]) || 0;

    if (!volume || volume <= 0) continue;

    // Litres: CAN UoM is "L", USA is gallons — convert gallons→litres
    const uom = isCAN ? (String(r[idxUoM]||"L").trim()) : "gal";
    const litres = uom === "L" ? volume : volume * GALLONS_TO_LITRES;

    // Resolve truck unit
    let geotabUnit = nomadToGeotab(unitRaw);

    // Check manual mapping table (for Pipeline cards etc.)
    if (!geotabUnit && fuelCardMap) {
      // Try by card number (masked or full)
      const cardKey = cardRaw.replace(/\*/g, "");
      const byCard = fuelCardMap.find(m =>
        m.cardNumber && (m.cardNumber.endsWith(cardKey.slice(-6)) || m.cardNumber === cardRaw)
      );
      if (byCard) geotabUnit = byCard.truckUnit;
      // Try by Nomad unit number directly
      if (!geotabUnit) {
        const byUnit = fuelCardMap.find(m => m.nomadUnit === unitRaw);
        if (byUnit) geotabUnit = byUnit.truckUnit;
      }
    }

    if (!geotabUnit) {
      errors.push({ row: i+1, unitRaw, cardRaw, driver, network, litres,
        msg:`Unit "${unitRaw}" (${network}) could not be matched to a truck — add to Fuel Cards table` });
      continue;
    }

    transactions.push({ dateStr, quarter: quarterOf(dateStr), truckUnit: geotabUnit,
      nomadUnit: unitRaw, cardNumber: cardRaw, driver, state, network, litres, total, currency: isCAN?"CAD":"USD" });
  }

  return { transactions, errors, isCAN };
}

// Parse Geotab IFTA report
function parseGeotabFile(wb) {
  // Prefer the 'Report' sheet if it exists, then fall back to detection
  const preferredSheet = wb.SheetNames.find(n => /^report$/i.test(n));
  let foundSheet = null, foundHeaderRow = -1;

  const sheetsToSearch = preferredSheet
    ? [preferredSheet, ...wb.SheetNames.filter(n=>n!==preferredSheet)]
    : wb.SheetNames;

  for (const sn of sheetsToSearch) {
    const ws = wb.Sheets[sn];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false });
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const vals = (rows[i]||[]).map(v => String(v).toLowerCase().trim());
      if (vals.some(v => v === "jurisdiction") && vals.some(v => v === "distance")) {
        foundSheet = sn; foundHeaderRow = i; break;
      }
    }
    if (foundSheet) break;
  }

  if (!foundSheet) return { records:[], errors:["Could not find jurisdiction/distance headers in this file"] };

  const ws = wb.Sheets[foundSheet];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false });
  const header = rows[foundHeaderRow].map(v => String(v).trim());
  const col = name => header.findIndex(h => h.toLowerCase().trim() === name.toLowerCase().trim());

  const idxVehicle = col("Vehicle");
  const idxJuris   = col("Jurisdiction");
  const idxCountry  = col("Country");
  const idxDist    = col("Distance");
  const idxDriver  = col("Driver");
  const idxEnterT  = col("Enter Time");

  // Detect distance unit from metadata rows above the header
  let distUnit = "km";
  for (let i = 0; i < foundHeaderRow; i++) {
    const rowStr = (rows[i]||[]).join(" ").toLowerCase();
    if (rowStr.includes("distance unit") && rowStr.includes("miles")) { distUnit = "miles"; break; }
    if (rowStr.includes("distance unit") && rowStr.includes("km"))    { distUnit = "km"; break; }
  }

  const records = [];
  let currentVehicle = "", currentDriver = "";

  for (let i = foundHeaderRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const vehicleCell = String(r[idxVehicle]||"").trim();
    const juris       = String(r[idxJuris]||"").trim().toUpperCase();
    // Handle comma-formatted numbers like "1,130,096"
    const distRaw = parseFloat(String(r[idxDist]||"0").replace(/,/g,"")) || 0;

    if (/total$/i.test(vehicleCell)) continue;
    if (vehicleCell) currentVehicle = vehicleCell;
    if (!currentVehicle) continue;
    if (idxDriver !== -1 && r[idxDriver] && String(r[idxDriver]).trim()) {
      const dv = String(r[idxDriver]).trim();
      // Skip email addresses as driver names
      if (!dv.includes("@")) currentDriver = dv;
    }

    if (!juris || !distRaw) continue;

    const km = distUnit === "miles" ? distRaw * MILES_TO_KM : distRaw;
    const enterDate = idxEnterT !== -1 ? parseDate(String(r[idxEnterT]||"")) : null;

    records.push({
      truckUnit: currentVehicle, driver: currentDriver,
      jurisdiction: juris, km: Math.round(km * 10) / 10,
      country: String(r[idxCountry]||"").trim(),
      quarter: quarterOf(enterDate),
    });
  }

  return { records, errors:[], distUnit };
}

// ── Core IFTA Calculation ────────────────────────────────────────────────────
function calculateIFTA(geotabRecords, fuelTransactions, adjustments={}, quarter="Q2 2026", liveRates={}, liveSurch={}) {
  const rates      = getRatesForQuarter(quarter, liveRates);
  const surcharges = getSurchargesForQuarter(quarter, liveSurch);
  // Step 1: km per truck per jurisdiction
  const kmByTruckJuris = {};
  for (const rec of geotabRecords) {
    const key = `${rec.truckUnit}||${rec.jurisdiction}`;
    kmByTruckJuris[key] = (kmByTruckJuris[key]||0) + rec.km;
  }

  // Step 2: litres per truck (jurisdiction of purchase)
  const litresByTruck = {};
  const litresByTruckJuris = {};
  for (const tx of fuelTransactions) {
    litresByTruck[tx.truckUnit] = (litresByTruck[tx.truckUnit]||0) + tx.litres;
    const key = `${tx.truckUnit}||${tx.state}`;
    litresByTruckJuris[key] = (litresByTruckJuris[key]||0) + tx.litres;
  }

  // Step 3: per truck totals
  const trucks = {};
  for (const [key, km] of Object.entries(kmByTruckJuris)) {
    const [truckUnit, juris] = key.split("||");
    if (!trucks[truckUnit]) trucks[truckUnit] = {
      truckUnit, totalKm:0, totalLitres:0, jurisdictions:{}, fuelEcon:null, driver:"",
    };
    trucks[truckUnit].totalKm += km;
    if (!trucks[truckUnit].jurisdictions[juris]) {
      trucks[truckUnit].jurisdictions[juris] = { km:0, litresPurchased:0, litresConsumed:0, taxable:0 };
    }
    trucks[truckUnit].jurisdictions[juris].km += km;
  }

  // Assign driver from geotab
  const driverByTruck = {};
  for (const rec of geotabRecords) {
    if (rec.driver) driverByTruck[rec.truckUnit] = rec.driver;
  }
  for (const t of Object.values(trucks)) {
    t.driver = driverByTruck[t.truckUnit] || "";
    t.totalLitres = litresByTruck[t.truckUnit] || 0;
  }

  // Assign driver from fuel transactions (overrides with real name when available)
  for (const tx of fuelTransactions) {
    if (trucks[tx.truckUnit] && tx.driver) trucks[tx.truckUnit].driver = tx.driver;
  }

  // Apply manual adjustments to total litres
  for (const [truckUnit, adj] of Object.entries(adjustments)) {
    if (trucks[truckUnit] && adj.adjustedLitres != null) {
      trucks[truckUnit].adjustedLitres = parseFloat(adj.adjustedLitres);
      trucks[truckUnit].adjustNote = adj.note || "";
    }
  }

  // Step 4: fleet average fuel economy (L/100km) — used to calculate consumption
  // Use per-truck economy where available; flag outliers
  const results = [];
  for (const truck of Object.values(trucks)) {
    const effectiveLitres = truck.adjustedLitres ?? truck.totalLitres;
    const fuelEcon = truck.totalKm > 0 && effectiveLitres > 0
      ? (effectiveLitres / truck.totalKm) * 100 : null;
    const flagged = fuelEcon != null && (fuelEcon < FUEL_ECON_MIN || fuelEcon > FUEL_ECON_MAX);

    // Distribute fuel consumption proportionally across jurisdictions by km share
    const jurisRows = [];
    for (const [juris, j] of Object.entries(truck.jurisdictions)) {
      const kmShare = truck.totalKm > 0 ? j.km / truck.totalKm : 0;
      const litresConsumed = fuelEcon != null ? (fuelEcon / 100) * j.km : 0;
      const litresPurchased = litresByTruckJuris[`${truck.truckUnit}||${juris}`] || 0;
      const taxable = litresConsumed - litresPurchased; // positive = owe tax, negative = credit

      const taxRate = rates[juris] || null;
      const taxDue  = taxRate != null ? Math.round(taxable * taxRate * 100) / 100 : null;
      const surchargeRate = surcharges[juris] || null;
      const surchargeDue  = surchargeRate != null ? Math.round(taxable * surchargeRate * 100) / 100 : null;

      jurisRows.push({
        jurisdiction: juris, km: j.km, kmShare,
        litresConsumed: Math.round(litresConsumed * 10)/10,
        litresPurchased: Math.round(litresPurchased * 10)/10,
        taxable: Math.round(taxable * 10)/10,
        taxRate, taxDue, surchargeRate, surchargeDue,
        isIFTA: IFTA_JURISDICTIONS.has(juris),
      });
    }

    // Add jurisdictions where fuel was purchased but no km logged (unusual, flag these)
    const purchasedJuris = new Set(
      fuelTransactions.filter(t=>t.truckUnit===truck.truckUnit).map(t=>t.state)
    );
    for (const juris of purchasedJuris) {
      if (!truck.jurisdictions[juris]) {
        const lp = litresByTruckJuris[`${truck.truckUnit}||${juris}`] || 0;
        const tr = rates[juris] || null;
        jurisRows.push({
          jurisdiction:juris, km:0, kmShare:0, litresConsumed:0,
          litresPurchased: Math.round(lp*10)/10,
          taxable: Math.round(-lp*10)/10,
          taxRate: tr, taxDue: tr != null ? Math.round(-lp * tr * 100)/100 : null,
          surchargeRate: surcharges[juris]||null, surchargeDue: null,
          isIFTA: IFTA_JURISDICTIONS.has(juris),
          noKmWarning: true,
        });
      }
    }

    jurisRows.sort((a,b) => a.jurisdiction.localeCompare(b.jurisdiction));
    const totalTaxDue = jurisRows
      .filter(r=>r.isIFTA && r.taxDue != null)
      .reduce((s,r) => s + r.taxDue + (r.surchargeDue||0), 0);

    results.push({
      ...truck, fuelEcon, flagged, effectiveLitres,
      jurisRows,
      totalKm: Math.round(truck.totalKm),
      totalLitresConsumed: Math.round(jurisRows.reduce((s,r)=>s+r.litresConsumed,0)),
      totalTaxable: Math.round(jurisRows.reduce((s,r)=>s+r.taxable,0)*10)/10,
      totalTaxDue: Math.round(totalTaxDue * 100) / 100,
    });
  }

  results.sort((a,b) => a.truckUnit.localeCompare(b.truckUnit));
  return results;
}

// ── PDF Export ───────────────────────────────────────────────────────────────
function exportIFTAPDF(results, quarter, unmatchedCount) {
  const pdf = new jsPDF({ orientation:"landscape" });
  const pageW = pdf.internal.pageSize.getWidth();

  // Header
  pdf.setFillColor(220, 38, 38);
  pdf.rect(0, 0, pageW, 4, "F");
  pdf.setFont("helvetica","bold");
  pdf.setFontSize(16);
  pdf.setTextColor(15, 15, 15);
  pdf.text("Diamond Back Express", 14, 16);
  pdf.setFontSize(12);
  pdf.setTextColor(220, 38, 38);
  pdf.text(`IFTA Fuel Tax Report — ${quarter}`, 14, 25);
  pdf.setFont("helvetica","normal");
  pdf.setFontSize(8);
  pdf.setTextColor(100,100,100);
  pdf.text(`Generated ${new Date().toLocaleString("en-CA")}`, pageW-14, 14, {align:"right"});
  if (unmatchedCount > 0) {
    pdf.setTextColor(220, 38, 38);
    pdf.text(`⚠ ${unmatchedCount} fuel transactions could not be matched to a truck unit`, 14, 31);
  }
  pdf.setDrawColor(220,220,220);
  pdf.line(14, 35, pageW-14, 35);

  // Fleet summary
  const totalKm = results.reduce((s,r)=>s+r.totalKm,0);
  const totalLitres = results.reduce((s,r)=>s+r.effectiveLitres,0);
  const totalTaxable = results.reduce((s,r)=>s+r.totalTaxable,0);
  const fleetEcon = totalKm > 0 ? (totalLitres/totalKm)*100 : 0;
  pdf.setFont("helvetica","normal");
  pdf.setFontSize(9);
  pdf.setTextColor(50,50,50);
  pdf.text(`Fleet: ${results.length} units   Total km: ${totalKm.toLocaleString()}   Total fuel: ${Math.round(totalLitres).toLocaleString()} L   Fleet avg: ${fleetEcon.toFixed(1)} L/100km   Net taxable: ${totalTaxable.toFixed(0)} L`, 14, 42);

  let y = 48;

  for (const truck of results) {
    if (y > 175) { pdf.addPage(); y = 14; }

    // Truck header bar
    pdf.setFillColor(15, 23, 42);
    pdf.rect(14, y, pageW-28, 10, "F");
    pdf.setFont("helvetica","bold");
    pdf.setFontSize(10);
    pdf.setTextColor(255,255,255);
    pdf.text(`Unit ${truck.truckUnit}${truck.driver?" — "+truck.driver:""}`, 18, y+7);
    const econStr = truck.fuelEcon ? `${truck.fuelEcon.toFixed(1)} L/100km` : "No fuel data";
    const taxStr  = truck.totalTaxDue != null ? `Tax: ${truck.totalTaxDue>0?"+":""}$${Math.abs(truck.totalTaxDue).toFixed(2)} CAD` : "";
    pdf.setTextColor(truck.flagged ? 255 : 200, truck.flagged ? 80 : 200, truck.flagged ? 80 : 200);
    pdf.text(`${truck.totalKm.toLocaleString()} km   ${Math.round(truck.effectiveLitres).toLocaleString()} L   ${econStr}   ${taxStr}${truck.flagged?" ⚠ REVIEW":""}`, pageW-18, y+7, {align:"right"});
    y += 14;

    autoTable(pdf, {
      startY: y,
      head: [["Juris.","KM","KM%","Consumed (L)","Purchased (L)","Net Taxable (L)","Rate CAD/L","Tax Due (CAD)"]],
      body: truck.jurisRows.filter(r=>r.isIFTA).map(r => [
        r.jurisdiction,
        r.km.toLocaleString("en-CA", {maximumFractionDigits:0}),
        (r.kmShare*100).toFixed(1)+"%",
        r.litresConsumed.toLocaleString("en-CA", {maximumFractionDigits:0}),
        r.litresPurchased>0 ? r.litresPurchased.toLocaleString("en-CA", {maximumFractionDigits:0}) : "—",
        (r.taxable>0?"+":"")+r.taxable.toLocaleString("en-CA", {maximumFractionDigits:0}),
        r.taxRate!=null ? r.taxRate.toFixed(4) : "—",
        r.taxDue!=null ? `${r.taxDue>0?"+":""}$${Math.abs(r.taxDue).toFixed(2)}${r.surchargeDue?` +$${r.surchargeDue.toFixed(2)}`:""}`:"—",
      ]),
      styles: { fontSize:7.5, cellPadding:2.5 },
      headStyles: { fillColor:[30,41,59], textColor:255, fontStyle:"bold", fontSize:7 },
      columnStyles: { 0:{fontStyle:"bold",cellWidth:16}, 5:{fontStyle:"bold"}, 7:{fontStyle:"bold"} },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        if (data.column.index === 5) {
          const v = parseFloat(String(data.cell.raw).replace(/[+,]/g,""));
          if (v>0) data.cell.styles.textColor=[220,38,38];
          if (v<0) data.cell.styles.textColor=[34,197,94];
        }
        if (data.column.index === 7) {
          const s = String(data.cell.raw);
          if (s.startsWith("+")) data.cell.styles.textColor=[220,38,38];
          else if (s.startsWith("-")) data.cell.styles.textColor=[34,197,94];
        }
      },
      margin: { left:14, right:14 },
    });

    y = pdf.lastAutoTable.finalY + 8;
    if (truck.adjustedLitres != null) {
      pdf.setFontSize(7); pdf.setTextColor(245,158,11);
      pdf.text(`⚠ Fuel manually adjusted: original ${Math.round(truck.totalLitres)} L → ${Math.round(truck.adjustedLitres)} L${truck.adjustNote?" ("+truck.adjustNote+")":""}`, 18, y);
      y += 6;
    }
  }

  pdf.save(`IFTA_${quarter.replace(/\s/g,"_")}.pdf`);
}

// ── Small UI components ──────────────────────────────────────────────────────
const sIn = {
  width:"100%", padding:"8px 10px", borderRadius:7, border:`1.5px solid ${T.border}`,
  background:T.bg, color:T.text, fontFamily:"inherit", fontSize:13, boxSizing:"border-box",
};
const sBtn = (col=T.red) => ({
  padding:"8px 16px", borderRadius:8, border:"none", background:col, color:"#fff",
  fontFamily:"inherit", fontWeight:700, fontSize:12, cursor:"pointer",
});
const sCard = {
  background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:16, marginBottom:12,
};

function StatCard({label, value, color, sub}) {
  return (
    <div style={{...sCard, flex:1, minWidth:130, marginBottom:0}}>
      <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{label}</div>
      <div style={{fontSize:22,fontWeight:800,color:color||T.text}}>{value}</div>
      {sub && <div style={{fontSize:11,color:T.dim,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function UploadZone({onFile, busy, label, accept=".xlsx,.xls"}) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDragOver={e=>{e.preventDefault();setDrag(true);}}
      onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files?.[0];if(f)onFile(f);}}
      onClick={()=>inputRef.current?.click()}
      style={{border:`2px dashed ${drag?T.red:T.border}`,borderRadius:10,padding:"20px 16px",
        textAlign:"center",cursor:"pointer",background:drag?T.redDim:T.surface,transition:"all 0.15s"}}
    >
      <input ref={inputRef} type="file" accept={accept} style={{display:"none"}}
        onChange={e=>{const f=e.target.files?.[0];if(f)onFile(f);e.target.value="";}}/>
      <div style={{fontSize:24,marginBottom:6}}>{busy?"⏳":"📂"}</div>
      <div style={{fontSize:13,fontWeight:600,color:T.text}}>{busy?"Processing...":label}</div>
      <div style={{fontSize:11,color:T.muted,marginTop:3}}>Drop file here or click to browse</div>
    </div>
  );
}

// ── IFTA Inc. Matrix File Parser ─────────────────────────────────────────────
// Parses the official IFTA Inc. quarterly tax matrix (XLS/XLSX/CSV download)
// from iftach.org → TaxDownload.php
// Each jurisdiction has two rows: "U.S." (USD/gal) then "Can" (CAD/L)
// We read the "Can" row, column 3 (Diesel/Special) → already in CAD/L, no conversion needed

const IFTA_JURIS_NAME_TO_CODE = {
  'ALBERTA':'AB','BRITISH COLUMBIA':'BC','MANITOBA':'MB','NEW BRUNSWICK':'NB',
  'NEWFOUNDLAND':'NL','NOVA SCOTIA':'NS','ONTARIO':'ON','PRINCE EDWARD ISLAND':'PE',
  'QUEBEC':'QC','SASKATCHEWAN':'SK',
  'ALABAMA':'AL','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA','COLORADO':'CO',
  'CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA','IDAHO':'ID',
  'ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA','KANSAS':'KS','KENTUCKY':'KY',
  'LOUISIANA':'LA','MAINE':'ME','MARYLAND':'MD','MASSACHUSETTS':'MA','MICHIGAN':'MI',
  'MINNESOTA':'MN','MISSISSIPPI':'MS','MISSOURI':'MO','MONTANA':'MT','NEBRASKA':'NE',
  'NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ','NEW MEXICO':'NM',
  'NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH',
  'OKLAHOMA':'OK','OREGON':'OR','PENNSYLVANIA':'PA','RHODE ISLAND':'RI',
  'SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD','TENNESSEE':'TN','TEXAS':'TX',
  'UTAH':'UT','VERMONT':'VT','VIRGINIA':'VA','WASHINGTON':'WA',
  'WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY',
};

function parseIFTAMatrix(wb) {
  // Find the data sheet (skip 'Footnotes')
  const sheetName = wb.SheetNames.find(n => !/footnote/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, defval:"", raw:false});
  if (!rows.length) return { error: "Empty file" };

  // Row 0 = quarter title e.g. "2nd Quarter 2026"
  const quarterRaw = String(rows[0]?.[0] || "").trim();
  const qm = quarterRaw.match(/(\d+)[a-z]* Quarter (\d{4})/i);
  const quarter = qm ? `Q${qm[1]} ${qm[2]}` : quarterRaw;

  const parseRate = (s) => {
    const v = String(s||"").replace(/[$,\s]/g,"").trim();
    if (!v || v === "-" || v === "$-") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : Math.round(n * 10000) / 10000;
  };

  const nameToCode = (rawName) => {
    // Strip footnote numbers: "ALBERTA #14" → "ALBERTA", "ONTARIO #5" → "ONTARIO"
    const clean = rawName.replace(/#\d+/g,"").replace(/SUR(CHG|CHARGE).*/i,"").trim().toUpperCase();
    if (IFTA_JURIS_NAME_TO_CODE[clean]) return IFTA_JURIS_NAME_TO_CODE[clean];
    // Partial match fallback
    for (const [name, code] of Object.entries(IFTA_JURIS_NAME_TO_CODE)) {
      if (clean.startsWith(name) || name.startsWith(clean)) return code;
    }
    return null;
  };

  const rates = {}, surcharges = {};

  for (let i = 3; i < rows.length; i++) {
    const col0 = String(rows[i]?.[0] || "").trim();
    const col1 = String(rows[i]?.[1] || "").trim();
    if (!col0 || col1 !== "U.S.") continue;

    const isSurchg = /SUR(CHG|CHARGE)/i.test(col0);
    const code = nameToCode(col0);
    if (!code) continue;

    // Next row should be the "Can" row with CAD/L rates
    const nextRow = rows[i + 1];
    if (!nextRow || String(nextRow[1]||"").trim() !== "Can") continue;

    // Column index 3 = Special/Diesel (the column we want)
    const dieselRate = parseRate(nextRow[3]);
    if (dieselRate !== null) {
      if (isSurchg) surcharges[code] = dieselRate;
      else rates[code] = dieselRate;
    }
    i++; // skip the Can row
  }

  const count = Object.keys(rates).length;
  if (count === 0) return { error: "No jurisdiction rates found — make sure you downloaded the XLS or CSV from iftach.org" };

  return { quarter, rates, surcharges, count, error: null };
}

// ── Tax Rates Tab ────────────────────────────────────────────────────────────
const ALL_JURISDICTIONS = [
  // Canadian provinces
  {code:"AB", name:"Alberta",             country:"CA"},
  {code:"BC", name:"British Columbia",    country:"CA"},
  {code:"MB", name:"Manitoba",            country:"CA"},
  {code:"NB", name:"New Brunswick",       country:"CA"},
  {code:"NL", name:"Newfoundland",        country:"CA"},
  {code:"NS", name:"Nova Scotia",         country:"CA"},
  {code:"ON", name:"Ontario",             country:"CA"},
  {code:"PE", name:"PEI",                 country:"CA"},
  {code:"QC", name:"Quebec",              country:"CA"},
  {code:"SK", name:"Saskatchewan",        country:"CA"},
  // US states
  {code:"AL", name:"Alabama",             country:"US"},
  {code:"AZ", name:"Arizona",             country:"US"},
  {code:"AR", name:"Arkansas",            country:"US"},
  {code:"CA", name:"California",          country:"US"},
  {code:"CO", name:"Colorado",            country:"US"},
  {code:"CT", name:"Connecticut",         country:"US"},
  {code:"DE", name:"Delaware",            country:"US"},
  {code:"FL", name:"Florida",             country:"US"},
  {code:"GA", name:"Georgia",             country:"US"},
  {code:"ID", name:"Idaho",               country:"US"},
  {code:"IL", name:"Illinois",            country:"US"},
  {code:"IN", name:"Indiana",             country:"US"},
  {code:"IA", name:"Iowa",                country:"US"},
  {code:"KS", name:"Kansas",              country:"US"},
  {code:"KY", name:"Kentucky",            country:"US"},
  {code:"LA", name:"Louisiana",           country:"US"},
  {code:"ME", name:"Maine",               country:"US"},
  {code:"MD", name:"Maryland",            country:"US"},
  {code:"MA", name:"Massachusetts",       country:"US"},
  {code:"MI", name:"Michigan",            country:"US"},
  {code:"MN", name:"Minnesota",           country:"US"},
  {code:"MS", name:"Mississippi",         country:"US"},
  {code:"MO", name:"Missouri",            country:"US"},
  {code:"MT", name:"Montana",             country:"US"},
  {code:"NE", name:"Nebraska",            country:"US"},
  {code:"NV", name:"Nevada",              country:"US"},
  {code:"NH", name:"New Hampshire",       country:"US"},
  {code:"NJ", name:"New Jersey",          country:"US"},
  {code:"NM", name:"New Mexico",          country:"US"},
  {code:"NY", name:"New York",            country:"US"},
  {code:"NC", name:"North Carolina",      country:"US"},
  {code:"ND", name:"North Dakota",        country:"US"},
  {code:"OH", name:"Ohio",                country:"US"},
  {code:"OK", name:"Oklahoma",            country:"US"},
  {code:"OR", name:"Oregon",              country:"US"},
  {code:"PA", name:"Pennsylvania",        country:"US"},
  {code:"RI", name:"Rhode Island",        country:"US"},
  {code:"SC", name:"South Carolina",      country:"US"},
  {code:"SD", name:"South Dakota",        country:"US"},
  {code:"TN", name:"Tennessee",           country:"US"},
  {code:"TX", name:"Texas",               country:"US"},
  {code:"UT", name:"Utah",                country:"US"},
  {code:"VT", name:"Vermont",             country:"US"},
  {code:"VA", name:"Virginia",            country:"US"},
  {code:"WA", name:"Washington",          country:"US"},
  {code:"WV", name:"West Virginia",       country:"US"},
  {code:"WI", name:"Wisconsin",           country:"US"},
  {code:"WY", name:"Wyoming",             country:"US"},
];

function TaxRatesTab({ liveRates, liveSurch, onSave }) {
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  const handleMatrixFile = async (file) => {
    setImportBusy(true); setImportMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:"array", raw:false});
      const result = parseIFTAMatrix(wb);
      if (result.error) {
        setImportMsg({ok:false, text:result.error});
      } else {
        await onSave(result.quarter, result.rates, result.surcharges);
        setImportMsg({ok:true, text:`✅ Imported ${result.count} jurisdiction rates for ${result.quarter} — ${Object.keys(result.surcharges).length} surcharge states included. Rates are now live.`});
        setSelectedQ(result.quarter);
      }
    } catch(e) {
      setImportMsg({ok:false, text:"Failed to parse file: "+e.message});
    }
    setImportBusy(false);
  };
  // All available quarters — hardcoded seeds + any saved in Firestore
  const allQuarters = useMemo(() => {
    const built = new Set(["Q2 2026"]);
    Object.keys(liveRates).forEach(q => built.add(q));
    return [...built].sort().reverse();
  }, [liveRates]);

  const [selectedQ, setSelectedQ] = useState(allQuarters[0] || "Q2 2026");
  const [newQName, setNewQName] = useState("");
  const [copyFrom, setCopyFrom] = useState(allQuarters[0] || "Q2 2026");
  const [editRates, setEditRates] = useState(null);    // {jurisCode: value}
  const [editSurch, setEditSurch] = useState(null);    // {jurisCode: value}
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState(""); // search filter
  const [showAll, setShowAll] = useState(false); // show all 58 vs your routes only

  // Seed edit state from selected quarter
  useEffect(() => {
    const baseRates = liveRates[selectedQ] || RATE_TABLES[selectedQ] || RATE_TABLES["Q2 2026"] || {};
    const baseSurch = liveSurch[selectedQ] || SURCHARGE_TABLES[selectedQ] || SURCHARGE_TABLES["Q2 2026"] || {};
    setEditRates({...baseRates});
    setEditSurch({...baseSurch});
    setSaved(false);
  }, [selectedQ, liveRates, liveSurch]);

  const handleSave = async () => {
    setSaving(true);
    // Strip empty strings, convert to numbers
    const cleanRates = {};
    const cleanSurch = {};
    Object.entries(editRates||{}).forEach(([k,v]) => { const n=parseFloat(v); if(!isNaN(n)) cleanRates[k]=Math.round(n*10000)/10000; });
    Object.entries(editSurch||{}).forEach(([k,v]) => { const n=parseFloat(v); if(!isNaN(n)&&n>0) cleanSurch[k]=Math.round(n*10000)/10000; });
    await onSave(selectedQ, cleanRates, cleanSurch);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleAddQuarter = () => {
    if (!newQName.trim()) return;
    const q = newQName.trim();
    // Copy rates from copyFrom quarter as starting point
    const baseRates = liveRates[copyFrom] || RATE_TABLES[copyFrom] || RATE_TABLES["Q2 2026"] || {};
    const baseSurch = liveSurch[copyFrom] || SURCHARGE_TABLES[copyFrom] || {};
    onSave(q, {...baseRates}, {...baseSurch});
    setSelectedQ(q);
    setNewQName("");
  };

  const setRate  = (code, val) => setEditRates(p => ({...p, [code]: val}));
  const setSurch = (code, val) => setEditSurch(p => ({...p, [code]: val}));

  // Your typical routes — pre-filtered for relevance
  const YOUR_ROUTES = new Set(["ON","QC","AB","MB","SK","BC","FL","NC","NY","PA","MO","MI","TX","GA","VA","MD","NJ","OH","IN","IL","AR","TN","SC","DE","CT","IA","MN","ND","SD","NE","KS","OK","LA","MS","AL"]);

  const visibleJuris = ALL_JURISDICTIONS.filter(j => {
    const matchFilter = !filter || j.code.includes(filter.toUpperCase()) || j.name.toLowerCase().includes(filter.toLowerCase());
    const inRoutes = showAll || YOUR_ROUTES.has(j.code);
    return matchFilter && inRoutes;
  });

  const changedFromSeed = useMemo(() => {
    if (!editRates) return {};
    const seedRates = RATE_TABLES["Q2 2026"] || {};
    const changed = {};
    Object.entries(editRates).forEach(([k,v]) => {
      if (parseFloat(v) !== seedRates[k]) changed[k] = true;
    });
    return changed;
  }, [editRates]);

  return (
    <div style={{maxWidth:900}}>

      {/* ── Matrix Import — primary workflow ── */}
      <div style={{background:"linear-gradient(135deg,#1e293b 0%,#0f172a 100%)",border:`1px solid ${T.border}`,borderLeft:`4px solid ${T.green}`,borderRadius:10,padding:"16px 18px",marginBottom:20}}>
        <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:4}}>📥 Import IFTA Tax Matrix — Fastest Way</div>
        <div style={{fontSize:12,color:T.muted,marginBottom:12,lineHeight:1.6}}>
          Go to <a href="https://www.iftach.org/taxmatrix4/TaxDownload.php" target="_blank" rel="noopener noreferrer" style={{color:T.blue,fontWeight:600}}>iftach.org → TaxDownload</a>, pick your quarter (e.g. 2Q2026), click <strong style={{color:T.text}}>EXCEL</strong> or <strong style={{color:T.text}}>CSV</strong>, then drop the file here. All 58 jurisdiction diesel rates import in one shot — quarter name auto-detected, no typing needed.
        </div>
        <UploadZone onFile={handleMatrixFile} busy={importBusy} label="Drop IFTA matrix file here (XLS, XLSX or CSV)" accept=".xls,.xlsx,.csv"/>
        {importMsg && (
          <div style={{marginTop:10,padding:"9px 12px",borderRadius:7,fontSize:12,fontWeight:600,
            background:importMsg.ok?T.greenDim:T.redDim, color:importMsg.ok?T.green:T.red,
            border:`1px solid ${importMsg.ok?T.green:T.red}`}}>
            {importMsg.text}
          </div>
        )}
      </div>

      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <div style={{flex:1,height:1,background:T.border}}/>
        <span style={{fontSize:11,color:T.dim,whiteSpace:"nowrap"}}>or review and edit rates manually below</span>
        <div style={{flex:1,height:1,background:T.border}}/>
      </div>

      <div style={{fontSize:13,color:T.muted,marginBottom:16,lineHeight:1.6}}>
        Edit diesel tax rates here instead of in code. Rates are in <strong style={{color:T.text}}>CAD per litre</strong> for all jurisdictions (US rates are pre-converted). Check <strong style={{color:T.blue}}>iftach.org</strong> for the new quarter's rates — typically only a few jurisdictions change each quarter.
      </div>

      {/* Quarter selector + new quarter */}
      <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:16,flexWrap:"wrap"}}>
        <div>
          <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Quarter</label>
          <select value={selectedQ} onChange={e=>setSelectedQ(e.target.value)} style={{...sIn,width:140,padding:"8px 10px"}}>
            {allQuarters.map(q=><option key={q} value={q}>{q}</option>)}
          </select>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>New Quarter</label>
            <input value={newQName} onChange={e=>setNewQName(e.target.value)} placeholder="e.g. Q3 2026"
              style={{...sIn,width:130,padding:"8px 10px"}}/>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Copy rates from</label>
            <select value={copyFrom} onChange={e=>setCopyFrom(e.target.value)} style={{...sIn,width:120,padding:"8px 10px"}}>
              {allQuarters.map(q=><option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <button onClick={handleAddQuarter} disabled={!newQName.trim()}
            style={{padding:"8px 14px",borderRadius:8,border:`1px solid ${T.border}`,background:T.surface,color:T.text,fontFamily:"inherit",fontWeight:600,fontSize:12,cursor:"pointer"}}>
            + Add Quarter
          </button>
        </div>
      </div>

      {/* Source note for selected quarter */}
      <div style={{fontSize:11,color:T.dim,marginBottom:12}}>
        {liveRates[selectedQ]
          ? `✅ Showing rates saved in your dispatch system for ${selectedQ}`
          : `📋 Showing built-in seed rates for ${selectedQ} — save to lock these in`}
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:12,flexWrap:"wrap"}}>
        <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search jurisdiction..."
          style={{...sIn,width:200,padding:"7px 10px",fontSize:12}}/>
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:T.muted,cursor:"pointer"}}>
          <input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/>
          Show all 58 jurisdictions
        </label>
        <span style={{fontSize:11,color:T.dim}}>{visibleJuris.length} shown</span>
      </div>

      {/* Rate table */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden",marginBottom:14}}>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr style={{background:T.surface}}>
                {["Code","Jurisdiction","Country","Tax Rate (CAD/L)","Surcharge (CAD/L)","Change from Q2 2026"].map(h=>(
                  <th key={h} style={{padding:"9px 12px",textAlign:"left",color:T.muted,fontWeight:700,fontSize:10,textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleJuris.map(j => {
                const rateVal = editRates?.[j.code] ?? "";
                const surchVal = editSurch?.[j.code] ?? "";
                const seedRate = (RATE_TABLES["Q2 2026"] || {})[j.code];
                const changed = changedFromSeed[j.code];
                const diff = seedRate != null && rateVal !== "" ? (parseFloat(rateVal) - seedRate) : null;
                return (
                  <tr key={j.code} style={{borderTop:`1px solid ${T.border}`,background:changed?"rgba(14,165,233,0.04)":"transparent"}}>
                    <td style={{padding:"7px 12px",fontWeight:700,color:T.text}}>{j.code}</td>
                    <td style={{padding:"7px 12px",color:T.text}}>{j.name}</td>
                    <td style={{padding:"7px 12px"}}>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:5,
                        background:j.country==="CA"?"rgba(220,38,38,0.12)":"rgba(14,165,233,0.12)",
                        color:j.country==="CA"?T.red:T.blue}}>
                        {j.country==="CA"?"🍁 CA":"🇺🇸 US"}
                      </span>
                    </td>
                    <td style={{padding:"7px 12px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <input type="number" step="0.0001" value={rateVal}
                          onChange={e=>setRate(j.code,e.target.value)}
                          style={{width:90,padding:"5px 7px",borderRadius:6,border:`1.5px solid ${changed?T.blue:T.border}`,background:T.bg,color:T.text,fontFamily:"inherit",fontSize:12,boxSizing:"border-box"}}/>
                        {j.country==="CA"
                          ? <span style={{fontSize:10,color:T.dim}}>CAD/L</span>
                          : <span style={{fontSize:10,color:T.dim}}>CAD/L</span>}
                      </div>
                    </td>
                    <td style={{padding:"7px 12px"}}>
                      <input type="number" step="0.0001" value={surchVal}
                        onChange={e=>setSurch(j.code,e.target.value)}
                        placeholder="0"
                        style={{width:80,padding:"5px 7px",borderRadius:6,border:`1.5px solid ${surchVal&&parseFloat(surchVal)>0?T.amber:T.border}`,background:T.bg,color:T.text,fontFamily:"inherit",fontSize:12,boxSizing:"border-box"}}/>
                    </td>
                    <td style={{padding:"7px 12px",fontSize:11}}>
                      {diff != null && Math.abs(diff) > 0.00005
                        ? <span style={{color:diff>0?T.red:T.green,fontWeight:600}}>{diff>0?"+":""}{diff.toFixed(4)}</span>
                        : <span style={{color:T.dim}}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Save button */}
      <div style={{display:"flex",gap:10,alignItems:"center"}}>
        <button onClick={handleSave} disabled={saving}
          style={{...sBtn(),padding:"10px 24px",fontSize:13}}>
          {saving?"Saving...":`💾 Save ${selectedQ} Rates`}
        </button>
        {saved && <span style={{fontSize:13,color:T.green,fontWeight:600}}>✅ Saved — report will recalculate automatically</span>}
      </div>

      <div style={{marginTop:14,fontSize:12,color:T.dim,lineHeight:1.7}}>
        <strong style={{color:T.muted}}>How to update for a new quarter:</strong><br/>
        1. Go to <a href="https://www.iftach.org/taxmatrix4/" target="_blank" rel="noopener noreferrer" style={{color:T.blue}}>iftach.org/taxmatrix4</a> → select the new quarter → look for jurisdictions marked as changed<br/>
        2. Click "+ Add Quarter" above, name it (e.g. Q3 2026), and copy from the previous quarter<br/>
        3. Only change the rates that are different — usually just 2–5 jurisdictions per quarter<br/>
        4. US rates on iftach.org are in USD/gallon. Convert to CAD/L: <strong style={{color:T.text}}>rate × exchange_rate ÷ 3.785</strong><br/>
        5. Click Save — the calculation updates immediately, no deploy needed
      </div>
    </div>
  );
}

// ── Fuel Cards Settings ──────────────────────────────────────────────────────
function FuelCardsTab() {
  const [cards, setCards] = useState([]);
  const [form, setForm] = useState({nomadUnit:"", cardNumber:"", truckUnit:"", driverName:"", network:"", notes:""});
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db,"iftaFuelCards"));
      setCards(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.truckUnit.localeCompare(b.truckUnit)));
    } catch(e){console.error(e);}
    setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const reset = () => { setForm({nomadUnit:"",cardNumber:"",truckUnit:"",driverName:"",network:"",notes:""}); setEditId(null); };

  const save = async () => {
    if (!form.truckUnit) return;
    setSaving(true);
    try {
      if (editId) {
        await updateDoc(doc(db,"iftaFuelCards",editId), form);
      } else {
        await addDoc(collection(db,"iftaFuelCards"), {...form, createdAt:new Date().toISOString()});
      }
      await load(); reset();
    } catch(e){console.error(e);}
    setSaving(false);
  };

  const remove = async (id) => {
    if (!window.confirm("Remove this fuel card mapping?")) return;
    await deleteDoc(doc(db,"iftaFuelCards",id));
    await load();
  };

  const startEdit = (card) => { setForm({nomadUnit:card.nomadUnit||"",cardNumber:card.cardNumber||"",truckUnit:card.truckUnit||"",driverName:card.driverName||"",network:card.network||"",notes:card.notes||""}); setEditId(card.id); };

  return (
    <div style={{maxWidth:900}}>
      <div style={{fontSize:13,color:T.muted,marginBottom:16,lineHeight:1.6}}>
        Map non-standard Nomad unit IDs (Pipeline card numbers, WEX anomaly IDs) to your Geotab truck units.
        Standard 4-digit IDs like <code style={{background:T.surface,padding:"1px 5px",borderRadius:4,color:T.amber}}>1906</code> → <code style={{background:T.surface,padding:"1px 5px",borderRadius:4,color:T.green}}>19-06</code> are converted automatically — only add entries here for the ones that don't follow that pattern.
      </div>

      {/* Add/Edit form */}
      <div style={sCard}>
        <div style={{fontSize:12,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>
          {editId ? "✏️ Edit Mapping" : "+ Add Card Mapping"}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Nomad Unit # <span style={{color:T.dim}}>(as it appears in the file)</span></label>
            <input style={sIn} value={form.nomadUnit} onChange={e=>setForm(p=>({...p,nomadUnit:e.target.value}))} placeholder="e.g. 1201327"/>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Card Number</label>
            <input style={sIn} value={form.cardNumber} onChange={e=>setForm(p=>({...p,cardNumber:e.target.value}))} placeholder="e.g. ****8001327"/>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Geotab Truck Unit <span style={{color:T.red}}>*</span></label>
            <input style={sIn} value={form.truckUnit} onChange={e=>setForm(p=>({...p,truckUnit:e.target.value}))} placeholder="e.g. 19-06"/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Driver Name</label>
            <input style={sIn} value={form.driverName} onChange={e=>setForm(p=>({...p,driverName:e.target.value}))} placeholder="e.g. Imran Haider"/>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Network</label>
            <select style={sIn} value={form.network} onChange={e=>setForm(p=>({...p,network:e.target.value}))}>
              <option value="">Select...</option>
              <option>WEX</option><option>PIPELINE</option><option>EFS</option><option>Other</option>
            </select>
          </div>
          <div>
            <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Notes</label>
            <input style={sIn} value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="e.g. Reefer unit on 19-06"/>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={save} disabled={saving||!form.truckUnit} style={sBtn()}>{saving?"Saving...":editId?"Update Mapping":"Add Mapping"}</button>
          {editId && <button onClick={reset} style={{...sBtn(T.surface),color:T.muted,border:`1px solid ${T.border}`}}>Cancel</button>}
        </div>
      </div>

      {/* Cards table */}
      {loading ? <div style={{color:T.muted,fontSize:13}}>Loading...</div> : (
        cards.length === 0 ? (
          <div style={{textAlign:"center",padding:32,color:T.muted,fontSize:13}}>
            <div style={{fontSize:28,marginBottom:8}}>🃏</div>
            No manual mappings yet — standard 4-digit unit IDs are handled automatically.
          </div>
        ) : (
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{background:T.surface}}>
                  {["Nomad Unit","Card Number","→ Geotab Truck","Driver","Network","Notes",""].map(h=>(
                    <th key={h} style={{textAlign:"left",padding:"10px 12px",color:T.muted,fontWeight:700,fontSize:10,textTransform:"uppercase"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cards.map((c,i)=>(
                  <tr key={c.id} style={{borderTop:`1px solid ${T.border}`}}>
                    <td style={{padding:"10px 12px",color:T.amber,fontWeight:600}}>{c.nomadUnit||"—"}</td>
                    <td style={{padding:"10px 12px",color:T.dim}}>{c.cardNumber||"—"}</td>
                    <td style={{padding:"10px 12px",color:T.green,fontWeight:700}}>{c.truckUnit}</td>
                    <td style={{padding:"10px 12px",color:T.text}}>{c.driverName||"—"}</td>
                    <td style={{padding:"10px 12px",color:T.muted}}>{c.network||"—"}</td>
                    <td style={{padding:"10px 12px",color:T.dim,fontSize:11}}>{c.notes||""}</td>
                    <td style={{padding:"10px 12px"}}>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>startEdit(c)} style={{padding:"3px 10px",borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Edit</button>
                        <button onClick={()=>remove(c.id)} style={{padding:"3px 10px",borderRadius:6,border:`1px solid ${T.red}`,background:"transparent",color:T.red,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ── Main IFTA Page ───────────────────────────────────────────────────────────
export default function IFTAPage() {
  const [tab, setTab] = useState("guide"); // guide | upload | report | history | setup

  // Upload state
  const [nomadFiles, setNomadFiles] = useState([]); // [{name, transactions, errors, isCAN}]
  const [geotabData, setGeotabData] = useState(null); // {records, errors}
  const [busyNomad, setBusyNomad] = useState(false);
  const [busyGeotab, setBusyGeotab] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);
  const [quarter, setQuarter] = useState(() => {
    const now = new Date();
    const q = Math.ceil((now.getMonth()+1)/3);
    return `Q${q} ${now.getFullYear()}`;
  });

  // Report state
  const [results, setResults] = useState([]);
  const [adjustments, setAdjustments] = useState({}); // {truckUnit: {adjustedLitres, note}}
  const [expandedTruck, setExpandedTruck] = useState(null);
  const [fuelCardMap, setFuelCardMap] = useState([]);
  const [liveRates, setLiveRates] = useState({});   // {quarter: {juris: rate}}
  const [liveSurch, setLiveSurch] = useState({});   // {quarter: {juris: rate}}

  // History
  const [history, setHistory] = useState([]);

  // Load fuel card map, history, and live rates on mount
  useEffect(() => {
    getDocs(collection(db,"iftaFuelCards"))
      .then(snap => setFuelCardMap(snap.docs.map(d=>({id:d.id,...d.data()}))))
      .catch(console.error);
    getDocs(query(collection(db,"iftaReports")))
      .then(snap => {
        const docs = snap.docs.map(d=>({id:d.id,...d.data()}));
        docs.sort((a,b)=>(b.savedAt||"").localeCompare(a.savedAt||""));
        setHistory(docs);
      })
      .catch(console.error);
    // Load live rates from Firestore — each doc is one quarter
    getDocs(collection(db,"iftaRates"))
      .then(snap => {
        const rates={}, surch={};
        snap.docs.forEach(d => {
          const data = d.data();
          if (data.quarter && data.rates)     rates[data.quarter]  = data.rates;
          if (data.quarter && data.surcharges) surch[data.quarter] = data.surcharges;
        });
        setLiveRates(rates);
        setLiveSurch(surch);
      })
      .catch(console.error);
  }, []);

  // Recalculate whenever uploads change
  useEffect(() => {
    const allTx = nomadFiles.flatMap(f => f.transactions || []);
    const allGeo = geotabData?.records || [];
    if (allTx.length > 0 || allGeo.length > 0) {
      setResults(calculateIFTA(allGeo, allTx, adjustments, quarter, liveRates, liveSurch));
    }
  }, [nomadFiles, geotabData, adjustments, quarter, liveRates, liveSurch]);

  const handleNomadFile = async (file) => {
    setBusyNomad(true); setUploadMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:"array", raw:false});
      if (!detectNomadFile(wb)) {
        setUploadMsg({ok:false, text:`"${file.name}" doesn't look like a Nomad fuel card export.`});
        setBusyNomad(false); return;
      }
      const parsed = parseNomadFile(wb, fuelCardMap);
      setNomadFiles(prev => {
        const others = prev.filter(f=>f.name!==file.name);
        return [...others, {...parsed, name:file.name}];
      });
      setUploadMsg({ok:true, text:`✅ "${file.name}" — ${parsed.transactions.length} diesel transactions imported${parsed.errors.length>0?`, ${parsed.errors.length} unmatched (check report tab)`:"."}`});
      setTab("report");
    } catch(e) {
      setUploadMsg({ok:false, text:"Failed to parse file: "+e.message});
    }
    setBusyNomad(false);
  };

  const handleGeotabFile = async (file) => {
    setBusyGeotab(true); setUploadMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:"array", raw:false});
      if (!detectGeotabFile(wb)) {
        setUploadMsg({ok:false, text:`"${file.name}" doesn't look like a Geotab IFTA report.`});
        setBusyGeotab(false); return;
      }
      const parsed = parseGeotabFile(wb);
      setGeotabData({...parsed, name:file.name});
      setUploadMsg({ok:true, text:`✅ "${file.name}" — ${parsed.records.length} jurisdiction records across ${new Set(parsed.records.map(r=>r.truckUnit)).size} vehicles.`});
      setTab("report");
    } catch(e) {
      setUploadMsg({ok:false, text:"Failed to parse file: "+e.message});
    }
    setBusyGeotab(false);
  };

  const allTransactions = nomadFiles.flatMap(f=>f.transactions||[]);
  const allErrors = nomadFiles.flatMap(f=>f.errors||[]);
  const totalKm = results.reduce((s,r)=>s+r.totalKm,0);
  const totalLitres = results.reduce((s,r)=>s+r.effectiveLitres,0);
  const totalTaxable = results.reduce((s,r)=>s+r.totalTaxable,0);
  const fleetEcon = totalKm>0 && totalLitres>0 ? (totalLitres/totalKm)*100 : null;
  const totalFleetTaxDue = useMemo(() => results.reduce((s,r)=>s+(r.totalTaxDue||0),0), [results]);
  const flaggedCount = results.filter(r=>r.flagged).length;

  const saveReport = async () => {
    const data = {
      quarter, savedAt:new Date().toISOString(),
      results: results.map(r=>({...r,jurisRows:r.jurisRows})),
      adjustments, totalKm, totalLitres, totalTaxable, fleetEcon,
      unmatchedCount: allErrors.length,
    };
    await addDoc(collection(db,"iftaReports"), data);
    alert(`Report saved to history as ${quarter}.`);
    const snap = await getDocs(query(collection(db,"iftaReports")));
    const docs = snap.docs.map(d=>({id:d.id,...d.data()}));
    docs.sort((a,b)=>(b.savedAt||"").localeCompare(a.savedAt||""));
    setHistory(docs);
  };

  const loadHistoricReport = (rep) => {
    setResults(rep.results||[]);
    setAdjustments(rep.adjustments||{});
    setQuarter(rep.quarter||"");
    setTab("report");
  };

  const setAdj = (truckUnit, field, value) => {
    setAdjustments(prev=>({...prev, [truckUnit]:{...(prev[truckUnit]||{}), [field]:value}}));
  };

  return (
    <div style={{padding:24, maxWidth:1400, margin:"0 auto"}}>
      {/* Page header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:700,color:T.text,margin:0}}>IFTA</h1>
          <div style={{fontSize:13,color:T.muted,marginTop:2}}>Quarterly fuel tax reporting — upload Nomad + Geotab exports</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <label style={{fontSize:11,color:T.muted}}>Quarter:</label>
          <input value={quarter} onChange={e=>setQuarter(e.target.value)}
            style={{...sIn, width:100, padding:"6px 10px", fontSize:12}} placeholder="Q2 2026"/>
          {results.length>0 && <>
            <button onClick={()=>exportIFTAPDF(results,quarter,allErrors.length)} style={sBtn()}>📄 Export PDF</button>
            <button onClick={saveReport} style={{...sBtn("#0ea5e9")}}>💾 Save Report</button>
          </>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:20,borderBottom:`1px solid ${T.border}`,paddingBottom:0}}>
        {[
          {id:"guide",   l:"📋 How-To Guide"},
          {id:"upload",  l:"📂 Upload Files"},
          {id:"report",  l:`📊 Report${results.length>0?` (${results.length} units)`:""}` },
          {id:"history", l:`🕐 History${history.length>0?` (${history.length})`:""}` },
          {id:"rates",   l:"💲 Tax Rates"},
          {id:"setup",   l:"🃏 Fuel Cards"},
        ].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            padding:"8px 16px", borderRadius:"8px 8px 0 0",
            border:`1px solid ${tab===t.id?T.border:"transparent"}`, borderBottom:"none",
            background:tab===t.id?T.card:"transparent",
            color:tab===t.id?T.text:T.muted,
            fontSize:12,fontWeight:tab===t.id?700:400,cursor:"pointer",fontFamily:"inherit",
            marginBottom: tab===t.id?"-1px":"0",
          }}>{t.l}</button>
        ))}
      </div>

      {/* ── GUIDE TAB ── */}
      {tab==="guide" && (
        <div style={{maxWidth:820}}>

          {/* Header banner */}
          <div style={{background:"linear-gradient(135deg,#1e293b 0%,#0f172a 100%)",border:`1px solid ${T.border}`,borderLeft:`4px solid ${T.red}`,borderRadius:10,padding:"18px 20px",marginBottom:24}}>
            <div style={{fontSize:16,fontWeight:800,color:T.text,marginBottom:4}}>IFTA Quarterly Filing — Complete Process Guide</div>
            <div style={{fontSize:13,color:T.muted,lineHeight:1.6}}>
              IFTA (International Fuel Tax Agreement) is filed <strong style={{color:T.text}}>4 times a year</strong>. You report fuel purchased and kilometres driven in each province/state, and pay (or receive credit for) the fuel tax difference.
              DBX is registered in <strong style={{color:T.text}}>Ontario</strong> — you file with the Ontario Ministry of Finance via ONT-TAXS.
            </div>
            <div style={{display:"flex",gap:16,marginTop:14,flexWrap:"wrap"}}>
              {[
                {q:"Q1 (Jan–Mar)", due:"April 30"},
                {q:"Q2 (Apr–Jun)", due:"July 31"},
                {q:"Q3 (Jul–Sep)", due:"October 31"},
                {q:"Q4 (Oct–Dec)", due:"January 31"},
              ].map(d=>(
                <div key={d.q} style={{background:"rgba(220,38,38,0.1)",border:`1px solid rgba(220,38,38,0.3)`,borderRadius:7,padding:"6px 12px",fontSize:11,color:T.text}}>
                  <span style={{fontWeight:700,color:T.red}}>{d.q}</span> <span style={{color:T.muted}}>→ due</span> <span style={{fontWeight:600}}>{d.due}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Steps */}
          {[
            {
              num:"01",
              title:"Update tax rates (if new quarter)",
              timing:"Once per quarter — do this first",
              color:"#8b5cf6",
              icon:"📅",
              steps:[
                "Go to the 💲 Tax Rates tab in the IFTA module",
                "Open iftach.org/taxmatrix4/TaxDownload.php in another tab",
                "Select your quarter (e.g. 2Q2026) and click EXCEL or CSV to download the file",
                "Drop that file into the Tax Rates tab upload zone — all 58 jurisdiction rates update in one shot, quarter name is detected automatically",
                "That's it. No manual entry, no code editor needed",
              ],
              note:"The IFTA Inc. matrix file includes diesel rates in CAD/L for Canadian provinces directly — no conversion needed. Takes about 2 minutes per quarter. If rates didn't change from last quarter (check iftach.org for 'Changes this quarter'), you can skip this step entirely.",
            },
            {
              num:"02",
              title:"Export Geotab IFTA report",
              timing:"After the quarter ends",
              color:"#0ea5e9",
              icon:"📍",
              steps:[
                "Log into MyGeotab (my.geotab.com)",
                "Go to Reports → Fuel Tax → IFTA Report (GPS Based)",
                'Set the date range to the full quarter (e.g. April 1 – June 30 for Q2)',
                "Make sure Distance Unit is set to km",
                "Export as .xlsx and save as something like Geotab_IFTA_Q2_2026.xlsx",
                "This file gives you kilometres driven per truck per jurisdiction — the foundation of the whole calculation",
              ],
              note:"This is the file that tells us HOW MUCH you drove in each province/state. Without it, we cannot calculate fuel consumed per jurisdiction.",
            },
            {
              num:"03",
              title:"Export Nomad fuel card reports",
              timing:"After the quarter ends",
              color:"#f59e0b",
              icon:"⛽",
              steps:[
                "Log into your Nomad fuel card portal",
                "Export the IFTA Report for Canada for the full quarter → save as NOMAD_CAN_Q2_2026.xlsx",
                "Export the IFTA Report for USA for the full quarter → save as NOMAD_USA_Q2_2026.xlsx",
                "These files tell us WHERE and HOW MUCH diesel was purchased (the tax already paid at the pump)",
                "Upload both files separately in the Upload Files tab — the app merges them automatically",
              ],
              note:"You need both CAN and USA reports even if your trucks rarely cross the border — some US fuel purchases may exist.",
            },
            {
              num:"04",
              title:"Upload all three files",
              timing:"Takes about 2 minutes",
              color:T.green,
              icon:"📂",
              steps:[
                "Go to the Upload Files tab",
                "Confirm the Quarter field shows the correct period (e.g. Q2 2026)",
                "Drop the Nomad CAN file in the left zone — you'll see a green ✅ confirmation",
                "Drop the Nomad USA file in the same left zone — it merges with CAN automatically",
                "Drop the Geotab IFTA file in the right zone — you'll see vehicle and record counts",
                "The Report tab will populate automatically once both sides are uploaded",
              ],
              note:"If you see a yellow warning about unmatched transactions, those are Pipeline card IDs that need to be added to the Fuel Cards table (see Step 5). They are excluded from the calculation until mapped.",
            },
            {
              num:"05",
              title:"Map unmatched Pipeline cards (first time only)",
              timing:"One-time setup, then maintain as cards change",
              color:"#f97316",
              icon:"🃏",
              steps:[
                "If the Upload tab shows unmatched transactions, go to the Fuel Cards tab",
                "Each unmatched row shows a Nomad Unit ID (e.g. 1201329), a driver name, and the network (PIPELINE)",
                "For each one, add a mapping: Nomad Unit ID → Geotab Truck Unit (e.g. 1201329 → 20-09)",
                "Once saved, go back to Upload Files and re-upload the Nomad files — those transactions will now resolve",
                "You only need to do this once per card. Next quarter, the same mappings are already saved",
                "Standard 4-digit WEX units (1906, 2009, etc.) convert automatically — you only need to map the Pipeline numbers",
              ],
              note:"Your 13 Pipeline card IDs from Q2 2026 represent about 88,000 litres of fuel. Mapping them will significantly change the final tax number.",
            },
            {
              num:"06",
              title:"Review the report and fix flagged trucks",
              timing:"15–30 minutes",
              color:T.red,
              icon:"📊",
              steps:[
                "Go to the Report tab — you'll see the fleet summary and a row per truck",
                "Check the fleet L/100km figure. Typical heavy truck range: 20–50 L/100km on highway",
                "Any truck flagged ⚠ REVIEW has a fuel economy outside the acceptable range (under 20 or over 80 L/100km)",
                "Click the truck row to expand it — see the per-jurisdiction breakdown",
                "If a truck's fuel economy is wrong (too high = fuel assigned to wrong truck, too low = GPS km not matched), use the Adjusted Litres field to correct it",
                "Enter a reason for any adjustment — this is your audit trail if CRA or Ontario ever audits you",
                "Common fix: a Pipeline card mapped to the wrong truck inflates one unit's fuel. Correct the Fuel Cards mapping and recalculate",
              ],
              note:"The ⚠ flag is a safety net, not an error. Some trucks with many idle hours or short local routes may legitimately have unusual economy. Use your knowledge of the fleet to judge.",
            },
            {
              num:"07",
              title:"Export the PDF and save the report",
              timing:"5 minutes",
              color:T.muted,
              icon:"📄",
              steps:[
                "Once you're satisfied with the numbers, click Export PDF at the top right",
                "The PDF shows every truck, every jurisdiction, rate (CAD/L), and Tax Due (CAD)",
                "Also click Save Report — this archives the calculation so you can load it back later without re-uploading files",
                "Keep the PDF for your records — it is your supporting documentation for the IFTA filing",
              ],
              note:"Ontario requires you to keep supporting records for 4 years in case of audit. The PDF plus your original Geotab and Nomad exports are sufficient documentation.",
            },
            {
              num:"08",
              title:"File on ONT-TAXS and pay",
              timing:"20–30 minutes",
              color:"#22c55e",
              icon:"🏛️",
              steps:[
                "Log into ONT-TAXS online at ontario.ca/TaxServices (create an account if you don't have one — it's free)",
                "Navigate to your IFTA account and start a new quarterly return",
                "In Section A: enter Total KM Everywhere (fleet total from our Report summary card)",
                "In Section B: enter Total Litres Everywhere (fleet total from our Report summary card)",
                "Section C (KPL / Average KM per Litre) calculates automatically: A ÷ B",
                "OPTION 1 — Excel Upload (fastest): ONT-TAXS lets you upload your entire Tax Schedule as an Excel file. Download their template from inside ONT-TAXS, then ask us to generate a pre-filled version matching their format from your report data",
                "OPTION 2 — Manual entry: In the Tax Schedule, enter one line per jurisdiction — use the values from our PDF (KM driven, fuel consumed, fuel purchased, net taxable, rate, tax due)",
                "P (Total Tax Due) and Q (Total Interest) from the schedule transfer to Lines 1 and 3 on the front of the return",
                "Review the total, submit the return, and print the confirmation page for your records",
                "Pay online (preferred) or by cheque payable to Minister of Finance — NOT at a bank",
                "If the result is negative (credit), Ontario will issue a refund after verifying your return",
              ],
              note:"You are licensed in Ontario so your base jurisdiction is ON. Only include jurisdictions where you actually drove. Credits are entered in brackets ( ) per form instructions. The Excel upload option inside ONT-TAXS can save significant time — download their template once and we can auto-fill it from your report data.",
            },
          ].map((step, si) => (
            <div key={step.num} style={{display:"flex",gap:16,marginBottom:20}}>
              {/* Step number */}
              <div style={{flexShrink:0,width:48,height:48,borderRadius:12,background:`rgba(${step.color==='#0ea5e9'?'14,165,233':step.color==='#8b5cf6'?'139,92,246':step.color==='#f59e0b'?'245,158,11':step.color==='#f97316'?'249,115,22':step.color==='#22c55e'?'34,197,94':step.color===T.red?'220,38,38':step.color===T.muted?'100,116,139':'100,116,139'},0.15)`,border:`2px solid ${step.color}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                <div style={{fontSize:18}}>{step.icon}</div>
                <div style={{fontSize:9,fontWeight:800,color:step.color}}>STEP {step.num}</div>
              </div>

              {/* Content */}
              <div style={{flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:6}}>
                  <div style={{fontSize:14,fontWeight:700,color:T.text}}>{step.title}</div>
                  <span style={{fontSize:10,fontWeight:700,color:step.color,background:`rgba(${step.color==='#0ea5e9'?'14,165,233':step.color==='#8b5cf6'?'139,92,246':step.color==='#f59e0b'?'245,158,11':step.color==='#f97316'?'249,115,22':step.color==='#22c55e'?'34,197,94':step.color===T.red?'220,38,38':'100,116,139'},0.15)`,border:`1px solid ${step.color}`,borderRadius:6,padding:"2px 8px",whiteSpace:"nowrap"}}>{step.timing}</span>
                </div>
                <ol style={{margin:"0 0 10px 18px",padding:0,lineHeight:1.8}}>
                  {step.steps.map((s,i)=>(
                    <li key={i} style={{fontSize:13,color:T.text,marginBottom:2}}>{s}</li>
                  ))}
                </ol>
                <div style={{fontSize:12,color:T.amber,background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:6,padding:"7px 10px",lineHeight:1.5}}>
                  💡 {step.note}
                </div>
              </div>
            </div>
          ))}

          {/* Quick reference card */}
          <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"16px 20px",marginTop:8}}>
            <div style={{fontSize:13,fontWeight:700,color:T.red,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:12}}>Quick Reference — Key Numbers & Contacts</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,fontSize:12,lineHeight:1.8}}>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>IFTA Penalty (if late)</div>
                <div style={{color:T.muted}}>$50 or 10% of tax owed — whichever is greater</div>
                <div style={{color:T.muted}}>+ interest charged from due date until full payment received</div>
              </div>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>Record keeping</div>
                <div style={{color:T.muted}}>Keep all records for <strong style={{color:T.amber}}>4 years</strong> from the return due date or filing date — whichever is later</div>
                <div style={{color:T.dim,fontSize:11}}>Trip logs, fuel receipts, Nomad exports, Geotab exports, PDFs from this module</div>
              </div>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>Contact — Ontario IFTA</div>
                <div style={{color:T.muted}}>Email: commodity.tax@ontario.ca</div>
                <div style={{color:T.muted}}>Toll free: 1-866-ONT-TAXS (1-866-668-8297)</div>
                <div style={{color:T.muted}}>TTY: 1-800-263-7776</div>
                <div style={{color:T.muted}}>Mail: Ministry of Finance, 33 King St W, PO Box 625, Oshawa ON L1H 8H9</div>
              </div>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>Annual licence renewal</div>
                <div style={{color:T.amber,fontWeight:600}}>⚠ Renew IFTA licence & decals before December 31 each year</div>
                <div style={{color:T.muted}}>Ontario will mail a renewal form ~30 days before expiry</div>
                <div style={{color:T.muted}}>Decal fee: $10/set — pay by cheque to Minister of Finance (not at a bank)</div>
              </div>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>Conversion constants</div>
                <div style={{color:T.muted}}>1 US gallon = 3.785 litres</div>
                <div style={{color:T.muted}}>1 Imperial gallon = 4.546 litres</div>
                <div style={{color:T.muted}}>1 mile = 1.609 km</div>
              </div>
              <div>
                <div style={{fontWeight:700,color:T.text,marginBottom:2}}>Acceptable fleet fuel economy</div>
                <div style={{color:T.green}}>Normal heavy truck range: 20–50 L/100km</div>
                <div style={{color:T.amber}}>This module flags anything under 20 or over 80 L/100km for review</div>
              </div>
            </div>
          </div>

          <div style={{textAlign:"center",marginTop:20}}>
            <button onClick={()=>setTab("upload")} style={{...sBtn(),padding:"12px 28px",fontSize:14}}>
              Start Filing → Go to Upload Files
            </button>
          </div>

        </div>
      )}
      {tab==="upload" && (
        <div style={{maxWidth:760}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:8}}>
                Nomad Fuel Card Export
              </div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10,lineHeight:1.5}}>
                Upload Nomad CAN and/or USA IFTA reports — you can upload both separately, they'll be combined automatically.
              </div>
              <UploadZone onFile={handleNomadFile} busy={busyNomad} label="Upload Nomad CAN or USA report"/>
              {nomadFiles.length>0 && (
                <div style={{marginTop:10}}>
                  {nomadFiles.map(f=>(
                    <div key={f.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 10px",background:T.surface,borderRadius:7,marginBottom:4,fontSize:12}}>
                      <span style={{color:T.green}}>✅ {f.name}</span>
                      <span style={{color:T.muted}}>{f.transactions.length} transactions</span>
                      <button onClick={()=>setNomadFiles(p=>p.filter(x=>x.name!==f.name))} style={{background:"none",border:"none",color:T.red,cursor:"pointer",fontSize:14}}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:8}}>
                Geotab IFTA Report
              </div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10,lineHeight:1.5}}>
                Export the IFTA/Fuel Tax report from MyGeotab for the same quarter. Provides km driven per truck per jurisdiction.
              </div>
              <UploadZone onFile={handleGeotabFile} busy={busyGeotab} label="Upload Geotab IFTA report"/>
              {geotabData && (
                <div style={{marginTop:10,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 10px",background:T.surface,borderRadius:7,fontSize:12}}>
                  <span style={{color:T.green}}>✅ {geotabData.name}</span>
                  <span style={{color:T.muted}}>{new Set(geotabData.records.map(r=>r.truckUnit)).size} vehicles</span>
                  <button onClick={()=>setGeotabData(null)} style={{background:"none",border:"none",color:T.red,cursor:"pointer",fontSize:14}}>✕</button>
                </div>
              )}
            </div>
          </div>

          {uploadMsg && (
            <div style={{padding:"10px 14px",borderRadius:8,fontSize:13,fontWeight:600,
              background:uploadMsg.ok?T.greenDim:T.redDim, color:uploadMsg.ok?T.green:T.red,
              border:`1px solid ${uploadMsg.ok?T.green:T.red}`,marginBottom:16}}>
              {uploadMsg.text}
            </div>
          )}

          {allErrors.length>0 && (
            <div style={sCard}>
              <div style={{fontSize:12,fontWeight:700,color:T.amber,marginBottom:10}}>
                ⚠ {allErrors.length} fuel transactions could not be matched to a truck unit
              </div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>
                These were excluded from the IFTA calculation. Add them to the Fuel Cards table to include them.
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead>
                    <tr style={{background:T.surface}}>
                      {["Row","Nomad Unit","Card","Driver","Network","Litres","Issue"].map(h=>(
                        <th key={h} style={{padding:"6px 10px",textAlign:"left",color:T.muted,fontWeight:700,fontSize:10}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allErrors.slice(0,50).map((e,i)=>(
                      <tr key={i} style={{borderTop:`1px solid ${T.border}`}}>
                        <td style={{padding:"5px 10px",color:T.dim}}>{e.row}</td>
                        <td style={{padding:"5px 10px",color:T.amber,fontWeight:600}}>{e.unitRaw}</td>
                        <td style={{padding:"5px 10px",color:T.dim}}>{e.cardRaw}</td>
                        <td style={{padding:"5px 10px",color:T.text}}>{e.driver}</td>
                        <td style={{padding:"5px 10px",color:T.muted}}>{e.network}</td>
                        <td style={{padding:"5px 10px",color:T.text}}>{e.litres.toFixed(0)} L</td>
                        <td style={{padding:"5px 10px",color:T.dim,fontSize:10}}>{e.msg}</td>
                      </tr>
                    ))}
                    {allErrors.length>50 && <tr><td colSpan={7} style={{padding:"6px 10px",color:T.dim,fontSize:11}}>...and {allErrors.length-50} more. Fix card mappings to resolve.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── REPORT TAB ── */}
      {tab==="report" && (
        <div>
          {results.length===0 ? (
            <div style={{textAlign:"center",padding:48,color:T.muted}}>
              <div style={{fontSize:32,marginBottom:8}}>📊</div>
              <div style={{fontSize:14,fontWeight:600}}>Upload Nomad and/or Geotab files to generate the report</div>
              <button onClick={()=>setTab("upload")} style={{...sBtn(),marginTop:16}}>Go to Upload</button>
            </div>
          ) : (
            <>
              {/* Fleet summary cards */}
              <div style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"}}>
                <StatCard label="Units" value={results.length}/>
                <StatCard label="Total KM" value={totalKm.toLocaleString()} sub={`${results.filter(r=>r.totalKm>0).length} with GPS data`}/>
                <StatCard label="Total Fuel" value={`${Math.round(totalLitres).toLocaleString()} L`} sub={`${allTransactions.length} transactions`}/>
                <StatCard label="Fleet L/100km" value={fleetEcon?`${fleetEcon.toFixed(1)}`:"—"}
                  color={fleetEcon&&(fleetEcon<FUEL_ECON_MIN||fleetEcon>FUEL_ECON_MAX)?T.red:T.green}
                  sub="Acceptable: 20–80 L/100km"/>
                <StatCard label="Net Taxable" value={`${totalTaxable.toFixed(0)} L`}
                  color={totalTaxable>0?T.red:T.green}
                  sub={totalTaxable>0?"Fuel owed":"Credit from jurisdictions"}/>
                <StatCard label="TOTAL TAX DUE" value={`${totalFleetTaxDue>0?"+":""}$${Math.abs(totalFleetTaxDue).toFixed(2)}`}
                  color={totalFleetTaxDue>0?T.red:T.green}
                  sub={`CAD — ${totalFleetTaxDue>0?"amount payable":"refund / credit"}`}/>
                {flaggedCount>0 && <StatCard label="⚠ Review" value={flaggedCount} color={T.amber} sub="Units outside fuel economy range"/>}
                {allErrors.length>0 && <StatCard label="Unmatched" value={allErrors.length} color={T.amber} sub="Transactions excluded"/>}
              </div>

              {/* Per-truck breakdown */}
              {results.map(truck=>(
                <div key={truck.truckUnit} style={{...sCard, borderLeft:`3px solid ${truck.flagged?T.amber:T.border}`}}>
                  {/* Truck header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}
                    onClick={()=>setExpandedTruck(expandedTruck===truck.truckUnit?null:truck.truckUnit)}>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{fontSize:15,fontWeight:800,color:T.text}}>Unit {truck.truckUnit}</div>
                      {truck.driver && <div style={{fontSize:12,color:T.muted}}>{truck.driver}</div>}
                      {truck.flagged && <span style={{fontSize:10,fontWeight:700,color:T.amber,background:T.amberDim,border:`1px solid ${T.amber}`,borderRadius:6,padding:"2px 8px"}}>⚠ REVIEW FUEL ECONOMY</span>}
                      {truck.adjustedLitres!=null && <span style={{fontSize:10,fontWeight:700,color:T.blue,background:T.blueDim,border:`1px solid ${T.blue}`,borderRadius:6,padding:"2px 8px"}}>✎ ADJUSTED</span>}
                    </div>
                    <div style={{display:"flex",gap:20,alignItems:"center"}}>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:11,color:T.muted}}>KM</div>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{truck.totalKm.toLocaleString()}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:11,color:T.muted}}>Fuel</div>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{Math.round(truck.effectiveLitres).toLocaleString()} L</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:11,color:T.muted}}>L/100km</div>
                        <div style={{fontSize:13,fontWeight:700,color:truck.flagged?T.amber:T.text}}>
                          {truck.fuelEcon?truck.fuelEcon.toFixed(1):"—"}
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:11,color:T.muted}}>Net Taxable</div>
                        <div style={{fontSize:13,fontWeight:700,color:truck.totalTaxable>0?T.red:T.green}}>
                          {truck.totalTaxable>0?"+":""}{truck.totalTaxable.toFixed(0)} L
                        </div>
                      </div>
                      <div style={{fontSize:18,color:T.muted}}>{expandedTruck===truck.truckUnit?"▲":"▼"}</div>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {expandedTruck===truck.truckUnit && (
                    <div style={{marginTop:16}}>
                      {/* Fuel adjustment */}
                      <div style={{background:T.surface,borderRadius:8,padding:12,marginBottom:14,display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap"}}>
                        <div style={{flex:"0 0 auto"}}>
                          <div style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:4}}>Fuel Adjustment</div>
                          <div style={{fontSize:11,color:T.dim}}>Original: {Math.round(truck.totalLitres).toLocaleString()} L</div>
                        </div>
                        <div style={{flex:"0 0 160px"}}>
                          <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Adjusted Litres</label>
                          <input type="number" value={adjustments[truck.truckUnit]?.adjustedLitres??""} placeholder={Math.round(truck.totalLitres)}
                            onChange={e=>setAdj(truck.truckUnit,"adjustedLitres",e.target.value?parseFloat(e.target.value):undefined)}
                            style={{...sIn,padding:"6px 8px",fontSize:12}}/>
                        </div>
                        <div style={{flex:1, minWidth:200}}>
                          <label style={{fontSize:10,fontWeight:700,color:T.muted,textTransform:"uppercase",display:"block",marginBottom:4}}>Reason for adjustment</label>
                          <input value={adjustments[truck.truckUnit]?.note||""} placeholder="e.g. Corrected misattributed transactions..."
                            onChange={e=>setAdj(truck.truckUnit,"note",e.target.value)}
                            style={{...sIn,padding:"6px 8px",fontSize:12}}/>
                        </div>
                        {adjustments[truck.truckUnit]?.adjustedLitres && (
                          <button onClick={()=>setAdjustments(p=>{const n={...p};delete n[truck.truckUnit];return n;})}
                            style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                            Clear
                          </button>
                        )}
                      </div>

                      {/* Jurisdiction table */}
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                        <thead>
                          <tr style={{background:T.surface}}>
                            {["Jurisdiction","KM Driven","KM %","Fuel Consumed (L)","Fuel Purchased (L)","Net Taxable (L)","Rate (CAD/L)","Tax Due (CAD)",""].map(h=>(
                              <th key={h} style={{padding:"8px 10px",textAlign:"left",color:T.muted,fontWeight:700,fontSize:10,textTransform:"uppercase"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {truck.jurisRows.filter(r=>r.isIFTA).map(r=>(
                            <tr key={r.jurisdiction} style={{borderTop:`1px solid ${T.border}`,background:r.noKmWarning?"rgba(245,158,11,0.05)":"transparent"}}>
                              <td style={{padding:"8px 10px",fontWeight:700,color:T.text}}>{r.jurisdiction}</td>
                              <td style={{padding:"8px 10px",color:T.text}}>{r.km.toLocaleString("en-CA",{maximumFractionDigits:0})}</td>
                              <td style={{padding:"8px 10px",color:T.dim}}>{(r.kmShare*100).toFixed(1)}%</td>
                              <td style={{padding:"8px 10px",color:T.text}}>{r.litresConsumed.toLocaleString("en-CA",{maximumFractionDigits:0})}</td>
                              <td style={{padding:"8px 10px",color:T.text}}>{r.litresPurchased>0?r.litresPurchased.toLocaleString("en-CA",{maximumFractionDigits:0}):"—"}</td>
                              <td style={{padding:"8px 10px",fontWeight:600,color:r.taxable>0?T.red:r.taxable<0?T.green:T.muted}}>
                                {r.taxable>0?"+":""}{r.taxable.toLocaleString("en-CA",{maximumFractionDigits:0})}
                              </td>
                              <td style={{padding:"8px 10px",color:T.dim,fontSize:11}}>{r.taxRate!=null?r.taxRate.toFixed(4):"—"}</td>
                              <td style={{padding:"8px 10px",fontWeight:700,color:r.taxDue==null?T.dim:r.taxDue>0?T.red:T.green,fontSize:13}}>
                                {r.taxDue==null?"—":`${r.taxDue>0?"+":""}$${Math.abs(r.taxDue).toFixed(2)}`}
                                {r.surchargeDue!=null && r.surchargeDue!==0 && <span style={{fontSize:10,color:T.amber,marginLeft:4}}>+${r.surchargeDue.toFixed(2)} srchg</span>}
                              </td>
                              <td style={{padding:"8px 10px"}}>
                                {r.noKmWarning && <span style={{fontSize:10,color:T.amber}}>⚠ No km logged — verify</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{borderTop:`2px solid ${T.border}`,background:T.surface}}>
                            <td colSpan={2} style={{padding:"8px 10px",fontWeight:700,color:T.text,fontSize:11}}>TOTAL</td>
                            <td style={{padding:"8px 10px"}}></td>
                            <td style={{padding:"8px 10px",fontWeight:700,color:T.text}}>{truck.totalLitresConsumed.toLocaleString()} L</td>
                            <td style={{padding:"8px 10px",fontWeight:700,color:T.text}}>{Math.round(truck.effectiveLitres).toLocaleString()} L</td>
                            <td style={{padding:"8px 10px",fontWeight:800,color:truck.totalTaxable>0?T.red:T.green,fontSize:13}}>
                              {truck.totalTaxable>0?"+":""}{truck.totalTaxable.toFixed(0)} L
                            </td>
                            <td style={{padding:"8px 10px"}}></td>
                            <td style={{padding:"8px 10px",fontWeight:800,fontSize:14,color:truck.totalTaxDue>0?T.red:T.green}}>
                              {truck.totalTaxDue!=null?`${truck.totalTaxDue>0?"+":""}$${Math.abs(truck.totalTaxDue).toFixed(2)} CAD`:"—"}
                            </td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>

                      {truck.jurisRows.filter(r=>!r.isIFTA && r.km>0).length>0 && (
                        <div style={{marginTop:10,fontSize:11,color:T.dim}}>
                          Non-IFTA jurisdictions (excluded from report): {truck.jurisRows.filter(r=>!r.isIFTA&&r.km>0).map(r=>`${r.jurisdiction} (${r.km.toFixed(0)} km)`).join(", ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab==="history" && (
        <div style={{maxWidth:800}}>
          {history.length===0 ? (
            <div style={{textAlign:"center",padding:48,color:T.muted}}>
              <div style={{fontSize:32,marginBottom:8}}>🕐</div>
              <div style={{fontSize:14,fontWeight:600}}>No saved IFTA reports yet</div>
              <div style={{fontSize:12,color:T.dim,marginTop:4}}>Generate a report and click "Save Report" to archive it here</div>
            </div>
          ) : (
            <div>
              {history.map(rep=>(
                <div key={rep.id} style={{...sCard, display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700,color:T.text}}>{rep.quarter}</div>
                    <div style={{fontSize:12,color:T.muted,marginTop:3}}>
                      {rep.results?.length||0} units · {rep.totalKm?.toLocaleString()||"—"} km · {Math.round(rep.totalLitres||0).toLocaleString()} L ·
                      Net taxable: <span style={{color:rep.totalTaxable>0?T.red:T.green,fontWeight:600}}>{(rep.totalTaxable||0).toFixed(0)} L</span>
                    </div>
                    <div style={{fontSize:11,color:T.dim,marginTop:2}}>
                      Saved {new Date(rep.savedAt).toLocaleString("en-CA")}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{loadHistoricReport(rep);}} style={{padding:"6px 14px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Load</button>
                    <button onClick={()=>exportIFTAPDF(rep.results||[],rep.quarter,rep.unmatchedCount||0)} style={sBtn()}>📄 PDF</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SETUP TAB ── */}
      {tab==="setup" && <FuelCardsTab/>}

      {/* ── TAX RATES TAB ── */}
      {tab==="rates" && (
        <TaxRatesTab
          liveRates={liveRates}
          liveSurch={liveSurch}
          onSave={(quarter, rates, surcharges) => {
            const newRates = {...liveRates, [quarter]: rates};
            const newSurch = {...liveSurch, [quarter]: surcharges};
            setLiveRates(newRates);
            setLiveSurch(newSurch);
            // Persist to Firestore
            const docId = quarter.replace(/\s/g,"_");
            setDoc(doc(db,"iftaRates",docId), {
              quarter, rates, surcharges,
              updatedAt: new Date().toISOString(),
            }).catch(console.error);
          }}
        />
      )}
    </div>
  );
}

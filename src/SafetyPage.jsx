import { useState, useEffect, useRef, useMemo } from "react";
import { db } from "./firebase.js";
import { collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc } from "firebase/firestore";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const T = {
  red:"#dc2626", black:"#0f0f0f", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b",
  border:"#1e293b", hover:"#0f172a", card:"#0f172a", surface:"#1e293b", bg:"#020817",
  green:"#22c55e", greenDim:"rgba(34,197,94,0.1)", amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)",
  redDim:"rgba(220,38,38,0.1)", blue:"#0ea5e9", blueDim:"rgba(14,165,233,0.1)",
  purple:"#8b5cf6", purpleDim:"rgba(139,92,246,0.1)",
};

const RATING_COLOR = {
  "Best": T.green, "Great": T.green, "Average": T.amber,
  "Underperforming": "#f97316", "At risk": T.red, "Not enough activity": T.dim,
};
const RISK_COLOR = { "Low": T.green, "Moderate": T.amber, "High": T.red };

const fd = (d) => {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
};
const fdt = (d) => {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

// ── PDF generation ──
function pdfHeader(pdf, title, subtitle) {
  const pageW = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(220, 38, 38);
  pdf.rect(0, 0, pageW, 4, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.setTextColor(15, 15, 15);
  pdf.text("Diamond Back Express", 14, 18);
  pdf.setFontSize(13);
  pdf.setTextColor(220, 38, 38);
  pdf.text(title, 14, 27);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(100, 100, 100);
  pdf.text(subtitle, 14, 33);
  pdf.text(`Generated ${new Date().toLocaleString("en-CA")}`, pageW - 14, 18, { align: "right" });
  pdf.setDrawColor(220, 220, 220);
  pdf.line(14, 37, pageW - 14, 37);
}

function ratingColorRGB(rating) {
  if (rating === "Best" || rating === "Great") return [34, 197, 94];
  if (rating === "Average") return [245, 158, 11];
  if (rating === "Underperforming") return [249, 115, 22];
  if (rating === "At risk") return [220, 38, 38];
  return [148, 163, 184];
}
function riskColorRGB(rating) {
  if (rating === "Low") return [34, 197, 94];
  if (rating === "Moderate") return [245, 158, 11];
  if (rating === "High") return [220, 38, 38];
  return [148, 163, 184];
}

function exportCollisionRiskPDF(report, flagMap, thresholds, onlyFlaggedOrRisky) {
  const pdf = new jsPDF({ orientation: "landscape" });
  let records = [...(report.records || [])];
  if (onlyFlaggedOrRisky) {
    records = records.filter(r => flagMap[r.unit] || r.riskRating === "High" ||
      [r.speeding, r.acceleration, r.braking, r.cornering, r.tailgating].filter(c => c === "At risk" || c === "Underperforming").length >= 2);
  }
  records.sort((a, b) => (a.safetyRanking || 999) - (b.safetyRanking || 999));

  pdfHeader(pdf, "Collision Risk Report", `${onlyFlaggedOrRisky ? "Flagged / High-Risk Units" : "All Units"} — Report date: ${report.runDate || "—"}`);

  const high = records.filter(r => r.riskRating === "High").length;
  const moderate = records.filter(r => r.riskRating === "Moderate").length;
  const low = records.filter(r => r.riskRating === "Low").length;
  pdf.setFontSize(9);
  pdf.setTextColor(60, 60, 60);
  pdf.text(`Units shown: ${records.length}    High risk: ${high}    Moderate: ${moderate}    Low: ${low}`, 14, 43);

  autoTable(pdf, {
    startY: 48,
    head: [["Unit", "Rank", "Risk", "Risk %", "Speeding", "Acceleration", "Braking", "Cornering", "Tailgating", "Flag"]],
    body: records.map(r => [
      r.unit, r.safetyRanking ?? "—", r.riskRating || "—", r.riskPct || "—",
      r.speeding || "—", r.acceleration || "—", r.braking || "—", r.cornering || "—", r.tailgating || "—",
      flagMap[r.unit] ? "FLAGGED" : "",
    ]),
    styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 22 },
      9: { fontStyle: "bold", textColor: [220, 38, 38] },
    },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (data.column.index === 2) { const c = riskColorRGB(data.cell.raw); data.cell.styles.textColor = c; data.cell.styles.fontStyle = "bold"; }
      if (data.column.index >= 4 && data.column.index <= 8) { data.cell.styles.textColor = ratingColorRGB(data.cell.raw); }
    },
  });

  pdf.save(`Collision_Risk_${report.runDate || "report"}.pdf`.replace(/[, ]/g, "_"));
}

function exportTripsDetailPDF(report, flagMap, thresholds, onlyFlaggedOrRisky) {
  const pdf = new jsPDF();
  let records = [...(report.records || [])];
  if (onlyFlaggedOrRisky) {
    records = records.filter(r => flagMap[r.unit] || r.maxSpeed > thresholds.maxSpeedThreshold || r.totalIdleMin > thresholds.idleThreshold);
  }
  records.sort((a, b) => b.maxSpeed - a.maxSpeed);

  pdfHeader(pdf, "Trips Detail Report", `${onlyFlaggedOrRisky ? "Flagged / Over-Threshold Units" : "All Units"} — Report date: ${report.runDate || "—"}`);

  const totalKm = records.reduce((s, r) => s + (r.totalKm || 0), 0);
  const overSpeed = records.filter(r => r.maxSpeed > thresholds.maxSpeedThreshold).length;
  const overIdle = records.filter(r => r.totalIdleMin > thresholds.idleThreshold).length;
  pdf.setFontSize(9);
  pdf.setTextColor(60, 60, 60);
  pdf.text(`Units shown: ${records.length}    Total KM: ${Math.round(totalKm)}    Over speed threshold (${thresholds.maxSpeedThreshold} km/h): ${overSpeed}    Over idle threshold (${thresholds.idleThreshold} min): ${overIdle}`, 14, 43);

  autoTable(pdf, {
    startY: 48,
    head: [["Unit", "Driver", "Trips", "Total KM", "Max Speed", "Total Idling", "Flag"]],
    body: records.map(r => [
      r.unit, r.driver || "—", r.trips, r.totalKm, `${r.maxSpeed} km/h`, `${r.totalIdleMin} min`,
      flagMap[r.unit] ? "FLAGGED" : "",
    ]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { fontStyle: "bold" }, 6: { fontStyle: "bold", textColor: [220, 38, 38] } },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (data.column.index === 4 && parseFloat(data.cell.raw) > thresholds.maxSpeedThreshold) { data.cell.styles.textColor = [220, 38, 38]; data.cell.styles.fontStyle = "bold"; }
      if (data.column.index === 5 && parseFloat(data.cell.raw) > thresholds.idleThreshold) { data.cell.styles.textColor = [245, 158, 11]; data.cell.styles.fontStyle = "bold"; }
    },
  });

  pdf.save(`Trips_Detail_${report.runDate || "report"}.pdf`.replace(/[, ]/g, "_"));
}

function exportUnitHistoryPDF(unit, collisionReports, flagMap) {
  const pdf = new jsPDF();
  const flag = flagMap[unit];
  pdfHeader(pdf, `Unit Safety History — ${unit}`, flag ? `FLAGGED (${flag.severity})` : "Not currently flagged");

  let y = 45;
  if (flag?.reason) {
    pdf.setFontSize(9);
    pdf.setTextColor(180, 40, 0);
    const lines = pdf.splitTextToSize(`Flag reason: ${flag.reason}`, 180);
    pdf.text(lines, 14, y);
    y += lines.length * 5 + 4;
  }

  const rows = [];
  for (const rep of collisionReports) {
    const rec = (rep.records || []).find(r => r.unit === unit);
    if (!rec) continue;
    rows.push([rep.runDate || "—", rec.riskRating || "—", rec.riskPct || "—", rec.speeding || "—", rec.acceleration || "—", rec.braking || "—", rec.cornering || "—", rec.tailgating || "—"]);
  }

  autoTable(pdf, {
    startY: y,
    head: [["Report Date", "Risk", "Risk %", "Speeding", "Acceleration", "Braking", "Cornering", "Tailgating"]],
    body: rows.length ? rows : [["No collision risk history found for this unit", "", "", "", "", "", "", ""]],
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
    didParseCell: (data) => {
      if (data.section !== "body" || rows.length === 0) return;
      if (data.column.index === 1) { data.cell.styles.textColor = riskColorRGB(data.cell.raw); data.cell.styles.fontStyle = "bold"; }
      if (data.column.index >= 3) { data.cell.styles.textColor = ratingColorRGB(data.cell.raw); }
    },
  });

  pdf.save(`Unit_History_${unit}.pdf`.replace(/[, ]/g, "_"));
}

// ── Excel parsing helpers ──

// Find the row index in a sheet (array-of-arrays) that looks like a real header row,
// by scanning for any of the given candidate keywords.
function findHeaderRow(rows, keywordSets) {
  for (let i = 0; i < rows.length; i++) {
    const rowVals = (rows[i] || []).map(v => String(v || "").trim().toLowerCase());
    for (const keywords of keywordSets) {
      const hits = keywords.filter(k => rowVals.some(v => v === k.toLowerCase() || v.includes(k.toLowerCase())));
      if (hits.length >= Math.min(3, keywords.length)) return i;
    }
  }
  return -1;
}

function sheetToRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
}

// Parse a Collision Risk report workbook → array of per-unit records
function parseCollisionRisk(wb) {
  const summarySheetName = wb.SheetNames.find(n => /summary/i.test(n)) || wb.SheetNames[0];
  const rows = sheetToRows(wb, summarySheetName);
  const headerKeywords = ["Name", "Collision risk rating", "Speeding", "Braking"];
  let hIdx = findHeaderRow(rows, [headerKeywords]);
  if (hIdx === -1) {
    // fallback: scan all sheets
    for (const sn of wb.SheetNames) {
      const r = sheetToRows(wb, sn);
      const idx = findHeaderRow(r, [headerKeywords]);
      if (idx !== -1) { hIdx = idx; rows.splice(0, rows.length, ...r); break; }
    }
  }
  if (hIdx === -1) return { records: [], runDate: null, error: "Could not find a recognizable header row (looking for columns like Name, Collision risk rating, Speeding, Braking)." };

  const header = rows[hIdx].map(h => String(h || "").trim());
  const col = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const idxName = col("Name");
  const idxObsDate = col("Observation date");
  const idxRanking = col("Safety ranking (higher is safer)");
  const idxRating = col("Collision risk rating");
  const idxRisk = col("Collision risk");
  const idxBenchmark = col("Benchmark");
  const idxBest = col("Best in class");
  const idxSpeeding = col("Speeding");
  const idxAccel = col("Acceleration");
  const idxBraking = col("Braking");
  const idxCornering = col("Cornering");
  const idxTailgating = col("Tailgating");
  const idxGroup = col("Group");

  // try to find a run date somewhere near the top
  let runDate = null;
  for (let i = 0; i < Math.min(hIdx, 6); i++) {
    const rowStr = (rows[i] || []).join(" ");
    const m = rowStr.match(/\d{4}-\d{2}-\d{2}/) || rowStr.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    if (m) { runDate = m[0]; break; }
  }

  const records = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || idxName === -1 || !r[idxName]) continue;
    const name = String(r[idxName]).trim();
    if (!name) continue;
    records.push({
      unit: name,
      group: idxGroup !== -1 ? String(r[idxGroup] || "").trim() : "",
      observationDate: idxObsDate !== -1 ? String(r[idxObsDate] || "").trim() : "",
      safetyRanking: idxRanking !== -1 ? parseFloat(r[idxRanking]) || null : null,
      riskRating: idxRating !== -1 ? String(r[idxRating] || "").trim() : "",
      riskPct: idxRisk !== -1 ? String(r[idxRisk] || "").trim() : "",
      benchmarkPct: idxBenchmark !== -1 ? String(r[idxBenchmark] || "").trim() : "",
      bestInClassPct: idxBest !== -1 ? String(r[idxBest] || "").trim() : "",
      speeding: idxSpeeding !== -1 ? String(r[idxSpeeding] || "").trim() : "",
      acceleration: idxAccel !== -1 ? String(r[idxAccel] || "").trim() : "",
      braking: idxBraking !== -1 ? String(r[idxBraking] || "").trim() : "",
      cornering: idxCornering !== -1 ? String(r[idxCornering] || "").trim() : "",
      tailgating: idxTailgating !== -1 ? String(r[idxTailgating] || "").trim() : "",
    });
  }
  return { records, runDate, error: null };
}

// Parse a Trips Detail report workbook → aggregated per unit+driver records.
// NOTE: this report format leaves Device/Driver blank on continuation rows
// (only the first row of each unit's block has them), and ends with
// "<Unit> Total" / "Grand Total" rows that must be excluded from aggregation.
function parseTripsDetail(wb) {
  const summarySheetName = wb.SheetNames.find(n => /summary/i.test(n)) || wb.SheetNames[0];
  let rows = sheetToRows(wb, summarySheetName);
  const headerKeywords = ["Device", "Distance", "Maximum Speed", "Idling Duration"];
  let hIdx = findHeaderRow(rows, [headerKeywords]);
  if (hIdx === -1) {
    for (const sn of wb.SheetNames) {
      const r = sheetToRows(wb, sn);
      const idx = findHeaderRow(r, [headerKeywords]);
      if (idx !== -1) { hIdx = idx; rows = r; break; }
    }
  }
  if (hIdx === -1) return { records: [], runDate: null, error: "Could not find a recognizable header row (looking for columns like Device, Distance, Maximum Speed, Idling Duration)." };

  const header = rows[hIdx].map(h => String(h || "").trim());
  const col = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const idxDevice = col("Device");
  const idxFirst = col("First Name");
  const idxLast = col("Last Name");
  const idxStart = col("Start Date");
  const idxDistance = col("Distance");
  const idxMaxSpeed = col("Maximum Speed");
  const idxIdling = col("Idling Duration");

  let runDate = null;
  for (let i = 0; i < Math.min(hIdx, 6); i++) {
    const rowStr = (rows[i] || []).join(" ");
    const m = rowStr.match(/\d{4}-\d{2}-\d{2}/) || rowStr.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    if (m) { runDate = m[0]; break; }
  }

  const parseDur = (s) => {
    if (!s) return 0;
    const parts = String(s).split(":").map(Number);
    if (parts.length === 3) return parts[0]*60 + parts[1] + parts[2]/60;
    if (parts.length === 2) return parts[0] + parts[1]/60;
    return 0;
  };

  // Forward-fill device name across continuation rows (this report only
  // repeats Device/Driver on the first row of each block), and skip the
  // "<Unit> Total" / "Grand Total" rollup rows entirely.
  const byUnit = {};
  let currentUnit = "";
  let currentDriver = "";
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const deviceCell = idxDevice !== -1 ? String(r[idxDevice] || "").trim() : "";

    if (/total$/i.test(deviceCell)) continue; // skip rollup rows

    if (deviceCell) currentUnit = deviceCell;
    if (!currentUnit) continue;

    const first = idxFirst !== -1 ? String(r[idxFirst] || "").trim() : "";
    const last = idxLast !== -1 ? String(r[idxLast] || "").trim() : "";
    if (first && first !== "0") currentDriver = `${first} ${last}`.trim();

    const dist = idxDistance !== -1 ? parseFloat(r[idxDistance]) || 0 : 0;
    const maxSpd = idxMaxSpeed !== -1 ? parseFloat(r[idxMaxSpeed]) || 0 : 0;
    const idleMin = idxIdling !== -1 ? parseDur(r[idxIdling]) : 0;
    const startStr = idxStart !== -1 ? String(r[idxStart] || "") : "";

    if (!dist && !maxSpd && !idleMin && !deviceCell) continue; // skip blank trailing rows

    if (!byUnit[currentUnit]) byUnit[currentUnit] = { unit: currentUnit, driver: "", trips: 0, totalKm: 0, maxSpeed: 0, totalIdleMin: 0 };
    const rec = byUnit[currentUnit];
    if (currentDriver) rec.driver = currentDriver;
    rec.trips += 1;
    rec.totalKm += dist;
    rec.maxSpeed = Math.max(rec.maxSpeed, maxSpd);
    rec.totalIdleMin += idleMin;
  }
  const records = Object.values(byUnit).map(r => ({ ...r, totalKm: Math.round(r.totalKm * 10) / 10, totalIdleMin: Math.round(r.totalIdleMin) }));
  return { records, runDate, error: null };
}

function detectReportType(wb) {
  const nameStr = wb.SheetNames.join(" ").toLowerCase();
  if (nameStr.includes("collision")) return "collision";
  if (nameStr.includes("trip")) return "trips";
  // fallback: scan the first few rows of every sheet for the report title
  for (const sn of wb.SheetNames) {
    const rows = sheetToRows(wb, sn).slice(0, 5);
    const txt = rows.map(r => r.join(" ")).join(" ").toLowerCase();
    if (txt.includes("collision")) return "collision";
    if (txt.includes("trip")) return "trips";
  }
  return "unknown";
}

function exportFlaggedListPDF(flags) {
  const pdf = new jsPDF();
  pdfHeader(pdf, "Flagged Drivers / Units Report", `${flags.length} active flag${flags.length === 1 ? "" : "s"}`);

  const sorted = [...flags].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  autoTable(pdf, {
    startY: 43,
    head: [["Unit", "Driver", "Severity", "Reason", "Flagged Date"]],
    body: sorted.map(f => [f.unit, f.driver || "—", f.severity, f.reason || "—", f.flaggedAt ? new Date(f.flaggedAt).toLocaleDateString("en-CA") : "—"]),
    styles: { fontSize: 9, cellPadding: 4, valign: "top" },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 22 }, 3: { cellWidth: 80 } },
    didParseCell: (data) => {
      if (data.section !== "body" || data.column.index !== 2) return;
      const c = data.cell.raw === "high" ? [220, 38, 38] : data.cell.raw === "medium" ? [245, 158, 11] : [34, 197, 94];
      data.cell.styles.textColor = c; data.cell.styles.fontStyle = "bold";
    },
  });

  pdf.save(`Flagged_Units_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ── Small UI helpers ──
function Pill({ label, color, dim }) {
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, color, background: dim || "rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{label}</span>;
}
function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || T.text, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Upload zone ──
function UploadZone({ onFile, busy }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? T.red : T.border}`, borderRadius: 12, padding: "32px 20px",
        textAlign: "center", cursor: "pointer", background: dragging ? T.redDim : T.card, transition: "all 0.15s",
      }}
    >
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <div style={{ fontSize: 32, marginBottom: 8 }}>{busy ? "⏳" : "📊"}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{busy ? "Processing report..." : "Upload GPS Report"}</div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>
        Drop a Collision Risk or Trips Detail .xlsx file here, or click to browse
      </div>
    </div>
  );
}

// ── Flag modal ──
function FlagModal({ unit, driver, existing, onClose, onSave }) {
  const [reason, setReason] = useState(existing?.reason || "");
  const [severity, setSeverity] = useState(existing?.severity || "medium");
  const [saving, setSaving] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, width: 420, maxWidth: "90vw" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>{existing ? "Update Flag" : "Flag for Review"}</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>{unit}{driver ? ` — ${driver}` : ""}</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", display: "block", marginBottom: 6 }}>Severity</label>
          <div style={{ display: "flex", gap: 8 }}>
            {["low", "medium", "high"].map(s => (
              <button key={s} onClick={() => setSeverity(s)} style={{
                flex: 1, padding: "8px", borderRadius: 7, border: `1.5px solid ${severity === s ? RISK_COLOR[s === "low" ? "Low" : s === "medium" ? "Moderate" : "High"] : T.border}`,
                background: severity === s ? (s === "low" ? T.greenDim : s === "medium" ? T.amberDim : T.redDim) : "transparent",
                color: severity === s ? (s === "low" ? T.green : s === "medium" ? T.amber : T.red) : T.muted,
                fontWeight: 700, fontSize: 12, textTransform: "capitalize", cursor: "pointer", fontFamily: "inherit",
              }}>{s}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", display: "block", marginBottom: 6 }}>Reason / Notes</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4} placeholder="e.g. Repeated hard braking events, high collision risk score, multiple speeding incidents..."
            style={{ width: "100%", padding: 10, borderRadius: 8, border: `1.5px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box", resize: "vertical" }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1.5px solid ${T.border}`, background: "transparent", color: T.muted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          {existing && (
            <button onClick={async () => { setSaving(true); await onSave(null); setSaving(false); }} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1.5px solid ${T.red}`, background: "transparent", color: T.red, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Remove Flag</button>
          )}
          <button disabled={saving} onClick={async () => { setSaving(true); await onSave({ severity, reason: reason.trim() }); setSaving(false); }} style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", background: T.red, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving..." : existing ? "Update Flag" : "🚩 Flag"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Threshold settings modal ──
function ThresholdSettingsModal({ settings, onClose, onSave }) {
  const [local, setLocal] = useState(settings);
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setLocal(p => ({ ...p, [k]: v }));
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, width: 460, maxWidth: "90vw" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Auto-Highlight Thresholds</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 16 }}>
          Rows matching these conditions will be visually highlighted as needing attention. This does not auto-flag — you decide whether to flag after reviewing.
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={local.highlightHighRisk} onChange={e => upd("highlightHighRisk", e.target.checked)} />
            Highlight units with "High" collision risk rating
          </label>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={local.highlightAtRisk} onChange={e => upd("highlightAtRisk", e.target.checked)} />
            Highlight units with 2+ behavior categories rated "At risk" or "Underperforming"
          </label>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.text, display: "block", marginBottom: 6 }}>Highlight trips with max speed over (km/h)</label>
          <input type="number" value={local.maxSpeedThreshold} onChange={e => upd("maxSpeedThreshold", e.target.value)}
            style={{ width: "100%", padding: 8, borderRadius: 7, border: `1.5px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.text, display: "block", marginBottom: 6 }}>Highlight units with total idling over (minutes/day)</label>
          <input type="number" value={local.idleThreshold} onChange={e => upd("idleThreshold", e.target.value)}
            style={{ width: "100%", padding: 8, borderRadius: 7, border: `1.5px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1.5px solid ${T.border}`, background: "transparent", color: T.muted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={saving} onClick={async () => { setSaving(true); await onSave(local); setSaving(false); }} style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", background: T.red, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_THRESHOLDS = { highlightHighRisk: true, highlightAtRisk: true, maxSpeedThreshold: 110, idleThreshold: 45 };

export default function SafetyPage() {
  const [tab, setTab] = useState("collision"); // collision | trips | flagged
  const [busy, setBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);

  const [collisionReports, setCollisionReports] = useState([]); // raw docs from firestore
  const [tripsReports, setTripsReports] = useState([]);
  const [flags, setFlags] = useState([]); // safetyFlags docs
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);

  const [showThresholds, setShowThresholds] = useState(false);
  const [flagTarget, setFlagTarget] = useState(null); // {unit, driver, existing}
  const [drillUnit, setDrillUnit] = useState(null);
  const [search, setSearch] = useState("");
  const [pdfScope, setPdfScope] = useState("all"); // "all" | "risky"
  const [loadError, setLoadError] = useState(null);

  const loadAll = async () => {
    setLoadError(null);
    try {
      // NOTE: sort client-side (not via Firestore orderBy) so this never needs
      // a composite index — where()+orderBy() on different fields requires one,
      // and an un-created index causes the query to fail silently.
      const [crSnap, tdSnap, flagSnap, settingsSnap] = await Promise.all([
        getDocs(query(collection(db, "safetyReports"), where("type", "==", "collision"))),
        getDocs(query(collection(db, "safetyReports"), where("type", "==", "trips"))),
        getDocs(collection(db, "safetyFlags")),
        getDoc(doc(db, "settings", "safetyThresholds")),
      ]);
      const sortByUploadedDesc = (a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || "");
      setCollisionReports(crSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort(sortByUploadedDesc));
      setTripsReports(tdSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort(sortByUploadedDesc));
      setFlags(flagSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      if (settingsSnap.exists()) setThresholds({ ...DEFAULT_THRESHOLDS, ...settingsSnap.data() });
    } catch (e) {
      console.error("Failed to load safety data:", e);
      setLoadError(e.message || "Failed to load safety data. Check the browser console for details.");
    }
  };

  useEffect(() => { loadAll(); }, []);

  // Most recent report of each type (for the main table view)
  const latestCollision = collisionReports[0] || null;
  const latestTrips = tripsReports[0] || null;

  const flagMap = useMemo(() => {
    const m = {};
    for (const f of flags) m[f.unit] = f;
    return m;
  }, [flags]);

  const handleFile = async (file) => {
    setBusy(true);
    setUploadMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: false });
      const type = detectReportType(wb);
      if (type === "unknown") {
        setUploadMsg({ ok: false, text: "Could not identify this report type. Expected a Collision Risk or Trips Detail export." });
        setBusy(false);
        return;
      }
      const parsed = type === "collision" ? parseCollisionRisk(wb) : parseTripsDetail(wb);
      if (parsed.error) {
        setUploadMsg({ ok: false, text: parsed.error });
        setBusy(false);
        return;
      }
      if (parsed.records.length === 0) {
        setUploadMsg({ ok: false, text: "No data rows found in this file." });
        setBusy(false);
        return;
      }
      const docData = {
        type,
        fileName: file.name,
        runDate: parsed.runDate || null,
        uploadedAt: new Date().toISOString(),
        records: parsed.records,
        recordCount: parsed.records.length,
      };
      await addDoc(collection(db, "safetyReports"), docData);
      setUploadMsg({ ok: true, text: `Imported ${parsed.records.length} ${type === "collision" ? "unit" : "unit/driver"} records from "${file.name}".` });
      await loadAll();
      setTab(type);
    } catch (e) {
      console.error(e);
      setUploadMsg({ ok: false, text: "Failed to process file: " + e.message });
    }
    setBusy(false);
  };

  const saveFlag = async (unit, driver, data) => {
    const existing = flagMap[unit];
    if (data === null) {
      if (existing) await deleteDoc(doc(db, "safetyFlags", existing.id));
    } else if (existing) {
      await updateDoc(doc(db, "safetyFlags", existing.id), { ...data, driver: driver || existing.driver || "", updatedAt: new Date().toISOString() });
    } else {
      await addDoc(collection(db, "safetyFlags"), { unit, driver: driver || "", ...data, flaggedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    await loadAll();
    setFlagTarget(null);
  };

  const saveThresholds = async (newSettings) => {
    await setDoc(doc(db, "settings", "safetyThresholds"), newSettings, { merge: true });
    setThresholds(newSettings);
    setShowThresholds(false);
  };

  // Stats for top cards
  const stats = useMemo(() => {
    if (tab === "collision" && latestCollision) {
      const recs = latestCollision.records || [];
      const high = recs.filter(r => r.riskRating === "High").length;
      const moderate = recs.filter(r => r.riskRating === "Moderate").length;
      const low = recs.filter(r => r.riskRating === "Low").length;
      return { high, moderate, low, total: recs.length };
    }
    if (tab === "trips" && latestTrips) {
      const recs = latestTrips.records || [];
      const totalKm = recs.reduce((s, r) => s + (r.totalKm || 0), 0);
      const maxSpeed = Math.max(0, ...recs.map(r => r.maxSpeed || 0));
      const totalTrips = recs.reduce((s, r) => s + (r.trips || 0), 0);
      const overSpeed = recs.filter(r => r.maxSpeed > thresholds.maxSpeedThreshold).length;
      return { totalKm: Math.round(totalKm), maxSpeed, totalTrips, overSpeed, total: recs.length };
    }
    return {};
  }, [tab, latestCollision, latestTrips, thresholds]);

  const isHighlighted = (rec, type) => {
    if (type === "collision") {
      if (thresholds.highlightHighRisk && rec.riskRating === "High") return true;
      if (thresholds.highlightAtRisk) {
        const cats = [rec.speeding, rec.acceleration, rec.braking, rec.cornering, rec.tailgating];
        const bad = cats.filter(c => c === "At risk" || c === "Underperforming").length;
        if (bad >= 2) return true;
      }
      return false;
    }
    if (type === "trips") {
      if (rec.maxSpeed > thresholds.maxSpeedThreshold) return true;
      if (rec.totalIdleMin > thresholds.idleThreshold) return true;
      return false;
    }
    return false;
  };

  const filteredCollisionRecords = (latestCollision?.records || []).filter(r =>
    !search || r.unit.toLowerCase().includes(search.toLowerCase())
  );
  const filteredTripsRecords = (latestTrips?.records || []).filter(r =>
    !search || r.unit.toLowerCase().includes(search.toLowerCase()) || (r.driver || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: T.text, margin: 0 }}>Safety</h1>
          <div style={{ fontSize: 13, color: T.muted, marginTop: 2 }}>GPS incident reports, collision risk, and driver flagging</div>
        </div>
        <button onClick={() => setShowThresholds(true)} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.border}`, background: "transparent", color: T.muted, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          ⚙ Thresholds
        </button>
      </div>

      {loadError && (
        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: T.redDim, color: T.red, border: `1px solid ${T.red}` }}>
          ⚠ Could not load saved reports: {loadError}
          {loadError.toLowerCase().includes("index") && (
            <div style={{ fontWeight: 400, marginTop: 4, fontSize: 12 }}>
              This usually means Firestore needs a one-time index created — check the browser console (F12), there should be a direct link to create it automatically.
            </div>
          )}
          <button onClick={loadAll} style={{ marginTop: 8, padding: "5px 12px", borderRadius: 6, border: `1px solid ${T.red}`, background: "transparent", color: T.red, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "block" }}>↻ Retry</button>
        </div>
      )}

      <div style={{ marginTop: 20, marginBottom: 20 }}>
        <UploadZone onFile={handleFile} busy={busy} />
        {uploadMsg && (
          <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            background: uploadMsg.ok ? T.greenDim : T.redDim, color: uploadMsg.ok ? T.green : T.red, border: `1px solid ${uploadMsg.ok ? T.green : T.red}` }}>
            {uploadMsg.ok ? "✅ " : "⚠ "}{uploadMsg.text}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[
          { id: "collision", l: "Collision Risk" },
          { id: "trips", l: "Trips Detail" },
          { id: "flagged", l: `Flagged (${flags.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(""); }} style={{
            padding: "8px 16px", borderRadius: 8, border: `1px solid ${tab === t.id ? T.red : T.border}`,
            background: tab === t.id ? T.redDim : "transparent", color: tab === t.id ? T.red : T.muted,
            fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{t.l}</button>
        ))}
      </div>

      {/* ── COLLISION RISK TAB ── */}
      {tab === "collision" && (
        <div>
          {!latestCollision ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted, fontSize: 13 }}>No Collision Risk report uploaded yet.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                <StatCard label="Total Units" value={stats.total} />
                <StatCard label="High Risk" value={stats.high} color={T.red} />
                <StatCard label="Moderate Risk" value={stats.moderate} color={T.amber} />
                <StatCard label="Low Risk" value={stats.low} color={T.green} />
                <StatCard label="Report Date" value={fd(latestCollision.runDate)} sub={`Uploaded ${fdt(latestCollision.uploadedAt)}`} />
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search unit..."
                  style={{ flex: "0 1 280px", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${T.border}`, background: T.card, color: T.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 4, background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 3 }}>
                  <button onClick={() => setPdfScope("all")} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: pdfScope === "all" ? T.surface : "transparent", color: pdfScope === "all" ? T.text : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>All units</button>
                  <button onClick={() => setPdfScope("risky")} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: pdfScope === "risky" ? T.surface : "transparent", color: pdfScope === "risky" ? T.text : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Flagged / High risk only</button>
                </div>
                <button onClick={() => exportCollisionRiskPDF(latestCollision, flagMap, thresholds, pdfScope === "risky")} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.red}`, background: T.redDim, color: T.red, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  📄 Export PDF
                </button>
              </div>

              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: T.surface }}>
                        {["Unit", "Rank", "Risk Rating", "Risk %", "Speeding", "Acceleration", "Braking", "Cornering", "Tailgating", ""].map(h => (
                          <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: T.muted, fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCollisionRecords.sort((a, b) => (a.safetyRanking || 999) - (b.safetyRanking || 999)).map((r, i) => {
                        const flagged = !!flagMap[r.unit];
                        const hl = isHighlighted(r, "collision");
                        return (
                          <tr key={i} onClick={() => setDrillUnit(r.unit)} style={{ borderTop: `1px solid ${T.border}`, background: hl ? "rgba(220,38,38,0.05)" : "transparent", cursor: "pointer" }}>
                            <td style={{ padding: "10px 12px", fontWeight: 700, color: T.text }}>
                              {r.unit} {flagged && <span title="Flagged">🚩</span>}
                            </td>
                            <td style={{ padding: "10px 12px", color: T.muted }}>{r.safetyRanking ?? "—"}</td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.riskRating || "—"} color={RISK_COLOR[r.riskRating] || T.muted} dim={r.riskRating === "High" ? T.redDim : r.riskRating === "Moderate" ? T.amberDim : T.greenDim} /></td>
                            <td style={{ padding: "10px 12px", color: T.text }}>{r.riskPct || "—"}</td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.speeding || "—"} color={RATING_COLOR[r.speeding] || T.dim} /></td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.acceleration || "—"} color={RATING_COLOR[r.acceleration] || T.dim} /></td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.braking || "—"} color={RATING_COLOR[r.braking] || T.dim} /></td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.cornering || "—"} color={RATING_COLOR[r.cornering] || T.dim} /></td>
                            <td style={{ padding: "10px 12px" }}><Pill label={r.tailgating || "—"} color={RATING_COLOR[r.tailgating] || T.dim} /></td>
                            <td style={{ padding: "10px 12px" }} onClick={e => e.stopPropagation()}>
                              <button onClick={() => setFlagTarget({ unit: r.unit, driver: "", existing: flagMap[r.unit] })} style={{
                                padding: "4px 10px", borderRadius: 6, border: `1px solid ${flagged ? T.red : T.border}`,
                                background: flagged ? T.redDim : "transparent", color: flagged ? T.red : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                              }}>{flagged ? "Flagged" : "Flag"}</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── TRIPS DETAIL TAB ── */}
      {tab === "trips" && (
        <div>
          {!latestTrips ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted, fontSize: 13 }}>No Trips Detail report uploaded yet.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                <StatCard label="Units" value={stats.total} />
                <StatCard label="Total Trips" value={stats.totalTrips} />
                <StatCard label="Total KM" value={stats.totalKm?.toLocaleString()} />
                <StatCard label="Highest Speed Seen" value={`${stats.maxSpeed} km/h`} color={stats.maxSpeed > thresholds.maxSpeedThreshold ? T.red : T.text} />
                <StatCard label="Over Speed Threshold" value={stats.overSpeed} color={stats.overSpeed > 0 ? T.red : T.green} sub={`> ${thresholds.maxSpeedThreshold} km/h`} />
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search unit or driver..."
                  style={{ flex: "0 1 280px", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${T.border}`, background: T.card, color: T.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 4, background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 3 }}>
                  <button onClick={() => setPdfScope("all")} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: pdfScope === "all" ? T.surface : "transparent", color: pdfScope === "all" ? T.text : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>All units</button>
                  <button onClick={() => setPdfScope("risky")} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: pdfScope === "risky" ? T.surface : "transparent", color: pdfScope === "risky" ? T.text : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Flagged / Over threshold only</button>
                </div>
                <button onClick={() => exportTripsDetailPDF(latestTrips, flagMap, thresholds, pdfScope === "risky")} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.red}`, background: T.redDim, color: T.red, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  📄 Export PDF
                </button>
              </div>

              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: T.surface }}>
                        {["Unit", "Driver", "Trips", "Total KM", "Max Speed", "Total Idling", ""].map(h => (
                          <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: T.muted, fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTripsRecords.sort((a, b) => b.maxSpeed - a.maxSpeed).map((r, i) => {
                        const flagged = !!flagMap[r.unit];
                        const hl = isHighlighted(r, "trips");
                        const speedHot = r.maxSpeed > thresholds.maxSpeedThreshold;
                        const idleHot = r.totalIdleMin > thresholds.idleThreshold;
                        return (
                          <tr key={i} style={{ borderTop: `1px solid ${T.border}`, background: hl ? "rgba(220,38,38,0.05)" : "transparent" }}>
                            <td style={{ padding: "10px 12px", fontWeight: 700, color: T.text }}>{r.unit} {flagged && <span title="Flagged">🚩</span>}</td>
                            <td style={{ padding: "10px 12px", color: T.text }}>{r.driver || "—"}</td>
                            <td style={{ padding: "10px 12px", color: T.muted }}>{r.trips}</td>
                            <td style={{ padding: "10px 12px", color: T.text }}>{r.totalKm}</td>
                            <td style={{ padding: "10px 12px", color: speedHot ? T.red : T.text, fontWeight: speedHot ? 700 : 400 }}>{r.maxSpeed} km/h</td>
                            <td style={{ padding: "10px 12px", color: idleHot ? T.amber : T.text, fontWeight: idleHot ? 700 : 400 }}>{r.totalIdleMin} min</td>
                            <td style={{ padding: "10px 12px" }}>
                              <button onClick={() => setFlagTarget({ unit: r.unit, driver: r.driver, existing: flagMap[r.unit] })} style={{
                                padding: "4px 10px", borderRadius: 6, border: `1px solid ${flagged ? T.red : T.border}`,
                                background: flagged ? T.redDim : "transparent", color: flagged ? T.red : T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                              }}>{flagged ? "Flagged" : "Flag"}</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── FLAGGED TAB ── */}
      {tab === "flagged" && (
        <div>
          {flags.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: T.muted, fontSize: 13 }}>No drivers or units currently flagged.</div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button onClick={() => exportFlaggedListPDF(flags)} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.red}`, background: T.redDim, color: T.red, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  📄 Export PDF
                </button>
              </div>
              <div style={{ display: "grid", gap: 10 }}>
              {flags.sort((a, b) => (b.flaggedAt || "").localeCompare(a.flaggedAt || "")).map(f => (
                <div key={f.id} style={{ background: T.card, border: `1.5px solid ${f.severity === "high" ? T.red : f.severity === "medium" ? T.amber : T.green}`, borderRadius: 10, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>🚩 {f.unit}</span>
                        {f.driver && <span style={{ fontSize: 13, color: T.muted }}>— {f.driver}</span>}
                        <Pill label={f.severity} color={f.severity === "high" ? T.red : f.severity === "medium" ? T.amber : T.green} dim={f.severity === "high" ? T.redDim : f.severity === "medium" ? T.amberDim : T.greenDim} />
                      </div>
                      {f.reason && <div style={{ fontSize: 13, color: T.text, marginTop: 8, lineHeight: 1.5 }}>{f.reason}</div>}
                      <div style={{ fontSize: 11, color: T.dim, marginTop: 8 }}>Flagged {fdt(f.flaggedAt)}{f.updatedAt && f.updatedAt !== f.flaggedAt ? ` · Updated ${fdt(f.updatedAt)}` : ""}</div>
                    </div>
                    <button onClick={() => setFlagTarget({ unit: f.unit, driver: f.driver, existing: f })} style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${T.border}`, background: "transparent", color: T.muted, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Edit</button>
                  </div>
                </div>
              ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Per-unit drill-in (collision risk history across uploads) */}
      {drillUnit && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setDrillUnit(null)}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, width: 600, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Unit {drillUnit} — History</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => exportUnitHistoryPDF(drillUnit, collisionReports, flagMap)} style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${T.red}`, background: T.redDim, color: T.red, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>📄 Export PDF</button>
                <button onClick={() => setDrillUnit(null)} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer" }}>✕</button>
              </div>
            </div>
            {collisionReports.map(rep => {
              const rec = (rep.records || []).find(r => r.unit === drillUnit);
              if (!rec) return null;
              return (
                <div key={rep.id} style={{ borderBottom: `1px solid ${T.border}`, padding: "10px 0" }}>
                  <div style={{ fontSize: 12, color: T.muted, marginBottom: 4 }}>{fd(rep.runDate)} — uploaded {fdt(rep.uploadedAt)}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Pill label={rec.riskRating} color={RISK_COLOR[rec.riskRating] || T.muted} dim={rec.riskRating === "High" ? T.redDim : rec.riskRating === "Moderate" ? T.amberDim : T.greenDim} />
                    <span style={{ fontSize: 12, color: T.text }}>{rec.riskPct}</span>
                    <Pill label={`Speeding: ${rec.speeding}`} color={RATING_COLOR[rec.speeding] || T.dim} />
                    <Pill label={`Braking: ${rec.braking}`} color={RATING_COLOR[rec.braking] || T.dim} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {flagTarget && (
        <FlagModal unit={flagTarget.unit} driver={flagTarget.driver} existing={flagTarget.existing}
          onClose={() => setFlagTarget(null)}
          onSave={(data) => saveFlag(flagTarget.unit, flagTarget.driver, data)} />
      )}

      {showThresholds && (
        <ThresholdSettingsModal settings={thresholds} onClose={() => setShowThresholds(false)} onSave={saveThresholds} />
      )}
    </div>
  );
}

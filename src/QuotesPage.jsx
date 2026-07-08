import { useState, useEffect } from "react";
import { db } from "./firebase.js";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, orderBy, query } from "firebase/firestore";

// ── Theme (matches App.jsx dark theme) ──
const T = {
  bg:"#0f172a", card:"#1e293b", border:"#334155", text:"#f1f5f9",
  muted:"#94a3b8", dim:"#475569", red:"#dc2626", redDim:"rgba(220,38,38,0.1)",
  hover:"rgba(255,255,255,0.04)", surface:"rgba(255,255,255,0.03)",
  green:"#22c55e", blue:"#0ea5e9",
};
const sIn = { background:T.surface, border:`1px solid ${T.border}`, borderRadius:6, color:T.text, fontSize:12, padding:"7px 10px", fontFamily:"inherit", width:"100%", boxSizing:"border-box", outline:"none" };
const sBtn = { padding:"6px 14px", borderRadius:6, border:`1px solid ${T.border}`, background:"transparent", color:T.muted, fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"inherit" };
const sLbl = { fontSize:10, fontWeight:600, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em", display:"block", marginBottom:4 };

const EQUIPMENT_TYPES = ["Step Deck","Flat Bed","Conestoga","Car Hauler","Sideloader","Power Only","Other"];
const PAYMENT_TERMS = ["Net 7","Net 15","Net 30","Net 60","Due on Receipt"];
const SALESPERSONS = ["Manuel Deslauriers","Carl Carter","Chris St-Germain","Kyle Savage"];

const DIVISIONS = [
  { id:"ca", name:"Diamond Back Express Canada", short:"DBX Canada", addr:"4515 Ebenezer Rd, Unit 212\nBrampton, Ontario L6P 2K7\nCanada", phone:"905-409-0278" },
  { id:"us", name:"Diamond Back Express LLC", short:"DBX USA", addr:"Suite 400-K-175\n1110 Brickell Ave\nMiami, FL 33131\nUSA", phone:"" },
];

const DISCLAIMER = "Please note that the fuel listed above will be charged based on actual fuel prices on date of completion. Prices reflect rental quotes (where applicable) at time of quote and may vary. Prices quoted on date given, subject to change - please allow for up to a 10% variance if applicable.";

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const fd = d => d ? new Date(d+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";
const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();

const emptyLine = () => ({ id:uid(), qty:"1", desc:"", unitPrice:"", equipment:"", currency:"" });

export default function QuotesPage({ clients: clientsProp }) {
  const [quotes, setQuotes] = useState([]);
  const [clients, setClients] = useState(clientsProp||[]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("list"); // "list" | "form" | "preview"
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const toggleGroup = (s) => setCollapsedGroups(p=>({...p,[s]:!p[s]}));
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fxRates, setFxRates] = useState({}); // { "CAD": 1.36, "EUR": 0.92, ... } relative to USD
  const [fxLoading, setFxLoading] = useState(false);
  const [fxDate, setFxDate] = useState("");

  const CURRENCIES = ["USD","CAD","EUR","GBP","ZAR"];
  const symFor = (c) => c==="EUR"?"€":c==="GBP"?"£":c==="ZAR"?"R":"$";

  // Returns { USD: 1234.56, CAD: 789.00, ... } — only currencies actually used
  const subtotalByCurrency = (lines, quoteCur) => {
    const map = {};
    (lines||[]).forEach(l => {
      const cur = l.currency || quoteCur || "USD";
      const amt = (parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0);
      if(amt===0) return;
      map[cur] = (map[cur]||0) + amt;
    });
    return map;
  };

  // Convert all to targetCur using rates fetched FROM USD base
  // rates = { EUR: 0.92, CAD: 1.36, ... } meaning 1 USD = X foreign
  const convertToTarget = (byCur, targetCur, rates) => {
    let total = 0;
    for(const [cur, amt] of Object.entries(byCur)) {
      let inUSD;
      if(cur === "USD") {
        inUSD = amt;
      } else {
        const r = rates[cur]; // 1 USD = r cur
        if(!r) return null;
        inUSD = amt / r;
      }
      let converted;
      if(targetCur === "USD") {
        converted = inUSD;
      } else {
        const r = rates[targetCur]; // 1 USD = r targetCur
        if(!r) return null;
        converted = inUSD * r;
      }
      total += converted;
    }
    return total;
  };

  const fetchRates = async () => {
    setFxLoading(true);
    try {
      // Always fetch from USD so rates are consistent: 1 USD = X foreign
      const res = await fetch(`https://v6.exchangerate-api.com/v6/f33d099aa4e8c96e5a16d497/latest/USD`);
      const data = await res.json();
      setFxRates({ ...data.conversion_rates, USD: 1 });
      setFxDate(data.time_last_update_utc ? data.time_last_update_utc.slice(0,16) : new Date().toISOString().slice(0,10));
    } catch(e) { console.error("FX fetch failed",e); }
    setFxLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  // Fetch rates whenever form opens or total currency changes
  useEffect(() => {
    if(form && Object.keys(fxRates).length === 0) {
      fetchRates();
    }
  }, [form]);

  useEffect(() => {
    if(form) fetchRates();
  }, [form?.totalCurrency]);

  const loadAll = async () => {
    setLoading(true);
    try {
      let qSnap;
      try {
        qSnap = await getDocs(query(collection(db,"quotes"), orderBy("createdAt","desc")));
      } catch(idxErr) {
        qSnap = await getDocs(collection(db,"quotes"));
      }
      setQuotes(qSnap.docs.map(d=>({id:d.id,...d.data()})));
      // Only fetch clients if not passed as prop
      if(!clientsProp?.length) {
        const cs = await getDocs(collection(db,"clients"));
        setClients(cs.docs.map(d=>({id:d.id,...d.data()})));
      }
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const nextQuoteNum = () => {
    if(quotes.length === 0) return "Q-0001";
    const nums = quotes.map(q => parseInt((q.quoteNum||"Q-0000").replace("Q-",""))||0);
    return `Q-${String(Math.max(...nums)+1).padStart(4,"0")}`;
  };

  const newForm = () => ({
    quoteNum: nextQuoteNum(),
    divId: "us",
    currency: "USD",
    totalCurrency: "USD",
    cliId: "",
    cliName: "", cliStreet: "", cliCity: "", cliProvState: "", cliPostalZip: "", cliCountry: "",
    cliContact: "", cliPhone: "", cliEmail: "",
    shipperName: "", shipperStreet: "", shipperCity: "", shipperProvState: "", shipperPostalZip: "", shipperCountry: "",
    consigneeName: "", consigneeStreet: "", consigneeCity: "", consigneeProvState: "", consigneePostalZip: "", consigneeCountry: "",
    date: today(),
    dueDate: "",
    project: "",
    attention: "",
    salesperson: "Manuel Deslauriers",
    paymentTerms: "Net 30",
    equipment: [],
    lines: [emptyLine(), emptyLine(), emptyLine()],
    taxRate: "",
    other: "",
    otherLabel: "Other",
    notes: DISCLAIMER,
    scopeOfWork: "",
    internalNotes: "",
    status: "draft",
    createdAt: new Date().toISOString(),
  });

  const startNew = () => { setForm(newForm()); setEditId(null); setView("form"); };

  const startEdit = (q) => { setForm({...q, lines: q.lines||[emptyLine()]}); setEditId(q.id); setView("form"); };

  const setF = (k, v) => setForm(p => ({...p, [k]:v}));

  const pickClient = (cliId) => {
    const c = clients.find(x=>x.id===cliId);
    if(!c) { setF("cliId",""); return; }
    setForm(p=>({...p, cliId, cliName:c.name||"", cliStreet:c.street||"", cliCity:c.city||"", cliProvState:c.provState||"", cliPostalZip:c.postalZip||"", cliCountry:c.country||"", cliContact:c.contact||"", cliPhone:c.phone||"", cliEmail:c.billingEmail||c.email||""}));
  };

  const updateLine = (idx, k, v) => setForm(p=>{ const lines=[...p.lines]; lines[idx]={...lines[idx],[k]:v}; return {...p,lines}; });
  const addLine = () => setForm(p=>({...p, lines:[...p.lines, emptyLine()]}));
  const removeLine = (idx) => setForm(p=>({...p, lines:p.lines.filter((_,i)=>i!==idx)}));

  const subtotal = (lines, quoteCur) => {
    // For list view / single-currency display: sum all lines treating amounts as same currency
    return (lines||[]).reduce((a,l)=>{
      const qty=parseFloat(l.qty)||0, up=parseFloat(l.unitPrice)||0;
      return a+qty*up;
    },0);
  };

  const calcTotal = (f) => {
    const sub = subtotal(f.lines||[]);
    const tax = sub*(parseFloat(f.taxRate)||0)/100;
    const other = parseFloat(f.other)||0;
    return sub+tax+other;
  };

  // Check if quote has multiple currencies in use
  const hasMultiCurrency = (f) => {
    const quoteCur = f.currency||(f.divId==="us"?"USD":"CAD");
    const curs = new Set((f.lines||[]).filter(l=>l.desc||l.unitPrice).map(l=>l.currency||quoteCur));
    return curs.size > 1;
  };

  const save = async (status) => {
    if(!form.quoteNum||!form.cliName) { alert("Please fill in Quote # and Client."); return; }
    setSaving(true);
    try {
      const data = { ...form, status: status||form.status, updatedAt: new Date().toISOString() };
      if(editId) { await updateDoc(doc(db,"quotes",editId), data); }
      else { const ref = await addDoc(collection(db,"quotes"), data); setEditId(ref.id); }
      await loadAll();
      const label = status==="sent" ? "saved and marked as Sent" : status==="draft" ? "saved as Draft" : "saved";
      alert(`✓ Quote ${form.quoteNum} ${label}.`);
      setView("list");
    } catch(e) { console.error(e); alert("Error saving quote."); }
    setSaving(false);
  };

  const changeStatus = async (id, status) => {
    await updateDoc(doc(db,"quotes",id), { status });
    setQuotes(prev => prev.map(q => q.id===id ? {...q, status} : q));
  };

  const deleteQuote = async (id) => {
    if(!window.confirm("Delete this quote?")) return;
    await deleteDoc(doc(db,"quotes",id));
    await loadAll();
  };

  // internalNotes is intentionally excluded from PDF — internal use only
  const generatePDF = async (quoteData) => {
    const f = quoteData || form;
    const div = DIVISIONS.find(d=>d.id===f.divId)||DIVISIONS[0];
    const lineCur = f.currency || (f.divId==="us"?"USD":"CAD"); // default for line items
    const cur = f.totalCurrency || lineCur;                     // grand total currency
    const sym = symFor(cur);
    const byCurPDF = subtotalByCurrency(f.lines||[], lineCur);
    const needsConv = Object.keys(byCurPDF).length > 1 || (Object.keys(byCurPDF).length === 1 && Object.keys(byCurPDF)[0] !== cur);
    const multiCur = needsConv;

    // Fetch live FX rates if multi-currency
    let rates = {};
    let rateDate = "";
    if(multiCur) {
      try {
        // Always fetch from USD so rates are consistent: 1 USD = X foreign
        const res = await fetch(`https://v6.exchangerate-api.com/v6/f33d099aa4e8c96e5a16d497/latest/USD`);
        const data = await res.json();
        rates = { ...data.conversion_rates, USD: 1 };
        rateDate = data.time_last_update_utc ? data.time_last_update_utc.slice(0,16) : new Date().toISOString().slice(0,10);
      } catch(e) { console.error("FX fetch failed", e); }
    }

    const taxRate = parseFloat(f.taxRate)||0;
    const otherAmt = parseFloat(f.other)||0;

    // Converted grand total
    let grandTotal = null;
    if(multiCur && Object.keys(rates).length) {
      grandTotal = convertToTarget(byCurPDF, cur, rates);
    } else if(!multiCur) {
      const singleSub = Object.values(byCurPDF)[0]||0;
      grandTotal = singleSub + singleSub*(taxRate/100) + otherAmt;
    }

    const lineRows = (f.lines||[]).filter(l=>l.desc||l.unitPrice).map(l=>{
      const lineCur = l.currency||cur;
      const lineSym = symFor(lineCur);
      const qty=parseFloat(l.qty)||0, up=parseFloat(l.unitPrice)||0, amt=qty*up;
      const isForeign = lineCur !== cur;
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-size:10px">${l.qty||""}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:10px">${l.desc||""}${l.equipment?`<br><span style="font-size:9px;color:#666;font-style:italic">${l.equipment}</span>`:""}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-size:10px">${up>0?`${lineSym}${up.toFixed(2)}${isForeign?` <span style="font-size:8px;color:#f97316;font-weight:700">${lineCur}</span>`:""}`:""}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;font-size:10px;${isForeign?"color:#c2410c":""}">${amt>0?`${lineSym}${amt.toFixed(2)}`:""}</td>
      </tr>`;
    }).join("");

    // Build totals rows
    const totalRows = Object.entries(byCurPDF).map(([c,amt])=>`
      <tr><td class="lbl">Subtotal ${c}</td><td class="val" style="${c!==cur?"color:#c2410c":""}">${symFor(c)}${amt.toFixed(2)}</td></tr>
    `).join("");

    const taxRow = taxRate>0 ? `<tr><td class="lbl">Tax (${taxRate}%)</td><td class="val">${sym}${((grandTotal||0)*(taxRate/100)).toFixed(2)}</td></tr>` : `<tr><td class="lbl">Tax</td><td class="val">${sym}0.00</td></tr>`;
    const otherRow = otherAmt>0 ? `<tr><td class="lbl">${f.otherLabel||"Other"}</td><td class="val">${sym}${otherAmt.toFixed(2)}</td></tr>` : "";

    const convNote = multiCur && rateDate ? `
      <div style="font-size:9px;color:#888;margin-bottom:4px;font-style:italic">
        Exchange rates via exchangerate-api.com as of ${rateDate}:
        ${Object.entries(byCurPDF).filter(([c])=>c!==cur).map(([c])=>{
          const rateToDisplay = rates[c] && rates[cur] ? (rates[c]/rates[cur]).toFixed(4) : "N/A";
          return `1 ${cur} = ${rateToDisplay} ${c}`;
        }).join(" · ")}
      </div>` : "";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Quote ${f.quoteNum}</title>
    <style>
      body{font-family:Arial,sans-serif;margin:0;padding:18px 24px;color:#111;font-size:11px}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;padding-bottom:10px;border-bottom:3px solid #dc2626}
      .logo-section{display:flex;align-items:center;gap:12px}
      .company-info{font-size:10px;color:#555;line-height:1.4;white-space:pre-line}
      .quote-meta{text-align:right;font-size:11px}
      .quote-title{font-size:26px;font-weight:900;color:#dc2626;letter-spacing:-1px;margin-bottom:4px}
      .meta-row{display:flex;justify-content:space-between;margin-bottom:10px}
      .prepared-for{flex:1}
      .prepared-for h3{font-size:9px;text-transform:uppercase;color:#999;margin:0 0 3px;letter-spacing:0.1em}
      .prepared-for .name{font-size:13px;font-weight:700;margin-bottom:1px}
      .prepared-for .addr{font-size:10px;color:#555;line-height:1.4}
      .quote-details{text-align:right;font-size:10px}
      .quote-details table{margin-left:auto}
      .quote-details td{padding:1px 5px}
      .quote-details .lbl{color:#888;text-align:right}
      .quote-details .val{font-weight:600;text-align:left}
      table.items{width:100%;border-collapse:collapse;margin-bottom:8px}
      table.items thead tr{background:#1e293b;color:#fff}
      table.items thead th{padding:5px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:0.05em}
      table.items thead th:nth-child(1){width:40px;text-align:center}
      table.items thead th:nth-child(3),table.items thead th:nth-child(4){text-align:right}
      table.items tbody tr td{padding:4px 8px;border-bottom:1px solid #eee;font-size:10px}
      table.items tbody tr td:nth-child(1){text-align:center}
      table.items tbody tr td:nth-child(3),table.items tbody tr td:nth-child(4){text-align:right}
      .totals{margin-left:auto;width:240px;margin-bottom:12px}
      .totals table{width:100%;border-collapse:collapse}
      .totals td{padding:3px 6px;font-size:10px}
      .totals .lbl{color:#555}
      .totals .val{text-align:right;font-weight:600}
      .totals .total-row td{border-top:2px solid #000;font-size:13px;font-weight:700;padding-top:5px}
      .notes-section{margin-bottom:10px;padding:8px 12px;background:#f8fafc;border-left:4px solid #dc2626;border-radius:0 4px 4px 0}
      .notes-section .notes-label{font-size:8px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}
      .notes-section .notes-text{font-size:10px;color:#333;line-height:1.4;white-space:pre-wrap}
      .signature{display:flex;gap:30px;margin-top:12px}
      .sig-box{flex:1;border-top:1px solid #333;padding-top:4px;font-size:9px;color:#555}
      .equipment-badges{margin-bottom:6px;display:flex;flex-wrap:wrap;gap:3px}
      .eq-badge{background:#1e293b;color:#fff;padding:1px 6px;border-radius:10px;font-size:9px;font-weight:600}
      @media print{body{padding:12px 18px}.no-print{display:none}}
    </style></head><body>

    <div class="header">
      <div class="logo-section">
        <img src="https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410" style="height:44px;object-fit:contain"/>
        <div class="company-info">${div.name}\n${div.addr}${div.phone?"\n"+div.phone:""}</div>
      </div>
      <div class="quote-meta">
        <div class="quote-title">QUOTE</div>
        <div style="font-size:11px;color:#555">
          <strong>${f.quoteNum}</strong><br>
          Date: ${fd(f.date)}<br>
          ${f.dueDate?`Valid Until: ${fd(f.dueDate)}<br>`:""}
          ${f.paymentTerms?`Payment: ${f.paymentTerms}`:""}
        </div>
      </div>
    </div>

    <div class="meta-row">
      <div class="prepared-for">
        <h3>Prepared For</h3>
        <div class="name">${f.cliName||""}</div>
        <div class="addr">${[f.cliStreet,f.cliCity,f.cliProvState,f.cliPostalZip,f.cliCountry].filter(Boolean).join(", ")}</div>
        ${f.cliContact?`<div class="addr" style="margin-top:4px">${f.cliContact}</div>`:""}
        ${f.cliPhone?`<div class="addr">${f.cliPhone}</div>`:""}
        ${f.cliEmail?`<div class="addr">${f.cliEmail}</div>`:""}
      </div>
      <div class="quote-details">
        <table><tbody>
          ${f.project?`<tr><td class="lbl">Project:</td><td class="val">${f.project}</td></tr>`:""}
          ${f.attention?`<tr><td class="lbl">Attention:</td><td class="val">${f.attention}</td></tr>`:""}
          ${f.salesperson?`<tr><td class="lbl">Salesperson:</td><td class="val">${f.salesperson}</td></tr>`:""}
        </tbody></table>
      </div>
    </div>

    ${f.equipment&&f.equipment.length>0?`<div class="equipment-badges">${f.equipment.map(e=>`<span class="eq-badge">${e}</span>`).join("")}</div>`:""}

    ${(f.shipperName||f.shipperStreet||f.shipperCity||f.shipperProvState||f.shipperPostalZip||f.shipperCountry||f.consigneeName||f.consigneeStreet||f.consigneeCity||f.consigneeProvState||f.consigneePostalZip||f.consigneeCountry)?`
    <div style="display:flex;gap:16px;margin-bottom:10px;padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
      ${(f.shipperName||f.shipperStreet||f.shipperCity||f.shipperProvState||f.shipperPostalZip||f.shipperCountry)?`
      <div style="flex:1">
        <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px">📦 Shipper</div>
        ${f.shipperName?`<div style="font-size:12px;font-weight:700;color:#111;margin-bottom:2px">${f.shipperName}</div>`:""}
        ${f.shipperStreet?`<div style="font-size:11px;color:#555">${f.shipperStreet}</div>`:""}
        <div style="font-size:11px;color:#555">${[f.shipperCity,f.shipperProvState,f.shipperPostalZip,f.shipperCountry].filter(Boolean).join(", ")}</div>
      </div>`:""}
      ${(f.shipperName||f.shipperStreet||f.shipperCity||f.shipperProvState||f.shipperPostalZip||f.shipperCountry)&&(f.consigneeName||f.consigneeStreet||f.consigneeCity||f.consigneeProvState||f.consigneePostalZip||f.consigneeCountry)?`<div style="width:1px;background:#e2e8f0"></div>`:""}
      ${(f.consigneeName||f.consigneeStreet||f.consigneeCity||f.consigneeProvState||f.consigneePostalZip||f.consigneeCountry)?`
      <div style="flex:1">
        <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px">🏁 Consignee</div>
        ${f.consigneeName?`<div style="font-size:12px;font-weight:700;color:#111;margin-bottom:2px">${f.consigneeName}</div>`:""}
        ${f.consigneeStreet?`<div style="font-size:11px;color:#555">${f.consigneeStreet}</div>`:""}
        <div style="font-size:11px;color:#555">${[f.consigneeCity,f.consigneeProvState,f.consigneePostalZip,f.consigneeCountry].filter(Boolean).join(", ")}</div>
      </div>`:""}
    </div>`:""}

    <table class="items">
      <thead><tr>
        <th>QTY</th><th>Description</th><th>Unit Price</th><th>Amount</th>
      </tr></thead>
      <tbody>${lineRows}</tbody>
    </table>

    <div class="totals">
      ${convNote}
      <table><tbody>
        ${totalRows}
        ${taxRow}
        ${otherRow}
        <tr class="total-row"><td class="lbl">TOTAL (${cur})</td><td class="val">${sym}${grandTotal!==null?grandTotal.toFixed(2):"—"}</td></tr>
      </tbody></table>
    </div>

    ${f.scopeOfWork?`
    <div style="margin-bottom:20px;padding:14px 16px;background:#fff7ed;border-left:4px solid #f97316;border-radius:0 4px 4px 0">
      <div style="font-size:9px;font-weight:700;color:#f97316;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Scope of Work / Quote Details</div>
      <div style="font-size:12px;color:#1e293b;line-height:1.7;white-space:pre-wrap">${f.scopeOfWork}</div>
    </div>`:""}

    ${f.notes?`<div class="notes-section"><div class="notes-label">Notes &amp; Details</div><div class="notes-text">${f.notes}</div></div>`:""}

    <div class="signature">
      <div class="sig-box">Authorized Rep &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
      <div class="sig-box">Date</div>
    </div>
    ${f.salesperson?`<div style="margin-top:16px;font-size:11px;color:#555">Prepared by: <strong>${f.salesperson}</strong></div>`:""}

    <div class="no-print" style="margin-top:24px;text-align:center">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700">Print / Save as PDF</button>
    </div>
    </body></html>`;

    const blob = new Blob([html],{type:"text/html"});
    const url = URL.createObjectURL(blob);
    window.open(url,"_blank");
    URL.revokeObjectURL(url);
  };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDiv, setFilterDiv] = useState("all");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const filteredQuotes = quotes.filter(q => {
    const s = search.toLowerCase().trim();
    if(s) {
      const match =
        (q.quoteNum||"").toLowerCase().includes(s) ||
        (q.cliName||"").toLowerCase().includes(s) ||
        (q.project||"").toLowerCase().includes(s) ||
        (q.attention||"").toLowerCase().includes(s) ||
        (q.salesperson||"").toLowerCase().includes(s) ||
        (q.lines||[]).some(l=>(l.desc||"").toLowerCase().includes(s));
      if(!match) return false;
    }
    if(filterStatus!=="all" && q.status!==filterStatus) return false;
    if(filterDiv!=="all" && q.divId!==filterDiv) return false;
    if(filterFrom && q.date < filterFrom) return false;
    if(filterTo && q.date > filterTo) return false;
    return true;
  });

  const statusColor = s => s==="sent"?"#0ea5e9":s==="accepted"?"#22c55e":s==="declined"?"#ef4444":"#94a3b8";
  const statusLabel = s => s==="sent"?"Sent":s==="accepted"?"Accepted":s==="declined"?"Declined":"Draft";

  // ── LIST VIEW ──
  if(view==="list") return (
    <div style={{padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:18,fontWeight:700,color:T.text}}>Quotes</div>
        <button onClick={startNew} style={{...sBtn,background:T.red,color:"#fff",border:"none",padding:"8px 16px",fontSize:12}}>+ New Quote</button>
      </div>

      {/* Search & Filters */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:12,marginBottom:16}}>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
          {/* Search box */}
          <div style={{flex:"1 1 220px"}}>
            <label style={sLbl}>Search</label>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:T.muted,fontSize:13}}>🔍</span>
              <input style={{...sIn,paddingLeft:28}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Quote #, client, project, description..."/>
            </div>
          </div>
          {/* Status filter */}
          <div style={{flex:"0 0 130px"}}>
            <label style={sLbl}>Status</label>
            <select style={sIn} value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
              <option value="all">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
            </select>
          </div>
          {/* Division filter */}
          <div style={{flex:"0 0 130px"}}>
            <label style={sLbl}>Division</label>
            <select style={sIn} value={filterDiv} onChange={e=>setFilterDiv(e.target.value)}>
              <option value="all">All Divisions</option>
              {DIVISIONS.map(d=><option key={d.id} value={d.id}>{d.short}</option>)}
            </select>
          </div>
          {/* Date range */}
          <div style={{flex:"0 0 130px"}}>
            <label style={sLbl}>From Date</label>
            <input type="date" style={sIn} value={filterFrom} onChange={e=>setFilterFrom(e.target.value)}/>
          </div>
          <div style={{flex:"0 0 130px"}}>
            <label style={sLbl}>To Date</label>
            <input type="date" style={sIn} value={filterTo} onChange={e=>setFilterTo(e.target.value)}/>
          </div>
          {/* Clear */}
          {(search||filterStatus!=="all"||filterDiv!=="all"||filterFrom||filterTo) &&
            <button onClick={()=>{setSearch("");setFilterStatus("all");setFilterDiv("all");setFilterFrom("");setFilterTo("");}}
              style={{...sBtn,alignSelf:"flex-end",padding:"7px 12px",fontSize:11}}>✕ Clear</button>
          }
        </div>
        <div style={{fontSize:10,color:T.dim,marginTop:8}}>
          {filteredQuotes.length} of {quotes.length} quote{quotes.length!==1?"s":""}
          {filteredQuotes.length>0 && ` · Total: $${filteredQuotes.reduce((a,q)=>a+calcTotal(q),0).toFixed(2)}`}
        </div>
      </div>

      {loading ? <div style={{color:T.muted,fontSize:13}}>Loading...</div> : filteredQuotes.length===0 ? (
        <div style={{textAlign:"center",padding:"40px 20px",color:T.muted}}>
          <div style={{fontSize:32,marginBottom:10}}>🔍</div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>{quotes.length===0?"No quotes yet":"No quotes match your search"}</div>
          <div style={{fontSize:12}}>{quotes.length===0?"Create your first quote to get started":"Try adjusting your filters"}</div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          {[
            {key:"draft",   label:"Draft",    color:"#94a3b8", bg:"rgba(148,163,184,0.1)"},
            {key:"sent",    label:"Sent",     color:"#0ea5e9", bg:"rgba(14,165,233,0.08)"},
            {key:"accepted",label:"Accepted", color:"#22c55e", bg:"rgba(34,197,94,0.08)"},
            {key:"declined",label:"Declined", color:"#ef4444", bg:"rgba(239,68,68,0.08)"},
          ].map(grp => {
            const grpQuotes = filteredQuotes.filter(q=>(q.status||"draft")===grp.key);
            if(grpQuotes.length===0) return null;
            const collapsed = collapsedGroups[grp.key];
            const grpTotal = grpQuotes.reduce((a,q)=>a+calcTotal(q),0);
            return (
              <div key={grp.key}>
                {/* Group header */}
                <button onClick={()=>toggleGroup(grp.key)} style={{width:"100%",background:grp.bg,border:`1px solid ${grp.color}40`,borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",marginBottom:collapsed?0:6,fontFamily:"inherit"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:grp.color}}/>
                    <span style={{fontSize:12,fontWeight:700,color:grp.color,textTransform:"uppercase",letterSpacing:"0.05em"}}>{grp.label}</span>
                    <span style={{fontSize:11,background:`${grp.color}20`,color:grp.color,padding:"1px 8px",borderRadius:10,fontWeight:700}}>{grpQuotes.length}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:12}}>
                    <span style={{fontSize:12,fontWeight:600,color:grp.color}}>${grpTotal.toFixed(2)}</span>
                    <span style={{fontSize:11,color:grp.color}}>{collapsed?"▶":"▼"}</span>
                  </div>
                </button>
                {/* Group rows */}
                {!collapsed && <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {grpQuotes.map(q=>(
                    <div key={q.id} style={{background:T.card,border:`1px solid ${T.border}`,borderLeft:`3px solid ${grp.color}`,borderRadius:"0 8px 8px 0",padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                          <span style={{fontSize:13,fontWeight:700,color:T.text}}>{q.quoteNum}</span>
                          {q.divId&&<span style={{fontSize:10,color:T.muted,background:T.hover,padding:"1px 6px",borderRadius:4}}>{DIVISIONS.find(d=>d.id===q.divId)?.short}</span>}
                        </div>
                        <div style={{fontSize:12,fontWeight:600,color:T.text}}>{q.cliName||"—"}</div>
                        <div style={{fontSize:11,color:T.muted,marginTop:1}}>
                          {fd(q.date)}{q.project?` · ${q.project}`:""}{q.salesperson?` · ${q.salesperson}`:""}
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                        <div style={{fontSize:15,fontWeight:700,color:T.green,minWidth:80,textAlign:"right"}}>${calcTotal(q).toFixed(2)}</div>
                        {/* Quick status change */}
                        <select value={q.status||"draft"} onChange={e=>{ const newStatus=e.target.value; if(window.confirm(`Change status to "${newStatus.charAt(0).toUpperCase()+newStatus.slice(1)}"?`)) changeStatus(q.id,newStatus); else e.target.value=q.status||"draft"; }}
                          style={{fontSize:10,padding:"3px 6px",borderRadius:6,border:`1px solid ${grp.color}`,background:grp.bg,color:grp.color,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                          <option value="draft">Draft</option>
                          <option value="sent">Sent</option>
                          <option value="accepted">Accepted</option>
                          <option value="declined">Declined</option>
                        </select>
                        <button onClick={()=>startEdit(q)} style={{...sBtn,fontSize:10,padding:"4px 10px"}}>Edit</button>
                        <button onClick={()=>generatePDF(q)} style={{...sBtn,fontSize:10,padding:"4px 10px",background:"rgba(220,38,38,0.1)",color:T.red,border:`1px solid ${T.red}`}}>PDF</button>
                        <button onClick={()=>deleteQuote(q.id)} style={{...sBtn,fontSize:10,padding:"4px 8px",color:"#ef4444",border:"1px solid #ef4444"}}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ── FORM VIEW ──
  const div = DIVISIONS.find(d=>d.id===form.divId)||DIVISIONS[0];
  const fcur = form.currency || (form.divId==="us"?"USD":"CAD");  // default for line items
  const totalCur = form.totalCurrency || fcur;                    // grand total currency only
  const fsym = symFor(fcur);
  const tsym = symFor(totalCur);
  const byCur = subtotalByCurrency(form.lines||[], fcur);
  const needsConversion = Object.keys(byCur).length > 1 || (Object.keys(byCur).length === 1 && Object.keys(byCur)[0] !== totalCur);
  const taxRate = parseFloat(form.taxRate)||0;
  const otherAmt = parseFloat(form.other)||0;
  const convertedSub = needsConversion && Object.keys(fxRates).length
    ? convertToTarget(byCur, totalCur, fxRates)
    : Object.values(byCur).reduce((a,v)=>a+v, 0);
  const taxAmt = convertedSub !== null ? convertedSub * (taxRate/100) : 0;
  const total = convertedSub !== null ? convertedSub + taxAmt + otherAmt : null;
  const sub = subtotal(form.lines||[]);

  return (
    <div style={{padding:20,maxWidth:900}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <button onClick={()=>setView("list")} style={{...sBtn,padding:"5px 10px"}}>← Back</button>
          <div style={{fontSize:16,fontWeight:700,color:T.text}}>{editId?"Edit Quote":"New Quote"} — {form.quoteNum}</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <select value={form.status} onChange={e=>setF("status",e.target.value)} style={{...sIn,maxWidth:120,fontSize:11,padding:"5px 8px"}}>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
          </select>
          <button onClick={()=>{ save(); }} disabled={saving} style={{...sBtn,background:"#334155",color:T.text}}>{saving?"Saving...":"Save"}</button>
          <button onClick={async ()=>{ setForm(f=>({...f})); await generatePDF(); }} style={{...sBtn,background:T.red,color:"#fff",border:"none"}}>📄 Preview PDF</button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        {/* Division */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14}}>
          <label style={sLbl}>Division</label>
          <div style={{display:"flex",gap:8}}>
            {DIVISIONS.map(d=>(
              <button key={d.id} onClick={()=>{setF("divId",d.id);setF("currency",d.id==="us"?"USD":"CAD");setF("totalCurrency",d.id==="us"?"USD":"CAD");}} style={{flex:1,padding:"8px",borderRadius:6,border:`1px solid ${form.divId===d.id?T.red:T.border}`,background:form.divId===d.id?T.redDim:"transparent",color:form.divId===d.id?T.red:T.muted,fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                {d.short}
              </button>
            ))}
          </div>
          <div style={{fontSize:10,color:T.dim,marginTop:8,lineHeight:1.6,whiteSpace:"pre-line"}}>{div.addr}</div>
          <label style={{...sLbl,marginTop:12}}>Currency</label>
          <select style={sIn} value={form.currency||"CAD"} onChange={e=>setF("currency",e.target.value)}>
            <option value="CAD">CAD ($)</option>
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR (€)</option>
            <option value="GBP">GBP (£)</option>
          </select>
        </div>

        {/* Quote Info */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div><label style={sLbl}>Quote #</label><input style={sIn} value={form.quoteNum} onChange={e=>setF("quoteNum",e.target.value)}/></div>
            <div><label style={sLbl}>Date</label><input type="date" style={sIn} value={form.date} onChange={e=>setF("date",e.target.value)}/></div>
            <div><label style={sLbl}>Valid Until</label><input type="date" style={sIn} value={form.dueDate} onChange={e=>setF("dueDate",e.target.value)}/></div>
            <div><label style={sLbl}>Payment Terms</label>
              <select style={sIn} value={form.paymentTerms} onChange={e=>setF("paymentTerms",e.target.value)}>
                {PAYMENT_TERMS.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Client */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16}}>
        <label style={sLbl}>Client</label>
        <select style={{...sIn,marginBottom:10}} value={form.cliId} onChange={e=>pickClient(e.target.value)}>
          <option value="">— Select existing client —</option>
          {clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div><label style={sLbl}>Company Name *</label><input style={sIn} value={form.cliName} onChange={e=>setF("cliName",e.target.value)} placeholder="Client name"/></div>
          <div><label style={sLbl}>Contact Person</label><input style={sIn} value={form.cliContact} onChange={e=>setF("cliContact",e.target.value)} placeholder="Contact"/></div>
          <div><label style={sLbl}>Email</label><input style={sIn} value={form.cliEmail} onChange={e=>setF("cliEmail",e.target.value)} placeholder="email@client.com"/></div>
          <div><label style={sLbl}>Street Address</label><input style={sIn} value={form.cliStreet} onChange={e=>setF("cliStreet",e.target.value)} placeholder="Street"/></div>
          <div><label style={sLbl}>City</label><input style={sIn} value={form.cliCity} onChange={e=>setF("cliCity",e.target.value)} placeholder="City"/></div>
          <div><label style={sLbl}>Phone</label><input style={sIn} value={form.cliPhone} onChange={e=>setF("cliPhone",e.target.value)} placeholder="Phone"/></div>
          <div><label style={sLbl}>Province / State</label><input style={sIn} value={form.cliProvState} onChange={e=>setF("cliProvState",e.target.value)} placeholder="Province/State"/></div>
          <div><label style={sLbl}>Postal / Zip</label><input style={sIn} value={form.cliPostalZip} onChange={e=>setF("cliPostalZip",e.target.value)} placeholder="Postal"/></div>
          <div><label style={sLbl}>Country</label><input style={sIn} value={form.cliCountry} onChange={e=>setF("cliCountry",e.target.value)} placeholder="Country"/></div>
        </div>
      </div>

      {/* Shipper & Consignee */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        {/* Shipper */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:11,fontWeight:700,color:T.text,textTransform:"uppercase",letterSpacing:"0.05em"}}>📦 Shipper</span>
            <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>(optional)</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{gridColumn:"1/-1"}}><label style={sLbl}>Company Name</label><input style={sIn} value={form.shipperName||""} onChange={e=>setF("shipperName",e.target.value)} placeholder="Shipper company"/></div>
            <div style={{gridColumn:"1/-1"}}><label style={sLbl}>Street Address</label><input style={sIn} value={form.shipperStreet||""} onChange={e=>setF("shipperStreet",e.target.value)} placeholder="Street"/></div>
            <div><label style={sLbl}>City</label><input style={sIn} value={form.shipperCity||""} onChange={e=>setF("shipperCity",e.target.value)} placeholder="City"/></div>
            <div><label style={sLbl}>Province / State</label><input style={sIn} value={form.shipperProvState||""} onChange={e=>setF("shipperProvState",e.target.value)} placeholder="Province/State"/></div>
            <div><label style={sLbl}>Postal / Zip</label><input style={sIn} value={form.shipperPostalZip||""} onChange={e=>setF("shipperPostalZip",e.target.value)} placeholder="Postal"/></div>
            <div><label style={sLbl}>Country</label><input style={sIn} value={form.shipperCountry||""} onChange={e=>setF("shipperCountry",e.target.value)} placeholder="Country"/></div>
          </div>
        </div>
        {/* Consignee */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:11,fontWeight:700,color:T.text,textTransform:"uppercase",letterSpacing:"0.05em"}}>🏁 Consignee</span>
            <span style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>(optional)</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{gridColumn:"1/-1"}}><label style={sLbl}>Company Name</label><input style={sIn} value={form.consigneeName||""} onChange={e=>setF("consigneeName",e.target.value)} placeholder="Consignee company"/></div>
            <div style={{gridColumn:"1/-1"}}><label style={sLbl}>Street Address</label><input style={sIn} value={form.consigneeStreet||""} onChange={e=>setF("consigneeStreet",e.target.value)} placeholder="Street"/></div>
            <div><label style={sLbl}>City</label><input style={sIn} value={form.consigneeCity||""} onChange={e=>setF("consigneeCity",e.target.value)} placeholder="City"/></div>
            <div><label style={sLbl}>Province / State</label><input style={sIn} value={form.consigneeProvState||""} onChange={e=>setF("consigneeProvState",e.target.value)} placeholder="Province/State"/></div>
            <div><label style={sLbl}>Postal / Zip</label><input style={sIn} value={form.consigneePostalZip||""} onChange={e=>setF("consigneePostalZip",e.target.value)} placeholder="Postal"/></div>
            <div><label style={sLbl}>Country</label><input style={sIn} value={form.consigneeCountry||""} onChange={e=>setF("consigneeCountry",e.target.value)} placeholder="Country"/></div>
          </div>
        </div>
      </div>

      {/* Project Info */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div><label style={sLbl}>Project</label><input style={sIn} value={form.project} onChange={e=>setF("project",e.target.value)} placeholder="Project name"/></div>
          <div><label style={sLbl}>Attention</label><input style={sIn} value={form.attention} onChange={e=>setF("attention",e.target.value)} placeholder="Attention to"/></div>
          <div><label style={sLbl}>Salesperson</label>
            <select style={sIn} value={form.salesperson} onChange={e=>setF("salesperson",e.target.value)}>
              {SALESPERSONS.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Equipment */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16}}>
        <label style={sLbl}>Equipment Required</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
          {EQUIPMENT_TYPES.map(eq=>{
            const sel = (form.equipment||[]).includes(eq);
            return <button key={eq} onClick={()=>setF("equipment", sel?(form.equipment||[]).filter(x=>x!==eq):[...(form.equipment||[]),eq])}
              style={{padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1px solid ${sel?T.red:T.border}`,background:sel?T.redDim:"transparent",color:sel?T.red:T.muted}}>
              {eq}
            </button>;
          })}
        </div>
      </div>

      {/* Line Items */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16}}>
        <label style={sLbl}>Line Items</label>
        <div style={{display:"grid",gridTemplateColumns:"60px 1fr 140px 70px 120px 100px 32px",gap:6,marginBottom:6,padding:"0 4px"}}>
          {["QTY","DESCRIPTION","EQUIPMENT","CUR","UNIT PRICE","AMOUNT",""].map((h,i)=><div key={i} style={{fontSize:9,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",textAlign:i>=4?"right":"left"}}>{h}</div>)}
        </div>
        {(form.lines||[]).map((line,idx)=>{
          const lineCur = line.currency||fcur;
          const lineSym = symFor(lineCur);
          const amt = (parseFloat(line.qty)||0)*(parseFloat(line.unitPrice)||0);
          const isDiff = line.currency && line.currency !== fcur;
          return (
            <div key={line.id} style={{display:"grid",gridTemplateColumns:"60px 1fr 140px 70px 120px 100px 32px",gap:6,marginBottom:6,alignItems:"center"}}>
              <input style={{...sIn,textAlign:"center"}} value={line.qty} onChange={e=>updateLine(idx,"qty",e.target.value)} placeholder="1"/>
              <input style={sIn} value={line.desc} onChange={e=>updateLine(idx,"desc",e.target.value)} placeholder="Description..."/>
              <select style={{...sIn,fontSize:11}} value={line.equipment} onChange={e=>updateLine(idx,"equipment",e.target.value)}>
                <option value="">— Equipment —</option>
                {EQUIPMENT_TYPES.map(eq=><option key={eq}>{eq}</option>)}
              </select>
              <select style={{...sIn,fontSize:10,padding:"7px 4px",border:`1px solid ${isDiff?"#f97316":T.border}`,color:isDiff?"#f97316":T.muted}} value={line.currency||""} onChange={e=>updateLine(idx,"currency",e.target.value)}>
                <option value="">({fcur})</option>
                {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <input style={{...sIn,textAlign:"right"}} value={line.unitPrice} onChange={e=>updateLine(idx,"unitPrice",e.target.value)} placeholder="0.00"/>
              <div style={{fontSize:12,fontWeight:600,color:isDiff?"#f97316":T.text,textAlign:"right",padding:"7px 10px",background:T.surface,border:`1px solid ${isDiff?"#f97316":T.border}`,borderRadius:6}}>{amt>0?`${lineSym}${amt.toFixed(2)}`:"—"}</div>
              <button onClick={()=>removeLine(idx)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:14,padding:4}}>✕</button>
            </div>
          );
        })}
        <button onClick={addLine} style={{...sBtn,marginTop:4,fontSize:11,padding:"5px 12px"}}>+ Add Line</button>
      </div>

      {/* Totals */}
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:16,marginBottom:16}}>
        {/* Notes */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14}}>
          <label style={sLbl}>Notes / Disclaimer</label>
          <textarea style={{...sIn,minHeight:100,resize:"vertical"}} value={form.notes} onChange={e=>setF("notes",e.target.value)}/>
        </div>

        {/* Summary */}
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,minWidth:280}}>
          {/* Per-currency subtotals */}
          {Object.entries(byCur).map(([cur,amt])=>(
            <div key={cur} style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}>
              <span style={{color:T.muted}}>Subtotal {cur}</span>
              <span style={{fontWeight:600,color:cur!==fcur?"#f97316":T.text}}>{symFor(cur)}{amt.toFixed(2)}</span>
            </div>
          ))}
          {Object.keys(byCur).length===0 && <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span style={{color:T.muted}}>Subtotal</span><span style={{fontWeight:600}}>{fsym}0.00</span></div>}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:12,color:T.muted,flexShrink:0}}>Tax Rate</span>
            <input style={{...sIn,width:70,textAlign:"right"}} value={form.taxRate} onChange={e=>setF("taxRate",e.target.value)} placeholder="0"/>
            <span style={{fontSize:12,color:T.muted}}>%</span>
            <span style={{fontSize:12,fontWeight:600,marginLeft:"auto"}}>{fsym}{taxAmt.toFixed(2)}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <input style={{...sIn,flex:1,fontSize:11}} value={form.otherLabel} onChange={e=>setF("otherLabel",e.target.value)} placeholder="Other label"/>
            <input style={{...sIn,width:90,textAlign:"right"}} value={form.other} onChange={e=>setF("other",e.target.value)} placeholder="0.00"/>
          </div>
          {/* Quote total currency selector */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:11,color:T.muted,flexShrink:0}}>Total Currency</span>
            <select style={{...sIn,flex:1,fontSize:11}} value={form.totalCurrency||fcur} onChange={e=>setF("totalCurrency",e.target.value)}>
              {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {needsConversion && fxLoading && <div style={{fontSize:10,color:T.muted,marginBottom:6,fontStyle:"italic"}}>⏳ Fetching live rates...</div>}
          {needsConversion && !fxLoading && fxDate && <div style={{fontSize:10,color:T.dim,marginBottom:6,fontStyle:"italic"}}>Rate as of {fxDate}</div>}
          <div style={{borderTop:`2px solid ${T.border}`,paddingTop:10,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:14,fontWeight:700,color:T.text}}>TOTAL ({totalCur})</span>
            <span style={{fontSize:18,fontWeight:800,color:T.green}}>
              {fxLoading ? "..." : total !== null ? `${tsym}${total.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Scope of Work — shown on client PDF */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,padding:14,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:700,color:"#f97316",textTransform:"uppercase",letterSpacing:"0.05em"}}>📋 Scope of Work / Quote Details</span>
          <span style={{fontSize:10,color:"#f97316",background:"rgba(249,115,22,0.12)",padding:"2px 8px",borderRadius:10,fontWeight:600}}>Visible on client PDF</span>
        </div>
        <textarea
          style={{...sIn,minHeight:120,resize:"vertical",fontSize:13}}
          placeholder={"Describe what's included in this quote...\ne.g. Transport of DHL cargo from YUL to YYZ, includes fuel surcharge, 2 drivers, overnight. All-in price — no additional charges."}
          value={form.scopeOfWork||""}
          onChange={e=>setF("scopeOfWork",e.target.value)}
        />
      </div>

      {/* Internal Notes — not shown on PDF */}
      <div style={{background:"#fefce8",border:"1px solid #fde047",borderRadius:8,padding:14,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:700,color:"#854d0e",textTransform:"uppercase",letterSpacing:"0.05em"}}>🔒 Internal Notes</span>
          <span style={{fontSize:10,color:"#a16207",background:"#fef08a",padding:"2px 8px",borderRadius:10,fontWeight:600}}>NOT shown on client PDF</span>
        </div>
        <textarea
          style={{width:"100%",padding:"10px 12px",borderRadius:6,border:"1px solid #fde047",background:"#fffbeb",fontSize:13,fontFamily:"inherit",resize:"vertical",minHeight:130,color:"#1a1a1a",outline:"none",boxSizing:"border-box"}}
          placeholder="Job details, scheduling notes, client instructions..."
          value={form.internalNotes||""}
          onChange={e=>setF("internalNotes",e.target.value)}
        />
      </div>

      {/* Save buttons */}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={()=>setView("list")} style={sBtn}>Cancel</button>
        <button onClick={()=>save("draft")} disabled={saving} style={{...sBtn,background:"#334155",color:T.text}}>{saving?"Saving...":"Save Draft"}</button>
        <button onClick={()=>{ save("sent"); }} disabled={saving} style={{...sBtn,background:T.blue,color:"#fff",border:"none"}}>{saving?"Saving...":"Save as Sent"}</button>
        <button onClick={()=>{ save("accepted"); }} disabled={saving} style={{...sBtn,background:"#16a34a",color:"#fff",border:"none"}}>{saving?"Saving...":"✓ Mark Accepted"}</button>
        <button onClick={()=>{ save("declined"); }} disabled={saving} style={{...sBtn,background:"#dc2626",color:"#fff",border:"none"}}>{saving?"Saving...":"✕ Mark Declined"}</button>
        <button onClick={async ()=>{ setForm(f=>({...f})); await generatePDF(); }} style={{...sBtn,background:T.red,color:"#fff",border:"none"}}>📄 Generate PDF</button>
      </div>
    </div>
  );
}

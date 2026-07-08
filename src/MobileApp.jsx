// ═══════════════════════════════════════════════════════════════
//  MobileApp.jsx — DBX Dispatch Mobile View
//  4 tabs: Orders | Clients & Locations | Equipment | Documents
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect } from "react";
import { db as db_inst, storage } from "./firebase.js";
import { collection, getDocs, addDoc, updateDoc, doc, orderBy, query, where } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { DIVISIONS, COMPANY_NAME, APP_NAME } from "./client.config.js";

// ── Theme ──
const T = {
  bg:"#020817", card:"#0f172a", surface:"#1e293b", border:"#1e293b",
  text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b", hover:"#1e293b",
  red:"#dc2626", redDim:"rgba(220,38,38,0.1)",
  green:"#22c55e", greenDim:"rgba(34,197,94,0.1)",
  amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)",
  blue:"#3b82f6", blueDim:"rgba(59,130,246,0.1)",
};

// ── Shared styles ──
const inp = { width:"100%", padding:"12px 14px", borderRadius:8, border:`1px solid ${T.border}`, background:T.surface, color:T.text, fontFamily:"inherit", fontSize:15, outline:"none", boxSizing:"border-box" };
const lbl = { display:"block", fontSize:11, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", color:T.muted, marginBottom:6, marginTop:12 };
const btn = (color=T.red) => ({ padding:"12px 20px", borderRadius:10, border:"none", background:color, color:"#fff", fontFamily:"inherit", fontSize:14, fontWeight:700, cursor:"pointer", width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:8 });
const outBtn = (color=T.muted) => ({ padding:"11px 20px", borderRadius:10, border:`1px solid ${color}`, background:"transparent", color, fontFamily:"inherit", fontSize:14, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 });
const card = { background:T.card, border:`1px solid ${T.border}`, borderRadius:12, padding:16, marginBottom:12 };

// ── Icons ──
function Ic({ n, s=18 }) {
  const paths = {
    orders:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    clients:"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0",
    equipment:"M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10l2 0m8 0H9m4 0h2m4 0h2v-4l-2-4H9",
    docs:"M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    plus:"M12 4v16m8-8H4",
    back:"M10 19l-7-7m0 0l7-7m-7 7h18",
    search:"M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z",
    x:"M6 18L18 6M6 6l12 12",
    check:"M5 13l4 4L19 7",
    file:"M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    download:"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
    desktop:"M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
    upload:"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12",
    location:"M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z",
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[n]}/>
    </svg>
  );
}

// ── Status badge ──
function StatusBadge({ status }) {
  const cfg = {
    "unassigned":   { bg:"rgba(100,116,139,0.2)", c:"#94a3b8",  l:"Unassigned" },
    "assigned":     { bg:"rgba(59,130,246,0.15)", c:"#60a5fa",  l:"Assigned" },
    "in-transit":   { bg:"rgba(245,158,11,0.15)", c:"#fbbf24",  l:"In Transit" },
    "ready-to-bill":{ bg:"rgba(168,85,247,0.2)",  c:"#a855f7",  l:"Ready to Bill" },
    "closed":       { bg:"rgba(34,197,94,0.2)",   c:"#22c55e",  l:"Closed" },
    "invoiced":     { bg:"rgba(59,130,246,0.2)",  c:"#3b82f6",  l:"Invoiced" },
    "cancelled":    { bg:"rgba(239,68,68,0.15)",  c:"#f87171",  l:"Cancelled" },
  };
  const s = cfg[status] || { bg:"rgba(100,116,139,0.2)", c:"#94a3b8", l:status||"Unknown" };
  return <span style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:20, background:s.bg, color:s.c, whiteSpace:"nowrap" }}>{s.l}</span>;
}

// ── Expiry badge ──
function ExpiryBadge({ date }) {
  if (!date) return null;
  const days = Math.ceil((new Date(date+"T12:00:00") - new Date()) / 86400000);
  if (days < 0) return <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10, background:T.redDim, color:T.red }}>EXPIRED</span>;
  if (days <= 30) return <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10, background:T.amberDim, color:T.amber }}>Expires {days}d</span>;
  return <span style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:10, background:T.greenDim, color:T.green }}>Valid</span>;
}

const fd = d => d ? new Date(d+"T12:00:00").toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"}) : "—";
const uid = () => Math.random().toString(36).slice(2,10);

// ════════════════════════════════════════════════════════════════
//  ORDERS TAB
// ════════════════════════════════════════════════════════════════
function OrdersTab({ db, savOrd }) {
  const [view, setView]       = useState("list");
  const [search, setSearch]   = useState("");
  const [selOrder, setSelOrder] = useState(null);
  const [statusFlt, setStatusFlt] = useState("all");
  const [showBolModal, setShowBolModal] = useState(false);
  const [bolMode, setBolMode]   = useState("auto");
  const [bolInput, setBolInput] = useState("");
  const [bolError, setBolError] = useState("");
  const [customBol, setCustomBol] = useState(null);

  const STATUSES = [
    ["all","All"],
    ["unassigned","Unassigned"],
    ["assigned","Assigned"],
    ["in-transit","In Transit"],
    ["ready-to-bill","Ready to Bill"],
    ["closed","Closed"],
    ["invoiced","Invoiced"],
    ["cancelled","Cancelled"],
  ];

  const filtered = (db.orders||[])
    .filter(o => statusFlt === "all" ? true : o.status === statusFlt)
    .filter(o => !search || (o.bol||"").includes(search) || (o.cliName||"").toLowerCase().includes(search.toLowerCase()) || (o.ref||"").toLowerCase().includes(search.toLowerCase()))
    .sort((a,b) => {
      const da = new Date(a.reqDate||a.createdAt||0);
      const db2 = new Date(b.reqDate||b.createdAt||0);
      if(db2-da !== 0) return db2-da;
      return (parseInt(b.bol)||0)-(parseInt(a.bol)||0);
    });

  const openNewOrder = () => { setBolMode("auto"); setBolInput(""); setBolError(""); setShowBolModal(true); };

  const confirmNewOrder = () => {
    if(bolMode==="custom") {
      const val = bolInput.trim();
      if(!val) { setBolError("Please enter a BOL number."); return; }
      const existing = (db.orders||[]).find(o => String(o.bol) === val);
      if(existing) { setBolError(`BOL #${val} already exists (${existing.cliName||"order"}, ${existing.status}).`); return; }
      setCustomBol(val);
    } else {
      setCustomBol(null);
    }
    setShowBolModal(false);
    setView("new");
  };

  if (view === "new" || view === "edit")
    return <OrderForm db={db} order={view==="edit"?selOrder:null} customBol={view==="new"?customBol:null} savOrd={savOrd} onBack={()=>{ if(view==="edit"){setView("detail");}else{setView("list");} }} onSaved={o=>{ setSelOrder(o); setView("detail"); }}/>;

  if (view === "detail" && selOrder)
    return <OrderDetail order={(db.orders||[]).find(x=>x.id===selOrder.id)||selOrder} db={db} savOrd={savOrd} onBack={()=>setView("list")} onEdit={()=>setView("edit")} onStatusChange={o=>{setSelOrder(o);}}/>;

  return (
    <div style={{ padding:16 }}>
      {/* Search + New */}
      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
        <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 14px" }}>
          <Ic n="search" s={16}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search BOL, client, ref..." style={{ background:"transparent", border:"none", color:T.text, fontSize:15, outline:"none", flex:1, fontFamily:"inherit" }}/>
          {search && <button onClick={()=>setSearch("")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", padding:0, display:"flex" }}><Ic n="x" s={14}/></button>}
        </div>
        <button onClick={openNewOrder} style={{ ...btn(T.red), width:"auto", padding:"10px 16px", borderRadius:10, flexShrink:0 }}><Ic n="plus" s={18}/></button>
      </div>

      {/* BOL modal */}
      {showBolModal && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={e=>{if(e.target===e.currentTarget)setShowBolModal(false);}}>
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:"16px 16px 0 0",padding:"20px 16px 32px",width:"100%",maxWidth:480,boxShadow:"0 -8px 40px rgba(0,0,0,0.5)"}}>
          <div style={{width:36,height:4,borderRadius:2,background:T.border,margin:"0 auto 16px"}}/>
          <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:4}}>New Order</div>
          <div style={{fontSize:12,color:T.muted,marginBottom:16}}>Choose how to assign the BOL number</div>

          <label style={{display:"flex",alignItems:"center",gap:12,padding:"12px",borderRadius:10,cursor:"pointer",marginBottom:8,background:bolMode==="auto"?"rgba(220,38,38,0.08)":"transparent",border:`1px solid ${bolMode==="auto"?T.red:T.border}`}}>
            <input type="radio" checked={bolMode==="auto"} onChange={()=>{setBolMode("auto");setBolError("");}} style={{accentColor:T.red,width:16,height:16}}/>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:T.text}}>Auto-generate BOL #</div>
              <div style={{fontSize:12,color:T.muted}}>Next number in sequence</div>
            </div>
          </label>

          <label style={{display:"flex",alignItems:"center",gap:12,padding:"12px",borderRadius:10,cursor:"pointer",marginBottom:bolMode==="custom"?0:16,background:bolMode==="custom"?"rgba(220,38,38,0.08)":"transparent",border:`1px solid ${bolMode==="custom"?T.red:T.border}`}}>
            <input type="radio" checked={bolMode==="custom"} onChange={()=>{setBolMode("custom");setBolError("");}} style={{accentColor:T.red,width:16,height:16}}/>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:T.text}}>Custom BOL #</div>
              <div style={{fontSize:12,color:T.muted}}>Enter your own number</div>
            </div>
          </label>

          {bolMode==="custom" && <div style={{padding:"10px 0 4px"}}>
            <input
              autoFocus
              inputMode="numeric"
              style={{...inp,fontSize:18,fontWeight:700,letterSpacing:"0.05em",marginBottom:4}}
              placeholder="e.g. 1842"
              value={bolInput}
              onChange={e=>{setBolInput(e.target.value.replace(/\D/g,""));setBolError("");}}
              onKeyDown={e=>{if(e.key==="Enter")confirmNewOrder();}}
              maxLength={10}
            />
            {bolError && <div style={{fontSize:12,color:T.red,fontWeight:600,marginTop:4}}>{bolError}</div>}
          </div>}

          <div style={{display:"flex",gap:8,marginTop:16}}>
            <button style={{flex:1,padding:"14px",borderRadius:10,background:T.red,color:"#fff",border:"none",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}} onClick={confirmNewOrder}>
              Create Order
            </button>
            <button style={{padding:"14px 20px",borderRadius:10,background:"transparent",color:T.muted,border:`1px solid ${T.border}`,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}} onClick={()=>setShowBolModal(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>}

      {/* Status filter — scrollable chips */}
      <div style={{ display:"flex", gap:6, marginBottom:16, overflowX:"auto", paddingBottom:4, WebkitOverflowScrolling:"touch", scrollbarWidth:"none" }}>
        {STATUSES.map(([v,l])=>(
          <button key={v} onClick={()=>setStatusFlt(v)} style={{ padding:"6px 14px", borderRadius:20, border:`1px solid ${statusFlt===v?T.red:T.border}`, background:statusFlt===v?T.redDim:"transparent", color:statusFlt===v?T.red:T.muted, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap", flexShrink:0 }}>{l}</button>
        ))}
      </div>

      {/* Count */}
      <div style={{ fontSize:11, color:T.dim, marginBottom:10 }}>{filtered.length} order{filtered.length!==1?"s":""}</div>

      {/* Order list */}
      {filtered.length === 0 && <div style={{ textAlign:"center", color:T.muted, padding:"40px 0", fontSize:14 }}>No orders found</div>}
      {filtered.map(o => (
        <div key={o.id} onClick={()=>{ setSelOrder(o); setView("detail"); }} style={{ ...card, cursor:"pointer", borderLeft:`3px solid ${T.red}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
            <div style={{ fontSize:18, fontWeight:700, color:T.text }}>BOL {o.bol}</div>
            <StatusBadge status={o.status}/>
          </div>
          <div style={{ fontSize:13, color:T.muted, marginBottom:4 }}>{o.cliName||"—"}</div>
          {o.linkedEventName && <div style={{ fontSize:11, color:"#8b5cf6", fontWeight:600, marginBottom:2 }}>📋 {o.linkedEventName}</div>}
          {o.ref && <div style={{ fontSize:12, color:T.dim }}>Ref: {o.ref}</div>}
          <div style={{ fontSize:11, color:T.dim, marginTop:6 }}>{fd(o.reqDate)}{o.drvName ? ` · ${o.drvName}` : ""}</div>
        </div>
      ))}
    </div>
  );
}

// ── Order Detail (mobile) ──
function OrderDetail({ order: initOrder, db, savOrd, onBack, onEdit, onStatusChange }) {
  const [o, setO] = useState(initOrder);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [saving, setSaving] = useState(false);
  const div = (DIVISIONS||[]).find(d=>d.id===o.divId);
  const sym = o.price?.cur==="USD" ? "US$" : "$";

  // Only allow advancing to ready-to-bill max — close/invoice handled in desktop
  const STATUS_FLOW = ["unassigned","assigned","in-transit","ready-to-bill"];
  const curIdx = STATUS_FLOW.indexOf(o.status);
  const nextStatus = curIdx >= 0 && curIdx < STATUS_FLOW.length-1 ? STATUS_FLOW[curIdx+1] : null;

  const update = (k,v) => setO(p=>({...p,[k]:v}));
  const updatePrice = (k,v) => setO(p=>({...p, price:{...(p.price||{}), [k]:v}}));

  const saveChanges = async (overrides={}) => {
    setSaving(true);
    try {
      const updated = {...o,...overrides};
      await savOrd(updated);
      setO(updated);
      onStatusChange(updated);
    } catch(e) { alert("Error saving"); }
    setSaving(false);
  };

  const advanceStatus = async () => {
    if(!nextStatus) return;
    // Require pricing before ready-to-bill
    if(nextStatus==="ready-to-bill" && !(parseFloat(o.price?.base)>0)) {
      alert("Please add pricing (Base Price) before marking as Ready to Bill."); return;
    }
    // Warn if PO required but missing
    if(o.poRequired && !o.poNumber && nextStatus==="ready-to-bill") {
      if(!window.confirm("⚠ This order requires a PO number.\n\nContinue without PO?")) return;
    }
    setUpdatingStatus(true);
    await saveChanges({status:nextStatus});
    setUpdatingStatus(false);
  };

  const Row = ({l,v}) => v ? <div style={{marginBottom:10}}>
    <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</div>
    <div style={{fontSize:14,color:T.text,marginTop:2}}>{v}</div>
  </div> : null;

  const baseAmt = parseFloat(o.price?.base)||0;
  const fuelPct = parseFloat(o.price?.fuelPct)||0;
  const fuelAmt = baseAmt*(fuelPct/100);
  const total = baseAmt+fuelAmt;

  return (
    <div style={{padding:16,paddingBottom:40}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",display:"flex",padding:0}}><Ic n="back" s={22}/></button>
        <div>
          <div style={{fontSize:20,fontWeight:700,color:T.text}}>BOL {o.bol}</div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4,flexWrap:"wrap"}}>
            <StatusBadge status={o.status}/>
            {o.poRequired && !o.poNumber && <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:"rgba(249,115,22,0.15)",color:"#f97316"}}>PO Required</span>}
          </div>
        </div>
        <button onClick={onEdit} style={{marginLeft:"auto",...outBtn(T.muted),padding:"8px 16px",fontSize:13}}>Edit</button>
      </div>

      {/* Advance status button */}
      {nextStatus && (
        <button onClick={advanceStatus} disabled={updatingStatus||saving} style={{...btn(T.green),marginBottom:16,borderRadius:10}}>
          <Ic n="check" s={18}/> {updatingStatus?"Updating...":`Mark as ${nextStatus.replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase())}`}
        </button>
      )}

      {/* PO Number */}
      {o.poRequired && <div style={{...card,marginBottom:12,border:`1px solid #f97316`}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f97316",textTransform:"uppercase",marginBottom:8}}>PO Number Required</div>
        <div style={{display:"flex",gap:8}}>
          <input value={o.poNumber||""} onChange={e=>update("poNumber",e.target.value)}
            placeholder="Enter PO #" style={{...inp,flex:1,padding:"10px 12px"}}/>
          <button onClick={()=>saveChanges({poNumber:o.poNumber})} disabled={saving}
            style={{...btn(T.green),width:"auto",padding:"10px 16px",borderRadius:8,fontSize:13}}>{saving?"...":"Save"}</button>
        </div>
      </div>}

      {/* Pricing card */}
      <div style={{...card,marginBottom:12}}>
        <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:10}}>Pricing</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <label style={{fontSize:10,color:T.muted,display:"block",marginBottom:4}}>Currency</label>
            <select style={{...inp,padding:"8px 10px"}} value={o.price?.cur||"CAD"} onChange={e=>updatePrice("cur",e.target.value)}>
              <option value="CAD">CAD ($)</option>
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
              <option value="GBP">GBP (£)</option>
            </select>
          </div>
          <div>
            <label style={{fontSize:10,color:T.muted,display:"block",marginBottom:4}}>Base Price</label>
            <input type="number" step="0.01" style={{...inp,padding:"8px 10px"}} value={o.price?.base||""} onChange={e=>updatePrice("base",e.target.value)} placeholder="0.00"/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          <div>
            <label style={{fontSize:10,color:T.muted,display:"block",marginBottom:4}}>Fuel Surcharge %</label>
            <input type="number" step="0.1" style={{...inp,padding:"8px 10px"}} value={o.price?.fuelPct||""} onChange={e=>updatePrice("fuelPct",e.target.value)} placeholder="0"/>
          </div>
          {fuelAmt>0 && <div style={{display:"flex",flexDirection:"column",justifyContent:"flex-end",paddingBottom:4}}>
            <span style={{fontSize:11,color:T.muted}}>Fuel: {sym}{fuelAmt.toFixed(2)}</span>
            <span style={{fontSize:13,fontWeight:700,color:T.green}}>Total: {sym}{total.toFixed(2)}</span>
          </div>}
        </div>
        {baseAmt>0 && fuelAmt===0 && <div style={{fontSize:13,fontWeight:700,color:T.green}}>Total: {sym}{baseAmt.toFixed(2)} {o.price?.cur||"CAD"}</div>}
        <button onClick={()=>saveChanges()} disabled={saving}
          style={{...btn(T.red),marginTop:8,borderRadius:8,padding:"10px",fontSize:13}}>{saving?"Saving...":"Save Pricing"}</button>
      </div>

      {/* POD section */}
      <div style={{...card,marginBottom:12}}>
        <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:10}}>POD (Proof of Delivery)</div>
        <label style={{fontSize:10,color:T.muted,display:"block",marginBottom:4}}>Received by</label>
        <input style={{...inp,padding:"10px 12px",marginBottom:8}} value={o.podBy||""} onChange={e=>update("podBy",e.target.value)} placeholder="Name of receiver"/>
        <label style={{fontSize:10,color:T.muted,display:"block",marginBottom:4}}>Date</label>
        <input type="date" style={{...inp,padding:"10px 12px",marginBottom:12}} value={o.podDate||""} onChange={e=>update("podDate",e.target.value)}/>
        <button onClick={()=>saveChanges()} disabled={saving}
          style={{...btn(T.red),borderRadius:8,padding:"10px",fontSize:13}}>{saving?"Saving...":"Save POD"}</button>
        {o.podBy && <div style={{marginTop:8,fontSize:12,color:T.green}}>✓ POD on file — {o.podBy}{o.podDate?` · ${fd(o.podDate)}`:""}</div>}
      </div>

      {/* PO Required toggle */}
      <div style={{...card,marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:T.text}}>PO Required</div>
            <div style={{fontSize:11,color:T.muted}}>Block billing until PO # is entered</div>
          </div>
          <button onClick={()=>saveChanges({poRequired:!o.poRequired})} style={{
            width:48,height:26,borderRadius:13,border:"none",cursor:"pointer",transition:"all 0.2s",
            background:o.poRequired?"#22c55e":"#334155",position:"relative"
          }}>
            <span style={{position:"absolute",top:3,left:o.poRequired?24:4,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"all 0.2s"}}/>
          </button>
        </div>
      </div>

      {/* Order info */}
      <div style={card}>
        <Row l="Client" v={o.cliName}/>
        <Row l="Bill To" v={o.billTo}/>
        <Row l="Division" v={div?.name}/>
        <Row l="Reference" v={o.ref}/>
        <Row l="Event" v={o.linkedEventName}/>
        <Row l="Request Date" v={fd(o.reqDate)}/>
      </div>

      {o.notes && <div style={card}>
        <div style={{fontSize:12,fontWeight:700,color:T.muted,textTransform:"uppercase",marginBottom:8}}>Notes</div>
        <div style={{fontSize:14,color:T.text,lineHeight:1.6}}>{o.notes}</div>
      </div>}
    </div>
  );
}

// ── Order Form (new/edit) ──
function OrderForm({ db, order, customBol, savOrd, onBack, onSaved }) {
  const isNew = !order;
  const nextBol = isNew
    ? (customBol || ((db.orders||[]).reduce((m,o)=>Math.max(m,parseInt(o.bol)||0),0)+1).toString())
    : order.bol;
  const [o, setO] = useState(order || {
    bol:nextBol, status:"unassigned", orderType:"transport", divId:"ca",
    reqDate:new Date().toISOString().slice(0,10),
    items:[{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}],
    pickStops:[{co:"",addr:"",date:""}],
    delStops:[{co:"",addr:"",date:""}],
  });
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setO(p=>({...p,[k]:v}));
  const locs = [...(db.locations||[])].sort((a,b)=>(a.company||"").localeCompare(b.company||""));

  const setItem = (i,k,v) => setO(p=>({...p,items:p.items.map((it,j)=>j===i?{...it,[k]:v}:it)}));
  const setPickStop = (i,k,v) => setO(p=>({...p,pickStops:(p.pickStops||[]).map((s,j)=>j===i?{...s,[k]:v}:s)}));
  const setDelStop  = (i,k,v) => setO(p=>({...p,delStops: (p.delStops||[]).map((s,j)=>j===i?{...s,[k]:v}:s)}));

  const save = async () => {
    if (!o.cliId) { alert("Please select a client"); return; }
    setSaving(true);
    try { const saved = await savOrd(o); onSaved(saved||o); }
    catch(e) { alert("Error saving order"); }
    setSaving(false);
  };

  const S = { ...inp, fontSize:16 }; // section input style

  return (
    <div style={{ padding:16, paddingBottom:40 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", display:"flex", padding:0 }}><Ic n="back" s={22}/></button>
        <div style={{ fontSize:18, fontWeight:700, color:T.text }}>{isNew ? `New Order — BOL ${nextBol}` : `Edit BOL ${o.bol}`}</div>
      </div>

      {/* Division & Client */}
      <div style={{ fontSize:11, fontWeight:700, color:T.red, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>Division & Client</div>
      <div style={card}>
        <label style={lbl}>Division</label>
        <select style={S} value={o.divId||""} onChange={e=>set("divId",e.target.value)}>
          {(DIVISIONS||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label style={lbl}>Client *</label>
        <select style={S} value={o.cliId||""} onChange={e=>{
          const c=(db.clients||[]).find(x=>x.id===e.target.value);
          set("cliId",e.target.value); set("cliName",c?.name||""); set("billTo",c?.name||"");
        }}>
          <option value="">Select client...</option>
          {[...(db.clients||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(c=><option key={c.id} value={c.id}>{c.name}{c.city?` — ${c.city}`:""}</option>)}
        </select>
        <label style={lbl}>Bill To</label>
        <input style={S} value={o.billTo||""} onChange={e=>set("billTo",e.target.value)}/>
        <label style={lbl}>Assign to Event</label>
        <select style={S} value={o.linkedEventId||""} onChange={e=>{
          const ev=(db.events||[]).find(x=>x.id===e.target.value);
          set("linkedEventId",e.target.value||""); set("linkedEventName",ev?.name||"");
        }}>
          <option value="">— No event —</option>
          {[...(db.events||[])].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}
        </select>
      </div>

      {/* Shipment Info */}
      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6, marginTop:16 }}>Shipment Info</div>
      <div style={card}>
        <label style={lbl}>Reference #</label>
        <input style={S} value={o.ref||""} onChange={e=>set("ref",e.target.value)} placeholder="AWB, PO, reference..."/>
        <label style={lbl}>Request Date</label>
        <input type="date" style={S} value={o.reqDate||""} onChange={e=>set("reqDate",e.target.value)}/>
      </div>

      {/* Pickup Stops */}
      {(o.pickStops||[{co:"",addr:"",date:""}]).map((stop,si)=>(
        <div key={si}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6, marginTop:16 }}>
            <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em" }}>{(o.pickStops||[]).length>1?`Pick Up — Stop ${si+1}`:"Pick Up"}</div>
            {si>0 && <button onClick={()=>setO(p=>({...p,pickStops:p.pickStops.filter((_,j)=>j!==si)}))} style={{ background:"none", border:"none", color:"#ef4444", cursor:"pointer", fontSize:13, fontWeight:700 }}>✕ Remove</button>}
          </div>
          <div style={card}>
            {locs.length>0 && <>
              <label style={lbl}>Quick Select Location</label>
              <select style={S} onChange={e=>{
                const l=locs.find(x=>x.id===e.target.value); if(!l)return;
                const stops=[...(o.pickStops||[])]; stops[si]={...stops[si],co:l.company||"",addr:[l.street,l.city,l.provState,l.postalZip,l.country].filter(Boolean).join("\n"),date:stops[si].date||""};
                setO(p=>({...p,pickStops:stops}));
              }}>
                <option value="">Select saved location...</option>
                {locs.map(l=><option key={l.id} value={l.id}>{l.company}{l.city?` — ${l.city}`:""}</option>)}
              </select>
            </>}
            <label style={lbl}>Company Name</label>
            <input style={S} value={stop.co||""} onChange={e=>setPickStop(si,"co",e.target.value)}/>
            <label style={lbl}>Address</label>
            <textarea style={{...S,minHeight:80,resize:"vertical"}} value={stop.addr||""} onChange={e=>setPickStop(si,"addr",e.target.value)}/>
            <label style={lbl}>Pickup Date</label>
            <input type="date" style={S} value={stop.date||""} onChange={e=>setPickStop(si,"date",e.target.value)}/>
          </div>
        </div>
      ))}
      <button onClick={()=>setO(p=>({...p,pickStops:[...(p.pickStops||[{co:"",addr:"",date:""}]),{co:"",addr:"",date:""}]}))} style={{...outBtn(T.muted), width:"100%", marginBottom:4, marginTop:4}}>+ Add Pickup Stop</button>

      {/* Delivery Stops */}
      {(o.delStops||[{co:"",addr:"",date:""}]).map((stop,si)=>(
        <div key={si}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6, marginTop:16 }}>
            <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em" }}>{(o.delStops||[]).length>1?`Delivery — Stop ${si+1}`:"Delivery"}</div>
            {si>0 && <button onClick={()=>setO(p=>({...p,delStops:p.delStops.filter((_,j)=>j!==si)}))} style={{ background:"none", border:"none", color:"#ef4444", cursor:"pointer", fontSize:13, fontWeight:700 }}>✕ Remove</button>}
          </div>
          <div style={card}>
            {locs.length>0 && <>
              <label style={lbl}>Quick Select Location</label>
              <select style={S} onChange={e=>{
                const l=locs.find(x=>x.id===e.target.value); if(!l)return;
                const stops=[...(o.delStops||[])]; stops[si]={...stops[si],co:l.company||"",addr:[l.street,l.city,l.provState,l.postalZip,l.country].filter(Boolean).join("\n"),date:stops[si].date||""};
                setO(p=>({...p,delStops:stops}));
              }}>
                <option value="">Select saved location...</option>
                {locs.map(l=><option key={l.id} value={l.id}>{l.company}{l.city?` — ${l.city}`:""}</option>)}
              </select>
            </>}
            <label style={lbl}>Company Name</label>
            <input style={S} value={stop.co||""} onChange={e=>setDelStop(si,"co",e.target.value)}/>
            <label style={lbl}>Address</label>
            <textarea style={{...S,minHeight:80,resize:"vertical"}} value={stop.addr||""} onChange={e=>setDelStop(si,"addr",e.target.value)}/>
            <label style={lbl}>Delivery Date</label>
            <input type="date" style={S} value={stop.date||""} onChange={e=>setDelStop(si,"date",e.target.value)}/>
          </div>
        </div>
      ))}
      <button onClick={()=>setO(p=>({...p,delStops:[...(p.delStops||[{co:"",addr:"",date:""}]),{co:"",addr:"",date:""}]}))} style={{...outBtn(T.muted), width:"100%", marginBottom:4, marginTop:4}}>+ Add Delivery Stop</button>

      {/* Items */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6, marginTop:16 }}>
        <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em" }}>Items</div>
        <button onClick={()=>setO(p=>({...p,items:[...(p.items||[]),{pcs:"",desc:"",wt:"",wUnit:"lbs",l:"",w:"",h:"",dUnit:"in"}]}))} style={{...outBtn(T.muted), padding:"4px 12px", fontSize:12}}>+ Add Row</button>
      </div>
      {(o.items||[]).map((it,i)=>(
        <div key={i} style={{...card, marginBottom:8, position:"relative"}}>
          <button onClick={()=>setO(p=>({...p,items:p.items.filter((_,j)=>j!==i)}))} style={{ position:"absolute", top:10, right:12, background:"none", border:"none", color:"#ef4444", cursor:"pointer", fontSize:16, fontWeight:700 }}>×</button>
          <div style={{ display:"grid", gridTemplateColumns:"80px 1fr", gap:8, marginBottom:10 }}>
            <div><label style={lbl}>Pces</label><input style={S} value={it.pcs} onChange={e=>setItem(i,"pcs",e.target.value)}/></div>
            <div><label style={lbl}>Description</label><input style={S} value={it.desc} onChange={e=>setItem(i,"desc",e.target.value)}/></div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 100px", gap:8, marginBottom:10 }}>
            <div><label style={lbl}>Weight</label><input style={S} type="number" value={it.wt} onChange={e=>setItem(i,"wt",e.target.value)}/></div>
            <div><label style={lbl}>Unit</label><select style={S} value={it.wUnit||"lbs"} onChange={e=>setItem(i,"wUnit",e.target.value)}><option value="lbs">lbs</option><option value="kg">kg</option></select></div>
          </div>
          <label style={lbl}>Dimensions (L × W × H)</label>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 100px", gap:8 }}>
            <input style={S} placeholder="L" value={it.l} onChange={e=>setItem(i,"l",e.target.value)}/>
            <input style={S} placeholder="W" value={it.w} onChange={e=>setItem(i,"w",e.target.value)}/>
            <input style={S} placeholder="H" value={it.h} onChange={e=>setItem(i,"h",e.target.value)}/>
            <select style={S} value={it.dUnit||"in"} onChange={e=>setItem(i,"dUnit",e.target.value)}><option value="in">in</option><option value="cm">cm</option></select>
          </div>
        </div>
      ))}

      {/* Special Requirements */}
      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6, marginTop:16 }}>Special Requirements</div>
      <div style={card}>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {["Tail Gate","Step Deck","Flat Bed","Trailer","2 Man","Inside Delivery","Unpacking","Liftgate","Appointment Required","Hazmat","Oversized","Refrigerated"].map(req=>{
            const active=(o.specReqs||[]).includes(req);
            return <button key={req} onClick={()=>{const cur=o.specReqs||[];set("specReqs",active?cur.filter(r=>r!==req):[...cur,req]);}} style={{padding:"8px 14px",borderRadius:20,fontSize:13,fontWeight:600,cursor:"pointer",border:`1px solid ${active?T.red:T.border}`,background:active?T.redDim:"transparent",color:active?T.red:T.muted,fontFamily:"inherit"}}>{req}</button>;
          })}
        </div>
      </div>

      {/* Notes */}
      <div style={{ fontSize:11, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6, marginTop:16 }}>Notes / Information</div>
      <div style={card}>
        <textarea style={{...S,minHeight:120,resize:"vertical",lineHeight:1.6}} value={o.notes||""} onChange={e=>set("notes",e.target.value)} placeholder="AWB numbers, special instructions, truck/plate info..."/>
      </div>

      <div style={{ display:"flex", gap:10, marginTop:20 }}>
        <button onClick={save} disabled={saving} style={btn(T.red)}>{saving?"Saving...":"Save Order"}</button>
        <button onClick={onBack} style={outBtn(T.muted)}>Cancel</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  CLIENTS & LOCATIONS TAB
// ════════════════════════════════════════════════════════════════
function ClientsTab({ db, saveColl }) {
  const [tab, setTab] = useState("clients");
  const [search, setSearch] = useState("");
  const [view, setView] = useState("list"); // list | detail | form
  const [sel, setSel] = useState(null);

  const items = tab === "clients" ? (db.clients||[]) : (db.locations||[]);
  const nameKey = tab === "clients" ? "name" : "company";
  const filtered = items.filter(x => !search || (x[nameKey]||"").toLowerCase().includes(search.toLowerCase()) || (x.city||"").toLowerCase().includes(search.toLowerCase()));

  const save = async (item) => {
    const list = tab === "clients" ? [...(db.clients||[])] : [...(db.locations||[])];
    const col = tab === "clients" ? "clients" : "locations";
    if (item.id) {
      await saveColl(col, list.map(x=>x.id===item.id?item:x));
    } else {
      await saveColl(col, [...list, { ...item, id:uid() }]);
    }
  };

  if (view === "form")
    return <ClientForm tab={tab} item={sel} onBack={()=>{setView(sel?"detail":"list");}} onSaved={async(item)=>{ await save(item); setView("list"); setSearch(""); }}/>;

  if (view === "detail" && sel) {
    const item = items.find(x=>x.id===sel.id)||sel;
    const nk = tab==="clients"?"name":"company";
    return (
      <div style={{ padding:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
          <button onClick={()=>setView("list")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", display:"flex", padding:0 }}><Ic n="back" s={22}/></button>
          <div style={{ fontSize:20, fontWeight:700, color:T.text }}>{item[nk]}</div>
          <button onClick={()=>{ setSel(item); setView("form"); }} style={{ marginLeft:"auto", ...outBtn(T.muted), padding:"8px 16px", fontSize:13 }}>Edit</button>
        </div>
        <div style={card}>
          {[["Address",[item.street,item.city,item.provState,item.country,item.postalZip].filter(Boolean).join(", ")],["Contact",item.contact],["Phone",item.phone],["Email",item.email],tab==="clients"?["Billing Email",item.billingEmail]:["",""],["Notes",item.notes]].filter(([,v])=>v).map(([l,v])=>(
            <div key={l} style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em" }}>{l}</div>
              <div style={{ fontSize:14, color:T.text, marginTop:2 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:16 }}>
      {/* Tab toggle */}
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {[["clients","Clients"],["locations","Locations"]].map(([v,l])=>(
          <button key={v} onClick={()=>{ setTab(v); setSearch(""); setView("list"); }} style={{ flex:1, padding:"10px", borderRadius:10, border:`1px solid ${tab===v?T.red:T.border}`, background:tab===v?T.redDim:"transparent", color:tab===v?T.red:T.muted, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
        ))}
      </div>

      {/* Search + Add */}
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        <div style={{ flex:1, display:"flex", alignItems:"center", gap:8, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 14px" }}>
          <Ic n="search" s={16}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={`Search ${tab}...`} style={{ background:"transparent", border:"none", color:T.text, fontSize:15, outline:"none", flex:1, fontFamily:"inherit" }}/>
          {search && <button onClick={()=>setSearch("")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", padding:0, display:"flex" }}><Ic n="x" s={14}/></button>}
        </div>
        <button onClick={()=>{ setSel(null); setView("form"); }} style={{ ...btn(T.red), width:"auto", padding:"10px 16px", borderRadius:10, flexShrink:0 }}><Ic n="plus" s={18}/></button>
      </div>

      {filtered.length === 0 && <div style={{ textAlign:"center", color:T.muted, padding:"40px 0", fontSize:14 }}>No {tab} found</div>}
      {filtered.sort((a,b)=>(a[nameKey]||"").localeCompare(b[nameKey]||"")).map(item=>(
        <div key={item.id} onClick={()=>{ setSel(item); setView("detail"); }} style={{ ...card, cursor:"pointer" }}>
          <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:4 }}>{item[nameKey]}</div>
          {(item.city||item.provState) && <div style={{ fontSize:13, color:T.muted }}>{[item.city,item.provState].filter(Boolean).join(", ")}</div>}
          {item.phone && <div style={{ fontSize:12, color:T.dim, marginTop:4 }}>{item.phone}</div>}
        </div>
      ))}
    </div>
  );
}

function ClientForm({ tab, item, onBack, onSaved }) {
  const isNew = !item?.id;
  const nk = tab==="clients"?"name":"company";
  const [f, setF] = useState(item||{});
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setF(p=>({...p,[k]:v}));

  const save = async () => {
    if (!f[nk]?.trim()) { alert(`Please enter a ${tab==="clients"?"company name":"location name"}`); return; }
    setSaving(true);
    await onSaved(f);
    setSaving(false);
  };

  const fields = tab==="clients"
    ? [{k:"name",l:"Company Name *"},{k:"street",l:"Street"},{k:"city",l:"City"},{k:"provState",l:"Province / State"},{k:"country",l:"Country"},{k:"postalZip",l:"Postal / Zip"},{k:"contact",l:"Contact Person"},{k:"phone",l:"Phone"},{k:"email",l:"Email"},{k:"billingEmail",l:"Billing Email"},{k:"notes",l:"Notes",tp:"textarea"}]
    : [{k:"company",l:"Location Name *"},{k:"street",l:"Street"},{k:"city",l:"City"},{k:"provState",l:"Province / State"},{k:"country",l:"Country"},{k:"postalZip",l:"Postal / Zip"},{k:"contact",l:"Contact Person"},{k:"phone",l:"Phone"},{k:"notes",l:"Notes",tp:"textarea"}];

  return (
    <div style={{ padding:16 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", display:"flex", padding:0 }}><Ic n="back" s={22}/></button>
        <div style={{ fontSize:20, fontWeight:700, color:T.text }}>{isNew ? `New ${tab==="clients"?"Client":"Location"}` : f[nk]}</div>
      </div>
      {fields.map(({k,l,tp})=>(
        <div key={k}>
          <label style={lbl}>{l}</label>
          {tp==="textarea"
            ? <textarea style={{ ...inp, minHeight:80, resize:"vertical" }} value={f[k]||""} onChange={e=>set(k,e.target.value)}/>
            : <input style={inp} value={f[k]||""} onChange={e=>set(k,e.target.value)}/>
          }
        </div>
      ))}
      <div style={{ display:"flex", gap:10, marginTop:20 }}>
        <button onClick={save} disabled={saving} style={btn(T.red)}>{saving?"Saving...":"Save"}</button>
        <button onClick={onBack} style={outBtn(T.muted)}>Cancel</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  EQUIPMENT TAB
// ════════════════════════════════════════════════════════════════
function EquipmentTab({ db }) {
  const [tab, setTab] = useState("trucks");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState(null);

  const items = tab==="trucks" ? (db.trucks||[]) : (db.trailers||[]);
  const filtered = items.filter(x => !search || (x.unit||"").includes(search) || (x.plate||"").toLowerCase().includes(search.toLowerCase()) || (x.type||"").toLowerCase().includes(search.toLowerCase()));

  const expColor = d => {
    if (!d) return null;
    const diff = Math.floor((new Date(d+"T12:00:00")-new Date())/(1000*60*60*24));
    if (diff<0) return T.red;
    if (diff<=30) return T.amber;
    if (diff<=90) return "#f97316";
    return T.green;
  };

  if (sel) {
    const item = items.find(x=>x.id===sel.id)||sel;
    const ec = expColor(item.safetyExp);
    return (
      <div style={{ padding:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
          <button onClick={()=>setSel(null)} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", display:"flex", padding:0 }}><Ic n="back" s={22}/></button>
          <div>
            <div style={{ fontSize:20, fontWeight:700, color:T.text }}>Unit {item.unit}</div>
            <div style={{ fontSize:13, color:T.muted }}>{item.type||tab.slice(0,-1)}</div>
          </div>
        </div>

        <div style={card}>
          {[["Plate #",item.plate],["Type",item.type],["VIN",item.vin]].filter(([,v])=>v).map(([l,v])=>(
            <div key={l} style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em" }}>{l}</div>
              <div style={{ fontSize:14, color:T.text, marginTop:2 }}>{v}</div>
            </div>
          ))}
          {item.safetyExp && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em" }}>Safety Expiry</div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:4 }}>
                <span style={{ fontSize:14, color:T.text }}>{fd(item.safetyExp)}</span>
                <ExpiryBadge date={item.safetyExp}/>
              </div>
            </div>
          )}
          {item.notes && (
            <div>
              <div style={{ fontSize:11, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em" }}>Notes</div>
              <div style={{ fontSize:14, color:T.text, marginTop:2, lineHeight:1.6 }}>{item.notes}</div>
            </div>
          )}
        </div>

        {/* Documents */}
        <div style={{ fontSize:13, fontWeight:700, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10, marginTop:4 }}>Documents</div>
        {(!item.docs || item.docs.length===0) && <div style={{ color:T.dim, fontSize:13, marginBottom:16 }}>No documents uploaded</div>}
        {(item.docs||[]).map((d,i)=>(
          <a key={i} href={d.url||d} target="_blank" rel="noreferrer" style={{ ...card, display:"flex", alignItems:"center", gap:12, textDecoration:"none", marginBottom:8 }}>
            <div style={{ color:T.muted }}><Ic n="file" s={20}/></div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.name||`Document ${i+1}`}</div>
              {d.uploadedAt && <div style={{ fontSize:11, color:T.dim, marginTop:2 }}>{fd(d.uploadedAt?.slice(0,10))}</div>}
            </div>
            <div style={{ color:T.muted, flexShrink:0 }}><Ic n="download" s={16}/></div>
          </a>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding:16 }}>
      {/* Tab toggle */}
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {[["trucks","Trucks"],["trailers","Trailers"]].map(([v,l])=>(
          <button key={v} onClick={()=>{ setTab(v); setSearch(""); setSel(null); }} style={{ flex:1, padding:"10px", borderRadius:10, border:`1px solid ${tab===v?T.red:T.border}`, background:tab===v?T.redDim:"transparent", color:tab===v?T.red:T.muted, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
        ))}
      </div>

      {/* Search */}
      <div style={{ display:"flex", alignItems:"center", gap:8, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 14px", marginBottom:16 }}>
        <Ic n="search" s={16}/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search unit, plate, type..." style={{ background:"transparent", border:"none", color:T.text, fontSize:15, outline:"none", flex:1, fontFamily:"inherit" }}/>
        {search && <button onClick={()=>setSearch("")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", padding:0, display:"flex" }}><Ic n="x" s={14}/></button>}
      </div>

      {filtered.length===0 && <div style={{ textAlign:"center", color:T.muted, padding:"40px 0", fontSize:14 }}>No {tab} found</div>}
      {[...filtered].sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0)).map(item=>{
        const ec = expColor(item.safetyExp);
        return (
          <div key={item.id} onClick={()=>setSel(item)} style={{ ...card, cursor:"pointer", borderLeft:ec?`3px solid ${ec}`:`3px solid ${T.border}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Unit {item.unit}</div>
                <div style={{ fontSize:13, color:T.muted, marginTop:2 }}>{item.plate||"—"}{item.type ? ` · ${item.type}` : ""}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                {item.safetyExp && <ExpiryBadge date={item.safetyExp}/>}
                {(item.docs||[]).length > 0 && <div style={{ fontSize:11, color:T.dim, marginTop:4 }}>{item.docs.length} doc{item.docs.length>1?"s":""}</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  DOCUMENTS TAB
// ════════════════════════════════════════════════════════════════
function DocsTab() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(()=>{
    getDocs(query(collection(db_inst,"company_docs"), orderBy("uploadedAt","desc")))
      .then(snap=>{ setDocs(snap.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false); })
      .catch(()=>setLoading(false));
  },[]);

  const filtered = docs.filter(d => !search || (d.name||"").toLowerCase().includes(search.toLowerCase()) || (d.type||"").toLowerCase().includes(search.toLowerCase()));

  const expiring = docs.filter(d=>{ const diff=Math.ceil((new Date((d.expiryDate||"")+"T12:00:00")-new Date())/86400000); return d.expiryDate && diff<=30; });

  return (
    <div style={{ padding:16 }}>
      {/* Expiry warning */}
      {expiring.length>0 && (
        <div style={{ background:T.amberDim, border:`1px solid ${T.amber}`, borderRadius:10, padding:14, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:T.amber, marginBottom:6 }}>⚠ {expiring.length} document{expiring.length>1?"s":""} expiring soon</div>
          {expiring.map(d=><div key={d.id} style={{ fontSize:12, color:T.text, marginBottom:2 }}><strong>{d.name}</strong> · <ExpiryBadge date={d.expiryDate}/></div>)}
        </div>
      )}

      {/* Search */}
      <div style={{ display:"flex", alignItems:"center", gap:8, background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 14px", marginBottom:16 }}>
        <Ic n="search" s={16}/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search documents..." style={{ background:"transparent", border:"none", color:T.text, fontSize:15, outline:"none", flex:1, fontFamily:"inherit" }}/>
        {search && <button onClick={()=>setSearch("")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", padding:0, display:"flex" }}><Ic n="x" s={14}/></button>}
      </div>

      {loading && <div style={{ textAlign:"center", color:T.muted, padding:"40px 0" }}>Loading...</div>}
      {!loading && filtered.length===0 && <div style={{ textAlign:"center", color:T.muted, padding:"40px 0", fontSize:14 }}>No documents found</div>}

      {filtered.map(d=>{
        const days = d.expiryDate ? Math.ceil((new Date(d.expiryDate+"T12:00:00")-new Date())/86400000) : null;
        const isExpired = days!==null && days<0;
        const isExpiring = days!==null && days>=0 && days<=30;
        const borderColor = isExpired?T.red:isExpiring?T.amber:T.border;
        return (
          <a key={d.id} href={d.fileUrl} target="_blank" rel="noreferrer" style={{ ...card, border:`1px solid ${borderColor}`, display:"flex", alignItems:"center", gap:12, textDecoration:"none", marginBottom:10 }}>
            <div style={{ color:T.muted, flexShrink:0 }}><Ic n="file" s={22}/></div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:14, fontWeight:700, color:T.text, marginBottom:4 }}>{d.name}</div>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:11, color:T.muted, background:T.surface, padding:"2px 8px", borderRadius:6 }}>{d.type}</span>
                {d.expiryDate && <ExpiryBadge date={d.expiryDate}/>}
              </div>
              {d.notes && <div style={{ fontSize:12, color:T.dim, marginTop:4 }}>{d.notes}</div>}
            </div>
            <div style={{ color:T.muted, flexShrink:0 }}><Ic n="download" s={18}/></div>
          </a>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  MAIN MOBILE APP
// ════════════════════════════════════════════════════════════════
export default function MobileApp({ db: dbProp, savOrd, saveColl, onExitMobile }) {
  const [tab, setTab] = useState("orders");
  const [db, setDb] = useState(dbProp||{orders:[],clients:[],locations:[],trucks:[],trailers:[],events:[]});
  const [loadingData, setLoadingData] = useState(!dbProp?.orders?.length);

  // Load data from Firestore if parent dbData isn't ready yet
  useEffect(()=>{
    if(dbProp?.orders?.length){ setDb(dbProp); setLoadingData(false); return; }
    const load = async () => {
      try {
        const [ordSnap,cliSnap,locSnap,trkSnap,trlSnap,evtSnap] = await Promise.all([
          getDocs(query(collection(db_inst,"orders"), orderBy("reqDate","desc"))),
          getDocs(collection(db_inst,"clients")),
          getDocs(collection(db_inst,"locations")),
          getDocs(collection(db_inst,"trucks")),
          getDocs(collection(db_inst,"trailers")),
          getDocs(collection(db_inst,"events")),
        ]);
        setDb({
          orders:  ordSnap.docs.map(d=>({id:d.id,...d.data()})),
          clients: cliSnap.docs.map(d=>({id:d.id,...d.data()})),
          locations: locSnap.docs.map(d=>({id:d.id,...d.data()})),
          trucks:  trkSnap.docs.map(d=>({id:d.id,...d.data()})),
          trailers: trlSnap.docs.map(d=>({id:d.id,...d.data()})),
          events:  evtSnap.docs.map(d=>({id:d.id,...d.data()})),
        });
      } catch(e){ console.error("Mobile load error:", e); }
      setLoadingData(false);
    };
    load();
  },[]);

  // Sync when parent updates
  useEffect(()=>{ if(dbProp?.orders?.length) setDb(dbProp); },[dbProp]);

  const TABS = [
    { id:"orders",    l:"Orders",    icon:"orders"    },
    { id:"clients",   l:"Clients",   icon:"clients"   },
    { id:"equipment", l:"Equipment", icon:"equipment" },
    { id:"docs",      l:"Docs",      icon:"docs"      },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:T.bg, color:T.text, fontFamily:"'IBM Plex Sans',system-ui,sans-serif", overflow:"hidden", paddingTop:"env(safe-area-inset-top)" }}>
      <style>{`
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        input, select, textarea { -webkit-appearance: none; font-size: 16px !important; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        @keyframes spin { to { transform: rotate(360deg); } }
        :root { --sat: env(safe-area-inset-top); --sab: env(safe-area-inset-bottom); }
      `}</style>

      {/* Header */}
      <div style={{ background:T.card, borderBottom:`1px solid ${T.border}`, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <img src="https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410" alt="DBX" style={{ height:48, objectFit:"contain" }}/>
          <div style={{ fontSize:14, fontWeight:700, color:T.text }}>DBX Mobile</div>
        </div>
        <button onClick={onExitMobile} style={{ background:T.surface, border:`1px solid ${T.border}`, color:T.muted, cursor:"pointer", borderRadius:8, padding:"6px 12px", fontSize:12, fontFamily:"inherit", display:"flex", alignItems:"center", gap:6 }}>
          <Ic n="desktop" s={14}/> Desktop
        </button>
      </div>

      {/* Loading indicator */}
      {loadingData && <div style={{ textAlign:"center", padding:"40px 0", color:T.muted, fontSize:13 }}>
        <div style={{ width:32, height:32, border:`3px solid ${T.border}`, borderTopColor:T.red, borderRadius:"50%", animation:"spin 0.8s linear infinite", margin:"0 auto 12px" }}/>
        Loading...
      </div>}

      {/* Content */}
      {!loadingData && <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 70px)" }}>
        {tab==="orders"    && <OrdersTab    db={db} savOrd={savOrd}/>}
        {tab==="clients"   && <ClientsTab   db={db} saveColl={saveColl}/>}
        {tab==="equipment" && <EquipmentTab db={db}/>}
        {tab==="docs"      && <DocsTab/>}
      </div>}

      {/* Bottom tab bar */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:"#0f0f0f", borderTop:`1px solid ${T.border}`, display:"flex", flexShrink:0, paddingBottom:"env(safe-area-inset-bottom, 0px)", zIndex:100 }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ flex:1, background:"none", border:"none", color:tab===t.id?T.red:T.dim, cursor:"pointer", padding:"10px 4px 8px", display:"flex", flexDirection:"column", alignItems:"center", gap:4, fontFamily:"inherit" }}>
            <Ic n={t.icon} s={22}/>
            <span style={{ fontSize:10, fontWeight:600, letterSpacing:"0.02em" }}>{t.l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

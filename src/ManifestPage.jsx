import React, { useState } from "react";

// ══════════════════════════════════════════════════════════════════════════
//  ManifestPage.jsx — 730 Permit Services ACE / ACI e-manifest cover sheet.
//  Fill in (NOTHING is mandatory) then Print / Save as PDF straight to the
//  computer — no data is written to Firestore.
//    • Driver's name  → type or pick from the driver database; the cell #
//      auto-fills from that record (still editable).
//    • Tractor / trailer unit → type or pick from the equipment database;
//      the plate # auto-fills from that record (still editable).
//    • Optional second driver (goes in the Passenger / Co-driver line).
//    • Up to 3 trailers.
//  Self-contained (own theme). Wired into App.jsx like LettersPage/IFTAPage:
//  reads db.drivers / db.trucks / db.trailers passed as  <ManifestPage db={dbData}/>.
// ══════════════════════════════════════════════════════════════════════════

const T = { bg:"#020817", card:"#0f172a", surface:"#1e293b", border:"#1e293b", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b", red:"#dc2626", redDk:"#b91c1c", green:"#22c55e", blue:"#3b82f6" };
const sIn  = { width:"100%", padding:"8px 10px", background:T.bg, border:`1px solid ${T.border}`, borderRadius:6, color:T.text, fontSize:13, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };
const sLbl = { display:"block", fontSize:10, fontWeight:600, color:T.muted, marginBottom:3, textTransform:"uppercase", letterSpacing:0.5 };
const sCrd = { background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:16, marginBottom:12 };
const sHint= { fontSize:10, color:T.dim, marginTop:3 };
const sBtn = { display:"inline-flex", alignItems:"center", gap:6, padding:"11px 20px", border:"none", borderRadius:8, color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" };
const bP   = { ...sBtn, background:`linear-gradient(135deg,${T.red},${T.redDk})`, boxShadow:"0 4px 12px rgba(220,38,38,.35)" };
const bGhost = { ...sBtn, background:"transparent", border:`1px solid ${T.border}`, color:T.muted, fontWeight:600, fontSize:12, padding:"7px 12px" };

const Field = ({ l, children, flex, style }) => <div style={{ marginBottom:12, flex: flex||"initial", minWidth:0, ...style }}><label style={sLbl}>{l}</label>{children}</div>;
const Row = ({ children }) => <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>{children}</div>;

// A tick-box that reads like the paper form's ☐ / ☒
const Chk = ({ on, onClick, label }) => (
  <button type="button" onClick={onClick} style={{ display:"inline-flex", alignItems:"center", gap:7, background:"transparent", border:"none", color:T.text, fontSize:13, cursor:"pointer", fontFamily:"inherit", padding:"4px 0", marginRight:16 }}>
    <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:19, height:19, borderRadius:5, border:`1.5px solid ${on?T.red:T.dim}`, background:on?T.red:"transparent", color:"#fff", fontSize:12, fontWeight:800, flexShrink:0 }}>{on?"✓":""}</span>
    {label}
  </button>
);

const esc = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtDate = iso => {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m[2],10)-1] || m[2];
  return `${m[3]}-${mon}-${m[1]}`;
};

// ── Build the filled 730 cover sheet as a standalone print window (same
//    window.open → window.print() path as the BOL). Kept compact + all rows
//    non-breaking so it never spills past a single Letter page, even at the
//    worst case (2 drivers + 3 trailers). ──────────────────────────────────
function buildHtml(f, trls) {
  const line = (val, minW) => `<span style="display:inline-block;border-bottom:1px solid #000;min-width:${minW||"120px"};padding:1px 5px;font-weight:600;line-height:1.15">${esc(val)||"&nbsp;"}</span>`;
  const cb  = on => `<span style="display:inline-block;width:11px;height:11px;border:1px solid #000;text-align:center;line-height:10px;font-size:9px;vertical-align:middle;margin:0 2px 0 4px">${on?"X":"&nbsp;"}</span>`;
  const lab = (en) => `<b>${en}</b>`;
  const rows = (trls && trls.length ? trls : [{unit:"",plate:"",prov:""}]);
  const trailerRows = rows.map((tr,i)=>`
    <div class="row two">
      <div>${lab("TRAILER UNIT :","Num&eacute;ro d'unit&eacute; : remorque")}${rows.length>1?` <b>#${i+1}</b>`:""} ${line(tr.unit,"85px")}</div>
      <div>${lab("PLATE# AND PROV OR STATE :","Num&eacute;ro d'immatriculation : remorque")} ${line(((tr.plate||"")+" "+(tr.prov||"")).trim(),"150px")}</div>
    </div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ACE / ACI Manifest${f.dateOfTrip?` — ${fmtDate(f.dateOfTrip)}`:""}</title>
  <style>
    @page { size: letter; margin: 11mm 14mm; }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; color:#000; font-size:11px; }
    /* Flex column that stretches to a full page and distributes the rows so
       the form fills the sheet instead of bunching at the top. More rows
       (2 drivers / 3 trailers) simply tighten the gaps — still one page. */
    .sheet { width:100%; display:flex; flex-direction:column; justify-content:space-between; }
    .row { line-height:1.3; page-break-inside:avoid; break-inside:avoid; }
    .row.two { display:flex; gap:20px; }
    .row.two > div { flex:1; min-width:0; }
    b { font-weight:700; }
    hr.rule { border:none; border-top:1.5px solid #000; margin:0; }
    .ctr { text-align:center; }
    .title { font-family:'Times New Roman',Georgia,serif; font-weight:400; line-height:1.1; }
    @media print  { .no-print { display:none !important; } .sheet { min-height:248mm; } }
    @media screen { body { padding:24px; background:#e2e8f0; } .sheet { background:#fff; max-width:800px; min-height:990px; margin:0 auto; padding:26px 32px; box-shadow:0 2px 18px rgba(0,0,0,.18); } }
  </style></head><body>
  <div class="sheet">
    <div class="ctr" style="margin-bottom:2px">
      <div class="title" style="font-size:26px">730 Permit Services Inc.</div>
      <div class="title" style="font-size:15px;letter-spacing:1px;margin-bottom:4px">ACE /ACI-MANIFEST</div>
      <div style="font-size:10px;font-weight:700;line-height:1.4">TELEPHONE NUMBER: 1-613-657-1244 &nbsp;--&nbsp; FAX TRIP INFORMATION TO: 1-613-657-1069</div>
      <div style="font-size:10px;font-weight:700">E-MAIL ADDRESS: ace@730permitservices.com</div>
    </div>
    <hr class="rule">

    <div class="row">${lab("COMPANY NAME:","Nom de la compagnie")} ${line(f.company,"360px")}</div>

    <div class="row two">
      <div>${lab("DATE OF TRIP:","Date de d&eacute;part")} ${line(fmtDate(f.dateOfTrip),"105px")}</div>
      <div>${lab("NUMBER OF PAGES FAXED:","")} ${line(f.pagesFaxed,"85px")}</div>
    </div>

    <div class="row two">
      <div>${lab("SCAC/ PARS CODE:","")} ${line(f.scacPars,"150px")}</div>
      <div style="font-weight:700;font-size:9px;align-self:center">***ACI must be done 1 hour prior to crossing</div>
    </div>

    <div class="row"><b>SHIPMENT TYPE:</b> &nbsp; REGULAR ${cb(f.shipReg)} &nbsp;&nbsp; IN BOND ${cb(f.shipInBond)} &nbsp;&nbsp; LINE RELEASE ${cb(f.shipLineRelease)}</div>

    <div class="row two">
      <div>${lab("DRIVER'S NAME :","Nom du conducteur")} ${line(f.drv1Name,"190px")}</div>
      <div>${lab("DRIVERS CELL# :","# De Cell du conducteur")} ${line(f.drv1Cell,"105px")}</div>
    </div>

    <div class="row">${lab("PASSENGER OR CO- DRIVER NAME:","Nom du passager ou autre conducteur")} ${line(f.drv2Name,"290px")}</div>

    <div class="row two">
      <div>${lab("TRACTOR UNIT :","Num&eacute;ro d'unit&eacute; : camion")} ${line(f.trkUnit,"85px")}</div>
      <div>${lab("PLATE # AND PROV OR STATE:","Num&eacute;ro d'immatriculation : camion")} ${line(((f.trkPlate||"")+" "+(f.trkProv||"")).trim(),"150px")}</div>
    </div>

    ${trailerRows}

    <div class="row two">
      <div>${lab("ARRIVAL DATE:","Date d'arriv&eacute;e")} ${line(fmtDate(f.arrivalDate),"105px")}</div>
      <div>${lab("E. T.A:","Heure d'arriv&eacute;e")} ${line(f.eta,"65px")} ${cb(f.etaAmPm==="AM")}AM ${cb(f.etaAmPm==="PM")}PM</div>
    </div>

    <div class="row"><b>Load Info Number of Pieces:</b> ${line(f.pieces,"80px")} &nbsp;&nbsp; <b>Weight:</b> ${line(f.weight,"80px")} ${cb(f.weightUnit==="lb")}Lbs ${cb(f.weightUnit==="kg")}Kg</div>

    <div class="row two">
      <div>${lab("U.S. PORT OF ARRIVAL:","Port d'arriv&eacute;e")} ${line(f.usPort,"135px")}</div>
      <div>${lab("CANADIAN PORT OF ARRIVAL:","Port d'arriv&eacute;e")} ${line(f.caPort,"135px")}</div>
    </div>

    <div class="row">${lab("CUSTOM BROKER:","Nom du courtier en douane")} ${line(f.broker,"185px")} &nbsp;( ${line(f.filerCode,"55px")} ) Filer code</div>

    <div class="row two">
      <div>${lab("CUSTOM BROKER TEL #:","Num&eacute;ro Tel : courtier en douane")} ${line(f.brokerTel,"125px")}</div>
      <div>${lab("CUSTOM BROKER FAX #:","Num&eacute;ro du t&eacute;l&eacute;copieur pour le courtier en douane")} ${line(f.brokerFax,"125px")}</div>
    </div>

    <div class="ctr" style="margin-top:10px">
      <div class="row"><b>730 PERMITS TO FAX TO CUSTOM BROKER:</b> Yes ${cb(f.faxBrokerYN==="Y")} &nbsp; NO ${cb(f.faxBrokerYN==="N")}</div>
      <div class="row"><b>CONFIRMATION COVER SHEET FAX TO:</b> ${line(f.confirmFaxTo,"205px")}</div>
      <div class="row"><b>OBTAIN ENTRY NUMBER:</b> YES ${cb(f.entryNumYN==="Y")} &nbsp; NO ${cb(f.entryNumYN==="N")}</div>
    </div>

    <hr class="rule">
  </div>

  <div class="no-print" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999">
    <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 4px 12px rgba(220,38,38,.4)">&#128424; Print / Save as PDF</button>
  </div>
  </body></html>`;
}

export default function ManifestPage({ db = {} }) {
  const drivers  = [...(db.drivers  || [])].filter(d=>d && d.name).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const trucks   = [...(db.trucks   || [])].filter(t=>t && (t.unit||t.unit===0)).sort((a,b)=>String(a.unit).localeCompare(String(b.unit),undefined,{numeric:true}));
  const trailers = [...(db.trailers || [])].filter(t=>t && (t.unit||t.unit===0)).sort((a,b)=>String(a.unit).localeCompare(String(b.unit),undefined,{numeric:true}));

  const [f, setF] = useState({
    company:"Diamond Back Express Inc.",
    dateOfTrip:"", pagesFaxed:"", scacPars:"",
    shipReg:false, shipInBond:false, shipLineRelease:false,
    drv1Name:"", drv1Cell:"", drv2Name:"",
    trkUnit:"", trkPlate:"", trkProv:"",
    arrivalDate:"", eta:"", etaAmPm:"",
    pieces:"", weight:"", weightUnit:"",
    usPort:"", caPort:"",
    broker:"", filerCode:"", brokerTel:"", brokerFax:"",
    faxBrokerYN:"", confirmFaxTo:"", entryNumYN:"",
  });
  const [showDrv2, setShowDrv2] = useState(false);
  const [trls, setTrls] = useState([{ unit:"", plate:"", prov:"" }]);

  const set = (k,v) => setF(p=>({ ...p, [k]:v }));
  const findDrv = name => drivers.find(x=>(x.name||"").trim().toLowerCase()===String(name||"").trim().toLowerCase());
  const findUnit = (list,unit) => list.find(x=>String(x.unit==null?"":x.unit).trim().toLowerCase()===String(unit||"").trim().toLowerCase());

  const onDrv1Name = v => { const d=findDrv(v); setF(p=>({ ...p, drv1Name:v, drv1Cell: d ? (d.phone||d.mobile||"") : p.drv1Cell })); };
  const onTrkUnit  = v => { const t=findUnit(trucks,v); setF(p=>({ ...p, trkUnit:v, trkPlate: t ? (t.plate||"") : p.trkPlate })); };
  const onTrlUnit  = (i,v) => { const t=findUnit(trailers,v); setTrls(prev=>prev.map((r,idx)=> idx===i ? { ...r, unit:v, plate: t ? (t.plate||"") : r.plate } : r )); };
  const setTrl = (i,k,v) => setTrls(prev=>prev.map((r,idx)=> idx===i ? { ...r, [k]:v } : r ));
  const addTrl = () => setTrls(prev=> prev.length>=3 ? prev : [...prev, { unit:"", plate:"", prov:"" }]);
  const rmTrl  = i => setTrls(prev=> prev.length<=1 ? prev : prev.filter((_,idx)=>idx!==i));

  const drvMatched = !!findDrv(f.drv1Name);
  const trkMatched = !!findUnit(trucks, f.trkUnit);

  // Open the native calendar on click/focus of a date field
  const openPicker = e => { try { const el = e.currentTarget; el.showPicker && el.showPicker(); } catch (_) {} };

  const printManifest = () => {
    const w = window.open("", "_blank");
    if (!w) { alert("Please allow popups to open the printable manifest."); return; }
    w.document.write(buildHtml(f, trls));
    w.document.close();
  };

  const matchNote = ok => ok ? <div style={{...sHint, color:T.green}}>✓ matched — pulled from database</div> : null;

  return (
    <div className="mf-scope" style={{ padding:20, maxWidth:960, margin:"0 auto" }}>
      <style>{`
        .mf-scope input[type="date"] { cursor:pointer; }
        .mf-scope input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.85); opacity:.9; cursor:pointer; }
      `}</style>
      {/* datalists for type-to-search */}
      <datalist id="mf-drivers">{drivers.map(d=><option key={d.id} value={d.name} />)}</datalist>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12, marginBottom:6 }}>
        <div>
          <h1 style={{ fontSize:20, fontWeight:800, margin:0, color:T.text }}>Manifest</h1>
          <div style={{ fontSize:12, color:T.muted, marginTop:3 }}>730 Permit Services ACE / ACI cover sheet — fill in and print. Nothing here is required, and nothing is saved.</div>
        </div>
        <button style={bP} onClick={printManifest}>🖨 Print / Save as PDF</button>
      </div>

      {/* Trip */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Trip</div>
        <Field l="Company Name"><input style={sIn} value={f.company} onChange={e=>set("company",e.target.value)} /></Field>
        <Row>
          <Field l="Date of Trip" flex="1"><input type="date" style={sIn} value={f.dateOfTrip} onChange={e=>set("dateOfTrip",e.target.value)} onClick={openPicker} onFocus={openPicker} /></Field>
          <Field l="Number of Pages Faxed" flex="1"><input type="number" style={sIn} value={f.pagesFaxed} onChange={e=>set("pagesFaxed",e.target.value)} /></Field>
          <Field l="SCAC / PARS Code" flex="1"><input style={sIn} value={f.scacPars} onChange={e=>set("scacPars",e.target.value)} placeholder="Enter manually" /></Field>
        </Row>
        <Field l="Shipment Type" style={{ marginBottom:0 }}>
          <div style={{ display:"flex", flexWrap:"wrap", marginTop:2 }}>
            <Chk on={f.shipReg}         onClick={()=>set("shipReg",!f.shipReg)}                 label="Regular" />
            <Chk on={f.shipInBond}      onClick={()=>set("shipInBond",!f.shipInBond)}           label="In Bond" />
            <Chk on={f.shipLineRelease} onClick={()=>set("shipLineRelease",!f.shipLineRelease)} label="Line Release" />
          </div>
        </Field>
      </div>

      {/* Drivers */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Drivers</div>
        <Row>
          <Field l="Driver's Name" flex="2">
            <input style={sIn} list="mf-drivers" value={f.drv1Name} onChange={e=>onDrv1Name(e.target.value)} placeholder="Type or pick from database…" />
            {drvMatched ? matchNote(true) : <div style={sHint}>Cell # fills automatically when the name matches a driver</div>}
          </Field>
          <Field l="Driver's Cell #" flex="1">
            <input style={sIn} value={f.drv1Cell} onChange={e=>set("drv1Cell",e.target.value)} placeholder="Auto-fills / editable" />
          </Field>
        </Row>
        {showDrv2 ? (
          <Field l="Second Driver — Passenger / Co-driver" style={{ marginBottom:0 }}>
            <div style={{ display:"flex", gap:8 }}>
              <input style={sIn} list="mf-drivers" value={f.drv2Name} onChange={e=>set("drv2Name",e.target.value)} placeholder="Type or pick from database…" />
              <button style={bGhost} onClick={()=>{ set("drv2Name",""); setShowDrv2(false); }}>Remove</button>
            </div>
          </Field>
        ) : (
          <button style={bGhost} onClick={()=>setShowDrv2(true)}>＋ Add second driver</button>
        )}
      </div>

      {/* Equipment */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Equipment</div>
        <Row>
          <Field l="Tractor Unit #" flex="1">
            <input style={sIn} value={f.trkUnit} onChange={e=>onTrkUnit(e.target.value)} placeholder="Type unit # — plate auto-fills…" />
            {trkMatched ? matchNote(true) : <div style={sHint}>Plate fills automatically when the unit matches</div>}
          </Field>
          <Field l="Plate #" flex="1"><input style={sIn} value={f.trkPlate} onChange={e=>set("trkPlate",e.target.value)} placeholder="Auto-fills / editable" /></Field>
          <Field l="Prov / State" flex="0 0 120px" style={{ width:120, minWidth:120 }}><input style={sIn} value={f.trkProv} onChange={e=>set("trkProv",e.target.value)} placeholder="e.g. ON" /></Field>
        </Row>

        <div style={{ height:1, background:T.border, margin:"4px 0 12px" }} />

        {trls.map((tr,i)=>{
          const matched = !!findUnit(trailers, tr.unit);
          return (
            <div key={i} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ ...sLbl, marginBottom:0 }}>Trailer {trls.length>1?`#${i+1}`:""}</span>
                {trls.length>1 && <button style={{ ...bGhost, padding:"3px 9px", fontSize:11 }} onClick={()=>rmTrl(i)}>Remove</button>}
              </div>
              <Row>
                <Field l="Trailer Unit #" flex="1" style={{ marginBottom:0 }}>
                  <input style={sIn} value={tr.unit} onChange={e=>onTrlUnit(i,e.target.value)} placeholder="Type unit # — plate auto-fills…" />
                  {matched && <div style={{...sHint,color:T.green}}>✓ matched — pulled from database</div>}
                </Field>
                <Field l="Plate #" flex="1" style={{ marginBottom:0 }}><input style={sIn} value={tr.plate} onChange={e=>setTrl(i,"plate",e.target.value)} placeholder="Auto-fills / editable" /></Field>
                <Field l="Prov / State" flex="0 0 120px" style={{ width:120, minWidth:120, marginBottom:0 }}><input style={sIn} value={tr.prov} onChange={e=>setTrl(i,"prov",e.target.value)} placeholder="e.g. ON" /></Field>
              </Row>
            </div>
          );
        })}
        {trls.length<3 && <button style={bGhost} onClick={addTrl}>＋ Add trailer{trls.length>0?` (${trls.length}/3)`:""}</button>}
      </div>

      {/* Arrival & Load */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Arrival & Load</div>
        <Row>
          <Field l="Arrival Date" flex="1"><input type="date" style={sIn} value={f.arrivalDate} onChange={e=>set("arrivalDate",e.target.value)} onClick={openPicker} onFocus={openPicker} /></Field>
          <Field l="E.T.A (time)" flex="1"><input style={sIn} value={f.eta} onChange={e=>set("eta",e.target.value)} placeholder="e.g. 10:30" /></Field>
          <Field l="AM / PM" style={{ marginBottom:12 }}>
            <div style={{ display:"flex", marginTop:2 }}>
              <Chk on={f.etaAmPm==="AM"} onClick={()=>set("etaAmPm", f.etaAmPm==="AM"?"":"AM")} label="AM" />
              <Chk on={f.etaAmPm==="PM"} onClick={()=>set("etaAmPm", f.etaAmPm==="PM"?"":"PM")} label="PM" />
            </div>
          </Field>
        </Row>
        <Row>
          <Field l="Number of Pieces" flex="1"><input type="number" style={sIn} value={f.pieces} onChange={e=>set("pieces",e.target.value)} /></Field>
          <Field l="Weight" flex="1"><input style={sIn} value={f.weight} onChange={e=>set("weight",e.target.value)} /></Field>
          <Field l="Unit" style={{ marginBottom:12 }}>
            <div style={{ display:"flex", marginTop:2 }}>
              <Chk on={f.weightUnit==="lb"} onClick={()=>set("weightUnit", f.weightUnit==="lb"?"":"lb")} label="Lbs" />
              <Chk on={f.weightUnit==="kg"} onClick={()=>set("weightUnit", f.weightUnit==="kg"?"":"kg")} label="Kg" />
            </div>
          </Field>
        </Row>
      </div>

      {/* Ports & Broker */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Ports & Customs Broker</div>
        <Row>
          <Field l="U.S. Port of Arrival" flex="1"><input style={sIn} value={f.usPort} onChange={e=>set("usPort",e.target.value)} /></Field>
          <Field l="Canadian Port of Arrival" flex="1"><input style={sIn} value={f.caPort} onChange={e=>set("caPort",e.target.value)} /></Field>
        </Row>
        <Row>
          <Field l="Custom Broker" flex="2"><input style={sIn} value={f.broker} onChange={e=>set("broker",e.target.value)} /></Field>
          <Field l="Filer Code" flex="1"><input style={sIn} value={f.filerCode} onChange={e=>set("filerCode",e.target.value)} /></Field>
        </Row>
        <Row>
          <Field l="Custom Broker Tel #" flex="1"><input style={sIn} value={f.brokerTel} onChange={e=>set("brokerTel",e.target.value)} /></Field>
          <Field l="Custom Broker Fax #" flex="1"><input style={sIn} value={f.brokerFax} onChange={e=>set("brokerFax",e.target.value)} /></Field>
        </Row>
      </div>

      {/* Final options */}
      <div style={sCrd}>
        <div style={{ fontSize:11, fontWeight:700, color:T.dim, textTransform:"uppercase", letterSpacing:0.6, marginBottom:10 }}>Final Options</div>
        <Field l="730 Permits to Fax to Custom Broker">
          <div style={{ display:"flex", marginTop:2 }}>
            <Chk on={f.faxBrokerYN==="Y"} onClick={()=>set("faxBrokerYN", f.faxBrokerYN==="Y"?"":"Y")} label="Yes (Oui)" />
            <Chk on={f.faxBrokerYN==="N"} onClick={()=>set("faxBrokerYN", f.faxBrokerYN==="N"?"":"N")} label="No (Non)" />
          </div>
        </Field>
        <Field l="Confirmation Cover Sheet Fax To"><input style={sIn} value={f.confirmFaxTo} onChange={e=>set("confirmFaxTo",e.target.value)} /></Field>
        <Field l="Obtain Entry Number" style={{ marginBottom:0 }}>
          <div style={{ display:"flex", marginTop:2 }}>
            <Chk on={f.entryNumYN==="Y"} onClick={()=>set("entryNumYN", f.entryNumYN==="Y"?"":"Y")} label="Yes (Oui)" />
            <Chk on={f.entryNumYN==="N"} onClick={()=>set("entryNumYN", f.entryNumYN==="N"?"":"N")} label="No (Non)" />
          </div>
        </Field>
      </div>

      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:40 }}>
        <button style={bP} onClick={printManifest}>🖨 Print / Save as PDF</button>
      </div>
    </div>
  );
}

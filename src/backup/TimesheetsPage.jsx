import { useState, useEffect, useRef } from "react";
import { db, storage } from "./firebase.js";
import { collection, query, where, getDocs, orderBy, updateDoc, addDoc, deleteDoc, doc, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

// Upload a file to Firebase Storage, returns public download URL
async function uploadFile(file, path) {
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return await getDownloadURL(storageRef);
}

// Delete a file from Firebase Storage by its download URL (best effort)
async function deleteFileByUrl(url) {
  try {
    const storageRef = ref(storage, url);
    await deleteObject(storageRef);
  } catch(e) { console.warn("Could not delete file from storage:", e.message); }
}

// Small reusable file upload button component with dropzone
function AttachFileButton({ label="📎 Attach Document", url, onUpload, onClear, accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx" }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = `timesheets/attachments/${Date.now()}_${file.name}`;
      const u = await uploadFile(file, path);
      onUpload(u);
    }
    catch(err) { alert("Upload failed: " + err.message); }
    setUploading(false);
  };
  const handleChange = async (e) => { await handleFile(e.target.files?.[0]); e.target.value = ""; };
  const handleDrop = async (e) => { e.preventDefault(); setDragging(false); await handleFile(e.dataTransfer.files?.[0]); };
  const lbl={fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:6};
  return <div style={{marginBottom:14}}>
    <label style={lbl}>Document / Receipt</label>
    <input ref={inputRef} type="file" accept={accept} style={{display:"none"}} onChange={handleChange}/>
    {url
      ? <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <a href={url} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:7,background:"rgba(34,197,94,0.1)",color:"#22c55e",fontSize:12,fontWeight:600,textDecoration:"none",border:"1px solid rgba(34,197,94,0.3)"}}>📄 View Document</a>
          <button onClick={()=>onClear()} style={{padding:"7px 12px",borderRadius:7,border:"1px solid rgba(239,68,68,0.4)",background:"rgba(239,68,68,0.1)",color:"#ef4444",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✕ Remove</button>
        </div>
      : <div
          onClick={()=>inputRef.current?.click()}
          onDragOver={e=>{e.preventDefault();setDragging(true);}}
          onDragLeave={()=>setDragging(false)}
          onDrop={handleDrop}
          style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,padding:"16px",borderRadius:8,border:`2px dashed ${dragging?"#22c55e":"#334155"}`,background:dragging?"rgba(34,197,94,0.05)":"transparent",color:dragging?"#22c55e":"#94a3b8",fontSize:12,fontWeight:600,cursor:"pointer",transition:"all 0.15s"}}>
          {uploading ? "Uploading..." : <><span style={{fontSize:20}}>📎</span><span>{label}</span><span style={{fontSize:10,fontWeight:400,color:"#64748b"}}>or drag & drop here</span></>}
        </div>
    }
  </div>;
}

// ── EmailJS config (same as dispatch app) ──
const EMAILJS = { serviceId:"service_aykab3n", templateId:"template_0ki8tnf", publicKey:"Z_0IMv8efUHLnxcUy" };

async function sendEmail(to, subject, htmlBody) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      service_id: EMAILJS.serviceId, template_id: EMAILJS.templateId, user_id: EMAILJS.publicKey,
      template_params: { to_email: to, subject, body: htmlBody }
    })
  });
  if(!res.ok) throw new Error("Email failed");
  return true;
}

const T = {
  red:"#dc2626", black:"#0f0f0f", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b",
  border:"#1e293b", hover:"#0f172a", card:"#0f172a", surface:"#1e293b", bg:"#020817",
  green:"#22c55e", greenDim:"rgba(34,197,94,0.1)", amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)",
  redDim:"rgba(220,38,38,0.1)",
};

const fd = (d) => d ? new Date(d+"T12:00:00").toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"}) : "—";
const fh = (h) => (h||0).toFixed(1)+"h";
const calcHours = (start, end) => {
  if(!start||!end) return 0;
  const [sh,sm]=start.split(":").map(Number);
  const [eh,em]=end.split(":").map(Number);
  let mins=(eh*60+em)-(sh*60+sm);
  if(mins<=0) mins+=24*60;
  return +(mins/60).toFixed(2);
};
const today = () => new Date().toISOString().slice(0,10);

const STATUS_STYLE = {
  pending:  { bg:T.amberDim, color:T.amber,  label:"Pending"  },
  approved: { bg:T.greenDim, color:T.green,  label:"Approved" },
  rejected: { bg:T.redDim,   color:T.red,    label:"Rejected" },
};

function Ic({ n, s=14 }) {
  const paths = {
    refresh:"M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
    download:"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
    user:"M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
    chevDown:"M19 9l-7 7-7-7",
    chevRight:"M9 5l7 7-7 7",
    receipt:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    check:"M5 13l4 4L19 7",
    x:"M6 18L18 6M6 6l12 12",
    edit:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    plus:"M12 4v16m8-8H4",
    trash:"M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={paths[n]}/></svg>;
}

function StatCard({ label, value, color }) {
  return (
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
      <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>
      <div style={{fontSize:26,fontWeight:700,color:color||T.text,fontFamily:"'IBM Plex Mono',monospace"}}>{value}</div>
    </div>
  );
}

// ── Pay Config Editor — per employee per event ──
function PayConfigEditor({ employee, onSaved }) {
  const cfg = employee.payCfg || {};
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(cfg.type || "daily");
  const [hourly, setHourly] = useState(cfg.hourly || "");
  const [workDay, setWorkDay] = useState(cfg.workDay || "");
  const [nonWorkDay, setNonWorkDay] = useState(cfg.nonWorkDay || "");
  const [perDiem, setPerDiem] = useState(cfg.perDiem || "");
  const [tripRate, setTripRate] = useState(cfg.tripRate || "");
  const [dayRate, setDayRate] = useState(cfg.dayRate || "");
  const [currency, setCurrency] = useState(cfg.currency || "CAD");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const newCfg = { type, hourly: parseFloat(hourly)||0, workDay: parseFloat(workDay)||0, nonWorkDay: parseFloat(nonWorkDay)||0, perDiem: parseFloat(perDiem)||0, tripRate: parseFloat(tripRate)||0, dayRate: parseFloat(dayRate)||0, currency };
      await updateDoc(doc(db, "employees", employee.id), { payCfg: newCfg });
      onSaved(employee.id, newCfg);
      setOpen(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const hasConfig = cfg.hourly || cfg.workDay || cfg.nonWorkDay || cfg.perDiem || cfg.tripRate;
  const iRow = {display:"flex",alignItems:"center",gap:6,marginBottom:8};
  const iLbl = {fontSize:11,color:T.muted,width:130,flexShrink:0};
  const iInp = {...inp,width:90,padding:"5px 8px",fontSize:12};

  const summary = () => {
    if(!hasConfig) return <span style={{fontSize:11,color:T.amber,fontWeight:600}}>Pay not configured</span>;
    const sym = cfg.currency==="USD" ? "US$" : "$";
    const parts = [];
    if(cfg.hourly) parts.push(sym+(parseFloat(cfg.hourly)||0).toFixed(2)+"/h");
    if(cfg.workDay) parts.push(sym+(parseFloat(cfg.workDay)||0).toFixed(0)+"/day");
    if(cfg.nonWorkDay) parts.push(sym+(parseFloat(cfg.nonWorkDay)||0).toFixed(0)+"/NW");
    if(cfg.perDiem) parts.push(sym+(parseFloat(cfg.perDiem)||0).toFixed(0)+" diem");
    if(cfg.tripRate) parts.push(sym+(parseFloat(cfg.tripRate)||0).toFixed(0)+"/trip");
    return <span style={{fontSize:12,color:T.green,fontWeight:600}}>{parts.length?parts.join(" · "):"No rates set"}{cfg.currency&&cfg.currency!=="CAD"&&<span style={{fontSize:10,color:T.muted,marginLeft:4}}>({cfg.currency})</span>}</span>;
  };

  return <div style={{marginTop:6}}>
    {!open ? <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      {summary()}
      <button onClick={()=>setOpen(true)} style={{fontSize:10,padding:"2px 8px",borderRadius:4,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
        {hasConfig?"Edit":"Configure Pay"}
      </button>
    </div>
    : <div style={{background:T.surface,borderRadius:8,padding:14,border:`1px solid ${T.border}`,marginTop:4}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",color:T.muted,letterSpacing:"0.06em",marginBottom:10}}>Pay Configuration</div>

        <div style={iRow}>
          <span style={iLbl}>Currency</span>
          <select value={currency} onChange={e=>setCurrency(e.target.value)} style={{...iInp,width:90}}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div style={iRow}>
          <span style={iLbl}>Hourly rate</span>
          <span style={{fontSize:12,color:T.muted}}>{currency==="USD"?"US$":"$"}</span>
          <input type="number" min="0" step="0.25" value={hourly} onChange={e=>setHourly(e.target.value)} style={iInp} placeholder="0.00"/>
          <span style={{fontSize:12,color:T.muted}}>/h</span>
        </div>
        <div style={iRow}>
          <span style={iLbl}>Working day rate</span>
          <span style={{fontSize:12,color:T.muted}}>{currency==="USD"?"US$":"$"}</span>
          <input type="number" min="0" step="1" value={workDay} onChange={e=>setWorkDay(e.target.value)} style={iInp} placeholder="0.00"/>
          <span style={{fontSize:12,color:T.muted}}>/day</span>
        </div>
        <div style={iRow}>
          <span style={iLbl}>Non-working day rate</span>
          <span style={{fontSize:12,color:T.muted}}>{currency==="USD"?"US$":"$"}</span>
          <input type="number" min="0" step="1" value={nonWorkDay} onChange={e=>setNonWorkDay(e.target.value)} style={iInp} placeholder="0.00"/>
          <span style={{fontSize:12,color:T.muted}}>/day</span>
        </div>
        <div style={iRow}>
          <span style={iLbl}>Per diem</span>
          <span style={{fontSize:12,color:T.muted}}>{currency==="USD"?"US$":"$"}</span>
          <input type="number" min="0" step="1" value={perDiem} onChange={e=>setPerDiem(e.target.value)} style={iInp} placeholder="0.00"/>
          <span style={{fontSize:12,color:T.muted}}>/day</span>
        </div>
        <div style={iRow}>
          <span style={iLbl}>Trip rate</span>
          <span style={{fontSize:12,color:T.muted}}>{currency==="USD"?"US$":"$"}</span>
          <input type="number" min="0" step="1" value={tripRate} onChange={e=>setTripRate(e.target.value)} style={iInp} placeholder="0.00"/>
          <span style={{fontSize:12,color:T.muted}}>/trip</span>
        </div>
                  <div style={{display:"flex",gap:8,marginTop:10}}>
          <button onClick={save} disabled={saving} style={{padding:"6px 14px",borderRadius:5,border:"none",background:T.green,color:"#000",cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:12}}>{saving?"Saving...":"Save"}</button>
          <button onClick={()=>setOpen(false)} style={{padding:"6px 12px",borderRadius:5,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"inherit",fontSize:12}}>Cancel</button>
        </div>
      </div>}
  </div>;
}
const inp = {width:"100%",padding:"9px 12px",borderRadius:6,border:`1px solid ${T.border}`,background:T.surface,color:T.text,fontFamily:"inherit",fontSize:13,outline:"none",boxSizing:"border-box"};
const lbl = {display:"block",fontSize:10,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,marginBottom:5};
const row2 = {display:"grid",gridTemplateColumns:"1fr 1fr",gap:10};

// ── Entry Modal (Edit or Add) ──
function EntryModal({ entry, events, employees, selectedEvent, allEntries=[], onClose, onSave }) {
  const isEdit = !!entry;
  const [empMode, setEmpMode] = useState(isEdit ? "existing" : "existing");
  const [selectedEmp, setSelectedEmp] = useState(isEdit ? entry.employeeEmail : "");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPayCfg, setNewPayCfg] = useState(null);
  const [driverSearch, setDriverSearch] = useState("");
  const [driverResults, setDriverResults] = useState([]);
  const [driversLoaded, setDriversLoaded] = useState([]);
  const [driverSelected, setDriverSelected] = useState(false);
  const [event, setEvent] = useState(isEdit ? entry.event : selectedEvent);
  const [date, setDate] = useState(isEdit ? entry.date : today());
  const [startTime, setStartTime] = useState(isEdit ? entry.startTime : "");
  const [endTime, setEndTime] = useState(isEdit ? entry.endTime : "");
  const [notes, setNotes] = useState(isEdit ? entry.notes : "");
  const [hourlyOverride, setHourlyOverride] = useState(isEdit ? (entry.hourlyOverride||"") : "");
  const [numTrips, setNumTrips] = useState(isEdit ? (entry.numTrips||"") : "");
  const [tripRateOverride, setTripRateOverride] = useState(isEdit ? (entry.tripRateOverride||"") : "");
  const [numDays, setNumDays] = useState(isEdit ? (entry.numDays||"") : "");
  const [dayRateOverride, setDayRateOverride] = useState(isEdit ? (entry.dayRateOverride||"") : "");
  const [numNwDays, setNumNwDays] = useState(isEdit ? (entry.numNwDays||"") : "");
  const [nwDayRateOverride, setNwDayRateOverride] = useState(isEdit ? (entry.nwDayRateOverride||"") : "");
  const [numPerDiem, setNumPerDiem] = useState(isEdit ? (entry.numPerDiem||"") : "");
  const [perDiemRateOverride, setPerDiemRateOverride] = useState(isEdit ? (entry.perDiemRateOverride||"") : "");
  const [expenseDesc, setExpenseDesc] = useState(isEdit ? (entry.expenseDesc||"") : "");
  const [expenseAmt, setExpenseAmt] = useState(isEdit ? (entry.expenseAmt||"") : "");
  const [expenseTax, setExpenseTax] = useState(isEdit ? (entry.expenseTax||"Tax Exempt") : "Tax Exempt");
  const [expenseCurrency, setExpenseCurrency] = useState(isEdit ? (entry.expenseCurrency||"CAD") : "CAD");
  const [attachmentUrl, setAttachmentUrl] = useState(isEdit ? (entry.attachmentUrl||"") : "");
  const [saving, setSaving] = useState(false);

  // Load all drivers once on mount
  useEffect(()=>{
    getDocs(collection(db,"drivers")).then(snap=>{
      setDriversLoaded(snap.docs.map(d=>({id:d.id,...d.data()})));
    }).catch(()=>{});
  },[]);

  // Filter drivers as user types
  useEffect(()=>{
    if(!driverSearch.trim()){ setDriverResults([]); return; }
    const q = driverSearch.toLowerCase();
    setDriverResults(driversLoaded.filter(d=>
      (d.name||"").toLowerCase().includes(q) ||
      (d.email||"").toLowerCase().includes(q) ||
      (d.phone||"").toLowerCase().includes(q)
    ).slice(0,6));
  },[driverSearch, driversLoaded]);

  const selectDriver = (d) => {
    setNewName(d.name||"");
    setNewEmail(d.email||"");
    setNewPhone(d.phone||"");
    setNewPayCfg(d.payCfg||null);
    setDriverSearch(d.name||"");
    setDriverResults([]);
    setDriverSelected(true);
  };

  const hours = calcHours(startTime, endTime);
  const overnight = startTime && endTime && hours > 0 &&
    (parseInt(endTime.split(":")[0])*60+parseInt(endTime.split(":")[1])) <
    (parseInt(startTime.split(":")[0])*60+parseInt(startTime.split(":")[1]));

  const chosenEmp = employees.find(e=>e.email===selectedEmp);

  const handleSave = async () => {
    const hasOtherPay = (parseFloat(numTrips)||0)>0||(parseFloat(numDays)||0)>0||(parseFloat(numNwDays)||0)>0||(parseFloat(numPerDiem)||0)>0||(parseFloat(expenseAmt)||0)>0;
    if(!date||!event) { alert("Please fill in date and event."); return; }
    if(!hasOtherPay && (!startTime||!endTime)) { alert("Please enter start/end time, or fill in at least one pay field."); return; }
    let empName, empEmail, empPhone, empPayCfg;
    if(empMode==="existing") {
      if(!chosenEmp) { alert("Please select an employee."); return; }
      empName=chosenEmp.name; empEmail=chosenEmp.email; empPhone=chosenEmp.phone;
      empPayCfg=chosenEmp.payCfg||null;
    } else {
      if(!newName.trim()||!newEmail.trim()) { alert("Please enter employee name and email."); return; }
      empName=newName.trim(); empEmail=newEmail.trim(); empPhone=newPhone.trim();
      empPayCfg=newPayCfg||null;
    }
    // ── Duplicate / overlapping time check ──
    if(startTime && endTime) {
      const toMin = t => { const [h,m]=t.split(":").map(Number); return h*60+m; };
      let ns = toMin(startTime), ne = toMin(endTime); if(ne<=ns) ne+=24*60; // handle overnight
      const sameDay = allEntries.filter(e =>
        e.id !== entry?.id &&
        e.employeeEmail === empEmail &&
        e.date === date &&
        e.startTime && e.endTime
      );
      for(const e of sameDay) {
        let es=toMin(e.startTime), ee=toMin(e.endTime); if(ee<=es) ee+=24*60;
        // exact duplicate
        if(e.startTime===startTime && e.endTime===endTime) {
          alert(`Duplicate entry: ${empName} already has an entry on ${date} from ${startTime} to ${endTime}.`);
          return;
        }
        // overlap
        if(ns < ee && es < ne) {
          if(!window.confirm(`⚠ Time conflict: ${empName} already has an entry on ${date} from ${e.startTime} to ${e.endTime}, which overlaps these hours.\n\nSave anyway?`)) return;
          break;
        }
      }
    }
    // ── Day-type conflict check ──
    // Hours / Working Day / Non-Working Day: mutually exclusive per date
    // Per Diem: max 1 per date, can coexist with any of the above
    // Trips: unrestricted
    {
      const existingSameDay = allEntries.filter(e =>
        e.id !== entry?.id &&
        e.employeeEmail === empEmail &&
        e.date === date
      );
      const hasHoursEntry    = existingSameDay.some(e => e.startTime && e.endTime && e.startTime!=="00:00" && !["non-working","per-diem","working-day"].includes(e.dayType));
      const hasWorkingDay    = existingSameDay.some(e => (parseFloat(e.numDays)||0)>0 || e.dayType==="working-day");
      const hasNonWorkingDay = existingSameDay.some(e => (parseFloat(e.numNwDays)||0)>0 || e.dayType==="non-working");
      const hasPerDiem       = existingSameDay.some(e => (parseFloat(e.numPerDiem)||0)>0 || e.dayType==="per-diem");

      const isAddingHours      = !!(startTime && endTime);
      const isAddingWorkingDay = (parseFloat(numDays)||0) > 0;
      const isAddingNwDay      = (parseFloat(numNwDays)||0) > 0;
      const isAddingPerDiem    = (parseFloat(numPerDiem)||0) > 0;

      if(isAddingHours && hasWorkingDay)     { alert(`⚠ Conflict: ${empName} already has a working day entry on ${date}. Hours and working day cannot coexist.`); return; }
      if(isAddingHours && hasNonWorkingDay)  { alert(`⚠ Conflict: ${empName} already has a non-working day on ${date}. Hours and non-working day cannot coexist.`); return; }
      if(isAddingWorkingDay && hasHoursEntry)    { alert(`⚠ Conflict: ${empName} already has hours logged on ${date}. Working day and hours cannot coexist.`); return; }
      if(isAddingWorkingDay && hasNonWorkingDay) { alert(`⚠ Conflict: ${empName} already has a non-working day on ${date}. Working day and non-working day cannot coexist.`); return; }
      if(isAddingNwDay && hasHoursEntry)     { alert(`⚠ Conflict: ${empName} already has hours logged on ${date}. Non-working day and hours cannot coexist.`); return; }
      if(isAddingNwDay && hasWorkingDay)     { alert(`⚠ Conflict: ${empName} already has a working day on ${date}. Non-working day and working day cannot coexist.`); return; }
      if(isAddingPerDiem && hasPerDiem)      { alert(`⚠ Conflict: ${empName} already has a per diem on ${date}. Only one per diem per day allowed.`); return; }
    }

    setSaving(true);
    try {
      const data = {
        employeeName:empName, employeeEmail:empEmail, employeePhone:empPhone||"",
        payCfg:empPayCfg||null,
        event, date, startTime, endTime, hours, notes:notes.trim(),
        hourlyOverride: parseFloat(hourlyOverride)||0,
        numTrips: parseFloat(numTrips)||0,
        tripRateOverride: parseFloat(tripRateOverride)||0,
        numDays: parseFloat(numDays)||0,
        dayRateOverride: parseFloat(dayRateOverride)||0,
        numNwDays: parseFloat(numNwDays)||0,
        nwDayRateOverride: parseFloat(nwDayRateOverride)||0,
        numPerDiem: parseFloat(numPerDiem)||0,
        perDiemRateOverride: parseFloat(perDiemRateOverride)||0,
        expenseDesc: expenseDesc.trim(),
        expenseAmt: parseFloat(expenseAmt)||0,
        expenseTax: expenseTax||"Tax Exempt",
        expenseCurrency: expenseCurrency||"CAD",
        attachmentUrl: attachmentUrl||"",
        manuallyEdited:true, editedAt:new Date().toISOString(),
      };
      // Also sync payCfg to employees collection so timesheets calculate pay
      if(empPayCfg?.type && empEmail) {
        const empSnap = await getDocs(query(collection(db,"employees"), where("email","==",empEmail)));
        if(!empSnap.empty) {
          await updateDoc(doc(db,"employees",empSnap.docs[0].id),{payCfg:empPayCfg});
        } else {
          await setDoc(doc(db,"employees",empEmail),{
            email:empEmail, name:empName, phone:empPhone||"", payCfg:empPayCfg
          },{merge:true});
        }
      }
      if(isEdit) {
        await updateDoc(doc(db,"timesheets",entry.id), data);
        onSave({...entry,...data});
      } else {
        const ref = await addDoc(collection(db,"timesheets"), {...data, submittedAt:new Date().toISOString()});
        onSave({id:ref.id,...data});
      }
      onClose();
    } catch(e) { console.error(e); alert("Error saving. Please try again."); }
    setSaving(false);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,width:"100%",maxWidth:520,maxHeight:"90vh",overflow:"auto"}}>
        {/* Modal header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 20px",borderBottom:`1px solid ${T.border}`}}>
          <div style={{fontSize:16,fontWeight:700,color:T.text}}>{isEdit?"Edit Entry":"Add Manual Entry"}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:T.muted,cursor:"pointer",fontSize:20,lineHeight:1}}>×</button>
        </div>

        <div style={{padding:"20px"}}>
          {/* Employee section */}
          {!isEdit && (
            <div style={{marginBottom:16}}>
              <label style={lbl}>Employee</label>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <button onClick={()=>setEmpMode("existing")} style={{flex:1,padding:"8px",borderRadius:6,border:`1px solid ${empMode==="existing"?T.red:T.border}`,background:empMode==="existing"?T.redDim:"transparent",color:empMode==="existing"?T.red:T.muted,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>Pick existing</button>
                <button onClick={()=>{setEmpMode("new");setDriverSelected(false);setDriverSearch("");setNewName("");setNewEmail("");setNewPhone("");setNewPayCfg(null);}} style={{flex:1,padding:"8px",borderRadius:6,border:`1px solid ${empMode==="new"?T.red:T.border}`,background:empMode==="new"?T.redDim:"transparent",color:empMode==="new"?T.red:T.muted,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer"}}>Add new</button>
              </div>
              {empMode==="existing" ? (
                <select value={selectedEmp} onChange={e=>setSelectedEmp(e.target.value)} style={{...inp,appearance:"none",WebkitAppearance:"none"}}>
                  <option value="">— Select employee —</option>
                  {[...employees].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(e=><option key={e.email} value={e.email}>{e.name} ({e.email})</option>)}
                </select>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {/* Driver search */}
                  <div style={{position:"relative"}}>
                    <input style={{...inp,paddingLeft:32}} placeholder="🔍 Search from Drivers / Employees..." value={driverSearch}
                      onChange={e=>{setDriverSearch(e.target.value);setDriverSelected(false);}}/>
                    {driverResults.length>0 && (
                      <div style={{position:"absolute",top:"100%",left:0,right:0,background:T.card,border:`1px solid ${T.border}`,borderRadius:6,zIndex:100,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",maxHeight:200,overflowY:"auto"}}>
                        {driverResults.map(d=>(
                          <div key={d.id} onClick={()=>selectDriver(d)}
                            style={{padding:"10px 14px",cursor:"pointer",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}
                            onMouseEnter={e=>e.currentTarget.style.background=T.surface}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <div>
                              <div style={{fontSize:13,fontWeight:600,color:T.text}}>{d.name}</div>
                              <div style={{fontSize:11,color:T.muted,marginTop:1}}>{d.email||"no email"} {d.phone?`· ${d.phone}`:""}</div>
                            </div>
                            {d.payCfg && <div style={{fontSize:10,padding:"2px 6px",borderRadius:4,background:"rgba(34,197,94,0.1)",color:"#22c55e",fontWeight:600,whiteSpace:"nowrap"}}>
                              {d.payCfg.type==="hourly"?`$${parseFloat(d.payCfg.hourly||0).toFixed(2)}/h`:`$${parseFloat(d.payCfg.workDay||0).toFixed(2)}/day`}
                            </div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* If driver selected — show populated read-only info */}
                  {driverSelected && (
                    <div style={{padding:"10px 12px",background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:8}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#22c55e",marginBottom:6}}>✅ Driver found — info auto-filled</div>
                      <div style={{fontSize:13,fontWeight:600,color:T.text}}>{newName}</div>
                      <div style={{fontSize:11,color:T.muted,marginTop:2}}>{newEmail} {newPhone?`· ${newPhone}`:""}</div>
                      {newPayCfg?.type && <div style={{fontSize:11,color:"#22c55e",marginTop:4,fontWeight:600}}>
                        💰 {newPayCfg.type==="hourly"?`$${parseFloat(newPayCfg.hourly||0).toFixed(2)}/h`:`$${parseFloat(newPayCfg.workDay||0).toFixed(2)}W · $${parseFloat(newPayCfg.nonWorkDay||0).toFixed(2)}NW${parseFloat(newPayCfg.perDiem||0)>0?` · $${parseFloat(newPayCfg.perDiem||0).toFixed(2)} diem`:""}`}
                      </div>}
                      <button onClick={()=>{setDriverSelected(false);setDriverSearch("");setNewName("");setNewEmail("");setNewPhone("");setNewPayCfg(null);}} style={{marginTop:8,fontSize:10,color:T.muted,background:"none",border:`1px solid ${T.border}`,borderRadius:4,padding:"2px 8px",cursor:"pointer",fontFamily:"inherit"}}>
                        ✕ Clear
                      </button>
                    </div>
                  )}

                  {/* Manual fields — only show if not auto-filled */}
                  {!driverSelected && <>
                    <input style={inp} placeholder="Full name *" value={newName} onChange={e=>setNewName(e.target.value)}/>
                    <input style={inp} placeholder="Email address *" value={newEmail} onChange={e=>setNewEmail(e.target.value)}/>
                    <input style={inp} placeholder="Phone number" value={newPhone} onChange={e=>setNewPhone(e.target.value)}/>
                  </>}
                </div>
              )}
            </div>
          )}

          {/* Edit mode — show employee info read-only */}
          {isEdit && (
            <div style={{marginBottom:16,padding:"10px 12px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:13,fontWeight:600,color:T.text}}>{entry.employeeName}</div>
              <div style={{fontSize:11,color:T.muted,marginTop:2}}>{entry.employeeEmail} · {entry.employeePhone}</div>
            </div>
          )}

          {/* Event */}
          <div style={{marginBottom:14}}>
            <label style={lbl}>Event</label>
            <select value={event} onChange={e=>setEvent(e.target.value)} style={{...inp,appearance:"none",WebkitAppearance:"none"}}>
              <option value="">— Select event —</option>
              {events.map(ev=><option key={ev}>{ev}</option>)}
            </select>
          </div>

          {/* Date */}
          <div style={{marginBottom:14}}>
            <label style={lbl}>Date</label>
            <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={inp}/>
          </div>

          {/* Times — custom 24h inputs */}
          <div style={{...row2,marginBottom:14}}>
            {[["Start time", startTime, setStartTime], ["End time", endTime, setEndTime]].map(([label, val, setter])=>(
              <div key={label}>
                <label style={lbl}>{label}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="HH:MM"
                  maxLength={5}
                  value={val}
                  onChange={e=>{
                    let v = e.target.value.replace(/[^0-9:]/g,"");
                    if (v.length===2 && !v.includes(":") && val.length<2) v = v+":";
                    setter(v);
                  }}
                  onBlur={e=>{
                    const parts = e.target.value.split(":");
                    if (parts.length===2) {
                      const h = parts[0].padStart(2,"0");
                      const m = (parts[1]||"00").padStart(2,"0").slice(0,2);
                      setter(`${h}:${m}`);
                    }
                  }}
                  style={{...inp, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.1em", textAlign:"center"}}
                />
              </div>
            ))}
          </div>

          {/* Hours preview */}
          {hours>0 && (
            <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:8}}>
              <div style={{background:T.black,color:T.text,fontFamily:"'IBM Plex Mono',monospace",fontSize:13,padding:"5px 12px",borderRadius:6,fontWeight:600}}>
                {Math.floor(hours)}h {Math.round((hours%1)*60)}m
              </div>
              {overnight && <span style={{fontSize:11,color:T.amber,fontWeight:600}}>⚠ Overnight shift</span>}
            </div>
          )}

          {/* Notes */}
          {/* Pay Details section */}
          <div style={{background:T.surface,border:"1px solid "+T.border,borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",color:T.muted,letterSpacing:"0.06em",marginBottom:14}}>Pay Details (Optional)</div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:600,color:"#3b82f6",marginBottom:6,textTransform:"uppercase"}}>Hourly Rate Override</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,alignItems:"end"}}>
                <div><label style={lbl}>$ / Hour</label><input type="number" min="0" step="0.25" value={hourlyOverride} onChange={e=>setHourlyOverride(e.target.value)} style={inp} placeholder="from profile"/></div>
                <div style={{paddingBottom:6,fontSize:11,color:T.muted}}>Override hourly rate</div>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:600,color:"#f59e0b",marginBottom:6,textTransform:"uppercase"}}>Trips</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"end"}}>
                <div><label style={lbl}># Trips</label><input type="number" min="0" step="1" value={numTrips} onChange={e=>setNumTrips(e.target.value)} style={inp} placeholder="0"/></div>
                <div><label style={lbl}>$ / Trip</label><input type="number" min="0" step="1" value={tripRateOverride} onChange={e=>setTripRateOverride(e.target.value)} style={inp} placeholder="from profile"/></div>
                <div style={{paddingBottom:6,fontSize:12,color:"#22c55e",fontWeight:700}}>= ${((parseFloat(numTrips)||0)*(parseFloat(tripRateOverride)||0)).toFixed(2)}</div>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:600,color:"#f59e0b",marginBottom:6,textTransform:"uppercase"}}>Working Days</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"end"}}>
                <div><label style={lbl}># Days</label><input type="number" min="0" max="1" step="1" value={numDays} onChange={e=>setNumDays(Math.min(1,e.target.value))} style={inp} placeholder="0 or 1"/></div>
                <div><label style={lbl}>$ / Day</label><input type="number" min="0" step="1" value={dayRateOverride} onChange={e=>setDayRateOverride(e.target.value)} style={inp} placeholder="from profile"/></div>
                <div style={{paddingBottom:6,fontSize:12,color:"#22c55e",fontWeight:700}}>= ${((parseFloat(numDays)||0)*(parseFloat(dayRateOverride)||0)).toFixed(2)}</div>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:600,color:"#f97316",marginBottom:6,textTransform:"uppercase"}}>Non-Working Days</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"end"}}>
                <div><label style={lbl}># NW Days</label><input type="number" min="0" max="1" step="1" value={numNwDays} onChange={e=>setNumNwDays(Math.min(1,e.target.value))} style={inp} placeholder="0 or 1"/></div>
                <div><label style={lbl}>$ / NW Day</label><input type="number" min="0" step="1" value={nwDayRateOverride} onChange={e=>setNwDayRateOverride(e.target.value)} style={inp} placeholder="from profile"/></div>
                <div style={{paddingBottom:6,fontSize:12,color:"#22c55e",fontWeight:700}}>= ${((parseFloat(numNwDays)||0)*(parseFloat(nwDayRateOverride)||0)).toFixed(2)}</div>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:600,color:"#0ea5e9",marginBottom:6,textTransform:"uppercase"}}>Per Diem</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"end"}}>
                <div><label style={lbl}># Days</label><input type="number" min="0" max="1" step="1" value={numPerDiem} onChange={e=>setNumPerDiem(Math.min(1,e.target.value))} style={inp} placeholder="0 or 1"/></div>
                <div><label style={lbl}>$ / Day</label><input type="number" min="0" step="1" value={perDiemRateOverride} onChange={e=>setPerDiemRateOverride(e.target.value)} style={inp} placeholder="from profile"/></div>
                <div style={{paddingBottom:6,fontSize:12,color:"#22c55e",fontWeight:700}}>= ${((parseFloat(numPerDiem)||0)*(parseFloat(perDiemRateOverride)||0)).toFixed(2)}</div>
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:600,color:"#8b5cf6",marginBottom:6,textTransform:"uppercase"}}>Expense (Reimbursement)</div>
              <div style={{marginBottom:8}}>
                <input style={inp} placeholder="Description (e.g. Uber baggage)" value={expenseDesc} onChange={e=>setExpenseDesc(e.target.value)}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"80px 1fr auto",gap:8,alignItems:"end"}}>
                <div>
                  <label style={lbl}>Currency</label>
                  <select value={expenseCurrency} onChange={e=>setExpenseCurrency(e.target.value)} style={inp}>
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Amount</label>
                  <input type="number" min="0" step="0.01" style={inp} placeholder="0.00" value={expenseAmt} onChange={e=>setExpenseAmt(e.target.value)}/>
                </div>
                <div>
                  <label style={lbl}>Tax</label>
                  <select value={expenseTax} onChange={e=>setExpenseTax(e.target.value)} style={inp}>
                    <option value="Tax Exempt">Tax Exempt</option>
                    <option value="HST on Purchases - 13%">HST 13%</option>
                    <option value="GST on Purchases - 5%">GST 5%</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          <AttachFileButton
            label="📎 Attach Receipt / Invoice"
            url={attachmentUrl}
            onUpload={url=>setAttachmentUrl(url)}
            onClear={()=>setAttachmentUrl("")}
          />
          <div style={{marginBottom:14}}>
            <label style={lbl}>Tasks & notes</label>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={3}
              placeholder="Describe what was worked on..."
              style={{...inp,resize:"none",lineHeight:1.6,minHeight:72}}/>
          </div>

          {/* Actions */}
          <div style={{display:"flex",gap:10}}>
            <button onClick={handleSave} disabled={saving} style={{flex:1,padding:"11px",background:T.red,color:"#fff",border:"none",borderRadius:7,fontFamily:"inherit",fontSize:14,fontWeight:700,cursor:"pointer"}}>
              {saving?"Saving...":(isEdit?"Save Changes":"Add Entry")}
            </button>
            <button onClick={onClose} style={{padding:"11px 20px",background:"transparent",color:T.muted,border:`1px solid ${T.border}`,borderRadius:7,fontFamily:"inherit",fontSize:14,cursor:"pointer"}}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Vendor charge tax helpers
const vendorTaxRate = t => t==="HST on Purchases - 13%"?0.13:t==="GST on Purchases - 5%"?0.05:0;
const vendorTaxAmt  = e => (parseFloat(e.amount)||0) * vendorTaxRate(e.taxType);
// Tax portion already included in a gross amount (e.g. $50 incl. 13% HST -> $5.75 tax)
const inclTaxRate = t => t==="HST on Purchases - 13%"?0.13:t==="GST on Purchases - 5%"?0.05:0;
const inclTaxAmt = (amount, taxType) => { const r=inclTaxRate(taxType); return r>0 ? (parseFloat(amount)||0)*(r/(1+r)) : 0; };
const inclTaxLabel = (amount, taxType) => { const t=inclTaxAmt(amount,taxType); return t>0 ? ` (incl. $${t.toFixed(2)} ${taxType.includes("HST")?"HST":"GST"})` : ""; };
const vendorTotal   = e => (parseFloat(e.amount)||0) + vendorTaxAmt(e);

function VendorChargeModal({ editEntry=null, events, selectedEvent, suppliers=[], onClose, onSave }) {
  const isEdit = !!editEntry;
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [company, setCompany] = useState(editEntry?.company||editEntry?.employeeName||"");
  const [contactName, setContactName] = useState(editEntry?.contactName||"");
  const [contactEmail, setContactEmail] = useState(editEntry?.contactEmail||"");
  const [contactPhone, setContactPhone] = useState(editEntry?.contactPhone||"");
  const [street, setStreet] = useState(editEntry?.street||"");
  const [city, setCity] = useState(editEntry?.city||"");
  const [provState, setProvState] = useState(editEntry?.provState||"");
  const [postalZip, setPostalZip] = useState(editEntry?.postalZip||"");
  const [country, setCountry] = useState(editEntry?.country||"");
  const [event, setEvent] = useState(editEntry?.event||(selectedEvent==="__all__"?"":selectedEvent));
  const [date, setDate] = useState(editEntry?.date||new Date().toISOString().slice(0,10));
  const [description, setDescription] = useState(editEntry?.description||"");
  const [amount, setAmount] = useState(editEntry?.amount!=null?String(editEntry.amount):"");
  const [currency, setCurrency] = useState(editEntry?.currency||"CAD");
  const [taxType, setTaxType] = useState(editEntry?.taxType||"Tax Exempt");
  const [invoiceNum, setInvoiceNum] = useState(editEntry?.invoiceNum||"");
  const [attachmentUrl, setAttachmentUrl] = useState(editEntry?.attachmentUrl||"");
  const [saving, setSaving] = useState(false);
  const lbl={fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:4};
  const inp={width:"100%",padding:"9px 12px",borderRadius:7,border:"1px solid #1e293b",background:"#0f172a",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",boxSizing:"border-box"};

  const handleSupplierSelect = (id) => {
    setSelectedSupplier(id);
    if(!id) return;
    const s = suppliers.find(x=>x.id===id);
    if(!s) return;
    setCompany(s.name||"");
    setContactName(s.contactPerson||"");
    setContactEmail(s.email||"");
    setContactPhone(s.phone||"");
    setStreet(s.street||"");
    setCity(s.city||"");
    setProvState(s.provState||"");
    setPostalZip(s.postalZip||"");
    setCountry(s.country||"");
  };

  const save = async () => {
    if(!company.trim()||!event||!date||!amount) { alert("Please fill in company, event, date, and amount."); return; }
    setSaving(true);
    try {
      const data = { entryType:"vendor-charge", company:company.trim(), contactName:contactName.trim(), contactEmail:contactEmail.trim(), contactPhone:contactPhone.trim(), street:street.trim(), city:city.trim(), provState:provState.trim(), postalZip:postalZip.trim(), country:country.trim(), event, date, description:description.trim(), amount:parseFloat(amount)||0, currency, taxType, invoiceNum:invoiceNum.trim(), attachmentUrl:attachmentUrl||"", employeeName:company.trim(), employeeEmail:"vendor-"+company.trim().toLowerCase().replace(/\s+/g,"-"), createdAt:editEntry?.createdAt||new Date().toISOString() };
      if(isEdit && editEntry.id) {
        await updateDoc(doc(db,"timesheets",editEntry.id), data);
        onSave({...data, id:editEntry.id});
      } else {
        const ref = await addDoc(collection(db,"timesheets"), data);
        onSave({...data, id:ref.id});
      }
      onClose();
    } catch(e) { console.error(e); alert("Error saving"); }
    setSaving(false);
  };
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:999,display:"flex",justifyContent:"center",alignItems:"center",padding:20}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#0f172a",borderRadius:12,padding:24,width:"100%",maxWidth:500,maxHeight:"90vh",overflow:"auto",border:"1px solid #1e293b"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <h3 style={{margin:0,fontSize:16,fontWeight:700,color:"#f1f5f9"}}>{isEdit?"Edit Vendor Charge":"Add Vendor / Broker Charge"}</h3>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#94a3b8",fontSize:18,cursor:"pointer"}}>{"×"}</button>
      </div>
      {suppliers.length > 0 && <div style={{marginBottom:14}}>
        <label style={lbl}>Select from your suppliers <span style={{color:"#64748b",fontWeight:400,textTransform:"none"}}>(optional)</span></label>
        <select value={selectedSupplier} onChange={e=>handleSupplierSelect(e.target.value)} style={{...inp,color:selectedSupplier?"#f1f5f9":"#64748b"}}>
          <option value="">— Select a supplier or enter manually —</option>
          {[...suppliers].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(s=><option key={s.id} value={s.id}>{s.name}{s.serviceType?` (${s.serviceType})`:""}</option>)}
        </select>
      </div>}
      <div style={{marginBottom:14}}><label style={lbl}>Company Name *</label><input style={inp} value={company} onChange={e=>setCompany(e.target.value)} placeholder="e.g. ABC Logistics"/></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>Contact Name</label><input style={inp} value={contactName} onChange={e=>setContactName(e.target.value)} placeholder="John Smith"/></div>
        <div><label style={lbl}>Invoice #</label><input style={inp} value={invoiceNum} onChange={e=>setInvoiceNum(e.target.value)} placeholder="INV-001"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>Email</label><input style={inp} value={contactEmail} onChange={e=>setContactEmail(e.target.value)} placeholder="email@company.com"/></div>
        <div><label style={lbl}>Phone</label><input style={inp} value={contactPhone} onChange={e=>setContactPhone(e.target.value)} placeholder="514-000-0000"/></div>
      </div>
      <div style={{marginBottom:14}}><label style={lbl}>Street Address</label><input style={inp} value={street} onChange={e=>setStreet(e.target.value)} placeholder="e.g. 123 Main St"/></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>City</label><input style={inp} value={city} onChange={e=>setCity(e.target.value)} placeholder="e.g. Montreal"/></div>
        <div><label style={lbl}>Province / State</label><input style={inp} value={provState} onChange={e=>setProvState(e.target.value)} placeholder="e.g. QC"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>Postal / ZIP</label><input style={inp} value={postalZip} onChange={e=>setPostalZip(e.target.value)} placeholder="e.g. H3B 1A1"/></div>
        <div><label style={lbl}>Country</label><input style={inp} value={country} onChange={e=>setCountry(e.target.value)} placeholder="e.g. Canada"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>Event *</label><select value={event} onChange={e=>setEvent(e.target.value)} style={{...inp,appearance:"none"}}><option value="">{"\u2014 Select event \u2014"}</option>{events.map(e=><option key={e} value={e}>{e}</option>)}</select></div>
        <div><label style={lbl}>Date *</label><input type="date" style={inp} value={date} onChange={e=>setDate(e.target.value)}/></div>
      </div>
      <div style={{marginBottom:14}}><label style={lbl}>Description</label><input style={inp} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Service description..."/></div>
      <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr",gap:10,marginBottom:14}}>
        <div><label style={lbl}>Currency</label><select value={currency} onChange={e=>setCurrency(e.target.value)} style={inp}><option value="CAD">CAD</option><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option></select></div>
        <div><label style={lbl}>Amount *</label><input type="number" min="0" step="0.01" style={inp} value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></div>
        <div><label style={lbl}>Tax</label><select value={taxType} onChange={e=>setTaxType(e.target.value)} style={inp}><option value="Tax Exempt">Tax Exempt</option><option value="HST on Purchases - 13%">HST 13%</option><option value="GST on Purchases - 5%">GST 5%</option></select></div>
      </div>
      <AttachFileButton
        label="📎 Attach Vendor Invoice"
        url={attachmentUrl}
        onUpload={url=>setAttachmentUrl(url)}
        onClear={()=>setAttachmentUrl("")}
      />
      <div style={{display:"flex",gap:10}}>
        <button onClick={save} disabled={saving} style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:"#8b5cf6",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{saving?"Saving...":isEdit?"Save Changes":"Add Vendor Charge"}</button>
        <button onClick={onClose} style={{padding:"10px 20px",borderRadius:8,border:"1px solid #1e293b",background:"transparent",color:"#94a3b8",cursor:"pointer",fontFamily:"inherit",fontSize:13}}>Cancel</button>
      </div>
    </div>
  </div>;
}

// Employee-level event document upload (invoice, email screenshot, etc.)
function EmpDocUpload({ empId, empEmail, event, onSaved }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [label, setLabel] = useState("Invoice");
  const [showForm, setShowForm] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = `timesheets/employee-docs/${empEmail}/${Date.now()}_${file.name}`;
      const url = await uploadFile(file, path);
      const newDoc = { url, label, event: event||"__all__", fileName: file.name, uploadedAt: new Date().toISOString() };
      const snap = await getDocs(query(collection(db,"employees"), where("email","==",empEmail)));
      if (!snap.empty) {
        const existing = snap.docs[0].data().eventDocs || [];
        await updateDoc(doc(db,"employees",snap.docs[0].id), { eventDocs: [...existing, newDoc] });
      } else {
        await addDoc(collection(db,"employees"), { email: empEmail, eventDocs: [newDoc] });
      }
      onSaved();
      setShowForm(false);
    } catch(e) { alert("Upload failed: "+e.message); }
    setUploading(false);
  };
  const handleDrop = async (e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); await handleFile(e.dataTransfer.files?.[0]); };
  if (!showForm) return (
    <button onClick={e=>{e.stopPropagation();setShowForm(true);}} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:10,background:"rgba(148,163,184,0.1)",color:"#94a3b8",fontSize:10,fontWeight:700,border:"1px dashed #334155",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
      📎 Attach
    </button>
  );
  return (
    <div onClick={e=>e.stopPropagation()} style={{display:"flex",flexDirection:"column",gap:6,marginTop:4,width:"100%"}}>
      <input ref={inputRef} type="file" accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx" style={{display:"none"}} onChange={e=>{handleFile(e.target.files?.[0]);e.target.value="";}}/>
      <div style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
        <select value={label} onChange={e=>setLabel(e.target.value)} style={{fontSize:10,padding:"2px 6px",borderRadius:6,border:"1px solid #334155",background:"#0f172a",color:"#f1f5f9",fontFamily:"inherit"}}>
          <option>Invoice</option>
          <option>Email</option>
          <option>Contract</option>
          <option>Receipt</option>
          <option>Other</option>
        </select>
        <button onClick={()=>setShowForm(false)} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:12,padding:"0 2px"}}>✕</button>
      </div>
      {/* Dropzone */}
      <div
        onClick={()=>inputRef.current?.click()}
        onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragging(true);}}
        onDragLeave={e=>{e.stopPropagation();setDragging(false);}}
        onDrop={handleDrop}
        style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,padding:"12px 16px",borderRadius:8,border:`2px dashed ${dragging?"#22c55e":"#334155"}`,background:dragging?"rgba(34,197,94,0.05)":"transparent",color:dragging?"#22c55e":"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",transition:"all 0.15s",minWidth:200}}>
        {uploading
          ? <span>Uploading...</span>
          : <><span style={{fontSize:18}}>📎</span><span>Click or drop file here</span><span style={{fontSize:10,fontWeight:400,color:"#64748b"}}>PDF, image, Word, Excel</span></>
        }
      </div>
    </div>
  );
}

export default function TimesheetsPage() {
  const [selectedEvent, setSelectedEvent] = useState("__all__");
  const [events, setEvents] = useState([]);
  const [entries, setEntries] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [empRecords, setEmpRecords] = useState({}); // email → {id, hourlyRate}
  const [loading, setLoading] = useState(false);
  const [expandedEmp, setExpandedEmp] = useState(null);
  // xeroSent is derived from entries — persistent in Firestore
  const [showXeroDone, setShowXeroDone] = useState(false);
  const [view, setView] = useState("by-employee");
  const [editEntry, setEditEntry] = useState(null);
  const [editVendorEntry, setEditVendorEntry] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [sendingRecap, setSendingRecap] = useState(null);
  const [showRecapModal, setShowRecapModal] = useState(false);
  const [recapEmp, setRecapEmp] = useState(null);
  const [recapMsg, setRecapMsg] = useState("");
  const [recapExtraEmails, setRecapExtraEmails] = useState("");
  const [empSearch, setEmpSearch] = useState("");
  const [suppliers, setSuppliers] = useState([]);

  // Send recap email to an employee
  const defaultRecapMsg = (event) =>
`Thank you for your work on ${event}. Please review your hours and contact us at manny@diamondbackexpress.com if you have any questions or corrections.

Payment for this event is currently being processed. While we are unable to confirm an exact payment date at this time, please know that your compensation is a priority and our team is actively working to complete the process as quickly as possible. We sincerely appreciate your patience and the quality of your work.

---

Merci pour votre travail sur ${event}. Veuillez vérifier vos heures et nous contacter à manny@diamondbackexpress.com si vous avez des questions ou corrections.

Le paiement pour cet événement est actuellement en cours de traitement. Bien que nous ne soyons pas en mesure de confirmer une date de paiement exacte pour le moment, sachez que votre rémunération est une priorité et que notre équipe travaille activement à finaliser le processus le plus rapidement possible. Nous vous remercions sincèrement de votre patience et de la qualité de votre travail.`;

  const sendRecap = async (emp, msg="", extraEmails="") => {
    // Guard: must have a specific event selected
    if (selectedEvent === "__all__") {
      alert("Please select a specific event before sending a recap.");
      setShowRecapModal(false);
      return;
    }
    // Guard: employee must have a valid email
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emp.email || !emailRe.test(emp.email.trim())) {
      alert(`Cannot send: ${emp.name} has an invalid or missing email address (${emp.email||"none"}). Please fix it in the Drivers / Employees section first.`);
      setShowRecapModal(false);
      return;
    }
    // Validate extra emails
    const extras = extraEmails.split(",").map(e=>e.trim()).filter(Boolean);
    const badExtras = extras.filter(e=>!emailRe.test(e));
    if (badExtras.length) {
      alert(`These additional email(s) look invalid:\n${badExtras.join("\n")}\n\nPlease correct or remove them.`);
      return;
    }
    setSendingRecap(emp.email);
    setShowRecapModal(false);
    try {
      const sorted = [...emp.entries].sort((a,b)=>a.date.localeCompare(b.date));
      const empExpenses = expenses.filter(e=>e.employeeEmail===emp.email);
      const cfg = empRecords[emp.email]?.payCfg || emp.entries[0]?.payCfg || null;

      const res = await fetch("https://sendrecapemail-lmhvg7gefa-uc.a.run.app", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          empName: emp.name, empEmail: emp.email.trim(), empPhone: emp.phone||"",
          entries: sorted, expenses: empExpenses, cfg,
          event: selectedEvent, message: msg,
          extraEmails: extras, ccManny: true,
        })
      });
      if (!res.ok) { const err = await res.json().catch(()=>{}); throw new Error(err?.error||"Email failed"); }
      alert(`✓ Recap sent to ${emp.name} at ${emp.email}${extras.length?` + ${extras.length} extra recipient${extras.length>1?"s":""}`:""}.`);
    } catch(e) {
      console.error(e);
      alert("Error sending recap to " + emp.name + ": " + e.message);
    }
    setSendingRecap(null);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const isAll = selectedEvent === "__all__";
      const [ts, es, emps, drivers] = await Promise.all([
        getDocs(isAll ? query(collection(db,"timesheets"), orderBy("date","desc")) : query(collection(db,"timesheets"), where("event","==",selectedEvent), orderBy("date","desc"))),
        getDocs(isAll ? query(collection(db,"expenses"),   orderBy("date","desc")) : query(collection(db,"expenses"),   where("event","==",selectedEvent), orderBy("date","desc"))),
        getDocs(collection(db,"employees")),
        getDocs(collection(db,"drivers")),
      ]);
      setEntries(ts.docs.map(d=>({id:d.id,...d.data()})));
      setExpenses(es.docs.map(d=>({id:d.id,...d.data()})));
      // Build lookup maps from drivers collection (profile-level pay defaults)
      // Match by email, normalized name, or normalized phone
      const normalize = s => (s||"").toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/g,"");
      const driverPayByEmail = {};
      const driverPayByName = {};
      const driverPayByPhone = {};
      drivers.docs.forEach(d=>{
        const data=d.data();
        if(!data.payCfg) return;
        if(data.email) driverPayByEmail[data.email.toLowerCase().trim()] = data.payCfg;
        if(data.name) driverPayByName[normalize(data.name)] = data.payCfg;
        if(data.phone) driverPayByPhone[normalize(data.phone)] = data.payCfg;
      });
      const findDriverPay = (emp) => {
        if(emp.email) { const v = driverPayByEmail[emp.email.toLowerCase().trim()]; if(v) return v; }
        if(emp.name) { const v = driverPayByName[normalize(emp.name)]; if(v) return v; }
        if(emp.phone) { const v = driverPayByPhone[normalize(emp.phone)]; if(v) return v; }
        return null;
      };
      const recs = {};
      emps.docs.forEach(d=>{
        const data=d.data();
        const key = data.email || data.phone || data.name;
        if(!key) return;
        const payCfg = data.payCfg ? data.payCfg : (findDriverPay(data) || null);
        const existing = recs[key];
        // Always prefer the doc that has payCfg over one that doesn't
        if(!existing || (!existing.payCfg && payCfg)) {
          recs[key]={id:d.id,...data, payCfg};
        } else if(existing && payCfg && !existing.payCfg) {
          recs[key]={...existing, payCfg};
        }
      });
      // Also index by email AND phone so lookups work either way
      const recsByEmail = {};
      const recsByPhone = {};
      Object.values(recs).forEach(r=>{ 
        if(r.email) recsByEmail[r.email.toLowerCase().trim()]=r; 
        if(r.phone) recsByPhone[r.phone.replace(/\D/g,"")]=r;
      });
      // Also add driver pay records directly so employees without an employees doc still show pay
      const driverRecs = {};
      drivers.docs.forEach(d=>{
        const data=d.data();
        if(!data.payCfg) return;
        if(data.email) driverRecs[data.email.toLowerCase().trim()] = {id:d.id,...data};
        if(data.name) driverRecs[normalize(data.name)] = {id:d.id,...data};
        if(data.phone) driverRecs[normalize(data.phone)] = {id:d.id,...data};
      });
      setEmpRecords({...driverRecs, ...recs, ...recsByPhone, ...recsByEmail});
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const deleteExpense = async (ex) => {
    if(!window.confirm(`Delete this expense for ${ex.employeeName}? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db,"expenses",ex.id));
      setExpenses(prev => prev.filter(e => e.id!==ex.id));
    } catch(e) { console.error(e); }
  };

  const updateExpenseStatus = async (id, status, ex) => {
    try {
      await updateDoc(doc(db,"expenses",id), { status });
      setExpenses(prev => prev.map(e => e.id===id ? {...e,status} : e));
      // Send email notification to employee
      if(status==="approved"||status==="rejected") {
        try {
          // Look up email from drivers collection first
          let toEmail = ex.employeeEmail || "";
          if(!toEmail || !toEmail.includes("@")) {
            const driverSnap = await getDocs(query(collection(db,"drivers"),where("name","==",ex.employeeName)));
            if(!driverSnap.empty) {
              const driverData = driverSnap.docs[0].data();
              if(driverData.email) toEmail = driverData.email;
            }
          }
          if(toEmail && toEmail.includes("@")) {
            const statusLabel = status==="approved" ? "✅ Approved" : "❌ Rejected";
            const statusColor = status==="approved" ? "#16a34a" : "#dc2626";
            const html = `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
              <div style="background:#111;padding:16px 20px;border-radius:8px 8px 0 0">
                <div style="color:#fff;font-weight:700;font-size:16px">Diamond Back Express</div>
                <div style="color:#888;font-size:12px">DBX Dispatch — Expense Update</div>
              </div>
              <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
                <h2 style="margin:0 0 16px;font-size:18px">Hi ${ex.employeeName},</h2>
                <p style="margin:0 0 12px;color:#374151">Your expense submission has been reviewed:</p>
                <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px">
                  <div style="font-size:20px;font-weight:700;color:${statusColor};margin-bottom:8px">${statusLabel}</div>
                  <table style="width:100%;font-size:13px;border-collapse:collapse">
                    <tr><td style="padding:4px 0;color:#6b7280">Date:</td><td style="padding:4px 0;font-weight:600">${ex.date}</td></tr>
                    <tr><td style="padding:4px 0;color:#6b7280">Type:</td><td style="padding:4px 0;font-weight:600">${ex.type}</td></tr>
                    <tr><td style="padding:4px 0;color:#6b7280">Amount:</td><td style="padding:4px 0;font-weight:700;color:#16a34a">${ex.currency} ${parseFloat(ex.amount||0).toFixed(2)}</td></tr>
                    <tr><td style="padding:4px 0;color:#6b7280">Event:</td><td style="padding:4px 0">${ex.event||selectedEvent}</td></tr>
                    ${ex.description?`<tr><td style="padding:4px 0;color:#6b7280">Description:</td><td style="padding:4px 0">${ex.description}</td></tr>`:""}
                  </table>
                </div>
                ${status==="rejected"?`<p style="color:#dc2626;font-size:13px">If you have questions about this decision, please contact your supervisor.</p>`:`<p style="color:#16a34a;font-size:13px">Your expense will be processed for reimbursement.</p>`}
                <p style="color:#9ca3af;font-size:11px;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:12px">Diamond Back Express Inc. — DBX Dispatch</p>
              </div>
            </div>`;
            await sendEmail(toEmail, `DBX Expense ${status==="approved"?"Approved":"Rejected"} — ${ex.type} ${ex.currency} ${parseFloat(ex.amount||0).toFixed(2)}`, html);
          }
        } catch(emailErr) { console.warn("Email notification failed:", emailErr); }
      }
    } catch(e) { console.error(e); }
  };

  // Load active events from Firestore
  useEffect(()=>{
    getDocs(query(collection(db,"events"), where("active","==",true)))
      .then(snap=>{ const evs=["Daily Operations",...snap.docs.map(d=>d.data().name).filter(e=>e!=="Daily Operations")]; setEvents(evs); setSelectedEvent("__all__"); })
      .catch(e=>console.error(e));
  },[]);

  // Load suppliers from drivers collection
  useEffect(()=>{
    getDocs(collection(db,"drivers"))
      .then(snap=>setSuppliers(snap.docs.map(d=>({id:d.id,...d.data()})).filter(d=>d.isSupplier===true)))
      .catch(e=>console.error(e));
  },[]);

  useEffect(()=>{ if(selectedEvent) loadData(); }, [selectedEvent]);

  // Handle save from modal — update or add entry in state
  const handleEntrySaved = (saved) => {
    setEntries(prev=>{
      const idx=prev.findIndex(e=>e.id===saved.id);
      if(idx>=0){ const n=[...prev]; n[idx]=saved; return n; }
      return [saved,...prev];
    });
  };

  // Delete a single entry
  const deleteEntry = async (entry) => {
    if(!window.confirm(`Delete this entry for ${entry.employeeName} on ${fd(entry.date)}?`)) return;
    try {
      await deleteDoc(doc(db,"timesheets",entry.id));
      setEntries(prev=>prev.filter(e=>e.id!==entry.id));
    } catch(e) { console.error(e); alert("Error deleting entry."); }
  };

  // Clear all entries + expenses for an employee for this event
  const deleteAllEntries = async (emp) => {
    if(selectedEvent==="__all__") { alert("Please select a specific event before clearing entries."); return; }
    const empKey = emp.email||emp.phone||emp.name;
    const empExpenses = expenses.filter(e=>(e.employeeEmail||e.employeePhone||e.employeeName)===empKey);
    if(!window.confirm(`Clear all entries for ${emp.name} on "${selectedEvent}"?\n\nThis will delete:\n• ${emp.entries.length} timesheet entries\n• ${empExpenses.length} expense(s)\n\nThis cannot be undone.`)) return;
    try {
      await Promise.all([
        ...emp.entries.map(e=>deleteDoc(doc(db,"timesheets",e.id))),
        ...empExpenses.map(e=>deleteDoc(doc(db,"expenses",e.id))),
      ]);
      await loadData();
    } catch(e) { console.error(e); alert("Error clearing entries."); }
  };

  // Group entries by employee
  // Smart grouping — match by email OR phone OR name (any one match = same employee)
  const empGroups = [];
  entries.forEach(e => {
    const eEmail = e.employeeEmail?.trim().toLowerCase();
    const ePhone = e.employeePhone?.trim().replace(/\D/g,"");
    const eName  = e.employeeName?.trim().toLowerCase();
    // Find existing group that matches on any identifier
    const match = empGroups.find(g =>
      (eEmail && g.email && eEmail === g.email) ||
      (ePhone && ePhone.length>=7 && g.phone && ePhone === g.phone) ||
      (eName  && g.name  && eName  === g.name)
    );
    if(match) {
      match.entries.push(e);
      // Enrich group with any new info
      if(eEmail && !match.email) match.email = eEmail;
      if(ePhone && !match.phone) match.phone = ePhone;
      if(e.employeeName && match.name === "unknown") match.name = e.employeeName;
    } else {
      empGroups.push({
        name: e.employeeName||"Unknown",
        email: eEmail||"",
        phone: ePhone||"",
        entries:[e]
      });
    }
  });
  const normalizeCfg = (cfg) => {
    if(!cfg) return null;
    return {
      ...cfg,
      hourly: parseFloat(cfg.hourly)||0,
      workDay: parseFloat(cfg.workDay)||0,
      nonWorkDay: parseFloat(cfg.nonWorkDay)||0,
      perDiem: parseFloat(cfg.perDiem)||0,
    };
  };
  const byEmp = empGroups.reduce((acc,g)=>{ acc[g.email||g.phone||g.name]=g; return acc; },{});
  const employees = Object.values(byEmp).map(emp=>{
    const empRec = empRecords[emp.email?.toLowerCase?.().trim()] || empRecords[(emp.phone||"").replace(/\D/g,"")] || empRecords[emp.name] || null;
    return {
      ...emp,
      totalHours: emp.entries.reduce((a,e)=>["non-working","per-diem","working-day"].includes(e.dayType)?a:a+calcHours(e.startTime,e.endTime),0),
      days: new Set(emp.entries.map(e=>e.date)).size,
      payCfg: normalizeCfg(empRec?.payCfg) || null,
      empRecordId: empRec?.id || null,
      events: [...new Set(emp.entries.map(e=>e.event).filter(Boolean))],
    };
  }).sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  const calcPay = (emp) => {
    const cfg = emp.payCfg || {};
    // Extra: trips and days across all entries
    const tripPay = emp.entries.reduce((a,e)=>{
      const trips = parseFloat(e.numTrips)||0;
      const rate = parseFloat(e.tripRateOverride)||(parseFloat(cfg.tripRate)||0);
      return a + trips*rate;
    },0);
    const dayExtraPay = emp.entries.reduce((a,e)=>{
      const days = parseFloat(e.numDays)||0;
      const rate = parseFloat(e.dayRateOverride) || parseFloat(cfg.dayRate) || parseFloat(cfg.workDay) || 0;
      return a + days*rate;
    },0);
    const nwDayPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numNwDays)||0)*(parseFloat(e.nwDayRateOverride)||(parseFloat(cfg.nonWorkDay)||0)),0);
    const perDiemPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numPerDiem)||0)*(parseFloat(e.perDiemRateOverride)||(parseFloat(cfg.perDiem)||0)),0);
    const inlineExpPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.expenseAmt)||0),0);
    const vendorPay = emp.entries.reduce((a,e)=>e.entryType==="vendor-charge"?a+vendorTotal(e):a,0);
    if(cfg.type!=="daily") {
      const totalMins = emp.entries.reduce((a,e)=>{
        if(!e.startTime||!e.endTime||["non-working","per-diem","working-day"].includes(e.dayType)) return a;
        const [sh,sm]=e.startTime.split(":").map(Number);
        const [eh,em]=e.endTime.split(":").map(Number);
        let mins=(eh*60+em)-(sh*60+sm);
        if(mins<=0) mins+=24*60;
        return a+mins;
      },0);
      const pay = emp.entries.reduce((a,e)=>{
        if(!e.startTime||!e.endTime||["non-working","per-diem","working-day"].includes(e.dayType)) return a;
        const [sh,sm]=e.startTime.split(":").map(Number);
        const [eh,em]=e.endTime.split(":").map(Number);
        let mins=(eh*60+em)-(sh*60+sm); if(mins<=0) mins+=24*60;
        const rate = parseFloat(e.hourlyOverride)||(cfg.hourly||0);
        return a + (mins/60)*rate;
      },0);
      return { pay, perDiem:0, tripPay, dayExtraPay, nwDayPay, perDiemPay, inlineExpPay, vendorPay, total:pay+tripPay+dayExtraPay+nwDayPay+perDiemPay+inlineExpPay+vendorPay, type:"hourly", totalMins };
    }
    const workDays = emp.entries.filter(e=>e.dayType!=="non-working").length;
    const nonWorkDays = emp.entries.filter(e=>e.dayType==="non-working").length;
    const totalDays = emp.entries.length;
    const pay = workDays*(cfg.workDay||0) + nonWorkDays*(cfg.nonWorkDay||0);
    const perDiem = totalDays*(cfg.perDiem||0);
    return { pay, perDiem, tripPay, dayExtraPay, nwDayPay, perDiemPay, inlineExpPay, vendorPay, total:pay+perDiem+tripPay+dayExtraPay+nwDayPay+perDiemPay+inlineExpPay+vendorPay, workDays, nonWorkDays, totalDays, type:"daily" };
  };

  const onRateSaved = (empId, payCfg) => {
    setEmpRecords(prev => {
      const updated = {...prev};
      const email = Object.keys(updated).find(k=>updated[k].id===empId);
      if(email) updated[email] = {...updated[email], payCfg};
      return updated;
    });
  };

  const moveEmployee = async (emp) => {
    const otherEvents = events.filter(ev=>ev!==selectedEvent);
    if(otherEvents.length===0) { alert("No other events available to move to."); return; }
    const target = window.prompt(`Move ${emp.name}'s ${emp.days} entries + expenses to which event?\n\n${otherEvents.map((e,i)=>`${i+1}. ${e}`).join("\n")}\n\nType the event name exactly:`);
    if(!target) return;
    if(!events.includes(target)) { alert(`Event "${target}" not found. Please type the exact event name.`); return; }
    if(target===selectedEvent) { alert("That's the same event."); return; }
    if(!window.confirm(`Move all ${emp.days} entries and ${expenses.filter(e=>e.employeeEmail===emp.email).length} expense(s) for ${emp.name} from "${selectedEvent}" to "${target}"?`)) return;
    try {
      const empExpenses = expenses.filter(e=>e.employeeEmail===emp.email);
      await Promise.all([
        ...emp.entries.map(e=>updateDoc(doc(db,"timesheets",e.id),{event:target})),
        ...empExpenses.map(e=>updateDoc(doc(db,"expenses",e.id),{event:target})),
      ]);
      setEntries(prev=>prev.filter(e=>e.employeeEmail!==emp.email));
      setExpenses(prev=>prev.filter(e=>e.employeeEmail!==emp.email));
      alert(`✓ ${emp.name} moved to "${target}"`);
    } catch(e) { console.error(e); alert("Error moving entries."); }
  };
  const pendingExp = expenses.filter(e=>e.status==="pending").length;
  const totalHours = entries.reduce((a,e)=>["non-working","per-diem","working-day"].includes(e.dayType)?a:a+calcHours(e.startTime,e.endTime),0);

  // Derive xeroSent from entries — an employee is "sent" if ALL their entries have xeroSent flag
  const xeroSent = {};
  employees.forEach(emp => {
    if(emp.entries.length > 0 && emp.entries.every(e => e.xeroSent)) xeroSent[emp.email] = true;
  });

  const bS = {padding:"8px 14px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6};
  const bP = {...bS,background:T.redDim,border:`1px solid ${T.red}`,color:T.red};
  const bG = {...bS,background:T.greenDim,border:`1px solid ${T.green}`,color:T.green};

  const exportCSV = () => {
    const rows=[["Employee","Email","Phone","Event","Date","Start","End","Hours","Notes"],
      ...entries.map(e=>[e.employeeName,e.employeeEmail,e.employeePhone,e.event,e.date,e.startTime,e.endTime,calcHours(e.startTime,e.endTime).toFixed(2),`"${(e.notes||"").replace(/"/g,'""')}"` ])];
    const csv=rows.map(r=>r.join(",")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download=`DBX_Timesheets_${selectedEvent.replace(/\s+/g,"_")}.csv`; a.click();
  };


  const buildEmpXeroRows = (emp, empEntries, empExpenses, cfg) => {
    const fmtXeroDate = (d) => {
      if(!d) return "";
      const dt = new Date(d + "T12:00:00");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return String(dt.getDate()).padStart(2,"0") + " " + months[dt.getMonth()] + " " + dt.getFullYear();
    };
    const addDays45 = (d) => {
      const dt = new Date(d + "T12:00:00"); dt.setDate(dt.getDate()+45);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return String(dt.getDate()).padStart(2,"0") + " " + months[dt.getMonth()] + " " + dt.getFullYear();
    };
    const acct = "5002";
    const acctPerDiem = "5390";
    const allDates = [...empEntries.map(e=>e.date),...empExpenses.map(e=>e.date)].filter(Boolean).sort();
    if(!allDates.length) return [];
    const today = new Date();
    const invDate = fmtXeroDate(today.toISOString().slice(0,10));
    const due = new Date(today); due.setDate(due.getDate()+30);
    const dueDate = fmtXeroDate(due.toISOString().slice(0,10));
    const invNum = selectedEvent;
    const ref = selectedEvent;
    const rows = [];
    const makeRow = (name, invNum, invDate, dueDate, desc, qty, unitAmt, acctCode, tax) => [name,emp.email||"","","","","","","","","",invNum,invDate,dueDate,"","",desc,qty,unitAmt,acctCode,tax,"","","","","","CAD"];
    // Hours
    const totalMins = empEntries.reduce((a,e)=>{ if(!e.startTime||!e.endTime) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return a+m; },0);
    const hourlyRate = parseFloat(cfg?.hourly)||0;
    // Group hours by rate
    const hoursByRate = {};
    empEntries.forEach(e=>{ if(!e.startTime||!e.endTime||["non-working","per-diem","working-day"].includes(e.dayType)) return; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; const r=parseFloat(e.hourlyOverride)||(parseFloat(cfg?.hourly)||0); if(r>0) { const k=r.toFixed(2); if(!hoursByRate[k]) hoursByRate[k]=0; hoursByRate[k]+=m; } });
    Object.entries(hoursByRate).forEach(([rate,mins])=>rows.push(makeRow(emp.name,invNum,invDate,dueDate,"Hours worked",((mins/60).toFixed(2)),rate,acct,"Tax Exempt")));
    // Working days
    // Working days — count both admin numDays and employee dayType="working-day" entries
    const totalWorkDayAdmin = empEntries.reduce((a,e)=>a+(parseFloat(e.numDays)||0),0);
    const totalWorkDayEmp = empEntries.filter(e=>e.dayType==="working-day").length;
    const totalWorkDays = totalWorkDayAdmin + totalWorkDayEmp;
    if(totalWorkDays>0) { const rate=Math.max(...[...empEntries.map(e=>parseFloat(e.dayRateOverride)||(parseFloat(cfg?.workDay)||0)),parseFloat(cfg?.workDay)||0]); if(rate>0) rows.push(makeRow(emp.name,invNum,invDate,dueDate,"Working days",totalWorkDays.toFixed(1),rate.toFixed(2),acct,"Tax Exempt")); }
    // Non-working days
    const totalNwAdmin = empEntries.reduce((a,e)=>a+(parseFloat(e.numNwDays)||0),0);
    const totalNwEmp = empEntries.filter(e=>e.dayType==="non-working").length;
    const totalNwDays = totalNwAdmin+totalNwEmp;
    if(totalNwDays>0) { const rate=Math.max(...[...empEntries.map(e=>parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0)),parseFloat(cfg?.nonWorkDay)||0]); if(rate>0) rows.push(makeRow(emp.name,invNum,invDate,dueDate,"Non-working days",totalNwDays.toFixed(1),rate.toFixed(2),acct,"Tax Exempt")); }
    // Per diem
    const totalPD = empEntries.reduce((a,e)=>a+(parseFloat(e.numPerDiem)||0)+(e.dayType==="per-diem"?1:0),0);
    if(totalPD>0) { const rate=Math.max(...[...empEntries.map(e=>parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0)),parseFloat(cfg?.perDiem)||0]); if(rate>0) rows.push(makeRow(emp.name,invNum,invDate,dueDate,"Per diem",totalPD.toFixed(1),rate.toFixed(2),acctPerDiem,"Tax Exempt")); }
    // Trips
    const totalTrips = empEntries.reduce((a,e)=>a+(parseFloat(e.numTrips)||0),0);
    if(totalTrips>0) { const rate=Math.max(...[...empEntries.map(e=>parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0)),parseFloat(cfg?.tripRate)||0]); if(rate>0) rows.push(makeRow(emp.name,invNum,invDate,dueDate,"Trips",totalTrips.toFixed(0),rate.toFixed(2),acct,"Tax Exempt")); }
    // Inline expenses grouped by description
    const inlineByType = {};
    empEntries.forEach(e=>{ if((parseFloat(e.expenseAmt)||0)>0&&e.expenseDesc){ const t=e.expenseDesc; if(!inlineByType[t]) inlineByType[t]={total:0,tax:e.expenseTax||"Tax Exempt"}; inlineByType[t].total+=parseFloat(e.expenseAmt)||0; } });
    Object.entries(inlineByType).forEach(([t,v])=>rows.push(makeRow(emp.name,invNum,invDate,dueDate,t,"1",v.total.toFixed(2),acct,v.tax)));
    // Employee-submitted expenses grouped by type (approved)
    const appByType = {};
    empExpenses.filter(e=>e.status==="approved").forEach(e=>{ const t=e.type||"Miscellaneous"; if(!appByType[t]) appByType[t]=0; appByType[t]+=parseFloat(e.amount)||0; });
    Object.entries(appByType).forEach(([t,total])=>rows.push(makeRow(emp.name,invNum,invDate,dueDate,t,"1",total.toFixed(2),acct,"Tax Exempt")));
    return rows;
  };

  const toCSV = (rows) => rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(",")).join("\n");
  const header = ["*ContactName","EmailAddress","POAddressLine1","POAddressLine2","POAddressLine3","POAddressLine4","POCity","PORegion","POPostalCode","POCountry","*InvoiceNumber","*InvoiceDate","*DueDate","Total","InventoryItemCode","Description","*Quantity","*UnitAmount","*AccountCode","*TaxType","TaxAmount","TrackingName1","TrackingOption1","TrackingName2","TrackingOption2","Currency"];

  // Export ALL employees in one CSV
  const exportVendorCsv = (empKey) => {
    const empEntries = entries.filter(e=>(e.employeeEmail||e.employeeName)===empKey);
    if(!empEntries.length) { alert("No entries found."); return; }
    const v = empEntries[0];
    const fmtD = (d) => { const dt=new Date(d+"T12:00:00"); const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return String(dt.getDate()).padStart(2,"0")+" "+months[dt.getMonth()]+" "+dt.getFullYear(); };
    const today = new Date();
    const invDate = fmtD(today.toISOString().slice(0,10));
    const due = new Date(today); due.setDate(due.getDate()+30);
    const dueDate = fmtD(due.toISOString().slice(0,10));
    const hdr = ["*ContactName","EmailAddress","POAddressLine1","POAddressLine2","POAddressLine3","POAddressLine4","POCity","PORegion","POPostalCode","POCountry","*InvoiceNumber","*InvoiceDate","*DueDate","Total","InventoryItemCode","Description","*Quantity","*UnitAmount","*AccountCode","*TaxType","TaxAmount","TrackingName1","TrackingOption1","TrackingName2","TrackingOption2","Currency"];
    const rows = [hdr];
    empEntries.forEach(e => {
      rows.push([
        e.company||e.employeeName,          // *ContactName
        e.contactEmail||"",                  // EmailAddress
        e.street||"",                        // POAddressLine1
        "", "", "",                          // POAddressLine2-4
        e.city||"",                          // POCity
        e.provState||"",                     // PORegion
        e.postalZip||"",                     // POPostalCode
        e.country||"",                       // POCountry
        e.invoiceNum||selectedEvent,         // *InvoiceNumber
        invDate,                             // *InvoiceDate
        dueDate,                             // *DueDate
        vendorTotal(e).toFixed(2),           // Total
        "",                                  // InventoryItemCode
        e.description||"Vendor charge",      // Description
        "1",                                 // *Quantity
        (parseFloat(e.amount)||0).toFixed(2),// *UnitAmount
        "5000",                              // *AccountCode
        e.taxType||"Tax Exempt",             // *TaxType
        vendorTaxAmt(e)>0?vendorTaxAmt(e).toFixed(2):"", // TaxAmount
        "", "", "", "",                      // Tracking fields
        e.currency||"CAD"                    // Currency
      ]);
    });
    const csv = rows.map(r=>r.map(v2=>'"'+String(v2).replace(/"/g,'""')+'"').join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = "Xero_Vendor_"+(v.company||v.employeeName).replace(/\s+/g,"_")+".csv";
    a.click();
  };

  const exportXeroBillSingle = (empKey) => {
    const emp = (() => { const byEmp = {}; entries.forEach(e=>{ const k=e.employeeEmail||e.employeeName; if(!byEmp[k]) byEmp[k]={name:e.employeeName,email:e.employeeEmail,entries:[]}; byEmp[k].entries.push(e); }); return byEmp[empKey]; })();
    if(!emp) { alert("No entries found."); return; }
    const empExp = expenses.filter(e=>(e.employeeEmail||e.employeeName)===empKey);
    const cfg = empRecords[emp.email]?.payCfg || emp.entries[0]?.payCfg;
    const rows = buildEmpXeroRows(emp, emp.entries, empExp, cfg);
    if(!rows.length) { alert("No billable data found for this employee.\n\nThis usually means pay rates are not configured, or no hours/days/expenses have been entered."); return; }
    const csv = toCSV([header, ...rows]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download = "Xero_"+selectedEvent.replace(/\s+/g,"_")+"_"+emp.name.replace(/\s+/g,"_")+".csv"; a.click();
  };

  const exportXeroBills = () => {
    const allRows = [header];
    const byEmp = {};
    entries.forEach(e=>{ const k=e.employeeEmail||e.employeeName; if(!byEmp[k]) byEmp[k]={name:e.employeeName,email:e.employeeEmail,entries:[]}; byEmp[k].entries.push(e); });
    const expByEmp = {};
    expenses.forEach(e=>{ const k=e.employeeEmail||e.employeeName; if(!expByEmp[k]) expByEmp[k]=[]; expByEmp[k].push(e); });
    const allKeys = new Set([...Object.keys(byEmp),...Object.keys(expByEmp)]);
    allKeys.forEach(k=>{ const emp=byEmp[k]||{name:(expByEmp[k]||[])[0]?.employeeName||k,email:k,entries:[]}; const cfg=empRecords[emp.email]?.payCfg||emp.entries[0]?.payCfg; buildEmpXeroRows(emp,emp.entries,expByEmp[k]||[],cfg).forEach(r=>allRows.push(r)); });
    if(allRows.length<=1){alert("No pay data found.");return;}
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([toCSV(allRows)],{type:"text/csv"}));
    a.download="Xero_Bills_"+selectedEvent.replace(/\s+/g,"_")+".csv"; a.click();
  };

  // Export individual CSV per employee
  const exportXeroBillsIndividual = () => {
    const byEmp = {};
    entries.forEach(e=>{ const k=e.employeeEmail||e.employeeName; if(!byEmp[k]) byEmp[k]={name:e.employeeName,email:e.employeeEmail,entries:[]}; byEmp[k].entries.push(e); });
    const expByEmp = {};
    expenses.forEach(e=>{ const k=e.employeeEmail||e.employeeName; if(!expByEmp[k]) expByEmp[k]=[]; expByEmp[k].push(e); });
    const allKeys = new Set([...Object.keys(byEmp),...Object.keys(expByEmp)]);
    let count=0;
    allKeys.forEach(k=>{ 
      const emp=byEmp[k]||{name:(expByEmp[k]||[])[0]?.employeeName||k,email:k,entries:[]};
      const cfg=empRecords[emp.email]?.payCfg||emp.entries[0]?.payCfg;
      const rows=buildEmpXeroRows(emp,emp.entries,expByEmp[k]||[],cfg);
      if(!rows.length) return;
      const csv=toCSV([header,...rows]);
      const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
      a.download="Xero_"+selectedEvent.replace(/\s+/g,"_")+"_"+emp.name.replace(/\s+/g,"_")+".csv"; a.click();
      count++;
    });
    if(!count) alert("No pay data found.");
  };

  const exportExpCSV = () => {
    const rows=[["Employee","Email","Date","Type","Amount","Currency","Description","Status","Receipt"],
      ...expenses.map(e=>[e.employeeName,e.employeeEmail,e.date,e.type,(e.amount||0).toFixed(2),e.currency,`"${(e.description||"").replace(/"/g,'""')}"`,e.status||"pending",e.receiptUrl||""])];
    const csv=rows.map(r=>r.join(",")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download=`DBX_Expenses_${selectedEvent.replace(/\s+/g,"_")}.csv`; a.click();
  };


  const downloadFile = async (url, fileName) => {
    try {
      const res = await fetch(url, { mode: 'cors' });
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'receipt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch(e) { window.open(url, '_blank'); }
  };

  const printEmployeeReport = (emp) => {
    const empExpenses = expenses.filter(e=>e.employeeEmail===emp.email);
    const sorted = [...emp.entries].sort((a,b)=>a.date.localeCompare(b.date));
    const fmtH = (h) => { const hrs=Math.floor(h),mins=Math.round((h-hrs)*60); return `${hrs}h${mins>0?` ${mins}m`:""}`; };
    const fmtDate = (d) => new Date(d+"T12:00:00").toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
    const calcMins = (s,e) => { if(!s||!e) return 0; const [sh,sm]=s.split(":").map(Number); const [eh,em]=e.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return m; };
    // Normalize payCfg — parse all values as floats
    const cfg = emp.payCfg ? { ...emp.payCfg, hourly:parseFloat(emp.payCfg.hourly)||0, workDay:parseFloat(emp.payCfg.workDay)||0, nonWorkDay:parseFloat(emp.payCfg.nonWorkDay)||0, perDiem:parseFloat(emp.payCfg.perDiem)||0, tripRate:parseFloat(emp.payCfg.tripRate)||0 } : null;
    const sym = emp.payCfg?.currency==="USD" ? "US$" : "$";
    const cur = emp.payCfg?.currency || "CAD";
    const totalMins = sorted.reduce((a,e)=>["non-working","per-diem","working-day"].includes(e.dayType)?a:a+calcMins(e.startTime,e.endTime),0);
    const totalH = totalMins/60;
    const hourlyPay = sorted.reduce((a,e)=>{ if(!e.startTime||!e.endTime||["non-working","per-diem","working-day"].includes(e.dayType)) return a; const m=calcMins(e.startTime,e.endTime); const r=Number(e.hourlyOverride)||parseFloat(e.hourlyOverride)||(cfg?.hourly||0); return a+(m/60)*r; },0);
    const tripPay = sorted.reduce((a,e)=>{const t=parseFloat(e.numTrips)||0;const r=parseFloat(e.tripRateOverride)||(cfg?.tripRate||0);return a+t*r;},0);
    const wdPay = sorted.reduce((a,e)=>{const d=parseFloat(e.numDays)||0;const r=parseFloat(e.dayRateOverride)||(cfg?.workDay||0);return a+d*r;},0);
    const nwPay = sorted.reduce((a,e)=>{const d=parseFloat(e.numNwDays)||0;const r=parseFloat(e.nwDayRateOverride)||(cfg?.nonWorkDay||0);return a+d*r;},0)+sorted.filter(e=>e.dayType==="non-working").length*(cfg?.nonWorkDay||0);
    const pdPay = sorted.reduce((a,e)=>{const d=parseFloat(e.numPerDiem)||0;const r=parseFloat(e.perDiemRateOverride)||(cfg?.perDiem||0);return a+d*r;},0)+sorted.filter(e=>e.dayType==="per-diem").length*(cfg?.perDiem||0);
    const expPay = sorted.reduce((a,e)=>a+(parseFloat(e.expenseAmt)||0),0);
    const empTotal = hourlyPay + tripPay + wdPay + nwPay + pdPay + expPay;

    const rows = sorted.map(e=>{
      const mins = calcMins(e.startTime,e.endTime);
      const h = mins/60;
      const isDayType = ["non-working","per-diem","working-day"].includes(e.dayType);
      const overnight = e.endTime&&e.startTime&&(parseInt(e.endTime.split(":")[0])*60+parseInt(e.endTime.split(":")[1]))<(parseInt(e.startTime.split(":")[0])*60+parseInt(e.startTime.split(":")[1]));
      const dayTag = isDayType ? `<span style="margin-left:5px;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;background:${e.dayType==="non-working"?"#fff3e0":e.dayType==="per-diem"?"#e0f2fe":"#e8f5e9"};color:${e.dayType==="non-working"?"#b45309":e.dayType==="per-diem"?"#0ea5e9":"#16a34a"}">${e.dayType==="non-working"?"NW":e.dayType==="per-diem"?"PD":"WD"}</span>` : "";
      const pp = [];
      if(e.entryType==="vendor-charge") { const tAmt=vendorTaxAmt(e); const tot=vendorTotal(e); const taxLine=tAmt>0?` &nbsp;|&nbsp; Tax (${e.taxType}): ${e.currency||"CAD"} ${tAmt.toFixed(2)} &nbsp;|&nbsp; <strong>Total: ${e.currency||"CAD"} ${tot.toFixed(2)}</strong>`:""; pp.push(`<strong style="color:#8b5cf6">${e.company||e.employeeName} — ${e.description||"Vendor"}: ${e.currency||"CAD"} ${(parseFloat(e.amount)||0).toFixed(2)}${taxLine}</strong>`); }
      else if(!isDayType && mins>0) { const hr=Number(e.hourlyOverride)||parseFloat(e.hourlyOverride)||(cfg?.hourly||0); if(hr>0) pp.push(`<strong style="color:#16a34a">${((mins/60)*hr).toFixed(2)}</strong> <span style="font-size:10px;color:#888">(${mins}min × ${hr.toFixed(2)}/h)</span>`); }
      if((parseFloat(e.numTrips)||0)>0) { const r=parseFloat(e.tripRateOverride)||(cfg?.tripRate||0); pp.push(`<span style="color:#f59e0b;font-weight:600">${parseFloat(e.numTrips)} trip${parseFloat(e.numTrips)>1?"s":""} × ${sym}${r.toFixed(0)} = ${sym}${(parseFloat(e.numTrips)*r).toFixed(2)}</span>`); }
      if((parseFloat(e.numDays)||0)>0) { const r=parseFloat(e.dayRateOverride)||(cfg?.workDay||0); pp.push(`<span style="color:#f59e0b;font-weight:600">${parseFloat(e.numDays)} day × ${sym}${r.toFixed(0)} = ${sym}${(parseFloat(e.numDays)*r).toFixed(2)}</span>`); }
      if((parseFloat(e.numNwDays)||0)>0) { const r=parseFloat(e.nwDayRateOverride)||(cfg?.nonWorkDay||0); pp.push(`<span style="color:#f97316;font-weight:600">${parseFloat(e.numNwDays)} NW × ${sym}${r.toFixed(0)} = ${sym}${(parseFloat(e.numNwDays)*r).toFixed(2)}</span>`); }
      if(e.dayType==="non-working"&&!(parseFloat(e.numNwDays)>0)) pp.push(`<span style="color:#f97316;font-weight:600">NW day ${sym}${(cfg?.nonWorkDay||0).toFixed(0)}</span>`);
      if((parseFloat(e.numPerDiem)||0)>0) { const r=parseFloat(e.perDiemRateOverride)||(cfg?.perDiem||0); pp.push(`<span style="color:#0ea5e9;font-weight:600">Per diem ${sym}${r.toFixed(0)}</span>`); }
      if(e.dayType==="per-diem"&&!(parseFloat(e.numPerDiem)>0)) pp.push(`<span style="color:#0ea5e9;font-weight:600">Per diem ${sym}${(cfg?.perDiem||0).toFixed(0)}</span>`);
      if((parseFloat(e.expenseAmt)||0)>0) pp.push(`<span style="color:#8b5cf6;font-weight:600">🧾 ${e.expenseDesc||"Expense"} ${e.expenseCurrency||"CAD"} ${(parseFloat(e.expenseAmt)||0).toFixed(2)}${inclTaxLabel(e.expenseAmt, e.expenseTax)}</span>`);
      const payStr = pp.length ? pp.join("<br>") : "—";
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap">${fmtDate(e.date)}${dayTag}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap">${isDayType?"—":(e.startTime||"—")+" → "+(e.endTime||"—")}${!isDayType&&overnight?" <em style='color:#b45309;font-size:10px'>(overnight)</em>":""}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:700;color:#d42b2b;white-space:nowrap">${isDayType?"—":fmtH(h)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap">${payStr}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:11px;color:#666">${e.notes||""}</td>
      </tr>`;
    }).join("");

    const expRows = empExpenses.map(ex=>`<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${fmtDate(ex.date)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${ex.type}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${ex.description||""}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:700;color:#16a34a">${ex.currency} ${parseFloat(ex.amount||0).toFixed(2)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600;color:${ex.status==="approved"?"#16a34a":ex.status==="rejected"?"#dc2626":"#b45309"}">${ex.status||"pending"}</td>
    </tr>`).join("");

    const sr = [];
    if(hourlyPay>0) { const hasOverride=sorted.some(e=>parseFloat(e.hourlyOverride)>0); sr.push(`<tr><td style="padding:4px 0;color:#555">Hours / Heures (${(totalMins/60).toFixed(2)}h${hasOverride?" — mixed rates":" × "+sym+(cfg?.hourly||0).toFixed(2)+"/h"}):</td><td style="text-align:right;font-weight:600">${sym}${hourlyPay.toFixed(2)}</td></tr>`); }
    if(tripPay>0) { const tt=sorted.reduce((a,e)=>a+(parseFloat(e.numTrips)||0),0); sr.push(`<tr><td style="padding:4px 0;color:#555">Trips / Trajets (${tt}):</td><td style="text-align:right;font-weight:600;color:#f59e0b">${sym}${tripPay.toFixed(2)}</td></tr>`); }
    if(wdPay>0) { const td2=sorted.reduce((a,e)=>a+(parseFloat(e.numDays)||0),0); sr.push(`<tr><td style="padding:4px 0;color:#555">Working days / Jours travaillés (${td2}):</td><td style="text-align:right;font-weight:600">${sym}${wdPay.toFixed(2)}</td></tr>`); }
    if(nwPay>0) { const tn=sorted.reduce((a,e)=>a+(parseFloat(e.numNwDays)||0),0)+sorted.filter(e=>e.dayType==="non-working").length; sr.push(`<tr><td style="padding:4px 0;color:#555">Non-working days / Jours non-travaillés (${tn}):</td><td style="text-align:right;font-weight:600;color:#f97316">${sym}${nwPay.toFixed(2)}</td></tr>`); }
    if(pdPay>0) { const tp=sorted.reduce((a,e)=>a+(parseFloat(e.numPerDiem)||0),0)+sorted.filter(e=>e.dayType==="per-diem").length; sr.push(`<tr><td style="padding:4px 0;color:#555">Per diem (${tp}):</td><td style="text-align:right;font-weight:600;color:#0ea5e9">${sym}${pdPay.toFixed(2)}</td></tr>`); }
    if(expPay>0) sr.push(`<tr><td style="padding:4px 0;color:#555">Expenses / Dépenses:</td><td style="text-align:right;font-weight:600;color:#8b5cf6">${expPay.toFixed(2)}</td></tr>`);
    const paySummary = sr.length ? `
      <div style="margin-top:24px;padding:14px 16px;background:#f0fff4;border:1px solid #86efac;border-radius:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#16a34a;margin-bottom:10px">Pay Summary / Résumé de paie</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          ${sr.join("")}
          <tr style="border-top:1px solid #86efac"><td style="padding:6px 0;font-weight:700;font-size:15px">Gross Pay / Salaire brut:</td><td style="text-align:right;font-weight:700;color:#16a34a;font-size:18px">${cur} ${empTotal.toFixed(2)}</td></tr>
        </table>
      </div>` : "";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hours - ${emp.name}</title>
    <style>body{font-family:Arial,sans-serif;margin:30px;color:#111}table{width:100%;border-collapse:collapse;font-size:13px}th{background:#f1f5f9;text-align:left;padding:8px 10px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em}td{vertical-align:top}h2{color:#d42b2b;margin-top:24px}.no-print{margin-top:20px;text-align:center}@media print{.no-print{display:none}}</style>
    </head><body>
    <div style="border-bottom:3px solid #d42b2b;padding-bottom:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end">
      <div><div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:4px">DIAMOND BACK EXPRESS INC.</div><div style="font-size:22px;font-weight:700">${emp.name}</div><div style="font-size:11px;color:#666;margin-top:3px">${emp.email||""} ${emp.phone?"&middot; "+emp.phone:""}</div></div>
      <div style="text-align:right"><div style="font-size:11px;color:#666">Event</div><div style="font-size:15px;font-weight:700">${selectedEvent}</div><div style="font-size:11px;color:#666;margin-top:4px">Total: <strong style="color:#d42b2b">${fmtH(totalH)} over ${sorted.length} day${sorted.length===1?"":"s"}</strong>${cfg?` &nbsp;·&nbsp; <strong style="color:#16a34a">${cur} ${empTotal.toFixed(2)}</strong>`:""}</div></div>
    </div>
    <h2>Hours</h2>
    <table><thead><tr><th>Date</th><th>Time / Heure</th><th>Hours / Heures</th><th style="color:#16a34a">Pay / Paie (${cur})</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr style="border-top:2px solid #000;background:#f8fafc">
      <td colspan="2" style="padding:8px 10px;font-weight:700">TOTAL</td>
      <td style="padding:8px 10px;font-weight:700;color:#d42b2b">${fmtH(totalH)}</td>
      <td style="padding:8px 10px;font-weight:700;color:#16a34a;font-size:15px">${cfg?`${cur} ${empTotal.toFixed(2)}`:"—"}</td>
      <td></td>
    </tr></tfoot>
    </table>
    ${paySummary}
    ${empExpenses.length>0?`<h2>Expenses / Dépenses</h2><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead><tbody>${expRows}</tbody></table>`:""}
    <div style="margin-top:24px;font-size:12px;color:#666;border-top:1px solid #eee;padding-top:12px">Generated by DBX Dispatch &mdash; Diamond Back Express Inc.</div>
    <div class="no-print"><button onclick="window.print()" style="padding:12px 28px;background:#d42b2b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Print / Save as PDF</button></div>
    </body></html>`;
    const blob = new Blob([html], {type:"text/html"});
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const printSummary = () => {
    const w=window.open("","_blank");
    w.document.write(buildPrintHtml(selectedEvent,employees,entries,expenses,totalHours));
    w.document.close();
  };

  return (
    <div style={{padding:20}}>
      {/* Modals */}
      {editEntry && <EntryModal entry={editEntry} events={events} employees={employees} selectedEvent={selectedEvent} allEntries={entries} onClose={()=>setEditEntry(null)} onSave={handleEntrySaved}/>}
      {editVendorEntry && <VendorChargeModal editEntry={editVendorEntry} events={events} selectedEvent={selectedEvent} suppliers={suppliers} onClose={()=>setEditVendorEntry(null)} onSave={handleEntrySaved}/>}
      {showVendorModal && <VendorChargeModal events={events} selectedEvent={selectedEvent} suppliers={suppliers} onClose={()=>setShowVendorModal(false)} onSave={handleEntrySaved}/>}

      {/* Send Recap modal */}
      {showRecapModal && recapEmp && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setShowRecapModal(false);}}>
        <div style={{background:"#0f172a",borderRadius:12,padding:24,width:"100%",maxWidth:460,border:"1px solid #1e293b",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9"}}>Send Recap</div>
              <div style={{fontSize:12,color:"#64748b",marginTop:2}}>To: <span style={{color:"#22c55e"}}>{recapEmp.name}</span> · {recapEmp.email}</div>
            </div>
            <button onClick={()=>setShowRecapModal(false)} style={{background:"none",border:"none",color:"#64748b",fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
          </div>
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:4}}>Message <span style={{color:"#64748b",fontWeight:400,textTransform:"none"}}>(optional — shown at top of recap)</span></label>
            <textarea
              rows={10}
              style={{width:"100%",padding:"10px 12px",borderRadius:7,border:"1px solid #1e293b",background:"#1e293b",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box",outline:"none"}}
              placeholder="Optional message to include in the recap email..."
              value={recapMsg}
              onChange={e=>setRecapMsg(e.target.value)}
            />
          </div>
          <div style={{marginBottom:20}}>
            <label style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",display:"block",marginBottom:4}}>Additional recipients <span style={{color:"#64748b",fontWeight:400,textTransform:"none"}}>(comma separated)</span></label>
            <input
              style={{width:"100%",padding:"10px 12px",borderRadius:7,border:"1px solid #1e293b",background:"#1e293b",color:"#f1f5f9",fontSize:13,fontFamily:"inherit",boxSizing:"border-box",outline:"none"}}
              placeholder="e.g. supervisor@company.com, hr@company.com"
              value={recapExtraEmails}
              onChange={e=>setRecapExtraEmails(e.target.value)}
            />
          </div>
          <div style={{display:"flex",gap:8}}>
            <button
              onClick={()=>sendRecap(recapEmp, recapMsg, recapExtraEmails)}
              disabled={sendingRecap===recapEmp.email}
              style={{flex:1,padding:"11px",borderRadius:8,border:"none",background:"#22c55e",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit",opacity:sendingRecap===recapEmp.email?0.6:1}}
            >
              {sendingRecap===recapEmp.email?"Sending...":"📧 Send Recap"}
            </button>
            <button onClick={()=>setShowRecapModal(false)} style={{padding:"11px 20px",borderRadius:8,border:"1px solid #1e293b",background:"transparent",color:"#94a3b8",cursor:"pointer",fontFamily:"inherit",fontSize:13}}>Cancel</button>
          </div>
        </div>
      </div>}
      {showAddModal && <EntryModal events={events} employees={employees} selectedEvent={selectedEvent} allEntries={entries} onClose={()=>setShowAddModal(false)} onSave={handleEntrySaved}/>}

      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,color:T.text,marginBottom:2}}>Timesheets</div>
          <div style={{fontSize:13,color:T.muted}}>Employee hours & expenses by event</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button style={bG} onClick={()=>setShowAddModal(true)}><Ic n="plus" s={13}/> Add Entry</button>
          <button style={{...bG,background:"rgba(139,92,246,0.15)",border:"1px solid #8b5cf6",color:"#8b5cf6"}} onClick={()=>setShowVendorModal(true)}><Ic n="plus" s={13}/> Vendor Charge</button>
          <button style={bS} onClick={loadData} disabled={loading}><Ic n="refresh" s={13}/> Refresh</button>
          <button style={bS} onClick={exportCSV} disabled={!entries.length}><Ic n="download" s={13}/> Hours CSV</button>
          <button style={bS} onClick={exportExpCSV} disabled={!expenses.length}><Ic n="download" s={13}/> Expenses CSV</button>
          <button style={bP} onClick={printSummary} disabled={!entries.length}><Ic n="download" s={13}/> Print PDF</button>
        </div>
      </div>

      {/* Event tabs */}
      <div style={{marginBottom:20}}>
        <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8,fontWeight:600}}>Event</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {events.length===0
            ? <div style={{fontSize:13,color:T.muted}}>No active events. Add one in the Events page.</div>
            : [
            <button key="__all__" onClick={()=>setSelectedEvent("__all__")} style={{padding:"8px 14px",borderRadius:7,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1px solid ${selectedEvent==="__all__"?T.red:T.border}`,background:selectedEvent==="__all__"?T.redDim:"transparent",color:selectedEvent==="__all__"?T.red:T.muted}}>All Events</button>,
            ...events.map(ev=>(
            <button key={ev} onClick={()=>setSelectedEvent(ev)} style={{padding:"8px 14px",borderRadius:7,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1px solid ${selectedEvent===ev?T.red:T.border}`,background:selectedEvent===ev?T.redDim:"transparent",color:selectedEvent===ev?T.red:T.muted}}>{ev}</button>
          ))]}
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20,maxWidth:600}}>
        <StatCard label="Total Hours" value={totalHours.toFixed(1)+"h"} color={T.red}/>
        <StatCard label="Employees" value={employees.length}/>
        <StatCard label="Expenses" value={expenses.length} color={pendingExp>0?T.amber:T.green}/>
        <StatCard label="Pending $$" value={pendingExp} color={pendingExp>0?T.amber:T.muted}/>
      </div>

      {/* View toggle */}
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {[{k:"by-employee",l:"By Employee"},{k:"all-entries",l:"All Hours"},{k:"expenses",l:`Expenses${pendingExp>0?` (${pendingExp})`:""}`}].map(({k,l})=>(
          <button key={k} onClick={()=>setView(k)} style={{padding:"7px 16px",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1px solid ${view===k?T.red:T.border}`,background:view===k?T.redDim:"transparent",color:view===k?T.red:T.muted}}>{l}</button>
        ))}
      </div>

      {loading&&<div style={{color:T.muted,fontSize:14,padding:"20px 0"}}>Loading...</div>}

      {/* ── By Employee ── */}
      {!loading&&view==="by-employee"&&<div>
        {!employees.length&&<div style={{color:T.muted,fontSize:14,padding:"20px 0"}}>No entries for this event yet.</div>}
        <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:8,background:T.surface,border:`1px solid ${T.border}`,borderRadius:7,padding:"7px 12px",maxWidth:320}}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={empSearch} onChange={e=>setEmpSearch(e.target.value)} placeholder="Search employee..." style={{background:"transparent",border:"none",color:T.text,fontSize:12,outline:"none",width:"100%",fontFamily:"inherit"}}/>
        </div>
        {employees.filter(emp=>!xeroSent[emp.email]).filter(emp=>!empSearch||emp.name.toLowerCase().includes(empSearch.toLowerCase())||emp.email.toLowerCase().includes(empSearch.toLowerCase())).map(emp=>{
          const expanded=expandedEmp===emp.email;
          return <div key={emp.email} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,marginBottom:10,overflow:"hidden"}}>
            <div onClick={()=>setExpandedEmp(expanded?null:emp.email)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",cursor:"pointer"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:34,height:34,borderRadius:"50%",background:T.surface,display:"flex",alignItems:"center",justifyContent:"center",color:T.muted,flexShrink:0}}><Ic n="user" s={16}/></div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <div style={{fontSize:14,fontWeight:600,color:T.text}}>{emp.name}</div>
                    {selectedEvent==="__all__" && emp.events && emp.events.map(ev=><span key={ev} style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:"rgba(220,38,38,0.1)",color:T.red,whiteSpace:"nowrap"}}>{ev==="__all__"?"No Event":ev}</span>)}
                    {/* Event-level document links */}
                    {(empRecords[emp.email?.toLowerCase?.().trim()]?.eventDocs||empRecords[emp.email]?.eventDocs||[]).filter(d=>selectedEvent==="__all__"||d.event===selectedEvent||!d.event).map((d,i)=>(
                      <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 6px 2px 8px",borderRadius:10,background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)"}}>
                        <a href={d.url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{color:"#22c55e",fontSize:10,fontWeight:700,textDecoration:"none",whiteSpace:"nowrap"}}>📄 {d.label||"Invoice"}</a>
                        <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm("Delete this document?"))return;
                          await deleteFileByUrl(d.url).catch(()=>{});
                          const snap=await getDocs(query(collection(db,"employees"),where("email","==",emp.email)));
                          if(!snap.empty){
                            const existing=snap.docs[0].data().eventDocs||[];
                            const updated=existing.filter((_,idx)=>idx!==i);
                            await updateDoc(doc(db,"employees",snap.docs[0].id),{eventDocs:updated});
                            const key=emp.email?.toLowerCase?.().trim()||emp.email;
                            setEmpRecords(prev=>({...prev,[key]:{...prev[key],eventDocs:updated},[emp.email]:{...prev[emp.email],eventDocs:updated}}));
                          }
                        }} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:11,padding:"0 2px",lineHeight:1}}>×</button>
                      </span>
                    ))}
                    {/* Upload button */}
                    <EmpDocUpload empId={emp.empRecordId||""} empEmail={emp.email} event={selectedEvent==="__all__"?"":selectedEvent} onSaved={()=>{
                      getDocs(query(collection(db,"employees"),where("email","==",emp.email))).then(snap=>{
                        if(!snap.empty) {
                          const data = snap.docs[0].data();
                          const key = emp.email?.toLowerCase?.().trim()||emp.email;
                          setEmpRecords(prev=>({...prev,[key]:{...prev[key],...data},[emp.email]:{...prev[emp.email],...data}}));
                        }
                      });
                    }}/>
                  </div>
                  <div style={{fontSize:11,color:T.muted,marginTop:1}}>{emp.email} · {emp.phone}</div>
                  {/* Pay config editor */}
                  <div style={{marginTop:6}} onClick={e=>e.stopPropagation()}>
                    {emp.empRecordId
                      ? <PayConfigEditor employee={{id:emp.empRecordId, payCfg:emp.payCfg}} onSaved={onRateSaved}/>
                      : <span style={{fontSize:11,color:T.dim,fontStyle:"italic"}}>Register employee to configure pay</span>
                    }
                  </div>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:18,fontWeight:700,color:T.red,fontFamily:"'IBM Plex Mono',monospace"}}>{emp.totalHours.toFixed(1)}h</div>
                  <div style={{fontSize:10,color:T.muted}}>{emp.days} {emp.days===1?"day":"days"}</div>
                  {(()=>{ const p=calcPay(emp); if(!p) return null;
                    return <>
                      <div style={{fontSize:13,fontWeight:700,color:T.green,fontFamily:"'IBM Plex Mono',monospace",marginTop:2}}>${p.total.toFixed(2)}</div>
                      {p.type==="daily" && <div style={{fontSize:9,color:T.dim}}>{p.workDays}W · {p.nonWorkDays}NW · ${p.perDiem.toFixed(2)} per diem</div>}
                      {p.type==="hourly" && <div style={{fontSize:9,color:T.dim}}>{emp.entries.some(e=>parseFloat(e.hourlyOverride)>0)?"mixed rates":"@ $"+(emp.payCfg?.hourly||0).toFixed(2)+"/h"}</div>}
                      {p.tripPay>0 && <div style={{fontSize:9,color:"#f59e0b",fontWeight:600}}>${p.tripPay.toFixed(2)} trips</div>}
                      {p.dayExtraPay>0 && <div style={{fontSize:9,color:"#f59e0b",fontWeight:600}}>${p.dayExtraPay.toFixed(2)} days</div>}
                      {p.vendorPay>0 && <div style={{fontSize:9,color:"#8b5cf6",fontWeight:600}}>${p.vendorPay.toFixed(2)} vendor</div>}
                    </>;
                  })()}
                </div>
                {/* Delete buttons — stop propagation so they don't toggle expand */}
                <div style={{display:"flex",flexDirection:"column",gap:5}} onClick={e=>e.stopPropagation()}>
                  <button onClick={()=>{setRecapEmp(emp);setRecapMsg(defaultRecapMsg(selectedEvent));setRecapExtraEmails("");setShowRecapModal(true);}} disabled={sendingRecap===emp.email} style={{background:"rgba(34,197,94,0.15)",border:`1px solid ${T.green}`,color:T.green,cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    📧 {sendingRecap===emp.email?"Sending...":"Send Recap"}
                  </button>
                  <button onClick={(e)=>{e.stopPropagation();printEmployeeReport(emp);}} style={{background:"rgba(220,38,38,0.15)",border:`1px solid ${T.red}`,color:T.red,cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    <Ic n="pdf" s={12}/> PDF
                  </button>
                  <button onClick={(e)=>{e.stopPropagation();if(selectedEvent==="__all__"){alert("Please select a specific event first.");return;}if(emp.entries[0]?.entryType==="vendor-charge"){exportVendorCsv(emp.email);}else{exportXeroBillSingle(emp.email);}}} style={{background:"rgba(0,168,132,0.15)",border:"1px solid #00a884",color:"#00a884",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    <Ic n="download" s={12}/> Xero CSV
                  </button>
                  <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm("Mark all entries for "+emp.name+" as sent to Xero?"))return;try{for(const entry of emp.entries){await updateDoc(doc(db,"timesheets",entry.id),{xeroSent:true});}setEntries(prev=>prev.map(en=>en.employeeEmail===emp.email?{...en,xeroSent:true}:en));}catch(err){console.error(err);alert("Error marking entries");}}} style={{background:"rgba(139,92,246,0.15)",border:"1px solid #8b5cf6",color:"#8b5cf6",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    <Ic n="check" s={12}/> Sent to Xero ✓
                  </button>
                  <button onClick={()=>moveEmployee(emp)} style={{background:"rgba(59,130,246,0.15)",border:"1px solid #3b82f6",color:"#60a5fa",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    ↗ Move to Event
                  </button>
                  <button onClick={()=>deleteAllEntries(emp)} title="Clear all entries for this event" style={{background:"rgba(239,68,68,0.1)",border:`1px solid ${T.red}`,color:T.red,cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                    <Ic n="trash" s={12}/> Clear entries
                  </button>
                </div>
                <div style={{color:T.muted}}><Ic n={expanded?"chevDown":"chevRight"} s={16}/></div>
              </div>
            </div>
            {expanded&&<div style={{borderTop:`1px solid ${T.border}`}}>
              {[...emp.entries].sort((a,b)=>a.date.localeCompare(b.date)).map(entry=>{
                const h=["non-working","per-diem","working-day"].includes(entry.dayType)?0:calcHours(entry.startTime,entry.endTime);
                const overnight = entry.startTime&&entry.endTime&&h>0&&
                  (parseInt(entry.endTime.split(":")[0])*60+parseInt(entry.endTime.split(":")[1]))<
                  (parseInt(entry.startTime.split(":")[0])*60+parseInt(entry.startTime.split(":")[1]));
                const isNonWorking = entry.dayType==="non-working";
                const toggleDayType = async () => {
                  const newType = isNonWorking ? "working" : "non-working";
                  try {
                    await updateDoc(doc(db,"timesheets",entry.id), { dayType: newType });
                    setEntries(prev=>prev.map(e=>e.id===entry.id?{...e,dayType:newType}:e));
                  } catch(e) { console.error(e); }
                };
                return <div key={entry.id} style={{padding:"12px 16px",borderBottom:`1px solid ${T.hover}`,display:"grid",gridTemplateColumns:"110px 50px 200px 1fr",gap:8,alignItems:"start"}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:600,color:T.text}}>{fd(entry.date)}</div>
                    <div style={{fontSize:11,color:T.muted,marginTop:2}}>{["non-working","per-diem","working-day"].includes(entry.dayType)?<span style={{fontStyle:"italic"}}>{entry.dayType==="per-diem"?"Per diem":entry.dayType==="non-working"?"Non-working day":"Working day"}</span>:<>{entry.startTime} → {entry.endTime}{overnight&&<span style={{color:T.amber}}> ☽</span>}</>}</div>
                    {entry.manuallyEdited&&<div style={{fontSize:9,color:T.dim,marginTop:1}}>✎ edited</div>}
                    {/* Working / Non-working toggle — only shown for daily pay */}
                    {emp.payCfg==="daily" && <button onClick={toggleDayType} style={{marginTop:4,fontSize:10,padding:"2px 7px",borderRadius:4,border:`1px solid ${isNonWorking?"#f97316":T.green}`,background:isNonWorking?"rgba(249,115,22,0.12)":"rgba(34,197,94,0.12)",color:isNonWorking?"#f97316":T.green,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                      {isNonWorking?"Non-Working":"Working"}
                    </button>}
                  </div>
                  <div style={{fontSize:13,fontWeight:600,color:T.red,fontFamily:"'IBM Plex Mono',monospace",paddingTop:1}}>{h.toFixed(1)}h</div>
                  <div style={{fontSize:12,color:T.muted,lineHeight:1.5}}>
                    {entry.entryType==="vendor-charge"?<div><strong style={{color:"#8b5cf6"}}>{entry.company||entry.employeeName}</strong>{entry.description&&<span style={{color:T.muted}}> — {entry.description}</span>}{entry.invoiceNum&&<span style={{color:T.dim}}> (#{entry.invoiceNum})</span>}<div style={{marginTop:4,fontSize:13,fontWeight:600,color:"#94a3b8"}}>{entry.currency||"CAD"} {(parseFloat(entry.amount)||0).toFixed(2)}{entry.taxType&&entry.taxType!=="Tax Exempt"&&<span style={{fontSize:11,color:T.dim,marginLeft:6}}>{entry.taxType}</span>}</div>{entry.taxType&&entry.taxType!=="Tax Exempt"&&<><div style={{fontSize:11,color:T.muted}}>Tax: {entry.currency||"CAD"} {vendorTaxAmt(entry).toFixed(2)}</div><div style={{fontSize:13,fontWeight:700,color:"#22c55e"}}>Total: {entry.currency||"CAD"} {vendorTotal(entry).toFixed(2)}</div></>}{(!entry.taxType||entry.taxType==="Tax Exempt")&&<div style={{fontSize:13,fontWeight:700,color:"#22c55e"}}>{entry.currency||"CAD"} {(parseFloat(entry.amount)||0).toFixed(2)}</div>}</div>:entry.notes}
                    {((parseFloat(entry.numTrips)||0)>0||(parseFloat(entry.numDays)||0)>0||(parseFloat(entry.numNwDays)||0)>0||(parseFloat(entry.numPerDiem)||0)>0||(parseFloat(entry.expenseAmt)||0)>0||entry.dayType==="non-working"||entry.dayType==="per-diem")&&(
                      <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:2}}>
                        {(parseFloat(entry.hourlyOverride)||0)>0&&<span style={{fontSize:11,color:"#3b82f6",fontWeight:600}}>{"⏱️ $"+(parseFloat(entry.hourlyOverride)).toFixed(2)+"/h (override)"}</span>}
                        {(parseFloat(entry.numTrips)||0)>0&&<span style={{fontSize:11,color:"#f59e0b",fontWeight:600}}>{"🚗 "+parseFloat(entry.numTrips)+" trips × $"+(parseFloat(entry.tripRateOverride)||(parseFloat(emp.payCfg?.tripRate)||0)).toFixed(0)+" = $"+((parseFloat(entry.numTrips)||0)*(parseFloat(entry.tripRateOverride)||(parseFloat(emp.payCfg?.tripRate)||0))).toFixed(2)}</span>}
                        {(parseFloat(entry.numDays)||0)>0&&<span style={{fontSize:11,color:"#f59e0b",fontWeight:600}}>{"📅 "+parseFloat(entry.numDays)+" days × $"+(parseFloat(entry.dayRateOverride)||(parseFloat(emp.payCfg?.workDay)||0)).toFixed(0)+" = $"+((parseFloat(entry.numDays)||0)*(parseFloat(entry.dayRateOverride)||(parseFloat(emp.payCfg?.workDay)||0))).toFixed(2)}</span>}
                        {(parseFloat(entry.numNwDays)||0)>0&&<span style={{fontSize:11,color:"#f97316",fontWeight:600}}>{"📅 "+parseFloat(entry.numNwDays)+" NW days × $"+(parseFloat(entry.nwDayRateOverride)||(parseFloat(emp.payCfg?.nonWorkDay)||0)).toFixed(0)+" = $"+((parseFloat(entry.numNwDays)||0)*(parseFloat(entry.nwDayRateOverride)||(parseFloat(emp.payCfg?.nonWorkDay)||0))).toFixed(2)}</span>}
                        {entry.dayType==="non-working"&&!(parseFloat(entry.numNwDays)>0)&&<span style={{fontSize:11,color:"#f97316",fontWeight:600}}>📅 Non-working day</span>}
                        {(parseFloat(entry.numPerDiem)||0)>0&&<span style={{fontSize:11,color:"#0ea5e9",fontWeight:600}}>{"🍽️ "+parseFloat(entry.numPerDiem)+" per diem × $"+(parseFloat(entry.perDiemRateOverride)||(parseFloat(emp.payCfg?.perDiem)||0)).toFixed(0)+" = $"+((parseFloat(entry.numPerDiem)||0)*(parseFloat(entry.perDiemRateOverride)||(parseFloat(emp.payCfg?.perDiem)||0))).toFixed(2)}</span>}
                        {entry.dayType==="per-diem"&&!(parseFloat(entry.numPerDiem)>0)&&<span style={{fontSize:11,color:"#0ea5e9",fontWeight:600}}>🍽️ Per diem (employee)</span>}
                        {(parseFloat(entry.expenseAmt)||0)>0&&<span style={{fontSize:11,color:"#8b5cf6",fontWeight:600}}>{"🧾 "+(entry.expenseDesc||"Expense")+" — $"+(parseFloat(entry.expenseAmt)||0).toFixed(2)+inclTaxLabel(entry.expenseAmt, entry.expenseTax)}</span>}
                        {expenses.filter(ex=>ex.employeeEmail===emp.email&&ex.date===entry.date).map((ex,i)=>(
                          <span key={i} style={{fontSize:11,color:"#8b5cf6",fontWeight:600}}>{"🧾 "+ex.type+" — $"+parseFloat(ex.amount||0).toFixed(2)+" ("+ex.currency+")"+(ex.description?" · "+ex.description:"")}</span>
                        ))}
                      </div>
                    )}
                    {(entry.truckUnit||entry.trailerUnit||entry.kmStart!=null||entry.unitLog?.length>0) && (
                      <div style={{marginTop:6,display:"flex",flexDirection:"column",gap:3}}>
                        {(entry.truckUnit||entry.trailerUnit) && (
                          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                            {entry.truckUnit&&<span style={{fontSize:11,color:T.muted}}>🚛 {entry.truckUnit}</span>}
                            {entry.trailerUnit&&<span style={{fontSize:11,color:T.muted}}>TRL: {entry.trailerUnit}</span>}
                            {entry.kmStart!=null&&entry.kmEnd!=null&&<span style={{fontSize:11,color:T.muted}}>📍 {entry.kmStart} → {entry.kmEnd} km{entry.kmTotal!=null?` (+${entry.kmTotal})`:""}</span>}
                          </div>
                        )}
                        {entry.unitLog?.length>0&&<div style={{marginTop:4,padding:"6px 8px",background:T.surface,borderRadius:6,border:`1px solid ${T.border}`}}>
                          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:T.dim,marginBottom:4}}>Unit History</div>
                          {entry.unitLog.map((u,i)=>(
                            <div key={i} style={{fontSize:11,color:T.muted,display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:i<entry.unitLog.length-1?`1px solid ${T.hover}`:"none"}}>
                              <span>{u.truck&&`🚛 ${u.truck}`}{u.trailer&&` TRL: ${u.trailer}`}{u.kmTotal!=null&&` (+${u.kmTotal.toFixed(0)}km)`}</span>
                              <span style={{fontSize:10,color:T.dim}}>{u.time}</span>
                            </div>
                          ))}
                        </div>}
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",gap:10,alignItems:"start",justifyContent:"flex-start"}}>
                  {(()=>{
                    const isVendor=entry.entryType==="vendor-charge";
                    const isDT=["non-working","per-diem","working-day"].includes(entry.dayType);
                    const hr=Number(entry.hourlyOverride)||parseFloat(emp.payCfg?.hourly)||0;
                    const hPay=!isDT&&h>0&&hr>0?h*hr:0;
                    const tPay=(parseFloat(entry.numTrips)||0)*(parseFloat(entry.tripRateOverride)||(parseFloat(emp.payCfg?.tripRate)||0));
                    const dPay=(parseFloat(entry.numDays)||0)*(parseFloat(entry.dayRateOverride)||(parseFloat(emp.payCfg?.workDay)||0));
                    const nPay=(parseFloat(entry.numNwDays)||0)*(parseFloat(entry.nwDayRateOverride)||(parseFloat(emp.payCfg?.nonWorkDay)||0));
                    const pPay=(parseFloat(entry.numPerDiem)||0)*(parseFloat(entry.perDiemRateOverride)||(parseFloat(emp.payCfg?.perDiem)||0));
                    const ePay=parseFloat(entry.expenseAmt)||0;
                    const nwE=entry.dayType==="non-working"&&!(parseFloat(entry.numNwDays)>0)?(parseFloat(emp.payCfg?.nonWorkDay)||0):0;
                    const pdE=entry.dayType==="per-diem"&&!(parseFloat(entry.numPerDiem)>0)?(parseFloat(emp.payCfg?.perDiem)||0):0;
                    const total=hPay+tPay+dPay+nPay+pPay+ePay+nwE+pdE;
                    const sym=emp.payCfg?.currency==="USD"?"US$":"$";
                    return <div style={{fontSize:11,textAlign:"right"}}>
                      {hPay>0&&<div style={{color:"#22c55e",fontWeight:600}}>{h.toFixed(1)}h × {sym+hr.toFixed(2)} = <strong>{sym+hPay.toFixed(2)}</strong></div>}
                      {tPay>0&&<div style={{color:"#f59e0b"}}>{parseFloat(entry.numTrips)} trip{parseFloat(entry.numTrips)>1?"s":""} = {sym+tPay.toFixed(2)}</div>}
                      {dPay>0&&<div style={{color:"#f59e0b"}}>{parseFloat(entry.numDays)} day = {sym+dPay.toFixed(2)}</div>}
                      {nPay>0&&<div style={{color:"#f97316"}}>{parseFloat(entry.numNwDays)} NW = {sym+nPay.toFixed(2)}</div>}
                      {nwE>0&&<div style={{color:"#f97316"}}>NW = {sym+nwE.toFixed(2)}</div>}
                      {pPay>0&&<div style={{color:"#0ea5e9"}}>Diem = {sym+pPay.toFixed(2)}</div>}
                      {pdE>0&&<div style={{color:"#0ea5e9"}}>Diem = {sym+pdE.toFixed(2)}</div>}
                      {ePay>0&&<div style={{color:"#8b5cf6"}}>Exp = {(entry.expenseCurrency||"CAD")} {ePay.toFixed(2)}</div>}
                      {isVendor&&<div style={{color:"#8b5cf6",fontWeight:700}}>{(entry.currency||"CAD")+" "+(parseFloat(entry.amount)||0).toFixed(2)}</div>}
                      {!isVendor&&total>0&&<div style={{fontWeight:700,color:"#22c55e",borderTop:"1px solid "+T.border,marginTop:2,paddingTop:2}}>{sym+total.toFixed(2)} {emp.payCfg?.currency||"CAD"}</div>}
                    </div>;
                  })()}
                  <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                    <button onClick={()=>entry.entryType==="vendor-charge"?setEditVendorEntry(entry):setEditEntry(entry)} style={{background:"#1e293b",border:`1px solid ${T.border}`,color:"#94a3b8",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="edit" s={12}/> Edit
                    </button>
                    <button onClick={()=>deleteEntry(entry)} style={{background:"rgba(220,38,38,0.15)",border:`1px solid #dc2626`,color:"#f87171",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="trash" s={12}/> Delete
                    </button>
                    {entry.gpsIn?.method==="button" &&
                      <a href={`https://www.google.com/maps?q=${entry.gpsIn.lat},${entry.gpsIn.lng}`} target="_blank" rel="noreferrer" style={{background:"rgba(96,165,250,0.15)",border:"1px solid #60a5fa",color:"#60a5fa",textDecoration:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                        📍 In
                      </a>}
                    {entry.gpsIn?.method==="unavailable" &&
                      <span style={{fontSize:11,color:T.amber,fontWeight:600}}>⚠️ No GPS In</span>}
                    {entry.gpsOut?.method==="button" &&
                      <a href={`https://www.google.com/maps?q=${entry.gpsOut.lat},${entry.gpsOut.lng}`} target="_blank" rel="noreferrer" style={{background:"rgba(96,165,250,0.15)",border:"1px solid #60a5fa",color:"#60a5fa",textDecoration:"none",borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                        📍 Out
                      </a>}
                    {entry.gpsOut?.method==="unavailable" &&
                      <span style={{fontSize:11,color:T.amber,fontWeight:600}}>⚠️ No GPS Out</span>}
                    {entry.attachmentUrl&&<span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 6px 2px 8px",borderRadius:6,background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)"}}>
                      <a href={entry.attachmentUrl} target="_blank" rel="noreferrer" style={{color:"#22c55e",fontSize:11,fontWeight:600,textDecoration:"none",whiteSpace:"nowrap"}}>📄 Doc</a>
                      <button onClick={async()=>{if(!window.confirm("Delete this attachment?"))return;
                        await deleteFileByUrl(entry.attachmentUrl).catch(()=>{});
                        await updateDoc(doc(db,"timesheets",entry.id),{attachmentUrl:""});
                        setEntries(prev=>prev.map(e=>e.id===entry.id?{...e,attachmentUrl:""}:e));
                      }} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:11,padding:"0 2px",lineHeight:1}}>×</button>
                    </span>}
                  </div>
                  </div>
                </div>;
              })}
              <div style={{padding:"10px 16px",display:"flex",justifyContent:"flex-end",background:T.surface}}>
                <div style={{fontSize:12,color:T.muted}}>Total: <span style={{color:T.red,fontWeight:700,fontFamily:"'IBM Plex Mono',monospace"}}>{emp.totalHours.toFixed(1)}h</span><span style={{marginLeft:12}}>over {emp.days} {emp.days===1?"day":"days"}</span></div>
              </div>
            </div>}
          </div>;
        })}
      </div>}

      {/* ── Sent to Xero ── */}
      {Object.keys(xeroSent).length > 0 && (
        <div style={{marginTop:24}}>
          <button onClick={()=>setShowXeroDone(!showXeroDone)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderRadius:8,border:"1px solid #8b5cf6",background:"rgba(139,92,246,0.08)",color:"#8b5cf6",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:12}}>
            Sent to Xero ({Object.keys(xeroSent).length}) {showXeroDone ? "▲" : "▼"}
          </button>
          {showXeroDone && employees.filter(emp=>xeroSent[emp.email]).filter(emp=>!empSearch||emp.name.toLowerCase().includes(empSearch.toLowerCase())||emp.email.toLowerCase().includes(empSearch.toLowerCase())).map(emp=>{
            const expanded = expandedEmp===emp.email+"_xero";
            return <div key={emp.email} style={{background:T.card,border:"1px solid #8b5cf6",borderRadius:10,marginBottom:8,opacity:0.85}}>
              <div onClick={()=>setExpandedEmp(expanded?null:emp.email+"_xero")} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:T.surface,display:"flex",alignItems:"center",justifyContent:"center",color:T.muted,flexShrink:0}}><Ic n="user" s={16}/></div>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <div style={{fontSize:14,fontWeight:600,color:T.text}}>{emp.name}</div>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:12,background:"rgba(139,92,246,0.15)",color:"#8b5cf6",fontWeight:700}}>✓ Sent to Xero</span>
                    </div>
                    <div style={{fontSize:11,color:T.muted,marginTop:1}}>{emp.email} · {emp.phone}</div>
                    {emp.empRecordId && <div style={{marginTop:6}} onClick={e=>e.stopPropagation()}><PayConfigEditor employee={{id:emp.empRecordId,payCfg:emp.payCfg}} onSaved={onRateSaved}/></div>}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:18,fontWeight:700,color:T.red,fontFamily:"'IBM Plex Mono',monospace"}}>{emp.totalHours.toFixed(1)}h</div>
                    <div style={{fontSize:10,color:T.muted}}>{emp.days} {emp.days===1?"day":"days"}</div>
                    {(()=>{ const p=calcPay(emp); if(!p) return null;
                      return <div style={{fontSize:13,fontWeight:700,color:T.green,fontFamily:"'IBM Plex Mono',monospace",marginTop:2}}>${p.total.toFixed(2)}</div>;
                    })()}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>{setRecapEmp(emp);setRecapMsg(defaultRecapMsg(selectedEvent));setRecapExtraEmails("");setShowRecapModal(true);}} disabled={sendingRecap===emp.email} style={{background:"rgba(34,197,94,0.15)",border:`1px solid ${T.green}`,color:T.green,cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      📧 {sendingRecap===emp.email?"Sending...":"Send Recap"}
                    </button>
                    <button onClick={(e)=>{e.stopPropagation();printEmployeeReport(emp);}} style={{background:"rgba(220,38,38,0.15)",border:`1px solid ${T.red}`,color:T.red,cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="pdf" s={12}/> PDF
                    </button>
                    <button onClick={(e)=>{e.stopPropagation();if(selectedEvent==="__all__"){alert("Please select a specific event first.");return;}if(emp.entries[0]?.entryType==="vendor-charge"){exportVendorCsv(emp.email);}else{exportXeroBillSingle(emp.email);}}} style={{background:"rgba(0,168,132,0.15)",border:"1px solid #00a884",color:"#00a884",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="download" s={12}/> Xero CSV
                    </button>
                    <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm("Move "+emp.name+" back to active?"))return;try{for(const entry of emp.entries){await updateDoc(doc(db,"timesheets",entry.id),{xeroSent:false});}setEntries(prev=>prev.map(en=>en.employeeEmail===emp.email?{...en,xeroSent:false}:en));}catch(err){console.error(err);alert("Error");}}} style={{background:"rgba(245,158,11,0.15)",border:"1px solid #f59e0b",color:"#f59e0b",cursor:"pointer",borderRadius:6,padding:"5px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      ↩ Move Back
                    </button>
                  </div>
                  <div style={{color:T.muted}}><Ic n={expanded?"chevDown":"chevRight"} s={16}/></div>
                </div>
              </div>
              {expanded&&<div style={{borderTop:`1px solid ${T.border}`}}>
                {[...emp.entries].sort((a,b)=>a.date.localeCompare(b.date)).map(entry=>{
                  const h=["non-working","per-diem","working-day"].includes(entry.dayType)?0:calcHours(entry.startTime,entry.endTime);
                  const isDT=["non-working","per-diem","working-day"].includes(entry.dayType);
                  const sym=emp.payCfg?.currency==="USD"?"US$":"$";
                  const hr=Number(entry.hourlyOverride)||parseFloat(emp.payCfg?.hourly)||0;
                  const hPay=!isDT&&h>0&&hr>0?h*hr:0;
                  const tPay=(parseFloat(entry.numTrips)||0)*(parseFloat(entry.tripRateOverride)||(parseFloat(emp.payCfg?.tripRate)||0));
                  const dPay=(parseFloat(entry.numDays)||0)*(parseFloat(entry.dayRateOverride)||(parseFloat(emp.payCfg?.workDay)||0));
                  const nPay=(parseFloat(entry.numNwDays)||0)*(parseFloat(entry.nwDayRateOverride)||(parseFloat(emp.payCfg?.nonWorkDay)||0));
                  const pPay=(parseFloat(entry.numPerDiem)||0)*(parseFloat(entry.perDiemRateOverride)||(parseFloat(emp.payCfg?.perDiem)||0));
                  const ePay=parseFloat(entry.expenseAmt)||0;
                  const total=hPay+tPay+dPay+nPay+pPay+ePay;
                  return <div key={entry.id} style={{padding:"12px 16px",borderBottom:`1px solid ${T.hover}`,display:"grid",gridTemplateColumns:"110px 50px 200px 1fr",gap:8,alignItems:"start"}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:600,color:T.text}}>{fd(entry.date)}</div>
                      {!isDT&&<div style={{fontSize:11,color:T.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{entry.startTime} → {entry.endTime}</div>}
                    </div>
                    <div style={{fontSize:13,fontWeight:700,color:isDT?T.muted:T.red,fontFamily:"'IBM Plex Mono',monospace"}}>{isDT?"—":h.toFixed(1)+"h"}</div>
                    <div style={{fontSize:11,color:T.muted}}>{entry.notes||entry.description||"—"}</div>
                    <div style={{fontSize:11,textAlign:"right"}}>
                      {hPay>0&&<div style={{color:"#22c55e",fontWeight:600}}>{h.toFixed(1)}h × {sym+hr.toFixed(2)} = <strong>{sym+hPay.toFixed(2)}</strong></div>}
                      {tPay>0&&<div style={{color:"#f59e0b"}}>{parseFloat(entry.numTrips)} trip{parseFloat(entry.numTrips)>1?"s":""} = {sym+tPay.toFixed(2)}</div>}
                      {dPay>0&&<div style={{color:"#f59e0b"}}>{parseFloat(entry.numDays)} day = {sym+dPay.toFixed(2)}</div>}
                      {nPay>0&&<div style={{color:"#f97316"}}>{parseFloat(entry.numNwDays)} NW = {sym+nPay.toFixed(2)}</div>}
                      {pPay>0&&<div style={{color:"#0ea5e9"}}>Diem = {sym+pPay.toFixed(2)}</div>}
                      {ePay>0&&<div style={{color:"#8b5cf6"}}>Exp = {(entry.expenseCurrency||"CAD")} {ePay.toFixed(2)}</div>}
                      {total>0&&<div style={{fontWeight:700,color:"#22c55e",borderTop:"1px solid "+T.border,marginTop:2,paddingTop:2}}>{sym+total.toFixed(2)} {emp.payCfg?.currency||"CAD"}</div>}
                    </div>
                  </div>;
                })}
                <div style={{padding:"10px 16px",display:"flex",justifyContent:"flex-end",background:T.surface}}>
                  <div style={{fontSize:12,color:T.muted}}>Total: <span style={{color:T.red,fontWeight:700,fontFamily:"'IBM Plex Mono',monospace"}}>{emp.totalHours.toFixed(1)}h</span><span style={{marginLeft:12}}>over {emp.days} {emp.days===1?"day":"days"}</span></div>
                </div>
              </div>}
            </div>;
          })}
        </div>
      )}

      {/* ── All Hours ── */}
      {!loading&&view==="all-entries"&&<div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,overflow:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:800}}>
          <thead><tr>{["Employee","Date","Start","End","Hours","Notes","GPS In","GPS Out",""].map(h=><th key={h} style={{textAlign:"left",padding:"10px 12px",fontSize:9,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr></thead>
          <tbody>
            {!entries.length&&<tr><td colSpan={9} style={{padding:24,textAlign:"center",color:T.dim,fontSize:12}}>No entries for this event.</td></tr>}
            {(()=>{
              const GpsCell=({gps})=>{
                if(!gps) return <td style={{padding:"10px 12px",fontSize:11,color:T.dim}}>—</td>;
                if(gps.method==="unavailable") return <td style={{padding:"10px 12px"}}><span style={{fontSize:10,color:T.amber,fontWeight:600}}>⚠️ No GPS</span></td>;
                return <td style={{padding:"10px 12px"}}><a href={`https://www.google.com/maps?q=${gps.lat},${gps.lng}`} target="_blank" rel="noreferrer" style={{color:"#60a5fa",textDecoration:"none",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,display:"block"}}>📍 {gps.lat}, {gps.lng}</a>{gps.accuracy&&<div style={{fontSize:9,color:T.dim,marginTop:1}}>±{gps.accuracy}m</div>}</td>;
              };
              const byDate={};
              [...entries].sort((a,b)=>b.date.localeCompare(a.date)).forEach(e=>{
                if(!byDate[e.date]) byDate[e.date]=[];
                byDate[e.date].push(e);
              });
              return Object.keys(byDate).sort((a,b)=>b.localeCompare(a)).map(date=>[
                <tr key={`hdr-${date}`}><td colSpan={9} style={{padding:"8px 12px",background:T.surface,fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:"0.05em",borderBottom:`1px solid ${T.border}`}}>{fd(date)}</td></tr>,
                ...byDate[date].map(e=>{
                  const h=calcHours(e.startTime,e.endTime);
                  const overnight=e.startTime&&e.endTime&&h>0&&(parseInt(e.endTime.split(":")[0])*60+parseInt(e.endTime.split(":")[1]))<(parseInt(e.startTime.split(":")[0])*60+parseInt(e.startTime.split(":")[1]));
                  return <tr key={e.id} style={{borderBottom:`1px solid ${T.hover}`}}>
                <td style={{padding:"10px 12px"}}><div style={{fontSize:12,fontWeight:600,color:T.text}}>{e.employeeName}</div><div style={{fontSize:10,color:T.muted}}>{e.employeeEmail}</div></td>
                <td style={{padding:"10px 12px",fontSize:12,color:T.text}}>{fd(e.date)}</td>
                <td style={{padding:"10px 12px",fontSize:12,color:T.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{e.startTime}</td>
                <td style={{padding:"10px 12px",fontSize:12,color:T.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{e.endTime}{overnight&&<span style={{color:T.amber,marginLeft:4}}>☽</span>}</td>
                <td style={{padding:"10px 12px",fontSize:13,fontWeight:700,color:T.red,fontFamily:"'IBM Plex Mono',monospace"}}>{h.toFixed(1)}h</td>
                <td style={{padding:"10px 12px",fontSize:11,color:T.muted,maxWidth:160}}>{e.notes}</td>
                <GpsCell gps={e.gpsIn}/>
                <GpsCell gps={e.gpsOut}/>
                <td style={{padding:"10px 12px"}}>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    <button onClick={()=>e.entryType==="vendor-charge"?setEditVendorEntry(e):setEditEntry(e)} style={{background:"#1e293b",border:`1px solid ${T.border}`,color:"#94a3b8",cursor:"pointer",borderRadius:6,padding:"6px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="edit" s={12}/> Edit
                    </button>
                    <button onClick={()=>deleteEntry(e)} style={{background:"rgba(220,38,38,0.15)",border:`1px solid #dc2626`,color:"#f87171",cursor:"pointer",borderRadius:6,padding:"6px 10px",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",fontWeight:600}}>
                      <Ic n="trash" s={12}/> Delete
                    </button>
                  </div>
                </td>
              </tr>;
                })]
              ).flat();
            })()}
          </tbody>
        </table>
      </div>}

      {/* ── Expenses ── */}
      {!loading&&view==="expenses"&&<div>
        {!expenses.length&&<div style={{color:T.muted,fontSize:14,padding:"20px 0"}}>No expenses submitted for this event yet.</div>}
        {expenses.map(ex=>{
          const st=STATUS_STYLE[ex.status||"pending"];
          return <div key={ex.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:T.text}}>{ex.employeeName}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:1}}>{ex.employeeEmail} · {ex.employeePhone}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:700,color:T.green,fontFamily:"'IBM Plex Mono',monospace"}}>{ex.currency} {parseFloat(ex.amount||0).toFixed(2)}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:1}}>{fd(ex.date)}</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <span style={{fontSize:11,color:T.muted,background:T.surface,padding:"2px 10px",borderRadius:10}}>{ex.type}</span>
              {ex.event&&selectedEvent==="__all__"&&<span style={{fontSize:11,fontWeight:600,padding:"2px 10px",borderRadius:10,background:"rgba(96,165,250,0.15)",color:"#60a5fa"}}>{ex.event}</span>}
              <span style={{fontSize:11,fontWeight:600,padding:"2px 10px",borderRadius:10,background:st.bg,color:st.color}}>{st.label}</span>
            </div>
            <div style={{fontSize:13,color:T.muted,lineHeight:1.5,marginBottom:12}}>{ex.description}</div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {ex.receiptUrl&&<><a href={ex.receiptUrl} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:6,background:T.surface,color:T.text,fontSize:12,fontWeight:600,textDecoration:"none",border:`1px solid ${T.border}`}}><Ic n="receipt" s={12}/> View Receipt</a><button onClick={()=>downloadFile(ex.receiptUrl,`receipt_${ex.employeeName}_${ex.date}.jpg`)} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:6,background:"rgba(220,38,38,0.1)",color:T.red,fontSize:12,fontWeight:600,border:`1px solid ${T.red}`,cursor:"pointer",fontFamily:"inherit"}}><Ic n="download" s={12}/> Download</button></> }
              {(ex.status||"pending")==="pending"&&<>
                <button onClick={()=>updateExpenseStatus(ex.id,"approved",ex)} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:6,background:"rgba(34,197,94,0.1)",color:"#22c55e",fontSize:12,fontWeight:600,border:"1px solid #22c55e",cursor:"pointer",fontFamily:"inherit"}}><Ic n="check" s={12}/> Approve</button>
                <button onClick={()=>updateExpenseStatus(ex.id,"rejected",ex)} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:6,background:"rgba(220,38,38,0.1)",color:T.red,fontSize:12,fontWeight:600,border:`1px solid ${T.red}`,cursor:"pointer",fontFamily:"inherit"}}><Ic n="x" s={12}/> Reject</button>
              </>}
              {(ex.status==="approved"||ex.status==="rejected")&&<button onClick={()=>updateExpenseStatus(ex.id,"pending",ex)} style={{fontSize:11,color:T.muted,background:"none",border:"none",cursor:"pointer",fontFamily:"inherit"}}>Undo</button>}
              <button onClick={()=>deleteExpense(ex)} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:6,background:"rgba(220,38,38,0.1)",color:T.red,fontSize:12,fontWeight:600,border:`1px solid ${T.red}`,cursor:"pointer",fontFamily:"inherit"}}><Ic n="trash" s={12}/> Delete</button>
            </div>
          </div>;
        })}
      </div>}
    </div>
  );
}

// ── PDF Builder ──
function buildPrintHtml(event, employees, entries, expenses, totalHours) {
  const approvedExp = expenses.filter(e=>e.status==="approved");
  const totalApproved = approvedExp.reduce((a,e)=>a+parseFloat(e.amount||0),0);

  const calcH = (start, end) => {
    if(!start||!end) return 0;
    const [sh,sm]=start.split(":").map(Number);
    const [eh,em]=end.split(":").map(Number);
    let mins=(eh*60+em)-(sh*60+sm);
    if(mins<=0) mins+=24*60;
    return +(mins/60).toFixed(2);
  };
  const fmtH = (h) => { const hrs=Math.floor(h),mins=Math.round((h-hrs)*60); return `${hrs}h${mins>0?` ${mins}m`:""}`; };
  const fmtDate = (d) => new Date(d+"T12:00:00").toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
  const normCfg = (cfg) => !cfg ? null : { ...cfg, hourly:parseFloat(cfg.hourly)||0, workDay:parseFloat(cfg.workDay)||0, nonWorkDay:parseFloat(cfg.nonWorkDay)||0, perDiem:parseFloat(cfg.perDiem)||0, tripRate:parseFloat(cfg.tripRate)||0, dayRate:parseFloat(cfg.dayRate)||0 };

  const empPages = employees.map(emp=>{
    const sorted=[...emp.entries].sort((a,b)=>a.date.localeCompare(b.date));
    const totalEmpHours=sorted.reduce((a,e)=>a+calcH(e.startTime,e.endTime),0);
    const empExpenses=expenses.filter(e=>e.employeeEmail===emp.email);
    const cfg = normCfg(emp.payCfg);
    const sym = emp.payCfg?.currency==="USD" ? "US$" : "$";
    const cur = emp.payCfg?.currency || "CAD";
    const workDays = sorted.filter(e=>e.dayType!=="non-working").length;
    const nonWorkDays = sorted.filter(e=>e.dayType==="non-working").length;
    // Per-minute calculation for hourly
    const totalEmpMins = sorted.reduce((a,e)=>{ if(!e.startTime||!e.endTime) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let mins=(eh*60+em)-(sh*60+sm); if(mins<=0) mins+=24*60; return a+mins; },0);
    const skip3 = ["non-working","per-diem","working-day"];
    const totalEmpMins2 = sorted.reduce((a,e)=>{ if(!e.startTime||!e.endTime||skip3.includes(e.dayType)) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let mins=(eh*60+em)-(sh*60+sm); if(mins<=0) mins+=24*60; return a+mins; },0);
    const empHourlyPay2 = sorted.reduce((a,e)=>{ if(!e.startTime||!e.endTime||skip3.includes(e.dayType)) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let mins=(eh*60+em)-(sh*60+sm); if(mins<=0) mins+=24*60; return a+(mins/60)*(Number(e.hourlyOverride)||parseFloat(cfg?.hourly)||0); },0);
    const empTripPay = sorted.reduce((a,e)=>a+(parseFloat(e.numTrips)||0)*(parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0)),0);
    const empDayPay2 = sorted.reduce((a,e)=>a+(parseFloat(e.numDays)||0)*(parseFloat(e.dayRateOverride)||parseFloat(cfg?.dayRate)||parseFloat(cfg?.workDay)||0),0);
    const empNwPay2 = sorted.reduce((a,e)=>a+(parseFloat(e.numNwDays)||0)*(parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0)),0)+sorted.filter(e=>e.dayType==="non-working").length*(parseFloat(cfg?.nonWorkDay)||0);
    const empPdPay2 = sorted.reduce((a,e)=>a+(parseFloat(e.numPerDiem)||0)*(parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0)),0)+sorted.filter(e=>e.dayType==="per-diem").length*(parseFloat(cfg?.perDiem)||0);
    const empExpPay2 = sorted.reduce((a,e)=>a+(parseFloat(e.expenseAmt)||0),0);
    const empVendorPay2 = sorted.reduce((a,e)=>e.entryType==="vendor-charge"?a+vendorTotal(e):a,0);
    const empTotal = empHourlyPay2 + empTripPay + empDayPay2 + empNwPay2 + empPdPay2 + empExpPay2 + empVendorPay2;
    const dayRows=sorted.map(e=>{
      const h=calcH(e.startTime,e.endTime);
      const mins = (() => { if(!e.startTime||!e.endTime) return 0; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return m; })();
      const overnight=e.endTime&&e.startTime&&(parseInt(e.endTime.split(":")[0])*60+parseInt(e.endTime.split(":")[1]))<(parseInt(e.startTime.split(":")[0])*60+parseInt(e.startTime.split(":")[1]));
      const isNW = e.dayType==="non-working";
      const dayTag = cfg?.type==="daily" ? `<span style="margin-left:6px;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;background:${isNW?"#fff3e0":"#e8f5e9"};color:${isNW?"#b45309":"#16a34a"}">${isNW?"NW":"W"}</span>` : "";
      // Pay per day calculation
      let dayPay = null;
      let dayPayStr = "—";
      if(cfg) {
        if(cfg.type==="hourly") {
          dayPay = (mins/60)*(cfg.hourly||0);
          dayPayStr = `<span style="color:#16a34a;font-weight:700">${sym}${dayPay.toFixed(2)}</span><span style="font-size:9px;color:#888"> (${mins}min)</span>`;
        } else {
          const baseDay = isNW ? (cfg.nonWorkDay||0) : (cfg.workDay||0);
          const diem = cfg.perDiem||0;
          dayPay = baseDay + diem;
          dayPayStr = `<span style="color:#16a34a;font-weight:700">${sym}${dayPay.toFixed(2)}</span>${diem>0?`<span style="font-size:9px;color:#888"> (+${sym}${diem} diem)</span>`:""}`;
        }
      }
      const tripExtra = (parseFloat(e.numTrips)||0)>0 ? `<div style="font-size:9px;color:#f59e0b;font-weight:700">${parseFloat(e.numTrips)} trips × ${(parseFloat(e.tripRateOverride)||(cfg?.tripRate||0)).toFixed(0)} = ${((parseFloat(e.numTrips)||0)*(parseFloat(e.tripRateOverride)||(cfg?.tripRate||0))).toFixed(2)}</div>` : "";
      const dayExtra = (parseFloat(e.numDays)||0)>0 ? `<div style="font-size:9px;color:#f59e0b;font-weight:700">${parseFloat(e.numDays)} days × ${(parseFloat(e.dayRateOverride)||(cfg?.dayRate||0)).toFixed(0)} = ${((parseFloat(e.numDays)||0)*(parseFloat(e.dayRateOverride)||(cfg?.dayRate||0))).toFixed(2)}</div>` : "";
      return `<tr><td style="white-space:nowrap;font-weight:600">${fmtDate(e.date)}${dayTag}</td><td style="white-space:nowrap;color:#555">${e.startTime||"—"} → ${e.endTime||"—"}${overnight?" <em style='color:#b45309;font-size:9px'>(overnight)</em>":""}</td><td style="text-align:right;font-weight:700;color:#d42b2b;white-space:nowrap">${fmtH(h)}</td><td style="text-align:right;white-space:nowrap">${dayPayStr}${tripExtra}${dayExtra}</td><td style="color:#444;font-size:11px">${e.notes||""}</td></tr>`;
    }).join("");
    const expRows=empExpenses.length?empExpenses.map(ex=>`<tr><td>${fmtDate(ex.date)}</td><td>${ex.type}</td><td style="text-align:right">${ex.currency} ${parseFloat(ex.amount||0).toFixed(2)}</td><td style="color:${ex.status==="approved"?"#16a34a":ex.status==="rejected"?"#dc2626":"#b45309"};font-weight:600">${ex.status||"pending"}</td><td style="font-size:11px;color:#555">${ex.description||""}</td></tr>`).join(""):"";
    return `<div style="page-break-after:always;padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #000">
        <div><div style="font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:4px">DIAMOND BACK EXPRESS INC.</div><div style="font-size:18px;font-weight:700">${emp.name}</div><div style="font-size:11px;color:#666;margin-top:3px">${emp.email} · ${emp.phone}</div></div>
        <div style="text-align:right"><div style="font-size:13px;font-weight:700;color:#d42b2b">${event}</div><div style="font-size:10px;color:#999;margin-top:2px">Generated: ${new Date().toLocaleDateString("en-CA",{month:"long",day:"numeric",year:"numeric"})}</div></div>
      </div>
      <div style="display:flex;gap:20px;margin-bottom:20px;padding:12px 16px;background:#f5f5f5;border-radius:6px">
        <div><div style="font-size:22px;font-weight:700;color:#d42b2b">${fmtH(totalEmpHours)}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Total Hours</div></div>
        <div><div style="font-size:22px;font-weight:700">${sorted.length}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Days Worked</div></div>
        ${empTotal>0 ? `<div><div style="font-size:22px;font-weight:700;color:#16a34a">${cur} ${empTotal.toFixed(2)}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Gross Pay / Salaire brut</div></div>` : ""}  ${totalEmpMins>0?`<div><div style="font-size:14px;font-weight:700;color:#666">${totalEmpMins} min</div><div style="font-size:9px;text-transform:uppercase;color:#888">Exact Minutes</div></div>`:""}
        ${totalEmpMins2>0?`<div><div style="font-size:14px;font-weight:700;color:#666">${totalEmpMins2} min</div><div style="font-size:9px;text-transform:uppercase;color:#888">Exact Minutes</div></div>`:""}
        ${empExpenses.length?`<div><div style="font-size:22px;font-weight:700;color:#b45309">${empExpenses.length}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Expenses</div></div>`:""}
      </div>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ddd">Daily Hours / Heures quotidiennes</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead><tr><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Date</th><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Time / Heure</th><th style="text-align:right;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Hours / Heures</th><th style="text-align:right;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#16a34a;background:#f0f0f0;border-bottom:1px solid #ddd">Pay / Paie (${cur})</th><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Notes</th></tr></thead>
        <tbody>${dayRows}</tbody>
        <tfoot><tr style="border-top:2px solid #000"><td colspan="2" style="padding:8px;font-weight:700">TOTAL</td><td style="padding:8px;text-align:right;font-weight:700;color:#d42b2b;font-size:14px">${fmtH(totalEmpHours)}</td><td style="padding:8px;text-align:right;font-weight:700;color:#16a34a;font-size:14px">${cfg?`${cur} ${empTotal.toFixed(2)}`:"—"}</td><td></td></tr></tfoot>
      </table>
      ${empExpenses.length?`<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ddd">Expenses / Dépenses</div><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Date</th><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Type</th><th style="text-align:right;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Amount</th><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Status</th><th style="text-align:left;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Description</th></tr></thead><tbody>${expRows}</tbody></table>`:""}
${empTotal>0?`<div style="margin-bottom:24px;padding:12px 16px;background:#f0fff4;border:1px solid #86efac;border-radius:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#16a34a;margin-bottom:8px">Pay Summary / Résumé de paie</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          ${empHourlyPay2>0?`<tr><td style="padding:4px 0;color:#555">Hours / Heures (${(totalEmpMins2/60).toFixed(2)}h):</td><td style="text-align:right;font-weight:600">${sym}${empHourlyPay2.toFixed(2)}</td></tr>`:""}
          ${empTripPay>0?`<tr><td style="padding:4px 0;color:#555">Trips / Trajets:</td><td style="text-align:right;font-weight:600;color:#f59e0b">${sym}${empTripPay.toFixed(2)}</td></tr>`:""}
          ${empDayPay2>0?`<tr><td style="padding:4px 0;color:#555">Working days / Jours travaillés:</td><td style="text-align:right;font-weight:600">${sym}${empDayPay2.toFixed(2)}</td></tr>`:""}
          ${empNwPay2>0?`<tr><td style="padding:4px 0;color:#555">Non-working days / Jours non-travaillés:</td><td style="text-align:right;font-weight:600;color:#f97316">${sym}${empNwPay2.toFixed(2)}</td></tr>`:""}
          ${empPdPay2>0?`<tr><td style="padding:4px 0;color:#555">Per diem:</td><td style="text-align:right;font-weight:600;color:#0ea5e9">${sym}${empPdPay2.toFixed(2)}</td></tr>`:""}
          ${empExpPay2>0?`<tr><td style="padding:4px 0;color:#555">Expenses / Dépenses:</td><td style="text-align:right;font-weight:600;color:#8b5cf6">${empExpPay2.toFixed(2)}</td></tr>`:""}
          ${empVendorPay2>0?`<tr><td style="padding:4px 0;color:#555">Vendor charges:</td><td style="text-align:right;font-weight:600;color:#8b5cf6">${empVendorPay2.toFixed(2)}</td></tr>`:""}
          <tr style="border-top:1px solid #86efac"><td style="padding:6px 0;font-weight:700">Gross Pay / Salaire brut:</td><td style="text-align:right;font-weight:700;color:#16a34a;font-size:14px">${cur} ${empTotal.toFixed(2)}</td></tr>
        </table>
      </div>`:""}
      <div style="margin-top:40px;display:flex;gap:40px"><div style="flex:1;border-top:1px solid #000;padding-top:6px;font-size:10px;color:#666">Employee Signature</div><div style="flex:1;border-top:1px solid #000;padding-top:6px;font-size:10px;color:#666">Authorized by</div><div style="width:120px;border-top:1px solid #000;padding-top:6px;font-size:10px;color:#666">Date</div></div>
    </div>`;
  }).join("");

  const calcEmpTotal = (emp) => {
    const cfg = emp.payCfg || {};
    const skip = ["non-working","per-diem","working-day"];
    const mins = emp.entries.reduce((a,e)=>{ if(!e.startTime||!e.endTime||skip.includes(e.dayType)) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return a+m; },0);
    const hPay = emp.entries.reduce((a,e)=>{ if(!e.startTime||!e.endTime||skip.includes(e.dayType)) return a; const [sh,sm]=e.startTime.split(":").map(Number); const [eh,em]=e.endTime.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; const r=Number(e.hourlyOverride)||parseFloat(cfg.hourly)||0; return a+(m/60)*r; },0);
    const tPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numTrips)||0)*(parseFloat(e.tripRateOverride)||(parseFloat(cfg.tripRate)||0)),0);
    const dPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numDays)||0)*(parseFloat(e.dayRateOverride)||parseFloat(cfg.dayRate)||parseFloat(cfg.workDay)||0),0);
    const nPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numNwDays)||0)*(parseFloat(e.nwDayRateOverride)||(parseFloat(cfg.nonWorkDay)||0)),0)+emp.entries.filter(e=>e.dayType==="non-working").length*(parseFloat(cfg.nonWorkDay)||0);
    const pPay = emp.entries.reduce((a,e)=>a+(parseFloat(e.numPerDiem)||0)*(parseFloat(e.perDiemRateOverride)||(parseFloat(cfg.perDiem)||0)),0)+emp.entries.filter(e=>e.dayType==="per-diem").length*(parseFloat(cfg.perDiem)||0);
    const ePay = emp.entries.reduce((a,e)=>a+(parseFloat(e.expenseAmt)||0),0);
    const vPay = emp.entries.reduce((a,e)=>e.entryType==="vendor-charge"?a+vendorTotal(e):a,0);
    return { hPay, tPay, dPay, nPay, pPay, ePay, vPay, total: hPay+tPay+dPay+nPay+pPay+ePay+vPay, mins };
  };
  const summaryRows=employees.map(emp=>{
    const h=emp.entries.reduce((a,e)=>["non-working","per-diem","working-day"].includes(e.dayType)?a:a+calcH(e.startTime,e.endTime),0);
    const cfg=emp.payCfg||{};
    const p=calcEmpTotal(emp);
    const sym=cfg.currency==="USD"?"US$":"$";
    const cur=cfg.currency||"CAD";
    const parts=[];
    if(p.hPay>0) { const hasOvr=emp.entries.some(e=>Number(e.hourlyOverride)>0); parts.push(hasOvr?"mixed hourly":sym+(parseFloat(cfg.hourly)||0).toFixed(2)+"/h"); }
    if(p.tPay>0) parts.push(sym+(parseFloat(cfg.tripRate)||0).toFixed(0)+"/trip");
    if(p.dPay>0) parts.push(sym+(parseFloat(cfg.workDay)||0).toFixed(0)+"/day");
    if(p.nPay>0) parts.push(sym+(parseFloat(cfg.nonWorkDay)||0).toFixed(0)+"/NW");
    if(p.pPay>0) parts.push(sym+(parseFloat(cfg.perDiem)||0).toFixed(0)+"/diem");
    if(p.ePay>0) parts.push("exp");
    if(p.vPay>0) parts.push("vendor");
    if(emp.entries[0]?.entryType==="vendor-charge") parts.push("vendor");
    const rateStr=parts.length?parts.join(" · "):"—";
    return `<tr><td style="font-weight:600">${emp.name}</td><td>${emp.email}</td><td>${emp.phone}</td><td style="text-align:center">${emp.days}</td><td style="text-align:right;font-weight:700;color:#d42b2b">${fmtH(h)}</td><td style="text-align:right;color:#666;font-size:10px">${rateStr}</td><td style="text-align:right;font-weight:700;color:#16a34a">${p.total>0?`${cur} ${p.total.toFixed(2)}`:"—"}</td></tr>`;
  }).join("");
  const totalPay=employees.reduce((a,emp)=>{
    return a+calcEmpTotal(emp).total;
  },0);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DBX Timesheets — ${event}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;color:#000;font-size:12px}td{padding:7px 8px;border-bottom:1px solid #eee;vertical-align:top}@media print{button{display:none!important}.no-print{display:none!important}}@page{margin:15mm}</style></head><body>
<div class="no-print" style="padding:12px;background:#f0f0f0;text-align:center">
  <button onclick="window.print()" style="padding:10px 28px;background:#d42b2b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700">🖨 Print / Save as PDF</button>
  <span style="margin-left:16px;font-size:12px;color:#666">${employees.length} employee${employees.length!==1?"s":""} · ${fmtH(totalHours)} total</span>
</div>
<div style="page-break-after:always;padding:20px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #000">
    <div><div style="font-size:20px;font-weight:700">DIAMOND BACK EXPRESS INC.</div><div style="font-size:11px;color:#666;margin-top:3px">4515 Ebenezer Rd Unit 212, Brampton, Ontario, L6P 2K7</div></div>
    <div style="text-align:right"><div style="font-size:16px;font-weight:700;color:#d42b2b">${event}</div><div style="font-size:10px;color:#999;margin-top:2px">Timesheet Summary · Generated: ${new Date().toLocaleDateString("en-CA",{month:"long",day:"numeric",year:"numeric"})}</div></div>
  </div>
  <div style="display:flex;gap:24px;margin-bottom:28px;padding:16px;background:#f5f5f5;border-radius:6px">
    <div><div style="font-size:28px;font-weight:700;color:#d42b2b">${fmtH(totalHours)}</div><div style="font-size:9px;text-transform:uppercase;color:#888;margin-top:2px">Total Hours</div></div>
    <div><div style="font-size:28px;font-weight:700">${employees.length}</div><div style="font-size:9px;text-transform:uppercase;color:#888;margin-top:2px">Employees</div></div>
    <div><div style="font-size:28px;font-weight:700">${entries.length}</div><div style="font-size:9px;text-transform:uppercase;color:#888;margin-top:2px">Day Entries</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#16a34a">CAD ${totalApproved.toFixed(2)}</div><div style="font-size:9px;text-transform:uppercase;color:#888;margin-top:2px">Approved Expenses</div></div>
  </div>
  <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ddd">All Employees / Tous les employés</div>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr><th style="text-align:left;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Name</th><th style="text-align:left;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Email</th><th style="text-align:left;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Phone</th><th style="text-align:center;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Days</th><th style="text-align:right;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Hours</th><th style="text-align:right;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Rate</th><th style="text-align:right;padding:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:#666;background:#f0f0f0;border-bottom:1px solid #ddd">Gross Pay</th></tr></thead>
    <tbody>${summaryRows}</tbody>
    <tfoot><tr style="border-top:2px solid #000"><td colspan="4" style="padding:8px;font-weight:700">TOTAL</td><td style="padding:8px;text-align:right;font-weight:700;color:#d42b2b;font-size:14px">${fmtH(totalHours)}</td><td></td><td style="padding:8px;text-align:right;font-weight:700;color:#16a34a;font-size:14px">${totalPay>0?`$${totalPay.toFixed(2)}`:"—"}</td></tr></tfoot>
  </table>
</div>
${empPages}
</body></html>`;
}

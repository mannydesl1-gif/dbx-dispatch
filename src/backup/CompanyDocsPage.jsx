import { useState, useEffect, useRef } from "react";
import { db, storage } from "./firebase.js";
import { collection, addDoc, getDocs, deleteDoc, doc, orderBy, query } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

const T = {
  red:"#dc2626", black:"#0f0f0f", text:"#f1f5f9", muted:"#94a3b8", dim:"#64748b",
  border:"#1e293b", hover:"#0f172a", card:"#0f172a", surface:"#1e293b", bg:"#020817",
  green:"#22c55e", greenDim:"rgba(34,197,94,0.1)", amber:"#f59e0b", amberDim:"rgba(245,158,11,0.1)",
  redDim:"rgba(220,38,38,0.1)", blue:"#3b82f6", blueDim:"rgba(59,130,246,0.1)",
};

const inp = {
  width:"100%", padding:"9px 12px", borderRadius:6, border:`1px solid ${T.border}`,
  background:T.surface, color:T.text, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box",
};
const lbl = {
  display:"block", fontSize:10, fontWeight:600, letterSpacing:"0.06em",
  textTransform:"uppercase", color:T.muted, marginBottom:5,
};

function Ic({ n, s=14 }) {
  const paths = {
    upload:"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12",
    file:"M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    trash:"M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
    search:"M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z",
    warning:"M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
    download:"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
    x:"M6 18L18 6M6 6l12 12",
    calendar:"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[n]}/>
    </svg>
  );
}

const daysUntilExpiry = (dateStr) => {
  if (!dateStr) return null;
  const diff = new Date(dateStr + "T12:00:00") - new Date();
  return Math.ceil(diff / 86400000);
};

const fmtDate = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-CA", { month:"short", day:"numeric", year:"numeric" }) : "—";

function ExpiryBadge({ date }) {
  const days = daysUntilExpiry(date);
  if (days === null) return null;
  if (days < 0) return (
    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:T.redDim,color:T.red}}>
      EXPIRED {Math.abs(days)}d ago
    </span>
  );
  if (days <= 30) return (
    <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:T.amberDim,color:T.amber}}>
      Expires in {days}d
    </span>
  );
  return (
    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:10,background:T.greenDim,color:T.green}}>
      Valid · {fmtDate(date)}
    </span>
  );
}

export default function CompanyDocsPage() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState(null);

  // Form state
  const [docName, setDocName] = useState("");
  const [docType, setDocType] = useState("");
  const [docExpiry, setDocExpiry] = useState("");
  const [docFile, setDocFile] = useState(null);
  const [docNotes, setDocNotes] = useState("");
  const fileRef = useRef();

  const loadDocs = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "company_docs"), orderBy("uploadedAt", "desc")));
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadDocs(); }, []);

  const expiring = docs.filter(d => {
    const days = daysUntilExpiry(d.expiryDate);
    return days !== null && days <= 30;
  });

  const handleUpload = async () => {
    if (!docName.trim() || !docType.trim() || !docFile) {
      alert("Please fill in document name, type and select a file.");
      return;
    }
    setUploading(true);
    try {
      const path = `company_docs/${Date.now()}_${docFile.name}`;
      const sRef = storageRef(storage, path);
      await uploadBytes(sRef, docFile);
      const url = await getDownloadURL(sRef);
      await addDoc(collection(db, "company_docs"), {
        name: docName.trim(),
        type: docType.trim(),
        expiryDate: docExpiry || null,
        notes: docNotes.trim(),
        fileUrl: url,
        fileName: docFile.name,
        storagePath: path,
        uploadedAt: new Date().toISOString(),
      });
      setDocName(""); setDocType(""); setDocExpiry(""); setDocFile(null); setDocNotes("");
      if (fileRef.current) fileRef.current.value = "";
      setShowForm(false);
      await loadDocs();
    } catch(e) { console.error(e); alert("Upload failed. Please try again."); }
    setUploading(false);
  };

  const handleDelete = async (d) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    setDeleting(d.id);
    try {
      if (d.storagePath) {
        try { await deleteObject(storageRef(storage, d.storagePath)); } catch(e) {}
      }
      await deleteDoc(doc(db, "company_docs", d.id));
      setDocs(prev => prev.filter(x => x.id !== d.id));
    } catch(e) { console.error(e); alert("Error deleting document."); }
    setDeleting(null);
  };

  const filtered = docs.filter(d =>
    !search ||
    d.name?.toLowerCase().includes(search.toLowerCase()) ||
    d.type?.toLowerCase().includes(search.toLowerCase()) ||
    d.notes?.toLowerCase().includes(search.toLowerCase())
  );

  const bS = { padding:"8px 14px", borderRadius:7, border:`1px solid ${T.border}`, background:"transparent", color:T.muted, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:6 };
  const bP = { ...bS, background:T.redDim, border:`1px solid ${T.red}`, color:T.red };
  const bG = { ...bS, background:T.greenDim, border:`1px solid ${T.green}`, color:T.green };

  return (
    <div style={{ padding:20 }}>

      {/* Upload Form */}
      {showForm && (
        <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:12, padding:20, marginBottom:20 }}>
          <div style={{ fontSize:14, fontWeight:700, color:T.text, marginBottom:16 }}>New Document</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
            <div>
              <label style={lbl}>Document Name *</label>
              <input style={inp} value={docName} onChange={e => setDocName(e.target.value)} placeholder="e.g. CVOR Certificate"/>
            </div>
            <div>
              <label style={lbl}>Document Type *</label>
              <input style={inp} value={docType} onChange={e => setDocType(e.target.value)} placeholder="e.g. Permit, Certificate, Insurance"/>
            </div>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={lbl}>Expiry Date <span style={{ color:T.dim, fontWeight:400, textTransform:"none" }}>(optional)</span></label>
            <input type="date" style={{...inp, maxWidth:220}} value={docExpiry} onChange={e => setDocExpiry(e.target.value)}/>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={lbl}>File *</label>
            <div
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor=T.green; e.currentTarget.style.background="rgba(34,197,94,0.07)"; }}
              onDragLeave={e => { e.currentTarget.style.borderColor=T.border; e.currentTarget.style.background="transparent"; }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor=T.border; e.currentTarget.style.background="transparent"; const f=e.dataTransfer.files[0]; if(f) setDocFile(f); }}
              onClick={() => fileRef.current.click()}
              style={{ border:`2px dashed ${docFile?T.green:T.border}`, borderRadius:8, padding:"24px 16px", textAlign:"center", cursor:"pointer", transition:"all 0.15s", background:docFile?"rgba(34,197,94,0.05)":"transparent" }}>
              <input ref={fileRef} type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
                onChange={e => setDocFile(e.target.files[0]||null)} style={{ display:"none" }}/>
              {docFile
                ? <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                    <div style={{ color:T.green }}><Ic n="file" s={18}/></div>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:T.green }}>{docFile.name}</div>
                      <div style={{ fontSize:11, color:T.dim, marginTop:2 }}>{(docFile.size/1024/1024).toFixed(2)} MB · Click to change</div>
                    </div>
                  </div>
                : <div>
                    <div style={{ color:T.muted, marginBottom:8 }}><Ic n="upload" s={24}/></div>
                    <div style={{ fontSize:13, fontWeight:600, color:T.muted }}>Drop file here or click to browse</div>
                    <div style={{ fontSize:11, color:T.dim, marginTop:4 }}>PDF, image, Word, Excel — max 10 MB</div>
                  </div>
              }
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={lbl}>Notes <span style={{ color:T.dim, fontWeight:400, textTransform:"none" }}>(optional)</span></label>
            <textarea style={{ ...inp, resize:"none", minHeight:60, lineHeight:1.6 }}
              value={docNotes} onChange={e => setDocNotes(e.target.value)}
              placeholder="Any additional info about this document..."/>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={handleUpload} disabled={uploading} style={{ ...bG, padding:"10px 20px", fontSize:13 }}>
              <Ic n="upload" s={13}/> {uploading ? "Uploading..." : "Save"}
            </button>
            <button onClick={() => setShowForm(false)} style={{ ...bS, padding:"10px 16px" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Expiry warnings banner */}
      {expiring.length > 0 && (
        <div style={{ marginBottom:20, padding:"14px 16px", background:T.amberDim, border:`1px solid ${T.amber}`, borderRadius:10, display:"flex", alignItems:"flex-start", gap:12 }}>
          <div style={{ color:T.amber, flexShrink:0, marginTop:1 }}><Ic n="warning" s={16}/></div>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:T.amber, marginBottom:4 }}>
              {expiring.length} document{expiring.length > 1 ? "s" : ""} expiring soon
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
              {expiring.map(d => (
                <div key={d.id} style={{ fontSize:12, color:T.text }}>
                  <span style={{ fontWeight:600 }}>{d.name}</span>
                  <span style={{ color:T.muted }}> · {d.type} · </span>
                  <ExpiryBadge date={d.expiryDate}/>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:22, fontWeight:700, color:T.text, marginBottom:2 }}>Company Documents</div>
        <div style={{ fontSize:13, color:T.muted, marginBottom:12 }}>Permits, certificates, and company files</div>
        <button style={bG} onClick={() => setShowForm(true)}>
          <Ic n="upload" s={13}/> Upload Document
        </button>
      </div>

      {/* Search */}
      <div style={{ marginBottom:16, display:"flex", alignItems:"center", gap:8, background:T.surface, border:`1px solid ${T.border}`, borderRadius:7, padding:"8px 12px", maxWidth:360 }}>
        <div style={{ color:T.muted }}><Ic n="search" s={13}/></div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search documents..."
          style={{ background:"transparent", border:"none", color:T.text, fontSize:12, outline:"none", width:"100%", fontFamily:"inherit" }}/>
        {search && <button onClick={() => setSearch("")} style={{ background:"none", border:"none", color:T.muted, cursor:"pointer", padding:0, display:"flex" }}><Ic n="x" s={12}/></button>}
      </div>

      {/* Stats */}
      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        {[
          { label:"Total Documents", value:docs.length, color:T.text },
          { label:"Expiring Soon", value:expiring.filter(d => daysUntilExpiry(d.expiryDate) >= 0).length, color:T.amber },
          { label:"Expired", value:docs.filter(d => { const x=daysUntilExpiry(d.expiryDate); return x !== null && x < 0; }).length, color:T.red },
        ].map(s => (
          <div key={s.label} style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:"12px 16px", minWidth:120 }}>
            <div style={{ fontSize:10, color:T.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:24, fontWeight:700, color:s.color, fontFamily:"'IBM Plex Mono',monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Document list */}
      {loading && <div style={{ color:T.muted, fontSize:14, padding:"20px 0" }}>Loading...</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ color:T.muted, fontSize:14, padding:"40px 0", textAlign:"center" }}>
          {search ? "No documents match your search." : "No documents uploaded yet. Click 'Upload Document' to get started."}
        </div>
      )}

      {!loading && filtered.map(d => {
        const days = daysUntilExpiry(d.expiryDate);
        const isExpired = days !== null && days < 0;
        const isExpiring = days !== null && days >= 0 && days <= 30;
        const borderColor = isExpired ? T.red : isExpiring ? T.amber : T.border;

        return (
          <div key={d.id} style={{ background:T.card, border:`1px solid ${borderColor}`, borderRadius:10, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:12, flex:1, minWidth:0 }}>
              <div style={{ width:36, height:36, borderRadius:8, background:T.surface, display:"flex", alignItems:"center", justifyContent:"center", color:T.muted, flexShrink:0 }}>
                <Ic n="file" s={16}/>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:T.text, marginBottom:3 }}>{d.name}</div>
                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:4 }}>
                  <span style={{ fontSize:11, color:T.muted, background:T.surface, padding:"2px 8px", borderRadius:6 }}>{d.type}</span>
                  {d.expiryDate && <ExpiryBadge date={d.expiryDate}/>}
                  {!d.expiryDate && <span style={{ fontSize:10, color:T.dim }}>No expiry</span>}
                </div>
                {d.notes && <div style={{ fontSize:12, color:T.muted, marginTop:4, lineHeight:1.5 }}>{d.notes}</div>}
                <div style={{ fontSize:10, color:T.dim, marginTop:4 }}>
                  {d.fileName} · Uploaded {fmtDate(d.uploadedAt?.slice(0,10))}
                </div>
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:6, flexShrink:0 }}>
              <a href={d.fileUrl} target="_blank" rel="noreferrer"
                style={{ ...bS, textDecoration:"none", padding:"6px 12px", fontSize:11 }}>
                <Ic n="download" s={12}/> View
              </a>
              <button onClick={() => handleDelete(d)} disabled={deleting === d.id}
                style={{ ...bP, padding:"6px 12px", fontSize:11 }}>
                <Ic n="trash" s={12}/> {deleting === d.id ? "..." : "Delete"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

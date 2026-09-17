import { useState, useEffect } from "react";
import { db } from "./firebase.js";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, orderBy, query } from "firebase/firestore";

// ── Theme (matches App.jsx / QuotesPage dark theme) ──
const T = {
  bg:"#0f172a", card:"#1e293b", border:"#334155", text:"#f1f5f9",
  muted:"#94a3b8", dim:"#475569", red:"#dc2626", redDim:"rgba(220,38,38,0.1)",
  hover:"rgba(255,255,255,0.04)", surface:"rgba(255,255,255,0.03)",
  green:"#22c55e", blue:"#0ea5e9",
};
const sIn = { background:T.surface, border:`1px solid ${T.border}`, borderRadius:6, color:T.text, fontSize:12, padding:"7px 10px", fontFamily:"inherit", width:"100%", boxSizing:"border-box", outline:"none" };
const sBtn = { padding:"6px 14px", borderRadius:6, border:`1px solid ${T.border}`, background:"transparent", color:T.muted, fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"inherit" };
const bRed = { ...sBtn, background:`linear-gradient(135deg,${T.red},#b91c1c)`, border:"none", color:"#fff" };
const sLbl = { fontSize:10, fontWeight:600, color:T.muted, textTransform:"uppercase", letterSpacing:"0.05em", display:"block", marginBottom:4 };

// Divisions mirror QuotesPage / client.config — keep the header identical to
// quotes so letters read as the same company. Both shown side by side in print.
const DIVISIONS = [
  { id:"ca", name:"Diamond Back Express Canada", short:"DBX Canada", addr:"4515 Ebenezer Rd, Unit 212\nBrampton, Ontario L6P 2K7\nCanada", phone:"905-409-0278" },
  { id:"us", name:"Diamond Back Express LLC", short:"DBX USA", addr:"Suite 400-K-175\n1110 Brickell Ave\nMiami, FL 33131\nUSA", phone:"" },
];
const LOGO_URL = "https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410";
const SIGNERS = [
  { name:"Manuel Deslauriers", title:"Owner / Operator" },
  { name:"Carl Carter",        title:"President" },
  { name:"Chris St-Germain",   title:"" },
];

// Date helper — matches the app's fd() display style (e.g. "Aug 18, 2026").
const fd = d => { if(!d) return ""; const dt = new Date(d + "T00:00:00"); return isNaN(dt) ? d : dt.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); };
const todayIso = () => new Date().toLocaleDateString("en-CA");
const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const BLANK = () => ({
  title:"", date:todayIso(), signerName:"", signerTitle:"",
  recipient:"", subject:"", body:"",
});

export default function LettersPage() {
  const [letters, setLetters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState(null); // null = list view; "new" or id = editor
  const [fm, setFm] = useState(BLANK());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null); // {ok:bool, text:string}
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      let snap;
      try { snap = await getDocs(query(collection(db,"letters"), orderBy("createdAt","desc"))); }
      catch { snap = await getDocs(collection(db,"letters")); }
      setLetters(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    } catch(e) { console.error("letters load failed:", e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setFm(BLANK()); setEditId("new"); };
  const openLetter = l => { setFm({ ...BLANK(), ...l }); setEditId(l.id); };
  const backToList = () => { setEditId(null); load(); };

  // On signer pick, autofill the title (still editable after).
  const pickSigner = name => {
    const s = SIGNERS.find(x => x.name === name);
    setFm(p => ({ ...p, signerName:name, signerTitle: s ? s.title : p.signerTitle }));
  };

  const save = async () => {
    if(saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const data = { ...fm, updatedAt: Date.now() };
      if(editId && editId !== "new") { await updateDoc(doc(db,"letters",editId), data); }
      else { data.createdAt = Date.now(); const ref = await addDoc(collection(db,"letters"), data); setEditId(ref.id); }
      setSaveMsg({ ok:true, text:"Saved ✓  You can safely go back — it's in the list." });
    } catch(e) {
      console.error("save letter failed:", e);
      const perm = /permission|insufficient/i.test(e?.message||"");
      setSaveMsg({ ok:false, text: perm
        ? "Save blocked by Firestore rules — the 'letters' collection needs a security rule. Your text is still here; copy it out before leaving."
        : `Couldn't save (${e?.code||e?.message||"unknown error"}). Your text is still here — copy it out before leaving.` });
    }
    setSaving(false);
  };

  const remove = async id => {
    if(!window.confirm("Delete this letter? This can't be undone.")) return;
    try { await deleteDoc(doc(db,"letters",id)); setLetters(ls => ls.filter(l => l.id !== id)); }
    catch(e) { console.error("delete letter failed:", e); }
  };

  // Build the print HTML — header matches the quote PDF (logo left, both
  // addresses side by side, red rule under). Body is plain text; blank lines
  // become paragraph breaks.
  const buildHtml = f => {
    const bodyHtml = esc(f.body).split(/\n{2,}/).map(p =>
      `<p style="margin:0 0 11px;white-space:pre-wrap">${p.replace(/\n/g,"<br>")}</p>`).join("");
    const addrCols = DIVISIONS.map(d =>
      `<div class="addr-col"><div class="div-name">${esc(d.name)}</div>${esc(d.addr).replace(/\n/g,"<br>")}${d.phone?`<br>${esc(d.phone)}`:""}</div>`
    ).join("");
    const sig = f.signerName ? `<div class="sig">
        <div style="height:38px"></div>
        <div style="border-top:1px solid #333;width:230px;padding-top:4px">
          <strong>${esc(f.signerName)}</strong>${f.signerTitle?`<br><span style="color:#555;font-size:10px">${esc(f.signerTitle)}</span>`:""}
        </div>
      </div>` : "";

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${esc(f.title||"Letter")}</title>
    <style>
      body{font-family:Arial,sans-serif;margin:0;padding:26px 34px;color:#111;font-size:12px;line-height:1.5}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;padding-bottom:12px;border-bottom:3px solid #dc2626}
      .header img{height:46px;object-fit:contain}
      .addr-block{display:flex;gap:26px;text-align:right;font-size:9.5px;color:#555;line-height:1.4}
      .addr-col{white-space:normal}
      .div-name{font-weight:700;color:#111;font-size:10px;margin-bottom:2px}
      .meta{margin-bottom:18px}
      .meta .date{color:#555;margin-bottom:14px}
      .recipient{white-space:pre-wrap;margin-bottom:16px;font-size:12px}
      .subject{font-weight:700;margin-bottom:14px}
      .sig{margin-top:34px}
      @media print{ .no-print{display:none} body{padding:0} @page{margin:25mm} }
    </style></head><body>
    <div class="header">
      <img src="${LOGO_URL}"/>
      <div class="addr-block">${addrCols}</div>
    </div>
    <div class="meta">
      ${f.date?`<div class="date">${esc(fd(f.date))}</div>`:""}
      ${f.recipient?`<div class="recipient">${esc(f.recipient).replace(/\n/g,"<br>")}</div>`:""}
      ${f.subject?`<div class="subject">Re: ${esc(f.subject)}</div>`:""}
    </div>
    <div class="body">${bodyHtml||"<p style='color:#999'>(no body text)</p>"}</div>
    ${sig}
    <div class="no-print" style="margin-top:30px;text-align:center">
      <button onclick="window.print()" style="padding:12px 28px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700">Print / Save as PDF</button>
    </div>
    </body></html>`;
  };

  const printLetter = f => {
    const blob = new Blob([buildHtml(f)],{type:"text/html"});
    const url = URL.createObjectURL(blob);
    window.open(url,"_blank");
    URL.revokeObjectURL(url);
  };

  // ── Editor view ──
  if(editId !== null) {
    return <div style={{ padding:20, maxWidth:760, margin:"0 auto" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:18 }}>
        <button style={sBtn} onClick={backToList}>← Back</button>
        <h2 style={{ margin:0, fontSize:18, color:T.text }}>{editId==="new"?"New Letter":"Edit Letter"}</h2>
      </div>

      <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:18 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
          <div>
            <label style={sLbl}>Letter Title <span style={{color:T.dim}}>(internal — for your list only)</span></label>
            <input style={sIn} value={fm.title} placeholder="e.g. Employment confirmation — J. Smith"
              onChange={e => setFm(p => ({ ...p, title:e.target.value }))} />
          </div>
          <div>
            <label style={sLbl}>Date <span style={{color:T.dim}}>(optional)</span></label>
            <input type="date" style={sIn} value={fm.date}
              onChange={e => setFm(p => ({ ...p, date:e.target.value }))} />
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <label style={sLbl}>Recipient <span style={{color:T.dim}}>(optional — name & address, one per line)</span></label>
          <textarea style={{ ...sIn, minHeight:56, resize:"vertical" }} value={fm.recipient}
            placeholder={"John Smith\n123 Example St\nToronto, ON"}
            onChange={e => setFm(p => ({ ...p, recipient:e.target.value }))} />
        </div>

        <div style={{ marginBottom:12 }}>
          <label style={sLbl}>Subject <span style={{color:T.dim}}>(optional — prints as "Re: …")</span></label>
          <input style={sIn} value={fm.subject} placeholder="e.g. Confirmation of Employment"
            onChange={e => setFm(p => ({ ...p, subject:e.target.value }))} />
        </div>

        <div style={{ marginBottom:12 }}>
          <label style={sLbl}>Body</label>
          <textarea style={{ ...sIn, minHeight:220, resize:"vertical", lineHeight:1.5 }} value={fm.body}
            placeholder={"Dear …,\n\nType your letter here. Leave a blank line between paragraphs."}
            onChange={e => setFm(p => ({ ...p, body:e.target.value }))} />
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
          <div>
            <label style={sLbl}>Signature — Name <span style={{color:T.dim}}>(optional)</span></label>
            <input list="letter-signers" style={sIn} value={fm.signerName} placeholder="Pick or type a name"
              onChange={e => pickSigner(e.target.value)} />
            <datalist id="letter-signers">{SIGNERS.map(s => <option key={s.name} value={s.name} />)}</datalist>
          </div>
          <div>
            <label style={sLbl}>Signature — Title <span style={{color:T.dim}}>(optional)</span></label>
            <input style={sIn} value={fm.signerTitle} placeholder="e.g. Owner / Operator"
              onChange={e => setFm(p => ({ ...p, signerTitle:e.target.value }))} />
          </div>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button style={bRed} disabled={saving} onClick={save}>{saving?"Saving…":(editId==="new"?"Save Letter":"Save Changes")}</button>
          <button style={sBtn} onClick={() => printLetter(fm)}>Print / Save as PDF</button>
        </div>
        {saveMsg && <div style={{ marginTop:12, padding:"9px 12px", borderRadius:6, fontSize:12, lineHeight:1.5,
          background: saveMsg.ok ? "rgba(34,197,94,0.12)" : "rgba(220,38,38,0.12)",
          color: saveMsg.ok ? T.green : T.red,
          border: `1px solid ${saveMsg.ok ? "rgba(34,197,94,0.4)" : "rgba(220,38,38,0.4)"}` }}>
          {saveMsg.text}
        </div>}
      </div>
    </div>;
  }

  // ── List view ──
  const filtered = letters.filter(l => {
    if(!search.trim()) return true;
    const s = search.toLowerCase();
    return [l.title, l.subject, l.recipient, l.body].some(v => (v||"").toLowerCase().includes(s));
  });

  return <div style={{ padding:20, maxWidth:900, margin:"0 auto" }}>
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18, flexWrap:"wrap", gap:10 }}>
      <h2 style={{ margin:0, fontSize:18, color:T.text }}>Company Letters</h2>
      <button style={bRed} onClick={startNew}>+ New Letter</button>
    </div>

    <input style={{ ...sIn, marginBottom:14 }} value={search} placeholder="Search letters…"
      onChange={e => setSearch(e.target.value)} />

    {loading ? <div style={{ padding:20, color:T.muted, fontSize:13 }}>Loading…</div>
      : filtered.length === 0 ? <div style={{ padding:30, textAlign:"center", color:T.muted, fontSize:13, background:T.card, border:`1px solid ${T.border}`, borderRadius:10 }}>
          {letters.length === 0 ? "No letters yet. Click “New Letter” to create your first." : "No letters match your search."}
        </div>
      : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {filtered.map(l => <div key={l.id} style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:T.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                {l.title || l.subject || "(untitled letter)"}
              </div>
              <div style={{ fontSize:11, color:T.muted, marginTop:2 }}>
                {l.date ? fd(l.date) : "no date"}
                {l.recipient ? ` · to ${l.recipient.split("\n")[0]}` : ""}
                {l.signerName ? ` · ${l.signerName}` : ""}
              </div>
            </div>
            <button style={sBtn} onClick={() => printLetter(l)}>Print</button>
            <button style={sBtn} onClick={() => openLetter(l)}>Edit</button>
            <button style={{ ...sBtn, color:T.red, borderColor:"rgba(220,38,38,0.4)" }} onClick={() => remove(l.id)}>Delete</button>
          </div>)}
        </div>}
  </div>;
}

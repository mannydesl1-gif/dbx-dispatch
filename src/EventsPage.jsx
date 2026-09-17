import { useState, useEffect } from "react";
import { db } from "./firebase.js";
import { collection, addDoc, getDocs, updateDoc, doc, orderBy, query } from "firebase/firestore";

// ── Match your dispatch app theme ──
const T = {
  red: "#dc2626", black: "#0f0f0f", text: "#f1f5f9", muted: "#94a3b8", dim: "#64748b",
  border: "#1e293b", hover: "#0f172a", card: "#0f172a", surface: "#1e293b",
  green: "#22c55e", greenDim: "rgba(34,197,94,0.1)",
  redDim: "rgba(220,38,38,0.1)",
};

function Ic({ n, s = 14 }) {
  const paths = {
    plus: "M12 4v16m8-8H4",
    archive: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4",
    restore: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
    calendar: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[n]} />
    </svg>
  );
}

export default function EventsPage() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [focused, setFocused] = useState(false);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "events"), orderBy("createdAt", "desc")));
      setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadEvents(); }, []);

  const addEvent = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const ref = await addDoc(collection(db, "events"), {
        name: newName.trim(),
        active: true,
        createdAt: new Date().toISOString(),
      });
      setEvents(prev => [{ id: ref.id, name: newName.trim(), active: true, createdAt: new Date().toISOString() }, ...prev]);
      setNewName("");
    } catch (e) { console.error(e); }
    setAdding(false);
  };

  const toggleActive = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { active: !event.active });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, active: !e.active } : e));
    } catch (e) { console.error(e); }
  };

  // Lock an event: freezes all its timesheet entries/expenses so employees can no
  // longer edit or delete them in the employee app. Stores locked + lockedAt on the
  // event doc; the employee app reads this live and switches to read-only.
  const toggleLocked = async (event) => {
    const willLock = !event.locked;
    if (willLock && !window.confirm(`Lock "${event.name}"? Employees will no longer be able to edit or delete their entries or expenses for this event. You can unlock it again anytime.`)) return;
    try {
      const patch = willLock ? { locked: true, lockedAt: new Date().toISOString() } : { locked: false, lockedAt: null };
      await updateDoc(doc(db, "events", event.id), patch);
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, ...patch } : e));
    } catch (e) { console.error(e); }
  };

  const toggleNwDays = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowNwDays: !event.allowNwDays });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowNwDays: !e.allowNwDays } : e));
    } catch (e) { console.error(e); }
  };

  const toggleTravelDays = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowTravelDays: !event.allowTravelDays });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowTravelDays: !e.allowTravelDays } : e));
    } catch (e) { console.error(e); }
  };

  const toggleDaily = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowDaily: !event.allowDaily });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowDaily: !e.allowDaily } : e));
    } catch (e) { console.error(e); }
  };

  const toggleTrips = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowTrips: !event.allowTrips });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowTrips: !e.allowTrips } : e));
    } catch (e) { console.error(e); }
  };

  const toggleExpenses = async (event) => {
    try {
      const current = event.allowExpenses !== false;
      await updateDoc(doc(db, "events", event.id), { allowExpenses: !current });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowExpenses: !current } : e));
    } catch (e) { console.error(e); }
  };

  const togglePerDiem = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowPerDiem: !event.allowPerDiem });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowPerDiem: !e.allowPerDiem } : e));
    } catch (e) { console.error(e); }
  };

  const toggleHours = async (event) => {
    try {
      // default to ON if undefined
      const current = event.allowHours !== false;
      await updateDoc(doc(db, "events", event.id), { allowHours: !current });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowHours: !current } : e));
    } catch (e) { console.error(e); }
  };

  // ── Sub-events (optional) ──────────────────────────────────────────────
  // A simple named list stored on the event (event.subEvents: string[]).
  // Optional and purely additive — used later to group entries (e.g.
  // "May Concert" for Evenko, or "Week 32" for Daily Operations).
  const [subInput, setSubInput] = useState({}); // { [eventId]: "typing..." }

  const addSubEvent = async (event) => {
    const name = (subInput[event.id] || "").trim();
    if (!name) return;
    const list = Array.isArray(event.subEvents) ? event.subEvents : [];
    if (list.includes(name)) { setSubInput(p => ({ ...p, [event.id]: "" })); return; }
    const next = [...list, name];
    try {
      await updateDoc(doc(db, "events", event.id), { subEvents: next });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, subEvents: next } : e));
      setSubInput(p => ({ ...p, [event.id]: "" }));
    } catch (e) { console.error(e); }
  };

  const removeSubEvent = async (event, name) => {
    const next = (event.subEvents || []).filter(s => s !== name);
    const nextArch = (event.archivedSubEvents || []).filter(s => s !== name);
    try {
      await updateDoc(doc(db, "events", event.id), { subEvents: next, archivedSubEvents: nextArch });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, subEvents: next, archivedSubEvents: nextArch } : e));
    } catch (e) { console.error(e); }
  };

  // Archive a sub-event: it leaves the employee picker (so a finished week
  // stops showing) but the main event stays active and all its entries/reports
  // are preserved. Additive — tracked in archivedSubEvents; subEvents is unchanged.
  const archiveSubEvent = async (event, name) => {
    const arch = event.archivedSubEvents || [];
    const next = arch.includes(name) ? arch.filter(s => s !== name) : [...arch, name];
    try {
      await updateDoc(doc(db, "events", event.id), { archivedSubEvents: next });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, archivedSubEvents: next } : e));
    } catch (e) { console.error(e); }
  };

  const activeEvents = events.filter(e => e.active);
  const archivedEvents = events.filter(e => !e.active);

  const bS = { padding: "8px 14px", borderRadius: 7, border: `1px solid ${T.border}`, background: "transparent", color: T.muted, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 };
  const bP = { ...bS, background: T.redDim, border: `1px solid ${T.red}`, color: T.red };

  return (
    <div style={{ padding: 20 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: T.text, marginBottom: 2 }}>Events</div>
        <div style={{ fontSize: 13, color: T.muted }}>Manage events shown in the employee timesheet app</div>
      </div>

      {/* Add new event */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px", marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.muted, marginBottom: 12 }}>New Event</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addEvent()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="e.g. Grand Prix du Canada 2026"
            style={{
              flex: 1, padding: "11px 14px", borderRadius: 7, fontFamily: "inherit",
              fontSize: 14, color: T.text, background: T.surface,
              border: `1.5px solid ${focused ? T.red : T.border}`, outline: "none",
            }}
          />
          <button onClick={addEvent} disabled={adding || !newName.trim()} style={{ ...bP, padding: "11px 18px", opacity: !newName.trim() ? 0.5 : 1 }}>
            <Ic n="plus" s={14} /> {adding ? "Adding..." : "Add"}
          </button>
        </div>
      </div>

      {/* Active events */}
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: T.muted }}>
          Active Events <span style={{ color: T.green, marginLeft: 6 }}>{activeEvents.length}</span>
        </div>
      </div>

      {loading && <div style={{ color: T.muted, fontSize: 14, padding: "20px 0" }}>Loading...</div>}

      {!loading && activeEvents.length === 0 && (
        <div style={{ color: T.muted, fontSize: 14, padding: "16px 0" }}>No active events. Add one above.</div>
      )}

      {activeEvents.map(ev => (
        <div key={ev.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 8 }}>
         <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text, display:"flex", alignItems:"center", gap:8 }}>{ev.name}
                {ev.locked && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: "rgba(220,38,38,0.15)", color: "#dc2626", letterSpacing:"0.04em" }}>🔒 LOCKED</span>}
              </div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
                Added {new Date(ev.createdAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}
                {ev.locked && ev.lockedAt && <span style={{color:"#dc2626",marginLeft:6}}>· locked {new Date(ev.lockedAt).toLocaleDateString("en-CA",{month:"short",day:"numeric"})}</span>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            <button onClick={() => toggleLocked(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.locked ? "#dc2626" : T.border}`,
              background: ev.locked ? "rgba(220,38,38,0.15)" : "transparent",
              color: ev.locked ? "#dc2626" : T.dim,
              fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace:"nowrap"
            }}>
              {ev.locked ? "🔒 Locked" : "🔓 Unlocked"}
            </button>
            <button onClick={() => toggleHours(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowHours !== false ? "#3b82f6" : T.border}`,
              background: ev.allowHours !== false ? "rgba(59,130,246,0.15)" : "transparent",
              color: ev.allowHours !== false ? "#3b82f6" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              ⏱️ Hours {ev.allowHours !== false ? "ON" : "OFF"}
            </button>
            <button onClick={() => toggleDaily(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowDaily ? "#22c55e" : T.border}`,
              background: ev.allowDaily ? "rgba(34,197,94,0.15)" : "transparent",
              color: ev.allowDaily ? "#22c55e" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              📅 Daily {ev.allowDaily ? "ON" : "OFF"}
            </button>
            <button onClick={() => toggleNwDays(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowNwDays ? "#f59e0b" : T.border}`,
              background: ev.allowNwDays ? "rgba(245,158,11,0.15)" : "transparent",
              color: ev.allowNwDays ? "#b45309" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              📅 NW Days {ev.allowNwDays ? "ON" : "OFF"}
            </button>
            <button onClick={() => toggleTravelDays(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowTravelDays ? "#8b5cf6" : T.border}`,
              background: ev.allowTravelDays ? "rgba(139,92,246,0.15)" : "transparent",
              color: ev.allowTravelDays ? "#8b5cf6" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              ✈️ Travel {ev.allowTravelDays ? "ON" : "OFF"}
            </button>
            <button onClick={() => togglePerDiem(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowPerDiem ? "#0ea5e9" : T.border}`,
              background: ev.allowPerDiem ? "rgba(14,165,233,0.15)" : "transparent",
              color: ev.allowPerDiem ? "#0ea5e9" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              🍽️ Per Diem {ev.allowPerDiem ? "ON" : "OFF"}
            </button>
            <button onClick={() => toggleTrips(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowTrips ? "#f59e0b" : T.border}`,
              background: ev.allowTrips ? "rgba(245,158,11,0.15)" : "transparent",
              color: ev.allowTrips ? "#f59e0b" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              🚗 Trips {ev.allowTrips ? "ON" : "OFF"}
            </button>
            <button onClick={() => toggleExpenses(ev)} style={{
              padding: "5px 10px", borderRadius: 7, border: `1px solid ${ev.allowExpenses !== false ? "#8b5cf6" : T.border}`,
              background: ev.allowExpenses !== false ? "rgba(139,92,246,0.15)" : "transparent",
              color: ev.allowExpenses !== false ? "#8b5cf6" : T.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 4
            }}>
              🧾 Expenses {ev.allowExpenses !== false ? "ON" : "OFF"}
            </button>
            </div>
            <button onClick={() => toggleActive(ev)} style={{ ...bS, color: T.dim, fontSize: 11 }} title="Archive this event">
              <Ic n="archive" s={12} /> Archive
            </button>
          </div>
         </div>
         {/* Sub-events (optional) */}
         <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
           <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.dim, marginBottom: 8 }}>
             Sub-events <span style={{ color: T.muted, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— optional (e.g. "May Concert", "Week 32")</span>
           </div>
           {(ev.subEvents || []).length > 0 && (
             <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
               {(ev.subEvents || []).map(s => {
                 const archived = (ev.archivedSubEvents || []).includes(s);
                 return (
                 <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 6, background: archived ? "rgba(100,116,139,0.12)" : "rgba(14,165,233,0.12)", border: `1px solid ${archived ? "rgba(100,116,139,0.4)" : "rgba(14,165,233,0.4)"}`, color: archived ? T.dim : "#0ea5e9", fontSize: 12, fontWeight: 600, opacity: archived ? 0.7 : 1 }}>
                   {archived && <span style={{ fontSize: 10 }}>📦</span>}
                   <span>{s}</span>
                   <span style={{ display: "inline-flex", alignItems: "center", gap: 12, marginLeft: 4, paddingLeft: 10, borderLeft: `1px solid ${archived ? "rgba(100,116,139,0.4)" : "rgba(14,165,233,0.3)"}` }}>
                     <button onClick={() => archiveSubEvent(ev, s)} title={archived ? "Show again in the employee app" : "Hide from the employee app"} style={{ background: "none", border: "none", color: archived ? "#0ea5e9" : T.muted, cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "2px 4px", fontWeight: 700, fontFamily: "inherit" }}>{archived ? "Restore" : "Archive"}</button>
                     <button onClick={() => { if (window.confirm(`Delete sub-event "${s}"?\n\nThis removes it from the list. Entries already tagged with it keep their data.`)) removeSubEvent(ev, s); }} title="Delete this sub-event" style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "2px 4px", fontWeight: 700, fontFamily: "inherit" }}>Delete</button>
                   </span>
                 </span>
                 );
               })}
             </div>
           )}
           {(ev.archivedSubEvents || []).length > 0 && (
             <div style={{ fontSize: 10, color: T.dim, marginBottom: 8 }}>📦 {(ev.archivedSubEvents || []).length} archived — hidden from the employee app, still in reports.</div>
           )}
           <div style={{ display: "flex", gap: 6, maxWidth: 360 }}>
             <input
               value={subInput[ev.id] || ""}
               onChange={e => setSubInput(p => ({ ...p, [ev.id]: e.target.value }))}
               onKeyDown={e => e.key === "Enter" && addSubEvent(ev)}
               placeholder="Add a sub-event…"
               style={{ flex: 1, padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12, color: T.text, background: T.surface, border: `1px solid ${T.border}`, outline: "none" }}
             />
             <button onClick={() => addSubEvent(ev)} disabled={!(subInput[ev.id] || "").trim()} style={{ ...bS, fontSize: 11, opacity: !(subInput[ev.id] || "").trim() ? 0.5 : 1 }}>
               <Ic n="plus" s={12} /> Add
             </button>
           </div>
         </div>
        </div>
      ))}

      {/* Archived events */}
      {archivedEvents.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <button onClick={() => setShowArchived(!showArchived)} style={{ ...bS, marginBottom: 12 }}>
            {showArchived ? "Hide" : "Show"} archived ({archivedEvents.length})
          </button>
          {showArchived && archivedEvents.map(ev => (
            <div key={ev.id} style={{ background: T.hover, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: 0.6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.dim, flexShrink: 0 }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: T.muted }}>{ev.name}</div>
              </div>
              <button onClick={() => toggleActive(ev)} style={{ ...bS, fontSize: 11 }} title="Restore this event">
                <Ic n="restore" s={12} /> Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

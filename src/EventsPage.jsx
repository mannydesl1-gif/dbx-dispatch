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

  const toggleNwDays = async (event) => {
    try {
      await updateDoc(doc(db, "events", event.id), { allowNwDays: !event.allowNwDays });
      setEvents(prev => prev.map(e => e.id === event.id ? { ...e, allowNwDays: !e.allowNwDays } : e));
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
        <div key={ev.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{ev.name}</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
                Added {new Date(ev.createdAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
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

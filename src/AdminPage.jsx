// ═══════════════════════════════════════════════════════════════════════════
// ADMIN PAGE — custom fields, alert recipients, report column picker
//
// Kept in its own file so it can be worked on without touching App.jsx.
//
// DATA MODEL
//   settings/customFields   { fields: [ {...def}, ... ] }
//   settings/alertRecipients{ emails: [ "a@b.com", ... ] }
//   settings/reportColumns  { <scopeKey>: [ "Name", "Phone", ... ] }
//
// A custom field definition:
//   {
//     id:        "cf_1721859... "   unique, also the Firestore key on records
//     label:     "Drug Testing"
//     targets:   ["drivers","trucks"]    where it appears
//     kind:      "text" | "number" | "date" | "expiry"
//     docs:      true|false               allow document upload
//     alert:     true|false               expiry only — include in email digest
//     alertDays: 30                       expiry only — first-notice window
//   }
//
// Values are stored on each record under the field id, e.g. driver.cf_1721859.
// Documents for a field are stored under `${id}Docs` as an array, matching the
// existing acrDocs / hazmatDocs convention.
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect } from "react";
import { db } from "./firebase.js";
import { doc, getDoc, setDoc } from "firebase/firestore";

const T = {
  bg: "#0a0f1a", card: "#111827", border: "#1f2937", hover: "#1a2332",
  text: "#e5e7eb", muted: "#9ca3af", dim: "#6b7280", red: "#dc2626",
};

const sIn = {
  width: "100%", padding: "7px 10px", background: T.bg,
  border: `1px solid ${T.border}`, borderRadius: 6, color: T.text,
  fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box",
};
const bP = {
  padding: "7px 14px", background: T.red, color: "#fff", border: "none",
  borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};
const bS = {
  padding: "7px 14px", background: "transparent", color: T.muted,
  border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 12,
  cursor: "pointer", fontFamily: "inherit",
};

// Where a custom field can be attached.
const TARGETS = [
  { id: "trucks",    label: "Trucks" },
  { id: "trailers",  label: "Trailers" },
  { id: "drivers",   label: "Drivers" },
  { id: "employees", label: "Employees" },
  { id: "suppliers", label: "Suppliers" },
];

const KINDS = [
  { id: "text",   label: "Text",            hint: "Free text — notes, reference numbers" },
  { id: "number", label: "Number",          hint: "Numeric only — value, mileage, count" },
  { id: "date",   label: "Date completed",  hint: "A date that does not expire" },
  { id: "expiry", label: "Expiration date", hint: "A date that expires — can send email alerts" },
];

// Built-in columns available to the report picker, per scope.
const BUILTIN_COLUMNS = {
  people: ["Name","Role","Phone","Email","Licence Class","Pay Configuration","Address",
           "ACR Training","HazMat Training","Criminal Record Check",
           "Background Verification","Code of Conduct","Driver's Licence"],
  equipment: ["Unit #","Plate #","Year","Make","Model","Type","VIN",
              "Safety Exp","Safety Status","Notes"],
};

const Section = ({ title, subtitle, children, right }) => (
  <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: 16, marginBottom: 14 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: subtitle ? 4 : 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.text,
                    textTransform: "uppercase", letterSpacing: "0.05em" }}>{title}</div>
      {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
    </div>
    {subtitle && <div style={{ fontSize: 11, color: T.dim, marginBottom: 12 }}>{subtitle}</div>}
    {children}
  </div>
);

const Field = ({ l, children, hint }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: T.muted,
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{l}</div>
    {children}
    {hint && <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{hint}</div>}
  </div>
);

export default function AdminPage() {
  const [tab, setTab] = useState("fields");

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 4 }}>Admin</div>
      <div style={{ fontSize: 12, color: T.dim, marginBottom: 16 }}>
        Customise dispatch without a code change — add fields, choose report columns,
        and manage who receives expiry alerts.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[["fields","Custom Fields"],["columns","Report Columns"],["alerts","Alert Recipients"]]
          .map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "7px 14px", borderRadius: 6,
            background: tab === k ? T.border : "transparent",
            border: `1px solid ${tab === k ? "#334155" : T.border}`,
            color: tab === k ? T.text : T.muted, fontSize: 12, cursor: "pointer",
            fontFamily: "inherit", fontWeight: tab === k ? 600 : 400,
          }}>{l}</button>
        ))}
      </div>

      {tab === "fields"  && <CustomFields />}
      {tab === "columns" && <ReportColumns />}
      {tab === "alerts"  && <AlertRecipients />}
    </div>
  );
}

// ─── CUSTOM FIELDS ─────────────────────────────────────────────────────────
function CustomFields() {
  const [fields, setFields] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | field id

  const blank = {
    id: "", label: "", targets: [], kind: "text",
    docs: false, alert: false, alertDays: 30,
  };
  const [fm, setFm] = useState(blank);

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "settings", "customFields"));
        setFields(snap.exists() ? (snap.data().fields || []) : []);
      } catch (e) { console.error(e); }
      setLoaded(true);
    })();
  }, []);

  const persist = async (next) => {
    setSaving(true); setMsg("");
    try {
      await setDoc(doc(db, "settings", "customFields"), { fields: next }, { merge: true });
      setFields(next);
      setMsg("Saved");
      setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      console.error(e);
      setMsg("Save failed — check your connection");
    }
    setSaving(false);
  };

  const startNew = () => { setFm({ ...blank }); setEditing("new"); };
  const startEdit = (f) => { setFm({ ...blank, ...f }); setEditing(f.id); };
  const cancel = () => { setEditing(null); setFm(blank); };

  const save = () => {
    const label = fm.label.trim();
    if (!label) { setMsg("Give the field a name"); return; }
    if (!fm.targets.length) { setMsg("Choose at least one place for this field to appear"); return; }

    // Reuse the id when editing so existing record values stay attached.
    const id = editing === "new"
      ? `cf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      : editing;

    const def = {
      id, label,
      targets: fm.targets,
      kind: fm.kind,
      docs: !!fm.docs,
      // alert only means anything for an expiry field
      alert: fm.kind === "expiry" ? !!fm.alert : false,
      alertDays: fm.kind === "expiry" ? (Number(fm.alertDays) || 30) : null,
    };

    const dupe = fields.some(f =>
      f.id !== id && f.label.trim().toLowerCase() === label.toLowerCase() &&
      f.targets.some(t => def.targets.includes(t)));
    if (dupe) { setMsg(`A field named "${label}" already exists in one of those places`); return; }

    const next = editing === "new"
      ? [...fields, def]
      : fields.map(f => (f.id === id ? def : f));
    persist(next);
    cancel();
  };

  const remove = (f) => {
    if (!window.confirm(
      `Delete "${f.label}"?\n\nThe field disappears from forms and reports. Data already ` +
      `entered stays in the database but will no longer be shown or alerted on.`)) return;
    persist(fields.filter(x => x.id !== f.id));
  };

  const toggleTarget = (t) => setFm(p => ({
    ...p,
    targets: p.targets.includes(t) ? p.targets.filter(x => x !== t) : [...p.targets, t],
  }));

  const kindMeta = k => KINDS.find(x => x.id === k) || KINDS[0];
  const targetLabel = t => (TARGETS.find(x => x.id === t) || {}).label || t;

  return (
    <>
      <Section
        title="Custom Fields"
        subtitle="Fields you add appear on the record's edit form, on reports, and — for expiration dates you opt in — in the daily alert email."
        right={editing === null && <button style={bP} onClick={startNew}>+ Add Field</button>}
      >
        {!loaded && <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>}

        {loaded && fields.length === 0 && editing === null && (
          <div style={{ fontSize: 12, color: T.dim, padding: "8px 0" }}>
            No custom fields yet. Add one to start tracking something the built-in fields don't cover.
          </div>
        )}

        {fields.map(f => (
          <div key={f.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{f.label}</div>
              <div style={{ fontSize: 10, color: T.dim, marginTop: 3,
                            display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ padding: "1px 7px", borderRadius: 10, background: T.hover }}>
                  {kindMeta(f.kind).label}
                </span>
                {f.targets.map(t => (
                  <span key={t} style={{ padding: "1px 7px", borderRadius: 10,
                    background: "rgba(59,130,246,0.12)", color: "#3b82f6",
                    border: "1px solid #3b82f6" }}>{targetLabel(t)}</span>
                ))}
                {f.docs && <span style={{ color: T.muted }}>📎 documents</span>}
                {f.kind === "expiry" && (
                  f.alert
                    ? <span style={{ padding: "1px 7px", borderRadius: 10, fontWeight: 700,
                        background: "rgba(34,197,94,0.12)", color: "#22c55e",
                        border: "1px solid #22c55e" }}>✉ alerts on · {f.alertDays}d</span>
                    : <span style={{ padding: "1px 7px", borderRadius: 10,
                        background: "rgba(234,179,8,0.12)", color: "#eab308",
                        border: "1px solid #eab308" }}>no email alerts</span>
                )}
              </div>
            </div>
            <button style={{ ...bS, padding: "4px 10px", fontSize: 11 }}
              disabled={saving} onClick={() => startEdit(f)}>Edit</button>
            <button style={{ ...bS, padding: "4px 10px", fontSize: 11,
              color: "#dc2626", borderColor: "#7f1d1d" }}
              disabled={saving} onClick={() => remove(f)}>Delete</button>
          </div>
        ))}

        {msg && <div style={{ fontSize: 11, marginTop: 8,
          color: msg === "Saved" ? "#22c55e" : "#eab308" }}>{msg}</div>}
      </Section>

      {editing !== null && (
        <Section title={editing === "new" ? "New Field" : "Edit Field"}>
          <Field l="Field name" hint="This is the label shown on forms and as the report column heading.">
            <input style={sIn} value={fm.label} autoFocus
              placeholder="e.g. Drug Testing, Value, Insurance Expiry"
              onChange={e => setFm(p => ({ ...p, label: e.target.value }))} />
          </Field>

          <Field l="Where should it appear?" hint="Tick every record type that should have this field.">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {TARGETS.map(t => {
                const on = fm.targets.includes(t.id);
                return (
                  <button key={t.id} onClick={() => toggleTarget(t.id)} style={{
                    padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                    fontFamily: "inherit", fontWeight: on ? 700 : 400,
                    background: on ? "rgba(59,130,246,0.15)" : "transparent",
                    border: `1px solid ${on ? "#3b82f6" : T.border}`,
                    color: on ? "#3b82f6" : T.muted,
                  }}>{on ? "✓ " : ""}{t.label}</button>
                );
              })}
            </div>
          </Field>

          <Field l="Type of field">
            <div style={{ display: "grid", gap: 6 }}>
              {KINDS.map(k => {
                const on = fm.kind === k.id;
                return (
                  <label key={k.id} style={{
                    display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px",
                    borderRadius: 6, cursor: "pointer",
                    background: on ? T.hover : "transparent",
                    border: `1px solid ${on ? "#334155" : T.border}`,
                  }}>
                    <input type="radio" name="cfkind" checked={on} style={{ accentColor: T.red, marginTop: 2 }}
                      onChange={() => setFm(p => ({ ...p, kind: k.id }))} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{k.label}</div>
                      <div style={{ fontSize: 10, color: T.dim }}>{k.hint}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </Field>

          <Field l="Documents">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                            color: T.text, cursor: "pointer" }}>
              <input type="checkbox" checked={!!fm.docs} style={{ accentColor: T.red }}
                onChange={e => setFm(p => ({ ...p, docs: e.target.checked }))} />
              Allow file uploads for this field
            </label>
          </Field>

          {fm.kind === "expiry" && (
            <div style={{ padding: 12, background: T.bg, borderRadius: 6,
                          border: `1px solid ${fm.alert ? "#22c55e" : T.border}`, marginBottom: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                              color: T.text, cursor: "pointer" }}>
                <input type="checkbox" checked={!!fm.alert} style={{ accentColor: "#22c55e" }}
                  onChange={e => setFm(p => ({ ...p, alert: e.target.checked }))} />
                <span style={{ fontWeight: 600 }}>Send email alerts before this expires</span>
              </label>
              <div style={{ fontSize: 10, color: T.dim, marginTop: 4, marginLeft: 24 }}>
                Uses the same recipients and cadence as the other expiry alerts — first notice at
                the window below, then every 5 days, then daily once expired.
              </div>
              {fm.alert && (
                <div style={{ marginTop: 10, marginLeft: 24, maxWidth: 200 }}>
                  <Field l="First notice (days before)">
                    <input style={sIn} type="number" min="1" max="365" value={fm.alertDays}
                      onChange={e => setFm(p => ({ ...p, alertDays: e.target.value }))} />
                  </Field>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button style={bP} disabled={saving} onClick={save}>
              {saving ? "Saving…" : editing === "new" ? "Add Field" : "Save Changes"}
            </button>
            <button style={bS} disabled={saving} onClick={cancel}>Cancel</button>
          </div>
          {msg && <div style={{ fontSize: 11, marginTop: 8,
            color: msg === "Saved" ? "#22c55e" : "#eab308" }}>{msg}</div>}
        </Section>
      )}
    </>
  );
}

// ─── REPORT COLUMNS ────────────────────────────────────────────────────────
// Lets Manuel choose exactly which columns appear on each report, e.g. a driver
// list showing only Name / Phone / Email.
function ReportColumns() {
  const SCOPES = [
    { id: "drivers",   label: "Drivers",   base: "people" },
    { id: "employees", label: "Employees", base: "people" },
    { id: "suppliers", label: "Suppliers", base: "people" },
    { id: "trucks",    label: "Trucks",    base: "equipment" },
    { id: "trailers",  label: "Trailers",  base: "equipment" },
  ];
  const [scope, setScope] = useState("drivers");
  const [sel, setSel] = useState({});          // { scopeId: [labels] }
  const [custom, setCustom] = useState([]);    // custom field defs
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [colSnap, cfSnap] = await Promise.all([
          getDoc(doc(db, "settings", "reportColumns")),
          getDoc(doc(db, "settings", "customFields")),
        ]);
        setSel(colSnap.exists() ? (colSnap.data().scopes || {}) : {});
        setCustom(cfSnap.exists() ? (cfSnap.data().fields || []) : []);
      } catch (e) { console.error(e); }
      setLoaded(true);
    })();
  }, []);

  const meta = SCOPES.find(s => s.id === scope);
  // Built-ins for this scope, plus any custom fields targeting it.
  const available = [
    ...BUILTIN_COLUMNS[meta.base],
    ...custom.filter(f => (f.targets || []).includes(scope)).map(f => f.label),
  ];
  // No saved selection means "show everything" — matches current behaviour.
  const chosen = sel[scope] || available;
  const isOn = c => chosen.includes(c);

  const toggle = (c) => {
    const next = isOn(c) ? chosen.filter(x => x !== c) : [...chosen, c];
    if (!next.length) { setMsg("Keep at least one column"); return; }
    setMsg("");
    setSel(p => ({ ...p, [scope]: next }));
  };

  const persist = async () => {
    setSaving(true); setMsg("");
    try {
      await setDoc(doc(db, "settings", "reportColumns"), { scopes: sel }, { merge: true });
      setMsg("Saved");
      setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      console.error(e);
      setMsg("Save failed — check your connection");
    }
    setSaving(false);
  };

  const selectAll = () => { setSel(p => ({ ...p, [scope]: [...available] })); setMsg(""); };
  const reset     = () => { setSel(p => { const n = { ...p }; delete n[scope]; return n; }); setMsg(""); };

  return (
    <Section
      title="Report Columns"
      subtitle="Tick the columns each report should show. Untick everything you don't need — fewer columns means wider, more readable columns on the printed page."
      right={<button style={bP} disabled={saving} onClick={persist}>
        {saving ? "Saving…" : "Save"}
      </button>}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {SCOPES.map(s => (
          <button key={s.id} onClick={() => { setScope(s.id); setMsg(""); }} style={{
            padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
            fontFamily: "inherit", fontWeight: scope === s.id ? 600 : 400,
            background: scope === s.id ? T.border : "transparent",
            border: `1px solid ${scope === s.id ? "#334155" : T.border}`,
            color: scope === s.id ? T.text : T.muted,
          }}>{s.label}</button>
        ))}
      </div>

      {!loaded && <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>}

      {loaded && <>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button style={{ ...bS, padding: "4px 10px", fontSize: 11 }} onClick={selectAll}>Select all</button>
          <button style={{ ...bS, padding: "4px 10px", fontSize: 11 }} onClick={reset}>Reset to default</button>
          <span style={{ fontSize: 11, color: T.dim, alignSelf: "center", marginLeft: "auto" }}>
            {chosen.length} of {available.length} columns
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 6 }}>
          {available.map(c => {
            const isCustom = custom.some(f => f.label === c);
            return (
              <label key={c} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                borderRadius: 6, cursor: "pointer", fontSize: 12,
                background: isOn(c) ? T.hover : "transparent",
                border: `1px solid ${isOn(c) ? "#334155" : T.border}`,
                color: isOn(c) ? T.text : T.muted,
              }}>
                <input type="checkbox" checked={isOn(c)} style={{ accentColor: T.red }}
                  onChange={() => toggle(c)} />
                <span style={{ flex: 1 }}>{c}</span>
                {isCustom && <span style={{ fontSize: 9, color: "#3b82f6" }}>custom</span>}
              </label>
            );
          })}
        </div>

        <div style={{ fontSize: 10, color: T.dim, marginTop: 10 }}>
          Columns with no data for any record are hidden automatically when the report runs,
          so an empty column won't waste space even if it's ticked here.
        </div>

        {msg && <div style={{ fontSize: 11, marginTop: 8,
          color: msg === "Saved" ? "#22c55e" : "#eab308" }}>{msg}</div>}
      </>}
    </Section>
  );
}

// ─── ALERT RECIPIENTS ──────────────────────────────────────────────────────
// The Cloud Function reads settings/alertRecipients at send time, so changes
// here take effect on the next scheduled run with no redeploy.
function AlertRecipients() {
  const [emails, setEmails] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "settings", "alertRecipients"));
        setEmails(snap.exists() ? (snap.data().emails || []) : []);
      } catch (e) { console.error(e); }
      setLoaded(true);
    })();
  }, []);

  const valid = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  const persist = async (next) => {
    setSaving(true); setMsg("");
    try {
      await setDoc(doc(db, "settings", "alertRecipients"), { emails: next }, { merge: true });
      setEmails(next);
      setMsg("Saved");
      setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      console.error(e);
      setMsg("Save failed — check your connection");
    }
    setSaving(false);
  };

  const add = () => {
    const e = input.trim().toLowerCase();
    if (!e) return;
    if (!valid(e)) { setMsg("That doesn't look like a valid email address"); return; }
    if (emails.some(x => x.toLowerCase() === e)) { setMsg("Already on the list"); return; }
    setInput("");
    persist([...emails, e]);
  };

  const remove = (e) => {
    if (emails.length === 1) {
      alert("Keep at least one recipient — otherwise the expiry alerts go to nobody.");
      return;
    }
    if (!window.confirm(`Stop sending expiry alerts to ${e}?`)) return;
    persist(emails.filter(x => x !== e));
  };

  return (
    <Section
      title="Expiry Alert Recipients"
      subtitle="Who receives the daily certification and equipment-safety expiry email. Changes apply on the next scheduled run — no deploy needed."
    >
      {!loaded && <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>}

      {loaded && emails.length === 0 && (
        <div style={{ fontSize: 11, color: "#eab308", marginBottom: 10 }}>
          No recipients set — the alert function will fall back to its built-in list.
        </div>
      )}

      {emails.map(e => (
        <div key={e} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: T.text, flex: 1, wordBreak: "break-all" }}>{e}</span>
          <button onClick={() => remove(e)} disabled={saving} style={{
            ...bS, padding: "4px 10px", fontSize: 11, color: "#dc2626", borderColor: "#7f1d1d",
          }}>Remove</button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <input style={{ ...sIn, flex: 1 }} value={input} placeholder="name@example.com"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button style={bP} disabled={saving} onClick={add}>{saving ? "Saving…" : "Add"}</button>
      </div>

      {msg && <div style={{ fontSize: 11, marginTop: 8,
        color: msg === "Saved" ? "#22c55e" : "#eab308" }}>{msg}</div>}
    </Section>
  );
}

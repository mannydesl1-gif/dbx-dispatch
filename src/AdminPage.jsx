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
//     area:      "general" | "certs"          which section it appears in
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
import { db, auth } from "./firebase.js";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { DEFAULT_TERMS, CLOUD_FUNCTIONS } from "./client.config.js";

const OWNER_EMAILS = ["manny@diamondbackexpress.com"];
const isOwner = () => OWNER_EMAILS.map(e=>e.toLowerCase()).includes((auth.currentUser?.email||"").toLowerCase());

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
  maintenance: ["Date","Unit","Type","Description","Vendor","Invoice #","Cost"],
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
        {[["fields","Custom Fields"],["columns","Report Columns"],["alerts","Alert Recipients"],["terms","Terms & Conditions"],...(isOwner()?[["users","Users"]]:[])]
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
      {tab === "terms"   && <TermsEditor />}
      {tab === "users"   && isOwner() && <UsersTab />}
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
    area: "general",
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
      area: fm.area === "certs" ? "certs" : "general",
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
                <span style={{ padding: "1px 7px", borderRadius: 10,
                  background: (f.area||(f.kind==="expiry"?"certs":"general"))==="certs" ? "rgba(34,197,94,0.12)" : T.hover,
                  color: (f.area||(f.kind==="expiry"?"certs":"general"))==="certs" ? "#22c55e" : T.muted }}>
                  {(f.area||(f.kind==="expiry"?"certs":"general"))==="certs" ? "🏅 Certifications" : "Profile"}
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

          <Field l="Section — where it appears in the record">
            <div style={{ display: "grid", gap: 6 }}>
              {[
                { id: "general", label: "General Profile", hint: "Shows in the main info area with the standard fields." },
                { id: "certs",   label: "Certifications & Checks", hint: "Shows in the Certifications & Checks section (good for licences, inspections, checks with a document)." },
              ].map(s => {
                const on = (fm.area || "general") === s.id;
                return (
                  <label key={s.id} style={{
                    display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px",
                    borderRadius: 6, cursor: "pointer",
                    background: on ? T.hover : "transparent",
                    border: `1px solid ${on ? "#334155" : T.border}`,
                  }}>
                    <input type="radio" name="cfarea" checked={on} style={{ accentColor: T.red, marginTop: 2 }}
                      onChange={() => setFm(p => ({ ...p, area: s.id }))} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{s.label}</div>
                      <div style={{ fontSize: 10, color: T.dim }}>{s.hint}</div>
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
    { id: "maintenance", label: "Maintenance & Repairs", base: "maintenance" },
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
    const isLast = emails.length === 1;
    const prompt = isLast
      ? `Remove ${e}? This empties the list, which turns the daily expiry email OFF entirely — no one will be notified until you add a recipient back.`
      : `Stop sending expiry alerts to ${e}?`;
    if (!window.confirm(prompt)) return;
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
          No recipients — the daily expiry email is OFF. Add an address below to turn it back on.
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

// ── Terms & Conditions editor ──────────────────────────────────────────────
// Stores the default Terms & Conditions text used on new quotes and orders,
// and shown at the bottom of the quote / order PDFs. Read from
// settings/orderTerms; falls back to DEFAULT_TERMS (client.config.js) until set.
function TermsEditor() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "settings", "orderTerms"));
        const saved = snap.exists() ? snap.data().text : undefined;
        setText(saved !== undefined ? saved : DEFAULT_TERMS);
      } catch { setText(DEFAULT_TERMS); }
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setSaving(true); setMsg("");
    try {
      await setDoc(doc(db, "settings", "orderTerms"), { text }, { merge: true });
      setMsg("Saved");
    } catch (e) { console.error(e); setMsg("Error saving"); }
    setSaving(false);
    setTimeout(() => setMsg(""), 2500);
  };

  const resetDefault = () => setText(DEFAULT_TERMS);

  return (
    <Section
      title="Terms & Conditions"
      subtitle="This text pre-fills new quotes and orders and prints at the bottom of the quote and order PDFs. Editing here changes the default for future records; existing records keep whatever text they were saved with."
    >
      {!loaded ? (
        <div style={{ color: T.muted, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            style={{ ...sIn, width: "100%", minHeight: 180, resize: "vertical",
              fontSize: 12, lineHeight: 1.5, boxSizing: "border-box" }}
            placeholder="Standard terms & conditions text…"
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button style={bP} disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button style={bS} onClick={resetDefault} type="button">
              Reset to built-in default
            </button>
            {msg && <span style={{ fontSize: 11,
              color: msg === "Saved" ? "#22c55e" : "#eab308" }}>{msg}</span>}
          </div>
        </>
      )}
    </Section>
  );
}

// ─── USERS (create logins, reset passwords, hide-pricing role) ──────────────
// Owner-only. Talks to the adminUsers Cloud Function with the caller's ID token.
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [newHide, setNewHide] = useState(true);

  const call = async (body) => {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(CLOUD_FUNCTIONS.adminUsers, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const load = async () => {
    setErr("");
    try { const d = await call({ action: "list" }); setUsers(d.users || []); setLoaded(true); }
    catch (e) { setErr(e.message); setLoaded(true); }
  };
  useEffect(() => { load(); }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  const addUser = async () => {
    setErr("");
    if (!email.trim() || pw.length < 6) { setErr("Enter an email and a password of at least 6 characters."); return; }
    setBusy(true);
    try {
      await call({ action: "create", email: email.trim(), password: pw, hidePricing: newHide });
      setEmail(""); setPw(""); setNewHide(true); flash("Login created ✓"); await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const toggleHide = async (u) => {
    setErr(""); setBusy(true);
    try {
      await call({ action: "setHidePricing", uid: u.uid, hidePricing: !u.hidePricing });
      flash("Updated ✓ — takes effect next time they sign in"); await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const resetPw = async (u) => {
    const np = window.prompt(`New password for ${u.email} (min 6 characters):`);
    if (np == null) return;
    if (np.length < 6) { setErr("Password must be at least 6 characters."); return; }
    setErr(""); setBusy(true);
    try { await call({ action: "resetPassword", uid: u.uid, password: np }); flash("Password reset ✓"); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const del = async (u) => {
    if (!window.confirm(`Delete the login ${u.email}? This cannot be undone.`)) return;
    setErr(""); setBusy(true);
    try { await call({ action: "delete", uid: u.uid }); flash("User deleted ✓"); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <Section title="Add a login"
        subtitle="Creates a dispatch account. Tick “Hide pricing” for staff who shouldn’t see any pricing, invoices, or pay information.">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px" }}><Field l="Email"><input style={sIn} value={email} onChange={e => setEmail(e.target.value)} placeholder="person@diamondbackexpress.com" autoComplete="off" /></Field></div>
          <div style={{ flex: "1 1 160px" }}><Field l="Temporary Password"><input style={sIn} value={pw} onChange={e => setPw(e.target.value)} placeholder="min 6 characters" autoComplete="new-password" /></Field></div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.text, marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={newHide} onChange={e => setNewHide(e.target.checked)} /> Hide pricing
          </label>
          <button style={{ ...bP, marginBottom: 10 }} disabled={busy} onClick={addUser}>{busy ? "Working…" : "+ Create login"}</button>
        </div>
        {err && <div style={{ fontSize: 11, color: T.red, marginTop: 4 }}>{err}</div>}
        {msg && <div style={{ fontSize: 11, color: "#22c55e", marginTop: 4 }}>{msg}</div>}
      </Section>

      <Section title="Existing logins" right={<button style={bS} disabled={busy} onClick={load}>↻ Refresh</button>}>
        {!loaded ? <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>
          : users.length === 0 ? <div style={{ fontSize: 12, color: T.dim }}>No users found.</div>
            : <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ textAlign: "left", color: T.muted, borderBottom: `1px solid ${T.border}` }}>
                    <th style={{ padding: "6px 8px" }}>Email</th>
                    <th style={{ padding: "6px 8px" }}>Access</th>
                    <th style={{ padding: "6px 8px" }}>Last sign-in</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Actions</th>
                  </tr></thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.uid} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: "7px 8px", color: T.text }}>{u.email}{u.isOwner && <span style={{ marginLeft: 6, fontSize: 9, color: "#eab308", border: "1px solid #eab308", borderRadius: 4, padding: "1px 5px" }}>OWNER</span>}</td>
                        <td style={{ padding: "7px 8px" }}>
                          {u.isOwner ? <span style={{ color: T.dim }}>Full</span>
                            : <span style={{ color: u.hidePricing ? "#f59e0b" : "#22c55e", fontWeight: 600 }}>{u.hidePricing ? "No pricing" : "Full"}</span>}
                        </td>
                        <td style={{ padding: "7px 8px", color: T.dim, fontSize: 11 }}>{u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString() : "—"}</td>
                        <td style={{ padding: "7px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {!u.isOwner && <button style={{ ...bS, padding: "4px 9px", fontSize: 11, marginLeft: 4 }} disabled={busy} onClick={() => toggleHide(u)}>{u.hidePricing ? "Show pricing" : "Hide pricing"}</button>}
                          <button style={{ ...bS, padding: "4px 9px", fontSize: 11, marginLeft: 4 }} disabled={busy} onClick={() => resetPw(u)}>Reset password</button>
                          {!u.isOwner && <button style={{ ...bS, padding: "4px 9px", fontSize: 11, marginLeft: 4, color: T.red, borderColor: T.red }} disabled={busy} onClick={() => del(u)}>Delete</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
        <div style={{ fontSize: 10, color: T.dim, marginTop: 10 }}>
          “Hide pricing” removes Quotes, order pricing, invoicing, the revenue report, pay configuration and Timesheets for that user. It applies in the interface; it takes effect the next time they sign in.
        </div>
      </Section>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { collection, addDoc, query, where, getDocs, getDoc, orderBy, setDoc, doc, updateDoc, deleteDoc, onSnapshot } from "firebase/firestore";
import { getMessaging, getToken, onMessage } from "firebase/messaging";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// ── Firebase config (same project as dispatch app) ──
const firebaseConfig = {
  apiKey: "AIzaSyBGROpss8i4f0txMQkl3i7wt20SPrxek2A",
  authDomain: "dbx-prod.firebaseapp.com",
  projectId: "dbx-prod",
  storageBucket: "dbx-prod.firebasestorage.app",
  messagingSenderId: "402235440224",
  appId: "1:402235440224:web:663da4005ec11833bcd705",
};
const app = initializeApp(firebaseConfig, "dbx-timesheets");
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const db = initializeFirestore(app, { experimentalForceLongPolling: isSafari });
const storage = getStorage(app);

// ── Anonymous auth — satisfies Firestore rules (request.auth != null) ──
// TimesheetApp uses a custom PIN system, not Firebase Auth.
// signInAnonymously gives every device a valid auth token so Firestore
// rules don't block reads/writes (orders, employees, sessions, etc.)
const _auth = getAuth(app);
// Resolve when an auth token actually exists. With tightened Firestore rules
// (request.auth != null), any read that fires before the anonymous token lands
// gets denied — so app code must await authReadyPromise before its first read.
let _resolveAuthReady;
const authReadyPromise = new Promise(res => { _resolveAuthReady = res; });
onAuthStateChanged(_auth, user => { if (user) _resolveAuthReady(true); });
signInAnonymously(_auth).catch(e => console.warn("Anon auth failed:", e));
let messaging = null;
try { messaging = getMessaging(app); } catch(e) { console.log('Messaging not supported'); }

const VAPID_KEY = "BFA2WJZ28otkdLeY5OgjVI9gwNf2xEt86hQw84nsd0wPyzBcaeaFIwj4bT0jMUi9W3wL8RvFZnYf829PiQv9ats";

// ── Events are loaded live from Firestore ──
// Manage them from the Events page in your dispatch app

const EXPENSE_TYPES = {
  fr: ["Uber / Taxi", "Bagage", "Gaz", "Fournitures", "Divers"],
  en: ["Uber / Taxi", "Baggage", "Gas", "Supplies", "Miscellaneous"],
};

// ── Registration document types ──
// Each has: id, icon, label_fr, label_en, desc_fr, desc_en, accept
const DOC_TYPES = [
  {
    id: "void_cheque",
    icon: "🏦",
    label_fr: "Chèque annulé",
    label_en: "Void cheque",
    desc_fr: "Pour le dépôt direct de votre paie",
    desc_en: "Required for direct deposit payroll",
    accept: "image/*,application/pdf",
  },
  {
    id: "drivers_licence",
    icon: "🪪",
    label_fr: "Permis de conduire",
    label_en: "Driver's licence",
    desc_fr: "Recto et/ou verso de votre permis",
    desc_en: "Front and/or back of your licence",
    accept: "image/*,application/pdf",
  },
  {
    id: "headshot",
    icon: "📷",
    label_fr: "Photo d'identité",
    label_en: "Headshot photo",
    desc_fr: "Photo récente sur fond neutre",
    desc_en: "Recent photo on a neutral background",
    accept: "image/*",
  },
  {
    id: "other",
    icon: "📎",
    label_fr: "Autre document",
    label_en: "Other document",
    desc_fr: "Précisez le type de document ci-dessous",
    desc_en: "Specify the document type below",
    accept: "image/*,application/pdf",
  },
];

const T = {
  fr: {
    portalLabel: "Portail employé",
    step1: "1. Inscription", step2: "2. Heures du jour", step3: "3. Dépenses", step4: "4. Résumé", step5: "5. Mes commandes", step6: "6. Équipements", step7: "7. Documents",
    navDaily: "Feuille de temps", navExpenses: "Dépenses", navSummary: "Résumé", navLogout: "Déconnexion",
    welcomeTitle: "Bienvenue",
    welcomeSub: "Entrez votre ID employé et NIP pour accéder à votre portail.",
    empIdLabel: "ID Employé",
    empIdPh: "ex: 26-23",
    pinLabel: "NIP",
    pinPh: "4-6 chiffres",
    loginBtn: "Connexion →",
    loggingIn: "Connexion...",
    loginErrNotFound: "ID employé introuvable. Vérifiez votre ID ou contactez votre gestionnaire.",
    loginErrArchived: "Ce compte est archivé. Contactez votre gestionnaire.",
    loginErrPin: "NIP incorrect. Veuillez réessayer.",
    loginErrEmpty: "Veuillez entrer votre ID employé et votre NIP.",
    welcomeBack: (n) => `👋 Bon retour, ${n} ! Vos infos sont sauvegardées.`,
    fullName: "Nom complet", phone: "Numéro de téléphone", email: "Adresse courriel", event: "Événement",
    selectEvent: "— Sélectionnez votre événement —", namePh: "Jean Tremblay", emailPh: "jean@courriel.com",
    continue: "Continuer →",
    docsSection: "Documents (optionnel)",
    myDocsTab: "Mes documents",
    myDocsSub: "Soumettez vos documents officiels. Vous pouvez les mettre à jour à tout moment.",
    myDocsSubmit: "Soumettre les documents",
    myDocsSubmitting: "Téléversement en cours...",
    myDocsSuccess: "✅ Documents soumis avec succès",
    myDocsNoneSelected: "Veuillez sélectionner au moins un document",
    myDocsAlreadyUploaded: "Déjà soumis",
    myDocsUpdate: "Mettre à jour",
    docsSub: "Téléversez vos documents si vous en avez. Vous pouvez les ajouter ou les mettre à jour à tout moment.",
    docsOptional: "Optionnel — mais requis avant le premier versement de paie.",
    otherDocLabel: "Nom du document",
    otherDocPh: "Ex : Carte SIN, Passeport, Permis de travail...",
    uploadBtn: "Choisir un fichier", noFile: "Aucun fichier", removeFile: "× Retirer",
    registering: "Inscription en cours...",
    dailyTitle: "Heures de la journée",
    dailySub: "Inscrivez vos heures et une note sur ce que vous avez fait aujourd'hui.",
    date: "Date", startTime: "Heure de début", endTime: "Heure de fin",
    truckUnit: "Unité du camion", trailerUnit: "Unité de remorque", kmStart: "KM de départ", kmEnd: "KM d'arrivée",
    tasksLabel: "Tâches et notes",
    tasksPh: "Décrivez ce sur quoi vous avez travaillé aujourd'hui — emplacement, tâches, tout ce qui est pertinent...",
    tasksNote: "Soyez précis. Cela apparaîtra directement dans votre rapport de feuille de temps.",
    submitBtn: "Soumettre mes heures →",
    goExpense: "Soumettre une dépense →",
    viewSummary: "Voir mon résumé",
    expenseTitle: "Soumettre une dépense",
    expenseSub: "Soumettez un reçu pour remboursement. Vous pouvez soumettre une dépense sans avoir travaillé ce jour-là.",
    expenseDate: "Date de la dépense", expenseType: "Type de dépense",
    selectExpenseType: "— Sélectionnez le type —",
    expenseAmount: "Montant", expenseCurrency: "Devise",
    expenseDesc: "Description",
    expenseDescPh: "Ex : Uber de l'aéroport Pearson à la maison après le retour des États-Unis. Course #ABC123.",
    expenseDescNote: "Soyez précis. Cela aide à traiter votre remboursement rapidement.",
    expenseReceipt: "Reçu (photo ou PDF)",
    expenseReceiptNote: "Photo de reçu, capture d'écran ou PDF. Max 10 Mo.",
    submitExpenseBtn: "Soumettre la dépense →",
    uploading: "Envoi en cours...",
    saveExpenseBtn: "Enregistrer cette dépense",
    stagedTitle: "Dépenses enregistrées (non soumises)",
    submitAllBtn: "Tout soumettre",
    stagedNote: "Enregistrez plusieurs dépenses, puis soumettez-les toutes en même temps.",
    removeStaged: "Retirer",
    toastStaged: "Dépense enregistrée ✓",
    toastAllOk: "Dépenses soumises ✓",
    leaveWarn: "Vous avez des dépenses enregistrées mais non soumises. Elles seront perdues si vous quittez.",
    backToHours: "← Retour aux heures",
    summaryTitle: "Mon résumé",
    summarySub: (e) => `Vos soumissions pour ${e}.`,
    totalHours: "Heures totales", daysWorked: "Jours travaillés", totalExpenses: "Dépenses",
    breakdown: "Détail des heures", expenseBreakdown: "Détail des dépenses",
    docsUploaded: "Documents soumis",
    addDay: "← Ajouter des heures", addExpense: "← Ajouter une dépense",
    noEntries: "Aucune entrée pour l'instant.", noExpenses: "Aucune dépense pour l'instant.",
    noDocs: "Aucun document soumis.",
    submitting: "Envoi en cours...", toastOk: "Heures soumises ✓",
    toastExpenseOk: "Dépense soumise ✓", toastRegOk: "Inscription complétée ✓",
    toastErr: "Erreur — veuillez réessayer.",
    pinTitle: "Vérification de sécurité",
    pinSub: (n) => `Bonjour ${n}, veuillez entrer votre NIP à 4-6 chiffres pour continuer.`,
    pinPlaceholder: "Entrez votre NIP",
    pinVerify: "Vérifier",
    pinCancel: "Annuler",
    pinWrong: "NIP incorrect. Veuillez réessayer.",
    pinEmpty: "Veuillez entrer votre NIP.",
    pinHelp: "Vous n'avez pas de NIP ? Contactez votre gestionnaire.",
    alertFill: "Veuillez remplir tous les champs obligatoires.",
    alertTime: "L'heure de fin doit être après l'heure de début.",
    alertFile: "Veuillez joindre un reçu.",
    alertOtherLabel: "Veuillez préciser le nom du document.",
    loading: "Chargement...", locale: "fr-CA",
    viewReceipt: "Voir le reçu", viewDoc: "Voir le document",
    pending: "En attente",
    docsSummaryTitle: "Documents",
  },
  en: {
    portalLabel: "Employee Portal",
    step1: "1. Registration", step2: "2. Daily log", step3: "3. Expenses", step4: "4. Summary", step5: "5. My Orders", step6: "6. Equipment", step7: "7. Documents",
    navDaily: "Daily Log", navExpenses: "Expenses", navSummary: "Summary", navLogout: "Log Out",
    welcomeTitle: "Welcome",
    welcomeSub: "Enter your Employee ID and PIN to access your portal.",
    empIdLabel: "Employee ID",
    empIdPh: "e.g. 26-23",
    pinLabel: "PIN",
    pinPh: "4-6 digits",
    loginBtn: "Sign In →",
    loggingIn: "Signing in...",
    loginErrNotFound: "Employee ID not found. Check your ID or contact your manager.",
    loginErrArchived: "This account is archived. Please contact your manager.",
    loginErrPin: "Incorrect PIN. Please try again.",
    loginErrEmpty: "Please enter your Employee ID and PIN.",
    welcomeBack: (n) => `👋 Welcome back, ${n}! Your info is saved.`,
    fullName: "Full name", phone: "Phone number", email: "Email address", event: "Event",
    selectEvent: "— Select your event —", namePh: "John Smith", emailPh: "john@email.com",
    continue: "Continue →",
    docsSection: "Documents (optional)",
    myDocsTab: "My Documents",
    myDocsSub: "Submit your official documents. You can update them at any time.",
    myDocsSubmit: "Submit Documents",
    myDocsSubmitting: "Uploading...",
    myDocsSuccess: "✅ Documents submitted successfully",
    myDocsNoneSelected: "Please select at least one document",
    myDocsAlreadyUploaded: "Already submitted",
    myDocsUpdate: "Update",
    docsSub: "Upload any documents if you have them. You can add or update them at any time.",
    docsOptional: "Optional — but required before your first payroll payment.",
    otherDocLabel: "Document name",
    otherDocPh: "e.g. SIN Card, Passport, Work permit...",
    uploadBtn: "Choose file", noFile: "No file", removeFile: "× Remove",
    registering: "Registering...",
    dailyTitle: "Daily check-in",
    dailySub: "Log your hours and a brief note about what you worked on today.",
    date: "Date", startTime: "Start time", endTime: "End time",
    truckUnit: "Truck unit", trailerUnit: "Trailer unit", kmStart: "Start KM", kmEnd: "End KM",
    tasksLabel: "Tasks & notes",
    tasksPh: "Describe what you worked on today — location, assignments, anything relevant...",
    tasksNote: "Be specific. This goes directly into your timesheet report.",
    submitBtn: "Submit today's entry →",
    goExpense: "Submit an expense →",
    viewSummary: "View my summary",
    expenseTitle: "Submit an expense",
    expenseSub: "Submit a receipt for reimbursement. You can submit an expense even on days you didn't work.",
    expenseDate: "Expense date", expenseType: "Expense type",
    selectExpenseType: "— Select type —",
    expenseAmount: "Amount", expenseCurrency: "Currency",
    expenseDesc: "Description",
    expenseDescPh: "e.g. Uber from Pearson Airport to home after returning from the US. Trip #ABC123.",
    expenseDescNote: "Be specific. This helps process your reimbursement quickly.",
    expenseReceipt: "Receipt (photo or PDF)",
    expenseReceiptNote: "Photo, screenshot, or PDF of your receipt. Max 10 MB.",
    submitExpenseBtn: "Submit expense →",
    uploading: "Uploading...",
    saveExpenseBtn: "Save this expense",
    stagedTitle: "Saved expenses (not yet submitted)",
    submitAllBtn: "Submit all",
    stagedNote: "Save several expenses, then submit them all at once.",
    removeStaged: "Remove",
    toastStaged: "Expense saved ✓",
    toastAllOk: "Expenses submitted ✓",
    leaveWarn: "You have saved expenses that haven't been submitted. They'll be lost if you leave.",
    backToHours: "← Back to hours",
    summaryTitle: "My summary",
    summarySub: (e) => `Your submissions for ${e}.`,
    totalHours: "Total hours", daysWorked: "Days worked", totalExpenses: "Expenses",
    breakdown: "Hours breakdown", expenseBreakdown: "Expenses breakdown",
    docsUploaded: "Documents",
    addDay: "← Add hours", addExpense: "← Add an expense",
    noEntries: "No entries yet.", noExpenses: "No expenses yet.",
    noDocs: "No documents submitted.",
    submitting: "Submitting...", toastOk: "Entry submitted ✓",
    toastExpenseOk: "Expense submitted ✓", toastRegOk: "Registration complete ✓",
    toastErr: "Error — please try again.",
    pinTitle: "Security verification",
    pinSub: (n) => `Hi ${n}, please enter your 4-6 digit PIN to continue.`,
    pinPlaceholder: "Enter your PIN",
    pinVerify: "Verify",
    pinCancel: "Cancel",
    pinWrong: "Incorrect PIN. Please try again.",
    pinEmpty: "Please enter your PIN.",
    pinHelp: "Don't have a PIN? Contact your manager.",
    alertFill: "Please fill in all required fields.",
    alertTime: "End time must be after start time.",
    alertFile: "Please attach a receipt.",
    alertOtherLabel: "Please specify the document name.",
    loading: "Loading...", locale: "en-CA",
    viewReceipt: "View receipt", viewDoc: "View document",
    pending: "Pending",
    docsSummaryTitle: "Documents",
  },
};

const today = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0,5);
// True if a YYYY-MM-DD date string is after today (a future date).
const isFutureDate = (d) => !!d && d > today();
const calcMins = (s, e) => {
  const [sh,sm]=s.split(":").map(Number),[eh,em]=e.split(":").map(Number);
  let mins = eh*60+em-(sh*60+sm);
  // Only a genuine overnight (end strictly BEFORE start) rolls to the next day.
  // Equal start/end = 0 minutes, not a phantom 24h shift.
  if(mins<0) mins+=24*60;
  return mins;
};
const fmtHours = (m) => { const h=Math.floor(m/60),mn=m%60; return `${h}h ${mn<10?"0":""}${mn}m`; };
const fmtDate = (d, locale) => new Date(d+"T12:00:00").toLocaleDateString(locale,{weekday:"short",month:"short",day:"numeric"});

// ── GPS — only called on button press, never on manual input ──
const getGPS = () => new Promise((resolve) => {
  if(!navigator.geolocation){ resolve({ method:"unavailable", reason:"not_supported" }); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => resolve({
      method: "button",
      lat: +pos.coords.latitude.toFixed(6),
      lng: +pos.coords.longitude.toFixed(6),
      accuracy: Math.round(pos.coords.accuracy), // metres
      capturedAt: new Date().toISOString(),
    }),
    (err) => resolve({ method:"unavailable", reason: err.code===1?"denied":"timeout_or_error" }),
    { enableHighAccuracy:true, timeout:8000, maximumAge:0 }
  );
});

// ── Theme palettes ──
const LIGHT = {
  black:"#0f0f0f", white:"#fafaf8", red:"#dc2626", redDark:"#991b1b", redLight:"#fef2f2",
  gray:"#888", border:"#e2e0dc", surface:"#f5f4f2", green:"#16a34a", greenLight:"#f0fdf4",
  amber:"#b45309", amberLight:"#fffbeb", blue:"#0369a1", blueLight:"#dbeafe",
};
const DARK = {
  black:"#f1f5f9", white:"#0f172a", red:"#f87171", redDark:"#dc2626", redLight:"rgba(220,38,38,0.1)",
  gray:"#94a3b8", border:"#1e293b", surface:"#1e293b", green:"#4ade80", greenLight:"rgba(34,197,94,0.1)",
  amber:"#fbbf24", amberLight:"rgba(245,158,11,0.1)", blue:"#60a5fa", blueLight:"rgba(59,130,246,0.1)",
};

// C is set dynamically — components reference window.__C which is updated on theme change
let C = {...LIGHT};

const makeS = (C) => ({
  app: { maxWidth:480, margin:"0 auto", minHeight:"100vh", minHeight:"-webkit-fill-available", background:C.white, fontFamily:"'DM Sans', sans-serif", overflowX:"hidden", boxSizing:"border-box", paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 70px)" },
  header: { background:C.black==="#f1f5f9"?"#0f172a":C.black, padding:"16px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  logoImg: { height:38, objectFit:"contain" },
  headerRight: { display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 },
  portalLabel: { color:"#666", fontSize:11, fontFamily:"'DM Mono', monospace", letterSpacing:"0.1em", textTransform:"uppercase", textAlign:"right" },
  langToggle: { display:"flex", gap:4 },
  steps: { display:"flex", background:C.surface, borderBottom:`1px solid ${C.border}`, overflowX:"auto", WebkitOverflowScrolling:"touch", scrollbarWidth:"none", msOverflowStyle:"none" },
  screen: { padding:"20px 16px", animation:"fadeIn 0.2s ease", boxSizing:"border-box", width:"100%" },
  title: { fontSize:21, fontWeight:700, marginBottom:4, color:C.black },
  sub: { fontSize:14, color:C.gray, marginBottom:24, lineHeight:1.55 },
  fw: { marginBottom:18 },
  lbl: { display:"block", fontSize:11, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase", color:C.gray, marginBottom:6 },
  inp: { width:"100%", maxWidth:"100%", padding:"12px 14px", border:`1.5px solid ${C.border}`, borderRadius:7, fontFamily:"'DM Sans', sans-serif", fontSize:15, color:C.black, background:C.white, outline:"none", boxSizing:"border-box", display:"block", WebkitAppearance:"none", appearance:"none", margin:0 },
  ta: { width:"100%", padding:"12px 14px", border:`1.5px solid ${C.border}`, borderRadius:7, fontFamily:"'DM Sans', sans-serif", fontSize:15, color:C.black, background:C.white, outline:"none", resize:"none", minHeight:88, lineHeight:1.6, boxSizing:"border-box" },
  note: { fontSize:12, color:C.gray, marginTop:5, lineHeight:1.4 },
  row2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 },
  amtRow: { display:"grid", gridTemplateColumns:"1fr 100px", gap:12 },
  badge: { display:"inline-flex", alignItems:"center", gap:7, background:C.black==="#f1f5f9"?"#0f172a":C.black, color:"#fff", fontFamily:"'DM Mono', monospace", fontSize:13, fontWeight:500, padding:"7px 13px", borderRadius:6, marginTop:6, marginBottom:4 },
  dot: { width:7, height:7, borderRadius:"50%", background:C.red, flexShrink:0 },
  btn: { width:"100%", padding:14, background:C.red, color:"#fff", border:"none", borderRadius:7, fontFamily:"'DM Sans', sans-serif", fontSize:15, fontWeight:700, cursor:"pointer", marginTop:6 },
  btnBlk: { background:C.black==="#f1f5f9"?"#0f172a":C.black },
  btnOut: { background:"transparent", color:C.black, border:`1.5px solid ${C.border}`, marginTop:10 },
  btnGrn: { background:C.green },
  empTag: { display:"inline-flex", alignItems:"center", gap:8, background:"#0369a1", color:"#fff", padding:"8px 14px", borderRadius:6, fontSize:13, fontWeight:600, marginBottom:20 },
  empDot: { width:7, height:7, borderRadius:"50%", background:"#7dd3fc", flexShrink:0 },
  statsGrid: { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:20 },
  statBox: { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"12px 14px" },
  statLbl: { fontSize:10, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:C.gray, marginBottom:6 },
  statVal: { fontFamily:"'DM Mono', monospace", fontSize:22, fontWeight:600, color:C.black },
  divider: { height:1, background:C.border, margin:"20px 0" },
  secLbl: { fontSize:11, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase", color:C.gray, marginBottom:12 },
  logItem: { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"13px 15px", marginBottom:8 },
  logHdr: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 },
  logDate: { fontSize:13, fontWeight:700, color:C.black },
  logHrs: { fontFamily:"'DM Mono', monospace", fontSize:13, fontWeight:600, color:C.red },
  logTime: { fontSize:12, color:C.gray, marginBottom:5 },
  logNote: { fontSize:13, color:C.gray, lineHeight:1.5 },
  wbBack: { background:C.redLight, border:`1px solid ${C.red}`, borderRadius:8, padding:"12px 14px", fontSize:13, color:C.red, marginBottom:20, display:"flex", alignItems:"center", gap:8 },
  docCard: { border:`1.5px solid ${C.border}`, borderRadius:10, padding:"14px 16px", marginBottom:10, background:C.white, transition:"border-color 0.2s" },
  docCardUploaded: { borderColor:C.green, background:C.greenLight },
  docHeader: { display:"flex", alignItems:"center", gap:10, marginBottom:6 },
  docIcon: { fontSize:20, flexShrink:0 },
  docLabel: { fontSize:14, fontWeight:600, color:C.black },
  docDesc: { fontSize:12, color:C.gray, marginBottom:10, lineHeight:1.4 },
  docActions: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
});
const S = makeS(C);

// ── Components ──
function LangBtn({ active, onClick, label, C }) {
  return <button onClick={onClick} style={{ background:active?C.red:"transparent", border:`1px solid ${active?C.red:"#444"}`, color:active?"#fff":"#888", fontFamily:"'DM Mono',monospace", fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:4, cursor:"pointer" }}>{label}</button>;
}

function StepTab({ label, active, done, onClick, C }) {
  return <button onClick={onClick} style={{ flex:"0 0 auto", padding:"12px 10px", fontSize:10, fontWeight:600, color:active?C.black:done?C.red:C.gray, background:active?C.white:"transparent", border:"none", borderBottom:`2.5px solid ${active?C.red:"transparent"}`, cursor:"pointer", textTransform:"uppercase", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", letterSpacing:"0.03em" }}>{label}</button>;
}

function Field({ label, children, note, required, C, S }) {
  return <div style={S.fw}><label style={S.lbl}>{label}{required&&<span style={{color:C.red,marginLeft:3}}>*</span>}</label>{children}{note&&<div style={S.note}>{note}</div>}</div>;
}

function FocusInput({ style: extra, ...props }) {
  const [f,setF]=useState(false);
  return <input {...props} style={{...S.inp,...(f?{borderColor:C.red}:{}), ...extra}} onFocus={()=>setF(true)} onBlur={()=>setF(false)} />;
}

function FocusSelect({ children, ...props }) {
  const [f,setF]=useState(false);
  return <select {...props} style={{...S.inp, backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`, backgroundRepeat:"no-repeat", backgroundPosition:"right 14px center", paddingRight:36, cursor:"pointer", appearance:"none", WebkitAppearance:"none", ...(f?{borderColor:C.red}:{})}} onFocus={()=>setF(true)} onBlur={()=>setF(false)}>{children}</select>;
}

function FocusTextarea({ ...props }) {
  const [f,setF]=useState(false);
  return <textarea {...props} style={{...S.ta,...(f?{borderColor:C.red}:{})}} onFocus={()=>setF(true)} onBlur={()=>setF(false)} />;
}

// ── Generic file pick button ──
function FilePick({ file, onFile, accept, t, compact=false, C, S }) {
  const ref = useRef();
  const has = !!file;
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <input ref={ref} type="file" accept={accept} style={{display:"none"}} onChange={e=>onFile(e.target.files[0]||null)} />
      <button type="button" onClick={()=>ref.current.click()} style={{ padding:compact?"6px 12px":"10px 14px", background:has?C.greenLight:C.surface, border:`1.5px solid ${has?C.green:C.border}`, borderRadius:7, fontSize:compact?12:13, fontWeight:600, color:has?C.green:C.gray, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
        <span>{has?"✓ ":"📎 "}</span>{t("uploadBtn")}
      </button>
      <span style={{fontSize:12,color:has?C.green:C.gray,fontWeight:has?500:400,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>
        {file?file.name:t("noFile")}
      </span>
      {has&&<button type="button" onClick={()=>{onFile(null);ref.current.value="";}} style={{background:"none",border:"none",color:C.gray,fontSize:11,cursor:"pointer",padding:0,fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}>{t("removeFile")}</button>}
    </div>
  );
}

// ── Document upload card for registration ──
function DocCard({ docType, file, onFile, otherLabel, onOtherLabel, lang, t, C, S }) {
  const label = lang==="fr" ? docType.label_fr : docType.label_en;
  const desc  = lang==="fr" ? docType.desc_fr  : docType.desc_en;
  const has   = !!file;
  return (
    <div style={{...S.docCard,...(has?S.docCardUploaded:{})}}>
      <div style={S.docHeader}>
        <span style={S.docIcon}>{docType.icon}</span>
        <div>
          <div style={{...S.docLabel,...(has?{color:C.green}:{})}}>{label}</div>
        </div>
        {has&&<span style={{marginLeft:"auto",fontSize:11,fontWeight:600,color:C.green,background:C.greenLight,padding:"2px 8px",borderRadius:10}}>✓ {lang==="fr"?"Ajouté":"Uploaded"}</span>}
      </div>
      <div style={S.docDesc}>{desc}</div>
      {docType.id==="other"&&(
        <div style={{marginBottom:10}}>
          <FocusInput
            type="text"
            value={otherLabel}
            onChange={e=>onOtherLabel(e.target.value)}
            placeholder={t("otherDocPh")}
            style={{fontSize:13,padding:"9px 12px"}}
          />
        </div>
      )}
      <div style={S.docActions}>
        <FilePick file={file} onFile={onFile} accept={docType.accept} t={t} compact C={C} S={S}/>
      </div>
    </div>
  );
}

export default function TimesheetApp() {
  const [lang, setLangState] = useState(()=>localStorage.getItem("cargodx_lang")||"fr");
  const [darkMode, setDarkMode] = useState(()=>{
    const saved = localStorage.getItem("cargodx_darkmode");
    if(saved!==null) return saved==="true";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
  });

  // Rebuild C and S whenever darkMode changes
  const C = darkMode ? DARK : LIGHT;
  const S = makeS(C);
  const savedEmployee = (() => { try{return JSON.parse(localStorage.getItem("cargodx_employee")||"null");}catch{return null;} })();
  const savedTab = (() => { const v = parseInt(localStorage.getItem("cargodx_tab")||"0",10); return (v>=1&&v<=7)?v:0; })();
  const savedIsGroundCrew = !!(savedEmployee && savedEmployee.isEmployee === true && savedEmployee.isDriver !== true);
  const logBlocked = (savedEmployee && savedEmployee.logRestricted === true);
  const defaultTab = logBlocked ? 5 : 2; // restricted users land on Orders, not the daily log
  const startTab = savedEmployee ? (logBlocked ? 5 : ((savedIsGroundCrew && (savedTab===5||savedTab===6)) ? 2 : (savedTab || 2))) : 1;
  const [tab, setTab] = useState(startTab); // must be registered to start past tab 1
  const [events, setEvents] = useState([]);
  const [employee, setEmployee] = useState(savedEmployee);
  // Ground crew = tagged Employee AND not a Driver (matches dispatch's role logic).
  // Defensive default: a missing flag (old saved session) is treated as NOT ground
  // crew, so no one loses tabs until their record confirms it (self-corrects on next login).
  const isGroundCrew = !!(employee && employee.isEmployee === true && employee.isDriver !== true);
  const [activeSession, setActiveSession] = useState(null); // found session on another device
  // PIN verification: when a matched driver has a PIN, hold pending registration data here
  const [pinPrompt, setPinPrompt] = useState(null); // { emp, driverPin, driverMatch }
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [checkingSession, setCheckingSession] = useState(false);
  const [logs, setLogs] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [empDocs, setEmpDocs] = useState([]);
  const [docSubmitting, setDocSubmitting] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false); // documents section collapsed by default
  const [equipOpen, setEquipOpen] = useState(false); // equipment section collapsed
  const [equipAnswer, setEquipAnswer] = useState(null); // null | "yes" | "no"
  const [unitLogOpen, setUnitLogOpen] = useState(false); // unit log collapsed

  // Registration fields
  const [regName,setRegName]=useState(employee?.name||"");
  const [regPhone,setRegPhone]=useState(employee?.phone||"");
  const [regEmail,setRegEmail]=useState(employee?.email||"");
  const [regEvent,setRegEvent]=useState(employee?.event||"");
  const [regEmpId,setRegEmpId]=useState("");
  const [regPin,setRegPin]=useState("");
  const [loginError,setLoginError]=useState("");

  // Document files — one per DOC_TYPES entry
  const [docFiles, setDocFiles] = useState({ void_cheque:null, drivers_licence:null, headshot:null, other:null });
  const [otherLabel, setOtherLabel] = useState("");

  // Hours fields
  const [logDate,setLogDate]=useState(()=>localStorage.getItem("cargodx_clockin_date")||today());
  const [logStart,setLogStart]=useState(()=>localStorage.getItem("cargodx_clockin_start")||"");
  const [logEnd,setLogEnd]=useState(()=>localStorage.getItem("cargodx_clockin_end")||"");
  const [logNotes,setLogNotes]=useState("");
  const [showNoteBox,setShowNoteBox]=useState(false);
  const [dayType,setDayType]=useState("working");
  const [showNwPanel,setShowNwPanel]=useState(false);
  const [eventAllowsNw,setEventAllowsNw]=useState(false);
  const [eventAllowsPerDiem,setEventAllowsPerDiem]=useState(false);
  const [eventAllowsHours,setEventAllowsHours]=useState(true);
  const [eventAllowsDaily,setEventAllowsDaily]=useState(false);
  // When an event allows BOTH hours and day-logging, the driver picks which to
  // use for this entry. "hours" = clock in/out; "day" = working/NW/per-diem UI.
  const [logMode,setLogMode]=useState("hours");
  const [eventAllowsExpenses,setEventAllowsExpenses]=useState(true);
  const [eventAllowsTrips,setEventAllowsTrips]=useState(false);
  const [logBreak,setLogBreak]=useState("");
  const [logTruck,setLogTruck]=useState(()=>localStorage.getItem("cargodx_clockin_truck")||"");
  const [logTrailer,setLogTrailer]=useState(()=>localStorage.getItem("cargodx_clockin_trailer")||"");
  const [unitLog,setUnitLog]=useState(()=>{ try{return JSON.parse(localStorage.getItem("cargodx_unitlog")||"[]");}catch{return [];} });
  const [logKmStart,setLogKmStart]=useState(()=>localStorage.getItem("cargodx_clockin_kmstart")||"");
  const [logKmEnd,setLogKmEnd]=useState(()=>localStorage.getItem("cargodx_clockin_kmend")||"");
  const [gpsIn,setGpsIn]=useState(null);
  const [gpsOut,setGpsOut]=useState(null);
  const [clockedIn,setClockedIn]=useState(()=>!!localStorage.getItem("cargodx_clockin_start"));
  const [shiftEvent,setShiftEvent]=useState(()=>localStorage.getItem("cargodx_clockin_event")||"");
  const [allEvents,setAllEvents]=useState([]);
  // Optional sub-event (e.g. "May Concert", "Week 32"). subEventOptions holds the
  // selected event's list; shiftSubEvent is the employee's choice. Only shown
  // when the chosen event actually has sub-events defined.
  const [shiftSubEvent,setShiftSubEvent]=useState(()=>localStorage.getItem("cargodx_clockin_subevent")||"");
  const [subEventOptions,setSubEventOptions]=useState([]);
  const [gpsLoading,setGpsLoading]=useState(null);
  const [showManual,setShowManual]=useState(false);
  const [showSubmitReminder,setShowSubmitReminder]=useState(false);
  const [clockInPanel,setClockInPanel]=useState(null); // null | "choice" | "manual"
  const [clockOutPanel,setClockOutPanel]=useState(null); // null | "choice" | "manual"
  const [manualInTime,setManualInTime]=useState("");
  const [manualInDate,setManualInDate]=useState(()=>today());
  const [manualOutTime,setManualOutTime]=useState("");
  const [pendingEntries,setPendingEntries]=useState([]); // [{type, label, icon, color}]
  const [editHours,setEditHours]=useState(false); // show edit panel for hours before submit

  // Expense fields
  const [expDate,setExpDate]=useState(today());
  const [expType,setExpType]=useState("");
  const [expAmount,setExpAmount]=useState("");
  const [expCurrency,setExpCurrency]=useState("CAD");
  const [expEvent,setExpEvent]=useState("");
  const [expSubEvent,setExpSubEvent]=useState(""); // optional sub-event for the expense
  const [expDesc,setExpDesc]=useState("");
  const [expFile,setExpFile]=useState(null);
  // Expenses saved locally but not yet submitted. In-memory only (receipt File
  // objects can't be persisted across a page reload), cleared on Submit All.
  const [stagedExpenses,setStagedExpenses]=useState([]);

  const [submitting,setSubmitting]=useState(false);
  const [toast,setToast]=useState({show:false,msg:"",error:false});

  const t = (key,...args) => { const v=T[lang][key]; return typeof v==="function"?v(...args):v; };
  const setLang = (l) => { setLangState(l); localStorage.setItem("cargodx_lang",l); };
  const showToast = (msg,error=false) => { setToast({show:true,msg,error}); setTimeout(()=>setToast(p=>({...p,show:false})),3000); };
  const mins = logStart&&logEnd ? calcMins(logStart,logEnd) : 0;

  // ── Clock in — sets start time + captures GPS silently ──
  const handleClockIn = async () => {
    if(!shiftEvent) { alert(lang==="fr"?"Veuillez sélectionner un événement avant de pointer.":"Please select an event before clocking in."); return; }
    setGpsLoading("in");
    const time = nowTime();
    const date = today();
    setLogStart(time);
    setLogDate(date);
    setClockedIn(true);
    localStorage.setItem("cargodx_clockin_event", shiftEvent);
    localStorage.setItem("cargodx_clockin_start", time);
    localStorage.setItem("cargodx_clockin_date", date);
    const gps = await getGPS();
    setGpsIn(gps);
    setGpsLoading(null);
    // Write live session to Firestore
    if(employee) {
      try {
        await setDoc(doc(db, "sessions", employee.key||employee.email||employee.phone?.replace(/\D/g,"")||employee.name), {
          name: employee.name,
          email: employee.email,
          event: shiftEvent || employee.event || "Daily Operations",
          date,
          clockIn: time,
          clockOut: null,
          truck: logTruck || null,
          trailer: logTrailer || null,
          kmStart: logKmStart || null,
          gpsIn: gps || null,
          status: "active",
          updatedAt: new Date().toISOString(),
        });
        console.log("Session written for", employee.name);
      } catch(e) { console.error("Session write error:", e); }
    }
    showToast(lang==="fr" ? `Entrée enregistrée à ${time}` : `Clocked in at ${time}`);
  };

  // ── Clock out — sets end time + captures GPS silently ──
  // Clear the current in-progress entry — wipes state, localStorage, and the
  // live Firestore session (so it does NOT restore on reload). For junk/mistake
  // entries the employee wants to discard.
  const clearEntry = async () => {
    if(!window.confirm(lang==="fr"?"Effacer l'entrée en cours ? Les heures non soumises seront perdues.":"Clear the current entry? Any unsubmitted hours will be lost.")) return;
    setLogStart(""); setLogEnd(""); setLogNotes(""); setLogTruck(""); setLogTrailer(""); setLogKmStart(""); setLogKmEnd(""); setLogBreak("");
    setGpsIn(null); setGpsOut(null); setClockedIn(false); setEquipAnswer(null);
    setClockInPanel(null); setClockOutPanel(null); setManualInTime(""); setManualOutTime(""); setEditHours(false);
    ["cargodx_clockin_start","cargodx_clockin_end","cargodx_clockin_date","cargodx_clockin_truck",
     "cargodx_clockin_trailer","cargodx_clockin_kmstart","cargodx_clockin_kmend"].forEach(k=>localStorage.removeItem(k));
    if(employee) { try { await deleteDoc(doc(db,"sessions",employee.key||employee.email||employee.phone?.replace(/\D/g,"")||employee.name)); } catch(e) {} }
    showToast(lang==="fr"?"Entrée effacée ✓":"Entry cleared ✓");
  };

  const handleClockOut = async (manualTime) => {
    // Manual time (from the manual panel) or a previous-day entry must NOT be
    // overwritten with the current time, and must NOT capture live GPS (which
    // would be today's location for a past shift). Only a live "Right Now"
    // clock-out on today's date captures GPS.
    const isManual = !!manualTime;
    // A future date is never valid — block it before any prev-day handling.
    if (isFutureDate(logDate)) {
      alert(lang==="fr"
        ? `La date (${logDate}) est dans le futur. Vous ne pouvez pas enregistrer pour une date future.`
        : `The date (${logDate}) is in the future. You cannot log for a future date.`);
      return;
    }
    // "Previous day" means strictly BEFORE today — not merely "not today", so a
    // future date is never treated as a previous-day entry (which would skip the
    // future-time guards below).
    const isPrevDay = logDate < today();
    const time = manualTime || nowTime();
    // Guard: on today's date, a clock-out can't be in the future. (Previous-day
    // entries are exempt — any time that day is valid.) Also can't be before the
    // clock-in time on the same day.
    if (!isPrevDay && time > nowTime()) {
      alert(lang==="fr"
        ? `L'heure de départ (${time}) est dans le futur. Entrez une heure jusqu'à maintenant (${nowTime()}).`
        : `The clock-out time (${time}) is in the future. Enter a time up to now (${nowTime()}).`);
      return;
    }
    if (logStart && !isPrevDay && time < logStart && logStart <= nowTime()) {
      // end before start on the same day is only valid as an overnight shift,
      // which for a same-day (non-previous) entry means crossing midnight into
      // tomorrow — not possible when "now" hasn't reached tomorrow yet.
      if(!window.confirm(lang==="fr"
        ? `L'heure de départ (${time}) est avant l'arrivée (${logStart}). S'agit-il d'un quart de nuit se terminant demain ? Sinon, corrigez.`
        : `Clock-out (${time}) is before clock-in (${logStart}). Is this an overnight shift ending tomorrow? If not, fix it.`)) {
        return;
      }
    }
    setLogEnd(time);
    localStorage.setItem("cargodx_clockin_end", time);
    let gps = null;
    if (!isManual && !isPrevDay) {
      setGpsLoading("out");
      gps = await getGPS();
      setGpsOut(gps);
      setGpsLoading(null);
    }
    // Update live session in Firestore
    if(employee) {
      try {
        const payload = {
          clockOut: time,
          status: "clocked-out",
          updatedAt: new Date().toISOString(),
        };
        if (gps) payload.gpsOut = gps; // never overwrite with null on manual/prev-day
        await setDoc(doc(db, "sessions", employee.key||employee.email||employee.phone?.replace(/\D/g,"")||employee.name), payload, { merge: true });
      } catch(e) { console.error("Session update error:", e); }
    }
    showToast(lang==="fr" ? `Sortie enregistrée à ${time}` : `Clocked out at ${time}`);
    setShowSubmitReminder(true);
  };

  useEffect(()=>{
    if(!document.getElementById("dbx-fonts")){
      const l=document.createElement("link"); l.id="dbx-fonts"; l.rel="stylesheet";
      l.href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap";
      document.head.appendChild(l);
    }
    if(!document.getElementById("dbx-kf")){
      const s=document.createElement("style"); s.id="dbx-kf";
      s.textContent="@keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}} div::-webkit-scrollbar{display:none}";
      document.head.appendChild(s);
    }
    // Fix iPhone white glare at bottom
    document.body.style.background = C.white;
    document.body.style.margin = "0";
    document.documentElement.style.background = C.white;
    // Prevent pull-to-refresh reloading the app (which would reset the active tab)
    document.body.style.overscrollBehaviorY = "contain";
    document.documentElement.style.overscrollBehaviorY = "contain";
    // Setup push notifications for returning users
    if(employee) setupPushNotifications(employee);

    // ── Session sync on page load/refresh ──
    if(employee) {
      const keysToTry = [
        employee.email?.trim(),
        employee.phone?.trim().replace(/\D/g,""),
        employee.key?.trim(),
        employee.name?.trim().replace(/\s/g,"").toLowerCase(),
      ].filter(Boolean);
      (async () => {
        for(const k of keysToTry) {
          try {
            const snap = await getDoc(doc(db,"sessions",k));
            if(!snap.exists()) continue;
            const s = snap.data();
            if(!s.clockIn && !s.truck) continue;
            if(s.clockIn) { setLogStart(s.clockIn); localStorage.setItem("cargodx_clockin_start",s.clockIn); setClockedIn(true); }
            else { setLogStart(""); localStorage.removeItem("cargodx_clockin_start"); setClockedIn(false); }
            if(s.clockOut) { setLogEnd(s.clockOut); localStorage.setItem("cargodx_clockin_end",s.clockOut); }
            else { setLogEnd(""); localStorage.removeItem("cargodx_clockin_end"); }
            if(s.date) { setLogDate(s.date); localStorage.setItem("cargodx_clockin_date",s.date); }
            else { setLogDate(today()); localStorage.removeItem("cargodx_clockin_date"); }
            if(s.truck) { setLogTruck(s.truck); localStorage.setItem("cargodx_clockin_truck",s.truck); }
            else { setLogTruck(""); localStorage.removeItem("cargodx_clockin_truck"); }
            if(s.trailer) { setLogTrailer(s.trailer); localStorage.setItem("cargodx_clockin_trailer",s.trailer); }
            else { setLogTrailer(""); localStorage.removeItem("cargodx_clockin_trailer"); }
            if(s.kmStart!=null) { setLogKmStart(String(s.kmStart)); localStorage.setItem("cargodx_clockin_kmstart",String(s.kmStart)); }
            else { setLogKmStart(""); localStorage.removeItem("cargodx_clockin_kmstart"); }
            if(s.kmEnd!=null) { setLogKmEnd(String(s.kmEnd)); localStorage.setItem("cargodx_clockin_kmend",String(s.kmEnd)); }
            else { setLogKmEnd(""); localStorage.removeItem("cargodx_clockin_kmend"); }
            if(s.event) { setShiftEvent(s.event); localStorage.setItem("cargodx_clockin_event",s.event); }
            else { setShiftEvent(""); localStorage.removeItem("cargodx_clockin_event"); }
            if(s.unitLog?.length>0) { setUnitLog(s.unitLog); localStorage.setItem("cargodx_unitlog",JSON.stringify(s.unitLog)); }
            else { setUnitLog([]); localStorage.removeItem("cargodx_unitlog"); }
            break; // found a valid session, stop trying
          } catch(e) { console.error("Session sync error:",e); }
        }
      })();
    }

    // Real-time events listener — always fresh. Wait for the anonymous auth
    // token before attaching, or the tightened rules deny the first read.
    let unsubEvents = () => {};
    authReadyPromise.then(() => {
      unsubEvents = onSnapshot(collection(db,"events"), (snap) => {
      const docs = snap.docs.map(d=>({id:d.id,...d.data()})).filter(d=>d.name&&d.active!==false);
      setAllEvents(docs);
      const loaded = docs.map(d=>d.name);
      const dailyOps = "Daily Operations";
      const withoutDaily = loaded.filter(e=>e!==dailyOps&&e!=="Opérations quotidiennes");
      setEvents([dailyOps, ...withoutDaily]);
      const cur = localStorage.getItem("cargodx_clockin_event");
      if(cur) { const evObj=docs.find(a=>a.name===cur); setEventAllowsNw(!!(evObj?.allowNwDays)); setEventAllowsPerDiem(!!(evObj?.allowPerDiem)); setEventAllowsHours(evObj?.allowHours!==false); setEventAllowsDaily(!!(evObj?.allowDaily)); setEventAllowsExpenses(evObj?.allowExpenses!==false); setEventAllowsTrips(!!(evObj?.allowTrips)); setSubEventOptions((Array.isArray(evObj?.subEvents)?evObj.subEvents:[]).filter(s=>!(evObj?.archivedSubEvents||[]).includes(s))); }
      }, e=>{console.error("Events error:",e);setEvents(["Daily Operations"]);});
    });
    return () => unsubEvents();
  },[]);

  const loadData = async () => {
    await authReadyPromise; // don't read before the anon token exists
    if(!employee) return;
    setLoadingData(true);
    try {
      const filters = [];
      if(employee.email) filters.push(where("employeeEmail","==",employee.email));
      if(employee.phone) filters.push(where("employeePhone","==",employee.phone.replace(/\D/g,"")));
      if(employee.name) filters.push(where("employeeName","==",employee.name));
      if(filters.length===0) { setLoadingData(false); return; }

      const merge = (snaps) => {
        const seen = new Set();
        return snaps.flatMap(s=>s.docs)
          .filter(d=>{ if(seen.has(d.id)) return false; seen.add(d.id); return true; })
          .map(d=>({id:d.id,...d.data()}));
      };

      const [tsSnaps, exSnaps, docSnaps] = await Promise.all([
        Promise.all(filters.map(f=>getDocs(query(collection(db,"timesheets"),f)))),
        Promise.all(filters.map(f=>getDocs(query(collection(db,"expenses"),f)))),
        Promise.all(filters.map(f=>getDocs(query(collection(db,"employee_documents"),f)))),
      ]);

      setLogs(merge(tsSnaps).sort((a,b)=>(b.date||"").localeCompare(a.date||"")));
      setExpenses(merge(exSnaps).sort((a,b)=>(b.date||"").localeCompare(a.date||"")));
      setEmpDocs(merge(docSnaps));
    } catch(e){console.error("loadData error:",e);}
    setLoadingData(false);
  };

  const setupPushNotifications = async (emp) => {
    if(!messaging) return;
    try {
      const permission = await Notification.requestPermission();
      if(permission !== 'granted') return;
      // Register service worker
      const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if(token) {
        // Save FCM token to employee record
        const empDocKey = emp.key||emp.email||emp.phone?.replace(/\D/g,"")||emp.name?.replace(/\s/g,"").toLowerCase();
        if(empDocKey) await setDoc(doc(db, "employees", empDocKey), { fcmToken: token }, { merge: true });
        console.log('Push notifications enabled');
      }
    } catch(e) { console.log('Push setup failed:', e); }
  };

  const restoreFromDevice = async () => {
    if(!employee) return;
    const keysToTry = [
      employee.email?.trim(),
      employee.phone?.trim().replace(/\D/g,""),
      employee.key?.trim(),
      employee.name?.trim().replace(/\s/g,"").toLowerCase(),
    ].filter(Boolean);
    if(!keysToTry.length) return;
    try {
      let snap = null;
      for(const k of keysToTry) {
        const s = await getDoc(doc(db,"sessions",k));
        if(s.exists() && (s.data().clockIn || s.data().truck)) { snap = s; break; }
      }
      if(!snap) {
        const nameSnap = await getDocs(query(collection(db,"sessions"), where("name","==",employee.name?.trim())));
        if(!nameSnap.empty) {
          const found = nameSnap.docs.find(d => d.data().clockIn || d.data().truck);
          if(found) snap = found;
        }
      }
      if(!snap) { showToast(lang==="fr"?"Aucune session active trouvée":"No active session found", true); return; }
      const s = snap.data();
      if(s.clockIn) { setLogStart(s.clockIn); localStorage.setItem("cargodx_clockin_start",s.clockIn); setClockedIn(true); }
      if(s.clockOut) { setLogEnd(s.clockOut); localStorage.setItem("cargodx_clockin_end",s.clockOut); }
      if(s.date) { setLogDate(s.date); localStorage.setItem("cargodx_clockin_date",s.date); }
      if(s.truck) { setLogTruck(s.truck); localStorage.setItem("cargodx_clockin_truck",s.truck); }
      if(s.trailer) { setLogTrailer(s.trailer); localStorage.setItem("cargodx_clockin_trailer",s.trailer); }
      if(s.kmStart!=null) { setLogKmStart(String(s.kmStart)); localStorage.setItem("cargodx_clockin_kmstart",String(s.kmStart)); }
      if(s.kmEnd!=null) { setLogKmEnd(String(s.kmEnd)); localStorage.setItem("cargodx_clockin_kmend",String(s.kmEnd)); }
      if(s.event) { setShiftEvent(s.event); localStorage.setItem("cargodx_clockin_event",s.event); }
      if(s.unitLog?.length>0) { setUnitLog(s.unitLog); localStorage.setItem("cargodx_unitlog",JSON.stringify(s.unitLog)); }
      setTab(2);
      showToast(lang==="fr"?"Session restaurée ✓":"Session restored ✓");
    } catch(e) { console.error(e); showToast(lang==="fr"?"Erreur":"Error", true); }
  };

  const doLogout = () => {
    if(!window.confirm(lang==="fr"?"Se déconnecter ? Vos données sauvegardées seront effacées de cet appareil.":"Log out? Your saved profile will be cleared from this device.")) return;
    setEmployee(null);
    localStorage.removeItem("cargodx_employee");
    localStorage.removeItem("cargodx_last_activity");
    localStorage.removeItem("cargodx_clockin_start");
    localStorage.removeItem("cargodx_clockin_end");
    localStorage.removeItem("cargodx_clockin_date");
    localStorage.removeItem("cargodx_clockin_truck");
    localStorage.removeItem("cargodx_clockin_trailer");
    localStorage.removeItem("cargodx_clockin_kmstart");
    localStorage.removeItem("cargodx_clockin_kmend");
    localStorage.removeItem("cargodx_tab");
    setTab(1);
    setRegEmpId(""); setRegPin(""); setLoginError("");
    setClockedIn(false); setLogStart(""); setLogEnd("");
  };

  const goTab = (n) => {
    // Security: must be registered (PIN-verified) to access any tab beyond registration
    if(!employee && n!==1){ setTab(1); return; }
    // Per-person restriction: block the daily-log workflow (tabs 2-4) entirely.
    if(employee && employee.logRestricted === true && n>=2 && n<=4){ setTab(5); return; }
    if(employee && employee.driverLog === true && (n===3 || n===4)){ setTab(2); return; }
    // Ground crew (Employee, not Driver) can't reach Orders or Equipment.
    if(isGroundCrew && (n===5 || n===6)){ setTab(2); return; }
    setTab(n); setSelEquip(null);
    if(n===4) setTimeout(()=>loadData(), 800);
    if(n===5) loadOrders();
    if(n===6) loadEquipment();
    if(n===7) loadCompanyDocs();
  };

  // ── One-time drvId patch for sessions saved before June 2026 ──
  // If employee is restored from localStorage but has no drvId (old session format),
  // silently look it up from the drivers collection so order matching works.
  useEffect(() => {
    if (!savedEmployee) return;
    (async () => {
      try {
        await authReadyPromise; // wait for anon token before reading drivers
        const empKey = String(savedEmployee.employeeId || savedEmployee.key || "").trim().toLowerCase();
        if (!empKey) return;
        const snap = await getDocs(collection(db, "drivers"));
        const match = snap.docs.find(d =>
          String(d.data().employeeId || "").trim().toLowerCase() === empKey
        );
        if (match) {
          // Archived after they logged in — kick the cached session so they
          // can't keep creating entries. Record kept for history only.
          if (match.data().archived === true) {
            ["cargodx_employee","cargodx_clockin_start","cargodx_clockin_end","cargodx_clockin_date",
             "cargodx_clockin_truck","cargodx_clockin_trailer","cargodx_clockin_kmstart","cargodx_clockin_kmend",
             "cargodx_clockin_event","cargodx_clockin_break","cargodx_unitlog","cargodx_tab","cargodx_last_activity"].forEach(k=>localStorage.removeItem(k));
            setEmployee(null);
            setTab(1);
            return;
          }
          // Sync drvId and the live log-restriction flag from the driver record,
          // so an admin toggling access takes effect on the next app open.
          const restricted = match.data().logRestricted === true;
          const driverLog = match.data().driverLog === true;
          const needsUpdate = !savedEmployee.drvId || savedEmployee.logRestricted !== restricted || savedEmployee.driverLog !== driverLog;
          if (needsUpdate) {
            const updated = { ...savedEmployee, drvId: match.id, logRestricted: restricted, driverLog };
            setEmployee(updated);
            localStorage.setItem("cargodx_employee", JSON.stringify(updated));
          }
        }
      } catch(e) { console.error("driver refresh failed:", e); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if(tab !== 5) return;
    const interval = setInterval(loadOrders, 30000);
    return () => clearInterval(interval);
  }, [tab]);

  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [trucks, setTrucks] = useState([]);
  const [trailers, setTrailers] = useState([]);
  const [companyDocs, setCompanyDocs] = useState([]);
  const [sharedDocs, setSharedDocs] = useState([]); // company → this driver (driver_shared_docs)
  const [equipLoading, setEquipLoading] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [equipError, setEquipError] = useState("");
  const [docsError, setDocsError] = useState("");
  const [equipTab, setEquipTab] = useState("trucks");
  const [selEquip, setSelEquip] = useState(null);
  const [equipSearch, setEquipSearch] = useState("");
  const [docsSearch, setDocsSearch] = useState("");
  const [podOrderId, setPodOrderId] = useState(null);
  const [podStopKey, setPodStopKey] = useState(null); // `${orderId}:${stopIdx}` when entering per-stop POD
  const [podReceiver, setPodReceiver] = useState("");
  const [podNote, setPodNote] = useState("");
  const [podDate, setPodDate] = useState("");
  const [podTime, setPodTime] = useState("");
  const [orderNote, setOrderNote] = useState({});

  const loadOrders = async () => {
    if(!employee) return;
    setOrdersLoading(true);
    setOrdersError("");
    try {
      const snap = await getDocs(query(
        collection(db, "orders"),
        where("status", "in", ["assigned", "in-transit"])
      ));
      const all = snap.docs.map(d => ({id: d.id, ...d.data()}));
      const myEmail = (employee.email||"").trim().toLowerCase();
      const myPhone = (employee.phone||"").replace(/\D/g,"");
      const myName  = (employee.name||"").trim().toLowerCase();
      const myDrvId = employee.drvId || employee.driverId || "";
      // Build the set of driver-identity tuples on an order (primary + extra drivers)
      const orderDrivers = (o) => [
        {id:o.drvId, name:o.drvName, email:o.drvEmail, phone:o.drvPhone},
        ...(o.extraDrivers||[]).map(d=>({id:d.drvId, name:d.drvName, email:d.drvEmail, phone:d.drvPhone}))
      ];
      const mine = all.filter(o => {
        if(o.pushToApp === false) return false; // skip orders not pushed to app
        return orderDrivers(o).some(d => {
          if(!d) return false;
          // 1. Driver ID match (most reliable)
          if(myDrvId && d.id && d.id===myDrvId) return true;
          // 2. Email match (reliable, login-independent)
          if(myEmail && d.email && d.email.trim().toLowerCase()===myEmail) return true;
          // 3. Phone match
          if(myPhone && d.phone && d.phone.replace(/\D/g,"")===myPhone) return true;
          // 4. Name match (fallback — fuzzy, case-insensitive partial)
          if(myName && d.name){ const dn=d.name.trim().toLowerCase(); if(dn.includes(myName)||myName.includes(dn)) return true; }
          return false;
        });
      });
      setOrders(mine);
    } catch(e) {
      console.error("loadOrders error:", e);
      setOrdersError(e.message || "Failed to load orders");
    }
    setOrdersLoading(false);
  };


  const loadEquipment = async () => {
    await authReadyPromise; // don't read before the anon token exists
    setEquipLoading(true);
    setEquipError("");
    try {
      const [truckSnap, trailerSnap] = await Promise.all([
        getDocs(collection(db, "trucks")),
        getDocs(collection(db, "trailers")),
      ]);
      setTrucks(truckSnap.docs.map(d=>({id:d.id,...d.data()})));
      setTrailers(trailerSnap.docs.map(d=>({id:d.id,...d.data()})));
    } catch(e) { console.error(e); setEquipError(e.message||"Failed to load equipment"); }
    setEquipLoading(false);
  };

  const loadCompanyDocs = async () => {
    await authReadyPromise; // don't read before the anon token exists
    setDocsLoading(true);
    setDocsError("");
    try {
      const snap = await getDocs(query(collection(db, "company_docs"), orderBy("uploadedAt","desc")));
      // Only show docs visible to all employees — filter out management-only docs
      setCompanyDocs(snap.docs.map(d=>({id:d.id,...d.data()})).filter(d => d.visibility !== "management"));
    } catch(e) {
      console.error(e);
      // Try without orderBy in case index is missing
      try {
        const snap2 = await getDocs(collection(db, "company_docs"));
        setCompanyDocs(snap2.docs.map(d=>({id:d.id,...d.data()})).filter(d => d.visibility !== "management"));
      } catch(e2) { setDocsError(e2.message||"Failed to load documents"); }
    }
    setDocsLoading(false);
  };

  // Company → this driver: docs dispatch shared, keyed by employeeId
  // (trimmed+lowercased — the same key login matches on). Read-only here.
  const loadSharedDocs = async () => {
    await authReadyPromise; // don't read before the anon token exists
    const empKey = String(employee?.employeeId || "").trim().toLowerCase();
    if (!empKey) { setSharedDocs([]); return; }
    try {
      const snap = await getDocs(query(collection(db, "driver_shared_docs"), where("employeeId", "==", empKey)));
      setSharedDocs(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.uploadedAt||0)-(a.uploadedAt||0)));
    } catch(e) { console.error("shared docs load failed:", e); }
  };

  const updateOrderStatus = async (orderId, newStatus) => {
    try {
      await setDoc(doc(db, "orders", orderId), { status: newStatus }, { merge: true });
      setOrders(prev => prev.map(o => o.id === orderId ? {...o, status: newStatus} : o));
      showToast(lang === "fr" ? "Statut mis à jour!" : "Status updated!");
    } catch(e) { console.error(e); showToast(lang === "fr" ? "Erreur" : "Error", true); }
  };

  const submitPod = async (orderId) => {
    if(!podReceiver.trim()) return;
    try {
      const now = new Date();
      const finalDate = podDate || now.toISOString().split("T")[0];
      const finalTime = podTime || now.toTimeString().slice(0,5);
      await setDoc(doc(db, "orders", orderId), {
        podBy: podReceiver.trim(),
        podDate: finalDate,
        podTime: finalTime,
        status: "ready-to-bill",
        ...(podNote.trim() ? {podNote: podNote.trim()} : {})
      }, { merge: true });
      setOrders(prev => prev.filter(o => o.id !== orderId));
      setPodOrderId(null); setPodReceiver(""); setPodNote(""); setPodDate(""); setPodTime("");
      showToast(lang === "fr" ? "POD soumis! Commande complétée ✓" : "POD submitted! Order completed ✓");
    } catch(e) { console.error(e); showToast(lang === "fr" ? "Erreur" : "Error", true); }
  };

  // Per-stop POD: write pod onto the chosen stop, DO NOT change order status (dispatch decides billing)
  const submitStopPod = async (order, side, stopIdx) => {
    if(!podReceiver.trim()) return;
    try {
      const now = new Date();
      const finalDate = podDate || now.toISOString().split("T")[0];
      const finalTime = podTime || now.toTimeString().slice(0,5);
      const arr = [...(order[side]||[])];
      arr[stopIdx] = {...arr[stopIdx], pod: {by: podReceiver.trim(), date: finalDate, time: finalTime, ...(podNote.trim()?{note:podNote.trim()}:{})}};
      await setDoc(doc(db, "orders", order.id), { [side]: arr }, { merge: true });
      // Update local list so progress reflects immediately (keep order visible — status unchanged)
      setOrders(prev => prev.map(o => o.id===order.id ? {...o, [side]: arr} : o));
      setPodStopKey(null); setPodReceiver(""); setPodNote(""); setPodDate(""); setPodTime("");
      showToast(lang === "fr" ? "POD enregistré ✓" : "POD recorded ✓");
    } catch(e) { console.error(e); showToast(lang === "fr" ? "Erreur" : "Error", true); }
  };

  const submitNote = async (orderId) => {
    const note = orderNote[orderId];
    if(!note?.trim()) return;
    try {
      const o = orders.find(x => x.id === orderId);
      const existing = o?.notes || "";
      const newNote = existing ? `${existing}\n[${employee.name}] ${note.trim()}` : `[${employee.name}] ${note.trim()}`;
      await setDoc(doc(db, "orders", orderId), { notes: newNote }, { merge: true });
      setOrders(prev => prev.map(x => x.id === orderId ? {...x, notes: newNote} : x));
      setOrderNote(prev => ({...prev, [orderId]: ""}));
      showToast(lang === "fr" ? "Note ajoutée!" : "Note added!");
    } catch(e) { console.error(e); }
  };

  // Upload a single document file to Storage, return { url, name, path }
  const loadEmpDocs = async () => {
    await authReadyPromise; // don't read before the anon token exists
    if (!employee) return;
    try {
      const snap = await getDoc(doc(db, "employees", employee.key));
      if (snap.exists()) {
        setEmpDocs(snap.data().documents || []);
      }
    } catch(e) { console.error(e); }
  };

  const uploadDoc = async (file, employeeEmail, docId) => {
    const path=`employee_docs/${employeeEmail}/${docId}_${Date.now()}_${file.name}`;
    const sRef=storageRef(storage,path);
    await uploadBytes(sRef,file);
    const url=await getDownloadURL(sRef);
    return { url, name:file.name, path };
  };

  // Check Firestore for an active session when employee identifies themselves
  const checkForActiveSession = async (empKey) => {
    if(!empKey) return null;
    try {
      const snap = await getDoc(doc(db, "sessions", empKey));
      if(snap.exists()) {
        const session = snap.data();
        if(session.status === "active" && session.clockIn) return session;
      }
    } catch(e) { console.error(e); }
    return null;
  };

  const resumeSession = (emp, session) => {
    localStorage.removeItem("cargodx_last_activity");
    setEmployee(emp);
    localStorage.setItem("cargodx_employee", JSON.stringify(emp));
    // Update session doc with name in case it was missing
    const sessKey = emp.key||emp.email||emp.phone?.replace(/\D/g,"")||emp.name;
    if(sessKey) {
      setDoc(doc(db,"sessions",sessKey), {
        name: emp.name,
        email: emp.email||null,
        phone: emp.phone||null,
        event: session.event||emp.event||"Daily Operations",
        updatedAt: new Date().toISOString(),
      }, { merge: true }).catch(()=>{});
    }
    // Restore all session fields to localStorage
    if(session.clockIn) { setLogStart(session.clockIn); localStorage.setItem("cargodx_clockin_start", session.clockIn); setClockedIn(true); }
    if(session.clockOut) { setLogEnd(session.clockOut); localStorage.setItem("cargodx_clockin_end", session.clockOut); }
    if(session.date) { setLogDate(session.date); localStorage.setItem("cargodx_clockin_date", session.date); }
    if(session.truck) { setLogTruck(session.truck); localStorage.setItem("cargodx_clockin_truck", session.truck); }
    if(session.trailer) { setLogTrailer(session.trailer); localStorage.setItem("cargodx_clockin_trailer", session.trailer); }
    if(session.kmStart) { setLogKmStart(String(session.kmStart)); localStorage.setItem("cargodx_clockin_kmstart", String(session.kmStart)); }
    if(session.kmEnd) { setLogKmEnd(String(session.kmEnd)); localStorage.setItem("cargodx_clockin_kmend", String(session.kmEnd)); }
    if(session.event) { setShiftEvent(session.event); localStorage.setItem("cargodx_clockin_event", session.event); }
    if(session.unitLog) { setUnitLog(session.unitLog); localStorage.setItem("cargodx_unitlog", JSON.stringify(session.unitLog)); }
    setActiveSession(null);
    showToast(lang==="fr"?"Session reprise ✓":"Session resumed ✓");
    goTab(2);
  };

  // Submit documents independently from registration
  const submitDocs = async () => {
    if (!employee) return;
    const hasAny = DOC_TYPES.some(dt => docFiles[dt.id]) || (docFiles["other"] && otherLabel.trim());
    if (!hasAny) { showToast(t("myDocsNoneSelected"), true); return; }
    setDocSubmitting(true);
    try {
      const existingDocs = [...empDocs];
      const updatedDocs = [...existingDocs];
      for (const dt of DOC_TYPES) {
        const file = docFiles[dt.id];
        if (!file) continue;
        const label = dt.id === "other" ? otherLabel.trim() : (lang === "fr" ? dt.label_fr : dt.label_en);
        const { url, name } = await uploadDoc(file, employee.email || employee.key, dt.id);
        const idx = updatedDocs.findIndex(d => d.docId === dt.id);
        const entry = { docId: dt.id, label, fileName: name, url, uploadedAt: new Date().toISOString() };
        if (idx >= 0) updatedDocs[idx] = entry;
        else updatedDocs.push(entry);
      }
      await setDoc(doc(db, "employees", employee.key), { documents: updatedDocs }, { merge: true });
      setEmpDocs(updatedDocs);
      setDocFiles({});
      showToast(t("myDocsSuccess"));
    } catch(e) { console.error(e); showToast(t("toastErr"), true); }
    setDocSubmitting(false);
  };

  const register = async () => {
    const empId = regEmpId.trim();
    const pin = regPin.trim();
    setLoginError("");

    if(!empId || !pin) { setLoginError(t("loginErrEmpty")); return; }

    setSubmitting(true);
    try {
      await authReadyPromise; // ensure anon token exists before the rules-gated read
      // Look up driver by employeeId field
      const driversSnap = await getDocs(collection(db,"drivers"));
      const driverMatch = driversSnap.docs.find(d => {
        const data = d.data();
        return String(data.employeeId||"").trim().toLowerCase() === empId.toLowerCase();
      });

      if(!driverMatch) {
        setLoginError(t("loginErrNotFound"));
        setSubmitting(false);
        return;
      }

      const driverData = driverMatch.data();
      const driverPin = String(driverData.pin||"").trim();

      // Verify PIN
      if(driverPin && pin !== driverPin) {
        setLoginError(t("loginErrPin"));
        setRegPin("");
        setSubmitting(false);
        return;
      }

      // Archived people can't log in — record kept for history only, no new
      // sessions/entries. (Dispatch assignment dropdown also excludes them.)
      if(driverData.archived === true) {
        setLoginError(t("loginErrArchived"));
        setSubmitting(false);
        return;
      }

      // PIN correct (or no PIN set) — build employee profile from driver record
      const emp = {
        name: driverData.name || empId,
        phone: driverData.phone || "",
        email: driverData.email || "",
        employeeId: empId,
        drvId: driverMatch.id,        // driver roster doc ID — matches order.drvId set in dispatch
        event: regEvent,
        key: empId.toLowerCase().replace(/\s/g,""),
        payCfg: driverData.payCfg || null,
        logRestricted: driverData.logRestricted === true,
        driverLog: driverData.driverLog === true,
        isDriver: driverData.isDriver !== false,   // default true, matches dispatch
        isEmployee: driverData.isEmployee === true, // ground crew flag
      };

      // Check for active session on another device
      const existingSession = await checkForActiveSession(emp.key);
      if(existingSession) {
        setActiveSession({emp, session:existingSession});
        setSubmitting(false);
        return;
      }

      // Finalize registration
      await finalizeRegistration(emp, driverMatch);

    } catch(e){ console.error(e); showToast(t("toastErr"),true); }
    setSubmitting(false);
  };

  // Completes registration: uploads docs, saves employee profile, syncs driver record.
  // Called either directly (no PIN) or after successful PIN verification.
  const finalizeRegistration = async (emp, driverMatch) => {
    // Upload any attached docs
    const uploadedDocs = [];
    for(const dt of DOC_TYPES){
      const file=docFiles[dt.id];
      if(!file) continue;
      const label = dt.id==="other" ? otherLabel.trim() : (lang==="fr"?dt.label_fr:dt.label_en);
      const { url, name } = await uploadDoc(file, emp.email, dt.id);
      uploadedDocs.push({ docId:dt.id, label, fileName:name, url, uploadedAt:new Date().toISOString() });
    }

    // Save employee profile to Firestore — include payCfg from drivers if found
    await setDoc(doc(db,"employees",emp.key), {
      ...emp,
      registeredAt: new Date().toISOString(),
      documents: uploadedDocs,
    }, { merge:true });

    // Also update drivers doc with latest phone/email if we found a match
    if(driverMatch) {
      try {
        await setDoc(doc(db,"drivers",driverMatch.id), {
          phone: emp.phone||driverMatch.data().phone,
          email: emp.email||driverMatch.data().email,
        }, { merge:true });
      } catch(e){ console.warn("Driver sync failed:", e); }
    }

    localStorage.removeItem("cargodx_last_activity");
    setEmployee(emp);
    localStorage.setItem("cargodx_employee",JSON.stringify(emp));
    showToast(t("toastRegOk"));
    setupPushNotifications(emp);
    goTab(2);
  };

  // Verifies the entered PIN against the matched driver's PIN.
  const verifyPin = async () => {
    if(!pinPrompt) return;
    const entered = pinInput.trim();
    if(!entered) { setPinError(t("pinEmpty")); return; }
    if(entered !== pinPrompt.driverPin) {
      setPinError(t("pinWrong"));
      setPinInput("");
      return;
    }
    // PIN correct
    setSubmitting(true);
    setPinError("");
    try {
      if(pinPrompt.pendingSession) {
        // Resume an existing active session
        const emp = pinPrompt.emp;
        const session = pinPrompt.pendingSession;
        setPinPrompt(null);
        setPinInput("");
        resumeSession(emp, session);
      } else {
        // Finalize a fresh registration
        await finalizeRegistration(pinPrompt.emp, pinPrompt.driverMatch);
        setPinPrompt(null);
        setPinInput("");
      }
    } catch(e){ console.error(e); showToast(t("toastErr"),true); }
    setSubmitting(false);
  };

  const cancelPin = () => {
    setPinPrompt(null);
    setPinInput("");
    setPinError("");
    setSubmitting(false);
  };


  const hasDayEntry = async (type) => {
    try {
      const snap = await getDocs(query(collection(db,"timesheets"), where("employeeEmail","==",employee.email), where("date","==",logDate)));
      if(type==="hours") {
        // Any entry with real start/end times that isn't a day-type entry
        return snap.docs.some(d => {
          const e = d.data();
          return e.startTime && e.endTime && e.startTime!=="00:00" && !["non-working","per-diem","working-day"].includes(e.dayType);
        });
      }
      return snap.docs.some(d => {
        const data = d.data();
        return data.employeeEmail === employee.email && data.date === logDate && data.event === (shiftEvent||employee.event) && data.dayType === type;
      });
    } catch(e) { return false; }
  };

  const submitNwDay = async () => {
    if(!employee) { alert(t("alertReg")); return; }
    if(isFutureDate(logDate)) { alert(lang==="fr"?`La date (${logDate}) est dans le futur. Vous ne pouvez pas enregistrer un jour pour une date future.`:`The date (${logDate}) is in the future. You cannot register a day for a future date.`); return; }
    if(await hasDayEntry("non-working")) { alert(lang==="fr"?"Journée non travaillée déjà enregistrée pour cette date.":"Non-working day already registered for this date."); return; }
    if(await hasDayEntry("working-day")) { alert(lang==="fr"?"Une journée de travail existe déjà pour cette date.":"A working day already exists for this date."); return; }
    if(await hasDayEntry("hours")) { alert(lang==="fr"?"Des heures existent déjà pour cette date. Un jour non travaillé ne peut pas coexister avec des heures.":"Hours already exist for this date. A non-working day cannot coexist with hours."); return; }
    if(!shiftEvent) { alert(lang==="fr"?"Veuillez sélectionner un événement.":"Please select an event."); return; }
    if(!window.confirm(lang==="fr"?`Enregistrer un jour NON TRAVAILLÉ pour ${logDate} — ${shiftEvent} ?`:`Register a NON-WORKING day for ${logDate} — ${shiftEvent}?`)) return;
    try {
      await addDoc(collection(db,"timesheets"),{
        employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email,
        event:shiftEvent||employee.event, subEvent:shiftSubEvent||null, date:logDate,
        startTime:"00:00", endTime:"00:00", hours:0,
        notes:lang==="fr"?"Jour non travaillé":"Non-working day",
        dayType:"non-working", submittedAt:new Date().toISOString()
      });
      showToast(lang==="fr"?"Jour non travaillé enregistré ✓":"Non-working day registered ✓");
      setShowNwPanel(false);
    } catch(e) { console.error(e); showToast(lang==="fr"?"Erreur":"Error",true); }
  };

  const submitPerDiem = async () => {
    if(!employee) { alert(t("alertReg")); return; }
    if(isFutureDate(logDate)) { alert(lang==="fr"?`La date (${logDate}) est dans le futur. Vous ne pouvez pas enregistrer un jour pour une date future.`:`The date (${logDate}) is in the future. You cannot register a day for a future date.`); return; }
    if(await hasDayEntry("per-diem")) { alert(lang==="fr"?"Per diem déjà enregistré pour cette date.":"Per diem already registered for this date."); return; }
    if(!shiftEvent) { alert(lang==="fr"?"Veuillez sélectionner un événement.":"Please select an event."); return; }
    if(!window.confirm(lang==="fr"?`Enregistrer un PER DIEM pour ${logDate} — ${shiftEvent} ?`:`Register a PER DIEM day for ${logDate} — ${shiftEvent}?`)) return;
    try {
      await addDoc(collection(db,"timesheets"),{
        employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email,
        event:shiftEvent||employee.event, subEvent:shiftSubEvent||null, date:logDate,
        startTime:"00:00", endTime:"00:00", hours:0,
        notes:lang==="fr"?"Per diem":"Per diem",
        dayType:"per-diem", numPerDiem:1, submittedAt:new Date().toISOString()
      });
      showToast(lang==="fr"?"Per diem enregistré ✓":"Per diem registered ✓");
    } catch(e) { console.error(e); showToast(lang==="fr"?"Erreur":"Error",true); }
  };

  const submitTrip = async () => {
    if(!employee) { alert(t("alertReg")); return; }
    if(!shiftEvent) { alert(lang==="fr"?"Veuillez sélectionner un événement.":"Please select an event."); return; }
    const tripCount = prompt(lang==="fr"?"Combien de trajets avez-vous fait aujourd'hui?":"How many trips did you make today?", "1");
    if(!tripCount || isNaN(tripCount) || parseInt(tripCount) <= 0) return;
    try {
      await addDoc(collection(db,"timesheets"),{
        employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email,
        event:shiftEvent||employee.event, subEvent:shiftSubEvent||null, date:logDate,
        startTime:"00:00", endTime:"00:00", hours:0,
        notes:lang==="fr"?tripCount+" trajet(s)":tripCount+" trip(s)",
        dayType:"trip", numTrips:parseInt(tripCount), submittedAt:new Date().toISOString()
      });
      showToast(lang==="fr"?tripCount+" trajet(s) enregistré(s) ✓":tripCount+" trip(s) registered ✓");
    } catch(e) { console.error(e); showToast(lang==="fr"?"Erreur":"Error",true); }
  };

  const submitWorkDay = async () => {
    if(!employee) { alert(t("alertReg")); return; }
    if(isFutureDate(logDate)) { alert(lang==="fr"?`La date (${logDate}) est dans le futur. Vous ne pouvez pas enregistrer un jour pour une date future.`:`The date (${logDate}) is in the future. You cannot register a day for a future date.`); return; }
    if(await hasDayEntry("working-day")) { alert(lang==="fr"?"Journée de travail déjà enregistrée pour cette date.":"Working day already registered for this date."); return; }
    if(await hasDayEntry("non-working")) { alert(lang==="fr"?"Une journée non travaillée existe déjà pour cette date.":"A non-working day already exists for this date."); return; }
    if(await hasDayEntry("hours")) { alert(lang==="fr"?"Des heures existent déjà pour cette date. Une journée de travail ne peut pas coexister avec des heures.":"Hours already exist for this date. A working day cannot coexist with hours."); return; }
    if(!shiftEvent) { alert(lang==="fr"?"Veuillez sélectionner un événement.":"Please select an event."); return; }
    if(!window.confirm(lang==="fr"?`Enregistrer une JOURNÉE DE TRAVAIL pour ${logDate} — ${shiftEvent} ?`:`Register a WORKING DAY for ${logDate} — ${shiftEvent}?`)) return;
    try {
      await addDoc(collection(db,"timesheets"),{
        employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email,
        event:shiftEvent||employee.event, subEvent:shiftSubEvent||null, date:logDate,
        startTime:"00:00", endTime:"00:00", hours:0,
        notes:lang==="fr"?"Journée de travail":"Working day",
        dayType:"working-day", numDays:1, submittedAt:new Date().toISOString()
      });
      showToast(lang==="fr"?"Journée enregistrée ✓":"Working day registered ✓");
    } catch(e) { console.error(e); showToast(lang==="fr"?"Erreur":"Error",true); }
  };

  const submitDay = async () => {
    if(!employee){alert(t("alertFill"));goTab(1);return;}
    if(!logDate||!logStart||!logEnd){alert(t("alertFill"));return;}
    // Always use clock-in date — never today() for overnight shifts
    const entryDate = localStorage.getItem("cargodx_clockin_date") || logDate;
    if(isFutureDate(entryDate)) { alert(lang==="fr"?`La date (${entryDate}) est dans le futur. Vous ne pouvez pas enregistrer des heures pour une date future.`:`The date (${entryDate}) is in the future. You cannot log hours for a future date.`); return; }
    if(mins<=0){alert(t("alertTime"));return;}
    setSubmitting(true);
    try {
      const breakMins = logBreak&&!logBreak.startsWith("START:") ? parseFloat(logBreak)||0 : 0;
      const netMins = mins - breakMins;
      if(netMins<1){alert(t("alertTime"));setSaving(false);return;}
      // Day-type conflict check — hours cannot coexist with working-day or non-working entries
      try {
        const daySnap = await getDocs(query(collection(db,"timesheets"), where("employeeEmail","==",employee.email), where("date","==",entryDate)));
        const hasWorkingDay = daySnap.docs.some(d => { const e=d.data(); return (parseFloat(e.numDays)||0)>0 || e.dayType==="working-day"; });
        const hasNonWorking = daySnap.docs.some(d => { const e=d.data(); return (parseFloat(e.numNwDays)||0)>0 || e.dayType==="non-working"; });
        if(hasWorkingDay) { alert(lang==="fr"?`Conflit : une journée de travail existe déjà pour le ${entryDate}. Les heures et les journées de travail ne peuvent pas coexister.`:`Conflict: a working day entry already exists for ${entryDate}. Hours and working day entries cannot coexist.`); setSubmitting(false); return; }
        if(hasNonWorking) { alert(lang==="fr"?`Conflit : un jour non travaillé existe déjà pour le ${entryDate}. Les heures et les jours non travaillés ne peuvent pas coexister.`:`Conflict: a non-working day already exists for ${entryDate}. Hours and non-working day entries cannot coexist.`); setSubmitting(false); return; }
      } catch(dayErr) { console.warn("day-type conflict check failed:", dayErr); }
      // ── Overlap / duplicate prevention ──
      // Blocks genuine time conflicts (no "save anyway" override), including
      // overnight entries from the PREVIOUS day that spill past midnight into
      // this window. Also flags a full 24h entry (start == end), which is almost
      // always a mistake (e.g. 17:15 → 17:15).
      try {
        const toMin = tt => { const [h,m]=tt.split(":").map(Number); return h*60+m; };
        // This entry's window in minutes (ne > 1440 means it runs past midnight).
        let ns = toMin(logStart), ne = toMin(logEnd); if(ne<=ns) ne+=1440;

        // Flag a full 24-hour entry up front — start == end reads as 24h.
        if(logStart===logEnd) {
          if(!window.confirm(lang==="fr"
            ? `Cette entrée dure 24 heures (${logStart} → ${logEnd}). Est-ce exact ? Si vous vouliez une autre heure de fin, annulez et corrigez.`
            : `This entry is a full 24 hours (${logStart} → ${logEnd}). Is that correct? If you meant a different end time, cancel and fix it.`)) {
            setSubmitting(false); return;
          }
        }

        // Previous calendar day (for catching overnight spillover into this entry).
        const prevDate = (() => {
          const d = new Date(entryDate + "T12:00:00"); d.setDate(d.getDate()-1);
          return d.toISOString().slice(0,10);
        })();

        const [sameSnap, prevSnap] = await Promise.all([
          getDocs(query(collection(db,"timesheets"), where("employeeEmail","==",employee.email), where("date","==",entryDate))),
          getDocs(query(collection(db,"timesheets"), where("employeeEmail","==",employee.email), where("date","==",prevDate))),
        ]);

        // Check same-day entries: overlap if the two windows intersect.
        for(const dref of sameSnap.docs) {
          const e = dref.data();
          if(!e.startTime||!e.endTime) continue;
          if(e.startTime===logStart && e.endTime===logEnd) {
            alert(lang==="fr"
              ? `Entrée en double : vous avez déjà une entrée le ${entryDate} de ${logStart} à ${logEnd}.`
              : `Duplicate entry: you already have an entry on ${entryDate} from ${logStart} to ${logEnd}.`);
            setSubmitting(false); return;
          }
          let es=toMin(e.startTime), ee=toMin(e.endTime); if(ee<=es) ee+=1440;
          if(ns < ee && es < ne) {
            alert(lang==="fr"
              ? `Conflit d'horaire : vous avez déjà une entrée le ${entryDate} de ${e.startTime} à ${e.endTime}, qui chevauche ${logStart}–${logEnd}. Corrigez l'heure ou la date avant d'enregistrer.`
              : `Time conflict: you already have an entry on ${entryDate} from ${e.startTime} to ${e.endTime}, which overlaps ${logStart}–${logEnd}. Fix the time or the date before saving.`);
            setSubmitting(false); return;
          }
        }

        // Check previous-day overnight entries that run past midnight into today.
        // Their spillover window (in "today" terms) is [0, ee-1440].
        for(const dref of prevSnap.docs) {
          const e = dref.data();
          if(!e.startTime||!e.endTime) continue;
          let es=toMin(e.startTime), ee=toMin(e.endTime);
          if(ee>es) continue; // not overnight — doesn't reach into today
          const spillEnd = ee; // minutes after midnight it runs to, today
          // This entry (today) occupies [ns, min(ne,1440)] of today.
          const todayStart = ns, todayEnd = Math.min(ne, 1440);
          if(todayStart < spillEnd) {
            alert(lang==="fr"
              ? `Conflit d'horaire : votre entrée du ${prevDate} (${e.startTime} → ${e.endTime}, de nuit) se poursuit jusqu'à ${e.endTime} le ${entryDate} et chevauche ${logStart}–${logEnd}. Corrigez l'heure ou la date.`
              : `Time conflict: your entry from ${prevDate} (${e.startTime} → ${e.endTime}, overnight) runs until ${e.endTime} on ${entryDate} and overlaps ${logStart}–${logEnd}. Fix the time or the date.`);
            setSubmitting(false); return;
          }
        }
      } catch(dupErr) { console.warn("overlap check failed:", dupErr); }
      await addDoc(collection(db,"timesheets"),{ employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email, event:shiftEvent||employee.event, subEvent:shiftSubEvent||null, date:entryDate, startTime:logStart, endTime:logEnd, breakMinutes:breakMins||null, hours:+(netMins/60).toFixed(2), notes:logNotes.trim(), truckUnit:logTruck.trim()||null, trailerUnit:logTrailer.trim()||null, kmStart:logKmStart?parseFloat(logKmStart):null, kmEnd:logKmEnd?parseFloat(logKmEnd):null, kmTotal:(logKmStart&&logKmEnd)?parseFloat(logKmEnd)-parseFloat(logKmStart):null, gpsIn: gpsIn||null, gpsOut: gpsOut||null, unitLog: unitLog.length>0?unitLog:null, dayType: dayType||"working", submittedAt:new Date().toISOString() });
      setLogStart(""); setLogEnd(""); setLogNotes(""); setLogTruck(""); setLogTrailer(""); setLogKmStart(""); setLogKmEnd(""); localStorage.removeItem("cargodx_clockin_kmstart"); localStorage.removeItem("cargodx_clockin_kmend"); setLogBreak("");
      setGpsIn(null); setGpsOut(null); setClockedIn(false); setShowManual(false); setEquipAnswer(null);
      localStorage.removeItem("cargodx_clockin_start");
      localStorage.removeItem("cargodx_clockin_end");
      localStorage.removeItem("cargodx_clockin_date");
      localStorage.removeItem("cargodx_clockin_truck");
      localStorage.removeItem("cargodx_clockin_trailer");
      localStorage.removeItem("cargodx_clockin_kmstart");
      localStorage.removeItem("cargodx_clockin_kmend");
      // Remove live session from Firestore
      if(employee) { try { await deleteDoc(doc(db,"sessions",employee.key||employee.email||employee.phone?.replace(/\D/g,"")||employee.name)); } catch(e) {} }
      // Keep same date — driver can log another shift
      showToast(t("toastOk")); goTab(4);
    } catch(e){console.error(e);showToast(t("toastErr"),true);}
    setSubmitting(false);
  };

  // Validate the current form; returns an expense object (with its File) or null.
  const validateExpense = () => {
    if(!employee){alert(t("alertFill"));goTab(1);return null;}
    if(!expDate||!expType||!expAmount||!expDesc.trim()){alert(t("alertFill"));return null;}
    if(!expFile){alert(t("alertFile"));return null;}
    return {
      _tmpId: Date.now()+"_"+Math.random().toString(36).slice(2,7),
      event: expEvent||employee.event, subEvent: expSubEvent||null,
      date: expDate, type: expType, amount: parseFloat(expAmount),
      currency: expCurrency, description: expDesc.trim(), file: expFile,
    };
  };

  const clearExpenseForm = () => {
    setExpType(""); setExpAmount(""); setExpDesc(""); setExpFile(null);
    setExpDate(today()); setExpEvent(employee?.event||""); setExpSubEvent("");
  };

  // Upload one receipt + write one expenses doc.
  const writeExpense = async (x) => {
    const path=`expenses/${(x.event||employee.event).replace(/\s+/g,"_")}/${employee.email}/${Date.now()}_${x.file.name}`;
    const sRef=storageRef(storage,path);
    await uploadBytes(sRef,x.file);
    const receiptUrl=await getDownloadURL(sRef);
    await addDoc(collection(db,"expenses"),{ employeeName:employee.name, employeePhone:employee.phone, employeeEmail:employee.email, event:x.event, subEvent:x.subEvent||null, date:x.date, type:x.type, amount:x.amount, currency:x.currency, description:x.description, receiptUrl, receiptName:x.file.name, status:"pending", submittedAt:new Date().toISOString() });
  };

  // Save (stage) the current form into the not-yet-submitted list.
  const saveExpense = () => {
    const x = validateExpense();
    if(!x) return;
    setStagedExpenses(prev=>{ const next=[...prev, x]; if(next.length>=2) setShowSubmitReminder(true); return next; });
    clearExpenseForm();
    showToast(t("toastStaged"));
  };

  const removeStaged = (id) => setStagedExpenses(prev=>prev.filter(x=>x._tmpId!==id));

  // Submit everything: any staged expenses, plus the current form if it's filled in.
  const submitAll = async () => {
    let toSend = [...stagedExpenses];
    // If the form has data, include it too (so a lone expense still works without Save).
    if(expType||expAmount||expDesc.trim()||expFile){
      const x = validateExpense();
      if(!x) return; // form partially filled — block until fixed or cleared
      toSend.push(x);
    }
    if(!toSend.length){alert(t("alertFill"));return;}
    setSubmitting(true);
    try {
      for(const x of toSend) await writeExpense(x);
      setStagedExpenses([]);
      clearExpenseForm();
      setShowSubmitReminder(false);
      showToast(t("toastAllOk")); goTab(4);
    } catch(e){console.error(e);showToast(t("toastErr"),true);}
    setSubmitting(false);
  };

  // Warn before a real page reload/close if there are unsubmitted staged expenses.
  useEffect(()=>{
    if(!stagedExpenses.length) return;
    const h = (e)=>{ e.preventDefault(); e.returnValue = t("leaveWarn"); return t("leaveWarn"); };
    window.addEventListener("beforeunload", h);
    return ()=>window.removeEventListener("beforeunload", h);
  },[stagedExpenses.length]);

  const [summaryDays, setSummaryDays] = useState(7); // filter last N days
  // Reload summary data whenever tab 4 is opened
  useEffect(()=>{ if(tab===4 && employee) loadData(); },[tab, employee]);
  useEffect(()=>{ if(tab===6) loadEquipment(); },[tab]);
  useEffect(()=>{ if(tab===7){ loadCompanyDocs(); loadSharedDocs(); } },[tab]);
  useEffect(()=>{ if(tab===8 && employee) loadEmpDocs(); },[tab, employee]);
  useEffect(()=>{ try{ localStorage.setItem("cargodx_tab", String(tab)); }catch{} },[tab]);
  // Security: if not registered/logged in, force the registration tab (blocks access to Log/Orders/Equipment/Docs)
  useEffect(()=>{ if(!employee && tab!==1) setTab(1); },[employee, tab]);
  // Logged-in users never see the login/registration screen — send them to the
  // Daily Log. (After logout, employee is null, so this won't fire.)
  useEffect(()=>{ if(employee && tab===1) setTab(employee.logRestricted?5:2); },[employee, tab]);
  // Keep log-restricted users out of the daily-log workflow (tabs 2-4).
  useEffect(()=>{ if(employee && employee.logRestricted===true && tab>=2 && tab<=4) setTab(5); },[employee, tab]);
  useEffect(()=>{ if(employee && employee.driverLog===true && (tab===3||tab===4)) setTab(2); },[employee, tab]);

  // ── Auto-logoff after 12 hours of inactivity (security) ──
  // Clears the saved employee session so re-entry requires PIN again.
  // Clock-in data persists server-side (sessions collection), so an
  // in-progress shift can still be resumed after re-registering.
  const autoLogoff = () => {
    ["cargodx_employee","cargodx_clockin_start","cargodx_clockin_end","cargodx_clockin_date",
     "cargodx_clockin_truck","cargodx_clockin_trailer","cargodx_clockin_kmstart","cargodx_clockin_kmend",
     "cargodx_clockin_event","cargodx_clockin_break","cargodx_unitlog","cargodx_tab","cargodx_last_activity"].forEach(k=>localStorage.removeItem(k));
    setEmployee(null);
    setTab(1);
    alert(lang==="fr"
      ? "Vous avez été déconnecté après 12 heures d'inactivité. Veuillez vous réidentifier."
      : "You've been logged out after 12 hours of inactivity. Please sign in again.");
  };

  useEffect(() => {
    if (!employee) return;
    const TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
    let timer = null;
    const reset = () => {
      if (timer) clearTimeout(timer);
      localStorage.setItem("cargodx_last_activity", String(Date.now()));
      timer = setTimeout(autoLogoff, TIMEOUT_MS);
    };
    // If the timeout already elapsed while the app was closed, log off now
    const last = parseInt(localStorage.getItem("cargodx_last_activity") || "0", 10);
    if (last && (Date.now() - last) > TIMEOUT_MS) { autoLogoff(); return; }
    const events = ["mousedown","keydown","touchstart","scroll","mousemove"];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [employee]);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - summaryDays);
  const filteredLogs = summaryDays === 0 ? logs : logs.filter(l => l.date && new Date(l.date+"T12:00:00") >= cutoff);
  const filteredExpenses = summaryDays === 0 ? expenses : expenses.filter(e => e.date && new Date(e.date+"T12:00:00") >= cutoff);
  const totalHours=filteredLogs.reduce((a,l)=>a+(l.hours||0),0);
  // Pay amounts — computed from THIS employee's payCfg (rates set in dispatch).
  // Each entry type uses its own rate; if the relevant rate isn't configured,
  // that entry shows no amount. Overrides on the entry win when present.
  const _pc = employee?.payCfg || {};
  const _paySym = _pc.currency==="USD" ? "US$" : "$";
  const _num = (v)=>{ const n=parseFloat(v); return isNaN(n)?0:n; };
  const entryAmount = (l) => {
    // An explicit per-entry override always wins.
    if(l.dayType==="working-day") { const r=_num(l.dayRateOverride)||_num(_pc.workDay)||_num(_pc.dayRate); return r>0 ? r*(_num(l.numDays)||1) : null; }
    if(l.dayType==="non-working") { const r=_num(_pc.nonWorkDay); return r>0 ? r : null; }
    if(l.dayType==="per-diem")    { const r=_num(l.perDiemRateOverride)||_num(_pc.perDiem); return r>0 ? r*(_num(l.numPerDiem)||1) : null; }
    if(l.dayType==="trip")        { const r=_num(l.tripRateOverride)||_num(_pc.tripRate); return r>0 ? r*(_num(l.numTrips)||1) : null; }
    // A clocked shift: hours × hourly rate.
    const r=_num(_pc.hourly); return r>0 ? r*(_num(l.hours)) : null;
  };
  const hasAnyRates = _num(_pc.hourly)>0 || _num(_pc.workDay)>0 || _num(_pc.nonWorkDay)>0 || _num(_pc.perDiem)>0 || _num(_pc.tripRate)>0 || _num(_pc.dayRate)>0;
  const totalEventPay = hasAnyRates ? filteredLogs.reduce((a,l)=>a+(entryAmount(l)||0),0) : null;
  const EmpTag = ()=>employee?<div style={S.empTag}><div style={S.empDot}/>{employee.name}&nbsp;·&nbsp;{employee.event}</div>:null;

  return (
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <img src="data:image/jpeg;base64,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" alt="DBX" style={{height:44,objectFit:"contain"}}/>
        <div style={S.headerRight}>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <div style={S.langToggle}><LangBtn active={lang==="fr"} onClick={()=>setLang("fr")} label="FR" C={C}/><LangBtn active={lang==="en"} onClick={()=>setLang("en")} label="EN" C={C}/></div>
            {/* Dark / Light mode toggle */}
            <button onClick={()=>{ const next=!darkMode; setDarkMode(next); localStorage.setItem("cargodx_darkmode",next); }}
              style={{background:"transparent",border:"1px solid #444",borderRadius:20,padding:"3px 10px",cursor:"pointer",fontSize:16,lineHeight:1,display:"flex",alignItems:"center",gap:4}}>
              {darkMode?"☀️":"🌙"}
            </button>
          </div>
          <div style={S.portalLabel}>{t("portalLabel")}</div>
        </div>
      </div>

      {/* Mini step indicator — only shown on log tabs 1-4 when registered and not log-restricted */}
      {employee && !employee.logRestricted && tab<=4&&<div style={{display:"flex",background:C.surface,borderBottom:`1px solid ${C.border}`,overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none"}}>
        {!employee && <StepTab label={t("step1")} active={tab===1} done={tab>1} onClick={()=>goTab(1)} C={C}/>}
        <StepTab label={`1. ${t("navDaily")}`} active={tab===2} done={tab>2} onClick={()=>goTab(2)} C={C}/>
        {!(employee && employee.driverLog) && <StepTab label={`2. ${t("navExpenses")}`} active={tab===3} done={tab>3} onClick={()=>goTab(3)} C={C}/>}
        {!(employee && employee.driverLog) && <StepTab label={`3. ${t("navSummary")}`} active={tab===4} done={false} onClick={()=>goTab(4)} C={C}/>}
        {employee && <StepTab label={`${(employee && employee.driverLog)?"2":"4"}. ${t("navLogout")}`} active={false} done={false} onClick={doLogout} C={C}/>}
      </div>}

      {/* ── Screen 1: Login ── */}
      {tab===1&&<div style={S.screen}>
        {employee&&<div style={S.wbBack}>{t("welcomeBack",employee.name.split(" ")[0])}</div>}

        {/* Logo + title */}
        <div style={{textAlign:"center",marginBottom:32,marginTop:16}}>
          <div style={{fontSize:28,fontWeight:800,color:C.black,marginBottom:8}}>{t("welcomeTitle")}</div>
          <div style={{fontSize:14,color:C.gray,lineHeight:1.6}}>{t("welcomeSub")}</div>
        </div>

        {/* Employee ID + PIN form */}
        <div style={{background:C.surface,borderRadius:14,padding:20,border:`1px solid ${C.border}`,marginBottom:16}}>
          <Field label={t("empIdLabel")} required C={C} S={S}>
            <FocusInput
              type="text"
              value={regEmpId}
              onChange={e=>{setRegEmpId(e.target.value); setLoginError("");}}
              placeholder={t("empIdPh")}
              autoComplete="off"
              autoCapitalize="none"
            />
          </Field>
          <Field label={t("pinLabel")} required C={C} S={S}>
            <FocusInput
              type="password"
              inputMode="numeric"
              value={regPin}
              onChange={e=>{setRegPin(e.target.value.replace(/\D/g,"")); setLoginError("");}}
              placeholder={t("pinPh")}
              maxLength={6}
              autoComplete="off"
              onKeyDown={e=>{ if(e.key==="Enter") register(); }}
            />
          </Field>
          {loginError && <div style={{fontSize:13,color:"#dc2626",fontWeight:600,marginTop:4,padding:"8px 12px",background:"rgba(220,38,38,0.08)",borderRadius:8}}>{loginError}</div>}
        </div>

        {/* Active session found on another device */}
        {activeSession && (
          <div style={{marginBottom:16,padding:"14px 16px",background:"rgba(34,197,94,0.1)",border:`1.5px solid ${C.green}`,borderRadius:10}}>
            <div style={{fontSize:13,fontWeight:700,color:C.green,marginBottom:6}}>
              {lang==="fr"?"Session active trouvée !":"Active session found!"}
            </div>
            <div style={{fontSize:12,color:C.black,marginBottom:4}}>
              {lang==="fr"?"Une session est en cours sur un autre appareil:":"A session is active on another device:"}
            </div>
            <div style={{fontSize:12,color:C.gray,marginBottom:10}}>
              ⏰ {lang==="fr"?"Pointage":"Clock-in"}: <strong>{activeSession.session.clockIn}</strong>
              {activeSession.session.truck&&<span> · 🚛 {activeSession.session.truck}</span>}
              {activeSession.session.trailer&&<span> · TRL: {activeSession.session.trailer}</span>}
              {activeSession.session.event&&<span> · 📋 {activeSession.session.event}</span>}
            </div>
            <button type="button" onClick={()=>resumeSession(activeSession.emp, activeSession.session)}
              style={{width:"100%",padding:"11px",background:C.green,color:"#fff",border:"none",borderRadius:7,fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:8}}>
              ▶ {lang==="fr"?"Reprendre cette session":"Resume this session"}
            </button>
            <button type="button" onClick={()=>setActiveSession(null)}
              style={{width:"100%",padding:"9px",background:"transparent",color:C.gray,border:`1px solid ${C.border}`,borderRadius:7,fontFamily:"'DM Sans',sans-serif",fontWeight:600,fontSize:13,cursor:"pointer"}}>
              {lang==="fr"?"Ignorer et créer une nouvelle session":"Ignore and start new session"}
            </button>
          </div>
        )}

        <button style={{...S.btn,...S.btnBlk}} onClick={register} disabled={submitting}>
          {submitting ? t("loggingIn") : t("loginBtn")}
        </button>

        {/* Manual restore — for someone whose main device died mid-shift and is
            logging in on a replacement device. Only shown once logged in. */}
        {employee && !clockedIn && <button type="button" onClick={restoreFromDevice} style={{width:"100%",marginTop:12,padding:"10px",background:"transparent",color:C.blue||C.red,border:`1.5px dashed ${C.blue||C.red}`,borderRadius:8,fontFamily:"'DM Sans',sans-serif",fontWeight:600,fontSize:13,cursor:"pointer"}}>
          📲 {lang==="fr"?"Restaurer la session d'un autre appareil":"Restore session from another device"}
        </button>}

        {/* Documents section — collapsable (optional, for uploading credentials) */}
        <div style={S.divider}/>

        {employee && <button style={{...S.btn,...S.btnOut,marginTop:16,fontSize:12}} onClick={()=>{
          if(!window.confirm(lang==="fr"?"Réinitialiser votre profil ? Vos données seront effacées.":"Reset your profile? Your saved data will be cleared.")) return;
          setEmployee(null);
          localStorage.removeItem("cargodx_employee");
          localStorage.removeItem("cargodx_last_activity");
          localStorage.removeItem("cargodx_clockin_start");
          localStorage.removeItem("cargodx_clockin_end");
          localStorage.removeItem("cargodx_clockin_date");
          localStorage.removeItem("cargodx_clockin_truck");
          localStorage.removeItem("cargodx_clockin_trailer");
          localStorage.removeItem("cargodx_clockin_kmstart");
          localStorage.removeItem("cargodx_clockin_kmend");
          localStorage.removeItem("cargodx_tab");
          setTab(1);
          setRegEmpId(""); setRegPin(""); setLoginError("");
          setClockedIn(false); setLogStart(""); setLogEnd("");
        }}>
          {lang==="fr"?"🔄 Réinitialiser le profil":"🔄 Reset Profile"}
        </button>}
      </div>}

      {/* ── Screen 2: Hours ── */}
      {tab===2&&<div style={S.screen}>
        {/* Prominent name display */}
        {employee&&<div style={{background:"#0369a1",borderRadius:10,padding:"14px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"#fff",flexShrink:0}}>
            {employee.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:"#fff"}}>{employee.name}</div>
            <div style={{fontSize:12,color:"#bfdbfe",marginTop:1}}>{employee.event}</div>
          </div>
          <button onClick={()=>goTab(1)} style={{marginLeft:"auto",background:"none",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",fontSize:11,padding:"4px 10px",borderRadius:5,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
            {lang==="fr"?"Modifier":"Edit"}
          </button>
        </div>}
        <div style={S.title}>{t("dailyTitle")}</div>
        <div style={S.sub}>{t("dailySub")}</div>

        {/* Restore-session moved to the login screen (used when switching devices) */}

        {/* ── Date selector — allows previous day entries ── */}
        <div style={{marginBottom:12}}>
          <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:C.gray,marginBottom:6}}>{lang==="fr"?"Choisissez votre date":"Choose your date"}</label>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <FocusInput type="date" value={logDate} max={today()} onChange={e=>{setLogDate(e.target.value);localStorage.setItem("cargodx_clockin_date",e.target.value);}} style={{flex:1}}/>
            {logDate<today()&&<span style={{fontSize:11,color:"#f59e0b",fontWeight:700,whiteSpace:"nowrap"}}>📅 {lang==="fr"?"Jour précédent":"Previous day"}</span>}
            {logDate>today()&&<span style={{fontSize:11,color:"#ef4444",fontWeight:700,whiteSpace:"nowrap"}}>⚠️ {lang==="fr"?"Date future — non permis":"Future date — not allowed"}</span>}
          </div>
        </div>

        {/* ── Event selector ── */}
        <div style={{marginBottom:16}}>
          <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:C.gray,marginBottom:6}}>{lang==="fr"?"Choisissez votre événement *":"Choose your event *"}</label>
          <FocusSelect value={shiftEvent} onChange={e=>{const ev=e.target.value;setShiftEvent(ev);localStorage.setItem("cargodx_clockin_event",ev);const evObj=allEvents.find(a=>a.name===ev);setEventAllowsNw(!!(evObj?.allowNwDays));setEventAllowsPerDiem(!!(evObj?.allowPerDiem));setEventAllowsHours(evObj?.allowHours!==false);setEventAllowsDaily(!!(evObj?.allowDaily));setEventAllowsExpenses(evObj?.allowExpenses!==false);setEventAllowsTrips(!!(evObj?.allowTrips));setSubEventOptions((Array.isArray(evObj?.subEvents)?evObj.subEvents:[]).filter(s=>!(evObj?.archivedSubEvents||[]).includes(s)));setShiftSubEvent("");localStorage.removeItem("cargodx_clockin_subevent");setPendingEntries([]);setEditHours(false);setEquipAnswer(null);setLogMode("hours");}}>
            <option value="">{lang==="fr"?"— Sélectionnez l'événement —":"— Select event —"}</option>
            {events.map(ev=><option key={ev}>{ev}</option>)}
          </FocusSelect>
        </div>

        {/* ── Optional sub-event picker (only if the event has sub-events) ── */}
        {shiftEvent && subEventOptions.length > 0 && (
          <div style={{marginBottom:16}}>
            <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:C.gray,marginBottom:6}}>{lang==="fr"?"Sous-événement (optionnel)":"Sub-event (optional)"}</label>
            <FocusSelect value={shiftSubEvent} onChange={e=>{const s=e.target.value;setShiftSubEvent(s);if(s)localStorage.setItem("cargodx_clockin_subevent",s);else localStorage.removeItem("cargodx_clockin_subevent");}}>
              <option value="">{lang==="fr"?"— Aucun —":"— None —"}</option>
              {subEventOptions.map(s=><option key={s}>{s}</option>)}
            </FocusSelect>
          </div>
        )}

        {/* ── Nothing selected yet ── */}
        {!shiftEvent && (
          <div style={{textAlign:"center",padding:"32px 16px",color:C.gray,fontSize:14}}>
            <div style={{fontSize:36,marginBottom:8}}>📋</div>
            <div style={{fontWeight:600}}>{lang==="fr"?"Sélectionnez un événement pour commencer":"Select an event to get started"}</div>
          </div>
        )}

        {/* ── LOG MODE PICKER — only when the event allows BOTH hours and day-logging ── */}
        {shiftEvent && eventAllowsHours && eventAllowsDaily && !clockedIn && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            <button onClick={()=>setLogMode("hours")} style={{padding:"10px",borderRadius:10,border:`2px solid ${logMode==="hours"?"#0369a1":C.border}`,background:logMode==="hours"?"rgba(3,105,161,0.15)":"transparent",color:logMode==="hours"?"#0369a1":C.gray,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              ⏱️ {lang==="fr"?"Enregistrer des heures":"Log hours"}
            </button>
            <button onClick={()=>setLogMode("day")} style={{padding:"10px",borderRadius:10,border:`2px solid ${logMode==="day"?"#22c55e":C.border}`,background:logMode==="day"?"rgba(34,197,94,0.15)":"transparent",color:logMode==="day"?"#22c55e":C.gray,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              📅 {lang==="fr"?"Enregistrer une journée":"Log a working day"}
            </button>
          </div>
        )}

        {/* ── HOURS EVENT ── */}
        {shiftEvent && eventAllowsHours && !(eventAllowsDaily && logMode==="day") && (
          <div>
            {/* Clock In / Out row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>

              {/* Clock In tile — with inline edit button when clocked in */}
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button onClick={()=>{
                  if(clockedIn) return;
                  setClockInPanel(clockInPanel==="choice"?null:"choice");
                  setClockOutPanel(null);
                  setManualInTime(nowTime());
                  setManualInDate(today());
                }} style={{padding:"16px 8px",borderRadius:12,border:`2px solid ${clockedIn?"#22c55e":"#0369a1"}`,background:clockedIn?"rgba(34,197,94,0.08)":"#0369a1",color:clockedIn?"#22c55e":"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:clockedIn?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                  <span style={{fontSize:24}}>{clockedIn?"✅":"🟢"}</span>
                  <span>{clockedIn?(lang==="fr"?"Arrivée ✓":"Clocked In ✓"):(lang==="fr"?"Arrivée":"Clock In")}</span>
                  {logStart&&<span style={{fontSize:11,opacity:0.85}}>{logStart}</span>}
                </button>
                {/* Edit clock-in time — only when clocked in */}
                {clockedIn && (
                  <button onClick={()=>setEditHours(editHours==="in"?false:"in")} style={{padding:"6px",borderRadius:7,border:`1.5px solid ${editHours==="in"?"#0369a1":C.border}`,background:editHours==="in"?"rgba(3,105,161,0.1)":"none",color:editHours==="in"?"#0369a1":C.gray,fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}>
                    ✏️ {lang==="fr"?"Modifier arrivée":"Edit clock-in"}
                  </button>
                )}
                {/* Edit clock-in panel */}
                {editHours==="in" && clockedIn && (
                  <div style={{background:C.white,border:`1.5px solid #0369a1`,borderRadius:8,padding:10}}>
                    <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:4}}>{lang==="fr"?"Heure d'arrivée":"Clock-in time"}</label>
                    <input type="time" value={logStart} onChange={e=>{setLogStart(e.target.value);localStorage.setItem("cargodx_clockin_start",e.target.value);}} style={{width:"100%",padding:"8px",borderRadius:7,border:`1.5px solid ${C.border}`,fontFamily:"inherit",fontSize:14,boxSizing:"border-box",background:C.white,color:C.black,colorScheme:C.black==="#f1f5f9"?"dark":"light"}}/>
                    <button onClick={()=>{if(logDate===today()&&logStart>nowTime()){alert(lang==="fr"?`L'heure d'arrivée (${logStart}) est dans le futur. Entrez une heure jusqu'à maintenant (${nowTime()}).`:`The clock-in time (${logStart}) is in the future. Enter a time up to now (${nowTime()}).`);return;}setEditHours(false);showToast(lang==="fr"?"Arrivée mise à jour ✓":"Clock-in updated ✓");}} style={{width:"100%",padding:"8px",marginTop:8,borderRadius:7,border:"none",background:"#0369a1",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅ {lang==="fr"?"Confirmer":"Confirm"}</button>
                  </div>
                )}
              </div>

              {/* Clock Out tile */}
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button onClick={()=>{
                  if(!clockedIn||logEnd) return;
                  setClockOutPanel(clockOutPanel==="choice"?null:"choice");
                  setClockInPanel(null);
                  setEditHours(false);
                  setManualOutTime(nowTime());
                }} style={{padding:"16px 8px",borderRadius:12,border:`2px solid ${logEnd?"#dc2626":clockedIn?"#dc2626":"#cbd5e1"}`,background:logEnd?"rgba(220,38,38,0.08)":clockedIn?"#dc2626":"rgba(100,116,139,0.06)",color:logEnd?"#dc2626":clockedIn?"#fff":"#94a3b8",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:(!clockedIn||logEnd)?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                  <span style={{fontSize:24}}>🔴</span>
                  <span>{logEnd?(lang==="fr"?"Départ ✓":"Clocked Out ✓"):(lang==="fr"?"Départ":"Clock Out")}</span>
                  {logEnd&&<span style={{fontSize:11,opacity:0.85}}>{logEnd}</span>}
                </button>
                {/* Edit clock-out time — only when clocked out */}
                {logEnd && (
                  <button onClick={()=>setEditHours(editHours==="out"?false:"out")} style={{padding:"6px",borderRadius:7,border:`1.5px solid ${editHours==="out"?"#dc2626":C.border}`,background:editHours==="out"?"rgba(220,38,38,0.1)":"none",color:editHours==="out"?"#dc2626":C.gray,fontFamily:"inherit",fontWeight:600,fontSize:11,cursor:"pointer"}}>
                    ✏️ {lang==="fr"?"Modifier départ":"Edit clock-out"}
                  </button>
                )}
                {/* Edit clock-out panel */}
                {editHours==="out" && logEnd && (
                  <div style={{background:C.white,border:`1.5px solid #dc2626`,borderRadius:8,padding:10}}>
                    <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:4}}>{lang==="fr"?"Heure de départ":"Clock-out time"}</label>
                    <input type="time" value={logEnd} onChange={e=>{setLogEnd(e.target.value);localStorage.setItem("cargodx_clockin_end",e.target.value);}} style={{width:"100%",padding:"8px",borderRadius:7,border:`1.5px solid ${C.border}`,fontFamily:"inherit",fontSize:14,boxSizing:"border-box",background:C.white,color:C.black,colorScheme:C.black==="#f1f5f9"?"dark":"light"}}/>
                    <button onClick={()=>{if(logDate===today()&&logEnd>nowTime()){alert(lang==="fr"?`L'heure de départ (${logEnd}) est dans le futur. Entrez une heure jusqu'à maintenant (${nowTime()}).`:`The clock-out time (${logEnd}) is in the future. Enter a time up to now (${nowTime()}).`);return;}setEditHours(false);showToast(lang==="fr"?"Départ mis à jour ✓":"Clock-out updated ✓");}} style={{width:"100%",padding:"8px",marginTop:8,borderRadius:7,border:"none",background:"#dc2626",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅ {lang==="fr"?"Confirmer":"Confirm"}</button>
                  </div>
                )}
              </div>
            </div>

            {/* Clock In choice/manual panel */}
            {clockInPanel==="choice" && !clockedIn && (
              <div style={{background:C.white,borderRadius:10,border:`2px solid #0369a1`,overflow:"hidden",marginBottom:10}}>
                {logDate>today() ? (
                  <div style={{padding:"14px 16px",background:"rgba(239,68,68,0.1)",fontSize:13,color:"#dc2626",fontWeight:700}}>
                    ⚠️ {lang==="fr"?"Date future sélectionnée. Vous ne pouvez pas enregistrer d'heures pour une date à venir. Choisissez aujourd'hui ou une date passée.":"Future date selected. You can't log hours for an upcoming date. Choose today or a past date."}
                  </div>
                ) : (<>
                {logDate===today() ? (
                  <button onClick={()=>{setClockInPanel(null);handleClockIn();}} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",borderBottom:`1px solid ${C.border}`,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
                    <span style={{fontSize:20}}>⚡</span>
                    <div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{lang==="fr"?"Maintenant":"Right Now"} — {nowTime()}</div></div>
                  </button>
                ) : (
                  <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,background:"rgba(245,158,11,0.08)",fontSize:12,color:"#b45309",fontWeight:600}}>
                    📅 {lang==="fr"?"Jour précédent sélectionné — saisissez l'heure manuellement.":"Previous day selected — enter the time manually."}
                  </div>
                )}
                <button onClick={()=>setClockInPanel("manual")} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
                  <span style={{fontSize:20}}>✏️</span>
                  <div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{lang==="fr"?"Heure manuelle":"Manual time"}</div></div>
                </button>
                </>)}
              </div>
            )}
            {clockInPanel==="manual" && !clockedIn && (
              <div style={{background:C.white,borderRadius:10,border:`2px solid #0369a1`,padding:12,marginBottom:10}}>
                <div style={{marginBottom:10}}>
                  <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:4}}>{lang==="fr"?`Heure d'arrivée — ${fmtDate(logDate,t("locale"))}`:`Clock-in time — ${fmtDate(logDate,t("locale"))}`}</label>
                  <input type="time" value={manualInTime} onChange={e=>setManualInTime(e.target.value)} style={{width:"100%",padding:"8px",borderRadius:7,border:`1.5px solid ${C.border}`,fontFamily:"inherit",fontSize:14,boxSizing:"border-box",background:C.white,color:C.black,colorScheme:C.black==="#f1f5f9"?"dark":"light"}}/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setClockInPanel("choice")} style={{flex:1,padding:"9px",borderRadius:8,border:`1.5px solid ${C.border}`,background:"none",fontFamily:"inherit",fontWeight:600,fontSize:13,cursor:"pointer",color:C.gray}}>← {lang==="fr"?"Retour":"Back"}</button>
                  <button onClick={()=>{if(!manualInTime)return;if(isFutureDate(logDate)){alert(lang==="fr"?`La date (${logDate}) est dans le futur.`:`The date (${logDate}) is in the future.`);return;}if(logDate===today()&&manualInTime>nowTime()){alert(lang==="fr"?`L'heure d'arrivée (${manualInTime}) est dans le futur. Entrez une heure jusqu'à maintenant (${nowTime()}).`:`The clock-in time (${manualInTime}) is in the future. Enter a time up to now (${nowTime()}).`);return;}setLogStart(manualInTime);setClockedIn(true);localStorage.setItem("cargodx_clockin_start",manualInTime);localStorage.setItem("cargodx_clockin_date",logDate);if(employee)setDoc(doc(db,"sessions",employee.key||employee.email||employee.phone?.replace(/\D/g,"")||employee.name),{clockIn:manualInTime,date:logDate,event:shiftEvent,status:"active",updatedAt:new Date().toISOString()},{merge:true}).catch(()=>{});setClockInPanel(null);showToast(lang==="fr"?"Arrivée enregistrée ✓":"Clocked in ✓");}} style={{flex:2,padding:"9px",borderRadius:8,border:"none",background:"#0369a1",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>✅ {lang==="fr"?"Confirmer":"Confirm"}</button>
                </div>
              </div>
            )}

            {/* Clock Out choice/manual panel */}
            {clockOutPanel==="choice" && clockedIn && !logEnd && (
              <div style={{background:C.white,borderRadius:10,border:`2px solid #dc2626`,overflow:"hidden",marginBottom:10}}>
                {logDate===today() ? (
                  <button onClick={()=>{setClockOutPanel(null);handleClockOut();}} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",borderBottom:`1px solid ${C.border}`,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
                    <span style={{fontSize:20}}>⚡</span>
                    <div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{lang==="fr"?"Maintenant":"Right Now"} — {nowTime()}</div></div>
                  </button>
                ) : (
                  <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,background:"rgba(245,158,11,0.08)",fontSize:12,color:"#b45309",fontWeight:600}}>
                    📅 {lang==="fr"?"Jour précédent — saisissez l'heure de départ manuellement.":"Previous day — enter the clock-out time manually."}
                  </div>
                )}
                <button onClick={()=>setClockOutPanel("manual")} style={{width:"100%",padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
                  <span style={{fontSize:20}}>✏️</span>
                  <div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{lang==="fr"?"Heure manuelle":"Manual time"}</div></div>
                </button>
              </div>
            )}
            {clockOutPanel==="manual" && clockedIn && !logEnd && (
              <div style={{background:C.white,borderRadius:10,border:`2px solid #dc2626`,padding:12,marginBottom:10}}>
                <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:4}}>{lang==="fr"?"Heure de départ":"Clock-out time"}</label>
                <input type="time" value={manualOutTime} onChange={e=>setManualOutTime(e.target.value)} style={{width:"100%",padding:"8px",borderRadius:7,border:`1.5px solid ${C.border}`,fontFamily:"inherit",fontSize:14,boxSizing:"border-box",background:C.white,color:C.black,colorScheme:C.black==="#f1f5f9"?"dark":"light",marginBottom:10}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setClockOutPanel("choice")} style={{flex:1,padding:"9px",borderRadius:8,border:`1.5px solid ${C.border}`,background:"none",fontFamily:"inherit",fontWeight:600,fontSize:13,cursor:"pointer",color:C.gray}}>← {lang==="fr"?"Retour":"Back"}</button>
                  <button onClick={()=>{if(!manualOutTime)return;handleClockOut(manualOutTime);setClockOutPanel(null);}} style={{flex:2,padding:"9px",borderRadius:8,border:"none",background:"#dc2626",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>✅ {lang==="fr"?"Confirmer":"Confirm"}</button>
                </div>
              </div>
            )}

            {/* Hours summary + break */}
            {clockedIn && (
              <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,padding:12,marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:clockedIn&&!logEnd?10:0}}>
                  <div style={{fontSize:13,color:C.gray}}>
                    {logStart&&<span style={{color:C.black}}>🟢 {logStart}</span>}
                    {logEnd&&<span style={{color:C.black}}> → 🔴 {logEnd}</span>}
                  </div>
                  {mins>0&&<div style={{...S.badge,margin:0}}><div style={S.dot}/>{fmtHours(mins)}</div>}
                </div>
                {/* Break buttons */}
                {clockedIn&&!logEnd&&(
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{const time=nowTime();if(!logBreak){setLogBreak("START:"+time);showToast(lang==="fr"?"Pause commencée":"Break started");}}} disabled={!!logBreak} style={{flex:1,padding:"9px 6px",borderRadius:8,border:`1.5px solid ${logBreak?"#f59e0b":C.border}`,background:logBreak?"rgba(245,158,11,0.1)":"none",color:logBreak?"#f59e0b":C.gray,fontFamily:"inherit",fontWeight:700,fontSize:12,cursor:logBreak?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                      ⏸️ {logBreak?(lang==="fr"?"En pause":"On Break"):(lang==="fr"?"Début pause":"Break Start")}
                      {logBreak&&logBreak.startsWith("START:")&&<span style={{fontSize:10,opacity:0.8}}>{logBreak.replace("START:","")}</span>}
                    </button>
                    <button onClick={()=>{if(!logBreak||!logBreak.startsWith("START:"))return;const s=logBreak.replace("START:","");const[h1,m1]=s.split(":").map(Number);const now=new Date();const bm=(now.getHours()*60+now.getMinutes())-(h1*60+m1);if(bm>0){setLogBreak(String(bm));showToast(lang==="fr"?`Pause: ${bm} min`:`Break: ${bm} min`);}}} disabled={!logBreak||!logBreak.startsWith("START:")} style={{flex:1,padding:"9px 6px",borderRadius:8,border:`1.5px solid ${(logBreak&&logBreak.startsWith("START:"))?"#f59e0b":C.border}`,background:(logBreak&&logBreak.startsWith("START:"))?"rgba(245,158,11,0.15)":"none",color:(logBreak&&logBreak.startsWith("START:"))?"#f59e0b":C.gray,fontFamily:"inherit",fontWeight:700,fontSize:12,cursor:(logBreak&&logBreak.startsWith("START:"))?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                      ▶️ {lang==="fr"?"Fin pause":"Break End"}
                      {logBreak&&!logBreak.startsWith("START:")&&<span style={{fontSize:10,opacity:0.8}}>−{logBreak} min</span>}
                    </button>
                  </div>
                )}
                {logBreak&&!logBreak.startsWith("START:")&&!isNaN(parseInt(logBreak))&&(
                  <div style={{fontSize:11,color:"#f59e0b",marginTop:6,fontWeight:600}}>⏸ {lang==="fr"?`Pause déduite: ${logBreak} min`:`Break deducted: ${logBreak} min`}</div>
                )}
                {/* Clear the current entry (for junk/mistake entries) */}
                <button onClick={clearEntry} style={{width:"100%",marginTop:10,padding:"9px",borderRadius:8,border:`1.5px solid ${C.border}`,background:"none",color:C.gray,fontFamily:"inherit",fontWeight:600,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  🗑️ {lang==="fr"?"Effacer l'entrée":"Clear entry"}
                </button>
              </div>
            )}

            {/* Equipment card — shown when clocked in */}
            {clockedIn && !isGroundCrew && (
              <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,padding:12,marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <div style={{fontSize:11,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em"}}>🚛 {lang==="fr"?"Équipement":"Equipment"}</div>
                {equipAnswer!==null && (
                  <button onClick={()=>setEquipAnswer(null)}
                    aria-label={lang==="fr"?"Fermer":"Close"}
                    style={{fontSize:18,lineHeight:1,color:C.gray,background:"none",border:"none",
                            padding:"2px 8px",cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                )}
              </div>
                {equipAnswer===null && (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <button onClick={()=>setEquipAnswer("yes")} style={{padding:"10px",borderRadius:8,border:"2px solid #22c55e",background:"rgba(34,197,94,0.08)",color:"#16a34a",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>✅ {lang==="fr"?"Oui":"Yes"}</button>
                    <button onClick={()=>setEquipAnswer("no")} style={{padding:"10px",borderRadius:8,border:`1.5px solid ${C.border}`,background:"none",color:C.gray,fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>❌ {lang==="fr"?"Non":"No"}</button>
                  </div>
                )}
                {equipAnswer==="no" && (
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontSize:13,color:C.gray,fontWeight:600}}>❌ {lang==="fr"?"Pas d'équipement":"No equipment"}</span>
                    <button onClick={()=>setEquipAnswer(null)} style={{fontSize:11,color:C.gray,background:"none",border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>{lang==="fr"?"✕ Annuler":"✕ Cancel"}</button>
                  </div>
                )}
                {equipAnswer==="yes" && (
                  <div>
                    <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                      <button onClick={()=>setEquipAnswer(null)} style={{fontSize:11,color:C.gray,background:"none",border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>{lang==="fr"?"✕ Annuler":"✕ Cancel"}</button>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                      <div>
                        <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"Camion":"Truck"}</label>
                        <FocusInput type="text" value={logTruck} onChange={e=>{setLogTruck(e.target.value);localStorage.setItem("cargodx_clockin_truck",e.target.value);}} placeholder={lang==="fr"?"Ex: 26-23":"e.g. 26-23"}/>
                      </div>
                      <div>
                        <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"Remorque":"Trailer"}</label>
                        <FocusInput type="text" value={logTrailer} onChange={e=>{setLogTrailer(e.target.value);localStorage.setItem("cargodx_clockin_trailer",e.target.value);}} placeholder={lang==="fr"?"Ex: T-45":"e.g. T-45"}/>
                      </div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                      <div>
                        <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"KM départ":"KM Start"} <span style={{fontSize:9,fontWeight:400,textTransform:"none"}}>(opt.)</span></label>
                        <FocusInput type="number" value={logKmStart} onChange={e=>{setLogKmStart(e.target.value);localStorage.setItem("cargodx_clockin_kmstart",e.target.value);}} placeholder="0"/>
                      </div>
                      <div>
                        <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"KM arrivée":"KM End"} <span style={{fontSize:9,fontWeight:400,textTransform:"none"}}>(opt.)</span></label>
                        <FocusInput type="number" value={logKmEnd} onChange={e=>{setLogKmEnd(e.target.value);localStorage.setItem("cargodx_clockin_kmend",e.target.value);}} placeholder="0"/>
                      </div>
                    </div>
                    {logKmStart&&logKmEnd&&parseFloat(logKmEnd)>parseFloat(logKmStart)&&(
                      <div style={{fontSize:11,color:"#16a34a",fontWeight:600,marginBottom:6}}>📍 {(parseFloat(logKmEnd)-parseFloat(logKmStart)).toFixed(0)} km {lang==="fr"?"parcourus":"driven"}</div>
                    )}
                    <button onClick={()=>{
                      const sessKey=employee?.key||employee?.email||employee?.phone?.replace(/\D/g,"")||employee?.name;
                      if(sessKey) setDoc(doc(db,"sessions",sessKey),{truck:logTruck||null,trailer:logTrailer||null,kmStart:logKmStart?parseFloat(logKmStart):null,kmEnd:logKmEnd?parseFloat(logKmEnd):null,updatedAt:new Date().toISOString()},{merge:true}).catch(()=>{});
                      localStorage.setItem("cargodx_clockin_truck",logTruck);
                      localStorage.setItem("cargodx_clockin_trailer",logTrailer);
                      showToast(lang==="fr"?"✅ Équipement sauvegardé":"✅ Equipment saved");
                    }} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:"#22c55e",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                      💾 {lang==="fr"?"Sauvegarder — envoyer au dispatch":"Save — send to dispatch"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Notes field — collapsed to a button until needed, to save space */}
            {clockedIn && (
              <div style={{marginBottom:10}}>
                {(showNoteBox || logNotes) ? (
                  <>
                    <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",color:C.gray,marginBottom:4}}>{lang==="fr"?"Notes (optionnel)":"Notes (optional)"}</label>
                    <FocusTextarea value={logNotes} onChange={e=>setLogNotes(e.target.value)} placeholder={t("tasksPh")} rows={2}/>
                  </>
                ) : (
                  <button type="button" onClick={()=>setShowNoteBox(true)} style={{width:"100%",padding:"9px",background:"transparent",color:C.gray,border:`1.5px dashed ${C.border}`,borderRadius:8,fontFamily:"inherit",fontWeight:600,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                    📝 {lang==="fr"?"Ajouter une note":"Add a note"}
                  </button>
                )}
              </div>
            )}

            {/* SUBMIT button — only when clocked out and not editing */}
            {logEnd && !editHours && (
              <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,padding:12,marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>{lang==="fr"?"À soumettre":"To submit"}</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>⏱️</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#22c55e"}}>{lang==="fr"?"Heures travaillées":"Hours worked"}</div>
                    <div style={{fontSize:11,color:C.gray,marginTop:1}}>
                      📅 {logDate} · 🟢 {logStart} → 🔴 {logEnd}
                      {logBreak&&!logBreak.startsWith("START:")&&parseInt(logBreak)>0&&<span style={{marginLeft:6,color:"#f59e0b"}}>⏸ -{logBreak} min</span>}
                      {mins>0&&<span style={{marginLeft:6,fontWeight:700,color:C.black}}>{fmtHours(mins)}</span>}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {logEnd && !editHours && (
              <>
                {/* Spacer so the sticky button doesn't hide content above it */}
                <div style={{height:76}}/>
                <div style={{position:"fixed",left:"50%",transform:"translateX(-50%)",bottom:"calc(64px + env(safe-area-inset-bottom,0px))",width:"100%",maxWidth:480,padding:"8px 16px",boxSizing:"border-box",zIndex:900,background:`linear-gradient(to top, ${C.white} 60%, transparent)`}}>
                  <button style={{...S.btn,marginTop:0,boxShadow:"0 4px 16px rgba(0,0,0,0.25)"}} onClick={submitDay} disabled={submitting}>
                    {submitting?t("submitting"):t("submitBtn")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── NON-HOURS EVENT (working day / non-working / per diem / trips) ── */}
        {shiftEvent && (!eventAllowsHours || (eventAllowsDaily && logMode==="day")) && (
          <div>
            {/* Action buttons — only show what the event allows */}
            <div style={{display:"grid",gridTemplateColumns:(eventAllowsDaily&&eventAllowsNw)?"1fr 1fr":"1fr",gap:10,marginBottom:10}}>
              {eventAllowsDaily && (
                <button onClick={()=>{
                  if(pendingEntries.find(e=>e.type==="working-day")){showToast(lang==="fr"?"Journée de travail déjà ajoutée":"Working day already added",true);return;}
                  if(pendingEntries.find(e=>e.type==="non-working")){showToast(lang==="fr"?"Un jour non travaillé est déjà ajouté pour cette date":"A non-working day is already added for this date",true);return;}
                  setPendingEntries(p=>{ const next=[...p,{type:"working-day",label:lang==="fr"?"Journée travaillée":"Working Day",icon:"📅",color:"#22c55e",detail:lang==="fr"?"Journée de travail":"Working day"}]; if(next.length>=2) setShowSubmitReminder(true); return next; });
                  showToast(lang==="fr"?"Journée ajoutée ✓":"Working day added ✓");
                }} style={{padding:"14px",borderRadius:12,border:"2px solid #22c55e",background:"rgba(34,197,94,0.08)",color:"#16a34a",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <span style={{fontSize:22}}>📅</span> {lang==="fr"?"Journée travaillée":"Working Day"}
                </button>
              )}
              {eventAllowsNw && (
                <button onClick={()=>{
                  if(pendingEntries.find(e=>e.type==="non-working")){showToast(lang==="fr"?"Jour non travaillé déjà ajouté":"Non-working day already added",true);return;}
                  if(pendingEntries.find(e=>e.type==="working-day")){showToast(lang==="fr"?"Une journée travaillée est déjà ajoutée pour cette date":"A working day is already added for this date",true);return;}
                  setPendingEntries(p=>{ const next=[...p,{type:"non-working",label:lang==="fr"?"Jour non travaillé":"Non-Working Day",icon:"🚫",color:"#f59e0b",detail:lang==="fr"?"Jour non travaillé":"Non-working day"}]; if(next.length>=2) setShowSubmitReminder(true); return next; });
                  showToast(lang==="fr"?"Jour non travaillé ajouté ✓":"Non-working day added ✓");
                }} style={{padding:"14px",borderRadius:12,border:"2px solid #f59e0b",background:"rgba(245,158,11,0.08)",color:"#b45309",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <span style={{fontSize:22}}>🚫</span> {lang==="fr"?"Jour non travaillé":"Non-Working Day"}
                </button>
              )}
            </div>

            {eventAllowsPerDiem && (
              <button onClick={()=>{
                const already=pendingEntries.find(e=>e.type==="per-diem");
                if(already){showToast(lang==="fr"?"Per diem déjà ajouté":"Per diem already added",true);return;}
                setPendingEntries(p=>{ const next=[...p,{type:"per-diem",label:"Per Diem",icon:"🍽️",color:"#0ea5e9",detail:"$"+((employee?.payCfg?.perDiem||"?")+"")}]; if(next.length>=2) setShowSubmitReminder(true); return next; });
                showToast(lang==="fr"?"Per diem ajouté ✓":"Per diem added ✓");
              }} style={{width:"100%",padding:"14px",borderRadius:12,border:"2px solid #0ea5e9",background:"rgba(14,165,233,0.08)",color:"#0369a1",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <span style={{fontSize:22}}>🍽️</span> {lang==="fr"?"Ajouter un per diem":"Add Per Diem"}
              </button>
            )}

            {eventAllowsTrips && (
              <button onClick={()=>{
                const already=pendingEntries.find(e=>e.type==="trip");
                if(already){showToast(lang==="fr"?"Trajets déjà ajoutés":"Trips already added",true);return;}
                setPendingEntries(p=>[...p,{type:"trip",label:lang==="fr"?"Trajets":"Trips",icon:"🚗",color:"#8b5cf6",detail:lang==="fr"?"Trajets à enregistrer":"Trips to log"}]);
                showToast(lang==="fr"?"Trajets ajoutés ✓":"Trips added ✓");
              }} style={{width:"100%",padding:"14px",borderRadius:12,border:"2px solid #8b5cf6",background:"rgba(139,92,246,0.08)",color:"#7c3aed",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <span style={{fontSize:22}}>🚗</span> {lang==="fr"?"Ajouter des trajets":"Add Trips"}
              </button>
            )}

            {/* Equipment card — always available regardless of event type */}
            {!isGroundCrew && (
            <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,padding:12,marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <div style={{fontSize:11,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em"}}>🚛 {lang==="fr"?"Équipement":"Equipment"}</div>
                {equipAnswer!==null && (
                  <button onClick={()=>setEquipAnswer(null)}
                    aria-label={lang==="fr"?"Fermer":"Close"}
                    style={{fontSize:18,lineHeight:1,color:C.gray,background:"none",border:"none",
                            padding:"2px 8px",cursor:"pointer",fontFamily:"inherit"}}>✕</button>
                )}
              </div>
              {equipAnswer===null && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <button onClick={()=>setEquipAnswer("yes")} style={{padding:"10px",borderRadius:8,border:"2px solid #22c55e",background:"rgba(34,197,94,0.08)",color:"#16a34a",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>✅ {lang==="fr"?"Oui":"Yes"}</button>
                  <button onClick={()=>setEquipAnswer("no")} style={{padding:"10px",borderRadius:8,border:`1.5px solid ${C.border}`,background:"none",color:C.gray,fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>❌ {lang==="fr"?"Non":"No"}</button>
                </div>
              )}
              {equipAnswer==="no" && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:13,color:C.gray,fontWeight:600}}>❌ {lang==="fr"?"Pas d'équipement":"No equipment"}</span>
                  <button onClick={()=>setEquipAnswer(null)} style={{fontSize:11,color:C.gray,background:"none",border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>{lang==="fr"?"✕ Annuler":"✕ Cancel"}</button>
                </div>
              )}
              {equipAnswer==="yes" && (
                <div>
                  <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                    <button onClick={()=>setEquipAnswer(null)} style={{fontSize:11,color:C.gray,background:"none",border:`1px solid ${C.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>{lang==="fr"?"✕ Annuler":"✕ Cancel"}</button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div>
                      <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"Camion":"Truck"}</label>
                      <FocusInput type="text" value={logTruck} onChange={e=>{setLogTruck(e.target.value);localStorage.setItem("cargodx_clockin_truck",e.target.value);}} placeholder={lang==="fr"?"Ex: 26-23":"e.g. 26-23"}/>
                    </div>
                    <div>
                      <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"Remorque":"Trailer"}</label>
                      <FocusInput type="text" value={logTrailer} onChange={e=>{setLogTrailer(e.target.value);localStorage.setItem("cargodx_clockin_trailer",e.target.value);}} placeholder={lang==="fr"?"Ex: T-45":"e.g. T-45"}/>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    <div>
                      <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"KM départ":"KM Start"} <span style={{fontSize:9,fontWeight:400,textTransform:"none"}}>(opt.)</span></label>
                      <FocusInput type="number" value={logKmStart} onChange={e=>{setLogKmStart(e.target.value);localStorage.setItem("cargodx_clockin_kmstart",e.target.value);}} placeholder="0"/>
                    </div>
                    <div>
                      <label style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",display:"block",marginBottom:3}}>{lang==="fr"?"KM arrivée":"KM End"} <span style={{fontSize:9,fontWeight:400,textTransform:"none"}}>(opt.)</span></label>
                      <FocusInput type="number" value={logKmEnd} onChange={e=>{setLogKmEnd(e.target.value);localStorage.setItem("cargodx_clockin_kmend",e.target.value);}} placeholder="0"/>
                    </div>
                  </div>
                  {logKmStart&&logKmEnd&&parseFloat(logKmEnd)>parseFloat(logKmStart)&&(
                    <div style={{fontSize:11,color:"#16a34a",fontWeight:600,marginBottom:6}}>📍 {(parseFloat(logKmEnd)-parseFloat(logKmStart)).toFixed(0)} km {lang==="fr"?"parcourus":"driven"}</div>
                  )}
                  <button onClick={()=>{
                    const sessKey=employee?.key||employee?.email||employee?.phone?.replace(/\D/g,"")||employee?.name;
                    if(sessKey) setDoc(doc(db,"sessions",sessKey),{truck:logTruck||null,trailer:logTrailer||null,kmStart:logKmStart?parseFloat(logKmStart):null,kmEnd:logKmEnd?parseFloat(logKmEnd):null,updatedAt:new Date().toISOString()},{merge:true}).catch(()=>{});
                    localStorage.setItem("cargodx_clockin_truck",logTruck);
                    localStorage.setItem("cargodx_clockin_trailer",logTrailer);
                    showToast(lang==="fr"?"✅ Équipement sauvegardé":"✅ Equipment saved");
                  }} style={{width:"100%",padding:"9px",borderRadius:8,border:"none",background:"#22c55e",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                    💾 {lang==="fr"?"Sauvegarder — envoyer au dispatch":"Save — send to dispatch"}
                  </button>
                </div>
              )}
            </div>
            )}

            {/* Pending entries review list */}
            {pendingEntries.length>0 && (
              <div style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,padding:12,marginBottom:10}}>
                <div style={{fontSize:10,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>
                  {lang==="fr"?"À soumettre":"To submit"} ({pendingEntries.length})
                </div>
                {pendingEntries.map((entry,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:i<pendingEntries.length-1?`1px solid ${C.border}`:"none"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
                      <span style={{fontSize:18,flexShrink:0}}>{entry.icon}</span>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:entry.color}}>{entry.label}</div>
                        <div style={{fontSize:11,color:C.gray,marginTop:1}}>
                          📅 {logDate}
                          {entry.detail && <span style={{marginLeft:6}}>{entry.detail}</span>}
                        </div>
                      </div>
                    </div>
                    <button onClick={()=>setPendingEntries(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#ef4444",fontSize:18,cursor:"pointer",padding:"2px 6px",fontFamily:"inherit",flexShrink:0}}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Notes — collapsed to a button until needed */}
            {pendingEntries.length>0 && (
              <div style={{marginBottom:10}}>
                {(showNoteBox || logNotes) ? (
                  <>
                    <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",color:C.gray,marginBottom:4}}>{lang==="fr"?"Notes (optionnel)":"Notes (optional)"}</label>
                    <FocusTextarea value={logNotes} onChange={e=>setLogNotes(e.target.value)} placeholder={lang==="fr"?"Remarques...":"Remarks..."} rows={2}/>
                  </>
                ) : (
                  <button type="button" onClick={()=>setShowNoteBox(true)} style={{width:"100%",padding:"9px",background:"transparent",color:C.gray,border:`1.5px dashed ${C.border}`,borderRadius:8,fontFamily:"inherit",fontWeight:600,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                    📝 {lang==="fr"?"Ajouter une note":"Add a note"}
                  </button>
                )}
              </div>
            )}

            {/* SUBMIT ALL — sticky at the bottom so it's always reachable */}
            {pendingEntries.length>0 && (
              <>
                <div style={{height:76}}/>
                <div style={{position:"fixed",left:"50%",transform:"translateX(-50%)",bottom:"calc(64px + env(safe-area-inset-bottom,0px))",width:"100%",maxWidth:480,padding:"8px 16px",boxSizing:"border-box",zIndex:900,background:`linear-gradient(to top, ${C.white} 60%, transparent)`}}>
                  <button onClick={async()=>{
                if(!employee){alert(lang==="fr"?"Veuillez vous identifier d'abord.":"Please register first.");return;}
                if(!shiftEvent){alert(lang==="fr"?"Veuillez sélectionner un événement.":"Please select an event.");return;}
                setSubmitting(true);
                try {
                  const entryDate = logDate||today();
                  if(isFutureDate(entryDate)) { alert(lang==="fr"?`La date (${entryDate}) est dans le futur. Vous ne pouvez pas enregistrer pour une date future.`:`The date (${entryDate}) is in the future. You cannot register for a future date.`); setSubmitting(false); return; }
                  for(const entry of pendingEntries) {
                    if(entry.type==="working-day") {
                      if(await hasDayEntry("working-day")){showToast(lang==="fr"?"Journée déjà enregistrée":"Already registered",true);continue;}
                      if(await hasDayEntry("non-working")){showToast(lang==="fr"?"Jour non travaillé existe déjà":"Non-working day exists",true);continue;}
                      await addDoc(collection(db,"timesheets"),{employeeName:employee.name,employeePhone:employee.phone,employeeEmail:employee.email,event:shiftEvent||employee.event,subEvent:shiftSubEvent||null,date:entryDate,notes:logNotes.trim()||null,dayType:"working-day",numDays:1,submittedAt:new Date().toISOString()});
                    } else if(entry.type==="non-working") {
                      if(await hasDayEntry("non-working")){showToast(lang==="fr"?"Déjà enregistré":"Already registered",true);continue;}
                      if(await hasDayEntry("working-day")){showToast(lang==="fr"?"Journée de travail existe déjà":"Working day exists",true);continue;}
                      await addDoc(collection(db,"timesheets"),{employeeName:employee.name,employeePhone:employee.phone,employeeEmail:employee.email,event:shiftEvent||employee.event,subEvent:shiftSubEvent||null,date:entryDate,notes:logNotes.trim()||null,dayType:"non-working",submittedAt:new Date().toISOString()});
                    } else if(entry.type==="per-diem") {
                      if(await hasDayEntry("per-diem")){showToast(lang==="fr"?"Per diem déjà enregistré":"Per diem already registered",true);continue;}
                      await addDoc(collection(db,"timesheets"),{employeeName:employee.name,employeePhone:employee.phone,employeeEmail:employee.email,event:shiftEvent||employee.event,subEvent:shiftSubEvent||null,date:entryDate,notes:logNotes.trim()||null,dayType:"per-diem",numPerDiem:1,submittedAt:new Date().toISOString()});
                    } else if(entry.type==="trip") {
                      await addDoc(collection(db,"timesheets"),{employeeName:employee.name,employeePhone:employee.phone,employeeEmail:employee.email,event:shiftEvent||employee.event,subEvent:shiftSubEvent||null,date:entryDate,notes:logNotes.trim()||null,dayType:"trip",numTrips:parseInt(tripCount)||1,submittedAt:new Date().toISOString()});
                    }
                  }
                  setPendingEntries([]);
                  setLogNotes("");
                  showToast(lang==="fr"?"Soumis avec succès ✓":"Submitted successfully ✓");
                } catch(e){console.error(e);showToast(lang==="fr"?"Erreur":"Error",true);}
                setSubmitting(false);
              }} style={{...S.btn,background:"#22c55e",boxShadow:"0 4px 16px rgba(34,197,94,0.35)"}} disabled={submitting}>
                {submitting?t("submitting"):`✅ ${lang==="fr"?"Soumettre tout":"Submit All"} (${pendingEntries.length})`}
              </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>}

      {/* ── Screen 3: Expenses ── */}
      {tab===3&&<div style={S.screen}>
        <EmpTag/>
        <div style={S.title}>{t("expenseTitle")}</div>
        <div style={S.sub}>{t("expenseSub")}</div>
        <Field label={t("expenseDate")} required C={C} S={S}><FocusInput type="date" value={expDate} onChange={e=>setExpDate(e.target.value)}/></Field>
        <Field label={lang==="fr"?"Événement":"Event"} required C={C} S={S}>
          <FocusSelect value={expEvent||employee?.event||""} onChange={e=>{setExpEvent(e.target.value);setExpSubEvent("");}}>
            <option value="">{lang==="fr"?"— Sélectionnez l'événement —":"— Select event —"}</option>
            {events.map(ev=><option key={ev}>{ev}</option>)}
          </FocusSelect>
        </Field>
        {(()=>{
          const evName = expEvent||employee?.event||"";
          const evObj = allEvents.find(a=>a.name===evName);
          const subs = (Array.isArray(evObj?.subEvents) ? evObj.subEvents : []).filter(s=>!(evObj?.archivedSubEvents||[]).includes(s));
          if (subs.length===0) return null;
          return (
            <Field label={lang==="fr"?"Sous-événement (optionnel)":"Sub-event (optional)"} C={C} S={S}>
              <FocusSelect value={expSubEvent} onChange={e=>setExpSubEvent(e.target.value)}>
                <option value="">{lang==="fr"?"— Aucun —":"— None —"}</option>
                {subs.map(s=><option key={s}>{s}</option>)}
              </FocusSelect>
            </Field>
          );
        })()}
        <Field label={t("expenseType")} required C={C} S={S}>
          <FocusSelect value={expType} onChange={e=>setExpType(e.target.value)}>
            <option value="">{t("selectExpenseType")}</option>
            {EXPENSE_TYPES[lang].map(et=><option key={et}>{et}</option>)}
          </FocusSelect>
        </Field>
        <div style={S.amtRow}>
          <Field label={t("expenseAmount")} required C={C} S={S}><FocusInput type="number" min="0" step="0.01" value={expAmount} onChange={e=>setExpAmount(e.target.value)} placeholder="0.00"/></Field>
          <Field label={t("expenseCurrency")} required C={C} S={S}>
            <FocusSelect value={expCurrency} onChange={e=>setExpCurrency(e.target.value)}>
              {["CAD","USD","EUR","GBP"].map(c=><option key={c}>{c}</option>)}
            </FocusSelect>
          </Field>
        </div>
        <Field label={t("expenseDesc")} required note={t("expenseDescNote")} C={C} S={S}>
          <FocusTextarea value={expDesc} onChange={e=>setExpDesc(e.target.value)} placeholder={t("expenseDescPh")} rows={3}/>
        </Field>
        <Field label={t("expenseReceipt")} required note={t("expenseReceiptNote")} C={C} S={S}>
          <FilePick file={expFile} onFile={setExpFile} accept="image/*,application/pdf" t={t} C={C} S={S}/>
        </Field>
        <div style={S.sub}>{t("stagedNote")}</div>
        <button style={{...S.btn,...S.btnOut}} onClick={saveExpense} disabled={submitting}>{t("saveExpenseBtn")}</button>

        {stagedExpenses.length>0 && <div style={{marginTop:16,marginBottom:8}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:8}}>{t("stagedTitle")} ({stagedExpenses.length})</div>
          {stagedExpenses.map(x=>(
            <div key={x._tmpId} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:6,background:C.card,border:`1px solid ${C.border}`,borderRadius:8}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:C.text}}>{x.type} · {x.currency} {x.amount.toFixed(2)}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:2}}>{x.date}{x.subEvent?` · ${x.subEvent}`:""} · 🧾 {x.file.name}</div>
                {x.description && <div style={{fontSize:11,color:C.muted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.description}</div>}
              </div>
              <button onClick={()=>removeStaged(x._tmpId)} style={{flexShrink:0,padding:"6px 10px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:"#ef4444",fontSize:11,fontWeight:600,cursor:"pointer"}}>{t("removeStaged")}</button>
            </div>
          ))}
        </div>}

        <button style={{...S.btn,...S.btnGrn}} onClick={submitAll} disabled={submitting}>{submitting?t("uploading"):(stagedExpenses.length>0?`${t("submitAllBtn")} (${stagedExpenses.length + (expType||expAmount||expDesc.trim()||expFile?1:0)})`:t("submitExpenseBtn"))}</button>
        <button style={{...S.btn,...S.btnOut}} onClick={()=>goTab(2)}>{t("backToHours")}</button>
      </div>}

      {/* ── Screen 4: Summary ── */}
      {tab===4&&<div style={S.screen}>
        <EmpTag/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={S.title}>{t("summaryTitle")}</div>
          <button onClick={()=>loadData()} style={{padding:"6px 14px",borderRadius:8,border:`1px solid ${C.border}`,background:"transparent",color:C.gray,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>
            🔄 {lang==="fr"?"Actualiser":"Refresh"}
          </button>
        </div>
        <div style={{...S.sub,marginBottom:16}}>{employee?t("summarySub", shiftEvent||employee.event||"All Events"):""}</div>
        {!employee ? (
          <div style={{color:C.gray,fontSize:14,textAlign:"center",padding:"20px 0"}}>
            {lang==="fr"?"Veuillez vous inscrire d'abord.":"Please register first."}
          </div>
        ) : loadingData ? <div style={{color:C.gray,fontSize:14}}>{t("loading")}</div> : <>
          {totalEventPay!=null && totalEventPay>0 && (
            <div style={{background:"rgba(22,163,74,0.1)",border:`1.5px solid #16a34a`,borderRadius:10,padding:"14px 16px",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em"}}>{lang==="fr"?`Total estimé — ${shiftEvent||employee.event||""}`:`Estimated total — ${shiftEvent||employee.event||""}`}</div>
              <div style={{fontSize:26,fontWeight:800,color:"#16a34a",marginTop:2}}>{_paySym}{totalEventPay.toFixed(2)}</div>
              <div style={{fontSize:11,color:C.gray,marginTop:2}}>{lang==="fr"?"Basé sur vos taux configurés. Montant indicatif.":"Based on your configured rates. Estimate only."}</div>
            </div>
          )}
          <div style={S.statsGrid}>
            <div style={S.statBox}><div style={S.statLbl}>{t("totalHours")}</div><div style={{...S.statVal,color:C.red}}>{totalHours.toFixed(1)}h</div></div>
            <div style={S.statBox}><div style={S.statLbl}>{t("totalExpenses")}</div><div style={{...S.statVal,color:C.green}}>{filteredExpenses.length}</div></div>
            {filteredLogs.some(l=>l.kmTotal!=null) && <div style={S.statBox}><div style={S.statLbl}>{lang==="fr"?"KM total":"Total KM"}</div><div style={{...S.statVal,color:C.blue}}>{filteredLogs.reduce((a,l)=>a+(l.kmTotal||0),0).toFixed(0)}</div></div>}
            {/* Day-type tiles — each only renders when such entries exist, so
                per diems and working/non-working days are counted rather than
                hidden among 0.0h rows. */}
            {(()=>{ const n=filteredLogs.filter(l=>l.dayType==="working-day").reduce((a,l)=>a+(l.numDays||1),0);
              return n>0 && <div style={S.statBox}><div style={S.statLbl}>{lang==="fr"?"Jours trav.":"Working days"}</div><div style={{...S.statVal,color:"#16a34a"}}>{n}</div></div>; })()}
            {(()=>{ const n=filteredLogs.filter(l=>l.dayType==="non-working").length;
              return n>0 && <div style={S.statBox}><div style={S.statLbl}>{lang==="fr"?"Non trav.":"Non-working"}</div><div style={{...S.statVal,color:"#ea580c"}}>{n}</div></div>; })()}
            {(()=>{ const n=filteredLogs.filter(l=>l.dayType==="per-diem").reduce((a,l)=>a+(l.numPerDiem||1),0);
              return n>0 && <div style={S.statBox}><div style={S.statLbl}>{lang==="fr"?"Per diem":"Per diem"}</div><div style={{...S.statVal,color:"#0ea5e9"}}>{n}</div></div>; })()}
            {(()=>{ const n=filteredLogs.filter(l=>l.dayType==="trip").reduce((a,l)=>a+(l.numTrips||1),0);
              return n>0 && <div style={S.statBox}><div style={S.statLbl}>{lang==="fr"?"Voyages":"Trips"}</div><div style={{...S.statVal,color:"#8b5cf6"}}>{n}</div></div>; })()}
          </div>

          {/* Date filter */}
          <div style={{display:"flex",gap:6,marginBottom:4,flexWrap:"wrap"}}>
            {[7,14].map(d=>(
              <button key={d} onClick={()=>setSummaryDays(d)} style={{padding:"4px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1px solid ${summaryDays===d?C.red:C.border}`,background:summaryDays===d?C.redLight:"transparent",color:summaryDays===d?C.red:C.gray}}>
                {`${d}d`}
              </button>
            ))}
          </div>

          {/* Hours */}
          <div style={S.divider}/>
          <div style={S.secLbl}>{t("breakdown")}</div>
          {filteredLogs.length===0?<div style={{color:C.gray,fontSize:14,marginBottom:8,display:"flex",flexDirection:"column",alignItems:"center",gap:8,padding:"12px 0"}}>
            <span>{t("noEntries")}</span>
            <button onClick={()=>loadData()} style={{padding:"6px 16px",borderRadius:8,border:`1px solid ${C.red}`,background:C.redLight,color:C.red,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
              🔄 {lang==="fr"?"Réessayer":"Try again"}
            </button>
          </div>:
            filteredLogs.map(l=>{
              // Entries are not all clocked shifts — dayType says what each one is.
              // Without this, a non-working day or per diem rendered as a bare
              // "0.0h" row with an empty "→" time range and no label.
              const DT = {
                "working-day": { label: lang==="fr"?"Journée travaillée":"Working day", icon:"📅", color:"#16a34a" },
                "non-working": { label: lang==="fr"?"Journée non travaillée":"Non-working day", icon:"🚫", color:"#ea580c" },
                "per-diem":    { label: lang==="fr"?"Per diem":"Per diem", icon:"🍽️", color:"#0ea5e9" },
                "trip":        { label: lang==="fr"?"Voyage":"Trip", icon:"🚚", color:"#8b5cf6" },
              };
              const meta = DT[l.dayType];
              const isShift = !meta; // a real clocked shift has start/end times
              const qty = l.dayType==="per-diem" ? (l.numPerDiem||1)
                        : l.dayType==="trip" ? (l.numTrips||1)
                        : l.dayType==="working-day" ? (l.numDays||1) : null;
              return <div key={l.id} style={{...S.logItem, ...(meta?{borderLeft:`3px solid ${meta.color}`}:{})}}>
                <div style={S.logHdr}>
                  <div style={S.logDate}>{fmtDate(l.date,t("locale"))}</div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    {isShift
                      ? <div style={S.logHrs}>{(l.hours||0).toFixed(1)}h</div>
                      : <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:meta.color}}>
                          {qty>1?`\u00d7${qty}`:"\u2713"}
                        </div>}
                    {entryAmount(l)!=null && <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:"#16a34a"}}>{_paySym}{entryAmount(l).toFixed(2)}</div>}
                  </div>
                </div>
                {isShift
                  ? <div style={S.logTime}>{l.startTime} → {l.endTime}{l.breakMinutes?` (−${l.breakMinutes}min break)`:""}</div>
                  : <div style={{marginTop:2}}>
                      <span style={{display:"inline-block",padding:"2px 9px",borderRadius:10,fontSize:11,fontWeight:700,
                                    background:`${meta.color}1a`,color:meta.color}}>{meta.icon} {meta.label}</span>
                    </div>}
                {(l.truckUnit||l.kmStart||l.kmEnd) && <div style={{fontSize:11,color:C.gray,marginTop:3,display:"flex",gap:10,flexWrap:"wrap"}}>
                  {l.truckUnit && <span>🚛 {lang==="fr"?"Camion":"Truck"}: {l.truckUnit}</span>}
                  {l.trailerUnit && <span>🚚 {lang==="fr"?"Remorque":"Trailer"}: {l.trailerUnit}</span>}
                  {l.kmStart!=null && l.kmEnd!=null && <span>📍 {l.kmStart} → {l.kmEnd} km {l.kmTotal!=null?`(+${l.kmTotal} km)`:""}</span>}
                </div>}
                {l.notes && <div style={S.logNote}>{l.notes}</div>}
              </div>;
            })
          }

          {/* Expenses */}
          <div style={S.divider}/>
          <div style={S.secLbl}>{t("expenseBreakdown")}</div>
          {filteredExpenses.length===0?<div style={{color:C.gray,fontSize:14,marginBottom:8}}>{t("noExpenses")}</div>:
            filteredExpenses.map(ex=><div key={ex.id} style={{...S.logItem,borderLeft:`3px solid ${C.green}`}}>
              <div style={S.logHdr}>
                <div style={S.logDate}>{fmtDate(ex.date,t("locale"))}</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:600,color:C.green}}>{ex.currency} {parseFloat(ex.amount).toFixed(2)}</div>
              </div>
              <div style={{fontSize:11,color:C.gray,marginBottom:4,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span>{ex.type}</span>
                {ex.event&&<span style={{padding:"1px 8px",borderRadius:10,fontSize:10,fontWeight:600,background:"rgba(96,165,250,0.15)",color:"#60a5fa"}}>{ex.event}</span>}
                <span style={{padding:"1px 8px",borderRadius:10,fontSize:10,fontWeight:600,background:C.amberLight,color:C.amber}}>{t("pending")}</span>
              </div>
              <div style={S.logNote}>{ex.description}</div>
              {ex.receiptUrl&&<a href={ex.receiptUrl} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:8,fontSize:12,color:C.green,fontWeight:600,textDecoration:"none"}}>📎 {t("viewReceipt")}</a>}
            </div>)
          }

          {/* Documents */}
          <div style={S.divider}/>
          <div style={S.secLbl}>{t("docsSummaryTitle")}</div>
          {empDocs.length===0?<div style={{color:C.gray,fontSize:14}}>{t("noDocs")}</div>:
            empDocs.map(d=>(
              <div key={d.id} style={{...S.logItem,borderLeft:`3px solid ${C.blue}`}}>
                <div style={S.logHdr}>
                  <div style={S.logDate}>{d.label}</div>
                  <a href={d.url} target="_blank" rel="noreferrer" style={{fontSize:12,color:C.blue,fontWeight:600,textDecoration:"none"}}>📎 {t("viewDoc")}</a>
                </div>
                <div style={S.logNote}>{d.fileName}</div>
              </div>
            ))
          }
        </>}
        <div style={{marginTop:16,display:"flex",flexDirection:"column",gap:0}}>
          <button style={{...S.btn,...S.btnOut}} onClick={()=>goTab(2)}>{t("addDay")}</button>
          <button style={{...S.btn,...S.btnOut}} onClick={()=>goTab(3)}>{t("addExpense")}</button>
        </div>
      </div>}

      {/* ── Screen 5: My Orders ── */}
      {tab===5&&<div style={S.screen}>
        <div style={S.title}>{lang==="fr"?"Mes commandes":"My Orders"}</div>
        <div style={{...S.sub,marginBottom:16}}>{lang==="fr"?"Commandes qui vous sont assignées":"Orders assigned to you"}</div>
        <button style={{...S.btn,...S.btnOut,marginBottom:16}} onClick={loadOrders}>{lang==="fr"?"↻ Actualiser":"↻ Refresh"}</button>

        {ordersLoading && <div style={{color:C.gray,fontSize:14,textAlign:"center",padding:20}}>{lang==="fr"?"Chargement...":"Loading..."}</div>}

        {ordersError && <div style={{color:"#ef4444",fontSize:13,padding:"12px 16px",background:"#fee2e2",borderRadius:8,marginBottom:12,wordBreak:"break-all"}}>
          ⚠️ Error loading orders: {ordersError}
        </div>}
        {!ordersLoading && orders.length===0 && !ordersError && <div style={{color:C.gray,fontSize:13,textAlign:"center",padding:20}}>
          {lang==="fr"?"Aucune commande assignée pour le moment":"No orders assigned to you right now"}
          <div style={{marginTop:8,fontSize:11,color:C.gray,opacity:0.7}}>ID: {employee?.drvId||"none"} · {employee?.email||employee?.name||""}</div>
        </div>}

        {orders.map(o => {
          const isInTransit = o.status === "in-transit";
          const isPod = podOrderId === o.id;
          const picks = o.pickStops||[{co:o.pickCo,addr:o.pickAddr,city:o.pickCity,provState:o.pickProv,date:o.pickDate,contact:o.pickContact,phone:o.pickPhone}];
          const dels = o.delStops||[{co:o.delCo,addr:o.delAddr,city:o.delCity,provState:o.delProv,date:o.delDate,contact:o.delContact,phone:o.delPhone}];
          const isMultiStop = (o.pickStops||[]).length>1 || (o.delStops||[]).length>1;
          const podSide = (o.delStops||[]).length>=(o.pickStops||[]).length ? "delStops" : "pickStops";
          const podStops = o[podSide]||[];
          const podDoneCount = podStops.filter(s=>s.pod?.by).length;
          const cardBg = C.surface;
          const labelColor = C.gray;
          const textColor = C.black;
          return <div key={o.id} style={{background:cardBg,borderRadius:12,padding:16,marginBottom:14,border:`1px solid ${C.border}`,borderLeft:`4px solid ${isInTransit?"#8b5cf6":C.blue}`}}>

            {/* Header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:16,fontWeight:700,color:textColor}}>BOL #{o.bol}</div>
              <div style={{fontSize:11,padding:"4px 12px",borderRadius:10,fontWeight:700,background:isInTransit?"#8b5cf6":"#0369a1",color:"#fff"}}>
                {isInTransit?(lang==="fr"?"En transit":"In Transit"):(lang==="fr"?"Assigné":"Assigned")}
              </div>
            </div>

            {/* Client + Reference */}
            <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.border}`}}>
              {o.cliName && <div style={{fontSize:14,fontWeight:700,color:textColor,marginBottom:3}}>{o.cliName}</div>}
              {o.ref && <div style={{fontSize:12,color:labelColor}}>Ref: {o.ref}</div>}
              {o.pickDate && <div style={{fontSize:12,color:labelColor}}>{lang==="fr"?"Date:":"Date:"} {o.pickDate}</div>}
            </div>

            {/* Pickup stops */}
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,color:C.blue,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>
                📍 {lang==="fr"?"Ramassage":"Pickup"}
              </div>
              {picks.map((p,i) => <div key={i} style={{marginBottom:8,paddingLeft:8,borderLeft:`2px solid ${C.blue}`}}>
                <div style={{fontSize:13,fontWeight:600,color:textColor}}>{p.co||"—"}</div>
                {p.addr && p.addr.split('\n').map((line,li)=><div key={li} style={{fontSize:12,color:labelColor}}>{line}</div>)}
                {p.date && <div style={{fontSize:11,color:C.blue,fontWeight:500}}>{p.date}</div>}
                {p.contact && <div style={{fontSize:11,color:labelColor}}>👤 {p.contact}</div>}
                {p.phone && <div style={{fontSize:11,color:labelColor}}>📞 {p.phone}</div>}
                {(p.items||[]).filter(it=>it.pcs||it.wt||it.desc).map((it,ii)=><div key={ii} style={{fontSize:11,color:textColor,marginTop:3,paddingTop:3,borderTop:`1px dashed ${C.border}`}}>
                  {it.pcs&&<span style={{fontWeight:600}}>{it.pcs} pcs </span>}
                  {it.wt&&<span style={{color:labelColor}}>· {it.wt}{it.wUnit||"lbs"} </span>}
                  {(it.l||it.w||it.h)&&<span style={{color:labelColor}}>· {it.l}×{it.w}×{it.h} {it.dUnit||"in"} </span>}
                  {it.desc&&it.desc!=="yes"&&<span style={{color:labelColor}}>· {it.desc}</span>}
                </div>)}
                {p.notes && <div style={{marginTop:4,fontSize:11,color:"#92400e",background:"#fef3c7",padding:"3px 6px",borderRadius:4}}>📝 {p.notes}</div>}
              </div>)}
            </div>

            {/* Delivery stops */}
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,color:C.green,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>
                🏁 {lang==="fr"?"Livraison":"Delivery"}
              </div>
              {dels.map((d,i) => <div key={i} style={{marginBottom:8,paddingLeft:8,borderLeft:`2px solid ${C.green}`}}>
                <div style={{fontSize:13,fontWeight:600,color:textColor}}>{d.co||"—"}</div>
                {d.addr && d.addr.split('\n').map((line,li)=><div key={li} style={{fontSize:12,color:labelColor}}>{line}</div>)}
                {d.date && <div style={{fontSize:11,color:C.green,fontWeight:500}}>{d.date}</div>}
                {d.contact && <div style={{fontSize:11,color:labelColor}}>👤 {d.contact}</div>}
                {d.phone && <div style={{fontSize:11,color:labelColor}}>📞 {d.phone}</div>}
                {(d.items||[]).filter(it=>it.pcs||it.wt||it.desc).map((it,ii)=><div key={ii} style={{fontSize:11,color:textColor,marginTop:3,paddingTop:3,borderTop:`1px dashed ${C.border}`}}>
                  {it.pcs&&<span style={{fontWeight:600}}>{it.pcs} pcs </span>}
                  {it.wt&&<span style={{color:labelColor}}>· {it.wt}{it.wUnit||"lbs"} </span>}
                  {(it.l||it.w||it.h)&&<span style={{color:labelColor}}>· {it.l}×{it.w}×{it.h} {it.dUnit||"in"} </span>}
                  {it.desc&&it.desc!=="yes"&&<span style={{color:labelColor}}>· {it.desc}</span>}
                </div>)}
                {d.notes && <div style={{marginTop:4,fontSize:11,color:"#92400e",background:"#fef3c7",padding:"3px 6px",borderRadius:4}}>📝 {d.notes}</div>}
              </div>)}
            </div>

            {/* Items */}
            {o.items?.length>0 && <div style={{marginBottom:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:labelColor,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>
                📦 {lang==="fr"?"Marchandises":"Items"}
              </div>
              {o.items.filter(it=>it.pcs||it.wt||it.desc).map((it,i) => <div key={i} style={{fontSize:12,color:textColor,marginBottom:2}}>
                {it.pcs&&<span style={{fontWeight:600}}>{it.pcs} pcs </span>}
                {it.wt&&<span>· {it.wt} {it.wUnit||"lbs"} </span>}
                {(it.l||it.w||it.h)&&<span>· {it.l}×{it.w}×{it.h} {it.dUnit||"in"} </span>}
                {it.desc&&it.desc!=="yes"&&<span style={{color:labelColor}}>· {it.desc}</span>}
              </div>)}
            </div>}

            {/* Special Requirements */}
            {((o.specReqs||[]).length>0||o.specReqCustom) && <div style={{marginBottom:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:"#8b5cf6",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>
                ⚡ {lang==="fr"?"Exigences spéciales":"Special Requirements"}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {(o.specReqs||[]).map(r=><span key={r} style={{padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,background:"rgba(139,92,246,0.12)",color:"#8b5cf6",border:"1px solid rgba(139,92,246,0.3)"}}>{r}</span>)}
                {o.specReqCustom&&<span style={{padding:"3px 9px",borderRadius:20,fontSize:11,fontWeight:600,background:"rgba(139,92,246,0.12)",color:"#8b5cf6",border:"1px solid rgba(139,92,246,0.3)"}}>{o.specReqCustom}</span>}
              </div>
            </div>}

            {/* Attachments */}
            {(o.files||[]).length>0 && <div style={{marginBottom:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:labelColor,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>
                📎 {lang==="fr"?"Pièces jointes":"Attachments"}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {o.files.map((f,i)=>(
                  <a key={i} href={f.url||f.data} target="_blank" rel="noopener noreferrer"
                    style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:6,background:`rgba(14,165,233,0.1)`,border:`1px solid rgba(14,165,233,0.25)`,color:C.blue,fontSize:12,fontWeight:500,textDecoration:"none"}}>
                    📄 {f.name}
                  </a>
                ))}
              </div>
            </div>}

            {/* Notes */}
            {o.notes && <div style={{marginBottom:10,padding:"8px 10px",background:C.amberLight,borderRadius:6,border:`1px solid ${C.amber}`}}>
              <div style={{fontSize:10,fontWeight:700,color:C.amber,textTransform:"uppercase",marginBottom:3}}>📝 Notes</div>
              <div style={{fontSize:12,color:textColor,whiteSpace:"pre-wrap"}}>{o.notes}</div>
            </div>}

            {/* Action buttons */}
            {!isPod && <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
              {!isInTransit && <button style={{...S.btn,background:"#8b5cf6",flex:1}} onClick={()=>updateOrderStatus(o.id,"in-transit")}>
                🚛 {lang==="fr"?"Marquer en transit":"Mark In Transit"}
              </button>}
              {isInTransit && !isMultiStop && !o.podBy && <button style={{...S.btn,background:C.green,flex:1}} onClick={()=>{
                const now = new Date();
                setPodOrderId(o.id);
                setPodReceiver("");
                setPodNote("");
                setPodDate(now.toISOString().split("T")[0]);
                setPodTime(now.toTimeString().slice(0,5));
              }}>                ✅ {lang==="fr"?"Entrer POD":"Enter POD"}
              </button>}
              {!isMultiStop && o.podBy && <div style={{fontSize:12,color:C.green,fontWeight:600}}>✅ POD: {o.podBy}</div>}
            </div>}

            {/* Per-stop POD (multi-stop orders) — only when in transit */}
            {isMultiStop && isInTransit && <div style={{marginTop:10}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:8,color:textColor}}>{lang==="fr"?"Preuve de livraison par arrêt":"Proof of Delivery — per stop"} <span style={{color:podDoneCount===podStops.length?C.green:C.gray,fontWeight:600}}>({podDoneCount}/{podStops.length})</span></div>
              {podStops.map((st,si)=>{
                const stopKey = `${o.id}:${si}`;
                const entering = podStopKey === stopKey;
                const done = !!st.pod?.by;
                return <div key={si} style={{marginBottom:8,padding:10,background:C.white,borderRadius:8,border:`1px solid ${done?C.green:C.border}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontSize:13,fontWeight:600,color:textColor}}>{podSide==="delStops"?(lang==="fr"?"Livraison":"Delivery"):(lang==="fr"?"Ramassage":"Pickup")} {si+1}{st.co?` — ${st.co}`:""}</div>
                    {done && <span style={{fontSize:11,color:C.green,fontWeight:700}}>✓</span>}
                  </div>
                  {st.addr && <div style={{fontSize:11,color:C.gray,marginTop:2,whiteSpace:"pre-line"}}>{st.addr}</div>}
                  {done && !entering && <div style={{fontSize:12,color:C.green,marginTop:6}}>✅ {st.pod.by}{st.pod.date?` — ${st.pod.date}`:""}{st.pod.time?` ${st.pod.time}`:""}</div>}
                  {!entering && <button style={{...S.btn,background:done?"transparent":C.green,color:done?C.gray:"#fff",border:done?`1px solid ${C.border}`:"none",marginTop:8,padding:"8px"}} onClick={()=>{
                    const now=new Date(); setPodStopKey(stopKey); setPodReceiver(st.pod?.by||""); setPodNote(""); setPodDate(st.pod?.date||now.toISOString().split("T")[0]); setPodTime(st.pod?.time||now.toTimeString().slice(0,5));
                  }}>{done?(lang==="fr"?"Modifier POD":"Edit POD"):(lang==="fr"?"Entrer POD":"Enter POD")}</button>}
                  {entering && <div style={{marginTop:8}}>
                    <input style={{...S.inp,marginBottom:8}} value={podReceiver} onChange={e=>setPodReceiver(e.target.value)} placeholder={lang==="fr"?"Nom du réceptionnaire":"Receiver name"}/>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                      <input type="date" style={S.inp} value={podDate} onChange={e=>setPodDate(e.target.value)}/>
                      <input type="time" style={S.inp} value={podTime} onChange={e=>setPodTime(e.target.value)}/>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button style={{...S.btn,...S.btnGrn,flex:1,padding:"8px"}} onClick={()=>submitStopPod(o,podSide,si)}>{lang==="fr"?"Confirmer":"Confirm"}</button>
                      <button style={{...S.btn,...S.btnOut,flex:1,padding:"8px"}} onClick={()=>setPodStopKey(null)}>{lang==="fr"?"Annuler":"Cancel"}</button>
                    </div>
                  </div>}
                </div>;
              })}
            </div>}

            {/* POD form */}
            {isPod && <div style={{marginTop:10,padding:12,background:C.surface,borderRadius:8,border:`1px solid ${C.border}`}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:8,color:textColor}}>{lang==="fr"?"Preuve de livraison":"Proof of Delivery"}</div>
              <input style={{...S.inp,marginBottom:8}} value={podReceiver} onChange={e=>setPodReceiver(e.target.value)}
                placeholder={lang==="fr"?"Nom du réceptionnaire":"Receiver name"}/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div>
                  <div style={{fontSize:11,color:C.gray,marginBottom:4}}>{lang==="fr"?"Date de livraison":"Delivery date"}</div>
                  <input type="date" style={S.inp} value={podDate} onChange={e=>setPodDate(e.target.value)}/>
                </div>
                <div>
                  <div style={{fontSize:11,color:C.gray,marginBottom:4}}>{lang==="fr"?"Heure":"Time"}</div>
                  <input type="time" style={S.inp} value={podTime} onChange={e=>setPodTime(e.target.value)}/>
                </div>
              </div>
              <textarea style={{...S.ta,minHeight:60,marginBottom:8}} value={podNote} onChange={e=>setPodNote(e.target.value)}
                placeholder={lang==="fr"?"Note (optionnel)":"Note (optional)"}/>
              <div style={{display:"flex",gap:8}}>
                <button style={{...S.btn,...S.btnGrn,flex:1}} onClick={()=>submitPod(o.id)}>
                  {lang==="fr"?"Confirmer livraison":"Confirm Delivery"}
                </button>
                <button style={{...S.btn,...S.btnOut,flex:1}} onClick={()=>setPodOrderId(null)}>
                  {lang==="fr"?"Annuler":"Cancel"}
                </button>
              </div>
            </div>}

            {/* Add note */}
            {!isPod && <div style={{marginTop:8}}>
              <input style={{...S.inp,fontSize:13}} value={orderNote[o.id]||""} onChange={e=>setOrderNote(prev=>({...prev,[o.id]:e.target.value}))}
                placeholder={lang==="fr"?"Ajouter une note...":"Add a note..."}
                onKeyDown={e=>e.key==="Enter"&&submitNote(o.id)}/>
              {orderNote[o.id] && <button style={{...S.btn,marginTop:6,padding:"8px 14px",fontSize:12}} onClick={()=>submitNote(o.id)}>
                {lang==="fr"?"Envoyer note":"Send note"}
              </button>}
            </div>}
          </div>;
        })}
      </div>}

      {/* ── Tab 6: Equipment ── */}
      {tab===6&&<div style={S.screen}>
        <div style={S.title}>{lang==="fr"?"Équipements":"Equipment"}</div>

        {selEquip ? (
          // ── Detail view ──
          <div>
            <button onClick={()=>setSelEquip(null)} style={{...S.btn,...S.btnOut,marginBottom:16,display:"flex",alignItems:"center",gap:6}}>
              ← {lang==="fr"?"Retour":"Back"}
            </button>
            <div style={{background:C.surface,borderRadius:12,padding:16,border:`1px solid ${C.border}`,marginBottom:16}}>
              <div style={{fontSize:18,fontWeight:700,color:C.black,marginBottom:4}}>
                {lang==="fr"?"Unité":"Unit"} {selEquip.unit}
              </div>
              <div style={{fontSize:13,color:C.gray,marginBottom:12}}>{selEquip.type||""}</div>
              {[
                [lang==="fr"?"Plaque":"Plate", selEquip.plate],
                ["VIN", selEquip.vin],
                [lang==="fr"?"Expiration sécurité":"Safety Expiry", selEquip.safetyExp ? (() => {
                  const d = Math.ceil((new Date(selEquip.safetyExp+"T12:00:00")-new Date())/86400000);
                  return `${selEquip.safetyExp} ${d<0?"⚠️ EXPIRED":d<=30?`⚠️ ${d}d`:d<=90?`⚠️ ${d}d`:"✅"}`;
                })() : null],
                [lang==="fr"?"Notes":"Notes", selEquip.notes],
              ].filter(([,v])=>v).map(([l,v])=>(
                <div key={l} style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em"}}>{l}</div>
                  <div style={{fontSize:14,color:C.black,marginTop:2}}>{v}</div>
                </div>
              ))}
            </div>
            {/* Documents */}
            <div style={{fontSize:12,fontWeight:700,color:C.gray,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:10}}>
              {lang==="fr"?"Documents":"Documents"}
            </div>
            {(!selEquip.docs||selEquip.docs.length===0)
              ? <div style={{color:C.gray,fontSize:13,marginBottom:16}}>{lang==="fr"?"Aucun document":"No documents"}</div>
              : (selEquip.docs||[]).map((d,i)=>(
                <div key={i} onClick={()=>window.open(d.url||d,"_blank")} style={{display:"flex",alignItems:"center",gap:12,background:C.surface,borderRadius:10,padding:14,marginBottom:8,border:`1px solid ${C.border}`,cursor:"pointer"}}>
                  <span style={{fontSize:22}}>📄</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.black}}>{d.name||`Document ${i+1}`}</div>
                    {d.uploadedAt&&<div style={{fontSize:11,color:C.gray,marginTop:2}}>{d.uploadedAt?.slice(0,10)}</div>}
                  </div>
                  <span style={{fontSize:18,color:C.gray}}>⬇️</span>
                </div>
              ))
            }
          </div>
        ) : (
          // ── List view ──
          <div>
            {/* Truck / Trailer toggle */}
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              {[["trucks",lang==="fr"?"Camions":"Trucks"],["trailers",lang==="fr"?"Remorques":"Trailers"]].map(([v,l])=>(
                <button key={v} onClick={()=>setEquipTab(v)} style={{flex:1,padding:"10px",borderRadius:10,border:`2px solid ${equipTab===v?C.blue:C.border}`,background:equipTab===v?C.blue+"22":"transparent",color:equipTab===v?C.blue:C.gray,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
              ))}
            </div>
            {/* Search */}
            <input style={{...S.inp,marginBottom:12}} value={equipSearch} onChange={e=>setEquipSearch(e.target.value)} placeholder={lang==="fr"?"Chercher par # d'unité ou plaque...":"Search by unit # or plate..."}/>
            {/* Refresh */}
            <button style={{...S.btn,...S.btnOut,marginBottom:16}} onClick={loadEquipment}>{lang==="fr"?"↻ Actualiser":"↻ Refresh"}</button>
            {equipError && <div style={{background:"#fef2f2",border:"1px solid #dc2626",borderRadius:8,padding:12,marginBottom:12,fontSize:12,color:"#dc2626"}}>⚠️ {equipError}</div>}
            {equipLoading && <div style={{color:C.gray,textAlign:"center",padding:20}}>Loading...</div>}
            {/* Search-only: nothing is listed until the driver types. Keeps the full
                fleet (incl. private management vehicles) from being browsable. */}
            {!equipLoading && !equipSearch.trim() && (
              <div style={{color:C.gray,textAlign:"center",padding:"28px 16px",fontSize:13,lineHeight:1.5}}>
                🔍 {lang==="fr"
                  ? "Entrez un numéro d'unité ou une plaque pour trouver un véhicule."
                  : "Enter a unit # or plate to find a vehicle."}
              </div>
            )}
            {!equipLoading && equipSearch.trim() && (() => {
              const matches = (equipTab==="trucks"?trucks:trailers)
                .filter(x=>(x.unit||"").toLowerCase().includes(equipSearch.toLowerCase())||(x.plate||"").toLowerCase().includes(equipSearch.toLowerCase()))
                .sort((a,b)=>parseFloat(a.unit||0)-parseFloat(b.unit||0));
              if(matches.length===0) return <div style={{color:C.gray,textAlign:"center",padding:20,fontSize:13}}>{lang==="fr"?"Aucune unité trouvée":"No unit found"}</div>;
              return matches
              .map(item=>{
                const expDays = item.safetyExp ? Math.ceil((new Date(item.safetyExp+"T12:00:00")-new Date())/86400000) : null;
                const expColor = expDays===null?C.border:expDays<0?"#dc2626":expDays<=30?"#f59e0b":expDays<=90?"#f97316":"#22c55e";
                return (
                  <div key={item.id} onClick={()=>setSelEquip(item)} style={{background:C.surface,borderRadius:12,padding:14,marginBottom:10,border:`1px solid ${C.border}`,borderLeft:`4px solid ${expColor}`,cursor:"pointer"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <div style={{fontSize:15,fontWeight:700,color:C.black}}>{lang==="fr"?"Unité":"Unit"} {item.unit}</div>
                        <div style={{fontSize:12,color:C.gray,marginTop:2}}>{item.plate||"—"}{item.type?` · ${item.type}`:""}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        {expDays!==null && <div style={{fontSize:11,fontWeight:700,color:expColor}}>{expDays<0?(lang==="fr"?"EXPIRÉ":"EXPIRED"):expDays<=90?`${expDays}d`:"✅"}</div>}
                        {(item.docs||[]).length>0 && <div style={{fontSize:11,color:C.gray,marginTop:4}}>{item.docs.length} {lang==="fr"?"doc":"doc"}{item.docs.length>1?"s":""}</div>}
                      </div>
                    </div>
                  </div>
                );
              });
            })()
            }
          </div>
        )}
      </div>}

      {/* ── Tab 7: Company Documents ── */}
      {tab===7&&<div style={S.screen}>
        <div style={S.title}>{lang==="fr"?"Documents":"Documents"}</div>
        <button style={{...S.btn,...S.btnOut,marginBottom:12}} onClick={loadCompanyDocs}>{lang==="fr"?"↻ Actualiser":"↻ Refresh"}</button>
        <input style={{...S.inp,marginBottom:16}} value={docsSearch} onChange={e=>setDocsSearch(e.target.value)} placeholder={lang==="fr"?"Chercher document...":"Search documents..."}/>

        {/* Shared with you — company → driver docs (read-only), e.g. drug screen for customs */}
        {sharedDocs.length>0 && (
          <div style={{marginBottom:20}}>
            <div style={{fontSize:13,fontWeight:700,color:"#16a34a",marginBottom:8}}>📤 {lang==="fr"?"Partagés avec vous":"Shared with you"}</div>
            {sharedDocs
              .filter(d=>!docsSearch||(d.label||"").toLowerCase().includes(docsSearch.toLowerCase())||(d.name||"").toLowerCase().includes(docsSearch.toLowerCase()))
              .map(d=>(
                <div key={d.id} onClick={()=>window.open(d.url,"_blank")} style={{display:"flex",alignItems:"center",gap:12,background:C.surface,borderRadius:12,padding:16,marginBottom:10,border:"1px solid rgba(34,197,94,0.35)",cursor:"pointer"}}>
                  <span style={{fontSize:24}}>📄</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:700,color:C.black,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{d.label||d.name}</div>
                    <div style={{fontSize:12,color:C.gray,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{d.name}</div>
                  </div>
                  <span style={{fontSize:20,color:C.gray,flexShrink:0}}>⬇️</span>
                </div>
              ))}
            <div style={{height:1,background:C.border,margin:"4px 0 16px"}}/>
          </div>
        )}

        {/* Expiry warnings */}
        {companyDocs.filter(d=>{ const diff=Math.ceil((new Date((d.expiryDate||"")+"T12:00:00")-new Date())/86400000); return d.expiryDate&&diff<=30; }).length>0 && (
          <div style={{background:"#fef3c7",border:"1px solid #f59e0b",borderRadius:10,padding:14,marginBottom:16}}>
            <div style={{fontSize:13,fontWeight:700,color:"#92400e",marginBottom:6}}>⚠️ {lang==="fr"?"Documents expirant bientôt":"Documents expiring soon"}</div>
            {companyDocs.filter(d=>{ const diff=Math.ceil((new Date((d.expiryDate||"")+"T12:00:00")-new Date())/86400000); return d.expiryDate&&diff<=30; }).map(d=>(
              <div key={d.id} style={{fontSize:12,color:"#92400e",marginBottom:2}}>{d.name}</div>
            ))}
          </div>
        )}

        {docsError && <div style={{background:"#fef2f2",border:"1px solid #dc2626",borderRadius:8,padding:12,marginBottom:12,fontSize:12,color:"#dc2626"}}>⚠️ {docsError}</div>}
        {docsLoading && <div style={{color:C.gray,textAlign:"center",padding:20}}>Loading...</div>}
        {!docsLoading && companyDocs.length===0 && sharedDocs.length===0 && <div style={{color:C.gray,textAlign:"center",padding:20}}>{lang==="fr"?"Aucun document trouvé":"No documents found"}</div>}

        {companyDocs
          .filter(d=>!docsSearch||(d.name||"").toLowerCase().includes(docsSearch.toLowerCase())||(d.type||"").toLowerCase().includes(docsSearch.toLowerCase()))
          .map(d=>{
            const expDays = d.expiryDate ? Math.ceil((new Date(d.expiryDate+"T12:00:00")-new Date())/86400000) : null;
            const expired = expDays!==null&&expDays<0;
            const expiring = expDays!==null&&expDays>=0&&expDays<=30;
            return (
              <div key={d.id} onClick={()=>window.open(d.fileUrl,"_blank")} style={{display:"flex",alignItems:"center",gap:12,background:C.surface,borderRadius:12,padding:16,marginBottom:10,border:`1px solid ${expired?"#dc2626":expiring?"#f59e0b":C.border}`,cursor:"pointer"}}>
                <span style={{fontSize:24}}>📄</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:C.black,marginBottom:4}}>{d.name}</div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    {d.type && <span style={{fontSize:11,color:C.gray,background:C.border+"44",padding:"2px 8px",borderRadius:6}}>{d.type}</span>}
                    {expired && <span style={{fontSize:11,fontWeight:700,color:"#dc2626"}}>⚠️ {lang==="fr"?"EXPIRÉ":"EXPIRED"}</span>}
                    {expiring && <span style={{fontSize:11,fontWeight:700,color:"#f59e0b"}}>⚠️ {expDays}d</span>}
                    {!expired&&!expiring&&d.expiryDate && <span style={{fontSize:11,color:"#22c55e",fontWeight:600}}>✅ {lang==="fr"?"Valide":"Valid"}</span>}
                  </div>
                  {d.notes && <div style={{fontSize:12,color:C.gray,marginTop:4}}>{d.notes}</div>}
                </div>
                <span style={{fontSize:20,color:C.gray,flexShrink:0}}>⬇️</span>
              </div>
            );
          })
        }
      </div>}

      {/* ── Screen 8: My Documents ── */}
      {tab===8&&<div style={{...S.screen, paddingBottom: 120}}>
        <div style={S.title}>{t("myDocsTab")}</div>
        <div style={S.sub}>{t("myDocsSub")}</div>

        {/* Already uploaded docs summary */}
        {empDocs.length>0&&(
          <div style={{background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:12,padding:"12px 14px",marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:"#16a34a",marginBottom:8}}>
              ✅ {lang==="fr"?"Documents déjà soumis":"Already submitted"}
            </div>
            {empDocs.map(d=>(
              <div key={d.docId} style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12,color:"#166534",fontWeight:600}}>• {d.label}</span>
                <a href={d.url} target="_blank" rel="noreferrer" style={{fontSize:11,color:"#0ea5e9",textDecoration:"none",fontWeight:600}}>
                  {lang==="fr"?"Voir":"View"} ↗
                </a>
              </div>
            ))}
          </div>
        )}

        {/* Doc upload cards */}
        {DOC_TYPES.map(dt=>{
          const alreadyUploaded = empDocs.find(d=>d.docId===dt.id);
          return (
            <div key={dt.id}>
              {alreadyUploaded && !docFiles[dt.id] && (
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,padding:"4px 10px",background:"rgba(34,197,94,0.1)",borderRadius:6,width:"fit-content"}}>
                  <span style={{fontSize:11,color:"#16a34a",fontWeight:700}}>✅ {t("myDocsAlreadyUploaded")}</span>
                  <span style={{fontSize:11,color:"#64748b"}}>— {alreadyUploaded.fileName}</span>
                </div>
              )}
              <DocCard key={dt.id} docType={dt} file={docFiles[dt.id]} onFile={f=>setDocFiles(p=>({...p,[dt.id]:f}))}
                otherLabel={otherLabel} onOtherLabel={setOtherLabel} lang={lang} t={t} C={C} S={S}/>
            </div>
          );
        })}

        {/* Submit button — large and prominent */}
        <div style={{position:"sticky",bottom:80,marginTop:24,zIndex:10}}>
          <button
            disabled={docSubmitting}
            onClick={submitDocs}
            style={{
              width:"100%",padding:"18px",borderRadius:14,border:"none",
              background:docSubmitting?"#94a3b8":"#16a34a",
              color:"#fff",fontFamily:"inherit",fontSize:17,fontWeight:800,
              cursor:docSubmitting?"not-allowed":"pointer",
              boxShadow:docSubmitting?"none":"0 4px 20px rgba(22,163,74,0.4)",
              letterSpacing:"0.02em",
              transition:"all 0.2s",
            }}>
            {docSubmitting ? t("myDocsSubmitting") : `📎 ${t("myDocsSubmit")}`}
          </button>
        </div>
      </div>}

      {/* Toast */}
      {showSubmitReminder && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:360,width:"100%",textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
            <div style={{fontSize:40,marginBottom:12}}>⚠️</div>
            <div style={{fontSize:17,fontWeight:700,color:"#111",marginBottom:10}}>{lang==="fr"?"N'oubliez pas !":"Don't forget!"}</div>
            <div style={{fontSize:14,color:"#555",lineHeight:1.6,marginBottom:20}}>{stagedExpenses.length>0 ? (lang==="fr"?"Appuyez sur Tout soumettre pour envoyer vos dépenses. Les enregistrer ne les soumet pas.":"Press Submit All to send your expenses. Saving them does not submit them yet.") : pendingEntries.length>0 ? (lang==="fr"?"Appuyez sur Soumettre tout pour enregistrer vos entrées. Les ajouter à la liste ne les sauvegarde pas.":"Press Submit All to save your entries. Adding them to the list does not save them yet.") : (lang==="fr"?"Appuyez sur Soumettre la journée pour enregistrer vos heures. Pointer la sortie seule ne sauvegarde pas votre feuille de temps.":"Press Submit Today's Entry to save your hours. Clocking out alone does not save your timesheet.")}</div>
            <button onClick={()=>setShowSubmitReminder(false)} style={{width:"100%",padding:"14px",borderRadius:10,background:"#DC2626",color:"#fff",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:700}}>{lang==="fr"?"OK, je vais soumettre":"OK, I'll submit"}</button>
          </div>
        </div>
      )}

      {/* ── PIN Verification Modal ── */}
      {pinPrompt && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:360,width:"100%",textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
            <div style={{fontSize:40,marginBottom:12}}>🔒</div>
            <div style={{fontSize:17,fontWeight:700,color:"#111",marginBottom:10}}>{t("pinTitle")}</div>
            <div style={{fontSize:14,color:"#555",lineHeight:1.6,marginBottom:20}}>{t("pinSub", pinPrompt.emp.name.split(" ")[0])}</div>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pinInput}
              onChange={e=>{ setPinInput(e.target.value.replace(/\D/g,"")); setPinError(""); }}
              onKeyDown={e=>{ if(e.key==="Enter") verifyPin(); }}
              placeholder={t("pinPlaceholder")}
              autoFocus
              style={{width:"100%",padding:"14px",borderRadius:10,border:`1.5px solid ${pinError?"#dc2626":"#ddd"}`,fontSize:24,textAlign:"center",letterSpacing:"0.4em",fontFamily:"'DM Mono',monospace",color:"#111",background:"#fff",outline:"none",boxSizing:"border-box",marginBottom:pinError?8:20,WebkitAppearance:"none"}}
            />
            {pinError && <div style={{fontSize:13,color:"#dc2626",fontWeight:600,marginBottom:16}}>{pinError}</div>}
            <button onClick={verifyPin} disabled={submitting} style={{width:"100%",padding:"14px",borderRadius:10,background:"#DC2626",color:"#fff",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:700,marginBottom:8,opacity:submitting?0.6:1}}>{submitting?"...":t("pinVerify")}</button>
            <button onClick={cancelPin} disabled={submitting} style={{width:"100%",padding:"11px",borderRadius:10,background:"transparent",color:"#888",border:"1px solid #ddd",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>{t("pinCancel")}</button>
            <div style={{fontSize:11,color:"#999",marginTop:14}}>{t("pinHelp")}</div>
          </div>
        </div>
      )}

      {/* ── Bottom Navigation Bar (hidden until registered/logged in) ── */}
      {employee && <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:C.black==="#f1f5f9"?"#0f172a":C.black,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:1000,paddingBottom:"env(safe-area-inset-bottom,0px)"}}>
        {[
          {icon:"📋", label:lang==="fr"?"Feuille":"Log",      tabs:[1,2,3,4], go:()=>goTab(tab<=4?tab:2), hide:employee&&employee.logRestricted===true},
          {icon:"📦", label:lang==="fr"?"Commandes":"Orders",  tabs:[5],       go:()=>goTab(5), hide:isGroundCrew},
          {icon:"🚛", label:lang==="fr"?"Équip.":"Equip.",     tabs:[6],       go:()=>goTab(6), hide:isGroundCrew},
          {icon:"📎", label:lang==="fr"?"Mes docs":"My Docs",  tabs:[8],       go:()=>goTab(8)},
          {icon:"📄", label:lang==="fr"?"Docs DBX":"DBX Docs", tabs:[7],       go:()=>goTab(7)},
        ].filter(item=>!item.hide).map(item=>{
          const active = item.tabs.includes(tab);
          return <button key={item.label} onClick={item.go} style={{flex:1,background:"none",border:"none",padding:"10px 4px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",fontFamily:"inherit",color:active?"#dc2626":"#666"}}>
            <span style={{fontSize:22}}>{item.icon}</span>
            <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.02em"}}>{item.label}</span>
          </button>;
        })}
      </div>}

      <div style={{position:"fixed",bottom:90,left:"50%",transform:`translateX(-50%) translateY(${toast.show?0:20}px)`,background:toast.error?"#991b1b":C.green||"#16a34a",color:"#fff",padding:"14px 28px",borderRadius:12,fontSize:15,fontWeight:700,display:"flex",alignItems:"center",gap:10,opacity:toast.show?1:0,transition:"all 0.3s",pointerEvents:"none",whiteSpace:"nowrap",zIndex:999,boxShadow:"0 4px 24px rgba(0,0,0,0.3)"}}>
        <span style={{fontSize:18}}>{toast.error?"❌":"✅"}</span>
        {toast.msg}
      </div>
    </div>
  );
}

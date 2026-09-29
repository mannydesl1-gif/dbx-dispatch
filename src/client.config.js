// ═══════════════════════════════════════════════════════════════
//  CLIENT CONFIG — Edit this file for each client deployment
// ═══════════════════════════════════════════════════════════════

export const APP_NAME = "DBX Dispatch";
export const APP_VERSION = "v6.2";
export const COMPANY_NAME = "Diamond Back Express Inc.";
export const LOGO_PATH = "./assets/logo.png";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBGROpss8i4f0txMQkl3i7wt20SPrxek2A",
  authDomain: "dbx-prod.firebaseapp.com",
  projectId: "dbx-prod",
  storageBucket: "dbx-prod.firebasestorage.app",
  messagingSenderId: "402235440224",
  appId: "1:402235440224:web:663da4005ec11833bcd705"
};

export const DIVISIONS = [
  { id: "ca", name: "Diamond Back Express Canada", short: "DBX Canada", addr: "4515 Ebenezer Rd Unit 212\nBrampton, Ontario, L6P 2K7" },
  { id: "us", name: "Diamond Back Express LLC", short: "DBX USA", addr: "Suite 400-K-175, 1110 Brickell Ave\nMiami, FL 33131" },
];

export const ACCT_EMAILS = [
  { label: "Manuel Deslauriers", email: "manny@diamondbackexpress.com" },
  { label: "Max",                email: "max@diamondbackexpress.com"   },
  { label: "Carl",               email: "carl@diamondbackexpress.com"  },
  { label: "Chris St-Germain",   email: "chris@diamondbackexpress.com" },
  { label: "Nichole",            email: "nichole@diamondbackexpress.com" },
];

export const REPORTS_EMAIL = "manny@diamondbackexpress.com";

export const CLOUD_FUNCTIONS = {
  sendBolEmail:         "https://sendbolemail-lmhvg7gefa-uc.a.run.app",
  sendInvoiceEmail:     "https://sendinvoiceemail-lmhvg7gefa-uc.a.run.app",
  downloadBolPdf:       "https://downloadbolpdf-lmhvg7gefa-uc.a.run.app",
  sendRecapEmail:       "https://sendrecapemail-lmhvg7gefa-uc.a.run.app",
  adminUsers:           "https://adminusers-lmhvg7gefa-uc.a.run.app",
};

export const BOL_COMPANY_LABEL = "Diamond Back Express Inc.";

// Default "Terms & Conditions" text pre-filled on new quotes and orders.
// Edit this to change your standard boilerplate; existing records keep whatever
// text they were saved with (you can still edit per record).
export const DEFAULT_TERMS = "Please note that the fuel listed above will be charged based on actual fuel prices on date of completion. Prices reflect rental quotes (where applicable) at time of quote and may vary. Prices quoted on date given, subject to change - please allow for up to a 10% variance if applicable.\n\nExclude: Demurrage, detention, custom inspection, excessive waiting time";

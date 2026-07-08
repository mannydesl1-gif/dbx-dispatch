import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBGROpss8i4f0txMQkl3i7wt20SPrxek2A",
  authDomain: "dbx-prod.firebaseapp.com",
  projectId: "dbx-prod",
  storageBucket: "dbx-prod.firebasestorage.app",
  messagingSenderId: "402235440224",
  appId: "1:402235440224:web:663da4005ec11833bcd705"
};

const app = initializeApp(firebaseConfig);
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: isSafari,
});
export const storage = getStorage(app);
export const auth = getAuth(app);

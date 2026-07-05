// Firebase bağlantı kurulumu - config bilgileri .env.local dosyasından okunuyor
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Next.js geliştirme modunda dosya birden fazla kez yüklenebiliyor,
// bu yüzden "zaten bir app var mı" kontrolü yapıyoruz (çift başlatmayı önlemek için)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
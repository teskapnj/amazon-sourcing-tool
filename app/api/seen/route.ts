import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, writeBatch, collection, getDocs, deleteDoc } from "firebase/firestore";

// 30 gün = milisaniye cinsinden (görülen ürün bu süre boyunca gizli kalır)
const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// POST: taranan ürünleri toplu olarak "görüldü" (seen) olarak kaydet.
// Belge kimliği = ASIN, yani tekrar görülürse tarihi güncellenir (dedup).
export async function POST(req: NextRequest) {
  try {
    const { asins } = await req.json();
    if (!Array.isArray(asins) || asins.length === 0) {
      return NextResponse.json({ error: "asins array required" }, { status: 400 });
    }
    const now = Date.now();
    const batch = writeBatch(db);
    for (const asin of asins) {
      if (typeof asin === "string" && asin) {
        batch.set(doc(db, "seen", asin), { asin, seenAt: now });
      }
    }
    await batch.commit();
    return NextResponse.json({ success: true, count: asins.length });
  } catch (error: any) {
    console.error("Seen POST error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}

// GET: hâlâ "taze" sayılan (son 30 gün içinde görülmüş) kayıtları döndür.
// Hem sadece ASIN listesi hem de tam kayıt (Seen sekmesi için). Süresi dolanları temizler.
export async function GET() {
  try {
    const snap = await getDocs(collection(db, "seen"));
    const now = Date.now();
    const activeAsins: string[] = [];
    const items: any[] = [];
    const expiredDocs: string[] = [];

    snap.docs.forEach((d) => {
      const data = d.data();
      const seenAt = data.seenAt || 0;
      if (now - seenAt < SEEN_TTL_MS) {
        activeAsins.push(data.asin);
        // Sadece fırsat olanları (tam verili) Seen sekmesinde göster
        if (data.opportunity !== false && data.title) {
          items.push(data);
        }
      } else {
        expiredDocs.push(d.id);
      }
    });

    // En son görülen en üstte
    items.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));

    // Süresi dolanları arka planda temizle
    if (expiredDocs.length > 0) {
      const batch = writeBatch(db);
      expiredDocs.forEach((id) => batch.delete(doc(db, "seen", id)));
      batch.commit().catch((e) => console.error("Seen cleanup error:", e));
    }

    return NextResponse.json({ asins: activeAsins, items });
  } catch (error: any) {
    console.error("Seen GET error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}

// DELETE: bir ürünü seen'den erken çıkar (restore - 30 günü beklemeden tekrar görünsün)
export async function DELETE(req: NextRequest) {
  try {
    const { asin } = await req.json();
    if (!asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }
    await deleteDoc(doc(db, "seen", asin));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Seen DELETE error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
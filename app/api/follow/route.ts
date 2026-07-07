import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";

// POST: bir ürünü "takip ettiklerim" (following) listesine ekle.
// Dismiss'ten farkı: tüm ürün verisini kaydediyoruz ki sonra tam tabloyu gösterebilelim.
export async function POST(req: NextRequest) {
  try {
    const product = await req.json();
    if (!product?.asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }
    // Belge kimliği = ASIN, yani aynı ürün iki kez eklenmez (otomatik dedup)
    await setDoc(doc(db, "following", product.asin), {
      ...product,
      followedAt: Date.now(),
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Follow error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
// PATCH: bir takip edilen ürünün "bought" (alındı) durumunu güncelle
export async function PATCH(req: NextRequest) {
    try {
      const { asin, bought } = await req.json();
      if (!asin) {
        return NextResponse.json({ error: "ASIN required" }, { status: 400 });
      }
      // Sadece bought alanını güncelle, diğer verilere dokunma
      await setDoc(
        doc(db, "following", asin),
        { bought: !!bought, boughtAt: bought ? Date.now() : null },
        { merge: true }
      );
      return NextResponse.json({ success: true });
    } catch (error: any) {
      console.error("Update bought error:", error);
      return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
    }
  }

// DELETE: takipten çıkar
export async function DELETE(req: NextRequest) {
  try {
    const { asin } = await req.json();
    if (!asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }
    await deleteDoc(doc(db, "following", asin));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Un-follow error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}

// GET: tüm takip edilen ürünleri getir (Following sekmesi için).
// En son takip edilen en üstte olacak şekilde sıralıyoruz.
export async function GET() {
  try {
    const snap = await getDocs(collection(db, "following"));
    const items = snap.docs
      .map((d) => d.data())
      .sort((a: any, b: any) => (b.followedAt || 0) - (a.followedAt || 0));
    return NextResponse.json({ items });
  } catch (error: any) {
    console.error("Get following error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
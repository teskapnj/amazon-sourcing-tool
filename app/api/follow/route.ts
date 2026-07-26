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

// PATCH: takip edilen bir ürünün "bought" durumunu VEYA satın alma takip alanlarını güncelle.
// Güncellenebilir alanlar: bought, ebayCost (eBay alım maliyeti), ebayBuyDate (eBay alım tarihi),
// amazonSellDate (Amazon satış tarihi), notes.
// Sadece gönderilen alanlar güncellenir, diğerlerine dokunulmaz (merge: true).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { asin } = body;
    if (!asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }

    const updates: Record<string, any> = {};

    // bought durumu (varsa)
    if ("bought" in body) {
      updates.bought = !!body.bought;
      updates.boughtAt = body.bought ? Date.now() : null;
    }
    // eBay alım maliyeti (sayı, boş bırakılırsa null)
    if ("ebayCost" in body) {
      const v = body.ebayCost;
      updates.ebayCost = v === "" || v === null || v === undefined ? null : Number(v);
    }
    // Tarihler ve not (string alanlar)
    if ("ebayBuyDate" in body) updates.ebayBuyDate = body.ebayBuyDate || null;
    if ("amazonSellDate" in body) updates.amazonSellDate = body.amazonSellDate || null;
    if ("notes" in body) updates.notes = body.notes || null;

    await setDoc(doc(db, "following", asin), updates, { merge: true });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Update following error:", error);
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
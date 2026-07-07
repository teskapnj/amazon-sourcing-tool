import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";

// POST: bir ürünü "elenenler" (dismissed) listesine ekle
// Belge kimliği = ASIN olduğu için aynı ürün iki kez eklenmez (otomatik dedup)
export async function POST(req: NextRequest) {
  try {
    const { asin, title } = await req.json();
    if (!asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }
    await setDoc(doc(db, "dismissed", asin), {
      asin,
      title: title || null,
      dismissedAt: Date.now(),
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Dismiss error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}

// DELETE: bir ürünü elenenler listesinden çıkar (geri al)
export async function DELETE(req: NextRequest) {
  try {
    const { asin } = await req.json();
    if (!asin) {
      return NextResponse.json({ error: "ASIN required" }, { status: 400 });
    }
    await deleteDoc(doc(db, "dismissed", asin));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Un-dismiss error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}

// GET: tüm elenmiş ürünleri getir (Dismissed sekmesi ve arama filtresi için)
export async function GET() {
  try {
    const snap = await getDocs(collection(db, "dismissed"));
    const items = snap.docs.map((d) => d.data());
    return NextResponse.json({ items });
  } catch (error: any) {
    console.error("Get dismissed error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
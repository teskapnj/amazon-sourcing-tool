import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, writeBatch } from "firebase/firestore";

// POST: "seen" koleksiyonundaki TÜM kayıtları sil (sıfırla).
// Firestore batch limiti 500 olduğu için parçalar halinde siliyoruz.
export async function POST() {
  try {
    const snap = await getDocs(collection(db, "seen"));
    const ids = snap.docs.map((d) => d.id);

    if (ids.length === 0) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    // 500'lük parçalar halinde sil
    for (let i = 0; i < ids.length; i += 500) {
      const batch = writeBatch(db);
      ids.slice(i, i + 500).forEach((id) => batch.delete(doc(db, "seen", id)));
      await batch.commit();
    }

    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (error: any) {
    console.error("Clear seen error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, writeBatch, setDoc, getDoc } from "firebase/firestore";
import { ebayConfigured, getEbayToken } from "@/lib/ebay";

// eBay satıcı taraması: bir satıcının medya listing'lerini çeker, GTIN'i olanları
// Keepa'ya sorar, eşleşenleri Firestore'a yazar (kullanıcı silene kadar kalıcı).
//
// AKIŞ (her istekte 100 listing):
//   1. eBay item_summary/search  -> listing listesi (kategori başına ayrı istek, tek kategori limiti var)
//   2. eBay item/{itemId}        -> GTIN (özet aramada kod GELMİYOR, detayda var) - 1 istek/listing
//   3. Keepa /product?code=      -> ASIN, fiyat, BSR (~1 token/ürün)
//   4. Keepa'da BULUNAN ürünler Firestore "sellerScan" koleksiyonuna yazılır
//
// MALİYET: 100 listing = ~104 eBay isteği + ~(GTIN'li ürün sayısı) Keepa token'ı
// eBay günlük limit: 5000 istek.

const BATCH_SIZE = 100;

// eBay tek seferde 1 kategori kabul ediyor (hata 12030), o yüzden sırayla geziyoruz.
const MEDIA_CATEGORIES: { id: string; label: string }[] = [
  { id: "267", label: "Books" },
  { id: "11233", label: "Music" },
  { id: "11232", label: "Movies & TV" },
  { id: "1249", label: "Video Games" },
];

const EBAY_PAGE_SIZE = 50; // Browse API max limit
const DETAIL_CONCURRENCY = 10; // aynı anda kaç detay isteği

type Cursor = { catIndex: number; offset: number };

// Satıcı bazlı tarama ilerlemesi (kaldığımız yer) - Firestore'da tutulur
async function loadCursor(seller: string): Promise<Cursor> {
  try {
    const snap = await getDoc(doc(db, "sellerScanState", seller));
    if (snap.exists()) {
      const d = snap.data();
      return { catIndex: d.catIndex ?? 0, offset: d.offset ?? 0 };
    }
  } catch (e) {
    console.error("[SELLER] cursor okuma hatası:", e);
  }
  return { catIndex: 0, offset: 0 };
}

async function saveCursor(seller: string, cursor: Cursor, done: boolean) {
  await setDoc(doc(db, "sellerScanState", seller), { ...cursor, done, updatedAt: Date.now() }).catch(
    (e) => console.error("[SELLER] cursor yazma hatası:", e)
  );
}

// Bir kategoriden listing özetleri çek
async function fetchListingPage(token: string, seller: string, categoryId: string, offset: number) {
  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?category_ids=${categoryId}` +
    `&filter=${encodeURIComponent(`sellers:{${seller}}`)}` +
    `&limit=${EBAY_PAGE_SIZE}` +
    `&offset=${offset}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return { items: [], total: 0 };
  const data = await res.json();
  return { items: (data.itemSummaries || []) as any[], total: data.total ?? 0 };
}

// Listing detayından GTIN (UPC/EAN/ISBN) al - özet aramada bu alan GELMİYOR
async function fetchGtin(token: string, itemId: string): Promise<string | null> {
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return null;
  const d = await res.json();
  if (d.gtin) return String(d.gtin).trim();
  // Yedek: satıcının girdiği özelliklerde ISBN/UPC olabiliyor
  const aspects: any[] = d.localizedAspects || [];
  const hit = aspects.find((a) => /^(isbn|upc|ean)$/i.test(a.name || ""));
  return hit?.value ? String(hit.value).trim() : null;
}

export async function POST(req: NextRequest) {
  try {
    if (!ebayConfigured()) {
      return NextResponse.json({ error: "eBay credentials not configured" }, { status: 500 });
    }
    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
    }

    const body = await req.json();
    const seller: string = (body.seller || "").trim();
    const minPrice = Number(body.minPrice) > 0 ? Number(body.minPrice) : 0;
    const restart = !!body.restart;
    // "all" (hepsi, sırayla) veya tek kategori ID'si
    const categoryFilter: string = body.category || "all";

    if (!seller) {
      return NextResponse.json({ error: "Seller username required" }, { status: 400 });
    }

    const token = await getEbayToken();

    // Tek kategori seçildiyse sadece onu tara. İlerleme (cursor) kategori bazlı
    // tutulsun diye anahtara kategori de ekleniyor.
    const activeCategories =
      categoryFilter === "all"
        ? MEDIA_CATEGORIES
        : MEDIA_CATEGORIES.filter((c) => c.id === categoryFilter);
    const cursorKey = `${seller}__${categoryFilter}`;
    const cursor = restart ? { catIndex: 0, offset: 0 } : await loadCursor(cursorKey);

    // Daha önce taranmış listing'ler (kaydedilenler = görüldü). Tekrar detay isteği
    // atmayalım diye baştan eleniyor - hem eBay kotası hem Keepa token'ı korunur.
    const alreadyScanned = new Set<string>();
    try {
      const prev = await getDocs(collection(db, "sellerScan"));
      prev.docs.forEach((d) => {
        const it = d.data()?.itemId;
        if (it) alreadyScanned.add(it);
      });
    } catch (e) {
      console.error("[SELLER] taranmış listesi okunamadı:", e);
    }

    // --- 1. AŞAMA: 100 listing toplanana kadar kategorileri/sayfaları gez ---
    const collected: any[] = [];
    let skippedCheap = 0;
    let skippedSeen = 0; // daha önce taranmış olduğu için atlananlar

    while (collected.length < BATCH_SIZE && cursor.catIndex < activeCategories.length) {
      const cat = activeCategories[cursor.catIndex];
      const { items, total } = await fetchListingPage(token, seller, cat.id, cursor.offset);

      for (const it of items) {
        if (alreadyScanned.has(it.itemId)) { skippedSeen++; continue; }
        const price = it.price?.value ? Number(it.price.value) : null;
        if (minPrice > 0 && (price === null || price < minPrice)) {
          skippedCheap++;
          continue;
        }
        collected.push({
          itemId: it.itemId,
          ebayTitle: it.title || "",
          ebayPrice: price,
          ebayCondition: it.condition || null,
          ebayUrl: it.itemWebUrl || null,
          ebayCategory: cat.label,
        });
        if (collected.length >= BATCH_SIZE) break;
      }

      cursor.offset += EBAY_PAGE_SIZE;
      // Bu kategori bitti mi? (dönen sonuç yoksa veya toplamı aştıysak sıradakine geç)
      if (items.length === 0 || cursor.offset >= total) {
        cursor.catIndex++;
        cursor.offset = 0;
      }
    }

    const done = cursor.catIndex >= activeCategories.length;
    await saveCursor(cursorKey, cursor, done);

    if (collected.length === 0) {
      return NextResponse.json({ added: 0, scanned: 0, matched: 0, done, note: "Taranacak listing kalmadı." });
    }

    // --- 2. AŞAMA: GTIN'leri çek (listing başına 1 eBay isteği) ---
    for (let i = 0; i < collected.length; i += DETAIL_CONCURRENCY) {
      const slice = collected.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.all(
        slice.map(async (c) => {
          try {
            c.code = await fetchGtin(token, c.itemId);
          } catch {
            c.code = null;
          }
        })
      );
    }

    const withCode = collected.filter((c) => c.code);
    const noCode = collected.filter((c) => !c.code);
    console.log(`[SELLER] ${seller} | toplanan: ${collected.length} | kodu olan: ${withCode.length} | kodsuz: ${noCode.length} | zaten görülmüş: ${skippedSeen}`);

    // Kodu olmayanlar Keepa'ya sorulamaz (başlıkla arama güvenilmez), ama yine de
    // kaydedilir: tabloda "no code" olarak görünür ve bir daha taranmaz.
    const batchIdNC = Date.now();
    if (noCode.length > 0) {
      const batchNC = writeBatch(db);
      for (const c of noCode) {
        batchNC.set(doc(db, "sellerScan", c.itemId.replace(/\|/g, "_")), {
          batchId: batchIdNC,
          itemId: c.itemId,
          ebayTitle: c.ebayTitle,
          ebayPrice: c.ebayPrice,
          ebayCondition: c.ebayCondition,
          ebayUrl: c.ebayUrl,
          ebayCategory: c.ebayCategory,
          code: null,
          noCode: true,
          seller,
          scannedAt: Date.now(),
        });
      }
      await batchNC.commit().catch((e) => console.error("[SELLER] kodsuz kayıt hatası:", e));
    }

    if (withCode.length === 0) {
      return NextResponse.json({ added: 0, noCode: noCode.length, scanned: collected.length, done });
    }

    // --- 3. AŞAMA: Keepa sorgusu (kod -> ürün). Tek istekte birden fazla kod desteklenmiyor,
    // bu yüzden kod başına ayrı istek (~1 token). ---
    const matched: any[] = [];
    const KEEPA_CONCURRENCY = 5;

    for (let i = 0; i < withCode.length; i += KEEPA_CONCURRENCY) {
      const slice = withCode.slice(i, i + KEEPA_CONCURRENCY);
      await Promise.all(
        slice.map(async (c) => {
          try {
            const url = `https://api.keepa.com/product?key=${apiKey}&domain=1&code=${encodeURIComponent(c.code)}&stats=1&history=0&update=48`;
            const res = await fetch(url);
            const data = await res.json();
            const p = Array.isArray(data.products) && data.products.length ? data.products[0] : null;
            if (!p || !p.asin) return;

            const current = p.stats?.current || [];
            const avg90 = p.stats?.avg90 || [];
            const cents = (v: any) => (typeof v === "number" && v > 0 ? v / 100 : null);
            const bsr = typeof current[3] === "number" && current[3] > 0 ? current[3] : null;

            matched.push({
              // eBay tarafı
              itemId: c.itemId,
              ebayTitle: c.ebayTitle,
              ebayPrice: c.ebayPrice,
              ebayCondition: c.ebayCondition,
              ebayUrl: c.ebayUrl,
              ebayCategory: c.ebayCategory,
              code: c.code,
              // Amazon (Keepa) tarafı
              asin: p.asin,
              title: p.title || c.ebayTitle,
              binding: p.binding || null,
              bsr,
              newPrice: cents(current[1]),
              usedPrice: cents(current[2]),
              newAvg90: cents(avg90[1]),
              usedAvg90: cents(avg90[2]),
              amazonUrl: `https://www.amazon.com/dp/${p.asin}`,
              keepaUrl: `https://keepa.com/#!product/1-${p.asin}`,
              seller,
              scannedAt: Date.now(),
            });
          } catch (e) {
            console.error("[SELLER] Keepa sorgu hatası:", e);
          }
        })
      );
    }

   // --- 4. AŞAMA: Firestore'a yaz ---
    // batchId: bu taramanın kimliği. Ana tabloda SADECE en son batch gösterilir,
    // önceki taramalar "Seen" listesine düşer (kullanıcı silene kadar durur).
    const batchId = batchIdNC;
    if (matched.length > 0) {
      const batch = writeBatch(db);
      for (const m of matched) {
        batch.set(doc(db, "sellerScan", m.itemId.replace(/\|/g, "_")), { ...m, batchId });
      }
      await batch.commit().catch((e) => console.error("[SELLER] Firestore yazma hatası:", e));
    }

    console.log(`[SELLER] Keepa eşleşen: ${matched.length}/${withCode.length} | kayıt edildi`);

    return NextResponse.json({
      added: matched.length,
      noCode: noCode.length,
      scanned: collected.length,
      withCode: withCode.length,
      skippedSeen,
      done,
      cursor,
    });
  } catch (error: any) {
    console.error("seller-scan error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}

// Kaydedilmiş tarama sonuçlarını getir
export async function GET() {
  try {
    const snap = await getDocs(collection(db, "sellerScan"));
    const items = snap.docs.map((d) => d.data());
    items.sort((a: any, b: any) => (b.scannedAt ?? 0) - (a.scannedAt ?? 0));
    return NextResponse.json({ items });
  } catch (error) {
    console.error("seller-scan list error:", error);
    return NextResponse.json({ items: [] });
  }
}

// Tüm tarama sonuçlarını sil (+ ilerleme sıfırlanır)
export async function DELETE() {
  try {
    const snap = await getDocs(collection(db, "sellerScan"));
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    const stateSnap = await getDocs(collection(db, "sellerScanState"));
    const batch2 = writeBatch(db);
    stateSnap.docs.forEach((d) => batch2.delete(d.ref));
    await batch2.commit();

    return NextResponse.json({ success: true, deleted: snap.size });
  } catch (error) {
    console.error("seller-scan clear error:", error);
    return NextResponse.json({ error: "Clear failed" }, { status: 500 });
  }
}
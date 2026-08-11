import { NextRequest, NextResponse } from "next/server";
import { ebayConfigured, getEbayToken, priceRangeByTitle } from "@/lib/ebay";
import { visionConfigured, extractBooksFromShelf } from "@/lib/vision";

// Raf/yığın fotoğrafı -> kitap listesi -> eBay fiyat aralıkları.
// Amaç kesin fiyat DEĞİL: yığındaki hangi kitaba elle bakılacağını göstermek.

const EBAY_CONCURRENCY = 8;

export async function POST(req: NextRequest) {
  try {
    if (!visionConfigured()) {
      return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }
    if (!ebayConfigured()) {
      return NextResponse.json({ error: "eBay credentials not configured" }, { status: 500 });
    }

    const body = await req.json();
    const image: string = body.image || "";
    if (!image) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    // 1. AŞAMA: fotoğraftan kitapları oku
    const t0 = Date.now();
    const books = await extractBooksFromShelf(image);
    const visionMs = Date.now() - t0;

    console.log(`[SHELF] Okunan kitap: ${books.length} (${visionMs}ms)`);

    if (books.length === 0) {
      return NextResponse.json({ books: [], note: "Fotoğrafta okunabilir kitap sırtı bulunamadı." });
    }

    // 2. AŞAMA: her kitap için eBay fiyat aralığı (paralel, gruplar halinde)
    const token = await getEbayToken();
    const t1 = Date.now();

    const results: any[] = books.map((b) => ({ ...b, low: null, high: null, count: 0, url: null }));

    for (let i = 0; i < results.length; i += EBAY_CONCURRENCY) {
      const slice = results.slice(i, i + EBAY_CONCURRENCY);
      await Promise.all(
        slice.map(async (r) => {
          try {
            const pr = await priceRangeByTitle(token, r.title, r.author, r.binding);
            r.low = pr.low;
            r.high = pr.high;
            r.count = pr.count;
            r.url = pr.url;
            r.debug = pr.debug;
            console.log(
              `[SHELF-DBG] "${r.title}" (${r.binding})\n` +
              `  sorgu: ${pr.debug?.query}\n` +
              `  filtre: ${pr.debug?.bindingFilter} | katman: ${pr.debug?.tier}\n` +
             `  bulunan: ${pr.count} (alakasız elenen: ${pr.debug?.dropped ?? 0}) | low ${pr.low} | high ${pr.high}\n` +
              (pr.debug?.samples || []).map((s: any) => `    $${s.price} · ${s.condition} · ${s.title}`).join("\n")
            );
          } catch (e) {
            console.error(`[SHELF] eBay hatası (${r.title}):`, e);
          }
        })
      );
    }

    const ebayMs = Date.now() - t1;

  // SIRALAMA YOK: kitaplar fotoğraftaki sırayla kalsın ki elindeki yığınla
    // tabloyu birebir eşleştirebilesin. Değerli olanlar zaten mavi vurgulu.

    console.log(`[SHELF] eBay sorguları: ${results.length} (${ebayMs}ms) | toplam ${visionMs + ebayMs}ms`);

    return NextResponse.json({
      books: results,
      timing: { visionMs, ebayMs, totalMs: visionMs + ebayMs },
    });
  } catch (error: any) {
    console.error("shelf-scan error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
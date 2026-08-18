import { NextRequest, NextResponse } from "next/server";
import { ebayConfigured, getEbayToken, priceRangeByTitle } from "@/lib/ebay";
import { visionConfigured, extractBooksFromShelf } from "@/lib/vision";
import { resolveISBNBatch, collectAsins } from "@/lib/googleBooks";
import { getKeepaBatchProducts } from "@/lib/keepa";

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

    // 1. Gemini Vision
    const t0 = Date.now();
    const extractedBooks: any[] = await extractBooksFromShelf(image);
    const visionMs = Date.now() - t0;

    if (!extractedBooks || extractedBooks.length === 0) {
      return NextResponse.json({ books: [], note: "Fotoğrafta okunabilir kitap bulunamadı." });
    }

    // 2. Google Books ISBN Çözümleme
    const t1 = Date.now();
    const queries = extractedBooks.map((b: any, i: number) => ({
      title: String(b.title || ""),
      author: b.author ? String(b.author) : undefined,
      publisher: b.publisher ? String(b.publisher) : undefined,
      shelfIndex: i,
    }));
    const resolvedResults = await resolveISBNBatch(queries);
    const googleMs = Date.now() - t1;

    // 3. Keepa Batch Sorgusu
    const t2 = Date.now();
    const { asins, asinByIndex } = collectAsins(resolvedResults);
    const keepaDataMap = await getKeepaBatchProducts(asins);
    const keepaMs = Date.now() - t2;

    // 4. eBay Taraması
    const t3 = Date.now();
    const ebayToken = await getEbayToken();

    const results = extractedBooks.map((b: any, i: number) => {
      const resolved = resolvedResults[i]?.best;
      const asin = asinByIndex.get(i);
      const keepa = asin && keepaDataMap[asin] ? keepaDataMap[asin] : null;

      return {
        ...b,
        isbn13: resolved?.isbn13 ?? null,
        isbn10: resolved?.isbn10 ?? null,
        confidence: resolved?.confidence ?? 0,
        ebay: { low: null, high: null, count: 0, url: null, debug: null },
        keepa: keepa ?? { amazonPrice: null, usedPrice: null, salesRank: null },
      };
    });

    for (let i = 0; i < results.length; i += EBAY_CONCURRENCY) {
      const slice = results.slice(i, i + EBAY_CONCURRENCY);
      await Promise.all(
        slice.map(async (r: any) => {
          try {
            const pr = await priceRangeByTitle(
              ebayToken,
              r.title,
              r.author ?? null,
              r.binding ?? null,
              r.isbn13 ?? null
            );
            r.ebay = {
              low: pr.low,
              high: pr.high,
              count: pr.count,
              url: pr.url,
              debug: pr.debug,
            };
          } catch (e) {
            console.error(`[SHELF] eBay hatası (${r.title}):`, e);
          }
        })
      );
    }

    const ebayMs = Date.now() - t3;

    return NextResponse.json({
      books: results,
      timing: { visionMs, googleMs, keepaMs, ebayMs, totalMs: visionMs + googleMs + keepaMs + ebayMs },
    });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
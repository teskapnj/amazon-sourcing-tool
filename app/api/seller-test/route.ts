import { NextRequest, NextResponse } from "next/server";
import { ebayConfigured, getEbayToken } from "@/lib/ebay";

// TEŞHİS AMAÇLI: eBay Browse API'de "sellers" filtresi gerçekten çalışıyor mu,
// dönen listing'lerin kaçında GTIN (UPC/EAN/ISBN) var?
// Keepa'ya HİÇ sorgu atmaz -> 0 token.
// Kullanım: /api/seller-test?seller=KULLANICI_ADI

export async function GET(req: NextRequest) {
  try {
    if (!ebayConfigured()) {
      return NextResponse.json({ error: "eBay credentials not configured" }, { status: 500 });
    }

    const seller = req.nextUrl.searchParams.get("seller");
    if (!seller) {
      return NextResponse.json({ error: "Missing ?seller= parameter" }, { status: 400 });
    }

    const token = await getEbayToken();

   // eBay "q" veya "category_ids" zorunlu tutuyor (hata 12001) AMA tek seferde
    // sadece 1 kategori kabul ediyor (hata 12030) -> kategori başına ayrı istek.
    // Books 267, Music (CD/plak) 11233, Movies & TV 11232, Video Games 1249
    const MEDIA_CATEGORIES: Record<string, string> = {
        "267": "Books",
        "11233": "Music",
        "11232": "Movies & TV",
        "1249": "Video Games",
      };
  
      const items: any[] = [];
      const perCategory: Record<string, any> = {};
  
      for (const catId of Object.keys(MEDIA_CATEGORIES)) {
        const url =
          `https://api.ebay.com/buy/browse/v1/item_summary/search` +
          `?category_ids=${catId}` +
          `&filter=${encodeURIComponent(`sellers:{${seller}}`)}` +
          `&limit=50` +
          `&offset=0`;
  
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            "Content-Type": "application/json",
          },
        });
  
        const raw = await res.text();
        if (!res.ok) {
          perCategory[MEDIA_CATEGORIES[catId]] = { error: raw.slice(0, 400) };
          continue;
        }
  
        const data = JSON.parse(raw);
        const catItems: any[] = data.itemSummaries || [];
        perCategory[MEDIA_CATEGORIES[catId]] = { total: data.total ?? null, returned: catItems.length };
        items.push(...catItems);
      }
  
      if (items.length === 0) {
        return NextResponse.json({ ok: false, seller, perCategory, note: "Hiç listing dönmedi." });
      }

    const sample = items.slice(0, 15).map((it) => ({
      title: (it.title || "").slice(0, 70),
      price: it.price?.value ?? null,
      condition: it.condition ?? null,
      // Keepa eşleşmesi için kritik alan
      gtin: it.epid ? null : null,
      // Browse API'de kod farklı alanlarda gelebiliyor - hepsine bakıyoruz
      codes: {
        epid: it.epid ?? null,
        gtin: (it as any).gtin ?? null,
        upc: Array.isArray((it as any).upc) ? (it as any).upc[0] : (it as any).upc ?? null,
        ean: Array.isArray((it as any).ean) ? (it as any).ean[0] : (it as any).ean ?? null,
        isbn: Array.isArray((it as any).isbn) ? (it as any).isbn[0] : (it as any).isbn ?? null,
      },
    }));

    const withAnyCode = items.filter((it: any) => it.gtin || it.upc || it.ean || it.isbn || it.epid).length;

    return NextResponse.json({
        ok: true,
        seller,
        perCategory,
        returned: items.length,
      withAnyCode,
      withoutCode: items.length - withAnyCode,
      sample,
      // Ham ilk kayıt - hangi alanların gerçekten geldiğini görmek için
      firstItemRaw: items[0] ?? null,
      // Detay endpoint'i GTIN döndürüyor mu? (özet aramada kodlar hiç gelmiyor)
      firstItemDetail: await (async () => {
        const id = items[0]?.itemId;
        if (!id) return null;
        const r = await fetch(
          `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(id)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
              "Content-Type": "application/json",
            },
          }
        );
        if (!r.ok) return { error: (await r.text()).slice(0, 400) };
        const d = await r.json();
        return {
          gtin: d.gtin ?? null,
          epid: d.epid ?? null,
          mpn: d.mpn ?? null,
          // Satıcının girdiği ürün özellikleri - ISBN genelde burada olur
          localizedAspects: d.localizedAspects ?? null,
        };
      })(),
    });
  } catch (error: any) {
    console.error("seller-test error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
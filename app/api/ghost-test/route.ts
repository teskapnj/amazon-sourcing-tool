import { NextRequest, NextResponse } from "next/server";

// TEŞHİS ENDPOINT'İ - offers verisiyle FBA/FBM dağılımını test eder.
// Kullanım: /api/ghost-test
// Kendi ASIN'lerinle: /api/ghost-test?asins=X,Y,Z
//
// Bilinen çiftler (elle doğrulandı):
//   B000023XT4 (HAYALET) vs B000003BZO (GERÇEK)  - "One Day It'll All Make Sense"
//   B000008NP3 (HAYALET) vs B00004RJSB (GERÇEK)  - "Acapella Collection"
//
// MALİYET: offers parametresi ürün başına ~6 token (normalde 1). 4 ürün = ~24 token.

const TEST_ASINS = [
  { asin: "B000023XT4", label: "HAYALET-1" },
  { asin: "B000003BZO", label: "GERCEK-1" },
  { asin: "B000008NP3", label: "HAYALET-2" },
  { asin: "B00004RJSB", label: "GERCEK-2" },
];

// Keepa condition kodları: 1=New, 2=Used LikeNew, 3=Used VeryGood, 4=Used Good, 5=Used Acceptable
function conditionName(c: number): string {
  const map: Record<number, string> = {
    0: "unknown", 1: "NEW", 2: "used-likenew", 3: "used-verygood",
    4: "used-good", 5: "used-acceptable", 6: "refurbished",
    7: "collectible-likenew", 8: "collectible-verygood", 9: "collectible-good", 10: "collectible-acceptable",
  };
  return map[c] ?? String(c);
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KEEPA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
  }

  const custom = req.nextUrl.searchParams.get("asins");
  const targets = custom
    ? custom.split(",").map((a) => ({ asin: a.trim(), label: a.trim() }))
    : TEST_ASINS;

  // offers=20: her ürün için en fazla 20 teklif detayı çek (FBA/FBM, satıcı, durum, fiyat)
  const url =
    `https://api.keepa.com/product?key=${apiKey}&domain=1` +
    `&asin=${targets.map((t) => t.asin).join(",")}` +
    `&stats=1&offers=20&update=48`;

  const res = await fetch(url);
  const data = await res.json();
  const products: any[] = data.products || [];

  const report = targets.map((t) => {
    const p = products.find((x: any) => x.asin === t.asin);
    if (!p) return { label: t.label, asin: t.asin, error: "product not found" };

    const offers: any[] = Array.isArray(p.offers) ? p.offers : [];
    const cur = p.stats?.current || [];

    // Teklifleri FBA/FBM ve New/Used olarak grupla
    let fbaNew = 0, fbmNew = 0, fbaUsed = 0, fbmUsed = 0, amazonOffers = 0, scamFlagged = 0;
    const offerDetails = offers.map((o: any) => {
      const isNew = o.condition === 1;
      if (o.isAmazon) amazonOffers++;
      if (o.isScam) scamFlagged++;
      if (isNew) {
        if (o.isFBA) fbaNew++; else fbmNew++;
      } else {
        if (o.isFBA) fbaUsed++; else fbmUsed++;
      }
      // Teklifin son fiyatı: offerCSV [zaman, fiyat, kargo, zaman, fiyat, kargo, ...]
      const csv = o.offerCSV;
      let lastPrice: number | null = null;
      if (Array.isArray(csv) && csv.length >= 3) {
        const price = csv[csv.length - 2];
        lastPrice = typeof price === "number" && price > 0 ? price / 100 : null;
      }
      return {
        condition: conditionName(o.condition),
        isFBA: !!o.isFBA,
        isAmazon: !!o.isAmazon,
        isScam: !!o.isScam,
        sellerId: o.sellerId ?? null,
        lastPrice,
      };
    });

    return {
      label: t.label,
      asin: t.asin,
      title: p.title,
      newPrice: cur[1] > 0 ? cur[1] / 100 : null,
      usedPrice: cur[2] > 0 ? cur[2] / 100 : null,
      // ANA TEST: FBA/FBM dağılımı
      fbaNew,
      fbmNew,
      fbaUsed,
      fbmUsed,
      amazonOffers,
      scamFlagged,
      // stats'tan gelen resmi sayaçlar (offers ile artık dolu gelmeli)
      statsOfferCountFBA: p.stats?.offerCountFBA ?? null,
      statsOfferCountFBM: p.stats?.offerCountFBM ?? null,
      buyBoxIsFBA: p.stats?.buyBoxIsFBA ?? null,
      totalOffersRetrieved: offers.length,
      offerDetails,
    };
  });

  return NextResponse.json({ tokensLeft: data.tokensLeft, report });
}
import { NextRequest, NextResponse } from "next/server";

// Her kategori: Keepa kök kategori numarası + (opsiyonel) binding filtresi.
// CDs & Vinyl kök kategorisi (5174) CD/Plak/Kaset karışık geliyor,
// bu yüzden binding alanına göre kod tarafında ayırıyoruz.
const CATEGORIES: Record<string, { root: number; binding?: string }> = {
  "Books": { root: 283155 },
  "CDs": { root: 5174, binding: "audioCD" },
  "Vinyl": { root: 5174, binding: "lp_record" },
  "Cassettes": { root: 5174, binding: "cassette" },
  "Video Games": { root: 468642 },
  "Movies & TV": { root: 2625373011 },
};

// New fiyatın Used fiyata oranı en az bu kadar olmalı
const MIN_PRICE_RATIO = 4;

// New teklifi son 90 günde bu orandan fazla stok dışıysa "hayalet listing" say, ele
const MAX_OUT_OF_STOCK_90 = 25;

// Kaç ürün taransın (token maliyeti buna bağlı: ~1 token/ürün)
const PER_PAGE = 100;

// Keepa ürün detayı tek istekte max 100 ASIN kabul ediyor, o yüzden parçalıyoruz
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { category, bsrMin, bsrMax, minPrice } = body;

    const categoryConfig = CATEGORIES[category];
    if (!categoryConfig) {
      return NextResponse.json({ error: "Unsupported category" }, { status: 400 });
    }
    const rootCategory = categoryConfig.root;
    const bindingFilter = categoryConfig.binding; // örn. "audioCD" / "lp_record" / undefined

    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
    }

    // Keepa zamanı: dakika cinsinden, Keepa'nın kendi başlangıç noktasına (2011) göre.
    // Son 7 gün içinde teklif verisi güncellenmiş ürünler (Used fiyatı taze gelsin diye).
    const keepaNowMinutes = Math.floor(Date.now() / 60000) - 21564000;
    const lastOffersUpdate = keepaNowMinutes - 7 * 24 * 60;

    // Ön-filtre: 4x oranı matematiksel olarak tutması imkansız ürünleri baştan ele.
    // New >= minPrice, oran >= 4 için Used <= minPrice/4 olmalı. Üstündekiler zaten elenecek,
    // o yüzden detaylarını hiç çekmeyip token harcamıyoruz.
    const maxUsedCents = Math.round((Number(minPrice) * 100) / MIN_PRICE_RATIO);

    // Adım A: Product Finder sorgusu
    const selection = {
      productType: ["0"],
      singleVariation: true,
      rootCategory: String(rootCategory),
      categories_include: [String(rootCategory)],
      current_SALES_gte: Number(bsrMin),
      current_SALES_lte: Number(bsrMax),
      current_NEW_gte: Math.round(Number(minPrice) * 100),
      current_USED_gte: 1,
      current_USED_lte: maxUsedCents,
      lastOffersUpdate_gte: lastOffersUpdate,
      perPage: PER_PAGE,
      page: 0,
      sort: [["current_SALES", "asc"]],
    };

    const finderUrl = `https://api.keepa.com/query?domain=1&key=${apiKey}`;
    const finderRes = await fetch(finderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });

    const finderData = await finderRes.json();
    const asinList: string[] = finderData.asinList || [];
    let tokensLeft: number | null = finderData.tokensLeft ?? null;

    if (asinList.length === 0) {
      return NextResponse.json({ results: [], tokensLeft, totalFound: 0, scanned: 0 });
    }

    // Adım B: ASIN'leri 100'erli parçalara böl, her parça için detay çek.
    // history=0 -> fiyat geçmişi csv'sini çekme (kullanmıyoruz, yanıtı küçültür/hızlandırır)
    // update=48 -> son 48 saatte güncellenmiş veriyi tekrar zorla çekme (token dostu)
    const asinChunks = chunk(asinList, 100);
    const allProducts: any[] = [];

    for (const group of asinChunks) {
      const productUrl = `https://api.keepa.com/product?key=${apiKey}&domain=1&asin=${group.join(",")}&stats=1&history=0&update=48`;
      const productRes = await fetch(productUrl);
      const productData = await productRes.json();
      if (Array.isArray(productData.products)) {
        allProducts.push(...productData.products);
      }
      if (typeof productData.tokensLeft === "number") {
        tokensLeft = productData.tokensLeft;
      }
    }

    // BSR'yi güvenilir kaynaktan oku: ürünün salesRanks verisinin son değeri
    function readBsr(p: any): number | null {
      const ref = p.salesRankReference;
      const ranks = p.salesRanks?.[String(ref)];
      if (Array.isArray(ranks) && ranks.length >= 2) {
        const last = ranks[ranks.length - 1];
        if (typeof last === "number" && last > 0) return last;
      }
      const fromStats = p.stats?.current?.[3];
      return typeof fromStats === "number" && fromStats > 0 ? fromStats : null;
    }

    // Cent -> dolar çevirici (-1 veya 0 ise "veri yok")
    function cents(v: any): number | null {
      return typeof v === "number" && v > 0 ? v / 100 : null;
    }

    const allResults = allProducts.map((p: any) => {
      const current = p.stats?.current || [];
      const oosArr = p.stats?.outOfStockPercentage90;
      const newOutOfStock90 =
        Array.isArray(oosArr) && typeof oosArr[1] === "number" ? oosArr[1] : null;
      return {
        asin: p.asin,
        title: p.title,
        binding: p.binding || null,
        newPrice: cents(current[1]),
        usedPrice: cents(current[2]),
        bsr: readBsr(p),
        newOutOfStock90,
        amazonUrl: `https://www.amazon.com/dp/${p.asin}`,
        keepaUrl: `https://keepa.com/#!product/1-${p.asin}`,
      };
    });

    const results = allResults
      .filter(
        (r: any) =>
          r.newPrice !== null &&
          r.usedPrice !== null &&
          r.newPrice / r.usedPrice >= MIN_PRICE_RATIO &&
          r.newOutOfStock90 !== null &&
          r.newOutOfStock90 <= MAX_OUT_OF_STOCK_90 &&
          (!bindingFilter || r.binding === bindingFilter)
      )
      .map((r: any) => ({
        ...r,
        ratio: Math.round((r.newPrice / r.usedPrice) * 10) / 10,
      }))
      .sort((a: any, b: any) => b.ratio - a.ratio);

    return NextResponse.json({
      results,
      tokensLeft,
      totalFound: finderData.totalResults ?? null,
      scanned: allResults.length,
    });
  } catch (error) {
    console.error("Keepa search error:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
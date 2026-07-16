import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, writeBatch } from "firebase/firestore";

// Her kategori: Keepa kök kategori numarası + (opsiyonel) binding filtresi.
// CDs & Vinyl kök kategorisi (5174) CD/Plak/Kaset karışık geliyor,
// bu yüzden binding alanına göre kod tarafında ayırıyoruz.
const CATEGORIES: Record<string, { root: number; binding?: string; subCategory?: number | number[] }> = {
  "Books": { root: 283155 },
  "CDs": { root: 5174, binding: "audioCD" },
  "Vinyl": { root: 5174, binding: "lp_record" },
  "Cassettes": { root: 5174, binding: "cassette" },
  "Video Games": { root: 468642 },
  "PS1": { root: 468642, subCategory: 229773 },
  "PS2": { root: 468642, subCategory: 301712 },
  "PS3": { root: 468642, subCategory: 14210751 },
  "PS4": { root: 468642, subCategory: 6427814011 },
  "PS5": { root: 468642, subCategory: 20972781011 },
  "Xbox": { root: 468642, subCategory: [14220161, 537504, 6469269011] },
  "GameCube": { root: 468642, subCategory: 541022 },
  "PC": { root: 468642, subCategory: 229575 },
  "Wii": { root: 468642, subCategory: [14218901, 3075112011] },
  "Dreamcast": { root: 468642, subCategory: 229793 },
  "PSP": { root: 468642, subCategory: 11075221 },
  "Nintendo": { root: 468642, subCategory: [11075831, 16227128011, 206234609011, 229763, 2622269011, 294945, 566458] },
  "Movies & TV": { root: 2625373011 },
};

// Books aramalarında elenecek alt kategoriler (education/textbook gürültüsü):
// Higher & Continuing Education, Adult & Continuing Education, Legal Education,
// Educational Law & Legislation, Medical Education & Training, College & Education Costs
const BOOKS_EXCLUDE_CATEGORIES = ["132424", "89185", "13664", "5479", "21152", "3220"];

// New teklifi son 90 günde bu orandan fazla stok dışıysa "hayalet listing" say, ele
const MAX_OUT_OF_STOCK_90 = 25;

// Kaç TAZE ürün detayı çekilsin (token maliyeti buna bağlı: ~1 token/ürün)
const PER_PAGE = 100;

// Seen (görüldü) süresi: bu süre içinde görülen ürün tekrar gösterilmez
const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

// Finder'dan kaç ASIN isteyelim. Seen olanları eleyeceğimiz için,
// PER_PAGE taze ürüne ulaşmak adına daha geniş bir havuz çekiyoruz.
const FINDER_PAGE_SIZE = 300;

// Keepa ürün detayı tek istekte max 100 ASIN kabul ediyor, o yüzden parçalıyoruz
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Firestore'dan hâlâ taze (30 gün dolmamış) seen ASIN'lerini getir, eskiyi temizle
async function getFreshSeenAsins(): Promise<Set<string>> {
  const snap = await getDocs(collection(db, "seen"));
  const now = Date.now();
  const fresh = new Set<string>();
  const expired: string[] = [];
  snap.docs.forEach((d) => {
    const data = d.data();
    const seenAt = data.seenAt || 0;
    if (now - seenAt < SEEN_TTL_MS) {
      fresh.add(data.asin);
    } else {
      expired.push(d.id);
    }
  });
  if (expired.length > 0) {
    const batch = writeBatch(db);
    expired.forEach((id) => batch.delete(doc(db, "seen", id)));
    batch.commit().catch((e) => console.error("Seen cleanup error:", e));
  }
  return fresh;
}

// Gösterilen taze ürünleri seen olarak kaydet (tüm ürün verisiyle birlikte,
// böylece Seen sekmesinde arama sonucu tablosuyla aynı görünümü gösterebiliriz)
async function markSeen(items: any[]) {
  if (items.length === 0) return;
  const now = Date.now();
  const batch = writeBatch(db);
  for (const it of items) {
    if (it.asin) {
      batch.set(doc(db, "seen", it.asin), { ...it, seenAt: now });
    }
  }
  await batch.commit().catch((e) => console.error("markSeen error:", e));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { category, bsrMin, bsrMax, minPrice, maxPrice } = body;

    const categoryConfig = CATEGORIES[category];
    if (!categoryConfig) {
      return NextResponse.json({ error: "Unsupported category" }, { status: 400 });
    }
    const rootCategory = categoryConfig.root;
    const bindingFilter = categoryConfig.binding;
    // Platform bazlı alt kategori (ör. PS1) - varsa Finder'da rootCategory yerine bunu kullanırız
    const subCategory = categoryConfig.subCategory;

    // Sadece Books kategorisinde education/textbook alt kategorilerini ele
    const excludeCategories = category === "Books" ? BOOKS_EXCLUDE_CATEGORIES : [];

    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
    }

    const keepaNowMinutes = Math.floor(Date.now() / 60000) - 21564000;
    const lastOffersUpdate = keepaNowMinutes - 7 * 24 * 60;

    const minCentsQ = Math.round(Number(minPrice) * 100);
    const maxCentsQ = maxPrice && Number(maxPrice) > 0 ? Math.round(Number(maxPrice) * 100) : null;

    // Adım A: Product Finder sorguları.
    // ESKİDEN: tek sorgu, New fiyatı olma ZORUNLUYDU (current_NEW_gte). Bu, gerçek "New" stoğu
    // neredeyse hiç olmayan retro platformlarda (PS1, GameCube, Dreamcast vb.) havuzu
    // Finder aşamasında sıfırlıyordu - kod tarafındaki filtre hiç devreye girmeden.
    // ŞİMDİ: İKİ sorgu atıyoruz - biri New aralıkta olanlar, biri Used aralıkta olanlar.
    // ASIN listeleri birleştirilip tekilleştirilir. (~+10 token, karşılığında New'i olmayan
    // ürünler de havuza girebiliyor.)
    const baseSelection = {
      productType: ["0"],
      singleVariation: true,
      rootCategory: String(rootCategory),
      categories_include: (Array.isArray(subCategory) ? subCategory : [subCategory ?? rootCategory]).map(String),
      ...(excludeCategories.length > 0 ? { categories_exclude: excludeCategories } : {}),
      current_SALES_gte: Number(bsrMin),
      current_SALES_lte: Number(bsrMax),
      lastOffersUpdate_gte: lastOffersUpdate,
      perPage: FINDER_PAGE_SIZE,
      page: 0,
      sort: [["current_SALES", "asc"]],
    };

    const selections = [
      {
        ...baseSelection,
        current_NEW_gte: minCentsQ,
        ...(maxCentsQ ? { current_NEW_lte: maxCentsQ } : {}),
      },
      {
        ...baseSelection,
        current_USED_gte: minCentsQ,
        ...(maxCentsQ ? { current_USED_lte: maxCentsQ } : {}),
      },
    ];

    const finderUrl = `https://api.keepa.com/query?domain=1&key=${apiKey}`;
    let tokensLeft: number | null = null;
    let totalFound = 0;
    const asinSet = new Set<string>();

    for (const sel of selections) {
      const finderRes = await fetch(finderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sel),
      });
      const finderData = await finderRes.json();
      (finderData.asinList || []).forEach((a: string) => asinSet.add(a));
      if (typeof finderData.totalResults === "number") totalFound += finderData.totalResults;
      if (typeof finderData.tokensLeft === "number") tokensLeft = finderData.tokensLeft;
    }

    const allAsins: string[] = Array.from(asinSet);

    if (allAsins.length === 0) {
      return NextResponse.json({ results: [], tokensLeft, totalFound: totalFound || 0, scanned: 0 });
    }

    // Seen (son 30 günde görülmüş) ASIN'leri çek, Finder sonucundan ELE.
    const seenSet = await getFreshSeenAsins();
    const freshAsins = allAsins.filter((a) => !seenSet.has(a));

    if (freshAsins.length === 0) {
      return NextResponse.json({
        results: [],
        tokensLeft,
        totalFound: totalFound || null,
        scanned: 0,
        allSeen: true,
      });
    }

    const asinsToFetch = freshAsins.slice(0, PER_PAGE);

    // Adım B: taze ASIN'lerin detayını çek (100'erli parçalar)
    const asinChunks = chunk(asinsToFetch, 100);
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

    function cents(v: any): number | null {
      return typeof v === "number" && v > 0 ? v / 100 : null;
    }

    function buildEbayUrl(p: any): string {
      const ean = Array.isArray(p.eanList) && p.eanList.length ? p.eanList[0] : null;
      const upc = Array.isArray(p.upcList) && p.upcList.length ? p.upcList[0] : null;
      const code = ean || upc || p.asin;
      return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(code)}`;
    }

    const allResults = allProducts.map((p: any) => {
      const current = p.stats?.current || [];
      const avg30 = p.stats?.avg30 || [];
      const oosArr = p.stats?.outOfStockPercentage90;
      const newOutOfStock90 =
        Array.isArray(oosArr) && typeof oosArr[1] === "number" ? oosArr[1] : null;
      return {
        asin: p.asin,
        title: p.title,
        // Hangi kategoriden arandığı (Books, CDs, Vinyl, ...) - Seen/Following'de filtrelemek için
        category,
        binding: p.binding || null,
        newPrice: cents(current[1]),
        usedPrice: cents(current[2]),
        // 30 günlük ortalama fiyatlar (cent -> dolar, -1/0 ise null)
        newAvg30: cents(avg30[1]),
        usedAvg30: cents(avg30[2]),
        ebayNewPrice: cents(current[28]),
        ebayUsedPrice: cents(current[29]),
        bsr: readBsr(p),
        newOutOfStock90,
        amazonUrl: `https://www.amazon.com/dp/${p.asin}`,
        keepaUrl: `https://keepa.com/#!product/1-${p.asin}`,
        ebayUrl: buildEbayUrl(p),
      };
    });

    // Hayalet basım ayıklama: aynı BSR'yi paylaşan ürünlerden sadece en ucuz New'i tut
    const bsrGroups = new Map<number, any>();
    for (const r of allResults) {
      if (r.bsr === null || r.newPrice === null) continue;
      const existing = bsrGroups.get(r.bsr);
      if (!existing || r.newPrice < existing.newPrice) {
        bsrGroups.set(r.bsr, r);
      }
    }
    const dedupedResults = allResults.filter((r: any) => {
      if (r.bsr === null || r.newPrice === null) return true;
      return bsrGroups.get(r.bsr) === r;
    });

    // Fiyat aralığı kontrolü (dolar -> cent). Artık ORAN FİLTRE DEĞİL, sadece tabloda
    // bilgi amaçlı gösteriliyor. Ürün, New VEYA Used fiyatından biri aralıktaysa listeye girer.
    const minCents = Math.round(Number(minPrice) * 100);
    const maxCents = maxPrice && Number(maxPrice) > 0 ? Math.round(Number(maxPrice) * 100) : null;
    const inRange = (dollars: number) => {
      const c = Math.round(dollars * 100);
      return c >= minCents && (maxCents === null || c <= maxCents);
    };

    const results = dedupedResults
      .filter((r: any) => {
        if (bindingFilter && r.binding !== bindingFilter) return false;

        // Oyun kategorilerinde (Video Games ve tüm platform alt kategorileri) "Renewed"
        // (yenilenmiş/refurbished) ürünleri ele - bunlar gerçek sıfır New stok değil.
        if (rootCategory === 468642 && /renewed/i.test(r.title || "")) return false;

        // New fiyatı hiç YOKSA: fiyat aralığı kontrolü dahil hiçbir filtre uygulanmadan
        // direkt geçirilir (retro platformlarda New zaten yok, elemeye gerek yok).
        if (r.newPrice === null) return true;

        // New fiyatı VARSA: aralık kontrolü (New veya Used aralıkta olabilir) + stok kontrolü
        const priceQualifies =
          inRange(r.newPrice) || (r.usedPrice !== null && inRange(r.usedPrice));
        if (!priceQualifies) return false;

        return r.newOutOfStock90 !== null && r.newOutOfStock90 <= MAX_OUT_OF_STOCK_90;
      })
      .map((r: any) => ({
        ...r,
        // Oran sadece bilgi amaçlı: New ve Used ikisi de varsa hesaplanır, yoksa null ("-" görünür)
        ratio:
          r.newPrice !== null && r.usedPrice !== null
            ? Math.round((r.newPrice / r.usedPrice) * 10) / 10
            : null,
      }))
      .sort((a: any, b: any) => (b.ratio ?? 0) - (a.ratio ?? 0));

    // Sadece KULLANICIYA GÖSTERİLEN fırsatları (results) seen'e kaydet - tam veriyle.
    // Böylece Seen sekmesinde arama sonucu tablosuyla birebir aynı görünümü gösteririz.
    // (Not: fırsat çıkmayan ürünleri de "görüldü" saymak için ayrıca asinsToFetch'i de
    //  işaretliyoruz ama onları sadece ASIN olarak - tabloda sadece fırsatlar görünecek.)
    await markSeen(results);

    // Fırsat çıkmayan taranan ürünleri de "görüldü" işaretle (sadece ASIN + tarih),
    // ki bir sonraki arama onları tekrar çekmesin. Tabloda görünmezler.
    const resultAsins = new Set(results.map((r: any) => r.asin));
    const nonOpportunityAsins = asinsToFetch.filter((a) => !resultAsins.has(a));
    if (nonOpportunityAsins.length > 0) {
      const now = Date.now();
      const batch = writeBatch(db);
      for (const asin of nonOpportunityAsins) {
        batch.set(doc(db, "seen", asin), { asin, seenAt: now, opportunity: false });
      }
      batch.commit().catch((e) => console.error("markSeen (non-opp) error:", e));
    }

    return NextResponse.json({
      results,
      tokensLeft,
      totalFound: totalFound || null,
      scanned: allProducts.length,
    });
  } catch (error) {
    console.error("Keepa search error:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
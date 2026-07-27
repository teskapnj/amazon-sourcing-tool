import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, writeBatch } from "firebase/firestore";

// Her kategori: Keepa kök kategori numarası + (opsiyonel) binding filtresi.
// CDs & Vinyl kök kategorisi (5174) CD/Plak/Kaset karışık geliyor,
// bu yüzden binding alanına göre kod tarafında ayırıyoruz.
const CATEGORIES: Record<string, { root: number; binding?: string; subCategory?: number | number[] }> = {
  "Books": { root: 283155 },
  "Biography": { root: 283155, subCategory: 2 },
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
// + Science & Math (75): matematik/kimya/fizik/biyoloji ders kitaplarının çoğu bu dalda
// + Law (10777): hukuk casebook/ders kitapları bu dalda
// + Teen & YA > Education & Reference (3344092011): lise ders kitapları (Holt McDougal vb.)
// + Medical Books (173514): tıp/hemşirelik/sağlık ders kitapları
const BOOKS_EXCLUDE_CATEGORIES = ["132424", "89185", "13664", "5479", "21152", "3220", "75", "10777", "3344092011", "173514"];

// ---- HAYALET BASIM FİLTRESİ: 180 günlük ortalama FBA'li NEW teklif sayısı ----
// Doğrulanmış test verisi (2 hayalet / 2 gerçek çift):
//   Hayalet-1: FBA'li New teklif 0   | Gerçek-1: 13
//   Hayalet-2: FBA'li New teklif 1   | Gerçek-2: 13
// FBA satıcı envanterini Amazon deposuna göndermek için para/emek harcar; bunu sadece
// satacağına inandığı ürüne yapar. Hayalet basıma FBA satıcı uğramıyor.
//
// KRİTİK: Bu filtre FINDER sorgusunda uygulanıyor -> EK TOKEN YOK.
// (Aynı bilgiyi ürün detayında "offers" parametresiyle almak ürün başına 1 yerine
//  5 token yakıyordu - ölçüldü. Finder'da bedava.)
// Alan adı Keepa Product Finder "SHOW API QUERY" ile doğrulandı.
//
// VINYL HARİÇ: limited/numbered baskılarda FBA satıcı olmaması NORMAL, orada bu filtre
// gerçek fırsatları elerdi.
const MIN_FBA_NEW_AVG180 = 1;
const GHOST_FILTER_ROOTS = new Set([5174, 2625373011]); // CD/Kaset + Movies & TV

// New teklifi son 90 günde bu orandan fazla stok dışıysa "hayalet listing" say, ele
const MAX_OUT_OF_STOCK_90 = 25;

// Kaç TAZE ürün detayı çekilsin (token maliyeti buna bağlı: ~1 token/ürün)
// 25: tek seferde gözle kontrol edilebilir sayıda sonuç + token tasarrufu.
// Kalanlar zaten "seen" olmadığı için bir sonraki aramada gelir, kaçan olmaz.
const PER_PAGE = 25;

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

    // Hayalet filtresi bu kategoride uygulanacak mı?
    // (Vinyl hariç: limited edition'larda FBA satıcı olmaması normal)
    const ghostFilterActive =
      GHOST_FILTER_ROOTS.has(rootCategory) && category !== "Vinyl";

    // Education/textbook gürültüsünü TÜM kitap kategorilerinde ele
    // (Books, Biography ve ileride eklenecek diğer kitap alt kategorileri - hepsi kök 283155)
    const excludeCategories = rootCategory === 283155 ? BOOKS_EXCLUDE_CATEGORIES : [];

    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
    }

    const keepaNowMinutes = Math.floor(Date.now() / 60000) - 21564000;
    const lastOffersUpdate = keepaNowMinutes - 7 * 24 * 60;

    const minCentsQ = Math.round(Number(minPrice) * 100);
    const maxCentsQ = maxPrice && Number(maxPrice) > 0 ? Math.round(Number(maxPrice) * 100) : null;

    // Adım A: Product Finder sorguları.
    // İKİ sorgu atıyoruz - biri New aralıkta olanlar, biri Used aralıkta olanlar.
    // ASIN listeleri birleştirilip tekilleştirilir.
    const baseSelection = {
      productType: ["0"],
      singleVariation: true,
      rootCategory: String(rootCategory),
      categories_include: (Array.isArray(subCategory) ? subCategory : [subCategory ?? rootCategory]).map(String),
      // BINDING FİLTRESİ FINDER'DA: CD/Vinyl/Kaset aynı kökü (5174) paylaşıyor.
      // Kod tarafında filtrelersek çektiğimiz 25 ürünün yarısı yanlış türde çıkıp
      // token boşa gidiyor (ölçüldü: 24 üründen 12'si eleniyordu).
      ...(bindingFilter ? { binding: [bindingFilter] } : {}),
      ...(excludeCategories.length > 0 ? { categories_exclude: excludeCategories } : {}),
      // HAYALET FİLTRESİ (bedava, Finder tarafında): son 180 günün ortalamasında
      // en az 1 FBA'li New teklif görülmüş olsun. Hayalet basımlara FBA satıcı uğramıyor.
      ...(ghostFilterActive ? { avg180_COUNT_NEW_FBA_gte: MIN_FBA_NEW_AVG180 } : {}),
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

    console.log(`[HUNI] 1) Finder toplam eşleşen: ${totalFound} | çekilen ASIN: ${allAsins.length}`);

    if (allAsins.length === 0) {
      return NextResponse.json({ results: [], tokensLeft, totalFound: totalFound || 0, scanned: 0 });
    }

    // Seen (son 30 günde görülmüş) ASIN'leri çek, Finder sonucundan ELE.
    const seenSet = await getFreshSeenAsins();
    const freshAsins = allAsins.filter((a) => !seenSet.has(a));

    console.log(`[HUNI] 2) Seen elemesi sonrası taze ASIN: ${freshAsins.length} (${allAsins.length - freshAsins.length} tanesi daha önce görülmüş)`);

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

    // Adım B: taze ASIN'lerin detayını çek (100'erli parçalar).
    // offers parametresi KULLANILMIYOR - hayalet filtresi artık Finder tarafında,
    // bu yüzden ürün başına 1 token (offers ile 5 token yakıyordu).
    const asinChunks = chunk(asinsToFetch, 100);
    const allProducts: any[] = [];
    const tokensBeforeProducts = tokensLeft; // gerçek maliyeti ölçmek için

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

    const tokensUsedForProducts =
      tokensBeforeProducts !== null && tokensLeft !== null ? tokensBeforeProducts - tokensLeft : null;

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

    // Sayaç alanları: 0 geçerli bir değer, -1/-2 "veri yok" demek
    function count(v: any): number | null {
      return typeof v === "number" && v >= 0 ? v : null;
    }

    function buildEbayUrl(p: any): string {
      // Başlık öncelikli: eBay satıcılarının çoğu UPC/EAN'i doğru girmiyor, ama başlık
      // her zaman var. Kod bazlı arama (UPC/ISBN) çoğu zaman az/hiç sonuç getirmiyor.
      const query = p.title || p.asin;
      return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`;
    }

    const allResults = allProducts.map((p: any) => {
      const current = p.stats?.current || [];
      const avg90 = p.stats?.avg90 || [];
      const oosArr = p.stats?.outOfStockPercentage90;
      const newOutOfStock90 =
        Array.isArray(oosArr) && typeof oosArr[1] === "number" ? oosArr[1] : null;
      return {
        asin: p.asin,
        title: p.title,
        // eBay aramasında öncelikli kullanılacak ürün kodu (EAN/UPC) - varsa kesin eşleşme sağlar
        upc:
          (Array.isArray(p.eanList) && p.eanList.length ? p.eanList[0] : null) ||
          (Array.isArray(p.upcList) && p.upcList.length ? p.upcList[0] : null) ||
          null,
        // Hangi kategoriden arandığı (Books, CDs, Vinyl, ...) - Seen/Following'de filtrelemek için
        category,
        binding: p.binding || null,
        newPrice: cents(current[1]),
        usedPrice: cents(current[2]),
        // 90 günlük ortalama fiyatlar (cent -> dolar, -1/0 ise null)
        newAvg90: cents(avg90[1]),
        usedAvg90: cents(avg90[2]),
        ebayNewPrice: cents(current[28]),
        ebayUsedPrice: cents(current[29]),
        bsr: readBsr(p),
        newOutOfStock90,
        // Teklif sayıları (BEDAVA - stats.current, bilgi amaçlı)
        newOfferCount: count(current[11]),
        usedOfferCount: count(current[12]),
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
    const inRange = (dollars: number) => {
      const c = Math.round(dollars * 100);
      return c >= minCentsQ && (maxCentsQ === null || c <= maxCentsQ);
    };

    // Huni sayaçları - hangi filtre kaç ürün yiyor görmek için
    let lostBinding = 0, lostRenewed = 0, lostTextbook = 0, lostPrice = 0, lostStock = 0;

    const results = dedupedResults
      .filter((r: any) => {
        if (bindingFilter && r.binding !== bindingFilter) { lostBinding++; return false; }

        // NOT: Hayalet filtresi (FBA'li New teklif) artık FINDER sorgusunda uygulanıyor,
        // burada tekrar kontrol etmeye gerek yok.


        // Oyun kategorilerinde "Renewed" (yenilenmiş) ürünleri ele
        if (rootCategory === 468642 && /renewed/i.test(r.title || "")) { lostRenewed++; return false; }

        // Kitap kategorilerinde ders kitabı/akademik gürültüsünü başlıktan da ele
        if (rootCategory === 283155) {
          const t = r.title || "";
          if (/\b\d+(st|nd|rd|th)\s+edition\b/i.test(t)) { lostTextbook++; return false; }
          if (/\btextbook\b|\bstudy guide\b|\bworkbook\b|\bsolutions? manual\b|\binstructor'?s\b|\bstudent edition\b|\btest bank\b|\blab manual\b|\bcourse\b/i.test(t)) { lostTextbook++; return false; }
          if (/^(elementary|introduction to|introductory|principles of|fundamentals of|essentials of|foundations of|basic|advanced|applied|modern)\s/i.test(t)) { lostTextbook++; return false; }
          if (/\b(algebra|calculus|trigonometry|statistics|biochemistry|organic chemistry|microeconomics|macroeconomics|econometrics|thermodynamics|anatomy (and|&) physiology|pharmacology|psychology|sociology)\b/i.test(t)) { lostTextbook++; return false; }
        }

        // New fiyatı hiç YOKSA: hiçbir filtre uygulanmadan direkt geçir
        if (r.newPrice === null) return true;

        // New fiyatı VARSA: aralık kontrolü + stok kontrolü
        const priceQualifies =
          inRange(r.newPrice) || (r.usedPrice !== null && inRange(r.usedPrice));
        if (!priceQualifies) { lostPrice++; return false; }

        const stockOk = r.newOutOfStock90 !== null && r.newOutOfStock90 <= MAX_OUT_OF_STOCK_90;
        if (!stockOk) lostStock++;
        return stockOk;
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

    console.log(
      `[HUNI] 3) Detayı çekilen: ${allProducts.length} | BSR dedup sonrası: ${dedupedResults.length}\n` +
      `[HUNI] 4) KAYIPLAR -> binding: ${lostBinding} | renewed: ${lostRenewed} | ders kitabı: ${lostTextbook} | fiyat: ${lostPrice} | stok: ${lostStock}\n` +
      `[HUNI] 5) SONUÇ: ${results.length}\n` +
      `[TOKEN] Ürün detayı için harcanan: ${tokensUsedForProducts ?? "?"} (${allProducts.length} ürün) | Kalan: ${tokensLeft} | Hayalet filtresi: ${ghostFilterActive ? "AÇIK (Finder'da, bedava)" : "kapalı"}`
    );

    // Sadece KULLANICIYA GÖSTERİLEN fırsatları (results) seen'e kaydet - tam veriyle.
    // Böylece Seen sekmesinde arama sonucu tablosuyla birebir aynı görünümü gösteririz.
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
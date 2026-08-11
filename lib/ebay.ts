// eBay Browse API ortak yardımcıları.
// Hem /api/ebay-price hem /api/search buradan kullanır (tek token cache).

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

let cachedToken: { value: string; expiresAt: number } | null = null;

export function ebayConfigured(): boolean {
  return !!(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET);
}

export async function getEbayToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token error (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };
  return cachedToken.value;
}

// Kod (UPC/ISBN) + condition (NEW/USED) için en düşük fiyat
export async function lowestPriceForCondition(
  token: string,
  code: string,
  condition: "NEW" | "USED"
): Promise<{ lowest: number | null; count: number }> {
  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?q=${encodeURIComponent(code)}` +
    `&limit=50` +
    `&filter=${encodeURIComponent(`conditions:{${condition}}`)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return { lowest: null, count: 0 };

  const data = await res.json();
  const items: any[] = data.itemSummaries || [];

  const prices: number[] = [];
  for (const it of items) {
    const p = it.price?.value ? Number(it.price.value) : null;
    if (p !== null && !isNaN(p) && p > 0 && it.price?.currency === "USD") {
      prices.push(p);
    }
  }
  prices.sort((a, b) => a - b);

  // EN DÜŞÜĞÜ DEĞİL, İKİNCİ EN DÜŞÜĞÜ: en ucuz listing genelde hasarlı kopya,
  // yanlış baskı veya hiç satmayan tuzak fiyat. İkincisi gerçek tabanı gösteriyor.
  // Tek listing varsa mecburen onu kullanırız.
  const picked = prices.length >= 2 ? prices[1] : prices.length === 1 ? prices[0] : null;

  return {
    lowest: picked !== null ? Math.round(picked * 100) / 100 : null,
    count: prices.length,
  };
}

// eBay web arama linki - FİLTRESİZ (condition seçili gelmez), sadece kodla.
// _sop=15: fiyat + kargo, ucuzdan pahalıya sırala (alım yapacağımız için ucuz olan önemli)
export function ebaySearchUrl(code: string): string {
  const q = encodeURIComponent(code);
  return `https://www.ebay.com/sch/i.html?_from=R40&_nkw=${q}&_sacat=0&_sop=15`;
}

// Tek ürün için New + Used en düşük fiyatlar (paralel)
export async function ebayPricesForCode(token: string, code: string) {
  const [newRes, usedRes] = await Promise.all([
    lowestPriceForCondition(token, code, "NEW"),
    lowestPriceForCondition(token, code, "USED"),
  ]);
  return {
    newLowest: newRes.lowest,
    newCount: newRes.count,
    usedLowest: usedRes.lowest,
    usedCount: usedRes.count,
    url: ebaySearchUrl(code),
  };
}
// Başlık + yazar ile eBay araması (barkodsuz eski kitaplar için).
// İKİ KATMANLI: önce sıkı (tırnaklı) sorgu, sonuç yoksa gevşek sorguya düşer.
export async function priceRangeByTitle(
  token: string,
  title: string,
  author?: string | null,
  binding?: "hardcover" | "paperback" | "unknown" | null
): Promise<{ low: number | null; high: number | null; count: number; url: string; debug?: any }> {
  // Noktalama temizliği: eBay tırnak içindeki virgül/iki nokta/& işaretini
  // birebir arıyor, bu da eşleşmeyi kaçırtıyor.
  const cleanTitle = title.replace(/[:,;]/g, " ").replace(/\s+/g, " ").trim();

  // eBay'de boşluk zaten AND: her kelime listing başlığında GEÇMELİ.
  // 12 kelimelik başlıkta (Complete Shakespeare with the Temple Notes...) hiçbir
  // listing tutmuyor. İlk 6 anlamlı kelime yeterli ayırt edicilik sağlıyor.
  const stopWords = new Set(["the", "a", "an", "of", "and", "to", "in", "for", "with", "by", "or"]);
  const shortTitle = cleanTitle
    .split(" ")
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()))
    .slice(0, 6)
    .join(" ");
  const cleanAuthor = author
    ? author.replace(/&/g, " ").replace(/\s+/g, " ").trim()
    : null;

  const filters: string[] = [];
 // FORMAT FİLTRESİ KAPALI - KANIT: "Bread Lover's Bread Machine Cookbook"
  // eBay'de 44 listing, $5.67'den başlıyor; filtre yüzünden API sadece 2 sonuç
  // görüp $32 diyordu. Model formatı tutarsız tahmin ediyor ve yanlış tahmin
  // sonuçların çoğunu kesiyor.
  const aspectParam = filters.length
    ? `&aspect_filter=${encodeURIComponent(`categoryId:267,${filters.join(",")}`)}`
    : "";

  const webUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
    cleanAuthor ? `${cleanTitle} ${cleanAuthor}` : cleanTitle
  )}&_sacat=267&_sop=15`;

  async function run(q: string) {
    const url =
      `https://api.ebay.com/buy/browse/v1/item_summary/search` +
      `?q=${encodeURIComponent(q)}` +
      `&category_ids=267` +
      `&limit=50` +
      aspectParam;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return { prices: [] as number[], items: [] as any[] };

    const data = await res.json();
    const items: any[] = data.itemSummaries || [];
    const matched = items.filter((it) => titleMatches(it.title || ""));
    const prices: number[] = [];
    for (const it of matched) {
      const p = it.price?.value ? Number(it.price.value) : null;
      if (p !== null && !isNaN(p) && p > 0 && it.price?.currency === "USD") prices.push(p);
    }
    prices.sort((a, b) => a - b);
    return { prices, items: matched, dropped: items.length - matched.length };
  }
  // eBay gevşek eşleştiriyor: "Golden Argosy" araması farklı antolojileri de getiriyor.
  // Başlıktaki anlamlı kelimelerin çoğu listing başlığında geçmiyorsa listing'i ELE.
  function titleMatches(listingTitle: string): boolean {
    const stop = new Set(["the", "a", "an", "of", "and", "to", "in", "for", "with", "by"]);
    const words = cleanTitle
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !stop.has(w));
    if (words.length === 0) return true;

    const lt = listingTitle.toLowerCase();
    const hits = words.filter((w) => lt.includes(w)).length;
    // Anlamlı kelimelerin en az %70'i geçmeli
    return hits / words.length >= 0.7;
  }

 // 1. KATMAN: kısa başlık + yazar. TIRNAK YOK - eBay dokümanına göre boşluk
  // zaten AND anlamına geliyor; tırnak ayrıca "aynı sırayla, aynen" şartı koyup
  // sonuçların çoğunu kesiyordu (Bread Machine Cookbook: 44 listing -> 2).
  const primaryQ = cleanAuthor ? `${shortTitle} ${cleanAuthor}` : shortTitle;
  let { prices, items } = await run(primaryQ);
  let usedQ = primaryQ;
  let tier = "primary";

  // 2. KATMAN: hâlâ sonuç yoksa yazarı at, sadece başlıkla dene.
  // (Model yazarı yanlış okuduysa AND yüzünden her şeyi eliyor olabilir.)
  if (prices.length === 0 && cleanAuthor) {
    const fallback = await run(shortTitle);
    if (fallback.prices.length > 0) {
      prices = fallback.prices;
      items = fallback.items;
      usedQ = shortTitle;
      tier = "title-only";
    }
  }

  const debug = {
    query: usedQ,
    tier,
    bindingFilter: filters.join(",") || "none",
    dropped: (items as any).dropped ?? 0,
    samples: items.slice(0, 5).map((it) => ({
      title: (it.title || "").slice(0, 70),
      price: it.price?.value ?? null,
      condition: it.condition ?? null,
    })),
  };

  if (prices.length === 0) {
    return { low: null, high: null, count: 0, url: webUrl, debug };
  }

 // Aralık gösteriyoruz: low = gerçek taban, high = tavan.
  // İkinci-en-düşük kuralı kaldırıldı - tutarsızdı ve hangi rakamın
  // geldiği belli olmuyordu. Aralık zaten belirsizliği dürüstçe gösteriyor.
  const low = prices[0];
  const high = prices[prices.length - 1];

  return {
    low: Math.round(low * 100) / 100,
    high: Math.round(high * 100) / 100,
    count: prices.length,
    url: webUrl,
    debug,
  };
}
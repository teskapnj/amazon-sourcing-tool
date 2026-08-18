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

  const picked = prices.length >= 2 ? prices[1] : prices.length === 1 ? prices[0] : null;

  return {
    lowest: picked !== null ? Math.round(picked * 100) / 100 : null,
    count: prices.length,
  };
}

// eBay web arama linki - FİLTRESİZ, sadece kodla.
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

// Başlık + yazar veya ISBN13 ile eBay araması.
// ÜÇ KATMANLI: 
//   0. Katman: ISBN-13 (GTIN) ile kesin eşleşme
//   1. Katman: Kısa başlık + yazar
//   2. Katman: Sadece kısa başlık
export async function priceRangeByTitle(
  token: string,
  title: string,
  author?: string | null,
  binding?: "hardcover" | "paperback" | "unknown" | null,
  isbn13?: string | null
): Promise<{ low: number | null; high: number | null; count: number; url: string; debug?: any }> {
  const cleanTitle = title.replace(/[:,;]/g, " ").replace(/\s+/g, " ").trim();

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
  const aspectParam = filters.length
    ? `&aspect_filter=${encodeURIComponent(`categoryId:267,${filters.join(",")}`)}`
    : "";

  const webUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
    isbn13 || (cleanAuthor ? `${cleanTitle} ${cleanAuthor}` : cleanTitle)
  )}&_sacat=267&_sop=15`;

  async function run(q: string, gtinQuery = false) {
    const url =
      `https://api.ebay.com/buy/browse/v1/item_summary/search` +
      `?${gtinQuery ? `gtin=${encodeURIComponent(q)}` : `q=${encodeURIComponent(q)}`}` +
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
    if (!res.ok) return { prices: [] as number[], items: [] as any[], dropped: 0 };

    const data = await res.json();
    const items: any[] = data.itemSummaries || [];
    // GTIN sorgusunda kelime bazlı başlık filtresine gerek kalmaz, direkt eşleşir
    const matched = gtinQuery ? items : items.filter((it) => titleMatches(it.title || ""));
    const prices: number[] = [];
    for (const it of matched) {
      const p = it.price?.value ? Number(it.price.value) : null;
      if (p !== null && !isNaN(p) && p > 0 && it.price?.currency === "USD") prices.push(p);
    }
    prices.sort((a, b) => a - b);
    return { prices, items: matched, dropped: items.length - matched.length };
  }

  function titleMatches(listingTitle: string): boolean {
    const stop = new Set(["the", "a", "an", "of", "and", "to", "in", "for", "with", "by"]);
    const words = cleanTitle
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !stop.has(w));
    if (words.length === 0) return true;

    const lt = listingTitle.toLowerCase();
    const hits = words.filter((w) => lt.includes(w)).length;
    return hits / words.length >= 0.7;
  }

  let prices: number[] = [];
  let items: any[] = [];
  let usedQ = "";
  let tier = "";
  let droppedCount = 0;

  // 0. KATMAN: ISBN-13 var ise gtin parametresiyle nokta atışı arama
  if (isbn13) {
    const gtinRes = await run(isbn13, true);
    if (gtinRes.prices.length > 0) {
      prices = gtinRes.prices;
      items = gtinRes.items;
      usedQ = `gtin:${isbn13}`;
      tier = "isbn13-gtin";
      droppedCount = gtinRes.dropped;
    }
  }

  // 1. KATMAN: ISBN yoksa veya gtin araması sonuç dönmediyse Metin Bazlı Sorgu
  if (prices.length === 0) {
    const primaryQ = cleanAuthor ? `${shortTitle} ${cleanAuthor}` : shortTitle;
    const primaryRes = await run(primaryQ);
    prices = primaryRes.prices;
    items = primaryRes.items;
    usedQ = primaryQ;
    tier = "primary-text";
    droppedCount = primaryRes.dropped;

    // 2. KATMAN: Sadece başlıkla gevşek arama
    if (prices.length === 0 && cleanAuthor) {
      const fallbackRes = await run(shortTitle);
      if (fallbackRes.prices.length > 0) {
        prices = fallbackRes.prices;
        items = fallbackRes.items;
        usedQ = shortTitle;
        tier = "title-only";
        droppedCount = fallbackRes.dropped;
      }
    }
  }

  const debug = {
    query: usedQ,
    tier,
    bindingFilter: filters.join(",") || "none",
    dropped: droppedCount,
    samples: items.slice(0, 5).map((it) => ({
      title: (it.title || "").slice(0, 70),
      price: it.price?.value ?? null,
      condition: it.condition ?? null,
    })),
  };

  if (prices.length === 0) {
    return { low: null, high: null, count: 0, url: webUrl, debug };
  }

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
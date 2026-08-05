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
  let lowest: number | null = null;
  let count = 0;
  for (const it of items) {
    const p = it.price?.value ? Number(it.price.value) : null;
    if (p !== null && !isNaN(p) && p > 0 && it.price?.currency === "USD") {
      count++;
      if (lowest === null || p < lowest) lowest = p;
    }
  }
  return { lowest: lowest !== null ? Math.round(lowest * 100) / 100 : null, count };
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
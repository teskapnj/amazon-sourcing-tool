// lib/keepa.ts
//
// Shelf Scan için Keepa batch fiyat sorgusu.
// ISBN-10 (= kitaplarda ASIN) listesi alır, ASIN -> fiyat haritası döner.

export interface KeepaProductData {
    /** Amazon'un kendi fiyatı varsa o, yoksa New marketplace en düşük */
    amazonPrice: number | null;
    usedPrice: number | null;
    salesRank: number | null;
    /** Kaç Used teklifi var — 0 ise fiyat güvenilmez */
    usedOfferCount: number | null;
  }
  
  /**
   * Keepa stats.current indeksleri (SHOW API QUERY ile doğrulanmış):
   *   0  = AMAZON (Amazon'un kendi satışı)
   *   1  = NEW (marketplace en düşük yeni)
   *   2  = USED (marketplace en düşük ikinci el)
   *   3  = SALES RANK (BSR)
   *   11 = New teklif sayısı
   *   12 = Used teklif sayısı
   */
  const IDX_AMAZON = 0;
  const IDX_NEW = 1;
  const IDX_USED = 2;
  const IDX_RANK = 3;
  const IDX_USED_COUNT = 12;
  
  /** Keepa tek istekte en fazla 100 ASIN kabul eder */
  const CHUNK_SIZE = 100;
  
  /** Keepa -1 = veri yok anlamına gelir. Fiyatlar cent cinsindendir. */
  function centsToDollars(raw: unknown): number | null {
    const n = typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n) / 100;
  }
  
  function toCount(raw: unknown): number | null {
    const n = typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
  
  function toRank(raw: unknown): number | null {
    const n = typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }
  
  async function fetchChunk(
    apiKey: string,
    asins: string[]
  ): Promise<Record<string, KeepaProductData>> {
    const out: Record<string, KeepaProductData> = {};
  
    // ÖNEMLİ: ASIN gönderirken parametre `asin`. `code` sadece UPC/EAN/ISBN-13 içindir.
    const url =
      `https://api.keepa.com/product` +
      `?key=${apiKey}` +
      `&domain=1` +
      `&asin=${asins.join(",")}` +
      `&stats=180`;
  
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[KEEPA] HTTP ${res.status}: ${text.slice(0, 300)}`);
      return out;
    }
  
    const data = await res.json();
  
    // Keepa hatayı 200 içinde de döndürebiliyor — sessizce yutma
    if (data.error) {
      console.error("[KEEPA] API error:", data.error);
      return out;
    }
    if (typeof data.tokensLeft === "number") {
      console.log(
        `[KEEPA] ${asins.length} ASIN sorgulandı, ${data.products?.length ?? 0} ürün döndü, kalan token: ${data.tokensLeft}`
      );
    }
  
    const products: any[] = Array.isArray(data.products) ? data.products : [];
  
    for (const prod of products) {
      if (!prod?.asin) continue;
      const cur = prod.stats?.current;
      if (!Array.isArray(cur)) {
        out[prod.asin] = {
          amazonPrice: null,
          usedPrice: null,
          salesRank: null,
          usedOfferCount: null,
        };
        continue;
      }
  
      // Amazon kendi satmıyorsa (eski ikinci el kitaplarda normal) New'e düş
      const amazonDirect = centsToDollars(cur[IDX_AMAZON]);
      const newPrice = centsToDollars(cur[IDX_NEW]);
  
      out[prod.asin] = {
        amazonPrice: amazonDirect ?? newPrice,
        usedPrice: centsToDollars(cur[IDX_USED]),
        salesRank: toRank(cur[IDX_RANK]),
        usedOfferCount: toCount(cur[IDX_USED_COUNT]),
      };
    }
  
    // Keepa'nın hiç döndürmediği ASIN'ler = Amazon'da karşılığı yok
    const missing = asins.filter((a) => !out[a]);
    if (missing.length > 0) {
      console.log(`[KEEPA] Karşılığı bulunamayan ${missing.length} ASIN:`, missing.slice(0, 10));
    }
  
    return out;
  }
  
  export async function getKeepaBatchProducts(
    asins: string[]
  ): Promise<Record<string, KeepaProductData>> {
    if (!asins || asins.length === 0) return {};
  
    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      console.error("[KEEPA] KEEPA_API_KEY tanımlı değil");
      return {};
    }
  
    // Aynı ASIN iki kez gönderilirse boşuna token yakılır
    const unique = Array.from(new Set(asins.filter(Boolean)));
  
    const merged: Record<string, KeepaProductData> = {};
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      try {
        Object.assign(merged, await fetchChunk(apiKey, chunk));
      } catch (err) {
        console.error("[KEEPA] Batch hatası:", err);
      }
    }
  
    return merged;
  }
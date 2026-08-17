// lib/googleBooks.ts
//
// Google Books API ile başlık/yazar -> ISBN-13 çözümleme katmanı.
// Shelf Scan akışında Gemini'nin sırttan okuduğu serbest metni
// kanonik bir ISBN'e çevirmek için kullanılır.
//
// Akış:
//   Gemini (sırt) -> { title, author, publisher }
//     -> resolveISBNBatch()          <-- BU MODÜL
//     -> ISBN-10 (= kitaplarda ASIN) -> Keepa batch pricing
//     -> eBay gtin=ISBN araması
//
// NOT: Bu modül Keepa veya eBay'i çağırmaz. Sadece ISBN çözer.

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

export interface BookQuery {
    /** Gemini'nin sırttan okuduğu başlık (zorunlu) */
    title: string;
    /** Sırtta yazıyorsa yazar — eşleşme doğruluğunu ciddi artırır */
    author?: string;
    /** Sırtta yazıyorsa yayıncı — baskı ayrımı için kullanılır */
    publisher?: string;
    /** Rafdaki sıra. Sonuçları shelf order'a geri map etmek için. */
    shelfIndex?: number;
  }
  
  export interface ISBNCandidate {
    isbn13: string;
    /** 978 ile başlayan ISBN-13'lerde üretilir. Kitaplarda ASIN = ISBN-10. */
    isbn10: string | null;
    title: string;
    subtitle?: string;
    authors: string[];
    publisher?: string;
    publishedDate?: string;
    /** 0..1 arası. Sorgu ile adayın ne kadar örtüştüğü. */
    confidence: number;
  }
  
  export interface ResolveResult {
    query: BookQuery;
    /** confidence'a göre azalan sırada, MIN_CONFIDENCE altındakiler elenmiş */
    candidates: ISBNCandidate[];
    /** En yüksek confidence'lı aday. Yoksa null. */
    best: ISBNCandidate | null;
    /** Hangi sorgu kademesi tuttu — debug için */
    matchedTier?: "title+author+publisher" | "title+author" | "title";
    error?: string;
  }
  
  // ---------------------------------------------------------------------------
  // Ayarlar
  // ---------------------------------------------------------------------------
  
  const API_BASE = "https://www.googleapis.com/books/v1/volumes";
  
  /** API key opsiyonel ama şiddetle tavsiye edilir. Keysiz kota çok düşük. */
  const API_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";
  
  /** Bu eşiğin altındaki adaylar atılır. Yanlış eşleşme > eşleşmeme. */
  const MIN_CONFIDENCE = 0.35;
  
  /** Aday başına maksimum sonuç. Fazlası Keepa tarafını şişirir. */
  const MAX_CANDIDATES = 5;
  
  /** Tek istek zaman aşımı (ms) */
  const REQUEST_TIMEOUT_MS = 8000;
  
  /** 429/5xx durumunda kaç kez tekrar denensin */
  const MAX_RETRIES = 2;
  
  /**
   * Paralel istek sayısı. Google Books keysiz agresif rate limit uygular;
   * key varsa 8-10'a çıkarılabilir.
   */
  export const DEFAULT_CONCURRENCY = API_KEY ? 8 : 4;
  
  // ---------------------------------------------------------------------------
  // Metin normalizasyonu
  // ---------------------------------------------------------------------------
  
  /** Aksan, noktalama, fazla boşluk temizler; karşılaştırma için küçük harfe çevirir. */
  function normalizeText(input: string): string {
    return input
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // aksan işaretleri
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  
  /** İngilizce stop word'ler — token karşılaştırmasında gürültü yapıyorlar. */
  const STOP_WORDS = new Set([
    "a", "an", "the", "of", "and", "or", "in", "on", "at", "to", "for", "with",
  ]);
  
  function tokenize(input: string): string[] {
    return normalizeText(input)
      .split(" ")
      .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  }
  
  // ---------------------------------------------------------------------------
  // ISBN yardımcıları
  // ---------------------------------------------------------------------------
  
  /** ISBN-13 checksum doğrulaması */
  export function isValidISBN13(isbn: string): boolean {
    const digits = isbn.replace(/[^0-9]/g, "");
    if (digits.length !== 13) return false;
  
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(digits[12]);
  }
  
  /**
   * ISBN-13 -> ISBN-10 dönüşümü.
   *
   * ÖNEMLİ: Sadece 978 önekinde çalışır. 979 ile başlayanların ISBN-10
   * karşılığı YOKTUR — bu kitapların Amazon ASIN'i ISBN'den türetilemez,
   * ayrı ele alınmalı (Keepa'da başlık aramasıyla veya atlanarak).
   */
  export function isbn13ToIsbn10(isbn13: string): string | null {
    const digits = isbn13.replace(/[^0-9]/g, "");
    if (digits.length !== 13) return null;
    if (!digits.startsWith("978")) return null; // 979 -> ISBN-10 yok
  
    const core = digits.slice(3, 12); // 9 haneli gövde
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(core[i]) * (10 - i);
    }
    const remainder = (11 - (sum % 11)) % 11;
    const checkChar = remainder === 10 ? "X" : String(remainder);
    return core + checkChar;
  }
  
  /** Kitaplarda Amazon ASIN'i ISBN-10'a eşittir. Okunabilirlik için alias. */
  export function isbnToAsin(isbn13: string): string | null {
    return isbn13ToIsbn10(isbn13);
  }
  
  // ---------------------------------------------------------------------------
  // Google Books istek katmanı
  // ---------------------------------------------------------------------------
  
  interface GoogleVolume {
    volumeInfo?: {
      title?: string;
      subtitle?: string;
      authors?: string[];
      publisher?: string;
      publishedDate?: string;
      industryIdentifiers?: Array<{ type: string; identifier: string }>;
    };
  }
  
  function buildQueryString(query: BookQuery, tier: number): string | null {
    const parts: string[] = [];
    const title = query.title?.trim();
    if (!title) return null;
  
    parts.push(`intitle:${JSON.stringify(title)}`);
  
    if (tier <= 1 && query.author?.trim()) {
      parts.push(`inauthor:${JSON.stringify(query.author.trim())}`);
    }
    if (tier === 0 && query.publisher?.trim()) {
      parts.push(`inpublisher:${JSON.stringify(query.publisher.trim())}`);
    }
    return parts.join("+");
  }
  
  async function fetchVolumes(q: string): Promise<GoogleVolume[]> {
    const params = new URLSearchParams({
      q,
      printType: "books",
      // 40 = Google Books üst sınırı. Maliyet aynı (tek istek), ama "1984" gibi
      // yaygın/karışık başlıklarda ABD baskısı ilk 10'a girmiyordu.
      maxResults: "40",
      // Almanca/Fransızca/Japonca baskıları API seviyesinde eler.
      // Hindistan/UK İngilizce baskılarını elemez — onlar için regionMultiplier var.
      langRestrict: "en",
      country: "US", // bazı bölgelerden key'siz istekler bunsuz 403 dönüyor
    });
    if (API_KEY) params.set("key", API_KEY);
  
    const url = `${API_BASE}?${params.toString()}`;
  
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
  
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            // exponential backoff: 400ms, 800ms
            await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(`Google Books HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`Google Books HTTP ${res.status}`);
  
        const data = (await res.json()) as { items?: GoogleVolume[] };
        return data.items ?? [];
      } catch (err) {
        clearTimeout(timer);
        if (attempt >= MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
      }
    }
    return [];
  }
  
  // ---------------------------------------------------------------------------
  // Skorlama yardımcıları
  // ---------------------------------------------------------------------------
  
  /**
   * Kutu seti / koleksiyon göstergeleri.
   * Sırtta "Dune" yazıyorsa aday "Dune Saga Collection: Books 1-6" olmamalı —
   * bunlar tamamen farklı ürünler ve fiyatları alakasız.
   */
  const SET_MARKERS = [
    "collection", "collections", "boxed", "box set", "omnibus", "trilogy",
    "saga", "complete", "anthology", "compendium", "bundle", "volumes",
    "series", "set of", "book set",
  ];
  
  function looksLikeSet(text: string): boolean {
    const t = normalizeText(text);
    if (SET_MARKERS.some((m) => t.includes(normalizeText(m)))) return true;
    // "books 1-3", "vol 1 3" gibi aralık ifadeleri
    if (/\b(books?|vols?|volumes?)\s+\d+\s*\d+\b/.test(t)) return true;
    return false;
  }
  
  /**
   * ISBN kayıt grubu -> Amazon US'te işe yarama olasılığı.
   * 978-0 / 978-1 = İngilizce dil grubu (ABD, UK, Kanada, Avustralya).
   * Diğerleri yabancı baskı: Amazon US'te ya listelenmemiş ya değersiz.
   */
  function regionMultiplier(isbn13: string): number {
    if (isbn13.startsWith("9780") || isbn13.startsWith("9781")) return 1.0;
    if (isbn13.startsWith("9798") || isbn13.startsWith("9798")) return 0.9;
    return 0.7;
  }
  
  /**
   * Token bazlı benzerlik — hem recall hem precision.
   *
   * recall    = sorgu token'larının kaçı adayda var
   * precision = aday token'larının kaçı sorguda var
   *
   * Sadece recall kullanmak kutu setlerini tek kitapla eşit puanlıyordu.
   * Precision'a düşük ağırlık veriliyor çünkü sırtta alt başlık okunmuyor —
   * aday başlığın sorgudan uzun olması normal, ama çok uzun olması şüpheli.
   */
  function similarity(query: string, candidate: string): number {
    const q = tokenize(query);
    const c = tokenize(candidate);
    if (q.length === 0 || c.length === 0) return 0;
  
    const cSet = new Set(c);
    const qSet = new Set(q);
  
    let recallHits = 0;
    for (const token of q) {
      if (cSet.has(token)) {
        recallHits++;
        continue;
      }
      // Kısmi eşleşme: OCR hatası / çoğul-tekil farkı
      for (const candToken of cSet) {
        if (
          (token.length >= 4 && candToken.startsWith(token.slice(0, 4))) ||
          (candToken.length >= 4 && token.startsWith(candToken.slice(0, 4)))
        ) {
          recallHits += 0.7;
          break;
        }
      }
    }
    const recall = Math.min(1, recallHits / q.length);
  
    let precisionHits = 0;
    for (const token of c) {
      if (qSet.has(token)) precisionHits++;
    }
    const precision = precisionHits / c.length;
  
    // Recall baskın, precision ince ayar yapar
    return recall * (0.7 + 0.3 * precision);
  }
  
  // ---------------------------------------------------------------------------
  // Skorlama
  // ---------------------------------------------------------------------------
  
  function scoreCandidate(query: BookQuery, vol: GoogleVolume): ISBNCandidate | null {
    const info = vol.volumeInfo;
    if (!info?.title) return null;
  
    const ids = info.industryIdentifiers ?? [];
    const isbn13Entry = ids.find((i) => i.type === "ISBN_13");
    if (!isbn13Entry) return null;
  
    const isbn13 = isbn13Entry.identifier.replace(/[^0-9]/g, "");
    if (!isValidISBN13(isbn13)) return null;
  
    const isbn10 = isbn13ToIsbn10(isbn13);
  
    // Başlık skoru — alt başlık hariç karşılaştır, çünkü sırtta genelde yok
    const titleScore = similarity(query.title, info.title);
  
    // Yazar skoru
    const candidateAuthors = (info.authors ?? []).join(" ");
    const hasAuthorQuery = Boolean(query.author?.trim());
    const authorScore = hasAuthorQuery
      ? similarity(query.author!, candidateAuthors)
      : 0;
  
    // Yayıncı bonusu
    const hasPublisherQuery = Boolean(query.publisher?.trim());
    const publisherScore =
      hasPublisherQuery && info.publisher
        ? similarity(query.publisher!, info.publisher)
        : 0;
  
    // Ağırlıklar: yazar yoksa ağırlığı başlığa devret
    let confidence: number;
    if (hasAuthorQuery) {
      confidence = titleScore * 0.6 + authorScore * 0.35 + publisherScore * 0.05;
    } else {
      confidence = titleScore * 0.95 + publisherScore * 0.05;
    }
  
    // --- Düzeltme çarpanları ---
  
    // 1) Kutu seti uyumsuzluğu: sorgu tek kitap ama aday koleksiyon
    const queryIsSet = looksLikeSet(
      [query.title, query.author ?? ""].join(" ")
    );
    const candidateIsSet = looksLikeSet(
      [info.title, info.subtitle ?? ""].join(" ")
    );
    if (candidateIsSet && !queryIsSet) confidence *= 0.5;
    if (queryIsSet && !candidateIsSet) confidence *= 0.7;
  
    // 2) Yabancı baskı cezası (Amazon US'te karşılığı olmayabilir)
    confidence *= regionMultiplier(isbn13);
  
    // 3) ISBN-10 türetilemiyorsa ASIN de yok — Keepa'ya sorulamaz.
    //    Tamamen elemiyoruz değil, ama ISBN-10'u olan aday öne geçsin.
    if (!isbn10) confidence *= 0.6;
  
    confidence = Math.min(1, confidence);
  
    return {
      isbn13,
      isbn10,
      title: info.title,
      subtitle: info.subtitle,
      authors: info.authors ?? [],
      publisher: info.publisher,
      publishedDate: info.publishedDate,
      confidence: Number(confidence.toFixed(3)),
    };
  }
  
  function dedupeByIsbn(candidates: ISBNCandidate[]): ISBNCandidate[] {
    const seen = new Set<string>();
    const out: ISBNCandidate[] = [];
    for (const c of candidates) {
      if (seen.has(c.isbn13)) continue;
      seen.add(c.isbn13);
      out.push(c);
    }
    return out;
  }
  
  // ---------------------------------------------------------------------------
  // Ana fonksiyonlar
  // ---------------------------------------------------------------------------
  
  /**
   * Tek bir başlık/yazar için ISBN çözer.
   *
   * Kademeli sorgu (fallback ladder):
   *   0) intitle + inauthor + inpublisher  (en dar)
   *   1) intitle + inauthor
   *   2) intitle                            (en geniş)
   *
   * Gemini yayıncıyı veya yazarı yanlış okursa dar sorgu 0 sonuç döner,
   * bir alt kademeye düşülür. Bu yüzden zincir gerekli.
   */
  export async function resolveISBN(query: BookQuery): Promise<ResolveResult> {
    const tierNames = [
      "title+author+publisher",
      "title+author",
      "title",
    ] as const;
  
    if (!query.title?.trim()) {
      return { query, candidates: [], best: null, error: "Empty title" };
    }
  
    for (let tier = 0; tier < 3; tier++) {
      // Bu kademe için gerekli alan yoksa atla
      if (tier === 0 && !(query.author?.trim() && query.publisher?.trim())) continue;
      if (tier === 1 && !query.author?.trim()) continue;
  
      const q = buildQueryString(query, tier);
      if (!q) continue;
  
      try {
        const volumes = await fetchVolumes(q);
        const scored = volumes
          .map((v) => scoreCandidate(query, v))
          .filter((c): c is ISBNCandidate => c !== null && c.confidence >= MIN_CONFIDENCE)
          .sort((a, b) => b.confidence - a.confidence);
  
        const candidates = dedupeByIsbn(scored).slice(0, MAX_CANDIDATES);
  
        if (candidates.length > 0) {
          return {
            query,
            candidates,
            best: candidates[0],
            matchedTier: tierNames[tier],
          };
        }
      } catch (err) {
        // Bu kademe patladıysa bir alta düş; hepsi patlarsa aşağıda raporlanır
        if (tier === 2) {
          return {
            query,
            candidates: [],
            best: null,
            error: err instanceof Error ? err.message : "Unknown error",
          };
        }
      }
    }
  
    return { query, candidates: [], best: null, error: "No match found" };
  }
  
  /** Basit eşzamanlılık sınırlayıcı — p-limit bağımlılığı eklemeden. */
  async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
  
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) break;
          results[i] = await fn(items[i], i);
        }
      }
    );
  
    await Promise.all(workers);
    return results;
  }
  
  /**
   * Bir raf fotoğrafından çıkan tüm başlıkları paralel çözer.
   * Sonuç dizisi girdi sırasını korur (shelf order bozulmaz).
   */
  export async function resolveISBNBatch(
    queries: BookQuery[],
    concurrency: number = DEFAULT_CONCURRENCY
  ): Promise<ResolveResult[]> {
    if (queries.length === 0) return [];
    return mapWithConcurrency(queries, concurrency, (q) => resolveISBN(q));
  }
  
  /**
   * Keepa batch çağrısı için hazır ASIN listesi üretir.
   * 979 önekli kitaplar (ISBN-10'u olmayanlar) `unresolved` içinde döner.
   */
  export function collectAsins(results: ResolveResult[]): {
    asins: string[];
    /** shelfIndex -> ASIN eşlemesi, sonuçları rafa geri map etmek için */
    asinByIndex: Map<number, string>;
    unresolved: BookQuery[];
  } {
    const asins: string[] = [];
    const asinByIndex = new Map<number, string>();
    const unresolved: BookQuery[] = [];
  
    results.forEach((r, i) => {
      const idx = r.query.shelfIndex ?? i;
      const asin = r.best?.isbn10 ?? null;
      if (asin) {
        asins.push(asin);
        asinByIndex.set(idx, asin);
      } else {
        unresolved.push(r.query);
      }
    });
  
    return { asins, asinByIndex, unresolved };
  }
  
  /* ---------------------------------------------------------------------------
  KULLANIM ÖRNEĞİ (Shelf Scan route'unda)
  
    import { resolveISBNBatch, collectAsins } from "@/lib/googleBooks";
  
    // 1) Gemini'den gelen yapılandırılmış çıktı
    const spines = geminiOutput.map((s, i) => ({
      title: s.title,
      author: s.author,
      publisher: s.publisher,
      shelfIndex: i,
    }));
  
    // 2) Paralel ISBN çözümleme (ücretsiz, ~1-2 sn)
    const resolved = await resolveISBNBatch(spines);
  
    // 3) Tek Keepa batch çağrısı — 30 ayrı çağrı yerine 1
    const { asins, asinByIndex, unresolved } = collectAsins(resolved);
    const keepaProducts = await getKeepaProducts(asins);
  
    // 4) eBay: artık gtin=isbn13 ile arayabilirsin
    //    resolved[i].best.isbn13
  
  --------------------------------------------------------------------------- */
// Raf/yığın fotoğrafından kitap listesi çıkarma.
// Model-bağımsız tutuldu: bugün Gemini, yarın başka sağlayıcı olursa sadece bu dosya değişir.

export type ShelfBook = {
    title: string;
    author: string | null;
    binding: "hardcover" | "paperback" | "unknown";
    confidence: "high" | "low";
  };
  
  const MODEL = "gemini-flash-latest";
  
  // Cilt tipi kuralları GERÇEK FOTOĞRAFLA test edildi (8 kitaplık yığın, 8/8 doğru):
  // ince matbaa baskılı sırt -> paperback | ceket/bez/kutu/kalın sert sırt -> hardcover
  const PROMPT = `You are looking at a photo of a stack or shelf of books, viewed from the side (spines facing the camera). The photo may be rotated 90 degrees.
  
  Identify EVERY book you can see, and list them in READING ORDER: start at the top shelf (or top of the stack), go left to right, then move down to the next shelf and repeat. If the photo is rotated, mentally rotate it upright first and then apply this order. Keep this order exactly — it lets the user match the list against the physical books in front of them.

For each book, extract:
  
  - title: the book title as printed on the spine
  - author: the author or editor name if printed, otherwise null
  - binding: "hardcover", "paperback", or "unknown"
  - confidence: "high" if the spine text is clearly legible, "low" if it is faded, partially hidden, or you are guessing
  
  BINDING RULES (important):
  - hardcover: has a dust jacket, cloth/linen texture, a slipcase, or a thick rigid spine
  - paperback: thin flexible spine, glossy or matte printed cover with no jacket
  - unknown: if you cannot tell with confidence — DO NOT guess
  
  Return ONLY a JSON object, no markdown fences, no explanation:
  {"books":[{"title":"...","author":"...","binding":"...","confidence":"..."}]}
  
  If you cannot read a spine at all, skip that book entirely.`;
  
  export function visionConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }
  
  export async function extractBooksFromShelf(base64Image: string): Promise<ShelfBook[]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  
    // "data:image/jpeg;base64," önekini temizle
    const data = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
  
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: "image/jpeg", data } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1, // tahmin değil, okuma istiyoruz
            maxOutputTokens: 8192, // 2048 yetmiyordu, kalabalık raflarda JSON yarıda kesiliyordu
            responseMimeType: "application/json", // model doğrudan geçerli JSON döndürsün
          },
        }),
      }
    );
  
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini error (${res.status}): ${text.slice(0, 300)}`);
    }
  
    const json = await res.json();
    const raw: string = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
    // Model bazen ```json ... ``` sarmalıyor - temizle
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[VISION] JSON parse edilemedi:", cleaned.slice(0, 400));
      return [];
    }
  
    const books: any[] = Array.isArray(parsed?.books) ? parsed.books : [];
  
    return books
      .filter((b) => b && typeof b.title === "string" && b.title.trim().length > 0)
      .map((b) => ({
        title: String(b.title).trim(),
        author: b.author ? String(b.author).trim() : null,
        binding: ["hardcover", "paperback"].includes(b.binding) ? b.binding : "unknown",
        confidence: b.confidence === "low" ? "low" : "high",
      }));
  }
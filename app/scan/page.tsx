"use client";

import { useState, useRef, CSSProperties } from "react";

// Estate sale'de telefonda kullanılacak sayfa: /scan
// Fotoğraf çek -> kitaplar okunsun -> eBay fiyat aralıkları gelsin.
// Amaç kesin fiyat değil: yığındaki hangi kitaba elle bakılacağını göstermek.

type ScanBook = {
  title: string;
  author: string | null;
  binding: "hardcover" | "paperback" | "unknown";
  confidence: "high" | "low";
  low: number | null;
  high: number | null;
  count: number;
  url: string | null;
};

// Bu değerin üstündeki kitaplar vurgulanır - "buna elle bak" sinyali
// Tabanı bu değerin üstündeyse vurgula: en ucuz kopyası bile pahalıysa
// kitap gerçekten değerli demektir (tek bir aykırı listing değil).
const WORTH_CHECKING = 25;

export default function ScanPage() {
  const [books, setBooks] = useState<ScanBook[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Son incelenen kitap - listede nerede kaldığını görmek için açık yeşil
  const [checkedTitle, setCheckedTitle] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Galeriden yükleme için ayrı input: capture="environment" olmadığı için
  // doğrudan kamera açmaz, dosya seçtirir
  const uploadRef = useRef<HTMLInputElement>(null);

  // Telefon fotoğrafı 4-5MB olabiliyor - yüklemeden önce küçült (hız + maliyet)
  async function compress(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(new Error("Read failed"));
      r.readAsDataURL(file);
    });

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1000;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.80));
      };
      img.onerror = () => resolve(dataUrl); // küçültme başarısızsa orijinali gönder
      img.src = dataUrl;
    });
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setStatus("Reading spines...");
    setBooks([]);

    try {
      const compressed = await compress(file);
      setPreview(compressed);

      const res = await fetch("/api/shelf-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: compressed }),
      });
      const data = await res.json();

      if (data.error) {
        setStatus(`Error: ${data.error}`);
      } else {
        setBooks(data.books || []);
        const secs = data.timing ? (data.timing.totalMs / 1000).toFixed(1) : "?";
        setStatus(`${(data.books || []).length} books · ${secs}s`);
      }
    } catch (err) {
      console.error("Scan failed:", err);
      setStatus("Scan failed. Try again.");
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <main style={{ maxWidth: "700px", margin: "0 auto", padding: "20px 14px 60px" }}>
      <h1 className="font-display" style={{ fontSize: "22px", fontWeight: 600, margin: "0 0 4px" }}>
        Shelf Scan
      </h1>
      <p className="font-mono" style={{ fontSize: "11px", color: "#8A8F98", margin: "0 0 18px" }}>
      Photograph a stack of spines. Listed in shelf order.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        style={{ display: "none" }}
      />

<input
        ref={uploadRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        style={{ display: "none" }}
      />

      <div style={{ display: "flex", gap: "10px" }}>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={loading}
          style={{
            flex: 2,
            background: loading ? "#8A8F98" : "var(--ink)",
            color: "#fff",
            border: "none",
            borderRadius: "10px",
            padding: "20px",
            fontSize: "17px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "Scanning..." : "📷  Take photo"}
        </button>
        <button
          onClick={() => uploadRef.current?.click()}
          disabled={loading}
          style={{
            flex: 1,
            background: "transparent",
            color: "var(--ink)",
            border: "1px solid var(--ink)",
            borderRadius: "10px",
            padding: "20px 10px",
            fontSize: "15px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Upload
        </button>
      </div>

      {status && (
        <p className="font-mono" style={{ fontSize: "12px", color: "var(--pine)", marginTop: "12px", marginBottom: 0 }}>
          {status}
        </p>
      )}

      {preview && !loading && (
        <img
          src={preview}
          alt=""
          style={{ width: "100%", borderRadius: "8px", marginTop: "14px" }}
        />
      )}

      <div style={{ marginTop: "20px" }}>
        {books.map((b, i) => {
          const worth = b.low != null && b.low >= WORTH_CHECKING;
          return (
            <div
              key={i}
              onClick={() => setCheckedTitle(b.title)}
              style={{
                border: "1px solid var(--line)",
                borderLeft: worth ? "4px solid #3B82F6" : "1px solid var(--line)",
                borderRadius: "8px",
                padding: "13px 14px",
                marginBottom: "10px",
                cursor: "pointer",
                // Son tıklanan kitap açık yeşil - listede kaldığın yeri gösterir
                background:
                  checkedTitle === b.title
                    ? "#D9F5E0"
                    : worth
                    ? "rgba(59,130,246,0.07)"
                    : b.confidence === "low"
                    ? "rgba(199,119,0,0.06)"
                    : "#fff",
              }}
            >
              <div style={{ fontSize: "15px", fontWeight: 500, lineHeight: 1.35 }}>{b.title}</div>
              <div style={{ fontSize: "13px", color: "#5C6470", marginTop: "2px" }}>
                {b.author || "—"}
                <span className="font-mono" style={{ marginLeft: "8px", fontSize: "11px", color: "#8A8F98" }}>
                  {b.binding === "unknown" ? "?" : b.binding}
                  {b.confidence === "low" && " · unsure"}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: "14px", marginTop: "9px" }}>
                {b.count === 0 ? (
                  <span className="font-mono" style={{ fontSize: "13px", color: "#B0B4BA" }}>no listings</span>
                ) : (
                  <>
                   <span className="font-mono" style={{ fontSize: "19px", fontWeight: 600, color: worth ? "#1D4ED8" : "var(--ink)" }}>
                      ${Math.round(b.low ?? 0)} – ${Math.round(b.high ?? 0)}
                    </span>
                    <span className="font-mono" style={{ fontSize: "12px", color: "#8A8F98" }}>
                      {b.count} listings
                    </span>
                  </>
                )}
                {b.url && (
                  
                    <a href={b.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ marginLeft: "auto", fontSize: "13px", color: "var(--pine)" }}
                  >
                    eBay →
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {books.length > 0 && (
        <p style={{ fontSize: "11px", color: "#8A8F98", marginTop: "18px", lineHeight: 1.5 }}>
          Prices are a range across all editions. First printings can be worth many times more than
          later ones — check the copyright page on anything highlighted.
        </p>
      )}
    </main>
  );
}
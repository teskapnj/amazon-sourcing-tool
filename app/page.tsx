"use client";

import { useState, FormEvent, CSSProperties } from "react";

const CATEGORIES = [
  "Books",
  "CDs & Vinyl",
  "Video Games",
  "DVD",
  "Blu-ray",
];

type ResultItem = {
  title: string;
  bsr: number;
  price: number;
};

export default function Home() {
  const [category, setCategory] = useState("Books");
  const [bsrMin, setBsrMin] = useState("200000");
  const [bsrMax, setBsrMax] = useState("300000");
  const [minPrice, setMinPrice] = useState("90");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setHasSearched(true);

    // Şimdilik sahte veri - Keepa API bağlanınca burası gerçek veriyle değişecek
    setTimeout(() => {
      setResults([]);
      setLoading(false);
    }, 600);
  }

  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "48px 24px" }}>
      {/* Başlık bölümü */}
      <header style={{ marginBottom: "40px", borderBottom: "1px solid var(--line)", paddingBottom: "24px" }}>
        <p className="font-mono" style={{ fontSize: "12px", color: "var(--pine)", letterSpacing: "0.05em", marginBottom: "8px" }}>
          AMAZON SOURCING
        </p>
        <h1 className="font-display" style={{ fontSize: "32px", fontWeight: 600, margin: 0 }}>
          Sourcing Desk
        </h1>
        <p style={{ color: "#5C6470", fontSize: "15px", marginTop: "8px" }}>
          Find Amazon products by category, sales rank range, and price.
        </p>
      </header>

      {/* Arama paneli (form) */}
      <form
        onSubmit={handleSearch}
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "10px",
          padding: "28px",
          marginBottom: "40px",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "20px", marginBottom: "24px" }}>
          {/* Kategori seçimi */}
          <div>
            <label style={labelStyle}>Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={inputStyle}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* BSR minimum */}
          <div>
            <label style={labelStyle}>Sales rank - min (BSR)</label>
            <input
              type="number"
              value={bsrMin}
              onChange={(e) => setBsrMin(e.target.value)}
              style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }}
              placeholder="200000"
            />
          </div>

          {/* BSR maksimum */}
          <div>
            <label style={labelStyle}>Sales rank - max (BSR)</label>
            <input
              type="number"
              value={bsrMax}
              onChange={(e) => setBsrMax(e.target.value)}
              style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }}
              placeholder="300000"
            />
          </div>

          {/* Minimum fiyat */}
          <div>
            <label style={labelStyle}>Min. new price ($)</label>
            <input
              type="number"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }}
              placeholder="90"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            background: "var(--ink)",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            padding: "12px 28px",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Sonuçlar bölümü */}
      <section>
        <h2 className="font-display" style={{ fontSize: "20px", fontWeight: 600, marginBottom: "16px" }}>
          Results
        </h2>

        {!hasSearched && (
          <p style={{ color: "#8A8F98", fontSize: "14px" }}>
            Enter your criteria and click &quot;Search&quot;.
          </p>
        )}

        {hasSearched && !loading && results.length === 0 && (
          <div
            style={{
              border: "1px dashed var(--line)",
              borderRadius: "8px",
              padding: "32px",
              textAlign: "center",
              color: "#8A8F98",
              fontSize: "14px",
            }}
          >
            Not connected to Amazon yet — results will appear here once the Keepa API is wired up.
          </div>
        )}

        {results.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--ink)" }}>
                <th style={thStyle}>Product</th>
                <th style={thStyle}>BSR</th>
                <th style={thStyle}>Price</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={tdStyle}>{r.title}</td>
                  <td className="font-mono" style={tdStyle}>{r.bsr}</td>
                  <td className="font-mono" style={tdStyle}>${r.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

// Ortak stil tanımları (etiketler, inputlar, tablo hücreleri)
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  color: "#5C6470",
  marginBottom: "6px",
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--line)",
  borderRadius: "6px",
  fontSize: "14px",
  background: "#fff",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: "12px",
  color: "#5C6470",
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "12px",
  fontSize: "14px",
};
"use client";

import { useState, useEffect, FormEvent, CSSProperties } from "react";

const CATEGORIES = [
  "Books",
  "CDs",
  "Vinyl",
  "Cassettes",
  "Video Games",
  "Movies & TV",
];

type ResultItem = {
  asin: string;
  title: string;
  bsr: number | null;
  newPrice: number | null;
  usedPrice: number | null;
  ebayNewPrice: number | null;
  ebayUsedPrice: number | null;
  ratio: number;
  amazonUrl: string;
  keepaUrl: string;
  ebayUrl: string;
  bought?: boolean;
};

type Tab = "search" | "following" | "dismissed";

export default function Home() {
  const [tab, setTab] = useState<Tab>("search");

  // Arama formu state'leri
  const [category, setCategory] = useState("Books");
  const [bsrMin, setBsrMin] = useState("200000");
  const [bsrMax, setBsrMax] = useState("300000");
  const [minPrice, setMinPrice] = useState("90");
  const [maxPrice, setMaxPrice] = useState("");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tokensLeft, setTokensLeft] = useState<number | null>(null);
  const [scanInfo, setScanInfo] = useState<{ scanned: number; totalFound: number | null } | null>(null);

  // Firestore listeleri
  const [dismissedAsins, setDismissedAsins] = useState<Set<string>>(new Set());
  const [followedAsins, setFollowedAsins] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState<ResultItem[]>([]);
  const [followFilter, setFollowFilter] = useState<"all" | "notBought" | "bought">("all");
  const [dismissed, setDismissed] = useState<any[]>([]);

  // Sayfa açılınca elenenleri ve takip edilenleri yükle
  useEffect(() => {
    loadDismissed();
    loadFollowing();
  }, []);

  async function loadDismissed() {
    try {
      const res = await fetch("/api/dismiss");
      const data = await res.json();
      const items = data.items || [];
      setDismissed(items);
      setDismissedAsins(new Set(items.map((it: any) => it.asin)));
    } catch (err) {
      console.error("Failed to load dismissed:", err);
    }
  }

  async function loadFollowing() {
    try {
      const res = await fetch("/api/follow");
      const data = await res.json();
      const items = data.items || [];
      setFollowing(items);
      setFollowedAsins(new Set(items.map((it: any) => it.asin)));
    } catch (err) {
      console.error("Failed to load following:", err);
    }
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setHasSearched(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, bsrMin, bsrMax, minPrice, maxPrice }),
      });
      const data = await res.json();
      setResults(data.results || []);
      setScanInfo({ scanned: data.scanned ?? 0, totalFound: data.totalFound ?? null });
      if (typeof data.tokensLeft === "number") setTokensLeft(data.tokensLeft);
    } catch (error) {
      console.error("Search request failed:", error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  // Ele: Firestore'a yaz + ekranda gizle
  async function handleDismiss(item: ResultItem) {
    setDismissedAsins((prev) => new Set(prev).add(item.asin));
    try {
      await fetch("/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin: item.asin, title: item.title }),
      });
      loadDismissed();
    } catch (err) {
      console.error("Dismiss failed:", err);
    }
  }

  // Elemeden geri al
  async function handleUndismiss(asin: string) {
    setDismissedAsins((prev) => {
      const next = new Set(prev);
      next.delete(asin);
      return next;
    });
    try {
      await fetch("/api/dismiss", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin }),
      });
      loadDismissed();
    } catch (err) {
      console.error("Un-dismiss failed:", err);
    }
  }

  // Takip et: tüm ürün verisini Firestore'a kaydet
  async function handleFollow(item: ResultItem) {
    setFollowedAsins((prev) => new Set(prev).add(item.asin));
    try {
      await fetch("/api/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      loadFollowing();
    } catch (err) {
      console.error("Follow failed:", err);
    }
  }

  // Takipten çıkar
  async function handleUnfollow(asin: string) {
    setFollowedAsins((prev) => {
      const next = new Set(prev);
      next.delete(asin);
      return next;
    });
    try {
      await fetch("/api/follow", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin }),
      });
      loadFollowing();
    } catch (err) {
      console.error("Unfollow failed:", err);
    }
  }

  // Alındı (bought) durumunu değiştir
  async function handleToggleBought(item: ResultItem) {
    const newBought = !item.bought;
    // Ekranda anında güncelle
    setFollowing((prev) =>
      prev.map((f) => (f.asin === item.asin ? { ...f, bought: newBought } : f))
    );
    try {
      await fetch("/api/follow", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin: item.asin, bought: newBought }),
      });
    } catch (err) {
      console.error("Toggle bought failed:", err);
    }
  }

  // Arama sonuçlarından elenenleri gizle
  const visibleResults = results.filter((r) => !dismissedAsins.has(r.asin));

  return (
    <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "48px 24px" }}>
      {/* Başlık */}
      <header style={{ marginBottom: "24px", borderBottom: "1px solid var(--line)", paddingBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p className="font-mono" style={{ fontSize: "12px", color: "var(--pine)", letterSpacing: "0.05em", marginBottom: "8px" }}>
              AMAZON SOURCING
            </p>
            <h1 className="font-display" style={{ fontSize: "32px", fontWeight: 600, margin: 0 }}>
              Sourcing Desk
            </h1>
          </div>
          {tokensLeft !== null && (
            <div className="font-mono" style={{ fontSize: "12px", color: "#8A8F98", textAlign: "right" }}>
              Tokens left: {tokensLeft}
            </div>
          )}
        </div>
      </header>

      {/* Arama formu - her zaman üstte sabit */}
      <form onSubmit={handleSearch} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "10px", padding: "28px", marginBottom: "32px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "20px", marginBottom: "24px" }}>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Sales rank - min (BSR)</label>
            <input type="number" value={bsrMin} onChange={(e) => setBsrMin(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="200000" />
          </div>
          <div>
            <label style={labelStyle}>Sales rank - max (BSR)</label>
            <input type="number" value={bsrMax} onChange={(e) => setBsrMax(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="300000" />
          </div>
          <div>
            <label style={labelStyle}>Min. new price ($)</label>
            <input type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="90" />
          </div>
          <div>
            <label style={labelStyle}>Max. new price ($)</label>
            <input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="no limit" />
          </div>
        </div>
        <button type="submit" disabled={loading} style={{ background: "var(--ink)", color: "#fff", border: "none", borderRadius: "6px", padding: "12px 28px", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Sekmeler - formun altında, sonuç alanının üstünde */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        <TabButton active={tab === "search"} onClick={() => setTab("search")} label={`Results (${visibleResults.length})`} />
        <TabButton active={tab === "following"} onClick={() => setTab("following")} label={`Following (${following.length})`} />
        <TabButton active={tab === "dismissed"} onClick={() => setTab("dismissed")} label={`Dismissed (${dismissed.length})`} />
      </div>

      {/* SEARCH (RESULTS) SEKMESİ */}
      {tab === "search" && (
        <>
          {scanInfo && (
            <p className="font-mono" style={{ fontSize: "12px", color: "#8A8F98", marginBottom: "12px" }}>
              Scanned {scanInfo.scanned}{scanInfo.totalFound ? ` of ${scanInfo.totalFound} matching` : ""} · {visibleResults.length} shown
            </p>
          )}
          {!hasSearched && <p style={{ color: "#8A8F98", fontSize: "14px" }}>Enter your criteria and click &quot;Search&quot;.</p>}
          {hasSearched && !loading && visibleResults.length === 0 && (
            <div style={{ border: "1px dashed var(--line)", borderRadius: "8px", padding: "32px", textAlign: "center", color: "#8A8F98", fontSize: "14px" }}>
              No products to show. Try widening the range.
            </div>
          )}
          {visibleResults.length > 0 && (
            <ResultsTable
              items={visibleResults}
              followedAsins={followedAsins}
              onFollow={handleFollow}
              onDismiss={handleDismiss}
            />
          )}
        </>
      )}

      {/* FOLLOWING SEKMESİ */}
      {tab === "following" && (
        following.length === 0 ? (
          <p style={{ color: "#8A8F98", fontSize: "14px" }}>No followed products yet. Star items from Results.</p>
        ) : (
          <>
            {/* Alındı durumuna göre filtre */}
            <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
              <FilterButton active={followFilter === "all"} onClick={() => setFollowFilter("all")} label="All" />
              <FilterButton active={followFilter === "notBought"} onClick={() => setFollowFilter("notBought")} label="Not bought" />
              <FilterButton active={followFilter === "bought"} onClick={() => setFollowFilter("bought")} label="Bought" />
            </div>
            <ResultsTable
              items={following.filter((f) =>
                followFilter === "all" ? true : followFilter === "bought" ? f.bought : !f.bought
              )}
              followedAsins={followedAsins}
              onFollow={handleFollow}
              onUnfollow={handleUnfollow}
              onToggleBought={handleToggleBought}
              mode="following"
            />
          </>
        )
      )}

      {/* DISMISSED SEKMESİ */}
      {tab === "dismissed" && (
        dismissed.length === 0 ? (
          <p style={{ color: "#8A8F98", fontSize: "14px" }}>No dismissed products.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--ink)" }}>
                <th style={thStyle}>Product (ASIN)</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {dismissed.map((d) => (
                <tr key={d.asin} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={tdStyle}>{d.title || d.asin}</td>
                  <td style={tdStyle}>
                    <button onClick={() => handleUndismiss(d.asin)} style={smallBtnStyle}>restore</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </main>
  );
}

// --- Sekme butonu bileşeni ---
function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--ink)" : "transparent",
        color: active ? "#fff" : "var(--ink)",
        border: "1px solid var(--ink)",
        borderRadius: "6px",
        padding: "8px 18px",
        fontSize: "14px",
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// --- Filtre butonu bileşeni (Following sekmesindeki All/Not bought/Bought) ---
function FilterButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--pine)" : "transparent",
        color: active ? "#fff" : "var(--pine)",
        border: "1px solid var(--pine)",
        borderRadius: "4px",
        padding: "5px 12px",
        fontSize: "12px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// --- Ortak sonuç tablosu bileşeni ---
function ResultsTable({
  items,
  followedAsins,
  onFollow,
  onDismiss,
  onUnfollow,
  onToggleBought,
  mode = "search",
}: {
  items: ResultItem[];
  followedAsins: Set<string>;
  onFollow: (item: ResultItem) => void;
  onDismiss?: (item: ResultItem) => void;
  onUnfollow?: (asin: string) => void;
  onToggleBought?: (item: ResultItem) => void;
  mode?: "search" | "following";
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: "2px solid var(--ink)" }}>
          <th style={thStyle}>Product</th>
          <th style={thStyle}>BSR</th>
          <th style={thStyle}>New</th>
          <th style={thStyle}>Used</th>
          <th style={thStyle}>eBay New</th>
          <th style={thStyle}>eBay Used</th>
          <th style={thStyle}>Ratio</th>
          <th style={thStyle}>Keepa</th>
          <th style={thStyle}></th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.asin} style={{ borderBottom: "1px solid var(--line)", background: r.bought ? "#E9F5EC" : "transparent" }}>
            <td style={tdStyle}>
              <a href={r.amazonUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--pine)" }}>{r.title}</a>
            </td>
            <td className="font-mono" style={tdStyle}>{r.bsr ?? "-"}</td>
            <td className="font-mono" style={tdStyle}>{r.newPrice ? `$${r.newPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={tdStyle}>{r.usedPrice ? `$${r.usedPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={tdStyle}>{r.ebayNewPrice ? `$${r.ebayNewPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={tdStyle}>
              <a href={r.ebayUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--pine)" }}>{r.ebayUsedPrice ? `$${r.ebayUsedPrice.toFixed(2)}` : "search"}</a>
            </td>
            <td className="font-mono" style={{ ...tdStyle, color: "var(--gold)", fontWeight: 500 }}>{r.ratio}x</td>
            <td style={tdStyle}>
              <a href={r.keepaUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--pine)", fontSize: "12px" }}>chart</a>
            </td>
            <td style={tdStyle}>
              {mode === "following" ? (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => onToggleBought && onToggleBought(r)}
                    style={{ ...smallBtnStyle, color: r.bought ? "#2E7D46" : "#999", borderColor: r.bought ? "#2E7D46" : "var(--line)" }}
                  >
                    {r.bought ? "✓ bought" : "bought"}
                  </button>
                  <button onClick={() => onUnfollow && onUnfollow(r.asin)} style={smallBtnStyle}>unfollow</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => onFollow(r)}
                    disabled={followedAsins.has(r.asin)}
                    style={{ ...smallBtnStyle, color: followedAsins.has(r.asin) ? "var(--gold)" : "#999" }}
                  >
                    {followedAsins.has(r.asin) ? "★" : "☆"}
                  </button>
                  {onDismiss && (
                    <button onClick={() => onDismiss(r)} style={smallBtnStyle}>✕</button>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Ortak stiller ---
const labelStyle: CSSProperties = { display: "block", fontSize: "12px", color: "#5C6470", marginBottom: "6px", fontWeight: 500 };
const inputStyle: CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid var(--line)", borderRadius: "6px", fontSize: "14px", background: "#fff" };
const thStyle: CSSProperties = { textAlign: "left", padding: "10px 12px", fontSize: "12px", color: "#5C6470", fontWeight: 500 };
const tdStyle: CSSProperties = { padding: "12px", fontSize: "14px" };
const smallBtnStyle: CSSProperties = { background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", color: "#999", fontSize: "12px" };
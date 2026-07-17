"use client";

import { useState, useEffect, useMemo, FormEvent, CSSProperties } from "react";

const CATEGORIES = [
  "Books",
  "Biography",
  "CDs",
  "Vinyl",
  "Cassettes",
  "Video Games",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PS5",
  "Xbox",
  "GameCube",
  "PC",
  "Wii",
  "Dreamcast",
  "PSP",
  "Nintendo",
  "Movies & TV",
];

type ResultItem = {
  asin: string;
  title: string;
  category?: string;
  bsr: number | null;
  newPrice: number | null;
  usedPrice: number | null;
  newAvg90?: number | null;
  usedAvg90?: number | null;
  ebayNewPrice: number | null;
  ebayUsedPrice: number | null;
  ratio: number | null;
  amazonUrl: string;
  keepaUrl: string;
  ebayUrl: string;
  bought?: boolean;
};

type Tab = "search" | "following" | "dismissed" | "seen";

// Sıralanabilir sütunlar - tabloda tıklanabilir başlıklar bu anahtarlarla eşleşir
type SortKey = "bsr" | "newPrice" | "newAvg90" | "usedPrice" | "usedAvg90" | "ebayNewPrice" | "ebayUsedPrice" | "ratio";

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
  const [allSeen, setAllSeen] = useState(false);
  const [tokensLeft, setTokensLeft] = useState<number | null>(null);
  const [scanInfo, setScanInfo] = useState<{ scanned: number; totalFound: number | null; ghostFiltered?: number } | null>(null);

  // Firestore listeleri
  const [dismissedAsins, setDismissedAsins] = useState<Set<string>>(new Set());
  const [followedAsins, setFollowedAsins] = useState<Set<string>>(new Set());
  // En son tıklanan (incelenen) ürün - localStorage'da kalıcı. Sadece SON tıklanan işaretli kalır,
  // yeni bir ürüne tıklayınca öncekinin işareti otomatik kalkar.
  const [lastClickedAsin, setLastClickedAsin] = useState<string | null>(null);
  const [following, setFollowing] = useState<ResultItem[]>([]);
  const [followFilter, setFollowFilter] = useState<"all" | "notBought" | "bought">("all");
  const [followCategoryFilter, setFollowCategoryFilter] = useState<string>("all");
  const [dismissed, setDismissed] = useState<any[]>([]);
  const [seen, setSeen] = useState<ResultItem[]>([]);
  const [seenCategoryFilter, setSeenCategoryFilter] = useState<string>("all");

  // Sayfa açılınca listeleri yükle
  useEffect(() => {
    loadDismissed();
    loadFollowing();
    loadSeen();
    // En son tıklanan ürünü localStorage'dan yükle
    try {
      const stored = localStorage.getItem("lastClickedAsin");
      if (stored) setLastClickedAsin(stored);
    } catch (err) {
      console.error("Failed to load last clicked asin:", err);
    }
  }, []);

  // Bir ürüne tıklandığında (satırı yeşile boyamak için) işaretle - öncekinin işareti otomatik kalkar
  function handleItemClick(asin: string) {
    setLastClickedAsin(asin);
    try {
      localStorage.setItem("lastClickedAsin", asin);
    } catch (err) {
      console.error("Failed to save last clicked asin:", err);
    }
  }

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

  async function loadSeen() {
    try {
      const res = await fetch("/api/seen");
      const data = await res.json();
      setSeen(data.items || []);
    } catch (err) {
      console.error("Failed to load seen:", err);
    }
  }

  // Seen'den erken çıkar (30 günü beklemeden tekrar aramalarda görünsün)
  async function handleRestoreSeen(asin: string) {
    setSeen((prev) => prev.filter((s) => s.asin !== asin));
    try {
      await fetch("/api/seen", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asin }),
      });
    } catch (err) {
      console.error("Restore seen failed:", err);
    }
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setHasSearched(true);
    setAllSeen(false);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, bsrMin, bsrMax, minPrice, maxPrice }),
      });
      const data = await res.json();
      setResults(data.results || []);
      setScanInfo({ scanned: data.scanned ?? 0, totalFound: data.totalFound ?? null, ghostFiltered: data.ghostFiltered ?? 0 });
      setAllSeen(!!data.allSeen);
      if (typeof data.tokensLeft === "number") setTokensLeft(data.tokensLeft);
      loadSeen();
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

  // Arama sonuçlarından elenenleri gizle (seen filtreleme route tarafında yapılıyor)
  const visibleResults = results.filter((r) => !dismissedAsins.has(r.asin));

  // Seen/Following listelerinde GERÇEKTEN mevcut olan kategorileri çıkar
  const seenCategories = Array.from(new Set(seen.map((s) => s.category).filter(Boolean))) as string[];
  const followingCategories = Array.from(new Set(following.map((f) => f.category).filter(Boolean))) as string[];

  const filteredSeen = seen.filter((s) => seenCategoryFilter === "all" || s.category === seenCategoryFilter);
  const filteredFollowing = following.filter((f) => {
    const categoryOk = followCategoryFilter === "all" || f.category === followCategoryFilter;
    const boughtOk =
      followFilter === "all" ? true : followFilter === "bought" ? f.bought : !f.bought;
    return categoryOk && boughtOk;
  });

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
            <label style={labelStyle}>Min. price ($)</label>
            <input type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="90" />
          </div>
          <div>
            <label style={labelStyle}>Max. price ($)</label>
            <input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={{ ...inputStyle, fontFamily: "IBM Plex Mono, monospace" }} placeholder="no limit" />
          </div>
        </div>
        <button type="submit" disabled={loading} style={{ background: "var(--ink)", color: "#fff", border: "none", borderRadius: "6px", padding: "12px 28px", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Sekmeler */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
        <TabButton active={tab === "search"} onClick={() => setTab("search")} label={`Results (${visibleResults.length})`} />
        <TabButton active={tab === "following"} onClick={() => setTab("following")} label={`Following (${following.length})`} />
        <TabButton active={tab === "dismissed"} onClick={() => setTab("dismissed")} label={`Dismissed (${dismissed.length})`} />
        <TabButton active={tab === "seen"} onClick={() => setTab("seen")} label={`Seen (${seen.length})`} />
      </div>

      {/* SEARCH (RESULTS) SEKMESİ */}
      {tab === "search" && (
        <>
          {scanInfo && (
            <p className="font-mono" style={{ fontSize: "12px", color: "#8A8F98", marginBottom: "12px" }}>
              Scanned {scanInfo.scanned}{scanInfo.totalFound ? ` of ${scanInfo.totalFound} matching` : ""}
              {scanInfo.ghostFiltered ? ` · ${scanInfo.ghostFiltered} ghost filtered` : ""}
              {" · "}{visibleResults.length} shown
            </p>
          )}
          {!hasSearched && <p style={{ color: "#8A8F98", fontSize: "14px" }}>Enter your criteria and click &quot;Search&quot;.</p>}
          {hasSearched && !loading && allSeen && (
            <div style={{ border: "1px dashed var(--line)", borderRadius: "8px", padding: "32px", textAlign: "center", color: "#8A8F98", fontSize: "14px" }}>
              All products in this range have been seen recently. Try a different range, or check back later.
            </div>
          )}
          {hasSearched && !loading && !allSeen && visibleResults.length === 0 && (
            <div style={{ border: "1px dashed var(--line)", borderRadius: "8px", padding: "32px", textAlign: "center", color: "#8A8F98", fontSize: "14px" }}>
              No new opportunities in this batch. Search again for the next set.
            </div>
          )}
          {visibleResults.length > 0 && (
            <ResultsTable
              items={visibleResults}
              followedAsins={followedAsins}
              onFollow={handleFollow}
              onDismiss={handleDismiss}
              lastClickedAsin={lastClickedAsin}
              onItemClick={handleItemClick}
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
            <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
              <FilterButton active={followFilter === "all"} onClick={() => setFollowFilter("all")} label="All" />
              <FilterButton active={followFilter === "notBought"} onClick={() => setFollowFilter("notBought")} label="Not bought" />
              <FilterButton active={followFilter === "bought"} onClick={() => setFollowFilter("bought")} label="Bought" />
            </div>
            {followingCategories.length > 1 && (
              <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
                <FilterButton active={followCategoryFilter === "all"} onClick={() => setFollowCategoryFilter("all")} label="All types" />
                {followingCategories.map((c) => (
                  <FilterButton key={c} active={followCategoryFilter === c} onClick={() => setFollowCategoryFilter(c)} label={c} />
                ))}
              </div>
            )}
            {filteredFollowing.length === 0 ? (
              <p style={{ color: "#8A8F98", fontSize: "14px" }}>No items match this filter.</p>
            ) : (
              <ResultsTable
                items={filteredFollowing}
                followedAsins={followedAsins}
                onFollow={handleFollow}
                onUnfollow={handleUnfollow}
                onToggleBought={handleToggleBought}
                mode="following"
                lastClickedAsin={lastClickedAsin}
                onItemClick={handleItemClick}
              />
            )}
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

      {/* SEEN (HISTORY) SEKMESİ - arama sonucuyla aynı tablo görünümü */}
      {tab === "seen" && (
        seen.length === 0 ? (
          <p style={{ color: "#8A8F98", fontSize: "14px" }}>No seen products yet. Opportunities you&apos;ve searched appear here and stay hidden for 30 days.</p>
        ) : (
          <>
            {seenCategories.length > 1 && (
              <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap" }}>
                <FilterButton active={seenCategoryFilter === "all"} onClick={() => setSeenCategoryFilter("all")} label="All types" />
                {seenCategories.map((c) => (
                  <FilterButton key={c} active={seenCategoryFilter === c} onClick={() => setSeenCategoryFilter(c)} label={c} />
                ))}
              </div>
            )}
            {filteredSeen.length === 0 ? (
              <p style={{ color: "#8A8F98", fontSize: "14px" }}>No items match this filter.</p>
            ) : (
              <ResultsTable
                items={filteredSeen}
                followedAsins={followedAsins}
                onFollow={handleFollow}
                onRestore={handleRestoreSeen}
                mode="seen"
                lastClickedAsin={lastClickedAsin}
                onItemClick={handleItemClick}
              />
            )}
          </>
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

// --- Filtre butonu bileşeni ---
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

// --- Sıralanabilir sütun başlığı bileşeni ---
// Tıklanınca: hiç seçili değilse -> azalan (yüksekten düşüğe), aynı sütuna tekrar tıklanırsa yön değişir
function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeSortKey: SortKey | null;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const isActive = activeSortKey === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ ...thStyle, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title="Click to sort"
    >
      {label}
      <span style={{ marginLeft: "4px", color: isActive ? "var(--ink)" : "#C4C9D0", fontSize: "10px" }}>
        {isActive ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
      </span>
    </th>
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
  onRestore,
  mode = "search",
  lastClickedAsin,
  onItemClick,
}: {
  items: ResultItem[];
  followedAsins: Set<string>;
  onFollow: (item: ResultItem) => void;
  onDismiss?: (item: ResultItem) => void;
  onUnfollow?: (asin: string) => void;
  onToggleBought?: (item: ResultItem) => void;
  onRestore?: (asin: string) => void;
  mode?: "search" | "following" | "seen";
  lastClickedAsin?: string | null;
  onItemClick?: (asin: string) => void;
}) {
  // Her tablo örneği kendi sıralama durumunu tutar (Results/Following/Seen birbirinden bağımsız)
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  // Sıralanmış liste - null değerler her zaman en sona düşer (hangi yönde sıralanırsa sıralansın)
  const sortedItems = useMemo(() => {
    if (!sortKey) return items;
    const withIndex = items.map((item, idx) => ({ item, idx }));
    withIndex.sort((a, b) => {
      const av = a.item[sortKey];
      const bv = b.item[sortKey];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) return a.idx - b.idx;
      if (aNull) return 1;
      if (bNull) return -1;
      const diff = (av as number) - (bv as number);
      if (diff !== 0) return sortDir === "asc" ? diff : -diff;
      return a.idx - b.idx;
    });
    return withIndex.map((w) => w.item);
  }, [items, sortKey, sortDir]);

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: "2px solid var(--ink)" }}>
          <th style={thStyle}>Product</th>
          <SortableHeader label="BSR" sortKey="bsr" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="New" sortKey="newPrice" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="Avg 90" sortKey="newAvg90" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="Used" sortKey="usedPrice" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="Avg 90" sortKey="usedAvg90" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="eBay New" sortKey="ebayNewPrice" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="eBay Used" sortKey="ebayUsedPrice" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <SortableHeader label="Ratio" sortKey="ratio" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <th style={thStyle}>Keepa</th>
          <th style={thStyle}></th>
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((r) => (
          <tr key={r.asin} style={{ borderBottom: "1px solid var(--line)", background: r.bought ? "#E9F5EC" : lastClickedAsin === r.asin ? "#BBF7D0" : "transparent" }}>
            <td style={tdStyle}>
              <a href={r.amazonUrl} target="_blank" rel="noopener noreferrer" onClick={() => onItemClick && onItemClick(r.asin)} style={{ color: "var(--pine)" }}>{r.title}</a>
            </td>
            <td className="font-mono" style={tdStyle}>{r.bsr ?? "-"}</td>
            <td className="font-mono" style={tdStyle}>{r.newPrice ? `$${r.newPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={{ ...tdStyle, fontSize: "13px", color: r.newAvg90 && r.newPrice && r.newPrice > r.newAvg90 * 1.5 ? "#C77700" : "#8A8F98", fontWeight: r.newAvg90 && r.newPrice && r.newPrice > r.newAvg90 * 1.5 ? 600 : 400 }}>
              {r.newAvg90 ? `$${r.newAvg90.toFixed(2)}` : "-"}
            </td>
            <td className="font-mono" style={tdStyle}>{r.usedPrice ? `$${r.usedPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={{ ...tdStyle, fontSize: "13px", color: r.usedAvg90 && r.usedPrice && r.usedPrice < r.usedAvg90 * 0.5 ? "#2E7D46" : "#8A8F98", fontWeight: r.usedAvg90 && r.usedPrice && r.usedPrice < r.usedAvg90 * 0.5 ? 600 : 400 }}>
              {r.usedAvg90 ? `$${r.usedAvg90.toFixed(2)}` : "-"}
            </td>
            <td className="font-mono" style={tdStyle}>{r.ebayNewPrice ? `$${r.ebayNewPrice.toFixed(2)}` : "-"}</td>
            <td className="font-mono" style={tdStyle}>
              <a href={r.ebayUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--pine)" }}>{r.ebayUsedPrice ? `$${r.ebayUsedPrice.toFixed(2)}` : "search"}</a>
            </td>
            <td className="font-mono" style={{ ...tdStyle, color: "var(--gold)", fontWeight: 500 }}>{r.ratio !== null && r.ratio !== undefined ? `${r.ratio}x` : "-"}</td>
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
              ) : mode === "seen" ? (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => onFollow(r)}
                    disabled={followedAsins.has(r.asin)}
                    style={{ ...smallBtnStyle, color: followedAsins.has(r.asin) ? "var(--gold)" : "#999" }}
                  >
                    {followedAsins.has(r.asin) ? "★" : "☆"}
                  </button>
                  <button onClick={() => onRestore && onRestore(r.asin)} style={smallBtnStyle}>restore</button>
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
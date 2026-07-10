import { NextResponse } from "next/server";

// Geçici teşhis: hayalet varyantın ham verisinde "diğer basımlar/format" bilgisi nerede?
// B000007381 = gerçek satan, B000091EQL = pahalı hayalet
export async function GET() {
  try {
    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Keepa API key not configured" }, { status: 500 });
    }

    const asins = "B000007381,B000091EQL";
    const url = `https://api.keepa.com/product?key=${apiKey}&domain=1&asin=${asins}&stats=1&history=0`;
    const res = await fetch(url);
    const data = await res.json();

    const compare = (data.products || []).map((p: any) => ({
        asin: p.asin,
        title: p.title?.slice(0, 40),
        newPrice: p.stats?.current?.[1],
        currentBsr: p.stats?.current?.[3],
        liveOffersOrder: p.liveOffersOrder,
        buyBoxSellerIdHistory: p.buyBoxSellerIdHistory?.slice(-4),
        offersSuccessful: p.offersSuccessful,
        salesRankReferenceHistory: p.salesRankReferenceHistory,
      }));

    return NextResponse.json({ compare, tokensLeft: data.tokensLeft });
  } catch (error: any) {
    console.error("Vartest error:", error);
    return NextResponse.json({ error: error?.message || "Failed" }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from "next/server";

// Tek bir ASIN'in Keepa'dan dönen HAM verisini olduğu gibi gösterir.
// Kullanım: /api/debug?asin=B000XXXXXX
export async function GET(req: NextRequest) {
  const asin = req.nextUrl.searchParams.get("asin");
  if (!asin) {
    return NextResponse.json({ error: "asin parameter required" }, { status: 400 });
  }
  const apiKey = process.env.KEEPA_API_KEY;
  const url = `https://api.keepa.com/product?key=${apiKey}&domain=1&asin=${asin}&stats=1&history=0`;
  const res = await fetch(url);
  const data = await res.json();
  return NextResponse.json(data.products?.[0] ?? data);
}
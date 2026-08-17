import { resolveISBNBatch } from "@/lib/googleBooks";

export async function GET() {
  const results = await resolveISBNBatch([
    { title: "Dune", author: "Frank Herbert" },
    { title: "1984", author: "George Orwell" },
    { title: "The Hobbit", author: "Tolkien" },
  ]);
  return Response.json(results);
}
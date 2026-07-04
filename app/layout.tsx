import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sourcing Desk",
  description: "Amazon kitap/medya kaynak bulma aracı",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
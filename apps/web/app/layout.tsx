import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "ChainCraft · Sales Command Center",
  description: "Private, evidence-led sales workspace for ChainCraft Studio.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

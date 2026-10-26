import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "bexio-oauth · Supabase example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

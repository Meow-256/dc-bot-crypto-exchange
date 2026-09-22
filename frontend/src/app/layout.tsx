import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto & Fiat Exchange | 暗号通貨・法定通貨 迅速両替サービス",
  description: "Discord完結型の安全・迅速な暗号資産(仮想通貨)・日本円(PayPay/銀行振込/楽天ペイ等)両替サービス。24時間自動対応、KYC不要、安心の匿名取引対応。",
  keywords: ["仮想通貨 両替", "暗号通貨 PayPay", "Crypto to JPY", "Bitcoin 両替", "LTC PayPay", "Discord 両替 Bot"],
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        <link rel="icon" href="/logo.png" type="image/png" />
        <link rel="shortcut icon" href="/logo.png" type="image/png" />
        <link rel="apple-touch-icon" href="/logo.png" />
      </head>
      <body className="min-h-screen bg-[#07090e] text-slate-100 antialiased selection:bg-blue-500/30 selection:text-blue-200">
        {children}
      </body>
    </html>
  );
}


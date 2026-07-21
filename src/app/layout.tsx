import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ToastProvider } from "@/components/toast/ToastProvider";
import { FormatBoot } from "@/components/FormatBoot";
import { getSetting } from "@/lib/settings";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "panetti-analytics",
  description: "Sales, profit and ambassador analytics for your webshops",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const setting = await getSetting();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <FormatBoot currencyFormat={setting.currencyFormat} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

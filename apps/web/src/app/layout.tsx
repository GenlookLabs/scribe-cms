import { GoogleAnalytics } from "@next/third-parties/google";
import { getLocale } from "next-intl/server";
import "./globals.css";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      <body>
        {children}
        <GoogleAnalytics gaId="G-KP16WLSJGB" />
      </body>
    </html>
  );
}

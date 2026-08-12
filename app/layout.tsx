import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import { I18nProvider } from "@/hooks/useI18n";
import "katex/dist/katex.min.css";
import "./globals.css";

// IBM Plex Sans/Mono are a designed pair. Subsets match the previous mono
// (latin + cyrillic) — CJK is served by the fallbacks in globals.css, since
// Plex has no CJK coverage and the UI ships zh-CN and ja.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    // Must track --bg in app/globals.css so the browser chrome matches the app.
    { media: "(prefers-color-scheme: light)", color: "#fcfdfd" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1416" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${plexSans.variable} ${plexMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate">
        {/* Every route gets translations. This used to be mounted per-page in
            app/page.tsx, so any new route crashed with "useI18n must be used
            inside I18nProvider" the first time it rendered a component that reads
            one — which is exactly what /ui-preview did. The provider is a client
            component and hydrates its locale in an effect, so it stays safe to
            render from this server layout. */}
        <I18nProvider>
          {children}
        </I18nProvider>
        <PwaRegistration />
      </body>
    </html>
  );
}

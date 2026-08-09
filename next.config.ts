import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Dev-only: governs who may fetch Next's /_next dev resources (the HMR
  // websocket and the error-overlay font). It has no effect on production and
  // is NOT the app's own host gate — that stays in proxy.ts /
  // lib/request-security.ts and is unaffected by this list.
  //
  // Loopback and the Tailscale IP are listed because binding the dev server to
  // 0.0.0.0 (needed to reach it from a phone) stops Next from inferring its own
  // origin, so every host looks cross-origin and HMR silently stops working.
  // 192.168.*.* does not cover Tailscale's 100.x range.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '192.168.*.*',
    '100.*.*.*',
    '*.tail*.ts.net',
    '*.ts.net',
    'vita.tail914baa.ts.net',
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;

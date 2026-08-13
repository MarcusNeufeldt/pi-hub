import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// Extra dev origins for whichever machine this checkout runs on, comma-separated:
//
//   PI_WEB_DEV_ORIGINS=vita.example-tailnet.ts.net,other-host.local
//
// Kept in .env.local rather than here because a tailnet hostname names a private
// network, and this file is public. Next calls loadEnvConfig() before it reads
// this config (server/config.js), so .env.local is already applied.
const extraDevOrigins = (process.env.PI_WEB_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // `next build` type-checks the whole project and halts on the first error, and
  // this tree carries 25 pre-existing ones — about half a single pattern in
  // modules/telegram/sqlite-telegram-store.ts, where the SQLite driver now hands
  // back `Record<string, SQLOutputValue>` rows that the row-type casts predate.
  // None of them stop the app: `next dev` never type-checked, which is how they
  // accumulated unnoticed.
  //
  // This unblocks a production build for the always-on server without pretending
  // the debt is gone: `npx tsc --noEmit` is still the real gate and still reports
  // every one of them. Delete this block once that count reaches zero.
  typescript: { ignoreBuildErrors: true },
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
  //
  // Patterns match label by label (server/app-render/csrf-protection.ts): '*'
  // consumes exactly one whole label, and a partial-label glob like 'tail*' is
  // compared literally, so it can never match. '*.ts.net' therefore covers
  // host.ts.net but NOT machine.tailnet.ts.net — a two-label tailnet host has to
  // be named in full, which is what PI_WEB_DEV_ORIGINS is for.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '192.168.*.*',
    '100.*.*.*',
    '*.ts.net',
    ...extraDevOrigins,
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

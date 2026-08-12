import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";

// I18nProvider lives in app/layout.tsx, not here: any route that renders a
// component reading translations needs it, and mounting it per-page meant a new
// route crashed the moment it touched one.
export default function Home() {
  return (
    <Suspense>
      <AppShell />
    </Suspense>
  );
}

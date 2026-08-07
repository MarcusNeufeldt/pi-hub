export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Pi Hub scheduler bootstrap. Idempotent (guarded by globalThis) and wrapped
  // so a migration/DB failure keeps the web server running with a reported
  // scheduler error state (design doc §9.3). Must not block the request path.
  await import("@/modules/scheduler")
    .then((m) => m.startSchedulerRuntime())
    .catch((error) => {
      console.error("[pi-hub:scheduler] init failed", error);
    });
}

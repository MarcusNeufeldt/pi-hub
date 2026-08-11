"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import {
  buildOpenRouterRouting,
  DEFAULT_REPLY_TOKENS,
  isRoutableOpenRouterModel,
  type OpenRouterEndpoint,
  type OpenRouterRoutingValue,
  predictedSeconds,
  rankByPredictedSpeed,
  REPLY_TOKEN_CHOICES,
} from "@/lib/openrouter-routing";

/**
 * Picks which upstream providers may serve the selected OpenRouter model.
 *
 * Rendered beside the reasoning-level control in the composer and styled to
 * match it. Owns its own open state and outside-click so wiring it into
 * ChatInput stays a few lines.
 *
 * Nothing is preselected: with no stored routing OpenRouter's own default
 * applies, and the sort choice starts at "default" rather than showing a
 * preference that is not actually saved. Checking providers is for excluding the
 * ones you do not want — a quantization tier, say — not for building a list you
 * then have to maintain.
 */
export function OpenRouterRoutingMenu({
  provider,
  modelId,
  disabled = false,
  compact = false,
}: {
  provider: string;
  modelId: string;
  disabled?: boolean;
  /** Hides the button label, matching the composer's mobile treatment. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [endpoints, setEndpoints] = useState<OpenRouterEndpoint[] | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [routing, setRouting] = useState<OpenRouterRoutingValue | null>(null);
  const [replyTokens, setReplyTokens] = useState<number>(DEFAULT_REPLY_TOKENS);
  const [saveError, setSaveError] = useState(false);

  const routable = isRoutableOpenRouterModel(provider, modelId);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Switching model invalidates everything shown here.
  useEffect(() => {
    setOpen(false);
    setEndpoints(null);
    setLoadState("idle");
    setRouting(null);
    setSaveError(false);
    requestedModelRef.current = null;
  }, [provider, modelId]);

  /**
   * Which model a load has been started for. A ref rather than state, and the
   * load is imperative rather than an effect, because the effect version dead-
   * locked: `loadState` was both a dependency and something the effect set, so
   * setting "loading" re-ran the effect, whose cleanup cancelled the very fetch
   * it had just started. Both requests returned 200 and every result was thrown
   * away, leaving "Loading providers…" on screen forever.
   */
  const requestedModelRef = useRef<string | null>(null);

  // Loaded on first open rather than on mount: most model selections never open
  // this, and a request per selection would be pure waste.
  const loadProviders = useCallback(async (id: string) => {
    if (requestedModelRef.current === id) return;
    requestedModelRef.current = id;
    setLoadState("loading");
    try {
      const query = `model=${encodeURIComponent(id)}`;
      const [endpointsResponse, routingResponse] = await Promise.all([
        fetch(`/api/models/openrouter-endpoints?${query}`, { cache: "no-store" }),
        fetch(`/api/models/openrouter-routing?${query}`, { cache: "no-store" }),
      ]);
      const endpointsData = await endpointsResponse.json() as {
        available?: boolean;
        endpoints?: OpenRouterEndpoint[];
      };
      const routingData = await routingResponse.json() as { routing?: OpenRouterRoutingValue | null };
      // Only a superseded model discards the result. Closing the menu must not,
      // or reopening would find the state still saying "loading".
      if (requestedModelRef.current !== id) return;
      setRouting(routingData.routing ?? null);
      if (endpointsData.available && endpointsData.endpoints?.length) {
        setEndpoints(endpointsData.endpoints);
        setLoadState("ready");
      } else {
        setLoadState("empty");
      }
    } catch {
      if (requestedModelRef.current !== id) return;
      // Cleared so the next open retries rather than showing a permanent error.
      requestedModelRef.current = null;
      setLoadState("error");
    }
  }, []);

  const save = useCallback(async (next: OpenRouterRoutingValue | null) => {
    setRouting(next);
    setSaveError(false);
    try {
      const response = await fetch("/api/models/openrouter-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, routing: next }),
      });
      if (!response.ok) setSaveError(true);
    } catch {
      setSaveError(true);
    }
  }, [modelId]);

  if (!routable) return null;

  const pinned = routing?.only ?? [];
  const sort = routing?.sort ?? "";

  const toggleTag = (tag: string) => {
    const next = pinned.includes(tag) ? pinned.filter((entry) => entry !== tag) : [...pinned, tag];
    void save(buildOpenRouterRouting(next, sort ? { sort } : {}));
  };
  const chooseSort = (nextSort: string) => {
    void save(buildOpenRouterRouting(pinned, nextSort ? { sort: nextSort } : {}));
  };

  const ranked = endpoints ? rankByPredictedSpeed(endpoints, replyTokens) : [];
  const label = pinned.length > 0
    ? t("route.pinnedCount", { count: pinned.length })
    : sort
      ? t(sort === "latency" ? "route.sortLatency" : "route.sortThroughput")
      : t("route.button");

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        onClick={() => {
          if (disabled) return;
          const next = !open;
          setOpen(next);
          if (next) void loadProviders(modelId);
        }}
        disabled={disabled}
        title={t("route.title")}
        aria-label={t("route.title")}
        aria-expanded={open}
        className={`ui-btn${pinned.length > 0 || sort ? " ui-btn--accent" : ""}`}
        style={{
          gap: 5,
          paddingInline: compact ? "6px" : "12px",
          borderRadius: "var(--r-md)",
          fontSize: "var(--fs-meta)",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 18a8 8 0 0 1 16 0" />
          <line x1="12" y1="18" x2="17" y2="11" />
        </svg>
        {!compact && <span style={{ whiteSpace: "nowrap" }}>{label}</span>}
      </button>

      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 0,
          zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
          overflow: "hidden", width: "min(440px, calc(100vw - 32px))",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            padding: "8px 12px", borderBottom: "1px solid var(--border)",
            fontSize: "var(--fs-micro)", color: "var(--text-dim)",
          }}>
            <span>{t("route.title")}</span>
            {loadState === "ready" && (
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {t("route.replyLength")}
                <select
                  value={replyTokens}
                  onChange={(event) => setReplyTokens(Number(event.target.value))}
                  className="ui-field"
                  style={{ fontSize: "var(--fs-micro)", padding: "1px 4px" }}
                >
                  {REPLY_TOKEN_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>{choice}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {loadState === "loading" && (
            <div style={{ padding: "10px 12px", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>
              {t("route.loading")}
            </div>
          )}
          {loadState === "error" && (
            <div style={{ padding: "10px 12px", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>
              {t("route.error")}
            </div>
          )}
          {loadState === "empty" && (
            <div style={{ padding: "10px 12px", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>
              {t("route.none")}
            </div>
          )}

          {/* Popular models are served by a lot of providers — 27 for
              deepseek-v4-flash — and this panel grows upward from the composer,
              so an uncapped list runs straight off the top of the window. */}
          <div style={{ maxHeight: "min(46vh, 340px)", overflowY: "auto" }}>
          {loadState === "ready" && ranked.map((endpoint) => {
            const checked = pinned.includes(endpoint.tag);
            const seconds = predictedSeconds(endpoint, replyTokens);
            return (
              <button
                key={endpoint.tag}
                // .ui-row owns hover/active backgrounds and the 44px mobile target;
                // an inline background here would beat it and stick after a tap.
                className={`ui-row${checked ? " is-active" : ""}`}
                aria-pressed={checked}
                onClick={() => toggleTag(endpoint.tag)}
                style={{
                  gap: 8, padding: "7px 12px", borderRadius: 0,
                  fontSize: "var(--fs-meta)", width: "100%",
                  color: checked ? "var(--text)" : "var(--text-muted)",
                }}
              >
                <span aria-hidden="true" style={{ width: 12, flexShrink: 0, color: "var(--accent)" }}>
                  {checked ? "✓" : ""}
                </span>
                <span style={{ flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {endpoint.providerName}
                </span>
                <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
                  {seconds === null ? t("route.unmeasured") : `${seconds.toFixed(1)}s`}
                </span>
                <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-dim)", minWidth: 62, textAlign: "right" }}>
                  {endpoint.throughputTps === null ? "—" : `${endpoint.throughputTps.toFixed(0)} tok/s`}
                </span>
                <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text-dim)", minWidth: 52, textAlign: "right" }}>
                  {endpoint.ttftMs === null ? "—" : `${Math.round(endpoint.ttftMs)}ms`}
                </span>
                {/* Quantization is a quality tier, not just a speed knob — an fp4
                    endpoint may be fastest to start and measurably worse. */}
                <span style={{ flexShrink: 0, color: "var(--text-dim)", minWidth: 34, textAlign: "right" }}>
                  {endpoint.quantization && endpoint.quantization !== "unknown" ? endpoint.quantization : ""}
                </span>
              </button>
            );
          })}
          </div>

          <div style={{ borderTop: "1px solid var(--border)", padding: "6px 12px 8px" }}>
            <div style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginBottom: 4 }}>
              {t("route.sortLabel")}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {([
                { value: "", key: "route.sortDefault" },
                { value: "throughput", key: "route.sortThroughput" },
                { value: "latency", key: "route.sortLatency" },
              ] as const).map((option) => (
                <button
                  key={option.value || "default"}
                  className={`ui-btn ui-btn--sm${sort === option.value ? " ui-btn--accent" : " ui-btn--outline"}`}
                  aria-pressed={sort === option.value}
                  onClick={() => chooseSort(option.value)}
                  style={{ fontSize: "var(--fs-micro)" }}
                >
                  {t(option.key)}
                </button>
              ))}
            </div>
            {saveError && (
              <div style={{ marginTop: 6, fontSize: "var(--fs-micro)", color: "var(--danger)" }}>
                {t("route.saveFailed")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

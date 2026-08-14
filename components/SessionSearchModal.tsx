"use client";

/**
 * Cross-session search.
 *
 * Two phases on purpose: typing runs a local scan that returns in milliseconds,
 * and "Ask the model" spends about a cent to have a long-context model read the
 * candidates' full conversations and say which one you meant. Local results are
 * never replaced by the model's answer — the picks annotate and reorder them, so
 * a wrong pick still leaves the list you had.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { Modal } from "./ui/Modal";

interface SearchResult {
  score: number;
  matchSource: "name" | "context";
  snippets: string[];
  session: SessionInfo;
}

interface Pick {
  id: string;
  confidence: number;
  reason: string;
}

type PickerReason = "no_model" | "no_credentials" | "runtime_error";

interface PickerStatus {
  available: boolean;
  reason?: PickerReason;
}

export interface SessionSearchModalProps {
  open: boolean;
  onClose: () => void;
  /** Opens the session in place, reusing the sidebar's selection path. */
  onSelectSession: (session: SessionInfo) => void;
  /** Lets the "not connected" notice send the user somewhere useful. */
  onOpenModels?: () => void;
}

/** The picker model this build asks for, shown when it is missing. */
const PICKER_MODEL_LABEL = "deepseek/deepseek-v4-flash-0731";

function sessionLabel(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.trim();
  if (first) return first.length > 70 ? `${first.slice(0, 69)}…` : first;
  return session.id.slice(0, 12);
}

function relativeDay(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** Shareable link to a session. Absolute so it survives a paste elsewhere. */
export function sessionDeepLink(id: string, origin?: string): string {
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}/?session=${encodeURIComponent(id)}`;
}

export function SessionSearchModal({
  open,
  onClose,
  onSelectSession,
  onOpenModels,
}: SessionSearchModalProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [searching, setSearching] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ ms: number; costTotal: number | null } | null>(null);
  const [picker, setPicker] = useState<PickerStatus>({ available: true });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    // Reopening should not show the previous query's answer.
    setPicks([]);
    setError(null);
    setUsage(null);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const ticket = ++requestRef.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(`/api/session-search?q=${encodeURIComponent(query)}`);
        const data = await response.json() as {
          results?: SearchResult[];
          picker?: PickerStatus;
          error?: string;
        };
        if (ticket !== requestRef.current) return;
        if (data.picker) setPicker(data.picker);
        if (data.error) setError(data.error);
        else {
          setResults(data.results ?? []);
          setError(null);
        }
      } catch (e) {
        if (ticket === requestRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (ticket === requestRef.current) setSearching(false);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [open, query]);

  const askModel = useCallback(async () => {
    if (!query.trim() || !results.length) return;
    setAsking(true);
    setError(null);
    try {
      const response = await fetch("/api/session-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, ids: results.map((r) => r.session.id) }),
      });
      const data = await response.json() as {
        picks?: Pick[];
        usage?: { ms: number; costTotal: number | null };
        reason?: PickerReason;
        error?: string;
      };
      // A coded reason means the provider is not set up; show the friendly
      // notice rather than an error string, and remember it for the button.
      if (data.reason) setPicker({ available: false, reason: data.reason });
      else if (data.error) setError(data.error);
      else {
        setPicks(data.picks ?? []);
        setUsage(data.usage ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }, [query, results]);

  const copyLink = useCallback(async (id: string) => {
    const link = sessionDeepLink(id);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    } catch {
      // Clipboard can be blocked; the link is visible in the title attribute.
      setError(t("search.copyFailed"));
    }
  }, [t]);

  const pickById = useMemo(() => new Map(picks.map((pick) => [pick.id, pick])), [picks]);

  /** Model picks float to the top; everything else keeps its local order. */
  const ordered = useMemo(() => {
    if (!picks.length) return results;
    const rank = new Map(picks.map((pick, index) => [pick.id, index]));
    return [...results].sort((a, b) => {
      const left = rank.get(a.session.id) ?? Number.MAX_SAFE_INTEGER;
      const right = rank.get(b.session.id) ?? Number.MAX_SAFE_INTEGER;
      return left - right;
    });
  }, [results, picks]);

  const openSession = (session: SessionInfo) => {
    onSelectSession(session);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("search.title")}
      description={t("search.description")}
      width={720}
      height="min(78vh, 640px)"
      padded={false}
      head={(
        <div className="session-search__head">
          <input
            ref={inputRef}
            className="session-search__input"
            type="search"
            value={query}
            placeholder={t("search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void askModel();
              }
            }}
            aria-label={t("search.placeholder")}
          />
          <button
            type="button"
            className="btn btn--accent session-search__ask"
            onClick={() => void askModel()}
            disabled={asking || !results.length || !query.trim() || !picker.available}
            title={picker.available ? undefined : t("search.askDisabledHint")}
          >
            {asking ? t("search.asking") : t("search.ask")}
          </button>
        </div>
      )}
      footer={(
        <div className="session-search__foot">
          <span aria-live="polite">
            {searching
              ? t("search.searching")
              : t("search.resultCount", { count: results.length })}
            {usage ? ` · ${(usage.ms / 1000).toFixed(1)}s${usage.costTotal !== null ? ` · $${usage.costTotal.toFixed(4)}` : ""}` : ""}
          </span>
          {error ? <span className="session-search__error">{error}</span> : null}
        </div>
      )}
    >
      {!picker.available ? (
        <div className="session-search__notice" role="status">
          <strong className="session-search__notice-title">{t("search.pickerOffTitle")}</strong>
          <span>
            {picker.reason === "no_model"
              ? t("search.pickerNoModel", { model: PICKER_MODEL_LABEL })
              : picker.reason === "runtime_error"
                ? t("search.pickerRuntimeError")
                : t("search.pickerNoCredentials")}
          </span>
          {onOpenModels ? (
            <button
              type="button"
              className="btn btn--ghost session-search__notice-action"
              onClick={() => {
                onClose();
                onOpenModels();
              }}
            >
              {t("search.pickerOpenModels")}
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="session-search__list">
        {ordered.map((result) => {
          const pick = pickById.get(result.session.id);
          const link = sessionDeepLink(result.session.id);
          return (
            <li key={result.session.id} className="session-search__item">
              <button
                type="button"
                className="session-search__open"
                onClick={() => openSession(result.session)}
                title={t("search.openHint")}
              >
                <span className="session-search__row">
                  <span className="session-search__name">{sessionLabel(result.session)}</span>
                  {pick ? (
                    // Only the leader claims "best match"; the rest carry their
                    // confidence so a hedged second pick does not read as certain.
                    <span className="session-search__badge">
                      {pick.id === picks[0]?.id
                        ? t("search.picked")
                        : `${Math.round(pick.confidence * 100)}%`}
                    </span>
                  ) : (
                    <span className="session-search__source">
                      {result.matchSource === "name" ? t("search.nameMatch") : t("search.contextMatch")}
                    </span>
                  )}
                </span>
                {pick?.reason ? (
                  <span className="session-search__reason">{pick.reason}</span>
                ) : null}
                {result.snippets.map((snippet, index) => (
                  <span key={index} className="session-search__snippet">{snippet}</span>
                ))}
                <span className="session-search__meta">
                  {result.session.cwd}
                  {result.session.modified ? ` · ${relativeDay(result.session.modified)}` : ""}
                </span>
              </button>
              <button
                type="button"
                className="btn btn--ghost session-search__link"
                onClick={() => void copyLink(result.session.id)}
                title={link}
                aria-label={t("search.copyLink")}
              >
                {copiedId === result.session.id ? t("search.copied") : t("search.copyLink")}
              </button>
            </li>
          );
        })}
        {!ordered.length && !searching ? (
          <li className="session-search__empty">{t("search.noResults")}</li>
        ) : null}
      </ul>
    </Modal>
  );
}

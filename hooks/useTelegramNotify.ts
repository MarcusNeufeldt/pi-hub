"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { getTelegramStatus } from "@/lib/telegram-client";

const STORAGE_KEY = "pi-telegram-notify-enabled";

/**
 * Manages the "notify via Telegram on completion" toggle for the Web chat,
 * mirroring {@link useAudio}. The preference is sticky (localStorage), and
 * the hook also tracks whether Telegram is configured so the toggle can be
 * hidden entirely when there is nowhere to send a notification.
 *
 * The toggle only controls intent — the actual notification is dispatched by
 * the chat layer (ChatWindow) when a run finishes, reading `notifyEnabledRef`
 * so a toggled-mid-run change does not retroactively fire.
 */
export function useTelegramNotify() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  });
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const [configured, setConfigured] = useState(false);

  // Check whether Telegram is set up once on mount (and again when the tab
  // returns to the foreground, in case it was configured in another tab).
  const checkConfigured = useCallback(async () => {
    try {
      const status = await getTelegramStatus();
      setConfigured(Boolean(status.configured && status.userCount > 0));
    } catch {
      // Status endpoint unreachable — keep the toggle hidden to avoid a
      // no-op button.
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    void checkConfigured();
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkConfigured();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkConfigured]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      enabledRef.current = next;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage may be unavailable (private mode) — in-memory is fine.
      }
      return next;
    });
  }, []);

  return {
    notifyEnabled: enabled,
    notifyEnabledRef: enabledRef,
    onNotifyToggle: toggle,
    telegramConfigured: configured,
    refreshConfigured: checkConfigured,
  };
}

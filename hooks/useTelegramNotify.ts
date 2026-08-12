"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const STORAGE_KEY = "pi-telegram-notify-enabled";

/**
 * Manages the "notify via Telegram on completion" preference for the Web chat,
 * mirroring {@link useAudio}. The preference is sticky (localStorage).
 *
 * It only controls intent — the actual notification is dispatched by the chat
 * layer (ChatWindow) when a run finishes, reading `notifyEnabledRef` so a
 * change made mid-run does not retroactively fire.
 *
 * This used to also poll /api/integrations/telegram/status on mount and on every
 * return to the foreground, so the composer's toggle could hide itself when there
 * was nowhere to send. That toggle is gone, so the request had no reader left and
 * only cost a round trip per mount.
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
  };
}

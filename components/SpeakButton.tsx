"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { extractFluentSpeech, TTS_MAX_CHARS } from "@/lib/speak-text";

/**
 * Read-aloud button: POSTs the text to /api/tts and plays the returned audio.
 * Clicking again stops playback. Mirrors the copy-button styling so it fits
 * message action rows and floating pills.
 */
export function SpeakButton({
  text,
  style,
}: {
  text: string;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(async () => {
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    if (!text.trim()) return;
    const clean = extractFluentSpeech(text).slice(0, TTS_MAX_CHARS);
    if (!clean) return;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setPlaying(false);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setPlaying(true);
      await audio.play();
    } catch {
      // ignore playback errors
    }
  }, [playing, text]);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      title={playing ? t("i18n.speakStop") : t("i18n.speak")}
      aria-label={playing ? t("i18n.speakStop") : t("i18n.speak")}
      // Same inline message action as copy / fork in MessageView.
      className={`ui-btn ui-btn--hint${playing ? " ui-btn--accent" : ""}`}
      style={style}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        {playing ? (
          <>
            <line x1="15.5" y1="9.5" x2="15.5" y2="14.5" />
            <line x1="18.5" y1="8" x2="18.5" y2="16" />
          </>
        ) : (
          <>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </>
        )}
      </svg>
      {playing ? t("i18n.speakStop") : t("i18n.speak")}
    </button>
  );
}

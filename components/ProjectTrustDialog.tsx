"use client";

import { useI18n } from "@/hooks/useI18n";
import { Modal } from "./ui/Modal";

export function ProjectTrustDialog({
  cwd,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <Modal
      open
      onClose={onCancel}
      title={t("trust.dialogTitle")}
      // Not dismissible mid-write: trusting a project is a security decision
      // and the request is already in flight.
      dismissible={!busy}
      width={440}
      head={(
        <div className="ui-dialog__head">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            // Trust is an attention state, so it takes the accent rather than a
            // one-off #f59e0b amber.
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: 2 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <h2 className="ui-dialog__title">{t("trust.dialogTitle")}</h2>
            <p className="ui-dialog__desc">{t("trust.dialogBody")}</p>
          </div>
        </div>
      )}
      footer={(
        <>
          {/* Cancel first in DOM so the primary action sits rightmost. */}
          <button
            type="button"
            className="ui-btn ui-btn--outline"
            onClick={onCancel}
            disabled={busy}
          >
            {t("trust.cancel")}
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--primary"
            onClick={onConfirm}
            disabled={busy}
            style={busy ? { cursor: "wait", opacity: 0.7 } : undefined}
          >
            {busy ? t("trust.trusting") : t("trust.trustProject")}
          </button>
        </>
      )}
    >
      <code
        style={{
          display: "block",
          padding: "var(--sp-4) var(--sp-5)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-meta)",
          overflowWrap: "anywhere",
        }}
      >
        {cwd}
      </code>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: "var(--sp-5)",
            color: "var(--danger)",
            fontSize: "var(--fs-ui)",
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}
    </Modal>
  );
}

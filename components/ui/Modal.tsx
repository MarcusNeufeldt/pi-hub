"use client";

import type { CSSProperties, ReactNode } from "react";
import { Dialog, VisuallyHidden } from "radix-ui";

/**
 * Shared dialog shell over Radix Dialog.
 *
 * The hand-rolled modals in this app were plain fixed divs: no focus trap, no
 * Escape handling, no background scroll lock, and no aria wiring beyond a
 * hand-written role="dialog". Radix supplies all of that; app/globals.css
 * supplies the skin (.ui-overlay / .ui-dialog), including the mobile bottom
 * sheet treatment.
 *
 * Radix warns when Content has no Title, so `title` is required. Pass
 * `hideTitle` when the design shows its own heading instead — the title still
 * reaches screen readers via VisuallyHidden.
 */
export function Modal({
  open,
  onClose,
  title,
  hideTitle = false,
  description,
  width,
  height,
  padded = true,
  dismissible = true,
  head,
  footer,
  children,
}: {
  open: boolean;
  /** Called for Escape, outside click, and the close button. */
  onClose: () => void;
  title: string;
  hideTitle?: boolean;
  description?: string;
  /** Max width of the panel; ignored on mobile, where it is a full-width sheet. */
  width?: number | string;
  /** Explicit panel height. Needed by the config modals, whose two-pane bodies
   *  scroll internally and so cannot size to content. */
  height?: number | string;
  /** false renders children raw, without the padded scrolling body wrapper, for
   *  panels that manage their own internal layout. */
  padded?: boolean;
  /** false while a blocking action runs, so the user cannot dismiss mid-write. */
  dismissible?: boolean;
  /** Replaces the default title block entirely (e.g. to add a leading icon). */
  head?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const block = (event: { preventDefault: () => void }) => {
    if (!dismissible) event.preventDefault();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay">
          <Dialog.Content
            className={`ui-dialog${height === undefined ? "" : " ui-dialog--tall"}`}
            style={{
              ...(width === undefined
                ? null
                : { "--dialog-w": typeof width === "number" ? `${width}px` : width }),
              ...(height === undefined
                ? null
                : { "--dialog-h": typeof height === "number" ? `${height}px` : height }),
            } as CSSProperties}
            onEscapeKeyDown={block}
            onInteractOutside={block}
          >
            {/* Radix requires a Dialog.Title inside Content or it warns and the
                dialog is unlabelled. A custom `head` renders its own visible
                heading, so the accessible title is supplied hidden instead —
                never skipped. */}
            {head || hideTitle
              ? (
                <VisuallyHidden.Root>
                  <Dialog.Title>{title}</Dialog.Title>
                </VisuallyHidden.Root>
              )
              : null}

            {head ?? (hideTitle ? null : (
              <div className="ui-dialog__head">
                <div style={{ minWidth: 0 }}>
                  <Dialog.Title className="ui-dialog__title">{title}</Dialog.Title>
                  {description
                    ? <Dialog.Description className="ui-dialog__desc">{description}</Dialog.Description>
                    : null}
                </div>
              </div>
            ))}

            {children
              ? (padded ? <div className="ui-dialog__body">{children}</div> : children)
              : null}
            {footer ? <div className="ui-dialog__foot">{footer}</div> : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

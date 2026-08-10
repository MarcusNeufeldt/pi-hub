"use client";

import { Fragment, type ReactNode } from "react";

import { collectPaneIds, type PaneNode } from "@/lib/pane-layout";

/** What the chrome needs to know about a pane, supplied by AppShell. */
export interface ChatPaneMeta {
  /** Session name, or the working directory when a session has no name yet. */
  title: string;
  /** True while this pane's agent is working. */
  running: boolean;
  /** True when this pane's session finished while the user was elsewhere. */
  unread: boolean;
}

interface ChatPaneTreeProps {
  layout: PaneNode;
  focusedPaneId: string;
  paneMeta: Record<string, ChatPaneMeta>;
  /**
   * Renders the chat surface for one pane. The tree owns layout and chrome only;
   * everything session-shaped stays in AppShell, so this component does not need
   * ChatWindow's ~18 props threaded through it.
   */
  renderPane: (paneId: string) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  labels: { close: string; running: string; unread: string };
}

/**
 * Lays the pane tree out as nested flex boxes and draws the per-pane chrome.
 *
 * Splitting is driven from the top bar because it acts on the focused pane;
 * closing lives on the pane itself, where the target is unambiguous. The header,
 * focus ring and close button only appear once a second pane exists, so the
 * single-pane view stays visually identical to before.
 */
export function ChatPaneTree({
  layout,
  focusedPaneId,
  paneMeta,
  renderPane,
  onFocusPane,
  onClosePane,
  labels,
}: ChatPaneTreeProps) {
  const split = layout.kind === "split";

  const renderNode = (node: PaneNode): ReactNode => {
    if (node.kind === "leaf") {
      const focused = split && node.paneId === focusedPaneId;
      const meta = paneMeta[node.paneId];
      return (
        <div
          // Focus follows any interaction, so the top bar and right panel always
          // describe the pane the user is actually working in.
          onMouseDownCapture={() => onFocusPane(node.paneId)}
          onFocusCapture={() => onFocusPane(node.paneId)}
          className={`chat-pane${focused ? " chat-pane--focused" : ""}`}
        >
          {/* Only shown when split: with a single pane the session is already
              named in the sidebar and the top bar, and a header would just be a
              second copy of it. */}
          {split && (
            <div className="chat-pane__header">
              <span
                className={`chat-pane__dot${meta?.running ? " chat-pane__dot--running" : ""}${
                  !meta?.running && meta?.unread ? " chat-pane__dot--unread" : ""
                }`}
                // A bare colour would carry the state to sighted users only.
                role="img"
                aria-label={meta?.running ? labels.running : meta?.unread ? labels.unread : ""}
                title={meta?.running ? labels.running : meta?.unread ? labels.unread : undefined}
              />
              <span className="chat-pane__title" title={meta?.title}>{meta?.title ?? ""}</span>
              <button
                type="button"
                className="chat-pane__close ui-btn ui-btn--icon ui-btn--dim"
                title={labels.close}
                aria-label={labels.close}
                onClick={() => onClosePane(node.paneId)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
          <div className="chat-pane__body">{renderPane(node.paneId)}</div>
        </div>
      );
    }

    return (
      <div className={`chat-pane-split chat-pane-split--${node.axis}`}>
        {node.children.map((child, index) => (
          // A subtree's first pane id is stable across re-renders and unique
          // across siblings, which an array index alone is not once panes close.
          <Fragment key={collectPaneIds(child)[0] ?? index}>
            {index > 0 && <div className="chat-pane-divider" aria-hidden="true" />}
            {renderNode(child)}
          </Fragment>
        ))}
      </div>
    );
  };

  return renderNode(layout);
}

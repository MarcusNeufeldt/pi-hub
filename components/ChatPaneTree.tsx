"use client";

import { Fragment, type ReactNode } from "react";

import { collectPaneIds, type PaneNode } from "@/lib/pane-layout";

interface ChatPaneTreeProps {
  layout: PaneNode;
  focusedPaneId: string;
  /**
   * Renders the chat surface for one pane. The tree owns layout and chrome only;
   * everything session-shaped stays in AppShell, so this component does not need
   * ChatWindow's ~18 props threaded through it.
   */
  renderPane: (paneId: string) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  closeLabel: string;
}

/**
 * Lays the pane tree out as nested flex boxes and draws the per-pane chrome.
 *
 * Splitting is driven from the top bar because it acts on the focused pane;
 * closing lives on the pane itself, where the target is unambiguous. Both the
 * focus ring and the close button only appear once a second pane exists, so the
 * single-pane view is visually identical to before.
 */
export function ChatPaneTree({
  layout,
  focusedPaneId,
  renderPane,
  onFocusPane,
  onClosePane,
  closeLabel,
}: ChatPaneTreeProps) {
  const split = layout.kind === "split";

  const renderNode = (node: PaneNode): ReactNode => {
    if (node.kind === "leaf") {
      const focused = split && node.paneId === focusedPaneId;
      return (
        <div
          // Focus follows any interaction, so the top bar and right panel always
          // describe the pane the user is actually working in.
          onMouseDownCapture={() => onFocusPane(node.paneId)}
          onFocusCapture={() => onFocusPane(node.paneId)}
          className={`chat-pane${focused ? " chat-pane--focused" : ""}`}
        >
          {split && (
            <button
              type="button"
              className="chat-pane__close ui-btn ui-btn--icon ui-btn--dim"
              title={closeLabel}
              aria-label={closeLabel}
              onClick={() => onClosePane(node.paneId)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
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

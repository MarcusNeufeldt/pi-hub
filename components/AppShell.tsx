"use client";

import { useState, useCallback, useMemo, memo, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { ChatPaneTree } from "./ChatPaneTree";
import {
  canSplitPane,
  leaf,
  type PaneNode,
  paneAfterRemoval,
  removePane,
  splitPane,
  type SplitAxis,
} from "@/lib/pane-layout";
import { FileViewer } from "./FileViewer";
import { PerTurnDiffView } from "./PerTurnDiffView";
import { SubagentsView } from "./SubagentPanel";
import type { SubagentDelegation } from "./SubagentPanel";
import type { TurnChanges } from "@/lib/session-changes";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { TasksConfig } from "./TasksConfig";
import { TelegramSettings } from "./telegram/TelegramSettings";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { copyText } from "@/lib/clipboard";
import {
  badgeReading,
  type CodexUsage,
  formatPlanLabel,
  formatWindowLabel,
} from "@/lib/codex-usage";
import { getFileName } from "@/lib/file-paths";
import { buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

// Top-bar icon buttons are sized by --h-topbar via .ui-btn--bar in globals.css,
// so they follow the mobile ramp (36px desktop / 48px mobile) instead of being
// pinned to a desktop-only 36px here.
const LANGUAGE_MENU_WIDTH = 176;

/** One pane of the main chat area. Each pane drives its own ChatWindow. */
interface ChatPane {
  id: string;
  /** Null while the pane is an unstarted "new session" slot. */
  session: SessionInfo | null;
  /** Directory a not-yet-created session will open in. */
  newSessionCwd: string | null;
  /** Bumped to force this pane's ChatWindow to remount. */
  remountKey: number;
}

const FIRST_PANE_ID = "pane-1";

/**
 * Panes render through a memoised ChatWindow.
 *
 * AppShell re-renders on every `paneRuntimes` change, which means on every token
 * of a streaming reply. Without this, one pane streaming re-rendered every other
 * pane's full transcript on each token — an amplification that scales with the
 * pane count, up to nine.
 *
 * This only pays off while every prop a quiet pane receives is referentially
 * stable, which holds because streaming writes to `paneRuntimes` and never to
 * `panes`, and because the per-pane callbacks are memoised. If a future prop is
 * rebuilt each render the comparison silently stops matching and the saving is
 * lost without anything failing, so keep new props stable — or measure.
 *
 * memo does not block context, so useI18n and useTheme still propagate.
 */
const PaneChatWindow = memo(ChatWindow);

interface ContextUsageInfo {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/**
 * What a pane reports about itself. The top bar and right panel describe the
 * focused pane, so these are keyed per pane rather than held once per app —
 * otherwise two panes overwrite each other's token counts and diffs.
 */
interface PaneRuntime {
  sessionStats: SessionStatsInfo | null;
  contextUsage: ContextUsageInfo | null;
  systemPrompt: string | null;
  subagents: SubagentDelegation[];
  turnChanges: TurnChanges[];
  branchTree: SessionTreeNode[];
  branchActiveLeafId: string | null;
}

/** Shared so an unreported pane keeps a stable identity between renders. */
const EMPTY_PANE_RUNTIME: PaneRuntime = {
  sessionStats: null,
  contextUsage: null,
  systemPrompt: null,
  subagents: [],
  turnChanges: [],
  branchTree: [],
  branchActiveLeafId: null,
};

/**
 * Mirrors React's setState contract so the pane-backed setters below are
 * drop-in replacements for the useState setters they took over from — call
 * sites pass either a value or an updater, exactly as before.
 */
type StateUpdate<T> = T | ((previous: T) => T);
function applyStateUpdate<T>(next: StateUpdate<T>, previous: T): T {
  return typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
}

/**
 * One threshold scale for every "percent used" readout in the top bar, so the
 * context meter and the Codex quota can never disagree about what 80% looks like.
 */
function usageThresholdColor(percent: number | null): string {
  if (percent === null) return "var(--text-muted)";
  if (percent > 90) return "#ef4444";
  if (percent > 70) return "rgba(234,179,8,0.95)";
  return "var(--text-muted)";
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { isDark, toggleTheme } = useTheme();
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  useViewportHeight();
  // ---- Chat panes ------------------------------------------------------
  // The main area holds one pane today and, on desktop, will hold a few side
  // by side. Rather than rewrite the ~20 places that already read and write
  // "the current session", the pane list is the source of truth and the old
  // names are re-bound to the focused pane: reads derive from it, writes are
  // redirected onto it. Single-pane behaviour is therefore unchanged.
  const [panes, setPanes] = useState<ChatPane[]>(() => [
    { id: FIRST_PANE_ID, session: null, newSessionCwd: null, remountKey: 0 },
  ]);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(FIRST_PANE_ID);
  // The setter shims run from stable callbacks, so they read focus through a
  // ref rather than closing over a value that would go stale.
  const focusedPaneIdRef = useRef(focusedPaneId);
  focusedPaneIdRef.current = focusedPaneId;
  const focusedPane = panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];

  /**
   * Targeted write. Callbacks a specific pane reports through must use this
   * rather than the focused-pane variant: a session created in one pane while
   * the user clicks into another would otherwise land in the wrong pane.
   */
  const updatePane = useCallback((paneId: string, patch: (pane: ChatPane) => ChatPane) => {
    setPanes((prev) => prev.map((pane) => (pane.id === paneId ? patch(pane) : pane)));
  }, []);
  const updateFocusedPane = useCallback((patch: (pane: ChatPane) => ChatPane) => {
    updatePane(focusedPaneIdRef.current, patch);
  }, [updatePane]);
  /** Focus follows interaction; with one pane this is a no-op. */
  const handleFocusPane = useCallback((paneId: string) => {
    setFocusedPaneId((current) => (current === paneId ? current : paneId));
  }, []);

  const selectedSession = focusedPane.session;
  const setSelectedSession = useCallback((next: StateUpdate<SessionInfo | null>) => {
    updateFocusedPane((pane) => ({ ...pane, session: applyStateUpdate(next, pane.session) }));
  }, [updateFocusedPane]);

  // When user clicks +, we only store the cwd — no fake session id
  const newSessionCwd = focusedPane.newSessionCwd;
  const setNewSessionCwd = useCallback((next: StateUpdate<string | null>) => {
    updateFocusedPane((pane) => ({ ...pane, newSessionCwd: applyStateUpdate(next, pane.newSessionCwd) }));
  }, [updateFocusedPane]);

  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Each pane carries its own remount key, read at its render site; only the
  // setter is needed here, for the session-switch paths that force a remount.
  const setSessionKey = useCallback((next: StateUpdate<number>) => {
    updateFocusedPane((pane) => ({ ...pane, remountKey: applyStateUpdate(next, pane.remountKey) }));
  }, [updateFocusedPane]);

  // Each pane reports its own stats, context usage, subagents and diffs; the
  // chrome around the panes reads whichever pane has focus.
  const [paneRuntimes, setPaneRuntimes] = useState<Record<string, PaneRuntime>>({});
  const patchPaneRuntime = useCallback((paneId: string, patch: Partial<PaneRuntime>) => {
    setPaneRuntimes((prev) => ({
      ...prev,
      [paneId]: { ...(prev[paneId] ?? EMPTY_PANE_RUNTIME), ...patch },
    }));
  }, []);
  const focusedRuntime = paneRuntimes[focusedPaneId] ?? EMPTY_PANE_RUNTIME;
  /** For the session-switch paths that reset chrome without a pane in hand. */
  const patchFocusedRuntime = useCallback((patch: Partial<PaneRuntime>) => {
    patchPaneRuntime(focusedPaneIdRef.current, patch);
  }, [patchPaneRuntime]);
  /** Updater form, when the patch is derived from the pane's current runtime. */
  const updateFocusedRuntime = useCallback((update: (runtime: PaneRuntime) => Partial<PaneRuntime>) => {
    setPaneRuntimes((prev) => {
      const paneId = focusedPaneIdRef.current;
      const current = prev[paneId] ?? EMPTY_PANE_RUNTIME;
      return { ...prev, [paneId]: { ...current, ...update(current) } };
    });
  }, []);

  // ---- Layout tree -----------------------------------------------------
  const [layout, setLayout] = useState<PaneNode>(() => leaf(FIRST_PANE_ID));
  const paneCounterRef = useRef(1);

  const handleSplitPane = useCallback((axis: SplitAxis) => {
    const targetId = focusedPaneId;
    const newPaneId = `pane-${paneCounterRef.current + 1}`;
    // splitPane returns null at a cap, so a refused split is a no-op rather
    // than a pane registered against a tree that never grew.
    const nextLayout = splitPane(layout, targetId, axis, newPaneId);
    if (nextLayout === null) return;
    paneCounterRef.current += 1;
    const source = panes.find((pane) => pane.id === targetId);
    // A new pane opens where its source is working — splitting to compare two
    // sessions in unrelated directories is the rarer intent.
    const inheritedCwd = source?.newSessionCwd ?? source?.session?.cwd ?? null;
    setPanes((prev) => [
      ...prev,
      { id: newPaneId, session: null, newSessionCwd: inheritedCwd, remountKey: 0 },
    ]);
    setLayout(nextLayout);
    setFocusedPaneId(newPaneId);
  }, [layout, panes, focusedPaneId]);

  const handleClosePane = useCallback((paneId: string) => {
    const nextLayout = removePane(layout, paneId);
    if (nextLayout === null) return;
    const nextFocus = paneAfterRemoval(layout, paneId);
    setLayout(nextLayout);
    setPanes((prev) => prev.filter((pane) => pane.id !== paneId));
    setPaneRuntimes((prev) => {
      if (!(paneId in prev)) return prev;
      const rest = { ...prev };
      delete rest[paneId];
      return rest;
    });
    // Pane ids are never reused, so these are only leaks — but a closed pane's
    // bookkeeping has no reason to outlive it.
    delete prevRunningSubagentsRef.current[paneId];
    delete turnChangesSigRef.current[paneId];
    delete branchLeafChangeFnRef.current[paneId];
    if (nextFocus !== null) setFocusedPaneId(nextFocus);
  }, [layout]);

  const canSplitRow = canSplitPane(layout, focusedPaneId, "row");
  const canSplitColumn = canSplitPane(layout, focusedPaneId, "column");
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [pluginsConfigOpen, setPluginsConfigOpen] = useState(false);
  const [tasksConfigOpen, setTasksConfigOpen] = useState(false);
  const [tasksConfigTargetId, setTasksConfigTargetId] = useState<string | null>(null);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  const openTasksConfig = useCallback((taskId?: string) => {
    setTasksConfigTargetId(taskId ?? null);
    setTasksConfigOpen(true);
  }, []);

  // Right panel view tabs: "review" (per-turn diffs) | "subagents" (fleet).
  const [rightView, setRightView] = useState<"review" | "subagents">("review");

  // Subagent fleet state, lifted from ChatWindow — recorded per pane.
  const subagents = focusedRuntime.subagents;
  const [subagentClearSignal, setSubagentClearSignal] = useState(0);
  // Per pane, not per app: a single counter shared by every pane would be
  // clobbered on each focus switch, so returning to a pane that already had
  // workers running would read as a fresh spawn and pop the panel open again.
  const prevRunningSubagentsRef = useRef<Record<string, number>>({});
  const handleSubagentsChange = useCallback((paneId: string, delegations: SubagentDelegation[]) => {
    patchPaneRuntime(paneId, { subagents: delegations });
    const running = delegations.reduce(
      (n, d) => n + d.children.filter((c) => c.status === "running").length,
      0,
    );
    // Recorded for every pane, focused or not, so the count a pane is compared
    // against is always its own.
    const previous = prevRunningSubagentsRef.current[paneId] ?? 0;
    prevRunningSubagentsRef.current[paneId] = running;
    // Only the focused pane may take over the right panel. A background pane
    // spawning workers must not swap the panel to data the user is not looking at.
    if (paneId !== focusedPaneIdRef.current) return;
    // Auto-switch to the Subagents tab when a new delegation spawns.
    if (running > previous) {
      setRightView("subagents");
      setRightPanelOpen(true);
    }
  }, [patchPaneRuntime]);

  // Per-turn diffs shown in the right panel; auto-opens when a new turn
  // changes files.
  const turnChanges = focusedRuntime.turnChanges;
  // Per pane for the same reason as the subagent counter above — two panes with
  // different diffs would otherwise look like a change on every focus switch.
  const turnChangesSigRef = useRef<Record<string, string>>({});
  const handleTurnChangesChange = useCallback((paneId: string, turns: TurnChanges[]) => {
    patchPaneRuntime(paneId, { turnChanges: turns });
    const sig = turns.map((t) => `${t.turnId}:${t.files.length}`).join(",");
    const previous = turnChangesSigRef.current[paneId] ?? "";
    turnChangesSigRef.current[paneId] = sig;
    if (paneId !== focusedPaneIdRef.current) return;
    if (sig && sig !== previous) setRightPanelOpen(true);
  }, [patchPaneRuntime]);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  // Branch state is per pane: the navigator in the top bar describes the focused
  // pane, and an unfocused pane reporting its tree must not redirect it.
  const branchTree = focusedRuntime.branchTree;
  const branchActiveLeafId = focusedRuntime.branchActiveLeafId;
  const branchLeafChangeFnRef = useRef<Record<string, (leafId: string | null) => void>>({});

  const handleBranchDataChange = useCallback((
    paneId: string,
    tree: SessionTreeNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => {
    patchPaneRuntime(paneId, { branchTree: tree, branchActiveLeafId: activeLeafId });
    branchLeafChangeFnRef.current[paneId] = onLeafChange;
  }, [patchPaneRuntime]);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    // The navigator is chrome around the focused pane, so it drives that pane.
    branchLeafChangeFnRef.current[focusedPaneIdRef.current]?.(leafId);
  }, []);

  const systemPrompt = focusedRuntime.systemPrompt;
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((paneId: string, prompt: string | null) => {
    patchPaneRuntime(paneId, { systemPrompt: prompt });
  }, [patchPaneRuntime]);

  // Session stats (tokens + cost) — populated by each ChatWindow, and the top
  // bar shows the focused pane's.
  const sessionStats = focusedRuntime.sessionStats;
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((paneId: string, stats: SessionStatsInfo | null) => {
    patchPaneRuntime(paneId, { sessionStats: stats });
  }, [patchPaneRuntime]);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated per pane, displayed for the focused one in the top bar
  const contextUsage = focusedRuntime.contextUsage;
  const handleContextUsageChange = useCallback((paneId: string, usage: ContextUsageInfo | null) => {
    patchPaneRuntime(paneId, { contextUsage: usage });
  }, [patchPaneRuntime]);


  // Codex plan quota — polled from the live upstream reading, displayed in top bar.
  // Stays null whenever the Codex desktop app is not signed in on this machine
  // (or is unreachable), which hides the badge instead of showing a placeholder.
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/codex-usage", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { available?: boolean; usage?: CodexUsage };
        if (cancelled) return;
        setCodexUsage(data.available && data.usage ? data.usage : null);
      } catch {
        // Quota is decorative. A failed poll keeps the last reading on screen;
        // the route itself decides when a reading has aged out.
      }
    };
    void load();
    // The server caches for 60s, so polling faster than this only adds requests.
    const timer = setInterval(() => { void load(); }, 90_000);
    const onVisibilityChange = () => { void load(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  // Derived here rather than inside the top-bar block so the stats button can be
  // gated on having something to render: a quota reading with no displayable
  // window would otherwise open an empty strip.
  const codexBadge = codexUsage ? badgeReading(codexUsage) : null;

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session" | "language") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(
          buttonRect.left - 1,
          Math.max(topBarRect.left, topBarRect.right - width),
        );
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectRootRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation, setNewSessionCwd]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    patchFocusedRuntime({ branchTree: [], branchActiveLeafId: null });
    patchFocusedRuntime({ systemPrompt: null });
    setActiveTopPanel(null);
    // File tabs are keyed by absolute path, so tabs opened in the previous
    // project would otherwise linger after switching to a different project.
    // Reached only past the same-project early return above, so worktrees of
    // one repo keep their open tabs. Mirror handleCloseFileTab and close the
    // now-empty right panel.
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightPanelOpen(false);
    router.replace("/", { scroll: false });
  }, [router, selectedSession, setNewSessionCwd, setSelectedSession, setSessionKey, patchFocusedRuntime]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    patchFocusedRuntime({ systemPrompt: null });
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, setNewSessionCwd, setSelectedSession, setSessionKey, patchFocusedRuntime]);

  // Open a worker's session from the Subagents tab (transcript).
  const handleOpenTranscript = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions?: SessionInfo[] };
      const info = data.sessions?.find((s) => s.id === sessionId);
      if (info) {
        // Task runs are global and may belong to a different project. Keep the
        // selected transcript open while the sidebar syncs to that cwd.
        suppressCwdBumpRef.current = true;
        handleSelectSession(info);
      }
    } catch {
      // ignore
    }
  }, [handleSelectSession]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    patchFocusedRuntime({ branchTree: [], branchActiveLeafId: null });
    patchFocusedRuntime({ systemPrompt: null });
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile, setNewSessionCwd, setSelectedSession, setSessionKey, patchFocusedRuntime]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  /** Fills in the full session record for whichever pane is holding that id. */
  const hydratePaneSession = useCallback((paneId: string, sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        // The pane may have been closed, or moved on, while this was in flight.
        updatePane(paneId, (pane) => (
          pane.session && pane.session.id === sessionId && !pane.session.projectRoot
            ? { ...pane, session: full }
            : pane
        ));
      })
      .catch(() => {});
  }, [updatePane]);

  // Called by ChatWindow when a new session gets its real id from pi. Targets the
  // reporting pane, not the focused one: clicking into another pane during the
  // round-trip would otherwise drop the new session into whichever pane the user
  // happened to land on.
  const handleSessionCreated = useCallback((paneId: string, session: SessionInfo) => {
    updatePane(paneId, (pane) => ({ ...pane, newSessionCwd: null, session }));
    setRefreshKey((k) => k + 1);
    hydratePaneSession(paneId, session.id);
    // The URL names a single session, so only the focused pane may rewrite it.
    if (paneId === focusedPaneIdRef.current) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, hydratePaneSession, updatePane]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      updateFocusedRuntime((runtime) => ({
        sessionStats: runtime.sessionStats?.sessionId === sessionId
          ? { ...runtime.sessionStats, sessionName: title }
          : runtime.sessionStats,
      }));
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id, setSelectedSession, updateFocusedRuntime]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleSessionForked = useCallback((paneId: string, newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    updatePane(paneId, (pane) => ({
      ...pane,
      remountKey: pane.remountKey + 1,
      newSessionCwd: null,
      session: {
        ...(pane.session ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
      },
    }));
    hydratePaneSession(paneId, newSessionId);
    if (paneId === focusedPaneIdRef.current) {
      router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
    }
  }, [router, hydratePaneSession, updatePane]);

  /**
   * ChatWindow reports upward through callbacks that carry no pane identity, so
   * each pane needs its own id bound in. These MUST be referentially stable:
   * ChatWindow clears its stats on unmount via
   * `useEffect(() => () => onSessionStatsChange(null), [onSessionStatsChange])`,
   * so a callback whose identity changed every render would re-run that cleanup
   * on every render, null the pane's stats, re-render, and loop.
   *
   * Keyed on the pane *ids* rather than the pane objects: a pane's session
   * changes constantly, and rebuilding these then would blink the top bar to
   * null and back on every message.
   *
   * Declared here rather than beside the other pane state because it binds
   * handlers defined further down — a `const` referenced before its initialiser
   * throws at render.
   */
  const paneIdsKey = panes.map((pane) => pane.id).join(",");
  const paneCallbacks = useMemo(() => {
    const map = new Map<string, {
      onSessionStatsChange: (stats: SessionStatsInfo | null) => void;
      onContextUsageChange: (usage: ContextUsageInfo | null) => void;
      onSystemPromptChange: (prompt: string | null) => void;
      onSubagentsChange: (delegations: SubagentDelegation[]) => void;
      onTurnChangesChange: (turns: TurnChanges[]) => void;
      onSessionCreated: (session: SessionInfo) => void;
      onSessionForked: (newSessionId: string) => void;
      onBranchDataChange: (
        tree: SessionTreeNode[],
        activeLeafId: string | null,
        onLeafChange: (leafId: string | null) => void,
      ) => void;
    }>();
    for (const paneId of paneIdsKey.split(",")) {
      map.set(paneId, {
        onSessionStatsChange: (stats) => handleSessionStatsChange(paneId, stats),
        onContextUsageChange: (usage) => handleContextUsageChange(paneId, usage),
        onSystemPromptChange: (prompt) => handleSystemPromptChange(paneId, prompt),
        onSubagentsChange: (delegations) => handleSubagentsChange(paneId, delegations),
        onTurnChangesChange: (turns) => handleTurnChangesChange(paneId, turns),
        onSessionCreated: (session) => handleSessionCreated(paneId, session),
        onSessionForked: (newSessionId) => handleSessionForked(paneId, newSessionId),
        onBranchDataChange: (tree, activeLeafId, onLeafChange) =>
          handleBranchDataChange(paneId, tree, activeLeafId, onLeafChange),
      });
    }
    return map;
  }, [
    paneIdsKey,
    handleSessionStatsChange,
    handleContextUsageChange,
    handleSystemPromptChange,
    handleSubagentsChange,
    handleTurnChangesChange,
    handleSessionCreated,
    handleSessionForked,
    handleBranchDataChange,
  ]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      patchFocusedRuntime({ branchTree: [], branchActiveLeafId: null });
      patchFocusedRuntime({ systemPrompt: null });
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router, setNewSessionCwd, setSelectedSession, setSessionKey, patchFocusedRuntime]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) {
        return [...prev, {
          id: tabId,
          label: fileName,
          filePath,
          sourceSessionId,
          initialDisplayMode: modeHint,
        }];
      }
      const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
      const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
      if (sourceUnchanged && modeUnchanged) return prev;
      return prev.map((t) => {
        if (t.id !== tabId) return t;
        const next: Tab = { ...t };
        if (sourceSessionId) next.sourceSessionId = sourceSessionId;
        if (modeHint) next.initialDisplayMode = modeHint;
        return next;
      });
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const paneNewSessionCwd = (pane: ChatPane) =>
    pane.newSessionCwd ?? (pane.session === null && activeCwd ? activeCwd : null);
  const effectiveNewSessionCwd = paneNewSessionCwd(focusedPane);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd, setSessionKey]);

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        tasksRefreshKey={tasksRefreshKey}
        onOpenTasks={openTasksConfig}
        onOpenTaskRunSession={handleOpenTranscript}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          {
             label: translate("common.models"),
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
             label: translate("common.skills"),
            onClick: () => setSkillsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
             label: translate("common.plugins"),
            onClick: () => setPluginsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7V2" />
                <path d="M15 7V2" />
                <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
                <path d="M12 19v3" />
              </svg>
            ),
          },
          {
             label: translate("common.tasks"),
            onClick: () => openTasksConfig(),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            ),
          },
          {
             label: translate("common.telegram"),
            onClick: () => setTelegramOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 4.5 2.5 11.8l5.6 1.8 2.1 6.1 3-3.4 4.3 3.2z" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            title={label}
            className="ui-btn"
            style={{
              flex: 1,
              gap: 6,
              borderRadius: "var(--r-md)",
              fontSize: "var(--fs-meta)",
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: var(--sh-3);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div className="app-canvas">
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`app-pane sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          // Was --bg-panel. As a floating pane it takes the top surface like the
          // others; --bg-panel now only layers *inside* a pane (bars, headers).
          background: "var(--bg)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div className="app-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} className="ui-bar" style={{ borderBottom: "1px solid var(--border)", height: "calc(var(--h-topbar) + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)", background: "var(--bg-panel)" }}>
          <button
            className="ui-btn ui-btn--bar"
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          <button
            className="ui-btn ui-btn--bar ui-btn--quiet"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
             title={isDark ? translate("theme.light") : translate("theme.dark")}
             aria-label={isDark ? translate("theme.light") : translate("theme.dark")}
            aria-pressed={isDark}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
           </button>
           <button
             className="ui-btn ui-btn--bar"
             ref={languageBtnRef}
             type="button"
             onClick={() => toggleTopPanel("language")}
             title={translate("common.language")}
             aria-label={translate("common.language")}
             aria-haspopup="menu"
             aria-expanded={activeTopPanel === "language"}
             aria-pressed={activeTopPanel === "language"}
           >
             <svg
               width="16"
               height="16"
               viewBox="0 0 24 24"
               fill="none"
               stroke="currentColor"
               strokeWidth="1.8"
               strokeLinecap="round"
               strokeLinejoin="round"
               aria-hidden="true"
             >
               <path d="m5 8 6 6" />
               <path d="m4 14 6-6 2-3" />
               <path d="M2 5h12" />
               <path d="M7 2h1" />
               <path d="m22 22-5-10-5 10" />
               <path d="M14 18h6" />
             </svg>
           </button>
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              // --accent as a class, not an inline colour: inline would beat the
              // class :hover/:active rules and kill the press feedback.
              // Untrusted project is an attention state, which is what amber
              // means throughout this UI.
              className="ui-btn ui-btn--accent"
              style={{
                fontSize: "var(--fs-micro)",
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                onClick={handleViewFullHistory}
                disabled={!selectedSession}
                 title={selectedSession ? translate("history.full") : translate("history.unsaved")}
                 aria-label={translate("history.full")}
                // disabled drives the dim state; the hairline divider is dropped
                // for the same reason as the toolbar's — spacing separates these.
                className="ui-btn"
                style={{
                  gap: 6,
                  height: "100%",
                  borderRadius: 0,
                  borderTop: "2px solid transparent",
                  fontSize: "var(--fs-micro)",
                  whiteSpace: "nowrap",
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
                 {!isMobile && <span>{translate("history.label")}</span>}
              </button>
              {(() => {
                const hasMessages = Boolean(
                  selectedSession
                  && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
                );
                const disabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                   ? translate("title.generating")
                    : isSuccess
                    ? translate("title.updated")
                    : isError
                      ? translate("title.failed")
                      : translate("title.generate");
                const title = !selectedSession
                   ? translate("title.unsaved")
                   : !hasMessages
                     ? translate("title.noMessages")
                     : isError
                       ? autoNameStatus.message
                       : translate("title.generateSession");

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    // Error/success are resting colours, so they are classes:
                    // #dc2626 becomes var(--danger), success takes the accent.
                    className={`ui-btn${isError ? " ui-btn--danger" : isSuccess ? " ui-btn--accent" : ""}`}
                    style={{
                      gap: 6,
                      height: "100%",
                      borderRadius: 0,
                      borderTop: "2px solid transparent",
                      borderColor: "transparent",
                      fontSize: "var(--fs-micro)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                compact={isMobile}
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                 title={translate("system.prompt")}
                 aria-label={translate("system.prompt")}
                aria-pressed={activeTopPanel === "system"}
                // aria-pressed already drives the selected surface via .ui-btn;
                // only the accent top-edge indicator stays inline.
                className="ui-btn"
                style={{
                  gap: 6,
                  height: "100%",
                  borderRadius: 0,
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: "var(--fs-micro)",
                  whiteSpace: "nowrap",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                 {!isMobile && <span>{translate("system.label")}</span>}
              </button>
            </div>
          )}
          {/* Split controls — desktop only, and they act on the focused pane.
              Disabled rather than hidden at a cap, so the ceiling is discoverable
              instead of the button vanishing. */}
          {!isMobile && showChat && (
            <div style={{ display: "flex", alignItems: "center" }}>
              <button
                type="button"
                className="ui-btn ui-btn--bar ui-btn--icon"
                title={translate("pane.splitRight")}
                aria-label={translate("pane.splitRight")}
                disabled={!canSplitRow}
                onClick={() => handleSplitPane("row")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="4" x2="12" y2="20" />
                </svg>
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--bar ui-btn--icon"
                title={translate("pane.splitDown")}
                aria-label={translate("pane.splitDown")}
                disabled={!canSplitColumn}
                onClick={() => handleSplitPane("column")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="12" x2="21" y2="12" />
                </svg>
              </button>
            </div>
          )}
          {/* Session stats + Codex quota — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage || codexBadge) && (() => {
             const tokens = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxStr: string | null = null;
            const ctxColor = usageThresholdColor(contextUsage?.contextWindow ? contextUsage.percent : null);
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            // Badge shows the window closest to its limit, which is not always
            // the one upstream labels "primary": a 5h window at 80% gates the
            // account long before a weekly one at 20%.
            const quotaStr = codexBadge
              ? `${codexBadge.name} ${codexBadge.window.usedPercent.toFixed(0)}%`
              : null;
            const quotaColor = usageThresholdColor(codexBadge?.window.usedPercent ?? null);

            const tooltipParts: string[] = [];
             if (tokens) {
               tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
               tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
               tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
               tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            if (codexUsage) {
              const quotaLine = (name: string, window: { usedPercent: number; windowSeconds: number | null }) => {
                const period = formatWindowLabel(window.windowSeconds);
                return `${name}${period ? ` ${period}` : ""}: ${window.usedPercent.toFixed(0)}%`;
              };
              const planLabel = formatPlanLabel(codexUsage.plan);
              for (const window of codexUsage.windows) tooltipParts.push(quotaLine(planLabel, window));
              for (const bucket of codexUsage.extras) {
                for (const window of bucket.windows) tooltipParts.push(quotaLine(bucket.label ?? bucket.key, window));
              }
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
               title={tooltip || translate("session.title")}
                 aria-label={translate("session.title")}
                aria-pressed={activeTopPanel === "session"}
                className="ui-btn"
                style={{
                  marginLeft: "auto",
                  gap: 10,
                  paddingLeft: 12,
                  paddingRight: rightPanelOpen ? 12 : 48,
                  height: "100%",
                  borderRadius: 0,
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: "var(--fs-micro)",
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                 {!isMobile && tokens && tokens.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                     {fmt(tokens.input)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                     {fmt(tokens.output)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                     {fmt(tokens.cacheRead)}
                  </span>
                )}
                {!isMobile && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
                {/* Quota is desktop-only in the bar — the phone top bar has no room
                    for a second percentage, and the panel below carries every bucket. */}
                {!isMobile && quotaStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: quotaColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.3 7.7 A4 4 0 1 1 8.7 7.7" /><line x1="5" y1="5.2" x2="7.1" y2="3.1" />
                    </svg>
                    {quotaStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "language" && (
                <div
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      className={`ui-row${locale === plugin.id ? " is-active" : ""}`}
                      style={{ fontSize: "var(--fs-meta)" }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.empty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.load")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {/* Codex quota sits outside the sessionStats branch on purpose: the
                      account quota is not session-scoped, so it stays readable before
                      a session has loaded any stats. */}
                  {codexUsage && (() => {
                    const relativeFromMs = (targetMs: number) => {
                      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
                      const minutes = Math.round((targetMs - Date.now()) / 60_000);
                      if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
                      const hours = Math.round(minutes / 60);
                      if (Math.abs(hours) < 48) return rtf.format(hours, "hour");
                      return rtf.format(Math.round(hours / 24), "day");
                    };
                    const rows: { key: string; name: string; period: string; percent: number; resets: string }[] = [];
                    const planLabel = formatPlanLabel(codexUsage.plan);
                    codexUsage.windows.forEach((window, index) => rows.push({
                      key: `plan-${index}`,
                      name: planLabel,
                      period: formatWindowLabel(window.windowSeconds) ?? "—",
                      percent: window.usedPercent,
                      resets: window.resetAt === null ? "—" : relativeFromMs(window.resetAt * 1000),
                    }));
                    codexUsage.extras.forEach((bucket) => bucket.windows.forEach((window, index) => rows.push({
                      key: `${bucket.key}-${index}`,
                      name: bucket.label ?? bucket.key,
                      period: formatWindowLabel(window.windowSeconds) ?? "—",
                      percent: window.usedPercent,
                      resets: window.resetAt === null ? "—" : relativeFromMs(window.resetAt * 1000),
                    })));
                    return (
                      <div style={{
                        marginBottom: 14,
                        paddingBottom: 14,
                        borderBottom: "1px solid var(--border)",
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                          {translate("codex.quota")}
                        </div>
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "max-content max-content max-content max-content",
                          columnGap: 14,
                          rowGap: 4,
                          justifyContent: "start",
                        }}>
                          <div style={{ color: "var(--text-dim)" }}>{translate("codex.plan")}</div>
                          <div style={{ color: "var(--text-dim)" }}>{translate("codex.window")}</div>
                          <div style={{ color: "var(--text-dim)", textAlign: "right" }}>{translate("codex.used")}</div>
                          <div style={{ color: "var(--text-dim)" }}>{translate("codex.resets")}</div>
                          {rows.map((row) => (
                            <div key={row.key} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{row.name}</div>
                              <div style={{ color: "var(--text-muted)" }}>{row.period}</div>
                              <div style={{
                                color: usageThresholdColor(row.percent),
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              }}>{row.percent.toFixed(0)}%</div>
                              <div style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{row.resets}</div>
                            </div>
                          ))}
                        </div>
                        {codexUsage.resetCredits !== null && codexUsage.resetCredits > 0 && (
                          <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
                            {translate("codex.resetCredits")}: {codexUsage.resetCredits.toLocaleString(locale)}
                          </div>
                        )}
                        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
                          {translate("codex.updated", { age: relativeFromMs(codexUsage.fetchedAt) })}
                        </div>
                      </div>
                    );
                  })()}
                  {sessionStats ? (() => {
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          className={`ui-btn ui-btn--icon ui-btn--outline ${copied ? "ui-btn--accent" : "ui-btn--dim"}`}
                          style={{
                            alignSelf: "start",
                            marginTop: -2,
                            flex: "0 0 auto",
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex" }}>
          {showChat ? (
            <ChatPaneTree
              layout={layout}
              focusedPaneId={focusedPaneId}
              onFocusPane={handleFocusPane}
              onClosePane={handleClosePane}
              closeLabel={translate("pane.close")}
              renderPane={(paneId) => {
                const pane = panes.find((candidate) => candidate.id === paneId);
                if (!pane) return null;
                const callbacks = paneCallbacks.get(paneId);
                return (
                  <PaneChatWindow
                    key={`${pane.id}:${pane.remountKey}`}
                    session={pane.session}
                    newSessionCwd={paneNewSessionCwd(pane)}
                    onAgentEnd={handleAgentEnd}
                    onSessionCreated={callbacks?.onSessionCreated}
                    onSessionForked={callbacks?.onSessionForked}
                    modelsRefreshKey={modelsRefreshKey}
                    // Global shortcuts type into one input, so only the focused
                    // pane claims the shared ref.
                    chatInputRef={pane.id === focusedPaneId ? chatInputRef : undefined}
                    onBranchDataChange={callbacks?.onBranchDataChange}
                    onSystemPromptChange={callbacks?.onSystemPromptChange}
                    onSessionStatsChange={callbacks?.onSessionStatsChange}
                    onTurnChangesChange={callbacks?.onTurnChangesChange}
                    onSubagentsChange={callbacks?.onSubagentsChange}
                    clearSubagentsSignal={subagentClearSignal}
                    onOpenTranscript={handleOpenTranscript}
                    onSessionStatsPanelOpen={openSessionStatsPanel}
                    onContextUsageChange={callbacks?.onContextUsageChange}
                    onOpenFile={handleOpenLinkedFile}
                  />
                );
              }}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: "var(--fs-body)", color: "var(--danger)" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`app-pane right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel view tabs: Subagents | Review */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(var(--h-topbar) + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "var(--sp-4)",
          paddingRight: "var(--sp-4)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          {/* One segmented control rather than two loose buttons in a bar. */}
          <div className="ui-segmented" style={{ flex: 1 }} role="tablist">
          {(["review", "subagents"] as const).map((view) => (
            <button
              key={view}
              role="tab"
              className={`ui-tab${rightView === view ? " is-active" : ""}`}
              aria-selected={rightView === view}
              onClick={() => {
                setRightView(view);
                setActiveFileTabId(null);
              }}
            >
              {view === "review" ? translate("panel.review") : translate("panel.subagents")}
            </button>
          ))}
          </div>
        </div>

        {/* File tabs — shown when files are open */}
        {fileTabs.length > 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
          }}>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <TabBar
                tabs={fileTabs}
                activeTabId={activeFileTabId ?? ""}
                onSelectTab={setActiveFileTabId}
                onCloseTab={handleCloseFileTab}
              />
            </div>
          </div>
        )}

        {/* Panel content: open file, or active view (review diffs / subagents) */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.filePath ? (
            <FileViewer
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : rightView === "subagents" ? (
            <SubagentsView
              delegations={subagents}
              onOpenTranscript={handleOpenTranscript}
              onClear={() => setSubagentClearSignal((s) => s + 1)}
            />
          ) : (
            <PerTurnDiffView
              turns={turnChanges}
              onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName, {})}
            />
          )}
        </div>
      </div>
    </div>
    {/* File panel toggle — always visible at top-right */}
    <button
      onClick={() => setRightPanelOpen((v) => !v)}
       aria-controls="file-panel"
       aria-expanded={rightPanelOpen}
       title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
       aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
      // aria-expanded above already drives the open/selected surface.
      className="ui-btn ui-btn--bar"
      style={{
        position: "fixed",
        top: "env(safe-area-inset-top)",
        right: "env(safe-area-inset-right)",
        zIndex: "var(--z-overlay)",
        background: "var(--bg-panel)",
        borderRight: "none",
        borderLeft: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        borderRadius: "0 0 0 var(--r-md)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {skillsConfigOpen && projectTrustCwd && (
      <SkillsConfig cwd={projectTrustCwd} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {pluginsConfigOpen && projectTrustCwd && (
      <PluginsConfig
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setPluginsConfigOpen(false)}
        onReloaded={() => setSessionKey((k) => k + 1)}
      />
    )}
    {tasksConfigOpen && (
      <TasksConfig
        activeCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
        initialTaskId={tasksConfigTargetId}
        onClose={() => {
          setTasksConfigOpen(false);
          setTasksConfigTargetId(null);
        }}
        onTasksChanged={() => setTasksRefreshKey((key) => key + 1)}
      />
    )}
    {telegramOpen && (
      <TelegramSettings onClose={() => setTelegramOpen(false)} />
    )}
    </>
  );
}

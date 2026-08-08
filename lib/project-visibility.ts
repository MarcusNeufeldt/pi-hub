const HIDDEN_PROJECTS_STORAGE_KEY = "pi-web:hidden-projects";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Projects the user chose to hide from the sidebar. Hiding only affects the
 *  UI — session files and chats stay untouched on disk. */
export function loadHiddenProjects(storage: StorageLike | null = getBrowserStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HIDDEN_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function saveHiddenProjects(
  projects: string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Persistence is best-effort; privacy mode and storage quotas must not break the sidebar.
  }
}

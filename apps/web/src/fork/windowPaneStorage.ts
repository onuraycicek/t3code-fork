// Secondary windows keep their split/tab layout in sessionStorage; only the main window's is remembered.
// The pane store hydrates before initWindowProjectScope() runs, so read its signals directly
// (session scope record, or the projectScope URL param); keep both names in sync with ../windowProjectScope.ts.
const WINDOW_SCOPE_SESSION_KEY = "t3code:window-project-scope:v1";
const PROJECT_SCOPE_URL_PARAM = "projectScope";

function isSecondaryAppWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.sessionStorage.getItem(WINDOW_SCOPE_SESSION_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null && "secondary" in stored) {
        return stored.secondary === true;
      }
    }
  } catch {}
  return new URLSearchParams(window.location.search).has(PROJECT_SCOPE_URL_PARAM);
}

export function chatPanesBackingStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return isSecondaryAppWindow() ? window.sessionStorage : window.localStorage;
}

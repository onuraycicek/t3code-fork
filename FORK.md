# Fork notes (local branch `fork/split-sidebar`)

Two features on top of upstream T3 Code:

- **Project-grouped sidebar.** Active threads are grouped under project headers,
  5 per project with "Show more"; sections collapse; pinned, working, snoozed and
  settled shelves behave as upstream. Toggle: Settings → General → "Group threads
  by project" (on by default). Ported from upstream PR #13815 / #9156.
- **Split chat panes (Orca style).** A binary split tree; every pane is a full
  chat. Ported from upstream PR #10783, with Orca's interaction model.
  - `Cmd+\` split right, `Cmd+Shift+\` split down, `Cmd+Alt+W` close pane,
    `Cmd+Alt+Arrow` move focus between panes.
  - Sidebar right-click → "Open in split".
  - Clicking a thread in the sidebar opens it in the focused pane (or focuses the
    pane that already shows it). Empty panes list recent threads.
  - Drag a pane by its grip: drop on another pane's outer 20% to split there,
    on its center to swap the two panes. Dividers resize (15–85%), double-click
    resets to 50/50. The layout is saved in localStorage.

- **Tabs per pane.** Every pane is a tab group; a single pane with tabs is a
  valid layout (no collapse to the plain view). Opening a thread (sidebar click,
  promoted draft) focuses its tab or adds a new tab to the focused pane; "Open in
  split" makes a new pane. Tabs: middle-click/x close, right-click menu (close,
  others, to the right, all), drag to reorder, move between panes, or drop on a
  pane edge to split. `Cmd+Shift+W` closes the tab, `Ctrl+Tab` / `Ctrl+Shift+Tab`
  move to the next / previous tab of the focused pane (never another pane),
  `Ctrl+1..9` (`Alt+1..9` off macOS) jumps to tab N. Layout persisted v2 (v1
  single-thread panes migrate to one tab).

- **Queue waits for the agent to finish.** A queued message is held while the
  agent waits on work that reports back (a subagent or another background
  task), and the agent's wake turns go ahead of queued user messages. Monitors
  and background commands never hold the queue (a watcher or dev server never
  finishes), and any hold ends 10 minutes after the agent went idle. Steer
  still sends at once. Server code: `apps/server/src/fork/queueHold.ts` (rule),
  `queueHoldSweep.ts` (30 s re-check when work ends without a wake).

## Where the code lives (keep it this way: fewer rebase conflicts)

All fork code is in `apps/web/src/fork/`, `apps/desktop/src/fork/` and
`apps/server/src/fork/` (new files never conflict). Upstream
files only carry small hook-up edits:

- `ChatView.tsx`: `useChatPane()` + one-line `inputOwner` guards on window
  listeners, so background panes do not steal input.
- `DiffPanel.tsx`: reads the pane's thread from `useChatPane()`.
- `ThreadRouteView.tsx`: `useChatPaneRoute()` + render `<ChatPanes>`.
- `Sidebar.tsx`, `Sidebar.logic.ts`, `Sidebar.drag.ts`: call sites into
  `fork/useSidebarProjectGrouping`, `fork/sidebarProjectItems`,
  `fork/SidebarProjectGroupRows`; the compact grouped row variant.
- `SettingsPanels.tsx`: renders `<ForkSettingsRows />` (setting stored in
  `fork/forkPrefsStore.ts`, not in the upstream settings schema).
- `threadActionMenu.logic.ts`, `contextMenuFallback.ts`: "Open in split" item.
- `desktopUpdate.logic.ts`: release links fall back to `fork/forkRepo.ts` when no update repository is configured (tests updated).
- Server: `Orchestrator.ts` (`forkQueueHold` in `startNextQueuedRun`),
  `QueuedRunOrder.ts` (`forkWakeFirst`), `server.ts` (sweep layer),
  `runtimeLayer.test.ts` (one wake dispatched later).

New fork code goes in `fork/`; touch an upstream file only with a one-line hook.

Commit subjects: `fork: ...` for user-facing changes (they become "Fork: ..."
items in the app's update popover), `fork(ci): ...` for CI, build and tooling
changes (kept out of the release notes).
`git rerere` is enabled in this repo, so a conflict resolved once is reused.

## Nightly CI (github.com/onuraycicek/t3code-fork)

`.github/workflows/fork-nightly.yml` runs every night at 01:00 UTC (and on
manual dispatch):

1. Rebases the `fork:` commits onto upstream `main` (git rerere cache kept in
   Actions cache).
2. Conflicts, or failing `make typecheck-web lint-web test-fork`, are handed to
   Claude Code (`anthropics/claude-code-action`, subscription token) with
   `.github/fork/sync-instructions.md`. Its result is pushed only if every check
   passes; otherwise the run fails and nothing ships.
3. Builds a Developer ID signed + notarized macOS app on macos-15 and publishes
   it as a prerelease `v<version>`. The body (shown as "What's changed" in the
   update popover) comes from `.github/fork/release-notes.sh`: upstream
   nightlies' "What's Changed" items since the previous fork release, then new
   `fork:` changes. The installed app's built-in updater
   (nightly channel, every few minutes) installs it.
4. Upstream workflows that come along are disabled; only `fork-nightly.yml`
   runs.

Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD` (Developer ID p12),
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (notarization),
`CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), `FORK_PUSH_TOKEN`
(fine-grained token for this repo: Contents + Workflows read/write).

## Installing

First install (or any time): `make install-latest` from Terminal, not from
inside the app. It downloads the newest CI release, quits the running fork
app, replaces `/Applications/T3 Code Fork.app` and relaunches it. After that
the app updates itself from this repository's releases.

## Manual update

```sh
git fetch origin
git rebase origin/main        # resolve conflicts, mostly Sidebar.tsx / ChatView.tsx
make install
make typecheck-web lint-web test-fork
make build-desktop            # unsigned arm64 app in release/, no update feed
make install-app              # quit the fork first; installs /Applications/T3 Code Fork.app
```

Before switching the installed app, check that upstream did not add a database
migration the official app does not have yet (or keep the fork newer than the
official build), since both use `~/.t3`.

## Dev loop

```sh
make seed-dev-db   # read-only copy of a slice of ~/.t3 into ~/.t3-fork
make dev           # web + server on localhost:5733 against ~/.t3-fork
```

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

## Where the code lives (keep it this way: fewer rebase conflicts)

All fork code is in `apps/web/src/fork/` (new files never conflict). Upstream
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

New fork code goes in `fork/`; touch an upstream file only with a one-line hook.
`git rerere` is enabled in this repo, so a conflict resolved once is reused.

## Weekly update

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

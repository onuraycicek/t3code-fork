import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useRef, type ReactNode } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";

/**
 * What a view rendered inside a split pane needs to know. Read through
 * context so upstream components (ChatView, DiffPanel) only need a one-line
 * hook call instead of new props.
 */
interface ChatPaneContextValue {
  /** Background panes must not own window-level input. */
  readonly focused: boolean;
  /** The pane's thread; the route only names the focused pane's thread. */
  readonly threadRef: ScopedThreadRef | null;
}

const ChatPaneContext = createContext<ChatPaneContextValue | null>(null);

export function ChatPaneProvider({
  value,
  children,
}: {
  value: ChatPaneContextValue;
  children: ReactNode;
}) {
  return <ChatPaneContext.Provider value={value}>{children}</ChatPaneContext.Provider>;
}

/** Null outside a split layout (the plain single chat view). */
export function useChatPane(): ChatPaneContextValue | null {
  return useContext(ChatPaneContext);
}

/**
 * Gives each pane its own composer handle. Upstream shares one app-wide handle
 * (so the command palette reaches "the" composer); with several chats on screen
 * that made a file dropped on a background pane land in the focused pane's
 * composer. The focused pane keeps the shared handle, so the palette still
 * targets it; background panes get a private one.
 */
export function PaneComposerScope({
  focused,
  children,
}: {
  focused: boolean;
  children: ReactNode;
}) {
  const shared = useComposerHandleContext();
  const local = useRef<ChatComposerHandle | null>(null);
  return (
    <ComposerHandleContext value={focused && shared ? shared : local}>
      {children}
    </ComposerHandleContext>
  );
}

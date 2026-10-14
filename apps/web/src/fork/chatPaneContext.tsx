import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

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

import {
  AlarmClockIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";

export type CompactRowStatusIcon =
  | "working"
  | "waiting"
  | "input"
  | "approval"
  | "failed"
  | "done"
  | "woke";

/**
 * One-line thread row used under a project header in grouped mode. Everything is
 * computed by the upstream row and passed in, so this file holds only markup.
 */
export function SidebarCompactThreadRow(props: {
  threadKey: string;
  liProps: ComponentProps<"li">;
  rowProps: ComponentProps<"div">;
  tooltipDisabled: boolean;
  tooltip: ReactNode;
  accessibleTitle: ReactNode;
  /** The rename input, or null to render the plain title. */
  renameInput: ReactNode;
  title: string;
  isActive: boolean;
  isUnread: boolean;
  isWoke: boolean;
  needsInput: boolean;
  receded: boolean;
  statusIcon: CompactRowStatusIcon | null;
  statusClassName: string | undefined;
  draftIndicator: ReactNode;
  timeLabel: ReactNode;
  /** Hover actions; each is omitted when the row does not support it. */
  onDiscardDraft: ComponentProps<"button">["onClick"];
  snoozeButton: ReactNode;
  snoozeOpen: boolean;
  onSettle: ComponentProps<"button">["onClick"];
  onSettlePointerDown: ComponentProps<"button">["onPointerDown"];
  /** Drag/sweep verb badge; replaces the time while present. */
  dragBadge: ReactNode;
  dragging: boolean;
  sweeping: boolean;
  jumpHint: ReactNode;
}) {
  const { statusIcon: icon } = props;
  const hasActions = !!(props.onDiscardDraft || props.snoozeButton || props.onSettle);
  const iconClass = cn("size-3.5 shrink-0", props.statusClassName);
  return (
    <li
      data-thread-item={props.threadKey}
      {...props.liProps}
      className={cn("list-none px-0.5 py-px", props.liProps.className)}
    >
      <Tooltip disabled={props.tooltipDisabled}>
        <TooltipTrigger render={<div data-testid="sidebar-row-card" {...props.rowProps} />}>
          {props.accessibleTitle}
          <div className="relative z-10 flex h-8 min-w-0 items-center gap-2 pr-2 pl-5">
            <span
              data-compact-row-status={icon ?? (props.isUnread ? "unread" : "idle")}
              className="flex size-4 shrink-0 items-center justify-center"
            >
              {icon === "working" ? (
                <CircleDashedIcon aria-hidden className={iconClass} />
              ) : icon === "waiting" ? (
                <CircleDotDashedIcon aria-hidden className={iconClass} />
              ) : icon === "input" ? (
                <MessageCircleQuestionIcon aria-hidden className={iconClass} />
              ) : icon === "approval" ? (
                <ShieldQuestionIcon aria-hidden className={iconClass} />
              ) : icon === "failed" ? (
                <CircleAlertIcon aria-hidden className={iconClass} />
              ) : icon === "woke" ? (
                <AlarmClockIcon aria-hidden className={iconClass} />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "size-2 rounded-full",
                    props.isUnread ? "bg-info" : "bg-muted-foreground/35",
                  )}
                />
              )}
            </span>
            {props.draftIndicator}
            {props.renameInput ?? (
              <span
                aria-hidden
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-normal",
                  props.isActive || props.isUnread || props.isWoke || props.needsInput
                    ? "text-foreground"
                    : props.receded
                      ? "text-secondary-label/70"
                      : "text-secondary-label",
                  "group-hover/sidebar-row:text-foreground",
                )}
              >
                {props.title}
              </span>
            )}
            {props.dragging ? (
              props.dragBadge
            ) : (
              // A sweep hides the slot instead of unmounting it so the pressed
              // action button stays connected until its release click fires.
              <span
                className={cn(
                  "relative flex h-6 min-w-8 shrink-0 items-center justify-end text-xs",
                  props.sweeping && "hidden",
                )}
              >
                <span
                  className={cn(
                    "tabular-nums text-secondary-label group-any-hover/sidebar-row:hidden",
                    hasActions && props.snoozeOpen && "hidden",
                  )}
                >
                  {props.timeLabel}
                </span>
                {hasActions ? (
                  <span
                    className={cn(
                      "hidden items-stretch group-any-hover/sidebar-row:flex has-[:focus-visible]:flex",
                      props.snoozeOpen && "flex",
                    )}
                  >
                    {props.onDiscardDraft ? (
                      <CompactRowActionButton
                        discard
                        label="Discard draft"
                        onClick={props.onDiscardDraft}
                      />
                    ) : null}
                    {props.snoozeButton}
                    {props.onSettle ? (
                      <CompactRowActionButton
                        label="Settle thread"
                        onClick={props.onSettle}
                        onPointerDown={props.onSettlePointerDown}
                      />
                    ) : null}
                  </span>
                ) : null}
              </span>
            )}
            {props.sweeping ? props.dragBadge : null}
          </div>
          {props.jumpHint}
        </TooltipTrigger>
        {props.tooltip}
      </Tooltip>
    </li>
  );
}

/** Icon-only hover buttons for the compact row's action slot. */
export function CompactRowActionButton(props: {
  label: string;
  onClick: ComponentProps<"button">["onClick"];
  onPointerDown?: ComponentProps<"button">["onPointerDown"];
  discard?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            onPointerDown={props.onPointerDown}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        {props.discard ? <XIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

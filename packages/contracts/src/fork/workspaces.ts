import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProjectIconOverride } from "../project.ts";

/**
 * Fork: the workspace registry. A workspace is a named working setup; threads join one
 * through the server-side thread tag `workspace:<id>`, so the id must never change and
 * the registry lives on the server, next to the threads it describes.
 */

/** Thread tag prefix for workspace membership; the rest is the workspace id. */
const FORK_WORKSPACE_TAG_PREFIX = "workspace:";

export const ForkWorkspaceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9-]+$/),
);
export type ForkWorkspaceId = typeof ForkWorkspaceId.Type;

/** An uploaded picture is cropped to a small square client-side; this caps a bad upload. */
const ForkWorkspaceImageDataUrl = Schema.String.check(
  Schema.isMaxLength(256 * 1024),
  Schema.isPattern(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
);

export const ForkWorkspaceIcon = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("override"), icon: ProjectIconOverride }),
  Schema.Struct({ kind: Schema.Literal("image"), dataUrl: ForkWorkspaceImageDataUrl }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    environmentId: TrimmedNonEmptyString,
    projectId: TrimmedNonEmptyString,
  }),
]);
export type ForkWorkspaceIcon = typeof ForkWorkspaceIcon.Type;

export const ForkWorkspace = Schema.Struct({
  id: ForkWorkspaceId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  icon: Schema.optional(ForkWorkspaceIcon),
});
export type ForkWorkspace = typeof ForkWorkspace.Type;

export const ForkWorkspaceRegistry = Schema.Struct({
  /** Bumped on every write; updates name the revision they started from. */
  revision: NonNegativeInt,
  /** In display order. Never empty once written. */
  workspaces: Schema.Array(ForkWorkspace),
  /** Holds threads without a (known) workspace tag. Always one of `workspaces`. */
  defaultWorkspaceId: Schema.NullOr(ForkWorkspaceId),
});
export type ForkWorkspaceRegistry = typeof ForkWorkspaceRegistry.Type;

export const ForkWorkspacesUpdateInput = Schema.Struct({
  expectedRevision: NonNegativeInt,
  workspaces: Schema.Array(ForkWorkspace).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  defaultWorkspaceId: ForkWorkspaceId,
});
export type ForkWorkspacesUpdateInput = typeof ForkWorkspacesUpdateInput.Type;

/** `applied: false` means the revision moved on; `registry` is the current one to retry from. */
export const ForkWorkspacesUpdateResult = Schema.Struct({
  applied: Schema.Boolean,
  registry: ForkWorkspaceRegistry,
});
export type ForkWorkspacesUpdateResult = typeof ForkWorkspacesUpdateResult.Type;

export const ForkWorkspacesSubscribeInput = Schema.Struct({});
export type ForkWorkspacesSubscribeInput = typeof ForkWorkspacesSubscribeInput.Type;

/** The workspace ids a thread's tags name, in tag order. */
export function forkWorkspaceIdsFromTags(tags: ReadonlyArray<string> | undefined): string[] {
  if (!tags) return [];
  return tags
    .filter((tag) => tag.startsWith(FORK_WORKSPACE_TAG_PREFIX))
    .map((tag) => tag.slice(FORK_WORKSPACE_TAG_PREFIX.length))
    .filter((id) => id.length > 0);
}

export function forkWorkspaceTag(workspaceId: string): string {
  return `${FORK_WORKSPACE_TAG_PREFIX}${workspaceId}`;
}

import {
  ForkWorkspaceRegistry as ForkWorkspaceRegistrySchema,
  type ForkWorkspace,
  type ForkWorkspaceRegistry as ForkWorkspaceRegistryValue,
  type ForkWorkspacesUpdateInput,
  type ForkWorkspacesUpdateResult,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

/**
 * Fork: the workspace registry (ids, names, icons, order, default). Threads point at a
 * workspace by id through the `workspace:<id>` thread tag, so the registry is kept on
 * the server next to them, written atomically, and served to every client as a stream.
 */
export class ForkWorkspaceRegistry extends Context.Service<
  ForkWorkspaceRegistry,
  {
    readonly changes: Stream.Stream<ForkWorkspaceRegistryValue>;
    readonly update: (
      input: ForkWorkspacesUpdateInput,
    ) => Effect.Effect<ForkWorkspacesUpdateResult>;
  }
>()("t3/fork/workspaceRegistry/ForkWorkspaceRegistry") {}

const REGISTRY_FILE = "fork-workspaces.json";

const EMPTY_REGISTRY: ForkWorkspaceRegistryValue = {
  revision: 0,
  workspaces: [],
  defaultWorkspaceId: null,
};

const RegistryJson = Schema.fromJsonString(ForkWorkspaceRegistrySchema);
const decodeRegistry = Schema.decodeUnknownOption(RegistryJson);
const encodeRegistry = Schema.encodeEffect(RegistryJson);

/** Drops duplicate ids (first wins) and points the default at a listed workspace. */
export function normalizeWorkspaces(
  workspaces: ReadonlyArray<ForkWorkspace>,
  defaultWorkspaceId: string,
): { workspaces: ForkWorkspace[]; defaultWorkspaceId: string | null } {
  const seen = new Set<string>();
  const unique = workspaces.filter((workspace) => {
    if (seen.has(workspace.id)) return false;
    seen.add(workspace.id);
    return true;
  });
  return {
    workspaces: unique,
    defaultWorkspaceId: seen.has(defaultWorkspaceId) ? defaultWorkspaceId : (unique[0]?.id ?? null),
  };
}

export const layer = Layer.effect(
  ForkWorkspaceRegistry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const filePath = path.join(stateDir, REGISTRY_FILE);

    const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
    let initial = EMPTY_REGISTRY;
    if (Option.isSome(raw)) {
      const decoded = decodeRegistry(raw.value);
      if (Option.isSome(decoded)) {
        initial = decoded.value;
      } else {
        // Keep the unreadable file for recovery instead of overwriting it on the next save.
        const backup = `${filePath}.unreadable-${yield* Clock.currentTimeMillis}`;
        yield* fs.rename(filePath, backup).pipe(Effect.ignore);
        yield* Effect.logWarning("fork workspace registry was unreadable; kept a copy", {
          backup,
        });
      }
    }

    const state = yield* SubscriptionRef.make(initial);
    const writeLock = yield* Semaphore.make(1);

    const fileServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const update = Effect.fn("ForkWorkspaceRegistry.update")(
      function* (input: ForkWorkspacesUpdateInput) {
        const current = yield* SubscriptionRef.get(state);
        if (input.expectedRevision !== current.revision) {
          const stale: ForkWorkspacesUpdateResult = { applied: false, registry: current };
          return stale;
        }
        const next: ForkWorkspaceRegistryValue = {
          revision: current.revision + 1,
          ...normalizeWorkspaces(input.workspaces, input.defaultWorkspaceId),
        };
        const contents = yield* encodeRegistry(next);
        yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
          Effect.provide(fileServices),
        );
        yield* SubscriptionRef.set(state, next);
        const applied: ForkWorkspacesUpdateResult = { applied: true, registry: next };
        return applied;
      },
      Effect.tapError((cause) =>
        Effect.logError("fork workspace registry could not be saved", { filePath, cause }),
      ),
      // A failed save is an operator problem (disk, permissions), not a client one.
      Effect.orDie,
      writeLock.withPermits(1),
    );

    return ForkWorkspaceRegistry.of({
      changes: SubscriptionRef.changes(state),
      update,
    });
  }),
);

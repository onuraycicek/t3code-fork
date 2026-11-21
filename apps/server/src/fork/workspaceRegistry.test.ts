import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ForkWorkspaceRegistry from "./workspaceRegistry.ts";

const workspace = (id: string, name = id) => ({ id, name });

const layer = (prefix: string) =>
  ForkWorkspaceRegistry.layer.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
    Layer.provideMerge(NodeServices.layer),
  );

const current = Effect.gen(function* () {
  const registry = yield* ForkWorkspaceRegistry.ForkWorkspaceRegistry;
  return yield* registry.changes.pipe(Stream.take(1), Stream.runHead);
});

it("normalizeWorkspaces keeps the first of duplicate ids and a listed default", () => {
  const result = ForkWorkspaceRegistry.normalizeWorkspaces(
    [workspace("a", "A"), workspace("b"), workspace("a", "again")],
    "missing",
  );
  assert.deepStrictEqual(
    result.workspaces.map((entry) => entry.name),
    ["A", "b"],
  );
  assert.strictEqual(result.defaultWorkspaceId, "a");
});

it.effect("applies an update on the current revision and persists it", () =>
  Effect.gen(function* () {
    const registry = yield* ForkWorkspaceRegistry.ForkWorkspaceRegistry;
    const first = yield* registry.update({
      expectedRevision: 0,
      workspaces: [workspace("a"), workspace("b")],
      defaultWorkspaceId: "b",
    });
    assert.isTrue(first.applied);
    assert.strictEqual(first.registry.revision, 1);
    assert.strictEqual(first.registry.defaultWorkspaceId, "b");

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const saved = JSON.parse(yield* fs.readFileString(path.join(stateDir, "fork-workspaces.json")));
    assert.strictEqual(saved.revision, 1);
    assert.deepStrictEqual(
      saved.workspaces.map((entry: { id: string }) => entry.id),
      ["a", "b"],
    );
  }).pipe(Effect.provide(layer("t3-fork-workspaces-apply-"))),
);

it.effect("rejects an update made against an old revision and returns the current one", () =>
  Effect.gen(function* () {
    const registry = yield* ForkWorkspaceRegistry.ForkWorkspaceRegistry;
    yield* registry.update({
      expectedRevision: 0,
      workspaces: [workspace("a")],
      defaultWorkspaceId: "a",
    });
    const stale = yield* registry.update({
      expectedRevision: 0,
      workspaces: [workspace("other")],
      defaultWorkspaceId: "other",
    });
    assert.isFalse(stale.applied);
    assert.strictEqual(stale.registry.revision, 1);
    assert.deepStrictEqual(
      stale.registry.workspaces.map((entry) => entry.id),
      ["a"],
    );
    const latest = yield* current;
    assert.strictEqual(latest._tag === "Some" ? latest.value.revision : -1, 1);
  }).pipe(Effect.provide(layer("t3-fork-workspaces-stale-"))),
);

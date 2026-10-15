import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicHooksPlugin, AtomicHooksPluginV2 } from "../plugins/atomic-hooks";

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Mirror of the CLI's `find_repository_root_from` acceptance for the
 * location directory itself: the graph database, or a pointer, must exist. */
function makeRepository(root: string) {
  mkdirSync(join(root, ".atomic"), { recursive: true });
  writeFileSync(join(root, ".atomic", "atomic.redb"), "");
}

const $ = (calls: any[]) => (strings: any[], ...values: any[]) => ({
  nothrow: async () => {
    calls.push({ verb: values[1], payload: JSON.parse(values[0]) });
    return { exitCode: 0, stderr: "" };
  },
});

async function v1Plugin(root: string, calls: any[]) {
  return await AtomicHooksPlugin({ directory: root, $: $(calls) } as any);
}

describe("opt-in gating (OpenCode v1 plugin)", () => {
  test("no Atomic repository: hooks register but never dispatch or spawn the CLI", async () => {
    const spawnSync = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
    const root = tempRoot("atomic-gate-v1-");
    const calls: any[] = [];
    const plugin: any = await v1Plugin(root, calls);
    expect(plugin.event).toBeDefined();
    expect(plugin["tool.execute.before"]).toBeDefined();
    const tool = { sessionID: "s1", callID: "t1", tool: "read" };
    await plugin["chat.message"](
      { sessionID: "s1", model: { modelID: "m", providerID: "p" } },
      { parts: [{ type: "text", text: "hello" }] },
    );
    await plugin["tool.execute.before"](tool, { args: {} });
    await plugin["tool.execute.after"](tool, { output: "ok" });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const env: any = {};
    await plugin["shell.env"]({}, { env });
    expect(calls).toHaveLength(0);
    expect(spawnSync.mock.calls.length).toBe(0);
    expect(env.ATOMIC_AGENT).toBeUndefined();
    expect(() =>
      mkdirSync(join(root, ".atomic")),
    ).not.toThrow(); // nothing was auto-created by the hooks
  });

  test("a bare .atomic directory (e.g. ~/.atomic global config) is not a repository", async () => {
    const spawnSync = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
    const root = tempRoot("atomic-gate-v1-bare-");
    mkdirSync(join(root, ".atomic"));
    const calls: any[] = [];
    const plugin: any = await v1Plugin(root, calls);
    const tool = { sessionID: "s1", callID: "t1", tool: "read" };
    await plugin["tool.execute.before"](tool, { args: {} });
    await plugin["tool.execute.after"](tool, { output: "ok" });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(calls).toHaveLength(0);
    expect(spawnSync.mock.calls.length).toBe(0);
  });

  test("linked-worktree pointer and sandbox pointer are repositories", async () => {
    spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
    const worktree = tempRoot("atomic-gate-v1-wt-");
    mkdirSync(join(worktree, ".atomic"));
    writeFileSync(join(worktree, ".atomic", "repository"), "/elsewhere/.atomic");
    const calls: any[] = [];
    const plugin: any = await v1Plugin(worktree, calls);
    await plugin["tool.execute.before"](
      { sessionID: "s", callID: "c", tool: "read" },
      { args: {} },
    );
    expect(calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);

    const sandbox = tempRoot("atomic-gate-v1-sbx-");
    writeFileSync(join(sandbox, ".atomic-sandbox"), "{}");
    const sandboxCalls: any[] = [];
    const sandboxPlugin: any = await v1Plugin(sandbox, sandboxCalls);
    await sandboxPlugin["tool.execute.before"](
      { sessionID: "s", callID: "c", tool: "read" },
      { args: {} },
    );
    expect(sandboxCalls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "before-tool",
    ]);
  });

  test("repository removed after setup: dispatch stops and tools never fail", async () => {
    const root = tempRoot("atomic-gate-v1-rm-");
    makeRepository(root);
    const calls: any[] = [];
    const plugin: any = await v1Plugin(root, calls);
    const tool = { sessionID: "s", callID: "c", tool: "read" };
    await plugin["tool.execute.before"](tool, { args: {} });
    expect(calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
    rmSync(join(root, ".atomic", "atomic.redb"));
    await plugin["tool.execute.after"](tool, { output: "ok" });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });
    expect(calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
  });

  test("repository created after setup: dispatch starts without a reload", async () => {
    const root = tempRoot("atomic-gate-v1-new-");
    const calls: any[] = [];
    const plugin: any = await v1Plugin(root, calls);
    const tool = { sessionID: "s", callID: "c", tool: "read" };
    await plugin["tool.execute.before"](tool, { args: {} });
    expect(calls).toHaveLength(0);
    makeRepository(root);
    await plugin["tool.execute.before"](tool, { args: {} });
    expect(calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
    const env: any = {};
    await plugin["shell.env"]({}, { env });
    expect(env.ATOMIC_AGENT).toBe("opencode");
  });
});

function eventBus() {
  const events: any[] = [];
  let notify: (() => void) | undefined;
  return {
    push(event: any) {
      events.push(event);
      const wake = notify;
      notify = undefined;
      wake?.();
    },
    async *stream({ signal }: any) {
      for (let i = 0; !signal?.aborted; ) {
        if (i < events.length) {
          yield events[i++];
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(cond()).toBe(true);
};

interface V2Options {
  sessionGet?: (sessionID: string) => any;
  dispatch?: (verb: string, payload: any) => Promise<{ exitCode: number; stderr: string }>;
  /** Use the plugin's real `spawnHook` instead of an injected invoke. */
  useRealSpawn?: boolean;
}

async function v2Plugin(root: string, opts: V2Options = {}) {
  const spawnSync = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
  const calls: any[] = [];
  const dispatch =
    opts.dispatch ?? (async (_verb: string, _payload: any) => ({ exitCode: 0, stderr: "" }));
  const invoke = async (json: string, verb: string) => {
    const payload = JSON.parse(json);
    calls.push({ verb, payload });
    return dispatch(verb, payload);
  };
  const hooks: Record<string, any> = {};
  const toolHooks: Record<string, any> = {};
  const bus = eventBus();
  const sessionGet =
    opts.sessionGet ??
    ((sessionID: string) => ({
      id: sessionID,
      model: { id: "m", providerID: "p" },
      location: { directory: root },
    }));
  const ctx: any = {
    location: { directory: root },
    session: {
      hook: async (name: string, cb: any) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      get: async ({ sessionID }: any) => sessionGet(sessionID),
    },
    tool: {
      hook: async (name: string, cb: any) => {
        toolHooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    shell: {
      hook: async (name: string, cb: any) => {
        (hooks as any)[`shell.${name}`] = cb;
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: (options: any) => bus.stream(options) },
  };
  const cleanup = await AtomicHooksPluginV2(
    ctx,
    opts.useRealSpawn ? undefined : invoke,
  );
  let eventId = 0;
  return {
    calls,
    root,
    bus,
    cleanup,
    hooks,
    toolHooks,
    spawnSync,
    event: (type: string, data: any, location?: any, created = 1000) =>
      bus.push({ id: `evt_${++eventId}`, type, data, location, created }),
  };
}

describe("opt-in gating (OpenCode v2 plugin)", () => {
  test("no Atomic repository: domain hooks register but never dispatch or spawn", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("must not spawn without a repository");
    });
    // useRealSpawn: any buggy dispatch would reach Bun.spawn and throw.
    const f = await v2Plugin(tempRoot("atomic-gate-v2-"), { useRealSpawn: true });
    expect(f.hooks.prompt).toBeDefined();
    expect(f.toolHooks["execute.before"]).toBeDefined();
    expect(f.hooks["shell.create.before"]).toBeDefined();
    await f.hooks.prompt({
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "hi" },
      delivery: "steer",
    });
    await f.toolHooks["execute.before"]({
      sessionID: "ses_1",
      tool: "read",
      id: "c1",
      input: {},
    });
    await f.toolHooks["execute.after"]({
      sessionID: "ses_1",
      tool: "read",
      id: "c1",
      input: {},
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    const env: any = {};
    f.hooks["shell.create.before"]({ env });
    expect(f.calls).toHaveLength(0);
    expect(f.spawnSync.mock.calls.length).toBe(0);
    expect(spawn.mock.calls.length).toBe(0);
    expect(env.ATOMIC_AGENT).toBeUndefined();
  });

  test("a bare .atomic directory is not a repository", async () => {
    const root = tempRoot("atomic-gate-v2-bare-");
    mkdirSync(join(root, ".atomic"));
    const f = await v2Plugin(root);
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "hi" }, delivery: "steer" });
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} });
    expect(f.calls).toHaveLength(0);
    expect(f.spawnSync.mock.calls.length).toBe(0);
  });

  test("repository created after setup: dispatch starts without a reload", async () => {
    const root = tempRoot("atomic-gate-v2-new-");
    const f = await v2Plugin(root);
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "hi" }, delivery: "steer" });
    expect(f.calls).toHaveLength(0);
    makeRepository(root);
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "hi again" }, delivery: "steer" });
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} });
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
  });

  test("foreign sessions are not recorded by this location's instance", async () => {
    const root = tempRoot("atomic-gate-v2-own-");
    makeRepository(root);
    const sessionGet = (sessionID: string) => ({
      id: sessionID,
      model: { id: "m", providerID: "p" },
      location: { directory: sessionID === "foreign" ? "/somewhere/else" : root },
    });
    const f = await v2Plugin(root, { sessionGet });
    // Foreign prompt admission (the plugin instance's own directory differs).
    await f.hooks.prompt({ sessionID: "foreign", prompt: { text: "x" }, delivery: "steer" });
    // Foreign tool calls — the case the event-stream filter cannot see.
    await f.toolHooks["execute.before"]({ sessionID: "foreign", tool: "read", id: "c1", input: {} });
    await f.toolHooks["execute.after"]({
      sessionID: "foreign",
      tool: "read",
      id: "c1",
      input: {},
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(f.calls).toHaveLength(0);
    // The session's own event stream (foreign location) must not record it
    // through this instance either.
    f.event("session.inbox.enqueued", { sessionID: "foreign" }, { directory: "/somewhere/else" });
    f.event("session.execution.started", { sessionID: "foreign" }, { directory: "/somewhere/else" });
    f.event("session.execution.succeeded", { sessionID: "foreign" }, { directory: "/somewhere/else" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.calls).toHaveLength(0);
  });

  test("a session move takes effect immediately (no prompt, no wait)", async () => {
    const root = tempRoot("atomic-gate-v2-move-");
    makeRepository(root);
    let moved = false;
    const sessionGet = (sessionID: string) => ({
      id: sessionID,
      model: { id: "m", providerID: "p" },
      location: { directory: moved ? "/somewhere/else" : root },
    });
    const f = await v2Plugin(root, { sessionGet });
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "first" }, delivery: "steer" });
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt"]);
    moved = true;
    // No new prompt, no TTL wait: the very next tool call must already be
    // refused — the fresh per-dispatch resolution is the authority.
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c2", input: {} });
    await f.toolHooks["execute.after"]({
      sessionID: "ses_1",
      tool: "read",
      id: "c2",
      input: {},
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt"]);
  });

  test("an unresolvable location after primed ownership dispatches nothing", async () => {
    const root = tempRoot("atomic-gate-v2-throw-");
    makeRepository(root);
    let failing = false;
    const sessionGet = (sessionID: string) => {
      if (failing) throw new Error("session lookup failed");
      return {
        id: sessionID,
        model: { id: "m", providerID: "p" },
        location: { directory: root },
      };
    };
    const f = await v2Plugin(root, { sessionGet });
    // Prime ownership with a successful, fully dispatched turn start.
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "first" }, delivery: "steer" });
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt"]);
    failing = true;
    // No fallback, no stale cache: every dispatch fails closed.
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} });
    f.event("session.execution.succeeded", { sessionID: "ses_1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt"]);
  });

  test("a move while an earlier queued callback is in flight stops followups", async () => {
    const root = tempRoot("atomic-gate-v2-queue-");
    makeRepository(root);
    let moved = false;
    const sessionGet = (sessionID: string) => ({
      id: sessionID,
      model: { id: "m", providerID: "p" },
      location: { directory: moved ? "/somewhere/else" : root },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await v2Plugin(root, {
      sessionGet,
      dispatch: async (verb) => {
        if (verb === "before-tool") await gate;
        return { exitCode: 0, stderr: "" };
      },
    });
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "first" }, delivery: "steer" });
    // The before-tool dispatch blocks while the session is still owned.
    const before = f.toolHooks["execute.before"]({
      sessionID: "ses_1",
      tool: "read",
      id: "c1",
      input: {},
    });
    await until(() => f.calls.some((c) => c.verb === "before-tool"));
    // Move away while the callback (and its CLI invocation) is in flight,
    // then queue the followup tool event behind it.
    moved = true;
    const after = f.toolHooks["execute.after"]({
      sessionID: "ses_1",
      tool: "read",
      id: "c1",
      input: {},
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    f.event("session.execution.succeeded", { sessionID: "ses_1" });
    release();
    await Promise.all([before, after]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The in-flight before-tool completed (it started while owned); the
    // after-tool and the stop were queued after the move and must have been
    // refused by the invocation-time re-authorization.
    expect(f.calls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "before-tool",
    ]);
  });

  test("a stale known set never authorizes dispatches after a move", async () => {
    const root = tempRoot("atomic-gate-v2-stale-");
    makeRepository(root);
    let moved = false;
    const sessionGet = (sessionID: string) => ({
      id: sessionID,
      model: { id: "m", providerID: "p" },
      location: { directory: moved ? "/somewhere/else" : root },
    });
    const f = await v2Plugin(root, { sessionGet });
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "first" }, delivery: "steer" });
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} });
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
    moved = true;
    // A turn-end event without a location field: the stale `known` set may
    // queue it, but the stop dispatch itself must re-authorize and refuse.
    f.event("session.execution.succeeded", { sessionID: "ses_1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.calls.map((c) => c.verb)).toEqual(["session-start", "user-prompt", "before-tool"]);
  });

  test("an unresolvable session location is never dispatched", async () => {
    const root = tempRoot("atomic-gate-v2-unknown-");
    makeRepository(root);
    const f = await v2Plugin(root, {
      sessionGet: () => {
        throw new Error("session lookup failed");
      },
    });
    await f.hooks.prompt({ sessionID: "ses_1", prompt: { text: "x" }, delivery: "steer" });
    await f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} });
    expect(f.calls).toHaveLength(0);
  });

  test("spawn failures resolve (never hang) and surface as hook errors", async () => {
    const root = tempRoot("atomic-gate-v2-spawn-");
    makeRepository(root);
    // No injected invoke: the real spawnHook path runs, but the process
    // cannot spawn at all (e.g. the atomic binary vanished mid-session).
    // The dispatcher must resolve — never hang — and surface the failure.
    spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const f = await v2Plugin(root, { useRealSpawn: true });
    await expect(
      f.toolHooks["execute.before"]({ sessionID: "ses_1", tool: "read", id: "c1", input: {} }),
    ).rejects.toThrow(/exit 127/);
  });
});

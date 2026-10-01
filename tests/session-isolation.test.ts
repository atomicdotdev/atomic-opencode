import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicHooksPlugin, AtomicHooksPluginV2 } from "../plugins/atomic-hooks";
import pluginDefault from "../plugins/atomic-hooks";

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
async function fixture(
  dispatch = async (_verb, _payload) => ({ exitCode: 0, stderr: "" }),
) {
  spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
  const root = mkdtempSync(join(tmpdir(), "atomic-plugin-test-"));
  roots.push(root);
  mkdirSync(join(root, ".atomic"));
  const calls: any[] = [];
  const $ = (strings, ...values) => ({
    nothrow: async () => {
      const payload = JSON.parse(values[0]),
        verb = values[1];
      calls.push({
        verb,
        payload,
        foreground: strings.join("").includes("--foreground"),
      });
      return dispatch(verb, payload);
    },
  });
  const plugin: any = await AtomicHooksPlugin({ directory: root, $ });
  return {
    plugin,
    calls,
    root,
    event: (type, properties) => plugin.event({ event: { type, properties } }),
    prompt: (sid) =>
      plugin["chat.message"](
        {
          sessionID: sid,
          model: { modelID: sid + "-model", providerID: sid + "-provider" },
        },
        { parts: [{ type: "text", text: sid + " prompt" }] },
      ),
  };
}

describe("concurrent Atomic sessions", () => {
  for (const scenario of ["existing edits", "handoff after a recorded turn"]) {
    test(`${scenario} do not block later bash commands or Stop`, async () => {
      let file: string;
      let recorded = "baseline\n";
      // Model the CLI snapshot/record boundary so this also exercises the old
      // ownership implementation when checking that the regression test fails.
      const f = await fixture(async (verb) => {
        if (verb === "file-snapshot") {
          const contents = readFileSync(file, "utf8");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              scope_version: 1,
              view: "draft",
              files: { "work.txt": contents },
              dirty: contents === recorded ? [] : ["work.txt"],
            }),
          };
        }
        if (verb === "stop") recorded = readFileSync(file, "utf8");
        return { exitCode: 0, stderr: "" };
      });
      file = join(f.root, "work.txt");
      writeFileSync(file, scenario === "existing edits" ? "human draft\n" : recorded);
      const ids = scenario === "existing edits" ? ["a"] : ["a", "b"];
      for (const sid of ids) {
        const edit = { sessionID: sid, callID: "edit", tool: "edit" };
        await f.plugin["tool.execute.before"](edit, { args: { filePath: file } });
        const contents = readFileSync(file, "utf8") + sid + " edit\n";
        writeFileSync(file, contents);
        await f.plugin["tool.execute.after"](edit, { output: "edited" });
        for (const command of ["atomic status", "echo OK"]) {
          const tool = { sessionID: sid, callID: command, tool: "bash" };
          await f.plugin["tool.execute.before"](tool, { args: { command } });
          await f.plugin["tool.execute.after"](tool, { output: "OK" });
        }
        await f.event("session.idle", { sessionID: sid });
        expect(recorded).toBe(contents);
        expect(f.calls.filter((c) => c.verb === "stop" && c.payload.session_id === sid)).toHaveLength(1);
      }
      expect(f.calls.some((c) => c.verb === "file-snapshot")).toBe(false);
    });
  }

  test("resuming after a tool started still activates its turn", async () => {
    const f = await fixture();
    await f.plugin["tool.execute.after"](
      { sessionID: "resumed", callID: "already-running", tool: "read" },
      { output: "finished" },
    );
    await f.event("session.idle", { sessionID: "resumed" });
    expect(f.calls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "after-tool",
      "stop",
    ]);
  });

  test("programmatic tool turns activate the CLI without chat.message", async () => {
    const f = await fixture();
    for (const sid of ["parent", "child"]) {
      for (let turn = 0; turn < 2; turn++) {
        await f.plugin["tool.execute.before"](
          { sessionID: sid, callID: `${sid}-${turn}`, tool: "read" },
          { args: { filePath: "source.ts" } },
        );
        await f.event("session.idle", { sessionID: sid });
        await f.event("session.idle", { sessionID: sid });
      }
      expect(
        f.calls.filter((c) => c.payload.session_id === sid).map((c) => c.verb),
      ).toEqual([
        "session-start",
        "user-prompt",
        "before-tool",
        "stop",
        "user-prompt",
        "before-tool",
        "stop",
      ]);
    }
  });

  test("model steps activate read-only turns and ignore completed step snapshots", async () => {
    const f = await fixture();
    for (let turn = 0; turn < 2; turn++) {
      const step = {
        sessionID: "resumed",
        id: `step-${turn}`,
        type: "step-start",
      };
      // Metadata can arrive before the first step; activation must retain it.
      await f.event("message.updated", {
        info: { sessionID: "resumed", id: `answer-${turn}`, role: "assistant" },
      });
      await f.event("message.part.updated", { part: step });
      await f.event("message.part.updated", { part: step });
      await f.event("message.part.updated", {
        part: {
          sessionID: "resumed",
          id: `text-${turn}`,
          type: "text",
          messageID: `answer-${turn}`,
          text: `Answer ${turn}`,
        },
      });
      await f.event("session.idle", { sessionID: "resumed" });
      await f.event("message.part.updated", { part: step });
      await f.event("session.idle", { sessionID: "resumed" });
    }
    expect(f.calls.filter((c) => c.verb === "user-prompt")).toHaveLength(2);
    expect(
      f.calls.filter((c) => c.verb === "stop").map((c) => c.payload.response),
    ).toEqual(["Answer 0", "Answer 1"]);
  });

  test("late chat.message and multiple steps do not restart an active turn", async () => {
    const f = await fixture();
    await f.event("message.part.updated", {
      part: { sessionID: "s", id: "first", type: "step-start" },
    });
    await f.event("message.part.updated", {
      part: {
        sessionID: "s",
        id: "reason",
        type: "reasoning",
        text: "keep this",
      },
    });
    await f.prompt("s");
    await f.event("message.part.updated", {
      part: { sessionID: "s", id: "second", type: "step-start" },
    });
    await f.event("session.idle", { sessionID: "s" });
    expect(f.calls.filter((c) => c.verb === "user-prompt")).toHaveLength(1);
    expect(f.calls.at(-1).payload).toMatchObject({
      step_count: 2,
      reasoning_blocks: [{ text: "keep this" }],
    });
  });

  test("failed activation blocks a tool and can be retried", async () => {
    let fail = true;
    const f = await fixture(async (verb) => {
      if (verb === "user-prompt" && fail)
        return { exitCode: 1, stderr: "start unavailable" };
      return { exitCode: 0, stderr: "" };
    });
    const tool = { sessionID: "s", callID: "read-1", tool: "read" };
    await expect(
      f.plugin["tool.execute.before"](tool, { args: {} }),
    ).rejects.toThrow("start unavailable");
    expect(f.calls.some((c) => c.verb === "before-tool")).toBe(false);
    await f.event("session.idle", { sessionID: "s" });
    expect(f.calls.some((c) => c.verb === "stop")).toBe(false);
    fail = false;
    await f.plugin["tool.execute.before"](tool, { args: {} });
    await f.event("session.idle", { sessionID: "s" });
    expect(f.calls.filter((c) => c.verb === "before-tool")).toHaveLength(1);
    expect(f.calls.filter((c) => c.verb === "stop")).toHaveLength(1);
  });

  test("interleaved parent/children keep tools, models, telemetry and Stops separate", async () => {
    const f = await fixture();
    const ids = ["parent", "child-a", "child-b"];
    for (const sid of ids) {
      await f.event("session.created", { info: { id: sid } });
      await f.prompt(sid);
      await f.plugin["tool.execute.before"](
        { sessionID: sid, callID: "same-call", tool: "read" },
        { args: { filePath: sid + ".txt" } },
      );
      await f.event("message.updated", {
        info: { sessionID: sid, id: "same-message", role: "assistant" },
      });
      for (const part of [
        {
          id: "reason",
          type: "reasoning",
          text: sid + " reasoning",
          time: { start: 5, end: 15 },
        },
        {
          id: "answer",
          type: "text",
          text: sid + " answer",
          messageID: "same-message",
        },
        { id: "step", type: "step-start" },
        {
          id: "finish",
          type: "step-finish",
          tokens: { input: ids.indexOf(sid) + 1 },
          cost: 0.1,
        },
      ])
        await f.event("message.part.updated", {
          part: { ...part, sessionID: sid },
        });
    }
    await Promise.all(
      ids.map(async (sid) => {
        await f.plugin["tool.execute.after"](
          { sessionID: sid, callID: "same-call", tool: "read" },
          { output: sid + " output", metadata: { exit: 0 } },
        );
        await f.event("session.idle", { sessionID: sid });
      }),
    );
    for (const sid of ids) {
      const own = f.calls.filter((x) => x.payload.session_id === sid);
      expect(own.map((x) => x.verb)).toEqual([
        "session-start",
        "user-prompt",
        "before-tool",
        "after-tool",
        "stop",
      ]);
      expect(own[0].payload.workspace_session_id).toBeUndefined();
      expect(own[0].payload.recording_scope).toBeUndefined();
      expect(own[4].payload.record_files).toBeUndefined();
      expect(own[3].payload).toMatchObject({
        tool_input: { filePath: sid + ".txt" },
        tool_output: sid + " output",
      });
      expect(own[4].payload).toMatchObject({
        turn_number: 1,
        model: sid + "-model",
        provider: sid + "-provider",
        input_tokens: ids.indexOf(sid) + 1,
        response: sid + " answer",
        reasoning_blocks: [{ text: sid + " reasoning", duration_ms: 10 }],
      });
    }
    expect(f.calls.every((c) => c.foreground)).toBe(true);
  });

  test("same-session callbacks await start while another session makes progress", async () => {
    let release!: () => void;
    let entered!: () => void;
    const startingSlow = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (verb, payload) => {
      if (verb === "session-start" && payload.session_id === "slow") {
        entered();
        await gate;
      }
      return { exitCode: 0, stderr: "" };
    });
    await f.prompt("fast");
    const starting = f.event("session.created", { sessionID: "slow" });
    const prompt = f.prompt("slow");
    await startingSlow;
    await f.plugin["tool.execute.before"](
      { sessionID: "fast", callID: "read", tool: "read" },
      { args: {} },
    );
    expect(
      f.calls.filter((c) => c.payload.session_id === "slow").map((c) => c.verb),
    ).toEqual(["session-start"]);
    expect(
      f.calls.some(
        (c) => c.payload.session_id === "fast" && c.verb === "before-tool",
      ),
    ).toBe(true);
    release();
    await Promise.all([starting, prompt]);
    expect(
      f.calls.filter((c) => c.payload.session_id === "slow").map((c) => c.verb),
    ).toEqual(["session-start", "user-prompt"]);
  });

  test("missing startup is healed once; duplicate idle and malformed events do not borrow a session", async () => {
    const f = await fixture();
    await f.prompt("parent");
    await f.event("session.created", { info: { id: "parent" } });
    await f.event("session.idle", {});
    await f.event("message.part.updated", {
      part: { type: "reasoning", id: "bad", text: "wrong" },
    });
    await f.event("session.idle", { sessionID: "parent" });
    await f.event("session.idle", { sessionID: "parent" });
    expect(f.calls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "stop",
    ]);
    expect(f.calls[2].payload.reasoning_blocks).toBeUndefined();
    await f.prompt("parent");
    await f.event("session.idle", { sessionID: "parent" });
    expect(f.calls.at(-1).payload.turn_number).toBe(2);
  });

  test("failed Stop retains its snapshot for retry and does not block other sessions", async () => {
    let fail = true;
    const f = await fixture(async (verb) => {
      if (verb === "stop" && fail) {
        fail = false;
        return { exitCode: 1, stderr: "owner unavailable" };
      }
      return { exitCode: 0, stderr: "" };
    });
    await f.prompt("a");
    await f.event("message.part.updated", {
      part: { sessionID: "a", id: "r", type: "reasoning", text: "keep" },
    });
    await f.event("session.idle", { sessionID: "a" });
    await f.prompt("b");
    await f.event("session.idle", { sessionID: "b" });
    await f.event("session.idle", { sessionID: "a" });
    const stops = f.calls.filter(
      (c) => c.verb === "stop" && c.payload.session_id === "a",
    );
    expect(stops.map((c) => c.payload.turn_number)).toEqual([1, 1]);
    expect(stops[1].payload.reasoning_blocks).toEqual([{ text: "keep" }]);
    expect(
      readFileSync(join(f.root, ".atomic/hook-errors.log"), "utf8"),
    ).toContain("owner unavailable");
  });

  test("part snapshots are not double-counted and deletion only clears its own session", async () => {
    const f = await fixture();
    await f.prompt("parent");
    await f.prompt("child");
    for (const tokens of [3, 8]) {
      await f.event("message.part.updated", {
        part: { sessionID: "parent", id: "s", type: "step-start" },
      });
      await f.event("message.part.updated", {
        part: {
          sessionID: "parent",
          id: "f",
          type: "step-finish",
          tokens: { input: tokens },
        },
      });
    }
    await f.event("message.part.updated", {
      part: { sessionID: "parent", id: "r", type: "reasoning", text: "parent" },
    });
    await f.event("message.part.updated", {
      part: { sessionID: "child", id: "r", type: "reasoning", text: "child" },
    });
    await f.event("message.part.removed", { sessionID: "child", partID: "r" });
    await f.event("session.deleted", { info: { id: "child" } });
    await f.event("session.idle", { sessionID: "parent" });
    expect(f.calls.at(-1).payload).toMatchObject({
      session_id: "parent",
      input_tokens: 8,
      step_count: 1,
      reasoning_blocks: [{ text: "parent" }],
    });
    expect(
      f.calls.find((c) => c.verb === "session-end").payload.session_id,
    ).toBe("child");
  });
});

describe("OpenCode v2 plugin", () => {
  const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cond()).toBe(true);
  };

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

  async function fixtureV2(
    dispatch = async (_verb: string, _payload: any) => ({ exitCode: 0, stderr: "" }),
  ) {
    spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as any);
    const root = mkdtempSync(join(tmpdir(), "atomic-plugin-v2-test-"));
    roots.push(root);
    mkdirSync(join(root, ".atomic"));
    const calls: any[] = [];
    const invoke = async (json: string, verb: string) => {
      const payload = JSON.parse(json);
      calls.push({ verb, payload });
      return dispatch(verb, payload);
    };
    const hooks: Record<string, any> = {};
    const toolHooks: Record<string, any> = {};
    const shell: any[] = [];
    const bus = eventBus();
    const ctx: any = {
      location: { directory: root },
      session: {
        hook: async (name: string, cb: any) => {
          hooks[name] = cb;
          return { dispose: async () => {} };
        },
        get: async () => ({
          model: { id: "selected-model", providerID: "selected-provider" },
        }),
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
    const cleanup = await AtomicHooksPluginV2(ctx, invoke);
    let eventId = 0;
    return {
      calls,
      root,
      bus,
      cleanup,
      hooks,
      toolHooks,
      prompt: (text: string, sid = "ses_1") =>
        hooks.prompt({
          sessionID: sid,
          messageID: "msg_1",
          prompt: { text },
          delivery: "steer",
        }),
      event: (type: string, data: any, location?: any, created = 1000) =>
        bus.push({
          id: `evt_${++eventId}`,
          type,
          data,
          location,
          created,
        }),
    };
  }

  test("dual entrypoint exports v1 server and v2 setup", () => {
    expect(pluginDefault.id).toBe("atomic-hooks");
    expect(pluginDefault.server).toBe(AtomicHooksPlugin);
    expect(typeof pluginDefault.setup).toBe("function");
  });

  test("records a full v2 turn with tools, reasoning, tokens and response", async () => {
    const f = await fixtureV2();
    await f.prompt("Create HELLO.md with hello");
    f.event("session.inbox.enqueued", { sessionID: "ses_1" }, { directory: f.root });
    f.event("session.execution.started", { sessionID: "ses_1" });
    f.event(
      "session.step.started",
      {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        model: { id: "longcat", providerID: "opencode" },
      },
      { directory: f.root },
    );
    f.event(
      "session.reasoning.started",
      { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
      { directory: f.root },
      2000,
    );
    f.event(
      "session.reasoning.ended",
      { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: " think" },
      { directory: f.root },
      3000,
    );
    await f.toolHooks["execute.before"]({
      sessionID: "ses_1",
      tool: "write",
      id: "call_1",
      input: { filePath: "HELLO.md", content: "hello" },
    });
    await f.toolHooks["execute.after"]({
      sessionID: "ses_1",
      tool: "write",
      id: "call_1",
      input: { filePath: "HELLO.md" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "Created file successfully" }],
        metadata: { exit: 0 },
      },
    });
    f.event(
      "session.step.ended",
      {
        sessionID: "ses_1",
        finish: "tool-calls",
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } },
      },
      { directory: f.root },
    );
    f.event(
      "session.step.started",
      { sessionID: "ses_1", assistantMessageID: "msg_b", model: { id: "longcat", providerID: "opencode" } },
      { directory: f.root },
    );
    f.event(
      "session.text.ended",
      { sessionID: "ses_1", assistantMessageID: "msg_b", ordinal: 0, text: "Created HELLO.md" },
      { directory: f.root },
    );
    f.event(
      "session.step.ended",
      { sessionID: "ses_1", finish: "stop", cost: 0.2, tokens: { input: 20, output: 4, reasoning: 1, cache: { read: 0, write: 0 } } },
      { directory: f.root },
    );
    f.event("session.execution.succeeded", { sessionID: "ses_1" });
    await until(() => f.calls.some((c) => c.verb === "stop"));
    expect(f.calls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "before-tool",
      "after-tool",
      "stop",
    ]);
    expect(f.calls[1].payload).toMatchObject({
      prompt: "Create HELLO.md with hello",
      model: "selected-model",
      provider: "selected-provider",
    });
    expect(f.calls[3].payload).toMatchObject({
      tool_name: "write",
      tool_output: "Created file successfully",
      exit_code: 0,
      file_path: "HELLO.md",
      status: "completed",
    });
    expect(f.calls[4].payload).toMatchObject({
      model: "longcat",
      provider: "opencode",
      input_tokens: 30,
      output_tokens: 9,
      reasoning_tokens: 3,
      cache_read_tokens: 7,
      cache_write_tokens: 3,
      finish_reason: "stop",
      step_count: 2,
      response: "Created HELLO.md",
      reasoning_blocks: [{ text: "think", duration_ms: 1000 }],
    });
  });

  test("tool-only v2 turns activate and stop without a prompt hook", async () => {
    const f = await fixtureV2();
    f.event("session.inbox.enqueued", { sessionID: "ses_t" }, { directory: f.root });
    await f.toolHooks["execute.after"]({
      sessionID: "ses_t",
      tool: "bash",
      id: "call_9",
      input: { command: "ls" },
      status: "error",
      error: { message: "command failed" },
    });
    f.event("session.execution.succeeded", { sessionID: "ses_t" });
    await until(() => f.calls.some((c) => c.verb === "stop"));
    expect(f.calls.map((c) => c.verb)).toEqual([
      "session-start",
      "user-prompt",
      "after-tool",
      "stop",
    ]);
    expect(f.calls[2].payload).toMatchObject({
      tool_output: "command failed",
      status: "error",
    });
  });

  test("sessions from other locations are never recorded", async () => {
    const f = await fixtureV2();
    const foreign = { directory: "/somewhere/else" };
    f.event("session.inbox.enqueued", { sessionID: "ses_far" }, foreign);
    f.event("session.step.started", { sessionID: "ses_far", assistantMessageID: "m", model: { id: "x", providerID: "y" } }, foreign);
    f.event("session.execution.succeeded", { sessionID: "ses_far" });
    f.event("session.step.started", { sessionID: "ses_far", assistantMessageID: "m" }, undefined);
    f.event("session.execution.succeeded", { sessionID: "ses_far" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.calls).toHaveLength(0);
  });

  test("registers shell env and stops duplicate turn boundaries safely", async () => {
    const f = await fixtureV2();
    const env: any = {};
    f.hooks["shell.create.before"]({ command: "atomic status", cwd: f.root, env });
    expect(env).toMatchObject({
      ATOMIC_AGENT: "opencode",
      ATOMIC_AGENT_VERSION: "1.3.0",
    });
    f.event("session.inbox.enqueued", { sessionID: "ses_d" }, { directory: f.root });
    await f.prompt("hi", "ses_d");
    f.event("session.status", { sessionID: "ses_d", status: { type: "idle" } }, { directory: f.root });
    await until(() => f.calls.some((c) => c.verb === "stop"));
    f.event("session.execution.succeeded", { sessionID: "ses_d" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.calls.filter((c) => c.verb === "stop")).toHaveLength(1);
    f.bus.push({
      id: "evt_del",
      type: "session.deleted",
      data: { sessionID: "ses_d" },
      location: { directory: f.root },
    });
    await until(() => f.calls.some((c) => c.verb === "session-end"));
    await f.cleanup?.();
  });
});

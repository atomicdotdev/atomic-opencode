import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicHooksPlugin } from "../plugins/atomic-hooks";

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
      if (verb === "file-snapshot")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            scope_version: 1,
            view: "test",
            files: {},
            dirty: [],
          }),
        };
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
      expect(own[0].payload.workspace_session_id).toBe(
        sid === "parent" ? undefined : "parent",
      );
      expect(own[0].payload.recording_scope).toBe("explicit-files-v1");
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
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (verb, payload) => {
      if (verb === "session-start" && payload.session_id === "slow") await gate;
      return { exitCode: 0, stderr: "" };
    });
    await f.prompt("fast");
    const starting = f.event("session.created", { sessionID: "slow" });
    const prompt = f.prompt("slow");
    await f.prompt("fast");
    expect(
      f.calls.filter((c) => c.payload.session_id === "slow").map((c) => c.verb),
    ).toEqual(["session-start"]);
    expect(
      f.calls.some(
        (c) => c.payload.session_id === "fast" && c.verb === "user-prompt",
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

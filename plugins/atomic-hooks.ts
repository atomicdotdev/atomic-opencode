import { appendFileSync } from "node:fs";
import { FileOwnership, mayMutate } from "./lib/file-ownership";

/** Atomic lifecycle and provenance hooks, isolated and ordered per session. */
export const AtomicHooksPlugin = async ({ directory, $ }) => {
  try {
    if (
      Bun.spawnSync(["atomic", "--version"], { stdout: "pipe", stderr: "pipe" })
        .exitCode !== 0
    )
      return {};
    if (
      Bun.spawnSync(["test", "-d", `${directory}/.atomic`], {
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode !== 0
    )
      return {};
  } catch {
    return {};
  }

  const ownership = new FileOwnership(async (paths) => {
    const result = await hook("", "file-snapshot", { paths });
    return JSON.parse(String(result.stdout));
  });
  let workspaceSession: string | undefined;
  const sessions = new Map();
  function stateFor(sid) {
    if (!sessions.has(sid))
      sessions.set(sid, {
        tail: Promise.resolve(),
        started: false,
        closed: false,
        active: false,
        model: null,
        provider: null,
        turns: 0,
        turnStartTime: null,
        tools: new Map(),
        reasoning: new Map(),
        text: new Map(),
        assistants: new Set(),
        steps: new Set(),
        completedSteps: new Set(),
        finishes: new Map(),
      });
    return sessions.get(sid);
  }
  function logFailure(sid, verb, message) {
    try {
      appendFileSync(
        `${directory}/.atomic/hook-errors.log`,
        `${new Date().toISOString()} ${sid} ${verb} ${message}\n`,
      );
    } catch {}
  }
  async function hook(sid, verb, payload = {}) {
    const json = JSON.stringify({
      ...payload,
      session_id: sid,
      cwd: directory,
      timestamp: new Date().toISOString(),
    });
    // Wait for the operation itself, not merely its background launcher.
    const result =
      await $`echo ${json} | atomic agent hooks opencode ${verb} --foreground`.nothrow();
    if (result.exitCode !== 0)
      throw new Error(
        `exit ${result.exitCode}: ${String(result.stderr).trim()}`,
      );
    return result;
  }
  // Events can arrive while an earlier callback awaits I/O. Only callbacks
  // belonging to the same session wait on one another.
  function enqueue(sid, operation, callback, strict = false) {
    if (typeof sid !== "string" || !sid) return Promise.resolve();
    const state = stateFor(sid);
    const next = state.tail.then(async () => {
      if (!state.closed) await callback(state);
    });
    state.tail = next.catch((error) =>
      logFailure(sid, operation, String(error)),
    );
    return strict ? next : state.tail;
  }
  async function start(sid, state) {
    if (!state.started) {
      await ownership.exclusive(async () => {
        await ownership.check();
        await hook(sid, "session-start", {
          source: "startup",
          recording_scope: "explicit-files-v1",
          workspace_session_id: workspaceSession,
        });
        workspaceSession ??= sid;
      });
      state.started = true;
    }
  }
  async function beginTurn(sid, state, payload = {}) {
    await start(sid, state);
    if (state.active) return;
    // Programmatic/subagent and resumed turns need not emit chat.message.
    // A tool or model step must activate the CLI turn before it can end.
    // Do not claim activation until the foreground hook has succeeded.
    await hook(sid, "user-prompt", {
      model: state.model,
      provider: state.provider,
      ...payload,
    });
    state.active = true;
    state.turnStartTime = Date.now();
  }
  function reset(state) {
    state.reasoning.clear();
    state.text.clear();
    state.assistants.clear();
    state.steps.clear();
    state.finishes.clear();
    state.tools.clear();
    state.turnStartTime = null;
  }
  return {
    event: async ({ event }) => {
      const props = event.properties ?? {};
      if (event.type === "session.created") {
        const sid = props.sessionID ?? props.info?.id;
        return enqueue(sid, event.type, (state) => start(sid, state));
      }
      if (event.type === "message.updated") {
        const info = props.info;
        return enqueue(info?.sessionID, event.type, (state) => {
          if (info.role === "assistant" && info.id) {
            state.assistants.add(info.id);
            if (info.modelID) state.model = info.modelID;
            if (info.providerID) state.provider = info.providerID;
          }
        });
      }
      if (event.type === "message.part.updated") {
        const part = props.part;
        return enqueue(part?.sessionID, event.type, async (state) => {
          if (part.type === "tool" && part.state?.status === "error") {
            return ownership.finish(part.sessionID, part.callID);
          }
          if (part.type === "reasoning") {
            state.reasoning.set(part.id, {
              text: part.text ?? "",
              start: part.time?.start,
              end: part.time?.end,
            });
          } else if (part.type === "text") {
            if (state.assistants.has(part.messageID))
              state.text.set(part.id, part.text ?? "");
          } else if (part.type === "step-start") {
            // OpenCode can resend the last step snapshot after idle.
            if (state.completedSteps.has(part.id)) return;
            await beginTurn(part.sessionID, state);
            state.steps.add(part.id);
          } else if (part.type === "step-finish") {
            // Updates are snapshots, not incremental token deltas.
            state.finishes.set(part.id, part);
          }
        });
      }
      if (event.type === "message.part.removed") {
        return enqueue(props.sessionID, event.type, (state) => {
          state.reasoning.delete(props.partID);
          state.text.delete(props.partID);
          state.steps.delete(props.partID);
          state.finishes.delete(props.partID);
        });
      }
      if (event.type === "session.idle") {
        const sid = props.sessionID;
        return enqueue(sid, event.type, async (state) => {
          if (!state.active) return;
          await start(sid, state);
          const reasoning_blocks = [...state.reasoning.values()]
            .map((b) => ({
              text: (b.text || "").trim(),
              duration_ms:
                b.start != null && b.end != null
                  ? Math.max(0, b.end - b.start)
                  : undefined,
            }))
            .filter((b) => b.text.length > 0);
          const response = [...state.text.values()]
            .map((t) => t.trim())
            .filter(Boolean)
            .pop();
          const totals = {
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: 0,
            finish_reason: undefined,
          };
          for (const part of state.finishes.values()) {
            const t = part.tokens ?? {};
            totals.input_tokens += t.input ?? 0;
            totals.output_tokens += t.output ?? 0;
            totals.reasoning_tokens += t.reasoning ?? 0;
            totals.cache_read_tokens += t.cache?.read ?? 0;
            totals.cache_write_tokens += t.cache?.write ?? 0;
            totals.cost_usd += part.cost ?? 0;
            if (part.reason) totals.finish_reason = part.reason;
          }
          await ownership.finishSession(sid);
          const turn = state.turns + 1;
          await ownership.exclusive(async () => {
            await hook(sid, "stop", {
              record_files: ownership.manifest(sid),
              turn_number: turn,
              model: state.model,
              provider: state.provider,
              turn_duration_ms:
                state.turnStartTime != null
                  ? Date.now() - state.turnStartTime
                  : undefined,
              reasoning_blocks: reasoning_blocks.length
                ? reasoning_blocks
                : undefined,
              response,
              ...(state.steps.size
                ? {
                    ...totals,
                    cost_usd: totals.cost_usd || undefined,
                    step_count: state.steps.size,
                  }
                : {}),
            });
            ownership.published(sid);
          });
          state.turns = turn;
          state.active = false;
          state.completedSteps = new Set(state.steps);
          reset(state);
        });
      }
      if (event.type === "session.deleted") {
        const sid = props.sessionID ?? props.info?.id;
        return enqueue(sid, event.type, async (state) => {
          await ownership.finishSession(sid);
          if (state.started)
            await ownership.exclusive(async () => {
              await hook(sid, "session-end", {
                reason: "deleted",
                record_files: ownership.manifest(sid),
              });
            });
          state.closed = true;
          reset(state);
          sessions.delete(sid);
        });
      }
    },
    "chat.message": async (input, output) => {
      const sid = input.sessionID;
      return enqueue(sid, "chat.message", async (state) => {
        if (input.model) {
          state.model = input.model.modelID;
          state.provider = input.model.providerID;
        }
        const prompt = output.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        await beginTurn(sid, state, {
          prompt: prompt || undefined,
          model: state.model,
          provider: state.provider,
        });
      });
    },
    "tool.execute.before": async (input, output) => {
      const sid = input.sessionID;
      return enqueue(
        sid,
        "before-tool",
        async (state) => {
          await beginTurn(sid, state);
          if (mayMutate(input.tool)) await ownership.begin(sid, input.callID);
          const args = output.args || {};
          state.tools.set(input.callID, { start: Date.now(), args });
          try {
            await hook(sid, "before-tool", {
              tool_name: input.tool,
              tool_call_id: input.callID,
              tool_input: args,
            });
          } catch (error) {
            await ownership.finish(sid, input.callID);
            throw error;
          }
        },
        true,
      );
    },
    "tool.execute.after": async (input, output) => {
      const sid = input.sessionID;
      return enqueue(sid, "after-tool", async (state) => {
        await beginTurn(sid, state);
        await ownership.finish(sid, input.callID);
        const saved = state.tools.get(input.callID),
          args = saved?.args || {};
        const raw = output.output;
        const toolOutput =
          typeof raw === "string"
            ? raw.length > 2048
              ? raw.slice(0, 2048) + "…"
              : raw
            : undefined;
        const exit = output.metadata?.exit;
        await hook(sid, "after-tool", {
          tool_name: input.tool,
          tool_call_id: input.callID,
          tool_input: args,
          tool_output: toolOutput,
          title: output.title,
          file_path: args.filePath || args.path,
          exit_code: typeof exit === "number" ? exit : undefined,
          status: "completed",
          duration: saved ? Date.now() - saved.start : undefined,
        });
        state.tools.delete(input.callID);
      });
    },
    "shell.env": async (_input, output) => {
      output.env.ATOMIC_AGENT = "opencode";
      output.env.ATOMIC_AGENT_VERSION = "1.3.0";
    },
  };
};

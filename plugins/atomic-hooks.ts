import { appendFileSync, statSync } from "node:fs";

/** Atomic lifecycle and provenance hooks, isolated and ordered per session. */

const ATOMIC_AGENT_VERSION = "1.3.0";

/**
 * Whether `directory` is an Atomic repository root, mirroring the CLI's
 * `find_repository_root_from`: a bare `.atomic/` directory (e.g. `~/.atomic`
 * holding only global configuration) is not a repository, so the graph
 * database — or a linked-worktree/sandbox pointer — must be present.
 * Filesystem-only, so it can be re-checked before every dispatch.
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function repositoryAt(directory) {
  const dot = `${directory}/.atomic`;
  if (isDirectory(dot)) {
    // Linked worktrees keep a pointer to the common Atomic directory.
    if (isFile(`${dot}/repository`)) return true;
    // Canonical repository database (current and legacy layouts).
    if (isFile(`${dot}/atomic.redb`)) return true;
    if (isFile(`${dot}/pristine.redb`)) return true;
  }
  // A sandbox working tree points at the canonical repository.
  return isFile(`${directory}/.atomic-sandbox`);
}

/** Memoized `atomic --version` probe; only reached once a repository exists. */
let cliAvailableResult;
function cliAvailable() {
  if (cliAvailableResult === undefined) {
    try {
      cliAvailableResult =
        Bun.spawnSync(["atomic", "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        }).exitCode === 0;
    } catch {
      cliAvailableResult = false;
    }
  }
  return cliAvailableResult;
}

function atomicEnabled(directory) {
  // Probe the filesystem first: no repository means no CLI spawn at all.
  return repositoryAt(directory) && cliAvailable();
}

/**
 * Per-directory turn tracker shared by the OpenCode v1 and v2 plugin APIs.
 * `invoke` runs one foreground `atomic agent hooks` command and resolves its
 * exit status; the two hosts only differ in how they spawn that command.
 * `enabled` is re-evaluated before every dispatch so a repository that is
 * created or removed after setup is honored without a plugin reload.
 * `authorize`, when present, is consulted immediately before every CLI
 * invocation (inside the session's serialized queue) with a fresh answer;
 * a session that no longer belongs to this directory never records here.
 */
const createTracker = (directory, invoke, enabled, authorize) => {
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
    // Re-validate before every dispatch: the repository may have appeared or
    // disappeared since this instance loaded. When it is gone, skip the
    // dispatch entirely instead of surfacing a CLI failure on every tool call.
    // Returns false when skipped so callers can keep their pending state.
    if (enabled && !enabled()) return false;
    // Ownership is authoritative only at invocation time: this runs inside
    // the session's serialized queue, so a callback that was queued while the
    // session still lived here is re-checked after any wait, immediately
    // before the CLI runs. Unresolvable sessions fail closed (skip).
    // `session-end` is exempt: the session is already gone from the host by
    // then, so its location cannot be resolved — finalizing a session this
    // repo actually recorded (state.started) is the designed behavior.
    if (authorize && verb !== "session-end" && !(await authorize(sid)))
      return false;
    const json = JSON.stringify({
      ...payload,
      session_id: sid,
      cwd: directory,
      timestamp: new Date().toISOString(),
    });
    // Wait for the operation itself, not merely its background launcher.
    const result = await invoke(json, verb);
    if (result.exitCode !== 0)
      throw new Error(
        `exit ${result.exitCode}: ${String(result.stderr).trim()}`,
      );
    return true;
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
      // Only a dispatched session-start marks the session started: when the
      // repository is absent the dispatch is skipped, so a repository that
      // appears later still receives its startup dispatch.
      state.started = await hook(sid, "session-start", { source: "startup" });
    }
  }
  async function beginTurn(sid, state, payload = {}) {
    await start(sid, state);
    if (state.active) return;
    // Programmatic/subagent and resumed turns need not emit chat.message.
    // A tool or model step must activate the CLI turn before it can end.
    // Do not claim activation until the foreground hook has succeeded — or,
    // when the repository is absent, keep the turn unclaimed so dispatch
    // resumes cleanly once a repository exists.
    if (!(await hook(sid, "user-prompt", {
      model: state.model,
      provider: state.provider,
      ...payload,
    })))
      return;
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
  async function stopTurn(sid, state) {
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
    const turn = state.turns + 1;
    const dispatched = await hook(sid, "stop", {
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
    // A skipped dispatch (no repository) retains the finished turn exactly
    // like a failed one, so a later attempt records it once the repository
    // exists again.
    if (dispatched === false) return;
    state.turns = turn;
    state.active = false;
    state.completedSteps = new Set(state.steps);
    reset(state);
  }
  async function endSession(sid) {
    const state = stateFor(sid);
    if (state.started)
      await hook(sid, "session-end", { reason: "deleted" });
    state.closed = true;
    reset(state);
    sessions.delete(sid);
  }
  return {
    stateFor,
    hook,
    enqueue,
    start,
    beginTurn,
    stopTurn,
    endSession,
  };
};

/** OpenCode v1 plugin: hooks returned by value, invoked with a Bun `$` shell. */
export const AtomicHooksPlugin = async ({ directory, $ }) => {
  if (typeof directory !== "string") return {};
  // Hooks are always registered; each dispatch re-checks repository presence
  // so a repository created after load is picked up without a restart, and a
  // missing repository makes every hook a no-op (no CLI spawn, no failures).
  const enabled = () => atomicEnabled(directory);
  const t = createTracker(
    directory,
    async (json, verb) =>
      $`echo ${json} | atomic agent hooks opencode ${verb} --foreground`.nothrow(),
    enabled,
  );
  const { enqueue, start, beginTurn, stopTurn } = t;
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
        return enqueue(sid, event.type, (state) => stopTurn(sid, state));
      }
      if (event.type === "session.deleted") {
        const sid = props.sessionID ?? props.info?.id;
        return enqueue(sid, event.type, () => t.endSession(sid));
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
          const args = output.args || {};
          state.tools.set(input.callID, { start: Date.now(), args });
          await t.hook(sid, "before-tool", {
            tool_name: input.tool,
            tool_call_id: input.callID,
            tool_input: args,
          });
        },
        true,
      );
    },
    "tool.execute.after": async (input, output) => {
      const sid = input.sessionID;
      return enqueue(sid, "after-tool", async (state) => {
        await beginTurn(sid, state);
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
        await t.hook(sid, "after-tool", {
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
      if (!enabled()) return;
      output.env.ATOMIC_AGENT = "opencode";
      output.env.ATOMIC_AGENT_VERSION = ATOMIC_AGENT_VERSION;
    },
  };
};

/** OpenCode v2 plugin: hooks registered on the context domains. */
const spawnHook = (directory, json, verb) =>
  new Promise(async (resolve) => {
    // `opencode run --standalone` tears down the whole process tree the
    // moment a turn completes; a foreground hook in flight would be killed
    // with it (SIGTERM, exit 143). An ignored-signal disposition survives
    // exec, so the recording already in progress always finishes. Graceful,
    // long-lived sessions are unaffected.
    let proc;
    try {
      proc = Bun.spawn(
        [
          "sh",
          "-c",
          'trap "" TERM; exec atomic agent hooks opencode "$0" --foreground',
          verb,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: directory },
      );
      proc.stdin.write(json);
      await proc.stdin.end();
    } catch (error) {
      // A failed spawn must resolve, never reject or hang the dispatcher.
      resolve({ exitCode: 127, stderr: String(error) });
      return;
    }
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    resolve({ exitCode, stderr });
  });

const setupV2 = async (ctx, invoke) => {
  const directory = ctx.location?.directory;
  // Always register the hooks: one plugin instance loads per location, and a
  // repository that appears later must start recording without a reload. Each
  // dispatch re-checks repository presence, so a location with no Atomic
  // repository stays a pure no-op — no CLI spawn, no hook failures.
  if (typeof directory !== "string") return;
  const enabled = () => atomicEnabled(directory);
  // Domain hooks (prompt, tool execution) fire for every session the server
  // runs, not only sessions at this instance's location. Ownership is
  // resolved FRESH from Session.Info.location on every dispatch (passed to
  // the tracker as `authorize`) — never from a cache and never from a
  // fallback: a session that moved, or whose location cannot be resolved,
  // must never be recorded into this location's repository. Model/provider
  // metadata fetched alongside is presentation data, not ownership.
  const sessionLocation = async (sid) => {
    if (typeof sid !== "string" || !sid) return undefined;
    try {
      const info = await ctx.session.get({ sessionID: sid });
      return info?.location?.directory;
    } catch {
      return undefined;
    }
  };
  const authorize = async (sid) => (await sessionLocation(sid)) === directory;
  const t = createTracker(
    directory,
    invoke ?? ((json, verb) => spawnHook(directory, json, verb)),
    enabled,
    authorize,
  );
  const { enqueue, stopTurn } = t;
  // The public event stream may not be scoped to this plugin instance's
  // location, so only track sessions that are known to belong to it. `known`
  // is a non-authoritative prefilter: every CLI dispatch re-authorizes with
  // a fresh session location, so stale entries can queue telemetry but can
  // never write a foreign session into this repository.
  const known = new Set();
  const own = (sid) => typeof sid === "string" && !!sid && known.has(sid);

  const userPrompt = (sid, payload) =>
    enqueue(sid, "user-prompt", (state) => t.beginTurn(sid, state, payload));
  const toolBefore = (sid, tool, callID, args) =>
    enqueue(
      sid,
      "before-tool",
      async (state) => {
        await t.beginTurn(sid, state);
        state.tools.set(callID, { start: Date.now(), args });
        await t.hook(sid, "before-tool", {
          tool_name: tool,
          tool_call_id: callID,
          tool_input: args,
        });
      },
      true,
    );
  const toolAfter = (sid, tool, callID, args, toolOutput, status, exit) =>
    enqueue(sid, "after-tool", async (state) => {
      await t.beginTurn(sid, state);
      const saved = state.tools.get(callID);
      const truncated =
        toolOutput != null
          ? toolOutput.length > 2048
            ? toolOutput.slice(0, 2048) + "…"
            : toolOutput
          : undefined;
      await t.hook(sid, "after-tool", {
        tool_name: tool,
        tool_call_id: callID,
        tool_input: args,
        tool_output: truncated,
        file_path: args?.filePath || args?.path,
        exit_code: typeof exit === "number" ? exit : undefined,
        status,
        duration: saved ? Date.now() - saved.start : undefined,
      });
      state.tools.delete(callID);
    });

  try {
    await ctx.session.hook("prompt", async (event) => {
      const sid = event.sessionID;
      let model, provider, location;
      try {
        const info = await ctx.session.get({ sessionID: sid });
        model = info?.model?.id;
        provider = info?.model?.providerID;
        location = info?.location?.directory;
      } catch {}
      // Prefilter only (this fetch also supplies model metadata): the queued
      // dispatch itself re-authorizes ownership immediately before the CLI
      // runs. Sessions at other locations — or unresolvable ones — never
      // reach a dispatch.
      if (location !== directory) return;
      known.add(sid);
      return userPrompt(sid, {
        prompt: (event.prompt?.text ?? "").trim() || undefined,
        ...(model ? { model, provider } : {}),
      });
    });
    await ctx.tool.hook("execute.before", (event) => {
      known.add(event.sessionID);
      // Ownership is not decided here: the queued callback re-authorizes
      // immediately before the CLI invocation (see createTracker).
      return toolBefore(
        event.sessionID,
        event.tool,
        event.id,
        event.input ?? {},
      );
    });
    await ctx.tool.hook("execute.after", (event) => {
      known.add(event.sessionID);
      let toolOutput;
      if (event.status === "error") toolOutput = event.error?.message;
      else if (Array.isArray(event.result?.content))
        toolOutput = event.result.content
          .filter((c) => c?.type === "text")
          .map((c) => c.text)
          .join("\n");
      const exit = event.result?.metadata?.exit;
      return toolAfter(
        event.sessionID,
        event.tool,
        event.id,
        event.input ?? {},
        toolOutput,
        event.status ?? "completed",
        exit,
      );
    });
    await ctx.shell.hook("create.before", (event) => {
      if (!enabled()) return;
      // ShellCreateBefore carries no session or location field — its only
      // per-event evidence is the shell's `cwd`. Inject the agent
      // environment only for shells rooted at this instance's directory so
      // other locations' shells receive no foreign env.
      const cwd = event.cwd;
      if (
        typeof cwd !== "string" ||
        (cwd !== directory && !cwd.startsWith(`${directory}/`))
      )
        return;
      event.env.ATOMIC_AGENT = "opencode";
      event.env.ATOMIC_AGENT_VERSION = ATOMIC_AGENT_VERSION;
    });
  } catch (error) {
    try {
      appendFileSync(
        `${directory}/.atomic/hook-errors.log`,
        `${new Date().toISOString()} v2-registration ${String(error)}\n`,
      );
    } catch {}
    return;
  }

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        const data = ev.data ?? {};
        const sid = data.sessionID;
        const loc = ev.location?.directory;
        if (loc !== undefined && loc !== directory) continue;
        switch (ev.type) {
          case "session.inbox.enqueued":
          case "session.inbox.delivered":
            if (loc === directory && sid) known.add(sid);
            break;
          case "session.execution.started":
            if (own(sid))
              enqueue(sid, ev.type, (state) => t.beginTurn(sid, state));
            break;
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted":
          case "session.idle":
            if (own(sid))
              enqueue(sid, ev.type, (state) => stopTurn(sid, state));
            break;
          case "session.status":
            if (own(sid) && data.status?.type === "idle")
              enqueue(sid, ev.type, (state) => stopTurn(sid, state));
            break;
          case "session.step.started":
            if (!own(sid)) break;
            enqueue(sid, ev.type, async (state) => {
              if (data.model?.id) state.model = data.model.id;
              if (data.model?.providerID)
                state.provider = data.model.providerID;
              await t.beginTurn(sid, state);
              state.steps.add(ev.id);
            });
            break;
          case "session.step.ended":
          case "session.step.failed":
            if (own(sid))
              enqueue(sid, ev.type, (state) => {
                state.finishes.set(ev.id, {
                  tokens: data.tokens,
                  cost: data.cost,
                  reason: data.finish,
                });
              });
            break;
          case "session.reasoning.started":
            if (own(sid))
              enqueue(sid, ev.type, (state) => {
                state.reasoning.set(
                  `${data.assistantMessageID}:${data.ordinal}`,
                  { text: "", start: ev.created },
                );
              });
            break;
          case "session.reasoning.ended":
            if (own(sid))
              enqueue(sid, ev.type, (state) => {
                const key = `${data.assistantMessageID}:${data.ordinal}`;
                state.reasoning.set(key, {
                  ...(state.reasoning.get(key) ?? { start: undefined }),
                  text: data.text ?? "",
                  end: ev.created,
                });
              });
            break;
          case "session.text.ended":
            if (own(sid))
              enqueue(sid, ev.type, (state) => {
                state.text.set(
                  `${data.assistantMessageID}:${data.ordinal}`,
                  data.text ?? "",
                );
              });
            break;
          case "session.deleted":
            if (own(sid)) enqueue(sid, ev.type, () => t.endSession(sid));
            known.delete(sid);
            break;
        }
      }
    } catch {}
  })();
  return () => controller.abort();
};

/** Dual entrypoint: OpenCode v1 calls `server()`, v2 calls `setup()`. */
export default {
  id: "atomic-hooks",
  server: AtomicHooksPlugin,
  setup: setupV2,
};

export { setupV2 as AtomicHooksPluginV2 };

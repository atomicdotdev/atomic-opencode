/** Attribute shared-directory writes by comparing serialized tool snapshots.
 * The queue covers filesystem tools and publication, never a task/subagent wait.
 */
export class FileOwnership {
  private tail: Promise<void> = Promise.resolve();
  private owners = new Map<string, string>();
  private files = new Map<string, Record<string, string | null>>();
  private failures = new Map<string, string>();
  private pending = new Map<
    string,
    { sid: string; before: any; release: () => void }
  >();

  constructor(
    private snapshot: (paths: string[]) => Promise<any>,
    private waitMs = 30_000,
  ) {}

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private async acquire() {
    let release!: () => void;
    const prior = this.tail;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.tail = prior.then(() => gate);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        prior,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("shared workspace is busy; tool was not started"),
              ),
            this.waitMs,
          );
        }),
      ]);
      return release;
    } catch (error) {
      release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private key(sid: string, call: string) {
    return JSON.stringify([sid, call]);
  }
  private async take() {
    const value = await this.snapshot([]);
    if (
      value?.scope_version !== 1 ||
      !value.files ||
      !Array.isArray(value.dirty)
    )
      throw new Error(
        "Atomic CLI must support explicit-files-v1; refusing unscoped recording",
      );
    return value;
  }
  async check() {
    await this.take();
  }
  async begin(sid: string, call: string) {
    const key = this.key(sid, call);
    if (this.pending.has(key)) throw new Error("duplicate mutation callback");
    const release = await this.acquire();
    try {
      if (this.failures.has(sid)) throw new Error(this.failures.get(sid));
      const before = await this.take();
      this.pending.set(key, { sid, before, release });
    } catch (error) {
      release();
      throw error;
    }
  }
  async finish(sid: string, call: string) {
    const key = this.key(sid, call),
      pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    try {
      const before = pending.before;
      // Include prior dirty files even when a tool restores them to clean.
      const after = await this.snapshot([
        ...new Set(Object.keys(before.files)),
      ]);
      if (after.scope_version !== 1 || after.view !== before.view)
        throw new Error(
          "working view changed during a tool; file ownership is ambiguous",
        );
      const files = this.files.get(sid) ?? Object.create(null);
      this.files.set(sid, files);
      for (const path of new Set([
        ...Object.keys(before.files),
        ...Object.keys(after.files),
      ])) {
        if (before.files[path] === after.files[path]) continue;
        const owner = this.owners.get(path);
        if (
          (owner && owner !== sid) ||
          (!owner && before.dirty.includes(path))
        ) {
          const reason = `Ambiguous file ownership: ${path} (${owner ?? "pre-existing edits"}); changes left on disk`;
          if (owner) this.failures.set(owner, reason);
          throw new Error(reason);
        }
        this.owners.set(path, sid);
        files[path] = after.files[path] ?? null;
      }
    } catch (error) {
      this.failures.set(sid, String(error));
      throw error;
    } finally {
      pending.release();
    }
  }
  async finishSession(sid: string) {
    for (const [key, value] of this.pending) {
      if (value.sid === sid) await this.finish(sid, JSON.parse(key)[1]);
    }
  }
  manifest(sid: string) {
    if (this.failures.has(sid)) throw new Error(this.failures.get(sid));
    return { ...(this.files.get(sid) ?? {}) };
  }
  published(sid: string) {
    this.files.delete(sid);
  }
}

// Unknown tools may mutate. Never hold the workspace queue while waiting for
// a child task, which needs that same queue to execute its own tools.
export function mayMutate(tool: string) {
  return ![
    "read",
    "glob",
    "grep",
    "list",
    "task",
    "webfetch",
    "websearch",
    "question",
    "todowrite",
    "todoread",
  ].includes(tool);
}

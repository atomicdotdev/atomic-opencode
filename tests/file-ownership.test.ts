import { expect, test } from "bun:test";
import { FileOwnership, mayMutate } from "../plugins/lib/file-ownership";

function fixture(initial: Record<string, string | null> = {}) {
  let files = { ...initial };
  let dirty = Object.keys(files);
  let view = "work";
  const owner = new FileOwnership(
    async (paths) => ({
      scope_version: 1,
      view,
      dirty,
      files: Object.fromEntries(
        [...new Set([...dirty, ...paths])].map((p) => [p, files[p] ?? null]),
      ),
    }),
    20,
  );
  return {
    owner,
    put(p: string, v: string | null) {
      files[p] = v;
      dirty = [...new Set([...dirty, p])];
    },
    settle(p: string) {
      dirty = dirty.filter((x) => x !== p);
    },
    clean() {
      dirty = [];
    },
    view(v: string) {
      view = v;
    },
  };
}

test("serialized tools attribute disjoint bash writes and exclude pre-existing files", async () => {
  const f = fixture({ human: "untouched" });
  await f.owner.begin("a", "bash-a");
  let bStarted = false;
  const b = f.owner.begin("b", "bash-b").then(() => {
    bStarted = true;
  });
  await Promise.resolve();
  expect(bStarted).toBe(false);
  f.put("a.txt", "a");
  await f.owner.finish("a", "bash-a");
  await b;
  f.put("b.txt", "b");
  await f.owner.finish("b", "bash-b");
  expect(f.owner.manifest("a")).toEqual({ "a.txt": "a" });
  expect(f.owner.manifest("b")).toEqual({ "b.txt": "b" });
});

test("foreign rewrite blocks both sessions instead of attributing combined bytes", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.put("same", "a");
  await f.owner.finish("a", "1");
  await f.owner.begin("b", "2");
  f.put("same", "b");
  await expect(f.owner.finish("b", "2")).rejects.toThrow("Ambiguous");
  expect(() => f.owner.manifest("a")).toThrow("Ambiguous");
  expect(() => f.owner.manifest("b")).toThrow("Ambiguous");
});

test("pre-existing edits are not claimed, and failure releases the workspace", async () => {
  const f = fixture({ human: "a" });
  await f.owner.begin("a", "1");
  f.put("human", "b");
  await expect(f.owner.finish("a", "1")).rejects.toThrow("pre-existing");
  await f.owner.begin("b", "2");
  f.put("new", "ok");
  await f.owner.finish("b", "2");
  expect(f.owner.manifest("b")).toEqual({ new: "ok" });
});

test("error/idle drain captures partial writes once and releases queued tools", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.put("partial", "written");
  await f.owner.finishSession("a");
  await f.owner.finish("a", "1");
  await f.owner.begin("b", "2");
  f.put("other", "ok");
  await f.owner.finish("b", "2");
  expect(f.owner.manifest("a")).toEqual({ partial: "written" });
});

test("deletion and returning an owned file to clean are represented explicitly", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.put("file", "first");
  await f.owner.finish("a", "1");
  f.clean();
  await f.owner.begin("a", "2");
  f.put("file", null);
  await f.owner.finish("a", "2");
  expect(f.owner.manifest("a")).toEqual({ file: null });
  f.owner.published("a");
  expect(f.owner.manifest("a")).toEqual({});
});

test("view changes and unsupported CLIs fail closed", async () => {
  const old = new FileOwnership(async () => ({}));
  await expect(old.check()).rejects.toThrow("CLI");
  const f = fixture();
  await f.owner.begin("a", "1");
  f.view("another");
  await expect(f.owner.finish("a", "1")).rejects.toThrow("view changed");
});

test("bounded queue timeout does not release someone else's active tool", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  await expect(f.owner.begin("b", "2")).rejects.toThrow("not started");
  await f.owner.finishSession("a");
  await f.owner.begin("c", "3");
  await f.owner.finish("c", "3");
  expect(mayMutate("task")).toBe(false);
  expect(mayMutate("read")).toBe(false);
  expect(mayMutate("bash")).toBe(true);
  expect(mayMutate("custom-tool")).toBe(true);
});

test("clean published files are not reclaimed by another session's read-only bash", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.put("a.txt", "a");
  await f.owner.finish("a", "1");
  f.owner.published("a");
  f.clean();
  await f.owner.begin("b", "2");
  await f.owner.finish("b", "2");
  expect(f.owner.manifest("b")).toEqual({});
  await f.owner.begin("b", "3");
  f.put("a.txt", "overwritten");
  await expect(f.owner.finish("b", "3")).rejects.toThrow("Ambiguous");
});

test("deleting a pre-existing dirty file is claimed, not refused", async () => {
  const f = fixture({ human: "a" });
  await f.owner.begin("a", "1");
  f.put("human", null);
  await f.owner.finish("a", "1");
  expect(f.owner.manifest("a")).toEqual({ human: null });
});

test("deleting a foreign-owned file still blocks both sessions", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.put("same", "a");
  await f.owner.finish("a", "1");
  await f.owner.begin("b", "2");
  f.put("same", null);
  await expect(f.owner.finish("b", "2")).rejects.toThrow("Ambiguous");
  expect(() => f.owner.manifest("a")).toThrow("Ambiguous");
});

test("ownership failure clears once the failing files settle", async () => {
  const f = fixture({ human: "a" });
  await f.owner.begin("a", "1");
  f.put("human", "b");
  await expect(f.owner.finish("a", "1")).rejects.toThrow("pre-existing");
  expect(() => f.owner.manifest("a")).toThrow("pre-existing");
  // Still blocked while the file stays dirty, even for a fresh tool.
  await expect(f.owner.begin("a", "2")).rejects.toThrow("pre-existing");
  // Resolution makes the file no longer dirty; the session recovers
  // without a plugin restart.
  f.settle("human");
  await f.owner.begin("a", "2");
  f.put("after", "ok");
  await f.owner.finish("a", "2");
  expect(f.owner.manifest("a")).toEqual({ after: "ok" });
});

test("view drift failure stays sticky across tools", async () => {
  const f = fixture();
  await f.owner.begin("a", "1");
  f.view("another");
  await expect(f.owner.finish("a", "1")).rejects.toThrow("view changed");
  f.view("work");
  f.clean();
  await expect(f.owner.begin("a", "2")).rejects.toThrow("view changed");
});

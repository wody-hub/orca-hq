import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRelayCoordinator } from "../src/relay-coordinator.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const workspace = "repo-hq::/safe/hq";
const terminal = (handle = "term_new", tabId = "tab-hq") => ({
  handle, tabId, worktreeId: workspace, title: "Orca HQ Relay",
  connected: true, writable: true, orphaned: false,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hq-coordinator-"));
  directories.push(directory);
  await writeFile(join(directory, "relay-coordinator.json"), JSON.stringify({ coordinatorHandle: "term_old" }));
  await writeFile(join(directory, "relay-terminal-receipt.json"), JSON.stringify({ ok: true, result: { terminal: terminal("term_old") } }));
  let terminals: ReturnType<typeof terminal>[] = [];
  let owner = "term_old";
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    let result: unknown;
    if (args[0] === "terminal" && args[1] === "show") {
      const t = terminals.find(t => t.handle === flag("--terminal"));
      if (!t) return { ok: false, error: { code: "terminal_handle_stale" } };
      result = { terminal: t };
    } else if (args[0] === "terminal" && args[1] === "list") {
      expect(flag("--worktree")).toBe("id:" + workspace);
      result = { terminals, truncated: false, hostScope: { omittedHostIds: [] } };
    } else if (args[0] === "terminal" && args[1] === "create") {
      expect(flag("--worktree")).toBe("id:" + workspace);
      terminals.push(terminal());
      result = { terminal: terminals.at(-1) };
    } else if (args[1] === "run-show") result = { run: { id: "run-existing", coordinator_handle: owner } };
    else if (args[1] === "run-use") {
      expect(flag("--id")).toBe("run-existing");
      owner = flag("--from")!;
      result = { run: { id: "run-existing", coordinator_handle: owner } };
    } else throw Error("unexpected RPC " + args.join(" "));
    return { ok: true, result };
  };
  return { directory, run, calls, setTerminals: (ts: typeof terminals) => { terminals = ts; }, owner: () => owner };
}

it("recovers a restored HQ tab and rebinds the existing Run without creating a terminal", async () => {
  const f = await fixture(); f.setTerminals([terminal()]);
  const coordinator = createRelayCoordinator(f);
  expect(await coordinator.resolve("run-existing")).toBe("term_new");
  expect(f.owner()).toBe("term_new");
  expect(f.calls.some(a => a[1] === "create")).toBe(false);
  expect(JSON.parse(await readFile(join(f.directory, "relay-coordinator.json"), "utf8")).coordinatorHandle).toBe("term_new");
});

it("creates only one dedicated terminal for concurrent recovery and survives a second runtime restart", async () => {
  const f = await fixture(); const coordinator = createRelayCoordinator(f);
  expect(await Promise.all([coordinator.resolve("run-existing"), coordinator.resolve("run-existing")])).toEqual(["term_new", "term_new"]);
  expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  f.setTerminals([terminal("term_next")]);
  expect(await coordinator.resolve("run-existing")).toBe("term_next");
  expect(f.owner()).toBe("term_next");
  expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
});

it("does not create terminals on a runtime connection error", async () => {
  const f = await fixture();
  const coordinator = createRelayCoordinator({ ...f, run: async () => { throw Error("offline"); } });
  await expect(coordinator.resolve("run-existing")).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(JSON.parse(await readFile(join(f.directory, "relay-coordinator.json"), "utf8")).coordinatorHandle).toBe("term_old");
});

it("refuses an ambiguous HQ terminal inventory instead of choosing a worker", async () => {
  const f = await fixture(); f.setTerminals([terminal("term_a", "a"), terminal("term_b", "b")]);
  await expect(createRelayCoordinator(f).resolve("run-existing")).rejects.toThrow();
  expect(f.calls.some(a => a[1] === "create" || a[1] === "run-use")).toBe(false);
});

it("journals a lost terminal-create response and does not duplicate it after process restart", async () => {
  const f = await fixture();
  const run = async (a: readonly string[]) => {
    if (a[0] === "terminal" && a[1] === "create") throw Error("lost response");
    return f.run(a);
  };
  await expect(createRelayCoordinator({ ...f, run }).resolve("run-existing")).rejects.toThrow();
  await expect(createRelayCoordinator(f).resolve("run-existing")).rejects.toThrow();
  expect(f.calls.some(a => a[1] === "create")).toBe(false);
  f.setTerminals([terminal()]);
  expect(await createRelayCoordinator(f).resolve("run-existing")).toBe("term_new");
});

it("refuses takeover when the Run has another live coordinator", async () => {
  const f = await fixture(); f.setTerminals([terminal(), terminal("term_old", "other")]);
  await writeFile(join(f.directory, "relay-coordinator.json"), JSON.stringify({ coordinatorHandle: "term_new", worktreeId: workspace, tabId: "tab-hq" }));
  await expect(createRelayCoordinator(f).resolve("run-existing")).rejects.toThrow();
  expect(f.owner()).toBe("term_old");
});

it("refuses terminal creation if the inventory is incomplete", async () => {
  const f = await fixture();
  const run = async (a: readonly string[]) => a[1] === "list"
    ? { ok: true, result: { terminals: [], truncated: true } } : f.run(a);
  await expect(createRelayCoordinator({ ...f, run }).resolve("run-existing")).rejects.toThrow();
  expect(f.calls.some(a => a[1] === "create")).toBe(false);
});

it("keeps an explicit terminal-create failure journaled because a failed response can follow partial creation", async () => {
  const f = await fixture();
  const run = async (a: readonly string[]) => a[0] === "terminal" && a[1] === "create"
    ? { ok: false, error: { code: "terminal_adoption_failed" } } : f.run(a);
  await expect(createRelayCoordinator({ ...f, run }).resolve("run-existing")).rejects.toThrow();
  await expect(createRelayCoordinator(f).resolve("run-existing")).rejects.toThrow();
  expect(f.calls.some(a => a[1] === "create")).toBe(false);
});

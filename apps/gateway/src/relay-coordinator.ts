import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const Handle = z.string().startsWith("term_");
const Placement = z.object({
  coordinatorHandle: Handle,
  worktreeId: z.string().min(1).optional(),
  tabId: z.string().min(1).optional(),
  title: z.string().min(1).default("Orca HQ Relay"),
  creationPending: z.boolean().default(false),
});
const Terminal = z.object({
  handle: Handle,
  worktreeId: z.string().min(1),
  tabId: z.string().min(1),
  title: z.string().optional(),
  connected: z.boolean().optional(),
  writable: z.boolean().optional(),
  orphaned: z.boolean().optional(),
});
type State = z.infer<typeof Placement>;
type TerminalInfo = z.infer<typeof Terminal>;
type Receipt = { ok?: boolean; result?: Record<string, unknown>; error?: { code?: string } };

export function createRelayCoordinator(options: {
  directory: string;
  run: (args: readonly string[]) => Promise<unknown>;
}) {
  const path = join(options.directory, "relay-coordinator.json");
  let serial = Promise.resolve();
  const rpc = async (args: string[]): Promise<Receipt> => {
    const receipt = await options.run([...args, "--json"]);
    if (!receipt || typeof receipt !== "object") throw Error("HQ coordinator: Orca 응답을 확인할 수 없습니다");
    return receipt as Receipt;
  };
  const result = (receipt: Receipt): Record<string, unknown> => {
    if (receipt.ok !== true || !receipt.result)
      throw Error(`HQ coordinator: Orca 연결 또는 복구 실패 (${receipt.error?.code ?? "invalid_response"})`);
    return receipt.result;
  };
  const save = async (state: State) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  };
  const show = async (handle: string): Promise<TerminalInfo | undefined> => {
    const receipt = await rpc(["terminal", "show", "--terminal", handle]);
    // Only an explicit stale handle proves this terminal no longer exists.
    if (receipt.ok === false && receipt.error?.code === "terminal_handle_stale") return undefined;
    const terminal = Terminal.parse(result(receipt).terminal);
    if (terminal.handle !== handle || terminal.connected !== true || terminal.writable !== true || terminal.orphaned === true)
      throw Error("HQ 전용 터미널이 연결되지 않았습니다. Orca 연결 복구 후 다시 시도하세요.");
    return terminal;
  };
  const resolve = async (runId?: string): Promise<string> => {
    let state = Placement.parse(JSON.parse(await readFile(path, "utf8")));
    let terminal = await show(state.coordinatorHandle);
    if (!terminal) {
      if (!state.worktreeId) {
        // Migrate the original installation receipt, never guess from the active workspace.
        const receipt = JSON.parse(await readFile(join(options.directory, "relay-terminal-receipt.json"), "utf8")) as Receipt;
        const original = Terminal.parse(result(receipt).terminal);
        if (original.handle !== state.coordinatorHandle)
          throw Error("HQ coordinator의 원래 작업 공간을 확인할 수 없습니다");
        state = { ...state, worktreeId: original.worktreeId, tabId: original.tabId, title: original.title ?? state.title };
      }
      const inventory = result(await rpc(["terminal", "list", "--worktree", `id:${state.worktreeId}`]));
      const scope = inventory.hostScope as { omittedHostIds?: unknown[] } | undefined;
      if (inventory.truncated !== false || (scope?.omittedHostIds?.length ?? 0) > 0)
        throw Error("HQ 터미널 목록이 불완전합니다. Orca 연결 복구 후 다시 시도하세요.");
      const terminals = Terminal.array().parse(inventory.terminals).filter(t => t.worktreeId === state.worktreeId);
      const sameTab = terminals.filter(t => t.tabId === state.tabId);
      const candidates = sameTab.length ? sameTab : terminals.filter(t => t.title === state.title);
      if (candidates.length > 1) throw Error("HQ 전용 터미널 후보가 여러 개입니다. 중복된 HQ Relay 탭을 확인하세요.");
      terminal = candidates[0];
      if (!terminal) {
        if (state.creationPending)
          throw Error("HQ 터미널 생성 결과가 불명확합니다. Orca의 HQ Relay 탭을 확인하세요. 자동으로 중복 생성하지 않습니다.");
        state.creationPending = true;
        await save(state);
        const receipt = await rpc(["terminal", "create", "--worktree", `id:${state.worktreeId}`, "--title", state.title]);
        // Even an explicit failure can follow a partially created terminal.
        // Only an observed terminal clears the creation journal.
        terminal = Terminal.parse(result(receipt).terminal);
      }
      if (terminal.worktreeId !== state.worktreeId) throw Error("HQ 터미널 작업 공간이 일치하지 않습니다");
      terminal = await show(terminal.handle);
      if (!terminal) throw Error("HQ 터미널이 복구 중 종료되었습니다. 다시 시도하세요.");
    }
    state = { ...state, coordinatorHandle: terminal.handle, worktreeId: terminal.worktreeId, tabId: terminal.tabId, creationPending: false };
    await save(state);
    if (runId) {
      const Run = z.object({ id: z.literal(runId), coordinator_handle: Handle });
      const current = Run.parse(result(await rpc(["orchestration", "run-show", "--id", runId])).run);
      if (current.coordinator_handle !== terminal.handle) {
        if (await show(current.coordinator_handle))
          throw Error("기존 Run에 다른 coordinator가 연결되어 있습니다. 자동으로 인계하지 않습니다.");
        result(await rpc(["orchestration", "run-use", "--id", runId, "--from", terminal.handle]));
        const bound = Run.parse(result(await rpc(["orchestration", "run-show", "--id", runId])).run);
        if (bound.coordinator_handle !== terminal.handle) throw Error("HQ Run 재연결을 확인하지 못했습니다");
      }
    }
    return terminal.handle;
  };
  return {
    resolve(runId?: string): Promise<string> {
      const next = serial.then(() => resolve(runId));
      serial = next.then(() => {}, () => {});
      return next;
    },
  };
}

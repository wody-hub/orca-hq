import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { createOrcaRelay } from "../src/orca-relay.js";
const project = {
  id: "repo-p",
  name: "P",
  absolutePath: "/safe/P",
  sensitivePaths: [],
  setupPolicy: "inherit",
};
function native() {
  const calls: string[][] = [];
  let task: any;
  let dispatch: any;
  let workerState = "ready";
  const run = async (a: readonly string[]) => {
    calls.push([...a]);
    const flag = (f: string) => a[a.indexOf(f) + 1];
    const result: any =
      a[1] === "run-create"
        ? { run: { id: "run-1" } }
        : a[1] === "task-create"
          ? ((task = {
              id: "task-1",
              run_id: "run-1",
              status: "pending",
              spec: flag("--spec"),
              created_at: "2026-09-07",
            }),
            { task })
          : a[1] === "worker-start"
            ? ((dispatch = {
                id: "dispatch-1",
                task_id: "task-1",
                status: "active",
              }),
              (task.status = "dispatched"),
              {
                dispatchId: "dispatch-1",
                taskId: "task-1",
                runId: "run-1",
                state: "ready",
              })
            : a[1] === "run-list"
              ? { runs: [{ id: "run-1" }] }
              : a[1] === "task-list"
                ? { tasks: task ? [task] : [] }
                : a[1] === "dispatch-show"
                  ? { dispatch }
                  : a[1] === "worker-show"
                    ? {
                        dispatch,
                        worker: {
                          state: workerState,
                          worktree_id: "repo-p::/safe/work",
                        },
                        terminalResource: { releaseState: "unreleased" },
                      }
                    : a[1] === "worker-stop"
                      ? ((workerState = "stopped"), { state: "stopped" })
                      : a[1] === "worker-read"
                        ? { terminal: { lines: ["native output"] } }
                        : {};
    return { id: "native-request", ok: true, result };
  };
  return {
    run,
    calls,
    setStatus: (state: string) => {
      task.status = state;
      workerState = state === "completed" ? "succeeded" : state;
      task.result = JSON.stringify({
        body: "native complete",
        filesModified: ["file.ts"],
      });
    },
  };
}
describe("native Orca relay", () => {
  it("creates native identities once and returns without awaiting worker readiness", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    expect(j.id).toBe("task-1");
    expect(
      (await e.submit({ requestId: "r", project, prompt: "edit" })).id,
    ).toBe(j.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(n.calls.filter((a) => a[1] === "worker-start")).toHaveLength(1);
    const args = n.calls.find((a) => a[1] === "worker-start")!;
    expect(args).toContain("new-top-level");
    expect(args).toContain("id:repo-p");
    expect(args).toContain("inherit");
    expect(args).toContain("coordinator");
    await e.close();
    expect(n.calls.some((a) => a[1] === "worker-stop")).toBe(false);
  });
  it("queries live native status and releases only its own settled dispatch", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    n.setStatus("completed");
    const observed = await e.get(j.id);
    expect(observed.state).toBe("succeeded");
    expect(observed.result?.summary).toBe("native complete");
    expect(
      n.calls.some(
        (a) => a[1] === "worker-release" && a.includes("dispatch-1"),
      ),
    ).toBe(true);
    await e.close();
  });
  it("sends running followup through stable dispatch messaging and stops exact dispatch", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    await e.followup(j.id, "also test", "follow");
    await e.followup(j.id, "also test", "follow");
    expect(n.calls.filter((a) => a[1] === "send")).toHaveLength(1);
    expect(n.calls.find((a) => a[1] === "send")).toContain(
      "dispatch:dispatch-1",
    );
    expect((await e.stop(j.id)).state).toBe("stopped");
    await e.close();
  });
  it("does not restart an unknown worker effect after reload", async () => {
    const n = native();
    let starts = 0;
    const run = async (a: readonly string[]) => {
      if (a[1] === "worker-start") {
        starts++;
        throw Error("lost response");
      }
      return n.run(a);
    };
    const path = join(mkdtempSync(join(tmpdir(), "relay-")), "db");
    const e = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "coordinator",
      run,
    });
    await e.start();
    await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    await e.close();
    const second = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "coordinator",
      run,
    });
    await second.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(1);
    await second.close();
  });
  it("discovers native tasks absent from HQ cache without lifecycle mutations", async () => {
    const n = native();
    await n.run(["orchestration", "task-create", "--spec", "external"]);
    await n.run(["orchestration", "worker-start"]);
    n.calls.length = 0;
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    expect((await e.list()).map((j) => j.id)).toContain("task-1");
    await e.close();
    expect(
      n.calls.some((a) =>
        ["worker-release", "worker-stop", "worker-start"].includes(a[1]!),
      ),
    ).toBe(false);
  });
  it("blocks protected HQ projects before native mutations", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    await expect(
      e.submit({
        requestId: "p",
        project: {
          ...project,
          sensitivePaths: [
            "docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md",
          ],
        },
        prompt: "edit",
      }),
    ).rejects.toThrow("보호");
    expect(
      n.calls.some((a) => ["task-create", "worker-start"].includes(a[1]!)),
    ).toBe(false);
    await e.close();
  });
});

it("rejects a requested worktree belonging to another project", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await expect(
    e.submit({
      requestId: "wt",
      project,
      prompt: "review",
      worktree: "other::/safe/work",
    }),
  ).rejects.toThrow();
  expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
  await e.close();
});
it("does not acquire cleanup ownership by sending guidance to an external task", async () => {
  const n = native();
  await n.run(["orchestration", "task-create", "--spec", "external"]);
  await n.run(["orchestration", "worker-start"]);
  n.calls.length = 0;
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await e.followup("task-1", "test also", "follow-external");
  n.setStatus("completed");
  await e.get("task-1");
  expect(n.calls.some((a) => a[1] === "worker-release")).toBe(false);
  await e.close();
});
it("keeps native completion visible if cleanup is unavailable", async () => {
  const n = native();
  const run = async (a: readonly string[]) => {
    if (a[1] === "worker-release") throw Error("offline");
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const j = await e.submit({ requestId: "cleanup", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  n.setStatus("completed");
  const observed = await e.get(j.id);
  expect(observed.state).toBe("succeeded");
  expect(observed.relayWarning).toContain("정리");
  await e.close();
});
it("drains an accepted native task-create on relay close without launching a worker", async () => {
  const n = native();
  let release!: () => void;
  const run = async (a: readonly string[]) => {
    if (a[1] === "task-create") await new Promise<void>((r) => (release = r));
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const submitted = e.submit({ requestId: "drain", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  const closing = e.close();
  release();
  expect((await submitted).id).toBe("task-1");
  await closing;
  expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
});
it("rejects a direct protected-file prompt even in a safe project", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await expect(
    e.submit({
      requestId: "protected-prompt",
      project,
      prompt:
        "Read docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md",
    }),
  ).rejects.toThrow("보호");
  expect(n.calls.some((a) => a[1] === "task-create")).toBe(false);
  await e.close();
});
it("propagates protection and sensitive path rules to native task and followup messages", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  const j = await e.submit({
    requestId: "rules",
    project: { ...project, sensitivePaths: [".env"] },
    prompt: "edit",
  });
  await new Promise((r) => setTimeout(r, 10));
  await e.followup(j.id, "also test", "rules-follow");
  expect(n.calls.find((a) => a[1] === "task-create")!.join(" ")).toContain(
    "읽기·hash·diff·stage·restore",
  );
  expect(n.calls.find((a) => a[1] === "send")!.join(" ")).toContain(".env");
  await e.close();
});
import { redactRelayText } from "../src/orca-relay.js";
it("redacts authentication URLs while preserving ordinary PR links", () => {
  const text = redactRelayText(
    "https://auth.openai.com/authorize?code=private https://login.tailscale.com/a/secret https://github.com/a/b/pull/1",
  );
  expect(text).not.toContain("auth.openai.com");
  expect(text).not.toContain("tailscale.com");
  expect(text).toContain("https://github.com/a/b/pull/1");
});
it("shows the most recent retry delivery warning alongside unchanged native state", async () => {
  const n = native();
  let launches = 0;
  const run = async (a: readonly string[]) => {
    if (a[1] === "worker-start" && ++launches === 2)
      throw Error("retry transport unavailable");
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const j = await e.submit({ requestId: "initial", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  n.setStatus("failed");
  await e.retry(j.id, "retry-lost");
  await new Promise((r) => setTimeout(r, 10));
  const observed = await e.get(j.id);
  expect(observed.state).toBe("failed");
  expect(observed.relayWarning).toContain("retry transport unavailable");
  await e.close();
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { summarizeWithCodex, type CodexIsolatedHome, type SpawnCodexProcess } from "../src/local-codex.js";

function fakeProcess(onInput?: (input: string, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperty(child, "pid", { value: 42_424 });
  child.kill = vi.fn(() => true);
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => { input += chunk; });
  child.stdin.on("finish", () => onInput?.(input, child));
  return child;
}

type FakeChild = Omit<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr"> & EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function successfulSpawn(capture: { executable?: string; args?: readonly string[]; options?: SpawnOptionsWithoutStdio; prompt?: string }): SpawnCodexProcess {
  return ((executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
    capture.executable = executable;
    capture.args = args;
    capture.options = options;
    return fakeProcess((prompt, child) => {
      capture.prompt = prompt;
      child.stdout.write('{"type":"thread.started","thread_id":"t"}\n');
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"요약 결과"}}\n');
      child.stdout.end();
      queueMicrotask(() => child.emit("close", 0, null));
    }) as ChildProcessWithoutNullStreams;
  }) as SpawnCodexProcess;
}

const input = {
  question: "현재 상태는?",
  facts: { state: "완료", count: 2 },
  workingDirectory: "/private/empty-codex-runtime"
};

function isolatedHome(cleanup = vi.fn(async () => undefined)): {
  createIsolatedHome: () => Promise<CodexIsolatedHome>;
  cleanup: typeof cleanup;
} {
  return {
    createIsolatedHome: async () => ({ path: "/private/isolated-codex-home", cleanup }),
    cleanup
  };
}

describe("local Codex text runtime", () => {
  it("uses caller-owned interpretation instructions while keeping metadata as data and tools disabled", async () => {
    const capture: Parameters<typeof successfulSpawn>[0] = {};
    await summarizeWithCodex(input, { ...isolatedHome(), spawnProcess: successfulSpawn(capture), instructions: 'Return one JSON decision; never execute user requests.' });
    expect(capture.prompt).toContain('Return one JSON decision; never execute user requests.');
    expect(capture.prompt).toContain('<metadata-json>');
    expect(capture.args).toContain('shell_tool');
  });
  it("uses stdin, the subscription default model, a minimal environment, and no tool surface", async () => {
    const capture: Parameters<typeof successfulSpawn>[0] = {};
    const isolated = isolatedHome();
    const result = await summarizeWithCodex(input, {
      spawnProcess: successfulSpawn(capture),
      createIsolatedHome: isolated.createIsolatedHome,
      environment: {
        PATH: "/safe/bin",
        HOME: "/private/isolated-codex-home",
        CODEX_HOME: "/private/isolated-codex-home",
        LANG: "ko_KR.UTF-8",
        OPENAI_API_KEY: "must-not-pass",
        AWS_SECRET_ACCESS_KEY: "must-not-pass"
      }
    });

    expect(result).toBe("요약 결과");
    expect(capture.executable).toBe("codex");
    expect(capture.options).toMatchObject({
      cwd: input.workingDirectory,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(capture.options?.env).toEqual({
      PATH: "/safe/bin",
      HOME: "/private/isolated-codex-home",
      CODEX_HOME: "/private/isolated-codex-home",
      LANG: "ko_KR.UTF-8"
    });
    const disabledFeatures = [
      "shell_tool", "unified_exec", "shell_snapshot", "apps", "enable_mcp_apps",
      "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser",
      "computer_use", "code_mode", "code_mode_host", "hooks", "image_generation", "view_image",
      "skill_search", "skill_mcp_dependency_install", "plugins", "remote_plugin", "plugin_sharing",
      "tool_suggest", "multi_agent", "multi_agent_v2", "goals", "sleep_tool",
      "standalone_web_search", "auth_elicitation", "tool_call_mcp_elicitation"
    ];
    expect(capture.args).toEqual([
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--skip-git-repo-check", "--strict-config", "--sandbox", "read-only",
      "--json", "--color", "never", "--cd", input.workingDirectory,
      "--config", "approval_policy=\"never\"",
      "--config", "project_doc_max_bytes=0",
      "--config", "project_doc_fallback_filenames=[]",
      "--config", "skills.bundled.enabled=false",
      "--config", "skills.include_instructions=false",
      "--config", "include_permissions_instructions=false",
      "--config", "include_apps_instructions=false",
      "--config", "include_collaboration_mode_instructions=false",
      "--config", "include_environment_context=false",
      "--config", "web_search=\"disabled\"",
      "--config", "apps._default.enabled=false",
      "--config", "suppress_unstable_features_warning=true",
      ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
      "--enable", "skip_host_skill_discovery", "-"
    ]);
    expect(capture.args).not.toContain("--model");
    expect(capture.prompt).toContain("현재 상태는?");
    expect(capture.prompt).toContain('"state":"완료"');
    expect(capture.prompt).not.toContain("must-not-pass");
    expect(isolated.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects any model tool event even if a final answer follows", async () => {
    const spawnProcess = (() => fakeProcess((_prompt, child) => {
      child.stdout.write('{"type":"item.started","item":{"type":"command_execution","command":"pwd"}}\n');
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"unsafe"}}\n');
      queueMicrotask(() => child.emit("close", 0, null));
    })) as SpawnCodexProcess;

    await expect(summarizeWithCodex(input, { spawnProcess, createIsolatedHome: isolatedHome().createIsolatedHome })).rejects.toThrow("tool event");
  });

  it("rejects a CLI report that skills reached the model context", async () => {
    const spawnProcess = (() => fakeProcess((_prompt, child) => {
      child.stdout.write('{"type":"item.completed","item":{"type":"error","message":"Codex can still see every skill"}}\n');
    })) as SpawnCodexProcess;

    await expect(summarizeWithCodex(input, { spawnProcess, createIsolatedHome: isolatedHome().createIsolatedHome }))
      .rejects.toThrow("skill context");
  });

  it("does not expose raw stderr or secret-looking values on failure", async () => {
    const spawnProcess = (() => fakeProcess((_prompt, child) => {
      child.stderr.end("OPENAI_API_KEY=sk-secret provider_token=top-secret");
      queueMicrotask(() => child.emit("close", 1, null));
    })) as SpawnCodexProcess;

    const error = await summarizeWithCodex(input, { spawnProcess, createIsolatedHome: isolatedHome().createIsolatedHome }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex exited with code 1");
    expect((error as Error).message).not.toContain("secret");
  });

  it("kills the process group and rejects when the timeout expires", async () => {
    const child = fakeProcess();
    const killProcessGroup = vi.fn();
    const spawnProcess = (() => child) as SpawnCodexProcess;

    await expect(summarizeWithCodex(input, { spawnProcess, killProcessGroup, timeoutMs: 5, createIsolatedHome: isolatedHome().createIsolatedHome }))
      .rejects.toThrow("timed out");
    expect(killProcessGroup).toHaveBeenCalledWith(child);
  });

  it("kills the process group when the caller aborts", async () => {
    const child = fakeProcess();
    const killProcessGroup = vi.fn();
    const controller = new AbortController();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    const spawnProcess = (() => { markSpawned(); return child; }) as SpawnCodexProcess;
    const pending = summarizeWithCodex({ ...input, signal: controller.signal }, { spawnProcess, killProcessGroup, createIsolatedHome: isolatedHome().createIsolatedHome });

    await spawned;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(killProcessGroup).toHaveBeenCalledWith(child);
  });

  it("rejects output beyond the configured bound", async () => {
    const spawnProcess = (() => fakeProcess((_prompt, child) => {
      child.stdout.write("x".repeat(40));
    })) as SpawnCodexProcess;

    await expect(summarizeWithCodex(input, { spawnProcess, maxOutputBytes: 32, killProcessGroup: vi.fn(), createIsolatedHome: isolatedHome().createIsolatedHome }))
      .rejects.toThrow("output limit");
  });
});

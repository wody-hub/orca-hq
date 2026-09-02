import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeOrcaScenario {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
}

interface StoredScenario extends FakeOrcaScenario {
  readonly args: readonly string[];
}

interface FakeOrcaState {
  readonly scenarios: readonly StoredScenario[];
  readonly calls: readonly (readonly string[])[];
}

const executableSource = `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const statePath = new URL("./state.json", import.meta.url);
const args = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
const scenarioIndex = state.scenarios.findIndex((candidate) =>
  JSON.stringify(candidate.args) === JSON.stringify(args)
);
state.calls.push(args);
if (scenarioIndex < 0) {
  await writeFile(statePath, JSON.stringify(state));
  process.stderr.write(\`unexpected fake Orca invocation: \${JSON.stringify(args)}\`);
  process.exit(64);
}
const [scenario] = state.scenarios.splice(scenarioIndex, 1);
await writeFile(statePath, JSON.stringify(state));
if (scenario.delayMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
}
if (scenario.stdout !== undefined) process.stdout.write(scenario.stdout);
if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr);
process.exit(scenario.exitCode ?? 0);
`;

export class FakeOrca {
  readonly executablePath: string;
  readonly #directory: string;
  readonly #statePath: string;

  private constructor(directory: string) {
    this.#directory = directory;
    this.executablePath = join(directory, "orca");
    this.#statePath = join(directory, "state.json");
  }

  static async create(): Promise<FakeOrca> {
    const directory = await mkdtemp(join(tmpdir(), "orca-hq-fake-orca-"));
    const fake = new FakeOrca(directory);
    await writeFile(fake.executablePath, executableSource, "utf8");
    await chmod(fake.executablePath, 0o755);
    await fake.#writeState({ scenarios: [], calls: [] });
    return fake;
  }

  async enqueue(args: readonly string[], scenario: FakeOrcaScenario): Promise<void> {
    const state = await this.#readState();
    await this.#writeState({
      scenarios: [...state.scenarios, { ...scenario, args: [...args] }],
      calls: state.calls
    });
  }

  async enqueueJson(
    args: readonly string[],
    value: unknown,
    scenario: Omit<FakeOrcaScenario, "stdout"> = {}
  ): Promise<void> {
    await this.enqueue(args, { ...scenario, stdout: JSON.stringify(value) });
  }

  async calls(): Promise<readonly (readonly string[])[]> {
    return (await this.#readState()).calls;
  }

  async cleanup(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  async #readState(): Promise<FakeOrcaState> {
    return JSON.parse(await readFile(this.#statePath, "utf8")) as FakeOrcaState;
  }

  async #writeState(state: FakeOrcaState): Promise<void> {
    await writeFile(this.#statePath, JSON.stringify(state), "utf8");
  }
}

export async function createFakeOrca(): Promise<FakeOrca> {
  return FakeOrca.create();
}

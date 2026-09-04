import { createConfigText, type ConfigFilePort } from "./config-files.js";
import {
  createDoctor,
  type DoctorPorts,
  type DoctorResult,
  type PilotCheckPorts,
  type RegistryReviewPort
} from "./doctor.js";
import { ORCA_HQ_KEYCHAIN_SERVICE, type KeychainPort } from "./keychain.js";

export interface SetupOutputPort {
  write(text: string): void;
}

export interface SetupPorts extends DoctorPorts {
  readonly databasePath: string;
  readonly keychain: KeychainPort;
  readonly configFile: ConfigFilePort;
  readonly output: SetupOutputPort;
  /** Called only after the non-secret plan and config destination were displayed. */
  confirm(): Promise<boolean>;
}

export interface SetupAnswers {
  readonly credentials: Readonly<Record<string, string>>;
  readonly registryPath: string;
}

export interface SetupResult {
  readonly ok: boolean;
  readonly checks: DoctorResult["checks"];
}

export type { PilotCheckPorts, RegistryReviewPort };

function credentialAccounts(credentials: Readonly<Record<string, string>>): string[] {
  return Object.entries(credentials)
    .filter(([, value]) => value.length > 0)
    .map(([account]) => account)
    .sort();
}

export function createSetup(ports: SetupPorts): Readonly<{
  run(answers: SetupAnswers): Promise<SetupResult>;
}> {
  return Object.freeze({
    async run(answers: SetupAnswers): Promise<SetupResult> {
      const preflight = await createDoctor({ checks: ports.checks, registry: ports.registry }).run({ format: "json" });
      if (!preflight.ok) {
        ports.output.write("Setup stopped before configuration; resolve failed checks with hq doctor.");
        return Object.freeze({ ok: false, checks: preflight.checks });
      }

      const accounts = credentialAccounts(answers.credentials);
      const config = createConfigText({
        schema: "orca-hq.private-pilot.v1",
        databasePath: ports.databasePath,
        projectRegistryPath: answers.registryPath,
        credentialAccounts: accounts
      });
      ports.output.write(`Planned configuration: ${ports.configFile.path}`);
      ports.output.write("Planned changes: save non-secret pilot configuration and store selected credentials in Keychain.");
      await ports.configFile.preview(config);

      if (!await ports.confirm()) {
        ports.output.write("Setup cancelled; configuration unchanged.");
        return Object.freeze({ ok: false, checks: preflight.checks });
      }

      for (const account of accounts) {
        const value = answers.credentials[account];
        if (value !== undefined) await ports.keychain.set(ORCA_HQ_KEYCHAIN_SERVICE, account, value);
      }
      await ports.configFile.write(config);
      ports.output.write(`Configuration written: ${ports.configFile.path}`);
      return Object.freeze({ ok: true, checks: preflight.checks });
    }
  });
}

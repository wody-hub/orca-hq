import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createControlClient, validSessionId, type ControlClient, type ControlClientOptions } from "./control.js";

export interface ChatOptions {
  readonly input: Readable;
  readonly output: Pick<typeof process.stdout, "write">;
  readonly sessionId?: string;
  readonly controlFactory?: (options: ControlClientOptions) => ControlClient;
}

export async function runChat(options: ChatOptions): Promise<void> {
  let sessionId = options.sessionId ?? randomUUID();
  if (!validSessionId(sessionId)) throw new Error("control_session_invalid");
  const factory = options.controlFactory ?? createControlClient;
  let control = factory({ sessionId });
  const announce = () => options.output.write(`세션 ID: ${sessionId}\n재개: hq chat --session ${sessionId}\n`);
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  // Consume the readline iterator immediately so piped lines remain queued during HTTP requests.
  try {
    announce();
    options.output.write("질문을 입력하세요. /new: 새 대화, /exit: 종료\n> ");
    for await (const line of lines) {
      const text = line.trim();
      if (text === "/exit") break;
      if (text === "/new") {
        sessionId = randomUUID();
        control = factory({ sessionId });
        announce();
      } else if (text !== "") {
        const response = await control.send(text);
        options.output.write(`${response.text}\n`);
        if (response.jobId !== undefined) options.output.write(`작업 ID: ${response.jobId}\n`);
      }
      options.output.write("> ");
    }
  } finally {
    lines.close();
  }
}

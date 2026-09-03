import { describe, expect, it } from "vitest";

import { createGateway, type GatewayConfig, type RuntimeAdapters } from "../src/lifecycle.js";

const config: GatewayConfig = { databasePath: ":memory:" };

describe("Gateway end-to-end composition", () => {
  it("takes an L1 command through verified completion and drains its delivery", async () => {
    // Break caught: accepted channel ingress is not handed to the existing durable command state machine and outbox.
    const received: string[] = [];
    const delivered: string[] = [];
    const adapters: RuntimeAdapters = {
      config: { async validate() {} },
      database: { async migrate() {}, async checkpoint() {}, async close() {} },
      orca: { async check() {} },
      reconcile: async () => {},
      http: { async start() {}, async stopIngress() {} },
      slack: { async start() {}, async stopIngress() {} },
      telegram: { async start() {}, async stopIngress() {} },
      transactions: { async drain() {} },
      commandFlow: {
        async accept(command) {
          received.push(command.text);
          return { state: "verified_success", delivery: "검증 완료" };
        }
      },
      deliveries: {
        async deliver(result) {
          delivered.push(result.delivery);
        }
      }
    };
    const gateway = await createGateway(config, adapters);
    await gateway.start();

    const result = await gateway.acceptCommand({
      commandId: "501",
      channel: "telegram",
      text: "샌드박스 프로젝트 테스트 수정해줘"
    });

    expect(result).toEqual({ state: "verified_success", delivery: "검증 완료" });
    expect(received).toEqual(["샌드박스 프로젝트 테스트 수정해줘"]);
    expect(delivered).toEqual(["검증 완료"]);
  });
});

import { OperationsControls, controlSupport } from "./operations-controls.js";
export type { OperationsServiceOptions } from "./operations-controls.js";
import { z } from "zod";
import {
  HqContextPageSchema,
  HqEventPageSchema,
  HqQuestionSchema,
  OperationsStatusSchema,
  OrcaOutputPageSchema,
  SubmitProgressRequestSchema,
} from "@orca-hq/core";
import type { ProgressEventQuery } from "./progress-store.js";
import { OperationsError } from "./operations-http.js";
import {
  Id,
  Cursor,
  State,
  Terminal,
  Run,
  Task,
  Worker,
  Receipt,
  publicValue,
  evidence,
} from "./operations-projections.js";
import type { QuestionRecord } from "./native-coordinator.js";
type Action = "dispatch" | "followup" | "reply" | "stop" | "retain" | "release";
const Body = z
  .string()
  .min(1)
  .max(8000)
  .refine((value) => value.trim().length > 0);
const requestSchema = SubmitProgressRequestSchema.extend({
  text: Body,
}).strict();
export class OperationsService extends OperationsControls {
  contexts(sessionId?: string, cursor?: string) {
    const offset = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(1000000)
      .parse(cursor ?? 0);
    const rows = this.options.store.listContexts(sessionId);
    return HqContextPageSchema.parse(
      publicValue({
        contexts: rows.slice(offset, offset + 100),
        ...(rows.length > offset + 100 ? { cursor: String(offset + 100) } : {}),
      }),
    );
  }
  context(id: string) {
    const value = this.options.store.getContext(Id.parse(id));
    if (!value) throw new OperationsError(404, "context_not_found");
    return {
      source: "hq",
      context: publicValue(value),
      evidence: evidence("hq_store"),
    };
  }
  request(id: string) {
    const value = this.options.store.getRequest(Id.parse(id));
    if (!value) throw new OperationsError(404, "request_not_found");
    return {
      source: "hq",
      request: publicValue(value),
      evidence: evidence("hq_store"),
    };
  }
  events(query: ProgressEventQuery) {
    const page = this.options.store.readEvents({
      ...query,
      limit: Math.min(query.limit ?? 100, 500),
    });
    return HqEventPageSchema.parse(
      publicValue({
        ...page,
        snapshots: page.snapshots.slice(0, 100),
        cursor: String(page.events.at(-1)?.seq ?? query.after),
        events: page.events.map(({ source, ...event }) => {
          const link = z
            .object({
              runId: Id,
              taskId: Id,
              dispatchId: Id,
              terminalHandle: Id,
            })
            .safeParse(event.payload);
          return {
            ...event,
            source: "hq",
            eventSource: source,
            ...(["worker.ready", "worker.retained"].includes(event.kind) &&
            link.success
              ? { receiptLink: link.data }
              : {}),
          };
        }),
      }),
    );
  }
  questions(after = 0, limit = 100) {
    const store = this.options.store;
    const page = store.readEvents({ after, limit: Math.min(limit, 100) });
    const native = store.nativeJournal().list<QuestionRecord>("question");
    const questions = page.events
      .filter((e) => e.kind === "clarification.required")
      .flatMap((e) => {
        const r = store.getRequest(e.requestId);
        if (!r) return [];
        const messageId =
          typeof e.payload.messageId === "string"
            ? e.payload.messageId
            : undefined;
        const pending = messageId
          ? native.find((q) => q.id === messageId && !q.answered)
          : undefined;
        if (messageId ? !pending : r.state !== "awaiting_input") return [];
        return [
          HqQuestionSchema.parse({
            source: "hq",
            kind: messageId ? "managed_orca_question" : "router_clarification",
            requestId: e.requestId,
            sessionId: r.sessionId,
            ...(e.contextId ? { contextId: e.contextId } : {}),
            ...(messageId ? { messageId } : {}),
            body: publicValue(String(e.payload.text ?? "")),
            occurredAt: e.occurredAt,
            state: r.state,
            evidence: evidence("hq_store"),
          }),
        ];
      })
      .slice(0, 100);
    return {
      source: "hq",
      questions,
      cursor: String(page.events.at(-1)?.seq ?? Math.max(after, page.latestSeq)),
      compacted: page.compacted,
    };
  }
  async status() {
    const c = this.options.capacity,
      byState: Record<string, number> = {};
    for (const a of c.attempts())
      byState[a.state] = (byState[a.state] ?? 0) + 1;
    let orca: {
      state: string;
      reachable: boolean;
      version: string;
      features: Record<string, unknown>;
      runtimeId?: string;
      connectionState?: string;
    } = {
      state: "unverifiable",
      reachable: false,
      version: "unavailable",
      features: {
        controls: { supported: false, reason: "runtime_unverifiable" },
      },
    };
    try {
      const raw = Receipt.parse(
        await this.options.orca.execute({ kind: "operations_status" }),
      );
      const { runtime } = z
        .object({
          runtime: z
            .object({
              state: State,
              reachable: z.boolean(),
              appVersion: State,
              capabilities: z.array(State),
              connectionState: State.optional(),
            })
            .passthrough(),
        })
        .parse(raw.result);
      orca = {
        state: runtime.state,
        reachable: runtime.reachable,
        version: runtime.appVersion,
        ...(runtime.connectionState
          ? { connectionState: runtime.connectionState }
          : {}),
        ...(raw._meta?.runtimeId ? { runtimeId: raw._meta.runtimeId } : {}),
        features: {
          advertised: runtime.capabilities,
          controls: controlSupport(runtime)
            ? { supported: true }
            : { supported: false, reason: "control_capability_unavailable" },
          gate: "fresh_run_owner_exact_incarnation_required",
        },
      };
    } catch {
      /* A failed runtime observation does not alter HQ occupancy. */
    }
    return OperationsStatusSchema.parse(
      publicValue({
        collectedAt: new Date().toISOString(),
        hq: {
          state: "running",
          capacity: {
            limit: c.limit,
            source: c.source,
            ...c.snapshot(),
            byState,
            updateSupported: false,
            reason: "restart_safe_mutation_contract_unavailable",
          },
        },
        orca,
        metrics: {
          tokens: { available: false, reason: "not_collected" },
          cost: { available: false, reason: "not_collected" },
        },
      }),
    );
  }
  async runs(cursor?: string) {
    const data = await this.read(
      { kind: "list_runs", limit: 100, ...(cursor ? { cursor } : {}) },
      z
        .object({
          runs: z.array(Run).max(100),
          nextCursor: Cursor.nullable().optional(),
        })
        .passthrough(),
    );
    return this.orcaPage(data);
  }
  async run(id: string) {
    return this.orcaPage(
      await this.read(
        { kind: "show_run", runId: id },
        z.object({ run: Run }).passthrough(),
      ),
    );
  }
  async tasks(runId: string) {
    return this.orcaPage(
      await this.read(
        { kind: "list_tasks", runId },
        z.object({ tasks: z.array(Task).max(100) }).passthrough(),
      ),
    );
  }
  async workers(runId?: string, cursor?: string) {
    return this.orcaPage(
      await this.read(
        {
          kind: "list_workers",
          limit: 100,
          ...(runId ? { runId } : {}),
          ...(cursor ? { cursor } : {}),
        },
        z
          .object({
            workers: z
              .array(
                z
                  .object({
                    dispatchId: Id,
                    projection: z
                      .object({
                        dispatchId: Id,
                        taskId: Id,
                        runId: Id,
                        liveness: z.object({ verdict: State }).passthrough(),
                      })
                      .passthrough(),
                  })
                  .passthrough(),
              )
              .max(100),
            page: z
              .object({
                hasMore: z.boolean(),
                nextCursor: Cursor.nullable().optional(),
              })
              .passthrough(),
            scope: z.object({ source: State }).passthrough(),
          })
          .passthrough(),
      ),
    );
  }
  async worker(id: string) {
    return this.orcaPage(
      await this.read(
        { kind: "operations_show_worker", dispatchId: id },
        Worker,
      ),
    );
  }
  private orcaPage(data: unknown) {
    return {
      ...z.record(z.unknown()).parse(publicValue(data)),
      source: "orca" as const,
      evidence: evidence("orca_cli"),
    };
  }
  async output(
    dispatchId: string,
    source: "terminal" | "transcript",
    cursor?: string,
    limit = 100,
  ) {
    const raw = Receipt.parse(
      await this.options.orca
        .execute({
          kind: "operations_worker_read",
          dispatchId,
          source,
          limit,
          ...(cursor ? { cursor } : {}),
        })
        .catch((error) => {
          if (
            (error as { orcaCode?: string }).orcaCode === "source_changed" ||
            (error as Error).message === "source_changed"
          )
            throw new OperationsError(409, "source_changed");
          throw error;
        }),
    );
    const base = z
      .object({
        dispatchId: Id,
        source: z.enum(["terminal", "transcript"]),
        cursor: Cursor,
        archived: z.boolean(),
        warnings: z.array(z.string()).max(100),
      })
      .passthrough()
      .parse(raw.result);
    if (base.dispatchId !== dispatchId)
      throw new OperationsError(502, "identity_mismatch");
    if (base.source !== source)
      throw new OperationsError(409, "source_changed");
    const content =
      source === "terminal"
        ? {
            lines: z
              .object({ lines: z.array(z.string()).max(500) })
              .parse(base.terminal).lines,
          }
        : {
            messages: z
              .object({
                messages: z
                  .array(
                    z.object({
                      id: Id,
                      role: State,
                      blocks: z.array(z.unknown()),
                      timestamp: z.number(),
                    }),
                  )
                  .max(500),
              })
              .parse(base.transcript)
              .messages.map((m) => ({
                id: m.id,
                role: m.role,
                text: JSON.stringify(m.blocks),
                occurredAt: new Date(m.timestamp).toISOString(),
              })),
          };
    return OrcaOutputPageSchema.parse(
      publicValue({
        source,
        cursor: base.cursor,
        archived: base.archived,
        warnings: base.warnings,
        ...content,
      }),
    );
  }
  async orcaQuestions() {
    const data = await this.inbox();
    return this.orcaPage({
      ...data,
      messages: data.messages.filter((m) => m.type === "question"),
      support: {
        pendingState: {
          supported: false,
          reason: "inbox_has_no_authoritative_pending_question_state",
        },
      },
    });
  }
  async resources(projectId?: string) {
    let remaining = 99;
    const uncovered = {
      supported: false as const,
      reason: "request_read_budget_exhausted",
    };
    const projects = await this.read(
      { kind: "operations_list_projects" },
      z.object({
        projects: z.array(z.object({ id: Id }).passthrough()).max(100),
      }),
    );
    const rows = await Promise.all(
      projects.projects
        .filter((project) => !projectId || project.id === projectId)
        .map(async (project) => {
          if (remaining-- <= 0)
            return {
              ...project,
              hostScope: "not_covered",
              setups: [],
              support: uncovered,
            };
          const { setups } = await this.read(
            { kind: "list_project_setups", projectId: project.id },
            z.object({
              setups: z
                .array(
                  z
                    .object({ id: Id, projectId: Id, repoId: Id, hostId: Id })
                    .passthrough(),
                )
                .max(100),
            }),
          );
          const results = await Promise.all(
            setups.map(async (setup) => {
              if (remaining-- <= 0)
                return {
                  ...setup,
                  hostScope: { hostIds: [], omittedHostIds: [setup.hostId] },
                  covered: false,
                  truncated: true,
                  worktrees: [],
                  support: uncovered,
                };
              const page = await this.read(
                { kind: "list_worktrees", repoId: setup.repoId, limit: 100 },
                z
                  .object({
                    worktrees: z
                      .array(
                        z
                          .object({ id: Id, projectHostSetupId: Id })
                          .passthrough(),
                      )
                      .max(100),
                    hostScope: z.object({
                      hostIds: z.array(Id),
                      omittedHostIds: z.array(Id),
                    }),
                    truncated: z.boolean(),
                  })
                  .passthrough(),
              );
              const worktrees = await Promise.all(
                page.worktrees
                  .filter((w) => w.projectHostSetupId === setup.id)
                  .map(async (w) => {
                    if (remaining-- <= 0)
                      return {
                        ...w,
                        terminals: [],
                        hostScope: {
                          hostIds: [],
                          omittedHostIds: [setup.hostId],
                        },
                        truncated: true,
                        support: uncovered,
                      };
                    const terminals = await this.read(
                      { kind: "list_terminals", worktreeId: w.id },
                      z
                        .object({
                          terminals: z.array(Terminal).max(100),
                          hostScope: z.object({
                            hostIds: z.array(Id),
                            omittedHostIds: z.array(Id),
                          }),
                          truncated: z.boolean(),
                        })
                        .passthrough(),
                    );
                    return { ...w, ...terminals };
                  }),
              );
              return {
                ...setup,
                hostScope: page.hostScope,
                covered:
                  page.hostScope.hostIds.includes(setup.hostId) &&
                  !page.hostScope.omittedHostIds.includes(setup.hostId),
                truncated: page.truncated,
                worktrees,
              };
            }),
          );
          return {
            ...project,
            hostScope: results.every((s) => s.covered)
              ? "covered"
              : "not_covered",
            setups: results,
          };
        }),
    );
    return this.orcaPage({ projects: rows });
  }
  async submit(raw: unknown, key: string) {
    const input = requestSchema.parse(raw);
    if (input.requestId !== key)
      throw new OperationsError(409, "request_identity_conflict");
    return this.options.journal.execute(
      {
        requestId: key,
        action: "hq_request",
        targetId: input.requestId,
        input,
      },
      async () => {
        await this.options.submit(input);
        return { state: "accepted" };
      },
    );
  }
  async route(
    method: string,
    url: URL,
    body: unknown,
    key?: string,
  ): Promise<unknown> {
    const path = url.pathname.replace(/^\/api\/operations/, "");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const q = Object.fromEntries(url.searchParams);
    const id = parts[2];
    if (
      !/^\/(?:status|hq\/(?:contexts(?:\/[^/]+)?|requests(?:\/[^/]+)?|events|questions)|orca\/(?:runs(?:\/[^/]+)?|tasks|workers(?:\/[^/]+(?:\/(?:output|stop|retain|release))?)?|questions|resources|dispatches|followups|replies))$/.test(
        path,
      )
    )
      throw new OperationsError(404, "route_not_found");
    if (method === "GET") {
      if (path === "/status") return this.status();
      if (parts[0] === "hq") {
        if (parts[1] === "contexts")
          return id
            ? this.context(id)
            : (() => {
                const p = z
                  .object({
                    sessionId: Id.optional(),
                    cursor: Cursor.optional(),
                  })
                  .strict()
                  .parse(q);
                return this.contexts(p.sessionId, p.cursor);
              })();
        if (parts[1] === "requests" && id) return this.request(id);
        if (parts[1] === "questions") {
          const p = z
            .object({
              after: z.coerce.number().int().nonnegative().default(0),
              limit: z.coerce.number().int().positive().max(100).default(100),
            })
            .strict()
            .parse(q);
          return this.questions(p.after, p.limit);
        }
        if (parts[1] === "events") {
          const filter = z
            .object({
              contextId: Id.optional(),
              after: z.coerce.number().int().nonnegative().default(0),
              limit: z.coerce.number().int().positive().max(500).default(100),
            })
            .strict()
            .parse(q);
          return this.events({
            after: filter.after,
            limit: filter.limit,
            ...(filter.contextId ? { contextId: filter.contextId } : {}),
          });
        }
      }
      if (parts[0] === "orca") {
        if (parts[1] === "runs")
          return id
            ? this.run(id)
            : this.runs(
                z.object({ cursor: Cursor.optional() }).strict().parse(q)
                  .cursor,
              );
        if (parts[1] === "tasks")
          return this.tasks(z.object({ runId: Id }).strict().parse(q).runId);
        if (parts[1] === "workers") {
          if (id && parts[3] === "output") {
            const p = z
              .object({
                source: z.enum(["terminal", "transcript"]),
                cursor: Cursor.optional(),
                limit: z.coerce.number().int().positive().max(500).default(100),
              })
              .strict()
              .parse(q);
            return this.output(id, p.source, p.cursor, p.limit);
          }
          if (id) return this.worker(id);
          const p = z
            .object({ runId: Id.optional(), cursor: Cursor.optional() })
            .strict()
            .parse(q);
          return this.workers(p.runId, p.cursor);
        }
        if (parts[1] === "questions") return this.orcaQuestions();
        if (parts[1] === "resources")
          return this.resources(
            z.object({ projectId: Id.optional() }).strict().parse(q).projectId,
          );
      }
    } else if (method === "POST" && key) {
      if (path === "/hq/requests") return this.submit(body, key);
      if (parts[0] === "orca") {
        if (
          parts[1] === "workers" &&
          id &&
          ["stop", "retain", "release"].includes(parts[3] ?? "")
        )
          return this.mutate(parts[3] as Action, id, body, key);
        const mappings = {
          dispatches: ["dispatch", "taskId"],
          followups: ["followup", "dispatchId"],
          replies: ["reply", "messageId"],
        } as const;
        if (parts[1] && parts[1] in mappings) {
          const [action, field] = mappings[parts[1] as keyof typeof mappings];
          const obj = z.record(z.unknown()).parse(body);
          const target = Id.parse(obj[field]);
          const { [field]: _, ...input } = obj;
          return this.mutate(action, target, input, key);
        }
      }
    }
    throw new OperationsError(404, "route_not_found");
  }
}

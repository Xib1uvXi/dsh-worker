import { z } from "zod";

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const text = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").includes("..") &&
      !p.includes("\0") &&
      !p.split("/").includes(".git"),
    "Expected repository-relative path outside .git",
  );
export const commandSchema = z
  .object({
    args: z.array(z.string().refine((s) => !s.includes("\0"))).min(1),
    cwd: relativePath.default("."),
    timeoutSeconds: z.number().int().min(1).max(86400).default(300),
  })
  .strict();
export const runtimeSchema = z
  .object({
    provider: text,
    model: text.default("deepseek-v4-pro"),
    reasoningEffort: text.optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().min(1).max(86400).default(1800),
    patches: z.array(text).default([]),
    envRequired: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  })
  .strict();
export const ticketSchema = z
  .object({
    schemaVersion: z.literal(2),
    ticketId: id,
    revision: z.number().int().positive(),
    title: text.max(200),
    project: text.max(120).optional(),
    targetRepo: text,
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    objective: text,
    scope: z
      .object({
        paths: z.array(relativePath).min(1),
        exclude: z.array(relativePath).default([]),
      })
      .strict(),
    outOfScope: z.array(text).default([]),
    acceptance: z.array(z.object({ id, description: text }).strict()).min(1),
    context: z.string().default(""),
    verification: z.array(commandSchema).min(1),
    execution: runtimeSchema,
  })
  .strict()
  .superRefine((t, ctx) => {
    if (new Set(t.acceptance.map((a) => a.id)).size !== t.acceptance.length)
      ctx.addIssue({
        code: "custom",
        message: "Acceptance ids must be unique",
      });
  });
export const deliverySchema = z
  .object({
    schemaVersion: z.literal(2),
    ticketId: id,
    revision: z.number().int().positive(),
    attemptId: id,
    outcome: z.enum(["submitted", "blocked"]),
    summary: text,
    evidence: z.array(z.object({ acceptanceId: id, evidence: text }).strict()),
    commands: z.array(z.object({ command: text, result: text }).strict()),
    notRun: z.array(text),
    blockers: z.array(text),
  })
  .strict();
const assessment = z
  .object({ verdict: z.enum(["pass", "fail"]), findings: z.array(text) })
  .strict();
export const reviewSchema = z
  .object({
    schemaVersion: z.literal(2),
    ticketId: id,
    revision: z.number().int().positive(),
    attemptId: id,
    snapshotDigest: digest,
    spec: assessment,
    standards: assessment,
    verdict: z.enum(["accept", "request_changes", "blocked"]),
    findings: z.array(text),
    reviewer: text,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.verdict === "accept" &&
      (r.spec.verdict !== "pass" ||
        r.standards.verdict !== "pass" ||
        r.findings.length ||
        r.spec.findings.length ||
        r.standards.findings.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Acceptance requires both assessments to pass without unresolved findings",
      });
    if (
      r.verdict !== "accept" &&
      ![...r.findings, ...r.spec.findings, ...r.standards.findings].length
    )
      ctx.addIssue({
        code: "custom",
        message: "A non-accept verdict requires concrete findings",
      });
  });
export const continuationSchema = z
  .object({
    ticketId: id,
    revision: z.number().int().positive(),
    attemptId: id,
    snapshotDigest: digest,
    instruction: text,
  })
  .strict();
export const workflowSchema = z
  .object({
    schemaVersion: z.literal(2),
    skillDirs: z.array(text).default([]),
    instructionFiles: z.array(text).default([]),
    entrySkills: z.array(text).default([]),
  })
  .strict();
export const instructionInputSchema = z
  .object({
    instructionId: id,
    revision: z.number().int().positive(),
    instruction: text.max(32000),
  })
  .strict();
export const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prune"),
      days: z.number().int().min(1).max(36500).default(7),
    })
    .strict(),
  instructionInputSchema.extend({
    action: z.literal("instruct"),
    ticketId: id,
  }),
  z
    .object({
      action: z.literal("archive"),
      ticketId: id,
      archived: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("prepare"), ticket: ticketSchema }).strict(),
  ...(["run", "cancel", "verify"] as const).map((action) =>
    z.object({ action: z.literal(action), ticketId: id }).strict(),
  ),
  z.object({ action: z.literal("review"), review: reviewSchema }).strict(),
  z
    .object({ action: z.literal("recover"), continuation: continuationSchema })
    .strict(),
]);
export type Ticket = z.infer<typeof ticketSchema>;
export type ExecutionConfig = z.infer<typeof runtimeSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Continuation = z.infer<typeof continuationSchema>;
export type Action = z.infer<typeof actionSchema>;
export type State =
  | "ready"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "accepted"
  | "blocked"
  | "interrupted";
export interface FileEntry {
  path: string;
  kind: "file" | "symlink" | "deleted";
  mode: number;
  hash: string | null;
  size: number;
  target?: string;
}
export interface Snapshot {
  baselineDigest?: string;
  detailsOmitted?: boolean;
  digest: string;
  baseCommit: string;
  head: string;
  indexHash: string;
  indexDiff?: string;
  files: FileEntry[];
  changedPaths?: string[];
  diff: string;
  violations: string[];
}
export interface ProcessIdentity {
  pid: number;
  start: string;
}
export interface Attempt {
  id: string;
  revision: number;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  marker: string;
  processes: ProcessIdentity[];
  receipt: boolean;
  finishReason?: string;
  termination?: string;
  cleanExit: boolean;
  snapshot?: Snapshot;
  delivery?: Delivery;
  error?: string;
}
export interface Verification {
  id: string;
  attemptId: string;
  revision: number;
  startedAt: string;
  endedAt?: string;
  before: string;
  after?: string;
  passed: boolean;
  commands: {
    args: string[];
    exitCode: number | null;
    output: string;
    outputTruncated?: boolean;
    timedOut: boolean;
  }[];
  marker: string;
  processes: ProcessIdentity[];
  cleanExit: boolean;
  error?: string;
}
export interface TicketRecord {
  archived?: boolean;
  instructions?: WorkerInstruction[];
  ticket: Ticket;
  state: State;
  worktree: string;
  owner: string;
  prepared: boolean;
  checkoutBaseline?: { path: string; digest: string };
  updatedAt: string;
  attempts: Attempt[];
  reviews: Review[];
  continuations: Continuation[];
  verifications: Verification[];
  activeOperation?: string;
  interruptedOperation?: "verification" | "execution";
  error?: string;
}
export interface WorkerInstruction {
  id: string;
  revision: number;
  text: string;
  time: string;
  status: "queued" | "sending" | "received" | "uncertain";
  attemptId?: string;
  messageId?: string;
  error?: string;
}
export interface TrajectoryEntry {
  seq: number;
  time: string;
  attemptId?: string;
  sessionId?: string;
  kind: string;
  title: string;
  text: string;
  callId?: string;
  raw: unknown;
}
export interface AgentActivity {
  sessionId: string;
  parentSessionId?: string;
  attemptId: string;
  status: "running" | "idle" | "ended" | "interrupted" | "unknown";
  action: string;
  updatedAt: string;
}
export interface TrajectoryPage {
  entries: TrajectoryEntry[];
  agents: AgentActivity[];
  cursor: number;
  hasMore: boolean;
}
export interface PruneResult {
  removed: string[];
  retentionDays: number;
  evidenceRetained: boolean;
}
export interface TicketView extends TicketRecord {
  stale: boolean;
  currentSnapshot?: string;
  snapshotCheckedAt?: string;
  snapshotMaxAgeMs?: number;
}
export interface JournalEvent {
  seq: number;
  time: string;
  ticketId: string;
  type: string;
  data: unknown;
}
export interface SessionSummary {
  source: string;
  id: string;
  parent?: string;
  origin?: string;
  cwd?: string;
  format: number;
  liveness: "unknown";
}
export interface Overview {
  tickets: TicketView[];
  capacity: number;
  active: number;
  dispatchEnabled: boolean;
  runtimeVersion: string;
}
export interface ApiError {
  error: { code: string; message: string };
}

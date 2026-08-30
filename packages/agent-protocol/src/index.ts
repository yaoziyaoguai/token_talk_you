import { z } from "zod";

export const TOKEN_TALK_AGENT_PROTOCOL_VERSION = "token-talk/codex-agent-v1" as const;

export const AgentTaskKindSchema = z.enum([
  "topic-editor",
  "research-plan",
  "research-claims",
  "research-audit",
  "cast-plan",
  "episode-blueprint",
  "script-segment",
  "script-audit",
  "script-repair",
  "music-plan",
  "cover-brief",
  "release-copy",
]);

export type AgentTaskKind = z.infer<typeof AgentTaskKindSchema>;

const RecordSchema = z.record(z.string(), z.unknown());
const ClaimSchema = z.object({
  id: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(4_000),
  sourceIds: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
  spokenQualifier: z.string().trim().min(1).max(500).optional(),
}).strict();

const EvidenceSynthesisSchema = z.object({
  thesis: z.string().trim().min(1).max(1_500),
  dimensions: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    definition: z.string().trim().min(1).max(600),
    indicators: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
    timeHorizon: z.string().trim().min(1).max(240),
    evidenceState: z.enum(["supported", "mixed", "unresolved"]),
    evidenceBasis: z.enum(["direct", "operational_proxy", "background", "none"]),
    claimIds: z.array(z.string().trim().min(1).max(120)).max(20),
    scope: z.string().trim().min(1).max(800),
  }).strict()).min(2).max(16),
  scopeBoundary: z.string().trim().min(1).max(1_000),
  sourceAssessments: z.array(z.object({
    sourceId: z.string().trim().min(1).max(160),
    studyType: z.string().trim().min(1).max(240),
    peerReviewStatus: z.enum(["reviewed", "preprint", "unknown"]),
    sample: z.string().trim().min(1).max(500),
    comparison: z.string().trim().min(1).max(500),
    measures: z.array(z.string().trim().min(1).max(240)).max(12),
    limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    independenceNotes: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(100),
  excludedSources: z.array(z.object({
    sourceId: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(500),
  }).strict()).max(100),
  unresolvedQuestions: z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();

const ProductionContextSchema = z.object({
  title: z.string().trim().min(1).max(240),
  targetMinutes: z.number().int().min(3).max(240),
  targetCharacters: z.number().int().min(100).max(80_000),
  brief: RecordSchema,
  claims: z.array(ClaimSchema).max(80),
  evidenceSynthesis: RecordSchema.default({}),
  castPolicy: RecordSchema.default({}),
  cast: RecordSchema,
  blueprint: RecordSchema,
  emotion: RecordSchema,
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
  retryFeedback: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const TargetSegmentSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(45),
  minutes: z.number().min(2).max(60),
  purpose: z.string().trim().max(500).optional(),
  claimIds: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  tension: z.string().trim().max(500).optional(),
  handoff: z.string().trim().max(500).optional(),
}).passthrough();

export const ScriptLineSchema = z.object({
  segmentId: z.string().trim().min(1).max(80),
  speaker: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(2_000),
  claimIds: z.array(z.string().trim().min(1).max(120)).max(8),
  delivery: z.string().trim().min(1).max(160).optional(),
  pauseAfterMs: z.number().int().min(0).max(10_000).optional(),
}).strict();

export const AgentFindingSchema = z.object({
  id: z.string().trim().min(1).max(120),
  severity: z.enum(["info", "warning", "critical"]),
  category: z.enum(["grounding", "coverage", "structure", "role", "tone", "pacing", "safety", "rights", "other"]),
  segmentId: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(1_000),
  evidence: z.string().trim().min(1).max(1_000),
  repairInstruction: z.string().trim().min(1).max(1_000),
}).strict();

const TaskInputSchemas = {
  "topic-editor": z.object({
    signals: z.array(RecordSchema).min(1).max(100),
    series: z.array(RecordSchema).max(40).default([]),
    editorialPolicy: z.string().trim().max(4_000).default(""),
  }).strict(),
  "research-plan": z.object({
    title: z.string().trim().min(1).max(240),
    centralQuestion: z.string().trim().min(1).max(1_000),
    listenerPromise: z.string().trim().max(1_000),
    currentQueries: z.array(z.string().trim().min(2).max(240)).max(8),
    auditFindings: z.array(AgentFindingSchema).max(100),
  }).strict(),
  "research-claims": z.object({
    title: z.string().trim().min(1).max(240),
    centralQuestion: z.string().trim().min(1).max(1_000),
    sources: z.array(RecordSchema).min(2).max(100),
    synthesisDirectives: z.array(z.string().trim().min(1).max(1_000)).max(30),
    previousSynthesis: RecordSchema,
  }).strict(),
  "research-audit": z.object({
    title: z.string().trim().min(1).max(240),
    centralQuestion: z.string().trim().min(1).max(1_000),
    sources: z.array(RecordSchema).min(1).max(100),
    claims: z.array(ClaimSchema).max(80),
    evidenceSynthesis: RecordSchema,
  }).strict(),
  "cast-plan": ProductionContextSchema,
  "episode-blueprint": ProductionContextSchema,
  "script-segment": ProductionContextSchema.extend({
    targetSegment: TargetSegmentSchema.optional(),
    currentScript: z.object({
      lockedSegmentIds: z.array(z.string().trim().min(1).max(80)).max(24).default([]),
      lines: z.array(ScriptLineSchema).max(1_200),
    }).passthrough().optional(),
  }).strict(),
  "script-audit": ProductionContextSchema.extend({
    script: z.object({ lines: z.array(ScriptLineSchema).min(1).max(1_200) }).passthrough(),
    auditRound: z.number().int().min(1).max(5),
  }).strict(),
  "script-repair": ProductionContextSchema.extend({
    script: z.object({ lines: z.array(ScriptLineSchema).min(1).max(1_200) }).passthrough(),
    findings: z.array(AgentFindingSchema).min(1).max(100),
    repairRound: z.number().int().min(1).max(5),
  }).strict(),
  "music-plan": ProductionContextSchema,
  "cover-brief": z.object({
    title: z.string().trim().min(1).max(240),
    brief: RecordSchema,
    series: RecordSchema,
    chapters: z.array(RecordSchema).max(24),
    script: z.object({ lines: z.array(ScriptLineSchema).min(1).max(1_200) }).passthrough(),
    visualConstraints: z.array(z.string().trim().min(1).max(500)).max(30),
  }).strict(),
  "release-copy": z.object({
    title: z.string().trim().min(1).max(240),
    hook: z.string().trim().min(1).max(1_000),
    script: z.object({ lines: z.array(ScriptLineSchema).min(1).max(1_200) }).passthrough(),
    chapters: z.array(RecordSchema).max(30),
    verifiedSources: z.array(RecordSchema).max(100),
  }).strict(),
} satisfies Record<AgentTaskKind, z.ZodType>;

const CastOutputSchema = z.object({
  roles: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(40),
    responsibility: z.string().trim().min(1).max(300),
    speakingStyle: z.string().trim().min(1).max(240),
    mustAsk: z.string().trim().min(1).max(500),
    voiceBrief: z.string().trim().min(1).max(240),
  }).strict()).min(1).max(6),
}).strict();

const BlueprintOutputSchema = z.object({
  segments: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(45),
    minutes: z.number().min(2).max(60),
    purpose: z.string().trim().min(1).max(500),
    claimIds: z.array(z.string().trim().min(1).max(120)).max(20),
    tension: z.string().trim().min(1).max(500),
    handoff: z.string().trim().min(1).max(500),
  }).strict()).min(3).max(24),
}).strict();

const ScriptOutputSchema = z.object({
  lines: z.array(ScriptLineSchema).min(4).max(1_200),
}).strict();

const AuditOutputSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  summary: z.string().trim().min(1).max(2_000),
  findings: z.array(AgentFindingSchema).max(100),
}).strict().superRefine((value, context) => {
  if (value.verdict === "pass" && value.findings.some((finding) => finding.severity !== "info")) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "pass cannot retain warning or critical findings" });
  }
  if (value.verdict === "revise" && value.findings.length === 0) {
    context.addIssue({ code: "custom", path: ["findings"], message: "revise requires findings" });
  }
});

const MusicOutputSchema = z.object({
  cues: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    segmentId: z.string().trim().min(1).max(80),
    action: z.enum(["silence", "transition", "bed", "outro"]),
    durationSeconds: z.number().min(0).max(60),
    mood: z.string().trim().min(1).max(120),
    intensity: z.number().int().min(0).max(5),
    purpose: z.string().trim().min(1).max(500),
    assetQuery: z.string().trim().max(300),
  }).strict()).max(40),
}).strict();

const TaskOutputSchemas = {
  "topic-editor": z.object({ ideas: z.array(RecordSchema).max(24) }).strict(),
  "research-plan": z.object({
    queries: z.array(z.object({
      query: z.string().trim().min(2).max(240),
      intent: z.string().trim().min(1).max(500),
      language: z.enum(["zh", "en"]),
      sourceKinds: z.array(z.enum(["scholarly", "primary", "book", "web"])).min(1).max(4),
    }).strict()).min(2).max(6),
    synthesisDirectives: z.array(z.string().trim().min(1).max(1_000)).max(20),
  }).strict(),
  "research-claims": z.object({
    claims: z.array(ClaimSchema).min(1).max(80),
    evidenceSynthesis: EvidenceSynthesisSchema,
  }).strict(),
  "research-audit": AuditOutputSchema,
  "cast-plan": CastOutputSchema,
  "episode-blueprint": BlueprintOutputSchema,
  "script-segment": ScriptOutputSchema,
  "script-audit": AuditOutputSchema,
  "script-repair": ScriptOutputSchema,
  "music-plan": MusicOutputSchema,
  "cover-brief": z.object({
    concept: z.string().trim().min(1).max(1_000),
    subject: z.string().trim().min(1).max(500),
    composition: z.string().trim().min(1).max(500),
    palette: z.array(z.string().trim().min(1).max(80)).min(2).max(8),
    typography: z.string().trim().min(1).max(500),
    imagePrompt: z.string().trim().min(1).max(2_000),
    negativePrompt: z.string().trim().min(1).max(1_000),
    altText: z.string().trim().min(3).max(240),
    chapterArtBriefs: z.array(z.object({
      segmentId: z.string().trim().min(1).max(80),
      title: z.string().trim().min(1).max(45),
      concept: z.string().trim().min(1).max(500),
      imagePrompt: z.string().trim().min(1).max(1_000),
      altText: z.string().trim().min(3).max(240),
    }).strict()).max(24),
  }).strict(),
  "release-copy": z.object({
    episodeTitle: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(2_000),
    showNotes: z.array(z.string().trim().min(1).max(1_000)).max(30),
    keywords: z.array(z.string().trim().min(1).max(40)).max(20),
  }).strict(),
} satisfies Record<AgentTaskKind, z.ZodType>;

const RawAgentTaskRequestSchema = z.object({
  protocolVersion: z.literal(TOKEN_TALK_AGENT_PROTOCOL_VERSION),
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,160}$/),
  kind: AgentTaskKindSchema,
  payload: z.unknown(),
}).strict();

export interface AgentTaskRequest {
  protocolVersion: typeof TOKEN_TALK_AGENT_PROTOCOL_VERSION;
  requestId: string;
  kind: AgentTaskKind;
  payload: unknown;
}

export const AgentTraceSchema = z.object({
  taskKind: AgentTaskKindSchema,
  promptVersion: z.string().min(1).max(160),
  providerId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(160),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
}).strict();

export type AgentTrace = z.infer<typeof AgentTraceSchema>;

export const AgentTaskSuccessSchema = z.object({
  ok: z.literal(true),
  requestId: z.string().min(1),
  output: z.unknown(),
  trace: AgentTraceSchema,
}).strict();

export const AgentHealthSchema = z.object({
  protocolVersion: z.literal(TOKEN_TALK_AGENT_PROTOCOL_VERSION),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  taskKinds: z.array(AgentTaskKindSchema),
  active: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
}).strict();

export function parseAgentTaskRequest(value: unknown): AgentTaskRequest {
  const request = RawAgentTaskRequestSchema.parse(value);
  return { ...request, payload: TaskInputSchemas[request.kind].parse(request.payload) };
}

export function parseAgentTaskOutput(kind: AgentTaskKind, value: unknown): unknown {
  return TaskOutputSchemas[kind].parse(value);
}

export function outputJsonSchemaFor(kind: AgentTaskKind): Record<string, unknown> {
  const schema = z.toJSONSchema(TaskOutputSchemas[kind], { target: "draft-7" }) as Record<string, unknown>;
  return requireEveryObjectProperty(schema) as Record<string, unknown>;
}

function requireEveryObjectProperty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requireEveryObjectProperty);
  if (!value || typeof value !== "object") return value;
  const record = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, requireEveryObjectProperty(child)]));
  if (record.type === "object" && record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    record.required = Object.keys(record.properties);
  }
  return record;
}

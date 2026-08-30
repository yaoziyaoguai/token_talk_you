import { z } from "zod";

export const SeriesRoleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  responsibility: z.string().trim().min(1).max(180).optional(),
  speakingStyle: z.string().trim().min(1).max(120).optional(),
  voiceBrief: z.string().trim().min(1).max(120).optional(),
});

export const CastPolicySchema = z.object({
  mode: z.enum(["dynamic", "recurring_with_guests", "fixed"]),
  recurringRoleIds: z.array(z.string().trim().min(1)).default([]),
  roles: z.array(SeriesRoleSchema).max(8).default([]),
  minSpeakers: z.number().int().positive().optional(),
  maxSpeakers: z.number().int().positive().optional(),
}).superRefine((policy, context) => {
  const roleIds = policy.roles.map((role) => role.id);
  const roleNames = policy.roles.map((role) => role.name);
  if (new Set(roleIds).size !== roleIds.length) context.addIssue({ code: "custom", path: ["roles"], message: "Role IDs must be unique" });
  if (new Set(roleNames).size !== roleNames.length) context.addIssue({ code: "custom", path: ["roles"], message: "Role names must be unique" });
  if (new Set(policy.recurringRoleIds).size !== policy.recurringRoleIds.length) context.addIssue({ code: "custom", path: ["recurringRoleIds"], message: "Recurring role IDs must be unique" });
  if (policy.recurringRoleIds.some((roleId) => !roleIds.includes(roleId))) context.addIssue({ code: "custom", path: ["recurringRoleIds"], message: "Recurring roles must reference configured roles" });
  if (policy.minSpeakers !== undefined && policy.maxSpeakers !== undefined && policy.minSpeakers > policy.maxSpeakers) context.addIssue({ code: "custom", path: ["minSpeakers"], message: "Minimum speakers cannot exceed maximum speakers" });
  if (policy.mode === "fixed" && policy.minSpeakers !== undefined && policy.roles.length < policy.minSpeakers) context.addIssue({ code: "custom", path: ["roles"], message: "Fixed cast has fewer roles than minSpeakers" });
  if (policy.mode === "fixed" && policy.maxSpeakers !== undefined && policy.roles.length > policy.maxSpeakers) context.addIssue({ code: "custom", path: ["roles"], message: "Fixed cast has more roles than maxSpeakers" });
});

export const SonicBibleSchema = z.object({
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
  palette: z.array(z.string().min(1)).default([]),
  exclusions: z.array(z.string().min(1)).default([]),
});

const PodcastDurationRangeSchema = z.object({
  min: z.number().int().min(15).max(240),
  max: z.number().int().min(15).max(240),
}).refine((range) => range.max >= range.min, { path: ["max"], message: "Maximum duration cannot be below minimum duration" });

export const SeriesBibleSchema = z.object({
  id: z.string().min(1),
  creationRequestId: z.string().min(8).max(128).optional(),
  title: z.string().min(1),
  promise: z.string().min(1),
  audience: z.string().min(1),
  castPolicy: CastPolicySchema,
  sonicBible: SonicBibleSchema,
  memory: z.array(z.string()).default([]),
});

export const ProductionRecipeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  contentProduct: z.enum(["rapid", "recurring", "durable", "custom"]),
  targetMinutes: PodcastDurationRangeSchema,
  legacyTargetMinutes: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).optional(),
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
  budgetPolicy: z.enum(["local", "economy", "balanced", "premium"]),
  capabilityIds: z.array(z.string().min(1)),
  estimatedCostCny: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }).optional(),
});

export const EpisodeEvidenceSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  platform: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Evidence URL must use HTTP(S)"),
  observedAt: z.string().datetime(),
  signal: z.string().min(1),
});

export const EpisodeCandidateScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  audienceRelevance: z.number().min(0).max(100),
  conversationPotential: z.number().min(0).max(100),
  evidenceDepth: z.number().min(0).max(100),
  longformDepth: z.number().min(0).max(100),
  freshness: z.number().min(0).max(100),
  seriesFit: z.number().min(0).max(100),
  feasibility: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
});

export const EpisodeCandidateSchema = z.object({
  id: z.string().min(1),
  origin: z.enum(["trend", "series", "custom"]),
  title: z.string().min(1),
  hook: z.string().min(1),
  rationale: z.string().min(1),
  category: z.enum([
    "ai_tech",
    "business",
    "culture",
    "science",
    "society",
    "books",
    "education",
    "health",
    "life",
    "world",
    "other",
  ]),
  platform: z.string().min(1),
  seriesId: z.string().min(1).optional(),
  episodeNumber: z.number().int().positive().optional(),
  suggestedRoles: z.array(z.string().min(1)).min(1),
  verdict: z.enum(["rapid_brief", "deep_discussion", "series_episode", "research_first", "skip"]),
  targetMinutes: PodcastDurationRangeSchema,
  legacyTargetMinutes: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).optional(),
  score: EpisodeCandidateScoreSchema,
  evidence: z.array(EpisodeEvidenceSchema),
  verification: z.object({
    status: z.enum(["ready", "review_required", "blocked"]),
    reason: z.string().min(1),
    independentSources: z.number().int().nonnegative(),
  }),
  editorial: z.object({
    whyNow: z.string().min(1),
    centralQuestion: z.string().min(1),
    listenerPromise: z.string().min(1),
    selectionReasons: z.array(z.string().min(1)).min(1),
    signalPlatforms: z.array(z.string().min(1)).min(1),
    signalCount: z.number().int().positive(),
    provider: z.enum(["local_ai", "rules", "series", "human"]),
    momentum: z.object({
      state: z.enum(["unknown", "new", "rising", "steady", "falling", "mixed"]),
      rankDelta: z.number().int().optional(),
      comparedAt: z.string().datetime().optional(),
    }).optional(),
  }).optional(),
  generatedAt: z.string().datetime(),
});

export const EpisodeOpportunitySchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  title: z.string().min(1),
  origin: EpisodeCandidateSchema.shape.origin,
  verdict: EpisodeCandidateSchema.shape.verdict,
  evidence: z.array(EpisodeEvidenceSchema),
  candidate: EpisodeCandidateSchema,
  adoptedAt: z.string().datetime(),
  status: z.enum(["adopted", "in_production", "release_ready", "published", "archived"]),
  runId: z.string().min(1).optional(),
});

export const EpisodeProductionIntentSchema = z.object({
  hook: z.string().min(1),
  targetMinutes: z.number().int().min(15).max(240),
  legacyTargetMinutes: z.number().int().positive().optional(),
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
  budgetPolicy: z.enum(["local", "economy", "balanced", "premium"]),
  maxCostCny: z.number().nonnegative(),
  castPolicy: CastPolicySchema.optional(),
  sonicPalette: z.array(z.string().min(1)).max(24).default([]),
  sonicExclusions: z.array(z.string().min(1)).max(24).default([]),
});

export const BillingSchema = z.object({
  type: z.enum(["free", "subscription", "metered", "local_compute"]),
  unit: z.enum(["character", "token", "minute", "request", "image", "run", "compute_second"]),
  rate: z.number().nonnegative(),
  unitSize: z.number().positive().default(1),
  currency: z.enum(["CNY", "USD"]),
});

export const FreeQuotaSchema = z.object({
  amount: z.number().nonnegative(),
  unit: z.enum(["character", "token", "minute", "request", "image", "run"]),
  renewal: z.enum(["none", "monthly", "introductory", "one_time"]),
  expiresAt: z.string().datetime().optional(),
  eligibility: z.string().optional(),
});

export const ProviderRightsSchema = z.object({
  commercialUse: z.enum(["allowed", "restricted", "unknown"]),
  attributionRequired: z.boolean(),
  licenseUrl: z.string().url().optional(),
  voiceConsentRequired: z.boolean().default(false),
});

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  deployment: z.enum(["local", "external"]),
  billing: BillingSchema,
  quota: FreeQuotaSchema.optional(),
  rights: ProviderRightsSchema,
  languages: z.array(z.string()).default([]),
  modes: z.array(z.string()).default([]),
  verifiedAt: z.string().date(),
  availability: z.object({
    status: z.enum(["ready", "configured", "needs_config", "planned", "research_only"]),
    reason: z.string().optional(),
  }),
});

export const ArtifactVersionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  sha256: z.string().length(64),
  source: z.enum(["generated", "human", "derived", "seed"]),
  data: z.unknown(),
});

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  activeVersionId: z.string().min(1),
  versions: z.array(ArtifactVersionSchema).min(1),
});

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  phase: z.enum(["planning", "production"]),
  role: z.string().min(1),
  capability: z.string().min(1),
  status: z.enum([
    "pending",
    "ready",
    "running",
    "succeeded",
    "failed",
    "needs_human",
    "stale",
    "awaiting_spend_approval",
  ]),
  inputArtifactIds: z.array(z.string()).default([]),
  inputVersionIds: z.array(z.string()).default([]),
  outputArtifactIds: z.array(z.string()).default([]),
  prerequisiteNodeIds: z.array(z.string()).default([]),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  staleReason: z.string().optional(),
  lastError: z.string().max(1_000).optional(),
  estimatedCostCny: z.number().nonnegative().default(0),
  authorizedCostCny: z.number().nonnegative().optional(),
  actualCostCny: z.number().nonnegative().optional(),
});

export const SpendAuthorizationSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  inputVersionIds: z.array(z.string()),
  maxAttempts: z.number().int().positive(),
  maxCostCny: z.number().nonnegative(),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const ExecutionReceiptSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed", "rejected", "needs_human"]),
  billing: z.enum(["free", "subscription", "metered", "local_compute"]),
  estimatedCostCny: z.number().nonnegative(),
  actualCostCny: z.number().nonnegative().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  errorMessage: z.string().max(1_000).optional(),
  reconciledAt: z.string().datetime().optional(),
  reconciliationNote: z.string().min(3).max(500).optional(),
  providerInvoiceId: z.string().min(1).max(160).optional(),
  reviewedInputVersionIds: z.array(z.string().min(1)).optional(),
  reviewChecklist: z.array(z.enum(["dialogue", "mix", "rights"])).optional(),
  reviewAttestedAt: z.string().datetime().optional(),
});

const PublicationRecordBaseSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/),
  platform: z.string().trim().min(1).max(80),
  releasePackageVersionId: z.string().min(1),
  releasePackageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverSha256: z.string().regex(/^[a-f0-9]{64}$/),
  registeredAt: z.string().datetime(),
});

export const PublicationRecordSchema = z.discriminatedUnion("status", [
  PublicationRecordBaseSchema.extend({
    status: z.literal("published"),
    externalEpisodeId: z.string().trim().min(1).max(240),
    episodeUrl: z.string().url().startsWith("https://"),
    channelUrl: z.string().url().startsWith("https://").optional(),
    publishedAt: z.string().datetime(),
  }),
  PublicationRecordBaseSchema.extend({
    status: z.literal("failed"),
    attemptedAt: z.string().datetime(),
    failureReason: z.string().trim().min(3).max(1_000),
  }),
]);

export const WorkflowRunSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  seriesId: z.string().min(1),
  recipeId: z.string().min(1),
  opportunityId: z.string().min(1).optional(),
  productionIntent: EpisodeProductionIntentSchema.optional(),
  status: z.enum(["active", "needs_human", "release_ready", "completed", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  nodes: z.array(WorkflowNodeSchema),
  artifacts: z.array(ArtifactSchema),
  spendAuthorizations: z.array(SpendAuthorizationSchema).default([]),
  executionReceipts: z.array(ExecutionReceiptSchema).default([]),
  publicationRecords: z.array(PublicationRecordSchema).default([]),
}).transform((run) => run.status === "completed" && !run.publicationRecords.some((record) => record.status === "published")
  ? { ...run, status: "release_ready" as const }
  : run);

export const StudioSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.string().datetime(),
  series: z.array(SeriesBibleSchema),
  recipes: z.array(ProductionRecipeSchema),
  providers: z.array(ProviderProfileSchema),
  runs: z.array(WorkflowRunSchema),
  opportunities: z.array(EpisodeOpportunitySchema).default([]),
});

export type SeriesBible = z.infer<typeof SeriesBibleSchema>;
export type ProductionRecipe = z.infer<typeof ProductionRecipeSchema>;
export type EpisodeEvidence = z.infer<typeof EpisodeEvidenceSchema>;
export type EpisodeCandidate = z.infer<typeof EpisodeCandidateSchema>;
export type EpisodeOpportunity = z.infer<typeof EpisodeOpportunitySchema>;
export type EpisodeProductionIntent = z.infer<typeof EpisodeProductionIntentSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type StudioSnapshot = z.infer<typeof StudioSnapshotSchema>;

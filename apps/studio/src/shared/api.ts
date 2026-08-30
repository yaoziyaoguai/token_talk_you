import {
  CastPolicySchema,
  EpisodeCandidateSchema,
  EpisodeOpportunitySchema,
  PublicationRecordSchema,
  StudioSnapshotSchema,
  WorkflowRunSchema,
  type SeriesBible,
  type StudioSnapshot,
  type WorkflowRun,
} from "@token-talk/domain/model";
import { z } from "zod";

export const StudioBootstrapSchema = StudioSnapshotSchema.extend({
  mutationToken: z.string().min(32),
});

export const CreateSeriesInputSchema = z.object({
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/),
  title: z.string().trim().min(1),
  promise: z.string().trim().min(1),
  audience: z.string().trim().min(1),
  castPolicy: CastPolicySchema,
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
}).superRefine((value, context) => {
  if (value.castPolicy.mode !== "dynamic" && value.castPolicy.roles.length === 0) {
    context.addIssue({ code: "custom", path: ["castPolicy", "roles"], message: "固定或常驻阵容至少需要一个角色" });
  }
});

export const ReviseArtifactInputSchema = z.object({
  data: z.unknown(),
});

export const ReviewSourceInputSchema = z.object({
  verified: z.boolean(),
});

export const CandidateInboxSchema = z.object({
  items: z.array(EpisodeCandidateSchema),
  fetchedAt: z.string().datetime(),
  sources: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    count: z.number().int().nonnegative(),
    status: z.enum(["ready", "degraded", "unavailable"]),
  })),
  warnings: z.array(z.string()),
  freshness: z.object({
    status: z.enum(["current", "fallback"]),
    lastSuccessfulAt: z.string().datetime(),
    attemptedAt: z.string().datetime().optional(),
  }).optional(),
  collector: z.object({
    state: z.enum(["scheduled", "collecting", "ready", "degraded", "error", "stopped"]),
    cadenceSeconds: z.number().int().positive(),
    consecutiveFailures: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().optional(),
    lastAttemptAt: z.string().datetime().optional(),
    lastSuccessfulAt: z.string().datetime().optional(),
    message: z.string().max(1_000).optional(),
  }).optional(),
});

export const AdoptCandidateInputSchema = z.object({
  verificationConfirmed: z.boolean().default(false),
});

export const AdoptCandidateResponseSchema = z.object({
  opportunity: EpisodeOpportunitySchema,
});

export const CreateCustomOpportunityInputSchema = z.object({
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/),
  title: z.string().trim().min(1),
  hook: z.string().trim().min(1),
  targetMinutes: z.number().int().min(15).max(240),
});

export const StartEpisodeInputSchema = z.object({
  title: z.string().trim().min(1),
  hook: z.string().trim().min(1),
  centralQuestion: z.string().trim().min(1),
  listenerPromise: z.string().trim().min(1),
  recipeId: z.string().min(1),
  targetMinutes: z.number().int().min(15).max(240),
  musicPolicy: z.enum(["minimal", "narrative", "immersive"]),
  budgetPolicy: z.enum(["local", "economy", "balanced", "premium"]),
  maxCostCny: z.number().min(0).max(10_000),
});

export const StartEpisodeResponseSchema = z.object({
  opportunity: EpisodeOpportunitySchema,
  run: WorkflowRunSchema,
});

export const NodeExecutionPreviewSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  billing: z.enum(["free", "subscription", "metered", "local_compute"]),
  estimatedCostCny: z.number().nonnegative(),
  remainingBudgetCny: z.number().nonnegative(),
  authorization: z.enum(["not_required", "required", "active", "exhausted"]),
  attemptsUsed: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  blocker: z.enum(["unreconciled_cost"]).optional(),
});

export const AuthorizeNodeSpendInputSchema = z.object({
  maxCostCny: z.number().positive().max(10_000),
  maxAttempts: z.literal(1),
  termsConfirmed: z.literal(true),
});

export const ExecuteNodeInputSchema = z.object({
  segmentId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
}).strict();

export const AgentLoopResultSchema = z.object({
  run: WorkflowRunSchema,
  executedNodeIds: z.array(z.string().min(1)).max(40),
  stoppedAtNodeId: z.string().min(1).optional(),
  reason: z.enum([
    "continue_available_work",
    "completed_available_work",
    "awaiting_spend_authorization",
    "requires_input",
    "failed",
    "repair_limit",
  ]),
});

export const ReconcileExecutionCostInputSchema = z.object({
  actualCostCny: z.number().min(0).max(10_000),
  note: z.string().trim().min(3).max(500),
  providerInvoiceId: z.string().trim().min(1).max(160).optional(),
});

export const ReleaseRightsBasisSchema = z.enum(["owned", "commissioned", "licensed", "generated"]);

const ReleaseRightsMetadataSchema = z.object({
  rightsOwner: z.string().trim().min(1).max(120),
  licenseBasis: ReleaseRightsBasisSchema,
  sourceUrl: z.union([z.string().url().startsWith("https://"), z.literal("")]).optional(),
  commercialUseConfirmed: z.union([z.literal(true), z.literal("true")]),
}).superRefine((value, context) => {
  if (["licensed", "generated"].includes(value.licenseBasis) && !value.sourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "外部许可或生成素材必须登记 HTTPS 授权来源" });
  }
});

export const RegisterReleaseMasterMetadataSchema = ReleaseRightsMetadataSchema.and(z.object({
  voiceConsentConfirmed: z.union([z.literal(true), z.literal("true")]),
  musicRightsConfirmed: z.union([z.literal(true), z.literal("true")]),
}));

export const RegisterCoverMetadataSchema = ReleaseRightsMetadataSchema.and(z.object({
  altText: z.string().trim().min(3).max(240),
}));

export const SelectCoverInputSchema = z.object({
  coverId: z.string().trim().min(1).max(160),
});

export const ReleasePackageSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("release_ready"),
  releaseReady: z.literal(true),
  episode: z.object({
    runId: z.string().min(1),
    title: z.string().min(1),
    seriesId: z.string().min(1),
    hook: z.string().min(1),
    targetMinutes: z.number().int().positive(),
    generatedAt: z.string().datetime(),
  }),
  audio: z.object({
    mediaUrl: z.string().startsWith("/media/"),
    mimeType: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationSeconds: z.number().positive(),
    releaseReady: z.literal(true),
    audioQc: z.record(z.string(), z.unknown()).optional(),
  }),
  cover: z.object({
    id: z.string().min(1),
    mediaUrl: z.string().startsWith("/media/"),
    mimeType: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    altText: z.string().min(3),
  }),
  transcript: z.object({
    format: z.literal("speaker_lines"),
    lineCount: z.number().int().positive(),
    lines: z.array(z.object({ speaker: z.string().min(1), text: z.string().min(1) })).min(1),
  }),
  chapters: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    startSeconds: z.number().int().nonnegative(),
    durationSeconds: z.number().int().positive(),
  })).min(1),
  sources: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    url: z.string().url().startsWith("https://"),
    publisher: z.string().min(1).optional(),
    publishedAt: z.string().min(1).optional(),
  })),
  editorial: z.object({
    episodeTitle: z.string().min(1).max(120),
    summary: z.string().min(1).max(2_000),
    showNotes: z.array(z.string().min(1).max(1_000)).max(30),
    keywords: z.array(z.string().min(1).max(40)).max(20),
  }).optional(),
  podcasting2: z.object({
    chapters: z.object({
      mimeType: z.literal("application/json+chapters"),
      data: z.object({
        version: z.literal("1.2.0"),
        title: z.string().min(1),
        description: z.string().min(1),
        chapters: z.array(z.object({
          startTime: z.number().nonnegative(),
          title: z.string().min(1),
        })).min(1),
      }),
    }),
    transcript: z.object({
      sourceFormat: z.literal("speaker_lines"),
      recommendedMimeType: z.literal("text/vtt"),
      status: z.literal("requires_forced_alignment"),
      speakerLabels: z.literal(true),
    }),
    persons: z.array(z.object({
      name: z.string().min(1),
      role: z.string().min(1),
    })),
  }).optional(),
  disclosures: z.object({
    aiAssisted: z.boolean(),
    automatedAudioAudit: z.literal(true),
    cast: z.array(z.string().min(1)),
    voices: z.array(z.object({
      role: z.string().min(1),
      providerId: z.string().min(1),
      voiceId: z.string().min(1),
      use: z.string().min(1).optional(),
    })),
    musicCues: z.array(z.object({
      id: z.string().min(1),
      action: z.enum(["silence", "asset"]),
      assetId: z.string().min(1).optional(),
    })),
    rights: z.object({ audio: z.unknown(), cover: z.unknown() }),
  }),
  checksums: z.object({
    audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
    coverSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  audioAuditArtifactVersionId: z.string().min(1),
}).superRefine((value, context) => {
  let previousEnd = 0;
  value.chapters.forEach((chapter, index) => {
    if (chapter.startSeconds < previousEnd) {
      context.addIssue({ code: "custom", path: ["chapters", index, "startSeconds"], message: "章节时间轴不能重叠或倒退" });
    }
    const chapterEnd = chapter.startSeconds + chapter.durationSeconds;
    if (chapterEnd > value.audio.durationSeconds + 1) {
      context.addIssue({ code: "custom", path: ["chapters", index, "durationSeconds"], message: "章节不能越过发行母带结尾" });
    }
    previousEnd = chapterEnd;
  });
});

const RegisterPublicationBaseSchema = z.object({
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/),
  platform: z.string().trim().min(1).max(80),
});

export const RegisterPublicationInputSchema = z.discriminatedUnion("status", [
  RegisterPublicationBaseSchema.extend({
    status: z.literal("published"),
    externalEpisodeId: z.string().trim().min(1).max(240),
    episodeUrl: z.string().url().startsWith("https://"),
    channelUrl: z.string().url().startsWith("https://").optional(),
    publishedAt: z.string().datetime(),
  }),
  RegisterPublicationBaseSchema.extend({
    status: z.literal("failed"),
    attemptedAt: z.string().datetime(),
    failureReason: z.string().trim().min(3).max(1_000),
  }),
]);

export const RegisterPublicationResponseSchema = z.object({
  run: WorkflowRunSchema,
  opportunity: EpisodeOpportunitySchema.optional(),
  record: PublicationRecordSchema,
});

export const VoiceCatalogSchema = z.object({
  providerId: z.literal("elevenlabs-v3"),
  configured: z.boolean(),
  voices: z.array(z.object({
    voiceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    name: z.string().min(1).max(160),
    category: z.string().max(80).optional(),
    description: z.string().max(500).optional(),
    previewUrl: z.string().url().startsWith("https://").optional(),
    labels: z.record(z.string(), z.string().max(160)).default({}),
  })).max(100),
  warning: z.string().max(500).optional(),
});

export const MusicAssetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  mediaUrl: z.string().startsWith("/media/music-library/"),
  mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/mp4"]),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationSeconds: z.number().positive().optional(),
  mood: z.enum(["curious", "reflective", "warm", "tense", "neutral"]),
  energy: z.number().int().min(1).max(5),
  bpm: z.number().int().min(40).max(240).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  license: z.object({
    basis: z.enum(["owned", "commissioned", "cc0", "royalty_free", "other"]),
    commercialUseConfirmed: z.literal(true),
    sourceUrl: z.string().url().startsWith("https://").optional(),
    confirmedAt: z.string().datetime(),
  }),
  addedAt: z.string().datetime(),
});

export const MusicLibrarySchema = z.object({
  assets: z.array(MusicAssetSchema),
});

export const AddMusicAssetMetadataSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mood: z.enum(["curious", "reflective", "warm", "tense", "neutral"]),
  energy: z.coerce.number().int().min(1).max(5),
  bpm: z.union([z.coerce.number().int().min(40).max(240), z.literal("")]).optional(),
  tags: z.string().max(480).optional(),
  licenseBasis: z.enum(["owned", "commissioned", "cc0", "royalty_free", "other"]),
  sourceUrl: z.union([z.string().url().startsWith("https://"), z.literal("")]).optional(),
  commercialUseConfirmed: z.union([z.literal(true), z.literal("true")]),
}).superRefine((value, context) => {
  if (["cc0", "royalty_free", "other"].includes(value.licenseBasis) && !value.sourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "外部音乐必须登记 HTTPS 来源链接" });
  }
});

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});

export { WorkflowRunSchema };
export type StudioBootstrap = StudioSnapshot & { mutationToken?: string };
export type CreateSeriesInput = z.infer<typeof CreateSeriesInputSchema>;
export type ReviseArtifactInput = z.infer<typeof ReviseArtifactInputSchema>;
export type CandidateInbox = z.infer<typeof CandidateInboxSchema>;
export type AdoptCandidateResponse = z.infer<typeof AdoptCandidateResponseSchema>;
export type CreateCustomOpportunityInput = z.infer<typeof CreateCustomOpportunityInputSchema>;
export type StartEpisodeInput = z.infer<typeof StartEpisodeInputSchema>;
export type StartEpisodeResponse = z.infer<typeof StartEpisodeResponseSchema>;
export type NodeExecutionPreview = z.infer<typeof NodeExecutionPreviewSchema>;
export type AuthorizeNodeSpendInput = z.infer<typeof AuthorizeNodeSpendInputSchema>;
export type ExecuteNodeInput = z.infer<typeof ExecuteNodeInputSchema>;
export type AgentLoopResult = z.infer<typeof AgentLoopResultSchema>;
export type ReconcileExecutionCostInput = z.infer<typeof ReconcileExecutionCostInputSchema>;
export type ReleaseRightsBasis = z.infer<typeof ReleaseRightsBasisSchema>;
export type ReleasePackage = z.infer<typeof ReleasePackageSchema>;
export type RegisterPublicationInput = z.infer<typeof RegisterPublicationInputSchema>;
export type RegisterPublicationResponse = z.infer<typeof RegisterPublicationResponseSchema>;
export type RegisterReleaseMasterMetadata = z.infer<typeof RegisterReleaseMasterMetadataSchema>;
export type RegisterCoverMetadata = z.infer<typeof RegisterCoverMetadataSchema>;
export type SelectCoverInput = z.infer<typeof SelectCoverInputSchema>;
export type VoiceCatalog = z.infer<typeof VoiceCatalogSchema>;
export type MusicAsset = z.infer<typeof MusicAssetSchema>;
export type MusicLibrary = z.infer<typeof MusicLibrarySchema>;
export type AddMusicAssetMetadata = z.infer<typeof AddMusicAssetMetadataSchema>;
export type { SeriesBible, WorkflowRun };

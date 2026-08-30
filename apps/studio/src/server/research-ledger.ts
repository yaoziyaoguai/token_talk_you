import { z } from "zod";
import { deriveProvenanceGroup } from "../shared/research.js";

const HumanVerifiedResearchSourceSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "来源必须使用 HTTPS"),
  verificationStatus: z.literal("verified"),
  verifiedBy: z.string().trim().min(1),
  verifiedAt: z.string().datetime(),
  provenanceGroup: z.string().trim().min(1),
  verificationMethod: z.literal("server_action"),
  publisher: z.string().trim().min(1).optional(),
  publishedAt: z.string().trim().min(1).optional(),
}).passthrough();

const MachineCheckedResearchSourceBaseSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "来源必须使用 HTTPS"),
  verificationStatus: z.literal("machine_checked"),
  machineCheckedAt: z.string().datetime(),
  provenanceGroup: z.string().trim().min(1),
  responseContentType: z.string().trim().min(1),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  publisher: z.string().trim().min(1).optional(),
  publishedAt: z.string().trim().min(1).optional(),
}).passthrough();

const SafeHttpsResearchSourceSchema = MachineCheckedResearchSourceBaseSchema.extend({
  verificationMethod: z.literal("safe_https_metadata"),
});

const PublicApiResearchSourceSchema = MachineCheckedResearchSourceBaseSchema.extend({
  verificationMethod: z.literal("public_api_metadata"),
  sourceKind: z.enum(["scholarly_metadata", "book_metadata"]),
  providerId: z.enum(["arxiv-public", "crossref-public", "openalex-public", "open-library-public"]),
  responseContentType: z.enum([
    "application/vnd.token-talk.public-scholarly-metadata+json",
    "application/vnd.token-talk.public-book-metadata+json",
  ]),
});

const TrustedResearchSourceSchema = z.union([
  HumanVerifiedResearchSourceSchema,
  SafeHttpsResearchSourceSchema,
  PublicApiResearchSourceSchema,
]);

export interface ResearchPacketReview {
  ready: boolean;
  verifiedIndependentSourceCount: number;
  verifiedSourceIds: Set<string>;
  verifiedSources: Array<z.infer<typeof TrustedResearchSourceSchema>>;
}

export function reviewResearchPacket(value: unknown): ResearchPacketReview {
  const packet = asRecord(value);
  const independentSources = new Map<string, z.infer<typeof TrustedResearchSourceSchema>>();
  const trustedSources: Array<z.infer<typeof TrustedResearchSourceSchema>> = [];
  const sourceIds = new Set<string>();
  const sourceUrls = new Set<string>();
  const sourceTitles = new Set<string>();
  for (const source of asArray(packet.sources)) {
    const parsed = TrustedResearchSourceSchema.safeParse(source);
    if (!parsed.success) continue;
    const sourceUrl = canonicalSourceUrl(parsed.data.url);
    const sourceTitle = canonicalSourceTitle(parsed.data.title);
    if (sourceIds.has(parsed.data.id) || sourceUrls.has(sourceUrl) || sourceTitles.has(sourceTitle)) continue;
    const key = trustedProvenanceGroup(parsed.data);
    if (!key) continue;
    if (parsed.data.provenanceGroup !== key) continue;
    sourceIds.add(parsed.data.id);
    sourceUrls.add(sourceUrl);
    sourceTitles.add(sourceTitle);
    trustedSources.push(parsed.data);
    if (!independentSources.has(key)) independentSources.set(key, parsed.data);
  }
  const verifiedSourceIds = new Set(trustedSources.map((source) => source.id));
  const verifiedSources = trustedSources;
  const verifiedIndependentSourceCount = independentSources.size;
  return {
    ready: ["verified", "machine_checked"].includes(String(packet.status)) && verifiedIndependentSourceCount >= 2,
    verifiedIndependentSourceCount,
    verifiedSourceIds,
    verifiedSources,
  };
}

function canonicalSourceTitle(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9\p{L}]+/gu, " ").trim();
}

export function sanitizeResearchPacketRevision(value: unknown, currentValue: unknown): Record<string, unknown> {
  const packet = structuredClone(asRecord(value));
  assertUniqueSourceIdentity(asArray(packet.sources));
  const currentSources = new Map(asArray(asRecord(currentValue).sources).flatMap((value) => {
    const source = asRecord(value);
    return typeof source.id === "string" ? [[source.id, source] as const] : [];
  }));
  packet.sources = asArray(packet.sources).map((value) => {
    const source = { ...asRecord(value) };
    const trusted = typeof source.id === "string" ? currentSources.get(source.id) : undefined;
    const canPreserveReview = trusted
      && ["server_action", "safe_https_metadata", "public_api_metadata"].includes(String(trusted.verificationMethod))
      && ["verified", "machine_checked"].includes(String(trusted.verificationStatus))
      && typeof source.url === "string"
      && typeof trusted.url === "string"
      && sameCanonicalUrl(source.url, trusted.url)
      && (trusted.verificationMethod !== "public_api_metadata"
        || (source.providerId === trusted.providerId
          && source.publisher === trusted.publisher
          && source.sourceKind === trusted.sourceKind));
    clearVerification(source);
    if (canPreserveReview) {
      source.provenanceGroup = trusted.provenanceGroup;
      source.verificationStatus = trusted.verificationStatus;
      source.verificationMethod = trusted.verificationMethod;
      if (trusted.verificationMethod === "server_action") {
        source.verifiedBy = trusted.verifiedBy;
        source.verifiedAt = trusted.verifiedAt;
      } else {
        source.machineCheckedAt = trusted.machineCheckedAt;
        source.responseContentType = trusted.responseContentType;
        source.responseSha256 = trusted.responseSha256;
      }
    }
    return source;
  });
  return normalizePacketStatus(packet);
}

export function setResearchSourceVerification(
  value: unknown,
  sourceId: string,
  verified: boolean,
  now: string,
): Record<string, unknown> {
  const packet = structuredClone(asRecord(value));
  assertUniqueSourceIdentity(asArray(packet.sources));
  let found = false;
  packet.sources = asArray(packet.sources).map((value) => {
    const source = { ...asRecord(value) };
    if (source.id !== sourceId) return source;
    found = true;
    clearVerification(source);
    if (!verified) return source;
    if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
      throw new Error("只有 HTTPS 来源可以标记为已核验。");
    }
    source.verificationStatus = "verified";
    source.verifiedBy = "本地主编";
    source.verifiedAt = now;
    const provenanceGroup = deriveProvenanceGroup(source.url);
    if (!provenanceGroup) throw new Error("来源 URL 无法形成独立来源分组。");
    source.provenanceGroup = provenanceGroup;
    source.verificationMethod = "server_action";
    return source;
  });
  if (!found) throw new Error(`Source '${sourceId}' was not found`);
  return normalizePacketStatus(packet);
}

function normalizePacketStatus(packet: Record<string, unknown>): Record<string, unknown> {
  const review = reviewResearchPacket({ ...packet, status: "machine_checked" });
  packet.verifiedIndependentSourceCount = review.verifiedIndependentSourceCount;
  const trustedSources = asArray(packet.sources).filter((source) => TrustedResearchSourceSchema.safeParse(source).success);
  const allHumanVerified = trustedSources.length >= 2 && trustedSources.every((source) => asRecord(source).verificationStatus === "verified");
  packet.status = review.verifiedIndependentSourceCount >= 2 ? allHumanVerified ? "verified" : "machine_checked" : "needs_research";
  return packet;
}

function clearVerification(source: Record<string, unknown>): void {
  source.verificationStatus = "unverified";
  delete source.verifiedBy;
  delete source.verifiedAt;
  delete source.machineCheckedAt;
  delete source.responseContentType;
  delete source.responseSha256;
  delete source.provenanceGroup;
  delete source.verificationMethod;
}

function trustedProvenanceGroup(source: z.infer<typeof TrustedResearchSourceSchema>): string | undefined {
  if (source.verificationMethod !== "public_api_metadata") return deriveProvenanceGroup(source.url);
  const record = source as typeof source & { authors?: unknown };
  const authors = Array.isArray(record.authors) ? record.authors.filter((author): author is string => typeof author === "string") : [];
  const authorTeam = source.sourceKind === "scholarly_metadata"
    ? authors.slice(0, 3).map((author) => author.trim().toLowerCase()
      .replace(/[^a-z0-9\p{L}]+/gu, "-").replace(/^-|-$/g, "")).filter(Boolean).join("+")
    : "";
  if (authorTeam) return `authors:${authorTeam}`;
  const publisher = source.publisher?.trim().toLowerCase()
    .replace(/[^a-z0-9\p{L}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return publisher ? `publisher:${publisher}` : `provider:${source.providerId}`;
}

function assertUniqueSourceIdentity(values: unknown[]): void {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const value of values) {
    const source = asRecord(value);
    if (typeof source.id === "string" && source.id.trim()) {
      const id = source.id.trim();
      if (ids.has(id)) throw new Error(`资料来源 ID“${id}”重复，请先合并或重新编号。`);
      ids.add(id);
    }
    if (typeof source.url !== "string") continue;
    try {
      const url = canonicalSourceUrl(source.url);
      if (urls.has(url)) throw new Error("资料来源 URL 重复，请保留一条规范记录。");
      urls.add(url);
    } catch (error) {
      if (error instanceof Error && error.message.includes("重复")) throw error;
    }
  }
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sameCanonicalUrl(left: string, right: string): boolean {
  try {
    return canonicalSourceUrl(left) === canonicalSourceUrl(right);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

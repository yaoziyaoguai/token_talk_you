import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { deriveProvenanceGroup } from "../shared/research.js";
import { canonicalizeHttpsUrl, type ResearchSource } from "./research-gateway.js";

const MAX_METADATA_BYTES = 256 * 1024;

export interface SourceVerificationCheck {
  sourceId: string;
  url: string;
  status: "checked" | "failed";
  checkedAt: string;
  verificationMethod?: "safe_https_metadata" | "public_api_metadata";
  provenanceGroup?: string;
  responseContentType?: string;
  responseSha256?: string;
  pageTitle?: string;
  excerpt?: string;
  error?: string;
}

export interface ResearchSourceVerifier {
  verify(sources: ResearchSource[], signal?: AbortSignal): Promise<SourceVerificationCheck[]>;
}

export class SafeHttpsSourceVerifier implements ResearchSourceVerifier {
  constructor(
    private readonly now: () => string,
    private readonly options: { timeoutMs?: number; userAgent?: string } = {},
  ) {}

  async verify(sources: ResearchSource[], signal?: AbortSignal): Promise<SourceVerificationCheck[]> {
    const unique = [...new Map(sources.map((source) => [source.id, source])).values()].slice(0, 8);
    return await Promise.all(unique.map(async (source): Promise<SourceVerificationCheck> => {
      const checkedAt = this.now();
      try {
        const metadata = await readPublicHttpsMetadata(
          source.url,
          signal,
          this.options.timeoutMs ?? 8_000,
          this.options.userAgent ?? "TokenTalk/0.1 (automated source metadata verification)",
        );
        const provenanceGroup = deriveProvenanceGroup(source.url);
        if (!provenanceGroup) throw new Error("来源 URL 无法形成独立来源分组");
        return {
          sourceId: source.id,
          url: source.url,
          status: "checked",
          checkedAt,
          provenanceGroup,
          ...metadata,
        };
      } catch (error) {
        return {
          sourceId: source.id,
          url: source.url,
          status: "failed",
          checkedAt,
          error: safeMessage(error),
        };
      }
    }));
  }
}

export class StaticSourceVerifier implements ResearchSourceVerifier {
  constructor(private readonly checks: SourceVerificationCheck[]) {}

  async verify(): Promise<SourceVerificationCheck[]> {
    return this.checks;
  }
}

async function readPublicHttpsMetadata(
  rawUrl: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  userAgent: string,
): Promise<Pick<SourceVerificationCheck, "responseContentType" | "responseSha256" | "pageTitle" | "excerpt">> {
  const canonical = canonicalizeHttpsUrl(rawUrl);
  if (!canonical) throw new Error("只允许 HTTPS 来源");
  const url = new URL(canonical);
  if (url.username || url.password || !url.hostname) throw new Error("来源 URL 不能包含账号信息");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const target = addresses.find((address) => isPublicAddress(address.address));
  if (!target) throw new Error("来源域名没有可访问的公网地址");
  return await requestPinnedHttps(url, target.address, target.family, parentSignal, timeoutMs, userAgent);
}

function requestPinnedHttps(
  url: URL,
  address: string,
  family: number,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  userAgent: string,
): Promise<Pick<SourceVerificationCheck, "responseContentType" | "responseSha256" | "pageTitle" | "excerpt">> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => request.destroy(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error("来源核验已取消"));
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        "user-agent": userAgent,
      },
      lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        const all = Boolean(options && typeof options === "object" && "all" in options && options.all === true);
        if (all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as never,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        finish(() => reject(new Error(`来源返回 HTTP ${statusCode}；自动核验不跟随跳转`)));
        return;
      }
      if (!isReadableMetadataType(contentType)) {
        response.resume();
        finish(() => reject(new Error("来源未返回可读取的 HTML 或文本元数据")));
        return;
      }
      if (Number.isFinite(contentLength) && contentLength > MAX_METADATA_BYTES) {
        response.resume();
        finish(() => reject(new Error("来源元数据响应超过 256KB 上限")));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_METADATA_BYTES) request.destroy(new Error("来源元数据响应超过 256KB 上限"));
        else chunks.push(chunk);
      });
      response.once("error", (error) => finish(() => reject(error)));
      response.once("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const metadata = extractMetadata(body);
        finish(() => resolve({
          responseContentType: contentType,
          responseSha256: createHash("sha256").update(body).digest("hex"),
          ...(metadata.pageTitle ? { pageTitle: metadata.pageTitle } : {}),
          ...(metadata.excerpt ? { excerpt: metadata.excerpt } : {}),
        }));
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error(`来源核验超过 ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
    request.once("error", (error) => finish(() => reject(error)));
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    request.end();
  });
}

function isReadableMetadataType(value: string): boolean {
  return value.includes("text/html") || value.includes("application/xhtml+xml") || value.includes("text/plain");
}

function extractMetadata(value: string): { pageTitle?: string; excerpt?: string } {
  const pageTitle = cleanHtml(extractTag(value, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const description = cleanHtml(extractTag(value, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    ?? extractTag(value, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i));
  return {
    ...(pageTitle ? { pageTitle } : {}),
    ...(description ? { excerpt: description } : {}),
  };
}

function extractTag(value: string, expression: RegExp): string | undefined {
  return expression.exec(value)?.[1];
}

function cleanHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/<[^>]+>/g, " ").replace(/&(?:quot|amp|lt|gt|#39);/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 600) : undefined;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [first = 0, second = 0] = octets;
    return first > 0
      && first < 224
      && first !== 10
      && first !== 127
      && !(first === 100 && second >= 64 && second <= 127)
      && !(first === 169 && second === 254)
      && !(first === 172 && second >= 16 && second <= 31)
      && !(first === 192 && second === 168)
      && !(first === 192 && second === 0)
      && !(first === 192 && second === 2)
      && !(first === 198 && (second === 18 || second === 19 || second === 51))
      && !(first === 203 && second === 0);
  }
  if (version !== 6) return false;
  const parsed = parseIpv6(address);
  if (parsed === undefined || !isIpv6Prefix(parsed, "2000::", 3)) return false;
  return !isIpv6Prefix(parsed, "2001::", 32)
    && !isIpv6Prefix(parsed, "2001:2::", 48)
    && !isIpv6Prefix(parsed, "2001:db8::", 32)
    && !isIpv6Prefix(parsed, "2002::", 16);
}

function parseIpv6(address: string): bigint | undefined {
  if (address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const embedded = normalized.slice(separator + 1);
    if (separator < 0 || isIP(embedded) !== 4) return undefined;
    const octets = embedded.split(".").map(Number);
    normalized = `${normalized.slice(0, separator)}:${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
  }
  if (normalized.indexOf("::") !== normalized.lastIndexOf("::")) return undefined;
  const [left = "", right = ""] = normalized.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const parts = normalized.includes("::")
    ? [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
    : leftParts;
  if (parts.length !== 8 || missing < 0 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function isIpv6Prefix(address: bigint, base: string, prefixLength: number): boolean {
  const parsedBase = parseIpv6(base);
  if (parsedBase === undefined) return false;
  const shift = BigInt(128 - prefixLength);
  return address >> shift === parsedBase >> shift;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "来源核验失败").replace(/\s+/g, " ").slice(0, 300);
}

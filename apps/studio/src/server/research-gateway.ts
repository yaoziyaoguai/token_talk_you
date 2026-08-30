import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export interface ResearchQuery {
  query: string;
  maxResultsPerProvider: number;
  sourceKinds?: Array<"scholarly" | "primary" | "book" | "web">;
}

export interface ResearchSourceDraft {
  title: string;
  url: string;
  providerId: string;
  providerLabel: string;
  sourceKind: "encyclopedia" | "scholarly_metadata" | "book_metadata" | "web";
  verificationStatus: "unverified";
  publishedAt?: string;
  publisher?: string;
  authors?: string[];
  excerpt?: string;
}

export interface ResearchSource extends ResearchSourceDraft {
  id: string;
  discoveredAt: string;
}

export interface ResearchProviderAttempt {
  providerId: string;
  providerLabel: string;
  billing: "free";
  status: "succeeded" | "failed";
  resultCount: number;
  query?: string;
  error?: string;
}

export interface ResearchSearchResult {
  sources: ResearchSource[];
  attempts: ResearchProviderAttempt[];
}

export interface ResearchProvider {
  id: string;
  label: string;
  billing: "free";
  search(query: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]>;
}

export interface ResearchSearchGateway {
  search(query: ResearchQuery, signal?: AbortSignal): Promise<ResearchSearchResult>;
}

export class FreeResearchGateway implements ResearchSearchGateway {
  constructor(
    private readonly providers: ResearchProvider[],
    private readonly now: () => string,
  ) {}

  async search(query: ResearchQuery, signal?: AbortSignal): Promise<ResearchSearchResult> {
    const settled = await Promise.allSettled(this.providers.map((provider) => provider.search(query, signal)));
    const attempts: ResearchProviderAttempt[] = [];
    const sources: ResearchSource[] = [];

    settled.forEach((result, index) => {
      const provider = this.providers[index];
      if (!provider) return;
      if (result.status === "rejected") {
        attempts.push({
          providerId: provider.id,
          providerLabel: provider.label,
          billing: provider.billing,
          status: "failed",
          resultCount: 0,
          error: errorMessage(result.reason),
        });
        return;
      }
      const valid = result.value.flatMap((source) => normalizeSource(source, this.now()));
      attempts.push({
        providerId: provider.id,
        providerLabel: provider.label,
        billing: provider.billing,
        status: "succeeded",
        resultCount: valid.length,
      });
      sources.push(...valid);
    });

    return { sources: deduplicateSources(sources), attempts };
  }
}

interface HttpProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  contactEmail?: string;
}

export class WikipediaResearchProvider implements ResearchProvider {
  readonly id = "wikipedia-zh";
  readonly label = "中文维基百科";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!hasContactIdentity(options.userAgent)) {
      throw new Error("Wikipedia research requires TOKEN_TALK_RESEARCH_USER_AGENT with a contact URL or email");
    }
    this.userAgent = options.userAgent;
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "web")) return [];
    const url = new URL("https://zh.wikipedia.org/w/rest.php/v1/search/page");
    url.searchParams.set("q", conciseTopicQuery(input.query));
    url.searchParams.set("limit", String(clampResults(input.maxResultsPerProvider)));
    const payload = WikipediaResponseSchema.parse(await fetchJson(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent));
    return payload.pages.flatMap((value) => {
      const page = asRecord(value);
      const title = cleanString(page.title);
      const key = cleanString(page.key) ?? title?.replaceAll(" ", "_");
      if (!title || !key) return [];
      const description = cleanString(page.description);
      return [{
        title,
        url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(key)}`,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "encyclopedia" as const,
        verificationStatus: "unverified" as const,
        publisher: "Wikimedia Foundation",
        ...(description ? { excerpt: description } : {}),
      }];
    });
  }
}

export class CrossrefResearchProvider implements ResearchProvider {
  readonly id = "crossref-public";
  readonly label = "Crossref 公共元数据";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly contactEmail: string | undefined;
  private readonly requestPacer = new RequestPacer(1_000);

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent = options.userAgent?.trim() || "TokenTalk/0.1 (local podcast research workspace)";
    this.contactEmail = options.contactEmail?.trim() || undefined;
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "scholarly", "primary")) return [];
    await this.requestPacer.wait(signal);
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", discoveryQuery(input.query));
    url.searchParams.set("rows", String(clampResults(input.maxResultsPerProvider)));
    url.searchParams.set("select", "DOI,title,author,published,publisher,container-title,type,URL,abstract");
    if (this.contactEmail) url.searchParams.set("mailto", this.contactEmail);
    const payload = CrossrefResponseSchema.parse(await fetchJson(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent));
    return payload.message.items.flatMap((value) => {
      const item = asRecord(value);
      const title = firstString(item.title);
      const doi = cleanString(item.DOI);
      const sourceUrl = canonicalizeHttpsUrl(cleanString(item.URL)) ?? (doi ? canonicalizeHttpsUrl(`https://doi.org/${doi}`) : undefined);
      if (!title || !sourceUrl) return [];
      const authors = asArray(item.author).flatMap((author) => {
        const record = asRecord(author);
        const name = [cleanString(record.given), cleanString(record.family)].filter(Boolean).join(" ");
        return name ? [name] : [];
      });
      const publisher = cleanString(item.publisher) ?? firstString(item["container-title"]);
      const publishedAt = crossrefDate(item.published);
      const excerpt = cleanAbstract(item.abstract);
      return [{
        title,
        url: sourceUrl,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "scholarly_metadata" as const,
        verificationStatus: "unverified" as const,
        ...(publishedAt ? { publishedAt } : {}),
        ...(publisher ? { publisher } : {}),
        ...(authors.length > 0 ? { authors } : {}),
        ...(excerpt ? { excerpt } : {}),
      }];
    });
  }
}

export class OpenAlexResearchProvider implements ResearchProvider {
  readonly id = "openalex-public";
  readonly label = "OpenAlex 论文索引";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent = options.userAgent?.trim() || "TokenTalk/0.1 (local podcast research workspace)";
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "scholarly", "primary")) return [];
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", discoveryQuery(input.query));
    url.searchParams.set("per-page", String(clampResults(input.maxResultsPerProvider)));
    url.searchParams.set("select", "id,doi,display_name,publication_date,authorships,primary_location,open_access,abstract_inverted_index");
    const payload = OpenAlexResponseSchema.parse(await fetchJson(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent));
    return payload.results.flatMap((value) => {
      const item = asRecord(value);
      const title = cleanString(item.display_name);
      const sourceUrl = canonicalizeHttpsUrl(cleanString(item.doi)) ?? canonicalizeHttpsUrl(cleanString(item.id));
      if (!title || !sourceUrl) return [];
      const authors = asArray(item.authorships).flatMap((authorship) => {
        const author = asRecord(asRecord(authorship).author);
        const name = cleanString(author.display_name);
        return name ? [name] : [];
      });
      const location = asRecord(item.primary_location);
      const publisher = cleanString(asRecord(location.source).display_name);
      const publishedAt = isoDate(cleanString(item.publication_date));
      const excerpt = openAlexAbstract(item.abstract_inverted_index);
      return [{
        title,
        url: sourceUrl,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "scholarly_metadata" as const,
        verificationStatus: "unverified" as const,
        ...(publishedAt ? { publishedAt } : {}),
        ...(publisher ? { publisher } : {}),
        ...(authors.length > 0 ? { authors } : {}),
        ...(excerpt ? { excerpt } : {}),
      }];
    });
  }
}

export class ArxivResearchProvider implements ResearchProvider {
  readonly id = "arxiv-public";
  readonly label = "arXiv 开放论文";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly requestPacer = new RequestPacer(3_000);

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.userAgent = options.userAgent?.trim() || "TokenTalk/0.1 (local podcast research workspace)";
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "scholarly", "primary")) return [];
    const searchQuery = arxivQuery(input.query);
    if (!searchQuery) return [];
    await this.requestPacer.wait(signal);
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", searchQuery);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(clampResults(input.maxResultsPerProvider)));
    url.searchParams.set("sortBy", "relevance");
    const xml = await fetchText(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent, ["application/atom+xml", "application/xml", "text/xml"]);
    const parsed = ArxivResponseSchema.parse(new XMLParser({ ignoreAttributes: false }).parse(xml));
    const feed = asRecord(parsed.feed);
    const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    return entries.flatMap((value) => {
      const entry = asRecord(value);
      const title = cleanString(entry.title)?.replace(/\s+/g, " ");
      const url = arxivAbsUrl(cleanString(entry.id));
      if (!title || !url) return [];
      const authors = (Array.isArray(entry.author) ? entry.author : entry.author ? [entry.author] : [])
        .flatMap((author) => cleanString(asRecord(author).name) ?? []);
      const publishedAt = isoDate(cleanString(entry.published));
      const excerpt = cleanAbstract(entry.summary);
      return [{
        title,
        url,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "scholarly_metadata" as const,
        verificationStatus: "unverified" as const,
        publisher: "arXiv",
        ...(publishedAt ? { publishedAt } : {}),
        ...(authors.length > 0 ? { authors } : {}),
        ...(excerpt ? { excerpt } : {}),
      }];
    });
  }
}

export class OpenLibraryResearchProvider implements ResearchProvider {
  readonly id = "open-library-public";
  readonly label = "Open Library 图书目录";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.userAgent = options.userAgent?.trim() || "TokenTalk/0.1 (local podcast research workspace)";
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "book")) return [];
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("q", conciseTopicQuery(input.query));
    url.searchParams.set("limit", String(clampResults(input.maxResultsPerProvider)));
    url.searchParams.set("fields", "key,title,author_name,first_publish_year,edition_count,has_fulltext,public_scan_b");
    const payload = OpenLibraryResponseSchema.parse(await fetchJson(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent));
    return payload.docs.flatMap((value) => {
      const item = asRecord(value);
      const title = cleanString(item.title);
      const key = cleanString(item.key);
      if (!title || !key) return [];
      const path = key.startsWith("/") ? key : `/works/${key}`;
      const sourceUrl = canonicalizeHttpsUrl(`https://openlibrary.org${path}`);
      if (!sourceUrl) return [];
      const authors = asArray(item.author_name).flatMap((author) => cleanString(author) ?? []);
      const year = Number(item.first_publish_year);
      const publishedAt = Number.isInteger(year) && year >= 1000 && year <= 9999 ? `${year}-01-01` : undefined;
      const editionCount = Number(item.edition_count);
      const hasFullText = item.has_fulltext === true;
      const hasPublicScan = item.public_scan_b === true;
      const access = hasPublicScan ? "存在公共扫描版本" : hasFullText ? "目录标记为有全文版本" : "仅确认书目与版本记录";
      const excerpt = `${Number.isInteger(editionCount) && editionCount > 0 ? `Open Library 目录收录 ${editionCount} 个版本；` : ""}${access}`;
      return [{
        title,
        url: sourceUrl,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "book_metadata" as const,
        verificationStatus: "unverified" as const,
        publisher: "Open Library / Internet Archive",
        ...(publishedAt ? { publishedAt } : {}),
        ...(authors.length > 0 ? { authors } : {}),
        ...(excerpt ? { excerpt } : {}),
      }];
    });
  }
}

export class HackerNewsResearchProvider implements ResearchProvider {
  readonly id = "hacker-news-public";
  readonly label = "Hacker News 公开索引";
  readonly billing = "free" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.userAgent = options.userAgent?.trim() || "TokenTalk/0.1 (local podcast research workspace)";
  }

  async search(input: ResearchQuery, signal?: AbortSignal): Promise<ResearchSourceDraft[]> {
    if (!acceptsSourceKind(input, "web")) return [];
    const limit = clampResults(input.maxResultsPerProvider);
    const queries = discoveryPhrases(input.query).slice(0, 2);
    const focusedQueries = queries.length > 0 ? queries : [conciseTopicQuery(input.query)];
    const resultsPerQuery = Math.max(2, Math.ceil(limit / focusedQueries.length));
    const payloads = await Promise.all(focusedQueries.map(async (query) => {
      const url = new URL("https://hn.algolia.com/api/v1/search");
      url.searchParams.set("query", query);
      url.searchParams.set("tags", "story");
      url.searchParams.set("hitsPerPage", String(resultsPerQuery));
      return HackerNewsResponseSchema.parse(await fetchJson(this.fetchImpl, url, this.timeoutMs, signal, this.userAgent));
    }));
    const sources = payloads.flatMap((payload) => payload.hits).flatMap((value) => {
      const hit = asRecord(value);
      const title = cleanString(hit.title) ?? cleanString(hit.story_title);
      const sourceUrl = canonicalizeHttpsUrl(cleanString(hit.url) ?? cleanString(hit.story_url));
      if (!title || !sourceUrl) return [];
      const publishedAt = isoDate(cleanString(hit.created_at));
      return [{
        title,
        url: sourceUrl,
        providerId: this.id,
        providerLabel: this.label,
        sourceKind: "web" as const,
        verificationStatus: "unverified" as const,
        publisher: new URL(sourceUrl).hostname.replace(/^www\./, ""),
        ...(publishedAt ? { publishedAt } : {}),
      }];
    });
    return [...new Map(sources.map((source) => [source.url, source])).values()].slice(0, limit);
  }
}

export function createDefaultFreeResearchGateway(
  now: () => string,
  environment: NodeJS.ProcessEnv = process.env,
): FreeResearchGateway {
  const userAgent = environment.TOKEN_TALK_RESEARCH_USER_AGENT?.trim();
  const contactEmail = environment.TOKEN_TALK_RESEARCH_CONTACT_EMAIL?.trim();
  const providers: ResearchProvider[] = [
    new OpenLibraryResearchProvider({ ...(userAgent ? { userAgent } : {}) }),
    new ArxivResearchProvider({ ...(userAgent ? { userAgent } : {}) }),
    new OpenAlexResearchProvider({ ...(userAgent ? { userAgent } : {}) }),
    new HackerNewsResearchProvider({ ...(userAgent ? { userAgent } : {}) }),
    new CrossrefResearchProvider({ ...(userAgent ? { userAgent } : {}), ...(contactEmail ? { contactEmail } : {}) }),
  ];
  if (hasContactIdentity(userAgent)) providers.unshift(new WikipediaResearchProvider({ userAgent }));
  return new FreeResearchGateway(providers, now);
}

const WikipediaResponseSchema = z.object({
  pages: z.array(z.unknown()),
});

const CrossrefResponseSchema = z.object({
  message: z.object({
    items: z.array(z.unknown()),
  }),
});

const OpenAlexResponseSchema = z.object({
  results: z.array(z.unknown()),
});

const ArxivResponseSchema = z.object({
  feed: z.record(z.string(), z.unknown()),
});

const OpenLibraryResponseSchema = z.object({
  docs: z.array(z.unknown()),
});

const HackerNewsResponseSchema = z.object({
  hits: z.array(z.unknown()),
});

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  userAgent: string,
): Promise<unknown> {
  return JSON.parse(await fetchText(fetchImpl, url, timeoutMs, parentSignal, userAgent, ["application/json"])) as unknown;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  userAgent: string,
  acceptedContentTypes: string[],
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: acceptedContentTypes.join(", "),
        "user-agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.url && new URL(response.url).origin !== url.origin) throw new Error("响应越过固定知识源 origin");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!acceptedContentTypes.some((type) => contentType.includes(type))) throw new Error("知识源返回了不支持的内容类型");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("知识源响应超过 2MB 上限");
    return await readLimitedText(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`请求超过 ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

const MAX_RESPONSE_BYTES = 2_000_000;

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("知识源响应超过 2MB 上限");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function normalizeSource(source: ResearchSourceDraft, discoveredAt: string): ResearchSource[] {
  const title = cleanString(source.title);
  const url = canonicalizeHttpsUrl(source.url);
  if (!title || !url) return [];
  return [{
    ...source,
    id: `source-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
    title,
    url,
    discoveredAt,
    verificationStatus: "unverified",
  }];
}

function deduplicateSources(sources: ResearchSource[]): ResearchSource[] {
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export function canonicalizeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function crossrefDate(value: unknown): string | undefined {
  const parts = asArray(asRecord(value)["date-parts"])[0];
  if (!Array.isArray(parts)) return undefined;
  const [year, month = 1, day = 1] = parts;
  if (![year, month, day].every((part) => typeof part === "number" && Number.isInteger(part))) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : undefined;
}

function discoveryQuery(value: string): string {
  const normalized = trimmedQuery(value);
  const uniquePhrases = discoveryPhrases(normalized);
  return (uniquePhrases.length > 0 ? uniquePhrases.join(" ") : conciseTopicQuery(normalized)).slice(0, 160);
}

function arxivQuery(value: string): string | undefined {
  const words = value.toLowerCase().replace(/-/g, " ").match(/[a-z][a-z0-9+#.]{1,}/g) ?? [];
  const stop = new Set([
    "assessment", "controlled", "empirical", "experiment", "expertise", "field", "longitudinal",
    "outcomes", "research", "study", "trial",
  ]);
  const focused = words.filter((word) => !stop.has(word));
  const hasAi = focused.some((word) => AI_QUERY_TERMS.has(word));
  const anchors = focused.filter((word) => !AI_QUERY_TERMS.has(word)).slice(0, hasAi ? 2 : 3);
  if (hasAi) anchors.push("ai");
  const clauses = [...new Set(anchors)].map(arxivTermClause);
  return clauses.length >= 2 ? clauses.join(" AND ") : undefined;
}

const AI_QUERY_TERMS = new Set(["ai", "chatgpt", "copilot", "llm", "llms"]);

function arxivTermClause(term: string): string {
  if (term === "ai") return "(all:AI OR all:Copilot OR all:LLM OR all:ChatGPT)";
  if (["developer", "developers", "engineer", "engineers", "programmer", "programmers"].includes(term)) {
    return "(all:developer OR all:engineer OR all:programmer)";
  }
  if (["coding", "programming"].includes(term)) return "(all:coding OR all:programming)";
  return `all:${term.replace(/[^a-z0-9+#.]/g, "")}`;
}

function acceptsSourceKind(input: ResearchQuery, ...accepted: NonNullable<ResearchQuery["sourceKinds"]>): boolean {
  return !input.sourceKinds || input.sourceKinds.length === 0 || input.sourceKinds.some((kind) => accepted.includes(kind));
}

class RequestPacer {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delayMs = Math.max(0, this.nextStartAt - Date.now());
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      this.nextStartAt = Date.now() + this.intervalMs;
    } finally {
      release();
    }
  }
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("研究请求已取消");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("研究请求已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function arxivAbsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname !== "arxiv.org" || !url.pathname.startsWith("/abs/")) return undefined;
    url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function discoveryPhrases(value: string): string[] {
  const latinPhrases = trimmedQuery(value).match(/[A-Za-z][A-Za-z0-9+#.-]*(?:\s+[A-Za-z][A-Za-z0-9+#.-]*){0,3}/g)
    ?.map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 2);
  const normalized = [...new Map((latinPhrases ?? []).map((phrase) => [phrase.toLowerCase(), phrase])).values()];
  return normalized.filter((phrase, index) => !normalized.some((candidate, candidateIndex) =>
    candidateIndex !== index
      && candidate.split(/\s+/).length > phrase.split(/\s+/).length
      && candidate.toLowerCase().includes(phrase.toLowerCase()),
  ));
}

function openAlexAbstract(value: unknown): string | undefined {
  const index = asRecord(value);
  const words = Object.entries(index).flatMap(([word, positions]) => asArray(positions).flatMap((position) =>
    Number.isInteger(position) ? [{ word, position: Number(position) }] : [],
  ));
  words.sort((left, right) => left.position - right.position);
  return cleanAbstract(words.map((entry) => entry.word).join(" "));
}

function cleanAbstract(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 1_200) : undefined;
}

function conciseTopicQuery(value: string): string {
  const normalized = trimmedQuery(value);
  return (normalized.split(/[。！？?!]/u)[0]?.trim() || normalized).slice(0, 80);
}

function trimmedQuery(value: string): string {
  const query = value.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!query) throw new Error("研究问题不能为空");
  return query;
}

function clampResults(value: number): number {
  return Math.min(5, Math.max(1, Math.floor(value)));
}

function firstString(value: unknown): string | undefined {
  return asArray(value).flatMap((item) => cleanString(item) ?? []).at(0);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.slice(0, 300);
}

function hasContactIdentity(value: string | undefined): value is string {
  return Boolean(value && value.trim().length >= 12 && (/https?:\/\//.test(value) || /\S+@\S+/.test(value)));
}

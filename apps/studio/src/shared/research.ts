const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn", "com.au", "com.hk", "co.jp", "co.kr",
]);

export function inferProvenanceGroup(source: Record<string, unknown>): string | undefined {
  return typeof source.url === "string" ? deriveProvenanceGroup(source.url) : undefined;
}

export function deriveProvenanceGroup(value: string): string | undefined {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length <= 2) return `domain:${hostname}`;
    const suffix = labels.slice(-2).join(".");
    const registrable = COMMON_SECOND_LEVEL_SUFFIXES.has(suffix)
      ? labels.slice(-3).join(".")
      : suffix;
    return `domain:${registrable}`;
  } catch {
    return undefined;
  }
}

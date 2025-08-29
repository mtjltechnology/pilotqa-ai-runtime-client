export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function clamp<T>(v: T | undefined | null, d: T): T {
  return (v ?? d) as T;
}

export const escapeRegExp = (t: string) =>
  t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractJsonArray(raw: string): string {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return raw;
  return raw.slice(start, end + 1);
}

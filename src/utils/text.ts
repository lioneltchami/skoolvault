export function slugify(input: string, max = 80): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s || "untitled";
}

export function sanitizeFilename(input: string, max = 180): string {
  return (
    input
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max) || "untitled"
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));
  await sleep(ms);
}

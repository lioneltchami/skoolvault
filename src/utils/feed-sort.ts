/** Shared feed date helpers — kept out of extractors to avoid storage cycles. */

/** Parse Skool createdAt (ISO, unix s, or unix ms) → ISO string for sorting. */
export function normalizeCreatedAt(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  const s = String(raw);
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 1e9) {
    const ms = asNum > 1e12 ? asNum : asNum * 1000;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return s;
}

export function feedPostTimeMs(p: { createdAt?: string }): number {
  if (!p.createdAt) return 0;
  const t = Date.parse(p.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** Newest first by default. Missing dates sort last when newest. */
export function sortFeedPostsByDate<
  T extends { createdAt?: string; id: string },
>(posts: T[], order: "newest" | "oldest" = "newest"): T[] {
  const newest = order === "newest";
  return [...posts].sort((a, b) => {
    const ta = feedPostTimeMs(a);
    const tb = feedPostTimeMs(b);
    if (ta === 0 && tb === 0) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (ta === 0) return 1;
    if (tb === 0) return -1;
    if (ta !== tb) return newest ? tb - ta : ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

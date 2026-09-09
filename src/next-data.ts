import type { Page } from "playwright";

export async function readNextData(
  page: Page,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const el = document.querySelector("script#__NEXT_DATA__");
    if (!el?.textContent) return null;
    try {
      return JSON.parse(el.textContent) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
}

export function pageProps(
  data: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!data) return {};
  const props = data.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  return pageProps ?? {};
}

export function renderData(
  data: Record<string, unknown> | null,
): Record<string, unknown> {
  const pp = pageProps(data);
  return (pp.renderData as Record<string, unknown>) ?? pp;
}

/** Fetch a fresh Next.js data payload (avoids stale __NEXT_DATA__ after ?md= soft nav). */
export async function fetchNextDataPath(
  page: Page,
  /** Path after buildId, no leading slash — e.g. `group/classroom/hash` or `group` */
  routePath: string,
  searchParams: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    async ({ routePath, searchParams }) => {
      const el = document.querySelector("script#__NEXT_DATA__");
      if (!el?.textContent) return null;
      try {
        const boot = JSON.parse(el.textContent) as { buildId?: string };
        const buildId = boot.buildId;
        if (!buildId) return null;
        const q = new URLSearchParams(searchParams).toString();
        const url = `/_next/data/${buildId}/${routePath}.json${q ? `?${q}` : ""}`;
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) return null;
        return (await resp.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    { routePath, searchParams },
  );
}

export async function fetchLessonPageProps(
  page: Page,
  opts: { group: string; courseHash: string; moduleId: string },
): Promise<Record<string, unknown> | null> {
  const raw = await fetchNextDataPath(
    page,
    `${opts.group}/classroom/${opts.courseHash}`,
    { md: opts.moduleId, group: opts.group },
  );
  if (!raw) return null;
  const props = raw.pageProps as Record<string, unknown> | undefined;
  return props ?? null;
}

export async function fetchLessonVideoToken(
  page: Page,
  opts: { group: string; courseHash: string; moduleId: string },
): Promise<{ playbackId: string; token: string; duration?: number } | null> {
  const pp = await fetchLessonPageProps(page, opts);
  if (!pp) return null;
  const rd = (pp.renderData as Record<string, unknown>) || pp;
  const video = rd.video as
    | {
        playbackId?: string;
        playbackToken?: string;
        duration?: number;
      }
    | undefined;
  if (video?.playbackId && video?.playbackToken) {
    return {
      playbackId: video.playbackId,
      token: video.playbackToken,
      duration: video.duration,
    };
  }
  return null;
}

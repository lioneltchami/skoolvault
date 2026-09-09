import type { Page } from "playwright";
import { pageProps, readNextData } from "../next-data.js";
import type { Comment, FeedPost } from "../schema.js";

function mapUser(u: Record<string, unknown> | undefined) {
  if (!u) return undefined;
  return {
    id: String(u.id ?? ""),
    name: String(u.name ?? ""),
    firstName: u.firstName ? String(u.firstName) : undefined,
    lastName: u.lastName ? String(u.lastName) : undefined,
  };
}

function mapComment(node: Record<string, unknown>): Comment {
  const post = (node.post as Record<string, unknown>) || node;
  const meta = (post.metadata as Record<string, unknown>) || {};
  return {
    id: String(post.id ?? ""),
    parentId: String(post.parent_id ?? post.parentId ?? ""),
    rootId: String(post.root_id ?? post.rootId ?? ""),
    content: String(meta.content ?? post.content ?? ""),
    upvotes: Number(meta.upvotes ?? 0),
    createdAt: post.created_at
      ? String(post.created_at)
      : post.createdAt
        ? String(post.createdAt)
        : undefined,
    user: mapUser(post.user as Record<string, unknown> | undefined),
  };
}

export async function extractFeedPosts(
  page: Page,
  maxItems = 50,
): Promise<FeedPost[]> {
  const data = await readNextData(page);
  const pp = pageProps(data);

  const candidates: Record<string, unknown>[] = [];
  for (const key of ["posts", "items", "feed", "data"]) {
    const val = pp[key];
    if (Array.isArray(val))
      candidates.push(...(val as Record<string, unknown>[]));
    else if (
      val &&
      typeof val === "object" &&
      Array.isArray((val as { items?: unknown }).items)
    ) {
      candidates.push(...(val as { items: Record<string, unknown>[] }).items);
    }
  }

  // Deduplicate candidates that appear under multiple pageProps keys
  const seenIds = new Set<string>();
  const posts: FeedPost[] = [];
  const now = new Date().toISOString();

  for (const raw of candidates) {
    const core = (raw.post as Record<string, unknown>) || raw;
    if (!core.id) continue;
    const id = String(core.id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const meta = (core.metadata as Record<string, unknown>) || {};
    const commentsRaw =
      (raw.comments as unknown[]) || (core.comments as unknown[]) || [];
    const comments = Array.isArray(commentsRaw)
      ? commentsRaw.map((c) => mapComment(c as Record<string, unknown>))
      : [];

    posts.push({
      type: "feedPost",
      id,
      title: String(meta.title ?? core.name ?? ""),
      content: String(meta.content ?? ""),
      url: String(core.url ?? ""),
      upvotes: Number(meta.upvotes ?? 0),
      commentsCount: Number(meta.comments ?? comments.length),
      createdAt: core.createdAt ? String(core.createdAt) : undefined,
      user: mapUser(core.user as Record<string, unknown> | undefined),
      comments,
      extractedAt: now,
    });

    if (posts.length >= maxItems) break;
  }

  // DOM fallback: collect post cards lightly
  if (posts.length === 0) {
    const fromDom = await page.evaluate((limit) => {
      const cards = Array.from(
        document.querySelectorAll(
          '[class*="PostItem"], [class*="FeedItem"], article',
        ),
      );
      return cards.slice(0, limit).map((el, i) => ({
        id: el.getAttribute("data-id") || `dom-post-${i}`,
        title:
          el.querySelector('h2,h3,[class*="Title"]')?.textContent?.trim() || "",
        content: el.textContent?.trim().slice(0, 2000) || "",
      }));
    }, maxItems);

    for (const p of fromDom) {
      posts.push({
        type: "feedPost",
        id: p.id,
        title: p.title,
        content: p.content,
        url: "",
        upvotes: 0,
        commentsCount: 0,
        comments: [],
        extractedAt: now,
      });
    }
  }

  return posts;
}

export async function fetchPostComments(
  page: Page,
  postId: string,
  max = 200,
): Promise<Comment[]> {
  const result = await page.evaluate(
    async ({ postId, max }) => {
      try {
        const resp = await fetch(
          `https://api2.skool.com/posts/${postId}/comments?limit=${max}`,
          {
            credentials: "include",
          },
        );
        if (!resp.ok) {
          // legacy host
          const resp2 = await fetch(
            `https://api.skool.com/posts/${postId}/comments?limit=${max}`,
            {
              credentials: "include",
            },
          );
          if (!resp2.ok) return [];
          return (await resp2.json()) as unknown;
        }
        return (await resp.json()) as unknown;
      } catch {
        return [];
      }
    },
    { postId, max },
  );

  const list = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { comments?: unknown }).comments)
      ? (result as { comments: unknown[] }).comments
      : [];

  return list.map((c) => mapComment(c as Record<string, unknown>));
}

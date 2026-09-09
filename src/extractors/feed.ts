import type { Page } from "playwright";
import { fetchNextDataPath, pageProps, readNextData } from "../next-data.js";
import type { Comment, FeedPost } from "../schema.js";
import { normalizeCreatedAt, sortFeedPostsByDate } from "../utils/feed-sort.js";
import { sleep } from "../utils/text.js";
import { tipTapToMarkdown } from "../utils/tiptap.js";

export {
	feedPostTimeMs,
	normalizeCreatedAt,
	sortFeedPostsByDate,
} from "../utils/feed-sort.js";

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
	const rawContent = String(meta.content ?? post.content ?? "");
	return {
		id: String(post.id ?? ""),
		parentId: String(post.parent_id ?? post.parentId ?? ""),
		rootId: String(post.root_id ?? post.rootId ?? ""),
		content: tipTapToMarkdown(rawContent) || rawContent,
		upvotes: Number(meta.upvotes ?? 0),
		createdAt: normalizeCreatedAt(post.created_at ?? post.createdAt),
		user: mapUser(post.user as Record<string, unknown> | undefined),
	};
}

function pushPostsFromProps(
	pp: Record<string, unknown>,
	into: Record<string, unknown>[],
): void {
	for (const key of ["posts", "items", "feed", "data", "postTrees", "btree"]) {
		const val = pp[key];
		if (Array.isArray(val)) {
			into.push(...(val as Record<string, unknown>[]));
		} else if (
			val &&
			typeof val === "object" &&
			Array.isArray((val as { items?: unknown }).items)
		) {
			into.push(...(val as { items: Record<string, unknown>[] }).items);
		} else if (
			val &&
			typeof val === "object" &&
			Array.isArray((val as { posts?: unknown }).posts)
		) {
			into.push(...(val as { posts: Record<string, unknown>[] }).posts);
		}
	}
	const rd = pp.renderData;
	if (rd && typeof rd === "object") {
		pushPostsFromProps(rd as Record<string, unknown>, into);
	}
}

function normalizePost(
	raw: Record<string, unknown>,
	now: string,
): FeedPost | null {
	const core = (raw.post as Record<string, unknown>) || raw;
	if (!core.id) return null;
	const meta = (core.metadata as Record<string, unknown>) || {};
	const commentsRaw =
		(raw.comments as unknown[]) || (core.comments as unknown[]) || [];
	const comments = Array.isArray(commentsRaw)
		? commentsRaw.map((c) => mapComment(c as Record<string, unknown>))
		: [];
	const rawContent = String(meta.content ?? "");
	const createdRaw =
		core.createdAt ??
		core.created_at ??
		meta.createdAt ??
		meta.created_at ??
		meta.created;
	return {
		type: "feedPost",
		id: String(core.id),
		title: String(meta.title ?? core.name ?? ""),
		content: tipTapToMarkdown(rawContent) || rawContent,
		url: String(core.url ?? ""),
		upvotes: Number(meta.upvotes ?? 0),
		commentsCount: Number(meta.comments ?? comments.length),
		createdAt: normalizeCreatedAt(createdRaw),
		user: mapUser(core.user as Record<string, unknown> | undefined),
		comments,
		extractedAt: now,
	};
}

async function scrollFeed(page: Page, rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		const prev = await page.evaluate(() => document.body.scrollHeight);
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await sleep(1200);
		const next = await page.evaluate(() => document.body.scrollHeight);
		if (next <= prev) break;
	}
}

export async function extractFeedPosts(
	page: Page,
	maxItems = 50,
	opts?: {
		communitySlug?: string;
		/** Default newest — Skool `s=newest` + local date sort + slice. */
		sort?: "newest" | "oldest";
	},
): Promise<FeedPost[]> {
	const sort = opts?.sort ?? "newest";
	const now = new Date().toISOString();
	const seenIds = new Set<string>();
	const posts: FeedPost[] = [];

	const addRaw = (candidates: Record<string, unknown>[]) => {
		for (const raw of candidates) {
			const p = normalizePost(raw, now);
			if (!p || seenIds.has(p.id)) continue;
			seenIds.add(p.id);
			posts.push(p);
		}
	};

	// 1) On-page SSR
	const boot = await readNextData(page);
	const bootPp = pageProps(boot);
	const fromBoot: Record<string, unknown>[] = [];
	pushPostsFromProps(bootPp, fromBoot);
	addRaw(fromBoot);

	// 2) Paginate `/_next/data/{buildId}/{slug}.json?s=newest&p=N`
	const slug =
		opts?.communitySlug ||
		page
			.url()
			.replace(/^https?:\/\/(www\.)?skool\.com\//, "")
			.split(/[/?#]/)[0] ||
		"";
	const skoolSort = sort === "oldest" ? "oldest" : "newest";
	const maxPages = Math.min(50, Math.max(12, Math.ceil(maxItems / 10) + 4));
	if (slug) {
		for (let p = 1; p <= maxPages && posts.length < maxItems * 2; p++) {
			const raw = await fetchNextDataPath(page, slug, {
				s: skoolSort,
				p: String(p),
			});
			if (!raw) break;
			const pp = (raw.pageProps as Record<string, unknown>) || {};
			const batch: Record<string, unknown>[] = [];
			pushPostsFromProps(pp, batch);
			if (batch.length === 0) break;
			const before = posts.length;
			addRaw(batch);
			if (posts.length === before) break;
		}
	}

	// 3) Scroll fallback only if still empty
	if (posts.length === 0) {
		await scrollFeed(page, Math.min(20, Math.ceil(maxItems / 5)));
		const fromDom = await page.evaluate((limit) => {
			const out: {
				id: string;
				title: string;
				content: string;
				url: string;
			}[] = [];
			const seen = new Set<string>();
			const slug = location.pathname.split("/").filter(Boolean)[0] || "";

			for (const a of Array.from(document.querySelectorAll("a[href]"))) {
				const href = a.getAttribute("href") || "";
				const m =
					href.match(
						new RegExp(`^/(?:${slug}/)?([a-f0-9]{20,40})(?:\\?|#|$)`, "i"),
					) || href.match(/\/([a-f0-9]{32})(?:\?|#|$)/i);
				if (!m) continue;
				const id = m[1]!;
				if (seen.has(id)) continue;
				if (
					href.includes("/classroom") ||
					href.includes("/about") ||
					href.includes("/members") ||
					href.includes("/settings")
				) {
					continue;
				}
				seen.add(id);
				const card =
					a.closest(
						'[class*="Post"], [class*="post"], [class*="Feed"], article, [class*="Card"]',
					) || a.parentElement;
				out.push({
					id,
					title:
						card
							?.querySelector('h2,h3,[class*="Title"],[class*="title"]')
							?.textContent?.trim() ||
						a.textContent?.trim().slice(0, 120) ||
						"",
					content: card?.textContent?.trim().slice(0, 2000) || "",
					url: href.startsWith("http") ? href : `https://www.skool.com${href}`,
				});
				if (out.length >= limit) break;
			}

			if (out.length === 0) {
				const cards = Array.from(
					document.querySelectorAll(
						'[class*="PostItem"], [class*="FeedItem"], [class*="PostCard"], article',
					),
				);
				for (let i = 0; i < Math.min(cards.length, limit); i++) {
					const el = cards[i]!;
					out.push({
						id: el.getAttribute("data-id") || `dom-post-${i}`,
						title:
							el.querySelector('h2,h3,[class*="Title"]')?.textContent?.trim() ||
							"",
						content: el.textContent?.trim().slice(0, 2000) || "",
						url: "",
					});
				}
			}
			return out;
		}, maxItems);

		for (const p of fromDom) {
			if (seenIds.has(p.id)) continue;
			seenIds.add(p.id);
			posts.push({
				type: "feedPost",
				id: p.id,
				title: p.title,
				content: p.content,
				url: p.url,
				upvotes: 0,
				commentsCount: 0,
				comments: [],
				extractedAt: now,
			});
		}
	}

	return sortFeedPostsByDate(posts, sort).slice(0, maxItems);
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

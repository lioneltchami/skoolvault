export type ScopeKind =
	| "community"
	| "classroom"
	| "course"
	| "lesson"
	| "feed";

export interface ParsedSkoolUrl {
	kind: ScopeKind;
	communitySlug: string;
	communityUrl: string;
	classroomUrl: string;
	courseHash?: string;
	lessonId?: string;
	originalUrl: string;
	/** Preserve feed query string when present */
	feedQuery?: string;
}

/**
 * Skool feed/discovery query keys (not marketing trackers).
 * - s  = sort (e.g. newest)
 * - fl = feed filter/label
 * - c  = category / channel filter
 * - p  = page / pagination
 * UTM and other trackers must NOT force feed-only mode.
 */
const SKOOL_FEED_QUERY_KEYS = new Set(["s", "fl", "c", "p"]);

export function hasSkoolFeedQuery(url: URL): boolean {
	for (const key of SKOOL_FEED_QUERY_KEYS) {
		if (url.searchParams.has(key)) return true;
	}
	return false;
}

/**
 * FlowExtract-style URL routing:
 * - /slug                  → community (feed if --feed, else classroom)
 * - /slug/classroom        → classroom
 * - /slug/classroom/hash   → course
 * - /slug/classroom/hash?md=id → lesson
 * - /slug?s=newest...      → feed-friendly community URL
 */
export function parseSkoolUrl(
	input: string,
	preferFeed = false,
): ParsedSkoolUrl {
	let url: URL;
	try {
		url = new URL(
			input.includes("://")
				? input
				: `https://www.skool.com/${input.replace(/^\//, "")}`,
		);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}

	if (!url.hostname.includes("skool.com")) {
		throw new Error(`Not a skool.com URL: ${input}`);
	}

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length === 0) {
		throw new Error(
			"URL must include a community slug, e.g. https://www.skool.com/my-group/classroom",
		);
	}

	const communitySlug = parts[0]!;
	const communityUrl = `https://www.skool.com/${communitySlug}`;
	const classroomUrl = `${communityUrl}/classroom`;
	const lessonId = url.searchParams.get("md") || undefined;
	const feedLike = hasSkoolFeedQuery(url);
	const feedQuery = feedLike ? url.search || undefined : undefined;

	if (parts[1] === "classroom") {
		const courseHash = parts[2];
		if (courseHash && lessonId) {
			return {
				kind: "lesson",
				communitySlug,
				communityUrl,
				classroomUrl,
				courseHash,
				lessonId,
				originalUrl: input,
			};
		}
		if (courseHash) {
			return {
				kind: "course",
				communitySlug,
				communityUrl,
				classroomUrl,
				courseHash,
				originalUrl: input,
			};
		}
		return {
			kind: "classroom",
			communitySlug,
			communityUrl,
			classroomUrl,
			originalUrl: input,
		};
	}

	// Bare community URL — feed only for --feed or known Skool feed params (not utm_*)
	if (preferFeed || feedLike) {
		return {
			kind: "feed",
			communitySlug,
			communityUrl,
			classroomUrl,
			originalUrl: input,
			feedQuery: feedQuery ?? (url.search || undefined),
		};
	}

	return {
		kind: "community",
		communitySlug,
		communityUrl,
		classroomUrl,
		originalUrl: input,
	};
}

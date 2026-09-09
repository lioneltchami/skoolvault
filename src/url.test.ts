import assert from "node:assert/strict";
import { hasSkoolFeedQuery, parseSkoolUrl } from "./url.js";

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok  ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`);
		throw e;
	}
}

check("bare community → community", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group");
	assert.equal(p.kind, "community");
	assert.equal(p.communitySlug, "my-group");
});

check("slug only (no URL) → community", () => {
	const p = parseSkoolUrl("ai-first-client-formula-8589");
	assert.equal(p.kind, "community");
	assert.equal(p.communitySlug, "ai-first-client-formula-8589");
	assert.equal(
		p.classroomUrl,
		"https://www.skool.com/ai-first-client-formula-8589/classroom",
	);
});

check("utm query → still community (not feed)", () => {
	const p = parseSkoolUrl(
		"https://www.skool.com/my-group?utm_source=x&utm_medium=email",
	);
	assert.equal(p.kind, "community");
	assert.equal(p.feedQuery, undefined);
});

check("?s=newest → feed", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group?s=newest");
	assert.equal(p.kind, "feed");
	assert.ok(p.feedQuery?.includes("s=newest"));
});

check("?fl= → feed", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group?fl=posts");
	assert.equal(p.kind, "feed");
});

check("?c= → feed", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group?c=abc");
	assert.equal(p.kind, "feed");
});

check("?p= → feed", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group?p=2");
	assert.equal(p.kind, "feed");
});

check(
	"preferFeed bare → feed (API helper; CLI --feed does not use this)",
	() => {
		const p = parseSkoolUrl("https://www.skool.com/my-group", true);
		assert.equal(p.kind, "feed");
	},
);

check("bare community without preferFeed → community (classroom)", () => {
	const p = parseSkoolUrl("https://www.skool.com/my-group", false);
	assert.equal(p.kind, "community");
});

check("classroom path ignores feed query noise", () => {
	const p = parseSkoolUrl(
		"https://www.skool.com/my-group/classroom?utm_source=x",
	);
	assert.equal(p.kind, "classroom");
});

check("lesson md= still lesson", () => {
	const p = parseSkoolUrl(
		"https://www.skool.com/my-group/classroom/hash123?md=lesson-1",
	);
	assert.equal(p.kind, "lesson");
	assert.equal(p.lessonId, "lesson-1");
});

check("hasSkoolFeedQuery ignores utm", () => {
	const u = new URL("https://www.skool.com/g?utm_source=x");
	assert.equal(hasSkoolFeedQuery(u), false);
});

check("hasSkoolFeedQuery detects s", () => {
	const u = new URL("https://www.skool.com/g?s=newest&utm_source=x");
	assert.equal(hasSkoolFeedQuery(u), true);
});

console.log("\nAll url tests passed.");

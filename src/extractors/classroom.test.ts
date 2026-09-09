import assert from "node:assert/strict";
import { parseResources, type TreeLesson, walkTree } from "./classroom.js";

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok  ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`);
		throw e;
	}
}

check("walkTree flattens modules under sections", () => {
	const out: TreeLesson[] = [];
	walkTree(
		{
			course: { unitType: "course", metadata: { title: "Root" } },
			children: [
				{
					course: { unitType: "set", metadata: { title: "Week 1" } },
					children: [
						{
							course: {
								id: "l1",
								name: "hash1",
								unitType: "module",
								metadata: {
									title: "Intro",
									videoId: "mux123",
									resources: '[{"file_id":"f1"}]',
								},
							},
							children: [],
						},
					],
				},
				{
					course: {
						id: "l2",
						unitType: "module",
						metadata: { title: "Standalone", desc: "body" },
					},
				},
			],
		},
		[],
		out,
		{ n: 0 },
	);
	assert.equal(out.length, 2);
	assert.equal(out[0]!.title, "Intro");
	assert.equal(out[0]!.section, "Week 1");
	assert.equal(out[0]!.videoId, "mux123");
	assert.equal(out[0]!.position, 1);
	assert.equal(out[1]!.title, "Standalone");
	assert.equal(out[1]!.section, "");
	assert.equal(out[1]!.position, 2);
	assert.equal(out[1]!.desc, "body");
});

check("parseResources accepts file_id and fileId", () => {
	const a = parseResources(
		JSON.stringify([{ file_id: "abc", label: "PDF" }, { fileId: "xyz" }]),
	);
	assert.equal(a.length, 2);
	assert.equal(a[0]!.fileId, "abc");
	assert.equal(a[0]!.label, "PDF");
	assert.equal(a[1]!.fileId, "xyz");
});

check("parseResources accepts link/url/name", () => {
	const a = parseResources(
		JSON.stringify([
			{ link: "https://x.test/a", name: "A" },
			{ url: "https://x.test/b" },
		]),
	);
	assert.equal(a[0]!.link, "https://x.test/a");
	assert.equal(a[0]!.label, "A");
	assert.equal(a[1]!.link, "https://x.test/b");
});

check("parseResources returns [] on junk", () => {
	assert.deepEqual(parseResources(undefined), []);
	assert.deepEqual(parseResources("not-json"), []);
	assert.deepEqual(parseResources("{}"), []);
});

console.log("\nclassroom tests passed");

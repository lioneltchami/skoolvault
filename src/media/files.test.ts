import assert from "node:assert/strict";
import { parseDownloadUrlBody } from "./files.js";

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok  ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`);
		throw e;
	}
}

check("bare https body (Skool text/plain)", () => {
	const p = parseDownloadUrlBody(
		"https://files.skool.com/abc/invoice.json?X-Amz-Signature=xyz",
	);
	assert.equal(
		p.url,
		"https://files.skool.com/abc/invoice.json?X-Amz-Signature=xyz",
	);
	assert.equal(p.error, undefined);
});

check("JSON {url}", () => {
	const p = parseDownloadUrlBody(
		JSON.stringify({ url: "https://files.skool.com/a", name: "x.json" }),
	);
	assert.equal(p.url, "https://files.skool.com/a");
	assert.equal(p.name, "x.json");
});

check("JSON {downloadUrl}", () => {
	const p = parseDownloadUrlBody(
		JSON.stringify({ downloadUrl: "https://files.skool.com/b" }),
	);
	assert.equal(p.url, "https://files.skool.com/b");
});

check("JSON string url", () => {
	const p = parseDownloadUrlBody(JSON.stringify("https://files.skool.com/c"));
	assert.equal(p.url, "https://files.skool.com/c");
});

check("empty / junk → error", () => {
	assert.ok(parseDownloadUrlBody("").error);
	assert.ok(parseDownloadUrlBody("not-a-url").error);
});

console.log("\nfiles tests passed");

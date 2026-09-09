import assert from "node:assert/strict";
import { normalizeCreatedAt, sortFeedPostsByDate } from "./utils/feed-sort.js";

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

check("normalizeCreatedAt handles unix s/ms/ISO", () => {
  assert.equal(
    normalizeCreatedAt(1_700_000_000),
    new Date(1_700_000_000_000).toISOString(),
  );
  assert.equal(
    normalizeCreatedAt(1_700_000_000_000),
    new Date(1_700_000_000_000).toISOString(),
  );
  assert.ok(normalizeCreatedAt("2024-01-15T12:00:00.000Z")?.startsWith("2024"));
});

check("sortFeedPostsByDate newest first + slice 100", () => {
  const posts = [
    { id: "a", createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "c", createdAt: "2024-03-01T00:00:00.000Z" },
    { id: "b", createdAt: "2024-02-01T00:00:00.000Z" },
    { id: "nodate" },
  ];
  const newest = sortFeedPostsByDate(posts, "newest");
  assert.deepEqual(
    newest.map((p) => p.id),
    ["c", "b", "a", "nodate"],
  );
  assert.deepEqual(
    newest.slice(0, 2).map((p) => p.id),
    ["c", "b"],
  );
});

console.log("\nfeed-sort tests passed");

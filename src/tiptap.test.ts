import assert from "node:assert/strict";
import { contentNeedsRefresh } from "./lesson-resume.js";
import { looksLikeTipTap, tipTapToMarkdown } from "./utils/tiptap.js";

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

check("TipTap [v2] → markdown headings/paragraphs", () => {
  const raw = `[v2]${JSON.stringify([
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "What This Template Does" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Extracts attendee data." }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Item A" }],
            },
          ],
        },
      ],
    },
  ])}`;
  assert.ok(looksLikeTipTap(raw));
  const md = tipTapToMarkdown(raw);
  assert.ok(md.includes("## What This Template Does"));
  assert.ok(md.includes("Extracts attendee data."));
  assert.ok(md.includes("- Item A"));
  assert.ok(!md.startsWith("[v2]"));
});

check("plain text pass-through", () => {
  assert.equal(tipTapToMarkdown("hello world"), "hello world");
});

check("contentNeedsRefresh detects empty and raw tip tap", () => {
  assert.equal(contentNeedsRefresh(""), true);
  assert.equal(contentNeedsRefresh("short"), true);
  assert.equal(contentNeedsRefresh("[v2][{}]"), true);
  assert.equal(
    contentNeedsRefresh("## What This Template Does\n\nReal prose here enough"),
    false,
  );
});

console.log("\ntiptap tests passed");

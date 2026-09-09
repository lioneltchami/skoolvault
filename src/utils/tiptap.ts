/**
 * Skool lesson bodies are TipTap/ProseMirror JSON, often prefixed with `[v2]`.
 * Convert to readable Markdown for archive files.
 */

type TipTapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: TipTapNode[];
};

export function looksLikeTipTap(raw: string): boolean {
  const t = raw.trim();
  return (
    t.startsWith("[v2]") || t.startsWith('[{"type"') || t.startsWith('{"type"')
  );
}

/** Strip `[v2]` and parse TipTap doc/array; return null if not TipTap. */
export function parseTipTapDoc(raw: string): TipTapNode[] | null {
  let t = raw.trim();
  if (t.startsWith("[v2]")) t = t.slice(4).trim();
  try {
    const data = JSON.parse(t) as unknown;
    if (Array.isArray(data)) return data as TipTapNode[];
    if (data && typeof data === "object") {
      const doc = data as TipTapNode;
      if (doc.type === "doc" && Array.isArray(doc.content)) return doc.content;
      if (doc.type) return [doc];
    }
  } catch {
    return null;
  }
  return null;
}

function applyMarks(text: string, marks?: TipTapNode["marks"]): string {
  if (!text) return "";
  let out = text;
  for (const m of marks || []) {
    if (m.type === "bold" || m.type === "strong") out = `**${out}**`;
    else if (m.type === "italic" || m.type === "em") out = `*${out}*`;
    else if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "link" && m.attrs?.href) {
      out = `[${out}](${String(m.attrs.href)})`;
    }
  }
  return out;
}

function inlineText(nodes?: TipTapNode[]): string {
  if (!nodes?.length) return "";
  return nodes
    .map((n) => {
      if (n.type === "text") return applyMarks(n.text || "", n.marks);
      if (n.type === "hardBreak") return "\n";
      if (n.type === "mention")
        return String(n.attrs?.label || n.attrs?.id || "");
      if (n.content) return inlineText(n.content);
      return "";
    })
    .join("");
}

function renderBlock(node: TipTapNode, listPrefix = ""): string {
  const type = node.type || "";
  switch (type) {
    case "paragraph": {
      const t = inlineText(node.content).trim();
      return t ? `${listPrefix}${t}\n\n` : "\n";
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 2, 1), 6);
      const t = inlineText(node.content).trim();
      return t ? `${"#".repeat(level)} ${t}\n\n` : "";
    }
    case "bulletList":
      return (node.content || []).map((li) => renderBlock(li, "- ")).join("");
    case "orderedList":
      return (node.content || [])
        .map((li, i) => renderBlock(li, `${i + 1}. `))
        .join("");
    case "listItem": {
      const parts = (node.content || []).map((c, i) => {
        if (c.type === "paragraph") {
          const t = inlineText(c.content).trim();
          return i === 0 ? `${listPrefix}${t}\n` : `  ${t}\n`;
        }
        return renderBlock(c, "  ");
      });
      return `${parts.join("")}\n`;
    }
    case "blockquote": {
      const inner = (node.content || [])
        .map((c) => renderBlock(c))
        .join("")
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      return inner ? `${inner}\n\n` : "";
    }
    case "codeBlock": {
      const code = inlineText(node.content);
      const lang = String(node.attrs?.language || "");
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    case "horizontalRule":
      return "---\n\n";
    case "image": {
      const src = String(node.attrs?.src || node.attrs?.originalSrc || "");
      const alt = String(node.attrs?.alt || node.attrs?.title || "image");
      return src ? `![${alt}](${src})\n\n` : "";
    }
    case "youtube":
    case "video": {
      const src = String(node.attrs?.src || node.attrs?.url || "");
      return src ? `${src}\n\n` : "";
    }
    default:
      if (node.content) {
        return node.content.map((c) => renderBlock(c, listPrefix)).join("");
      }
      return "";
  }
}

/** Convert TipTap/ProseMirror JSON (or `[v2]…`) to Markdown. Pass-through if not TipTap. */
export function tipTapToMarkdown(raw: string): string {
  if (!raw.trim()) return "";
  if (!looksLikeTipTap(raw)) return raw;
  const nodes = parseTipTapDoc(raw);
  if (!nodes) return raw;
  return nodes
    .map((n) => renderBlock(n))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

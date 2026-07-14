import type { BlockType, RenderedBlock } from "@/crdt/types";

/**
 * Markdown shortcuts: typing `## ` turns the block into a heading.
 *
 * The rule is deliberately narrow — the pattern must match the text from the START of the block, and
 * the trigger is always a trailing space. Anything looser produces the single most infuriating class
 * of editor bug: text transforming while you are in the middle of writing a sentence about markdown.
 *
 * Recognising a shortcut is pure string work, so it lives here, tested, rather than inline in a
 * keydown handler where it would be untestable and would grow special cases forever.
 */

export interface MarkdownShortcut {
  readonly type: BlockType;
  /** Characters to remove from the start of the block (the `## `, the `- `, the ``` ). */
  readonly consumed: number;
  readonly attrs?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Ordered longest-prefix-first: `###` must be tested before `##`, or `### ` becomes an h2 followed by
 * a stray `#`. This is a classic ordering bug and the reason these are a list rather than a map.
 */
const SHORTCUTS: ReadonlyArray<{ prefix: string; type: BlockType; attrs?: Record<string, string> }> = [
  { prefix: "### ", type: "heading3" },
  { prefix: "## ", type: "heading2" },
  { prefix: "# ", type: "heading1" },
  { prefix: "- ", type: "bulletList" },
  { prefix: "* ", type: "bulletList" },
  { prefix: "1. ", type: "numberedList" },
  { prefix: "[] ", type: "todo" },
  { prefix: "[ ] ", type: "todo" },
  { prefix: "> ", type: "quote" },
  { prefix: "``` ", type: "code" },
  { prefix: "--- ", type: "divider" },
];

/**
 * Does the block's text (with `pending` about to be typed at `caretOffset`) trigger a shortcut?
 *
 * The `pending` character is passed separately rather than pre-applied, because this runs inside
 * `beforeinput` — the character has NOT been inserted yet, and the whole design of the editor is that
 * the DOM never mutates before the CRDT does. Asking "what would the text be if this landed?" without
 * actually landing it is the only way to decide whether to swallow it.
 */
export function matchShortcut(
  block: RenderedBlock,
  caretOffset: number,
  pending: string,
): MarkdownShortcut | null {
  // A shortcut only fires from the start of a block, and only on a space. `#hashtag` mid-sentence is
  // not a heading, and `# ` typed at offset 12 is not one either.
  if (pending !== " ") return null;
  if (block.type !== "paragraph") return null; // do not re-transform an existing heading

  const prefix = block.text.slice(0, caretOffset);
  // The caret must be at the end of the prefix and the prefix must be ALL of the text before it —
  // otherwise the user is editing in the middle of a line that happens to start with "#".
  if (prefix.length !== caretOffset) return null;

  const candidate = `${prefix} `;

  for (const shortcut of SHORTCUTS) {
    if (candidate === shortcut.prefix) {
      return {
        type: shortcut.type,
        // The typed prefix, minus the space that triggers it (the space is swallowed, never inserted).
        consumed: prefix.length,
        ...(shortcut.attrs !== undefined ? { attrs: shortcut.attrs } : {}),
      };
    }
  }

  return null;
}

/** Inline markdown: `**bold**`, `*italic*`, `` `code` ``. Applied on the closing delimiter. */
export interface InlineShortcut {
  readonly mark: "bold" | "italic" | "code";
  /** Offsets (within the block) of the characters to delete: the delimiters. */
  readonly delimiters: readonly number[];
  /** Offsets of the characters to mark. */
  readonly content: readonly number[];
}

const INLINE: ReadonlyArray<{ open: string; mark: InlineShortcut["mark"] }> = [
  { open: "**", mark: "bold" },
  { open: "*", mark: "italic" },
  { open: "`", mark: "code" },
];

/**
 * The user just typed the final character of a closing delimiter. Is there a matching opener?
 *
 * Scans backwards from the caret for the opening delimiter, requiring at least one character between
 * them — `****` is not empty bold, it is four asterisks, and turning it into an invisible zero-length
 * mark is a bug that manifests as "my text disappeared".
 */
export function matchInlineShortcut(
  block: RenderedBlock,
  caretOffset: number,
  pending: string,
): InlineShortcut | null {
  for (const { open, mark } of INLINE) {
    if (!open.endsWith(pending)) continue;

    // The text as it WOULD be, including the character about to be typed.
    const text = block.text.slice(0, caretOffset) + pending;
    if (!text.endsWith(open)) continue;

    const closeStart = text.length - open.length;
    const openEnd = text.lastIndexOf(open, closeStart - 1);
    if (openEnd === -1) continue;

    const contentStart = openEnd + open.length;
    if (contentStart >= closeStart) continue; // no content between the delimiters

    // `*` must not match the inner asterisks of `**bold**` — the longest delimiter is tried first, so
    // reaching `*` means `**` already failed, but the content itself must still not be an empty
    // asterisk pair.
    const content = text.slice(contentStart, closeStart);
    if (content.trim() === "") continue;

    const delimiters: number[] = [];
    for (let i = openEnd; i < contentStart; i += 1) delimiters.push(i);
    // The closing delimiter's last character is `pending`, which does not exist in the block yet — so
    // only the characters that ARE in the block are named here. The pending one is simply never
    // inserted.
    for (let i = closeStart; i < caretOffset; i += 1) delimiters.push(i);

    const contentOffsets: number[] = [];
    for (let i = contentStart; i < closeStart; i += 1) contentOffsets.push(i);

    return { mark, delimiters, content: contentOffsets };
  }

  return null;
}

/** The slash-menu catalogue. One list, so the menu and the keyboard shortcuts cannot disagree. */
export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: BlockType;
  readonly keywords: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "text", label: "Text", description: "Plain paragraph", type: "paragraph", keywords: ["paragraph", "plain"] },
  { id: "h1", label: "Heading 1", description: "Large section heading", type: "heading1", keywords: ["title", "h1"] },
  { id: "h2", label: "Heading 2", description: "Medium section heading", type: "heading2", keywords: ["subtitle", "h2"] },
  { id: "h3", label: "Heading 3", description: "Small section heading", type: "heading3", keywords: ["h3"] },
  { id: "bullet", label: "Bulleted list", description: "A simple bulleted list", type: "bulletList", keywords: ["ul", "unordered"] },
  { id: "numbered", label: "Numbered list", description: "A numbered list", type: "numberedList", keywords: ["ol", "ordered"] },
  { id: "todo", label: "To-do list", description: "Track tasks with a checkbox", type: "todo", keywords: ["task", "checkbox"] },
  { id: "quote", label: "Quote", description: "Capture a quotation", type: "quote", keywords: ["blockquote"] },
  { id: "code", label: "Code", description: "Code with syntax highlighting", type: "code", keywords: ["snippet", "pre"] },
  { id: "divider", label: "Divider", description: "Visually divide blocks", type: "divider", keywords: ["hr", "line"] },
  { id: "callout", label: "Callout", description: "Make writing stand out", type: "callout", keywords: ["note", "info"] },
  { id: "table", label: "Table", description: "Add a table", type: "table", keywords: ["grid"] },
];

export function filterSlashCommands(query: string): readonly SlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return SLASH_COMMANDS;

  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(normalized) ||
      command.keywords.some((keyword) => keyword.includes(normalized)),
  );
}

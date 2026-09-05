// When a cell's value is a LIST, and how it displays.
//
// Fan-out folds its per-item answers back into the cell as a JSON list. Rendered raw, a twelve-item
// answer is one long bracketed string in a 32px row — technically visible, practically unreadable,
// and it teaches people not to use the feature. Chips: one per item, bounded, the count named.

/** The items of a JSON array value, stringified for display. Null when the value is not a list. */
export function parseListValue(value: string | null): string[] | null {
  if (value == null) return null;
  const t = value.trim();
  if (!t.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null; // a value that merely starts with "[" is data, and stays raw
  }
  if (!Array.isArray(parsed)) return null; // an object is the JSON tree's job, not chips
  return parsed.map((item) => (item == null ? "" : typeof item === "string" ? item : JSON.stringify(item)));
}

/** How many chips show before the "+N" that names the rest. */
export const LIST_CHIPS_SHOWN = 3;

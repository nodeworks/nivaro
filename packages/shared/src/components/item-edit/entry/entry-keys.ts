/**
 * Keyboard-first entry (#2707) and the tab order (#2708): the pure parts. The
 * DOM side is useEntryKeyboard.ts. A form's fields are the `[data-field]`
 * wrappers FieldRow renders; the sequence is the layout's tab order first
 * (fields it names that are on screen), then every other field in page order.
 */

/** The field keys Tab and Enter walk, in order. */
export function entrySequence(pageOrder: string[], tabOrder: string[] | undefined): string[] {
  if (!tabOrder?.length) return pageOrder
  const onPage = new Set(pageOrder)
  const named = tabOrder.filter((k) => onPage.has(k))
  const taken = new Set(named)
  return [...named, ...pageOrder.filter((k) => !taken.has(k))]
}

/** The key after (dir 1) or before (dir -1) `current`; null at an end or off the list. */
export function stepField(seq: string[], current: string, dir: 1 | -1): string | null {
  const at = seq.indexOf(current)
  if (at < 0) return null
  return seq[at + dir] ?? null
}

/** An empty value as a required field counts it. */
export const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** The first required field with no value, in page order; null when none. */
export function firstEmptyRequired(
  pageOrder: string[],
  required: ReadonlySet<string>,
  draft: Record<string, unknown>
): string | null {
  for (const k of pageOrder) if (required.has(k) && isEmptyValue(draft[k])) return k
  return null
}

export const FOCUSABLE =
  'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role="combobox"]:not([disabled]), [contenteditable="true"], button:not([disabled])'

/** True when Enter in this element must keep its own meaning (a new line, a list pick, a button). */
export function enterIsTaken(el: Element): boolean {
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  if (el.closest('[role="listbox"], [role="menu"], [role="dialog"][data-state="open"] .cm-editor'))
    return true
  if (el.getAttribute('aria-expanded') === 'true') return true
  if (el.getAttribute('role') === 'combobox' && el.tagName !== 'INPUT') return true
  return false
}

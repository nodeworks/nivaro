import { matchesVisibleWhen, parseVisibleWhen } from '../../lib/visible-when'
import type { ChoiceLabels, DescribeField } from '../layout-editor/overview/describe-conditions'
import { describeShowWhen } from '../layout-editor/show-when'

/**
 * #3228 — a section or step a show-when rule hides says why in one quiet line
 * ("Unit Selection shows when Type is Capital") instead of vanishing. Pure: the
 * record form and the read view pass their groups, values and field metadata.
 *
 * Only RULE-hidden groups are named. A group hidden for the viewer's role never
 * reaches the client (/active drops it), and a group whose fields the viewer may
 * not read is never named either (`readable`) — the line must not confirm what
 * permissions hide.
 */

export interface RuleHiddenGroup {
  key: string
  label: string
  /** The rule as words: "Type is Capital", "the record is sparing". */
  when: string
}

/**
 * The show-when rules as the words after "shows when". The overview phrases a
 * yes/no rule without a subject ("is sparing", "has no PO" — its column reads
 * "When the record …"); in a sentence of its own that needs "the record".
 */
export function ruleHiddenWhen(
  raw: unknown,
  fields: DescribeField[],
  choices: ChoiceLabels = {}
): string | null {
  const parts: string[] = []
  for (const rule of parseVisibleWhen(raw)) {
    if (!rule?.field) continue
    const words = describeShowWhen([rule], fields, choices)
    if (!words) continue
    parts.push(/^(is|has) /.test(words) ? `the record ${words}` : words)
  }
  return parts.length ? parts.join(' and ') : null
}

/** "Shows when Type is Capital" — the line's sentence. */
export function ruleHiddenSentence(
  raw: unknown,
  fields: DescribeField[],
  choices: ChoiceLabels = {}
): string | null {
  const when = ruleHiddenWhen(raw, fields, choices)
  return when ? `Shows when ${when}` : null
}

/**
 * Does a group hold a field the viewer may read? A saved record's read leaves out
 * the fields the viewer may not read, so a field counts when the record carries
 * it; a new record has no read yet, so any placed field counts.
 */
export function groupHasReadableField(
  fieldKeys: string[],
  record: Record<string, unknown> | null | undefined,
  isNew: boolean
): boolean {
  const real = fieldKeys.filter((k) => !k.startsWith('__'))
  if (real.length === 0) return false
  if (isNew) return true
  if (!record) return false
  return real.some((k) => Object.hasOwn(record, k))
}

/** The groups a show-when rule hides right now, with the line each one shows. */
export function ruleHiddenGroups(args: {
  groups: Array<{ key: string; label?: string | null; visible_when?: unknown }>
  values: Record<string, unknown>
  fields: DescribeField[]
  choices?: ChoiceLabels
  /** Keys whose line the layout turned off (`conditions.quiet_hidden_sections`). */
  quiet?: string[]
  readable: (groupKey: string) => boolean
}): RuleHiddenGroup[] {
  const quiet = new Set(args.quiet ?? [])
  const out: RuleHiddenGroup[] = []
  for (const g of args.groups) {
    if (quiet.has(g.key)) continue
    if (parseVisibleWhen(g.visible_when).length === 0) continue
    if (matchesVisibleWhen(g.visible_when, args.values)) continue
    if (!args.readable(g.key)) continue
    const when = ruleHiddenWhen(g.visible_when, args.fields, args.choices)
    if (!when) continue
    out.push({ key: g.key, label: g.label?.trim() || g.key, when })
  }
  return out
}

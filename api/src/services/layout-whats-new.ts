/**
 * "What's new on this form" (#2657) and the save notices' change summary (#2655 / #2667) —
 * the pure half: what a person would notice between two saved states of a layout (fields
 * added, removed or moved to another section; sections added, removed or renamed), and a
 * one-line summary of an ops batch. No I/O here; services/layout-notify.ts feeds it.
 */

type Row = Record<string, unknown>

export interface LayoutSnapLike {
  groups: Row[]
  assignments: Row[]
}

export interface WhatsNew {
  added: string[]
  removed: string[]
  moved: Array<{ field: string; to: string }>
  sections_added: string[]
  sections_removed: string[]
  sections_renamed: Array<{ from: string; to: string }>
}

const isSlot = (field: string) => field.startsWith('__')
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** The first visible placement of each real field: field → group key ('' = no section). */
function placed(snap: LayoutSnapLike, mayRead: (field: string) => boolean): Map<string, Row> {
  const out = new Map<string, Row>()
  const rows = [...snap.assignments].sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  for (const a of rows) {
    const field = String(a.field ?? '')
    if (!field || isSlot(field) || out.has(field) || !mayRead(field)) continue
    // A stored is_visible=false placement is on the layout but never on the form.
    if (a.is_visible != null && !truthy(a.is_visible)) continue
    out.set(field, a)
  }
  return out
}

const groupLabel = (g: Row | undefined) => String(g?.label ?? '').trim()

/**
 * What changed between two states, in the words a form's user would use. `label` names a
 * field (label override, else the field's label); `mayRead` drops fields the reader cannot
 * see, so the note never names one.
 */
export function diffForPeople(
  from: LayoutSnapLike,
  to: LayoutSnapLike,
  opts: { label: (field: string, placement: Row) => string; mayRead?: (field: string) => boolean }
): WhatsNew {
  const mayRead = opts.mayRead ?? (() => true)
  const before = placed(from, mayRead)
  const after = placed(to, mayRead)
  const groupsBefore = new Map(from.groups.map((g) => [String(g.key ?? g.id), g]))
  const groupsAfter = new Map(to.groups.map((g) => [String(g.key ?? g.id), g]))
  const out: WhatsNew = {
    added: [],
    removed: [],
    moved: [],
    sections_added: [],
    sections_removed: [],
    sections_renamed: []
  }
  for (const [field, a] of after) {
    const b = before.get(field)
    if (!b) {
      out.added.push(opts.label(field, a))
      continue
    }
    const fromKey = String(b.group_key ?? '')
    const toKey = String(a.group_key ?? '')
    if (fromKey !== toKey) {
      const target = groupLabel(groupsAfter.get(toKey))
      out.moved.push({ field: opts.label(field, a), to: target || 'the top of the form' })
    }
  }
  for (const [field, b] of before) if (!after.has(field)) out.removed.push(opts.label(field, b))
  for (const [key, g] of groupsAfter) {
    const label = groupLabel(g)
    const old = groupsBefore.get(key)
    if (!old) {
      if (label) out.sections_added.push(label)
    } else if (label && groupLabel(old) && groupLabel(old) !== label)
      out.sections_renamed.push({ from: groupLabel(old), to: label })
  }
  for (const [key, g] of groupsBefore)
    if (!groupsAfter.has(key) && groupLabel(g)) out.sections_removed.push(groupLabel(g))
  return out
}

export function whatsNewCount(w: WhatsNew): number {
  return (
    w.added.length +
    w.removed.length +
    w.moved.length +
    w.sections_added.length +
    w.sections_removed.length +
    w.sections_renamed.length
  )
}

function list(items: string[], max = 4): string {
  if (items.length <= max) return items.join(', ')
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}

/** Short sentences for the note, most telling first. Empty when nothing a reader sees moved. */
export function whatsNewLines(w: WhatsNew): string[] {
  const lines: string[] = []
  if (w.added.length) lines.push(`New: ${list(w.added)}`)
  if (w.moved.length) {
    const shown = w.moved.slice(0, 3).map((m) => `${m.field} moved to ${m.to}`)
    const more = w.moved.length - shown.length
    lines.push(shown.join('; ') + (more > 0 ? `; and ${more} more moved` : ''))
  }
  if (w.removed.length) lines.push(`No longer on the form: ${list(w.removed)}`)
  if (w.sections_added.length)
    lines.push(
      `${w.sections_added.length === 1 ? 'New section' : 'New sections'}: ${list(w.sections_added)}`
    )
  if (w.sections_renamed.length)
    lines.push(
      w.sections_renamed
        .slice(0, 3)
        .map((r) => `${r.from} is now called ${r.to}`)
        .join('; ')
    )
  if (w.sections_removed.length)
    lines.push(
      `${w.sections_removed.length === 1 ? 'Section removed' : 'Sections removed'}: ${list(
        w.sections_removed
      )}`
    )
  return lines
}

/**
 * The saved state a person last saw, as a version row to diff from: the version whose
 * snapshot hashes to the rev they saw (exact), else the oldest version taken after they
 * looked (the state just before the first save they missed — versions are BEFORE images),
 * else none. `versions` oldest first.
 */
export function pickBaseVersion<V extends { hash: string; created_at: Date | string | null }>(
  versions: V[],
  seen: { rev: string; at: string }
): V | null {
  const exact = versions.find((v) => v.hash === seen.rev)
  if (exact) return exact
  const at = new Date(seen.at).getTime()
  if (!Number.isFinite(at)) return null
  return (
    versions.find((v) => v.created_at != null && new Date(v.created_at).getTime() >= at) ?? null
  )
}

const OP_WORDS: Record<string, [string, string]> = {
  place: ['field added', 'fields added'],
  move: ['field moved', 'fields moved'],
  update_placement: ['field changed', 'fields changed'],
  remove: ['field removed', 'fields removed'],
  group_create: ['section added', 'sections added'],
  group_update: ['section changed', 'sections changed'],
  group_move: ['section moved', 'sections moved'],
  group_remove: ['section removed', 'sections removed'],
  layout_update: ['form setting changed', 'form settings changed']
}

/** "2 fields moved, 1 section added" — what an ops batch did, in counts. */
export function summarizeOps(ops: unknown[]): string {
  const counts = new Map<string, number>()
  for (const op of ops) {
    const kind = String((op as { op?: unknown })?.op ?? '')
    if (!(kind in OP_WORDS)) continue
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const [kind, n] of counts) {
    const [one, many] = OP_WORDS[kind]
    parts.push(`${n} ${n === 1 ? one : many}`)
  }
  return parts.length ? parts.join(', ') : 'changes saved'
}

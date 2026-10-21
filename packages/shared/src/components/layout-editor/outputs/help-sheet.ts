import type { LayoutBundle, LayoutOp, PlacementPatch, PlacementRow } from '../../../lib/layout-ops'
import { isCanvasSlot, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { inPageOrder, normalizedBundle } from '../field-zones'
import { readOverrides, withKey } from '../inspector/model'
import { checked, groupsInPageOrder, refuse, type StructurePlan } from '../structure-ops'

// Help text from a spreadsheet (#2729). The editor turns the draft into rows
// (labels, help text, placeholders as the form shows them), the server makes
// the workbook, and an uploaded one comes back as rows. This file compares
// the two and turns the ticked differences into ONE ops batch (one undo step).

export interface HelpSheetRow {
  /** `s:<group key>` for a section, `f:<field>:<group key>` for a placement. */
  key: string
  kind: 'section' | 'field'
  section: string
  field: string
  label: string
  help: string
  placeholder: string
}

export interface UploadedHelpRow {
  key: string
  label: string
  help: string
  placeholder: string
}

export interface HelpGlobals {
  field: string
  label?: string | null
  note?: string | null
  placeholder?: string | null
}

export type HelpProp = 'label' | 'help' | 'placeholder'

export interface HelpChange {
  id: string
  key: string
  prop: HelpProp
  /** "Title · Basics", for the list. */
  where: string
  before: string
  after: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim()

export const placementKey = (field: string, groupKey: string | null) =>
  `f:${field}:${groupKey ?? ''}`

function parseKey(
  key: string
):
  | { kind: 'section'; group: string }
  | { kind: 'field'; field: string; group: string | null }
  | null {
  if (key.startsWith('s:')) return { kind: 'section', group: key.slice(2) }
  const m = /^f:([^:]+):(.*)$/.exec(key)
  return m ? { kind: 'field', field: m[1], group: m[2] === '' ? null : m[2] } : null
}

/** What a field shows today: this form's own text, else the collection's. */
function effective(p: PlacementRow, g: HelpGlobals | undefined) {
  const ov = readOverrides(p)
  return {
    label: str(ov.label) ?? str(p.label_override) ?? str(g?.label) ?? titleCase(p.field),
    help: str(ov.note) ?? str(g?.note) ?? '',
    placeholder: str(ov.placeholder) ?? str(g?.placeholder) ?? '',
    ownLabel: str(ov.label) !== null || str(p.label_override) !== null,
    ownHelp: str(ov.note) !== null,
    ownPlaceholder: str(ov.placeholder) !== null
  }
}

/** The draft as sheet rows: each section, then the fields placed in it, in page order. */
export function helpSheetRows(bundle: LayoutBundle, globals: HelpGlobals[] = []): HelpSheetRow[] {
  const b = normalizedBundle(bundle)
  const byField = new Map(globals.map((g) => [g.field, g]))
  const groups = new Map(groupsInPageOrder(b).map((g) => [g.key, g]))
  const rows: HelpSheetRow[] = []
  const seen = new Set<string>()
  const sectionName = (key: string | null) =>
    key === null || key === UNGROUPED_KEY
      ? 'Ungrouped'
      : key === '__header__'
        ? 'Header strip'
        : (groups.get(key)?.label ?? titleCase(key))
  for (const p of inPageOrder(
    b,
    b.placements.filter((x) => !isCanvasSlot(x) && !x.field.startsWith('__'))
  )) {
    const gk = p.group_key
    if (gk && gk !== '__header__' && gk !== UNGROUPED_KEY && !seen.has(gk) && groups.has(gk)) {
      seen.add(gk)
      const g = groups.get(gk)
      if (g)
        rows.push({
          key: `s:${gk}`,
          kind: 'section',
          section: g.label,
          field: '',
          label: g.label,
          help: '',
          placeholder: ''
        })
    }
    const e = effective(p, byField.get(p.field))
    rows.push({
      key: placementKey(p.field, gk),
      kind: 'field',
      section: sectionName(gk),
      field: p.field,
      label: e.label,
      help: e.help,
      placeholder: e.placeholder
    })
  }
  return rows
}

export interface HelpDiff {
  changes: HelpChange[]
  /** Rows of the file that match nothing on this form (a field or section since removed). */
  unknown: number
  /** Cells that could not be applied, in words. */
  skipped: string[]
  /** Rows in the file that already match. */
  same: number
}

const PROP_WORDS: Record<HelpProp, string> = {
  label: 'Label',
  help: 'Help text',
  placeholder: 'Placeholder'
}
export const propWord = (p: HelpProp) => PROP_WORDS[p]

/** Every cell of the uploaded sheet that differs from the draft. */
export function diffHelpSheet(
  bundle: LayoutBundle,
  globals: HelpGlobals[],
  uploaded: UploadedHelpRow[]
): HelpDiff {
  const b = normalizedBundle(bundle)
  const byField = new Map(globals.map((g) => [g.field, g]))
  const current = new Map(helpSheetRows(bundle, globals).map((r) => [r.key, r]))
  const changes: HelpChange[] = []
  const skipped: string[] = []
  let unknown = 0
  let same = 0
  for (const u of uploaded) {
    const cur = current.get(u.key)
    const parsed = parseKey(u.key)
    if (!cur || !parsed) {
      unknown++
      continue
    }
    const where =
      parsed.kind === 'section' ? `Section ${cur.label}` : `${cur.label} · ${cur.section}`
    let any = false
    const consider = (prop: HelpProp, before: string, after: string, own: boolean) => {
      if (norm(before) === norm(after)) return
      // Clearing text the form never set (it comes from the field) changes nothing here.
      if (norm(after) === '' && !own) return
      if (prop === 'label' && norm(after) === '' && parsed.kind === 'section') {
        skipped.push(`${cur.label}: a section needs a name`)
        return
      }
      any = true
      changes.push({
        id: `${u.key}|${prop}`,
        key: u.key,
        prop,
        where,
        before,
        after: norm(after)
      })
    }
    if (parsed.kind === 'section') {
      consider('label', cur.label, u.label, true)
    } else {
      const p = b.placements.find(
        (x) => x.field === parsed.field && x.group_key === parsed.group
      ) as PlacementRow | undefined
      if (!p) {
        unknown++
        continue
      }
      const e = effective(p, byField.get(p.field))
      consider('label', cur.label, u.label, e.ownLabel)
      consider('help', cur.help, u.help, e.ownHelp)
      consider('placeholder', cur.placeholder, u.placeholder, e.ownPlaceholder)
    }
    if (!any) same++
  }
  return { changes, unknown, skipped, same }
}

/** The ticked changes as one batch: an op per section or placement. */
export function helpSheetPlan(bundle: LayoutBundle, changes: HelpChange[]): StructurePlan {
  if (changes.length === 0) return refuse('Pick at least one change')
  const ops: LayoutOp[] = []
  const perKey = new Map<string, HelpChange[]>()
  for (const c of changes) perKey.set(c.key, [...(perKey.get(c.key) ?? []), c])
  for (const [key, list] of perKey) {
    const parsed = parseKey(key)
    if (!parsed) continue
    if (parsed.kind === 'section') {
      const label = list.find((c) => c.prop === 'label')?.after
      if (label) ops.push({ op: 'group_update', key: parsed.group, patch: { label } })
      continue
    }
    const row = bundle.placements.find(
      (p) => p.field === parsed.field && p.group_key === parsed.group
    ) as PlacementRow | undefined
    if (!row) continue
    let ov: Record<string, unknown> | null = readOverrides(row)
    const patch: PlacementPatch = {}
    let ovChanged = false
    const setOv = (k: string, v: string) => {
      ov = withKey(ov ?? {}, k, v === '' ? undefined : v)
      ovChanged = true
    }
    for (const c of list) {
      if (c.prop === 'label') {
        // Same precedence the form reads: its own override label, then the older label_override.
        if (str(readOverrides(row).label) === null && str(row.label_override) !== null)
          patch.label_override = c.after === '' ? null : c.after
        else setOv('label', c.after)
      } else setOv(c.prop === 'help' ? 'note' : 'placeholder', c.after)
    }
    if (ovChanged) patch.overrides = ov
    ops.push({
      op: 'update_placement',
      at: { field: parsed.field, group_key: parsed.group },
      patch
    })
  }
  const n = changes.length
  return checked(bundle, {
    ok: true,
    ops,
    label: `Apply ${n} ${n === 1 ? 'change' : 'changes'} from the help text sheet`,
    notes: []
  })
}

import type { GlossaryTerm } from './glossary'

// The built-in Nivaro glossary (#2): the app's own words — pipeline, owner
// group, layout, queue, scope … — with a one-line hint each, so <Term> has a
// definition on every instance, AI configured or not. An instance glossary
// entry (Ask AI → Knowledge → Glossary, GET /api/ai-knowledge/glossary) with
// the same slug, term or alias REPLACES the built-in one: the instance's
// words always win. Pure data + pure helpers; no fetch here.

type Core = { slug: string; term: string; hint: string; aliases?: string[] }

const CORE: Core[] = [
  {
    slug: 'collection',
    term: 'Collection',
    hint: 'A kind of record — one database table, such as Purchase Orders or Vendors.',
    aliases: ['collections']
  },
  {
    slug: 'field',
    term: 'Field',
    hint: 'One piece of information on a record, such as Status or Amount.'
  },
  {
    slug: 'relation',
    term: 'Relation',
    hint: 'A link between two collections, such as a PO pointing at its Vendor.',
    aliases: ['relations']
  },
  {
    slug: 'junction',
    term: 'Junction',
    hint: 'A hidden table that links many records to many records (M2M).'
  },
  {
    slug: 'pipeline',
    term: 'Pipeline',
    hint: 'The steps a record moves through (states and the moves between them), with who owns each step.',
    aliases: ['pipelines']
  },
  {
    slug: 'state',
    term: 'State',
    hint: 'One step of a pipeline, such as Draft, Review or Approved.',
    aliases: ['states']
  },
  {
    slug: 'transition',
    term: 'Transition',
    hint: 'A move from one pipeline state to another, such as Submit or Approve.',
    aliases: ['transitions']
  },
  {
    slug: 'owner-group',
    term: 'Owner group',
    hint: 'The people who own a pipeline step for records that match its filters.',
    aliases: ['owner groups']
  },
  {
    slug: 'owner-matrix',
    term: 'Owner matrix',
    hint: 'The grid of owner groups per state and dimension — the most specific match owns the record.'
  },
  {
    slug: 'dimension',
    term: 'Dimension',
    hint: 'A field the owner matrix splits ownership by, such as Zone or Category.',
    aliases: ['dimensions']
  },
  {
    slug: 'layout',
    term: 'Layout',
    hint: 'How a record form is arranged: its sections, fields and rules. Each record gets the best-matching form.',
    aliases: ['layouts', 'form layout']
  },
  {
    slug: 'section',
    term: 'Section',
    hint: 'A titled block of fields on a form layout.',
    aliases: ['sections']
  },
  {
    slug: 'queue',
    term: 'Queue',
    hint: 'A worklist of records from one or more collections, split into My items, No owners and All items.',
    aliases: ['queues', 'worklist']
  },
  {
    slug: 'scope',
    term: 'User Scope',
    hint: "A person's own limits, such as their Zones: they only see records that belong to them.",
    aliases: ['user scopes', 'scope', 'scopes']
  },
  {
    slug: 'row-filter',
    term: 'Row filter',
    hint: 'A rule on a role that limits which records it can see or change, such as Status is Approved.',
    aliases: ['row filters', 'row rule', 'row rules', 'row-level security']
  },
  {
    slug: 'policy',
    term: 'Policy',
    hint: 'What a role may do on one collection: see, add, edit or delete, and which fields.',
    aliases: ['policies']
  },
  {
    slug: 'role',
    term: 'Role',
    hint: 'A set of policies people share. Everyone has exactly one role.',
    aliases: ['roles']
  },
  {
    slug: 'rollup',
    term: 'Rollup',
    hint: 'A figure worked out from related records, such as the total of all lines on a PO.',
    aliases: ['rollups']
  },
  {
    slug: 'computed-field',
    term: 'Computed field',
    hint: 'A field whose value is calculated from other fields instead of typed in.',
    aliases: ['computed fields', 'formula field']
  },
  {
    slug: 'addendum',
    term: 'Addendum',
    hint: 'A change request attached to a record, approved on its own before it changes the record.',
    aliases: ['addendums', 'amendment']
  },
  {
    slug: 'picker',
    term: 'Picker',
    hint: 'The dropdown that chooses a related record, such as the Vendor picker on a PO.',
    aliases: ['pickers']
  },
  {
    slug: 'hidden-from-pickers',
    term: 'Hidden from pickers',
    hint: 'Never offered in any dropdown, but still in lists, search, reports and the API.',
    aliases: ['hide from pickers']
  },
  {
    slug: 'cascade',
    term: 'Cascade',
    hint: 'A picker narrowed by another field, such as Sites only for the chosen Zone.',
    aliases: ['cascades', 'cascading picker']
  },
  {
    slug: 'display-template',
    term: 'Display template',
    hint: 'How a related record is named in lists and pickers, such as {{number}} — {{vendor}}.'
  },
  {
    slug: 'flow',
    term: 'Flow',
    hint: 'An automation: when something happens, run steps such as send mail or update a record.',
    aliases: ['flows']
  },
  {
    slug: 'sla',
    term: 'SLA',
    hint: 'A deadline for a record in a state; it turns at risk, then breached, as time runs out.',
    aliases: ['deadline', 'deadlines']
  },
  {
    slug: 'field-rule',
    term: 'Field rule',
    hint: 'A rule that fills, shows, hides or locks a field depending on other values.',
    aliases: ['field rules']
  },
  {
    slug: 'edit-lock',
    term: 'Edit lock',
    hint: 'While someone is editing a record, others can read it but not save over them.'
  },
  {
    slug: 'workspace',
    term: 'Workspace',
    hint: 'A separate set of collections and roles inside one instance.',
    aliases: ['workspaces']
  },
  {
    slug: 'custom-query',
    term: 'Custom query',
    hint: 'Saved SQL that dashboards, reports and pickers can use.',
    aliases: ['custom queries']
  },
  {
    slug: 'record-template',
    term: 'Record template',
    hint: 'Saved values that pre-fill a new record.',
    aliases: ['record templates']
  },
  {
    slug: 'bulk-action',
    term: 'Bulk action',
    hint: 'One change applied to many selected records at once.',
    aliases: ['bulk actions']
  }
]

/** The built-in terms, shaped like instance glossary rows (ids are negative). */
export const CORE_GLOSSARY: GlossaryTerm[] = CORE.map((c, i) => ({
  id: -(i + 1),
  term: c.term,
  slug: c.slug,
  aliases: c.aliases ?? [],
  definition: c.hint,
  ui_hint: c.hint,
  query_slug: null,
  query_note: null,
  collection: null,
  updated_at: null,
  builtin: true
}))

/** One line for a tooltip: the given hint, else the definition's first sentence. */
export function uiHint(t: Pick<GlossaryTerm, 'definition' | 'ui_hint'>): string {
  const given = t.ui_hint?.trim()
  if (given) return given
  const d = (t.definition ?? '').trim().replace(/\s+/g, ' ')
  const first = d.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? d
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first
}

const key = (s: string) => s.trim().toLowerCase()

/**
 * Built-in terms with the instance's entries laid over them: an instance term
 * whose slug, term or alias names a built-in one replaces it (and takes over
 * its slug, so <Term id="pipeline"> finds the instance wording); every other
 * instance term is added. Pure.
 */
export function mergeGlossary(core: GlossaryTerm[], instance: GlossaryTerm[]): GlossaryTerm[] {
  const byForm = new Map<string, GlossaryTerm>()
  for (const c of core) for (const f of [c.slug, c.term, ...c.aliases]) byForm.set(key(f), c)
  const replaced = new Map<string, GlossaryTerm>()
  const extra: GlossaryTerm[] = []
  for (const t of instance) {
    const hit = [t.slug, t.term, ...(t.aliases ?? [])]
      .map((f) => byForm.get(key(f)))
      .find((c): c is GlossaryTerm => !!c)
    if (hit && !replaced.has(hit.slug)) replaced.set(hit.slug, { ...t, overrides: hit.slug })
    else extra.push(t)
  }
  return [...core.map((c) => replaced.get(c.slug) ?? c), ...extra]
}

/** A term by slug (a built-in slug finds the instance entry that replaced it). */
export function findGlossaryTerm(list: GlossaryTerm[], id: string): GlossaryTerm | null {
  const k = key(id)
  return (
    list.find((t) => key(t.slug) === k || (t.overrides && key(t.overrides) === k)) ??
    list.find((t) => key(t.term) === k || t.aliases.some((a) => key(a) === k)) ??
    null
  )
}

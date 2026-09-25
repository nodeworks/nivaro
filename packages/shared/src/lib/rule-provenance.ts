/**
 * Where a rule-derived grid value came from — phrased for the "auto" chip's
 * popover. Mirrors the server's RuleProvenance (routes/field-rules.ts): the
 * rule that wrote the value and, for a precedence chain, every source it
 * tried with the labels of the records each one read.
 */
export interface RuleProvenanceSource {
  index: number
  source_type: string
  source_field: string
  source_related_field: string
  o2m_collection?: string
  filter_field?: string
  filter_value?: string | null
  via?: { collection: string; id: string } | null
  matched?: { collection: string; id: string } | null
  via_label?: string | null
  matched_label?: string | null
  filter_label?: string | null
  miss?: string
  value?: unknown
}

export interface RuleProvenance {
  rule_index: number
  target_type: string
  trigger_field: string | null
  trigger_value: unknown
  trigger_op: string | null
  trigger_expected: string | null
  trigger_related_field: string | null
  target_value: string | null
  trigger_expected_label?: string | null
  trigger_value_label?: string | null
  value: unknown
  sources?: RuleProvenanceSource[]
}

export interface ProvenanceStory {
  /** The derived value, labelled when the caller can. */
  value: string
  /** "Rule 12 · runs when Category is set" */
  rule: string
  /** How the value was produced — the source that answered, or the rule's own action. */
  winner: string
  /** Sources the chain checked before the winner, each with why it gave nothing. */
  tried: string[]
}

const words = (s: string) => s.replace(/_/g, ' ')
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const OP_TEXT: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  contains: 'contains',
  null: 'is empty',
  nnull: 'is set'
}
const MISS_TEXT: Record<string, string> = {
  'gate-closed': 'not applicable',
  'no-value': 'empty',
  'no-match': 'no row',
  'no-record': 'record missing',
  error: 'lookup failed',
  misconfigured: 'misconfigured'
}

interface Opts {
  /** Label for the derived value (an M2O id → its display label). */
  labelOf?: (v: unknown) => string
  /** Label for a row field ("category" → "Category"); `$parent.x` = the record's field. */
  fieldLabel?: (f: string) => string
}

function defaultFieldLabel(f: string): string {
  return cap(words(f))
}

/** `$parent.<field>` names the parent record's field; everything else is a
 *  row field the caller can label. */
function labelWith(opts: Opts, f: string): string {
  if (f.startsWith('$parent.')) return `the record's ${words(f.slice(8))}`
  return (opts.fieldLabel ?? defaultFieldLabel)(f)
}

/** One source, as one short line: what it read, then → value or — why not. */
export function describeSource(src: RuleProvenanceSource, opts: Opts = {}): string {
  const label = (f: string) => labelWith(opts, f)
  const record = (
    lbl: string | null | undefined,
    r: { collection: string; id: string } | null | undefined
  ) => lbl ?? (r ? `${words(r.collection)} #${r.id}` : null)
  const tail =
    src.value != null
      ? ` → ${opts.labelOf?.(src.value) ?? String(src.value)}`
      : ` — ${MISS_TEXT[src.miss ?? ''] ?? 'empty'}`
  switch (src.source_type) {
    case 'o2m_filtered': {
      const who = record(src.via_label, src.via) ?? label(src.source_field)
      const filt = src.filter_label ?? src.filter_value
      return `${cap(words(src.o2m_collection ?? 'lookup'))} for ${who}${filt ? ` × ${filt}` : ''}${tail}`
    }
    case 'relation_field': {
      const who = record(src.via_label, src.via)
      return `${label(src.source_field)}${who ? ` ${who}` : ''}'s ${words(src.source_related_field)}${tail}`
    }
    case 'parent_m2o': {
      const who = record(src.via_label, src.via)
      return `${label(`$parent.${src.source_field}`)}${who ? ` ${who}` : ''} → ${words(src.source_related_field)}${tail}`
    }
    case 'o2m_first':
      return `First ${words(src.source_field)} row → ${words(src.source_related_field)}${tail}`
    default:
      return `${src.source_type} ${words(src.source_field)}.${words(src.source_related_field)}${tail}`
  }
}

/** The story behind one derived value. */
export function explainProvenance(p: RuleProvenance, opts: Opts = {}): ProvenanceStory {
  const label = (f: string) => labelWith(opts, f)
  const value = p.value != null ? (opts.labelOf?.(p.value) ?? String(p.value)) : '—'
  const trigger = p.trigger_field
    ? `runs when ${label(p.trigger_field)}${
        p.trigger_related_field
          ? ` (${words(p.trigger_related_field.replace(/\.__(entity|id)__$/, ''))})`
          : ''
      } ${OP_TEXT[p.trigger_op ?? 'eq'] ?? p.trigger_op ?? 'is'}${
        p.trigger_expected != null && p.trigger_op !== 'null' && p.trigger_op !== 'nnull'
          ? ` ${p.trigger_expected_label ?? p.trigger_expected}`
          : ''
      }`
    : 'always runs'
  const rule = `Rule ${p.rule_index + 1} · ${trigger}`
  if (p.target_type === 'precedence') {
    const sources = p.sources ?? []
    const winIdx = sources.findIndex((s) => s.value != null)
    const winner =
      winIdx >= 0
        ? describeSource(sources[winIdx], opts)
        : 'No source answered — the value was left empty'
    const tried = (winIdx >= 0 ? sources.slice(0, winIdx) : sources).map((s) =>
      describeSource(s, opts)
    )
    return { value, rule, winner, tried }
  }
  if (p.target_type === 'relation_field') {
    return {
      value,
      rule,
      winner: `Copied from ${label(p.trigger_field ?? '')}'s ${words(p.target_value ?? '')}`,
      tried: []
    }
  }
  if (p.target_type === 'clear') return { value, rule, winner: 'Cleared by the rule', tried: [] }
  return { value, rule, winner: `Set to ${value} by the rule`, tried: [] }
}

import type { Field, MapSpec, Problem } from './api'
import { humanizePath, humanizeSegment, type PathNames, singular } from './field-map/labels'

// ─── Problem copy ────────────────────────────────────────────────────────────
// The server sends each render problem with a machine `code` + small `params`
// and its output `path`; the editor composes the sentence a person reads here:
// it names the field plainly ("Shipping location → Inventory org", "Material 1
// → Quantity"), says which record, and says the fix. Raw paths only ever go in
// the tooltip. An unknown or missing code falls back to the server's message.

export interface ProblemCopy {
  /** What the person reads. */
  text: string
  /** Raw detail for the tooltip: the output path and the server's own message. */
  tip: string
}

/** A problem with its composed copy (what the field map and panels render). */
export type ShownProblem = Problem & ProblemCopy

export interface ProblemCopyOpts {
  /** The preview record's label ("IR-004818 · Node split…"); only its first part is used. */
  recordLabel?: string | null
  /** The field map the problem came from — names list items ("Material 1"). */
  spec?: MapSpec | null
  /** Partner name for locked keys (the external API name). */
  partner?: string | null
  /** Collection display names for record paths ("Purchase order → Number"). */
  names?: PathNames | null
}

/** "IR-004818 · Node split staging" → "IR-004818". */
export function shortRecordLabel(label: string | null | undefined): string | null {
  const t = label?.split(' · ')[0]?.trim()
  return t ? t : null
}

type Frame = { alias: string; label: string }

/** A list item as a person says it: "Material 1". */
function itemLabel(list: Field, index: number): string {
  const src = list.list?.source?.split('.').filter(Boolean).pop() ?? list.key
  const noun = singular(humanizeSegment(src)) || list.key
  return `${noun} ${index + 1}`
}

/**
 * Walk an output path (`orderDetails[0].whToQuantity`) through the spec:
 * the plain label ("Material 1 → whToQuantity") and the list frames it passes.
 */
export function outputPathLabel(
  path: string,
  fields: Field[] | null | undefined
): { label: string; frames: Frame[] } {
  const frames: Frame[] = []
  const words: string[] = []
  let level: Field[] | null = fields ?? null
  for (const raw of path.split('.').filter(Boolean)) {
    const m = /^(.*?)((?:\[\d+\])*)$/.exec(raw)
    const key = m?.[1] ?? raw
    const idx = [...(m?.[2] ?? '').matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))
    const field: Field | null = level?.find((f) => f.key === key) ?? null
    if (field?.type === 'list' && idx.length) {
      const label = itemLabel(field, idx[0])
      frames.push({ alias: field.list?.item || 'line', label })
      words.push(label)
    } else {
      words.push(idx.length ? `${key} ${idx[0] + 1}` : key)
    }
    level = field?.children ?? null
  }
  return { label: words.join(' → '), frames }
}

/**
 * A source path as a person says it. Inside a list item the alias names the
 * item: `line.quantity` in the first material → owner "Material 1", "Quantity".
 */
function sourceParts(
  source: string,
  frames: Frame[],
  names?: PathNames | null
): { owner: string | null; label: string; full: string } {
  const head = source.split('.')[0]?.replace(/\[\d*\]/g, '') ?? ''
  const frame = [...frames].reverse().find((f) => f.alias === head)
  if (frame) {
    const rest = source.split('.').slice(1).filter(Boolean)
    const label = rest.map((s) => humanizeSegment(s)).join(' → ')
    return { owner: frame.label, label, full: label ? `${frame.label} → ${label}` : frame.label }
  }
  const label = humanizePath(source, null, names)
  return { owner: null, label, full: label }
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
const q = (v: unknown): string => `‘${str(v) ?? ''}’`

/** Compose the sentence for one problem. */
export function problemCopy(p: Problem, opts: ProblemCopyOpts = {}): ProblemCopy {
  const tip = p.path ? `${p.path} — ${p.message}` : p.message
  const text = compose(p, opts)
  return { text: text ?? p.message, tip }
}

/** `problemCopy` folded into the problem; same input object → same output object. */
export function makeProblemShower(opts: ProblemCopyOpts) {
  const cache = new WeakMap<Problem, ShownProblem>()
  return (p: Problem): ShownProblem => {
    let hit = cache.get(p)
    if (!hit) {
      hit = { ...p, ...problemCopy(p, opts) }
      cache.set(p, hit)
    }
    return hit
  }
}

function compose(p: Problem, opts: ProblemCopyOpts): string | null {
  const params = (p.params ?? {}) as Record<string, unknown>
  const out = outputPathLabel(p.path ?? '', opts.spec?.fields)
  const record = shortRecordLabel(opts.recordLabel) ?? 'This record'
  const source = str(params.source)
  const src = source ? sourceParts(source, out.frames, opts.names) : null
  /** The field as the person knows it: where the value comes from, else the output key. */
  const subject = src?.full || out.label || 'This field'
  const partner = opts.partner?.trim() || 'The partner'

  switch (p.code) {
    case 'no_value':
    case 'rule_required': {
      if (!src) {
        if (p.code !== 'rule_required') return null
        return `${subject} is required and has no value. Pick where its value comes from, or add an else value.`
      }
      const owner = src.owner ?? record
      const what = src.label || src.full
      const required =
        p.code === 'rule_required' ? `, and ${out.label || 'this field'} is required` : ''
      return `${owner} has no ${what}${required}. Set it on the record, or add an else value.`
    }
    case 'type_number':
      return `${subject} is ${q(params.got)}, not a number. Fix it on the record, or pick a different value.`
    case 'type_boolean':
      return `${subject} is ${q(params.got)}, not yes or no. Fix it on the record, or pick a different value.`
    case 'type_date':
      return `${subject} is ${q(params.got)}, not a date. Fix it on the record, or pick a different value.`
    case 'type_text':
      return params.kind === 'list'
        ? `${subject} is a list, not text. Add a Join a list step, or pick a single value.`
        : `${subject} is a group of values, not text. Pick one of the values inside it.`
    case 'json_invalid':
      return `The formula for ${out.label || 'this field'} doesn’t give valid JSON. Check its output in the formula editor.`
    case 'rule_max_length':
      return `${subject} is ${str(params.length)} characters; at most ${str(params.max)} are allowed. Add a First N characters step, or shorten it on the record.`
    case 'rule_allowed': {
      const allowed = Array.isArray(params.allowed) ? params.allowed.map(String) : []
      const list = allowed.length > 6 ? `${allowed.slice(0, 6).join(', ')}…` : allowed.join(', ')
      return `${subject} is ${q(params.got)}, which isn’t one of the allowed values${list ? ` (${list})` : ''}.`
    }
    case 'rule_pattern':
      return `${subject} is ${q(params.got)}, which isn’t in the format this field’s rule expects.`
    case 'rule_pattern_invalid':
      return `The pattern rule on ${subject} isn’t a valid expression. Fix it under Rules.`
    case 'rule_not_number':
      return `${subject} is ${q(params.got)}, not a number, so its lowest / highest rule can’t be checked.`
    case 'rule_min':
      return `${subject} is ${str(params.got)}; the lowest allowed is ${str(params.min)}.`
    case 'rule_max':
      return `${subject} is ${str(params.got)}; the highest allowed is ${str(params.max)}.`
    case 'rules_ignored':
      return `Rules on ${subject} are ignored — it’s a group. Put them on the fields inside it.`
    case 'secret_unknown':
      return `This API has no ${str(params.name) ?? ''} secret yet. Add it under Body secrets on the API page.`
    case 'secret_none':
      return `Choose which secret ${out.label || 'this field'} sends.`
    case 'secret_not_text':
      return `${out.label || 'This field'} sends a secret, so its type must be Text.`
    case 'no_field':
      return `Choose a record field for ${out.label || 'this field'}.`
    case 'list_no_source':
      return `Choose what the ${out.label || 'list'} list comes from.`
    case 'list_not_list':
      return `${src?.full ?? 'The source'} isn’t a list on ${record}. Choose a different source for ${out.label || 'this list'}.`
    case 'list_scalar_children':
      return `${out.label || 'This list'} sends plain values, so it needs exactly one field inside.`
    case 'formula_error':
      return `The formula for ${out.label || 'this field'} has an error: ${str(params.detail) ?? ''}`
    case 'condition_error': {
      const field = str(params.field)
      return `The condition on ${field ? humanizePath(field) : 'a field'} for ${out.label || 'this field'} couldn’t be checked.`
    }
    case 'duplicate_key':
      return `Two fields here are named ${str(params.key)}. Rename one of them.`
    case 'empty_key':
      return 'A field has no name. Name it, or remove it.'
    case 'number_key':
      return `${str(params.key)} is a number, so it’s sent first, not where it sits. Rename it if the order matters.`
    case 'locked_missing':
      return `${partner} needs ${str(params.key)}, but it’s no longer in the field map. Add it back, or reset to the file default.`
    case 'locked_missing_output':
      return `The output no longer has ${str(params.key)}, which Nivaro reads back to confirm ${partner === 'The partner' ? 'the partner' : partner} got it.`
    default:
      return null
  }
}

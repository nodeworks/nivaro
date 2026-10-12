/**
 * Plain-language sentences for access and ownership facts.
 *
 * Every function here is PURE: it takes facts another service already
 * computed (record-access gates, owner resolution, the permission simulator,
 * the owner-gap advisor) and phrases them. Nothing here decides access — a
 * sentence can only ever repeat what the deterministic services found, so the
 * words and the behaviour cannot drift apart. The AI tools hand these same
 * facts (and sentences) to the model, which phrases them again for the person
 * asking; it never reasons about access on its own.
 */

/** "A", "A and B", "A, B and C" — capped, with "and 4 more". */
export function listPhrase(items: string[], conj = 'and', cap = 6): string {
  const clean = items.map((s) => String(s).trim()).filter(Boolean)
  if (clean.length === 0) return ''
  if (clean.length > cap) {
    const shown = clean.slice(0, cap)
    return `${shown.join(', ')} ${conj} ${clean.length - cap} more`
  }
  if (clean.length === 1) return clean[0]
  return `${clean.slice(0, -1).join(', ')} ${conj} ${clean[clean.length - 1]}`
}

/** 'inventory_request_materials' → 'inventory request materials'. */
export function humanCollection(collection: string, displayName?: string | null): string {
  const d = (displayName ?? '').trim()
  // 'Inventory Request Lines' → 'inventory request lines'; acronyms ('PO',
  // 'SLA') keep their case so they still read as names.
  if (d)
    return d
      .split(/\s+/)
      .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
      .join(' ')
  return collection.replace(/_/g, ' ')
}

/** 'divisions.short_name' → 'Divisions'; a configured label always wins. */
export function fieldLabel(field: string, labels?: Map<string, string>): string {
  const hit = labels?.get(field)
  if (hit?.trim()) return hit.trim()
  const head = field.split('.')[0]
  return head.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 'workflows' → 'workflow', 'addresses' stays — a light touch, not a stemmer. */
export function singular(noun: string): string {
  if (/[^aeiou]ies$/i.test(noun)) return `${noun.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/i.test(noun)) return noun.slice(0, -2)
  if (/[^su]s$/i.test(noun)) return noun.slice(0, -1)
  return noun
}

/** 'Zone' + 'Zone 4' → 'Zone 4'; 'Region' + 'North' → 'Region North'. */
export function labelledValue(label: string, value: string): string {
  const l = label.trim()
  const v = value.trim()
  if (!l) return v
  return v.toLowerCase().startsWith(l.toLowerCase()) ? v : `${l} ${v}`
}

/** 2700000 → '2.7M', 4271 → '4,271'. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  return Math.round(n).toLocaleString('en-US')
}

export function personName(p: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  name?: string | null
}): string {
  const n = (p.name ?? '').trim() || [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
  return n || (p.email ?? '').trim() || 'someone'
}

// ── #1889 What narrowed an answer ────────────────────────────────────────────

export interface NarrowingFacts {
  /** A row-level security rule on the role applies to this collection. */
  rowFilter: boolean
  /** Restrict-mode User Scopes that route to this collection, with the
   *  person's OWN allowed values (they already know these — nothing hidden
   *  is revealed by naming them). */
  scopes: Array<{ label: string; values: string[] }>
  /** The role's policy lists only some fields. */
  fieldsLimited: boolean
  /** A strict dimension hides the whole collection. */
  strict?: string | null
}

/**
 * "Limited to Zone 1 by your Zone filter, and a row rule on your role" — or
 * null when nothing narrowed the answer. Deliberately says WHAT shaped the
 * result, never how many rows were left out: a count of hidden rows is
 * itself information the person is not allowed.
 */
export function describeNarrowing(f: NarrowingFacts): string | null {
  const parts: string[] = []
  if (f.strict) parts.push(`your ${f.strict} filter hides this collection entirely`)
  for (const s of f.scopes) {
    const vals = listPhrase(s.values, 'or', 5)
    parts.push(vals ? `your ${s.label} filter (${vals})` : `your ${s.label} filter`)
  }
  if (f.rowFilter) parts.push('a row rule on your role')
  const shaped = parts.length > 0 ? `limited by your access — ${listPhrase(parts)}` : ''
  const fields = f.fieldsLimited ? 'some fields are hidden by your role' : ''
  if (!shaped && !fields) return null
  const sentence = [shaped, fields].filter(Boolean).join('; ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

// ── #1956 Why someone owns a record ─────────────────────────────────────────

export interface OwnerSource {
  kind: 'group' | 'default_group' | 'manual' | 'fallback' | 'delegate'
  group_name?: string | null
  /** The group's filters, each with the record's own value. */
  matched?: Array<{
    field?: string
    label: string
    wants: string
    record_value: string
    /** The asker's role cannot read this field — say so, never the value. */
    hidden?: boolean
  }>
  /** Joined through a team linked to the group. */
  via_team?: string | null
  /** fallback: the record field that names this person. */
  field_label?: string | null
  /** delegate: who they stand in for, and until when. */
  for_name?: string | null
  until?: string | null
  /** manual: who added them. */
  added_by?: string | null
}

export function ownerSourceSentence(name: string, src: OwnerSource): string {
  switch (src.kind) {
    case 'group': {
      const g = src.group_name?.trim()
        ? `the owner group "${src.group_name.trim()}"`
        : 'an owner group'
      const why =
        src.matched && src.matched.length > 0
          ? ` — it covers records whose ${listPhrase(
              src.matched.map((m) => `${m.label} is ${m.wants}`)
            )}, and this record's ${listPhrase(
              src.matched.map((m) =>
                m.hidden
                  ? `${m.label} is not visible to you`
                  : `${m.label} is ${m.record_value || 'empty'}`
              )
            )}`
          : ''
      const team = src.via_team
        ? ` ${name} is in the team "${src.via_team}", which sits in it.`
        : ''
      return `${name} owns this step through ${g}${why}.${team}`
    }
    case 'default_group': {
      const g = src.group_name?.trim() ? `"${src.group_name.trim()}"` : 'the default group'
      const team = src.via_team ? ` (through the team "${src.via_team}")` : ''
      return `No specific owner group matches this record, so the fallback group ${g} applies and ${name} is in it${team}.`
    }
    case 'manual':
      return `${name} was added to this record by hand${src.added_by ? ` by ${src.added_by}` : ''}.`
    case 'fallback':
      return `${name} owns this record because they are its ${src.field_label ?? 'named person'}.`
    case 'delegate':
      return `${name} stands in for ${src.for_name ?? 'an owner'}, who is out of office${
        src.until ? ` until ${src.until}` : ''
      }.`
  }
}

// ── #2012 Why records are unowned ────────────────────────────────────────────

export interface OwnerGapFacts {
  count: number
  /** What the records are ('inventory requests'); default 'record(s)'. */
  noun?: string | null
  state_label: string
  /** label → the records' value. */
  dims: Array<{ label: string; value: string }>
  /** dimension values no owner group mentions at all (label → value). */
  uncovered: Array<{ label: string; value: string }>
  suggestion: { group_label: string; matched: string[]; missing: string[] } | null
}

export function ownerGapSentence(f: OwnerGapFacts): string {
  const what = f.dims.map((d) => d.value).filter(Boolean)
  const noun = f.noun?.trim()
    ? f.count === 1
      ? singular(f.noun.trim())
      : f.noun.trim()
    : `record${f.count === 1 ? '' : 's'}`
  const subject = `${f.count.toLocaleString('en-US')}${what.length ? ` ${what.join(' ')}` : ''} ${noun} in ${f.state_label}`
  const verb = f.count === 1 ? 'matches' : 'match'
  let why: string
  if (f.uncovered.length > 0) {
    why = `because no group covers ${listPhrase(
      f.uncovered.map((u) => labelledValue(u.label, u.value)),
      'or'
    )}`
  } else if (f.dims.length > 0) {
    why = `because no group covers this combination of ${listPhrase(
      f.dims.map((d) => d.label.toLowerCase())
    )}`
  } else {
    why = `because ${f.count === 1 ? 'its' : 'their'} dimension values could not be read`
  }
  let tail = ''
  if (f.suggestion) {
    tail = ` The closest group is "${f.suggestion.group_label}"`
    if (f.suggestion.matched.length > 0)
      tail += `: it matches on ${listPhrase(f.suggestion.matched)}`
    if (f.suggestion.missing.length > 0)
      tail += `${f.suggestion.matched.length > 0 ? ' but' : ':'} it wants ${listPhrase(f.suggestion.missing)}`
    tail += '.'
  }
  return `${subject} ${verb} no owner group ${why}.${tail}`
}

// ── #1958 A role change in words ─────────────────────────────────────────────

export interface RoleChangeFact {
  collection_label: string
  action: string
  grant: boolean
  /** Approximate rows in the collection (null = unknown). */
  rows: number | null
  /** The change does nothing (wildcard still covers it, already held…). */
  no_effect?: string | null
}

const ACTION_VERB: Record<string, string> = {
  read: 'read',
  create: 'create',
  update: 'update',
  delete: 'delete'
}

export function roleChangeSentence(
  roleName: string,
  changes: RoleChangeFact[],
  members: number
): string {
  if (changes.length === 0) return `No change to ${roleName}.`
  const phrase = (c: RoleChangeFact) =>
    `${ACTION_VERB[c.action] ?? c.action} on ${c.collection_label}${
      c.rows != null ? ` (${compactCount(c.rows)} row${c.rows === 1 ? '' : 's'})` : ''
    }`
  const effective = changes.filter((c) => !c.no_effect)
  const gains = effective.filter((c) => c.grant).map(phrase)
  const losses = effective.filter((c) => !c.grant).map(phrase)
  const parts: string[] = []
  if (gains.length) parts.push(`gain ${listPhrase(gains, 'and', 8)}`)
  if (losses.length) parts.push(`lose ${listPhrase(losses, 'and', 8)}`)
  const who =
    members > 0
      ? ` This affects ${members.toLocaleString('en-US')} ${members === 1 ? 'person' : 'people'}.`
      : ' Nobody holds this role yet.'
  const noEffect = changes.filter((c) => c.no_effect).map((c) => c.no_effect as string)
  const noEffectText = noEffect.length ? ` ${noEffect.join(' ')}` : ''
  if (parts.length === 0)
    return `These changes would not alter what ${roleName} can do.${noEffectText}`
  return `${roleName} would ${parts.join(' and ')}.${who}${noEffectText}`
}

// ── #1959 A person's access in words ─────────────────────────────────────────

export interface PersonCollectionFact {
  collection_label: string
  visible: number | null
  total: number | null
  can_update: boolean
  scopes: Array<{ label: string; values: string[] }>
  row_filter: boolean
  strict?: string | null
}

export function personCollectionSentence(name: string, f: PersonCollectionFact): string {
  const reasons: string[] = []
  for (const s of f.scopes)
    reasons.push(`their ${s.label} filter is ${listPhrase(s.values, 'or', 5) || '(none)'}`)
  if (f.row_filter) reasons.push('a row rule on their role narrows it')
  reasons.push(`their role reads ${f.collection_label}`)
  const edit = f.can_update ? 'and can edit them' : 'but cannot edit them'
  if (f.strict)
    return `${name} sees no ${f.collection_label}: their ${f.strict} filter is strict and ${f.collection_label} has no ${f.strict} link.`
  if (f.visible != null && f.total != null && f.visible < f.total)
    return `${name} sees ${f.visible.toLocaleString('en-US')} of ${f.total.toLocaleString('en-US')} ${f.collection_label} because ${listPhrase(reasons)}, ${edit}.`
  return `${name} sees all ${f.total != null ? `${f.total.toLocaleString('en-US')} ` : ''}${f.collection_label} ${edit}.`
}

export function personCannotSentence(name: string, labels: string[]): string | null {
  if (labels.length === 0) return null
  return `${name} cannot edit ${listPhrase(labels, 'or', 8)}.`
}

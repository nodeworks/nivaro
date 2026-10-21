import { titleCase } from '../../../lib/utils'
import {
  type CommandEnv,
  type CommandIntent,
  fieldLabel,
  namedGroups,
  placedFields,
  placementOf
} from './intents'

/**
 * The command palette's own parser (#2586): the common verbs, read without
 * AI, with forgiving name matching (label or key, any case, partial words,
 * small typos). Several commands can go in one line, split by ";".
 *
 *   move Shipping Location to Materials      move Zone after Region
 *   make Zone required [for Finance]         make Notes optional / read-only
 *   hide Notes / show Notes                  rename Notes to "Comments"
 *   rename section Details to Basics         set width Zone 6 / make Zone half
 *   add Region to Location                   add step Shipping [after Details]
 *   remove Notes                             collapse Extras / expand Extras
 *
 * A name that matches two things equally well is an error naming both; text
 * that is not one of these commands is `unknown` (the palette offers AI).
 */

export type ParseResult =
  | { ok: true; intents: CommandIntent[] }
  | { ok: false; error: string; unknown: boolean }

interface Cand<T> {
  value: T
  names: string[]
  display: string
}

type Match<T> = { ok: true; value: T; score: number } | { ok: false; error: string }

const STOP = /^(the|a|an|field|section|step|tab|group)\s+|\s+(field|section|step|tab|group)$/g

export function normName(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/[“”"'‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  for (let i = 0; i < 3; i++) t = t.replace(STOP, '').trim()
  return t
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 3) return 0
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const row = [i]
    for (let j = 1; j <= n; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return 1 - prev[n] / Math.max(m, n)
}

/** 0 = no match; 100 = exact. */
export function nameScore(query: string, name: string): number {
  const q = normName(query)
  const n = normName(name)
  if (!q || !n) return 0
  if (q === n) return 100
  const qc = q.replace(/ /g, '')
  const nc = n.replace(/ /g, '')
  if (qc === nc) return 95
  if (n.startsWith(q)) return 80
  if (n.includes(q)) return 60
  const nt = n.split(' ')
  if (q.split(' ').every((w) => nt.some((t) => t.startsWith(w)))) return 50
  const sim = similarity(qc, nc)
  return sim >= 0.75 ? Math.round(40 * sim) : 0
}

function pick<T>(query: string, cands: Cand<T>[], what: string): Match<T> {
  let best = 0
  let hits: Cand<T>[] = []
  for (const c of cands) {
    const s = Math.max(0, ...c.names.map((n) => nameScore(query, n)))
    if (s === 0 || s < best) continue
    if (s > best) {
      best = s
      hits = [c]
    } else hits.push(c)
  }
  const q = query.trim()
  if (hits.length === 0) return { ok: false, error: `No ${what} called “${q}” on this form` }
  if (hits.length > 1) {
    const names = hits.slice(0, 4).map((h) => h.display)
    return {
      ok: false,
      error: `“${q}” could be ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]} — be more specific`
    }
  }
  return { ok: true, value: hits[0].value, score: best }
}

const UNGROUPED = /^(ungrouped|no section|outside( (of )?(the )?sections?)?|top( of the form)?)$/

function matchers(env: CommandEnv) {
  const placed = placedFields(env.bundle)
  const placedNames = new Set(placed.map((p) => p.field))
  const fieldCands: Cand<string>[] = placed.map((p) => ({
    value: p.field,
    names: [fieldLabel(env, p), p.field],
    display: fieldLabel(env, p)
  }))
  const otherCands: Cand<string>[] = env.fields
    .filter((f) => !placedNames.has(f.field) && !f.field.startsWith('__'))
    .map((f) => ({
      value: f.field,
      names: [f.label || titleCase(f.field), f.field],
      display: f.label || titleCase(f.field)
    }))
  const groupCands: Cand<string>[] = namedGroups(env.bundle).map((g) => ({
    value: g.key,
    names: [g.label, g.key],
    display: g.label || titleCase(g.key)
  }))
  return {
    field: (q: string) => pick(q, fieldCands, 'field'),
    newField: (q: string) => pick(q, otherCands, 'field (not on the form yet)'),
    group: (q: string) => pick(q, groupCands, 'section'),
    target: (q: string): Match<string | null> =>
      UNGROUPED.test(normName(q).replace(/^the /, ''))
        ? { ok: true, value: null, score: 100 }
        : pick(q, groupCands, 'section')
  }
}

/**
 * Two names around a connector word ("X to Y"), when either may contain it:
 * every split is tried and the best-matching pair wins.
 */
function splitPair<A, B>(
  text: string,
  connector: RegExp,
  left: (s: string) => Match<A>,
  right: (s: string) => Match<B>
): { ok: true; a: A; b: B } | { ok: false; error: string } {
  const re = new RegExp(`\\s+(?:${connector.source})\\s+`, 'gi')
  let best: { a: A; b: B; score: number } | null = null
  let firstError: string | null = null
  for (const m of text.matchAll(re)) {
    const l = left(text.slice(0, m.index))
    const r = right(text.slice((m.index ?? 0) + m[0].length))
    if (l.ok && r.ok) {
      const score = l.score + r.score
      if (!best || score > best.score) best = { a: l.value, b: r.value, score }
    } else firstError ??= !l.ok ? l.error : !r.ok ? r.error : null
  }
  if (best) return { ok: true, a: best.a, b: best.b }
  return { ok: false, error: firstError ?? 'Say where it goes' }
}

/** "6", "half", "½", "1/2", "full" → a width. */
export function parseWidth(word: string): 12 | 6 | 4 | 3 | null {
  const w = word
    .toLowerCase()
    .replace(/[-\s]*width$/, '')
    .trim()
  if (/^(12|full|whole|1\/1)$/.test(w)) return 12
  if (/^(6|half|½|1\/2)$/.test(w)) return 6
  if (/^(4|a third|one third|third|⅓|1\/3)$/.test(w)) return 4
  if (/^(3|a quarter|one quarter|quarter|¼|1\/4)$/.test(w)) return 3
  return null
}

const SETTING_WORDS =
  'not required|required|mandatory|optional|read[- ]?only|editable|hidden|visible|' +
  'full[- ]width|full|half[- ]width|half|(?:a |one )?third(?:[- ]width)?|(?:a |one )?quarter(?:[- ]width)?'

type One = { ok: true; intent: CommandIntent } | { ok: false; error: string; unknown: boolean }

function parseOne(raw: string, env: CommandEnv, m: ReturnType<typeof matchers>): One {
  const text = raw
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ')
  const bad = (error: string): One => ({ ok: false, error, unknown: false })
  const ok = (intent: CommandIntent): One => ({ ok: true, intent })
  let r: RegExpMatchArray | null

  // move X before/after Y (a field next to a field, or a section next to a section)
  r = text.match(/^(?:move|put|drag) (.+)$/i)
  if (r) {
    const rest = r[1]
    const rel = splitPair(
      rest,
      /before|above|after|below/,
      (s) => m.field(s),
      (s) => m.field(s)
    )
    const relWord = rest.match(/\s(before|above|after|below)\s/i)?.[1].toLowerCase()
    const before = relWord === 'before' || relWord === 'above'
    if (rel.ok)
      return ok({
        kind: 'move_field',
        field: rel.a,
        to_group: null,
        ...(before ? { before: rel.b } : { after: rel.b })
      })
    if (relWord) {
      const grp = splitPair(
        rest,
        /before|above|after|below/,
        (s) => m.group(s),
        (s) => m.group(s)
      )
      if (grp.ok)
        return ok({
          kind: 'move_group',
          group: grp.a,
          ...(before ? { before: grp.b } : { after: grp.b })
        })
      const into = splitPair(
        rest,
        /before|above|after|below/,
        (s) => m.field(s),
        (s) => m.target(s)
      )
      if (into.ok) return ok({ kind: 'move_field', field: into.a, to_group: into.b })
      return bad(rel.error)
    }
    const to = splitPair(
      rest,
      /to|into|in|under|onto/,
      (s) => m.field(s),
      (s) => m.target(s)
    )
    if (to.ok) return ok({ kind: 'move_field', field: to.a, to_group: to.b })
    return bad(to.error)
  }

  // set width X 6 / set X width to 6 / set the width of X to half
  r =
    text.match(/^set (?:the )?width (?:of )?(.+?) (?:to )?(\S+(?:[- ]width)?)$/i) ??
    text.match(/^set (?:the )?(.+?)(?:'s)? width (?:to )?(\S+)$/i)
  if (r) {
    const width = parseWidth(r[2])
    if (!width) return bad('Width is full, half, third or quarter (12, 6, 4 or 3)')
    const f = m.field(r[1])
    if (!f.ok) return bad(f.error)
    return ok({ kind: 'set_field', field: f.value, width })
  }

  // make X required [for Role] / optional / read-only / editable / hidden / visible / half
  r = text.match(
    new RegExp(
      `^(?:make|set|mark) (.+?) (?:to )?(${SETTING_WORDS})(?: (?:for|to) (?:the )?(.+?)(?: role)?)?$`,
      'i'
    )
  )
  if (r) {
    const f = m.field(r[1])
    if (!f.ok) return bad(f.error)
    const word = r[2].toLowerCase().replace(/[- ]/g, '')
    let role: string | undefined
    if (r[3]) {
      const roleHit = pick(
        r[3],
        env.roles.map((x) => ({ value: x.id, names: [x.name], display: x.name })),
        'role'
      )
      if (!roleHit.ok) return bad(roleHit.error.replace(' on this form', ''))
      role = roleHit.value
    }
    const width = parseWidth(r[2])
    if (width) return ok({ kind: 'set_field', field: f.value, width })
    if (word === 'required' || word === 'mandatory')
      return ok({ kind: 'set_field', field: f.value, required: true, ...(role ? { role } : {}) })
    if (word === 'notrequired' || word === 'optional')
      return ok({ kind: 'set_field', field: f.value, required: false, ...(role ? { role } : {}) })
    if (word === 'readonly') return ok({ kind: 'set_field', field: f.value, readonly: true })
    if (word === 'editable') return ok({ kind: 'set_field', field: f.value, readonly: false })
    if (word === 'hidden') return ok({ kind: 'set_field', field: f.value, hidden: true })
    return ok({ kind: 'set_field', field: f.value, hidden: false })
  }

  // hide X / show X
  r = text.match(/^(hide|show|unhide) (.+)$/i)
  if (r) {
    const f = m.field(r[2])
    if (!f.ok) return bad(f.error)
    return ok({ kind: 'set_field', field: f.value, hidden: r[1].toLowerCase() === 'hide' })
  }

  // rename [section|step|tab|field] X to Y
  r = text.match(/^rename (?:the )?(?:(section|step|tab|group|field) )?(.+)$/i)
  if (r) {
    const noun = r[1]?.toLowerCase()
    const asGroup = noun && noun !== 'field'
    const newName = (s: string): Match<string> => {
      const t = s
        .trim()
        .replace(/^["“'‘]|["”'’]$/g, '')
        .trim()
      return t
        ? { ok: true, value: t.slice(0, 80), score: 0 }
        : { ok: false, error: 'Say the new name' }
    }
    if (!asGroup) {
      const f = splitPair(r[2], /to|as/, (s) => m.field(s), newName)
      if (f.ok) return ok({ kind: 'set_field', field: f.a, label: f.b })
      if (noun === 'field') return bad(f.error)
    }
    const g = splitPair(r[2], /to|as/, (s) => m.group(s), newName)
    if (g.ok) return ok({ kind: 'update_group', group: g.a, label: g.b })
    return bad(g.error)
  }

  // add section|step X [after Y]
  r = text.match(
    /^add (?:a |an |new |another )*(section|step|tab) (?:called |named )?(.+?)(?: after (.+))?$/i
  )
  if (r) {
    const type = r[1].toLowerCase() === 'section' ? 'section' : 'tab'
    let label = r[2].trim().replace(/^["“'‘]|["”'’]$/g, '')
    let after: string | undefined
    if (r[3]) {
      const a = m.group(r[3])
      if (a.ok) after = a.value
      else label = `${label} after ${r[3]}`
    }
    if (!label) return bad('Give the new section a name')
    return ok({ kind: 'add_group', label, group_type: type, ...(after ? { after } : {}) })
  }

  // add X to Y
  r = text.match(/^add (.+)$/i)
  if (r) {
    const p = splitPair(
      r[1],
      /to|into|in|under/,
      (s) => m.newField(s),
      (s) => m.target(s)
    )
    if (p.ok) return ok({ kind: 'add_field', field: p.a, to_group: p.b })
    const placed = m.field(r[1].split(/\s+(?:to|into|in)\s+/i)[0])
    if (placed.ok && placementOf(env.bundle, placed.value))
      return bad(`${fieldLabel(env, placed.value)} is already on the form — use “move”`)
    if (!/\s(to|into|in|under)\s/i.test(r[1]))
      return bad('Say where it goes: add <field> to <section>')
    return bad(p.error)
  }

  // remove X [from the form]
  r = text.match(/^(?:remove|delete|drop) (.+?)(?: from (?:the |this )?(?:form|layout))?$/i)
  if (r) {
    const f = m.field(r[1])
    if (!f.ok) return bad(f.error)
    return ok({ kind: 'remove_field', field: f.value })
  }

  // collapse X / expand X
  r = text.match(/^(collapse|expand|open|close) (.+)$/i)
  if (r) {
    const g = m.group(r[2])
    if (!g.ok) return bad(g.error)
    const w = r[1].toLowerCase()
    return ok({
      kind: 'update_group',
      group: g.value,
      collapsed: w === 'collapse' || w === 'close'
    })
  }

  return { ok: false, error: 'That is not a command the palette knows', unknown: true }
}

export function parseCommand(text: string, env: CommandEnv): ParseResult {
  const parts = text
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return { ok: false, error: 'Type a command', unknown: false }
  const m = matchers(env)
  const intents: CommandIntent[] = []
  for (const part of parts) {
    const one = parseOne(part, env, m)
    if (!one.ok)
      return {
        ok: false,
        error: parts.length > 1 ? `“${part}”: ${one.error}` : one.error,
        unknown: one.unknown
      }
    intents.push(one.intent)
  }
  return { ok: true, intents }
}

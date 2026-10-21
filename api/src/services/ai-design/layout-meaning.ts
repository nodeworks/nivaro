import type { LayoutBundle, LayoutOp } from '../layout-ops-apply.js'
import {
  type AssistContext,
  factsForPlacement,
  groupLabel,
  helpTextOf,
  isFieldPlacement,
  isShown,
  placementLabel
} from './layout-assist-context.js'
import type { LayoutFinding } from './layout-review.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * Two review findings only the model can judge (#2686 #2687), asked in one
 * call beside the layout review:
 *
 *   - help text that disagrees with what the form does — the prompt carries
 *     the computed facts per field (required where, locked where, hidden for
 *     whom, needed by which move), so "optional" next to "must be filled
 *     before Approve" is visible to it — with a rewrite;
 *   - two fields with different labels that mean the same thing (Vendor and
 *     Supplier); identical labels stay the rules pass's duplicate_label.
 *
 * The answer is data: every field it names must be a visible field of the
 * layout (a help conflict also needs help text to conflict with); anything
 * else is dropped and counted. A rewrite comes as a one-op change set the
 * editor applies through its draft (the client merges the note into the
 * placement's overrides as they are then).
 */

const MAX_PAIRS = 6
const MAX_CONFLICTS = 10
const MAX_FIELDS = 150
const HELP_MAX = 300

export interface MeaningChangeSet {
  kind: 'help_rewrite'
  title: string
  steps: string[]
  ops: LayoutOp[]
  base_rev: string
  source: 'ai'
}

export const MEANING_SYSTEM = `You review a data-entry form. You get its visible fields as JSON: key, label, type, section, help text (when it has one) and facts — what the form and its rules actually do with the field.
Answer with ONE JSON object and nothing else:
{"same_meaning":[{"fields":["<field key>","<field key>"],"reason":"<why a person would think they are the same, <=140 chars>"}],
 "help_conflicts":[{"field":"<field key>","problem":"<what the help text says vs what the form does, <=200 chars>","rewrite":"<corrected help text, one or two sentences, <=200 chars>"}]}
Rules: only use field keys from the input. "same_meaning" lists pairs whose labels differ but would hold the same information (e.g. Vendor and Supplier, Start date and Begin date) — never two fields that are clearly different (Start date and End date); an empty list is fine. "help_conflicts" lists only fields whose help text contradicts a fact (says optional but required, says anyone can edit but read-only for a role, names a step that does not need it); keep the rewrite's useful content, fix only the contradiction. Never invent facts.`

export interface MeaningInput {
  field: string
  label: string
  type: string
  section: string
  help?: string
  facts: string[]
}

export function meaningInputs(bundle: LayoutBundle, ctx: AssistContext): MeaningInput[] {
  const seen = new Set<string>()
  const out: MeaningInput[] = []
  for (const p of bundle.placements) {
    if (!isFieldPlacement(p) || !isShown(p) || seen.has(p.field)) continue
    seen.add(p.field)
    const help = helpTextOf(p, ctx)
    out.push({
      field: p.field,
      label: placementLabel(p, ctx),
      type: ctx.fields.get(p.field)?.type ?? 'string',
      section: groupLabel(bundle, p.group_key),
      ...(help ? { help } : {}),
      facts: factsForPlacement(bundle, p, ctx)
    })
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

export function buildMeaningPrompt(collection: string, inputs: MeaningInput[]): string {
  return JSON.stringify({ collection, fields: inputs })
}

export interface MeaningAnswer {
  pairs: Array<{ a: string; b: string; reason: string }>
  conflicts: Array<{ field: string; problem: string; rewrite: string }>
  dropped: number
}

export function parseMeaningAnswer(text: string, inputs: MeaningInput[]): MeaningAnswer {
  const parsed = parseJsonLoose(text) ?? {}
  const byField = new Map(inputs.map((i) => [i.field, i]))
  let dropped = 0
  const pairs: MeaningAnswer['pairs'] = []
  const pairSeen = new Set<string>()
  for (const raw of asArray(parsed.same_meaning)) {
    const o = raw as { fields?: unknown; reason?: unknown }
    const fs = asArray(o?.fields).filter((f): f is string => typeof f === 'string')
    const [a, b] = fs
    const ia = a ? byField.get(a) : undefined
    const ib = b ? byField.get(b) : undefined
    if (fs.length !== 2 || !ia || !ib || a === b) {
      dropped++
      continue
    }
    // Identical labels are the rules' duplicate_label finding.
    if (ia.label.trim().toLowerCase() === ib.label.trim().toLowerCase()) continue
    const key = [a, b].sort().join('|')
    if (pairSeen.has(key)) continue
    pairSeen.add(key)
    pairs.push({ a, b, reason: cleanText(o.reason, 140) ?? 'They look like the same information.' })
    if (pairs.length >= MAX_PAIRS) break
  }
  const conflicts: MeaningAnswer['conflicts'] = []
  const conflictSeen = new Set<string>()
  for (const raw of asArray(parsed.help_conflicts)) {
    const o = raw as { field?: unknown; problem?: unknown; rewrite?: unknown }
    const field = typeof o?.field === 'string' ? o.field : ''
    const input = byField.get(field)
    const rewrite = cleanText(o?.rewrite, HELP_MAX)
    const problem = cleanText(o?.problem, 200)
    if (!input?.help || !rewrite || !problem) {
      dropped++
      continue
    }
    if (conflictSeen.has(field) || rewrite.toLowerCase() === input.help.toLowerCase()) continue
    conflictSeen.add(field)
    conflicts.push({ field, problem, rewrite })
    if (conflicts.length >= MAX_CONFLICTS) break
  }
  return { pairs, conflicts, dropped }
}

/** The answer as review findings; a rewrite carries its one-op change set. */
export function meaningFindings(
  bundle: LayoutBundle,
  inputs: MeaningInput[],
  answer: MeaningAnswer
): Array<LayoutFinding & { change_set?: MeaningChangeSet }> {
  const byField = new Map(inputs.map((i) => [i.field, i]))
  const placementOf = (field: string) =>
    bundle.placements.find((p) => p.field === field && isFieldPlacement(p))
  const groupOf = (field: string) => {
    const key = placementOf(field)?.group_key ?? null
    const g = key ? bundle.groups.find((x) => x.key === key) : undefined
    return g ? { id: g.id ?? null, key: g.key, label: groupLabel(bundle, g.key) } : null
  }
  const out: Array<LayoutFinding & { change_set?: MeaningChangeSet }> = []
  for (const pair of answer.pairs) {
    const a = byField.get(pair.a) as MeaningInput
    const b = byField.get(pair.b) as MeaningInput
    out.push({
      id: `same_meaning:${[pair.a, pair.b].sort().join('|')}`,
      kind: 'same_meaning',
      severity: 'warn',
      source: 'ai',
      field: pair.b,
      field_label: b.label,
      group: groupOf(pair.b),
      message: `"${a.label}" and "${b.label}" look like the same thing: ${pair.reason}`,
      suggestion: `Keep one of them on this form, or relabel both so the difference is clear.`,
      fix: null
    })
  }
  for (const c of answer.conflicts) {
    const input = byField.get(c.field) as MeaningInput
    const p = placementOf(c.field)
    if (!p) continue
    out.push({
      id: `help_conflict:${c.field}`,
      kind: 'help_conflict',
      severity: 'warn',
      source: 'ai',
      field: c.field,
      field_label: input.label,
      group: groupOf(c.field),
      message: `The help text of "${input.label}" disagrees with the form: ${c.problem}`,
      suggestion: `Rewrite: "${c.rewrite}"`,
      fix: null,
      change_set: {
        kind: 'help_rewrite',
        title: 'Use the rewrite',
        steps: [`Help text of "${input.label}" on this form becomes: "${c.rewrite}"`],
        ops: [
          {
            op: 'update_placement',
            at: { field: p.field, group_key: p.group_key },
            patch: { overrides: { note: c.rewrite } }
          }
        ],
        base_rev: bundle.rev,
        source: 'ai'
      }
    })
  }
  return out
}

/** The whole pass; no model or nothing to compare → no findings. Never throws. */
export async function reviewMeaning(
  bundle: LayoutBundle,
  ctx: AssistContext,
  complete: AiComplete | null
): Promise<{ findings: LayoutFinding[]; dropped: number; error: string | null }> {
  const inputs = meaningInputs(bundle, ctx)
  if (!complete || inputs.length < 2) return { findings: [], dropped: 0, error: null }
  try {
    const text = await complete({
      system: MEANING_SYSTEM,
      user: buildMeaningPrompt(ctx.collection, inputs),
      maxTokens: 2500
    })
    const answer = parseMeaningAnswer(text, inputs)
    return {
      findings: meaningFindings(bundle, inputs, answer),
      dropped: answer.dropped,
      error: null
    }
  } catch (err) {
    return {
      findings: [],
      dropped: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300)
    }
  }
}

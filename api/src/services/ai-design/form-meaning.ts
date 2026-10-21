import type { ComposeAsk, ComposeContext } from './form-compose.js'
import { asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * Sections by meaning (#2672): a home section for fields that are not on the
 * form yet, from what the fields MEAN (names, labels, descriptions, relation
 * targets) and what each section already holds. The usage suggestions
 * (#2605) need revisions; this works on a brand-new collection.
 *
 * The editor sends its draft's sections (key, label, field keys) and the
 * fields to place; the answer is checked here (fields of the request that the
 * collection has, section keys of the request) and again by the editor with
 * the ops twin before it is offered.
 */

export const MEANING_MAX_FIELDS = 60
const MAX_GROUPS = 40
const MAX_GROUP_FIELDS = 30
const REASON_MAX = 120

export interface MeaningGroup {
  key: string
  label: string
  fields: string[]
}

export interface MeaningSuggestion {
  field: string
  group_key: string
  reason: string | null
}

export const MEANING_SYSTEM = `You place fields of a data-entry form into the section where they belong by meaning.
You get the form's sections (key, label, the fields already in each) and fields that are not on the form yet, with labels, types, descriptions and relation targets.
Answer with ONE JSON object and nothing else:
{"suggestions":[{"field":"<field key>","section":"<section key>","reason":"<why, <= 12 words>"}]}
Rules: only field keys from "place" and section keys from "sections". Leave a field out when no section fits it. Group by meaning: an address with addresses, money with money, approval with approval.`

/** Sections and fields as the model reads them (keys, labels, metadata — no values). */
export function buildMeaningPrompt(
  ctx: ComposeContext,
  groups: MeaningGroup[],
  fields: string[]
): string {
  const meta = new Map(ctx.fields.map((f) => [f.field, f]))
  const labelOf = (f: string) => meta.get(f)?.label ?? f
  return JSON.stringify({
    collection: ctx.collection,
    collection_label: ctx.label ?? undefined,
    sections: groups.slice(0, MAX_GROUPS).map((g) => ({
      key: g.key,
      label: g.label,
      fields: g.fields.slice(0, MAX_GROUP_FIELDS).map(labelOf)
    })),
    place: fields.slice(0, MEANING_MAX_FIELDS).map((f) => {
      const m = meta.get(f)
      return {
        key: f,
        label: m?.label ?? f,
        type: m?.type,
        description: m?.note ?? undefined,
        relation: m?.relation ?? undefined
      }
    })
  })
}

export function parseMeaningAnswer(
  text: string,
  groups: MeaningGroup[],
  fields: string[]
): { suggestions: MeaningSuggestion[]; dropped: number } {
  const parsed = parseJsonLoose(text) ?? {}
  const wanted = new Set(fields)
  const keys = new Set(groups.map((g) => g.key))
  const out: MeaningSuggestion[] = []
  let dropped = 0
  for (const raw of asArray(parsed.suggestions)) {
    const o = (raw ?? {}) as Record<string, unknown>
    const field = typeof o.field === 'string' ? o.field : ''
    const group = typeof o.section === 'string' ? o.section : ''
    if (!wanted.has(field) || !keys.has(group) || out.some((s) => s.field === field)) {
      dropped++
      continue
    }
    out.push({ field, group_key: group, reason: cleanText(o.reason, REASON_MAX) })
  }
  return { suggestions: out, dropped }
}

export async function suggestByMeaning(
  ask: ComposeAsk,
  ctx: ComposeContext,
  groups: MeaningGroup[],
  fields: string[]
): Promise<{ suggestions: MeaningSuggestion[]; dropped: number }> {
  const answer = await ask(MEANING_SYSTEM, buildMeaningPrompt(ctx, groups, fields), 2000)
  return parseMeaningAnswer(answer, groups, fields)
}

/** The request body, cleaned: sections with keys and labels, fields the collection has. */
export function cleanMeaningRequest(
  body: { groups?: unknown; fields?: unknown } | undefined,
  ctx: ComposeContext
): { groups: MeaningGroup[]; fields: string[] } {
  const known = new Set(ctx.fields.map((f) => f.field))
  const groups: MeaningGroup[] = []
  for (const raw of asArray(body?.groups).slice(0, MAX_GROUPS)) {
    const o = (raw ?? {}) as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.slice(0, 100) : ''
    const label = cleanText(o.label, 80)
    if (!key || key.startsWith('__') || !label || groups.some((g) => g.key === key)) continue
    groups.push({
      key,
      label,
      fields: asArray(o.fields)
        .filter((f): f is string => typeof f === 'string' && known.has(f))
        .slice(0, MAX_GROUP_FIELDS)
    })
  }
  const fields = [
    ...new Set(asArray(body?.fields).filter((f): f is string => typeof f === 'string'))
  ]
    .filter((f) => known.has(f))
    .slice(0, MEANING_MAX_FIELDS)
  return { groups, fields }
}

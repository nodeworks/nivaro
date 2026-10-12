import { db } from '../db/index.js'
import { cosineSim, embedText } from './embeddings.js'

/**
 * Group similar issues (#1861). Open issues are clustered by the meaning of their message and
 * route: each issue is embedded (message with ids and numbers folded away, plus its route),
 * and an issue joins the first group whose lead is close enough. Ten variants of one bug
 * ("Invalid column name 'x'", "...'y'") therefore read as one problem with the variants under it.
 *
 * The grouping is recomputed on demand (10 minute cache). Admins can correct it: an issue can be
 * split out to stand alone, or merged into another issue's group. Those overrides are kept as
 * JSON in nivaro_extension_settings (extension 'nivaro-core', key 'issue_group_overrides') and
 * are applied on top of the cached clustering at read time, so a change shows at once.
 */

export interface IssueGroup {
  lead: { id: number; title: string; severity: string; occurrences: number }
  total_occurrences: number
  variants: Array<{
    id: number
    title: string
    severity: string
    occurrences: number
    similarity: number
    /** An admin put this issue here (merge) rather than the clustering. */
    manual?: boolean
  }>
  /** The lead was split out or had others merged into it by an admin. */
  adjusted?: boolean
}

/** issue id → 'alone' (split out) or the id of the issue whose group it joins (merge). */
export type GroupOverrides = Record<string, 'alone' | number>

const OVERRIDE_EXT = 'nivaro-core'
const OVERRIDE_KEY = 'issue_group_overrides'
const MAX_OVERRIDES = 500

export async function loadGroupOverrides(): Promise<GroupOverrides> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: OVERRIDE_EXT, key: OVERRIDE_KEY })
      .first('value')) as { value: string | null } | undefined
    const raw = row?.value ? (JSON.parse(row.value) as unknown) : null
    if (!raw || typeof raw !== 'object') return {}
    const out: GroupOverrides = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === 'alone' || (typeof v === 'number' && Number.isInteger(v))) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function saveGroupOverrides(next: GroupOverrides): Promise<void> {
  const entries = Object.entries(next).slice(-MAX_OVERRIDES)
  const value = JSON.stringify(Object.fromEntries(entries))
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: OVERRIDE_EXT, key: OVERRIDE_KEY })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({
      extension_id: OVERRIDE_EXT,
      key: OVERRIDE_KEY,
      value,
      updated_at: new Date()
    })
  }
}

/**
 * Admin overrides on top of an automatic grouping. Pure. A merge target that is gone, or that is
 * itself split out / merged elsewhere, is followed at most a few hops and otherwise ignored, so a
 * stale override can never lose an issue.
 */
export function applyGroupOverrides(auto: IssueGroup[], overrides: GroupOverrides): IssueGroup[] {
  if (Object.keys(overrides).length === 0) return auto
  type Member = IssueGroup['lead'] & { similarity: number; manual?: boolean }
  const members = new Map<number, Member>()
  const home = new Map<number, number>() // issue id → group key (the id of its auto lead)
  const autoLead = new Map<number, number>() // group key → auto lead id
  for (const g of auto) {
    members.set(g.lead.id, { ...g.lead, similarity: 1 })
    home.set(g.lead.id, g.lead.id)
    autoLead.set(g.lead.id, g.lead.id)
    for (const v of g.variants) {
      members.set(v.id, { ...v })
      home.set(v.id, g.lead.id)
    }
  }
  const touched = new Set<number>()
  for (const [k, ov] of Object.entries(overrides)) {
    const id = Number(k)
    if (!members.has(id)) continue
    if (ov === 'alone') {
      touched.add(id)
      // Splitting a group's lead hands the group to its busiest remaining variant.
      if (autoLead.get(id) === id) {
        const rest = [...home]
          .filter(([m, g]) => g === id && m !== id && overrides[String(m)] !== 'alone')
          .map(([m]) => members.get(m) as Member)
          .sort((a, b) => b.occurrences - a.occurrences)
        if (rest.length > 0) {
          autoLead.set(rest[0].id, rest[0].id)
          for (const m of rest) home.set(m.id, rest[0].id)
          touched.add(rest[0].id)
        }
      }
      home.set(id, id)
    }
  }
  for (const [k, ov] of Object.entries(overrides)) {
    const id = Number(k)
    if (!members.has(id) || ov === 'alone') continue
    let target = ov
    for (let hop = 0; hop < 4 && typeof overrides[String(target)] === 'number'; hop++) {
      target = overrides[String(target)] as number
    }
    if (target === id || !members.has(target)) continue
    // Join the target's current group; a target that was split out starts its own.
    const g = home.get(target)
    if (g == null) continue
    home.set(id, g)
    const m = members.get(id)
    if (m) m.manual = true
    touched.add(id)
    touched.add(g)
  }
  const byGroup = new Map<number, Member[]>()
  for (const [id, g] of home) {
    const list = byGroup.get(g) ?? []
    list.push(members.get(id) as Member)
    byGroup.set(g, list)
  }
  const out: IssueGroup[] = []
  for (const [key, list] of byGroup) {
    const lead =
      list.find((m) => m.id === autoLead.get(key)) ??
      [...list].sort((a, b) => b.occurrences - a.occurrences)[0]
    const rest = list.filter((m) => m.id !== lead.id).sort((a, b) => b.occurrences - a.occurrences)
    const shape = (m: Member) => ({
      id: m.id,
      title: m.title,
      severity: m.severity,
      occurrences: m.occurrences
    })
    out.push({
      lead: shape(lead),
      total_occurrences: list.reduce((n, m) => n + m.occurrences, 0),
      variants: rest.map((m) => ({
        ...shape(m),
        similarity: m.similarity,
        ...(m.manual ? { manual: true } : {})
      })),
      ...(touched.has(lead.id) || rest.some((m) => m.manual || touched.has(m.id))
        ? { adjusted: true }
        : {})
    })
  }
  return out.sort((a, b) => b.total_occurrences - a.total_occurrences)
}

/** Record an admin split/merge/reset and return the new override map. */
export function nextOverrides(
  current: GroupOverrides,
  action:
    | { op: 'split'; ids: number[] }
    | { op: 'merge'; ids: number[]; into: number }
    | { op: 'reset'; ids?: number[] }
): GroupOverrides {
  const next: GroupOverrides = { ...current }
  if (action.op === 'reset') {
    if (!action.ids) return {}
    for (const id of action.ids) delete next[String(id)]
    return next
  }
  if (action.op === 'split') {
    for (const id of action.ids) next[String(id)] = 'alone'
    return next
  }
  for (const id of action.ids) {
    if (id === action.into) continue
    delete next[String(id)]
    next[String(id)] = action.into
  }
  // The target itself must not be pointing elsewhere or the merge would chase its own tail.
  delete next[String(action.into)]
  return next
}

/** The text that is embedded: volatile parts (uuids, numbers, quoted names) folded away. */
export function normalizeForGrouping(title: string): string {
  return title
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/'[^']{1,80}'/g, "'<x>'")
    .replace(/"[^"]{1,80}"/g, '"<x>"')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/** Greedy clustering over embeddings; pure so it can be tested without a provider. */
export function clusterByVectors<T extends { vec: number[] }>(
  items: T[],
  threshold: number
): Array<{ lead: T; members: Array<{ item: T; sim: number }> }> {
  const groups: Array<{ lead: T; members: Array<{ item: T; sim: number }> }> = []
  for (const item of items) {
    let best: { g: (typeof groups)[number]; sim: number } | null = null
    for (const g of groups) {
      const sim = cosineSim(g.lead.vec, item.vec)
      if (sim >= threshold && (!best || sim > best.sim)) best = { g, sim }
    }
    if (best) best.g.members.push({ item, sim: best.sim })
    else groups.push({ lead: item, members: [] })
  }
  return groups
}

let cache: { at: number; value: IssueGroup[] } | null = null

/** The automatic clustering with the admin's split/merge overrides applied. */
export async function groupSimilarIssues(threshold = 0.8): Promise<IssueGroup[]> {
  const auto = await clusterOpenIssues(threshold)
  return applyGroupOverrides(auto, await loadGroupOverrides())
}

async function clusterOpenIssues(threshold: number): Promise<IssueGroup[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.value
  const rows = (await db('nivaro_issues')
    .whereIn('status', ['open', 'in_progress'])
    .orderBy('occurrence_count', 'desc')
    .limit(150)
    .select('id', 'title', 'severity', 'occurrence_count', 'source')) as Array<{
    id: number
    title: string
    severity: string
    occurrence_count: number | null
    source: string | null
  }>
  const embedded: Array<{ row: (typeof rows)[number]; vec: number[] }> = []
  for (const row of rows) {
    try {
      embedded.push({ row, vec: await embedText(normalizeForGrouping(row.title)) })
    } catch {
      /* an issue that cannot be embedded stands alone below */
      embedded.push({ row, vec: [] })
    }
  }
  const out = clusterByVectors(embedded, threshold)
    .map((g) => {
      const shape = (r: (typeof rows)[number]) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        occurrences: Number(r.occurrence_count) || 1
      })
      const lead = shape(g.lead.row)
      return {
        lead,
        total_occurrences:
          lead.occurrences +
          g.members.reduce((s, m) => s + (Number(m.item.row.occurrence_count) || 1), 0),
        variants: g.members.map((m) => ({
          ...shape(m.item.row),
          similarity: Math.round(m.sim * 100) / 100
        }))
      }
    })
    .sort((a, b) => b.total_occurrences - a.total_occurrences)
  cache = { at: Date.now(), value: out }
  return out
}

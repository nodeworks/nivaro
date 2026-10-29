import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import {
  BlockError,
  type BlockGroup,
  type BlockPlacement,
  extractSection,
  GROUP_FIELD_BOUND,
  type LayoutBlock,
  mapBlock,
  PLACEMENT_FIELD_BOUND,
  planBlock
} from './layout-blocks.js'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  loadLayoutBundle,
  runLayoutOps
} from './layout-ops.js'
import {
  cleanMap,
  collectionFieldNames,
  type FieldMap,
  fieldResolver,
  type LoadedTemplate
} from './layout-templates.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Linked sections (#3194). A section from the library placed as LINKED stays
 * tied to it: saving the library section re-applies it to every form that
 * links it, as layout ops through runLayoutOps — the same path as an editor
 * save, so each form gets a version (History) and a fresh rev.
 *
 * On a form the linked section is one top-level group (its ROOT, keyed
 * `lib<template>_<random>` so no other section can ever take the key) and
 * everything under it. Re-applying removes that subtree and plans the library
 * block in its place with the same root key at the same position; fields the
 * form shows elsewhere stay where they are (planBlock's `already`), exactly as
 * when the section was first dropped. The editor keeps the subtree read-only
 * (Edit the shared section / Unlink); a change made another way (API, a
 * restored version) shows as "differs from the library" until the next update.
 */

export const LINKS_TABLE = 'nivaro_layout_section_links'

export interface SectionLinkRow {
  id: number
  template_id: number
  layout_id: number
  group_key: string
  field_map: string | null
  created_by: string | null
  created_at: unknown
  confirmed_at: unknown
  synced_at: unknown
}

/** A linked drop that never reached a saved layout is forgotten after this long. */
export const PENDING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

const LINK_KEY_RE = /^lib\d+_[a-z0-9]{4,16}$/

/** The root key a linked drop gets: unique to this placement, never reused. */
export function linkedRootKey(templateId: number): string {
  return `lib${templateId}_${randomBytes(4).toString('hex')}`
}

export function isLinkedRootKey(key: unknown): key is string {
  return typeof key === 'string' && LINK_KEY_RE.test(key)
}

// ─── Pure planning ──────────────────────────────────────────────────────────

/** A section block whose root group takes `key` (children keep theirs). */
export function withRootKey(block: LayoutBlock, key: string): LayoutBlock {
  const top = block.top[0]
  const root = top && 'group' in top ? top.group : block.groups[0]?.key
  if (!root) throw new BlockError('The library section is empty')
  const k = (x: string | null) => (x === root ? key : x)
  return {
    ...block,
    groups: block.groups.map((g) => ({
      ...g,
      key: k(g.key) as string,
      parent_key: k(g.parent_key)
    })),
    placements: block.placements.map((p) => ({ ...p, group_key: k(p.group_key) })),
    top: [{ group: key }]
  }
}

/** `key` and every group under it, parents first. */
export function subtreeKeys(bundle: Pick<LayoutBundle, 'groups'>, key: string): string[] {
  const out = [key]
  for (let i = 0; i < out.length; i++)
    for (const g of bundle.groups)
      if (g.parent_key === out[i] && !out.includes(g.key)) out.push(g.key)
  return out
}

export interface LinkedPlan {
  ops: LayoutOp[]
  /** Fields the form shows outside the section: left where they are. */
  already: string[]
}

/**
 * The ops that make the linked section `rootKey` on `bundle` match `block`
 * (already mapped to the form's collection): its subtree goes (fields with
 * it), the block comes back at the same top-level position with the same
 * root key. Throws BlockError when the section is not a top-level group of
 * the form or the block cannot land.
 */
export function planLinkedReplace(
  block: LayoutBlock,
  bundle: LayoutBundle,
  rootKey: string
): LinkedPlan {
  const root = bundle.groups.find((g) => g.key === rootKey)
  if (!root) throw new BlockError('The linked section is not on this form')
  if (root.parent_key !== null) throw new BlockError('The linked section is not at the top level')
  // Renumbered, a top-level member's sort is its index among groups, slot cards and Ungrouped.
  const index = applyLayoutOps(bundle, []).groups.find((g) => g.key === rootKey)?.sort ?? 0
  const removes: LayoutOp[] = subtreeKeys(bundle, rootKey)
    .reverse()
    .map((key) => ({ op: 'group_remove', key, placements: 'delete' }))
  let without: LayoutBundle
  try {
    without = applyLayoutOps(bundle, removes)
  } catch (err) {
    if (err instanceof LayoutOpError) throw new BlockError(err.message)
    throw err
  }
  const plan = planBlock(withRootKey(block, rootKey), without, { index })
  return { ops: [...removes, ...plan.ops], already: plan.already }
}

const norm = (v: unknown): unknown => {
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))
      try {
        return norm(JSON.parse(t))
      } catch {
        return v
      }
    return v
  }
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== null && x !== undefined) out[k] = norm(x)
    }
    return out
  }
  return v
}

/**
 * A section block's content without its keys: labels, types, settings and
 * fields in order. Two blocks with the same signature render the same form.
 */
export function sectionSignature(block: LayoutBlock): string {
  const at = new Map(block.groups.map((g, i) => [g.key, i]))
  const ix = (k: string | null) => (k === null ? -1 : (at.get(k) ?? -2))
  return JSON.stringify({
    groups: block.groups.map((g) => [ix(g.parent_key), g.label, g.type, norm(g.patch)]),
    placements: block.placements.map((p) => [p.field, ix(p.group_key), norm(p.patch)])
  })
}

/**
 * Does the linked section `rootKey` already look like `block` (mapped)? The
 * expected section is the one an update would leave, so a field kept
 * elsewhere on the form (`already`) never reads as a difference.
 */
export function linkInSync(block: LayoutBlock, bundle: LayoutBundle, rootKey: string): boolean {
  try {
    const plan = planLinkedReplace(block, bundle, rootKey)
    const expected = applyLayoutOps(bundle, plan.ops)
    return (
      sectionSignature(extractSection(expected, rootKey)) ===
      sectionSignature(extractSection(bundle, rootKey))
    )
  } catch {
    return false
  }
}

/** The library block as it lands on a form of `collection`, through the link's map. */
export function mappedFor(
  template: Pick<LoadedTemplate, 'block' | 'source_collection'>,
  collection: string,
  map: FieldMap,
  targetFields: Set<string>
) {
  return mapBlock(
    template.block,
    fieldResolver(map, targetFields),
    !!template.source_collection && template.source_collection !== collection
  )
}

/**
 * The library section rebuilt from a form's edited copy. On a form of the
 * library's own collection it is the copy as it stands. On a form of another
 * collection, fields go back to the library's names where the link mapped
 * them, and the settings written in the library collection's own terms (step
 * conditions, lock conditions, bindings…) that were left out when the section
 * came to this collection are kept from the library version, so publishing
 * from there never wipes them on the library's own forms.
 */
export function rebaseEdited(
  edited: LayoutBlock,
  previous: LayoutBlock,
  cross: boolean,
  resolve: (field: string) => string | null
): LayoutBlock {
  if (!cross) return edited
  const back = new Map<string, string>()
  for (const p of previous.placements) {
    const to = resolve(p.field)
    if (to && !back.has(to)) back.set(to, p.field)
  }
  const name = (f: string) => (f.startsWith('__') ? f : (back.get(f) ?? f))
  const groups: BlockGroup[] = edited.groups.map((g, i) => {
    const old = previous.groups[i]
    if (!old || old.type !== g.type) return g
    const patch: Record<string, unknown> = { ...g.patch }
    for (const k of GROUP_FIELD_BOUND) {
      const was = (old.patch as Record<string, unknown>)[k]
      if ((patch[k] == null || patch[k] === '') && was != null) patch[k] = was
    }
    return { ...g, patch: patch as BlockGroup['patch'] }
  })
  const placements: BlockPlacement[] = edited.placements.map((p) => {
    const field = name(p.field)
    const old = previous.placements.find((x) => x.field === field)
    if (!old) return { ...p, field }
    const patch: Record<string, unknown> = { ...p.patch }
    for (const k of PLACEMENT_FIELD_BOUND) {
      const was = (old.patch as Record<string, unknown>)[k]
      if (patch[k] == null && was != null) patch[k] = was
    }
    return { ...p, field, patch: patch as BlockPlacement['patch'] }
  })
  return { ...edited, groups, placements }
}

// ─── Store ──────────────────────────────────────────────────────────────────

// Per tenant (cloud): one tenant may run the migration before another.
const ready = new Map<string, true>()

/** Is migration 508 there? A database without it simply has no links. */
export async function linksReady(): Promise<boolean> {
  const t = currentTenantKey()
  if (ready.has(t)) return true
  const ok = await db.schema.hasTable(LINKS_TABLE).catch(() => false)
  if (ok) ready.set(t, true)
  return ok
}

export async function linksOfLayout(layoutId: number): Promise<SectionLinkRow[]> {
  if (!(await linksReady())) return []
  return (await db(LINKS_TABLE).where({ layout_id: layoutId })) as SectionLinkRow[]
}

export async function linksOfTemplate(templateId: number): Promise<SectionLinkRow[]> {
  if (!(await linksReady())) return []
  return (await db(LINKS_TABLE).where({ template_id: templateId })) as SectionLinkRow[]
}

/** Linked forms per library section, for the library list. */
export async function linkCounts(): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!(await linksReady())) return out
  const rows = (await db(LINKS_TABLE).select('template_id', 'layout_id')) as Array<{
    template_id: number
    layout_id: number
  }>
  const seen = new Map<number, Set<number>>()
  for (const r of rows) {
    const s = seen.get(Number(r.template_id)) ?? new Set<number>()
    s.add(Number(r.layout_id))
    seen.set(Number(r.template_id), s)
  }
  for (const [k, s] of seen) out.set(k, s.size)
  return out
}

export async function deleteLink(id: number): Promise<void> {
  await db(LINKS_TABLE).where({ id }).delete()
}

export async function deleteTemplateLinks(templateId: number): Promise<void> {
  if (!(await linksReady())) return
  await db(LINKS_TABLE).where({ template_id: templateId }).delete()
}

export async function markLink(id: number, patch: { confirmed?: boolean; synced?: boolean }) {
  const now = new Date()
  const cols: Record<string, Date> = {}
  if (patch.confirmed) cols.confirmed_at = now
  if (patch.synced) cols.synced_at = now
  if (Object.keys(cols).length) await db(LINKS_TABLE).where({ id }).update(cols)
}

const ms = (v: unknown) => {
  const t = v == null ? Number.NaN : new Date(v as string).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Reconcile a layout's links with its SAVED bundle: a group seen there for
 * the first time confirms its link; a confirmed link whose group is gone (the
 * section was removed, a version without it was restored) is dropped, and so
 * is a link that never reached a save within PENDING_LINK_TTL_MS. Returns the
 * links that remain.
 */
export async function reconcileLinks(
  rows: SectionLinkRow[],
  bundle: LayoutBundle | null,
  now = Date.now()
): Promise<SectionLinkRow[]> {
  const keys = new Set((bundle?.groups ?? []).map((g) => g.key))
  const keep: SectionLinkRow[] = []
  for (const r of rows) {
    const here = !!bundle && keys.has(r.group_key)
    if (here) {
      if (r.confirmed_at == null) {
        await markLink(r.id, { confirmed: true })
        r.confirmed_at = new Date(now)
      }
      keep.push(r)
      continue
    }
    const created = ms(r.created_at)
    const stale =
      r.confirmed_at != null || !bundle || (created != null && now - created > PENDING_LINK_TTL_MS)
    if (stale) await deleteLink(r.id)
    else keep.push(r)
  }
  return keep
}

// ─── Propagation ────────────────────────────────────────────────────────────

export interface PushOutcome {
  layout_id: number
  name: string
  collection: string
  result: 'updated' | 'unchanged' | 'skipped'
  reason?: string
}

/**
 * Re-apply `template` to every form that links it (except `exceptLayoutId`,
 * the form it was just published from). Each form is its own runLayoutOps
 * batch: a frozen form, a form that asks for a ticket link with every save,
 * or one that cannot take the section is skipped and says why — it shows as
 * "differs from the library" in its editor until someone updates it there.
 */
export async function pushTemplateToLinks(
  template: LoadedTemplate,
  opts: { exceptLayoutId?: number | null; userId?: string | null; from?: string | null }
): Promise<PushOutcome[]> {
  const out: PushOutcome[] = []
  const rows = await linksOfTemplate(template.id)
  const reason =
    `Linked section "${template.name}" updated in the library${opts.from ? ` (from ${opts.from})` : ''}`.slice(
      0,
      250
    )
  for (const link of rows) {
    const layoutId = Number(link.layout_id)
    if (opts.exceptLayoutId != null && layoutId === opts.exceptLayoutId) continue
    let outcome: PushOutcome | null = null
    let raced: LayoutBundle | null = null
    for (let attempt = 0; attempt < 2 && !outcome; attempt++) {
      raced = null
      const bundle = await loadLayoutBundle(db, layoutId)
      const [kept] = await reconcileLinks([link], bundle)
      if (!bundle || !kept) {
        if (bundle && link.confirmed_at == null)
          outcome = skipped(bundle, 'not saved on the form yet')
        break
      }
      const collection = String(bundle.layout.collection)
      const mapped = mappedFor(
        template,
        collection,
        cleanMap(link.field_map),
        await collectionFieldNames(collection)
      ).block
      if (linkInSync(mapped, bundle, link.group_key)) {
        outcome = { ...describe(bundle), result: 'unchanged' }
        await markLink(link.id, { synced: true })
        break
      }
      let plan: LinkedPlan
      try {
        plan = planLinkedReplace(mapped, bundle, link.group_key)
      } catch (err) {
        if (err instanceof BlockError) {
          outcome = skipped(bundle, err.message)
          break
        }
        throw err
      }
      const res = await runLayoutOps(
        layoutId,
        { ops: plan.ops, base_rev: bundle.rev, note: reason, reason },
        opts.userId
      )
      if (res.status === 409) {
        raced = bundle
        continue
      }
      if (res.status === 404) break
      if (res.status === 400) {
        outcome = skipped(bundle, res.freeze ? 'the form is frozen' : res.error)
        break
      }
      await markLink(link.id, { synced: true })
      outcome = { ...describe(bundle), result: 'updated' }
    }
    if (!outcome && raced) outcome = skipped(raced, 'the form kept changing while it was updated')
    if (outcome) out.push(outcome)
  }
  return out
}

function describe(bundle: LayoutBundle) {
  return {
    layout_id: Number(bundle.layout.id),
    name: String(bundle.layout.name ?? `Layout ${bundle.layout.id}`),
    collection: String(bundle.layout.collection)
  }
}

function skipped(bundle: LayoutBundle, reason: string): PushOutcome {
  return { ...describe(bundle), result: 'skipped', reason: reason.slice(0, 300) }
}

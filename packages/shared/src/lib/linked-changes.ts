import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { get } from './commands'
import { type LiveBatch, useLiveCollection } from './live'

/**
 * Warnings re-check when a linked record changes (rt4 #6).
 *
 * An open form holds links to other records — a vendor, a project, a unit. When one of
 * them changes (deactivated, hidden from pickers, closed, retired) while the form is open,
 * the form re-asks, as the viewer, everything that judges the link: the picker's "is this
 * still an available option" read (which feeds the form's save check), the label, and the
 * field rules that fill other fields from it (only fields still empty — a value the person
 * set is never replaced). The person's value itself is never cleared or changed.
 *
 * When the re-check finds the value no longer offered, the line under the field says what
 * happened: "Vendor ABC was deactivated 2 min ago by Beth Lee".
 */

export interface LinkedTarget {
  field: string
  collection: string
  id: string
}

export interface LinkedChangeInfo {
  /** The linked record as the viewer knows it ("ABC Supply"). */
  label?: string
  at: string
  by: string | null
  kind: 'update' | 'hidden'
  fields: Array<{ field: string; label: string; type: string; value?: boolean | string | null }>
}

/** "just now", "1 min ago", "25 min ago", "3 hours ago", "2 days ago". */
export function agoWords(at: string | number, now: number = Date.now()): string {
  const ms = now - new Date(at).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} days ago`
}

const OFF_WHEN_FALSE = /^(is_)?(active|enabled|available|open)$/i
const WORD_WHEN_TRUE: Array<[RegExp, string]> = [
  [/^(is_)?(inactive|disabled|deactivated)$/i, 'deactivated'],
  [/^(is_)?archived$/i, 'archived'],
  [/^(is_)?retired$/i, 'retired'],
  [/^(is_)?closed$/i, 'closed'],
  [/^(is_)?(hidden|hide_from_pickers|picker_hidden)$/i, 'hidden from pickers']
]

/**
 * The line under a field whose linked record changed and is no longer offered:
 *   hidden from pickers  "Vendor ABC was hidden from pickers 2 min ago by Beth Lee"
 *   active → no          "Vendor ABC was deactivated 2 min ago by Beth Lee"
 *   archived → yes       "Unit 12 was archived 5 min ago by Mark Li"
 *   status → Closed      "Project 4471 was set to Closed 1 hour ago by Beth Lee"
 *   anything else        "Vendor ABC was changed 2 min ago by Beth Lee (Region)"
 *   nothing known        "Vendor ABC is no longer offered here"
 */
export function linkedChangeSentence(
  label: string,
  change: LinkedChangeInfo | null | undefined,
  now: number = Date.now(),
  /** What the picker shows for the value, when known. */
  shown?: string | null
): string {
  // The server's name for it, unless that is only its number ("#3663"): then what the
  // picker shows ("gloucester.nj"), then the field's label.
  const server = change?.label?.trim() || ''
  const name =
    (server && !/^#\S+$/.test(server) ? server : '') ||
    shown?.trim() ||
    server ||
    label.trim() ||
    'The linked record'
  if (!change) return `${name} is no longer offered here`
  const tail = `${agoWords(change.at, now)}${change.by ? ` by ${change.by}` : ''}`
  if (change.kind === 'hidden') return `${name} was hidden from pickers ${tail}`
  for (const f of change.fields) {
    if (f.value === false && OFF_WHEN_FALSE.test(f.field)) return `${name} was deactivated ${tail}`
    if (f.value === true)
      for (const [re, word] of WORD_WHEN_TRUE)
        if (re.test(f.field)) return `${name} was ${word} ${tail}`
  }
  const choice = change.fields.find(
    (f) => typeof f.value === 'string' && f.value.trim() && /(^|_)(status|state)$/i.test(f.field)
  )
  if (choice) return `${name} was set to ${String(choice.value).trim()} ${tail}`
  const labels = change.fields.map((f) => f.label).filter(Boolean)
  return `${name} was changed ${tail}${labels.length ? ` (${labels.slice(0, 3).join(', ')})` : ''}`
}

/** The query-key prefixes a picker reads its value with (RelationCombobox). */
export function linkedReadKeys(t: Pick<LinkedTarget, 'collection' | 'id'>): unknown[][] {
  return [
    ['relation-single', t.collection, t.id],
    ['relation-avail', t.collection, t.id]
  ]
}

/** Targets a batch names (exported for tests). A bulk `'*'` event names all of its collection's. */
export function targetsHit(
  targets: LinkedTarget[],
  collection: string,
  ids: Set<string>,
  bulk: boolean
): LinkedTarget[] {
  const upper = new Set([...ids].map((i) => i.toUpperCase()))
  return targets.filter(
    (t) => t.collection === collection && (bulk || upper.has(t.id.toUpperCase()))
  )
}

/** Aspect notices that can change whether a linked record is still a valid pick. */
const RECHECK_ASPECTS = new Set(['$picker', '$state'])

/** Whether one live event could change a link's validity (a comment or a lock cannot). */
export function eventMatters(changedFields: string[] | null | undefined): boolean {
  if (!changedFields || changedFields.length === 0) return true
  return changedFields.some((f) => !f.startsWith('$') || RECHECK_ASPECTS.has(f))
}

const RECHECK_GAP_MS = 1000

export interface LinkedWatchEntry {
  change: LinkedChangeInfo | null
  /** The field's label. */
  label: string
  /** What the picker showed for the value (its cached row's text), when known. */
  shown: string | null
  target: string
}

/** The text of a picker's cached row for the value ("gloucester.nj"), or null (exported for tests). */
export function shownLabel(entries: Array<[unknown, unknown]>): string | null {
  for (const [, data] of entries) {
    if (!data || typeof data !== 'object') continue
    const parts = Object.entries(data as Record<string, unknown>)
      .filter(([k, v]) => k !== 'id' && (typeof v === 'string' || typeof v === 'number'))
      .map(([, v]) => String(v).trim())
      // Names, not stamps or bare numbers.
      .filter((v) => v && !/^\d{4}-\d{2}-\d{2}T/.test(v) && !/^-?\d+(\.\d+)?$/.test(v))
    if (parts.length > 0) return parts[0]
  }
  return null
}

/**
 * Watch the records an open form links to. `onRecheck(fields)` runs (coalesced, at most
 * once a second) after the picker reads were re-asked, for the form's own re-checks.
 * Returns field → change info for fields that changed while the form was open; the form
 * shows the sentence only where the picker now flags the value.
 */
export function useLinkedRecordWatch(opts: {
  targets: LinkedTarget[]
  labels: (field: string) => string
  enabled: boolean
  onRecheck?: (fields: string[]) => void
}): Record<string, LinkedWatchEntry> {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const openedAt = useRef(new Date().toISOString())
  const targetsRef = useRef(opts.targets)
  targetsRef.current = opts.targets
  const recheckRef = useRef(opts.onRecheck)
  recheckRef.current = opts.onRecheck
  const labelsRef = useRef(opts.labels)
  labelsRef.current = opts.labels
  const [changes, setChanges] = useState<Record<string, LinkedWatchEntry>>({})
  const pending = useRef(new Map<string, LinkedTarget>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const collections = useMemo(
    () => [...new Set(opts.targets.map((t) => t.collection))].sort(),
    [opts.targets]
  )

  const flush = useCallback(() => {
    timer.current = null
    const hit = [...pending.current.values()]
    pending.current.clear()
    if (hit.length === 0) return
    for (const t of hit)
      for (const k of linkedReadKeys(t)) void qc.invalidateQueries({ queryKey: k })
    recheckRef.current?.(hit.map((t) => t.field))
    // Who changed it and how — read as the viewer, shown only if the value is now flagged.
    for (const t of hit) {
      void client
        .request<{ data: LinkedChangeInfo | null }>(
          get('/picker-exclusions/linked-change', {
            collection: t.collection,
            item_id: t.id,
            since: openedAt.current
          })
        )
        .then((r) => r.data ?? null)
        .catch(() => null)
        .then((change) => {
          // The value moved on meanwhile: nothing to say about the old link.
          const still = targetsRef.current.find((x) => x.field === t.field)
          if (!still || still.id !== t.id || still.collection !== t.collection) return
          setChanges((cur) => ({
            ...cur,
            [t.field]: {
              change,
              label: labelsRef.current(t.field),
              shown: shownLabel(
                qc.getQueriesData({ queryKey: ['relation-single', t.collection, t.id] })
              ),
              target: t.id
            }
          }))
        })
    }
  }, [client, qc])

  useLiveCollection(
    opts.enabled ? collections : null,
    (batch: LiveBatch) => {
      const byCollection = new Map<string, Set<string>>()
      for (const ev of batch.events) {
        if (!eventMatters(ev.changed_fields)) continue
        const c = String(ev.collection)
        const set = byCollection.get(c) ?? new Set<string>()
        set.add(String(ev.item))
        byCollection.set(c, set)
      }
      for (const [c, set] of byCollection) {
        const hits = targetsHit(targetsRef.current, c, set, set.has('*'))
        for (const t of hits) pending.current.set(t.field, t)
      }
      if (pending.current.size > 0 && !timer.current)
        timer.current = setTimeout(flush, RECHECK_GAP_MS)
    },
    { enabled: opts.enabled, debounceMs: 400 }
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  // A field whose link changed (a new pick) forgets what was said about the old one.
  const targetSig = opts.targets.map((t) => `${t.field}=${t.collection}:${t.id}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetSig is the content key of targets
  useEffect(() => {
    setChanges((cur) => {
      let changed = false
      const next = { ...cur }
      for (const [field, entry] of Object.entries(cur)) {
        const t = targetsRef.current.find((x) => x.field === field)
        if (!t || t.id !== entry.target) {
          delete next[field]
          changed = true
        }
      }
      return changed ? next : cur
    })
  }, [targetSig])

  return changes
}

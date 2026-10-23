import { useSyncExternalStore } from 'react'
import type { ShownProblem } from '../problem-copy'
import type { Issue } from './spec-ops'

// Per-row facts that change often (problems, structural issues, preview
// values, locks) live in a small external store so a keystroke in one row
// re-renders that row only — not all 200. Unchanged rows keep the SAME meta
// object, so their snapshot is stable.

export interface RowMeta {
  lock: 'self' | 'inside' | null
  /** Client-side shape checks (empty / duplicate key …). */
  issues: Issue[]
  /** Server problems for this row (from the preview). */
  problems: ShownProblem[]
  value: unknown
  hasValue: boolean
  /** Group folded shut. */
  collapsed: boolean
  /** Just added: its empty key is not an error until the person leaves it. */
  fresh: boolean
}

export const EMPTY_META: RowMeta = {
  lock: null,
  issues: [],
  problems: [],
  value: undefined,
  hasValue: false,
  collapsed: false,
  fresh: false
}

function sameList<T>(a: T[], b: T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameIssues(a: Issue[], b: Issue[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x.code === b[i].code && x.message === b[i].message)
}

function sameMeta(a: RowMeta, b: RowMeta): boolean {
  return (
    a.lock === b.lock &&
    a.hasValue === b.hasValue &&
    a.collapsed === b.collapsed &&
    a.fresh === b.fresh &&
    Object.is(a.value, b.value) &&
    sameIssues(a.issues, b.issues) &&
    sameList(a.problems, b.problems)
  )
}

export class RowStore {
  private meta = new Map<string, RowMeta>()
  private listeners = new Set<() => void>()

  /** Replace every row's meta, keeping the old object wherever nothing changed. */
  replace(next: Map<string, RowMeta>): boolean {
    let changed = next.size !== this.meta.size
    const merged = new Map<string, RowMeta>()
    for (const [id, m] of next) {
      const old = this.meta.get(id)
      if (old && sameMeta(old, m)) merged.set(id, old)
      else {
        merged.set(id, m)
        changed = true
      }
    }
    this.meta = merged
    return changed
  }

  get(id: string): RowMeta {
    return this.meta.get(id) ?? EMPTY_META
  }

  notify() {
    for (const l of this.listeners) l()
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
}

export function useRowMeta(store: RowStore, id: string): RowMeta {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(id),
    () => store.get(id)
  )
}

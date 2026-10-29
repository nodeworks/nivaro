import type { Collection } from '@/lib/api'

/**
 * Shared contract for the Collections list page (/collections) and its parts.
 * The page (pages/Collections.tsx) owns state; components under
 * pages/collections/ render it.
 */

/** Per-collection facts from GET /api/collections/overview-stats (admin only). */
export interface CollectionStat {
  /** Approximate row count (table statistics); null when unknown (virtual, no table). */
  rows: number | null
  /** Last write the database saw on the table since SQL Server last started; null = unknown. */
  changed_at: string | null
  /** Bound pipeline template name, if any. */
  pipeline: string | null
  /** Number of form layouts (nivaro_collection_layouts rows). */
  forms: number
  /** Import definitions / collection imports that feed it. */
  imports: number
  /** A link (junction) table between two collections. */
  link: boolean
  /** Backed by SQL (virtual collection) — read-only. */
  virtual: boolean
}
export type OverviewStats = Record<string, CollectionStat>

/** GET /api/collections/:collection/summary (admin only) — the row hover card. */
export interface CollectionSummary {
  collection: string
  /** First fields by sort (no alias/system), at most 8. */
  fields: Array<{ field: string; label: string; type: string }>
  field_count: number
  /** Relations this collection points to (M2O). */
  relations_out: Array<{ field: string; collection: string }>
  /** Collections that point at this one. */
  relations_in: Array<{ collection: string; field: string }>
  pipeline: string | null
  forms: number
  /** Newest activity row in the last 90 days, or null. */
  last_edit: { at: string; user: string | null } | null
}

export type ViewMode = 'folders' | 'az' | 'recent' | 'records' | 'used'
export type Density = 'compact' | 'comfortable'
export type ChipKey =
  | 'has_records'
  | 'empty'
  | 'hidden'
  | 'link'
  | 'virtual'
  | 'singleton'
  | 'pipeline'
  | 'form'

export interface FolderOption {
  /** The folder's key (a `group` value). */
  key: string
  label: string
  color: string | null
}

export interface PageState {
  view: ViewMode
  density: Density
  /** Only-show filters (AND). Empty = no chip filter. */
  chips: ChipKey[]
  /** Hidden collections are folded away unless this is on (or the 'hidden' chip is). */
  showHidden: boolean
  /** Link tables are folded into their own section unless this is on (or the 'link' chip is). */
  showLinks: boolean
  /** Drag-to-reorder is only live in Arrange mode. */
  arranging: boolean
  /** Checkboxes for bulk "Move to folder". */
  selecting: boolean
}

export type { Collection }

import type { ReactNode } from 'react'

/**
 * The collections directory (admin /collections, efp-new /admin/data): one shared page that
 * lists every registered collection. The page (CollectionsDirectory.tsx) owns the state;
 * the parts in this folder render it. Host-only edit tools come in through
 * `CollectionsDirectoryAdminTools`, so a host that passes none gets the plain directory.
 */

/** A row of GET /api/collections — only the columns the directory reads. */
export interface DirectoryCollection {
  collection: string
  display_name?: string | null
  icon?: string | null
  color?: string | null
  note?: string | null
  hidden?: boolean | null
  singleton?: boolean | null
  sort?: number | null
  /** The folder it sits in (another row's `collection`). */
  group?: string | null
}

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

/**
 * The person's own favorite collections — the star. The admin app passes its sidebar
 * favorites (so a star also lands in the sidebar); without one the directory reads and writes
 * the same store itself (users.preferences.nav_favorites, `/collections/<name>` paths).
 */
export interface CollectionFavorites {
  favorite: Set<string>
  toggle: (collection: string, label: string) => unknown
}

/** One extra item in a row's ⋯ menu (host-supplied, e.g. the admin's Data model pages). */
export interface RowMenuLink {
  key: string
  label: string
  icon?: ReactNode
  /** In-app path, opened through the host's navigation. */
  path: string
}

/** A folded section the host adds under the list (the admin's unregistered/system tables). */
export interface ExtraSectionSpec {
  key: string
  label: string
  icon?: ReactNode
  count: number | null
  open: boolean
  onToggle: () => void
  body: ReactNode
}

/**
 * Editing tools only the admin app offers (efp-new passes none): each one switches its part
 * of the page on. Everything else — Pinned, My favorites, Recent, the views, chips, folders,
 * Jump to, the switches, the hover card, search — is the same in every host.
 */
export interface CollectionsDirectoryAdminTools {
  /** Toolbar buttons before Arrange / Select (new table, schema views, proposals). */
  toolbarActions?: ReactNode
  /** Panels shown above the list (create a table, describe, proposals). */
  panels?: ReactNode
  /** ✏ on each row: where the collection's editor lives. */
  editPath?: (collection: string) => string
  /** An extra group in each row's ⋯ menu. */
  rowMenu?: { heading: string; items: (collection: string) => RowMenuLink[] }
  /** Move collections into a folder (null = out of every folder). Turns on the row menu's
   *  "Move to folder" (and, with `renderMoveDialog`, Select). */
  moveCollections?: (names: string[], group: string | null) => Promise<unknown>
  /** Select mode's "Move to folder…" dialog. */
  renderMoveDialog?: (p: {
    open: boolean
    onOpenChange: (open: boolean) => void
    names: string[]
    folders: FolderOption[]
    onMoved: () => void
  }) => ReactNode
  /** Save a new folder / collection order. Turns on Arrange. */
  reorder?: (items: Array<{ collection: string; sort: number }>) => Promise<unknown>
  /** Shown above the folders in the Folders view while nothing is filtered (suggested folders). */
  renderSuggestions?: (ctx: {
    real: DirectoryCollection[]
    folders: FolderOption[]
    refresh: () => void
  }) => ReactNode
  /** Extra folded sections under the list (unregistered / system tables). */
  renderExtraSections?: (ctx: {
    filter: string
    collapsed: Record<string, boolean>
    onToggle: (key: string) => void
    renderSection: (s: ExtraSectionSpec) => ReactNode
  }) => ReactNode
  /** "Create a table" on an empty search. */
  onCreate?: () => void
}

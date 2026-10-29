/**
 * Procedures page — API shapes (routes/procedures.ts), the status chip map, what each kind of
 * procedure allows, and the request bodies a write sends. Pure: no React, no fetching.
 *
 * Owners: an import definition (read-only here), a managed row in config (edits save a version,
 * then deploy), or nobody yet (unmanaged: the first edit or drop adopts it into config).
 */

export type DriftStatus =
  | 'in-sync'
  | 'drifted'
  | 'not-deployed'
  | 'dropped'
  | 'dropped-but-live'
  | 'conflict'

export type ManagedInfo =
  | { kind: 'import'; key: string }
  | { kind: 'managed'; status: DriftStatus; version: number; owner: string | null }

export interface ProcRow {
  name: string
  created: string | null
  modified: string | null
  bytes: number
  param_count: number
  live: boolean
  managed: ManagedInfo | null
}

export interface ProcParam {
  name: string
  type: string
  is_output: boolean
  position: number
}

export interface ProcConfig {
  body: string
  body_hash: string
  version: number
  deployed_hash: string | null
  deployed_at: string | null
  deployed_by: string | null
  dropped_at: string | null
  owner: string | null
  description: string | null
  updated_at: string | null
  updated_by: string | null
}

export interface ProcDetail {
  name: string
  created: string | null
  modified: string | null
  /** Live text; null when not on this database, or encrypted. */
  definition: string | null
  /** Hash of the live text ('' for an encrypted proc); null only when not live. */
  live_hash: string | null
  params: ProcParam[]
  managed: ManagedInfo | null
  config: ProcConfig | null
}

export interface VersionSummary {
  version: number
  body_hash: string
  note: string
  created_at: string
  created_by: string | null
}

export interface VersionDetail extends VersionSummary {
  body: string
}

// ── Chips ────────────────────────────────────────────────────────────────────

export type ChipTone = 'ok' | 'warn' | 'info' | 'muted' | 'danger'

export interface Chip {
  label: string
  tone: ChipTone
  tip: string
}

/** The list/detail chip for a procedure; null when there is nothing to say (managed, in sync). */
export function procedureChip(row: { live: boolean; managed: ManagedInfo | null }): Chip | null {
  const m = row.managed
  if (!m) {
    return {
      label: 'not managed',
      tone: 'muted',
      tip: 'Only on this database. Adopt it, or edit it, to keep it in config'
    }
  }
  if (m.kind === 'import') {
    return {
      label: 'import',
      tone: 'info',
      tip: `Owned by import definition ${m.key} — edit it there`
    }
  }
  switch (m.status) {
    case 'in-sync':
      return null
    case 'drifted':
      return { label: 'drifted', tone: 'warn', tip: 'The database differs from the saved version' }
    case 'not-deployed':
      return {
        label: 'not deployed',
        tone: 'info',
        tip: 'Saved in config but not on this database yet'
      }
    case 'dropped-but-live':
      return {
        label: 'drop pending',
        tone: 'warn',
        tip: 'Dropped in config but still on this database; the next deploy drops it'
      }
    case 'dropped':
      return {
        label: 'dropped',
        tone: 'muted',
        tip: 'Dropped. Its versions are kept; restore one to bring it back'
      }
    case 'conflict':
      return {
        label: 'conflict',
        tone: 'danger',
        tip: 'An import definition and a managed procedure both claim this name; the import wins'
      }
  }
}

/** Chip classes per tone: tinted fill + ring + ink, AA in both themes; the label carries meaning. */
export const CHIP_TONE: Record<ChipTone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/30',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30',
  info: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-400/30',
  muted:
    'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-muted dark:text-muted-foreground dark:ring-border',
  danger:
    'bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30'
}

// ── What a procedure allows ──────────────────────────────────────────────────

export interface ProcState {
  owner: 'import' | 'conflict' | 'managed' | 'unmanaged'
  /** On this database (the GET answered a live hash). */
  live: boolean
  /** Live and its text is readable (not encrypted). */
  readable: boolean
  /** What the editor starts from: the config body when managed, the live text otherwise. */
  base: string
  editable: boolean
  canDrop: boolean
  canAdopt: boolean
  canRun: boolean
  canReview: boolean
  /** Why AI review is off, when it is. */
  reviewOff?: string
  /** An edit or drop adopts it into config first (warn before the first one). */
  adoptsOnWrite: boolean
  dropped: boolean
  status?: DriftStatus
  version?: number
  importKey?: string
}

export function procedureState(d: ProcDetail): ProcState {
  const live = d.live_hash !== null
  // Readability from the text itself: an encrypted proc still has a hash (of '').
  const readable = live && !!d.definition
  const reviewOff = !live
    ? "AI review reads the procedure from the database, and it isn't on this database yet"
    : !readable
      ? 'The procedure is encrypted, so its text cannot be read'
      : undefined
  const common = {
    live,
    readable,
    canRun: live,
    canReview: live && readable,
    reviewOff,
    adoptsOnWrite: false,
    dropped: false,
    canAdopt: false
  }
  const m = d.managed
  if (m?.kind === 'import') {
    return {
      ...common,
      owner: 'import',
      importKey: m.key,
      base: d.definition ?? '',
      editable: false,
      canDrop: false
    }
  }
  if (m?.kind === 'managed') {
    const base = d.config?.body ?? d.definition ?? ''
    if (m.status === 'conflict') {
      return {
        ...common,
        owner: 'conflict',
        status: m.status,
        version: m.version,
        base,
        editable: false,
        canDrop: false
      }
    }
    const dropped = m.status === 'dropped' || m.status === 'dropped-but-live'
    return {
      ...common,
      owner: 'managed',
      status: m.status,
      version: m.version,
      base,
      dropped,
      editable: !dropped,
      canDrop: !dropped
    }
  }
  return {
    ...common,
    owner: 'unmanaged',
    base: d.definition ?? '',
    editable: readable,
    canDrop: readable,
    canAdopt: readable,
    adoptsOnWrite: readable
  }
}

/** The newest version whose body is what this database has (deployed_hash), or null. */
export function deployedVersion(
  versions: VersionSummary[],
  deployedHash: string | null | undefined
): number | null {
  if (!deployedHash) return null
  let best: number | null = null
  for (const v of versions) {
    if (v.body_hash === deployedHash && (best === null || v.version > best)) best = v.version
  }
  return best
}

// ── Request bodies ───────────────────────────────────────────────────────────

export interface SaveBody {
  definition: string
  note?: string
  base_hash?: string
  base_version?: number
  base_live_hash: string | null
}

/**
 * PUT /procedures/:name for an edit. Managed: the config base it was opened on plus the live
 * hash it saw. Unmanaged: the live hash only (the server adopts it first). `liveHash` replaces
 * the live hash after a 409 PROC_DRIFTED ("overwrite with mine").
 */
export function saveRequest(
  d: ProcDetail,
  definition: string,
  note: string,
  liveHash?: string | null
): SaveBody {
  const n = note.trim()
  const managed = d.config && d.managed?.kind === 'managed' ? d.config : null
  return {
    definition,
    ...(n ? { note: n } : {}),
    ...(managed ? { base_hash: managed.body_hash, base_version: managed.version } : {}),
    base_live_hash: liveHash !== undefined ? liveHash : d.live_hash
  }
}

/** POST /procedures/:name/versions/:v/restore — the same guards as an edit. */
export function restoreRequest(d: ProcDetail, liveHash?: string | null) {
  return {
    ...(d.config ? { base_hash: d.config.body_hash, base_version: d.config.version } : {}),
    base_live_hash: liveHash !== undefined ? liveHash : d.live_hash
  }
}

/** PUT /procedures/:name from New procedure: born managed. */
export function createRequest(definition: string) {
  return { definition, create: true as const }
}

/** DELETE path: a managed proc carries the version it was opened on (stale → 409). */
export function dropPath(d: ProcDetail): string {
  const base = `/procedures/${encodeURIComponent(d.name)}`
  return d.config && d.managed?.kind === 'managed'
    ? `${base}?base_version=${d.config.version}`
    : base
}

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ProcError {
  status: number | null
  code: string | null
  message: string
  /** PROC_DRIFTED: the live hash now (null = not live). */
  liveHash?: string | null
  /** APP_MANAGED: the import definition key. */
  importKey?: string
  /** PROC_EXISTS: the name belongs to a dropped managed proc. */
  dropped?: boolean
  /** DEPLOY_STAMP_FAILED / PROC_ALREADY_MANAGED: the version concerned. */
  version?: number
  /** DROP_FAILED: config still marks it dropped. */
  configDropped?: boolean
  /** 500 DEPLOY_STAMP_FAILED: deployed, only recording it failed — a warning, config kept. */
  stampOnly: boolean
}

export function readProcError(e: unknown, fallback = 'Something went wrong'): ProcError {
  const r = (e as { response?: { status?: number; data?: Record<string, unknown> } })?.response
  const data = r?.data ?? {}
  const code = typeof data.code === 'string' ? data.code : null
  const out: ProcError = {
    status: typeof r?.status === 'number' ? r.status : null,
    code,
    message: typeof data.error === 'string' && data.error ? data.error : fallback,
    stampOnly: code === 'DEPLOY_STAMP_FAILED'
  }
  if ('live_hash' in data) out.liveHash = (data.live_hash as string | null) ?? null
  if (typeof data.definition === 'string') out.importKey = data.definition
  if (typeof data.dropped === 'boolean') out.dropped = data.dropped
  if (typeof data.version === 'number') out.version = data.version
  if (typeof data.config_dropped === 'boolean') out.configDropped = data.config_dropped
  return out
}

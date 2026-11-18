import type { FastifyRequest } from 'fastify'
import type { User } from '../../../types.js'

/**
 * Linkable things ("sources"): issue-log entries, support tickets and business records. One
 * GitLab issue (a link) holds members of any kind; everything a source does differently — how it
 * reads, who may create from it, how GitLab state comes back, where comments land — sits behind
 * TrackerSource.
 */

export type SourceKind = 'issue' | 'ticket' | 'record'
export const SOURCE_KINDS: readonly SourceKind[] = ['issue', 'ticket', 'record']

export interface SourceView {
  kind: SourceKind
  /** issue / ticket: the numeric id as text; record: `<collection>:<id>`. */
  id: string
  title: string
  body: string | null
  status: string | null
  priority: string | null
  url: string
  fingerprint: string | null
  /** Template variables (already markdown-safe for strings that came from people). */
  vars: Record<string, unknown>
}

export interface SourceActor {
  userId: string
  via: 'gitlab'
  /** The activity / history line ("GitLab: closed by @jane"). */
  note?: string
}

export interface MirroredCommentMeta {
  link: number
  note_id: number
  author: string
  created_at?: Date
}

export interface LoadOptions {
  /**
   * Read as this person (records: their field list and row access; fields they cannot read are
   * absent). Null / missing for a record = no field values at all.
   */
  asUser?: User | null
  /** Issues: include the details text in the template variables (default true). */
  includeDetails?: boolean
}

export interface TrackerSource {
  kind: SourceKind
  load(id: string, opts?: LoadOptions): Promise<SourceView | null>
  /** May this person create / link a GitLab issue from it? (Admins: always for an existing one.) */
  canCreate(user: User, id: string, isAdmin: boolean, req?: FastifyRequest): Promise<boolean>
  /** Issue + ticket only. */
  setStatus?(id: string, status: string, actor: SourceActor): Promise<void>
  /** Issue + ticket only. */
  setPriority?(id: string, priority: string, actor: SourceActor): Promise<void>
  /** A GitLab note as a comment on the source's own thread, by the GitLab machine user. */
  addComment(id: string, text: string, meta: MirroredCommentMeta): Promise<void>
  /** The comment thread / record the source lives on (`nivaro_comments` collection + item). */
  ref(id: string): { collection: string; item: string } | null
  /** Doc only: comments follow the source's own read rules. */
  readers(id: string): 'everyone-who-can-read'
}

/** 'issue:12' | 'ticket:55' | 'record:workflows:9001' */
export function sourceKey(kind: SourceKind, id: string): string {
  return `${kind}:${id}`
}

export function isSourceKind(v: unknown): v is SourceKind {
  return v === 'issue' || v === 'ticket' || v === 'record'
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,99}$/

/** `<collection>:<id>` → parts, or null. System tables (nivaro_ / directus_) are not records. */
export function parseRecordId(id: string): { collection: string; item: string } | null {
  const s = String(id ?? '')
  const at = s.indexOf(':')
  if (at <= 0) return null
  const collection = s.slice(0, at)
  const item = s.slice(at + 1).trim()
  if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection)) return null
  if (!item || item.length > 80 || /[\s<>]/.test(item)) return null
  return { collection, item }
}

/** The canonical source id for a kind, or null when it is not one. */
export function normalizeSourceId(kind: SourceKind, raw: unknown): string | null {
  if (kind === 'record') {
    const p = parseRecordId(String(raw ?? ''))
    return p ? `${p.collection}:${p.item}` : null
  }
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null
}

/**
 * AI commands: field generation, record summarization, natural-language
 * query, CSV column mapping, and semantic (vector) search.
 *
 * All AI routes return 503 when no Anthropic API key is configured
 * (ANTHROPIC_API_KEY env var or the key saved in Settings → AI Features).
 */
import { type Command, cmd } from '../command.js'

// ─── Generate / Summarize (admin) ────────────────────────────────────────────

/** Generate a value for one field of an existing record (admin). */
export function aiGenerate(body: {
  collection: string
  item_id: string
  field: string
  context?: string
}): Command<{ data: { value: string } }> {
  return cmd('POST', '/ai/generate', undefined, body)
}

/** Summarize a record in 2-3 sentences (admin). */
export function aiSummarize(body: {
  collection: string
  item_id: string
}): Command<{ data: { summary: string } }> {
  return cmd('POST', '/ai/summarize', undefined, body)
}

// ─── Natural-language query ───────────────────────────────────────────────────

export interface AiQueryFilter {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'null' | 'nnull'
  value?: unknown
}

export interface AiQueryResult {
  data: Record<string, unknown>[]
  filters: AiQueryFilter[]
  sort: { field: string; dir: 'asc' | 'desc' } | null
  limit: number
  interpreted: string
}

/**
 * Translate a natural-language question into a validated filter and run it.
 * Returns matching rows plus the interpreted filter/sort/limit.
 */
export function aiQuery(body: { collection: string; prompt: string }): Command<AiQueryResult> {
  return cmd('POST', '/ai/query', undefined, body)
}

// ─── CSV column mapping ───────────────────────────────────────────────────────

export interface AiColumnMapping {
  column: string
  field: string | null
  confidence: 'high' | 'medium' | 'low'
}

/** Suggest CSV column → collection field mappings for the import wizard. */
export function aiMapColumns(body: {
  collection: string
  columns: string[]
  sample_rows?: Record<string, unknown>[]
}): Command<{ mappings: AiColumnMapping[] }> {
  return cmd('POST', '/ai/map-columns', undefined, body)
}

// ─── Semantic search ──────────────────────────────────────────────────────────

export interface SemanticSearchMatch {
  item: Record<string, unknown>
  score: number
  field: string
}

/** Vector-similarity search over a collection's embedded text fields. */
export function semanticSearch(body: {
  collection: string
  query: string
  /** 1–100, default 10. */
  limit?: number
}): Command<{ data: SemanticSearchMatch[] }> {
  return cmd('POST', '/search/semantic', undefined, body)
}

/** Rebuild embeddings for all eligible text fields of a collection (admin). */
export function reindexSemanticSearch(collection: string): Command<{ indexed: number }> {
  return cmd('POST', `/search/reindex/${collection}`)
}

// ─── AI content validation / duplicate detection ─────────────────────────────

export interface AiViolation {
  rule: string
  explanation: string
}

/** Validate a record against the collection's configured AI content rules. */
export function aiValidate(body: {
  collection: string
  data: Record<string, unknown>
}): Command<{ violations: AiViolation[]; mode: 'soft' | 'hard'; enabled: boolean }> {
  return cmd('POST', '/ai/validate', undefined, body)
}

export interface AiDuplicateMatch {
  id: string | number
  score: number
  label: string
  fields: Record<string, unknown>
}

/** Check a record against existing items for semantic duplicates. */
export function aiCheckDuplicates(body: {
  collection: string
  data: Record<string, unknown>
  exclude_id?: string | number
}): Command<{ duplicates: AiDuplicateMatch[]; enabled: boolean }> {
  return cmd('POST', '/ai/check-duplicates', undefined, body)
}

export interface AiCollectionSettings {
  collection: string
  validation_enabled: boolean
  validation_mode: 'soft' | 'hard'
  validation_rules: string[]
  duplicate_detection_enabled: boolean
  duplicate_threshold: number
}

/** Read a collection's AI feature configuration (admin). */
export function readAiSettings(collection: string): Command<{ data: AiCollectionSettings }> {
  return cmd('GET', `/ai-settings/${collection}`)
}

/** Update a collection's AI feature configuration (admin). */
export function updateAiSettings(
  collection: string,
  body: Partial<Omit<AiCollectionSettings, 'collection'>>
): Command<{ data: AiCollectionSettings }> {
  return cmd('PATCH', `/ai-settings/${collection}`, undefined, body)
}

import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

// ---------------------------------------------------------------------------
// Embeddings service
//
// Anthropic/Claude has no embedding API. Two providers are supported:
//
// 1. Voyage AI (Anthropic's recommended embeddings partner) — used when the
//    optional VOYAGE_API_KEY env var is set. Model: voyage-3-lite.
// 2. Local fallback — a deterministic feature-hashed term-frequency vector
//    (512 dims, token hash → bucket, L2-normalized). This is NOT a neural
//    embedding: it captures lexical overlap only (shared tokens), with no
//    real semantic understanding. It is honest, dependency-free, and good
//    enough for keyword-ish similarity ranking when no provider is set.
//
// Vectors from the two providers live in different spaces — if VOYAGE_API_KEY
// is set we never silently fall back to the local embedder on transient
// failure (that would mix incompatible vectors in nivaro_embeddings).
// ---------------------------------------------------------------------------

const LOCAL_DIM = 512
const VOYAGE_URL = 'https://api.voyage.ai/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3-lite'

// Field names eligible for automatic embedding (text/string fields only).
export const EMBEDDABLE_FIELD_NAMES = ['title', 'name', 'description', 'content', 'body', 'notes']
export const EMBEDDABLE_FIELD_TYPES = ['text', 'string']

// FNV-1a 32-bit hash — deterministic token → bucket assignment.
function hashToken(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function localEmbed(text: string): number[] {
  const vec: number[] = new Array(LOCAL_DIM).fill(0)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    vec[hashToken(token) % LOCAL_DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (norm === 0) return vec
  return vec.map((v) => v / norm)
}

async function voyageEmbed(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ input: [text.slice(0, 8000)], model: VOYAGE_MODEL })
  })
  if (!res.ok) {
    throw new Error(`Voyage embeddings request failed with status ${res.status}`)
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Voyage embeddings response missing embedding')
  }
  return embedding
}

export async function embedText(text: string): Promise<number[]> {
  const voyageKey = process.env.VOYAGE_API_KEY
  if (voyageKey) return voyageEmbed(text, voyageKey)
  return localEmbed(text)
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Upsert the embedding for one (collection, item, field) triple.
 * Skips the provider call entirely when the sha256 content hash is unchanged.
 * Returns true when an embedding was written, false when skipped.
 */
export async function upsertItemEmbedding(
  collection: string,
  item: string,
  field: string,
  text: string
): Promise<boolean> {
  const contentHash = createHash('sha256').update(text).digest('hex')

  const existing = (await db('nivaro_embeddings')
    .where({ collection, item, field })
    .first('id', 'content_hash')) as { id: number; content_hash: string } | undefined
  if (existing?.content_hash === contentHash) return false

  const vec = await embedText(text)
  const row = {
    content_hash: contentHash,
    embedding: JSON.stringify(vec),
    updated_at: new Date()
  }

  if (existing) {
    await db('nivaro_embeddings').where({ id: existing.id }).update(row)
  } else {
    await db('nivaro_embeddings').insert({ collection, item, field, ...row })
  }
  return true
}

/**
 * Rank stored embeddings for a collection against a query vector.
 * Embeddings are stored as JSON text (MSSQL has no native vector type),
 * so similarity is computed in JS — fine at CMS scale, revisit if rows
 * grow into the hundreds of thousands.
 */
export async function searchEmbeddings(
  collection: string,
  queryVec: number[],
  limit = 10
): Promise<Array<{ item: string; field: string; score: number }>> {
  const rows = (await db('nivaro_embeddings')
    .where({ collection })
    .select('item', 'field', 'embedding')) as Array<{
    item: string
    field: string
    embedding: string
  }>

  const scored: Array<{ item: string; field: string; score: number }> = []
  for (const row of rows) {
    let vec: unknown
    try {
      vec = JSON.parse(row.embedding)
    } catch {
      continue
    }
    if (!Array.isArray(vec)) continue
    scored.push({
      item: String(row.item),
      field: row.field,
      score: cosineSim(queryVec, vec as number[])
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, limit))
}

/** Text/string fields on a collection whose names make them embedding-eligible. */
export async function getEmbeddableFields(collection: string): Promise<string[]> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .whereIn('type', EMBEDDABLE_FIELD_TYPES)
    .whereIn('field', EMBEDDABLE_FIELD_NAMES)
    .select('field')) as Array<{ field: string }>
  return rows.map((r) => r.field)
}

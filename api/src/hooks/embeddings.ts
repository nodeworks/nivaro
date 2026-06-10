import type { FastifyInstance } from 'fastify'
import { getEmbeddableFields, upsertItemEmbedding } from '../services/embeddings.js'
import { hooks } from './registry.js'

// Store app reference so the hook can log via Fastify after startup.
let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

// Embeddable-field lookups are cached per collection with a short TTL so the
// hook doesn't hit nivaro_fields on every mutation.
const CACHE_TTL_MS = 5 * 60_000
const fieldCache = new Map<string, { fields: string[]; at: number }>()

async function embeddableFields(collection: string): Promise<string[]> {
  const cached = fieldCache.get(collection)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.fields
  const fields = await getEmbeddableFields(collection)
  fieldCache.set(collection, { fields, at: Date.now() })
  return fields
}

export function registerEmbeddingHooks() {
  // The hook registry supports wildcard collections ('*'), so a single
  // after-hook covers every collection — no per-collection registration
  // (which would require DB access before migrations run at startup).
  hooks.after('*', '*', async (ctx) => {
    if (ctx.action !== 'create' && ctx.action !== 'update') return
    if (ctx.collection.startsWith('nivaro_')) return

    const result = ctx.result as Record<string, unknown> | undefined
    if (!result) return

    const itemKey = ctx.keys?.[0] ?? result.id
    if (itemKey === undefined || itemKey === null) return
    const item = String(itemKey)

    const fields = await embeddableFields(ctx.collection).catch(() => [] as string[])
    for (const field of fields) {
      const value = result[field]
      if (typeof value !== 'string' || value.trim() === '') continue

      // Fire-and-forget — embedding must never block or fail the mutation.
      upsertItemEmbedding(ctx.collection, item, field, value).catch((err) => {
        if (_app) {
          _app.log.error(
            { err, collection: ctx.collection, item, field },
            'Embedding upsert failed'
          )
        } else {
          console.error({ err, collection: ctx.collection, item, field }, 'Embedding upsert failed')
        }
      })
    }
  })
}

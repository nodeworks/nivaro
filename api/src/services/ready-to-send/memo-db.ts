/**
 * A read-memoizing knex for the ready-to-send batch (idea 37): every awaited builder is keyed by
 * its compiled SQL + bindings, so the same statement answers once per run (metadata — field
 * labels, relations — keeps for the whole run; anything else for one chunk of records, then
 * `forgetChunk` drops it). Only reads go through it: the transition-requirements evaluator,
 * which takes its database as a parameter, reads nivaro_fields / nivaro_relations on every
 * call and would otherwise repeat them for every record.
 */
import type { Knex } from 'knex'
import { db } from '../../db/index.js'

const META_TABLES = new Set(['nivaro_fields', 'nivaro_relations', 'nivaro_collections'])

function memoBuilder(
  qb: Knex.QueryBuilder,
  cache: Map<string, Promise<unknown>>,
  prefix: string
): Knex.QueryBuilder {
  const proxy: Knex.QueryBuilder = new Proxy(qb, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          let key: string
          try {
            const c = target.toSQL()
            key = `${prefix}${c.sql}|${JSON.stringify(c.bindings ?? [])}`
          } catch {
            return target.then(res, rej)
          }
          let p = cache.get(key)
          if (!p) {
            p = Promise.resolve(target)
            cache.set(key, p)
            // A failed read is not remembered.
            p.catch(() => cache.delete(key))
          }
          return p.then(res, rej)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(target, args)
        return out === target ? proxy : out
      }
    }
  })
  return proxy
}

/** A `typeof db` whose table reads are memoized in `cache` (see the module note). */
export function memoDb(cache: Map<string, Promise<unknown>>): typeof db {
  return new Proxy(db, {
    apply(target, thisArg, args: unknown[]) {
      const qb = Reflect.apply(target as never, thisArg, args) as Knex.QueryBuilder
      const table = typeof args[0] === 'string' ? args[0] : ''
      return memoBuilder(qb, cache, META_TABLES.has(table) ? 'meta:' : 'sql:')
    }
  }) as typeof db
}

/** Drop one chunk's memoized record reads (metadata stays). */
export function forgetChunkReads(cache: Map<string, Promise<unknown>>): void {
  for (const k of [...cache.keys()]) if (k.startsWith('sql:')) cache.delete(k)
}

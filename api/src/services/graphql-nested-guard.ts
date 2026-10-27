import { GraphQLError } from 'graphql'
import type { User } from '../types.js'
import type { NestedGate } from './graphql-nested-access.js'
import { isSecretColumn, isSystemCollection, systemReadableColumns } from './system-collections.js'

/**
 * Guards for NESTED GraphQL list arguments and nested fan-out.
 *
 * A top-level list goes through readItems, which refuses credential paths and paths the caller
 * cannot read. The nested `filter` / `sort` arguments on a to-many field compile straight into
 * SQL (schema-builder applyNestedListArgs), so they get the same rules here: a credential name is
 * refused anywhere in a path (admins included — a filter is an oracle), and a non-admin may only
 * filter or sort on fields their read policy lists, on the related collection and through one
 * M2O hop from it.
 *
 * Nested fields also resolve one query per parent row. A cost cap on selections cannot bound
 * that (100 parents × 100 children × an M2O each is 10,000 queries from a short document), so
 * every request carries a budget of nested queries and nested rows.
 */

interface NestedCtx {
  user?: User
  isAdmin?: boolean
}

type GateOf = (collection: string) => Promise<NestedGate>

function refusal(message: string, code: string, status: number, fields: string[]): GraphQLError {
  return new GraphQLError(message, { extensions: { code, status, fields } })
}

/** Every filter key path (dotted keys split) and every sort path, as segment lists. */
export function nestedArgPaths(args: { filter?: unknown; sort?: unknown }): string[][] {
  const out: string[][] = []
  const walk = (f: unknown, prefix: string[]) => {
    if (Array.isArray(f)) {
      for (const c of f) walk(c, prefix)
      return
    }
    if (!f || typeof f !== 'object') return
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k === '_and' || k === '_or' || k === '_some' || k === '_none') walk(v, prefix)
      else if (k.startsWith('_') || k.startsWith('$')) continue
      else {
        const path = [...prefix, ...k.split('.')]
        out.push(path)
        walk(v, path)
      }
    }
  }
  walk(args.filter, [])
  for (const s of Array.isArray(args.sort) ? args.sort : []) {
    if (typeof s !== 'string' || !s) continue
    out.push((s.startsWith('-') ? s.slice(1) : s).split('.'))
  }
  return out
}

/**
 * Throws when a nested list's filter or sort names a credential, or (non-admins) a field the
 * caller cannot read on `collection` or one M2O hop from it.
 */
export async function assertNestedArgsAllowed(
  ctx: NestedCtx,
  collection: string,
  gate: NestedGate,
  args: { filter?: unknown; sort?: unknown },
  m2oOf: (field: string) => string | undefined,
  gateOf: GateOf
): Promise<void> {
  const paths = nestedArgPaths(args)
  if (paths.length === 0) return
  const secret = [...new Set(paths.flat().filter((seg) => isSecretColumn(seg)))]
  if (secret.length > 0)
    throw refusal(
      `${secret.map((f) => `"${f}"`).join(', ')} cannot be filtered or sorted`,
      'FIELD_NOT_FILTERABLE',
      400,
      secret
    )
  if (ctx.isAdmin) return
  const bad = new Set<string>()
  const allowedOn = (g: NestedGate, field: string) =>
    field === 'id' || g.fields === null || g.fields.has(field)
  for (const path of paths) {
    const [root, next] = path
    if (!allowedOn(gate, root)) {
      bad.add(root)
      continue
    }
    if (next == null) continue
    const target = m2oOf(root)
    if (!target) continue
    if (isSystemCollection(target)) {
      const readable = systemReadableColumns(target) ?? []
      if (next !== 'id' && !readable.includes(next)) bad.add(`${root}.${next}`)
      continue
    }
    const tg = await gateOf(target)
    if (!tg.allowed || !allowedOn(tg, next)) bad.add(`${root}.${next}`)
  }
  if (bad.size === 0) return
  throw refusal(
    `You cannot filter or sort on ${[...bad].map((f) => `"${f}"`).join(', ')}`,
    'FIELD_NOT_READABLE',
    403,
    [...bad]
  )
}

// ── Fan-out budget ──────────────────────────────────────────────────────────

interface Budget {
  queries: number
  rows: number
  /** The refusal was already raised once; later nested fields answer empty quietly. */
  spent: boolean
}

const budgets = new WeakMap<object, Budget>()

function limit(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** GRAPHQL_MAX_NESTED_QUERIES (default 25,000; 0 = off) per request. */
export function maxNestedQueries(): number {
  return limit('GRAPHQL_MAX_NESTED_QUERIES', 25_000)
}

/** GRAPHQL_MAX_NESTED_ROWS (default 250,000; 0 = off) per request. */
export function maxNestedRows(): number {
  return limit('GRAPHQL_MAX_NESTED_ROWS', 250_000)
}

function budgetOf(ctx: object): Budget {
  let b = budgets.get(ctx)
  if (!b) {
    b = { queries: 0, rows: 0, spent: false }
    budgets.set(ctx, b)
  }
  return b
}

function overBudget(b: Budget, what: string, cap: number): false {
  if (b.spent) return false
  b.spent = true
  throw new GraphQLError(
    `This query reads more than ${cap} nested ${what}. Page the outer list (limit/offset) or narrow the nested lists.`,
    { extensions: { code: 'QUERY_TOO_COSTLY', status: 400 } }
  )
}

/**
 * Take one nested query from this request's budget. False = the budget is spent (the first
 * call past it throws QUERY_TOO_COSTLY once; later ones answer false quietly so one runaway
 * query does not return thousands of identical errors).
 */
export function takeNestedQuery(ctx: object): boolean {
  const b = budgetOf(ctx)
  if (b.spent) return false
  const cap = maxNestedQueries()
  b.queries++
  if (cap > 0 && b.queries > cap) return overBudget(b, 'reads', cap)
  return true
}

/** Charge rows a nested query returned. False = the budget is spent (see takeNestedQuery). */
export function chargeNestedRows(ctx: object, rows: number): boolean {
  const b = budgetOf(ctx)
  if (b.spent) return false
  const cap = maxNestedRows()
  b.rows += rows
  if (cap > 0 && b.rows > cap) return overBudget(b, 'rows', cap)
  return true
}

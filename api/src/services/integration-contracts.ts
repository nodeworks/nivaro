import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Inbound payload contract enforcement. Runs inside createOne/updateOne on
 * the CALLER's raw payload, before field rules and computed fields reshape
 * it — the contract judges what the integration actually sent. 'flag' mode
 * raises a deduped issue and lets the write proceed (drift you want to know
 * about, not block on); 'reject' throws a 422 the sender sees.
 *
 * Required fields are judged on CREATE only — a partial PATCH is normal
 * integration behaviour, and failing it for omissions would fail every
 * status-only update (same philosophy as server validation rules).
 */

export interface ContractConfig {
  required?: string[]
  /** field -> 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' */
  types?: Record<string, string>
  forbid_unknown?: boolean
}

interface ContractRow {
  id: number
  name: string
  collection: string
  user_id: string | null
  config: string | null
  mode: 'flag' | 'reject'
  is_active: boolean
}

let cache: { at: number; byCollection: Map<string, ContractRow[]> } | null = null
const TTL = 60_000

export function bustContractCache(): void {
  cache = null
}

async function contractsFor(collection: string): Promise<ContractRow[]> {
  if (!cache || Date.now() - cache.at > TTL) {
    try {
      const rows = (await db('nivaro_integration_contracts').where('is_active', true)) as ContractRow[]
      const m = new Map<string, ContractRow[]>()
      for (const r of rows) m.set(r.collection, [...(m.get(r.collection) ?? []), r])
      cache = { at: Date.now(), byCollection: m }
    } catch {
      // table missing mid-migration — contracts simply don't apply
      cache = { at: Date.now(), byCollection: new Map() }
    }
  }
  return cache.byCollection.get(collection) ?? []
}

function typeOk(value: unknown, expected: string): boolean {
  if (value == null) return true // nullability is the required-list's job
  switch (expected) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
    case 'boolean':
      return typeof value === 'boolean' || value === 0 || value === 1 || value === '0' || value === '1'
    case 'date':
      return (
        (typeof value === 'string' || value instanceof Date) && !Number.isNaN(new Date(value as string).getTime())
      )
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

export class ContractViolationError extends Error {
  statusCode = 422
  code = 'CONTRACT_VIOLATION'
  violations: string[]
  constructor(contractName: string, violations: string[]) {
    super(`Payload violates integration contract "${contractName}": ${violations.join('; ')}`)
    this.violations = violations
  }
}

const AUDIT_FIELDS = new Set(['id', 'date_created', 'date_updated', 'user_created', 'user_updated', 'created_at', 'updated_at', '_change_reason'])

/**
 * Validate a write. Throws ContractViolationError in reject mode; in flag
 * mode records a deduped issue and returns. No-op when no contract binds
 * this collection + writer.
 */
export async function enforceContracts(
  collection: string,
  userId: string | null | undefined,
  payload: Record<string, unknown>,
  action: 'create' | 'update'
): Promise<void> {
  const contracts = await contractsFor(collection)
  if (contracts.length === 0) return

  for (const c of contracts) {
    if (c.user_id && String(c.user_id).toUpperCase() !== String(userId ?? '').toUpperCase()) continue
    let cfg: ContractConfig
    try {
      cfg = c.config ? (JSON.parse(c.config) as ContractConfig) : {}
    } catch {
      continue
    }
    const violations: string[] = []
    if (action === 'create') {
      for (const f of cfg.required ?? []) {
        const v = payload[f]
        if (v == null || v === '') violations.push(`missing required field "${f}"`)
      }
    }
    for (const [f, expected] of Object.entries(cfg.types ?? {})) {
      if (f in payload && !typeOk(payload[f], expected)) {
        violations.push(`"${f}" should be ${expected}, got ${Array.isArray(payload[f]) ? 'array' : typeof payload[f]} (${JSON.stringify(payload[f]).slice(0, 60)})`)
      }
    }
    if (cfg.forbid_unknown) {
      const known = new Set([...(cfg.required ?? []), ...Object.keys(cfg.types ?? {})])
      for (const k of Object.keys(payload)) {
        if (!known.has(k) && !AUDIT_FIELDS.has(k)) violations.push(`unknown field "${k}"`)
      }
    }
    if (violations.length === 0) continue

    if (c.mode === 'reject') throw new ContractViolationError(c.name, violations)
    await flagViolation(c, action, violations)
  }
}

async function flagViolation(c: ContractRow, action: string, violations: string[]): Promise<void> {
  try {
    const fingerprint = createHash('sha256').update(`contract|${c.id}`).digest('hex')
    const details = [
      `An inbound ${action} on ${c.collection} drifted from the declared contract:`,
      ...violations.map((v) => `  · ${v}`),
      '',
      'The write was allowed (flag mode). If the integration changed its payload shape,',
      'update the contract; if this is corruption, switch the contract to reject mode.'
    ].join('\n')
    const existing = await db('nivaro_issues')
      .where({ fingerprint })
      .whereIn('status', ['open', 'acknowledged'])
      .first()
    if (existing) {
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({ details, occurrence_count: db.raw('occurrence_count + 1'), last_seen_at: new Date(), updated_at: new Date() })
    } else {
      await db('nivaro_issues').insert({
        title: `Integration contract drift: ${c.name}`,
        severity: 'warning',
        status: 'open',
        source: 'server',
        details,
        fingerprint,
        occurrence_count: 1,
        last_seen_at: new Date(),
        created_at: new Date(),
        updated_at: new Date()
      })
    }
  } catch {
    // flagging must never break the write
  }
}

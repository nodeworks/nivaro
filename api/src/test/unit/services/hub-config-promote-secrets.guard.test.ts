import { readFileSync } from 'node:fs'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// GUARD — Hub config promotion (idea 30) never carries a secret. Two halves:
//  1. every keep-registry rule on a promotable table names a real column of it or a part the
//     promotion knows how to strip (KEEP_PSEUDO_COLUMNS) — a rule nobody applies fails here;
//  2. readPromotionSnapshot over a database seeded with the secrets that matter (a flow with a
//     webhook step carrying auth headers, a URL key and a token, a webhook trigger secret; an
//     external API with a body secret; a payload template using that body secret; settings with
//     mail, Teams, storage, MCP credentials and a sealed value) answers NONE of them: no seeded
//     value, no sealed value, no secret-named key with a value, and a body-secret placeholder
//     only as a reference by name (the value lives in the external API, which never travels).
// Every promotable table is created (columns from the column fixture) and walked.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../db/dialect/users-ai-config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  listNivaroTables: async (k: Knex) =>
    (
      (await k.raw(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nivaro\\_%' ESCAPE '\\'"
      )) as Array<{ name: string }>
    ).map((r) => r.name)
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { promotableTables } = await import('../../../services/config-promote-groups.js')
const { allKeeps } = await import('../../../services/env-refresh/registry.js')
const { KEEP_PSEUDO_COLUMNS, readPromotionSnapshot } = await import(
  '../../../services/hub-link/config-promote.js'
)
const { MARKER, PLACEHOLDER_RE, SECRET_NAME_RE } = await import(
  '../../../services/secret-markers.js'
)

const COLUMNS = JSON.parse(
  readFileSync(new URL('../../fixtures/nivaro-column-names.json', import.meta.url), 'utf8')
) as Record<string, string[]>

const SECRETS = [
  'HDR-SECRET-2',
  'APIKEY-3',
  'PW-SECRET-4',
  'TOK-5',
  'URLSECRET',
  'TRIG-SECRET-1',
  'SMTP-6',
  'WEBHOOK-7',
  'STORE-8',
  'MCP-9',
  'BODY-SECRET-11',
  'enc:v1:'
]
/** A key name that holds a credential (plural `tokens` is an AI token count). */
const SECRET_KEY =
  /secret|token(?!s)|passw|pwd|private_key|credential|api_?key|access_key|auth|cookie|webhook/i

beforeAll(async () => {
  for (const t of [...promotableTables(), 'nivaro_external_apis']) {
    const cols = COLUMNS[t]
    expect(cols, `${t} in the column fixture`).toBeTruthy()
    await db.schema.createTable(t, (tb) => {
      for (const c of cols) tb.text(c).nullable()
    })
  }
  await db('nivaro_flows').insert({
    id: '1',
    name: 'Partner hook',
    status: 'active',
    trigger: 'webhook',
    trigger_options: JSON.stringify({ secret: 'TRIG-SECRET-1', method: 'POST' })
  })
  await db('nivaro_flow_operations').insert({
    id: '1',
    flow: '1',
    key: 'send',
    name: 'Send to partner',
    type: 'webhook',
    options: JSON.stringify({
      url: 'https://partner.example/hook?k=URLSECRET',
      method: 'POST',
      headers: { Authorization: 'Bearer HDR-SECRET-2', 'X-Api-Key': 'APIKEY-3' },
      auth: { username: 'svc', password: 'PW-SECRET-4' },
      token: 'TOK-5',
      body: '{"order":"{{id}}"}'
    })
  })
  await db('nivaro_external_apis').insert({
    id: '1',
    name: 'partner',
    base_url: 'https://partner.example',
    auth_config: JSON.stringify({ body_secrets: { partner_key: 'BODY-SECRET-11' } })
  })
  const body = JSON.stringify({ key: '⟦nvr-secret:partner_key⟧', id: '{{id}}' })
  await db('nivaro_payload_templates').insert({
    id: '1',
    key: 'order',
    label: 'Order',
    external_api: '1',
    published_body: body
  })
  await db('nivaro_payload_template_versions').insert({
    id: '1',
    template_id: '1',
    body,
    version: '1'
  })
  await db('nivaro_payload_template_drafts').insert({ id: '1', template_id: '1', body })
  await db('nivaro_settings').insert({
    id: '1',
    welcome_message: 'hello',
    smtp_pass: 'SMTP-6',
    teams_webhook_url: 'https://teams.example/WEBHOOK-7',
    storage_config: JSON.stringify({ access_key: 'STORE-8' }),
    mcp_settings: JSON.stringify({ token: 'MCP-9' }),
    ai_gateway_client_secret: 'enc:v1:aaaa:bbbb:cccc'
  })
  await db('nivaro_roles').insert({ id: '1', name: 'Editor', description: 'Edits' })
  await db('nivaro_managed_procedures').insert({ id: '1', name: 'usp_x', body: 'SELECT 1' })
})
afterAll(async () => {
  await db.destroy()
})

describe('keep rules on promotable tables', () => {
  it('every rule names a real column or a part the promotion strips', () => {
    const promotable = promotableTables()
    const gaps: string[] = []
    for (const k of allKeeps([])) {
      if (!promotable.has(k.table) || k.kind !== 'columns') continue
      const real = new Set(COLUMNS[k.table] ?? [])
      const pseudo = KEEP_PSEUDO_COLUMNS[k.table] ?? {}
      for (const c of [...(k.columns ?? []), ...(k.secret_columns ?? [])])
        if (!real.has(c) && !pseudo[c]) gaps.push(`${k.id}: ${k.table}.${c}`)
    }
    expect(gaps).toEqual([])
  })
})

function walk(v: unknown, path: string, hits: string[]): void {
  if (v === null || v === undefined) return
  if (typeof v === 'string') {
    for (const s of SECRETS) if (v.includes(s)) hits.push(`${path} carries ${s}`)
    if (v.includes(MARKER)) {
      const rest = v.replace(PLACEHOLDER_RE, (_m, name: string) =>
        SECRET_NAME_RE.test(name) ? '' : '!!'
      )
      if (rest.includes(MARKER) || rest.includes('!!')) hits.push(`${path} has a forged marker`)
    }
    const t = v.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200_000) {
      try {
        walk(JSON.parse(t), `${path}<json>`, hits)
      } catch {
        // not JSON
      }
    }
    return
  }
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`, hits)
    return
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && x !== null && x !== undefined && x !== '')
        hits.push(`${path}.${k} is a secret-named key with a value`)
      walk(x, `${path}.${k}`, hits)
    }
  }
}

describe('readPromotionSnapshot', () => {
  it('answers no secret from any promotable table or column', async () => {
    const answer = await readPromotionSnapshot([...promotableTables()])
    const tables = Object.keys(answer.snapshot.tables)
    // Every promotable table was read (none failed and slipped through unchecked).
    expect(answer.snapshot.errors).toEqual({})
    expect(tables.sort()).toEqual([...promotableTables()].sort())
    const hits: string[] = []
    for (const [t, rows] of Object.entries(answer.snapshot.tables))
      for (const [key, row] of Object.entries(rows))
        for (const [c, v] of Object.entries(row.data)) {
          if (SECRET_KEY.test(c) && v !== null && v !== undefined && v !== '')
            hits.push(`${t}#${key}.${c} is a secret-named column with a value`)
          walk(v, `${t}#${key}.${c}`, hits)
        }
    expect(hits).toEqual([])
    // Nothing the whole answer says (the snapshot's own frame included) names a seeded secret.
    const all = JSON.stringify(answer)
    for (const s of SECRETS) expect(all, s).not.toContain(s)
  })

  it('keeps what is not a secret: the step body, the template’s placeholder by name', async () => {
    const answer = await readPromotionSnapshot([...promotableTables()])
    const op = answer.snapshot.tables.nivaro_flow_operations['1'].data
    expect(JSON.parse(String(op.options))).toEqual({ method: 'POST', body: '{"order":"{{id}}"}' })
    expect(
      String(answer.snapshot.tables.nivaro_payload_templates['1'].data.published_body)
    ).toContain('⟦nvr-secret:partner_key⟧')
    expect(answer.snapshot.tables.nivaro_settings['1'].data.welcome_message).toBe('hello')
    expect(answer.snapshot.tables.nivaro_external_apis).toBeUndefined()
    expect(answer.snapshot.instance.database).toBe('')
  })
})

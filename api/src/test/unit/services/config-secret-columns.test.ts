import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_TABLES,
  hashRow,
  isRedactedColumn,
  redactRow,
  redactSnapshot,
  SECRET_NAME_ALLOW,
  SECRET_NAME_RE
} from '../../../services/config-inventory.js'

/**
 * #2803 review — no credential column may ride a config snapshot (the nightly row, the Config
 * Diff download, a restore preview). The fixture is every nivaro_* column name on the dev
 * database (INFORMATION_SCHEMA, names only, captured read-only 2026-10-22). Refresh it when a
 * migration adds columns:
 *   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns WHERE TABLE_NAME LIKE 'nivaro[_]%'
 */
const COLUMNS = JSON.parse(
  readFileSync(new URL('../../fixtures/nivaro-column-names.json', import.meta.url), 'utf8')
) as Record<string, string[]>

/** Broader than the redaction rule on purpose: any of these anywhere in a name needs a look. */
// `tokens` (plural) is an AI token COUNT (input_tokens, ai_max_tokens_generate), not a credential.
const LOOKS_SECRET =
  /secret|token(?!s)|passw|pwd|private_key|credential|api_?key|access_key|auth_config|account_sid/i

describe('secret columns never ride a snapshot', () => {
  it('the fixture is real', () => {
    expect(Object.keys(COLUMNS).length).toBeGreaterThan(100)
    expect(COLUMNS.nivaro_settings).toContain('ai_gateway_client_secret')
  })

  it('redacts every column that looks like a credential, except the reviewed allow-list', () => {
    const leaks: string[] = []
    for (const [table, cols] of Object.entries(COLUMNS)) {
      for (const c of cols) {
        if (!LOOKS_SECRET.test(c)) continue
        if (SECRET_NAME_ALLOW.has(`${table}.${c}`)) continue
        if (!isRedactedColumn(table, c)) leaks.push(`${table}.${c}`)
      }
    }
    expect(leaks).toEqual([])
  })

  it('names exactly the reviewed exceptions — a new name the rule catches needs a decision', () => {
    const caught: string[] = []
    for (const [table, cols] of Object.entries(COLUMNS)) {
      for (const c of cols) {
        if (SECRET_NAME_RE.test(c) && SECRET_NAME_ALLOW.has(`${table}.${c}`))
          caught.push(`${table}.${c}`)
      }
    }
    expect(caught.sort()).toEqual([...SECRET_NAME_ALLOW].sort())
  })

  it('covers the credentials the review named', () => {
    for (const [t, c] of [
      ['nivaro_settings', 'ai_gateway_client_secret'],
      ['nivaro_settings', 'storage_s3_access_key'],
      ['nivaro_settings', 'storage_s3_secret'],
      ['nivaro_settings', 'provision_secret'],
      ['nivaro_settings', 'directory_password'],
      ['nivaro_settings', 'directory_refresh_token'],
      ['nivaro_environment_components', 'api_token'],
      ['nivaro_environment_components', 'git_token'],
      ['nivaro_webhooks', 'secret'],
      ['nivaro_sso_providers', 'client_secret']
    ]) {
      expect(isRedactedColumn(t, c), `${t}.${c}`).toBe(true)
    }
  })

  it('keeps ordinary config columns, including the reviewed non-secrets', () => {
    expect(isRedactedColumn('nivaro_settings', 'ai_gateway_token_url')).toBe(false)
    expect(isRedactedColumn('nivaro_settings', 'project_name')).toBe(false)
    expect(isRedactedColumn('nivaro_fields', 'field')).toBe(false)
    // Every config table keeps its id.
    for (const t of CONFIG_TABLES) expect(isRedactedColumn(t, 'id')).toBe(false)
  })

  it('catches a credential column a future migration adds without a list entry', () => {
    expect(isRedactedColumn('nivaro_settings', 'slack_bot_token')).toBe(true)
    expect(isRedactedColumn('nivaro_external_apis', 'oauth_client_secret')).toBe(true)
    expect(isRedactedColumn('nivaro_sync_jobs', 'sftp_password')).toBe(true)
    expect(isRedactedColumn('nivaro_settings', 'webhook_credentials')).toBe(true)
  })

  it('strips a stored snapshot written before the column joined the list, with a fresh hash', () => {
    const data = { id: 1, project_name: 'EFP', directory_password: 'x' }
    const snap = redactSnapshot({
      format: 1,
      generated_at: '2026-10-07T08:40:00.000Z',
      instance: { version: '0.2.20', environment: 'development', database: 'D' },
      classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
      tables: { nivaro_settings: { '1': { hash: hashRow(data), data } } },
      errors: {}
    })
    const row = snap.tables.nivaro_settings['1']
    expect(row.data).toEqual({ id: 1, project_name: 'EFP' })
    expect(row.hash).toBe(hashRow(redactRow('nivaro_settings', data)))
  })
})

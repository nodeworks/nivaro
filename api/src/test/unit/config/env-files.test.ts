import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFiles } from '../../../env-files.js'

function dir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'nvr-secrets-'))
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v)
  return d
}

describe('loadEnvFiles (#1084)', () => {
  it('reads X_FILE into X and drops one trailing newline', () => {
    const d = dir({ pw: 's3cret\n' })
    const env: NodeJS.ProcessEnv = { DB_PASSWORD_FILE: join(d, 'pw') }
    const r = loadEnvFiles(env, { secretsDir: null })
    expect(env.DB_PASSWORD).toBe('s3cret')
    expect(r.errors).toEqual([])
  })

  it('refuses X and X_FILE both set', () => {
    const d = dir({ pw: 'a' })
    const env: NodeJS.ProcessEnv = { DB_PASSWORD: 'b', DB_PASSWORD_FILE: join(d, 'pw') }
    const r = loadEnvFiles(env, { secretsDir: null })
    expect(r.errors[0]).toMatch(/Both DB_PASSWORD and DB_PASSWORD_FILE/)
    expect(env.DB_PASSWORD).toBe('b')
  })

  it('reports an unreadable file without its contents', () => {
    const env: NodeJS.ProcessEnv = { SESSION_SECRET_FILE: '/nope/missing' }
    const r = loadEnvFiles(env, { secretsDir: null })
    expect(r.errors[0]).toMatch(/SESSION_SECRET_FILE/)
    expect(env.SESSION_SECRET).toBeUndefined()
  })

  it('exports every env-shaped file in the secrets folder, replacing a stale value', () => {
    const d = dir({ DB_PASSWORD: 'from-secret\n', 'not-a-var': 'x', lower: 'y' })
    const env: NodeJS.ProcessEnv = { DB_PASSWORD: 'from-dotenv' }
    const r = loadEnvFiles(env, { secretsDir: d })
    expect(env.DB_PASSWORD).toBe('from-secret')
    expect(r.replaced).toEqual(['DB_PASSWORD'])
    expect(env['not-a-var']).toBeUndefined()
    expect(env.lower).toBeUndefined()
  })

  it('an explicit X_FILE wins over the folder', () => {
    const d = dir({ DB_PASSWORD: 'folder' })
    const e = dir({ pw: 'explicit' })
    const env: NodeJS.ProcessEnv = { DB_PASSWORD_FILE: join(e, 'pw') }
    const r = loadEnvFiles(env, { secretsDir: d })
    expect(env.DB_PASSWORD).toBe('explicit')
    expect(r.errors).toEqual([])
  })

  it('a missing secrets folder is not an error', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(loadEnvFiles(env, { secretsDir: '/no/such/dir' }).errors).toEqual([])
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_DB_COPY, envDbError } from './env-db-api'

// Ruling P6-32: every code the attach / detach routes answer has plain words here.
const API = join(import.meta.dirname, '../../../../../api/src')

describe('attach / detach refusal copy', () => {
  it('has words for every code the service and the lock-holder refusals answer', () => {
    const found = new Set<string>()
    const service = readFileSync(join(API, 'services/hub/env-database.ts'), 'utf8')
    for (const m of service.matchAll(/(?:EnvDatabaseError\(\s*|code: )'([A-Z][A-Z0-9_]+)'/g))
      found.add(m[1] as string)
    const lock = readFileSync(join(API, 'services/hub/promote-lock.ts'), 'utf8')
    const refusal = lock.slice(lock.indexOf('export function lockHolderRefusal'))
    for (const m of refusal.slice(0, refusal.indexOf('\n}\n')).matchAll(/code: '([A-Z_]+)'/g))
      found.add(m[1] as string)
    expect(found.has('MOVE_OPEN')).toBe(true)
    expect(found.has('DATABASE_BUSY')).toBe(true)
    // NOT_FOUND is the shared 404 copy.
    expect([...found].filter((c) => c !== 'NOT_FOUND' && !ENV_DB_COPY[c])).toEqual([])
    for (const [code, c] of Object.entries(ENV_DB_COPY))
      expect(`${c.title} ${c.hint ?? ''}`, code).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/)
  })

  it('shows the copy, not the server text', () => {
    const d = envDbError(
      { response: { status: 409, data: { code: 'ENGINE_MISMATCH', error: 'raw text' } } },
      'Could not attach the database'
    )
    expect(d.title).toBe('The app runs on another database engine')
  })
})

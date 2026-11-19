import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The SDK's recovery policy (packages/sdk/src/recovery.ts isKeyedWrite) retries a write only
 * where the server deduplicates it by Idempotency-Key. Each of those routes must keep the
 * idempotency preHandler, or an automatic retry could write twice.
 */
const routes = (f: string) => readFileSync(join(import.meta.dirname, '../../../routes', f), 'utf8')

describe('routes the app may retry keep their Idempotency-Key check', () => {
  it('records (/items)', () => {
    expect(routes('items.ts')).toMatch(/addHook\('preHandler', idempotencyPreHandler\('items'\)\)/)
  })
  it('comments and tasks (every write in the plugin)', () => {
    expect(routes('comments.ts')).toMatch(
      /addHook\('preHandler', idempotencyPreHandler\('comments'\)\)/
    )
    expect(routes('tasks.ts')).toMatch(/addHook\('preHandler', idempotencyPreHandler\('tasks'\)\)/)
  })
  it('pipeline and workflow moves', () => {
    expect(routes('pipelines.ts')).toMatch(
      /'\/instance\/:collection\/:item\/transition',[\s\S]{0,300}idempotencyPreHandler\('transition'\)/
    )
    expect(routes('workflows.ts')).toMatch(
      /'\/instance\/:id\/transition',[\s\S]{0,300}idempotencyPreHandler\('transition'\)/
    )
  })
  it('the comment and task hooks run after sign-in (the key is scoped to the caller)', () => {
    for (const f of ['comments.ts', 'tasks.ts']) {
      const s = routes(f)
      expect(s.indexOf("addHook('preHandler', requireAuth)")).toBeGreaterThan(-1)
      expect(s.indexOf("addHook('preHandler', requireAuth)")).toBeLessThan(
        s.indexOf('idempotencyPreHandler(')
      )
    }
  })
})

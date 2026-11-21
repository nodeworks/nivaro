import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({ placementUsing: null as unknown, row: undefined as unknown }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.where = () => chain
    chain.first = () =>
      Promise.resolve(table === 'nivaro_hub_placements' ? dbState.placementUsing : dbState.row)
    chain.del = () => Promise.resolve(1)
    return chain
  })
}))
vi.mock('../../../db/dialect/ef.js', () => ({ insertReturningId: vi.fn(async () => 5) }))

import {
  deleteDriver,
  driverCtx,
  getDriver,
  publicDriver,
  validateDriverInput,
  validatePlacementInput
} from '../../../services/hub/drivers.js'
import { HUB_MASK, sealSecret } from '../../../services/hub/secrets.js'

const KEY = 'b'.repeat(64)
const config = {
  api: 'https://gitlab.example.com/api/v4',
  project: 'grp/repo',
  branch: 'production',
  pin_file: '.docker/nivaro-version',
  deploy_job: 'deploy_production'
}

describe('hub drivers', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    dbState.placementUsing = null
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  it('rejects an unknown kind', () => {
    const r = validateDriverInput({ kind: 'github', name: 'x', config })
    expect(r).toMatchObject({ ok: false, code: 'BAD_KIND' })
  })

  it('requires every config key and a safe URL', () => {
    expect(
      validateDriverInput({ kind: 'gitlab', name: 'x', config: { ...config, project: '' } }).ok
    ).toBe(false)
    expect(
      validateDriverInput({
        kind: 'gitlab',
        name: 'x',
        config: { ...config, api: 'http://evil.com' }
      }).ok
    ).toBe(false)
    expect(
      validateDriverInput({
        kind: 'gitlab',
        name: 'x',
        config: { ...config, api: 'http://localhost:8080/api/v4' }
      }).ok
    ).toBe(true)
    expect(
      validateDriverInput({ kind: 'gitlab', name: 'x', config: { ...config, extra: 'a' } }).ok
    ).toBe(false)
  })

  it('seals the secret and never shows plaintext', () => {
    const r = validateDriverInput({ kind: 'gitlab', name: 'x', config, secret: 'glpat-123' })
    if (!r.ok) throw new Error('expected ok')
    expect(r.row.secret).not.toContain('glpat-123')
    const pub = publicDriver({ id: 1, ...r.row })
    expect(pub.secret).toBe(HUB_MASK)
    expect(JSON.stringify(pub)).not.toContain('glpat-123')
    expect(publicDriver({ id: 1, ...r.row, secret: null }).secret).toBeNull()
  })

  it('a masked secret keeps the stored one; empty clears', () => {
    const stored = sealSecret('glpat-old')
    const existing = { id: 1, kind: 'gitlab' as const, name: 'x', config, secret: stored }
    const keep = validateDriverInput({ secret: HUB_MASK }, existing)
    expect(keep.ok && keep.row.secret).toBe(stored)
    const clear = validateDriverInput({ secret: '' }, existing)
    expect(clear.ok && clear.row.secret).toBeNull()
  })

  it('driverCtx opens the secret and strips /api/v4', () => {
    const ctx = driverCtx({
      id: 1,
      kind: 'gitlab',
      name: 'x',
      config,
      secret: sealSecret('glpat-xyz')
    })
    expect(ctx).toMatchObject({
      provider: 'gitlab',
      base: 'https://gitlab.example.com',
      project: 'grp/repo',
      token: 'glpat-xyz',
      ref: 'production'
    })
  })

  it('validates placements', () => {
    expect(validatePlacementInput({ kind: 'shared', driver_id: 1, target: {} })).toMatchObject({
      ok: false,
      code: 'BAD_KIND'
    })
    expect(validatePlacementInput({ kind: 'dedicated', driver_id: 'a', target: {} }).ok).toBe(false)
    const ok = validatePlacementInput({
      kind: 'dedicated',
      driver_id: 2,
      target: { branch: 'staging' }
    })
    expect(ok).toEqual({
      ok: true,
      row: { kind: 'dedicated', driver_id: 2, target: { branch: 'staging' } }
    })
  })

  it('refuses to delete a driver a placement names', async () => {
    dbState.placementUsing = { id: 9 }
    expect(await deleteDriver(1)).toEqual({ ok: false, code: 'IN_USE' })
    dbState.placementUsing = undefined
    expect(await deleteDriver(1)).toEqual({ ok: true })
  })

  describe('token re-targeting', () => {
    const existing = () => ({
      id: 1,
      kind: 'gitlab' as const,
      name: 'x',
      config,
      secret: sealSecret('glpat-old')
    })
    it('refuses a new host with the mask or no secret', () => {
      const c = { api: 'https://evil.example.com/api/v4' }
      expect(validateDriverInput({ config: c, secret: HUB_MASK }, existing())).toMatchObject({
        ok: false,
        code: 'SECRET_REQUIRED'
      })
    })
    it('refuses a new project with no secret', () => {
      expect(validateDriverInput({ config: { project: 'other/repo' } }, existing())).toMatchObject({
        ok: false,
        code: 'SECRET_REQUIRED'
      })
    })
    it('allows a new host with a new token or a clear', () => {
      const c = { api: 'https://other.example.com/api/v4' }
      expect(validateDriverInput({ config: c, secret: 'glpat-new' }, existing()).ok).toBe(true)
      expect(validateDriverInput({ config: c, secret: '' }, existing()).ok).toBe(true)
    })
    it('rejects a non-string secret', () => {
      for (const bad of [123, true, {}]) {
        expect(
          validateDriverInput(
            { config: { api: 'https://evil.example.com/api/v4' }, secret: bad },
            existing()
          )
        ).toMatchObject({ ok: false, code: 'BAD_SECRET' })
      }
    })
    it('absent secret with a new host needs the token again', () => {
      expect(
        validateDriverInput({ config: { api: 'https://evil.example.com/api/v4' } }, existing())
      ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
    })
    it('absent secret on an unrelated change keeps the token; null clears', () => {
      const e = existing()
      const keep = validateDriverInput({ config: { branch: 'staging' } }, e)
      expect(keep.ok && keep.row.secret).toBe(e.secret)
      const clear = validateDriverInput({ config: { branch: 'staging' }, secret: null }, e)
      expect(clear.ok && clear.row.secret).toBeNull()
    })
    it('keeps the stored token on an unrelated change', () => {
      const e = existing()
      const r = validateDriverInput({ config: { branch: 'staging' }, secret: HUB_MASK }, e)
      expect(r.ok && r.row.secret).toBe(e.secret)
    })
  })

  it('driverCtx refuses a missing api', () => {
    const bad = { id: 1, kind: 'gitlab' as const, name: 'x', config: {} as never, secret: null }
    expect(() => driverCtx(bad)).toThrowError(
      expect.objectContaining({ code: 'DRIVER_MISCONFIGURED' })
    )
  })

  it('stored config that is not a plain object reads as {}', async () => {
    dbState.row = { id: 1, kind: 'gitlab', name: 'x', config: '[1]', secret: null }
    expect((await getDriver(1))?.config).toEqual({})
    dbState.row = { id: 1, kind: 'gitlab', name: 'x', config: 'null', secret: null }
    expect((await getDriver(1))?.config).toEqual({})
    dbState.row = { id: 1, kind: 'gitlab', name: 'x', config: '7', secret: null }
    expect((await getDriver(1))?.config).toEqual({})
  })
})

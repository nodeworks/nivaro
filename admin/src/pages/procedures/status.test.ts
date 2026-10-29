import { describe, expect, it } from 'vitest'
import {
  createRequest,
  deployedVersion,
  dropPath,
  type ManagedInfo,
  type ProcDetail,
  procedureChip,
  procedureState,
  readProcError,
  restoreCopy,
  restoreRequest,
  saveRequest
} from './status'

const managed = (status: Extract<ManagedInfo, { kind: 'managed' }>['status']): ManagedInfo => ({
  kind: 'managed',
  status,
  version: 3,
  owner: null
})

describe('procedureChip', () => {
  it('in sync shows no chip', () => {
    expect(procedureChip({ live: true, managed: managed('in-sync') })).toBeNull()
  })

  it('drifted', () => {
    const c = procedureChip({ live: true, managed: managed('drifted') })
    expect(c).toMatchObject({ label: 'drifted', tone: 'warn' })
    expect(c?.tip).toBe('The database differs from the saved version')
  })

  it('not deployed', () => {
    expect(procedureChip({ live: false, managed: managed('not-deployed') })).toMatchObject({
      label: 'not deployed',
      tone: 'info'
    })
  })

  it('dropped but still live', () => {
    expect(procedureChip({ live: true, managed: managed('dropped-but-live') })).toMatchObject({
      label: 'drop pending',
      tone: 'warn'
    })
  })

  it('dropped', () => {
    expect(procedureChip({ live: false, managed: managed('dropped') })).toMatchObject({
      label: 'dropped',
      tone: 'muted'
    })
  })

  it('conflict', () => {
    const c = procedureChip({ live: true, managed: managed('conflict') })
    expect(c).toMatchObject({ label: 'conflict', tone: 'danger' })
    expect(c?.tip).toBe(
      'An import definition and a managed procedure both claim this name; the import wins'
    )
  })

  it('import-owned names its definition', () => {
    const c = procedureChip({ live: true, managed: { kind: 'import', key: 'po_lines' } })
    expect(c).toMatchObject({ label: 'import', tone: 'info' })
    expect(c?.tip).toBe('Owned by import definition po_lines — edit it there')
  })

  it('unmanaged', () => {
    expect(procedureChip({ live: true, managed: null })).toMatchObject({
      label: 'not managed',
      tone: 'muted'
    })
  })
})

const config = {
  body: 'CREATE OR ALTER PROCEDURE p AS SELECT 2',
  body_hash: 'cfg-hash',
  version: 3,
  deployed_hash: 'cfg-hash',
  deployed_at: '2026-10-28T12:00:00Z',
  deployed_by: 'user:u1',
  dropped_at: null,
  owner: null,
  description: null,
  updated_at: '2026-10-28T12:00:00Z',
  updated_by: 'u1'
}

function detail(over: Partial<ProcDetail> = {}): ProcDetail {
  return {
    name: 'p',
    created: '2026-01-01T00:00:00Z',
    modified: '2026-10-28T12:00:00Z',
    definition: 'CREATE PROCEDURE p AS SELECT 1',
    live_hash: 'live-hash',
    params: [],
    managed: null,
    config: null,
    ...over
  }
}

describe('procedureState', () => {
  it('unmanaged readable proc: edit, drop and adopt, base = live text, adopts on write', () => {
    const s = procedureState(detail())
    expect(s).toMatchObject({
      owner: 'unmanaged',
      live: true,
      readable: true,
      editable: true,
      canDrop: true,
      canAdopt: true,
      canRun: true,
      canReview: true,
      adoptsOnWrite: true,
      base: 'CREATE PROCEDURE p AS SELECT 1'
    })
  })

  it('encrypted unmanaged proc: hash of empty text is still unreadable — nothing but run', () => {
    const s = procedureState(detail({ definition: null, live_hash: 'hash-of-empty' }))
    expect(s).toMatchObject({
      readable: false,
      editable: false,
      canDrop: false,
      canAdopt: false,
      canRun: true,
      canReview: false
    })
    expect(s.reviewOff).toMatch(/encrypted/)
    expect(procedureState(detail({ definition: '' })).readable).toBe(false)
  })

  it('managed proc edits from config, never adopts', () => {
    const s = procedureState(detail({ managed: managed('drifted'), config }))
    expect(s).toMatchObject({
      owner: 'managed',
      status: 'drifted',
      version: 3,
      base: config.body,
      editable: true,
      canDrop: true,
      canAdopt: false,
      adoptsOnWrite: false
    })
  })

  it('managed proc not deployed here: no run, no AI review (it reads live)', () => {
    const s = procedureState(
      detail({
        definition: null,
        live_hash: null,
        created: null,
        modified: null,
        managed: managed('not-deployed'),
        config
      })
    )
    expect(s).toMatchObject({ live: false, editable: true, canRun: false, canReview: false })
    expect(s.reviewOff).toMatch(/isn't on this database/)
  })

  it('dropped proc is read-only and offers restore', () => {
    for (const st of ['dropped', 'dropped-but-live'] as const) {
      const s = procedureState(
        detail({ managed: managed(st), config: { ...config, dropped_at: '2026-10-28T13:00:00Z' } })
      )
      expect(s).toMatchObject({ dropped: true, editable: false, canDrop: false, canAdopt: false })
    }
  })

  it('import-owned and conflict are read-only', () => {
    const imp = procedureState(detail({ managed: { kind: 'import', key: 'po_lines' } }))
    expect(imp).toMatchObject({
      owner: 'import',
      importKey: 'po_lines',
      editable: false,
      canDrop: false,
      canAdopt: false,
      canReview: true
    })
    const con = procedureState(detail({ managed: managed('conflict'), config }))
    expect(con).toMatchObject({ owner: 'conflict', editable: false, canDrop: false })
  })
})

describe('request builders', () => {
  it('managed save sends config base + the live hash it saw', () => {
    const d = detail({ managed: managed('in-sync'), config })
    expect(saveRequest(d, 'X', '  fixed totals ')).toEqual({
      definition: 'X',
      note: 'fixed totals',
      base_hash: 'cfg-hash',
      base_version: 3,
      base_live_hash: 'live-hash'
    })
  })

  it('managed save of a proc not on this database says so (null live hash)', () => {
    const d = detail({
      live_hash: null,
      definition: null,
      managed: managed('not-deployed'),
      config
    })
    expect(saveRequest(d, 'X', '')).toEqual({
      definition: 'X',
      base_hash: 'cfg-hash',
      base_version: 3,
      base_live_hash: null
    })
  })

  it('unmanaged save sends only the live hash (no config base)', () => {
    expect(saveRequest(detail(), 'X', '')).toEqual({ definition: 'X', base_live_hash: 'live-hash' })
  })

  it('overwrite after drift resends with the database hash it was handed', () => {
    const d = detail({ managed: managed('in-sync'), config })
    expect(saveRequest(d, 'X', '', 'newer-live').base_live_hash).toBe('newer-live')
    expect(saveRequest(d, 'X', '', null).base_live_hash).toBeNull()
  })

  it('restore sends the same guards', () => {
    const d = detail({ managed: managed('drifted'), config })
    expect(restoreRequest(d)).toEqual({
      base_hash: 'cfg-hash',
      base_version: 3,
      base_live_hash: 'live-hash'
    })
    expect(restoreRequest(d, 'newer').base_live_hash).toBe('newer')
  })

  it('create is born managed', () => {
    expect(createRequest('CREATE PROCEDURE n AS SELECT 1')).toEqual({
      definition: 'CREATE PROCEDURE n AS SELECT 1',
      create: true
    })
  })

  it('drop carries the version it saw only for a managed proc', () => {
    expect(dropPath(detail({ managed: managed('in-sync'), config }))).toBe(
      '/procedures/p?base_version=3'
    )
    expect(dropPath(detail())).toBe('/procedures/p')
  })
})

describe('deployedVersion', () => {
  const versions = [
    { version: 3, body_hash: 'a', note: '', created_at: '', created_by: null },
    { version: 2, body_hash: 'b', note: '', created_at: '', created_by: null },
    { version: 1, body_hash: 'a', note: '', created_at: '', created_by: null }
  ]
  it('the newest version whose body is what this database has', () => {
    expect(deployedVersion(versions, 'a')).toBe(3)
    expect(deployedVersion(versions, 'b')).toBe(2)
    expect(deployedVersion(versions, null)).toBeNull()
    expect(deployedVersion(versions, 'zzz')).toBeNull()
  })
})

describe('readProcError', () => {
  const axiosErr = (status: number, data: Record<string, unknown>) => ({
    response: { status, data }
  })

  it('drift carries the current live hash', () => {
    expect(
      readProcError(axiosErr(409, { error: 'changed', code: 'PROC_DRIFTED', live_hash: 'h2' }))
    ).toMatchObject({ status: 409, code: 'PROC_DRIFTED', message: 'changed', liveHash: 'h2' })
  })

  it('import refusal carries the definition key', () => {
    expect(
      readProcError(axiosErr(409, { error: 'x', code: 'APP_MANAGED', definition: 'po_lines' }))
    ).toMatchObject({ code: 'APP_MANAGED', importKey: 'po_lines' })
  })

  it('a stamp failure is a warning, not a failure', () => {
    const e = readProcError(axiosErr(500, { error: 'x', code: 'DEPLOY_STAMP_FAILED', version: 4 }))
    expect(e).toMatchObject({ stampOnly: true, version: 4 })
    expect(readProcError(axiosErr(400, { error: 'x', code: 'DEPLOY_FAILED' })).stampOnly).toBe(
      false
    )
  })

  it('create collisions say whether the name was dropped', () => {
    expect(
      readProcError(axiosErr(409, { error: 'x', code: 'PROC_EXISTS', dropped: true }))
    ).toMatchObject({ code: 'PROC_EXISTS', dropped: true })
  })

  it('a network error falls back to the given message', () => {
    expect(readProcError(new Error('boom'), 'Deploy failed')).toMatchObject({
      status: null,
      code: null,
      message: 'Deploy failed'
    })
  })
})

describe('restoreCopy', () => {
  it('says no new version is saved when the text matches the current one', () => {
    expect(restoreCopy({ version: 1, body_hash: 'a' }, 3, 'a', false)).toMatch(
      /same text as version 3, so no new version is saved/
    )
    expect(restoreCopy({ version: 1, body_hash: 'a' }, 3, 'b', false)).toMatch(/saved as version 4/)
    // A dropped proc always gets a new version (it is revived).
    expect(restoreCopy({ version: 3, body_hash: 'a' }, 3, 'a', true)).toMatch(/saved as version 4/)
  })
})

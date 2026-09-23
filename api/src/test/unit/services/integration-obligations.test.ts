import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  clearObligationKinds,
  listObligationKinds,
  openObligationForTrigger,
  recordObligation,
  registerObligationKind,
  resolveApiName,
  resolveKindForTrigger,
  resolveObligation
} from '../../../services/integration-obligations.js'

const base = {
  api: 'Partner',
  collection: 'workflows',
  label: 'x',
  expect: async () => []
}

beforeEach(() => clearObligationKinds())

describe('kind registry', () => {
  it('returns null when nothing is registered — core writes nothing', () => {
    const got = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit'
    })
    expect(got).toBeNull()
  })

  it('matches on api + collection when the kind declares no predicate', () => {
    registerObligationKind({ ...base, kind: 'wf.only' })
    const got = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit'
    })
    expect(got?.kind).toBe('wf.only')
  })

  it('never crosses collections', () => {
    registerObligationKind({ ...base, kind: 'wf.only' })
    const got = resolveKindForTrigger({
      collection: 'inventory_request',
      item: '1',
      api: 'Partner',
      source: 'erp_submit'
    })
    expect(got).toBeNull()
  })

  it('lets a predicate discriminate two kinds on one endpoint', () => {
    registerObligationKind({
      ...base,
      kind: 'wf.state',
      matches: (c) => c.action_context_keys?.includes('legacy_state') === true
    })
    registerObligationKind({
      ...base,
      kind: 'wf.complete',
      matches: (c) => c.action_skip_unless_any?.some((r) => r.includes('ref_id')) === true
    })
    const asState = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit',
      endpoint_path: '/partner-update',
      action_context_keys: ['legacy_state']
    })
    const asComplete = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit',
      endpoint_path: '/partner-update',
      action_skip_unless_any: ['context.partner_link.0.ref_id']
    })
    expect(asState?.kind).toBe('wf.state')
    expect(asComplete?.kind).toBe('wf.complete')
  })

  it('prefers a kind WITH a predicate over a catch-all on the same collection', () => {
    registerObligationKind({ ...base, kind: 'wf.catchall' })
    registerObligationKind({
      ...base,
      kind: 'wf.specific',
      matches: (c) => c.endpoint_path === '/specific'
    })
    const got = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit',
      endpoint_path: '/specific'
    })
    expect(got?.kind).toBe('wf.specific')
  })

  it('re-registering a kind replaces it rather than duplicating', () => {
    registerObligationKind({ ...base, kind: 'wf.one', label: 'first' })
    registerObligationKind({ ...base, kind: 'wf.one', label: 'second' })
    const kinds = listObligationKinds().filter((k) => k.kind === 'wf.one')
    expect(kinds).toHaveLength(1)
    expect(kinds[0].label).toBe('second')
  })

  it('lists kinds without their handlers', () => {
    registerObligationKind({ ...base, kind: 'wf.one' })
    const listed = listObligationKinds()
    expect(listed[0]).not.toHaveProperty('expect')
    expect(listed[0]).not.toHaveProperty('matches')
    expect(listed[0].api).toBe('Partner')
  })
})

// ─── The db-writing surface ────────────────────────────────────────────────
// db is already mocked in src/test/setup.ts — db(table) is a vi.fn() whose
// return value each test overrides with its own fake query chain, mirroring
// the pattern already established in src/test/unit/services/activity.test.ts.

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function mockUpdateChain() {
  const chain: { where: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } = {
    where: vi.fn(),
    update: vi.fn().mockResolvedValue(1)
  }
  chain.where.mockReturnValue(chain)
  return chain
}

describe('recordObligation — row shape', () => {
  afterEach(() => vi.clearAllMocks())

  it('writes every field, coerces item to a string, and pending is not resolved_at', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 9 }])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    const id = await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: 42,
      trigger: 'manual',
      trigger_ref: 'ref-1'
    })

    expect(id).toBe(9)
    const row = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(row.api).toBe('Partner')
    expect(row.kind).toBe('wf.only')
    expect(row.collection).toBe('workflows')
    expect(row.item).toBe('42')
    expect(row.trigger).toBe('manual')
    expect(row.trigger_ref).toBe('ref-1')
    expect(row.outcome).toBe('pending')
    expect(row.reason).toBeNull()
    expect(row.detail).toBeNull()
    expect(row.resolved_at).toBeNull()
    expect(row.due_at).toBeInstanceOf(Date)
    expect(row.created_at).toBeInstanceOf(Date)
  })

  for (const outcome of ['sent', 'skipped', 'superseded'] as const) {
    it(`outcome "${outcome}" sets resolved_at — it closes the obligation`, async () => {
      const insertStub = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }])
      })
      mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

      await recordObligation({
        api: 'Partner',
        kind: 'wf.only',
        collection: 'workflows',
        item: '1',
        trigger: 'manual',
        outcome
      })

      const row = insertStub.mock.calls[0][0] as Record<string, unknown>
      expect(row.resolved_at).toBeInstanceOf(Date)
    })
  }

  for (const outcome of ['failed', 'overdue', 'missing', 'pending'] as const) {
    it(`outcome "${outcome}" leaves resolved_at null — the obligation stays open`, async () => {
      const insertStub = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }])
      })
      mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

      await recordObligation({
        api: 'Partner',
        kind: 'wf.only',
        collection: 'workflows',
        item: '1',
        trigger: 'manual',
        outcome
      })

      const row = insertStub.mock.calls[0][0] as Record<string, unknown>
      expect(row.resolved_at).toBeNull()
    })
  }

  it('truncates trigger_ref to 200 chars and reason to 500 chars', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 1 }])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual',
      trigger_ref: 'x'.repeat(250),
      reason: 'y'.repeat(600)
    })

    const row = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect((row.trigger_ref as string).length).toBe(200)
    expect((row.reason as string).length).toBe(500)
  })

  it('caps a stringified detail at 4000 chars plus a trailing ellipsis, and stores null when detail is omitted', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 1 }])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual',
      detail: { big: 'z'.repeat(5000) }
    })
    const capped = (insertStub.mock.calls[0][0] as Record<string, unknown>).detail as string
    expect(capped.length).toBe(4001)
    expect(capped.endsWith('…')).toBe(true)

    insertStub.mockClear()
    await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual'
    })
    expect((insertStub.mock.calls[0][0] as Record<string, unknown>).detail).toBeNull()
  })

  it('unwraps a tedious-style {id} object returned by .returning', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 55 }])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    const id = await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual'
    })
    expect(id).toBe(55)
  })

  it('unwraps a plain numeric id returned by .returning', async () => {
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([77])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    const id = await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual'
    })
    expect(id).toBe(77)
  })
})

describe('resolveObligation', () => {
  afterEach(() => vi.clearAllMocks())

  it('is a no-op for a null id — the db is never touched', async () => {
    mockedDb().mockClear()
    await resolveObligation(null, { outcome: 'sent' })
    expect(db).not.toHaveBeenCalled()
  })

  it('sets outcome + resolved_at for a closing outcome and omits every optional field the caller did not pass', async () => {
    const chain = mockUpdateChain()
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    await resolveObligation(12, { outcome: 'sent' })

    expect(chain.where).toHaveBeenCalledWith({ id: 12 })
    const row = chain.update.mock.calls[0][0] as Record<string, unknown>
    expect(row.outcome).toBe('sent')
    expect(row.resolved_at).toBeInstanceOf(Date)
    expect(row.reason).toBeNull()
    expect('submission_id' in row).toBe(false)
    expect('signature' in row).toBe(false)
    expect('resolved_by' in row).toBe(false)
    expect('detail' in row).toBe(false)
  })

  it('leaves resolved_at null for a still-open outcome (pending)', async () => {
    const chain = mockUpdateChain()
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)
    await resolveObligation(12, { outcome: 'pending' })
    const row = chain.update.mock.calls[0][0] as Record<string, unknown>
    expect(row.resolved_at).toBeNull()
  })

  for (const outcome of ['failed', 'overdue', 'missing'] as const) {
    it(`leaves resolved_at null for outcome "${outcome}"`, async () => {
      const chain = mockUpdateChain()
      mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)
      await resolveObligation(1, { outcome })
      const row = chain.update.mock.calls[0][0] as Record<string, unknown>
      expect(row.resolved_at).toBeNull()
    })
  }

  for (const outcome of ['skipped', 'superseded'] as const) {
    it(`sets resolved_at for outcome "${outcome}"`, async () => {
      const chain = mockUpdateChain()
      mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)
      await resolveObligation(1, { outcome })
      const row = chain.update.mock.calls[0][0] as Record<string, unknown>
      expect(row.resolved_at).toBeInstanceOf(Date)
    })
  }

  it('includes submission_id, signature (truncated to 64), resolved_by and detail only when the caller passes them — a null submission_id is still written, only "undefined" omits the key', async () => {
    const chain = mockUpdateChain()
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    await resolveObligation(1, {
      outcome: 'sent',
      submission_id: null,
      signature: 'x'.repeat(100),
      resolved_by: 'user-1',
      detail: { ok: true }
    })

    const row = chain.update.mock.calls[0][0] as Record<string, unknown>
    expect('submission_id' in row).toBe(true)
    expect(row.submission_id).toBeNull()
    expect((row.signature as string).length).toBe(64)
    expect(row.resolved_by).toBe('user-1')
    expect(row.detail).toBe(JSON.stringify({ ok: true }))
  })

  it('truncates reason to 500 chars', async () => {
    const chain = mockUpdateChain()
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)
    await resolveObligation(1, { outcome: 'failed', reason: 'z'.repeat(600) })
    const row = chain.update.mock.calls[0][0] as Record<string, unknown>
    expect((row.reason as string).length).toBe(500)
  })

  it('does not read the row back before writing, so it can move an already-sent obligation to a different outcome — there is no guard against re-resolving a closed row', async () => {
    // The fake chain below exposes ONLY where()/update() — if the implementation
    // tried to SELECT/first() the current row before deciding whether to write,
    // that call would throw inside the try/catch and update() would never run.
    const chain = mockUpdateChain()
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    await resolveObligation(1, { outcome: 'sent' })
    await resolveObligation(1, { outcome: 'failed' })

    expect(chain.update).toHaveBeenCalledTimes(2)
    expect((chain.update.mock.calls[0][0] as Record<string, unknown>).outcome).toBe('sent')
    expect((chain.update.mock.calls[1][0] as Record<string, unknown>).outcome).toBe('failed')
  })
})

describe('openObligationForTrigger', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null and never touches the db when no kind claims the context', async () => {
    mockedDb().mockClear()
    const id = await openObligationForTrigger(
      { collection: 'workflows', item: '1', api: 'Partner', source: 'manual' },
      { trigger: 'manual' }
    )
    expect(id).toBeNull()
    expect(db).not.toHaveBeenCalled()
  })

  it('opens a pending obligation attributed to the resolved kind', async () => {
    registerObligationKind({ ...base, kind: 'wf.only' })
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 3 }])
    })
    mockedDb().mockReturnValue({ insert: insertStub } as unknown as ReturnType<typeof db>)

    const id = await openObligationForTrigger(
      { collection: 'workflows', item: '55', api: 'Partner', source: 'erp_submit' },
      { trigger: 'transition', trigger_ref: 'state->done' }
    )

    expect(id).toBe(3)
    const row = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(row.api).toBe('Partner')
    expect(row.kind).toBe('wf.only')
    expect(row.collection).toBe('workflows')
    expect(row.item).toBe('55')
    expect(row.trigger).toBe('transition')
    expect(row.trigger_ref).toBe('state->done')
    expect(row.outcome).toBe('pending')
  })

  it('normalizes a numeric external_api id to its name before matching a kind — the sweep and the registry always compare names', async () => {
    registerObligationKind({ ...base, kind: 'wf.only' })
    const apiChain = { where: vi.fn(), first: vi.fn().mockResolvedValue({ name: 'Partner' }) }
    apiChain.where.mockReturnValue(apiChain)
    const insertStub = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 4 }])
    })
    mockedDb().mockImplementation(((table: string) =>
      table === 'nivaro_external_apis' ? apiChain : { insert: insertStub }) as never)

    // ctx.api is "42" — the numeric id an erp_submit action carries when it
    // was configured by picking the API from a list, not typing its name.
    // Without normalization this matches no kind (api 'Partner' !== '42')
    // and openObligationForTrigger returns null.
    const id = await openObligationForTrigger(
      { collection: 'workflows', item: '9', api: '42', source: 'erp_submit' },
      { trigger: 'transition' }
    )

    expect(id).toBe(4)
    expect(apiChain.where).toHaveBeenCalledWith({ id: 42 })
    const row = insertStub.mock.calls[0][0] as Record<string, unknown>
    expect(row.api).toBe('Partner')
    expect(row.kind).toBe('wf.only')
  })
})

describe('resolveApiName', () => {
  afterEach(() => vi.clearAllMocks())

  it('passes a non-numeric value straight through without touching the db', async () => {
    mockedDb().mockClear()
    const name = await resolveApiName(db, 'Partner')
    expect(name).toBe('Partner')
    expect(db).not.toHaveBeenCalled()
  })

  it("resolves a numeric id to the row's name", async () => {
    const chain = { where: vi.fn(), first: vi.fn().mockResolvedValue({ name: 'Fusion IIP' }) }
    chain.where.mockReturnValue(chain)
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    const name = await resolveApiName(db, '9101')
    expect(name).toBe('Fusion IIP')
    expect(chain.where).toHaveBeenCalledWith({ id: 9101 })
  })

  it('falls back to the id string itself when no row matches', async () => {
    const chain = { where: vi.fn(), first: vi.fn().mockResolvedValue(undefined) }
    chain.where.mockReturnValue(chain)
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    const name = await resolveApiName(db, '9102')
    expect(name).toBe('9102')
  })

  it('falls back to the id string when the lookup throws', async () => {
    const chain = { where: vi.fn(), first: vi.fn().mockRejectedValue(new Error('down')) }
    chain.where.mockReturnValue(chain)
    mockedDb().mockReturnValue(chain as unknown as ReturnType<typeof db>)

    const name = await resolveApiName(db, '9103')
    expect(name).toBe('9103')
  })
})

describe('never throws — warnOnce', () => {
  afterEach(() => vi.clearAllMocks())

  it('recordObligation and resolveObligation both swallow a db failure without throwing, and warn only once across both failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failingChain: {
      insert: ReturnType<typeof vi.fn>
      where: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    } = {
      insert: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('connection lost'))
      }),
      where: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error('connection lost'))
    }
    failingChain.where.mockReturnValue(failingChain)
    mockedDb().mockReturnValue(failingChain as unknown as ReturnType<typeof db>)

    const id = await recordObligation({
      api: 'Partner',
      kind: 'wf.only',
      collection: 'workflows',
      item: '1',
      trigger: 'manual'
    })
    expect(id).toBeNull()

    await expect(resolveObligation(1, { outcome: 'sent' })).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
})

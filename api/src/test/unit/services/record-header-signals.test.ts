import { afterEach, describe, expect, it, vi } from 'vitest'

const raw = vi.hoisted(() => vi.fn())
vi.mock('../../../db/index.js', () => ({ db: { raw } }))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))

import {
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import {
  bustRecordHeaderSignals,
  collectionHasPartnerIntegration,
  ownerSetupFor
} from '../../../services/record-header-signals.js'

afterEach(() => {
  raw.mockReset()
  bustRecordHeaderSignals()
  clearObligationKinds()
})

describe('ownerSetupFor — the header Owners tile (Rob 2026-11-13)', () => {
  it('is set up when the template has owner groups or dimensions', async () => {
    raw.mockResolvedValueOnce([{ has_setup: 1 }])
    expect(await ownerSetupFor({ template: 'T1', instanceId: 'I1' })).toBe(true)
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('is set up by an owner fallback field without asking the database', async () => {
    expect(await ownerSetupFor({ template: 'T1', fallbackField: 'requester' })).toBe(true)
    expect(raw).not.toHaveBeenCalled()
  })

  it('is set up when someone added an owner to this record by hand', async () => {
    raw.mockResolvedValueOnce([{ has_setup: 0 }]).mockResolvedValueOnce([{ manual: 1 }])
    expect(await ownerSetupFor({ template: 'T1', instanceId: 'I1' })).toBe(true)
  })

  it('has none when the template has no owner setup and nobody was added', async () => {
    raw.mockResolvedValueOnce([{ has_setup: 0 }]).mockResolvedValueOnce([])
    expect(await ownerSetupFor({ template: 'T1', instanceId: 'I1' })).toBe(false)
  })

  it('remembers the template answer (one read per template, not per record)', async () => {
    raw.mockResolvedValue([{ has_setup: 1 }])
    await ownerSetupFor({ template: 'T1', instanceId: 'I1' })
    await ownerSetupFor({ template: 'T1', instanceId: 'I2' })
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('reads as set up when the check fails (the tile is the default)', async () => {
    raw.mockRejectedValueOnce(new Error('boom'))
    expect(await ownerSetupFor({ template: 'T1' })).toBe(true)
  })
})

describe('collectionHasPartnerIntegration — the header External requests chip', () => {
  it('a registered obligation kind for the collection is enough', async () => {
    registerObligationKind({
      api: 'Fusion',
      kind: 'po',
      collection: 'workflows',
      label: 'PO'
    } as never)
    expect(await collectionHasPartnerIntegration('workflows')).toBe(true)
    expect(raw).not.toHaveBeenCalled()
  })

  it('a transition that pushes to a partner (erp_submit) counts', async () => {
    raw.mockResolvedValueOnce([
      { actions: '[{"type":"notify"}]' },
      { actions: '[{"type":"erp_submit","external_api":3}]' }
    ])
    expect(await collectionHasPartnerIntegration('workflows')).toBe(true)
  })

  it('a LIKE match that is not really an erp_submit action does not', async () => {
    raw.mockResolvedValueOnce([{ actions: '[{"type":"notify","note":"erp_submit later"}]' }])
    expect(await collectionHasPartnerIntegration('breakers')).toBe(false)
  })

  it('nothing at all: no integration, and the answer is remembered', async () => {
    raw.mockResolvedValue([])
    expect(await collectionHasPartnerIntegration('breakers')).toBe(false)
    expect(await collectionHasPartnerIntegration('breakers')).toBe(false)
    expect(raw).toHaveBeenCalledTimes(1)
  })
})

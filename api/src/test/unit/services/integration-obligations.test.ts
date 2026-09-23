import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearObligationKinds,
  listObligationKinds,
  registerObligationKind,
  resolveKindForTrigger
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
      matches: (c) => c.action_skip_unless_any?.some((r) => r.includes('mwf_id')) === true
    })
    const asState = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit',
      endpoint_path: '/update_workflow.php',
      action_context_keys: ['legacy_state']
    })
    const asComplete = resolveKindForTrigger({
      collection: 'workflows',
      item: '1',
      api: 'Partner',
      source: 'erp_submit',
      endpoint_path: '/update_workflow.php',
      action_skip_unless_any: ['context.mwf_link.0.mwf_id']
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

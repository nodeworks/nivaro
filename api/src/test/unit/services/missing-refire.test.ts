import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearObligationKinds,
  getObligationKind,
  registerObligationKind
} from '../../../services/integration-obligations.js'

beforeEach(() => clearObligationKinds())

describe('which missing obligations may be re-fired', () => {
  const base = { api: 'Partner', collection: 'workflows', label: 'x', expect: async () => [] }

  it('a kind that declares itself unsafe is queued for a person, never re-fired', () => {
    registerObligationKind({ ...base, kind: 'inbound', safe_to_refire: false })
    expect(getObligationKind('Partner', 'inbound')?.safe_to_refire).toBe(false)
  })

  it('a kind that says nothing is eligible — the default is to try once', () => {
    registerObligationKind({ ...base, kind: 'outbound' })
    expect(getObligationKind('Partner', 'outbound')?.safe_to_refire).toBeUndefined()
  })

  it('an unregistered kind resolves to nothing, so the pass treats it as eligible', () => {
    expect(getObligationKind('Partner', 'gone')).toBeUndefined()
  })
})

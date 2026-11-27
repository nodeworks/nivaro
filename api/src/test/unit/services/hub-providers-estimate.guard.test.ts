import { describe, expect, it } from 'vitest'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'
import { missingEstimates } from '../../../services/hub/providers/pricing/index.js'

// Hub providers Task 44a (Rob, 2026-11-26): every resource type that has a `costClass` implements
// `estimate()` (a type with no costClass costs nothing by contract). The temporary Wave 1
// allow-list is empty since Task 44b shipped every estimate; a Wave 2 or 3 type is never added
// here: it ships its estimate. A stale entry (the type now has an estimate, or is gone) fails too.

const WAVE_1_WITHOUT_ESTIMATE = new Set<string>()

describe('cost estimates of the core provider types', () => {
  it('every costed type has an estimate, outside the Wave 1 allow-list', () => {
    expect(
      missingEstimates(CORE_PROVIDERS, WAVE_1_WITHOUT_ESTIMATE),
      'a costed type needs estimate(ctx, desired, observed) → CostEstimate (providers/types.ts)'
    ).toEqual([])
  })

  it('the allow-list holds only types that still lack one (Task 44b empties it)', () => {
    const missing = new Set(missingEstimates(CORE_PROVIDERS))
    const stale = [...WAVE_1_WITHOUT_ESTIMATE].filter((k) => !missing.has(k))
    expect(stale, 'remove these from WAVE_1_WITHOUT_ESTIMATE').toEqual([])
    for (const k of WAVE_1_WITHOUT_ESTIMATE) expect(k).toMatch(/^(aws|vercel|auth0|expo|github)\./)
  })
})

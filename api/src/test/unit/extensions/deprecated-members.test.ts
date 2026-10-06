import { describe, expect, it } from 'vitest'
import {
  deprecatedMembersReadiness,
  deprecatedMemberUses,
  describeDeprecatedUses,
  withDeprecationWarnings
} from '../../../extensions/loader.js'

/** The kit deprecates nothing today, so the loader is proven against a fake
 *  deprecation: first use logs once, every use counts, the registry sheet and
 *  the readiness check read the same record (#1303). */
describe('deprecated kit members (#1303)', () => {
  const fake = [
    {
      member: 'storage.setActive',
      replacement: 'storage.register(name, adapter, { active: true })',
      removedIn: '0.3.0'
    }
  ]

  it('warns on the first use per extension and counts the rest', () => {
    const warnings: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => warnings.push(args) }
    const ctx = withDeprecationWarnings(
      'acme',
      { storage: { setActive: (n: string) => `active ${n}`, register: () => 'ok' } },
      logger,
      fake
    )
    expect(ctx.storage.register()).toBe('ok')
    expect(describeDeprecatedUses('acme')).toEqual([])
    expect(ctx.storage.setActive('s3')).toBe('active s3')
    ctx.storage.setActive('blob')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][1])).toContain('acme uses ctx.storage.setActive')
    const uses = describeDeprecatedUses('acme')
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({ member: 'storage.setActive', removed_in: '0.3.0', uses: 2 })
    expect(deprecatedMembersReadiness(1)).toMatchObject({
      status: 'warn',
      blockers: [expect.stringContaining('leaves the kit in 0.3.0')]
    })
    // a reload starts the record again
    withDeprecationWarnings('acme', {}, logger, fake)
    expect(describeDeprecatedUses('acme')).toEqual([])
    deprecatedMemberUses.clear()
  })

  it('skips the check when nothing is deprecated, passes when nothing is used', () => {
    deprecatedMemberUses.clear()
    expect(deprecatedMembersReadiness(0).status).toBe('skip')
    expect(deprecatedMembersReadiness(2).status).toBe('pass')
  })

  it('hands back the context untouched with the real (empty) registry', () => {
    const ctx = { storage: { setActive: () => 1 } }
    expect(withDeprecationWarnings('acme', ctx)).toBe(ctx)
  })
})

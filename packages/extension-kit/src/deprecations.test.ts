import { describe, expect, it } from 'vitest'
import {
  deprecationMessage,
  KIT_DEPRECATIONS,
  type KitDeprecation,
  watchDeprecatedMembers
} from './deprecations.js'

const fake: KitDeprecation = {
  member: 'storage.setActive',
  replacement: 'storage.register(name, adapter, { active: true })',
  removedIn: '0.3.0'
}

function makeCtx() {
  const shared = { tag: 'shared', fn: () => 'shared-fn' }
  return {
    shared,
    storage: {
      register: (name: string) => `registered ${name}`,
      setActive: (name: string) => `active ${name}`
    },
    hooks: { before: () => 'before' }
  }
}

describe('watchDeprecatedMembers (#1303)', () => {
  it('ships an empty registry — nothing is deprecated today', () => {
    expect(KIT_DEPRECATIONS).toEqual([])
  })

  it('returns the same context when nothing is deprecated', () => {
    const ctx = makeCtx()
    expect(watchDeprecatedMembers(ctx, [], () => {})).toBe(ctx)
  })

  it('reports a use of the deprecated member and still answers what it held', () => {
    const uses: string[] = []
    const ctx = watchDeprecatedMembers(makeCtx(), [fake], (d) => uses.push(d.member))
    expect(ctx.storage.register('s3')).toBe('registered s3')
    expect(uses).toEqual([])
    expect(ctx.storage.setActive('s3')).toBe('active s3')
    expect(ctx.storage.setActive('blob')).toBe('active blob')
    expect(uses).toEqual(['storage.setActive', 'storage.setActive'])
    expect(ctx.hooks.before()).toBe('before')
  })

  it('never mutates the objects it wraps', () => {
    const raw = makeCtx()
    const sharedBefore = raw.shared
    const ctx = watchDeprecatedMembers(
      raw,
      [{ member: 'shared.fn', replacement: 'x', removedIn: '1.0.0' }],
      () => {}
    )
    expect(ctx.shared.fn()).toBe('shared-fn')
    expect(raw.shared).toBe(sharedBefore)
    expect(Object.keys(raw.shared)).toEqual(['tag', 'fn'])
  })

  it('wraps a top-level member and skips one the context does not have', () => {
    const uses: string[] = []
    const ctx = watchDeprecatedMembers(
      makeCtx() as Record<string, unknown>,
      [
        { member: 'hooks', replacement: 'events', removedIn: '1.0.0' },
        { member: 'nothing.here', replacement: 'x', removedIn: '1.0.0' }
      ],
      (d) => uses.push(d.member)
    )
    void ctx.hooks
    void ctx.nothing
    expect(uses).toEqual(['hooks'])
  })

  it('words the warning with the replacement and the version', () => {
    expect(deprecationMessage('acme', fake)).toBe(
      'acme uses ctx.storage.setActive, which is deprecated — use storage.register(name, adapter, { active: true }); it leaves the kit in 0.3.0.'
    )
  })
})

describe('createTestContext watches deprecated members', () => {
  it('records a read of a deprecated member in calls.deprecations', async () => {
    const { createTestContext } = await import('./testing.js')
    const ctx = createTestContext({
      deprecations: [{ member: 'storage.setActive', replacement: 'x', removedIn: '9.0.0' }]
    })
    expect(ctx.calls.deprecations).toEqual([])
    ctx.storage.setActive('s3')
    expect(ctx.calls.deprecations).toEqual([
      'extension uses ctx.storage.setActive, which is deprecated — use x; it leaves the kit in 9.0.0.'
    ])
    expect(createTestContext().calls.deprecations).toEqual([])
  })
})

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveNotificationTargetFor } from './notification-target'

describe('external notification targets (army 11)', () => {
  const routes = { record: () => null } as never
  it('a link into this same app navigates in place', () => {
    const url = `${window.location.origin}/data-integrity?tab=people`
    expect(
      resolveNotificationTargetFor({ target: { kind: 'external', url } } as never, routes)
    ).toEqual({
      type: 'path',
      path: '/data-integrity?tab=people'
    })
  })
  it('another host still opens outside', () => {
    expect(
      resolveNotificationTargetFor(
        { target: { kind: 'external', url: 'https://admin.example.com/x' } } as never,
        routes
      )
    ).toEqual({ type: 'external', url: 'https://admin.example.com/x' })
  })
})

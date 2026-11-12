import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => ({}) }) }))

const { PUSH_ICON_CATEGORIES, pushBody, pushIconKey } = await import(
  '../../../services/web-push.js'
)

// 2026-11-12: every browser notification showed a bare Chrome logo — the
// service worker pointed `icon` at /favicon.svg, which Chrome never draws.
describe('browser notification payload', () => {
  it('picks the category icon with a lane suffix', () => {
    expect(pushIconKey('sla', 'needs_you')).toBe('sla-needs')
    expect(pushIconKey('workflow', 'fyi')).toBe('workflow')
    expect(pushIconKey('system', 'critical')).toBe('system-critical')
    expect(pushIconKey('audit', null)).toBe('security')
    expect(pushIconKey('inventory', 'fyi')).toBe('default')
    expect(pushIconKey(null)).toBe('default')
  })

  it('every icon key has a PNG in both apps', () => {
    const root = join(__dirname, '../../../../..')
    for (const app of ['admin/public/push', '../efp-new/public/push']) {
      const dir = join(root, app)
      if (!existsSync(dir)) continue // efp-new is a sibling checkout, not always present
      for (const c of ['default', ...PUSH_ICON_CATEGORIES])
        for (const s of ['', '-needs', '-critical'])
          expect(existsSync(join(dir, `${c}${s}.png`)), `${app}/${c}${s}.png`).toBe(true)
      expect(existsSync(join(dir, 'badge.png'))).toBe(true)
    }
  })

  it('a record notification carries its row, time and a per-record tag', () => {
    const body = JSON.parse(
      pushBody({
        title: 'Approval requested',
        body: 'PO 4471 waits for you',
        url: '/collections/workflows/12',
        id: 88,
        category: 'approvals',
        lane: 'needs_you',
        at: '2026-11-12T16:09:00.000Z',
        collection: 'workflows',
        item: 12
      })
    )
    expect(body).toMatchObject({
      id: 88,
      icon: 'approvals-needs',
      lane: 'needs_you',
      at: '2026-11-12T16:09:00.000Z',
      tag: 'rec-workflows-12'
    })
  })

  it('chat and chaos pushes get their icons without a category', () => {
    expect(JSON.parse(pushBody({ title: 'Ann', body: 'hi', room: 'dm:a:b' })).icon).toBe('chat')
    expect(JSON.parse(pushBody({ title: 'Drill', body: 'x', stop_token: 't' })).icon).toBe('chaos')
  })

  it('an explicit tag wins; a row with no record is tagged by its id', () => {
    expect(JSON.parse(pushBody({ title: 'a', body: '', tag: 'chat-r', id: 1 })).tag).toBe('chat-r')
    expect(JSON.parse(pushBody({ title: 'a', body: '', id: 5 })).tag).toBe('n-5')
    expect(JSON.parse(pushBody({ title: 'a', body: '' })).tag).toBeNull()
  })
})

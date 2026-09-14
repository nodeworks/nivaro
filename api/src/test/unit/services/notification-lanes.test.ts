import { describe, expect, it } from 'vitest'
import { laneFromRow, notificationRowMeta } from '../../../services/notification-channels.js'
import { actionsFor } from '../../../services/notification-target.js'

describe('laneFromRow', () => {
  it('critical subjects win over everything', () => {
    expect(laneFromRow({ subject: 'SLA escalation (tier 2): X', kind: 'record' })).toBe('critical')
    expect(laneFromRow({ subject: 'Maintenance window starts', category: 'system' })).toBe(
      'critical'
    )
  })
  it('acting kinds and non-open actions need you', () => {
    expect(laneFromRow({ subject: 'x', kind: 'task' })).toBe('needs_you')
    expect(laneFromRow({ subject: 'x', kind: 'approval' })).toBe('needs_you')
    expect(laneFromRow({ subject: 'x', kind: 'record', action: 'reply' })).toBe('needs_you')
    expect(laneFromRow({ subject: 'Robert mentioned you', kind: 'record' })).toBe('needs_you')
  })
  it('legacy subjects: task assigned / approval requested / access', () => {
    expect(laneFromRow({ subject: 'Task assigned: fix it' })).toBe('needs_you')
    expect(laneFromRow({ subject: 'Approval requested: CR26' })).toBe('needs_you')
    expect(laneFromRow({ subject: 'Beth requested access to workflows/1' })).toBe('needs_you')
  })
  it('everything else is FYI', () => {
    expect(laneFromRow({ subject: 'Report "Budget" is ready', kind: 'report' })).toBe('fyi')
    expect(laneFromRow({ subject: 'Welcome!', category: 'system' })).toBe('fyi')
  })
  it('notificationRowMeta stamps category, lane and an in-app delivery record', () => {
    const m = notificationRowMeta({ subject: 'Watching CR26: updated', category: 'watch' })
    expect(m.category).toBe('watch')
    expect(m.lane).toBe('fyi')
    expect(JSON.parse(m.delivery)).toEqual({ inapp: { status: 'delivered' } })
  })
})

describe('actionsFor reply actions', () => {
  it('chat rooms reply into the room', () => {
    const a = actionsFor({ kind: 'chat', room: 'dm:A:B', action: 'reply' })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({
      key: 'reply',
      endpoint: '/chat/messages',
      body: { room: 'dm:A:B' },
      input: { field: 'message' },
      mark_read: true
    })
  })
  it('a mention on a record replies on the record thread', () => {
    const a = actionsFor(
      { kind: 'record', collection: 'workflows', id: '1', action: 'reply' },
      { category: 'mentions' }
    )
    expect(a[0]).toMatchObject({
      key: 'reply',
      endpoint: '/comments',
      body: { collection: 'workflows', item: '1' },
      input: { field: 'text' }
    })
  })
  it('a workflow transition offers "comment on this" (never marks read)', () => {
    const a = actionsFor(
      { kind: 'record', collection: 'workflows', id: '1', action: 'open' },
      { category: 'workflow' }
    )
    expect(a[0]).toMatchObject({ label: 'Comment on this', mark_read: false })
  })
  it('system collections and plain FYI rows get nothing', () => {
    expect(
      actionsFor({ kind: 'record', collection: 'nivaro_issues', id: '1' }, { category: 'mentions' })
    ).toEqual([])
    expect(actionsFor({ kind: 'report', id: '9' }, { category: 'reports' })).toEqual([])
  })
  it('task rows keep their one-click complete alongside', () => {
    const a = actionsFor(
      { kind: 'record', collection: 'workflows', id: '1', task_id: 7, action: 'complete' },
      { category: 'workflow' }
    )
    expect(a.map((x) => x.key).sort()).toEqual(['complete', 'reply'])
  })
})

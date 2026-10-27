import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ menu: [] as Array<{ id: string; in_row_menu: unknown }> }))

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ select: async () => h.menu }) })
}))
vi.mock('../../../services/users.js', () => ({
  getUser: async () => ({ id: 'u1', role: 'r' })
}))
vi.mock('../../../services/instance-guard.js', () => ({ instanceAccessAllowed: async () => true }))
vi.mock('../../../services/permissions.js', () => ({ isAdminRole: async () => false }))
vi.mock('../../../services/queues.js', () => ({ getLabels: async () => ({}) }))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: async () => ({
    id: 'i1',
    collection: 'orders',
    item: '7',
    template: 'tpl',
    current_state: 's1'
  })
}))
vi.mock('../../../services/pipeline-outline-load.js', () => ({
  loadPipelineOutline: async () => ({
    states: [{ id: 's1', label: 'Open' }],
    transitions: [
      { id: 'a', label: 'Fast', from_state: 's1', require_owner: false },
      { id: 'b', label: 'Form only', from_state: 's1', require_owner: false }
    ]
  })
}))

import { buildTeamsNotificationCard } from '../../../services/teams-bot/notification-card.js'

const input = {
  userId: 'u1',
  notificationId: 1,
  subject: 's',
  message: 'm',
  category: 'workflow' as never,
  collection: 'orders',
  item: '7',
  target: { kind: 'record', collection: 'orders', id: '7', action: 'open' } as never,
  openUrl: 'https://n.test/orders/7'
}

describe('buildTeamsNotificationCard', () => {
  it('card omits transitions with in_row_menu false', async () => {
    h.menu = [
      { id: 'a', in_row_menu: 1 },
      { id: 'b', in_row_menu: 0 }
    ]
    const json = JSON.stringify(await buildTeamsNotificationCard(input))
    expect(json).toContain('Fast')
    expect(json).not.toContain('Form only')
  })
})

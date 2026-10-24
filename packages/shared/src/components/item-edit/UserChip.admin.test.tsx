import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: () => {}, isPending: false })
}))
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useOptionalNivaroClient: () => ({})
}))

import { reloadPushedText, signedOutText } from '../profile/session-actions'
import { UserCardAdminRow } from './UserChip'

describe('user card admin row', () => {
  it('offers Reload tabs and Sign out, the sign-out unarmed until clicked', () => {
    const html = renderToStaticMarkup(
      createElement(UserCardAdminRow, { userId: 'u1', name: 'Jane Roe' })
    )
    expect(html).toContain('data-user-card-admin')
    expect(html).toContain('data-user-card-reload')
    expect(html).toContain('>Reload tabs<')
    expect(html).toContain('data-user-card-sign-out=""')
    expect(html).toContain('>Sign out<')
  })
})

describe('session action wording', () => {
  it('says what a reload reached', () => {
    expect(reloadPushedText({ sockets: 2, nodes: 3 })).toBe('Reload pushed to 2 open tabs.')
    expect(reloadPushedText({ sockets: 0, nodes: 3, remembered: true, remember_hours: 24 })).toBe(
      'Reload sent — they have no tab open right now. Tabs that connect in the next 24 h reload too.'
    )
    expect(reloadPushedText({ sockets: 1, partial: true })).toMatch(/another server did not answer/)
  })

  it('says how many sessions ended', () => {
    expect(signedOutText('Jane Roe', 3)).toBe(
      'Jane Roe is signed out of 3 sessions — every open tab goes back to sign-in.'
    )
    expect(signedOutText('Jane Roe', 0)).toBe('Jane Roe had no session open.')
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../UserAvatar', () => ({
  UserAvatar: ({ fallback }: { fallback: React.ReactNode }) => fallback
}))

const { OwnerAvatars, ownerText } = await import('./OwnerAvatars')

// Army 8 b08-N4: a "No Owners" row named a suspended person with nothing
// saying why he does not count.
describe('OwnerAvatars inactive owners', () => {
  it('names why an owner cannot act', () => {
    expect(ownerText({ id: '1', name: 'Joseph Paolillo', inactive: 'suspended' })).toBe(
      'Joseph Paolillo (suspended)'
    )
    expect(ownerText({ id: '2', name: 'Ann Lee' })).toBe('Ann Lee')
  })
  it('tags the row and its accessible name', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <OwnerAvatars owners={[{ id: '1', name: 'Joseph Paolillo', inactive: 'suspended' }]} />
      )
    })
    expect(container.querySelector('[data-owner-inactive="suspended"]')?.textContent).toBe(
      'suspended'
    )
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      '1 owner: Joseph Paolillo (suspended)'
    )
  })
})

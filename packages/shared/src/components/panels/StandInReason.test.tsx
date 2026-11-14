// @vitest-environment jsdom

import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { UserRosterCluster } from '../item-edit/UserChip'
import { type StandInReason, StandInReasonLines, standInIds } from './StandInReason'

// Rob 2026-11-14 (CR26INV-36126): a stand-in owner is said plainly — why
// nobody is assigned, why this person stands in, and (admins) what fixes it.

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (ui: React.ReactNode) => act(() => root.render(ui))

const reason = (over: Partial<StandInReason> = {}): StandInReason => ({
  state: { id: 'S-ENG', label: 'Engineering Review' },
  people: [{ id: 'u-nathan', name: 'Nathan Winger' }],
  why_unassigned: {
    kind: 'uncovered',
    sentence:
      'No owner group covers Zone 3, Region CRAN or Project Type PNR for Engineering Review.',
    values: [
      { label: 'Division', value: 'Zone 3' },
      { label: 'Region', value: 'CRAN' },
      { label: 'Project Type', value: 'PNR' }
    ]
  },
  why_this_person: {
    kind: 'creator',
    sentence: 'Nathan Winger stands in as the person who created this record.'
  },
  ...over
})

describe('StandInReasonLines', () => {
  it('says why nobody is assigned and why this person stands in, with no admin link', () => {
    const html = renderToStaticMarkup(<StandInReasonLines reason={reason()} />)
    expect(html).toContain(
      'No owner group covers Zone 3, Region CRAN or Project Type PNR for Engineering Review.'
    )
    expect(html).toContain('Nathan Winger stands in as the person who created this record.')
    // The labelled values ride as an instant tooltip (data-tip, never title).
    expect(html).toContain('data-tip="Division: Zone 3 · Region: CRAN · Project Type: PNR"')
    expect(html).not.toContain('Open owner matrix')
    expect(html).not.toContain('title=')
  })

  it('administrators get the closest group and a link to the owner matrix through consoleUrl', () => {
    const went: string[] = []
    render(
      <NavigationContext.Provider
        value={{ navigate: (p) => went.push(p), consoleUrl: (p) => `/admin${p}` }}
      >
        <StandInReasonLines
          reason={reason({
            detail: 'Closest group: “East CRAN”, which wants Division Zone 1.',
            matrix_href: '/pipelines/T1#owner-matrix'
          })}
        />
      </NavigationContext.Provider>
    )
    expect(host.textContent).toContain('Closest group: “East CRAN”, which wants Division Zone 1.')
    const link = host.querySelector('a[data-stand-in-matrix]') as HTMLAnchorElement
    expect(link.textContent).toContain('Open owner matrix')
    expect(link.getAttribute('href')).toBe('/admin/pipelines/T1#owner-matrix')
    act(() => link.click())
    expect(went).toEqual(['/admin/pipelines/T1#owner-matrix'])
  })

  it('standInIds compares ids case-blind', () => {
    expect(standInIds(reason()).has('U-NATHAN')).toBe(true)
    expect(standInIds(null).size).toBe(0)
  })
})

describe('UserRosterCluster (header Owners tile)', () => {
  const client = {
    url: '',
    getToken: () => null,
    request: async () => ({ data: null })
  } as unknown as NivaroClient
  const wrap = (ui: React.ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>
      <NivaroProvider client={client}>{ui}</NivaroProvider>
    </QueryClientProvider>
  )

  it('marks the stand-in beside the name, and only the stand-in', () => {
    const marked = renderToStaticMarkup(
      wrap(
        <UserRosterCluster
          users={[{ id: 'u-nathan', name: 'Nathan Winger' }]}
          nameLabel
          standIn={reason()}
        />
      )
    )
    expect(marked).toContain('data-stand-in-mark')
    expect(marked).toContain('stand-in')
    const plain = renderToStaticMarkup(
      wrap(
        <UserRosterCluster
          users={[{ id: 'u-kim', name: 'Kim Lee' }]}
          nameLabel
          standIn={reason()}
        />
      )
    )
    expect(plain).not.toContain('data-stand-in-mark')
  })

  it('the roster popover says why', () => {
    render(
      wrap(
        <UserRosterCluster
          users={[{ id: 'u-nathan', name: 'Nathan Winger' }]}
          nameLabel
          standIn={reason()}
        />
      )
    )
    const anchor = host.querySelector('[data-roster-label]')?.parentElement as HTMLElement
    act(() => anchor.click())
    const text = document.body.textContent ?? ''
    expect(text).toContain(
      'No owner group covers Zone 3, Region CRAN or Project Type PNR for Engineering Review.'
    )
    expect(text).toContain('Nathan Winger stands in as the person who created this record.')
    expect(text).not.toContain('Open owner matrix')
  })
})

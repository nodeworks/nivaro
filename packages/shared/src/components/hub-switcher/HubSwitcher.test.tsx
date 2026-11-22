// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HubSwitcherView, isSafeSwitcherLink } from './HubSwitcher'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app = (o: Record<string, unknown>) => ({
  app_key: 'a',
  app_name: 'App A',
  environment_key: 'production',
  url: 'https://a.example.com/',
  signin_url: 'https://a.example.com/api/auth/login?returnTo=%2F',
  current: false,
  ...o
})

const hosts: HTMLElement[] = []
function render(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  act(() => createRoot(host).render(el))
  return host
}
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove()
  document.body.innerHTML = ''
})

describe('HubSwitcherView', () => {
  it('links other apps with rel noopener noreferrer and no link for the current app', () => {
    render(
      <HubSwitcherView
        unavailable={false}
        defaultOpen
        apps={[
          app({ app_key: 'me', app_name: 'This app', current: true }),
          app({ app_key: 'b', app_name: 'Other', environment_key: 'staging' })
        ]}
      />
    )
    const links = [...document.querySelectorAll('a')]
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(document.body.textContent).toContain('This app')
    expect(document.body.textContent).toContain('staging')
  })
  it('renders no unsafe link', () => {
    render(
      <HubSwitcherView
        unavailable={false}
        defaultOpen
        apps={[
          app({ signin_url: 'javascript:alert(1)' }),
          app({ app_key: 'c', signin_url: 'http://remote.example.com/x' })
        ]}
      />
    )
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })
  it('renders nothing for an empty list, a note when unavailable', () => {
    const h = render(<HubSwitcherView apps={[]} unavailable={false} />)
    expect(h.innerHTML).toBe('')
    render(<HubSwitcherView apps={[]} unavailable defaultOpen />)
    expect(document.body.textContent).toContain('The app list is not available right now.')
  })
  it('only https or loopback http links are safe', () => {
    expect(isSafeSwitcherLink('https://x.example.com/')).toBe(true)
    expect(isSafeSwitcherLink('http://localhost:3000/')).toBe(true)
    expect(isSafeSwitcherLink('http://x.example.com/')).toBe(false)
    expect(isSafeSwitcherLink('data:text/html,hi')).toBe(false)
  })
})

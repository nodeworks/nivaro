// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiMarkdown, mirroredMarkdown, parseAiMarkdown } from './AiMarkdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (content: string, mirrored: boolean) =>
  act(() => {
    root.render(<AiMarkdown content={content} autolink={false} mirrored={mirrored} />)
  })

describe('text mirrored in from GitLab (`mirrored`)', () => {
  it('never makes an in-app link: a relative link reads as its label only', async () => {
    await render('See [the admin page](/users/1) and [docs](https://gitlab.example.com/a)', true)
    expect(host.querySelector('[data-ai-link="in-app"]')).toBeNull()
    expect(host.querySelector('a[href="/users/1"]')).toBeNull()
    expect(host.textContent).toContain('the admin page')
    // an absolute link still opens outside, in a new tab
    const out = host.querySelector<HTMLAnchorElement>('a[href="https://gitlab.example.com/a"]')
    expect(out?.target).toBe('_blank')
  })

  it('without `mirrored` the same path is an in-app link (unchanged for Ask AI)', async () => {
    await render('See [the admin page](/users/1)', false)
    expect(host.querySelector('[data-ai-link="in-app"]')).not.toBeNull()
  })

  it('an image reads as a link to the image, never "!" plus a link', async () => {
    await render('Shot: ![screen](https://gitlab.example.com/uploads/ab/x.png)', true)
    const a = host.querySelector<HTMLAnchorElement>('a')
    expect(a?.getAttribute('href')).toBe('https://gitlab.example.com/uploads/ab/x.png')
    expect(host.textContent).not.toContain('!')
    expect(mirroredMarkdown('![](https://x.example/a.png)')).toBe(
      '[image](https://x.example/a.png)'
    )
  })

  it('a ```chart block stays text: GitLab authors cannot plant a chart', () => {
    const src =
      '```chart\n{"type":"bar","data":[{"label":"a","value":1},{"label":"b","value":2}]}\n```'
    expect(parseAiMarkdown(src)[0].kind).toBe('chart')
    expect(parseAiMarkdown(src, { charts: false })[0].kind).toBe('code')
  })

  it('renders the chart block as code when mirrored', async () => {
    await render(
      '```chart\n{"type":"bar","data":[{"label":"a","value":1},{"label":"b","value":2}]}\n```',
      true
    )
    expect(host.querySelector('[data-ai-chart-loading]')).toBeNull()
    expect(host.querySelector('pre')?.textContent).toContain('"type":"bar"')
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentsSlot } from './CommentsSlot'

// GitLab issue sync: a comment mirrored in from GitLab names its GitLab author with a GitLab
// mark, and while the record is linked the box says comments go to GitLab too.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(answers: Record<string, unknown>) {
  const paths: string[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path: string }) => {
      paths.push(cmd._path)
      return { data: answers[cmd._path] ?? [] }
    })
  }
  await act(async () =>
    root.render(
      <NivaroProvider client={client as never}>
        <CommentsSlot
          {...({ collection: 'orders', itemId: 7, defaultExpanded: true } as unknown as Parameters<
            typeof CommentsSlot
          >[0])}
        />
      </NivaroProvider>
    )
  )
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  return paths
}

const MIRRORED = {
  id: 'c1',
  user: { id: 'gl', first_name: 'GitLab', last_name: '', email: 'gitlab-sync@nivaro.local' },
  text: 'Fixed in [the admin page](/users/1)',
  created_at: '2026-11-17T10:00:00Z',
  updated_at: '2026-11-17T10:00:00Z',
  tracker: { provider: 'gitlab', author: 'Jane Doe' }
}

describe('CommentsSlot and GitLab', () => {
  it('a mirrored comment names its GitLab author; its text stays plain (no links)', async () => {
    await render({
      '/comments': [MIRRORED],
      '/trackers/feature/public': { enabled: true },
      '/trackers/links/for': [
        { iid: 4, web_url: 'https://g.example/a/-/issues/4', state: 'opened' }
      ]
    })
    const author = host.querySelector('[data-nf-comment-gitlab]')
    expect(author?.textContent).toBe('GitLab Jane Doe')
    expect(host.querySelector('a[href="/users/1"]')).toBeNull()
    expect(host.querySelector('[data-nf-comment-gitlab-shared]')?.textContent).toBe(
      'Comments here are shared with GitLab.'
    )
  })

  it('GitLab sync off: no notice and no link read', async () => {
    const paths = await render({
      '/comments': [{ ...MIRRORED, tracker: null }],
      '/trackers/feature/public': { enabled: false }
    })
    expect(host.querySelector('[data-nf-comment-gitlab-shared]')).toBeNull()
    expect(paths).not.toContain('/trackers/links/for')
  })
})

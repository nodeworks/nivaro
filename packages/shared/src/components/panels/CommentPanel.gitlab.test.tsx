// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIRRORED = {
  id: 'c1',
  collection: 'orders',
  item: '7',
  user: { id: 'gl', first_name: 'GitLab', last_name: '', email: 'gitlab-sync@nivaro.local' },
  text: 'Fixed in [the admin page](/users/1). ![shot](https://gitlab.example.com/uploads/x.png)',
  created_at: '2026-11-17T10:00:00Z',
  updated_at: '2026-11-17T10:00:00Z',
  mentions: [],
  tracker: { provider: 'gitlab', author: 'Jane Doe' }
}

async function mountPanel(answers: Record<string, unknown>) {
  const calls: string[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path?: string; _method?: string }) => {
      const path = String(cmd?._path ?? '')
      calls.push(path)
      if (path in answers) return { data: answers[path] }
      return { data: [] }
    })
  } as unknown as NivaroClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client}>
          <CommentPanel collection='orders' item='7' defaultExpanded />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 40 && !until(); i++)
      await act(async () => new Promise((r) => setTimeout(r, 10)))
  }
  return {
    host,
    calls,
    settle,
    done: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

describe('CommentPanel — comments mirrored in from GitLab', () => {
  it('shows the GitLab author with a badge, safe markdown, no in-app link', async () => {
    const p = await mountPanel({
      '/comments': [MIRRORED],
      '/trackers/feature/public': { enabled: true },
      '/trackers/links/for': [
        {
          iid: 482,
          web_url: 'https://gitlab.example.com/a/-/issues/482',
          state: 'opened',
          title: ''
        }
      ]
    })
    await p.settle(() => !!p.host.querySelector('[data-comment-gitlab-author]'))
    const author = p.host.querySelector('[data-comment-gitlab-author]')
    expect(author?.textContent).toContain('GitLab')
    expect(author?.textContent).toContain('Jane Doe')
    // the machine user's own name is not the author line
    expect(p.host.textContent).not.toContain('gitlab-sync@nivaro.local')
    const body = p.host.querySelector('[data-ai-mirrored]')
    expect(body).not.toBeNull()
    expect(body?.querySelector('a[href="/users/1"]')).toBeNull()
    expect(body?.textContent).toContain('the admin page')
    expect(body?.querySelector('a[href="https://gitlab.example.com/uploads/x.png"]')).not.toBeNull()
    // linked: the box says comments go to GitLab too
    await p.settle(() => !!p.host.querySelector('[data-gitlab-shared]'))
    expect(p.host.querySelector('[data-gitlab-shared]')?.textContent).toBe(
      'Comments here are shared with GitLab.'
    )
    p.done()
  })

  it('not linked (or GitLab sync off): no notice', async () => {
    const p = await mountPanel({
      '/comments': [{ ...MIRRORED, tracker: null, text: 'Plain' }],
      '/trackers/feature/public': { enabled: false }
    })
    await p.settle(() => p.host.textContent?.includes('Plain') ?? false)
    await p.settle(() => false)
    expect(p.host.querySelector('[data-gitlab-shared]')).toBeNull()
    expect(p.calls).not.toContain('/trackers/links/for')
    p.done()
  })
})

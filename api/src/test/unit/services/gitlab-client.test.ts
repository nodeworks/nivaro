import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchJson,
  type GitCtx,
  gitlabJobs,
  gitlabPipelines
} from '../../../services/gitlab-client.js'

const ctx: GitCtx = {
  provider: 'gitlab',
  base: 'https://gl.test',
  project: 'grp/proj',
  token: 'tok',
  ref: 'main'
}

function stubFetch(handler: (url: string) => unknown, status = 200) {
  const f = vi.fn(async (url: string) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(handler(String(url)))
  }))
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('gitlabJobs', () => {
  it('maps the jobs body into the slim shape', async () => {
    const f = stubFetch(() => [
      {
        id: 7,
        name: 'build',
        status: 'success',
        started_at: '2026-11-21T10:00:00Z',
        finished_at: '2026-11-21T10:01:00Z',
        web_url: 'https://gl.test/j/7',
        stage: 'ignored'
      },
      { id: 8, name: 'test', status: 'pending', started_at: null, web_url: 'https://gl.test/j/8' }
    ])
    const jobs = await gitlabJobs(ctx, 42)
    expect(jobs).toEqual([
      {
        id: 7,
        name: 'build',
        status: 'success',
        started_at: '2026-11-21T10:00:00Z',
        finished_at: '2026-11-21T10:01:00Z',
        web_url: 'https://gl.test/j/7'
      },
      {
        id: 8,
        name: 'test',
        status: 'pending',
        started_at: null,
        finished_at: null,
        web_url: 'https://gl.test/j/8'
      }
    ])
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('/api/v4/projects/grp%2Fproj/pipelines/42/jobs')
    expect(init.headers['PRIVATE-TOKEN']).toBe('tok')
  })

  it('throws when GitLab refuses', async () => {
    stubFetch(() => ({ message: 'nope' }), 403)
    await expect(gitlabJobs(ctx, 1)).rejects.toThrow('GitLab answered 403')
  })
})

describe('gitlabPipelines', () => {
  it('still normalizes pipelines', async () => {
    stubFetch((url) => {
      if (url.includes('/repository/commits/')) return { title: 'Fix', author_name: 'Ann' }
      if (/\/pipelines\/\d+$/.test(url)) return { duration: 31, user: { name: 'Bob' } }
      return [
        {
          id: 5,
          status: 'success',
          ref: 'main',
          sha: 'abcdef1234567890',
          web_url: 'https://gl.test/p/5',
          created_at: 'c',
          updated_at: 'u'
        }
      ]
    })
    const out = await gitlabPipelines(ctx)
    expect(out).toEqual([
      {
        id: 5,
        status: 'success',
        ref: 'main',
        sha: 'abcdef12',
        full_sha: 'abcdef1234567890',
        title: 'Fix',
        author: 'Ann',
        duration: 31,
        web_url: 'https://gl.test/p/5',
        created_at: 'c',
        updated_at: 'u'
      }
    ])
  })
})

describe('fetchJson redirect option', () => {
  it('leaves fetch at its default when no option is given', async () => {
    const f = stubFetch(() => ({ ok: 1 }))
    await fetchJson('https://x.test/a', {})
    expect((f.mock.calls[0] as unknown[])[1]).not.toHaveProperty('redirect')
  })

  it("passes redirect: 'error' through", async () => {
    const f = stubFetch(() => ({ ok: 1 }))
    await fetchJson('https://x.test/a', {}, 8000, { redirect: 'error' })
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' })
  })

  it('a refused redirect throws FETCH_REDIRECT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      })
    )
    await expect(
      fetchJson('https://x.test/a', {}, 8000, { redirect: 'error' })
    ).rejects.toMatchObject({ code: 'FETCH_REDIRECT' })
  })

  it('a network error without the option is rethrown as is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      })
    )
    await expect(fetchJson('https://x.test/a', {})).rejects.toBeInstanceOf(TypeError)
  })
})

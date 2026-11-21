import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchJson,
  type GitCtx,
  gitlabCommit,
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

describe('the token never follows a redirect', () => {
  const plainCtx: GitCtx = { ...ctx, token: null }
  const answers = (url: string) => {
    if (url.includes('/repository/commits/')) return { title: 'Fix', author_name: 'Ann' }
    if (/\/pipelines\/\d+$/.test(url)) return { duration: 31 }
    if (url.includes('/jobs')) return []
    return [{ id: 5, status: 'success', sha: 'f00dbabe12345678' }]
  }
  const inits = (f: ReturnType<typeof stubFetch>) =>
    f.mock.calls.map((c) => (c as unknown[])[1] as { redirect?: string })

  it("pipelines, pipeline detail, commits and jobs pass redirect: 'error' with a token", async () => {
    const f = stubFetch(answers)
    await gitlabPipelines(ctx)
    await gitlabJobs(ctx, 5)
    await gitlabCommit(ctx, 'cafe0001')
    const urls = f.mock.calls.map((c) => String((c as unknown[])[0]))
    expect(urls.some((u) => u.includes('/repository/commits/'))).toBe(true)
    expect(urls.some((u) => /\/pipelines\/5$/.test(u))).toBe(true)
    expect(urls.some((u) => u.includes('/jobs'))).toBe(true)
    for (const init of inits(f)) expect(init.redirect).toBe('error')
  })

  it('no token: fetch keeps its default (no redirect option)', async () => {
    const f = stubFetch(answers)
    await gitlabPipelines(plainCtx)
    await gitlabJobs(plainCtx, 5)
    await gitlabCommit(plainCtx, 'cafe0002')
    expect(f.mock.calls.length).toBeGreaterThan(0)
    for (const init of inits(f)) expect(init).not.toHaveProperty('redirect')
  })
})

describe('fetchJson method + body', () => {
  it('a plain call sends no method, body or content-type (GET as before)', async () => {
    const f = stubFetch(() => ({ ok: 1 }))
    await fetchJson('https://x.test/a', { 'PRIVATE-TOKEN': 't' })
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(init).not.toHaveProperty('method')
    expect(init).not.toHaveProperty('body')
    expect(init.headers).toEqual({ 'PRIVATE-TOKEN': 't' })
  })

  it('sends the method and a JSON body with its content-type', async () => {
    const f = stubFetch(() => ({ id: 1 }))
    await fetchJson('https://x.test/a', { 'PRIVATE-TOKEN': 't' }, 8000, {
      method: 'POST',
      body: { branch: 'b' },
      redirect: 'error'
    })
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(init).toMatchObject({ method: 'POST', body: '{"branch":"b"}', redirect: 'error' })
    expect(init.headers).toEqual({ 'PRIVATE-TOKEN': 't', 'content-type': 'application/json' })
  })
})

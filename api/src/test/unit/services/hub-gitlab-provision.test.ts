import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commitFiles,
  currentUser,
  ensureBranch,
  forkProject,
  IMPORT_POLL_MS,
  IMPORT_POLLS,
  namespaceExists,
  projectExists,
  protectBranch,
  upsertVariable
} from '../../../services/hub/create/gitlab-provision.js'
import { GitlabWriteError, gitlabCall } from '../../../services/hub/gitlab-write.js'
import { FakeGitLab } from './hub-fake-gitlab.js'

// Nivaro Hub phase 3: the GitLab provisioning calls, run for real over the in-memory GitLab.

const TEMPLATE = 'platform/hub-app-template'
const VALUE = 'dGVzdC1vbmx5LXZhbHVlLTAxMjM0NTY3' // base64 of a test-only value

let gl: FakeGitLab
let slept: number[]
const sleep = async (ms: number) => {
  slept.push(ms)
}

beforeEach(() => {
  gl = new FakeGitLab()
  slept = []
  gl.project(TEMPLATE)
  gl.commit(TEMPLATE, 'main', 'template', {
    '.gitlab-ci.yml': 'deploy: {}\n',
    'scripts/deploy.sh': '#!/bin/sh\n'
  })
  gl.namespace('apps')
  vi.stubGlobal('fetch', gl.fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every call carried the token in PRIVATE-TOKEN only and refused redirects. */
function expectSafeCalls() {
  expect(gl.calls.length).toBeGreaterThan(0)
  for (const c of gl.calls) {
    expect(c.redirect).toBe('error')
    expect(c.token).toBe(gl.token)
    expect(c.url).not.toContain(gl.token)
    expect(JSON.stringify(c.body ?? null)).not.toContain(gl.token)
  }
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(GitlabWriteError)
    const e = err as GitlabWriteError
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a refusal')
}

describe('gitlabCall export', () => {
  it('is the write client call: project URL, token header, redirect refused', async () => {
    const res = await gitlabCall(gl.ctx(TEMPLATE), 'probe', '/repository/branches/main')
    expect(res.status).toBe(200)
    expect(gl.calls[0].path).toBe('/repository/branches/main')
    expectSafeCalls()
  })
  it('refuses without a token and never fetches', async () => {
    const r = await codeOf(gitlabCall({ ...gl.ctx(TEMPLATE), token: null }, 'probe', '/'))
    expect(r.code).toBe('GITLAB_NO_TOKEN')
    expect(gl.calls).toHaveLength(0)
  })
})

describe('projectExists', () => {
  it('answers id and path for a project, null for a 404', async () => {
    const found = await projectExists(gl.ctx(TEMPLATE), TEMPLATE)
    expect(found).toEqual({ id: expect.any(Number), path_with_namespace: TEMPLATE })
    expect(await projectExists(gl.ctx(TEMPLATE), 'apps/nope-deploy')).toBeNull()
    expectSafeCalls()
  })
})

describe('forkProject', () => {
  it('forks, polls import_status until finished, then removes the fork relation', async () => {
    const out = await forkProject(
      gl.ctx(TEMPLATE),
      TEMPLATE,
      'apps',
      'demo-deploy',
      'demo deploy',
      {
        sleep
      }
    )
    expect(out).toEqual({
      id: expect.any(Number),
      path_with_namespace: 'apps/demo-deploy',
      web_url: `${gl.base}/apps/demo-deploy`
    })
    // scheduled → started → finished: two waits of 3 s.
    expect(slept).toEqual([IMPORT_POLL_MS, IMPORT_POLL_MS])
    expect(IMPORT_POLL_MS).toBe(3000)
    expect(IMPORT_POLLS).toBe(40)
    expect(gl.forkedFromOf('apps/demo-deploy')).toBeNull()
    const del = gl.calls.find((c) => c.method === 'DELETE')
    expect(del?.path).toBe('/fork')
    expect(del?.url).toContain(`/projects/${out.id}/fork`)
    const fork = gl.calls.find((c) => c.method === 'POST')
    expect(fork?.body).toMatchObject({
      namespace_path: 'apps',
      path: 'demo-deploy',
      name: 'demo deploy'
    })
    expect(gl.file('apps/demo-deploy', 'main', 'scripts/deploy.sh')).toBe('#!/bin/sh\n')
    expectSafeCalls()
  })

  it('import failed → IMPORT_FAILED, the relation stays', async () => {
    gl.forkImport = ['scheduled', 'failed']
    const r = await codeOf(
      forkProject(gl.ctx(TEMPLATE), TEMPLATE, 'apps', 'demo-deploy', 'd', { sleep })
    )
    expect(r.code).toBe('IMPORT_FAILED')
    expect(gl.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('import never finishes → IMPORT_TIMEOUT after 40 polls of 3 s', async () => {
    gl.forkImport = ['scheduled', 'started']
    const r = await codeOf(
      forkProject(gl.ctx(TEMPLATE), TEMPLATE, 'apps', 'demo-deploy', 'd', { sleep })
    )
    expect(r.code).toBe('IMPORT_TIMEOUT')
    expect(slept).toHaveLength(40)
    expect(slept.every((ms) => ms === 3000)).toBe(true)
  })

  it('a taken path is PROJECT_EXISTS and the error carries no GitLab text', async () => {
    gl.project('apps/demo-deploy')
    const r = await codeOf(
      forkProject(gl.ctx(TEMPLATE), TEMPLATE, 'apps', 'demo-deploy', 'd', { sleep })
    )
    expect(r.code).toBe('PROJECT_EXISTS')
    expect(r.message).not.toContain(gl.token)
    expect(r.message).not.toContain('taken')
  })

  it('a stopped signal ends the wait', async () => {
    gl.forkImport = ['scheduled']
    const ctl = new AbortController()
    const r = await codeOf(
      forkProject(gl.ctx(TEMPLATE), TEMPLATE, 'apps', 'demo-deploy', 'd', {
        sleep: async () => ctl.abort(),
        signal: ctl.signal
      })
    )
    expect(r.code).toBe('ABORTED')
  })
})

describe('branches', () => {
  it('ensureBranch creates once, then answers existed', async () => {
    const ctx = gl.ctx(TEMPLATE)
    expect(await ensureBranch(ctx, 'staging', 'main')).toBe('created')
    expect(await ensureBranch(ctx, 'staging', 'main')).toBe('existed')
    expect(gl.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expectSafeCalls()
  })

  it('protectBranch protects for Maintainers; "already protected" is fine', async () => {
    const ctx = gl.ctx(TEMPLATE)
    await protectBranch(ctx, 'staging')
    await protectBranch(ctx, 'staging')
    expect(gl.protectedOf(TEMPLATE)).toEqual(['staging'])
    expect(gl.calls[0].body).toMatchObject({
      name: 'staging',
      push_access_level: 40,
      merge_access_level: 40
    })
    expectSafeCalls()
  })
})

describe('upsertVariable', () => {
  const v = {
    key: 'NIVARO_DB_URL_B64',
    value: VALUE,
    scope: 'staging',
    masked: true,
    protected: true
  }

  it('creates a masked, protected, raw variable scoped to the environment', async () => {
    expect(await upsertVariable(gl.ctx(TEMPLATE), v)).toBe('created')
    expect(gl.variablesOf(TEMPLATE)).toEqual([
      {
        key: v.key,
        value: VALUE,
        environment_scope: 'staging',
        masked: true,
        protected: true,
        raw: true
      }
    ])
    expectSafeCalls()
  })

  it('"has already been taken" → PUT filtered by environment scope', async () => {
    const ctx = gl.ctx(TEMPLATE)
    await upsertVariable(ctx, v)
    await upsertVariable(ctx, { ...v, scope: 'production' })
    const next = 'bmV4dC10ZXN0LXZhbHVlLTk4NzY1NDMy'
    expect(await upsertVariable(ctx, { ...v, value: next })).toBe('updated')
    const put = gl.calls.find((c) => c.method === 'PUT')
    expect(put?.url).toContain(`/variables/${v.key}?filter%5Benvironment_scope%5D=staging`)
    const vars = gl.variablesOf(TEMPLATE)
    expect(vars.find((x) => x.environment_scope === 'staging')?.value).toBe(next)
    expect(vars.find((x) => x.environment_scope === 'production')?.value).toBe(VALUE)
    expectSafeCalls()
  })

  it('keepExisting leaves a taken variable untouched (no PUT)', async () => {
    const ctx = gl.ctx(TEMPLATE)
    const keep = { ...v, key: 'NIVARO_ENCRYPTION_KEY_B64' }
    expect(await upsertVariable(ctx, keep, { keepExisting: true })).toBe('created')
    const other = 'b3RoZXItdGVzdC12YWx1ZS0xMjM0NTY3OA=='
    expect(await upsertVariable(ctx, { ...keep, value: other }, { keepExisting: true })).toBe(
      'kept'
    )
    expect(gl.variablesOf(TEMPLATE)[0].value).toBe(VALUE)
    expect(gl.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('scope * reaches GitLab as * (project-wide, not masked)', async () => {
    const ctx = gl.ctx(TEMPLATE)
    const host = {
      key: 'DEPLOY_HOST',
      value: 'deploy@host-1',
      scope: '*',
      masked: false,
      protected: false
    }
    expect(await upsertVariable(ctx, host)).toBe('created')
    expect(await upsertVariable(ctx, { ...host, value: 'deploy@host-2' })).toBe('updated')
    expect(gl.calls.find((c) => c.method === 'PUT')?.url).toContain(
      '?filter%5Benvironment_scope%5D=*'
    )
    expect(gl.variablesOf(TEMPLATE)[0]).toMatchObject({
      environment_scope: '*',
      value: 'deploy@host-2'
    })
  })

  it('a refusal names the key, never the value or GitLab text', async () => {
    const bad = { ...v, value: 'not maskable value!' }
    const r = await codeOf(upsertVariable(gl.ctx(TEMPLATE), bad))
    expect(r.code).toBe('VARIABLE_REFUSED')
    expect(r.message).toContain(v.key)
    expect(r.message).not.toContain('maskable')
    expect(r.message).not.toContain('invalid')
  })
})

describe('commitFiles', () => {
  const files = [
    { path: '.hub/app.env', content: 'APP_KEY=demo\n' },
    { path: '.hub/nivaro-version', content: '0.3.200\n' }
  ]

  it('changed files go in ONE commit with create and update actions', async () => {
    const ctx = gl.ctx(TEMPLATE)
    gl.commit(TEMPLATE, 'main', 'old pin', { '.hub/nivaro-version': '0.3.100\n' })
    const out = await commitFiles(ctx, 'main', files, 'nivaro 0.3.200 (hub: create demo/staging)')
    expect(out.changed).toBe(true)
    const posts = gl.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect((posts[0].body as { actions: unknown[] }).actions).toEqual([
      { action: 'create', file_path: '.hub/app.env', content: 'APP_KEY=demo\n' },
      expect.objectContaining({
        action: 'update',
        file_path: '.hub/nivaro-version',
        content: '0.3.200\n'
      })
    ])
    expect(gl.file(TEMPLATE, 'main', '.hub/app.env')).toBe('APP_KEY=demo\n')
    expect(gl.projects.get(TEMPLATE)?.branches.get('main')).toBe(out.sha)
    expectSafeCalls()
  })

  it('unchanged files make no commit and answer the branch head', async () => {
    const ctx = gl.ctx(TEMPLATE)
    await commitFiles(ctx, 'main', files, 'first')
    const head = gl.projects.get(TEMPLATE)?.branches.get('main')
    gl.calls.length = 0
    const out = await commitFiles(ctx, 'main', files, 'again')
    expect(out).toEqual({ sha: head, changed: false })
    expect(gl.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('only the changed file rides the commit', async () => {
    const ctx = gl.ctx(TEMPLATE)
    await commitFiles(ctx, 'main', files, 'first')
    gl.calls.length = 0
    await commitFiles(ctx, 'main', [files[0], { ...files[1], content: '0.3.201\n' }], 'pin')
    const post = gl.calls.find((c) => c.method === 'POST')
    expect(
      (post?.body as { actions: Array<{ file_path: string }> }).actions.map((a) => a.file_path)
    ).toEqual(['.hub/nivaro-version'])
  })
})

describe('account calls', () => {
  it('currentUser and namespaceExists use the token header and refuse redirects', async () => {
    const ctx = gl.ctx(TEMPLATE)
    expect(await currentUser(ctx)).toEqual({ id: 7, username: 'hub-bot' })
    expect(await namespaceExists(ctx, 'apps')).toEqual({
      id: expect.any(Number),
      kind: 'group',
      full_path: 'apps'
    })
    expect(await namespaceExists(ctx, 'nope')).toBeNull()
    expect(gl.calls.map((c) => c.url)).toEqual([
      `${gl.base}/api/v4/user`,
      `${gl.base}/api/v4/namespaces/apps`,
      `${gl.base}/api/v4/namespaces/nope`
    ])
    expectSafeCalls()
  })

  it('a refused token is GITLAB_UNAUTHORIZED without GitLab text', async () => {
    const r = await codeOf(currentUser({ ...gl.ctx(TEMPLATE), token: 'glpat-wrong' }))
    expect(r.code).toBe('GITLAB_UNAUTHORIZED')
    expect(r.message).not.toContain('Unauthorized')
  })

  it('a redirect is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('unexpected redirect')
        })
      })
    )
    const r = await codeOf(currentUser(gl.ctx(TEMPLATE)))
    expect(r.code).toBe('FETCH_REDIRECT')
  })
})

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { expoAdapter } from '../../../services/hub/providers/expo/index.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { getProvider, resetProvidersForTest } from '../../../services/hub/providers/registry.js'
import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

// Nivaro Hub providers, Task 10: the Expo / EAS adapter, driven by recorded (fake) GraphQL
// answers from expo/__fixtures__/eas-answers.json through the allowlisted ctx.fetch.

const FIX = JSON.parse(
  readFileSync(
    new URL('../../../services/hub/providers/expo/__fixtures__/eas-answers.json', import.meta.url),
    'utf8'
  )
) as Record<string, any>

const TOKEN = 'test-secret-expo-robot-token'

type Handler = (op: string, vars: Record<string, any>) => unknown
interface Sent {
  op: string
  vars: Record<string, any>
  headers: Record<string, string>
  url: string
}

function setup(handler?: Handler, httpStatus = 200) {
  const sent: Sent[] = []
  const ctx = makeProviderContext({
    adapter: expoAdapter,
    connectionId: 77,
    config: { account: 'acme-mobile' },
    secrets: { token: TOKEN },
    fetch: {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init.body))
        const op = /(?:query|mutation) (\w+)/.exec(body.query)![1]
        sent.push({ op, vars: body.variables, headers: init.headers as any, url })
        const out = handler ? handler(op, body.variables) : undefined
        const payload = out === undefined ? { data: FIX[op] } : out
        return new Response(JSON.stringify(payload), {
          status: httpStatus,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
  })
  return { ctx, sent }
}

function desired(over: Partial<DesiredResource> & { type: string }): DesiredResource {
  return {
    resourceId: 1,
    externalId: null,
    scope: 'app',
    appId: 5,
    environmentId: 9,
    fields: {},
    refs: {},
    tags: {},
    ...over
  }
}

beforeEach(() => {
  resetProvidersForTest()
})

describe('expo adapter: registration', () => {
  it('is one entry in CORE_PROVIDERS and registers', () => {
    ensureCoreProviders()
    expect(getProvider('expo')?.types.map((t) => t.key)).toEqual([
      'expo.project',
      'expo.branch',
      'expo.channel',
      'expo.env_var',
      'expo.build'
    ])
    expect(expoAdapter.connection.hosts({})).toEqual(['api.expo.dev'])
  })
})

describe('expo adapter: testConnection', () => {
  it('lists missing permissions when the token cannot reach the pinned account', async () => {
    const { ctx } = setup((op) =>
      op === 'HubWhoami'
        ? {
            data: {
              meActor: { __typename: 'Robot', id: 'r', accounts: [{ id: 'x', name: 'other' }] }
            }
          }
        : undefined
    )
    const t = await expoAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.missing).toContain('Access to account acme-mobile')
    expect(t.permissions.every((p) => p.has === false)).toBe(true)
  })

  it('passes with identity when the account is reachable, sending the bearer token', async () => {
    const { ctx, sent } = setup()
    const t = await expoAdapter.testConnection(ctx)
    expect(t).toMatchObject({ ok: true, identity: 'robot acme-mobile', missing: [] })
    expect(sent[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(sent[0].url).toBe('https://api.expo.dev/graphql')
  })
})

describe('expo adapter: observe', () => {
  it('maps provider fields per type', async () => {
    const { ctx } = setup()
    const project = await expoAdapter.observe(ctx, 'expo.project', 'app-1')
    expect(project).toMatchObject({
      externalId: 'app-1',
      name: 'field-app',
      fields: { name: 'field-app', privacy: 'unlisted', account: 'acme-mobile' },
      url: 'https://expo.dev/@acme-mobile/field-app'
    })
    const channel = await expoAdapter.observe(ctx, 'expo.channel', 'app-1:ch-1')
    expect(channel?.fields).toEqual({
      project: 'app-1',
      name: 'production',
      branch: 'app-1:br-1'
    })
    const env = await expoAdapter.observe(ctx, 'expo.env_var', 'app-1:ev-1')
    expect(env?.fields).toEqual({
      project: 'app-1',
      name: 'API_URL',
      visibility: 'secret',
      environments: ['production', 'preview']
    })
    expect(env?.fields).not.toHaveProperty('value')
    const build = await expoAdapter.observe(ctx, 'expo.build', 'app-1:bld-1')
    expect(build).toMatchObject({
      status: 'finished',
      fields: { platform: 'ios', profile: 'production' }
    })
    expect(await expoAdapter.observe(ctx, 'expo.branch', 'app-1:nope')).toBeNull()
  })

  it('answers null when Expo says the project is not found', async () => {
    const { ctx } = setup(() => ({
      errors: [{ message: 'App not found', extensions: { errorCode: 'EXPERIENCE_NOT_FOUND' } }]
    }))
    expect(await expoAdapter.observe(ctx, 'expo.project', 'gone')).toBeNull()
  })

  it('lists every type from the account projects', async () => {
    const { ctx } = setup()
    const projects = await expoAdapter.list(ctx, 'expo.project')
    expect(projects.items.map((i) => i.externalId)).toEqual(['app-1'])
    expect(projects.cursor).toBeNull()
    const branches = await expoAdapter.list(ctx, 'expo.branch')
    expect(branches.items.map((i) => i.name)).toEqual(['release-1', 'release-2'])
    const builds = await expoAdapter.list(ctx, 'expo.build')
    expect(builds.items[0].externalId).toBe('app-1:bld-1')
  })
})

describe('expo adapter: plan', () => {
  it('creates, deletes and noops per type', () => {
    const create = expoAdapter.plan(
      setup().ctx,
      desired({ type: 'expo.project', fields: { name: 'field-app', privacy: 'unlisted' } }),
      null
    )
    expect(create[0]).toMatchObject({ kind: 'create', type: 'expo.project' })
    const obs: Observed = {
      type: 'expo.branch',
      externalId: 'app-1:br-1',
      name: 'release-1',
      fields: { project: 'app-1', name: 'release-1' },
      tags: {}
    }
    expect(expoAdapter.plan(setup().ctx, null, obs)[0]).toMatchObject({
      kind: 'delete',
      externalId: 'app-1:br-1'
    })
    expect(
      expoAdapter.plan(
        setup().ctx,
        desired({
          type: 'expo.branch',
          externalId: 'app-1:br-1',
          fields: { project: { resourceId: 2 }, name: 'release-1' },
          refs: { project: 'app-1' }
        }),
        obs
      )[0].kind
    ).toBe('noop')
  })

  it('points a channel at another branch as a named `point` op', () => {
    const obs: Observed = {
      type: 'expo.channel',
      externalId: 'app-1:ch-1',
      name: 'production',
      fields: { project: 'app-1', name: 'production', branch: 'app-1:br-1' },
      tags: {}
    }
    const [op] = expoAdapter.plan(
      setup().ctx,
      desired({
        type: 'expo.channel',
        externalId: 'app-1:ch-1',
        fields: {
          project: { resourceId: 2 },
          name: 'production',
          branch: { resourceId: 4 }
        },
        refs: { project: 'app-1', branch: 'app-1:br-2' }
      }),
      obs
    )
    expect(op).toMatchObject({ kind: 'update', action: 'point' })
    expect(op.changes).toEqual([{ field: 'branch', from: 'app-1:br-1', to: 'app-1:br-2' }])
    expect(op.preconditions).toEqual({ branch: 'app-1:br-1' })
  })

  it('a build is read-only after it exists, and its trigger is action `build`', () => {
    const obs: Observed = {
      type: 'expo.build',
      externalId: 'app-1:bld-1',
      name: 'production',
      fields: { project: 'app-1', platform: 'ios', profile: 'production' },
      tags: {}
    }
    const d = desired({
      type: 'expo.build',
      externalId: 'app-1:bld-1',
      fields: { project: { resourceId: 2 }, platform: 'android', profile: 'other' },
      refs: { project: 'app-1' }
    })
    expect(expoAdapter.plan(setup().ctx, d, obs)[0].kind).toBe('noop')
    const [create] = expoAdapter.plan(setup().ctx, { ...d, externalId: null }, null)
    expect(create).toMatchObject({ kind: 'create', action: 'build' })
    expect(create.data).toMatchObject({ platform: 'android', profile: 'other' })
  })

  it('a renamed channel is a replace; a changed env value only shows as a secret change', () => {
    const chObs: Observed = {
      type: 'expo.channel',
      externalId: 'app-1:ch-1',
      name: 'production',
      fields: { project: 'app-1', name: 'production', branch: null },
      tags: {}
    }
    const [rep] = expoAdapter.plan(
      setup().ctx,
      desired({
        type: 'expo.channel',
        fields: { project: { resourceId: 2 }, name: 'staging' },
        refs: { project: 'app-1' }
      }),
      chObs
    )
    expect(rep.kind).toBe('replace')
    const evObs: Observed = {
      type: 'expo.env_var',
      externalId: 'app-1:ev-1',
      name: 'API_URL',
      fields: {
        project: 'app-1',
        name: 'API_URL',
        visibility: 'secret',
        environments: ['preview', 'production']
      },
      tags: {}
    }
    const [upd] = expoAdapter.plan(
      setup().ctx,
      desired({
        type: 'expo.env_var',
        fields: {
          project: { resourceId: 2 },
          name: 'API_URL',
          value: { fingerprint: 'fp1', changed: true },
          visibility: 'secret',
          environments: ['production', 'preview']
        },
        refs: { project: 'app-1' }
      }),
      evObs
    )
    expect(upd.kind).toBe('update')
    expect(upd.changes).toEqual([{ field: 'value', secret: true }])
    expect(JSON.stringify(upd)).not.toContain('plain')
  })
})

describe('expo adapter: risk flags', () => {
  const spec = (k: string) => expoAdapter.types.find((t) => t.key === k)!
  const op = (kind: PlannedOp['kind'], type: string): PlannedOp => ({
    kind,
    type,
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  })
  it('flags deletes by type', () => {
    expect(spec('expo.project').risk(op('delete', 'expo.project'), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(spec('expo.channel').risk(op('delete', 'expo.channel'), null)).toEqual(['destructive'])
    expect(spec('expo.env_var').risk(op('delete', 'expo.env_var'), null)).toEqual(['destructive'])
    expect(spec('expo.branch').risk(op('create', 'expo.branch'), null)).toEqual([])
    expect(spec('expo.build').capabilities).toMatchObject({ update: false, delete: false })
  })
})

describe('expo adapter: apply', () => {
  it('create project is idempotent (read-before-write: no create when it exists)', async () => {
    const { ctx, sent } = setup((op) =>
      op === 'HubAppByFullName'
        ? { data: { app: { byFullName: FIX.HubAppById.app.byId } } }
        : undefined
    )
    const [op] = expoAdapter.plan(
      ctx,
      desired({ type: 'expo.project', fields: { name: 'field-app', privacy: 'unlisted' } }),
      null
    )
    const res = await expoAdapter.apply(
      ctx,
      op,
      desired({
        type: 'expo.project',
        externalId: 'app-1',
        fields: { name: 'field-app', privacy: 'unlisted' }
      })
    )
    expect(res).toMatchObject({ ok: true, externalId: 'app-1', answer: { existed: true } })
    expect(sent.some((s) => s.op === 'HubCreateApp')).toBe(false)
  })

  it('creates a project when missing', async () => {
    const { ctx, sent } = setup((op) => {
      if (op === 'HubAppByFullName') return { data: { app: { byFullName: null } } }
      if (op === 'HubCreateApp') return { data: { app: { createApp: FIX.HubAppById.app.byId } } }
      return undefined
    })
    const d = desired({ type: 'expo.project', fields: { name: 'field-app', privacy: 'unlisted' } })
    const res = await expoAdapter.apply(ctx, expoAdapter.plan(ctx, d, null)[0], d)
    expect(res.externalId).toBe('app-1')
    const create = sent.find((s) => s.op === 'HubCreateApp')!
    expect(create.vars.input).toEqual({
      accountId: 'acct-1',
      projectName: 'field-app',
      privacy: 'unlisted'
    })
  })

  it('points a channel: skips when already there, writes when not', async () => {
    const d = desired({
      type: 'expo.channel',
      externalId: 'app-1:ch-1',
      fields: { project: { resourceId: 2 }, name: 'production', branch: { resourceId: 4 } },
      refs: { project: 'app-1', branch: 'app-1:br-2' }
    })
    const op: PlannedOp = {
      kind: 'update',
      type: 'expo.channel',
      resourceId: 1,
      externalId: 'app-1:ch-1',
      reason: '',
      changes: [],
      preconditions: {},
      risk: [],
      action: 'point'
    }
    const { ctx, sent } = setup((o, v) =>
      o === 'HubPointChannel'
        ? {
            data: {
              updateChannel: {
                editUpdateChannel: {
                  id: 'ch-1',
                  name: 'production',
                  branchMapping: v.branchMapping
                }
              }
            }
          }
        : undefined
    )
    const res = await expoAdapter.apply(ctx, op, d)
    expect(res.observed?.fields.branch).toBe('app-1:br-2')
    expect(JSON.parse(sent.find((s) => s.op === 'HubPointChannel')!.vars.branchMapping)).toEqual({
      version: 0,
      data: [{ branchId: 'br-2', branchMappingLogic: 'true' }]
    })
    // Already pointing at br-1: second apply sends no write.
    const same = setup()
    const again = await expoAdapter.apply(same.ctx, op, {
      ...d,
      refs: { project: 'app-1', branch: 'app-1:br-1' }
    })
    expect(again.answer).toEqual({ existed: true })
    expect(same.sent.some((s) => s.op === 'HubPointChannel')).toBe(false)
  })

  it('env var value is sent once on create and never comes back in the result', async () => {
    const { ctx, sent } = setup((op) =>
      op === 'HubEnvVars'
        ? { data: { app: { byId: { id: 'app-1', environmentVariables: [] } } } }
        : op === 'HubCreateEnvVar'
          ? {
              data: {
                environmentVariable: {
                  createEnvironmentVariableForApp: {
                    id: 'ev-9',
                    name: 'TOKEN',
                    visibility: 'SECRET',
                    environments: ['PRODUCTION']
                  }
                }
              }
            }
          : undefined
    )
    const d = desired({
      type: 'expo.env_var',
      fields: {
        project: { resourceId: 2 },
        name: 'TOKEN',
        value: { fingerprint: 'f', changed: true, plain: 'test-secret-env-value-1' },
        visibility: 'secret',
        environments: ['production']
      },
      refs: { project: 'app-1' }
    })
    const res = await expoAdapter.apply(ctx, expoAdapter.plan(ctx, d, null)[0], d)
    expect(res.externalId).toBe('app-1:ev-9')
    expect(sent.find((s) => s.op === 'HubCreateEnvVar')!.vars.input).toMatchObject({
      name: 'TOKEN',
      value: 'test-secret-env-value-1',
      visibility: 'SECRET',
      environments: ['PRODUCTION']
    })
    expect(JSON.stringify(res)).not.toContain('test-secret-env-value-1')
  })

  it('refuses to bind an existing project/branch/channel/env var the Hub did not create', async () => {
    const p = setup((op) =>
      op === 'HubAppByFullName'
        ? { data: { app: { byFullName: FIX.HubAppById.app.byId } } }
        : undefined
    )
    const proj = desired({ type: 'expo.project', fields: { name: 'field-app' } })
    await expect(
      expoAdapter.apply(p.ctx, expoAdapter.plan(p.ctx, proj, null)[0], proj)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    // A resumed run (this row already records the id) may continue.
    await expect(
      expoAdapter.apply(p.ctx, expoAdapter.plan(p.ctx, proj, null)[0], {
        ...proj,
        externalId: 'app-1'
      })
    ).resolves.toMatchObject({ ok: true })
    const mk = (type: string, fields: Record<string, unknown>) =>
      desired({
        type,
        fields: { project: { resourceId: 2 }, ...fields },
        refs: { project: 'app-1' }
      })
    const s = setup()
    for (const d of [
      mk('expo.branch', { name: 'release-1' }),
      mk('expo.channel', { name: 'production' }),
      mk('expo.env_var', {
        name: 'API_URL',
        value: { fingerprint: 'f', changed: true, plain: 'test-secret-env-value-2' },
        visibility: 'plaintext',
        environments: ['production']
      })
    ])
      await expect(
        expoAdapter.apply(s.ctx, expoAdapter.plan(s.ctx, d, null)[0], d)
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(s.sent.some((x) => /Update|Create|Point/.test(x.op))).toBe(false)
  })

  it('findExisting (plan time): project by slug, branch / channel / variable by name; reads only', async () => {
    const p = setup((op) =>
      op === 'HubAppByFullName'
        ? { data: { app: { byFullName: FIX.HubAppById.app.byId } } }
        : undefined
    )
    const proj = await expoAdapter.findExisting?.(
      p.ctx,
      'expo.project',
      desired({ type: 'expo.project', fields: { name: 'field-app' } })
    )
    expect(proj).toMatchObject({ type: 'expo.project', externalId: 'app-1' })
    expect(p.sent[0].vars.fullName).toBe('@acme-mobile/field-app')
    const mk = (type: string, fields: Record<string, unknown>) =>
      desired({
        type,
        fields: { project: { resourceId: 2 }, ...fields },
        refs: { project: 'app-1' }
      })
    const s = setup()
    for (const [type, name] of [
      ['expo.branch', 'release-1'],
      ['expo.channel', 'production'],
      ['expo.env_var', 'API_URL']
    ])
      expect(await expoAdapter.findExisting?.(s.ctx, type, mk(type, { name }))).toMatchObject({
        type
      })
    expect(
      await expoAdapter.findExisting?.(s.ctx, 'expo.branch', mk('expo.branch', { name: 'nope-1' }))
    ).toBeNull()
    // The project is made in the same change: nothing to collide with, no call.
    const n = s.sent.length
    expect(
      await expoAdapter.findExisting?.(
        s.ctx,
        'expo.branch',
        desired({ type: 'expo.branch', fields: { name: 'release-1' }, refs: {} })
      )
    ).toBeNull()
    expect(s.sent.length).toBe(n)
    expect(s.sent.some((x) => /Update|Create|Point/.test(x.op))).toBe(false)
  })

  it('named ops refuse a target that does not match desired.refs', async () => {
    const { ctx } = setup()
    const op: PlannedOp = {
      kind: 'update',
      type: 'expo.channel',
      resourceId: 1,
      externalId: 'app-1:ch-1',
      reason: '',
      changes: [],
      preconditions: {},
      risk: [],
      action: 'point'
    }
    await expect(
      expoAdapter.apply(
        ctx,
        op,
        desired({
          type: 'expo.channel',
          externalId: 'app-1:ch-1',
          refs: { project: 'app-other', branch: 'app-other:br-2' }
        })
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    const b = desired({
      type: 'expo.build',
      fields: { platform: 'ios', profile: 'production' },
      refs: { project: 'app-1' }
    })
    await expect(
      expoAdapter.apply(
        ctx,
        {
          ...op,
          kind: 'create',
          type: 'expo.build',
          action: 'build',
          data: { platform: 'android', profile: 'production' }
        },
        b
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('refuses an app of another account on observe, delete and update', async () => {
    const other = (op: string) =>
      op === 'HubAppById'
        ? { data: { app: { byId: { ...FIX.HubAppById.app.byId, fullName: '@rival/field-app' } } } }
        : undefined
    const { ctx, sent } = setup(other)
    await expect(expoAdapter.observe(ctx, 'expo.project', 'app-1')).rejects.toMatchObject({
      code: 'EXPO_OUT_OF_ACCOUNT'
    })
    await expect(expoAdapter.observe(ctx, 'expo.branch', 'app-1:br-1')).rejects.toMatchObject({
      code: 'EXPO_OUT_OF_ACCOUNT'
    })
    const base: PlannedOp = {
      kind: 'delete',
      type: 'expo.project',
      resourceId: 1,
      externalId: 'app-1',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    await expect(expoAdapter.apply(ctx, base, null)).rejects.toMatchObject({
      code: 'EXPO_OUT_OF_ACCOUNT'
    })
    await expect(
      expoAdapter.apply(
        ctx,
        { ...base, kind: 'update' },
        desired({ type: 'expo.project', externalId: 'app-1', fields: { name: 'field-app' } })
      )
    ).rejects.toMatchObject({ code: 'EXPO_OUT_OF_ACCOUNT' })
    expect(sent.some((x) => /Delete|Update/.test(x.op))).toBe(false)
  })

  it('masks an env value Expo echoes in an error', async () => {
    const plain = 'test-secret-env-value-3'
    const { ctx } = setup((op) =>
      op === 'HubEnvVars'
        ? { data: { app: { byId: { id: 'app-1', environmentVariables: [] } } } }
        : op === 'HubCreateEnvVar'
          ? { errors: [{ message: `Invalid value ${plain} for variable` }] }
          : undefined
    )
    const d = desired({
      type: 'expo.env_var',
      fields: {
        project: { resourceId: 2 },
        name: 'TOKEN',
        value: { fingerprint: 'f', changed: true, plain },
        visibility: 'secret',
        environments: ['production']
      },
      refs: { project: 'app-1' }
    })
    const err = await expoAdapter.apply(ctx, expoAdapter.plan(ctx, d, null)[0], d).catch((e) => e)
    expect(err).toMatchObject({ code: 'EXPO_GRAPHQL' })
    expect(err.message).not.toContain(plain)
  })

  it('build mutation variables come from desired, a tampered op.data.gitRef is refused', async () => {
    const d = desired({
      type: 'expo.build',
      fields: {
        project: { resourceId: 2 },
        platform: 'ios',
        profile: 'production',
        gitRef: 'main'
      },
      refs: { project: 'app-1' }
    })
    const [op] = expoAdapter.plan(setup().ctx, d, null)
    const bad = setup()
    await expect(
      expoAdapter.apply(bad.ctx, { ...op, data: { ...op.data, gitRef: 'evil-branch' } }, d)
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(bad.sent.some((x) => x.op === 'HubTriggerBuild')).toBe(false)
    const ok = setup((o) =>
      o === 'HubTriggerBuild'
        ? {
            data: {
              build: {
                triggerBuildFromGit: {
                  id: 'bld-3',
                  status: 'NEW',
                  platform: 'IOS',
                  buildProfile: 'production'
                }
              }
            }
          }
        : undefined
    )
    await expoAdapter.apply(ok.ctx, op, d)
    expect(ok.sent.find((x) => x.op === 'HubTriggerBuild')!.vars.gitRef).toBe('main')
  })

  it('triggers a build once: a known external id is read, not re-triggered', async () => {
    const d = desired({
      type: 'expo.build',
      fields: { project: { resourceId: 2 }, platform: 'ios', profile: 'production' },
      refs: { project: 'app-1' }
    })
    const [op] = expoAdapter.plan(setup().ctx, d, null)
    const fresh = setup((o) =>
      o === 'HubTriggerBuild'
        ? {
            data: {
              build: {
                triggerBuildFromGit: {
                  id: 'bld-2',
                  status: 'NEW',
                  platform: 'IOS',
                  buildProfile: 'production'
                }
              }
            }
          }
        : undefined
    )
    const res = await expoAdapter.apply(fresh.ctx, op, d)
    expect(res).toMatchObject({ externalId: 'app-1:bld-2', observed: { status: 'new' } })
    expect(fresh.sent.find((s) => s.op === 'HubTriggerBuild')!.vars).toMatchObject({
      appId: 'app-1',
      platform: 'IOS',
      profile: 'production'
    })
    const known = setup()
    await expoAdapter.apply(known.ctx, op, { ...d, externalId: 'app-1:bld-1' })
    expect(known.sent.some((s) => s.op === 'HubTriggerBuild')).toBe(false)
  })

  it('delete is idempotent: a missing branch deletes nothing', async () => {
    const { ctx, sent } = setup()
    const res = await expoAdapter.apply(
      ctx,
      {
        kind: 'delete',
        type: 'expo.branch',
        resourceId: 1,
        externalId: 'app-1:gone',
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(res.ok).toBe(true)
    expect(sent.some((s) => s.op === 'HubDeleteBranch')).toBe(false)
  })
})

describe('expo adapter: errors', () => {
  it('maps GraphQL errors with HTTP 200 to ProviderError', async () => {
    const { ctx } = setup(() => ({ errors: [{ message: 'Something is wrong' }] }))
    const err = await expoAdapter.observe(ctx, 'expo.branch', 'app-1:x').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'EXPO_GRAPHQL', retryable: false })
  })

  it('maps 429 to retryable and 5xx to retryable', async () => {
    for (const status of [429, 503]) {
      const { ctx } = setup(() => ({ errors: [{ message: 'slow down' }] }), status)
      const err = await expoAdapter.observe(ctx, 'expo.project', 'app-1').catch((e) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect(err.retryable).toBe(true)
      expect(err.status).toBe(status)
    }
    const rate = setup(() => ({
      errors: [{ message: 'Too many', extensions: { errorCode: 'RATE_LIMIT_EXCEEDED' } }]
    }))
    const e2 = await expoAdapter.observe(rate.ctx, 'expo.project', 'app-1').catch((e) => e)
    expect(e2).toMatchObject({ code: 'EXPO_RATE_LIMITED', retryable: true })
  })

  it('a 401 is not retryable', async () => {
    const { ctx } = setup(() => ({ errors: [{ message: 'bad token' }] }), 401)
    const err = await expoAdapter.observe(ctx, 'expo.project', 'app-1').catch((e) => e)
    expect(err).toMatchObject({ code: 'EXPO_AUTH', retryable: false })
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = setup(() => ({
      errors: [{ message: `Invalid token ${TOKEN} for robot` }]
    }))
    const err = await expoAdapter.observe(ctx, 'expo.project', 'app-1').catch((e) => e)
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).toContain('••••')
    const t = await expoAdapter
      .testConnection(setup(() => ({ errors: [{ message: `Invalid token ${TOKEN}` }] }), 200).ctx)
      .catch((e) => e)
    expect(JSON.stringify(t)).not.toContain(TOKEN)
  })

  it('refuses a host other than api.expo.dev', async () => {
    const { ctx } = setup()
    await expect(ctx.fetch('https://example.com/graphql')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
  })
})

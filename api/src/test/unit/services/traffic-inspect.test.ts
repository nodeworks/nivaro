// api/src/test/unit/services/traffic-inspect.test.ts
// Traffic Map drill-down Wave 0: the inspect source registry and its generic routes.
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectCoreRoutes } from '../../../routes/traffic-map-extras/inspect-core.js'
import {
  type InspectCtx,
  type InspectSource,
  inspectKinds,
  inspectSource,
  parseInspectAt,
  parseInspectWindow,
  registerInspectSource,
  resetInspectSources
} from '../../../services/traffic-inspect.js'

const UUID_RE = /^[0-9a-f-]{36}$/i

function source(over: Partial<InspectSource> = {}): InspectSource {
  return {
    kind: 'request',
    validId: (id) => UUID_RE.test(id),
    detail: async (id) => ({ id }),
    ...over
  }
}

async function app() {
  const a = Fastify()
  await a.register(inspectCoreRoutes, { prefix: '/traffic-map' })
  await a.ready()
  return a
}

afterEach(() => resetInspectSources())

describe('inspect registry', () => {
  it('replaces a source registered again under the same kind', () => {
    registerInspectSource(source({ detail: async () => 'first' }))
    const second = source({ detail: async () => 'second' })
    registerInspectSource(second)
    registerInspectSource(source({ kind: 'job-run' }))
    expect(inspectSource('request')).toBe(second)
    expect(inspectKinds()).toEqual(['job-run', 'request'])
    expect(inspectSource('nope')).toBeNull()
  })
  it('refuses a kind outside the pattern and a source without detail', () => {
    expect(() => registerInspectSource(source({ kind: 'Bad Kind' }))).toThrow(/kind must match/)
    expect(() => registerInspectSource(source({ kind: 'x' }))).toThrow(/kind must match/)
    expect(() =>
      registerInspectSource({ kind: 'okay', validId: () => true } as unknown as InspectSource)
    ).toThrow(/validId and detail/)
  })
  it('parses at and window', () => {
    expect(parseInspectAt('1800000000000')).toBe(1_800_000_000_000)
    expect(parseInspectAt('')).toBeNull()
    expect(parseInspectAt('soon')).toBeNull()
    expect(parseInspectWindow(undefined)).toBe(300)
    expect(parseInspectWindow('60')).toBe(60)
    expect(parseInspectWindow('999999')).toBe(86_400)
    expect(parseInspectWindow('-5')).toBe(300)
  })
})

describe('inspect routes', () => {
  const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('lists kinds', async () => {
    registerInspectSource(source())
    const a = await app()
    const res = await a.inject({ url: '/traffic-map/inspect/kinds' })
    expect(res.json()).toEqual({ data: ['request'] })
    await a.close()
  })
  it('answers detail with the window and anchor the source asked for', async () => {
    let seen: InspectCtx | null = null
    registerInspectSource(
      source({
        detail: async (id, ctx) => {
          seen = ctx
          return { id, ok: true }
        }
      })
    )
    const a = await app()
    const res = await a.inject({
      url: `/traffic-map/inspect/request/${RID}?at=1800000000000&window=60`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { id: RID, ok: true } })
    expect(seen).toMatchObject({ at: 1_800_000_000_000, windowSec: 60 })
    await a.close()
  })
  it('unknown kind → 404 INSPECT_KIND_UNKNOWN; bad id → 400 INSPECT_ID_INVALID', async () => {
    registerInspectSource(source())
    const a = await app()
    const unknown = await a.inject({ url: `/traffic-map/inspect/widget/${RID}` })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().code).toBe('INSPECT_KIND_UNKNOWN')
    const bad = await a.inject({ url: "/traffic-map/inspect/request/1';DROP" })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('INSPECT_ID_INVALID')
    const badPeek = await a.inject({ url: '/traffic-map/inspect/request/nope/peek' })
    expect(badPeek.statusCode).toBe(400)
    await a.close()
  })
  it('a validId that throws reads as invalid, not a 500', async () => {
    registerInspectSource(
      source({
        validId: () => {
          throw new Error('boom')
        }
      })
    )
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    expect(res.statusCode).toBe(400)
    await a.close()
  })
  it('null detail → 404 INSPECT_NOT_FOUND', async () => {
    registerInspectSource(source({ detail: async () => null }))
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('INSPECT_NOT_FOUND')
    await a.close()
  })
  it('a source throw → 500 with the reason, never the statement', async () => {
    const err = Object.assign(new Error('select * from nivaro_api_logs where id = @p0 - '), {
      errors: [new Error("Invalid column name 'request_id'.")]
    })
    registerInspectSource(
      source({
        detail: async () => {
          throw err
        }
      })
    )
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.code).toBe('INSPECT_FAILED')
    expect(body.error).toBe("Invalid column name 'request_id'.")
    expect(body.error).not.toMatch(/select/i)
    await a.close()
  })
  it('peek: derived when the source has none, the source answer otherwise', async () => {
    registerInspectSource(source())
    registerInspectSource(
      source({
        kind: 'job-run',
        validId: (id) => /^\d+$/.test(id),
        peek: async (id) => ({ title: `Run ${id}`, lines: ['ok'], at: null })
      })
    )
    registerInspectSource(source({ kind: 'gone', validId: () => true, peek: async () => null }))
    const a = await app()
    const derived = await a.inject({ url: `/traffic-map/inspect/request/${RID}/peek` })
    expect(derived.json()).toEqual({ data: { title: `request ${RID}`, lines: [] } })
    const own = await a.inject({ url: '/traffic-map/inspect/job-run/42/peek' })
    expect(own.json()).toEqual({ data: { title: 'Run 42', lines: ['ok'], at: null } })
    const none = await a.inject({ url: '/traffic-map/inspect/gone/x/peek' })
    expect(none.json()).toEqual({ data: null })
    await a.close()
  })
  it('an id carrying an encoded slash stays one id', async () => {
    registerInspectSource(source({ kind: 'entity', validId: (id) => /^[a-z]+\/[a-z_]+$/.test(id) }))
    const a = await app()
    const res = await a.inject({
      url: `/traffic-map/inspect/entity/${encodeURIComponent('items/workflows')}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { id: 'items/workflows' } })
    await a.close()
  })
})

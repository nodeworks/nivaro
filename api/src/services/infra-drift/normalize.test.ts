import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dockerGet,
  envDigestKeyId,
  sanitizeServiceSpec,
  setDockerFetchForTests
} from '../docker-source.js'
import { canonicalImage, diffStack, normalizeService, specFields } from './normalize.js'
import { findingLine, findingView, prepareBaseline, readLiveStack } from './store.js'

/**
 * Fixtures recorded from a throwaway docker:27-dind swarm (2026-10-22): `docker stack deploy`
 * of a two-service stack `efp` (inspect-baseline.json = `docker service inspect` right after the
 * deploy), then by hand `docker service update --env-add LOG_LEVEL=debug --env-add
 * DB_PASSWORD=rotated-by-hand --limit-memory 256M efp_api`, `docker service scale efp_worker=3`
 * and `docker service create --name efp_debug --label com.docker.stack.namespace=efp …`
 * (services-hand-run.json = the Engine's GET /services answer), then the same stack deployed
 * again (services-redeployed.json). Fixture secrets are fake.
 */
const here = dirname(fileURLToPath(import.meta.url))
const load = (f: string): unknown[] => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'))

const saved = { ...process.env }
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef'
  delete process.env.CLOUD_META_DB_URL
  process.env.DOCKER_HOSTS = 'production=http://proxy:2375'
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

/** Serves an Engine /services answer through docker-source exactly as a proxy would. */
function serve(fixture: string) {
  const calls: string[] = []
  setDockerFetchForTests(async (url) => {
    calls.push(url)
    return new Response(JSON.stringify(load(fixture)), { status: 200 })
  })
  return calls
}

async function baselineFromFixture() {
  return prepareBaseline({
    stack: 'efp',
    environment: 'production',
    version: '0.3.4',
    release: 'efp-2026.10.22-1',
    services: load('inspect-baseline.json')
  })
}

describe('sanitizeServiceSpec', () => {
  it('turns Env into a digest map: plain values kept, secret ones hashed, nothing else leaks', () => {
    const [api] = load('inspect-baseline.json')
    const clean = sanitizeServiceSpec(api) as any
    const cs = clean.Spec.TaskTemplate.ContainerSpec
    expect(cs.Env).toBeUndefined()
    expect(cs.EnvDigest.LOG_LEVEL).toBe('info')
    expect(cs.EnvDigest.PUBLIC_URL).toBe('https://efp.example.test')
    expect(cs.EnvDigest.DB_PASSWORD).toMatch(/^hmac:[0-9a-f]{32}$/)
    expect(JSON.stringify(clean)).not.toContain('hunter2')
  })

  it('a plain docker-source read still drops Env entirely', async () => {
    serve('services-hand-run.json')
    const raw = await dockerGet<any[]>({ name: 'h', url: 'http://p' }, '/services', { cacheMs: 0 })
    expect(JSON.stringify(raw)).not.toContain('EnvDigest')
    expect(JSON.stringify(raw)).not.toContain('LOG_LEVEL')
  })

  it('refuses the digest mode outside /services', async () => {
    serve('services-hand-run.json')
    await expect(
      dockerGet({ name: 'h', url: 'http://p' }, '/containers/json', { env: 'digest' })
    ).rejects.toThrow(/only read from \/services/)
  })
})

describe('specFields', () => {
  it('normalizes the recorded baseline', async () => {
    const b = await baselineFromFixture()
    expect(b.services.map((s) => s.name)).toEqual(['efp_api', 'efp_worker'])
    const f = b.services[0].fields
    expect(f.image).toBe(
      'traefik/whoami@sha256:43a68d10b9dfcfc3ffbfe4dd42100dc9aeaf29b3a5636c856337a5940f1b4f1c'
    )
    expect(f.mode).toBe('replicated')
    expect(f.replicas).toBe('2')
    expect(f.mounts).toBe('bind /tmp → /host-tmp (ro)\nvolume efp_data → /data')
    expect(f.secrets).toBe('efp_db_pass → db_password')
    expect(f['resources.limits']).toBe('cpus=0.5 memory=128 MiB')
    expect(f['resources.reservations']).toBe('memory=32 MiB')
    expect(f['placement.constraints']).toBe('node.role == manager')
    expect(f.read_only).toBe('true')
    expect(f.cap_drop).toBe('ALL')
    expect(f.healthcheck).toBe('CMD /whoami --help interval=30s timeout=5s retries=3')
    expect(f['labels.traefik.enable']).toBe('true')
    // Stack-generated labels are not fields.
    expect(Object.keys(f).some((k) => k.includes('com.docker.stack'))).toBe(false)
    // Swarm defaults the CLI fills in are dropped; what the stack file set stays.
    expect(f.update_config).toBe('{"Order":"start-first"}')
    expect(f.restart_policy).toBeUndefined()
  })

  it('a CLI inspect (defaults filled in) and a plain Engine read of one spec are equal', () => {
    const cli = normalizeService(sanitizeServiceSpec(load('same-spec-cli-inspect.json')[0]))
    const engine = normalizeService(
      sanitizeServiceSpec(
        JSON.parse(readFileSync(join(here, 'fixtures', 'same-spec-engine-read.json'), 'utf8'))
      )
    )
    expect(engine.version).toBe(cli.version)
    expect(engine.fields).toEqual(cli.fields)
  })

  it('ignores the tag when the digest is the same, compares the full ref without one', () => {
    expect(canonicalImage('a/b:1.0@sha256:x')).toBe(canonicalImage('a/b:2.0@sha256:x'))
    expect(canonicalImage('reg:5000/a/b:1.0@sha256:x')).toBe('reg:5000/a/b@sha256:x')
    expect(canonicalImage('a/b:1.0')).not.toBe(canonicalImage('a/b:2.0'))
  })

  it('absent and empty are the same field', () => {
    expect(specFields({ TaskTemplate: { ContainerSpec: { Mounts: [] } } })).toEqual(
      specFields({ TaskTemplate: { ContainerSpec: {} } })
    )
  })
})

describe('diffStack on the recorded hand-run update', () => {
  it('flags every hand change, labels it hand-run, and never shows the secret', async () => {
    const b = await baselineFromFixture()
    serve('services-hand-run.json')
    const live = await readLiveStack({ name: 'production', url: 'http://proxy:2375' }, 'efp')
    const items = diffStack(b.services, live)
    const byKey = Object.fromEntries(items.map((i) => [`${i.service} ${i.field}`, i]))

    expect(byKey['efp_api env.LOG_LEVEL']).toMatchObject({
      kind: 'changed',
      expected: 'info',
      actual: 'debug',
      secret: false,
      origin: 'hand-run'
    })
    expect(byKey['efp_api env.DB_PASSWORD']).toMatchObject({
      kind: 'changed',
      expected: null,
      actual: null,
      secret: true,
      origin: 'hand-run'
    })
    expect(byKey['efp_api resources.limits']).toMatchObject({
      expected: 'cpus=0.5 memory=128 MiB',
      actual: 'cpus=0.5 memory=256 MiB'
    })
    expect(byKey['efp_worker replicas']).toMatchObject({ expected: '1', actual: '3' })
    // Scaled once: swarm's previous spec is exactly the deployed one.
    expect(byKey['efp_worker replicas'].detail).toMatch(/one docker service update/)
    expect(byKey['efp_debug (service)']).toMatchObject({ kind: 'extra', origin: null })
    expect(items).toHaveLength(5)
    expect(JSON.stringify(items)).not.toContain('rotated-by-hand')
    expect(JSON.stringify(items)).not.toContain('hunter2')
  })

  it('after the next deploy only the service created outside it is left', async () => {
    const b = await baselineFromFixture()
    serve('services-redeployed.json')
    const live = await readLiveStack({ name: 'production', url: 'http://proxy:2375' }, 'efp')
    const items = diffStack(b.services, live)
    expect(items.map((i) => `${i.service} ${i.field} ${i.kind}`)).toEqual([
      'efp_debug (service) extra'
    ])
  })

  it('a baseline compared with itself is clean; a removed service is missing', async () => {
    const b = await baselineFromFixture()
    expect(diffStack(b.services, b.services)).toEqual([])
    const items = diffStack(b.services, b.services.slice(0, 1))
    expect(items).toMatchObject([{ service: 'efp_worker', kind: 'missing' }])
  })

  it('a different service id reads as recreated', async () => {
    const b = await baselineFromFixture()
    const live = b.services.map((s) => ({
      ...s,
      id: `${s.id}x`,
      fields: { ...s.fields, 'env.LOG_LEVEL': 'warn' }
    }))
    const items = diffStack(b.services, live)
    expect(items.find((i) => i.field === 'env.LOG_LEVEL')?.origin).toBe('recreated')
  })

  it('skips secret values hashed with another key, still compares the rest', async () => {
    const b = await baselineFromFixture()
    serve('services-hand-run.json')
    const live = await readLiveStack({ name: 'production', url: 'http://proxy:2375' }, 'efp')
    const items = diffStack(b.services, live, { secretsComparable: false })
    expect(items.some((i) => i.secret)).toBe(false)
    expect(items.some((i) => i.field === 'env.LOG_LEVEL')).toBe(true)
  })
})

describe('prepareBaseline', () => {
  it('validates the body', async () => {
    await expect(prepareBaseline({ stack: 'efp', environment: 'production' })).rejects.toThrow()
    await expect(
      prepareBaseline({ stack: '../x', environment: 'production', services: [] })
    ).rejects.toThrow(/stack/)
    await expect(
      prepareBaseline({ stack: 'efp', environment: 'production', services: 'x' })
    ).rejects.toThrow(/array/)
    await expect(
      prepareBaseline({ stack: 'efp', environment: 'production', services: [1] })
    ).rejects.toThrow(/inspect object/)
    await expect(
      prepareBaseline({
        stack: 'efp',
        environment: 'production',
        services: new Array(201).fill({})
      })
    ).rejects.toThrow(/At most/)
  })

  it('keeps only the stack namespace and reports the rest as ignored', async () => {
    const other = {
      ID: 'z',
      Spec: { Name: 'gitlab_web', Labels: { 'com.docker.stack.namespace': 'gitlab' } }
    }
    const b = await prepareBaseline({
      stack: 'efp',
      environment: 'production',
      services: [...load('inspect-baseline.json'), other]
    })
    expect(b.services).toHaveLength(2)
    expect(b.ignored).toEqual(['gitlab_web'])
  })

  it('reads the live stack through docker-source when services are not sent', async () => {
    const calls = serve('services-hand-run.json')
    const b = await prepareBaseline({ stack: 'efp', environment: 'production' })
    expect(b.source).toBe('live')
    expect(b.services.map((s) => s.name).sort()).toEqual(['efp_api', 'efp_debug', 'efp_worker'])
    expect(decodeURIComponent(calls[0])).toContain(
      'filters={"label":["com.docker.stack.namespace=efp"]}'
    )
  })

  it('says there is no live source instead of pretending', async () => {
    delete process.env.DOCKER_HOSTS
    await expect(prepareBaseline({ stack: 'efp', environment: 'production' })).rejects.toThrow(
      /No live source — set DOCKER_HOSTS/
    )
  })

  it('the stored baseline never holds a secret in clear', async () => {
    const b = await baselineFromFixture()
    expect(JSON.stringify(b.services)).not.toContain('hunter2')
    expect(envDigestKeyId()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('views', () => {
  it('a secret finding shows only "set", never a hash', () => {
    const v = findingView({
      id: 1,
      baseline_id: 1,
      stack: 'efp',
      environment: 'production',
      service: 'efp_api',
      field: 'env.DB_PASSWORD',
      kind: 'changed',
      expected: null,
      actual: null,
      secret: 1,
      origin: 'hand-run',
      detail: null,
      fingerprint: 'f',
      first_seen: new Date(),
      last_seen: new Date(),
      resolved_at: null,
      alerted_at: null
    })
    expect(v).toMatchObject({ expected: 'set', actual: 'set', secret: true })
    expect(findingLine(v)).toBe('efp_api: env.DB_PASSWORD changed (docker service update)')
  })

  it('normalizeService keeps the previous spec only when asked', () => {
    const [svc] = load('services-hand-run.json')
    const clean = sanitizeServiceSpec(svc)
    expect(normalizeService(clean).previous).toBeUndefined()
    expect(normalizeService(clean, { withPrevious: true }).previous).toBeTruthy()
  })
})

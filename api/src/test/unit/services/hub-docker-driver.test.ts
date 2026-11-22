import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 4): the docker driver kind — config validation, token masking, no GitLab
// context, and the stack name on a placement.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { validateDockerDriverInput } from '../../../services/hub/docker/driver-config.js'
import {
  type DockerDriverRow,
  driverCtx,
  placementTargetRefusal,
  publicDriver,
  validateDriverInput,
  validatePlacementInput
} from '../../../services/hub/drivers.js'
import { HUB_MASK, sealSecret } from '../../../services/hub/secrets.js'

const KEY = 'd'.repeat(64)
const TOKEN = 'agent-token-plain'

const auto = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'automatic',
  wildcard_domain: 'apps.example.com'
}
const manual = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'manual',
  edge_target: 'edge.example.com'
}

function stored(over: Partial<DockerDriverRow> = {}): DockerDriverRow {
  return {
    id: 7,
    kind: 'docker',
    name: 'Swarm',
    config: {
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    },
    secret: sealSecret(TOKEN),
    ...over
  }
}

describe('docker driver validation', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  const code = (config: Record<string, unknown>) =>
    validateDriverInput({ kind: 'docker', name: 'Swarm', config, secret: TOKEN })

  it('accepts automatic and manual configs, normalised', () => {
    const a = code({
      ...auto,
      agent_url: 'https://Agent.Example.com/',
      wildcard_domain: '*.Apps.Example.com'
    })
    expect(a).toMatchObject({
      ok: true,
      row: {
        kind: 'docker',
        name: 'Swarm',
        config: {
          agent_url: 'https://agent.example.com',
          dns_mode: 'automatic',
          wildcard_domain: 'apps.example.com',
          edge_target: null
        }
      }
    })
    const m = code(manual)
    expect(m).toMatchObject({
      ok: true,
      row: {
        config: { dns_mode: 'manual', edge_target: 'edge.example.com', wildcard_domain: null }
      }
    })
    expect(code({ ...manual, edge_target: '203.0.113.7' }).ok).toBe(true)
    // The token is sealed, never stored as typed.
    if (m.ok) {
      expect(m.row.secret).not.toBe(TOKEN)
      expect(m.row.secret).toBeTruthy()
    }
  })

  it('agent_url: https, or http only for plainHttpAllowed() hosts', () => {
    expect(code({ ...auto, agent_url: 'http://agent.example.com' })).toMatchObject({
      ok: false,
      code: 'BAD_CONFIG'
    })
    for (const ok of ['http://10.0.0.5:8088', 'http://hub-agent:8088', 'http://127.0.0.1:8088'])
      expect(code({ ...auto, agent_url: ok }).ok).toBe(true)
  })

  it('agent_url: no credentials, no path, no query', () => {
    for (const bad of [
      'https://u:p@agent.example.com',
      'https://u@agent.example.com',
      'https://agent.example.com/v1',
      'https://agent.example.com/?x=1',
      'https://agent.example.com/#f',
      'ftp://agent.example.com',
      'not a url',
      5
    ])
      expect([bad, code({ ...auto, agent_url: bad })]).toEqual([
        bad,
        expect.objectContaining({ ok: false, code: 'BAD_CONFIG' })
      ])
  })

  it('dns_mode missing, automatic without wildcard, manual without edge → BAD_CONFIG', () => {
    expect(code({ agent_url: auto.agent_url, wildcard_domain: 'apps.example.com' })).toMatchObject({
      code: 'BAD_CONFIG'
    })
    expect(code({ ...auto, dns_mode: 'magic' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...auto, wildcard_domain: undefined })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...auto, wildcard_domain: 'not a domain' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...auto, wildcard_domain: 'localhost' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...manual, edge_target: undefined })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...manual, edge_target: 'bad target!' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(code({ ...auto, extra: 1 })).toMatchObject({ code: 'BAD_CONFIG' })
  })

  it('SECRET_REQUIRED when the agent origin changes and the token is kept', () => {
    const existing = stored()
    expect(
      validateDriverInput({ config: { agent_url: 'https://other.example.com' } }, existing)
    ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
    expect(
      validateDriverInput(
        { config: { agent_url: 'https://other.example.com' }, secret: HUB_MASK },
        existing
      )
    ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
    // Same origin, or a new token: fine.
    expect(
      validateDriverInput({ config: { agent_url: 'https://agent.example.com/' } }, existing).ok
    ).toBe(true)
    const fresh = validateDriverInput(
      { config: { agent_url: 'https://other.example.com' }, secret: 'new-token' },
      existing
    )
    expect(fresh.ok).toBe(true)
    // A PATCH of the DNS mode alone keeps the rest of the config and the token.
    const m = validateDriverInput(
      { config: { dns_mode: 'manual', edge_target: '198.51.100.4' } },
      existing
    )
    expect(m).toMatchObject({
      ok: true,
      row: {
        secret: existing.secret,
        config: {
          agent_url: 'https://agent.example.com',
          dns_mode: 'manual',
          wildcard_domain: 'apps.example.com',
          edge_target: '198.51.100.4'
        }
      }
    })
  })

  it('SECRET_REQUIRED on a scheme change or a port change of the agent', () => {
    const plain = stored({
      config: {
        agent_url: 'https://hub-agent:8443',
        dns_mode: 'manual',
        wildcard_domain: null,
        edge_target: 'edge.example.com'
      }
    })
    expect(
      validateDriverInput({ config: { agent_url: 'http://hub-agent:8443' } }, plain)
    ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
    expect(
      validateDriverInput({ config: { agent_url: 'https://hub-agent:9443' } }, plain)
    ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
    expect(
      validateDriverInput(
        { config: { agent_url: 'https://agent.example.com:9443' }, secret: HUB_MASK },
        stored()
      )
    ).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' })
  })

  it('validateDockerDriverInput is the docker branch of validateDriverInput', () => {
    expect(validateDockerDriverInput({ name: 'S', config: auto, secret: TOKEN }).ok).toBe(true)
    expect(validateDockerDriverInput({ name: '', config: auto })).toMatchObject({
      code: 'BAD_NAME'
    })
  })

  it("a driver's kind never changes; an unknown kind is refused", () => {
    expect(validateDriverInput({ kind: 'gitlab' }, stored())).toMatchObject({
      ok: false,
      code: 'BAD_KIND'
    })
    expect(validateDriverInput({ kind: 'k8s', name: 'x', config: auto })).toMatchObject({
      code: 'BAD_KIND'
    })
  })

  it('publicDriver masks the agent token', () => {
    const shown = publicDriver(stored())
    expect(shown.secret).toBe(HUB_MASK)
    expect(JSON.stringify(shown)).not.toContain(TOKEN)
    expect(shown).toMatchObject({
      kind: 'docker',
      config: { agent_url: 'https://agent.example.com' }
    })
    expect(publicDriver(stored({ secret: null })).secret).toBeNull()
  })

  it('driverCtx of a docker driver throws DRIVER_MISCONFIGURED', () => {
    expect(() => driverCtx(stored())).toThrow(
      expect.objectContaining({ code: 'DRIVER_MISCONFIGURED' })
    )
  })
})

describe('placement target.stack', () => {
  const p = (target: Record<string, unknown>) =>
    validatePlacementInput({ kind: 'dedicated', driver_id: 1, target })

  it('accepts a stack name and keeps branch working', () => {
    expect(p({ stack: 'efp-prod' })).toMatchObject({
      ok: true,
      row: { target: { stack: 'efp-prod' } }
    })
    expect(p({ branch: 'production' })).toMatchObject({
      ok: true,
      row: { target: { branch: 'production' } }
    })
  })

  it('stack only on docker, branch only on gitlab → BAD_TARGET', () => {
    expect(placementTargetRefusal('gitlab', { stack: 'efp-prod' })).toMatchObject({
      code: 'BAD_TARGET'
    })
    expect(placementTargetRefusal('docker', { branch: 'production' })).toMatchObject({
      code: 'BAD_TARGET'
    })
    expect(placementTargetRefusal('docker', { stack: 'efp-prod' })).toBeNull()
    expect(placementTargetRefusal('gitlab', { branch: 'production' })).toBeNull()
    expect(placementTargetRefusal('docker', {})).toBeNull()
  })

  it('refuses a bad stack name → BAD_TARGET', () => {
    for (const bad of ['E', 'efp_prod', '1efp', 'efp prod', 'a', `a${'b'.repeat(41)}`, 5, ''])
      expect([bad, p({ stack: bad })]).toEqual([
        bad,
        expect.objectContaining({ ok: false, code: 'BAD_TARGET' })
      ])
  })
})

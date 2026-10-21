import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DockerUnavailableError,
  dockerGet,
  dockerHosts,
  forEachDockerHost,
  ownerOf,
  setDockerFetchForTests
} from './docker-source.js'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.DOCKER_HOSTS
  delete process.env.DOCKER_API_URL
  delete process.env.CLOUD_META_DB_URL
  delete process.env.DOCKER_API_TOKEN
})
afterEach(() => {
  process.env = { ...saved }
  setDockerFetchForTests(null)
})

describe('dockerHosts', () => {
  it('parses DOCKER_HOSTS, dropping bad entries and duplicates', () => {
    process.env.DOCKER_HOSTS =
      'staging=http://a:2375/, bad, x=ftp://y, staging=http://b, prod=https://c'
    expect(dockerHosts()).toEqual([
      { name: 'staging', url: 'http://a:2375' },
      { name: 'prod', url: 'https://c' }
    ])
  })

  it('falls back to DOCKER_API_URL and is empty in cloud mode', () => {
    process.env.DOCKER_API_URL = 'http://proxy:2375'
    expect(dockerHosts()).toEqual([{ name: 'local', url: 'http://proxy:2375' }])
    process.env.CLOUD_META_DB_URL = 'x'
    expect(dockerHosts()).toEqual([])
  })
})

describe('dockerGet', () => {
  const host = { name: 'h', url: 'http://proxy' }

  it('refuses paths outside the allowlist', async () => {
    await expect(dockerGet(host, '/containers/abc/logs')).rejects.toBeInstanceOf(
      DockerUnavailableError
    )
    await expect(dockerGet(host, '/exec/1/start')).rejects.toBeInstanceOf(DockerUnavailableError)
    await expect(dockerGet(host, '/containers/../exec')).rejects.toBeInstanceOf(
      DockerUnavailableError
    )
  })

  it('GETs, encodes filters, caches and names a proxy refusal', async () => {
    const calls: string[] = []
    setDockerFetchForTests(async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url.includes('/secrets')) return new Response('no', { status: 403 })
      return new Response(JSON.stringify([{ Id: '1' }]), { status: 200 })
    })
    const q = { filters: { label: ['a=b'] } }
    expect(await dockerGet(host, '/containers/json', { query: q })).toEqual([{ Id: '1' }])
    await dockerGet(host, '/containers/json', { query: q })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(
      `GET http://proxy/containers/json?filters=${encodeURIComponent('{"label":["a=b"]}')}`
    )
    await expect(dockerGet(host, '/secrets')).rejects.toThrow(/section not enabled/)
  })

  it('reports each host on its own', async () => {
    process.env.DOCKER_HOSTS = 'a=http://a,b=http://b'
    setDockerFetchForTests(async (url) =>
      url.startsWith('http://a') ? new Response('{}') : new Response('x', { status: 500 })
    )
    const out = await forEachDockerHost((h) => dockerGet(h, '/info'))
    expect(out[0]).toEqual({ host: 'a', data: {}, error: null })
    expect(out[1].error).toMatch(/HTTP 500/)
  })
})

it('ownerOf reads stack and compose labels', () => {
  expect(ownerOf({ 'com.docker.stack.namespace': 's', 'com.docker.compose.project': 'p' })).toEqual(
    { stack: 's', service: null, compose_project: 'p', compose_service: null }
  )
})

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Ruling P5-13: the release image HEALTHCHECK probes the tenant-free
// /api/ready whenever the process is multi-tenant (the same rule as
// isMultiTenant(): CLOUD_META_DB_URL, or a non-blank HUB_SHARED_DEPLOYMENT).
// A shared deployment resolves 127.0.0.1 as an unknown app (503/404), so
// /api/version there marked the container unhealthy forever. Run for real
// with a stub wget on PATH that prints the URL it was given.

const SCRIPT = resolve(__dirname, '../../../../../deploy/image/healthcheck.sh')

function probedUrl(env: Record<string, string> = {}): string {
  const bin = mkdtempSync(join(tmpdir(), 'hc-'))
  const stub = join(bin, 'wget')
  writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf "%s" "$last"\n')
  chmodSync(stub, 0o755)
  return execFileSync('sh', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...env }
  }).toString()
}

describe('release image healthcheck path', () => {
  it('self-hosted probes /api/version', () => {
    expect(probedUrl()).toBe('http://127.0.0.1:3055/api/version')
    expect(probedUrl({ PORT: '4000' })).toBe('http://127.0.0.1:4000/api/version')
  })

  it('cloud probes the tenant-free /api/ready (unchanged)', () => {
    expect(probedUrl({ CLOUD_META_DB_URL: 'postgres://meta' })).toBe(
      'http://127.0.0.1:3055/api/ready'
    )
  })

  it('a Hub shared deployment probes /api/ready too', () => {
    expect(probedUrl({ HUB_SHARED_DEPLOYMENT: 'demo' })).toBe('http://127.0.0.1:3055/api/ready')
    expect(probedUrl({ HUB_SHARED_DEPLOYMENT: 'demo', CLOUD_META_DB_URL: 'x' })).toBe(
      'http://127.0.0.1:3055/api/ready'
    )
  })

  it('a blank HUB_SHARED_DEPLOYMENT is not shared (same as isMultiTenant)', () => {
    expect(probedUrl({ HUB_SHARED_DEPLOYMENT: '' })).toBe('http://127.0.0.1:3055/api/version')
    expect(probedUrl({ HUB_SHARED_DEPLOYMENT: '   ' })).toBe('http://127.0.0.1:3055/api/version')
  })

  it('NIVARO_HEALTHCHECK_PATH still wins in every mode', () => {
    expect(probedUrl({ NIVARO_HEALTHCHECK_PATH: '/x', HUB_SHARED_DEPLOYMENT: 'demo' })).toBe(
      'http://127.0.0.1:3055/x'
    )
    expect(probedUrl({ NIVARO_HEALTHCHECK_PATH: '/x', CLOUD_META_DB_URL: 'y' })).toBe(
      'http://127.0.0.1:3055/x'
    )
  })
})

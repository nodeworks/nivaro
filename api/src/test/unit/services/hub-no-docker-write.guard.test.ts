import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard (Hub phase 4): the API process never writes to a Docker engine. Engine writes belong to
 * the Hub agent alone (packages/hub-agent); the API reads Docker only through
 * services/docker-source.ts (GET allow-list), which stays exactly as it is on main.
 *
 * Changing docker-source.ts on purpose: review that it is still GET-only, then update
 * DOCKER_SOURCE_SHA256 below in the same commit.
 */

// Hub phase 5 (cloud-flag split): dockerHosts() tests isMultiTenant() instead of reading
// CLOUD_META_DB_URL. Reviewed at the integration merge (ruling X-3): no new request path, no
// write, GET allow-list unchanged.
const DOCKER_SOURCE_SHA256 = 'ca0d9ad79c9eaa3fc2876fab75f487e2068378e14d01fb8e6931abd04fe31cc1'

const SRC = join(import.meta.dirname, '..', '..', '..')

/** Every source file under api/src, tests excluded. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name === 'test' || name === '__tests__' || name === 'node_modules') continue
        walk(p)
      } else if (
        /\.(ts|tsx|js|mjs|cjs)$/.test(name) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
      ) {
        out.push(p)
      }
    }
  }
  walk(SRC)
  return out
}

/** Text that only Engine write code (or a raw socket) would contain. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['docker.sock', /docker\.sock/],
  ['socketPath', /\bsocketPath\b/],
  ['/services/create', /\/services\/create\b/],
  ['/services/<id>/update (template)', /\/services\/\$\{[^}]*\}\/update\b/],
  ['/containers/create', /\/containers\/create\b/],
  ['/secrets/create', /\/secrets\/create\b/]
]

const WRITE_METHOD = /\bmethod\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i
/** A Docker Engine path literal (optionally versioned), or the read-only client itself. */
const ENGINE_NEAR =
  /['"`](?:\/v1\.\d+)?\/(?:containers|services|secrets|configs|images|networks|volumes|swarm|nodes|exec|plugins)(?:[/?'"`$]|\b)|\bdockerGet\b|docker-source/
const WINDOW = 6

describe('hub: no Docker engine writes in the API', () => {
  const files = sourceFiles()

  it('scans the API source (and skips tests)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.endsWith(join('services', 'docker-source.ts')))).toBe(true)
    expect(files.some((f) => /\.test\.ts$/.test(f))).toBe(false)
  })

  it('no file names a raw socket or an Engine create/update path', () => {
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const [label, re] of FORBIDDEN)
        if (re.test(text)) hits.push(`${relative(SRC, f)}: ${label}`)
    }
    expect(hits).toEqual([])
  })

  it('no non-GET method sits next to a dockerGet call or an Engine URL', () => {
    const hits: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!WRITE_METHOD.test(line)) return
        const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n')
        if (ENGINE_NEAR.test(near)) hits.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('services/docker-source.ts is byte-identical to main', () => {
    const bytes = readFileSync(join(SRC, 'services', 'docker-source.ts'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(DOCKER_SOURCE_SHA256)
  })

  it('the guard itself catches what it is meant to', () => {
    // Source text holding a template placeholder, spelled without one.
    const tpl = (path: string) => `\`${path.replace('{', '$' + '{')}\``
    expect(FORBIDDEN.some(([, re]) => re.test(tpl('/services/{id}/update')))).toBe(true)
    expect(FORBIDDEN.some(([, re]) => re.test("{ socketPath: '/var/run/docker.sock' }"))).toBe(true)
    expect(WRITE_METHOD.test("method: 'POST',")).toBe(true)
    expect(ENGINE_NEAR.test("dockerGet(host, '/info')")).toBe(true)
    expect(ENGINE_NEAR.test("'/v1.44/containers/create'")).toBe(true)
    // The Hub agent's own routes are not Engine paths.
    expect(ENGINE_NEAR.test(tpl('/v1/stacks/{name}/restart'))).toBe(false)
  })
})

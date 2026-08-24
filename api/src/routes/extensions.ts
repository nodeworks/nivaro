import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import {
  extensionRegistry,
  removeExtension,
  scanNewExtensions,
  setExtensionEnabled
} from '../extensions/loader.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { inngest } from '../plugins/inngest.js'
import { logActivity } from '../services/activity.js'
import { callExternalApi } from '../services/external-apis.js'

// ─── Marketplace ──────────────────────────────────────────────────────────────

// api/src/routes → api/extensions (same resolution as extensions/loader.ts)
const EXTENSIONS_DIR = new URL('../../extensions', import.meta.url).pathname
const CONFIG_PATH = join(EXTENSIONS_DIR, '.config.json')
// Bundled example extensions shipped with the repo (dev installs only)
const BUILTIN_SOURCE_DIR = new URL('../../../examples/my-project/extensions', import.meta.url)
  .pathname

const SAFE_EXT_NAME = /^[a-z0-9][a-z0-9-]*$/
const MAX_TARBALL_BYTES = 20 * 1024 * 1024

interface MarketplaceEntry {
  name: string
  description: string
  version: string
  tarball_url?: string
  builtin?: boolean
}

const BUILTIN_EXTENSIONS: MarketplaceEntry[] = [
  {
    name: 'hello-world',
    version: '1.0.0',
    builtin: true,
    description:
      'Minimal starter extension — registers a /api/hello route and demonstrates the extension context.'
  },
  {
    name: 'example-flows',
    version: '1.0.0',
    builtin: true,
    description: 'Registers custom flow operations and triggers via the flows extension registry.'
  },
  {
    name: 'example-inngest',
    version: '1.0.0',
    builtin: true,
    description: 'Shows how to enqueue and handle background jobs through the Inngest client.'
  },
  {
    name: 'example-socketio',
    version: '1.0.0',
    builtin: true,
    description: 'Emits real-time Socket.io events from item hooks to connected admin clients.'
  },
  {
    name: 'example-ui-plugin',
    version: '1.0.0',
    builtin: true,
    description: 'UI plugin with a manifest.json bundle that injects panels into admin UI slots.'
  }
]

function readExtConfig(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, boolean>
  } catch {
    return {}
  }
}

function writeExtConfig(config: Record<string, boolean>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * SSRF-guarded fetch: validates the URL (and every redirect hop, max 3) through
 * assertSafeUrl before following it. Redirects are handled manually so each
 * Location target is re-validated.
 */
async function safeFetch(rawUrl: string, timeoutMs = 30_000): Promise<Response> {
  let currentUrl = rawUrl
  for (let hop = 0; hop <= 3; hop++) {
    await assertSafeUrl(currentUrl)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(currentUrl, { signal: ctrl.signal, redirect: 'manual' })
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('Redirect without Location header')
      if (hop === 3) throw new Error('Too many redirects')
      currentUrl = new URL(loc, currentUrl).toString()
      continue
    }
    return res
  }
  throw new Error('Too many redirects')
}

/**
 * Minimal ustar tarball extractor (no external tar dependency).
 * Only writes regular files; sanitises every path against traversal.
 * Install scripts are NEVER executed — files are only copied to disk.
 */
function extractTarball(tarBuf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break // end-of-archive
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '')
    const sizeOctal = header.subarray(124, 136).toString('utf-8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeOctal || '0', 8)
    const typeFlag = String.fromCharCode(header[156])
    offset += 512
    if (Number.isNaN(size) || size < 0) break
    if (typeFlag === '0' || typeFlag === '\0') {
      // Strip leading "package/" (npm pack convention) and sanitise
      const stripped = name.replace(/^package\//, '').replace(/^\.\//, '')
      const safe = normalize(stripped)
      if (safe && !safe.startsWith('..') && !safe.startsWith('/') && !safe.includes('\0')) {
        files.set(safe, Buffer.from(tarBuf.subarray(offset, offset + size)))
      }
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

export async function extensionsRoutes(app: FastifyInstance) {
  // Public — no auth required. The admin SPA loads this before auth context is available.
  app.get('/manifest', async (_req, reply) => {
    const data = Array.from(extensionRegistry.values())
      .filter((e) => e.enabled && e.manifest?.uiBundle)
      .map((e) => ({
        id: e.id,
        name: e.manifest?.name ?? e.id,
        version: e.manifest?.version ?? null,
        bundleUrl: `/api/extensions/${e.id}/ui.js`,
        slots: e.manifest?.slots ?? [],
        cloud: e.cloud ?? false
      }))
    // Palette entries (#260): server extensions may declare command-palette
    // navigation entries — served beside the UI-bundle manifest so the
    // palette can merge them without an admin-gated call.
    const palette = Array.from(extensionRegistry.values())
      .filter((e) => e.enabled && (e.palette?.length ?? 0) > 0)
      .flatMap((e) => (e.palette ?? []).map((pp) => ({ ...pp, extension: e.id })))
    return reply.send({ data, palette })
  })

  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    // Cloud extensions are internal — hidden from the tenant Extensions page
    const data = Array.from(extensionRegistry.values()).filter((e) => !e.cloud)
    return reply.send({ data })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { enabled?: boolean }

    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: '`enabled` boolean is required' })
    }

    const ok = setExtensionEnabled(id, body.enabled)
    if (!ok) {
      return reply.code(404).send({ error: 'Extension not found or in error state' })
    }

    const entry = extensionRegistry.get(id)
    await logActivity({
      action: body.enabled ? 'enable' : 'disable',
      user: req.user?.id,
      collection: 'extensions',
      item: id,
      req
    })
    return reply.send({ data: entry })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const entry = extensionRegistry.get(id)
    if (!entry) return reply.code(404).send({ error: 'Extension not found' })
    if (entry.status !== 'missing') {
      return reply.code(400).send({ error: 'Only missing extensions can be deleted' })
    }
    removeExtension(id)
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'extensions',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // ─── GET /marketplace — registry index (env URL or built-in curated list) ──

  // ── Extension settings (#112) ─────────────────────────────────────────────
  app.get('/:id/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { extensionSettingsDecls, bustExtensionSettingsCache } = await import(
      '../extensions/loader.js'
    )
    void bustExtensionSettingsCache
    const decls = extensionSettingsDecls.get(id)
    if (!decls) return reply.code(404).send({ error: 'Extension declares no settings' })
    const rows = (await db('nivaro_extension_settings')
      .where({ extension_id: id })
      .select('key', 'value')) as Array<{ key: string; value: string | null }>
    const stored = new Map(rows.map((r) => [r.key, r.value]))
    return reply.send({
      data: decls.map((d) => ({
        ...d,
        value: d.secret && stored.get(d.key) ? '••••••' : (stored.get(d.key) ?? d.default ?? null)
      }))
    })
  })

  app.put('/:id/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { values?: Record<string, string | null> }
    const { extensionSettingsDecls, bustExtensionSettingsCache } = await import(
      '../extensions/loader.js'
    )
    const decls = extensionSettingsDecls.get(id)
    if (!decls) return reply.code(404).send({ error: 'Extension declares no settings' })
    const declared = new Map(decls.map((d) => [d.key, d]))
    for (const [key, raw] of Object.entries(body?.values ?? {})) {
      const decl = declared.get(key)
      if (!decl) continue // undeclared keys are ignored, never stored
      // Masked secret re-submitted → keep the stored value.
      if (decl.secret && raw === '••••••') continue
      const value = raw == null ? null : String(raw).slice(0, 4000)
      const existing = await db('nivaro_extension_settings')
        .where({ extension_id: id, key })
        .first('id')
      if (existing) {
        await db('nivaro_extension_settings')
          .where({ id: existing.id })
          .update({ value, updated_at: new Date() })
      } else {
        await db('nivaro_extension_settings').insert({
          extension_id: id,
          key,
          value,
          updated_at: new Date()
        })
      }
    }
    bustExtensionSettingsCache(id)
    await logActivity({
      action: 'extension-settings-update',
      user: req.user?.id,
      comment: id,
      req
    })
    return reply.send({ data: { saved: true } })
  })

  // ── Health probes (#262) ──────────────────────────────────────────────────
  app.get('/:id/health', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { extensionHealthChecks } = await import('../extensions/loader.js')
    const check = extensionHealthChecks.get(id)
    if (!check) return reply.code(404).send({ error: 'Extension declares no health check' })
    try {
      const result = await Promise.race([
        check(),
        new Promise<{ ok: boolean; note: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, note: 'health check timed out (5s)' }), 5000)
        )
      ])
      return reply.send({ data: result })
    } catch (err) {
      return reply.send({
        data: { ok: false, note: err instanceof Error ? err.message : 'check threw' }
      })
    }
  })

  // ── Log channels (#427) ───────────────────────────────────────────────────
  app.get('/:id/logs', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { getExtensionLogs } = await import('../extensions/loader.js')
    return reply.send({ data: getExtensionLogs(id) })
  })

  // ── Starter scaffold (#181) ───────────────────────────────────────────────
  app.get('/scaffold', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8')
    reply.header('content-disposition', 'attachment; filename="index.ts"')
    return reply.send(EXTENSION_SCAFFOLD)
  })

  app.get('/marketplace', async (_req, reply) => {
    let entries: MarketplaceEntry[] = []
    let source = 'builtin'
    let registryError: string | undefined

    const registryUrl = process.env.EXTENSION_REGISTRY_URL
    if (registryUrl) {
      source = 'registry'
      try {
        const res = await safeFetch(registryUrl, 5000)
        if (!res.ok) throw new Error(`registry responded ${res.status}`)
        const json = (await res.json()) as { extensions?: MarketplaceEntry[] } | MarketplaceEntry[]
        entries = Array.isArray(json) ? json : (json.extensions ?? [])
      } catch (err) {
        registryError = err instanceof Error ? err.message : String(err)
        entries = []
      }
    } else {
      entries = BUILTIN_EXTENSIONS.filter((e) => existsSync(join(BUILTIN_SOURCE_DIR, e.name)))
    }

    const data = entries.map((e) => ({
      ...e,
      installed: existsSync(join(EXTENSIONS_DIR, e.name)) || extensionRegistry.has(e.name)
    }))
    return reply.send({ data, source, ...(registryError ? { error: registryError } : {}) })
  })

  // ─── POST /marketplace/install — copy built-in or download tarball ─────────

  app.post('/marketplace/install', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { name?: string; tarball_url?: string }
    const name = body?.name ?? ''
    if (!SAFE_EXT_NAME.test(name)) {
      return reply
        .code(400)
        .send({ error: 'Invalid extension name (lowercase letters, digits, hyphens)' })
    }
    const targetDir = join(EXTENSIONS_DIR, name)
    if (existsSync(targetDir)) {
      return reply.code(409).send({ error: `Extension "${name}" is already installed` })
    }

    try {
      if (body.tarball_url) {
        // Remote install — SSRF-guarded download, verify, extract.
        // Install scripts are never run.
        let res: Response
        try {
          res = await safeFetch(body.tarball_url)
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : 'Invalid tarball_url' })
        }
        if (!res.ok) return reply.code(502).send({ error: `Download failed (${res.status})` })
        const raw = Buffer.from(await res.arrayBuffer())
        if (raw.length > MAX_TARBALL_BYTES) {
          return reply.code(400).send({ error: 'Tarball exceeds 20 MB limit' })
        }
        // Gzipped (.tgz) or plain .tar
        let tarBuf = raw
        if (raw[0] === 0x1f && raw[1] === 0x8b) tarBuf = gunzipSync(raw)
        const files = extractTarball(tarBuf)
        if (!files.has('index.js') || !files.has('manifest.json')) {
          return reply
            .code(400)
            .send({ error: 'Tarball must contain index.js and manifest.json at its root' })
        }
        await mkdir(targetDir, { recursive: true })
        for (const [rel, content] of files) {
          const dest = join(targetDir, rel)
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, content)
        }
      } else {
        // Built-in install — copy from the bundled examples directory
        const sourceDir = join(BUILTIN_SOURCE_DIR, name)
        if (!existsSync(sourceDir)) {
          return reply
            .code(404)
            .send({ error: `Built-in extension "${name}" not found on this server` })
        }
        await cp(sourceDir, targetDir, { recursive: true })
      }

      // Enable in .config.json
      const config = readExtConfig()
      config[name] = true
      writeExtConfig(config)

      // Load it
      const loaded = await scanNewExtensions({
        app,
        database: db,
        inngest,
        logger: app.log,
        callExternalApi
      })
      const entry = extensionRegistry.get(name)
      await logActivity({
        action: 'install',
        user: req.user?.id,
        collection: 'extensions',
        item: name,
        req
      })
      return reply
        .code(201)
        .send({ data: { name, loaded: loaded.includes(name), entry: entry ?? null } })
    } catch (err) {
      // Clean up a half-written install
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
      const msg = err instanceof Error ? err.message : String(err)
      app.log.error({ err, name }, 'Marketplace install failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /marketplace/uninstall — remove dir + config entry ──────────────

  app.post('/marketplace/uninstall', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { name?: string }
    const name = body?.name ?? ''
    if (!SAFE_EXT_NAME.test(name)) {
      return reply.code(400).send({ error: 'Invalid extension name' })
    }
    const targetDir = join(EXTENSIONS_DIR, name)
    if (!existsSync(targetDir) && !extensionRegistry.has(name)) {
      return reply.code(404).send({ error: `Extension "${name}" is not installed` })
    }
    try {
      await rm(targetDir, { recursive: true, force: true })
      removeExtension(name) // clears registry entry, hooks, and .config.json key
      await logActivity({
        action: 'uninstall',
        user: req.user?.id,
        collection: 'extensions',
        item: name,
        req
      })
      return reply.send({
        data: {
          name,
          uninstalled: true,
          note: 'A restart is recommended to fully unload extension code.'
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  app.post('/reload', async (req, reply) => {
    const newIds = await scanNewExtensions({
      app,
      database: db,
      inngest,
      logger: app.log,
      callExternalApi
    })
    await logActivity({
      action: 'extension-reload',
      user: req.user?.id,
      req,
      comment: newIds.length > 0 ? `loaded: ${newIds.join(', ')}` : 'no new extensions'
    })
    const data = Array.from(extensionRegistry.values())
    return reply.send({ data, loaded: newIds })
  })
}


// Starter extension (#181): everything a first extension needs — typed ctx,
// a hook, a cron, a route, a setting, a health check.
const EXTENSION_SCAFFOLD = `// my-extension/index.ts — drop this folder into api/extensions/
// Dev runs .ts directly (tsx); production deployments compile to index.js.
export default {
  id: 'my-extension',

  // Shown on the Extensions page before enabling — declare what you touch.
  scopes: ['hooks:articles', 'cron', 'routes'],

  // Admin-editable settings (Extensions page) — read via ctx.settings.get().
  settings: [
    { key: 'greeting', label: 'Greeting text', type: 'string', default: 'hello' }
  ],

  // Quick self-check surfaced on the Extensions page.
  async healthCheck() {
    return { ok: true, note: 'all good' }
  },

  async register({ app, database, logger, hooks, cron, settings }) {
    // A route under /api
    app.register(
      async (f) => {
        f.get('/my-extension/ping', async () => ({
          ok: true,
          greeting: (await settings?.get('greeting')) ?? 'hello'
        }))
      },
      { prefix: '/api' }
    )

    // React to writes (RBAC/validation already ran)
    hooks.after('articles', 'create', async ({ item }) => {
      logger.info({ item }, 'article created')
    })

    // Scheduled work — appears on /background-jobs automatically
    cron.schedule('nightly', '0 3 * * *', async () => {
      const count = await database('articles').count('* as c').first()
      logger.info({ count }, 'nightly article count')
    })
  }
}
`

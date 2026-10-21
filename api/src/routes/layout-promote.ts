import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import type { ConfigSnapshot } from '../services/config-inventory.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import { partitionSelf } from '../services/environment-self.js'
import {
  bundleFromRows,
  type LayoutBundle,
  loadLayoutBundle,
  runLayoutOps
} from '../services/layout-ops.js'
import { isRowId } from '../services/layout-patch.js'
import {
  isLayoutExportFile,
  type LayoutExportFile,
  matchLayout,
  planLayoutPromotion
} from '../services/layout-promote.js'
import { promotionSkips } from '../services/layout-promote-skips.js'
import { snapshotLayoutVersion } from '../services/layout-versions.js'
import { NIVARO_VERSION } from '../version.js'
import { fetchJson, tokenRefusal } from './environments.js'

/**
 * Promote one layout between environments (#2593).
 *
 * PULL only: this instance reads the other environment's copy and applies it
 * HERE — nothing is ever pushed. The other copy comes from an Environments
 * registry API component (server-side, with that component's stored token,
 * the settings-compare precedent; tokens never reach the browser) or from an
 * uploaded file: a "Download this layout" export or a Config Diff snapshot.
 * Applying saves a layout version first (History → Restore undoes it) and goes
 * through the editor's own ops path, so the rev check, versions and the
 * config:update push all behave as an ordinary save.
 */

interface CandidateLayout {
  id: number
  name: string
  slug: string | null
  layout_type: string | null
}

interface Source {
  label: string
  environment: string | null
  version: string | null
  candidates: CandidateLayout[]
  load: (id: number) => Promise<LayoutBundle>
}

class SourceError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type PromoteBody = {
  component_id?: unknown
  file?: unknown
  remote_layout_id?: unknown
  base_rev?: unknown
}

const asCandidate = (r: Record<string, unknown>): CandidateLayout => ({
  id: Number(r.id),
  name: String(r.name ?? ''),
  slug: r.slug == null ? null : String(r.slug),
  layout_type: r.layout_type == null ? null : String(r.layout_type)
})

/** Another environment's API component, read with its own stored token. */
async function remoteSource(req: FastifyRequest, componentId: number, collection: string) {
  const comp = (await db('nivaro_environment_components')
    .where({ id: componentId, kind: 'api' })
    .first('id', 'environment', 'name', 'base_url', 'api_token')) as
    | {
        id: number
        environment: number
        name: string
        base_url: string | null
        api_token: string | null
      }
    | undefined
  if (!comp?.base_url) throw new SourceError(404, 'That environment has no API address')
  const envs = (await db('nivaro_environments').select('id', 'name')) as Array<{
    id: number
    name: string
  }>
  const { probe } = partitionSelf([comp], envs, req.host)
  if (!probe.length) throw new SourceError(400, 'That component is this instance')
  if (!comp.api_token)
    throw new SourceError(400, 'That component has no API token — add one on Environments')
  const envName = envs.find((e) => e.id === comp.environment)?.name ?? null
  const base = comp.base_url.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${comp.api_token}` }
  const read = async (path: string) => {
    let res: Awaited<ReturnType<typeof fetchJson>>
    try {
      res = await fetchJson(`${base}${path}`, headers, 15_000)
    } catch (err) {
      const cause = (err as { cause?: { code?: string } })?.cause?.code
      throw new SourceError(502, `Could not reach ${comp.name}${cause ? ` (${cause})` : ''}`)
    }
    const refused = tokenRefusal(res)
    if (refused) throw new SourceError(502, refused)
    return res
  }
  const version = await read('/api/version').catch(() => null)
  const list = await read(`/api/collection-layouts?collection=${encodeURIComponent(collection)}`)
  if (!list.ok) throw new SourceError(502, `${comp.name} answered HTTP ${list.status}`)
  const rows = ((list.body as { data?: unknown })?.data ?? []) as Array<Record<string, unknown>>
  return {
    label: `${envName ?? 'Environment'} · ${comp.name}`,
    environment: envName,
    version:
      version?.ok && typeof (version.body as { version?: unknown })?.version === 'string'
        ? String((version.body as { version: string }).version)
        : null,
    candidates: rows.map(asCandidate),
    load: async (id: number) => {
      const res = await read(`/api/collection-layouts/${id}/bundle`)
      if (res.status === 404)
        throw new SourceError(
          502,
          `${comp.name} cannot hand over a layout (an older version, or the layout is gone). Download a config snapshot there and upload it here instead.`
        )
      if (!res.ok) throw new SourceError(502, `${comp.name} answered HTTP ${res.status}`)
      const b = res.body as LayoutBundle
      if (!b?.layout || !Array.isArray(b.groups) || !Array.isArray(b.placements))
        throw new SourceError(502, `${comp.name} sent something that is not a layout`)
      return b
    }
  } satisfies Source
}

/** A layout export, or the layout tables of a Config Diff snapshot. */
function fileSource(file: unknown, collection: string): Source {
  if (isLayoutExportFile(file)) {
    const f = file as LayoutExportFile
    if (String(f.bundle.layout.collection) !== collection)
      throw new SourceError(
        400,
        `That file holds a layout of ${String(f.bundle.layout.collection)}`
      )
    return {
      label: `File from ${f.instance?.environment ?? 'another environment'}`,
      environment: f.instance?.environment ?? null,
      version: f.instance?.version ?? null,
      candidates: [asCandidate(f.bundle.layout)],
      load: async () => f.bundle
    }
  }
  const snap = file as ConfigSnapshot | null
  if (!snap || typeof snap !== 'object' || snap.format !== 1 || !snap.tables)
    throw new SourceError(400, 'Upload a layout file or a Config Diff snapshot')
  const rowsOf = (t: string) =>
    Object.values(snap.tables[t] ?? {})
      .map((r) => r?.data)
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
  const layouts = rowsOf('nivaro_collection_layouts').filter((l) => l.collection === collection)
  if (!snap.tables.nivaro_collection_layouts)
    throw new SourceError(400, 'That snapshot does not carry nivaro_collection_layouts')
  const bySort = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Number(a.sort ?? 0) - Number(b.sort ?? 0) || Number(a.id ?? 0) - Number(b.id ?? 0)
  return {
    label: `Snapshot of ${snap.instance?.environment ?? 'another environment'}${snap.instance?.database ? ` (${snap.instance.database})` : ''}`,
    environment: snap.instance?.environment ?? null,
    version: snap.instance?.version ?? null,
    candidates: layouts.map(asCandidate),
    load: async (id: number) => {
      const raw = layouts.find((l) => Number(l.id) === id)
      if (!raw) throw new SourceError(404, 'That layout is not in the snapshot')
      const groups = rowsOf('nivaro_field_groups')
        .filter((g) => Number(g.layout_id) === id)
        .sort(bySort)
      const asg = rowsOf('nivaro_layout_field_assignments')
        .filter((a) => Number(a.layout_id) === id)
        .sort(bySort)
      return bundleFromRows(raw, groups, asg, '')
    }
  }
}

export async function layoutPromoteRoutes(app: FastifyInstance) {
  // GET /collection-layouts/promote/sources — the other environments' APIs this
  // instance can read a layout from (Environments registry; tokens stay here).
  app.get('/promote/sources', { preHandler: requireAdmin }, async (req) => {
    const envs = (await db('nivaro_environments')
      .orderBy('sort')
      .orderBy('id')
      .select('id', 'name')) as Array<{ id: number; name: string }>
    const comps = (await db('nivaro_environment_components')
      .where('kind', 'api')
      .orderBy('sort')
      .orderBy('id')
      .select('id', 'environment', 'name', 'base_url', 'api_token')) as Array<{
      id: number
      environment: number
      name: string
      base_url: string | null
      api_token: string | null
    }>
    const { probe } = partitionSelf(comps, envs, req.host)
    return {
      data: probe.map((c) => ({
        id: c.id,
        name: c.name,
        environment: envs.find((e) => e.id === c.environment)?.name ?? null,
        has_token: !!c.api_token
      }))
    }
  })

  // GET /collection-layouts/:id/export — this layout as a file another
  // environment can compare against (for environments that cannot reach this one).
  app.get('/:id/export', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const bundle = await loadLayoutBundle(db, Number(id))
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    const file: LayoutExportFile = {
      format: 'nivaro-layout',
      version: 1,
      exported_at: new Date().toISOString(),
      instance: { version: NIVARO_VERSION, environment: config.NODE_ENV },
      bundle
    }
    await logActivity({
      action: 'layout-export',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      req
    })
    const slug = String(bundle.layout.slug || bundle.layout.name || `layout-${id}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
    return reply
      .header('content-disposition', `attachment; filename="layout-${slug}.json"`)
      .send(file)
  })

  /** Resolve the source and the other copy; shared by preview and apply. */
  const prepare = async (req: FastifyRequest, mine: LayoutBundle, body: PromoteBody) => {
    const collection = String(mine.layout.collection)
    const source =
      body.component_id != null
        ? await remoteSource(req, Number(body.component_id), collection)
        : body.file != null
          ? fileSource(body.file, collection)
          : null
    if (!source) throw new SourceError(400, 'Pick an environment or upload a file')
    const asked = body.remote_layout_id != null ? Number(body.remote_layout_id) : null
    const match =
      asked != null
        ? (source.candidates.find((c) => c.id === asked) ?? null)
        : matchLayout({ name: mine.layout.name, slug: mine.layout.slug }, source.candidates)
    return { source, match }
  }

  const sendError = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    err: unknown
  ) => {
    if (err instanceof SourceError) return reply.code(err.status).send({ error: err.message })
    throw err
  }

  // POST /collection-layouts/:id/promote/preview — { component_id | file, remote_layout_id? }
  // → what applying the other copy would change here. Writes nothing.
  app.post(
    '/:id/promote/preview',
    { preHandler: requireAdmin, bodyLimit: 128 * 1024 * 1024 },
    async (req, reply) => {
      // Read-only POST under a metadata route: no cache flush, no config:update.
      markConfigRead(req)
      const { id } = req.params as { id: string }
      if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
      const mine = await loadLayoutBundle(db, Number(id))
      if (!mine) return reply.code(404).send({ error: 'Not found' })
      try {
        const { source, match } = await prepare(req, mine, (req.body ?? {}) as PromoteBody)
        const head = {
          source: { label: source.label, environment: source.environment, version: source.version },
          candidates: source.candidates,
          base_rev: mine.rev
        }
        if (!match) return reply.send({ data: { ...head, theirs: null, plan: null } })
        const theirs = await source.load(match.id)
        const plan = planLayoutPromotion(mine, theirs, await promotionSkips(mine, theirs))
        return reply.send({
          data: {
            ...head,
            theirs: match,
            plan: { changes: plan.changes, ops: plan.ops.length, exact: plan.exact }
          }
        })
      } catch (err) {
        return sendError(reply, err)
      }
    }
  )

  // POST /collection-layouts/:id/promote/apply — same body + base_rev. Saves a
  // version of this layout first, then applies through the ops path. 409 when
  // the layout changed since the preview.
  app.post(
    '/:id/promote/apply',
    { preHandler: requireAdmin, bodyLimit: 128 * 1024 * 1024 },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
      const body = (req.body ?? {}) as PromoteBody
      if (typeof body.base_rev !== 'string')
        return reply.code(400).send({ error: 'base_rev required (preview first)' })
      const mine = await loadLayoutBundle(db, Number(id))
      if (!mine) return reply.code(404).send({ error: 'Not found' })
      if (mine.rev !== body.base_rev)
        return reply
          .code(409)
          .send({ error: 'This layout changed since the comparison — compare again' })
      try {
        const { source, match } = await prepare(req, mine, body)
        if (!match) return reply.code(400).send({ error: 'No matching layout to apply' })
        const theirs = await source.load(match.id)
        const plan = planLayoutPromotion(mine, theirs, await promotionSkips(mine, theirs))
        if (!plan.ops.length) return reply.send({ data: { applied: 0, bundle: mine } })
        const note = `before promotion from ${source.label}`.slice(0, 255)
        await snapshotLayoutVersion(Number(id), note, req.user?.id ?? null)
        const result = await runLayoutOps(
          Number(id),
          { ops: plan.ops, base_rev: mine.rev, note },
          req.user?.id
        )
        if (result.status === 404) return reply.code(404).send({ error: 'Not found' })
        if (result.status === 409)
          return reply
            .code(409)
            .send({ error: 'This layout changed since the comparison — compare again' })
        if (result.status === 400) return reply.code(400).send({ error: result.error })
        nameConfigCollection(req, String(mine.layout.collection))
        await logActivity({
          action: 'layout-promote',
          user: req.user?.id,
          collection: 'nivaro_collection_layouts',
          item: id,
          comment: `applied “${match.name}” from ${source.label}${source.version ? ` (${source.version})` : ''}: ${plan.changes.filter((c) => c.action !== 'skip').length} change(s)`,
          req
        })
        return reply.send({ data: { applied: plan.ops.length, bundle: result.bundle } })
      } catch (err) {
        return sendError(reply, err)
      }
    }
  )
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { adminRefusal } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ccReadAuth, ccWriteAuth } from '../services/command-center/auth.js'
import {
  CC_KIOSK_COLLECTION,
  cleanKioskInput,
  countKioskView,
  createKioskLink,
  listKioskLinks,
  revokeKioskLink
} from '../services/command-center/kiosk.js'
import {
  applyPrefsChange,
  ccRoleDefaultFor,
  normalizeCcLayout,
  prefsBodyRefusal,
  readCcPrefs,
  readCcRoleDefaults,
  writeCcPrefs,
  writeCcRoleDefault
} from '../services/command-center/prefs.js'

/**
 * Command Center shell routes (slice 4: Shell & UX), registered under /command-center:
 *   GET  /prefs                 own board prefs (layout, theme, saved views, TV cycle) + role_default
 *   PUT  /prefs                 change any of them (layout null = back to the role's / built-in)
 *   GET  /role-defaults         (admin) every role's starting layout
 *   PUT  /role-defaults         (admin) {role_id, layout|null} — set or clear one role's
 *   GET  /kiosk-links           (admin) wallboard links, newest first (tokens are never shown again)
 *   POST /kiosk-links           (admin) {label, expires_in_days 1–90, region?, map_collection?} → url once
 *   DELETE /kiosk-links/:id     (admin) revoke
 *   GET  /kiosk                 (wallboard link only) what the link opens: label, region, map, expiry
 *
 * Every route except GET /kiosk refuses a wallboard link (ccNoKiosk / ccWriteAuth).
 */

const NO_KIOSK = { config: { ccNoKiosk: true } }

function adminOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  const refusal = adminRefusal(req)
  if (!refusal) return true
  void reply.code(403).send(refusal)
  return false
}

export async function commandCenterShellRoutes(app: FastifyInstance) {
  app.addHook('preHandler', ccReadAuth)

  app.get('/prefs', NO_KIOSK, async (req) => {
    const user = req.user!
    const [prefs, roleDefault] = await Promise.all([
      readCcPrefs(String(user.id)),
      ccRoleDefaultFor(user.role).catch(() => null)
    ])
    return { data: { ...prefs, role_default: roleDefault } }
  })

  app.put('/prefs', { ...NO_KIOSK, preHandler: ccWriteAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const refusal = prefsBodyRefusal(body)
    if (refusal) return reply.code(400).send({ error: refusal })
    const next = await writeCcPrefs(String(req.user!.id), (p) => applyPrefsChange(p, body))
    const roleDefault = await ccRoleDefaultFor(req.user!.role).catch(() => null)
    return { data: { ...next, role_default: roleDefault } }
  })

  app.get('/role-defaults', NO_KIOSK, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply
    return { data: await readCcRoleDefaults() }
  })

  app.put('/role-defaults', { ...NO_KIOSK, preHandler: ccWriteAuth }, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply
    const body = (req.body ?? {}) as { role_id?: unknown; layout?: unknown }
    const roleId = typeof body.role_id === 'string' ? body.role_id : ''
    if (!/^[0-9A-Fa-f-]{36}$/.test(roleId))
      return reply.code(400).send({ error: 'role_id must be a role id' })
    if (!('layout' in body)) return reply.code(400).send({ error: 'Send layout (or null)' })
    const layout = body.layout === null ? null : normalizeCcLayout(body.layout)
    if (body.layout !== null && !layout)
      return reply.code(400).send({ error: 'layout must be {order, hidden} or null' })
    const data = await writeCcRoleDefault(roleId, layout)
    await logActivity({
      action: 'cc-role-default',
      collection: CC_KIOSK_COLLECTION,
      item: roleId,
      user: req.user?.id,
      req
    })
    return { data }
  })

  app.get('/kiosk-links', NO_KIOSK, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply
    const rows = await listKioskLinks()
    // The token is stored hashed: a listed link has no URL to show.
    return { data: rows.map((r) => ({ ...r, url: '' })) }
  })

  app.post('/kiosk-links', { ...NO_KIOSK, preHandler: ccWriteAuth }, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply
    const input = cleanKioskInput(req.body)
    if ('error' in input) return reply.code(400).send({ error: input.error })
    const { link, token } = await createKioskLink(input, String(req.user!.id))
    await logActivity({
      action: 'cc-kiosk-link-create',
      collection: CC_KIOSK_COLLECTION,
      item: link.id,
      comment: input.label,
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: { ...link, url: `/command/kiosk/${token}` } })
  })

  app.delete('/kiosk-links/:id', { ...NO_KIOSK, preHandler: ccWriteAuth }, async (req, reply) => {
    if (!adminOnly(req, reply)) return reply
    const { id } = req.params as { id: string }
    if (!(await revokeKioskLink(id))) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'cc-kiosk-link-revoke',
      collection: CC_KIOSK_COLLECTION,
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // What a wallboard link opens. Only through a link: a signed-in person has no link to read.
  app.get('/kiosk', async (req, reply) => {
    const k = req.ccKiosk
    if (!k) return reply.code(400).send({ error: 'Open this through a wallboard link' })
    countKioskView(k.linkId)
    return {
      data: {
        label: k.meta.label,
        region: k.meta.region,
        map_collection: k.meta.map_collection,
        expires_at: k.expires_at
      }
    }
  })
}

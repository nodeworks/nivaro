import type { FastifyInstance } from 'fastify'
import { generateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

const TOTP_ISSUER = 'Nivaro CMS'

interface TotpUserRow {
  id: string
  email: string
  totp_secret: string | null
  totp_enabled: boolean
}

function normalizeToken(token: unknown): string {
  return String(token ?? '').replace(/\s+/g, '')
}

async function verifyToken(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false
  try {
    const result = await verify({ secret, token, epochTolerance: 30 })
    return result.valid === true
  } catch {
    return false
  }
}

export async function twoFactorRoutes(app: FastifyInstance) {
  // Begin TOTP enrollment — generates and stores a secret (NOT yet enabled)
  app.post('/setup', { preHandler: authenticate }, async (req, reply) => {
    const user = req.user!
    const row = (await db('nivaro_users')
      .where({ id: user.id })
      .select('id', 'email', 'totp_secret', 'totp_enabled')
      .first()) as TotpUserRow | undefined
    if (!row) return reply.code(404).send({ error: 'User not found' })
    if (row.totp_enabled) {
      return reply.code(400).send({ error: 'Two-factor authentication is already enabled' })
    }

    const secret = generateSecret()
    await db('nivaro_users')
      .where({ id: user.id })
      .update({ totp_secret: secret, totp_enabled: false, updated_at: new Date() })

    const uri = generateURI({ issuer: TOTP_ISSUER, label: row.email, secret })
    const qr = await QRCode.toDataURL(uri)

    return reply.send({ data: { uri, qr, secret } })
  })

  // Confirm enrollment with a valid token → enable 2FA
  app.post('/verify', { preHandler: authenticate }, async (req, reply) => {
    const token = normalizeToken((req.body as { token?: string } | null)?.token)
    const row = (await db('nivaro_users')
      .where({ id: req.user!.id })
      .select('id', 'email', 'totp_secret', 'totp_enabled')
      .first()) as TotpUserRow | undefined
    if (!row?.totp_secret) {
      return reply.code(400).send({ error: 'Two-factor setup has not been started' })
    }

    const valid = await verifyToken(row.totp_secret, token)
    if (!valid) return reply.code(400).send({ error: 'Invalid verification code' })

    await db('nivaro_users')
      .where({ id: row.id })
      .update({ totp_enabled: true, updated_at: new Date() })
    await logActivity({ action: 'totp_enabled', user: row.id, req })

    return reply.send({ data: { enabled: true } })
  })

  // Disable 2FA — requires a currently valid token
  app.post('/disable', { preHandler: authenticate }, async (req, reply) => {
    const token = normalizeToken((req.body as { token?: string } | null)?.token)
    const row = (await db('nivaro_users')
      .where({ id: req.user!.id })
      .select('id', 'email', 'totp_secret', 'totp_enabled')
      .first()) as TotpUserRow | undefined
    if (!row?.totp_secret || !row.totp_enabled) {
      return reply.code(400).send({ error: 'Two-factor authentication is not enabled' })
    }

    const valid = await verifyToken(row.totp_secret, token)
    if (!valid) return reply.code(400).send({ error: 'Invalid verification code' })

    await db('nivaro_users')
      .where({ id: row.id })
      .update({ totp_secret: null, totp_enabled: false, updated_at: new Date() })
    await logActivity({ action: 'totp_disabled', user: row.id, req })

    return reply.send({ data: { enabled: false } })
  })

  // Current user's 2FA status (used by the Profile page)
  app.get('/status', { preHandler: authenticate }, async (req, reply) => {
    const row = (await db('nivaro_users')
      .where({ id: req.user!.id })
      .select('totp_enabled')
      .first()) as { totp_enabled: boolean } | undefined
    return reply.send({ data: { enabled: Boolean(row?.totp_enabled) } })
  })
}

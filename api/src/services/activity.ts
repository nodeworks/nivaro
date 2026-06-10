import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'

export async function logActivity(opts: {
  action: string
  user: string | null | undefined
  collection?: string
  item?: string
  comment?: string
  req?: FastifyRequest
}): Promise<number | null> {
  try {
    const rows = (await db('nivaro_activity')
      .insert({
        action: opts.action,
        user: opts.user ?? null,
        collection: opts.collection ?? null,
        item: opts.item ?? null,
        comment: opts.comment ?? null,
        ip: opts.req?.ip ?? null,
        user_agent: opts.req?.headers['user-agent'] ?? null,
        timestamp: new Date()
      })
      .returning('id')) as unknown[]
    const row = rows[0] as { id: number } | number
    return typeof row === 'object' && row !== null ? row.id : (row as number)
  } catch (err) {
    // Activity logging must never break the main operation
    console.error({ err, action: opts.action }, 'Failed to write activity log')
    return null
  }
}

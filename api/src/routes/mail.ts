import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { sendMail } from '../services/mail.js'

export async function mailRoutes(app: FastifyInstance) {
  // POST /mail/test — sends a test email (admin only, dev use)
  app.post('/test', { preHandler: requireAdmin }, async (req, reply) => {
    const { to } = req.body as { to: string }
    if (!to) return reply.code(400).send({ error: 'to is required' })
    await sendMail({
      to,
      subject: 'Nivaro — Mail Test',
      template: 'notification',
      data: {
        first_name: req.user?.first_name ?? 'there',
        message:
          'This is a test email from Nivaro. If you can read this, mail is working correctly.'
      }
    })
    return reply.send({ ok: true })
  })
}

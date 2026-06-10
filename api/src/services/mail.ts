import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Liquid } from 'liquidjs'
import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { db } from '../db/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const engine = new Liquid({
  root: join(__dirname, '../../templates/mail'),
  extname: '.liquid'
})

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  from: string
}

/**
 * Resolves SMTP config — DB values win over env vars when set.
 * Env vars remain the fallback so existing deployments continue to work.
 */
async function getSmtpConfig(): Promise<SmtpConfig> {
  try {
    const row = (await db('nivaro_settings')
      .select('smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure')
      .orderBy('id', 'asc')
      .first()) as Record<string, unknown> | undefined

    const host = (row?.smtp_host as string | null) || config.SMTP_HOST
    const port = (row?.smtp_port as number | null) ?? config.SMTP_PORT
    const user = (row?.smtp_user as string | null) || config.SMTP_USER || null
    const pass = (row?.smtp_pass as string | null) || config.SMTP_PASSWORD || null
    const from = (row?.smtp_from as string | null) || config.MAIL_FROM
    const secure =
      row?.smtp_secure != null
        ? row.smtp_secure === 1 || row.smtp_secure === true
        : config.SMTP_SECURE

    return { host, port, secure, user, pass, from }
  } catch {
    // DB not ready during startup — fall back to env vars
    return {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER || null,
      pass: config.SMTP_PASSWORD || null,
      from: config.MAIL_FROM
    }
  }
}

function buildTransporter(smtp: SmtpConfig) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {})
  })
}

export interface MailOptions {
  to: string | string[]
  subject: string
  template: string
  data?: Record<string, unknown>
  text?: string
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return
  }
  const html = await engine.renderFile(opts.template, opts.data ?? {})
  await buildTransporter(smtp).sendMail({
    from: smtp.from,
    to: opts.to,
    subject: opts.subject,
    html,
    text: opts.text
  })
}

export async function sendRawMail(opts: {
  to: string | string[]
  subject: string
  html: string
  text?: string
}): Promise<void> {
  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return
  }
  await buildTransporter(smtp).sendMail({ from: smtp.from, ...opts })
}

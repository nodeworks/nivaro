import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Liquid } from 'liquidjs'
import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { db } from '../db/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ─── Pluggable template roots ────────────────────────────────────────────────
// Core templates live in api/templates/mail; extensions may ship their own
// under <extension>/templates/mail (auto-registered by the extension loader).
// LiquidJS resolves lookups in root-array order, so a later-registered
// extension root WINS — including for `{% layout 'base' %}` — which is how a
// deployment rebrands every email (chrome + overrides) without forking core.

const CORE_TEMPLATE_ROOT = join(__dirname, '../../templates/mail')
let templateRoots: string[] = [CORE_TEMPLATE_ROOT]

function buildEngine(): Liquid {
  return new Liquid({ root: [...templateRoots], extname: '.liquid' })
}

let engine = buildEngine()

/** Register an extension's mail-template directory (highest precedence wins —
 *  last registered is consulted first, core is always the final fallback). */
export function registerMailTemplateRoot(dir: string): void {
  if (templateRoots.includes(dir)) return
  templateRoots = [dir, ...templateRoots]
  engine = buildEngine()
}

// DB override layer (#18): a nivaro_mail_templates row shadows the file
// template of the same name — rebranding an email no longer needs a deploy.
// 60s cache; busted by the mail-templates routes on save/revert.
let overrideCache: { at: number; map: Map<string, string> } | null = null
export function bustMailTemplateOverrides(): void {
  overrideCache = null
}
async function getTemplateOverride(name: string): Promise<string | null> {
  if (!overrideCache || Date.now() - overrideCache.at > 60_000) {
    try {
      const rows = (await db('nivaro_mail_templates').select('name', 'body')) as Array<{
        name: string
        body: string
      }>
      overrideCache = { at: Date.now(), map: new Map(rows.map((r) => [r.name, r.body])) }
    } catch {
      // Table may not exist yet mid-migration — file templates carry on.
      overrideCache = { at: Date.now(), map: new Map() }
    }
  }
  return overrideCache.map.get(name) ?? null
}

/** Render a mail template by name — DB override first, then the pluggable
 *  file roots. Overrides still resolve `{% layout 'base' %}` against the
 *  roots, so an override keeps the branded chrome unless it replaces it. */
export async function renderMailTemplate(
  template: string,
  data?: Record<string, unknown>
): Promise<string> {
  const override = await getTemplateOverride(template)
  if (override !== null) {
    return engine.parseAndRender(override, data ?? {})
  }
  return engine.renderFile(template, data ?? {})
}

/** Render an UNSAVED draft body (editor preview) through the engine — layout
 *  tags resolve against the file roots exactly like a stored override. */
export async function previewMailBody(
  body: string,
  data?: Record<string, unknown>
): Promise<string> {
  return engine.parseAndRender(body, data ?? {})
}

/** The file template's source (for the editor's baseline + revert preview). */
export async function readFileTemplate(name: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises')
  for (const root of templateRoots) {
    try {
      return await readFile(join(root, `${name}.liquid`), 'utf8')
    } catch {
      /* next root */
    }
  }
  return null
}

/** Template names available across every registered root. */
export async function listFileTemplates(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const names = new Set<string>()
  for (const root of templateRoots) {
    try {
      for (const f of await readdir(root)) {
        if (f.endsWith('.liquid')) names.add(f.replace(/\.liquid$/, ''))
      }
    } catch {
      /* extension root may be absent in this deployment */
    }
  }
  return [...names].sort()
}

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  from: string
  testMode: boolean
  testRecipient: string | null
  testAllowlist: string[]
  /** "[STAGING]" etc. — prefixed onto every outgoing subject when set, so
   *  recipients always know which instance is talking. Null = no prefix. */
  envLabel: string | null
}

/**
 * Resolves SMTP config — DB values win over env vars when set.
 * Env vars remain the fallback so existing deployments continue to work.
 */
async function getSmtpConfig(): Promise<SmtpConfig> {
  try {
    const row = (await db('nivaro_settings')
      .select(
        'smtp_host',
        'smtp_port',
        'smtp_user',
        'smtp_pass',
        'smtp_from',
        'smtp_secure',
        'mail_test_mode',
        'mail_test_recipient',
        'mail_test_allowlist',
        'environment_label'
      )
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

    const envLabel = String(row?.environment_label ?? '').trim() || null
    return { host, port, secure, user, pass, from, envLabel, ...resolveTestMode(row) }
  } catch {
    // DB not ready during startup — fall back to env vars
    return {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER || null,
      pass: config.SMTP_PASSWORD || null,
      from: config.MAIL_FROM,
      envLabel: null,
      ...resolveTestMode(undefined)
    }
  }
}

// ─── Mail test mode ──────────────────────────────────────────────────────────
// Dev/staging safety net: when enabled, every outgoing mail is redirected to a
// single test inbox instead of its real recipients. The env vars WIN over the
// settings row so a staging box restored from a prod backup (test bit off)
// stays protected. (Read via process.env, not config.ts, deliberately.)

/** "[STAGING] [TEST — was: x] Subject" — the environment always leads. */
function withEnvLabel(smtp: SmtpConfig, subject: string): string {
  return smtp.envLabel ? `[${smtp.envLabel}] ${subject}` : subject
}

function envBool(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true'
}

function resolveTestMode(row: Record<string, unknown> | undefined): {
  testMode: boolean
  testRecipient: string | null
  testAllowlist: string[]
} {
  const dbMode = row?.mail_test_mode === 1 || row?.mail_test_mode === true
  const testMode = envBool(process.env.MAIL_TEST_MODE) || dbMode
  const testRecipient =
    process.env.MAIL_TEST_RECIPIENT || (row?.mail_test_recipient as string | null) || null
  const testAllowlist = String(row?.mail_test_allowlist ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return { testMode, testRecipient, testAllowlist }
}

function isAllowlisted(email: string, allowlist: string[]): boolean {
  const e = email.trim().toLowerCase()
  return allowlist.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a))
}

/**
 * Apply test-mode redirection to a recipient set. Exported for tests.
 * Returns null when the mail should be DROPPED (test mode on, nothing
 * allowlisted, and no test recipient configured).
 */
export function applyMailTestMode(
  smtp: Pick<SmtpConfig, 'testMode' | 'testRecipient' | 'testAllowlist'>,
  to: string | string[],
  subject: string
): { to: string[]; subject: string; redirected: string[] } | null {
  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  if (!smtp.testMode) return { to: recipients, subject, redirected: [] }

  const kept = recipients.filter((r) => isAllowlisted(r, smtp.testAllowlist))
  const redirected = recipients.filter((r) => !isAllowlisted(r, smtp.testAllowlist))
  if (redirected.length === 0) return { to: kept, subject, redirected: [] }

  if (!smtp.testRecipient) {
    if (kept.length === 0) return null
    return {
      to: kept,
      subject: `[TEST — dropped: ${redirected.join(', ')}] ${subject}`,
      redirected
    }
  }
  const finalTo = [...new Set([...kept, smtp.testRecipient])]
  return {
    to: finalTo,
    subject: `[TEST — was: ${redirected.join(', ')}] ${subject}`,
    redirected
  }
}

/**
 * Daily-digest deferral: recipients whose preferences.email_digest is 'daily'
 * are pulled OUT of the send and captured in nivaro_deferred_emails — the
 * daily action digest flushes them as one summary. Applied AFTER test-mode
 * routing so staging redirection still wins. Fails open: any error sends
 * normally (losing a digest entry beats losing the email).
 */

/**
 * Drop addresses belonging to accounts that have left — suspended, or redacted
 * under a deletion request. A suspended person cannot act on what we send, and
 * mailing a redacted one is the part that actually matters legally.
 *
 * Matched by address because that is all a mail call carries; an address with
 * no user row is left alone, since plenty of legitimate recipients (vendors,
 * distribution lists) are not users at all. A lookup failure delivers rather
 * than silently swallowing the mail.
 */
async function dropInactiveRecipients(to: string[]): Promise<string[]> {
  if (to.length === 0) return to
  try {
    const rows = (await db('nivaro_users')
      .whereIn(
        db.raw('LOWER(email)') as never,
        to.map((a) => a.toLowerCase())
      )
      .select('email', 'status', 'is_redacted')) as Array<{
      email: string | null
      status?: string | null
      is_redacted?: boolean | number
    }>
    const blocked = new Set(
      rows
        .filter(
          (r) =>
            String(r.status ?? '').toLowerCase() === 'suspended' ||
            r.is_redacted === true ||
            r.is_redacted === 1
        )
        .map((r) => String(r.email ?? '').toLowerCase())
    )
    if (blocked.size === 0) return to
    return to.filter((a) => !blocked.has(a.toLowerCase()))
  } catch {
    return to
  }
}

async function applyDigestDeferral(
  recipients: string[],
  subject: string,
  htmlOrText: string,
  skip?: boolean
): Promise<string[]> {
  if (skip || recipients.length === 0) return recipients
  try {
    const lower = recipients.map((r) => r.toLowerCase())
    const users = (await db('nivaro_users')
      .whereRaw(`LOWER(email) IN (${lower.map(() => '?').join(',')})`, lower)
      .select('id', 'email', 'preferences')) as Array<{
      id: string
      email: string
      preferences: string | Record<string, unknown> | null
    }>
    if (users.length === 0) return recipients
    const daily = new Map<string, string>()
    for (const u of users) {
      let prefs: Record<string, unknown> | null = null
      try {
        prefs =
          typeof u.preferences === 'string' ? JSON.parse(u.preferences) : (u.preferences ?? null)
      } catch {
        prefs = null
      }
      if (prefs && prefs['email_digest'] === 'daily') daily.set(u.email.toLowerCase(), u.id)
      else {
        // Quiet hours defer email the same way daily-digest prefs do — the
        // 07:45 flush delivers everything held overnight.
        try {
          const { inQuietHours } = await import('./notification-channels.js')
          const np = (prefs?.notification_prefs ?? null) as {
            quiet_start?: string
            quiet_end?: string
          } | null
          if (np && inQuietHours(np)) daily.set(u.email.toLowerCase(), u.id)
        } catch {
          // never let a prefs read break mail
        }
      }
    }
    if (daily.size === 0) return recipients
    const snippet = String(htmlOrText)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    const now = new Date()
    const deferredRows = recipients
      .filter((r) => daily.has(r.toLowerCase()))
      .map((r) => ({
        user: daily.get(r.toLowerCase())!,
        email: r,
        subject: subject.slice(0, 500),
        snippet,
        created_at: now
      }))
    if (deferredRows.length > 0) await db('nivaro_deferred_emails').insert(deferredRows)
    return recipients.filter((r) => !daily.has(r.toLowerCase()))
  } catch (err) {
    console.warn(
      '[mail] digest deferral failed — sending normally:',
      err instanceof Error ? err.message : err
    )
    return recipients
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
  /** Bypass daily-digest deferral (the digest email itself, test sends). */
  skipDigest?: boolean
}

/** Outbound mail log (#71): every send ATTEMPT gets a row — sent, failed
 *  (with the SMTP error), dropped (test mode / no recipients), deferred
 *  (digest). Fire-and-forget: logging must never break sending. */
function logMail(
  to: string | string[],
  subject: string,
  status: 'sent' | 'failed' | 'dropped' | 'deferred',
  opts?: { template?: string | null; error?: unknown; body?: string }
): void {
  const addr = (Array.isArray(to) ? to.join(', ') : String(to)).slice(0, 1000)
  void db('nivaro_mail_log')
    .insert({
      to: addr,
      subject: String(subject ?? '').slice(0, 500),
      template: opts?.template ? String(opts.template).slice(0, 120) : null,
      status,
      error: opts?.error
        ? String(opts.error instanceof Error ? opts.error.message : opts.error).slice(0, 2000)
        : null,
      body: opts?.body ? String(opts.body).slice(0, 200_000) : null,
      created_at: new Date()
    })
    .catch((err: unknown) => {
      // Logging must never break sending — but a PERSISTENT insert failure
      // (schema drift) must not be invisible either, or the log quietly
      // records nothing while everyone trusts it.
      if (!mailLogWarned) {
        mailLogWarned = true
        console.warn(
          '[mail-log] insert failing — the mail log is NOT recording:',
          err instanceof Error ? err.message : err
        )
      }
    })
}
let mailLogWarned = false

export async function sendMail(opts: MailOptions): Promise<void> {
  // Chaos drill (#333): a mail_down fault makes sends fail like a dead SMTP
  // host would, verifying the callers' failure paths (mail log, outbox).
  {
    const { chaosMailDown } = await import('../routes/chaos.js')
    if (chaosMailDown()) throw new Error('chaos: mail transport down (drill)')
  }

  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return
  }
  let html: string
  try {
    html = await engine.renderFile(opts.template, opts.data ?? {})
  } catch (err) {
    // A stale/missing template name must never produce a failed or unstyled
    // send — fall back to the generic branded 'message' chrome carrying
    // whatever readable content the data has.
    console.warn(
      `[mail] template "${opts.template}" failed to render, using fallback:`,
      err instanceof Error ? err.message : err
    )
    const raw = opts.data?.message ?? opts.text ?? ''
    const safe = String(raw).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
    )
    html = await engine.renderFile('message', {
      title: opts.subject,
      html: safe ? `<p style="margin:0;white-space:pre-wrap;">${safe}</p>` : ''
    })
  }
  // Digest deferral FIRST, against the ORIGINAL recipients — the preference
  // belongs to the intended reader; test-mode redirection happens after, on
  // whatever still sends.
  const original = (Array.isArray(opts.to) ? opts.to : String(opts.to).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  const active = await dropInactiveRecipients(original)
  if (active.length === 0) return
  const afterDigest = await applyDigestDeferral(active, opts.subject, html, opts.skipDigest)
  if (afterDigest.length < active.length) {
    logMail(active.filter((a) => !afterDigest.includes(a)), opts.subject, 'deferred', {
      template: opts.template
    })
  }
  if (afterDigest.length === 0) return
  const routed = applyMailTestMode(smtp, afterDigest, opts.subject)
  if (!routed || routed.to.length === 0) {
    console.warn('[mail] test mode: dropped email to', opts.to, '(no test recipient configured)')
    logMail(afterDigest, opts.subject, 'dropped', { template: opts.template })
    return
  }
  try {
    await buildTransporter(smtp).sendMail({
      from: smtp.from,
      to: routed.to,
      subject: withEnvLabel(smtp, routed.subject),
      html,
      text: opts.text
    })
    logMail(routed.to, opts.subject, 'sent', { template: opts.template, body: html })
  } catch (err) {
    logMail(routed.to, opts.subject, 'failed', { template: opts.template, error: err, body: html })
    throw err
  }
}

export async function sendRawMail(opts: {
  to: string | string[]
  subject: string
  html: string
  text?: string
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>
  /** Optional heading rendered above the body inside the branded chrome. */
  title?: string
  /** Set false to send the html exactly as given (no branded chrome). */
  wrap?: boolean
  /** Bypass daily-digest deferral (the digest email itself, test sends). */
  skipDigest?: boolean
}): Promise<void> {
  // Chaos drill (#333): a mail_down fault makes sends fail like a dead SMTP
  // host would, verifying the callers' failure paths (mail log, outbox).
  {
    const { chaosMailDown } = await import('../routes/chaos.js')
    if (chaosMailDown()) throw new Error('chaos: mail transport down (drill)')
  }

  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return
  }
  // Every raw sender historically shipped a bare HTML fragment with no
  // branding at all. Unless explicitly opted out — or the caller already
  // built a full document — wrap the fragment in the branded base layout
  // (the 'message' template), so ad-hoc emails match templated ones.
  let html = opts.html
  if (opts.wrap !== false && !/<html[\s>]/i.test(html)) {
    try {
      html = await engine.renderFile('message', { html, title: opts.title ?? null })
    } catch {
      // Template missing/broken — the unwrapped fragment still sends.
    }
  }
  // Digest deferral FIRST, against the ORIGINAL recipients; test-mode
  // redirection applies to whatever still sends.
  const original = (Array.isArray(opts.to) ? opts.to : String(opts.to).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  const active2 = await dropInactiveRecipients(original)
  if (active2.length === 0) return
  const afterDigest = await applyDigestDeferral(active2, opts.subject, opts.html, opts.skipDigest)
  if (afterDigest.length < active2.length) {
    logMail(active2.filter((a) => !afterDigest.includes(a)), opts.subject, 'deferred')
  }
  if (afterDigest.length === 0) return
  const routed = applyMailTestMode(smtp, afterDigest, opts.subject)
  if (!routed || routed.to.length === 0) {
    console.warn('[mail] test mode: dropped email to', opts.to, '(no test recipient configured)')
    logMail(afterDigest, opts.subject, 'dropped')
    return
  }
  const { title: _title, wrap: _wrap, skipDigest: _sd, ...mailOpts } = opts
  try {
    await buildTransporter(smtp).sendMail({
      from: smtp.from,
      ...mailOpts,
      html,
      to: routed.to,
      subject: withEnvLabel(smtp, routed.subject)
    })
    logMail(routed.to, opts.subject, 'sent', { body: html })
  } catch (err) {
    logMail(routed.to, opts.subject, 'failed', { error: err, body: html })
    throw err
  }
}

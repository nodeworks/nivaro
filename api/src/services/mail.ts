import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Liquid } from 'liquidjs'
import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { db } from '../db/index.js'
import type { NotifyCategory } from './notification-channels.js'
import { overlaySettings } from './settings-overrides.js'

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

/** Wrap a bare HTML fragment in the branded `message` chrome — the same wrap
 *  sendRawMail applies — for callers that need the finished document without
 *  sending it (the mail-type harness preview). */
export async function wrapMailFragment(
  html: string,
  title?: string | null,
  extra?: Record<string, unknown>
): Promise<string> {
  if (/<html[\s>]/i.test(html)) return html
  try {
    return await engine.renderFile('message', { ...(extra ?? {}), html, title: title ?? null })
  } catch {
    return html
  }
}

/**
 * The "why me" footer context: `why` + a link to the recipient's
 * notification rules in the app THEY use (portal vs admin). A single
 * recipient resolves by address; a list resolves with no recipient (portal
 * when configured). Best-effort — a lookup failure just drops the link.
 */
export async function whyContext(
  to: string | string[],
  why?: string | null
): Promise<{ why?: string; rules_url?: string }> {
  const text = String(why ?? '').trim()
  if (!text) return {}
  try {
    const { linkTo, userIdForEmail } = await import('./app-links.js')
    const list = (Array.isArray(to) ? to : String(to).split(/[,;]/))
      .map((s) => s.trim())
      .filter(Boolean)
    const userId = list.length === 1 ? await userIdForEmail(list[0]) : null
    const rules_url = await linkTo('profile', {}, { recipientUserId: userId })
    return { why: text, rules_url }
  } catch {
    return { why: text }
  }
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
    const row = await overlaySettings(
      (await db('nivaro_settings')
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
    )

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
  // MODE: env OR settings — env wins so a prod-DB restore into staging can
  // never flip test mode off. RECIPIENT: the source that turned test mode ON
  // supplies it. Settings on → the Settings field is authoritative (empty =
  // non-allowlisted mail is DROPPED, never the env address — an operator
  // clears the field to stop receiving other people's mail, 2026-09-11). Settings off
  // and env forcing the mode → the env recipient (the prod-restore case).
  const testMode = envBool(process.env.MAIL_TEST_MODE) || dbMode
  const dbRecipient = String(row?.mail_test_recipient ?? '').trim()
  const testRecipient = dbMode
    ? dbRecipient || null
    : dbRecipient || process.env.MAIL_TEST_RECIPIENT || null
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
  skip?: boolean,
  explicitCategory?: NotifyCategory,
  senderCadence?: boolean
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
    const off = new Set<string>()
    const { inQuietHours, classifyNotification, emailModeFor, isCriticalSubject } = await import(
      './notification-channels.js'
    )
    const category = explicitCategory ?? classifyNotification(subject)
    const critical = isCriticalSubject(subject)
    for (const u of users) {
      let prefs: Record<string, unknown> | null = null
      try {
        prefs =
          typeof u.preferences === 'string' ? JSON.parse(u.preferences) : (u.preferences ?? null)
      } catch {
        prefs = null
      }
      const np = (prefs?.notification_prefs ?? null) as Parameters<typeof emailModeFor>[0]
      // Per-category email mode (the profile's notification rules), falling
      // back to the account-wide instant/daily default. Critical subjects
      // (SLA escalations, maintenance, monitor failures) always send now.
      // Precedence: a sender that already chose the cadence (a subscription
      // set to Instantly) beats the category's "Daily summary" default — the
      // per-subscription setting is the more specific one. "No email" and
      // quiet hours still apply; critical subjects always send now.
      const categoryMode = critical
        ? 'instant'
        : emailModeFor(np, category, prefs?.['email_digest'])
      const mode = senderCadence && categoryMode === 'daily' ? 'instant' : categoryMode
      if (mode === 'off') {
        off.add(u.email.toLowerCase())
        continue
      }
      if (mode === 'daily') daily.set(u.email.toLowerCase(), u.id)
      else if (!critical) {
        // Quiet hours defer email the same way daily-digest prefs do — the
        // digest flush delivers everything held overnight.
        try {
          if (np && inQuietHours(np)) daily.set(u.email.toLowerCase(), u.id)
        } catch {
          // never let a prefs read break mail
        }
      }
    }
    const kept = off.size > 0 ? recipients.filter((r) => !off.has(r.toLowerCase())) : recipients
    if (daily.size === 0) return kept
    const snippet = String(htmlOrText)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    const now = new Date()
    const deferredRows = kept
      .filter((r) => daily.has(r.toLowerCase()))
      .map((r) => ({
        user: daily.get(r.toLowerCase())!,
        email: r,
        subject: subject.slice(0, 500),
        snippet,
        created_at: now
      }))
    if (deferredRows.length > 0) await db('nivaro_deferred_emails').insert(deferredRows)
    return kept.filter((r) => !daily.has(r.toLowerCase()))
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

/**
 * Live SMTP reachability — connects and EHLOs, never sends. 'unconfigured'
 * when no host is set (mail deliberately no-ops there, that's not an outage).
 */
export async function probeSmtp(): Promise<'ok' | 'down' | 'unconfigured'> {
  const smtp = await getSmtpConfig()
  if (!smtp.host) return 'unconfigured'
  const transporter = buildTransporter(smtp)
  try {
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ])
    return 'ok'
  } catch {
    return 'down'
  } finally {
    transporter.close()
  }
}

export interface MailOptions {
  /** Record context (#261) — logged, powers the record communications view. */
  collection?: string | null
  item?: string | number | null
  to: string | string[]
  subject: string
  template: string
  data?: Record<string, unknown>
  text?: string
  /** Bypass daily-digest deferral (the digest email itself, test sends). */
  skipDigest?: boolean
  /** Notification-rules category this mail belongs to (see NotifyUserOptions.category). */
  category?: NotifyCategory
  /** 'sender' = the caller already chose when this goes out (a subscription
   *  set to Instantly): the category's Daily-summary default is skipped; No
   *  email and quiet hours still apply. */
  cadence?: 'sender'
  /** Why THIS recipient is getting the mail, as the tail of "You're getting
   *  this because …" — rendered in the footer with a link to their
   *  notification rules. Per recipient by construction: pass it on
   *  single-recipient sends; a list send gets one shared line. */
  why?: string | null
}

/** Outbound mail log (#71): every send ATTEMPT gets a row — sent, failed
 *  (with the SMTP error), dropped (test mode / no recipients), deferred
 *  (digest). Fire-and-forget: logging must never break sending. */
function logMail(
  to: string | string[],
  subject: string,
  status: 'sent' | 'failed' | 'dropped' | 'deferred',
  opts?: {
    template?: string | null
    error?: unknown
    body?: string
    /** Record context (#261) — powers the per-record communications view. */
    collection?: string | null
    item?: string | number | null
  }
): Promise<number | null> {
  const addr = (Array.isArray(to) ? to.join(', ') : String(to)).slice(0, 1000)
  return db('nivaro_mail_log')
    .insert({
      to: addr,
      subject: String(subject ?? '').slice(0, 500),
      template: opts?.template ? String(opts.template).slice(0, 120) : null,
      collection: opts?.collection ? String(opts.collection).slice(0, 255) : null,
      item: opts?.item != null ? String(opts.item).slice(0, 255) : null,
      status,
      error: opts?.error
        ? String(opts.error instanceof Error ? opts.error.message : opts.error).slice(0, 2000)
        : null,
      body: opts?.body ? String(opts.body).slice(0, 200_000) : null,
      created_at: new Date()
    })
    .returning('id')
    .then((rows: unknown) => {
      const first = Array.isArray(rows) ? rows[0] : rows
      const id = first && typeof first === 'object' ? (first as { id?: unknown }).id : first
      return Number.isFinite(Number(id)) ? Number(id) : null
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
      return null
    })
}
let mailLogWarned = false

/** What happened to a send — the notification row records it per channel.
 *  'sent' / 'failed' carry the mail-log row id so an inbox row can link to
 *  the delivery board; 'deferred' = folded into the daily summary;
 *  'dropped' = test mode with no test recipient, or every recipient inactive;
 *  'unconfigured' = no SMTP host. */
export type MailOutcome = 'sent' | 'deferred' | 'dropped' | 'failed' | 'unconfigured'
export interface MailResult {
  status: MailOutcome
  log_id: number | null
}

export async function sendMail(opts: MailOptions): Promise<MailResult> {
  // Chaos drill (#333): a mail_down fault makes sends fail like a dead SMTP
  // host would, verifying the callers' failure paths (mail log, outbox).
  {
    const { chaosMailDown } = await import('../routes/chaos.js')
    if (chaosMailDown()) throw new Error('chaos: mail transport down (drill)')
  }

  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return { status: 'unconfigured', log_id: null }
  }
  // The why-me footer rides the template context (the base layout renders
  // it); an explicit `why` in data wins over the option.
  const whyCtx = await whyContext(opts.to, (opts.data?.why as string | undefined) ?? opts.why)
  const renderData = { ...(opts.data ?? {}), ...whyCtx }
  let html: string
  try {
    html = await engine.renderFile(opts.template, renderData)
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
      ...whyCtx,
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
  if (active.length === 0) return { status: 'dropped', log_id: null }
  const afterDigest = await applyDigestDeferral(
    active,
    opts.subject,
    html,
    opts.skipDigest,
    opts.category,
    opts.cadence === 'sender'
  )
  let deferredLogId: number | null = null
  if (afterDigest.length < active.length) {
    deferredLogId = await logMail(
      active.filter((a) => !afterDigest.includes(a)),
      opts.subject,
      'deferred',
      {
        template: opts.template
      }
    )
  }
  if (afterDigest.length === 0) return { status: 'deferred', log_id: deferredLogId }
  const routed = applyMailTestMode(smtp, afterDigest, opts.subject)
  if (!routed || routed.to.length === 0) {
    console.warn('[mail] test mode: dropped email to', opts.to, '(no test recipient configured)')
    const id = await logMail(afterDigest, opts.subject, 'dropped', { template: opts.template })
    return { status: 'dropped', log_id: id }
  }
  try {
    await buildTransporter(smtp).sendMail({
      from: smtp.from,
      to: routed.to,
      subject: withEnvLabel(smtp, routed.subject),
      html,
      text: opts.text
    })
    const id = await logMail(routed.to, opts.subject, 'sent', {
      template: opts.template,
      body: html,
      collection: opts.collection,
      item: opts.item
    })
    return { status: 'sent', log_id: id }
  } catch (err) {
    await logMail(routed.to, opts.subject, 'failed', {
      template: opts.template,
      error: err,
      body: html,
      collection: opts.collection,
      item: opts.item
    })
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
  /** Notification-rules category this mail belongs to (see NotifyUserOptions.category). */
  category?: NotifyCategory
  /** See MailOptions.cadence. */
  cadence?: 'sender'
  /** Record context (#261) — logged, powers the record communications view. */
  collection?: string | null
  item?: string | number | null
  /** See MailOptions.why. */
  why?: string | null
  /** Logged as the mail-log `template` so raw sends (flow ops, digests)
   *  group on the delivery board instead of landing as "(untemplated)". */
  template?: string | null
}): Promise<MailResult> {
  // Chaos drill (#333): a mail_down fault makes sends fail like a dead SMTP
  // host would, verifying the callers' failure paths (mail log, outbox).
  {
    const { chaosMailDown } = await import('../routes/chaos.js')
    if (chaosMailDown()) throw new Error('chaos: mail transport down (drill)')
  }

  const smtp = await getSmtpConfig()
  if (!smtp.host || smtp.host === 'localhost') {
    console.warn('[mail] SMTP not configured, skipping email to', opts.to)
    return { status: 'unconfigured', log_id: null }
  }
  // Every raw sender historically shipped a bare HTML fragment with no
  // branding at all. Unless explicitly opted out — or the caller already
  // built a full document — wrap the fragment in the branded base layout
  // (the 'message' template), so ad-hoc emails match templated ones.
  let html = opts.html
  if (opts.wrap !== false && !/<html[\s>]/i.test(html)) {
    try {
      const whyCtx = await whyContext(opts.to, opts.why)
      html = await engine.renderFile('message', { ...whyCtx, html, title: opts.title ?? null })
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
  if (active2.length === 0) return { status: 'dropped', log_id: null }
  const afterDigest = await applyDigestDeferral(
    active2,
    opts.subject,
    opts.html,
    opts.skipDigest,
    opts.category,
    opts.cadence === 'sender'
  )
  const logTemplate = opts.template ?? null
  let deferredLogId: number | null = null
  if (afterDigest.length < active2.length) {
    deferredLogId = await logMail(
      active2.filter((a) => !afterDigest.includes(a)),
      opts.subject,
      'deferred',
      { template: logTemplate }
    )
  }
  if (afterDigest.length === 0) return { status: 'deferred', log_id: deferredLogId }
  const routed = applyMailTestMode(smtp, afterDigest, opts.subject)
  if (!routed || routed.to.length === 0) {
    console.warn('[mail] test mode: dropped email to', opts.to, '(no test recipient configured)')
    const id = await logMail(afterDigest, opts.subject, 'dropped', { template: logTemplate })
    return { status: 'dropped', log_id: id }
  }
  const {
    title: _title,
    wrap: _wrap,
    skipDigest: _sd,
    why: _why,
    template: _template,
    category: _category,
    cadence: _cadence,
    collection: _collection,
    item: _item,
    ...mailOpts
  } = opts
  try {
    await buildTransporter(smtp).sendMail({
      from: smtp.from,
      ...mailOpts,
      html,
      to: routed.to,
      subject: withEnvLabel(smtp, routed.subject)
    })
    const id = await logMail(routed.to, opts.subject, 'sent', {
      template: logTemplate,
      body: html,
      collection: opts.collection,
      item: opts.item
    })
    return { status: 'sent', log_id: id }
  } catch (err) {
    await logMail(routed.to, opts.subject, 'failed', {
      template: logTemplate,
      error: err,
      body: html,
      collection: opts.collection,
      item: opts.item
    })
    throw err
  }
}

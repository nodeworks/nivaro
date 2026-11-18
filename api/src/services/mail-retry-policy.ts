/**
 * Automatic mail retry — the pure rules (no imports, so tests and the logger
 * load it for free).
 *
 * WHICH failures retry. Only a failure that certainly did NOT deliver and may
 * well succeed later:
 *   - the server answered 4xx (421 service not available, 450/451/452, 454 …,
 *     or an enhanced 4.x.x code) — an explicit "not now", at any step, even
 *     after DATA: a 4xx reply to the final dot means the message was NOT taken;
 *   - the connection never got as far as the conversation: refused /
 *     unreachable host or network, a temporary DNS failure (EAI_AGAIN, DNS
 *     server timeout), the connect / greeting / TLS-upgrade timeout, a TLS
 *     handshake the server reset.
 *
 * What never retries:
 *   - 5xx replies (550 mailbox, 553, 554 …) and every authentication failure
 *     (535: the settings are wrong — retrying would never succeed);
 *   - an invalid sender / recipient, a message the library refused, a host
 *     name that does not exist (ENOTFOUND), a certificate the TLS check
 *     rejects, a server that speaks something other than SMTP;
 *   - AMBIGUOUS failures: an idle-socket timeout, a connection reset or closed
 *     mid-conversation, a server that went away without a reply. Nodemailer
 *     reports those the same way before MAIL FROM and after the message body
 *     was streamed, and in the second case the server may already have taken
 *     the message — retrying could send it twice. A duplicate is worse than a
 *     failure someone can Resend, so these stay failed;
 *   - anything not recognised.
 */

export type MailFailureKind = 'temporary' | 'permanent' | 'ambiguous' | 'unknown'

export interface MailFailureClass {
  kind: MailFailureKind
  /** A short machine reason, e.g. 'smtp-4xx', 'auth', 'socket-timeout'. */
  reason: string
}

/** Delay before automatic retry N+1 (index = retries already made). */
export const MAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const
/** Automatic retries per original send; after the last one the send stays failed. */
export const MAIL_RETRY_MAX = MAIL_RETRY_DELAYS_MS.length

/** How long to wait before the next automatic retry, or null when none is left. */
export function nextRetryDelayMs(retriesMade: number): number | null {
  const n = Number.isInteger(retriesMade) && retriesMade >= 0 ? retriesMade : 0
  return n < MAIL_RETRY_DELAYS_MS.length ? MAIL_RETRY_DELAYS_MS[n] : null
}

/** System error codes of a connection that never reached the SMTP conversation. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EAI_AGAIN'
])
/** DNS lookups that failed for now, not because the name does not exist. */
const DNS_TEMPORARY = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'ETIMEDOUT'])
/** Timeouts of a phase before any mail command went out. */
const SETUP_TIMEOUTS = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'DNS_TIMEOUT'
])
const CERT_PROBLEM =
  /certificate|self[- ]signed|unable to (?:get|verify)|altname|hostname\/ip does not match|wrong version number|CERT_|unsupported protocol/i

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The SMTP reply code the error carries (nodemailer's responseCode, else the reply text). */
export function smtpReplyCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { responseCode?: unknown; response?: unknown }
  const n = Number(e.responseCode)
  if (Number.isInteger(n) && n >= 200 && n < 600) return n
  const m = str(e.response).match(/^([2-5]\d\d)[ -]/)
  return m ? Number(m[1]) : null
}

/** Classify a send error. Pure — reads only the error's own fields. */
export function classifyMailError(err: unknown): MailFailureClass {
  if (!err || typeof err !== 'object') return { kind: 'unknown', reason: 'no-error' }
  const e = err as {
    code?: unknown
    originalCode?: unknown
    timeoutType?: unknown
    command?: unknown
    message?: unknown
  }
  const code = str(e.code)
  const original = str(e.originalCode)
  const message = str(e.message)

  // 1. The server's own answer decides first.
  const reply = smtpReplyCode(err)
  if (reply != null) {
    if (reply >= 400 && reply < 500) return { kind: 'temporary', reason: `smtp-${reply}` }
    if (reply === 535 || reply === 534 || reply === 530 || code === 'EAUTH')
      return { kind: 'permanent', reason: 'auth' }
    if (reply >= 500) return { kind: 'permanent', reason: `smtp-${reply}` }
  }
  // An enhanced status code in the text with no reply code parsed (some relays).
  if (reply == null && /(?:^|\s)4\.\d{1,3}\.\d{1,3}(?:\s|$)/.test(message))
    return { kind: 'temporary', reason: 'smtp-4.x.x' }
  if (reply == null && /(?:^|\s)5\.\d{1,3}\.\d{1,3}(?:\s|$)/.test(message))
    return { kind: 'permanent', reason: 'smtp-5.x.x' }

  // 2. Configuration and message problems never fix themselves.
  if (code === 'EAUTH' || code === 'ENOAUTH' || code === 'EOAUTH2')
    return { kind: 'permanent', reason: 'auth' }
  if (code === 'EENVELOPE') return { kind: 'permanent', reason: 'envelope' }
  if (code === 'EMESSAGE' || code === 'ESTREAM') return { kind: 'permanent', reason: 'message' }
  if (code === 'EREQUIRETLS') return { kind: 'permanent', reason: 'requiretls' }
  if (code === 'EPROTOCOL') return { kind: 'permanent', reason: 'protocol' }
  if (code === 'ECONFIG') return { kind: 'permanent', reason: 'config' }
  if (code === 'ETLS' || /^ERR_TLS|CERT/.test(original)) {
    if (CERT_PROBLEM.test(message) || CERT_PROBLEM.test(original))
      return { kind: 'permanent', reason: 'tls-certificate' }
    // A handshake the server reset / closed: TLS comes before any mail command.
    return { kind: 'temporary', reason: 'tls-handshake' }
  }

  // 3. DNS: a name that does not exist is a setting; a lookup that failed for now is not.
  if (code === 'EDNS' || code === 'ENOTFOUND' || original === 'ENOTFOUND') {
    if (DNS_TEMPORARY.has(original) || original === 'EAI_AGAIN')
      return { kind: 'temporary', reason: 'dns-temporary' }
    return { kind: 'permanent', reason: 'dns-not-found' }
  }
  if (code === 'EAI_AGAIN' || original === 'EAI_AGAIN')
    return { kind: 'temporary', reason: 'dns-temporary' }

  // 4. Timeouts: only those of a setup phase are safe.
  if (code === 'ETIMEDOUT') {
    const phase = str(e.timeoutType)
    if (SETUP_TIMEOUTS.has(phase)) return { kind: 'temporary', reason: 'setup-timeout' }
    if (/^(?:Connection timeout|Greeting never received|TLS handshake timed out)/i.test(message))
      return { kind: 'temporary', reason: 'setup-timeout' }
    return { kind: 'ambiguous', reason: 'socket-timeout' }
  }

  // 5. Connection-level system errors before the conversation.
  if (CONNECT_CODES.has(code) || CONNECT_CODES.has(original))
    return { kind: 'temporary', reason: 'connect' }

  // 6. A connection that broke or closed mid-way — may have delivered.
  if (
    code === 'ECONNECTION' ||
    code === 'ESOCKET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    original === 'ECONNRESET' ||
    original === 'EPIPE'
  )
    return { kind: 'ambiguous', reason: 'connection-lost' }

  return { kind: 'unknown', reason: code ? code.toLowerCase() : 'unknown' }
}

/** True when an automatic retry is safe and worth making. */
export function isRetryableMailError(err: unknown): boolean {
  return classifyMailError(err).kind === 'temporary'
}

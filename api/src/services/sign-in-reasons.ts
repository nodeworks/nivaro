/**
 * Why a sign-in failed, in plain words (the person page's sign-in troubleshooter, idea 32).
 *
 * Pure: no database, no request. `routes/auth.ts` classifies each failure with these functions
 * before it writes the `sign-in-failed` activity row, and the troubleshooter reads rows back
 * through them — including the older `login-refused` / `device-revoked` rows, whose comments are
 * sentences, not codes.
 *
 * Never stores or returns a password, code, token or the IdP's free-text description (Microsoft
 * puts the person's email and trace ids in it): only the reason key and a short error code such
 * as `AADSTS50057`.
 */

export type SignInReason =
  | 'suspended'
  | 'sign_in_disabled'
  | 'directory_disabled'
  | 'wrong_tenant'
  | 'not_in_directory'
  | 'not_assigned'
  | 'mfa'
  | 'conditional_access'
  | 'locked'
  | 'password_expired'
  | 'idp_wrong_password'
  | 'consent'
  | 'app_misconfigured'
  | 'provider_unavailable'
  | 'session_state'
  | 'cookie_blocked'
  | 'code_expired'
  | 'account_link'
  | 'wrong_password'
  | 'totp_wrong'
  | 'totp_restart'
  | 'throttled'
  | 'device_ended'
  | 'idp_refused'
  | 'auth_failed'

/** Who can fix it: the person themself, a Nivaro administrator, or the organisation's IT. */
export type ReasonOwner = 'person' | 'admin' | 'it' | 'wait'

export interface ReasonText {
  label: string
  explain: string
  todo: string
  owner: ReasonOwner
}

export const SIGN_IN_REASONS: Record<SignInReason, ReasonText> = {
  suspended: {
    label: 'Account suspended here',
    explain:
      'The identity provider let them in, but their account in this app is suspended or redacted, so the sign-in was refused.',
    todo: 'If they should have access, reactivate the account on the Access tab. Check why it was suspended first: a retention rule or the directory sync may suspend it again.',
    owner: 'admin'
  },
  sign_in_disabled: {
    label: 'Sign-in is off for their role',
    explain: 'Their role has sign-in turned off, so this app refused the sign-in.',
    todo: 'Give them a role that may sign in, or turn sign-in on for the role under Roles.',
    owner: 'admin'
  },
  directory_disabled: {
    label: 'Disabled in Microsoft',
    explain: 'Microsoft says the account is disabled in the organisation’s directory.',
    todo: 'Nothing to change here. Their IT or Microsoft administrator has to enable the account in Entra ID.',
    owner: 'it'
  },
  wrong_tenant: {
    label: 'Signed in with another organisation’s account',
    explain:
      'They used a Microsoft account that does not belong to this organisation: a personal account, or one from another company.',
    todo: 'Ask them to sign out of Microsoft (or use a private window) and sign in with their work account. A guest from another company must be invited into the directory first.',
    owner: 'person'
  },
  not_in_directory: {
    label: 'Not found in the Microsoft directory',
    explain: 'Microsoft could not find this account in the organisation’s directory.',
    todo: 'Check they typed their work address. If they are new or were removed, their IT team has to add them to the directory.',
    owner: 'it'
  },
  not_assigned: {
    label: 'Not assigned to the app in Microsoft',
    explain: 'The Microsoft app only lets in people assigned to it, and they are not.',
    todo: 'Their Microsoft administrator assigns them (or a group they are in) to the app under Entra ID → Enterprise applications.',
    owner: 'it'
  },
  mfa: {
    label: 'Second check not finished',
    explain:
      'Microsoft asked for the extra verification step (app, text or call) and it was not completed.',
    todo: 'Ask them to finish the verification step. If their phone or method changed, their IT team can reset their verification methods.',
    owner: 'person'
  },
  conditional_access: {
    label: 'Blocked by a Microsoft access policy',
    explain:
      'An access policy in the organisation’s Microsoft setup blocked the sign-in, usually because of the device or the location it came from.',
    todo: 'Try from a work device or the usual network. Their IT team can see which policy blocked it in the Entra sign-in log.',
    owner: 'it'
  },
  locked: {
    label: 'Locked by Microsoft',
    explain: 'Microsoft locked the account after too many wrong passwords.',
    todo: 'Wait for the lock to lift (often 15 to 30 minutes), or their IT team unlocks the account or resets the password.',
    owner: 'wait'
  },
  password_expired: {
    label: 'Microsoft password expired',
    explain: 'Their Microsoft password has expired.',
    todo: 'They change the password at Microsoft (or IT resets it), then sign in again.',
    owner: 'person'
  },
  idp_wrong_password: {
    label: 'Wrong Microsoft password',
    explain: 'Microsoft refused the password they typed.',
    todo: 'If they forgot it, they reset it through Microsoft’s “Forgot password” or their IT team.',
    owner: 'person'
  },
  consent: {
    label: 'Permission prompt declined',
    explain:
      'The app asked for permission and the request was declined, or needs an administrator’s approval.',
    todo: 'Sign in again and accept. If Microsoft says an administrator must approve, their Microsoft administrator grants consent for the organisation.',
    owner: 'it'
  },
  app_misconfigured: {
    label: 'The app’s Microsoft setup is wrong',
    explain:
      'Microsoft refused the app itself (its address, secret or registration), not the person. Everyone signing in this way is affected.',
    todo: 'Check Settings → Microsoft and the app registration in Entra ID: the redirect address, the client secret’s expiry, and the tenant.',
    owner: 'admin'
  },
  provider_unavailable: {
    label: 'Sign-in provider did not answer',
    explain: 'The identity provider could not be reached or timed out. It was not a refusal.',
    todo: 'Usually brief. Ask them to try again in a few minutes; anyone already signed in keeps working.',
    owner: 'wait'
  },
  session_state: {
    label: 'Sign-in page went stale',
    explain:
      'The sign-in came back to a browser session that no longer knew about it: it took too long, was started in another tab, or the back button replayed it.',
    todo: 'Ask them to close other sign-in tabs and start again from the sign-in page, in one tab, without going back.',
    owner: 'person'
  },
  cookie_blocked: {
    label: 'Browser dropped the sign-in cookie',
    explain:
      'The browser came back from the provider without this app’s cookie: blocked cookies, a strict privacy setting or extension, or the address changed during sign-in.',
    todo: 'Allow cookies for this site, leave private mode, and use the usual address (not a bookmark of another host).',
    owner: 'person'
  },
  code_expired: {
    label: 'Sign-in code expired or used twice',
    explain: 'The one-time code from the provider was too old or had already been used.',
    todo: 'Start again from the sign-in page and do not refresh or go back while signing in.',
    owner: 'person'
  },
  account_link: {
    label: 'Email belongs to an account linked to another sign-in',
    explain:
      'The sign-in carried this account’s email, but the account is already linked to a different sign-in identity, so it was not taken over by email.',
    todo: 'Check which provider they used. If it really is them (a new Microsoft account or another sign-in provider), an administrator can allow that provider to link by email (SSO_LINK_BY_EMAIL).',
    owner: 'admin'
  },
  wrong_password: {
    label: 'Wrong password',
    explain: 'The email matched this account but the password did not.',
    todo: 'If they forgot it, an administrator can give them a new setup link.',
    owner: 'person'
  },
  totp_wrong: {
    label: 'Wrong verification code',
    explain: 'The two-factor code they typed was wrong or already used.',
    todo: 'Check the phone’s clock is set automatically and they use the code for this site. An administrator can reset two-factor.',
    owner: 'person'
  },
  totp_restart: {
    label: 'Too many wrong codes',
    explain: 'After several wrong two-factor codes the sign-in had to start over.',
    todo: 'Start again from the sign-in page. If codes never work, an administrator can reset two-factor.',
    owner: 'person'
  },
  throttled: {
    label: 'Too many attempts',
    explain: 'Sign-in paused for a few minutes after repeated failures.',
    todo: 'Wait a few minutes, then try once more.',
    owner: 'wait'
  },
  device_ended: {
    label: 'Phone signed out',
    explain: 'A phone’s sign-in was ended, so the app asks to sign in again.',
    todo: 'Sign in again in the phone app. If an administrator removed the phone, that was deliberate.',
    owner: 'person'
  },
  idp_refused: {
    label: 'The provider refused the sign-in',
    explain: 'The identity provider refused the sign-in with an error code.',
    todo: 'Look the code up in the provider’s sign-in log (Entra ID → Sign-in logs) for the time shown.',
    owner: 'it'
  },
  auth_failed: {
    label: 'Sign-in failed',
    explain: 'The sign-in failed without a more specific reason.',
    todo: 'Ask them to try again and note the time; the server log at that time has the cause.',
    owner: 'person'
  }
}

export function isSignInReason(v: unknown): v is SignInReason {
  return typeof v === 'string' && Object.hasOwn(SIGN_IN_REASONS, v)
}

/** Microsoft AADSTS error numbers → reason. Unlisted codes fall back to `idp_refused`. */
const AADSTS: Record<number, SignInReason> = {
  50057: 'directory_disabled',
  50020: 'wrong_tenant',
  90072: 'wrong_tenant',
  500200: 'wrong_tenant',
  50177: 'wrong_tenant',
  50034: 'not_in_directory',
  50105: 'not_assigned',
  50074: 'mfa',
  50076: 'mfa',
  50079: 'mfa',
  50072: 'mfa',
  50158: 'mfa',
  50097: 'conditional_access',
  53000: 'conditional_access',
  53001: 'conditional_access',
  53002: 'conditional_access',
  53003: 'conditional_access',
  530003: 'conditional_access',
  530032: 'conditional_access',
  50053: 'locked',
  50055: 'password_expired',
  50144: 'password_expired',
  50126: 'idp_wrong_password',
  65001: 'consent',
  65004: 'consent',
  90094: 'consent',
  90008: 'consent',
  700016: 'app_misconfigured',
  50011: 'app_misconfigured',
  7000215: 'app_misconfigured',
  7000222: 'app_misconfigured',
  700054: 'app_misconfigured',
  700027: 'app_misconfigured',
  70001: 'app_misconfigured',
  70008: 'code_expired',
  54005: 'code_expired',
  9002313: 'code_expired'
}

/** The short code worth keeping: `AADSTS50057`, else an OAuth error word. Never free text. */
export function shortErrorCode(text: unknown): string | null {
  const s = String(text ?? '')
  const aad = /AADSTS(\d{4,8})/.exec(s)
  if (aad) return `AADSTS${aad[1]}`
  const word = /^[a-z][a-z0-9_]{2,39}$/.exec(s.trim())
  return word ? word[0] : null
}

/**
 * Classify a failed OIDC callback.
 *  - `idpError` / `idpDescription`: the `error` / `error_description` the provider sent back.
 *  - `err`: what the token exchange or account step threw.
 *  - `unreachable`: the caller's verdict that the provider could not be reached.
 */
export function classifyCallbackFailure(input: {
  idpError?: string | null
  idpDescription?: string | null
  err?: unknown
  unreachable?: boolean
}): { reason: SignInReason; code: string | null } {
  if (input.unreachable) return { reason: 'provider_unavailable', code: null }
  const e = input.err as
    | { code?: unknown; error?: unknown; error_description?: unknown; message?: unknown }
    | null
    | undefined
  const texts = [
    input.idpDescription,
    input.idpError,
    e?.error_description,
    e?.error,
    e?.message
  ].map((t) => String(t ?? ''))
  for (const t of texts) {
    const m = /AADSTS(\d{4,8})/.exec(t)
    if (m) {
      const n = Number(m[1])
      return { reason: AADSTS[n] ?? 'idp_refused', code: `AADSTS${m[1]}` }
    }
  }
  const oauthErr = String(input.idpError ?? e?.error ?? '').trim()
  if (oauthErr === 'invalid_grant') return { reason: 'code_expired', code: 'invalid_grant' }
  if (oauthErr === 'consent_required') return { reason: 'consent', code: oauthErr }
  if (oauthErr === 'interaction_required' || oauthErr === 'login_required')
    return { reason: 'mfa', code: oauthErr }
  if (oauthErr === 'temporarily_unavailable' || oauthErr === 'server_error')
    return { reason: 'provider_unavailable', code: oauthErr }
  if (oauthErr === 'unauthorized_client' || oauthErr === 'invalid_client')
    return { reason: 'app_misconfigured', code: oauthErr }
  if (oauthErr) return { reason: 'idp_refused', code: shortErrorCode(oauthErr) }
  // openid-client: the state that came back is not the one this session sent.
  const msg = String(e?.message ?? '')
  if (/state/i.test(msg) && /(unexpected|mismatch|missing)/i.test(msg))
    return { reason: 'session_state', code: null }
  return { reason: 'auth_failed', code: null }
}

/** A callback with no state in its session: no cookie at all = the browser dropped it. */
export function classifyMissingState(hadSessionCookie: boolean): SignInReason {
  return hadSessionCookie ? 'session_state' : 'cookie_blocked'
}

/** Did the request carry the session cookie? */
export function hasSessionCookie(cookieHeader: unknown, cookieName: string): boolean {
  const raw = String(cookieHeader ?? '')
  return raw.split(';').some((p) => p.trim().startsWith(`${cookieName}=`))
}

/** The reason an older `login-refused` / `device-revoked` row records in its sentence. */
export function reasonFromLegacyRow(action: string, comment: unknown): SignInReason {
  const c = String(comment ?? '')
  if (action === 'device-revoked') return 'device_ended'
  if (/sign-in is turned off/i.test(c)) return 'sign_in_disabled'
  if (/not active/i.test(c)) return 'suspended'
  if (/linked to a different sign-in|sent no subject/i.test(c)) return 'account_link'
  return 'auth_failed'
}

/** A `sign-in-failed` row's comment JSON: {reason, method, app, code}. */
export interface FailureComment {
  reason: SignInReason
  method: string | null
  app: string | null
  code: string | null
}

export function encodeFailureComment(c: FailureComment): string {
  return JSON.stringify({
    reason: c.reason,
    method: c.method,
    app: c.app,
    code: c.code ? shortErrorCode(c.code) : null
  })
}

export function decodeFailureComment(raw: unknown): FailureComment {
  try {
    const v = JSON.parse(String(raw ?? '')) as Record<string, unknown>
    return {
      reason: isSignInReason(v.reason) ? v.reason : 'auth_failed',
      method: typeof v.method === 'string' ? v.method.slice(0, 20) : null,
      app: typeof v.app === 'string' ? v.app.slice(0, 120) : null,
      code: typeof v.code === 'string' ? shortErrorCode(v.code) : null
    }
  } catch {
    return { reason: 'auth_failed', method: null, app: null, code: null }
  }
}

/**
 * Which app a sign-in was for: `admin` when it returns to the admin's own origin, else the host
 * of the other allowed app (a headless front end). Anything not on the allowlist is `null`.
 */
export function appOfOrigin(
  url: string | null | undefined,
  adminUrl: string,
  allowedOrigins: Iterable<string>
): string | null {
  if (!url) return null
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return null
  }
  let admin: string | null = null
  try {
    admin = new URL(adminUrl).origin
  } catch {
    /* no admin origin */
  }
  if (admin && origin === admin) return 'admin'
  for (const o of allowedOrigins) if (o === origin) return new URL(origin).host
  return null
}

/** The account an attempted identity names, most trusted first: subject, Entra id, email. */
export function pickIdentityMatch<
  T extends {
    id: string
    external_id?: string | null
    entra_oid?: string | null
    email?: string | null
  }
>(
  rows: T[],
  attempt: { sub?: string | null; oid?: string | null; email?: string | null }
): { id: string; by: 'subject' | 'microsoft_id' | 'email' } | null {
  const lower = (v: unknown) =>
    String(v ?? '')
      .trim()
      .toLowerCase()
  if (attempt.sub) {
    const hit = rows.find((r) => r.external_id && r.external_id === attempt.sub)
    if (hit) return { id: hit.id, by: 'subject' }
  }
  if (attempt.oid) {
    const hit = rows.find((r) => r.entra_oid && lower(r.entra_oid) === lower(attempt.oid))
    if (hit) return { id: hit.id, by: 'microsoft_id' }
  }
  if (attempt.email && lower(attempt.email)) {
    const hit = rows.find((r) => lower(r.email) === lower(attempt.email))
    if (hit) return { id: hit.id, by: 'email' }
  }
  return null
}

/**
 * An attempt nobody could name is "probably them" when it came from a browser they signed in
 * from: the same address AND the same browser string. Address alone is not enough (an office
 * shares one), and an empty string never matches.
 */
export function browserKey(ip: unknown, ua: unknown): string | null {
  const a = String(ip ?? '').trim()
  const b = String(ua ?? '').trim()
  return a && b ? `${a}\u0000${b}` : null
}

export function isKnownBrowser(known: Set<string>, ip: unknown, ua: unknown): boolean {
  const k = browserKey(ip, ua)
  return !!k && known.has(k)
}

/** A short plain name for a browser string: "Edge on Windows", "Nivaro app on iPhone". */
export function describeAgent(ua: unknown): string | null {
  const s = String(ua ?? '')
  if (!s) return null
  const os = /iPhone|iPad/.test(s)
    ? 'iPhone'
    : /Android/.test(s)
      ? 'Android'
      : /Windows/.test(s)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(s)
          ? 'Mac'
          : /Linux/.test(s)
            ? 'Linux'
            : null
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\//.test(s)
      ? 'Opera'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : /Expo|okhttp|CFNetwork|Dalvik/.test(s)
              ? 'Phone app'
              : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? s.slice(0, 40)
}

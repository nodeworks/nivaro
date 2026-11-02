#!/usr/bin/env node
// End-to-end probe of the phone sign-in on a THROWAWAY API (never Rob's :3055).
//
//   PROBE_BASE=http://127.0.0.1:3099 PROBE_STATIC_TOKEN=<throwaway user's static token> \
//   PROBE_OTHER_NOTIFICATION_ID=<id of a notification owned by someone else> \
//   node scripts/mobile-signin-probe.mjs
//
// Signs in as the throwaway user through the static-token login (a session), runs the
// PKCE authorize -> token flow as client `nivaro-mobile`, then checks /auth/me, refresh with
// install_id, the 10 s replay, a replay from another install, notification ownership,
// /app-info and the device sign-out. Tokens print as their prefix only.
import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.env.PROBE_BASE ?? '').replace(/\/$/, '')
const STATIC = process.env.PROBE_STATIC_TOKEN ?? ''
const OTHER = process.env.PROBE_OTHER_NOTIFICATION_ID ?? ''
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE) || /:(3055|3056|3057)$/.test(BASE)) {
  console.error('PROBE_BASE must be a loopback throwaway API (not 3055/3056/3057)')
  process.exit(2)
}
if (!STATIC) {
  console.error('PROBE_STATIC_TOKEN is required')
  process.exit(2)
}

const REDIRECT = 'dev.nivaro.app:/oauth/callback'
const red = (t) => (t ? `${String(t).slice(0, 5)}…` : String(t))
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const b64u = (b) => b.toString('base64url')

let cookie = ''
const jar = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';')
    const name = pair.split('=')[0]
    cookie = cookie
      .split('; ')
      .filter((x) => x && !x.startsWith(`${name}=`))
      .concat(pair)
      .join('; ')
  }
}
const http = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { ...(cookie && !init.noCookie ? { cookie } : {}), ...(init.headers ?? {}) }
  })
  jar(res)
  return res
}
const form = (o) => new URLSearchParams(o).toString()
const tokenCall = (o) =>
  http('/oauth/token', {
    method: 'POST',
    noCookie: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: 'nivaro-mobile', ...o })
  })

// 1. session for the throwaway user
let r = await http('/api/auth/login/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: STATIC })
})
check('static-token login gives a session', r.status === 200 && !!cookie, `status ${r.status}`)

// 2. app-info
r = await http('/api/app-info', { noCookie: true })
const info = await r.json().catch(() => ({}))
const infoBody = info.data ?? info
console.log('app-info keys:', Object.keys(infoBody).sort().join(','))
check('app-info 200 and carries origin', r.status === 200 && typeof infoBody.origin === 'string', `origin ${infoBody.origin}`)

// 3. authorize (PKCE)
const verifier = b64u(randomBytes(32))
const challenge = b64u(createHash('sha256').update(verifier).digest())
const state = b64u(randomBytes(8))
const q = {
  client_id: 'nivaro-mobile',
  redirect_uri: REDIRECT,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  device_name: 'Probe phone',
  platform: 'ios'
}
r = await http(`/oauth/authorize?${form(q)}`)
const html = await r.text()
check('authorize GET shows the consent page', r.status === 200 && html.includes('name="csrf"'), `status ${r.status}`)
const hidden = {}
for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
  hidden[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
r = await http('/oauth/authorize', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ ...hidden, decision: 'allow' })
})
const loc = r.headers.get('location') ?? ''
check('authorize POST redirects to the app callback', r.status === 302 && loc.startsWith(`${REDIRECT}?`), `status ${r.status}`)
const cb = new URL(loc.replace('dev.nivaro.app:/', 'http://cb.invalid/'))
const code = cb.searchParams.get('code')
check('callback carries code, same state and iss', !!code && cb.searchParams.get('state') === state && !!cb.searchParams.get('iss'), `iss ${cb.searchParams.get('iss')}`)

// 4. token exchange
r = await tokenCall({
  grant_type: 'authorization_code',
  code,
  code_verifier: verifier,
  redirect_uri: REDIRECT
})
let t = await r.json()
console.log('token keys:', Object.keys(t).sort().join(','))
check('token 200 with nvd_ / nvdr_', r.status === 200 && t.access_token?.startsWith('nvd_') && t.refresh_token?.startsWith('nvdr_'), `${red(t.access_token)} ${red(t.refresh_token)} expires_in ${t.expires_in}`)

// 5. /auth/me and device list
const bearer = (tok) => ({ authorization: `Bearer ${tok}` })
r = await http('/api/auth/me', { noCookie: true, headers: bearer(t.access_token) })
check('GET /api/auth/me 200 with the device token', r.status === 200, `status ${r.status}`)
r = await http('/api/auth/devices', { noCookie: true, headers: bearer(t.access_token) })
const devs = (await r.json()).data ?? []
const dev = devs.find((d) => d.current) ?? devs[0]
check('device list shows this phone as current', r.status === 200 && !!dev?.current, `id ${dev?.id}, name ${dev?.device_name}`)

// 6. refresh with install_id, replay
const install = `probe-${b64u(randomBytes(6))}`
const first = t
r = await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, install_id: install })
const rot = await r.json()
check('refresh with install_id rotates to a new pair', r.status === 200 && rot.access_token?.startsWith('nvd_') && rot.refresh_token !== first.refresh_token, `${red(rot.access_token)} ${red(rot.refresh_token)}`)
r = await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, install_id: install })
const rep = await r.json()
check('replay within 10 s with the same install_id returns the same pair', r.status === 200 && rep.refresh_token === rot.refresh_token && rep.access_token === rot.access_token, `status ${r.status}`)
r = await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, install_id: 'other-install' })
check('replay with another install_id is refused', r.status === 400 && (await r.json()).error === 'invalid_grant', `status ${r.status}`)
r = await http('/api/auth/me', { noCookie: true, headers: bearer(rot.access_token) })
check('that replay ended the grant (rotated access token now 401)', r.status === 401, `status ${r.status}`)

// 7. a fresh grant for ownership + sign-out
const sign = async () => {
  const v = b64u(randomBytes(32))
  const s = b64u(randomBytes(8))
  const qq = { ...q, state: s, code_challenge: b64u(createHash('sha256').update(v).digest()) }
  const g = await http(`/oauth/authorize?${form(qq)}`)
  const h = {}
  for (const m of (await g.text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
    h[m[1]] = m[2].replace(/&amp;/g, '&')
  const p = await http('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...h, decision: 'allow' })
  })
  const c = new URL((p.headers.get('location') ?? '').replace('dev.nivaro.app:/', 'http://cb.invalid/')).searchParams.get('code')
  const tk = await tokenCall({ grant_type: 'authorization_code', code: c, code_verifier: v, redirect_uri: REDIRECT })
  return tk.json()
}
const g2 = await sign()
if (OTHER) {
  r = await http(`/api/notifications/${OTHER}`, { noCookie: true, headers: bearer(g2.access_token) })
  check("GET /api/notifications/<someone else's id> is 404", r.status === 404, `status ${r.status}`)
}
r = await http('/api/auth/devices', { noCookie: true, headers: bearer(g2.access_token) })
const d2 = ((await r.json()).data ?? []).find((d) => d.current)
r = await http(`/api/auth/devices/${d2?.id}`, { method: 'DELETE', noCookie: true, headers: bearer(g2.access_token) })
check('DELETE /api/auth/devices/:id signs the phone out', r.status < 300, `status ${r.status}`)
r = await http('/api/auth/me', { noCookie: true, headers: bearer(g2.access_token) })
check('next call with the old token is 401', r.status === 401, `status ${r.status}`)
r = await tokenCall({ grant_type: 'refresh_token', refresh_token: g2.refresh_token, install_id: install })
check('its refresh token no longer works', r.status === 400, `status ${r.status}`)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)

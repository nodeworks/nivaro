import { config } from '../config.js'
import { db } from '../db/index.js'
import { oidcConfigured } from './oidc.js'

/**
 * Is the primary env-configured provider offered on the login page?
 *  - Blank OIDC_ISSUER / OIDC_CLIENT_ID → no (nothing configured).
 *  - OIDC_ENABLED=false → honored ONLY when at least one ACTIVE custom provider
 *    (nivaro_sso_providers) exists to take over interactive sign-in; with none, the flag is
 *    ignored so an instance cannot disable its way into a lockout.
 * Used by routes/auth.ts (login page, /login) and the Hub's ping (routes/hub-oidc.ts): a Hub
 * whose primary sign-in is off captures no Entra evidence, so no app can sign in through it.
 */
export async function primaryOidcEnabled(): Promise<boolean> {
  if (!oidcConfigured()) return false
  // Disable comes from EITHER the OIDC_ENABLED=false env flag or the
  // Settings → Sign-in providers toggle (nivaro_settings.oidc_primary_disabled).
  let disabled = !config.OIDC_ENABLED
  if (!disabled) {
    const row = (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first('oidc_primary_disabled')
      .catch(() => null)) as { oidc_primary_disabled?: boolean | number } | null
    disabled = row?.oidc_primary_disabled === true || row?.oidc_primary_disabled === 1
  }
  if (!disabled) return true
  const custom = await db('nivaro_sso_providers')
    .where({ is_active: true })
    .first('id')
    .catch(() => null)
  // No custom provider to take over → the disable is IGNORED (no lockout).
  return !custom
}

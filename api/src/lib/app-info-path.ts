/** The phone app's "what is this instance" probe: it must answer on a suspended or provisioning tenant. */
export const APP_INFO_PATH = '/api/app-info'

/** True for the app-info route (query string allowed), nothing else. */
export function isAppInfoPath(url: string): boolean {
  return url === APP_INFO_PATH || url.startsWith(`${APP_INFO_PATH}?`)
}

export type TenantBlock = 'suspended' | 'provisioning'

/** Set on the request by the tenant hook when it lets app-info through a blocked tenant. */
export interface TenantBlockMark {
  nvrTenantBlock?: { kind: TenantBlock; name: string }
}

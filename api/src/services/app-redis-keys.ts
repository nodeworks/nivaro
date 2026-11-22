import { appKeyPart } from './tenancy/credential-binding.js'

// Redis keys built in heavy route modules, kept here so their app part (Hub shared deployments,
// Hub phase 6 Task 12) is one tested place. Off a shared deployment each key is unchanged.

/** An async bulk run's results (24 h). Run ids are per-app integers: copied apps share them. */
export function bulkResultKey(runId: string | number): string {
  return `nvr:bulk:${appKeyPart()}${runId}`
}

/** One fixed-window counter of the per-key / per-connection rate limit. Key ids are per-app
 *  integers, so two apps' key 3 must not spend one budget. */
export function rateWindowKey(bucket: string, windowStart: number): string {
  return `nvr:keyrl:${appKeyPart()}${bucket}:${windowStart}`
}

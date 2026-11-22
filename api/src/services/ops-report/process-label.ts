/**
 * Hub phase 5 (P5-10): on a shared deployment the daily operations report runs once per app,
 * but its memory and pool figures belong to the one process that serves every app. They are
 * labelled so. Self-hosted and cloud: labels and digest JSON unchanged.
 */
import { perAppJobs } from '../deployment-mode.js'

/** `label`, marked as the shared process's on a shared deployment. */
export function processFigureLabel(label: string): string {
  return perAppJobs() ? `${label} (the shared process, which serves every app)` : label
}

/** Spread into the digest's `capacity`: `shared_process: true` on a shared deployment only. */
export function sharedProcessFlag(): { shared_process?: true } {
  return perAppJobs() ? { shared_process: true } : {}
}

import { noteApprovalWrite } from '../services/approval-changes.js'
import { hooks } from './registry.js'

/**
 * "Changed after approval" (round 7, item 21): every real update through the items service
 * may open a change burst on a record that sits in an approved state. The burst's one notice to
 * the approvers goes out GATHER_MS later (services/approval-changes.ts). A rehearsal never
 * counts; a collection with the badge off costs one cached metadata read.
 */
export function registerApprovalChangeHooks() {
  hooks.after('*', 'update', async (ctx) => {
    if (ctx.dryRun || !ctx.keys?.length) return
    await noteApprovalWrite(ctx.collection, ctx.keys, ctx.user?.id ? String(ctx.user.id) : null)
  })
}

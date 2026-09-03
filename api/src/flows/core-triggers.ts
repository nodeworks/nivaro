import { registerTrigger } from './registry.js'

// ─── Core flow triggers ──────────────────────────────────────────────────────
// Built-in trigger types emitted by the platform itself (extensions add their
// own via ctx.flows.registerTrigger). Registered at boot from index.ts.

export function registerCoreTriggers(): void {
  registerTrigger({
    type: 'workflow-transition',
    label: 'Workflow Transition',
    description:
      'Fires after any workflow/pipeline transition lands (manual or automatic). ' +
      'Payload: collection, item, template, transition_label, source (manual|auto), comment, ' +
      'user_id, from_state {key,label}, to_state {key,label}, owners (resolved owner list for ' +
      'the NEW state: id/email/first_name/last_name) and owner_emails (comma-joined). ' +
      'Filter with a Condition operation (e.g. collection eq inventory_request, ' +
      'to_state.key eq finance_review).',
    fields: []
  })
  registerTrigger({
    type: 'staged-import-completed',
    label: 'Staged Import Completed',
    description:
      'Fires after a staged (file → staging table → procedure) import run completes successfully. ' +
      'Payload: run_id, import_key, definition_label, staging_table, procedure, row_count, ' +
      'duration_seconds, created_by. Filter with a Condition operation ' +
      '(e.g. import_key eq purchase_orders).',
    fields: []
  })
}

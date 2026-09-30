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
      'Filter with a Condition operation (e.g. collection eq orders, ' +
      'to_state.key eq review).',
    fields: []
  })
  registerTrigger({
    type: 'field-watch',
    label: 'Watched Field Changed',
    description:
      'Fires when a field with an active field watch changes value (through the items service). ' +
      'Payload: collection, item, field, watch_id, watch_name, old, new, user_id. ' +
      'Filter with a Condition operation (e.g. collection eq orders, field eq amount).',
    fields: []
  })
  registerTrigger({
    type: 'staged-import-completed',
    label: 'Staged Import Completed',
    description:
      'Fires after a staged (file → staging table → procedure) import run completes successfully. ' +
      'Payload: run_id, import_key, definition_label, staging_table, procedure, row_count, ' +
      'duration_seconds, created_by. Filter with a Condition operation ' +
      '(e.g. import_key eq orders).',
    fields: []
  })
  registerTrigger({
    type: 'chat-message',
    label: 'Chat Message',
    description:
      'Fires when a person posts a chat message (never the assistant or a platform line). ' +
      'Payload: room, room_kind (global|dm|channel|entity), room_prefix + room_token (record rooms), ' +
      'message_id, parent_id (thread replies), sender, sender_name, text, has_attachments, urgent. ' +
      'Filter with a Condition operation (e.g. room eq ch:ops, text contains "outage").',
    fields: []
  })
}

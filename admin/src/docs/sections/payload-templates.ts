import type { DocSection } from '../types.js'

export const payloadTemplates: DocSection = {
  id: 'payload-templates',
  label: 'Partner Payload Templates',
  content: [
    { type: 'h1', id: 'payload-templates', text: 'Partner Payload Templates' },
    {
      type: 'p',
      text: 'A payload template is the named, versioned JSON body Nivaro sends to a partner API. You edit a **draft**, check it against real records, then **publish** it; a push only ever sends the published version. Templates live on the External API they belong to (External APIs → the API → **Payloads** card) and open in a full-width editor at `/external-apis/:id/payloads/:key`. Changing a field no longer needs a code push or a go-live script.'
    },
    { type: 'h2', id: 'pt-lifecycle', text: 'Draft, publish, versions' },
    {
      type: 'ul',
      items: [
        '**Draft** — the working copy. Autosaves; it never reaches a partner. The header shows an amber "Draft — not live" chip while it differs from the live version.',
        '**Publish** — needs a note and shows a before/after payload diff for a real record. If recent records would fail, the panel asks you to confirm ("Publish anyway — N records would fail"). Every publish is an immutable version.',
        '**History** — any version can be restored as the draft. **Reset to default** restores the file default an extension registered.',
        "**Conflicts** — drafts use a revision counter; saving over someone else's newer draft, or over a version published since you opened the page, is refused with a conflict banner (HTTP 409) so you can reload.",
        '**Sharing** — one template can be used by many transitions and code pushes. The header lists them under "Used by".'
      ]
    },
    { type: 'h2', id: 'pt-field-map', text: 'The field map' },
    {
      type: 'p',
      text: 'The default editor builds the JSON from rows, never typed text, so the body is always valid JSON with the right types. Each row is a key, a type, a value source, an include rule and optional checks.'
    },
    {
      type: 'table',
      head: ['Part', 'Options'],
      rows: [
        ['Type', 'text, number, boolean, date (`YYYY-MM-DD`), object, list, json'],
        [
          'Value source',
          'Fixed value · Record field (a path, e.g. `record.shipping_location.inventory_org`) · Related (data lookups) · Built-in (`today`, `now`, `acting_user.email|name|employee_id`, `list.number`, `state.label`, `state.external_label`) · API secret · If/then (switch on conditions, with an else) · Formula (Liquid)'
        ],
        [
          'Transforms',
          'trim, upper, lower, truncate, prefix, suffix, pad start, replace, date format, add days, at least N days out, next open day (respects blackout dates), editor text, join. Applied in order; they skip empty values.'
        ],
        [
          'Fallbacks',
          'An "else …" chain: the first candidate whose transformed result is non-empty wins. Each candidate has its own transforms.'
        ],
        [
          'Include',
          'Always · Only when not empty (drops the key for null, empty text or an empty list) · Only when conditions match'
        ],
        [
          'Checks',
          'required, max length, min / max, allowed values, regex pattern (at most 200 characters, tested against the first 10,000 characters of the value)'
        ],
        [
          'Groups and lists',
          'An object nests rows. A list repeats its rows for each item of a source (`where`, `sort`, a numbering alias for the 1-based index after filtering); a scalar list produces plain values.'
        ],
        [
          'Locked keys',
          'Keys Nivaro reads back from stored payloads (obligation reconciliation, drift checks) show a lock. They cannot be removed, renamed or retyped; their value source can still change. A locked key may be `not_empty` (it need not appear in every body).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'The client never evaluates a template. Values shown in the editor come from the server preview, so the editor, the preview and a real push cannot disagree.'
    },
    { type: 'h2', id: 'pt-code', text: 'Code mode and Convert' },
    {
      type: 'p',
      text: "A template can be in **code** mode: Liquid text that renders to JSON, with the same engine, filters and scope as an inline erp_submit `payload_template`, plus the locked-key and rule checks on the parsed result. A map template's **Code** tab shows the spec JSON (schema-validated on save) and **Convert to Liquid**. Convert generates Liquid, renders the map and the Liquid against the recent-records set and refuses unless every body is identical, listing the differing paths. Conversion is one way: a code template has no field map. A draft's mode changes only through Convert."
    },
    {
      type: 'warn',
      text: 'Code mode is JSON assembled from text. A value containing a quote can break the body unless the template runs it through `jsonify`; the editor warns about unescaped output and duplicate keys. Prefer the field map.'
    },
    { type: 'h2', id: 'pt-preview', text: 'Preview and Check recent records' },
    {
      type: 'ul',
      items: [
        "**Preview** — pick any record of the template's collection (search by id or name; newest by default). The JSON pane toggles **Draft · Live · Diff**. The preview builds the record scope exactly as the push does: `acting_user` is read from the user record for you, the way a transition push reads it for whoever moved the record, and a template whose extension builds its own scope previews without one (that push sends none).",
        '**Problems** list under the rows and the JSON: unknown path on this record, duplicate or empty key, type mismatch, rule failure, missing body secret, list source that is not a list, Liquid errors with the message.',
        '**Check recent records** — renders the newest 20 records (in chunks, with an N / M counter) and lists which fail and why. A record the sender would skip is not counted as a failure.',
        "**Data** tab — the lookups the template can read. An erp_submit template shows the referencing action's context read-only plus its own editable lookups; a code-built template shows the registrar's description of its variables."
      ]
    },
    { type: 'h2', id: 'pt-push-checks', text: 'What happens at push time' },
    {
      type: 'p',
      text: 'After the published template renders, locked keys and per-field checks run. A failure is a recorded failed submission (message names the key and rule) and the obligation resolves failed; nothing is sent. A template that has never been published also blocks the push. A failed render is recorded with no body and the `validation` error class, so no retry ladder picks it up, and every resend (Retry, Bulk retry, Send now, the retry sweeps) refuses it with 409 `no_body` ("This submission has no body to resend"). Pushes that already stored a body re-send that stored body on retry.'
    },
    { type: 'h2', id: 'pt-body-secrets', text: 'Body secrets' },
    {
      type: 'p',
      text: 'Some partners take their credential inside the JSON body, not in a header. Store it once on the External API: **Body secrets** card, saved in `auth_config.body_secrets` as `{name: value}`. Values are masked on every read, kept when a masked value is re-saved, and an instance override (`instance_overrides.<instance>.auth_config.body_secrets`) is deep-merged per name, so production can override just one secret.'
    },
    {
      type: 'p',
      text: 'Templates, previews, stored submissions and call logs only ever hold the placeholder `⟦nvr-secret:<name>⟧` (the "API secret" value source, or `secrets.<name>` / `| secret` in code mode). `callExternalApi` swaps the real value in after the body is final and before it is serialised and signed, only when the caller passes `bodySecrets: true`. erp_submit sends and retries, the flow `external-api` operation, the API\'s Test call and extension calls for a registered template do. A missing secret refuses the call with "<API> API has no body secret \'<name>\'" and sends nothing; mock mode never substitutes.'
    },
    {
      type: 'warn',
      text: 'Never type a credential into a template or a flow body. Record, trigger and response data is neutralised (a zero-width space is inserted into any `⟦nvr-secret:` it contains), so only text an administrator wrote can pull a secret in. Echoed secrets are scrubbed from stored responses and logs. Stored submissions carry `secret_paths`; a retry substitutes only at those paths, and a row without them fails closed.'
    },
    { type: 'h2', id: 'pt-erp-submit', text: 'Using a template from a pipeline action' },
    {
      type: 'p',
      text: 'An `erp_submit` transition action takes a `payload_template_key`. When set it wins over the inline `payload_template`, and the action is configured when either exists. In the pipeline editor the action\'s **Payload** field is a Combobox of the templates for the action\'s External API ("MWF workflow status · Live v7") with **Open template**; "Custom (inline Liquid)" keeps the old textarea. A template belongs to one External API: pointing an action at another API\'s template records a failed push and shows a preview problem. Template-level lookups merge into `context`; the action\'s own context wins on a key clash. Exporting a transition that names a template key bundles the template into a blueprint.'
    },
    { type: 'h2', id: 'pt-extension-api', text: 'Extension API' },
    {
      type: 'pre',
      code: `// register() — seeded once; an existing template is never overwritten
await ctx.payloadTemplates.register({
  key: 'mwf-ir-order',                   // ^[a-z0-9-]+$, at most 120
  label: 'MWF inventory request order',
  external_api: 'MWF',                    // callExternalApi name
  endpoint_path: '/update_workflow.php',  // display + preview only
  collection: 'inventory_request',
  default: { mode: 'map', body: specJson },
  locked_keys: ['workflow_id', 'order_id'],
  lookups: {},                            // same shape as erp_submit context
  scope: (id) => buildScope(id),          // the SAME builder the push uses
  recent: (limit) => newestIds(limit),
  senders: ['efp-ops: Submit to Warehouse']
})

// render() — PUBLISHED version; rejects with problems when nothing is publishable
const { body, problems, version } = await ctx.payloadTemplates.render(key, scope)
await ctx.callExternalApi('MWF', { method: 'POST', body, bodySecrets: true })

// Skip a push when the credential is not configured
if (!(await ctx.payloadTemplates.hasBodySecret('MWF', 'token'))) return

// Before STORING a partner answer: body secrets back to their placeholders
const stored = await ctx.payloadTemplates.scrubResponse('MWF', res.body)`
    },
    {
      type: 'p',
      text: 'Validate before side effects: a throw inside a `register()` call kills the extension\'s whole register. The seed is hashed; when the shipped default later differs, the editor shows "ships a newer default" with a diff and **Use as draft**. Declared `lookups` follow the code only while the template still holds its seed; once someone has published from the editor, changed lookups also show as a newer default (**Reset to default** brings back the body and lookups together). File changes never go live by themselves. A registered template cannot be deleted from the UI. Types are mirrored in `@nivaro/extension-kit`.'
    },
    { type: 'h2', id: 'pt-routes', text: 'REST routes' },
    {
      type: 'p',
      text: 'All under `/api/payload-templates`, administrators only. Responses include a `warning` string when `PAYLOAD_EDIT_WARNING` is set.'
    },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET /?external_api=`',
          'List with status (live / draft changes / unpublished), version, used-by count, newer-default flag'
        ],
        ['`GET /:key`', 'One template with draft, published version, used-by, default info'],
        ['`POST /`', 'Create `{key, label, external_api, endpoint_path, collection, mode, body}`'],
        [
          '`DELETE /:key`',
          'Refused (409) when an extension registers it or transitions still use it'
        ],
        [
          '`PUT /:key/draft`',
          '`{mode, body, base_rev, base_published_version?}`; 409 `stale` returns the current row'
        ],
        ['`PUT /:key/lookups`', 'Template-level lookups, validated like erp_submit context'],
        [
          '`POST /:key/preview`',
          '`{id, which: draft|published, draft?}` render one record with problems'
        ],
        ['`GET /:key/recent`', 'The newest record ids Check renders'],
        [
          '`POST /:key/check`',
          '`{which, limit?, ids?}` render recent records (default 20) and list failures'
        ],
        ['`GET /:key/record-search?q=`', 'Record picker for previews'],
        ['`POST /:key/publish`', '`{base_rev, note}` (note required)'],
        ['`GET /:key/versions`, `GET /:key/versions/:v`', 'History'],
        ['`POST /:key/versions/:v/restore`', 'Restore a version as the draft'],
        ['`POST /:key/reset-default`', 'Reset the draft to the registered default'],
        [
          '`POST /:key/convert`',
          '`{base_rev}` map to Liquid; 422 with differing paths when not identical'
        ]
      ]
    },
    {
      type: 'p',
      text: "Collections whose names start with `nivaro_` or `directus_` can never be a template's record type or a lookup. `/payload-templates/:key` in the admin redirects to the owning API's editor, which is where config search links."
    },
    { type: 'h2', id: 'pt-environments', text: 'Environments and promotion' },
    {
      type: 'p',
      text: 'Templates, versions and drafts are configuration: they ride config snapshots, Config Diff and promotion between environments, and every row restores by id (a restore that removes a template removes its draft and versions first). Where a nightly promotion replaces them, set `PAYLOAD_EDIT_WARNING` (for example "Payload templates here are replaced every night from development. Make lasting changes on development.") to show a banner on the list, the API\'s Payloads card and the editor. Editing drafts does not move the config epoch; publish, restore and reset do.'
    }
  ]
}

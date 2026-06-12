import type { DocSection } from '../types.js'

export const sdkSetup: DocSection = {
  id: 'sdk-setup',
  label: 'Setup',
  content: [
    { type: 'h1', id: 'sdk-setup', text: 'SDK — Setup' },
    { type: 'p', text: 'The `@nivaro/sdk` package is a typed client for the Nivaro API.' },
    {
      type: 'pre',
      code: `# Install
pnpm add @nivaro/sdk

# TypeScript import
import { createNivaro, readItems, createItem, updateItem, deleteItem } from '@nivaro/sdk'`
    },
    { type: 'h3', text: 'Create a client' },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

// Pass the base URL of the Nivaro API server
const nivaro = createNivaro('https://nivaro.example.com')

// Optionally, seed an initial token
const nivaro = createNivaro('https://nivaro.example.com', { token: 'your-static-token' })`
    },
    {
      type: 'p',
      text: 'The `createNivaro` function returns a `NivaroClient` — a single object with `request()`, `graphql()`, `upload()`, `fileUrl()`, `setToken()`, and `getToken()`.'
    }
  ]
}

export const sdkAuth: DocSection = {
  id: 'sdk-auth',
  label: 'Authentication',
  content: [
    { type: 'h1', id: 'sdk-auth', text: 'SDK — Authentication' },
    {
      type: 'p',
      text: "The SDK attaches the current token as an `Authorization: Bearer` header on every request. It also sets `credentials: 'include'` so browser session cookies are forwarded automatically."
    },
    { type: 'h3', text: 'Static token (scripts / server-side)' },
    {
      type: 'pre',
      code: `// Set at creation time
const nivaro = createNivaro('https://nivaro.example.com', { token: 'abc123...' })

// Or set at runtime (e.g. after generating a token via the API)
nivaro.setToken('abc123...')

// Read the current token
const t = nivaro.getToken()  // string | undefined

// Remove the token (revert to session-cookie-only)
nivaro.setToken(null)`
    },
    { type: 'h3', text: 'Session cookie (browser)' },
    {
      type: 'p',
      text: 'In a browser environment where the user has logged in via OIDC, the session cookie is sent automatically. You do not need to call `setToken()` unless you want to use a static token instead.'
    }
  ]
}

export const sdkRest: DocSection = {
  id: 'sdk-rest',
  label: 'REST Commands',
  content: [
    { type: 'h1', id: 'sdk-rest', text: 'SDK — REST Commands' },
    {
      type: 'p',
      text: 'All REST operations are performed via `nivaro.request(command)`. Command factories are pure functions — they return a descriptor that `request()` executes.'
    },
    { type: 'h3', text: 'Items' },
    {
      type: 'pre',
      code: `import { readItems, readItem, createItem, updateItem, deleteItem } from '@nivaro/sdk'

// List with filter + sort
const list = await nivaro.request(readItems('articles', {
  filter: { status: { _eq: 'active' } },
  sort: ['-created_at'],
  limit: 50,
}))
// list.data → T[], list.total, list.limit, list.offset

// Single item
const item = await nivaro.request(readItem('articles', '123'))
// item.data → T

// Create
const created = await nivaro.request(createItem('articles', { name: 'New', status: 'draft' }))

// Update (partial — only pass changed fields)
const updated = await nivaro.request(updateItem('articles', '123', { status: 'active' }))

// Delete
await nivaro.request(deleteItem('articles', '123'))`
    },
    { type: 'h3', text: 'Singletons' },
    {
      type: 'pre',
      code: `import { readSingleton, updateSingleton } from '@nivaro/sdk'

const settings = await nivaro.request(readSingleton('nivaro_settings'))
await nivaro.request(updateSingleton('nivaro_settings', { project_name: 'My Project' }))`
    },
    { type: 'h3', text: 'Users & revisions' },
    {
      type: 'pre',
      code: `import { readMe, updateMe, readUsers, readRevisions } from '@nivaro/sdk'

const me = await nivaro.request(readMe())
await nivaro.request(updateMe({ first_name: 'Rob' }))
const revs = await nivaro.request(readRevisions('articles', '123'))`
    }
  ]
}

export const sdkWorkflow: DocSection = {
  id: 'sdk-workflow',
  label: 'Workflow Commands',
  content: [
    { type: 'h1', id: 'sdk-workflow', text: 'SDK — Workflow Commands' },
    {
      type: 'p',
      text: 'Workflow commands read and drive the state machine bound to any collection. All routes live under `/api/pipelines` (pipelines and workflows share the same engine).'
    },
    {
      type: 'pre',
      code: `import {
  readWorkflowInstance, startWorkflow, transitionWorkflow, readWorkflowInstances
} from '@nivaro/sdk'

// Get current state, available transitions, and history for an item
const wf = await nivaro.request(readWorkflowInstance('inventory_requests', itemId))
// wf.data === null  → no workflow bound to this collection
// wf.data.instance  → { current_state, started_at, completed_at, ... }
// wf.data.states    → all states with id, key, label, color
// wf.data.available_transitions → transitions the caller's role can execute
// wf.data.history   → immutable log of every transition taken

// Find the current state label
const currentState = wf.data.states.find(s => s.id === wf.data.instance?.current_state)

// Start the workflow (creates instance in the initial state)
await nivaro.request(startWorkflow('inventory_requests', itemId))

// Execute a transition
await nivaro.request(
  transitionWorkflow('inventory_requests', itemId, transition.id, 'Approved — looks good')
)

// List all instances for a collection (summary rows, admin use)
const all = await nivaro.request(readWorkflowInstances('inventory_requests'))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        [
          'readWorkflowInstance(col, item)',
          'GET /pipelines/instance/:col/:item',
          'Any authenticated user'
        ],
        [
          'startWorkflow(col, item)',
          'POST /pipelines/instance/:col/:item/start',
          'Any authenticated user'
        ],
        [
          'transitionWorkflow(col, item, txId, comment?)',
          'POST /pipelines/instance/:col/:item/transition',
          'Role-gated per transition'
        ],
        ['readWorkflowInstances(col)', 'GET /pipelines/instances/:col', 'Any authenticated user'],
        ['readWorkflowBindings()', 'GET /pipelines/bindings', 'Admin']
      ]
    }
  ]
}

export const sdkPipeline: DocSection = {
  id: 'sdk-pipeline',
  label: 'Pipeline & Owners',
  content: [
    { type: 'h1', id: 'sdk-pipeline', text: 'SDK — Pipeline & Owners' },
    {
      type: 'p',
      text: 'The Pipeline Owner Matrix resolves which users own each state of a workflow instance. Use these commands to read and manage ownership.'
    },
    { type: 'h3', text: 'Reading owners' },
    {
      type: 'pre',
      code: `import {
  readInstanceOwners, readStateOwners, readAllStateOwners
} from '@nivaro/sdk'

// Current state owners — the primary call for "who owns this right now?"
const { data: owners } = await nivaro.request(readInstanceOwners('inventory_requests', itemId))
// owners → ResolvedOwner[] — { id, email, first_name, last_name }

// Owners for a specific (non-current) state
const { data } = await nivaro.request(
  readStateOwners('inventory_requests', itemId, 'state-uuid-here')
)
// data.state   → { id, key, label, color, ... }
// data.owners  → ResolvedOwner[]

// All states at once — avoids N round-trips
const { data: allOwners } = await nivaro.request(
  readAllStateOwners('inventory_requests', itemId)
)
// allOwners → Record<stateId, { state, owners }> | null (null if no pipeline bound)
const reviewOwners = allOwners?.['review-state-uuid']?.owners`
    },
    { type: 'h3', text: 'Managing instance owners' },
    {
      type: 'pre',
      code: `import { addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Assign a user as owner (optional: scope to a specific state)
const { data: owner } = await nivaro.request(
  addInstanceOwner('inventory_requests', itemId, 'user-uuid', 'state-uuid')
)

// Remove an owner assignment by its row ID
await nivaro.request(removeInstanceOwner(owner.id))`
    },
    { type: 'h3', text: 'Template data (admin)' },
    {
      type: 'pre',
      code: `import { readPipelineTemplates, readOwnerGroups, readStateOwnerGroups } from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Owner groups for all states, keyed by state ID
const { data: groups } = await nivaro.request(readOwnerGroups(templateId))
// groups['state-uuid'] → PipelineOwnerGroup[] with .filters and .users`
    },
    {
      type: 'note',
      text: '`readInstanceOwners` / `readStateOwners` apply the full matrix resolution — group filters evaluated against the actual record + instance owner overrides. `readOwnerGroups` returns the raw template configuration without applying any item-specific filter context.'
    }
  ]
}

export const sdkForms: DocSection = {
  id: 'sdk-forms',
  label: 'Form Schema',
  content: [
    { type: 'h1', id: 'sdk-forms', text: 'SDK — Form Schema' },
    {
      type: 'p',
      text: '`fetchFormSchema` aggregates collection metadata, fields, groups, and relations into a single normalized `FormSchema` — one round-trip instead of separate calls to collections, fields, field-groups, and relations. The remaining helpers cover the rest of a typical form lifecycle: evaluating inline field rules as the user types, loading relation options for M2O/M2M pickers, and submitting the completed item.'
    },
    {
      type: 'pre',
      code: `import {
  fetchFormSchema, evaluateFieldRules, readRelationOptions, submitFormItem
} from '@nivaro/sdk'

// 1. Load the normalized schema for a collection
const schema = await nivaro.request(fetchFormSchema('inventory_requests'))
// schema → {
//   collection,    // collection metadata
//   fields,        // FormField[] — type, interface, required, validation_rules, ...
//   groups,        // FieldGroup[] — section/tab definitions, sorted
//   relations,     // RelationMeta[] — m2o/o2m/m2m/m2a, related_collection + display_field
// }

// 2. Evaluate inline field rules against the in-progress values (no save)
const { updates } = await nivaro.request(
  evaluateFieldRules('inventory_requests', { category: 'hardware', priority: null })
)
// updates → only the fields the rules changed, e.g. { priority: 'high' }

// 3. Load options for a relation field (M2O / M2M picker)
const { data: options } = await nivaro.request(
  readRelationOptions('inventory_requests', 'assigned_to', { search: 'jane', limit: 25 })
)
// options → [{ value, label }] — label rendered from the relation's display template

// 4. Submit the completed item (create or update)
const created = await nivaro.request(
  submitFormItem('inventory_requests', { mode: 'create', values })
)
const updated = await nivaro.request(
  submitFormItem('inventory_requests', { mode: 'edit', itemId: '123', values })
)`
    },
    {
      type: 'table',
      head: ['Function', 'Returns', 'Notes'],
      rows: [
        [
          'fetchFormSchema(collection)',
          'FormSchema',
          'Collection + fields + groups + relations, normalized into one object.'
        ],
        [
          'evaluateFieldRules(collection, values)',
          '{ updates }',
          'Server-evaluates inline field rules; returns only changed fields. Computes without saving.'
        ],
        [
          'readRelationOptions(collection, field, opts?)',
          '{ value, label }[]',
          'Options for an M2O/M2M field; opts accepts search and limit.'
        ],
        [
          'submitFormItem(collection, { mode, itemId?, values })',
          'T',
          "mode: 'create' calls createItem; mode: 'edit' calls updateItem against itemId."
        ]
      ]
    },
    {
      type: 'note',
      text: 'The Form Schema commands use the same **snake_case** field shape as the rest of the REST API (`validation_rules`, `related_collection`, `display_field`). The `@nivaro/react` package wraps these into a camelCase form runtime (`validationRules`, `fieldType`) and is documented as a separate API — do not mix the two casing conventions.'
    },
    {
      type: 'note',
      text: 'For end-user public submission forms (no SDK, embeddable via `widget.js`), see the Submission Forms docs — that is a separate, hosted feature distinct from the Form Schema SDK.'
    }
  ]
}

export const sdkReact: DocSection = {
  id: 'sdk-react',
  label: 'React (@nivaro/react)',
  content: [
    { type: 'h1', id: 'sdk-react', text: 'SDK — React (@nivaro/react)' },
    {
      type: 'p',
      text: '`@nivaro/react` is a React form runtime built on top of `@nivaro/sdk`. It turns a collection into a fully-wired form: schema loading, field rules, visibility/lock evaluation, relation options, validation, and submit — all behind a single `useNivaroForm` hook. Use the headless hook with your own inputs, or `<NivaroForm>` to auto-render fields from the schema.'
    },
    {
      type: 'note',
      text: 'The React runtime exposes a **camelCase** API (`fieldType`, `validationRules`) — distinct from the snake_case shape of the underlying SDK Form Schema commands. Treat them as separate APIs.'
    },
    { type: 'h3', text: 'Installation' },
    {
      type: 'pre',
      code: 'pnpm add @nivaro/react @nivaro/sdk'
    },
    { type: 'h3', text: 'Setup' },
    {
      type: 'p',
      text: 'Wrap your app in `<NivaroProvider>` with a configured SDK client. The provider supplies the client to every form hook below it.'
    },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider } from '@nivaro/react'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

function App() {
  return (
    <NivaroProvider client={nivaro}>
      <RequestForm />
    </NivaroProvider>
  )
}`
    },
    { type: 'h3', text: 'useNivaroForm' },
    {
      type: 'p',
      text: 'The hook loads the schema, manages values and errors, and wires submit. Pass the collection and a mode (`create` or `edit`).'
    },
    {
      type: 'pre',
      code: `const form = useNivaroForm('inventory_requests', {
  mode: 'create',                  // 'create' | 'edit'
  itemId: '123',                   // required when mode === 'edit'
  defaultValues: { priority: 'low' },
  onSuccess: (item) => navigate(\`/requests/\${item.id}\`),
  onError: (err) => toast.error(err.message),
})`
    },
    {
      type: 'table',
      head: ['Returned', 'Description'],
      rows: [
        ['values', 'Current form values keyed by field name.'],
        ['errors', 'Validation errors keyed by field name (empty when valid).'],
        [
          'setValue(field, value)',
          'Update one field; re-runs field rules and visibility/lock evaluation.'
        ],
        [
          'handleSubmit(e?)',
          'Validates, then creates or updates via the SDK; fires onSuccess / onError.'
        ],
        ['isVisible(field)', 'Whether a field passes its visibility rules for the current values.'],
        ['isLocked(field)', 'Whether a field is locked (read-only) for the current values.'],
        ['schema', 'The normalized FormSchema (camelCase: fieldType, validationRules, ...).'],
        ['fieldsByGroup', 'Fields bucketed by group key for rendering sections/tabs.'],
        ['visibleGroups', 'Group definitions that currently have at least one visible field.']
      ]
    },
    { type: 'h3', text: 'Styled example (custom inputs)' },
    {
      type: 'p',
      text: 'Drive your own markup directly from the hook — full control over inputs and layout.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm } from '@nivaro/react'

function RequestForm() {
  const form = useNivaroForm('inventory_requests', {
    mode: 'create',
    onSuccess: (item) => console.log('created', item.id),
  })

  if (!form.schema) return <p>Loading…</p>

  return (
    <form onSubmit={form.handleSubmit} className="space-y-4">
      {form.schema.fields.map((field) =>
        form.isVisible(field.field) ? (
          <label key={field.field} className="block">
            <span className="text-sm font-medium">{field.label}</span>
            <input
              className="mt-1 w-full rounded border px-3 py-2"
              value={form.values[field.field] ?? ''}
              disabled={form.isLocked(field.field)}
              onChange={(e) => form.setValue(field.field, e.target.value)}
            />
            {form.errors[field.field] && (
              <span className="text-xs text-red-600">{form.errors[field.field]}</span>
            )}
          </label>
        ) : null
      )}
      <button type="submit" className="rounded bg-nvr-cyan px-4 py-2 text-white">
        Submit
      </button>
    </form>
  )
}`
    },
    { type: 'h3', text: 'Unstyled example (NivaroForm auto-render)' },
    {
      type: 'p',
      text: '`<NivaroForm form={form}>` renders every visible field from the schema automatically. Use `renderField` for a per-field override, or `components` to swap the default input element per field type.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, NivaroForm } from '@nivaro/react'

function RequestForm() {
  const form = useNivaroForm('inventory_requests', { mode: 'create' })

  return (
    <NivaroForm
      form={form}
      // Optional: override rendering for a single field
      renderField={(field, ctx) =>
        field.field === 'notes' ? (
          <textarea value={ctx.value} onChange={(e) => ctx.setValue(e.target.value)} />
        ) : undefined  // return undefined to fall back to the default
      }
      // Optional: swap the input component per field type
      components={{
        select: MySelect,
        date: MyDatePicker,
      }}
    />
  )
}`
    }
  ]
}

export const sdkReactLayout: DocSection = {
  id: 'sdk-react-layout',
  label: 'React — Layout Hooks',
  content: [
    { type: 'h1', id: 'sdk-react-layout', text: 'SDK — React Layout Hooks (@nivaro/react)' },
    {
      type: 'p',
      text: 'These hooks work alongside `useNivaroForm` and require a form returned by that hook. They expose the active collection layout (tabs, sections, col_span grid, ungrouped zone position) plus field-level state, dirty tracking, and repeater management. Import all hooks from `@nivaro/react`.'
    },
    {
      type: 'note',
      text: '`FormSchema` now includes `ungroupedSort: number | null` — the configured position of the Ungrouped zone relative to named groups. `fetchFormSchema` and `useFormSchema` fetch this automatically from the active layout endpoint; no extra call is needed.'
    },

    { type: 'h3', text: 'LayoutForm — layout-aware auto-renderer' },
    {
      type: 'p',
      text: '`<LayoutForm>` renders the full form using the active layout: tabs (if any), named sections with a col_span grid inside each, and an Ungrouped zone at its configured position. It is a drop-in replacement for iterating `form.schema.fields` manually when you want correct group/tab/grid rendering out of the box.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, LayoutForm } from '@nivaro/react'

function RequestForm() {
  const form = useNivaroForm('inventory_requests', { mode: 'create' })

  return (
    <LayoutForm
      form={form}
      // Optional per-field override — return undefined to use the default renderer
      renderField={(field, ctx) =>
        field.field === 'notes'
          ? <textarea value={ctx.value ?? ''} onChange={(e) => ctx.onChange(e.target.value)} />
          : undefined
      }
    />
  )
}`
    },

    { type: 'h3', text: 'useOrderedLayout — full layout descriptor' },
    {
      type: 'p',
      text: 'Returns the ordered sequence of groups and ungrouped fields, respecting `ungroupedSort`. Use this as the single source of truth when building a custom layout renderer.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useOrderedLayout } from '@nivaro/react'

function CustomLayout() {
  const form = useNivaroForm('contracts', { mode: 'create' })
  const { items, hasTabs, tabGroups, sectionGroups, ungroupedFields } = useOrderedLayout(form)

  // items is (FormGroupDescriptor | '__ungrouped__')[] in display order
  return (
    <div>
      {items.map((item) =>
        item === '__ungrouped__'
          ? ungroupedFields.map((f) => <MyField key={f.field} field={f} form={form} />)
          : <MySection key={item.key} group={item} form={form} />
      )}
    </div>
  )
}`
    },

    { type: 'h3', text: 'useTabState — tab navigation' },
    {
      type: 'p',
      text: 'Tracks which tab is active when the layout has tab-type groups. Falls back gracefully when there are no tabs (`hasTabs === false`).'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useTabState } from '@nivaro/react'

function TabbedForm() {
  const form = useNivaroForm('projects', { mode: 'create' })
  const { activeTab, setActiveTab, tabs, hasTabs } = useTabState(form)

  if (!hasTabs) return <FlatForm form={form} />

  return (
    <div>
      <nav className="flex gap-2 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={activeTab === tab.key ? 'border-b-2 border-cyan-500' : ''}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {/* render fields for activeTab only */}
    </div>
  )
}`
    },

    { type: 'h3', text: 'useSectionState — collapse / expand sections' },
    {
      type: 'p',
      text: 'Manages collapsed state for section-type groups. Pass `defaultCollapsed: true` to start all sections closed.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useOrderedLayout, useSectionState } from '@nivaro/react'

function CollapsibleForm() {
  const form = useNivaroForm('orders', { mode: 'create' })
  const { sectionGroups } = useOrderedLayout(form)
  const { isCollapsed, toggle, collapseAll, expandAll } = useSectionState(form)

  return (
    <div>
      <div className="flex gap-2 text-sm mb-4">
        <button onClick={collapseAll}>Collapse all</button>
        <button onClick={expandAll}>Expand all</button>
      </div>
      {sectionGroups.map((section) => (
        <div key={section.key} className="border rounded mb-3">
          <button className="w-full p-3 text-left font-medium" onClick={() => toggle(section.key)}>
            {section.label} {isCollapsed(section.key) ? '▸' : '▾'}
          </button>
          {!isCollapsed(section.key) && <div className="p-3">{/* fields */}</div>}
        </div>
      ))}
    </div>
  )
}`
    },

    { type: 'h3', text: 'useFieldState — per-field descriptor' },
    {
      type: 'p',
      text: 'Returns all computed state for a single field: value, error, visibility, lock, required, col_span, and a stable `onChange` callback. Useful when building custom field wrappers that need a clean per-field API.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useFieldState } from '@nivaro/react'

function MyField({ form, fieldName }: { form: NivaroForm; fieldName: string }) {
  const { value, error, visible, locked, required, colSpan, descriptor, onChange } =
    useFieldState(form, fieldName)

  if (!visible) return null

  return (
    <div style={{ gridColumn: \`span \${colSpan}\` }}>
      <label>{descriptor.label}{required && ' *'}</label>
      <input value={value ?? ''} disabled={locked} onChange={(e) => onChange(e.target.value)} />
      {error && <span className="text-red-600 text-xs">{error}</span>}
    </div>
  )
}`
    },

    { type: 'h3', text: 'useWatchFields — reactive value slice' },
    {
      type: 'p',
      text: 'Subscribes to a subset of field values and re-renders only when those values change. Use for derived UI that depends on a few fields without watching the entire form.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useWatchFields } from '@nivaro/react'

function PricePreview({ form }: { form: NivaroForm }) {
  const { quantity, unit_price, discount } = useWatchFields(form, ['quantity', 'unit_price', 'discount'])

  const total = ((quantity ?? 0) as number) * ((unit_price ?? 0) as number)
    * (1 - ((discount ?? 0) as number) / 100)

  return <p className="text-sm text-slate-600">Total: {total.toFixed(2)}</p>
}`
    },

    { type: 'h3', text: 'useFormDirty — change tracking' },
    {
      type: 'p',
      text: 'Tracks which fields have changed from their initial values. Pass `initialValues` explicitly or omit it to compare against the values present when the hook first mounted (i.e. the loaded item in edit mode).'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useFormDirty } from '@nivaro/react'

function EditForm({ itemId }: { itemId: string }) {
  const form = useNivaroForm('contracts', { mode: 'edit', itemId })
  const { isDirty, dirtyFields, isFieldDirty } = useFormDirty(form)

  return (
    <form onSubmit={form.handleSubmit}>
      {/* ... fields ... */}
      <button type="submit" disabled={!isDirty}>
        Save changes {isDirty && \`(\${dirtyFields.length} changed)\`}
      </button>
      {isFieldDirty('title') && <span className="text-xs text-amber-600">Title modified</span>}
    </form>
  )
}`
    },

    { type: 'h3', text: 'useFormStatus — consolidated status flags' },
    {
      type: 'p',
      text: 'Combines dirty, valid, submitting, and loading flags into a single object. Useful for driving save buttons and loading states without subscribing to multiple sources.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useFormStatus } from '@nivaro/react'

function SaveBar({ form }: { form: NivaroForm }) {
  const { isDirty, isValid, isSubmitting, isLoading, canSubmit } = useFormStatus(form)

  return (
    <div className="fixed bottom-0 right-0 p-4 flex gap-2">
      {isLoading && <span>Loading schema…</span>}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={form.handleSubmit}
        className="rounded bg-nvr-cyan px-4 py-2 text-white disabled:opacity-50"
      >
        {isSubmitting ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}`
    },

    { type: 'h3', text: 'useFieldArray — repeater field management' },
    {
      type: 'p',
      text: 'Manages a repeater field as an ordered list of row objects. Provides append, remove, move, update, and replace operations — all wired to `form.setValue` so validation and dirty tracking stay in sync.'
    },
    {
      type: 'pre',
      code: `import { useNivaroForm, useFieldArray } from '@nivaro/react'

function LineItemsEditor({ form }: { form: NivaroForm }) {
  const { items, append, remove, move, update } = useFieldArray(form, 'line_items')

  return (
    <div className="space-y-2">
      {items.map((row, idx) => (
        <div key={idx} className="flex gap-2 items-center">
          <input
            value={row.description ?? ''}
            onChange={(e) => update(idx, { ...row, description: e.target.value })}
            placeholder="Description"
          />
          <input
            type="number"
            value={row.qty ?? ''}
            onChange={(e) => update(idx, { ...row, qty: Number(e.target.value) })}
            className="w-20"
          />
          <button onClick={() => remove(idx)}>✕</button>
        </div>
      ))}
      <button onClick={() => append({ description: '', qty: 1 })}>Add line</button>
    </div>
  )
}`,
    },

    {
      type: 'table',
      head: ['Export', 'Kind', 'Purpose'],
      rows: [
        ['LayoutForm', 'Component', 'Full layout-aware auto-renderer (tabs, sections, col_span grid, ungrouped zone).'],
        ['useOrderedLayout(form)', 'Hook', 'Ordered list of groups + `__ungrouped__` sentinel, reflecting `ungroupedSort`.'],
        ['useTabState(form)', 'Hook', 'Active tab + setter + tabs list; `hasTabs` false when layout has no tab groups.'],
        ['useSectionState(form, defaultCollapsed?)', 'Hook', 'Per-section collapse state; `toggle`, `collapseAll`, `expandAll`.'],
        ['useFieldState(form, field)', 'Hook', 'value, error, visible, locked, required, colSpan, descriptor, onChange for one field.'],
        ['useWatchFields(form, fields[])', 'Hook', 'Reactive Record<string, unknown> slice — re-renders only when watched values change.'],
        ['useFormDirty(form, initialValues?)', 'Hook', 'isDirty, dirtyFields[], isFieldDirty(field) — compares against initial or mounted values.'],
        ['useFormStatus(form)', 'Hook', 'isDirty, isValid, isSubmitting, isLoading, canSubmit — one-stop status object.'],
        ['useFieldArray(form, field)', 'Hook', 'append, remove, move, update, replace for ordered repeater rows.'],
      ]
    },
    {
      type: 'note',
      text: 'All layout hooks read the same `form` object returned by `useNivaroForm`. They do not create extra network requests — schema and layout data are fetched once by the hook and shared.'
    }
  ]
}

export const sdkNotifications: DocSection = {
  id: 'sdk-notifications',
  label: 'Notifications',
  content: [
    { type: 'h1', id: 'sdk-notifications', text: 'SDK — Notifications' },
    {
      type: 'pre',
      code: `import {
  readNotifications, readNotificationCount,
  markNotificationRead, markAllNotificationsRead, deleteNotification
} from '@nivaro/sdk'

// List inbox notifications for the current user
const { data: notifs } = await nivaro.request(readNotifications())
// notifs → Notification[] — { id, subject, message, status, timestamp, collection, item }

// Unread count — lightweight poll for badge
const { data: { unread } } = await nivaro.request(readNotificationCount())

// Mark one as read
await nivaro.request(markNotificationRead(notif.id))

// Mark all read
await nivaro.request(markAllNotificationsRead())

// Delete one
await nivaro.request(deleteNotification(notif.id))`
    },
    {
      type: 'note',
      text: 'For real-time delivery use the Socket.io client — the server emits `notification:new` events to the room `user:<userId>` immediately when a notification is created. See the Realtime section.'
    }
  ]
}

export const sdkActivity: DocSection = {
  id: 'sdk-activity',
  label: 'Activity & Revisions',
  content: [
    { type: 'h1', id: 'sdk-activity', text: 'SDK — Activity & Revisions' },
    { type: 'h3', text: 'Activity log' },
    {
      type: 'pre',
      code: `import { readActivity } from '@nivaro/sdk'

// All activity, newest first
const { data: entries } = await nivaro.request(readActivity({ limit: 50 }))

// Filter by collection / action / user
const { data: creates } = await nivaro.request(readActivity({
  collection: 'inventory_requests',
  action: 'create',
  limit: 25,
}))`
    },
    { type: 'h3', text: 'Revisions' },
    {
      type: 'pre',
      code: `import { readRevisions, readRevision } from '@nivaro/sdk'

// All revisions for a specific item (newest first)
const { data: revs } = await nivaro.request(readRevisions('inventory_requests', itemId))
// Each revision: { action, data (full snapshot), delta (changed fields only), timestamp, user }

// Single revision with full snapshot + delta
const { data: rev } = await nivaro.request(readRevision(revisionId))`
    },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['action', '"create" | "update" | "delete"'],
        ['data', 'Full snapshot of the record at that point in time.'],
        ['delta', 'For updates: only the changed fields. Null for create/delete.'],
        ['timestamp', 'ISO 8601 datetime.'],
        ['first_name / last_name / user_email', 'Joined from nivaro_users for display.']
      ]
    }
  ]
}

export const sdkGraphql: DocSection = {
  id: 'sdk-graphql',
  label: 'GraphQL Transport',
  content: [
    { type: 'h1', id: 'sdk-graphql', text: 'SDK — GraphQL Transport' },
    {
      type: 'p',
      text: 'Use `nivaro.graphql()` to send typed GraphQL queries. The method throws on GraphQL errors — no need to check `response.errors` manually.'
    },
    {
      type: 'pre',
      code: `interface ProjectsResult {
  articles: {
    data: Array<{ id: string; name: string; status: string }>
    total: number
  }
}

const result = await nivaro.graphql<ProjectsResult>(\`
  query {
    articles(filter: { status: { _eq: "active" } }, limit: 10) {
      data { id name status }
      total
    }
  }
\`)
const projects = result.articles.data`
    },
    { type: 'h3', text: 'With variables' },
    {
      type: 'pre',
      code: `const result = await nivaro.graphql<ProjectsResult>(
  \`query GetProjects($filter: JSON, $limit: Int) {
    articles(filter: $filter, limit: $limit) {
      data { id name }
      total
    }
  }\`,
  { filter: { status: { _eq: 'active' } }, limit: 25 },
  'GetProjects',  // optional operationName
)`
    },
    {
      type: 'note',
      text: '`nivaro.graphql()` uses the same token / session cookie as `nivaro.request()`. Call `nivaro.setToken()` once and both transports are authenticated.'
    }
  ]
}

export const sdkTokens: DocSection = {
  id: 'sdk-tokens',
  label: 'Token Management',
  content: [
    { type: 'h1', id: 'sdk-tokens', text: 'SDK — Token Management' },
    {
      type: 'p',
      text: 'Generate and revoke static tokens via the SDK without leaving TypeScript.'
    },
    {
      type: 'pre',
      code: `import { generateToken, revokeToken, generateUserToken, revokeUserToken } from '@nivaro/sdk'

// Generate a token for the currently-authenticated user
const { data } = await nivaro.request(generateToken())
nivaro.setToken(data.token)   // immediately use the new token
console.log(data.token)    // store it — not retrievable again

// Revoke your own token
await nivaro.request(revokeToken())
nivaro.setToken(null)

// Admin: generate/revoke for another user
const { data: adminData } = await nivaro.request(generateUserToken('user-uuid-here'))
await nivaro.request(revokeUserToken('user-uuid-here'))`
    },
    {
      type: 'warn',
      text: 'The token is only returned in the response body once. After `generateToken()` resolves, the value is not retrievable from the API. Save it to a secure store immediately.'
    }
  ]
}

export const sdkFiles: DocSection = {
  id: 'sdk-files',
  label: 'Files & Upload',
  content: [
    { type: 'h1', id: 'sdk-files', text: 'SDK — Files & Upload' },
    {
      type: 'pre',
      code: `// Upload a File object (e.g. from <input type="file">)
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const result = await nivaro.upload(fileInput.files![0], {
  title: 'Q2 Report',
  folder: 'folder-uuid-here',   // optional
})
// result: FileUploadResult — id, filename_disk, type, filesize, width, height, etc.

// Generate a URL to serve a file
const url = nivaro.fileUrl(result.id)   // https://nivaro.example.com/api/files/<id>

// To serve the actual file content:
//   GET /api/files/:id/content  (sets correct Content-Type header)
`
    },
    { type: 'h3', text: 'FileUploadResult shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['id', 'string', 'UUID primary key.'],
        ['filename_disk', 'string', 'Name on disk (hashed for uniqueness).'],
        ['filename_download', 'string', 'Original filename from the upload.'],
        ['title', 'string | null', 'Optional display title.'],
        ['type', 'string', 'MIME type, e.g. image/png.'],
        ['filesize', 'number', 'Bytes.'],
        ['width / height', 'number | null', 'Pixel dimensions (images only).'],
        ['folder', 'string | null', 'Folder UUID, or null for root.'],
        ['uploaded_on', 'string', 'ISO 8601 datetime.']
      ]
    }
  ]
}

export const sdkRealtime: DocSection = {
  id: 'sdk-realtime',
  label: 'Realtime',
  content: [
    { type: 'h1', id: 'sdk-realtime', text: 'SDK — Realtime' },
    {
      type: 'p',
      text: 'The SDK includes a Socket.io client wrapper for subscribing to live updates. Import `createRealtime` from `@nivaro/sdk`.'
    },
    {
      type: 'pre',
      code: `import { createNivaro, createRealtime } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

// Create a realtime connection
const rt = createRealtime()
rt.connect('https://nivaro.example.com')

// Subscribe to a room (e.g. 'articles:123')
const unsubscribe = rt.subscribe(
  'articles',
  { event: 'update' },
  (data) => {
    console.log('project updated', data)
  },
)

// Disconnect when done
rt.disconnect()
unsubscribe()`
    },
    {
      type: 'p',
      text: 'The Nivaro Socket.io server uses the Redis pub/sub adapter — events emitted on one replica are received by clients connected to any replica.'
    },
    {
      type: 'note',
      text: 'You do not need to run a separate Socket.io server. The Socket.io server runs inside the Fastify process. Connect directly to the Nivaro API URL.'
    }
  ]
}

export const sdkFilters: DocSection = {
  id: 'sdk-filters',
  label: 'Filter Helpers',
  content: [
    { type: 'h1', id: 'sdk-filters', text: 'SDK — Filter Helpers' },
    {
      type: 'p',
      text: 'The SDK exports operator helper functions that make filters type-safe and readable.'
    },
    {
      type: 'pre',
      code: `import {
  _eq, _neq, _gt, _gte, _lt, _lte,
  _in, _nin, _null, _nnull,
  _contains, _ncontains, _starts_with, _ends_with,
  _and, _or, _some, _none,
  asc, desc
} from '@nivaro/sdk'

// Scalar field conditions
const filter = {
  status: _in(['active', 'draft']),
  amount: _gt(1000),
  deleted_at: _null(),
  name: _contains('fiber'),
  email: _ends_with('@nivaro.dev'),
  title: _ncontains('archived'),
}

// Logical combinators
const combined = _and(
  { status: _eq('active') },
  _or({ region: _eq('East') }, { region: _eq('West') })
)

// Relation filters — O2M / M2M
const withTags = {
  tags: _some({ name: _eq('featured') }),   // at least one tag named "featured"
  approvals: _none({ status: _eq('rejected') }),  // no rejected approvals
}

// Sort helpers
const items = await nivaro.request(
  readItems('projects', {
    filter: combined,
    sort: [asc('region.short_name'), desc('created_at')],
  })
)`
    },
    { type: 'h3', text: 'Scalar operators' },
    {
      type: 'table',
      head: ['Helper', 'SQL', 'Notes'],
      rows: [
        ['_eq(v)', '= v', 'Exact equality.'],
        ['_neq(v)', '!= v', 'Not equal.'],
        ['_gt(v)', '> v', ''],
        ['_gte(v)', '>= v', ''],
        ['_lt(v)', '< v', ''],
        ['_lte(v)', '<= v', ''],
        ['_in(arr)', 'IN (...)', 'Array of values.'],
        ['_nin(arr)', 'NOT IN (...)', ''],
        ['_null()', 'IS NULL', ''],
        ['_nnull()', 'IS NOT NULL', ''],
        ['_contains(s)', 'LIKE %s%', 'Substring match.'],
        ['_ncontains(s)', 'NOT LIKE %s%', 'Substring exclusion.'],
        ['_starts_with(s)', 'LIKE s%', 'Prefix match.'],
        ['_ends_with(s)', 'LIKE %s', 'Suffix match.']
      ]
    },
    { type: 'h3', text: 'Logical & relation operators' },
    {
      type: 'table',
      head: ['Helper', 'Type', 'Notes'],
      rows: [
        ['_and(...clauses)', 'Logical', 'All clauses must match.'],
        ['_or(...clauses)', 'Logical', 'At least one clause must match.'],
        ['_some(filter)', 'Relation', 'At least one related record matches filter.'],
        ['_none(filter)', 'Relation', 'No related records match filter.']
      ]
    },
    { type: 'h3', text: 'Sort helpers' },
    {
      type: 'table',
      head: ['Helper', 'Example', 'Notes'],
      rows: [
        [
          'asc(field)',
          "asc('created_at')",
          "Ascending. Dotted paths for M2O: asc('region.short_name')."
        ],
        ['desc(field)', "desc('amount')", 'Descending.']
      ]
    }
  ]
}

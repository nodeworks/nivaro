# @nivaro/sdk

TypeScript SDK for [Nivaro CMS](https://nivaro.dev) — typed REST client, GraphQL, realtime subscriptions, and presence.

## Installation

```bash
npm install @nivaro/sdk
# or
pnpm add @nivaro/sdk
```

All API calls use `nivaro.request(command)` where `command` is a typed descriptor built by one of the helper functions below.

---

## SDK — Setup

The `@nivaro/sdk` package is a fully-typed TypeScript client for the Nivaro REST, GraphQL, and realtime APIs. Works in Node.js, browsers, and edge runtimes.

#### Installation

```typescript
pnpm add @nivaro/sdk
```

#### Create a client

```typescript
import { createNivaro } from '@nivaro/sdk'

// Minimal — use session cookie (browser) or set token later
const nivaro = createNivaro('https://nivaro.example.com')

// With static token
const nivaro = createNivaro('https://nivaro.example.com', {
  token: 'nvk_abc123...',  // Bearer token
})

// Full options
const nivaro = createNivaro('https://nivaro.example.com', {
  token: 'nvk_abc123...',
  workspace: 'workspace-uuid',  // optional: workspace to target
  headers: { 'X-Custom': 'value' },  // optional: extra headers
})
```

#### Client methods

| Method | Purpose | Example |
| --- | --- | --- |
| request(command) | REST operations | await nivaro.request(readItems("articles")) |
| graphql(query, vars?) | GraphQL queries + mutations | await nivaro.graphql(query, variables) |
| upload(file) | File upload | await nivaro.upload(file) |
| fileUrl(fileId) | Get download URL | nivaro.fileUrl("file-uuid") |
| setToken(token) | Set/clear auth token | nivaro.setToken("nvk_...") |
| getToken() | Read current token | const t = nivaro.getToken() |

#### TypeScript setup

All SDK functions are fully typed. For collection-specific item operations, define your data shape and pass it as a generic:

```typescript
import { readItems, createItem } from '@nivaro/sdk'

interface Article {
  id: string
  name: string
  status: 'draft' | 'published'
  author_id: string
}

const items = await nivaro.request(
  readItems<Article>('articles', { filter: { status: { _eq: 'published' } } })
)
// items.data → Article[]
```

---

## SDK — Authentication

The SDK supports two authentication methods: static tokens (for backends/scripts) and session cookies (for browser SPAs).

#### Static tokens (server-side / CLI)

Use a static API token for automated scripts, cron jobs, and server-to-server communication:

```typescript
import { createNivaro, readItems } from '@nivaro/sdk'

// Set token at creation
const nivaro = createNivaro('https://nivaro.example.com', {
  token: process.env.NIVARO_TOKEN,  // nvk_...
})

// Or set at runtime
nivaro.setToken(process.env.NIVARO_TOKEN)

// Check current token
const hasToken = nivaro.getToken() !== undefined

// Clear token (revert to unauth or session-cookie mode)
nivaro.setToken(null)

// Use the client
const { data: items } = await nivaro.request(readItems('articles'))
```

#### Session cookies (browser SPA)

In a browser, after a user logs in via the OIDC flow (`/login`), the session cookie is set automatically. The SDK will send it with every request:

```typescript
import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com')
// No token needed — session cookie is sent automatically

// After login, you can also set a static token if desired
nivaro.setToken(localStorage.getItem('api_token'))
```

#### Token priority

- If a static token is set, it takes priority (Authorization: Bearer header).
- Otherwise, the session cookie is sent if available.
- If neither exists, requests are made as unauthenticated (limits depend on public routes).

#### Generate tokens via the API

```typescript
import { generateToken } from '@nivaro/sdk'

// Generate a new token for yourself
const { data: result } = await nivaro.request(generateToken())
console.log(result.token)  // Show once — never retrievable again

// Store in env var or secure storage
process.env.NIVARO_TOKEN = result.token
nivaro.setToken(result.token)

// Admin: generate token for another user
const { data: other } = await nivaro.request(generateUserToken('user-uuid'))

// Revoke your own token
await nivaro.request(revokeToken())
nivaro.setToken(null)

// Admin: revoke another user's token
await nivaro.request(revokeUserToken('user-uuid'))
```

---

## SDK — REST Commands

All REST operations use `await nivaro.request(command)`. Command functions are factories that return a descriptor — no network call happens until `request()` executes it.

#### Read items

```typescript
import { readItems, readItem } from '@nivaro/sdk'

// List with filtering, sorting, and pagination
const { data, total, limit, offset } = await nivaro.request(
  readItems('articles', {
    filter: {
      status: { _eq: 'published' },
      created_at: { _gte: '2024-01-01' },
    },
    sort: ['-created_at', 'title'],  // descending created_at, then ascending title
    limit: 25,
    offset: 0,
  })
)
// data → T[]

// Single item
const { data: article } = await nivaro.request(readItem('articles', '123'))
// data → T
```

#### Create items

```typescript
import { createItem } from '@nivaro/sdk'

const { data: created } = await nivaro.request(
  createItem('articles', {
    title: 'New Article',
    body: 'Lorem ipsum...',
    status: 'draft',
    author_id: 'user-uuid',
  })
)
// data → T (with id, timestamps, and default values filled in)
```

#### Update items

```typescript
import { updateItem } from '@nivaro/sdk'

// Partial update — only changed fields
const { data: updated } = await nivaro.request(
  updateItem('articles', '123', {
    status: 'published',
    published_at: new Date().toISOString(),
  })
)
// data → T (full record with updates applied)
```

#### Delete items

```typescript
import { deleteItem } from '@nivaro/sdk'

await nivaro.request(deleteItem('articles', '123'))
```

#### Bulk operations

```typescript
import { bulkCreateItems, bulkUpdateItems, bulkDeleteItems } from '@nivaro/sdk'

// Bulk create
const { data: created } = await nivaro.request(
  bulkCreateItems('articles', [
    { title: 'Article 1', status: 'draft' },
    { title: 'Article 2', status: 'draft' },
  ])
)

// Bulk update
const { data: updated } = await nivaro.request(
  bulkUpdateItems('articles', [
    { id: '123', status: 'published' },
    { id: '124', status: 'published' },
  ])
)

// Bulk delete
await nivaro.request(bulkDeleteItems('articles', ['123', '124']))
```

#### Singletons

For single-record collections (e.g., site settings), use singleton commands:

```typescript
import { readSingleton, updateSingleton } from '@nivaro/sdk'

// Read the singleton record
const { data: settings } = await nivaro.request(readSingleton('site_settings'))

// Update it
const { data: updated } = await nivaro.request(
  updateSingleton('site_settings', { site_name: 'My App', theme: 'dark' })
)
```

#### Current user

```typescript
import { readMe, updateMe } from '@nivaro/sdk'

// Get your own profile
const { data: me } = await nivaro.request(readMe())
// me → { id, email, first_name, last_name, role, current_workspace, ... }

// Update your profile
const { data: updated } = await nivaro.request(
  updateMe({ first_name: 'Jane', last_name: 'Doe' })
)
```

#### Revisions (audit trail)

```typescript
import { readRevisions, readRevision } from '@nivaro/sdk'

// All changes to an item (newest first)
const { data: revisions } = await nivaro.request(readRevisions('articles', '123'))
// Each revision: { id, action ('create'|'update'|'delete'), data, delta, timestamp, user_id, first_name, last_name }

// Single revision detail
const { data: rev } = await nivaro.request(readRevision('rev-uuid'))
// rev.data → full snapshot at that point in time
// rev.delta → only the fields that changed (for updates)
```

---

## SDK — Workflow State Machine

Workflows are state machines that control the lifecycle of items. Each transition can be conditional, role-gated, and can trigger automations. Use these commands to read and drive workflow states.

#### Read workflow state

```typescript
import { readWorkflowInstance, readWorkflowInstances } from '@nivaro/sdk'

// Get full workflow context for an item
const { data: wf } = await nivaro.request(
  readWorkflowInstance('inventory_requests', itemId)
)
// wf === null → no workflow bound to this collection

// If bound:
// wf.instance → { current_state, started_at, completed_at, transitioned_at }
// wf.states → all states with { id, key, label, color, is_initial, is_terminal, lock_record }
// wf.available_transitions → transitions the user's role can execute from current state
// wf.history → immutable log: [{ transitioned_at, from_state, to_state, comment, user }]

// Find current state label
const currentState = wf.states.find(s => s.id === wf.instance.current_state)
console.log(currentState.label)  // e.g., "In Progress"

// List all workflow instances for a collection (admin)
const { data: instances } = await nivaro.request(
  readWorkflowInstances('inventory_requests', { limit: 100 })
)
```

#### Start and transition workflows

```typescript
import { startWorkflow, transitionWorkflow } from '@nivaro/sdk'

// Start a workflow on an item (moves to initial state)
await nivaro.request(startWorkflow('inventory_requests', itemId))

// Execute a transition with optional comment
const { data: updated } = await nivaro.request(
  transitionWorkflow('inventory_requests', itemId, transitionId, {
    comment: 'Approved — ready to ship',
  })
)
// updated → full item with updated workflow state

// Check available transitions before showing UI
const { data: wf } = await nivaro.request(
  readWorkflowInstance('inventory_requests', itemId)
)
wf.available_transitions.forEach(tx => {
  // Render a button per transition
  console.log(tx.label, tx.id)
})
```

#### Conditional transitions

Some transitions have conditions (field values that must match) before they can execute:

```typescript
// Before transitioning, check if conditions are met
const { data: wf } = await nivaro.request(
  readWorkflowInstance('orders', orderId)
)

const transition = wf.available_transitions.find(t => t.id === selectedTxId)

// Attempt transition — if conditions not met, API returns 409
try {
  await nivaro.request(
    transitionWorkflow('orders', orderId, transition.id, { comment: 'Approved' })
  )
} catch (err) {
  if (err.status === 409) {
    console.error('Transition conditions no longer met:', err.message)
  }
}
```

| Function | Purpose | Auth |
| --- | --- | --- |
| readWorkflowInstance(collection, itemId) | Get current state + available transitions | Authenticated |
| startWorkflow(collection, itemId) | Initialize workflow on an item | Authenticated |
| transitionWorkflow(col, itemId, txId, opts?) | Execute a state transition | Role-gated per transition |
| readWorkflowInstances(collection) | List all workflow instances | Authenticated |

---

## SDK — Pipeline & Ownership Matrix

The Pipeline Owner Matrix extends workflows with multi-dimensional ownership. It resolves which users own each workflow state based on dimensional rules (e.g., "If region=North and status=urgent, then assign to @jane").

#### Read ownership

```typescript
import {
  readInstanceOwners, readStateOwners, readAllStateOwners
} from '@nivaro/sdk'

// Get owners for the CURRENT state (primary API)
const { data: owners } = await nivaro.request(
  readInstanceOwners('inventory_requests', itemId)
)
// owners → User[] — { id, email, first_name, last_name, is_inherited }

// Get owners for a SPECIFIC state (non-current)
const { data: result } = await nivaro.request(
  readStateOwners('inventory_requests', itemId, stateId)
)
// result.state → { id, key, label, color }
// result.owners → User[] (resolved via matrix rules)

// Get owners for ALL states at once (no N+1)
const { data: allOwners } = await nivaro.request(
  readAllStateOwners('inventory_requests', itemId)
)
// allOwners → { [stateId]: { state, owners } } | null

// Null means no pipeline bound to collection
if (allOwners) {
  Object.entries(allOwners).forEach(([stateId, { state, owners }]) => {
    console.log(`${state.label}: ${owners.map(o => o.first_name).join(', ')}`)
  })
}
```

#### Manual ownership overrides

```typescript
import { addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Assign a user as an override owner for this item
const { data: owner } = await nivaro.request(
  addInstanceOwner('inventory_requests', itemId, 'user-uuid', {
    state_id: stateId,  // optional: scope to a specific state
  })
)

// Remove an override
await nivaro.request(removeInstanceOwner(owner.id))
```

#### Admin: Pipeline template configuration

```typescript
import {
  readPipelineTemplates, readPipelineTemplate,
  readOwnerGroups, readDimensions
} from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Get one template
const { data: template } = await nivaro.request(readPipelineTemplate(templateId))
// template → { id, name, states: [], binding: { collection }, ... }

// Owner groups per state (configured in admin UI)
const { data: groups } = await nivaro.request(readOwnerGroups(templateId))
// groups[stateId] → OwnerGroup[] with { filters: JSON, priority, users: [] }

// Dimensions for the matrix (region, product, etc.)
const { data: dimensions } = await nivaro.request(readDimensions(templateId))
// dimensions → Dimension[] — { field, label, is_row_axis, sort }
```

#### How ownership resolution works

- Owner Groups are evaluated in priority order (lower = higher priority).
- Each group has filter rules (e.g., "region == North AND status == urgent").
- First group where ALL filters match assigns its users.
- If no rules match, the item has no owner.
- Manual Instance Owner overrides always apply (bypass rules).
- Delegation via user.delegate_id also applies (temporary out-of-office reassignments).

| Function | Purpose | Auth |
| --- | --- | --- |
| readInstanceOwners(col, itemId) | Owners for current state | Authenticated |
| readStateOwners(col, itemId, stateId) | Owners for a specific state | Authenticated |
| readAllStateOwners(col, itemId) | Owners for all states (no N+1) | Authenticated |
| addInstanceOwner(col, itemId, userId, opts?) | Add manual override | Authenticated |
| removeInstanceOwner(ownerId) | Remove override | Authenticated |
| readPipelineTemplates() | List pipeline templates | Admin |
| readPipelineTemplate(id) | Get one template | Admin |
| readOwnerGroups(templateId) | Owner groups by state | Admin |
| readDimensions(templateId) | Matrix dimensions | Admin |

---

## SDK — Form Schema

The Form Schema API aggregates collection metadata, fields, groups, layouts, and relations into one normalized response. Use it to power dynamic UIs, form generators, and headless form runtimes.

#### Load form schema

```typescript
import { fetchFormSchema } from '@nivaro/sdk'

const { data: schema } = await nivaro.request(fetchFormSchema('inventory_requests'))
// schema → {
//   collection: { id, name, icon, ... },
//   fields: FormField[],
//   groups: FieldGroup[],  // section/tab definitions, sorted
//   relations: RelationMeta[],  // m2o/o2m/m2m/m2a
//   layout: { id, name, tab_mode, ... },
//   ungroupedSort: 5,  // position of Ungrouped zone
// }

// Iterate fields by group
schema.groups.forEach(group => {
  const fieldsInGroup = schema.fields.filter(f => f.group_key === group.key)
  console.log(group.label, fieldsInGroup.map(f => f.label))
})
```

#### Evaluate field rules in real-time

```typescript
import { evaluateFieldRules } from '@nivaro/sdk'

// As the user types, evaluate inline field rules (no save)
const values = { category: 'hardware', vendor: null }
const { data: result } = await nivaro.request(
  evaluateFieldRules('inventory_requests', values)
)
// result.updates → { priority: 'high' }  (only changed fields)

// Apply rule updates to form state
setValues({ ...values, ...result.updates })
```

#### Load relation options (picker)

```typescript
import { readRelationOptions } from '@nivaro/sdk'

// Load options for an M2O or M2M field picker
const { data: options } = await nivaro.request(
  readRelationOptions('inventory_requests', 'assigned_to', {
    search: 'jane',  // filter by search term
    limit: 25,
  })
)
// options → { value, label }[]  (label from display template)

// Render picker
options.forEach(opt => console.log(`${opt.label} (${opt.value})`))
```

#### Submit form item

```typescript
import { submitFormItem } from '@nivaro/sdk'

// Create new item
const { data: created } = await nivaro.request(
  submitFormItem('inventory_requests', {
    mode: 'create',
    values: {
      title: 'New Request',
      category: 'hardware',
      priority: 'high',
    },
  })
)

// Update existing
const { data: updated } = await nivaro.request(
  submitFormItem('inventory_requests', {
    mode: 'edit',
    itemId: '123',
    values: { status: 'approved' },  // partial update
  })
)
```

#### Form field shape

| Property | Type | Description |
| --- | --- | --- |
| key | string | Field name (used in values/updates). |
| label | string | Display name. |
| type | string | text | number | boolean | date | select | etc. |
| interface | string | UI hint: text-input | textarea | toggle | date-picker. |
| required | boolean | If true, value must be provided. |
| sort | number | null | Display order within group. |
| hidden | boolean | If true, hidden from UI but readable via API. |
| validation_rules | Rule[] | Constraints: min_length, pattern, unique, etc. |
| visibility_rules | Rule[] | Show/hide based on other field values. |
| lock_condition | Rule[] | Make read-only based on field values. |
| computed_formula | string | null | If set, field is auto-calculated (read-only). |

| Command | Purpose |
| --- | --- |
| fetchFormSchema(collection) | Load full schema + layout + relations |
| evaluateFieldRules(collection, values) | Server-evaluate rules against values (no save) |
| readRelationOptions(collection, field, opts?) | Get picker options for a relation field |
| submitFormItem(collection, { mode, itemId?, values }) | Create or update via form |

> **Note:** Form Schema uses **snake_case** (`validation_rules`, `visibility_rules`, `computed_formula`). The `@nivaro/react` package wraps these in **camelCase** (`validationRules`) for React — do not mix the two APIs.

---

## SDK — React (@nivaro/react)

`@nivaro/react` is a form runtime built on `@nivaro/sdk`. One hook (`useNivaroForm`) handles schema loading, field rules, visibility/lock evaluation, relation options, validation, and submit. Pair it with your own inputs (headless) or use `<NivaroForm>` for auto-rendering fields.

#### Installation

```typescript
pnpm add @nivaro/react @nivaro/sdk react react-dom @tanstack/react-query sonner
```

#### Styling

The styled components (`ItemEditForm`, `QueueWorklist`, panels, sheets) are built with Tailwind. Two ways to get their styles — pick one:

**Option A — precompiled CSS (simplest, no Tailwind required).** One import, works in any app:

```typescript
// app entry
import '@nivaro/react/full.css'
```

**Option B — Tailwind v3 preset.** If your app already runs Tailwind 3 and you want one utility pipeline (no duplicated classes):

```typescript
// tailwind.config.js
module.exports = {
  presets: [require('@nivaro/react/tailwind-preset')],
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@nivaro/react/dist/**/*.js'
  ]
}

// app entry
import '@nivaro/react/styles.css'
```

The preset supplies the theme tokens (`nvr-cyan`, semantic color vars, radius, type scale) and the animate plugin; `styles.css` supplies the CSS variables plus class-based dark-mode overrides. Tailwind v4 configs ignore `tailwind.config.js` presets — use Option A there. Dark mode in both options: `dark` class on `<html>`. The headless `useNivaroForm` API needs neither.

#### Setup

Wrap your app in `<NivaroProvider>` with a configured SDK client. It provides a TanStack Query `QueryClient` automatically when your app does not already run a `QueryClientProvider` — if you do, yours wins.

#### Item links in embedded apps

Components like `QueueWorklist` open records at the admin route shape (`/collections/:collection/:id`) by default. When embedding in your own app, override link handling on `NavigationContext`:

```typescript
import { NavigationContext } from '@nivaro/react'

<NavigationContext.Provider
  value={{
    navigate: (to) => router.push(to),
    // Map record links onto YOUR routes (row clicks, Open buttons, Work Next):
    itemUrl: ({ collection, itemId, layoutSlug }) =>
      `/records/${collection}/${itemId}${layoutSlug ? `?layout=${layoutSlug}` : ''}`,
    // Or intercept opening entirely (return true = handled — e.g. open your own drawer):
    openItem: ({ collection, itemId }) => {
      openMyDetailDrawer(collection, itemId)
      return true
    }
  }}
>
```

`openItem` is checked first; returning `true` skips navigation. Otherwise the component navigates to `itemUrl(target)`, falling back to the admin shape when neither is provided.

#### Report Studio viewer

`<ReportView reportId="…" />` renders a fully-styled, interactive Report Studio report in your own app — same as `QueueWorklist` / `ItemEditForm`: bring the styles via `@nivaro/react/full.css` (or the Tailwind preset). It fetches the definition and resolves every widget (KPIs, KPI groups, bar/line/donut charts via recharts, tables) as the client identity — collection read permissions apply server-side. Interactive: a global filter bar (date-range switcher + live entity-filter chips) and per-widget refresh. Read-only (no drag/resize edit surface).

```typescript
import { NivaroProvider, ReportView } from '@nivaro/react'

<ReportView
  reportId="…"
  refetchInterval={60_000}          // live-refresh; omit for one-shot
  showFilterBar                              // date range + entity chips (default true)
  dateRange={{ preset: 'last_3_months' }}    // override the saved range (optional)
  initialEntityFilters={[{ field: 'division', values: [1, 2] }]}
/>
```

For custom rendering, skip the component and drive the data commands directly: `readReport`, `readReportWidgetData` / `previewReportWidget`, plus the full CRUD, subscription (`setReportSubscription`), alert (`createReportAlert`), and AI (`aiBuildReport`, `aiReportFilters`) surface from `@nivaro/sdk`.

```typescript
import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider } from '@nivaro/react'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

export function App() {
  return (
    <NivaroProvider client={nivaro}>
      <Routes>
        <Route path="/requests/new" element={<CreateRequestForm />} />
        <Route path="/requests/:id/edit" element={<EditRequestForm />} />
      </Routes>
    </NivaroProvider>
  )
}
```

#### useNivaroForm hook

```typescript
import { useNivaroForm } from '@nivaro/react'

function CreateRequestForm() {
  const form = useNivaroForm('inventory_requests', {
    mode: 'create',
    defaultValues: { priority: 'medium', status: 'draft' },
    onSuccess: (item) => navigate(`/requests/${item.id}`),
    onError: (err) => toast.error(err.message),
  })

  return (
    <form onSubmit={form.handleSubmit}>
      <input
        type="text"
        value={form.values.title}
        onChange={(e) => form.setValue('title', e.target.value)}
      />
      {form.errors.title && <p>{form.errors.title}</p>}

      <select
        value={form.values.priority}
        onChange={(e) => form.setValue('priority', e.target.value)}
        disabled={form.isLocked('priority')}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>

      <button type="submit" disabled={!form.isValid || form.isSubmitting}>
        {form.isSubmitting ? 'Saving...' : 'Create'}
      </button>
    </form>
  )
}
```

#### Hook return shape

| Property | Type | Description |
| --- | --- | --- |
| values | Record<string, unknown> | Current form values. |
| errors | Record<string, string> | Validation errors (empty when valid). |
| isValid | boolean | Whether all fields pass validation. |
| isDirty | boolean | Whether any field differs from initial values. |
| isLoading | boolean | Schema loading in progress. |
| isSubmitting | boolean | Form submission in progress. |
| setValue(field, value) | void | Update one field; re-runs rules/visibility. |
| handleSubmit(e?) | void | Validate + submit; fires onSuccess/onError. |
| reset(values?) | void | Reset to initial or new values. |
| isVisible(field) | boolean | Whether field passes visibility rules. |
| isLocked(field) | boolean | Whether field is read-only. |
| schema | FormSchema | Full schema (camelCase: fieldType, validationRules). |
| fieldsByGroup | Record<string, Field[]> | Fields bucketed by group key. |
| visibleGroups | Group[] | Groups with at least one visible field. |

#### Auto-render form

```typescript
import { NivaroForm } from '@nivaro/react'

function AutoForm() {
  return (
    <NivaroForm
      collection="inventory_requests"
      mode="create"
      onSuccess={(item) => navigate(`/requests/${item.id}`)}
    />
  )
}
// <NivaroForm> auto-renders all fields, groups, and validation.
```

> **Note:** `@nivaro/react` uses **camelCase** (`fieldType`, `validationRules`, `visibilityRules`) — different from the SDK Form Schema snake_case. This is intentional for React conventions. Do not mix the two APIs.

---

## SDK — React Layout Hooks (@nivaro/react)

These hooks work alongside `useNivaroForm` and require a form returned by that hook. They expose the active collection layout (tabs, sections, col_span grid, ungrouped zone position) plus field-level state, dirty tracking, and repeater management. Import all hooks from `@nivaro/react`.

> **Note:** `FormSchema` now includes `ungroupedSort: number | null` — the configured position of the Ungrouped zone relative to named groups. `fetchFormSchema` and `useFormSchema` fetch this automatically from the active layout endpoint; no extra call is needed.

| Export | Kind | Purpose |
| --- | --- | --- |
| LayoutForm | Component | Full layout-aware auto-renderer (tabs, sections, col_span grid, ungrouped zone). |
| useOrderedLayout(form) | Hook | Ordered list of groups + `__ungrouped__` sentinel, reflecting `ungroupedSort`. |
| useTabState(form) | Hook | Active tab + setter + tabs list; `hasTabs` false when layout has no tab groups. |
| useSectionState(form, defaultCollapsed?) | Hook | Per-section collapse state; `toggle`, `collapseAll`, `expandAll`. |
| useFieldState(form, field) | Hook | value, error, visible, locked, required, colSpan, descriptor, onChange for one field. |
| useWatchFields(form, fields[]) | Hook | Reactive Record<string, unknown> slice — re-renders only when watched values change. |
| useFormDirty(form, initialValues?) | Hook | isDirty, dirtyFields[], isFieldDirty(field) — compares against initial or mounted values. |
| useFormStatus(form) | Hook | isDirty, isValid, isSubmitting, isLoading, canSubmit — one-stop status object. |
| useFieldArray(form, field) | Hook | append, remove, move, update, replace for ordered repeater rows. |

> **Note:** All layout hooks read the same `form` object returned by `useNivaroForm`. They do not create extra network requests — schema and layout data are fetched once by the hook and shared.

---

## SDK — Notifications & Inbox

Manage your notification inbox. Notifications are created by rules, workflows, comments (@mentions), and alerts — use these endpoints to read, mark as read, and delete them.

```typescript
import {
  readNotifications, readNotificationCount,
  markNotificationRead, markAllNotificationsRead, deleteNotification
} from '@nivaro/sdk'

// List your inbox notifications (paginated)
const { data: notifs, total, offset } = await nivaro.request(
  readNotifications({ limit: 50, offset: 0 })
)
// notifs → Notification[] — { id, subject, message, status, timestamp, collection, item }

// Get unread count (lightweight, for badge)
const { data: counts } = await nivaro.request(readNotificationCount())
// counts → { unread: 5, total: 42 }

// Mark one as read
await nivaro.request(markNotificationRead(notif.id))

// Mark all as read
await nivaro.request(markAllNotificationsRead())

// Delete one
await nivaro.request(deleteNotification(notif.id))
```

#### Real-time notifications via Socket.io

For live notifications as they arrive, subscribe to the Socket.io event:

```typescript
import { createRealtime } from '@nivaro/sdk'

const rt = createRealtime()
await rt.connect('https://nivaro.example.com')

// Subscribe to your notifications room
rt.subscribe(`user:${userId}`, { event: 'notification:new' }, (notif) => {
  console.log('New notification:', notif.subject)
  // Update badge, toast, etc.
})
```

| Field | Type | Description |
| --- | --- | --- |
| id | string | UUID. |
| subject | string | Notification title. |
| message | string | Full message body. |
| status | string | "inbox" | "read" |
| timestamp | string | ISO 8601 when created. |
| collection | string | null | Related collection (if from an item event). |
| item | string | null | Related item ID. |
| sender | string | null | User who triggered it (if applicable). |

---

## SDK — Activity & Revisions

The activity log records all changes and actions in your CMS. Revisions give you full audit trail and rollback capability.

#### Activity log

```typescript
import { readActivity } from '@nivaro/sdk'

// All activity, newest first (system-wide audit log)
const { data: entries, total } = await nivaro.request(
  readActivity({ limit: 50, offset: 0 })
)
// entries → Activity[] — { id, action, collection, item, user_id, timestamp, ... }

// Filter by collection, action, or user
const { data: creates } = await nivaro.request(
  readActivity({
    collection: 'inventory_requests',
    action: 'create',  // 'create' | 'update' | 'delete' | 'schema-*'
    user_id: 'user-uuid',  // optional
    limit: 25,
  })
)
```

#### Revisions (item-level history)

```typescript
import { readRevisions, readRevision } from '@nivaro/sdk'

// All revisions for a specific item (newest first)
const { data: revisions } = await nivaro.request(
  readRevisions('inventory_requests', itemId, { limit: 50 })
)
// revisions → Revision[] — each revision includes action, full snapshot, and delta

revisions.forEach(rev => {
  console.log(
    `${rev.action.toUpperCase()} by ${rev.first_name} at ${rev.timestamp}`
  )
  if (rev.delta) {
    console.log('Changed:', Object.keys(rev.delta))
  }
})

// Single revision detail with full snapshot and delta
const { data: rev } = await nivaro.request(readRevision(revisionId))
console.log('Full snapshot:', rev.data)
console.log('Changed fields:', rev.delta)
```

#### Revision shape

| Field | Type | Description |
| --- | --- | --- |
| id | string | Revision UUID. |
| action | string | "create" | "update" | "delete" |
| collection | string | Collection name. |
| item_id | string | Item ID (null for create). |
| data | Record | Full snapshot of the record at that revision. |
| delta | Record | null | Only changed fields (for updates). Null for create/delete. |
| timestamp | string | ISO 8601 datetime. |
| user_id | string | User who made the change. |
| first_name / last_name / user_email | string | Display info from nivaro_users. |

> **Note:** Revisions are immutable — they form a complete audit trail. You can compare any two revisions to see exactly what changed. For rollback, use the delta as a PATCH to the current item.

---

## SDK — External APIs

Call configured external APIs without exposing credentials. The SDK handles credential injection server-side. Use these commands to manage API configs, test connections, and call endpoints.

#### Calling an external API

```typescript
import { callExternalApi } from '@nivaro/sdk'

// Call any endpoint on a configured API
const { data: result } = await nivaro.request(
  callExternalApi('slack-api', {
    method: 'POST',
    path: '/chat.postMessage',
    body: { channel: 'C1234', text: 'Task completed' },
  })
)
// result.status → 200, 400, 500, etc.
// result.headers → response headers
// result.body → parsed JSON response (or text if not JSON)
```

#### Admin: API config CRUD

```typescript
import {
  readExternalApis, readExternalApi,
  createExternalApi, updateExternalApi, deleteExternalApi,
  testExternalApi,
} from '@nivaro/sdk'

// List all configured APIs
const { data: apis } = await nivaro.request(readExternalApis())

// Get one
const { data: api } = await nivaro.request(readExternalApi(apiId))

// Create an API config
const { data: slack } = await nivaro.request(
  createExternalApi({
    name: 'Slack API',
    base_url: 'https://slack.com/api',
    auth_type: 'bearer',  // bearer | api_key | basic | oauth2_cc
    auth_config: { token: 'xoxb-...' },
    enabled: true,
  })
)

// Update
await nivaro.request(updateExternalApi(slack.id, { enabled: false }))

// Test the connection
const { data: testResult } = await nivaro.request(testExternalApi(slack.id, {
  method: 'GET',
  path: '/auth.test',
}))
console.log(testResult.status, testResult.body)

// Delete
await nivaro.request(deleteExternalApi(slack.id))
```

| Auth Type | Config Fields | Example |
| --- | --- | --- |
| bearer | token | { token: "sk_live_..." } |
| api_key | header_name, value | { header_name: "X-API-Key", value: "key123" } |
| basic | username, password | { username: "user", password: "pass" } |
| oauth2_cc | client_id, client_secret, token_url | { client_id: "...", ... } |

#### Admin: Endpoint templates

Pre-define common endpoints for an API so users can call them by slug instead of writing full path/method each time.

```typescript
import {
  readExternalApiEndpoints, createExternalApiEndpoint,
  updateExternalApiEndpoint, deleteExternalApiEndpoint,
} from '@nivaro/sdk'

// List templates for an API
const { data: endpoints } = await nivaro.request(readExternalApiEndpoints(apiId))

// Create a template
const { data: tpl } = await nivaro.request(
  createExternalApiEndpoint(apiId, {
    name: 'Post Message',
    slug: 'post-message',  // users call via this slug
    method: 'POST',
    path: '/chat.postMessage',
    default_body: { channel: 'general' },
  })
)

// Update
await nivaro.request(updateExternalApiEndpoint(tpl.id, {
  default_body: { channel: 'alerts' },
}))

// Delete
await nivaro.request(deleteExternalApiEndpoint(tpl.id))
```

> **Note:** Credentials (tokens, passwords) are never exposed in GET responses — sensitive fields return a masked value like `••••••`. When updating, re-submit the masked value to keep the existing credential; send a plaintext value to change it.

---

## SDK — GraphQL Transport

Use `nivaro.graphql()` to send typed GraphQL queries and mutations. The method throws on errors — no need to check `response.errors` manually. Uses the same auth (token/cookie) as REST.

#### Queries

```typescript
import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

interface ArticlesResult {
  articles: {
    data: Array<{ id: string; name: string; status: string; author_id: string }>
    total: number
  }
}

const result = await nivaro.graphql<ArticlesResult>(`
  query {
    articles(filter: { status: { _eq: "active" } }, limit: 10) {
      data { id name status author_id }
      total
    }
  }
`)

result.articles.data.forEach(article => {
  console.log(`${article.name} by author ${article.author_id}`)
})
```

#### Queries with variables

```typescript
interface ArticlesResult {
  articles: { data: Article[]; total: number }
}

const result = await nivaro.graphql<ArticlesResult>(
  `query GetArticles($filter: JSON, $limit: Int) {
    articles(filter: $filter, limit: $limit) {
      data { id name status }
      total
    }
  }`,
  {
    filter: { status: { _eq: 'active' }, created_at: { _gte: '2024-01-01' } },
    limit: 25,
  },
  'GetArticles'  // optional operationName (for debugging)
)
```

#### Mutations

```typescript
interface CreateArticleResult {
  createArticle: { id: string; name: string; status: string }
}

const result = await nivaro.graphql<CreateArticleResult>(`
  mutation CreateArticle($name: String!, $status: String) {
    createArticle(data: { name: $name, status: $status }) {
      id name status
    }
  }
`,
  { name: 'New Article', status: 'draft' }
)

console.log('Created:', result.createArticle.id)
```

#### Subscriptions

```typescript
// GraphQL subscriptions require a separate WebSocket transport
// Use the Socket.io realtime client instead — it's simpler and handles reconnection

import { createRealtime } from '@nivaro/sdk'

const rt = createRealtime()
await rt.connect('https://nivaro.example.com')

rt.subscribe('articles', { event: 'update' }, (article) => {
  console.log('Article updated:', article)
})
```

| Method | Purpose |
| --- | --- |
| nivaro.graphql(query, variables?, operationName?) | Send a GraphQL query or mutation |
| nivaro.setToken(token) | Set auth token (shared with REST) |

> **Note:** The GraphQL schema is auto-generated from your collections, fields, and relations at startup. View the full schema at `/graphql` in the admin UI.

---

## SDK — API Keys & Token Management

Generate, revoke, and manage static API tokens programmatically. Tokens are prefixed with `nvk_` and can have custom scopes, expiry dates, and IP allowlists.

#### Generate token for yourself

```typescript
import { generateToken, revokeToken } from '@nivaro/sdk'

// Generate a new token
const { data: result } = await nivaro.request(generateToken())
// result.token → "nvk_abc123..." (shown only once!)

// Use it immediately or store in secure location
console.log('Save this token:', result.token)
nivaro.setToken(result.token)

// Later: revoke it
await nivaro.request(revokeToken())
```

#### Admin: Generate token for another user

```typescript
import { generateUserToken, revokeUserToken } from '@nivaro/sdk'

// Generate token for a user (admin only)
const { data } = await nivaro.request(generateUserToken('user-uuid'))
console.log('Token for user:', data.token)

// Revoke it
await nivaro.request(revokeUserToken('user-uuid'))
```

#### Token configuration (API keys admin page)

When creating a token in the admin UI, you can configure:

| Setting | Description | Example |
| --- | --- | --- |
| Scopes | What the token can do (read, write, admin) | ["read:all", "write:articles"] |
| Expires at | Expiry datetime (optional) | 2025-12-31T23:59:59Z |
| IP allowlist | Restrict to specific IPs (optional) | ["203.0.113.0", "203.0.113.1"] |
| Rate limit | Requests per minute (optional) | 100 |

> **Warning:** Token values are only returned in the API response once. After you leave the page or close the dialog, the value cannot be retrieved. Copy it to a password manager or secure store immediately.

> **Note:** All tokens are stored as sha256 hashes in the database — the plaintext is never persisted. Use `setToken()` to set the SDK token at runtime.

---

## SDK — Files & Upload

Upload files to the Nivaro file manager and get URLs for serving them. Files are stored locally by default; configure S3 or other providers in settings.

#### Upload a file

```typescript
import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

// From a file input
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const file = fileInput.files![0]

const result = await nivaro.upload(file, {
  title: 'Q2 Report',  // optional: display name
  folder: 'folder-uuid-here',  // optional: folder ID
})

// result → FileUploadResult
console.log('Uploaded:', result.id, result.filesize, 'bytes')
```

#### Get file URL

```typescript
// Generate a download URL
const url = nivaro.fileUrl(fileId)
// url → https://nivaro.example.com/api/files/<id>/content

// Display in an img tag
<img src={url} alt="Report" />

// Or link for download
<a href={url} download>Download Report</a>
```

#### FileUploadResult shape

| Field | Type | Description |
| --- | --- | --- |
| id | string | UUID primary key (use for fileUrl). |
| filename_disk | string | Hashed filename on disk (for deduplication). |
| filename_download | string | Original filename from upload. |
| title | string | null | Custom display title. |
| type | string | MIME type, e.g. "image/png", "application/pdf". |
| filesize | number | File size in bytes. |
| width | number | null | Image width in pixels (images only). |
| height | number | null | Image height in pixels (images only). |
| folder | string | null | Folder ID, or null if in root. |
| uploaded_on | string | ISO 8601 upload timestamp. |

#### Usage in forms

```typescript
// Upload and store file ID in a field
async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0]
  if (!file) return

  const uploaded = await nivaro.upload(file)
  form.setValue('attachment_id', uploaded.id)  // store the ID
}

// On render, show the file
const fileId = form.values.attachment_id
if (fileId) {
  const url = nivaro.fileUrl(fileId)
  return <a href={url}>{fileId}</a>
}
```

---

## SDK — Realtime (Socket.io)

Subscribe to live events (item updates, notifications, presence) via Socket.io. The SDK wraps Socket.io with a simple subscribe/unsubscribe API.

#### Basic setup

```typescript
import { createRealtime } from '@nivaro/sdk'

// Create and connect
const rt = createRealtime()
await rt.connect('https://nivaro.example.com', { token: 'nvk_...' })
```

#### Subscribe to events

```typescript
// Subscribe to all updates on a collection
const unsubscribe = rt.subscribe(
  'articles',
  { event: 'update' },
  (article) => {
    console.log('Article updated:', article)
    // article → full updated item snapshot
  }
)

// Subscribe to updates on a specific item
rt.subscribe(
  'articles:123',
  { event: 'update' },
  (article) => console.log('This article changed')
)

// Subscribe to your notifications
rt.subscribe(
  `user:${userId}`,
  { event: 'notification:new' },
  (notif) => console.log('New notification:', notif.subject)
)

// Subscribe to presence changes on an item
rt.subscribe(
  'articles:123',
  { event: 'presence' },
  (users) => console.log(`${users.length} users viewing`)
)
```

#### Event types

| Event | Fires On | Data |
| --- | --- | --- |
| create | New item added | Full item snapshot |
| update | Item field changed | Full item snapshot (with updated values) |
| delete | Item deleted | Item ID and deletion timestamp |
| notification:new | Notification created | Notification object |
| presence | User joins/leaves/edits | Array of currently viewing users |

#### Unsubscribe and disconnect

```typescript
// Unsubscribe from a room
unsubscribe()

// Disconnect from server (closes all subscriptions)
rt.disconnect()
```

> **Note:** Socket.io is multiplexed over the same URL as the API (e.g., https://nivaro.example.com). No separate server configuration needed. The Redis pub/sub adapter means events propagate across all server replicas.

---

## SDK — Filter Helpers

The SDK exports operator helper functions that make filters type-safe and readable.

```typescript
import {
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
)
```

#### Scalar operators

| Helper | SQL | Notes |
| --- | --- | --- |
| _eq(v) | = v | Exact equality. |
| _neq(v) | != v | Not equal. |
| _gt(v) | > v |  |
| _gte(v) | >= v |  |
| _lt(v) | < v |  |
| _lte(v) | <= v |  |
| _in(arr) | IN (...) | Array of values. |
| _nin(arr) | NOT IN (...) |  |
| _null() | IS NULL |  |
| _nnull() | IS NOT NULL |  |
| _contains(s) | LIKE %s% | Substring match. |
| _ncontains(s) | NOT LIKE %s% | Substring exclusion. |
| _starts_with(s) | LIKE s% | Prefix match. |
| _ends_with(s) | LIKE %s | Suffix match. |

#### Logical & relation operators

| Helper | Type | Notes |
| --- | --- | --- |
| _and(...clauses) | Logical | All clauses must match. |
| _or(...clauses) | Logical | At least one clause must match. |
| _some(filter) | Relation | At least one related record matches filter. |
| _none(filter) | Relation | No related records match filter. |

#### Sort helpers

| Helper | Example | Notes |
| --- | --- | --- |
| asc(field) | asc('created_at') | Ascending. Dotted paths for M2O: asc('region.short_name'). |
| desc(field) | desc('amount') | Descending. |

---

## SDK — Comments & Mentions

Threaded comments on any record. Users can mention other users via @username syntax — mentioned users receive in-app notifications automatically.

```typescript
import { readComments, createComment, updateComment, deleteComment } from '@nivaro/sdk'

// All comments on an item (oldest first)
const { data: comments } = await nivaro.request(
  readComments('projects', itemId)
)
// comments → Comment[] — { id, text, user_id, first_name, last_name, created_at, mentions: [{ user_id, first_name }] }

// Create a comment with @mentions
const { data: comment } = await nivaro.request(
  createComment({
    collection: 'projects',
    item: itemId,
    text: '@jane Please review when you get a chance. Thanks @bob!',
  })
)
// @mentions are parsed from text; mentioned users get notifications

// Update own comment
await nivaro.request(
  updateComment(comment.id, { text: 'Updated — needs urgent review' })
)

// Delete own comment (or admin delete any)
await nivaro.request(deleteComment(comment.id))
```

| Function | Route | Auth |
| --- | --- | --- |
| readComments(collection, item) | GET /comments | Authenticated |
| createComment(body) | POST /comments | Authenticated |
| updateComment(id, body) | PATCH /comments/:id | Authenticated (own) |
| deleteComment(id) | DELETE /comments/:id | Authenticated (own or admin) |

> **Note:** Mention syntax: `@firstname-lastname` (from the user directory). The server parses mentions from the text and sends notifications to all mentioned users. Mention list is also returned in the response for UI highlighting.

---

## SDK — Webhooks

HTTP webhooks fire when collection items are created, updated, or deleted. Payloads include the full item snapshot + delta for updates. Deliveries are retried automatically with exponential backoff.

```typescript
import {
  readWebhooks, readWebhook,
  createWebhook, updateWebhook, deleteWebhook, testWebhook,
} from '@nivaro/sdk'

// List all webhooks
const { data: webhooks } = await nivaro.request(readWebhooks())

// Create a webhook
const { data: wh } = await nivaro.request(
  createWebhook({
    name: 'Slack notifications',
    url: 'https://hooks.slack.com/services/xxx/yyy/zzz',
    collection: 'projects',
    events: ['create', 'update'],  // or 'delete'
    headers: { 'X-Custom-Header': 'value' },
    enabled: true,
  })
)

// Update
await nivaro.request(updateWebhook(wh.id, { enabled: false }))

// Test delivery (fire one immediately to verify endpoint is working)
const { data: testResult } = await nivaro.request(testWebhook(wh.id))
console.log(testResult.status, testResult.response_time)

// Delete
await nivaro.request(deleteWebhook(wh.id))
```

#### Payload shape

```typescript
{
  "event": "item.create",
  "collection": "projects",
  "item": {
    "id": "123",
    "name": "New Project",
    "status": "draft",
    ...
  },
  "delta": {
    // For updates only — fields that changed
    "status": "draft"
  },
  "timestamp": "2024-06-14T10:30:00Z",
  "user_id": "user-uuid",
  "delivery_id": "delivery-uuid"
}
```

| Function | Route | Auth |
| --- | --- | --- |
| readWebhooks() | GET /webhooks | Admin |
| readWebhook(id) | GET /webhooks/:id | Admin |
| createWebhook(data) | POST /webhooks | Admin |
| updateWebhook(id, data) | PATCH /webhooks/:id | Admin |
| deleteWebhook(id) | DELETE /webhooks/:id | Admin |
| testWebhook(id) | POST /webhooks/:id/test | Admin |

> **Note:** Webhooks are fired asynchronously after the item is committed to the database. Failures are retried up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s). See the Webhooks admin page to view delivery history and retry failed deliveries.

---

## SDK — Rules & Automation

Automations (rules) run server-side on create/update/delete. Define conditions (field values that must match) and actions (notify, set field, reject, trigger external system). All actions run transactionally — if any action fails, the entire operation is rolled back.

```typescript
import { readRules, createRule, updateRule, deleteRule } from '@nivaro/sdk'

// List rules for a collection
const { data: rules } = await nivaro.request(readRules('orders'))

// Create a rule
const { data: rule } = await nivaro.request(
  createRule({
    name: 'Auto-escalate urgent orders',
    collection: 'orders',
    trigger: 'create',  // or 'update' or 'delete'
    conditions: [
      { field: 'priority', operator: '_eq', value: 'urgent' }
    ],
    actions: [
      { type: 'notify', recipient_user_id: 'manager-uuid', subject: 'Urgent order' },
      { type: 'set_field', field: 'escalated', value: true },
    ],
    enabled: true,
  })
)

// Disable a rule temporarily
await nivaro.request(updateRule(rule.id, { enabled: false }))

// Delete
await nivaro.request(deleteRule(rule.id))
```

#### Condition operators

| Operator | Meaning | Example |
| --- | --- | --- |
| _eq | Equal | status _eq "urgent" |
| _neq | Not equal | status _neq "draft" |
| _gt | Greater than | amount _gt 1000 |
| _gte | Greater or equal | amount _gte 500 |
| _lt | Less than | age _lt 18 |
| _lte | Less or equal | age _lte 65 |
| _in | In set | status _in ["urgent", "high"] |
| _empty | Is null/empty | description _empty null |
| _contains | Substring | name _contains "test" |
| _starts_with | Prefix | email _starts_with "admin" |

#### Action types

| Action | Fields | Description |
| --- | --- | --- |
| notify | recipient_user_id, subject, body | Send in-app notification. |
| set_field | field, value | Auto-set a field (no auth bypass — must be writable). |
| reject | error_message | Block the save and return an error to the user. |
| trigger_external | external_api_id, path, method, body | Call an external API (credentials stay server-side). |

| Function | Route | Auth |
| --- | --- | --- |
| readRules(collection?) | GET /rules | Admin |
| createRule(data) | POST /rules | Admin |
| updateRule(id, data) | PATCH /rules/:id | Admin |
| deleteRule(id) | DELETE /rules/:id | Admin |

> **Note:** All conditions in a rule must be true (AND logic) for actions to fire. Actions execute in order. If a "reject" action runs, no subsequent actions run and the item is not saved.

---

## SDK — Flow Runs

Flows are Inngest-backed automations (schedules, webhooks, manual triggers). View execution history, logs, and errors via the SDK.

```typescript
import { readFlowRuns, readFlowRun, triggerFlowRun } from '@nivaro/sdk'

// List all runs for a flow (newest first)
const { data: runs } = await nivaro.request(
  readFlowRuns(flowId, { limit: 50, status: 'error' })
)
// runs → Run[] — { id, status, started_at, completed_at, duration_ms, output, error_message }

// Single run detail with step logs
const { data: run } = await nivaro.request(readFlowRun(runId))
console.log(run.status)  // 'running' | 'success' | 'error'
console.log(run.error_message)  // if status === 'error'

// Trigger a flow immediately (bypasses schedule)
const { data: run } = await nivaro.request(
  triggerFlowRun(flowId, { payload: { action: 'review', user_id: '123' } })
)
```

| Function | Route | Auth |
| --- | --- | --- |
| readFlowRuns(flowId, opts?) | GET /flows/:id/runs | Admin |
| readFlowRun(runId) | GET /flows/runs/:id | Admin |
| triggerFlowRun(flowId, payload?) | POST /flows/:id/trigger | Admin |

> **Note:** Flows are created and configured in the admin UI at `/flows`. They support cron schedules, manual triggers, webhook triggers, and event-driven execution. Each flow run produces logs for every step — view them in the admin UI or via the GraphQL API.

---

## SDK — Custom Queries

Custom queries are parameterized SQL endpoints defined by admins. Use them for complex analytics, cross-collection joins, and aggregations that the standard filter DSL cannot express.

```typescript
import { readCustomQueries, executeCustomQuery } from '@nivaro/sdk'

// List all queries visible to the current user
const { data: queries } = await nivaro.request(readCustomQueries())
// queries → Query[] — { id, name, slug, description, access, cache_ttl, params }

// Execute a query by slug with parameters
const { data: rows, cached, executed_at } = await nivaro.request(
  executeCustomQuery('high-value-deals', { region: 'West', min_amount: 50000 })
)
// rows → Record[] — raw query results (any shape, depends on the query)
```

#### Example: Defining a custom query

In the admin UI at `/custom-queries`, create a query:

```typescript
-- Name: High-value deals
-- Access: authenticated

SELECT
  d.id,
  d.name,
  d.amount,
  d.region,
  u.first_name,
  u.last_name,
  COUNT(i.id) as item_count
FROM deals d
LEFT JOIN users u ON u.id = d.owner_id
LEFT JOIN items i ON i.deal_id = d.id
WHERE d.region = @region
  AND d.amount >= @min_amount
GROUP BY d.id, d.name, d.amount, d.region, u.first_name, u.last_name
ORDER BY d.amount DESC
```

#### Parameters

| Name | Type | Required | Default |
| --- | --- | --- | --- |
| region | string | true | N/A |
| min_amount | number | false | 0 |

| Function | Route | Auth |
| --- | --- | --- |
| readCustomQueries() | GET /custom-queries | Authenticated |
| executeCustomQuery(slug, params?) | POST /custom-queries/:slug/execute | Per-query setting |

> **Note:** All parameters are bound safely via MSSQL parameterized queries (@name syntax). Never string-interpolate user input into custom queries. Results can be cached via the TTL setting.

---

## SDK — Collections & Schema

Read collection metadata and field definitions from the registry. Useful for building dynamic UIs, form generators, and schema explorers.

```typescript
import { readCollections, readCollection, readFields } from '@nivaro/sdk'

// List all collections visible to the current user
const { data: collections } = await nivaro.request(readCollections())
// collections → Collection[] — { id, collection, label, icon, sort_field, display_template }

// Single collection metadata
const { data: col } = await nivaro.request(readCollection('orders'))
// col → { id, collection: "orders", label: "Orders", primary_key_field: "id", ... }

// All fields in a collection
const { data: fields } = await nivaro.request(readFields('orders'))
// fields → Field[] — { key, type, interface, required, sort, hidden, ... }
```

#### Collection metadata

| Property | Type | Description |
| --- | --- | --- |
| id | string | UUID. |
| collection | string | Slug used in API paths. |
| label | string | Display name. |
| icon | string | Icon class name. |
| primary_key_field | string | Usually "id". |
| sort_field | string | null | Default sort column. |
| display_template | string | null | Handlebars for rendering rows (e.g., "{{ name }} ({{ status }})"). |

#### Field metadata

| Property | Type | Description |
| --- | --- | --- |
| key | string | Field name. |
| label | string | Display label. |
| type | string | text | number | boolean | date | select | etc. |
| interface | string | UI hint: text-input | textarea | toggle | date-picker | etc. |
| required | boolean | If true, must have a value. |
| sort | number | null | Display order. |
| hidden | boolean | If true, hidden from UI (but readable via API). |
| computed_formula | string | null | If set, field is auto-calculated (read-only). |

| Function | Route | Auth |
| --- | --- | --- |
| readCollections() | GET /collections | Authenticated |
| readCollection(collection) | GET /collections/:collection | Authenticated |
| readFields(collection) | GET /fields/:collection | Authenticated |

---

## SDK — Blackout Dates

Blackout date ranges (e.g., holidays, maintenance windows) pause scheduled flows, SLA timers, and other time-based automations. Mark days as blackout and time is not counted.

```typescript
import {
  readBlackoutDates, checkBlackoutDate,
  createBlackoutDate, deleteBlackoutDate
} from '@nivaro/sdk'

// List all blackout dates
const { data: dates } = await nivaro.request(readBlackoutDates())
// dates → Blackout[] — { id, name, start_date, end_date, is_active }

// Check if a specific date is blacked out
const { isBlackout, reason } = await nivaro.request(
  checkBlackoutDate('2025-12-25')
)
console.log(isBlackout)  // true if in any active blackout range

// Create a blackout range
const { data: bd } = await nivaro.request(
  createBlackoutDate({
    name: 'Winter Shutdown',
    description: 'No deployments',
    start_date: '2024-12-20',
    end_date: '2025-01-02',
    is_active: true,
  })
)

// Delete
await nivaro.request(deleteBlackoutDate(bd.id))
```

#### Usage in time-based systems

When SLA rules, scheduled flows, or other time-tracking systems are active:

- Time during blackout windows is not counted.
- Timers pause on the first second of a blackout and resume on the first second after.
- Business hours SLA settings (e.g., "Mon-Fri 09:00-17:00") are multiplied by the business hours factor within a blackout window.

| Function | Route | Auth |
| --- | --- | --- |
| readBlackoutDates() | GET /blackout-dates | Authenticated |
| checkBlackoutDate(date) | GET /blackout-dates/check | Authenticated |
| createBlackoutDate(body) | POST /blackout-dates | Admin |
| deleteBlackoutDate(id) | DELETE /blackout-dates/:id | Admin |

---

## SDK — Schema Snapshots

Capture point-in-time snapshots of your entire metadata registry (collections, fields, relations). Useful for version control, environment promotion, and disaster recovery.

```typescript
import { readSchemaSnapshots, createSchemaSnapshot, restoreSchemaSnapshot } from '@nivaro/sdk'

// List all snapshots
const { data: snapshots } = await nivaro.request(readSchemaSnapshots())
// snapshots → Snapshot[] — { id, name, created_at, collection_count, field_count }

// Capture a snapshot
const { data: snap } = await nivaro.request(
  createSchemaSnapshot({
    name: 'Before v2.0 migration',
    description: 'Backup of schema before major refactoring',
  })
)

// Restore a snapshot (rolls back collections/fields to that point in time)
await nivaro.request(restoreSchemaSnapshot(snap.id))
```

#### What gets snapshotted

- All collections (metadata, settings, display templates)
- All fields (types, interfaces, validation rules, computed formulas)
- All relations (M2O, O2M, M2M, M2A)
- Field groups, layouts, and assignments
- Collection-level settings (draft/publish, item locking, etc.)

#### What does NOT get snapshotted

- Item data (rows) — only schema
- Workflows, pipelines, rules, or other business logic
- User permissions or role assignments
- Custom queries, external APIs, or webhooks

| Function | Route | Auth |
| --- | --- | --- |
| readSchemaSnapshots() | GET /schema-snapshot | Admin |
| createSchemaSnapshot(body) | POST /schema-snapshot | Admin |
| restoreSchemaSnapshot(id) | POST /schema-snapshot/:id/restore | Admin |

> **Warning:** Restoring a snapshot overwrites the current schema. It does NOT roll back data. Always back up your database before restoring.

---

## SDK — Alerts & Monitoring

Define threshold-based or anomaly-detection alerts on collection fields. Monitor values in real-time and notify users when conditions are met. All users can subscribe to alerts relevant to their work.

#### Admin: Create alert definitions

```typescript
import { readAlertDefinitions, createAlertDefinition, updateAlertDefinition, deleteAlertDefinition } from '@nivaro/sdk'

// List all alert definitions
const { data: defs } = await nivaro.request(readAlertDefinitions())

// Create a threshold alert
const { data: alert } = await nivaro.request(
  createAlertDefinition({
    name: 'High-value order',
    category: 'threshold',  // or 'anomaly'
    collection: 'orders',
    field: 'total_amount',
    operator: 'gt',  // _eq, _neq, _gt, _gte, _lt, _lte, _in, _contains
    threshold: 100000,
    unit: 'USD',
    cooldown_minutes: 60,  // prevent alert spam
    is_active: true,
  })
)

// Update alert
await nivaro.request(updateAlertDefinition(alert.id, { is_active: false }))

// Delete
await nivaro.request(deleteAlertDefinition(alert.id))
```

#### User: Subscribe to alerts

```typescript
import { readAlertSubscriptions, createAlertSubscription, deleteAlertSubscription } from '@nivaro/sdk'

// List alerts you are subscribed to
const { data: subs } = await nivaro.request(readAlertSubscriptions())
// subs → Subscription[] — { id, alert_id, notify_inapp, notify_email }

// Subscribe to an alert
const { data: sub } = await nivaro.request(
  createAlertSubscription({
    alert_definition_id: alertId,
    notify_inapp: true,   // in-app bell notification
    notify_email: false,  // email digest
  })
)

// Unsubscribe
await nivaro.request(deleteAlertSubscription(sub.id))
```

#### Admin: View alert log and manually evaluate

```typescript
import { readAlertLog, evaluateAlerts } from '@nivaro/sdk'

// Last 100 alert firings for a definition
const { data: log } = await nivaro.request(readAlertLog(alertId))
// log → Firing[] — { id, triggered_at, collection, item_id, field_value }

// Trigger immediate evaluation (normally runs every 5 minutes)
await nivaro.request(evaluateAlerts())
```

#### Alert operators

| Operator | Meaning | Example |
| --- | --- | --- |
| _eq | Equal | status == "overdue" |
| _neq | Not equal | status != "active" |
| _gt | Greater than | amount > 100000 |
| _gte | Greater or equal | age >= 65 |
| _lt | Less than | days_remaining < 0 |
| _lte | Less or equal | days_remaining <= 7 |
| _in | In set | status in ("failed", "cancelled") |
| _contains | Contains substring | email contains "@spam" |

| Command | Route | Auth |
| --- | --- | --- |
| readAlertDefinitions(collection?) | GET /alerts/definitions | Admin |
| createAlertDefinition(body) | POST /alerts/definitions | Admin |
| updateAlertDefinition(id, body) | PATCH /alerts/definitions/:id | Admin |
| deleteAlertDefinition(id) | DELETE /alerts/definitions/:id | Admin |
| readAlertSubscriptions() | GET /alerts/subscriptions | Authenticated |
| createAlertSubscription(body) | POST /alerts/subscriptions | Authenticated |
| deleteAlertSubscription(id) | DELETE /alerts/subscriptions/:id | Authenticated |
| readAlertLog(alertId?) | GET /alerts/log | Admin |
| evaluateAlerts() | POST /alerts/evaluate | Admin |

> **Note:** Alerts are evaluated every 5 minutes by an Inngest cron job. Anomaly detection uses statistical analysis (standard deviation multipliers) to identify unusual values. Cooldown prevents the same alert from firing multiple times within a time window.

---

## SDK — Dynamic Attributes

Dynamic attributes (EAV — Entity-Attribute-Value) let you attach arbitrary custom fields to any collection without modifying the database schema. Useful for extensibility, multi-tenant customization, and handling one-off custom fields.

#### Admin: Define attribute types

```typescript
import {
  readAttributeDefinitions, createAttributeDefinition,
  updateAttributeDefinition, deleteAttributeDefinition,
} from '@nivaro/sdk'

// List all attribute definitions for a collection
const { data: defs } = await nivaro.request(readAttributeDefinitions('projects'))

// Create a new attribute type
const { data: def } = await nivaro.request(
  createAttributeDefinition('projects', {
    key: 'risk_level',  // slug used in API calls
    label: 'Risk Level',  // display name
    type: 'select',  // text | number | boolean | date | select
    options: ['low', 'medium', 'high'],  // required for type='select'
    required: false,
    sort: 1,
  })
)

// Update definition
await nivaro.request(updateAttributeDefinition(def.id, { required: true }))

// Delete (also cleans up orphaned values)
await nivaro.request(deleteAttributeDefinition(def.id))
```

#### User: Read and write values

```typescript
import { readAttributes, updateAttributes } from '@nivaro/sdk'

// Read all attribute values for an item
const { data: attrs } = await nivaro.request(readAttributes('projects', '42'))
// attrs → { risk_level: 'medium', budget_code: 'IT-2024-003' }

// Update attribute values (partial patch)
await nivaro.request(
  updateAttributes('projects', '42', {
    risk_level: 'high',
    budget_code: 'IT-2024-099',
  })
)
// Omitted keys are left unchanged
```

#### Attribute types

| Type | Stored As | Parsed As | Example |
| --- | --- | --- | --- |
| text | string | string | "extended warranty" |
| number | string | number | "42" |
| boolean | string | boolean | "true" or "false" |
| date | string | ISO 8601 date | "2024-12-31" |
| select | string | option key | "gold" |

#### Admin UI

Attribute definitions are managed in `/data-model` → Table Editor → Attributes tab (admin only). Once definitions exist for a collection, an Attributes card appears on the item editor for users to fill in values.

| Command | Route | Auth |
| --- | --- | --- |
| readAttributeDefinitions(collection) | GET /attributes/definitions/:collection | Authenticated |
| createAttributeDefinition(collection, body) | POST /attributes/definitions/:collection | Admin |
| updateAttributeDefinition(id, body) | PATCH /attributes/definitions/:id | Admin |
| deleteAttributeDefinition(id) | DELETE /attributes/definitions/:id | Admin |
| readAttributes(collection, itemId) | GET /attributes/:collection/:itemId | Authenticated |
| updateAttributes(collection, itemId, body) | PATCH /attributes/:collection/:itemId | Authenticated |

> **Note:** All attribute values are stored as strings in `nivaro_attribute_values` regardless of the definition type. SDKs and the admin UI handle type conversion on read/write. Deleting a definition cleans up its orphaned values.

---

## SDK — Notification Subscriptions

Users subscribe to collection events (create/update/delete) with optional field filters. Notifications are delivered instantly or as daily/weekly digests. Self-serve — no admin permission needed.

```typescript
import {
  readNotificationSubscriptions,
  createNotificationSubscription,
  updateNotificationSubscription,
  deleteNotificationSubscription,
} from '@nivaro/sdk'

// List my subscriptions
const { data: subs } = await nivaro.request(readNotificationSubscriptions())
// subs → Subscription[] — { id, collection, event_type, filter_field, filter_value, label, digest_frequency, is_active }

// Subscribe to all new "urgent" orders
const { data: sub } = await nivaro.request(
  createNotificationSubscription({
    collection: 'orders',
    event_type: 'create',  // 'create' | 'update' | 'delete'
    filter_field: 'priority',  // optional: filter by field value
    filter_value: 'urgent',  // only notify if priority == 'urgent'
    label: 'Urgent orders',  // custom label
    is_active: true,
  })
)

// Switch to daily digest instead of instant notifications
await nivaro.request(
  updateNotificationSubscription(sub.id, {
    digest_frequency: 'instant',  // or 'daily' or 'weekly'
  })
)

// Unsubscribe
await nivaro.request(deleteNotificationSubscription(sub.id))
```

#### Subscription types

| Event Type | Triggers | Example |
| --- | --- | --- |
| create | New item is added to the collection | Notify on new leads |
| update | An existing item is modified | Notify when status changes |
| delete | An item is removed from the collection | Notify on deleted orders |

#### Filters (optional)

If you only care about certain items (e.g., high-priority orders), specify a filter_field and filter_value. Notifications only fire when the field matches the value.

| No Filter | With Filter | Result |
| --- | --- | --- |
| collection: "orders" | filter_field: "priority", filter_value: "urgent" | Only notify on urgent orders |
| collection: "deals" | filter_field: "amount", filter_value: "100000" | Only notify on deals >= 100k |
| collection: "projects" | (no filter) | Notify on ALL project changes |

#### Digest modes

| Mode | Delivery | Best For |
| --- | --- | --- |
| instant | Real-time in-app bell notification | Critical events that need immediate action |
| daily | Email digest at 08:00 daily | Summary of events from the last 24 hours |
| weekly | Email digest on Monday 08:00 | Lower-priority notifications, trending events |

| Command | Route | Auth |
| --- | --- | --- |
| readNotificationSubscriptions() | GET /notification-subscriptions | Authenticated |
| createNotificationSubscription(body) | POST /notification-subscriptions | Authenticated |
| updateNotificationSubscription(id, body) | PATCH /notification-subscriptions/:id | Authenticated |
| deleteNotificationSubscription(id) | DELETE /notification-subscriptions/:id | Authenticated |

> **Note:** Digest emails are sent daily at 08:00 and weekly on Monday at 08:00 (UTC). Each user has a single watermark (`last_digest_at`) shared across both daily and weekly digests — whichever sends first advances the watermark, so events are never delivered twice.

---

## SDK — SLA Rules

Attach time-based SLA targets (e.g., "resolve within 24 hours") to workflow states. Track elapsed time, warn on approaching breach, and escalate to managers when targets are missed.

#### Admin: Define SLA rules

```typescript
import {
  readSlaRules, readSlaRule,
  createSlaRule, updateSlaRule, deleteSlaRule,
} from '@nivaro/sdk'

// List all SLA rules for a workflow template
const { data: rules } = await nivaro.request(readSlaRules(workflowTemplateId))

// Create an SLA rule
const { data: rule } = await nivaro.request(
  createSlaRule({
    name: 'Critical bug resolution',
    workflow_template_id: 'wf-uuid',
    state_key: 'in_progress',  // applies to this workflow state
    duration_hours: 8,  // must resolve within 8 hours
    warning_threshold_pct: 75,  // warn at 75% (6 hours)
    business_hours_only: true,  // count only Mon-Fri 09:00-17:00
    notify_on_warning: true,  // notify owner at 75%
    notify_on_breach: true,  // notify owner at 100%
    escalation_user_id: 'manager-uuid',  // escalate to manager on breach
    is_active: true,
  })
)

// Update
await nivaro.request(updateSlaRule(rule.id, { duration_hours: 16 }))

// Delete
await nivaro.request(deleteSlaRule(rule.id))
```

#### User: Check SLA status

```typescript
import { readSlaStatus, readSlaStatusBatch } from '@nivaro/sdk'

// Check SLA for a single item
const { data: status } = await nivaro.request(readSlaStatus('orders', '42'))
// status → SlaStatus[] — one entry per active SLA rule for the workflow state
// {
//   rule_id,
//   rule_name,
//   state_key,
//   elapsed_hours: 4.5,
//   remaining_hours: 3.5,
//   warning_threshold_pct: 75,
//   is_warning: false,  // 75% reached?
//   is_breached: false,  // 100% exceeded?
//   breached_at: null,
// }

// Batch check multiple items
const { data: batch } = await nivaro.request(
  readSlaStatusBatch('orders', ['42', '43', '44'])
)
// batch → { [itemId]: SlaStatus[] }
```

#### Business hours calculation

When `business_hours_only: true`, only Mon-Fri 09:00-17:00 is counted. Blackout dates (holidays, maintenance windows) pause the timer entirely.

| Scenario | Time Counting | Example |
| --- | --- | --- |
| Mon 10:00 - Mon 18:00 | 8 business hours counted | 8h of an 8h SLA |
| Fri 16:00 - Fri 17:00 + Mon 09:00 - 10:00 | 2 business hours counted | 1h Friday + 1h Monday |
| During blackout date | Timer paused | Winter shutdown 12/20-1/2 → no time counted |
| 24/7 mode (business_hours_only: false) | All hours counted | Calendar hours only |

| Command | Route | Auth |
| --- | --- | --- |
| readSlaRules(workflowTemplateId?) | GET /sla/rules | Admin |
| readSlaRule(id) | GET /sla/rules/:id | Admin |
| createSlaRule(body) | POST /sla/rules | Admin |
| updateSlaRule(id, body) | PATCH /sla/rules/:id | Admin |
| deleteSlaRule(id) | DELETE /sla/rules/:id | Admin |
| readSlaStatus(collection, itemId) | GET /sla/status/:collection/:item | Authenticated |
| readSlaStatusBatch(collection, ids) | POST /sla/status/batch | Authenticated |

> **Note:** SLA times are calculated from workflow history: elapsed time is how long the item has been in the current state. Transitions reset the clock for the new state (which may have its own SLA rule).

---

## SDK — Queues

Full command coverage for cross-collection worklists: queue CRUD and source configuration, item resolution with scopes/filters/sorting/pagination, claims, saved views (including column snapshots), per-viewer default views, stat trends, per-owner workload, and materialized-cache rebuilds.

```typescript
import {
  createNivaro, listQueues, readQueueItems, claimQueueItem,
  listQueueViews, createQueueView, setQueueDefaultView, readQueueTrends
} from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: 'nvk_…' })

const { data: queues } = await nivaro.request(listQueues())

// Table-style page 1 with per-column filters (omit page/limit for the full set)
const result = await nivaro.request(
  readQueueItems(queues[0].id, {
    scope: 'mine',
    sort: '-priority',
    filters: { state: 'Waiting on Manager Approval' },
    page: 1,
    limit: 25
  })
)
console.log(result.stats.total, result.data.length)

// Claim the first unclaimed item
const next = result.data.find((i) => !i.claimed_by)
if (next) await nivaro.request(claimQueueItem(queues[0].id, next))

// Save the current table state as a shared view and star it as my default
const view = await nivaro.request(
  createQueueView(queues[0].id, {
    name: 'My triage',
    is_shared: true,
    state: { scope: 'mine', sort: '-priority', view: 'table', columns: null }
  })
)
await nivaro.request(setQueueDefaultView(queues[0].id, view.data.id))
```

| Command | Purpose |
| --- | --- |
| listQueues / readQueue | Queues visible to the caller; one queue with sources + extra-field metadata |
| createQueue / updateQueue / deleteQueue | Queue CRUD incl. display_config (views, row_click, default_columns…) |
| updateQueueSources | Replace sources wholesale (max 10); cache-affecting edits rebuild materialized queues |
| readQueueItems | Resolve items: scope mine/unowned/all/claimed, column filters, sort, optional pagination |
| readQueueWorkload | Items grouped per owner with WIP limits |
| readQueueTrends | Daily stat snapshots for sparklines (scope "mine" = caller series) |
| claimQueueItem / releaseQueueItem | Claims with pipeline instance-owner write-through |
| listQueueViews / createQueueView / updateQueueView / deleteQueueView | Saved views — state snapshots incl. visible columns |
| readQueueColumnPrefs / setQueueDefaultView | Per-viewer starred default view |
| rematerializeQueue | Force a materialized-cache rebuild |
| readQueueCollectionStates / suggestQueueLabels | Builder helpers: state pickers, label-template previews |

> **Note:** Queue reads respect queue-level visibility (owner, shared, role-scoped). Claims return 403 when the queue has claims disabled.

---

## SDK — Presence & Awareness

Real-time presence tracking via Socket.io. See who is currently viewing/editing an item and take coordination actions (lock, merge, notify).

#### REST: Query presence

```typescript
import { readPresence, readAllPresence } from '@nivaro/sdk'

// Who is currently viewing/editing a specific item?
const { data: viewers } = await nivaro.request(readPresence('contracts', '99'))
// viewers → Presence[] — { user_id, first_name, last_name, email, is_editing, last_heartbeat }

// All active sessions across the instance (admin)
const { data: sessions, total } = await nivaro.request(readAllPresence())
// sessions → Presence[] (paginated; default 100 per page)
```

#### Socket.io: Real-time subscription

```typescript
import { createRealtime } from '@nivaro/sdk'

const rt = createRealtime(token)
await rt.connect('https://nivaro.example.com')

// Subscribe to presence updates for an item
rt.presence.subscribe('contracts:99', (users) => {
  console.log(`${users.length} users viewing`)
  users.forEach(u => {
    if (u.is_editing) console.log(`${u.first_name} is editing`)
  })
})

// Announce that you are editing
rt.presence.setEditing('contracts:99', true)

// Stop editing
rt.presence.setEditing('contracts:99', false)

// Leave the presence room
rt.presence.leave('contracts:99')
```

#### Soft edit locks (item locking)

Pair presence with item locking to prevent conflicting edits:

```typescript
// Admin UI example
const canEdit = async (collection, itemId, userId) => {
  // Check if item is locked by another user
  const { data: locked } = await nivaro.request(
    isItemLocked(collection, itemId, userId)
  )

  if (locked && locked.lock.user_id !== userId) {
    // Item is locked by someone else
    return false
  }

  // Item is free to edit — acquire a lock
  const { data: lock } = await nivaro.request(
    acquireItemLock(collection, itemId)
  )
  return true
}

// Release lock when done editing
await nivaro.request(releaseItemLock(collection, itemId))
```

#### Presence events via Socket.io

| Event | When Fired | Data |
| --- | --- | --- |
| presence:join | User enters a room | { user_id, first_name, last_name } |
| presence:leave | User leaves a room | { user_id } |
| presence:editing | User starts/stops editing | { user_id, is_editing } |
| presence:heartbeat | Periodic keep-alive (30s) | { user_id, last_seen } |

| Command | Route | Auth |
| --- | --- | --- |
| readPresence(collection, itemId) | GET /presence/:collection/:itemId | Authenticated |
| readAllPresence(limit?, offset?) | GET /presence | Admin |

> **Note:** Presence data is ephemeral — it lives only in Redis and is lost on server restart. Perfect for collaboration cues but not for audit/compliance tracking. The admin UI emits heartbeats automatically; custom clients should emit `presence:heartbeat` every 30 seconds to stay visible.

---

## Tree & Hierarchy

The Nivaro SDK provides typed commands for both same-collection trees and multi-collection hierarchies.

#### Tree commands

```typescript
import { createNivaro, readTreeConfig, readTreeNodes, readTreeNested, readTreeAncestors, readTreeDescendants, readTreeChildren, moveTreeNode, reorderTreeSiblings, rebuildTreePaths } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: 'my-token' })

// Check if a collection has a tree config
const config = await nivaro.request(readTreeConfig('org_units'))
// → { data: { id, collection, parent_field, label_field, order_field } | null }

// Flat node list (for custom rendering)
const nodes = await nivaro.request(readTreeNodes('org_units'))

// Fully nested tree (recursive children arrays)
const tree = await nivaro.request(readTreeNested('org_units'))

// Ancestors of a node (root-first breadcrumb)
const path = await nivaro.request(readTreeAncestors('org_units', 42))

// Direct children of a node
const kids = await nivaro.request(readTreeChildren('org_units', 42))

// All descendants (any depth)
const all = await nivaro.request(readTreeDescendants('org_units', 42))

// Move a node (null = make root)
await nivaro.request(moveTreeNode('org_units', 42, 7))

// Reorder siblings (requires order_field on the tree config)
await nivaro.request(reorderTreeSiblings('org_units', 42, [
  { id: 42, sort: 0 },
  { id: 43, sort: 1 },
]))

// Rebuild materialized path/depth columns (admin; maintain_path configs)
await nivaro.request(rebuildTreePaths(3))
```

#### Tree permission commands (admin)

```typescript
import { listTreePermissions, createTreePermission, updateTreePermission, deleteTreePermission } from '@nivaro/sdk'

// List rules (optionally for one collection)
const rules = await nivaro.request(listTreePermissions('org_units'))

// Deny the "Contractors" role updates inside node 42's subtree
await nivaro.request(createTreePermission({
  collection: 'org_units',
  node_id: 42,
  role: '0a1b2c3d-…',     // role UUID
  action: 'update',
  allow: false,
}))

await nivaro.request(updateTreePermission(7, { action: '*' }))
await nivaro.request(deleteTreePermission(7))
```

> **Note:** Item reads on tree collections may include an `_inherited` sidecar (`{ field: ancestorId }`) when inheritable fields resolved values from an ancestor — see Inherited Field Values.

#### Hierarchy commands

```typescript
import { createNivaro, listHierarchyConfigs, readHierarchyConfig, readHierarchyTree, readHierarchyNodes, readHierarchyNodeChildren, readHierarchyNodeAncestors, createHierarchyConfig, updateHierarchyConfig, deleteHierarchyConfig } from '@nivaro/sdk'

// List all hierarchy configs
const configs = await nivaro.request(listHierarchyConfigs())

// Full nested tree for hierarchy #1
const tree = await nivaro.request(readHierarchyTree(1))

// Flat nodes for hierarchy #1
const nodes = await nivaro.request(readHierarchyNodes(1))

// Children of a specific node
const children = await nivaro.request(readHierarchyNodeChildren(1, 'divisions', 5))

// Ancestors (breadcrumb) of a node
const ancestors = await nivaro.request(readHierarchyNodeAncestors(1, 'regions', 22))

// Create a new hierarchy config
await nivaro.request(createHierarchyConfig({
  name: 'Org Structure',
  levels: [
    { collection: 'divisions', label_field: 'name', parent_fk: null },
    { collection: 'regions', label_field: 'name', parent_fk: 'division_id' },
  ],
}))
```

---

## SDK Coverage: 300+ Typed Commands

The @nivaro/sdk command surface now covers every feature area — roughly 175 typed `Command<T>` factories spanning items, files, workflows, pipelines, flows, comments, webhooks, rules, custom queries, trees and hierarchies, submission forms, field watches, notification subscriptions, imports, SLA, alerts, AI endpoints (generate, summarize, validate, check-duplicates), translations, drafts, scheduled changes, record templates, saved views, API keys, widget feeds, sync jobs, ERP submissions, PDF templates, pages, queues (worklists, items, claims, saved views, trends, workload), roles & policies (RBAC/RLS), user management + out-of-office delegation, file management (list/meta/presign/transform URLs), dashboard widgets, extension item/bulk actions, throughput reporting, and more. If a REST route exists, there is a typed command for it.

#### Discovering commands

- Everything is exported from the package root — editor autocomplete on `import { … } from "@nivaro/sdk"` is the fastest index.
- The Playground at /playground runs snippets against the live instance with your session's permissions, with collection and field comboboxes to scaffold calls.
- All commands flow through `nivaro.request(command)`, so auth, workspace headers, and error handling are uniform.

```typescript
import { createNivaro, readItems, aiValidate, listWidgetFeeds } from '@nivaro/sdk';

const nivaro = createNivaro('https://nivaro.example.com').withToken('nvk_...');

const articles = await nivaro.request(readItems('articles', { limit: 5 }));
const check = await nivaro.request(aiValidate('articles', { title: 'Draft post' }));
const feeds = await nivaro.request(listWidgetFeeds());
```


---

## TypeScript

All commands are fully typed. Pass your collection interface as a generic to get typed responses:

```typescript
interface Project {
  id: string
  name: string
  status: 'active' | 'done' | 'archived'
  owner: string
  created_at: string
}

const list = await nivaro.request(readItems<Project>('projects', {
  filter: { status: _eq('active') },
  sort: [desc('created_at')],
}))
// list.data is Project[]

const { data: project } = await nivaro.request(readItem<Project>('projects', id))
// project is Project
```

---

## License

MIT — see [LICENSE](https://github.com/nodeworks/nivaro/blob/main/LICENSE).

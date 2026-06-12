import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Code2,
  Copy,
  Layers,
  Play,
  Terminal,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Command catalog (mirrors sdk/src/index.ts) ──────────────────────────────
//
// Each entry maps an SDK command to its REST equivalent. `in` controls where a
// param lands: path segment, query string, query string as JSON (stringified),
// merged body key, or the raw request body.

type ParamLocation = 'path' | 'query' | 'query-json' | 'body' | 'body-raw'

// `kind` drives the input widget: 'collection' → registered-collection combobox,
// 'fields' → multi-token field picker (comma-joined), 'field' → single field
// combobox with free entry. Unset → plain input/textarea by `type`.
type ParamKind = 'collection' | 'fields' | 'field'

type ParamDef = {
  name: string
  type: 'string' | 'number' | 'json'
  required?: boolean
  in: ParamLocation
  placeholder?: string
  kind?: ParamKind
}

type CmdDef = {
  name: string
  group: string
  description: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string // `{param}` placeholders
  params: ParamDef[]
}

const p = (
  name: string,
  type: ParamDef['type'],
  loc: ParamLocation,
  required = false,
  placeholder?: string,
  kind?: ParamKind
): ParamDef => ({ name, type, in: loc, required, placeholder, kind })

// Shorthand for the ubiquitous `collection` param — always kind: 'collection'.
const pc = (loc: ParamLocation, required = false, placeholder?: string): ParamDef =>
  p('collection', 'string', loc, required, placeholder, 'collection')

const COMMANDS: CmdDef[] = [
  // ─── Items ───
  {
    name: 'readItems',
    group: 'Items',
    description: 'List items in a collection with filter / sort / pagination.',
    method: 'GET',
    path: '/items/{collection}',
    params: [
      pc('path', true, 'articles'),
      p('filter', 'json', 'query-json', false, '{ "status": { "_eq": "active" } }'),
      p('sort', 'string', 'query', false, '-created_at,name'),
      p('fields', 'string', 'query', false, 'id,name', 'fields'),
      p('limit', 'number', 'query'),
      p('offset', 'number', 'query'),
      p('search', 'string', 'query')
    ]
  },
  {
    name: 'readItem',
    group: 'Items',
    description: 'Fetch a single item by primary key.',
    method: 'GET',
    path: '/items/{collection}/{id}',
    params: [pc('path', true), p('id', 'string', 'path', true)]
  },
  {
    name: 'createItem',
    group: 'Items',
    description: 'Create an item.',
    method: 'POST',
    path: '/items/{collection}',
    params: [pc('path', true), p('data', 'json', 'body-raw', true, '{ "name": "New item" }')]
  },
  {
    name: 'updateItem',
    group: 'Items',
    description: 'Patch an item by primary key.',
    method: 'PATCH',
    path: '/items/{collection}/{id}',
    params: [
      pc('path', true),
      p('id', 'string', 'path', true),
      p('data', 'json', 'body-raw', true, '{ "status": "done" }')
    ]
  },
  {
    name: 'deleteItem',
    group: 'Items',
    description: 'Delete an item by primary key.',
    method: 'DELETE',
    path: '/items/{collection}/{id}',
    params: [pc('path', true), p('id', 'string', 'path', true)]
  },
  {
    name: 'readSingleton',
    group: 'Items',
    description: 'Read a singleton collection.',
    method: 'GET',
    path: '/items/{collection}',
    params: [pc('path', true)]
  },
  {
    name: 'updateSingleton',
    group: 'Items',
    description: 'Update a singleton collection.',
    method: 'PATCH',
    path: '/items/{collection}',
    params: [pc('path', true), p('data', 'json', 'body-raw', true)]
  },

  // ─── Auth / Users ───
  {
    name: 'readMe',
    group: 'Auth & Users',
    description: 'Current authenticated user.',
    method: 'GET',
    path: '/auth/me',
    params: []
  },
  {
    name: 'updateMe',
    group: 'Auth & Users',
    description: 'Update the current user profile.',
    method: 'PATCH',
    path: '/auth/me',
    params: [p('data', 'json', 'body-raw', true, '{ "first_name": "Rob" }')]
  },
  {
    name: 'readUsers',
    group: 'Auth & Users',
    description: 'List CMS users.',
    method: 'GET',
    path: '/users',
    params: [
      p('filter', 'json', 'query-json'),
      p('sort', 'string', 'query'),
      p('limit', 'number', 'query'),
      p('offset', 'number', 'query')
    ]
  },
  {
    name: 'generateToken',
    group: 'Auth & Users',
    description: 'Generate a static API token for the current user.',
    method: 'POST',
    path: '/users/me/token',
    params: []
  },
  {
    name: 'revokeToken',
    group: 'Auth & Users',
    description: 'Revoke the current user static token.',
    method: 'DELETE',
    path: '/users/me/token',
    params: []
  },
  {
    name: 'generateUserToken',
    group: 'Auth & Users',
    description: 'Generate a static token for another user (admin).',
    method: 'POST',
    path: '/users/{userId}/token',
    params: [p('userId', 'string', 'path', true)]
  },
  {
    name: 'revokeUserToken',
    group: 'Auth & Users',
    description: 'Revoke a user token (admin).',
    method: 'DELETE',
    path: '/users/{userId}/token',
    params: [p('userId', 'string', 'path', true)]
  },

  // ─── Collections / Schema ───
  {
    name: 'readCollections',
    group: 'Schema',
    description: 'List registered collections.',
    method: 'GET',
    path: '/collections',
    params: []
  },
  {
    name: 'exportSchemaSnapshot',
    group: 'Schema',
    description: 'Export the full schema snapshot JSON.',
    method: 'GET',
    path: '/schema-snapshot/export',
    params: []
  },
  {
    name: 'importSchemaSnapshot',
    group: 'Schema',
    description: 'Import a schema snapshot (upsert).',
    method: 'POST',
    path: '/schema-snapshot/import',
    params: [p('snapshot', 'json', 'body-raw', true)]
  },

  // ─── Revisions & Activity ───
  {
    name: 'readRevisions',
    group: 'Revisions & Activity',
    description: 'All revisions for an item, newest first.',
    method: 'GET',
    path: '/revisions',
    params: [pc('query', true), p('item', 'string', 'query', true)]
  },
  {
    name: 'readRevision',
    group: 'Revisions & Activity',
    description: 'Single revision by ID.',
    method: 'GET',
    path: '/revisions/{id}',
    params: [p('id', 'number', 'path', true)]
  },
  {
    name: 'readActivity',
    group: 'Revisions & Activity',
    description: 'Audit log entries.',
    method: 'GET',
    path: '/activity',
    params: [
      pc('query'),
      p('action', 'string', 'query', false, 'create | update | delete | login'),
      p('user', 'string', 'query'),
      p('limit', 'number', 'query'),
      p('offset', 'number', 'query')
    ]
  },

  // ─── Notifications ───
  {
    name: 'readNotifications',
    group: 'Notifications',
    description: 'List notifications for the current user.',
    method: 'GET',
    path: '/notifications',
    params: []
  },
  {
    name: 'readNotificationCount',
    group: 'Notifications',
    description: 'Unread notification count.',
    method: 'GET',
    path: '/notifications/count',
    params: []
  },
  {
    name: 'markNotificationRead',
    group: 'Notifications',
    description: 'Mark one notification read.',
    method: 'POST',
    path: '/notifications/{id}/read',
    params: [p('id', 'number', 'path', true)]
  },
  {
    name: 'markAllNotificationsRead',
    group: 'Notifications',
    description: 'Mark all notifications read.',
    method: 'POST',
    path: '/notifications/read-all',
    params: []
  },
  {
    name: 'deleteNotification',
    group: 'Notifications',
    description: 'Delete a notification.',
    method: 'DELETE',
    path: '/notifications/{id}',
    params: [p('id', 'number', 'path', true)]
  },

  // ─── Workflow ───
  {
    name: 'readWorkflowInstance',
    group: 'Workflow',
    description: 'Workflow state, transitions, and history for an item.',
    method: 'GET',
    path: '/pipelines/instance/{collection}/{item}',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'startWorkflow',
    group: 'Workflow',
    description: 'Start a workflow instance in its initial state.',
    method: 'POST',
    path: '/pipelines/instance/{collection}/{item}/start',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'transitionWorkflow',
    group: 'Workflow',
    description: 'Execute a workflow transition.',
    method: 'POST',
    path: '/pipelines/instance/{collection}/{item}/transition',
    params: [
      pc('path', true),
      p('item', 'string', 'path', true),
      p('transition_id', 'string', 'body', true),
      p('comment', 'string', 'body')
    ]
  },
  {
    name: 'readWorkflowInstances',
    group: 'Workflow',
    description: 'All workflow instances for a collection.',
    method: 'GET',
    path: '/pipelines/instances/{collection}',
    params: [pc('path', true)]
  },
  {
    name: 'readWorkflowBindings',
    group: 'Workflow',
    description: 'All workflow/pipeline bindings (admin).',
    method: 'GET',
    path: '/pipelines/bindings',
    params: []
  },

  // ─── Pipeline owners ───
  {
    name: 'readInstanceOwners',
    group: 'Pipeline Owners',
    description: 'Resolved owners for the current pipeline state.',
    method: 'GET',
    path: '/pipelines/instance/{collection}/{item}/owners',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'addInstanceOwner',
    group: 'Pipeline Owners',
    description: 'Manually assign an owner.',
    method: 'POST',
    path: '/pipelines/instance/{collection}/{item}/owners',
    params: [
      pc('path', true),
      p('item', 'string', 'path', true),
      p('user', 'string', 'body', true, 'user UUID'),
      p('state', 'string', 'body', false, 'state UUID (optional)')
    ]
  },
  {
    name: 'readStateOwners',
    group: 'Pipeline Owners',
    description: 'Resolved owners for a specific state.',
    method: 'GET',
    path: '/pipelines/instance/{collection}/{item}/owners/{stateId}',
    params: [
      pc('path', true),
      p('item', 'string', 'path', true),
      p('stateId', 'string', 'path', true)
    ]
  },
  {
    name: 'readAllStateOwners',
    group: 'Pipeline Owners',
    description: 'Owners for ALL states keyed by state ID — avoids N round-trips.',
    method: 'GET',
    path: '/pipelines/instance/{collection}/{item}/owners/all',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'removeInstanceOwner',
    group: 'Pipeline Owners',
    description: 'Remove an instance owner assignment.',
    method: 'DELETE',
    path: '/pipelines/instance-owners/{ownerId}',
    params: [p('ownerId', 'number', 'path', true)]
  },
  {
    name: 'readPipelineTemplates',
    group: 'Pipeline Owners',
    description: 'List pipeline templates (admin).',
    method: 'GET',
    path: '/pipelines',
    params: []
  },
  {
    name: 'readOwnerGroups',
    group: 'Pipeline Owners',
    description: 'Owner groups for a template, keyed by state.',
    method: 'GET',
    path: '/pipelines/{templateId}/owner-groups',
    params: [p('templateId', 'string', 'path', true)]
  },

  // ─── External APIs ───
  {
    name: 'listExternalApis',
    group: 'External APIs',
    description: 'List configured external APIs.',
    method: 'GET',
    path: '/external-apis',
    params: []
  },
  {
    name: 'getExternalApi',
    group: 'External APIs',
    description: 'Single external API config.',
    method: 'GET',
    path: '/external-apis/{id}',
    params: [p('id', 'number', 'path', true)]
  },
  {
    name: 'testExternalApi',
    group: 'External APIs',
    description: 'Fire a test request through a configured API.',
    method: 'POST',
    path: '/external-apis/{id}/test',
    params: [
      p('id', 'number', 'path', true),
      p('method', 'string', 'body', false, 'GET'),
      p('path', 'string', 'body', false, '/status'),
      p('body', 'json', 'body')
    ]
  },
  {
    name: 'callExternalApi',
    group: 'External APIs',
    description: 'Call any path on a configured API — auth resolved server-side.',
    method: 'POST',
    path: '/external-apis/{apiId}/call',
    params: [
      p('apiId', 'number', 'path', true),
      p('method', 'string', 'body'),
      p('path', 'string', 'body'),
      p('body', 'json', 'body')
    ]
  },
  {
    name: 'callExternalApiEndpoint',
    group: 'External APIs',
    description: 'Call a saved endpoint by id or slug.',
    method: 'POST',
    path: '/external-apis/endpoints/{slugOrId}/call',
    params: [p('slugOrId', 'string', 'path', true), p('body', 'json', 'body')]
  },
  {
    name: 'listExternalApiEndpoints',
    group: 'External APIs',
    description: 'Saved endpoints for an API.',
    method: 'GET',
    path: '/external-apis/{apiId}/endpoints',
    params: [p('apiId', 'number', 'path', true)]
  },

  // ─── Webhooks ───
  {
    name: 'listWebhooks',
    group: 'Webhooks',
    description: 'List outbound webhooks.',
    method: 'GET',
    path: '/webhooks',
    params: []
  },
  {
    name: 'createWebhook',
    group: 'Webhooks',
    description: 'Create a webhook.',
    method: 'POST',
    path: '/webhooks',
    params: [
      p(
        'body',
        'json',
        'body-raw',
        true,
        '{ "name": "My hook", "url": "https://…", "events": ["create"] }'
      )
    ]
  },
  {
    name: 'updateWebhook',
    group: 'Webhooks',
    description: 'Update a webhook.',
    method: 'PATCH',
    path: '/webhooks/{id}',
    params: [p('id', 'number', 'path', true), p('body', 'json', 'body-raw', true)]
  },
  {
    name: 'deleteWebhook',
    group: 'Webhooks',
    description: 'Delete a webhook.',
    method: 'DELETE',
    path: '/webhooks/{id}',
    params: [p('id', 'number', 'path', true)]
  },
  {
    name: 'testWebhook',
    group: 'Webhooks',
    description: 'Send a test payload to a webhook.',
    method: 'POST',
    path: '/webhooks/{id}/test',
    params: [p('id', 'number', 'path', true)]
  },

  // ─── Comments ───
  {
    name: 'listComments',
    group: 'Comments',
    description: 'Comments for an item.',
    method: 'GET',
    path: '/comments',
    params: [pc('query', true), p('item', 'string', 'query', true)]
  },
  {
    name: 'createComment',
    group: 'Comments',
    description: 'Add a comment (supports @mentions).',
    method: 'POST',
    path: '/comments',
    params: [pc('body', true), p('item', 'string', 'body', true), p('text', 'string', 'body', true)]
  },
  {
    name: 'updateComment',
    group: 'Comments',
    description: 'Edit a comment.',
    method: 'PATCH',
    path: '/comments/{id}',
    params: [p('id', 'string', 'path', true), p('text', 'string', 'body', true)]
  },
  {
    name: 'deleteComment',
    group: 'Comments',
    description: 'Delete a comment.',
    method: 'DELETE',
    path: '/comments/{id}',
    params: [p('id', 'string', 'path', true)]
  },

  // ─── Flows ───
  {
    name: 'listFlowRuns',
    group: 'Flows',
    description: 'Execution history of a flow.',
    method: 'GET',
    path: '/flows/{flowId}/runs',
    params: [
      p('flowId', 'string', 'path', true),
      p('status', 'string', 'query', false, 'success | error | running'),
      p('limit', 'number', 'query'),
      p('offset', 'number', 'query')
    ]
  },
  {
    name: 'getFlowRun',
    group: 'Flows',
    description: 'Single flow run with input/output.',
    method: 'GET',
    path: '/flows/runs/{runId}',
    params: [p('runId', 'string', 'path', true)]
  },

  // ─── Custom queries ───
  {
    name: 'listCustomQueries',
    group: 'Custom Queries',
    description: 'List saved SQL queries.',
    method: 'GET',
    path: '/custom-queries',
    params: []
  },
  {
    name: 'executeCustomQuery',
    group: 'Custom Queries',
    description: 'Execute a saved query by slug.',
    method: 'POST',
    path: '/custom-queries/{slug}/execute',
    params: [
      p('slug', 'string', 'path', true),
      p('params', 'json', 'body', false, '{ "year": 2026 }')
    ]
  },

  // ─── Blackout dates ───
  {
    name: 'listBlackoutDates',
    group: 'Blackout Dates',
    description: 'List blackout dates.',
    method: 'GET',
    path: '/blackout-dates',
    params: [p('scope', 'string', 'query')]
  },
  {
    name: 'checkBlackoutDate',
    group: 'Blackout Dates',
    description: 'Check whether a date is blacked out.',
    method: 'GET',
    path: '/blackout-dates/check',
    params: [p('date', 'string', 'query', true, '2026-12-25'), p('scope', 'string', 'query')]
  },

  // ─── Rules ───
  {
    name: 'listRules',
    group: 'Rules',
    description: 'List automation rules.',
    method: 'GET',
    path: '/rules',
    params: [pc('query')]
  },
  {
    name: 'createRule',
    group: 'Rules',
    description: 'Create an automation rule.',
    method: 'POST',
    path: '/rules',
    params: [p('body', 'json', 'body-raw', true)]
  },

  // ─── Tree ───
  {
    name: 'readTreeConfig',
    group: 'Tree & Hierarchy',
    description: 'Tree config for a collection (null when unconfigured).',
    method: 'GET',
    path: '/tree-configs/by-collection/{collection}',
    params: [pc('path', true)]
  },
  {
    name: 'readTreeNodes',
    group: 'Tree & Hierarchy',
    description: 'Flat node list for a tree.',
    method: 'GET',
    path: '/tree/{collection}/nodes',
    params: [pc('path', true)]
  },
  {
    name: 'readTreeNested',
    group: 'Tree & Hierarchy',
    description: 'Nested recursive tree structure.',
    method: 'GET',
    path: '/tree/{collection}/nested',
    params: [pc('path', true)]
  },
  {
    name: 'readTreeAncestors',
    group: 'Tree & Hierarchy',
    description: 'Ancestors of a node, root-first.',
    method: 'GET',
    path: '/tree/{collection}/{id}/ancestors',
    params: [pc('path', true), p('id', 'string', 'path', true)]
  },
  {
    name: 'readTreeDescendants',
    group: 'Tree & Hierarchy',
    description: 'All descendants of a node.',
    method: 'GET',
    path: '/tree/{collection}/{id}/descendants',
    params: [pc('path', true), p('id', 'string', 'path', true)]
  },
  {
    name: 'moveTreeNode',
    group: 'Tree & Hierarchy',
    description: 'Re-parent a tree node (cycle-safe).',
    method: 'PATCH',
    path: '/tree/{collection}/{id}/move',
    params: [
      pc('path', true),
      p('id', 'string', 'path', true),
      p('parent_id', 'string', 'body', false, 'null for root')
    ]
  },
  {
    name: 'listHierarchyConfigs',
    group: 'Tree & Hierarchy',
    description: 'Multi-collection hierarchy configs.',
    method: 'GET',
    path: '/hierarchy-configs',
    params: []
  },
  {
    name: 'readHierarchyTree',
    group: 'Tree & Hierarchy',
    description: 'Full nested tree for a hierarchy.',
    method: 'GET',
    path: '/hierarchy/{id}/tree',
    params: [p('id', 'number', 'path', true)]
  },
  {
    name: 'readHierarchyNodeChildren',
    group: 'Tree & Hierarchy',
    description: 'Direct children of a hierarchy node.',
    method: 'GET',
    path: '/hierarchy/{hierarchyId}/node/{collection}/{nodeId}/children',
    params: [
      p('hierarchyId', 'number', 'path', true),
      pc('path', true),
      p('nodeId', 'string', 'path', true)
    ]
  },
  {
    name: 'readHierarchyNodeAncestors',
    group: 'Tree & Hierarchy',
    description: 'Ancestors of a hierarchy node, root-first.',
    method: 'GET',
    path: '/hierarchy/{hierarchyId}/node/{collection}/{nodeId}/ancestors',
    params: [
      p('hierarchyId', 'number', 'path', true),
      pc('path', true),
      p('nodeId', 'string', 'path', true)
    ]
  },

  // ─── Extension registry ───
  {
    name: 'getExtensionRegistry',
    group: 'Extensions',
    description:
      'All registered extension capabilities — bulk actions, item actions, notification channels, dashboard widgets, field types, collection views, import parsers, validators, storage adapters.',
    method: 'GET',
    path: '/extension-registry',
    params: [pc('query')]
  },

  // ─── Bulk actions ───
  {
    name: 'listBulkActions',
    group: 'Extensions',
    description: 'Registered bulk actions for a collection.',
    method: 'GET',
    path: '/bulk-actions/registered',
    params: [pc('query')]
  },
  {
    name: 'executeBulkAction',
    group: 'Extensions',
    description: 'Run a registered bulk action on selected records.',
    method: 'POST',
    path: '/bulk-actions/{id}/execute',
    params: [
      p('id', 'string', 'path', true, 'mark-fulfilled'),
      pc('body', true),
      p('ids', 'json', 'body', true, '["1","2","3"]')
    ]
  },

  // ─── Item actions ───
  {
    name: 'listItemActions',
    group: 'Extensions',
    description: 'Registered item actions for a collection.',
    method: 'GET',
    path: '/item-actions/registered',
    params: [pc('query')]
  },
  {
    name: 'executeItemAction',
    group: 'Extensions',
    description: 'Run a registered item action on a single record.',
    method: 'POST',
    path: '/item-actions/{id}/execute',
    params: [
      p('id', 'string', 'path', true, 'push-to-erp'),
      pc('body', true),
      p('itemId', 'string', 'body', true)
    ]
  },

  // ─── User activity ───
  {
    name: 'listUserActivity',
    group: 'User Activity',
    description:
      'Paginated activity log for a user. Supports action, collection, date_from, date_to, sort filters.',
    method: 'GET',
    path: '/user-activity/{userId}',
    params: [
      p('userId', 'string', 'path', true),
      p('page', 'number', 'query', false, '1'),
      p('limit', 'number', 'query', false, '50'),
      p('action', 'string', 'query', false, 'create'),
      p('collection', 'string', 'query', false, 'orders'),
      p('sort', 'string', 'query', false, 'desc')
    ]
  },
  {
    name: 'getUserActivitySummary',
    group: 'User Activity',
    description: 'Total event count + top actions and collections for a user.',
    method: 'GET',
    path: '/user-activity/{userId}/summary',
    params: [p('userId', 'string', 'path', true)]
  },

  // ─── Item lock config ───
  {
    name: 'getItemLockingConfig',
    group: 'Item Locks',
    description: 'Get per-collection item locking enabled state.',
    method: 'GET',
    path: '/item-locks/config/{collection}',
    params: [pc('path', true)]
  },
  {
    name: 'setItemLockingConfig',
    group: 'Item Locks',
    description:
      'Enable or disable item locking for a collection. Disabling releases all active locks immediately.',
    method: 'PATCH',
    path: '/item-locks/config/{collection}',
    params: [pc('path', true), p('item_locking_enabled', 'string', 'body', true, 'true')]
  },
  {
    name: 'getItemLock',
    group: 'Item Locks',
    description: 'Current lock state for a record (null = free or locking disabled).',
    method: 'GET',
    path: '/item-locks/{collection}/{item}/lock',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'acquireItemLock',
    group: 'Item Locks',
    description: 'Acquire or refresh a lock. 409 if held by another user.',
    method: 'POST',
    path: '/item-locks/{collection}/{item}/lock',
    params: [pc('path', true), p('item', 'string', 'path', true)]
  },
  {
    name: 'releaseItemLock',
    group: 'Item Locks',
    description: 'Release a lock. Admin can pass ?force=1 to break any lock.',
    method: 'DELETE',
    path: '/item-locks/{collection}/{item}/lock',
    params: [
      pc('path', true),
      p('item', 'string', 'path', true),
      p('force', 'string', 'query', false, '1')
    ]
  },

  // ─── Settings — email & SMS test ───
  {
    name: 'testMailConfig',
    group: 'Settings',
    description: 'Send a test email using the current SMTP configuration.',
    method: 'POST',
    path: '/settings/mail/test',
    params: [p('to', 'string', 'body', true, 'you@example.com')]
  },
  {
    name: 'testSmsConfig',
    group: 'Settings',
    description: 'Send a test SMS using the current SMS provider configuration.',
    method: 'POST',
    path: '/settings/sms/test',
    params: [p('to', 'string', 'body', true, '+12125550100')]
  },

  // ─── Privacy & Retention ───
  {
    name: 'listRetentionPolicies',
    group: 'Privacy & Retention',
    description: 'List all user retention policies (admin).',
    method: 'GET',
    path: '/retention',
    params: []
  },
  {
    name: 'getRetentionPolicy',
    group: 'Privacy & Retention',
    description: 'Get a single retention policy by ID.',
    method: 'GET',
    path: '/retention/{id}',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'createRetentionPolicy',
    group: 'Privacy & Retention',
    description: 'Create a retention policy. action: redact | delete | suspend_only.',
    method: 'POST',
    path: '/retention',
    params: [
      p('name', 'string', 'body', true, '3-year inactivity redaction'),
      p('inactivity_threshold_months', 'number', 'body', true, '36'),
      p('action', 'string', 'body', false, 'redact'),
      p(
        'redact_fields',
        'json',
        'body',
        false,
        '["first_name","last_name","email","external_id","job_title"]'
      ),
      p('redact_value_template', 'string', 'body', false, 'Redacted_{{id}}'),
      p('exclusion_emails', 'json', 'body', false, '["admin@example.com"]'),
      p('cron_schedule', 'string', 'body', false, '0 2 1 * *'),
      p('is_active', 'string', 'body', false, 'true'),
      p('dry_run_mode', 'string', 'body', false, 'false')
    ]
  },
  {
    name: 'updateRetentionPolicy',
    group: 'Privacy & Retention',
    description: 'Update a retention policy.',
    method: 'PATCH',
    path: '/retention/{id}',
    params: [
      p('id', 'number', 'path', true, '1'),
      p('name', 'string', 'body', false, ''),
      p('inactivity_threshold_months', 'number', 'body', false, ''),
      p('action', 'string', 'body', false, 'redact'),
      p('is_active', 'string', 'body', false, 'true'),
      p('dry_run_mode', 'string', 'body', false, 'false'),
      p('cron_schedule', 'string', 'body', false, '')
    ]
  },
  {
    name: 'deleteRetentionPolicy',
    group: 'Privacy & Retention',
    description: 'Delete a retention policy.',
    method: 'DELETE',
    path: '/retention/{id}',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'runRetentionPolicy',
    group: 'Privacy & Retention',
    description:
      'Execute a retention policy. Pass dry_run=true for a preview without writing changes.',
    method: 'POST',
    path: '/retention/{id}/run',
    params: [p('id', 'number', 'path', true, '1'), p('dry_run', 'string', 'query', false, 'true')]
  },
  {
    name: 'listRetentionRuns',
    group: 'Privacy & Retention',
    description: 'List the run history for a retention policy.',
    method: 'GET',
    path: '/retention/{id}/runs',
    params: [p('id', 'number', 'path', true, '1')]
  },

  // ─── Layouts ───
  {
    name: 'readCollectionLayouts',
    group: 'Layouts',
    description: 'List all layouts for a collection.',
    method: 'GET',
    path: '/collection-layouts',
    params: [pc('query', true, 'articles')]
  },
  {
    name: 'readActiveLayout',
    group: 'Layouts',
    description: 'Read the active layout with groups + field assignments.',
    method: 'GET',
    path: '/collection-layouts/active',
    params: [pc('query', true, 'articles')]
  },
  {
    name: 'readLayoutGroups',
    group: 'Layouts',
    description: 'Read field groups for a specific layout.',
    method: 'GET',
    path: '/field-groups/{collection}',
    params: [
      pc('path', true, 'articles'),
      p('layout_id', 'number', 'query', true, '1')
    ]
  },
  {
    name: 'readLayoutAssignments',
    group: 'Layouts',
    description: 'Read field assignments for a specific layout by ID.',
    method: 'GET',
    path: '/collection-layouts/{id}/assignments',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'activateLayout',
    group: 'Layouts',
    description: 'Activate a layout — deactivates all others for the collection.',
    method: 'POST',
    path: '/collection-layouts/{id}/activate',
    params: [p('id', 'number', 'path', true, '1')]
  },
  {
    name: 'cloneLayout',
    group: 'Layouts',
    description: 'Clone a layout with a new name.',
    method: 'POST',
    path: '/collection-layouts/{id}/clone',
    params: [
      p('id', 'number', 'path', true, '1'),
      p('name', 'string', 'body', true, 'Compact copy')
    ]
  },
  {
    name: 'createCollectionLayout',
    group: 'Layouts',
    description: 'Create a new layout for a collection.',
    method: 'POST',
    path: '/collection-layouts',
    params: [pc('body', true, 'articles'), p('name', 'string', 'body', true, 'Reviewer Layout')]
  },
  {
    name: 'updateCollectionLayout',
    group: 'Layouts',
    description:
      'Update layout settings — tab_mode, validate_before_next, summary_enabled, ai_enabled, conditions.',
    method: 'PATCH',
    path: '/collection-layouts/{id}',
    params: [
      p('id', 'number', 'path', true, '1'),
      p('data', 'json', 'body-raw', true, '{ "tab_mode": "steps", "validate_before_next": true }')
    ]
  },
  {
    name: 'updateLayoutAssignments',
    group: 'Layouts',
    description:
      'Bulk-replace a layout’s field→group assignments and page slot sentinels (__pipeline__ / __comments__ / __tasks__).',
    method: 'PUT',
    path: '/collection-layouts/{id}/assignments',
    params: [
      p('id', 'number', 'path', true, '1'),
      p(
        'assignments',
        'json',
        'body',
        true,
        '[{ "field": "title", "group_key": "basic", "sort": 0 }]'
      )
    ]
  },
  {
    name: 'deleteCollectionLayout',
    group: 'Layouts',
    description: 'Delete a layout.',
    method: 'DELETE',
    path: '/collection-layouts/{id}',
    params: [p('id', 'number', 'path', true, '1')]
  }
]

const GROUPS = Array.from(new Set(COMMANDS.map((c) => c.group)))

const METHOD_CLS: Record<CmdDef['method'], string> = {
  GET: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800',
  POST: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
  PATCH:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800',
  PUT: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800',
  DELETE:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800'
}

// ─── Request building ─────────────────────────────────────────────────────────

type BuiltRequest = {
  method: CmdDef['method']
  url: string
  params: Record<string, string>
  data: unknown
}

function buildRequest(cmd: CmdDef, values: Record<string, string>): BuiltRequest {
  let url = cmd.path
  const query: Record<string, string> = {}
  let bodyRaw: unknown
  const bodyMerged: Record<string, unknown> = {}
  let hasMergedBody = false

  for (const param of cmd.params) {
    const raw = (values[param.name] ?? '').trim()
    if (!raw) {
      if (param.required) throw new Error(`"${param.name}" is required`)
      continue
    }
    const value: unknown =
      param.type === 'json' ? JSON.parse(raw) : param.type === 'number' ? Number(raw) : raw
    switch (param.in) {
      case 'path':
        url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)))
        break
      case 'query':
        query[param.name] = String(value)
        break
      case 'query-json':
        query[param.name] = JSON.stringify(value)
        break
      case 'body':
        bodyMerged[param.name] = value
        hasMergedBody = true
        break
      case 'body-raw':
        bodyRaw = value
        break
    }
  }

  if (url.includes('{')) {
    const missing = url.match(/\{([^}]+)\}/)?.[1]
    throw new Error(`"${missing}" is required`)
  }

  return {
    method: cmd.method,
    url,
    params: query,
    data: bodyRaw ?? (hasMergedBody ? bodyMerged : undefined)
  }
}

function buildSnippet(cmd: CmdDef, values: Record<string, string>): string {
  const pathArgs = cmd.params
    .filter((param) => param.in === 'path')
    .map((param) => {
      const raw = (values[param.name] ?? '').trim()
      if (!raw) return `/* ${param.name} */`
      return param.type === 'number' ? raw : JSON.stringify(raw)
    })

  const optionEntries: string[] = []
  for (const param of cmd.params) {
    if (param.in === 'path') continue
    const raw = (values[param.name] ?? '').trim()
    if (!raw) continue
    if (param.in === 'body-raw') {
      // raw body becomes its own positional argument
      pathArgs.push(raw)
      continue
    }
    const valueStr =
      param.type === 'json' ? raw : param.type === 'number' ? raw : JSON.stringify(raw)
    optionEntries.push(`${param.name}: ${valueStr}`)
  }

  const args = [...pathArgs]
  if (optionEntries.length > 0) args.push(`{ ${optionEntries.join(', ')} }`)
  return `await nivaro.request(${cmd.name}(${args.join(', ')}))`
}

// ─── Collection & field param inputs ──────────────────────────────────────────

type FieldMeta = { field: string; type: string; hidden?: boolean }

function useCollectionFields(collection: string) {
  const { data } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      api
        .get<{ data: { fields: FieldMeta[] } }>(`/collections/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  return (data?.fields ?? []).filter((f) => !f.hidden)
}

function CollectionCombobox({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })
  const collections = data ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2.5 font-mono text-[12.5px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || (placeholder ?? 'Select collection…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No collections found
            </CommandEmpty>
            <CommandGroup>
              {collections.map((c) => (
                <CommandItem
                  key={c.collection}
                  value={c.collection}
                  onSelect={() => {
                    onChange(c.collection === value ? '' : c.collection)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === c.collection ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {c.collection}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Hybrid field picker. Multi mode (`single = false`): tokens are comma-joined
// into the param value; dropdown lists the selected collection's fields AND any
// typed text can be committed as a free token (dotted/wildcard paths welcome).
// Single mode: plain combobox of fields with a "Use <typed>" free-entry escape.
function FieldTokenInput({
  collection,
  value,
  onChange,
  placeholder,
  single = false
}: {
  collection: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  single?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const fields = useCollectionFields(collection)

  const tokens = useMemo(
    () =>
      value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    [value]
  )

  const typed = input.trim()
  const exactMatch = fields.some((f) => f.field === typed)

  function commit(next: string[]) {
    onChange(next.join(','))
  }

  function addToken(token: string) {
    if (single) {
      onChange(token)
      setInput('')
      setOpen(false)
      return
    }
    if (!tokens.includes(token)) commit([...tokens, token])
    setInput('')
  }

  function toggleToken(token: string) {
    if (single) {
      onChange(token === value ? '' : token)
      setOpen(false)
      return
    }
    if (tokens.includes(token)) commit(tokens.filter((t) => t !== token))
    else commit([...tokens, token])
  }

  const isPicked = (field: string) => (single ? value === field : tokens.includes(field))

  const dropdown = (
    <PopoverContent className='w-[280px] p-0' align='start'>
      <Command>
        <CommandInput
          value={input}
          onValueChange={setInput}
          placeholder='Search fields or type a path…'
          className='h-8 text-[12px]'
        />
        <CommandList>
          <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
            {collection ? 'No fields found' : 'Pick a collection first — or type a field path'}
          </CommandEmpty>
          {typed && !exactMatch && (
            <CommandGroup>
              <CommandItem
                value={`use:${typed}`}
                onSelect={() => addToken(typed)}
                className='font-mono text-[12px]'
              >
                Use "{typed}"
              </CommandItem>
            </CommandGroup>
          )}
          {fields.length > 0 && (
            <CommandGroup heading={collection}>
              {fields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={f.field}
                  onSelect={() => toggleToken(f.field)}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', isPicked(f.field) ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='flex-1 truncate'>{f.field}</span>
                  <span className='ml-2 text-[10px] text-muted-foreground'>{f.type}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  )

  if (single) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            role='combobox'
            aria-expanded={open}
            className='h-8 w-full justify-between px-2.5 font-mono text-[12.5px] font-normal'
          >
            <span className={cn('truncate', !value && 'text-muted-foreground')}>
              {value || (placeholder ?? 'Select field…')}
            </span>
            <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        {dropdown}
      </Popover>
    )
  }

  return (
    <div className='flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1'>
      {tokens.map((t) => (
        <span
          key={t}
          className='inline-flex items-center gap-1 rounded bg-nvr-cyan/10 px-1.5 py-0.5 font-mono text-[11.5px] text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
        >
          {t}
          <button
            type='button'
            aria-label={`Remove ${t}`}
            onClick={() => commit(tokens.filter((x) => x !== t))}
            className='text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 gap-1 px-1.5 font-mono text-[11.5px] font-normal text-muted-foreground'
          >
            {tokens.length === 0 ? (placeholder ?? 'Add fields…') : 'Add…'}
            <ChevronsUpDown className='h-3 w-3 opacity-50' />
          </Button>
        </PopoverTrigger>
        {dropdown}
      </Popover>
    </div>
  )
}

// ─── Response viewer ──────────────────────────────────────────────────────────

function ResponseViewer({
  status,
  durationMs,
  body,
  isError
}: {
  status: number | null
  durationMs: number
  body: unknown
  isError: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setCollapsed((c) => !c)}
        className='flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
      >
        {collapsed ? (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
        )}
        <span className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
          Response
        </span>
        {status != null && (
          <span
            className={cn(
              'rounded px-1.5 py-px font-mono text-[10.5px] font-semibold',
              isError
                ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
            )}
          >
            {status}
          </span>
        )}
        <span className='ml-auto font-mono text-[10.5px] text-slate-400'>{durationMs} ms</span>
      </button>
      {!collapsed && (
        <pre className='max-h-[400px] overflow-auto bg-slate-900 p-3.5 font-mono text-[11.5px] leading-relaxed text-slate-100'>
          {text}
        </pre>
      )}
    </div>
  )
}

// ─── @nivaro/react reference examples ────────────────────────────────────────

type ReactExample = {
  id: string
  title: string
  description: string
  code: string
}

const REACT_EXAMPLES: ReactExample[] = [
  {
    id: 'layout-form',
    title: 'LayoutForm — simplest usage',
    description:
      'Drop-in layout-aware form. Reads the active layout from the API and renders tabs, sections, and ungrouped fields automatically. Bring your own field components.',
    code: `import { NivaroProvider, useNivaroForm, LayoutForm } from '@nivaro/react'
import { createNivaro } from '@nivaro/sdk'

const client = createNivaro(window.location.origin, { token })

function ArticleEditor({ id }: { id?: string }) {
  const form = useNivaroForm('articles', {
    itemId: id,           // omit for a create form
    autoLoad: true,       // fetch item data on mount
  }, client)

  return (
    <NivaroProvider client={client}>
      <LayoutForm
        form={form}
        renderField={({ field, value, onChange, visible, locked, required }) => {
          if (!visible) return null
          return (
            <div key={field}>
              <label>{field}{required && ' *'}</label>
              <input
                value={value ?? ''}
                onChange={e => onChange(e.target.value)}
                disabled={locked}
              />
            </div>
          )
        }}
      />
      <button
        disabled={!form.canSubmit}
        onClick={() => form.submit()}
      >
        Save
      </button>
    </NivaroProvider>
  )
}`
  },
  {
    id: 'use-ordered-layout',
    title: 'useOrderedLayout — custom layout renderer',
    description:
      'Full control over rendering. useOrderedLayout returns the parsed layout tree so you can build your own tab strip, collapsible sections, or grid without LayoutForm.',
    code: `import { useNivaroForm, useOrderedLayout } from '@nivaro/react'

function ArticleForm({ id }: { id?: string }) {
  const form = useNivaroForm('articles', { itemId: id, autoLoad: true })
  const { hasTabs, tabGroups, sectionGroups, ungroupedFields } = useOrderedLayout(form)

  // Tab-based layout
  if (hasTabs) {
    return (
      <div>
        {tabGroups.map(tab => (
          <details key={tab.key} open>
            <summary>{tab.label}</summary>
            {tab.fields.map(f => (
              <FieldInput key={f.field} form={form} field={f.field} />
            ))}
          </details>
        ))}
        {ungroupedFields.map(f => (
          <FieldInput key={f.field} form={form} field={f.field} />
        ))}
      </div>
    )
  }

  // Section-based layout
  return (
    <div>
      {sectionGroups.map(section => (
        <fieldset key={section.key}>
          <legend>{section.label}</legend>
          {section.fields.map(f => (
            <FieldInput key={f.field} form={form} field={f.field} />
          ))}
        </fieldset>
      ))}
      {ungroupedFields.map(f => (
        <FieldInput key={f.field} form={form} field={f.field} />
      ))}
    </div>
  )
}`
  },
  {
    id: 'use-field-state',
    title: 'useFieldState — custom field with colSpan grid',
    description:
      'Access per-field state including visibility, lock, required flag, validation error, and the colSpan value from the active layout assignment. Useful for building CSS Grid layouts that respect the layout editor widths.',
    code: `import { useNivaroForm, useFieldState } from '@nivaro/react'

function TitleField({ form }: { form: ReturnType<typeof useNivaroForm> }) {
  const { value, error, visible, locked, required, colSpan, onChange } =
    useFieldState(form, 'title')

  if (!visible) return null

  return (
    <div style={{ gridColumn: \`span \${colSpan ?? 1}\` }}>
      <label>
        Title{required && <span aria-hidden> *</span>}
      </label>
      <input
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        disabled={locked}
        aria-invalid={!!error}
        aria-required={required}
      />
      {error && <p role='alert'>{error}</p>}
    </div>
  )
}

// Render a full grid respecting per-field colSpan values
function LayoutGrid({ form, fields }: { form: any, fields: string[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16 }}>
      {fields.map(f => (
        <TitleField key={f} form={form} />
      ))}
    </div>
  )
}`
  },
  {
    id: 'use-watch-fields',
    title: 'useWatchFields — conditional field visibility',
    description:
      'Subscribe to a reactive slice of field values. Re-renders only when one of the watched fields changes. Ideal for conditional UI that depends on sibling field values.',
    code: `import { useNivaroForm, useWatchFields } from '@nivaro/react'

function ArticleForm() {
  const form = useNivaroForm('articles', { autoLoad: false })

  // Watch 'status' and 'type' — re-renders only when they change
  const { status, type } = useWatchFields(form, ['status', 'type'])

  return (
    <div>
      {/* Always visible */}
      <input
        placeholder='Title'
        value={form.values.title ?? ''}
        onChange={e => form.setValue('title', e.target.value)}
      />

      {/* Show publish_at only when status is 'scheduled' */}
      {status === 'scheduled' && (
        <input
          type='datetime-local'
          value={form.values.publish_at ?? ''}
          onChange={e => form.setValue('publish_at', e.target.value)}
        />
      )}

      {/* Show external_url only for 'link' type articles */}
      {type === 'link' && (
        <input
          type='url'
          placeholder='External URL'
          value={form.values.external_url ?? ''}
          onChange={e => form.setValue('external_url', e.target.value)}
        />
      )}
    </div>
  )
}`
  },
  {
    id: 'use-field-array',
    title: 'useFieldArray — repeater field',
    description:
      'Manage an array of sub-records stored in a JSON repeater field. Provides append, remove, move, update, and replace helpers. Integrates with the repeater_schema field type.',
    code: `import { useNivaroForm, useFieldArray } from '@nivaro/react'

function ArticleForm() {
  const form = useNivaroForm('articles', { autoLoad: false })
  const { items, append, remove, move, update } = useFieldArray(form, 'links')

  return (
    <div>
      <h3>Links ({items.length})</h3>
      {items.map((item, index) => (
        <div key={item._key} style={{ display: 'flex', gap: 8 }}>
          <input
            value={item.label ?? ''}
            placeholder='Label'
            onChange={e => update(index, { ...item, label: e.target.value })}
          />
          <input
            value={item.url ?? ''}
            placeholder='URL'
            onChange={e => update(index, { ...item, url: e.target.value })}
          />
          <button onClick={() => move(index, index - 1)} disabled={index === 0}>
            ↑
          </button>
          <button onClick={() => move(index, index + 1)} disabled={index === items.length - 1}>
            ↓
          </button>
          <button onClick={() => remove(index)}>Remove</button>
        </div>
      ))}
      <button onClick={() => append({ label: '', url: '' })}>Add link</button>
    </div>
  )
}`
  },
  {
    id: 'use-form-status-dirty',
    title: 'useFormStatus + useFormDirty — save bar',
    description:
      'Combine useFormStatus (submission state) with useFormDirty (unsaved-changes tracking) to build a sticky save bar that shows how many fields have been modified.',
    code: `import { useNivaroForm, useFormStatus, useFormDirty } from '@nivaro/react'

function ArticlePage({ id }: { id: string }) {
  const form = useNivaroForm('articles', { itemId: id, autoLoad: true })

  // Track submission state
  const { isDirty: statusDirty, isValid, isSubmitting, isLoading, canSubmit } =
    useFormStatus(form)

  // Track which fields changed vs initial server data
  const { isDirty, dirtyFields, isFieldDirty } = useFormDirty(form)

  return (
    <div>
      {/* Page content */}
      <input
        value={form.values.title ?? ''}
        onChange={e => form.setValue('title', e.target.value)}
        style={{ borderColor: isFieldDirty('title') ? 'orange' : undefined }}
      />

      {/* Sticky save bar — only shown when there are unsaved changes */}
      {isDirty && (
        <div style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          padding: '12px 24px',
          background: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>
            {dirtyFields.length} unsaved {dirtyFields.length === 1 ? 'change' : 'changes'}
          </span>
          <button
            onClick={() => form.reset()}
            disabled={isSubmitting}
            style={{ marginLeft: 'auto' }}
          >
            Discard
          </button>
          <button
            onClick={() => form.submit()}
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}`
  },
  {
    id: 'use-tab-section-state',
    title: 'useTabState + useSectionState — tab and collapse control',
    description:
      'Control active tab and section collapse state programmatically. Useful for validation flows (switch to tab with errors) or bulk expand/collapse actions.',
    code: `import { useNivaroForm, useTabState, useSectionState } from '@nivaro/react'

function ArticleEditor() {
  const form = useNivaroForm('articles', { autoLoad: false })
  const { activeTab, setActiveTab, tabs, hasTabs } = useTabState(form)
  const { isCollapsed, toggle, collapseAll, expandAll } = useSectionState(form)

  async function handleSubmit() {
    const result = await form.submit()
    if (!result.ok && result.firstErrorField) {
      // Switch to the tab that contains the first invalid field
      const errorTab = tabs.find(t => t.fields.some(f => f.field === result.firstErrorField))
      if (errorTab) setActiveTab(errorTab.key)
    }
  }

  return (
    <div>
      {hasTabs && (
        <nav style={{ display: 'flex', gap: 8 }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{ fontWeight: activeTab === tab.key ? 'bold' : 'normal' }}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={expandAll}>Expand all</button>
        <button onClick={collapseAll}>Collapse all</button>
      </div>

      {/* Render sections with collapse control */}
      {form.layout?.sectionGroups?.map(section => (
        <div key={section.key}>
          <button onClick={() => toggle(section.key)}>
            {isCollapsed(section.key) ? '▶' : '▼'} {section.label}
          </button>
          {!isCollapsed(section.key) && (
            <div>
              {section.fields.map(f => (
                <input key={f.field} placeholder={f.field} />
              ))}
            </div>
          )}
        </div>
      ))}

      <button onClick={handleSubmit}>Save</button>
    </div>
  )
}`
  }
]

// ─── @nivaro/react tab component ──────────────────────────────────────────────

function ReactReferenceTab() {
  const [selectedId, setSelectedId] = useState(REACT_EXAMPLES[0].id)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const selected = REACT_EXAMPLES.find((e) => e.id === selectedId) ?? REACT_EXAMPLES[0]

  async function copyCode(id: string, code: string) {
    await navigator.clipboard.writeText(code)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      {/* Left: example list */}
      <aside className='flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card overflow-y-auto'>
        <div className='px-3 py-3 border-b border-slate-100 dark:border-border'>
          <p className='text-[11px] text-slate-400 leading-snug'>
            Static code examples for{' '}
            <code className='font-mono'>@nivaro/react</code> hooks and components.
          </p>
        </div>
        <nav className='flex-1 p-2 space-y-0.5'>
          {REACT_EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              type='button'
              onClick={() => setSelectedId(ex.id)}
              className={cn(
                'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                selectedId === ex.id
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-600 hover:bg-slate-50 dark:text-muted-foreground dark:hover:bg-muted/40'
              )}
            >
              <span className='block text-[12px] font-medium leading-snug'>{ex.title}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Right: example detail */}
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='mx-auto max-w-3xl space-y-5'>
          {/* Header card */}
          <div className='rounded-xl border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <div className='flex items-center gap-2'>
              <h2 className='font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                {selected.title}
              </h2>
              <Badge variant='outline' className='font-mono text-[10px]'>
                @nivaro/react
              </Badge>
            </div>
            <p className='mt-1.5 text-[12.5px] text-slate-500 dark:text-muted-foreground leading-relaxed'>
              {selected.description}
            </p>
          </div>

          {/* Code block */}
          <div className='overflow-hidden rounded-xl border border-slate-200 dark:border-border'>
            <div className='flex items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
              <Code2 className='h-3.5 w-3.5 text-slate-400' />
              <span className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                Example
              </span>
              <Badge variant='secondary' className='px-1.5 py-px font-mono text-[9px]'>
                TSX
              </Badge>
              <Button
                size='sm'
                variant='outline'
                className='ml-auto h-6 gap-1.5 text-[11px]'
                onClick={() => void copyCode(selected.id, selected.code)}
              >
                {copiedId === selected.id ? (
                  <Check className='h-3 w-3 text-emerald-500' />
                ) : (
                  <Copy className='h-3 w-3' />
                )}
                {copiedId === selected.id ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className='overflow-x-auto bg-slate-900 p-3.5 font-mono text-[11.5px] leading-relaxed text-cyan-200 whitespace-pre'>
              {selected.code}
            </pre>
          </div>

          {/* Install hint */}
          <div className='overflow-hidden rounded-xl border border-slate-200 dark:border-border'>
            <div className='flex items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
              <Terminal className='h-3.5 w-3.5 text-slate-400' />
              <span className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                Install
              </span>
            </div>
            <pre className='overflow-x-auto bg-slate-900 p-3.5 font-mono text-[12px] leading-relaxed text-cyan-200'>
              {`pnpm add @nivaro/react @nivaro/sdk`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type RunResult = {
  status: number | null
  durationMs: number
  body: unknown
  isError: boolean
}

export function SdkPlaygroundPage() {
  const [activeTab, setActiveTab] = useState<'sdk' | 'react'>('sdk')
  const [selectedName, setSelectedName] = useState<string>(COMMANDS[0].name)
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<RunResult | null>(null)
  const [copied, setCopied] = useState(false)

  const selected = useMemo(
    () => COMMANDS.find((c) => c.name === selectedName) ?? COMMANDS[0],
    [selectedName]
  )

  function selectCommand(name: string) {
    setSelectedName(name)
    setValues({})
    setResult(null)
  }

  const snippet = useMemo(() => buildSnippet(selected, values), [selected, values])

  // The collection context for field pickers — first `kind: 'collection'` param.
  const collectionParamName = selected.params.find((q) => q.kind === 'collection')?.name
  const collectionValue = collectionParamName ? (values[collectionParamName] ?? '').trim() : ''

  const runMut = useMutation({
    mutationFn: async () => {
      const req = buildRequest(selected, values)
      const start = performance.now()
      try {
        const res = await api.request({
          method: req.method,
          url: req.url,
          params: Object.keys(req.params).length ? req.params : undefined,
          data: req.data
        })
        return {
          status: res.status,
          durationMs: Math.round(performance.now() - start),
          body: res.data ?? '(empty response)',
          isError: false
        } satisfies RunResult
      } catch (err) {
        const axErr = err as { response?: { status: number; data: unknown }; message?: string }
        if (axErr.response) {
          return {
            status: axErr.response.status,
            durationMs: Math.round(performance.now() - start),
            body: axErr.response.data,
            isError: true
          } satisfies RunResult
        }
        throw err
      }
    },
    onSuccess: (r) => setResult(r),
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Request failed'
      toast.error(msg)
    }
  })

  async function copySnippet() {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Terminal className='h-4 w-4 text-nvr-cyan' />
          <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            SDK Playground
          </h1>
          <span className='text-[12px] text-slate-400 hidden sm:block'>
            Explore @nivaro/sdk commands and @nivaro/react hooks
          </span>
          <div className='ml-auto flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
            <button
              type='button'
              onClick={() => setActiveTab('sdk')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                activeTab === 'sdk'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              <Terminal className='h-3.5 w-3.5' />
              @nivaro/sdk
            </button>
            <button
              type='button'
              onClick={() => setActiveTab('react')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                activeTab === 'react'
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              <Layers className='h-3.5 w-3.5' />
              @nivaro/react
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'react' ? (
        <ReactReferenceTab />
      ) : null}

      <div className={cn('flex flex-1 min-h-0 overflow-hidden', activeTab !== 'sdk' && 'hidden')}>
        {/* Left: searchable command list */}
        <aside className='flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <Command className='flex-1'>
            <CommandInput placeholder='Search commands…' />
            <CommandList className='max-h-none flex-1'>
              <CommandEmpty>No command found.</CommandEmpty>
              {GROUPS.map((group) => (
                <CommandGroup key={group} heading={group}>
                  {COMMANDS.filter((c) => c.group === group).map((c) => (
                    <CommandItem
                      key={c.name}
                      value={`${c.group} ${c.name} ${c.description}`}
                      onSelect={() => selectCommand(c.name)}
                      className={cn(
                        'flex items-center gap-2',
                        selectedName === c.name && 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      )}
                    >
                      <span
                        className={cn(
                          'w-12 shrink-0 rounded border px-1 text-center font-mono text-[9px] font-semibold',
                          METHOD_CLS[c.method]
                        )}
                      >
                        {c.method}
                      </span>
                      <span className='truncate font-mono text-[12px]'>{c.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </aside>

        {/* Right: command detail */}
        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          <div className='mx-auto max-w-3xl space-y-5'>
            {/* Header */}
            <div className='rounded-xl border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
              <div className='flex items-center gap-2'>
                <h2 className='font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  {selected.name}
                </h2>
                <Badge variant='outline' className='font-mono text-[10px]'>
                  {selected.group}
                </Badge>
              </div>
              <p className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                {selected.description}
              </p>
              <div className='mt-3 flex items-center gap-2'>
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold',
                    METHOD_CLS[selected.method]
                  )}
                >
                  {selected.method}
                </span>
                <code className='font-mono text-[12px] text-slate-600 dark:text-muted-foreground'>
                  /api{selected.path}
                </code>
              </div>
            </div>

            {/* Param form */}
            <div className='rounded-xl border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
              <div className='mb-4 flex items-center justify-between'>
                <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                  Parameters
                </h3>
                <Button
                  size='sm'
                  className='gap-1.5'
                  disabled={runMut.isPending}
                  onClick={() => runMut.mutate()}
                >
                  <Play className='h-3.5 w-3.5' />
                  {runMut.isPending ? 'Running…' : 'Run'}
                </Button>
              </div>
              {selected.params.length === 0 ? (
                <p className='text-[12px] text-slate-400'>This command takes no parameters.</p>
              ) : (
                <div className='space-y-3.5'>
                  {selected.params.map((param) => (
                    <div key={param.name} className='space-y-1.5'>
                      <Label className='flex items-center gap-1.5 text-[12px]'>
                        <span className='font-mono'>{param.name}</span>
                        {param.required && <span className='text-red-500'>*</span>}
                        <span className='ml-auto flex items-center gap-1'>
                          <Badge variant='secondary' className='px-1 py-px text-[9px] uppercase'>
                            {param.in.replace('-raw', '').replace('-json', '')}
                          </Badge>
                          <Badge variant='outline' className='px-1 py-px font-mono text-[9px]'>
                            {param.type}
                          </Badge>
                        </span>
                      </Label>
                      {param.kind === 'collection' ? (
                        <CollectionCombobox
                          value={values[param.name] ?? ''}
                          onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
                          placeholder={param.placeholder}
                        />
                      ) : param.kind === 'fields' || param.kind === 'field' ? (
                        <FieldTokenInput
                          collection={collectionValue}
                          single={param.kind === 'field'}
                          value={values[param.name] ?? ''}
                          onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
                          placeholder={param.placeholder}
                        />
                      ) : param.type === 'json' ? (
                        <Textarea
                          value={values[param.name] ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [param.name]: e.target.value }))
                          }
                          placeholder={param.placeholder ?? '{ }'}
                          rows={4}
                          spellCheck={false}
                          className='resize-y font-mono text-[12px]'
                        />
                      ) : (
                        <Input
                          value={values[param.name] ?? ''}
                          type={param.type === 'number' ? 'number' : 'text'}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [param.name]: e.target.value }))
                          }
                          placeholder={param.placeholder}
                          className='h-8 font-mono text-[12.5px]'
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* SDK snippet preview */}
            <div className='overflow-hidden rounded-xl border border-slate-200 dark:border-border'>
              <div className='flex items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
                <Code2 className='h-3.5 w-3.5 text-slate-400' />
                <span className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>
                  Equivalent SDK code
                </span>
                <Button
                  size='sm'
                  variant='outline'
                  className='ml-auto h-6 gap-1.5 text-[11px]'
                  onClick={() => void copySnippet()}
                >
                  {copied ? (
                    <Check className='h-3 w-3 text-emerald-500' />
                  ) : (
                    <Copy className='h-3 w-3' />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className='overflow-x-auto bg-slate-900 p-3.5 font-mono text-[12px] leading-relaxed text-cyan-200'>
                {`import { createNivaro, ${selected.name} } from '@nivaro/sdk'\n\nconst nivaro = createNivaro(window.location.origin, { token })\n${snippet}`}
              </pre>
            </div>

            {/* Response */}
            {result && (
              <ResponseViewer
                status={result.status}
                durationMs={result.durationMs}
                body={result.body}
                isError={result.isError}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

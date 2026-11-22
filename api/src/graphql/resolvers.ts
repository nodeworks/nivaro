import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import {
  GraphQLError,
  type GraphQLFieldConfigMap,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString
} from 'graphql'
import { db } from '../db/index.js'
import { findRecordInstance } from '../services/branch-instances.js'
import { chainFields } from '../services/chain-columns.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { readableFileIds } from '../services/file-access.js'
import { assertInstanceAccess, InstanceAccessError } from '../services/instance-guard.js'
import { writeStartHistory } from '../services/instance-start.js'
import { originFields } from '../services/note-authorship.js'
import { can } from '../services/permissions.js'
import {
  buildInstancePayload,
  coerceBool,
  gqlState,
  gqlUser,
  parseJson,
  resolveStateOwners,
  resolveTransitionTarget,
  type WorkflowInstance,
  type WorkflowState,
  type WorkflowTransition
} from '../services/pipeline-engine.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { runRecordTransition, serverMoveLog } from '../services/record-transition.js'
import { announceStateMoved } from '../services/state-moved.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { noteViewAsHistory } from '../services/view-as-attribution.js'
import type { User } from '../types.js'
import { pubsub, topics } from './pubsub.js'
import {
  ActivityEntryType,
  CmsFileType,
  ItemMutatedEventType,
  MeType,
  PipelineInstanceType,
  PipelineMatrixType,
  PipelineOwnersResultType,
  PipelineStateChangedEventType,
  PipelineTemplateType,
  RoleType,
  SettingsType,
  StateOwnersType,
  UserType,
  WorkflowInstanceType,
  WorkflowStateChangedEventType,
  WorkflowTemplateType,
  WorkflowTransitionResultType
} from './types.js'

// ─── Context ──────────────────────────────────────────────────────────────────

interface GQLContext {
  user?: User
  isAdmin?: boolean
  /** The HTTP request (POST /api/graphql): the edit lock and the activity row read it. */
  req?: FastifyRequest
  /** Subscriptions (graphql-ws): the tenant the connection resolved to ('' self-hosted). */
  tenantKey?: string
  /** Subscriptions in cloud mode: run a permission read inside the connection's tenant. */
  withTenant?: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * The tenant a subscription listens under. A graphql-ws connection runs outside any tenant
 * context, so it brings its own key; in cloud mode a connection without one hears nothing
 * rather than another tenant's events.
 */
function subscriptionTenant(ctx: GQLContext): string {
  if (ctx.tenantKey != null) return ctx.tenantKey
  return isMultiTenant() ? 't:none' : currentTenantKey()
}

/** May this subscriber hear a collection's events? The collection read gate (admins: all). */
async function mayReadForSubscription(
  ctx: GQLContext,
  user: User,
  collection: string
): Promise<boolean> {
  if (ctx.isAdmin) return true
  if (/^(nivaro_|directus_)/i.test(collection)) return false
  const readable = () => can(user, 'read', collection)
  return ctx.withTenant ? ctx.withTenant(readable) : readable()
}

/** Run a read as the subscriber, inside their connection's tenant (cloud). */
function asSubscriber<T>(ctx: GQLContext, fn: () => Promise<T>): Promise<T> {
  return ctx.withTenant ? ctx.withTenant(fn) : fn()
}

/** May this subscriber read the record (role, row filter, user scopes)? */
async function maySeeRecordForSubscription(
  ctx: GQLContext,
  user: User,
  collection: string,
  item: string
): Promise<boolean> {
  if (!(await mayReadForSubscription(ctx, user, collection))) return false
  try {
    await asSubscriber(ctx, () =>
      assertInstanceAccess(user, ctx.isAdmin ?? false, collection, item, undefined, 'read')
    )
    return true
  } catch {
    return false
  }
}

/**
 * Workflow / pipeline state events carry ids only; each subscriber gets the instance built AS
 * THEM (their role decides which transitions show), and an event for a record they can no
 * longer read is skipped rather than delivered.
 */
function instanceEventsAsSubscriber(
  source: AsyncIterableIterator<unknown>,
  field: 'workflowStateChanged' | 'pipelineStateChanged',
  ctx: GQLContext,
  user: User
): AsyncIterableIterator<unknown> {
  const build = async (ev: { collection: string; item: string; instance_id?: unknown }) => {
    if (!(await maySeeRecordForSubscription(ctx, user, ev.collection, String(ev.item)))) return null
    return asSubscriber(ctx, async () => {
      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: ev.instance_id as WorkflowInstance['id'] })
        .first()
      if (!instance) return null
      const payload = await buildInstancePayload(instance, user.role, ctx.isAdmin ?? false)
      return { [field]: { collection: ev.collection, item: ev.item, instance: payload } }
    })
  }
  return {
    async next() {
      for (;;) {
        const r = await source.next()
        if (r.done) return r
        const ev = (r.value as Record<string, unknown>)[field] as Parameters<typeof build>[0]
        const out = ev ? await build(ev).catch(() => null) : null
        if (out) return { value: out, done: false }
      }
    },
    return: () => source.return!(),
    throw: (e: unknown) => source.throw!(e),
    [Symbol.asyncIterator]() {
      return this
    }
  }
}

// ─── Guards ───────────────────────────────────────────────────────────────────

function requireUser(ctx: GQLContext): User {
  if (!ctx.user) throw new Error('Unauthorized')
  return ctx.user
}

/**
 * A manual transition from a GraphQL mutation: the ONE manual-move path
 * (runRecordTransition — the REST route's and the Teams cards'), 2026-11-18.
 * Record access, admin-only and extension checks, roles, owner / creator rule,
 * required note, requirements, conditions, the edit lock, background runs, the
 * double-fire claim, actions, history, View-as note, live announce, automatic
 * moves and the activity row all apply. A refusal is a GraphQLError carrying
 * the route's status and code. Answers the instance where it came to rest.
 */
async function runGraphqlMove(
  ctx: GQLContext,
  args: {
    collection: string
    item: string | number
    transition_id: string
    comment?: string | null
  }
): Promise<WorkflowInstance> {
  const user = requireUser(ctx)
  const r = await runRecordTransition({
    user,
    isAdmin: ctx.isAdmin ?? false,
    collection: args.collection,
    item: String(args.item),
    transitionId: String(args.transition_id),
    comment: args.comment ?? null,
    log: ctx.req?.log ?? serverMoveLog,
    ...(ctx.req ? { req: ctx.req } : {})
  })
  if (r.status < 200 || r.status >= 300) {
    const { error, code, ...extras } = (r.body ?? {}) as Record<string, unknown>
    throw new GraphQLError(typeof error === 'string' ? error : 'The move was refused.', {
      extensions: {
        code: typeof code === 'string' ? code : (MOVE_STATUS_CODES[r.status] ?? 'BAD_REQUEST'),
        status: r.status,
        ...extras
      }
    })
  }
  const moved = (r.body as { data?: { instance?: WorkflowInstance } })?.data?.instance
  // Re-read: the automatic moves after it may have taken the record further.
  const instance = moved?.id
    ? ((await db<WorkflowInstance>('nivaro_workflow_instances').where({ id: moved.id }).first()) ??
      moved)
    : moved
  if (!instance) throw new Error('No pipeline instance for this item')
  return instance
}

const MOVE_STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE'
}

function requireAdmin(ctx: GQLContext): User {
  const user = requireUser(ctx)
  if (!ctx.isAdmin) throw new Error('Admin access required')
  return user
}

/**
 * May the caller READ this record (role, row filter, User Scopes, addendum parent)? The same
 * gate the subscriptions and the REST instance routes apply. False = the record is invisible
 * (answer as "nothing there"); a collection the caller may not read at all is FORBIDDEN.
 */
export async function mayReadRecord(
  ctx: GQLContext,
  collection: string,
  item: string,
  guard: typeof assertInstanceAccess = assertInstanceAccess
): Promise<boolean> {
  const user = requireUser(ctx)
  try {
    await guard(user, ctx.isAdmin ?? false, collection, String(item), undefined, 'read')
    return true
  } catch (err) {
    if (err instanceof InstanceAccessError) {
      if (err.statusCode === 404) return false
      throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN', status: 403 } })
    }
    throw err
  }
}

/**
 * The instances of `collection` whose record the caller may read: system collections are
 * admin-only, a collection the caller cannot read gives nothing, and row filters + User Scopes
 * narrow the rest in one set-based pass.
 */
async function visibleInstances(
  ctx: GQLContext,
  user: User,
  collection: string,
  instances: WorkflowInstance[]
): Promise<WorkflowInstance[]> {
  if (/^(nivaro_|directus_)/i.test(collection)) return ctx.isAdmin ? instances : []
  if (instances.length === 0) return instances
  // Admins skip policy + row filters, never their own restrict User Scopes.
  const gates = await compileAccessGates(user, collection, { actingAdmin: !!ctx.isAdmin })
  if (gates.bypass) return instances
  const seen = await visibleIds(
    gates,
    instances.map((i) => String(i.item))
  )
  const lower = new Set([...seen].map((id) => id.toLowerCase()))
  return instances.filter((i) => lower.has(String(i.item).toLowerCase()))
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

async function loadWorkflowTemplate(id: string) {
  const template = await db('nivaro_workflow_templates').where({ id }).first()
  if (!template) return null

  const [states, transitions, bindings] = await Promise.all([
    db<WorkflowState>('nivaro_workflow_states').where({ template: id }).orderBy('sort'),
    db<WorkflowTransition>('nivaro_workflow_transitions').where({ template: id }).orderBy('sort'),
    db('nivaro_workflow_bindings').where({ template: id })
  ])

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    color: template.color,
    icon: template.icon,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    states: states.map(gqlState),
    transitions: transitions.map((t: WorkflowTransition) => ({
      id: t.id,
      fromState: t.from_state,
      toState: t.to_state,
      label: t.label,
      color: t.color,
      requiredRoles: parseJson(t.required_roles) as string[] | null,
      actions: parseJson(t.actions) as unknown[] | null,
      sort: t.sort
    })),
    bindings: bindings.map((b: Record<string, unknown>) => ({
      id: b.id,
      collection: b.collection,
      stateField: b.state_field
    }))
  }
}

async function loadPipelineTemplate(id: string) {
  const template = await db('nivaro_workflow_templates').where({ id }).first()
  if (!template) return null

  const [states, bindings] = await Promise.all([
    db<WorkflowState>('nivaro_workflow_states').where({ template: id }).orderBy('sort'),
    db('nivaro_workflow_bindings').where({ template: id })
  ])

  const statesWithGroups = await Promise.all(
    states.map(async (s) => {
      const groups = await db('nivaro_pipeline_owner_groups').where({ state: s.id }).orderBy('sort')
      const groupsWithUsers = await Promise.all(
        groups.map(async (g: Record<string, unknown>) => {
          const users = await db('nivaro_pipeline_owner_group_users as ogu')
            .join('nivaro_users as u', 'ogu.user', 'u.id')
            .where('ogu.group', g.id as string | number)
            .select('u.id', 'u.email', 'u.first_name', 'u.last_name')
          return {
            id: g.id,
            name: g.name,
            filters: parseJson(g.filters as string),
            isDefault: coerceBool(g.is_default),
            sort: (g.sort as number) ?? 0,
            priority: (g.priority as number) ?? 0,
            users: users.map((u: Record<string, unknown>) => gqlUser(u))
          }
        })
      )
      return { ...gqlState(s), ownerGroups: groupsWithUsers }
    })
  )

  const bindingsWithDims = await Promise.all(
    bindings.map(async (b: Record<string, unknown>) => {
      const dims = await db('nivaro_pipeline_owner_dimensions')
        .where({ binding: b.id })
        .orderBy('sort')
      return {
        id: b.id,
        collection: b.collection,
        stateField: b.state_field,
        dimensions: dims.map((d: Record<string, unknown>) => ({
          id: d.id,
          field: d.field,
          label: d.label,
          sort: (d.sort as number) ?? 0,
          isRowAxis: coerceBool(d.is_row_axis),
          required: coerceBool(d.required)
        }))
      }
    })
  )

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    color: template.color,
    icon: template.icon,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    states: statesWithGroups,
    bindings: bindingsWithDims
  }
}

// ─── Query fields ─────────────────────────────────────────────────────────────

export const domainQueryFields: GraphQLFieldConfigMap<unknown, GQLContext> = {
  me: {
    type: MeType,
    resolve: (_src, _args, ctx) => {
      const user = requireUser(ctx)
      return {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        isAdmin: ctx.isAdmin ?? false,
        status: user.status
      }
    }
  },

  users: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))),
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      status: { type: GraphQLString }
    },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      let q = db('nivaro_users').orderBy('email').limit(args.limit).offset(args.offset)
      if (args.status) q = q.where({ status: args.status })
      const rows = await q
      return rows.map((r: Record<string, unknown>) => gqlUser(r))
    }
  },

  user_by_id: {
    type: UserType,
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      const row = await db('nivaro_users').where({ id: args.id }).first()
      return row ? gqlUser(row as Record<string, unknown>) : null
    }
  },

  roles: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RoleType))),
    resolve: async (_src, _args, ctx) => {
      requireAdmin(ctx)
      const rows = await db('nivaro_roles').orderBy('name')
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        adminAccess: coerceBool(r.admin_access),
        appAccess: coerceBool(r.app_access)
      }))
    }
  },

  // ── Workflow ──────────────────────────────────────────────────────────────

  workflow_templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowTemplateType))),
    resolve: async (_src, _args, ctx) => {
      requireAdmin(ctx)
      const templates = await db('nivaro_workflow_templates').orderBy('name')
      return Promise.all(
        templates.map((t: Record<string, unknown>) => loadWorkflowTemplate(t.id as string))
      )
    }
  },

  workflow_template_by_id: {
    type: WorkflowTemplateType,
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      return loadWorkflowTemplate(args.id)
    }
  },

  workflow_instance: {
    type: WorkflowInstanceType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      if (!(await mayReadRecord(ctx, args.collection, args.item))) return null
      const instance = await findRecordInstance<WorkflowInstance>(args.collection, args.item)
      if (!instance) return null
      return buildInstancePayload(instance, ctx.user?.role, ctx.isAdmin ?? false)
    }
  },

  workflow_instances: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowInstanceType))),
    args: { collection: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const all = await db<WorkflowInstance>('nivaro_workflow_instances').where({
        collection: args.collection
      })
      const instances = await visibleInstances(ctx, user, args.collection, all)
      return Promise.all(
        instances.map((i) => buildInstancePayload(i, ctx.user?.role, ctx.isAdmin ?? false))
      )
    }
  },

  // ── Pipeline ──────────────────────────────────────────────────────────────

  pipeline_templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineTemplateType))),
    resolve: async (_src, _args, ctx) => {
      requireAdmin(ctx)
      const templates = await db('nivaro_workflow_templates').orderBy('name')
      return Promise.all(
        templates.map((t: Record<string, unknown>) => loadPipelineTemplate(t.id as string))
      )
    }
  },

  pipeline_template_by_id: {
    type: PipelineTemplateType,
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      return loadPipelineTemplate(args.id)
    }
  },

  pipeline_matrix: {
    type: PipelineMatrixType,
    args: { template_id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      const template = await loadPipelineTemplate(args.template_id)
      if (!template) return null
      const matrix: Record<string, unknown[]> = {}
      for (const state of template.states) matrix[state.id] = state.ownerGroups
      return { template, states: template.states, matrix }
    }
  },

  pipeline_instance: {
    type: PipelineInstanceType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      if (!(await mayReadRecord(ctx, args.collection, args.item))) return null
      const instance = await findRecordInstance<WorkflowInstance>(args.collection, args.item)
      if (!instance) return null

      const payload = await buildInstancePayload(instance, ctx.user?.role, ctx.isAdmin ?? false)
      const states = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: instance.template })
        .orderBy('sort')
      const statesWithGroups = await Promise.all(
        states.map(async (s) => {
          const groups = await db('nivaro_pipeline_owner_groups')
            .where({ state: s.id })
            .orderBy('sort')
          const groupsWithUsers = await Promise.all(
            groups.map(async (g: Record<string, unknown>) => {
              const users = await db('nivaro_pipeline_owner_group_users as ogu')
                .join('nivaro_users as u', 'ogu.user', 'u.id')
                .where('ogu.group', g.id as string | number)
                .select('u.id', 'u.email', 'u.first_name', 'u.last_name')
              return {
                id: g.id,
                name: g.name,
                filters: parseJson(g.filters as string),
                isDefault: coerceBool(g.is_default),
                sort: (g.sort as number) ?? 0,
                priority: (g.priority as number) ?? 0,
                users: users.map((u: Record<string, unknown>) => gqlUser(u))
              }
            })
          )
          return { ...gqlState(s), ownerGroups: groupsWithUsers }
        })
      )
      const currentPipelineState = statesWithGroups.find((s) => s.id === instance.current_state)
      return { ...payload, currentState: currentPipelineState ?? payload.currentState }
    }
  },

  pipeline_owners: {
    type: PipelineOwnersResultType,
    description: 'Resolved owners for the current pipeline state of a record',
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      if (!(await mayReadRecord(ctx, args.collection, args.item))) return { byState: [] }
      const instance = await findRecordInstance<WorkflowInstance>(args.collection, args.item)
      if (!instance?.current_state) return { byState: [] }

      const state = await db<WorkflowState>('nivaro_workflow_states')
        .where({ id: instance.current_state })
        .first()
      if (!state) return { byState: [] }

      const owners = await resolveStateOwners(
        instance.current_state,
        instance.id,
        args.collection,
        args.item
      )
      return {
        byState: [
          {
            state: gqlState(state),
            owners: owners.map((o) => gqlUser(o as unknown as Record<string, unknown>))
          }
        ]
      }
    }
  },

  pipeline_owners_all: {
    type: PipelineOwnersResultType,
    description: 'Resolved owners for all pipeline states of a record',
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      if (!(await mayReadRecord(ctx, args.collection, args.item))) return { byState: [] }
      const binding = await db('nivaro_workflow_bindings')
        .where({ collection: args.collection })
        .first()
      if (!binding) return { byState: [] }

      const instance = await findRecordInstance<WorkflowInstance>(args.collection, args.item)

      const states = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: binding.template })
        .orderBy('sort')

      const byState = await Promise.all(
        states.map(async (s) => {
          const owners = await resolveStateOwners(
            s.id,
            instance?.id ?? null,
            args.collection,
            args.item
          )
          return {
            state: gqlState(s),
            owners: owners.map((o) => gqlUser(o as unknown as Record<string, unknown>))
          }
        })
      )
      return { byState }
    }
  },

  pipeline_owners_for_state: {
    type: StateOwnersType,
    description: 'Resolved owners for a specific pipeline state of a record',
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) },
      state_id: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      if (!(await mayReadRecord(ctx, args.collection, args.item))) return null
      const state = await db<WorkflowState>('nivaro_workflow_states')
        .where({ id: args.state_id })
        .first()
      if (!state) return null

      const instance = await findRecordInstance<WorkflowInstance>(args.collection, args.item)

      const owners = await resolveStateOwners(
        args.state_id,
        instance?.id ?? null,
        args.collection,
        args.item
      )
      return {
        state: gqlState(state),
        owners: owners.map((o) => gqlUser(o as unknown as Record<string, unknown>))
      }
    }
  },

  // ── Activity ──────────────────────────────────────────────────────────────

  activity: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ActivityEntryType))),
    args: {
      collection: { type: GraphQLString },
      item: { type: GraphQLString },
      user_id: { type: GraphQLID },
      action: { type: GraphQLString },
      limit: { type: GraphQLInt, defaultValue: 50 },
      offset: { type: GraphQLInt, defaultValue: 0 }
    },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      let q = db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .orderBy('a.timestamp', 'desc')
        .limit(args.limit)
        .offset(args.offset)
        .select(
          'a.id',
          'a.action',
          'a.collection',
          'a.item',
          'a.user_agent',
          'a.ip',
          'a.comment',
          'a.timestamp',
          'u.id as user_id',
          'u.email as user_email',
          'u.first_name as user_first_name',
          'u.last_name as user_last_name'
        )
      if (args.collection) q = q.where('a.collection', args.collection)
      if (args.item) q = q.where('a.item', args.item)
      if (args.user_id) q = q.where('a.user', args.user_id)
      if (args.action) q = q.where('a.action', args.action)

      const rows = await q
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        action: r.action,
        collection: r.collection,
        item: r.item,
        userAgent: r.user_agent,
        ip: r.ip,
        comment: r.comment,
        timestamp: r.timestamp,
        user: r.user_id
          ? {
              id: r.user_id,
              email: r.user_email,
              firstName: r.user_first_name,
              lastName: r.user_last_name
            }
          : null
      }))
    }
  },

  activity_by_id: {
    type: ActivityEntryType,
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireAdmin(ctx)
      const r = await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where('a.id', args.id)
        .select(
          'a.id',
          'a.action',
          'a.collection',
          'a.item',
          'a.user_agent',
          'a.ip',
          'a.comment',
          'a.timestamp',
          'u.id as user_id',
          'u.email as user_email',
          'u.first_name as user_first_name',
          'u.last_name as user_last_name'
        )
        .first()
      if (!r) return null
      return {
        id: r.id,
        action: r.action,
        collection: r.collection,
        item: r.item,
        userAgent: r.user_agent,
        ip: r.ip,
        comment: r.comment,
        timestamp: r.timestamp,
        user: r.user_id
          ? {
              id: r.user_id,
              email: r.user_email,
              firstName: r.user_first_name,
              lastName: r.user_last_name
            }
          : null
      }
    }
  },

  // ── Files ─────────────────────────────────────────────────────────────────

  files: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CmsFileType))),
    args: {
      limit: { type: GraphQLInt, defaultValue: 50 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      folder: { type: GraphQLID }
    },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      let q = db('nivaro_files as f')
        .leftJoin('nivaro_users as u', 'f.uploaded_by', 'u.id')
        .orderBy('f.uploaded_on', 'desc')
        .limit(args.limit)
        .offset(args.offset)
        .select(
          'f.id',
          'f.filename_download',
          'f.title',
          'f.type',
          'f.filesize',
          'f.folder',
          'f.uploaded_on',
          'f.uploaded_by',
          'u.id as uploader_id',
          'u.email as uploader_email',
          'u.first_name as uploader_first_name',
          'u.last_name as uploader_last_name'
        )
      if (args.folder) q = q.where('f.folder', args.folder)
      const page = (await q) as Array<Record<string, unknown> & { id: unknown }>
      // The /api/files rule (services/file-access.ts): a file reads only where it is used —
      // never a DM attachment, a help-video file or another person's unattached upload.
      const readable = await readableFileIds(page, {
        user,
        isAdmin: ctx.isAdmin ?? false,
        workspaceId: null
      })
      const rows = page.filter((r) => readable.has(String(r.id).toLowerCase()))
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        filenameDownload: r.filename_download,
        title: r.title,
        type: r.type,
        filesize: r.filesize,
        folder: r.folder,
        uploadedOn: r.uploaded_on,
        uploadedBy: r.uploader_id
          ? {
              id: r.uploader_id,
              email: r.uploader_email,
              firstName: r.uploader_first_name,
              lastName: r.uploader_last_name
            }
          : null
      }))
    }
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  settings: {
    type: SettingsType,
    resolve: async (_src, _args, ctx) => {
      requireUser(ctx)
      const s = await db('nivaro_settings').where({ id: 1 }).first()
      if (!s) return null
      return {
        id: s.id,
        projectName: s.project_name,
        projectColor: s.project_color,
        projectLogo: s.project_logo,
        publicForeground: s.public_foreground,
        publicBackground: s.public_background,
        defaultLanguage: s.default_language,
        darkMode: coerceBool(s.dark_mode)
      }
    }
  }
}

// ─── Mutation fields ──────────────────────────────────────────────────────────

export const domainMutationFields: GraphQLFieldConfigMap<unknown, GQLContext> = {
  start_workflow: {
    type: WorkflowInstanceType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const { collection, item } = args
      // Start/advance gate: update permission + the caller can see the record.
      await assertInstanceAccess(user, ctx.isAdmin ?? false, collection, String(item))

      const binding = await db('nivaro_workflow_bindings').where({ collection }).first()
      if (!binding) throw new Error('No workflow bound to this collection')

      const existing = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (existing) throw new Error('Workflow already started for this item')

      const initialState = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: binding.template, is_initial: true })
        .first()

      const instanceId = randomUUID()
      const startedAt = new Date()
      await db('nivaro_workflow_instances').insert({
        id: instanceId,
        template: binding.template,
        collection,
        item,
        current_state: initialState?.id ?? null,
        started_at: startedAt,
        completed_at: null
      })
      // #1219: the start is the instance's first history row.
      if (initialState)
        await writeStartHistory({
          instanceId,
          stateId: String(initialState.id),
          userId: user.id,
          timestamp: startedAt
        })

      let finalState = initialState
      if (initialState) {
        const resolved = await resolveTransitionTarget(
          initialState.id,
          binding.template,
          collection,
          item,
          instanceId
        )
        const finalId = resolved?.id ?? initialState.id
        if (finalId !== initialState.id) {
          finalState = resolved ?? initialState
          await db('nivaro_workflow_instances')
            .where({ id: instanceId })
            .update({
              current_state: finalId,
              completed_at: resolved && coerceBool(resolved.is_terminal) ? new Date() : null
            })
          await db('nivaro_workflow_history').insert({
            ...(await chainFields('nivaro_workflow_history')),
            instance: instanceId,
            transition: null,
            from_state: initialState.id,
            to_state: finalId,
            user: user.id,
            comment: 'Auto-advanced via skip criteria',
            timestamp: new Date(),
            ...(await originFields('nivaro_workflow_history', 'machine'))
          })
          noteViewAsHistory({
            instance: instanceId,
            from_state: initialState.id,
            to_state: finalId
          })
        }
      }

      if (finalState && binding.state_field) {
        try {
          await db(collection)
            .where({ id: item })
            .update({ [binding.state_field]: finalState.key })
        } catch {
          /* non-fatal */
        }
      }

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: instanceId })
        .first()
      const payload = await buildInstancePayload(instance!, user.role, ctx.isAdmin ?? false)
      // Ids only: each subscriber's resolver reads the instance as THAT subscriber.
      pubsub.publish(topics.workflowStateChanged(collection, item), {
        workflowStateChanged: { collection, item, instance_id: instance!.id }
      })
      // S4 (realtime gaps 2026-11-17): open records, list rows and queues hear the move too.
      void announceStateMoved(collection, String(item))
      return payload
    }
  },

  execute_workflow_transition: {
    type: WorkflowTransitionResultType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) },
      transition_id: { type: new GraphQLNonNull(GraphQLID) },
      comment: { type: GraphQLString }
    },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const { collection, item } = args
      const instance = await runGraphqlMove(ctx, args)
      const newStateObj = instance.current_state
        ? await db<WorkflowState>('nivaro_workflow_states')
            .where({ id: instance.current_state })
            .first()
        : undefined
      const payload = await buildInstancePayload(instance, user.role, ctx.isAdmin ?? false)
      // Ids only: each subscriber's resolver reads the instance as THAT subscriber.
      // (applyTransition already announced the move to open records, lists and queues.)
      pubsub.publish(topics.workflowStateChanged(collection, item), {
        workflowStateChanged: { collection, item, instance_id: instance.id }
      })
      return { instance: payload, newState: newStateObj ? gqlState(newStateObj) : null }
    }
  },

  start_pipeline: {
    type: PipelineInstanceType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const { collection, item } = args
      // Start/advance gate: update permission + the caller can see the record.
      await assertInstanceAccess(user, ctx.isAdmin ?? false, collection, String(item))

      const binding = await db('nivaro_workflow_bindings').where({ collection }).first()
      if (!binding) throw new Error('No pipeline bound to this collection')

      const existing = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (existing) throw new Error('Pipeline already started for this item')

      const initialState = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: binding.template, is_initial: true })
        .first()

      const instanceId = randomUUID()
      const startedAt = new Date()
      await db('nivaro_workflow_instances').insert({
        id: instanceId,
        template: binding.template,
        collection,
        item,
        current_state: initialState?.id ?? null,
        started_at: startedAt,
        completed_at: null
      })
      // #1219: the start is the instance's first history row.
      if (initialState)
        await writeStartHistory({
          instanceId,
          stateId: String(initialState.id),
          userId: user.id,
          timestamp: startedAt
        })

      let finalState = initialState
      if (initialState) {
        const resolved = await resolveTransitionTarget(
          initialState.id,
          binding.template,
          collection,
          item,
          instanceId
        )
        const finalId = resolved?.id ?? initialState.id
        if (finalId !== initialState.id) {
          finalState = resolved ?? initialState
          await db('nivaro_workflow_instances')
            .where({ id: instanceId })
            .update({
              current_state: finalId,
              completed_at: resolved && coerceBool(resolved.is_terminal) ? new Date() : null
            })
          await db('nivaro_workflow_history').insert({
            ...(await chainFields('nivaro_workflow_history')),
            instance: instanceId,
            transition: null,
            from_state: initialState.id,
            to_state: finalId,
            user: user.id,
            comment: 'Auto-advanced via skip criteria',
            timestamp: new Date(),
            ...(await originFields('nivaro_workflow_history', 'machine'))
          })
          noteViewAsHistory({
            instance: instanceId,
            from_state: initialState.id,
            to_state: finalId
          })
        }
      }

      if (finalState && binding.state_field) {
        try {
          await db(collection)
            .where({ id: item })
            .update({ [binding.state_field]: finalState.key })
        } catch {
          /* non-fatal */
        }
      }

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: instanceId })
        .first()
      const payload = await buildInstancePayload(instance!, user.role, ctx.isAdmin ?? false)
      // Ids only: each subscriber's resolver reads the instance as THAT subscriber.
      pubsub.publish(topics.pipelineStateChanged(collection, item), {
        pipelineStateChanged: { collection, item, instance_id: instance!.id }
      })
      // S4 (realtime gaps 2026-11-17): open records, list rows and queues hear the move too.
      void announceStateMoved(collection, String(item))
      return payload
    }
  },

  execute_pipeline_transition: {
    type: PipelineInstanceType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) },
      transition_id: { type: new GraphQLNonNull(GraphQLID) },
      comment: { type: GraphQLString }
    },
    resolve: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const { collection, item } = args
      const instance = await runGraphqlMove(ctx, args)
      const payload = await buildInstancePayload(instance, user.role, ctx.isAdmin ?? false)
      // Ids only: each subscriber's resolver reads the instance as THAT subscriber.
      // (applyTransition already announced the move to open records, lists and queues.)
      pubsub.publish(topics.pipelineStateChanged(collection, item), {
        pipelineStateChanged: { collection, item, instance_id: instance.id }
      })
      return payload
    }
  }
}

// ─── Subscription fields ──────────────────────────────────────────────────────

/**
 * The `fields` / `actions` narrowing of an itemMutated subscription, or null when it hears
 * every event. An event passes when its action is asked for and, for updates, when it touched
 * one of the named fields. Shared with the SSE transport's Last-Event-ID replay (#1749).
 */
export function itemMutatedFilter(args: {
  fields?: unknown
  actions?: unknown
}): ((ev: { action: string; changed_fields: string[] }) => boolean) | null {
  const fields = Array.isArray(args.fields) ? new Set((args.fields as unknown[]).map(String)) : null
  const actions = Array.isArray(args.actions)
    ? new Set((args.actions as unknown[]).map(String))
    : null
  if ((!fields || fields.size === 0) && (!actions || actions.size === 0)) return null
  return (ev) => {
    if (actions && actions.size > 0 && !actions.has(ev.action)) return false
    if (fields && fields.size > 0) {
      if (ev.action !== 'update') return false
      return ev.changed_fields.some((f) => fields.has(f))
    }
    return true
  }
}

export const domainSubscriptionFields: GraphQLFieldConfigMap<unknown, GQLContext> = {
  workflowStateChanged: {
    type: WorkflowStateChangedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    subscribe: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      // A record's state belongs to people who may read that record.
      if (
        !(await maySeeRecordForSubscription(ctx, user, String(args.collection), String(args.item)))
      )
        throw new GraphQLError('You do not have permission to read this record', {
          extensions: { code: 'FORBIDDEN' }
        })
      return instanceEventsAsSubscriber(
        pubsub.asyncIterator(
          topics.workflowStateChanged(args.collection, args.item, subscriptionTenant(ctx))
        ),
        'workflowStateChanged',
        ctx,
        user
      )
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).workflowStateChanged
  },

  pipelineStateChanged: {
    type: PipelineStateChangedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    subscribe: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      // A record's state belongs to people who may read that record.
      if (
        !(await maySeeRecordForSubscription(ctx, user, String(args.collection), String(args.item)))
      )
        throw new GraphQLError('You do not have permission to read this record', {
          extensions: { code: 'FORBIDDEN' }
        })
      return instanceEventsAsSubscriber(
        pubsub.asyncIterator(
          topics.pipelineStateChanged(args.collection, args.item, subscriptionTenant(ctx))
        ),
        'pipelineStateChanged',
        ctx,
        user
      )
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).pipelineStateChanged
  },

  itemMutated: {
    type: ItemMutatedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: GraphQLID },
      /** Only updates that changed one of these fields. */
      fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      /** Only these actions: create, update, delete. */
      actions: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) }
    },
    subscribe: async (_src, args, ctx) => {
      const user = requireUser(ctx)
      const collection = String(args.collection)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
        throw new GraphQLError('Unknown collection', { extensions: { code: 'BAD_USER_INPUT' } })
      }
      // The same gate as reading the collection. System tables stay with admins.
      const allowed = await mayReadForSubscription(ctx, user, collection)
      if (!allowed) {
        throw new GraphQLError('You do not have permission to read this collection', {
          extensions: { code: 'FORBIDDEN' }
        })
      }
      // L-8: when watching ONE record, gate on that record too (row filter / User Scope),
      // matching workflowStateChanged / pipelineStateChanged. Collection-read alone would leak a
      // hidden record's change actions, changed-field names and timestamps to a subscriber who
      // cannot see the record at row level.
      if (
        args.item != null &&
        !(await maySeeRecordForSubscription(ctx, user, collection, String(args.item)))
      ) {
        throw new GraphQLError('You do not have permission to read this record', {
          extensions: { code: 'FORBIDDEN' }
        })
      }
      const tenant = subscriptionTenant(ctx)
      const topic = args.item
        ? topics.itemMutated(collection, String(args.item), tenant)
        : topics.itemMutated(collection, '*', tenant)
      const source = pubsub.asyncIterator<{
        itemMutated: { action: string; changed_fields: string[] }
      }>(topic)
      const passes = itemMutatedFilter(args)
      if (!passes) return source
      const filtered: AsyncIterableIterator<unknown> = {
        async next() {
          for (;;) {
            const r = await source.next()
            if (r.done) return r
            if (passes(r.value.itemMutated)) return r
          }
        },
        return: () => source.return!(),
        throw: (e: unknown) => source.throw!(e),
        [Symbol.asyncIterator]() {
          return this
        }
      }
      return filtered
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).itemMutated
  }
}

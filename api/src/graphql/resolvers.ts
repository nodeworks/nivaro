import { randomUUID } from 'node:crypto'
import {
  type GraphQLFieldConfigMap,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString
} from 'graphql'
import { db } from '../db/index.js'
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
}

// ─── Guards ───────────────────────────────────────────────────────────────────

function requireUser(ctx: GQLContext): User {
  if (!ctx.user) throw new Error('Unauthorized')
  return ctx.user
}

function requireAdmin(ctx: GQLContext): User {
  const user = requireUser(ctx)
  if (!ctx.isAdmin) throw new Error('Admin access required')
  return user
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
      requireUser(ctx)
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
      requireUser(ctx)
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
      requireUser(ctx)
      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection: args.collection, item: args.item })
        .first()
      if (!instance) return null
      return buildInstancePayload(instance, ctx.user?.role, ctx.isAdmin ?? false)
    }
  },

  workflow_instances: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowInstanceType))),
    args: { collection: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, ctx) => {
      requireUser(ctx)
      const instances = await db<WorkflowInstance>('nivaro_workflow_instances').where({
        collection: args.collection
      })
      return Promise.all(
        instances.map((i) => buildInstancePayload(i, ctx.user?.role, ctx.isAdmin ?? false))
      )
    }
  },

  // ── Pipeline ──────────────────────────────────────────────────────────────

  pipeline_templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineTemplateType))),
    resolve: async (_src, _args, ctx) => {
      requireUser(ctx)
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
      requireUser(ctx)
      return loadPipelineTemplate(args.id)
    }
  },

  pipeline_matrix: {
    type: PipelineMatrixType,
    args: { template_id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, ctx) => {
      requireUser(ctx)
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
      requireUser(ctx)
      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection: args.collection, item: args.item })
        .first()
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
      requireUser(ctx)
      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection: args.collection, item: args.item })
        .first()
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
      requireUser(ctx)
      const binding = await db('nivaro_workflow_bindings')
        .where({ collection: args.collection })
        .first()
      if (!binding) return { byState: [] }

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection: args.collection, item: args.item })
        .first()

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
      requireUser(ctx)
      const state = await db<WorkflowState>('nivaro_workflow_states')
        .where({ id: args.state_id })
        .first()
      if (!state) return null

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection: args.collection, item: args.item })
        .first()

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
      requireUser(ctx)
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
      requireUser(ctx)
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
      requireUser(ctx)
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
          'u.id as uploader_id',
          'u.email as uploader_email',
          'u.first_name as uploader_first_name',
          'u.last_name as uploader_last_name'
        )
      if (args.folder) q = q.where('f.folder', args.folder)
      const rows = await q
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
      await db('nivaro_workflow_instances').insert({
        id: instanceId,
        template: binding.template,
        collection,
        item,
        current_state: initialState?.id ?? null,
        started_at: new Date(),
        completed_at: null
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
            instance: instanceId,
            transition: null,
            from_state: initialState.id,
            to_state: finalId,
            user: user.id,
            comment: 'Auto-advanced via skip criteria',
            timestamp: new Date()
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
      pubsub.publish(topics.workflowStateChanged(collection, item), {
        workflowStateChanged: { collection, item, instance: payload }
      })
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

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (!instance) throw new Error('No workflow instance for this item')
      if (instance.completed_at) throw new Error('Workflow is already completed')

      const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
        .where({ id: args.transition_id, template: instance.template })
        .first()
      if (!transition) throw new Error('Transition not found')

      const fromOk =
        transition.from_state === null || transition.from_state === instance.current_state
      if (!fromOk) throw new Error('Transition is not valid from the current state')

      if (!ctx.isAdmin && transition.required_roles) {
        const roles = parseJson(transition.required_roles) as string[] | null
        if (roles?.length && (!user.role || !roles.includes(user.role))) {
          throw new Error('You do not have permission for this transition')
        }
      }

      const previousState = instance.current_state
      const resolvedTarget = await resolveTransitionTarget(
        transition.to_state,
        instance.template,
        collection,
        item,
        instance.id
      )
      const newStateId = resolvedTarget?.id ?? transition.to_state
      const newStateObj =
        resolvedTarget ??
        (await db<WorkflowState>('nivaro_workflow_states').where({ id: newStateId }).first())

      await db('nivaro_workflow_instances')
        .where({ id: instance.id })
        .update({
          current_state: newStateId,
          completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
        })
      await db('nivaro_workflow_history').insert({
        instance: instance.id,
        transition: transition.id,
        from_state: previousState,
        to_state: newStateId,
        user: user.id,
        comment: args.comment ?? null,
        timestamp: new Date()
      })

      const binding = await db('nivaro_workflow_bindings').where({ collection }).first()
      if (binding?.state_field && newStateObj) {
        try {
          await db(collection)
            .where({ id: item })
            .update({ [binding.state_field]: newStateObj.key })
        } catch {
          /* non-fatal */
        }
      }

      const updatedInstance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: instance.id })
        .first()
      const payload = await buildInstancePayload(updatedInstance!, user.role, ctx.isAdmin ?? false)
      pubsub.publish(topics.workflowStateChanged(collection, item), {
        workflowStateChanged: { collection, item, instance: payload }
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
      await db('nivaro_workflow_instances').insert({
        id: instanceId,
        template: binding.template,
        collection,
        item,
        current_state: initialState?.id ?? null,
        started_at: new Date(),
        completed_at: null
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
            instance: instanceId,
            transition: null,
            from_state: initialState.id,
            to_state: finalId,
            user: user.id,
            comment: 'Auto-advanced via skip criteria',
            timestamp: new Date()
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
      pubsub.publish(topics.pipelineStateChanged(collection, item), {
        pipelineStateChanged: { collection, item, instance: payload }
      })
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

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (!instance) throw new Error('No pipeline instance for this item')
      if (instance.completed_at) throw new Error('Pipeline is already completed')

      const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
        .where({ id: args.transition_id, template: instance.template })
        .first()
      if (!transition) throw new Error('Transition not found')

      const fromOk =
        transition.from_state === null || transition.from_state === instance.current_state
      if (!fromOk) throw new Error('Transition is not valid from the current state')

      if (!ctx.isAdmin && transition.required_roles) {
        const roles = parseJson(transition.required_roles) as string[] | null
        if (roles?.length && (!user.role || !roles.includes(user.role))) {
          throw new Error('You do not have permission for this transition')
        }
      }

      const previousState = instance.current_state
      const resolvedTarget = await resolveTransitionTarget(
        transition.to_state,
        instance.template,
        collection,
        item,
        instance.id
      )
      const newStateId = resolvedTarget?.id ?? transition.to_state
      const newStateObj =
        resolvedTarget ??
        (await db<WorkflowState>('nivaro_workflow_states').where({ id: newStateId }).first())

      await db('nivaro_workflow_instances')
        .where({ id: instance.id })
        .update({
          current_state: newStateId,
          completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
        })
      await db('nivaro_workflow_history').insert({
        instance: instance.id,
        transition: transition.id,
        from_state: previousState,
        to_state: newStateId,
        user: user.id,
        comment: args.comment ?? null,
        timestamp: new Date()
      })

      const binding = await db('nivaro_workflow_bindings').where({ collection }).first()
      if (binding?.state_field && newStateObj) {
        try {
          await db(collection)
            .where({ id: item })
            .update({ [binding.state_field]: newStateObj.key })
        } catch {
          /* non-fatal */
        }
      }

      const updatedInstance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: instance.id })
        .first()
      const payload = await buildInstancePayload(updatedInstance!, user.role, ctx.isAdmin ?? false)
      pubsub.publish(topics.pipelineStateChanged(collection, item), {
        pipelineStateChanged: { collection, item, instance: payload }
      })
      return payload
    }
  }
}

// ─── Subscription fields ──────────────────────────────────────────────────────

export const domainSubscriptionFields: GraphQLFieldConfigMap<unknown, GQLContext> = {
  workflowStateChanged: {
    type: WorkflowStateChangedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    subscribe: (_src, args, ctx) => {
      requireUser(ctx)
      return pubsub.asyncIterator(topics.workflowStateChanged(args.collection, args.item))
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).workflowStateChanged
  },

  pipelineStateChanged: {
    type: PipelineStateChangedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: new GraphQLNonNull(GraphQLID) }
    },
    subscribe: (_src, args, ctx) => {
      requireUser(ctx)
      return pubsub.asyncIterator(topics.pipelineStateChanged(args.collection, args.item))
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).pipelineStateChanged
  },

  itemMutated: {
    type: ItemMutatedEventType,
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      item: { type: GraphQLID }
    },
    subscribe: (_src, args, ctx) => {
      requireUser(ctx)
      const topic = args.item
        ? topics.itemMutated(args.collection, args.item)
        : topics.itemMutated(args.collection, '*')
      return pubsub.asyncIterator(topic)
    },
    resolve: (payload: unknown) => (payload as Record<string, unknown>).itemMutated
  }
}

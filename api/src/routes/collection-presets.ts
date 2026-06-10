import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

interface PresetField {
  field: string
  type: string
  interface: string
  required?: boolean
  options?: string[]
}

interface PresetCollection {
  name: string
  display_name: string
  fields: PresetField[]
}

interface PresetRelation {
  many_collection: string
  many_field: string
  one_collection: string
  one_field?: string
}

interface PresetAlert {
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit?: string
}

interface Preset {
  name: string
  description: string
  collections: PresetCollection[]
  relations?: PresetRelation[]
  alerts?: PresetAlert[]
}

const PRESETS: Record<string, Preset> = {
  blog: {
    name: 'Blog',
    description: 'Articles, authors, categories',
    collections: [
      {
        name: 'articles',
        display_name: 'Articles',
        fields: [
          { field: 'title', type: 'string', interface: 'input', required: true },
          { field: 'slug', type: 'string', interface: 'input', required: true },
          { field: 'content', type: 'text', interface: 'textarea' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['draft', 'review', 'published']
          },
          { field: 'published_at', type: 'datetime', interface: 'datetime' }
        ]
      },
      {
        name: 'authors',
        display_name: 'Authors',
        fields: [
          { field: 'name', type: 'string', interface: 'input', required: true },
          { field: 'email', type: 'string', interface: 'input' },
          { field: 'bio', type: 'text', interface: 'textarea' }
        ]
      },
      {
        name: 'categories',
        display_name: 'Categories',
        fields: [
          { field: 'name', type: 'string', interface: 'input', required: true },
          { field: 'slug', type: 'string', interface: 'input' }
        ]
      }
    ]
  },
  crm: {
    name: 'CRM',
    description: 'Contacts, companies, deals',
    collections: [
      {
        name: 'contacts',
        display_name: 'Contacts',
        fields: [
          { field: 'first_name', type: 'string', interface: 'input', required: true },
          { field: 'last_name', type: 'string', interface: 'input', required: true },
          { field: 'email', type: 'string', interface: 'input' },
          { field: 'phone', type: 'string', interface: 'input' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['lead', 'prospect', 'customer', 'churned']
          }
        ]
      },
      {
        name: 'companies',
        display_name: 'Companies',
        fields: [
          { field: 'name', type: 'string', interface: 'input', required: true },
          { field: 'website', type: 'string', interface: 'input' },
          { field: 'industry', type: 'string', interface: 'input' },
          {
            field: 'size',
            type: 'string',
            interface: 'select',
            options: ['1-10', '11-50', '51-200', '201-1000', '1000+']
          }
        ]
      },
      {
        name: 'deals',
        display_name: 'Deals',
        fields: [
          { field: 'title', type: 'string', interface: 'input', required: true },
          { field: 'value', type: 'float', interface: 'input' },
          {
            field: 'stage',
            type: 'string',
            interface: 'select',
            options: [
              'prospecting',
              'qualification',
              'proposal',
              'negotiation',
              'closed_won',
              'closed_lost'
            ]
          },
          { field: 'close_date', type: 'datetime', interface: 'datetime' }
        ]
      }
    ]
  },
  project_tracker: {
    name: 'Project Tracker',
    description: 'Projects, tasks, milestones',
    collections: [
      {
        name: 'projects',
        display_name: 'Projects',
        fields: [
          { field: 'name', type: 'string', interface: 'input', required: true },
          { field: 'description', type: 'text', interface: 'textarea' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['planning', 'active', 'on_hold', 'completed', 'cancelled']
          },
          { field: 'start_date', type: 'datetime', interface: 'datetime' },
          { field: 'end_date', type: 'datetime', interface: 'datetime' },
          { field: 'budget', type: 'float', interface: 'input' }
        ]
      },
      {
        name: 'tasks',
        display_name: 'Tasks',
        fields: [
          { field: 'title', type: 'string', interface: 'input', required: true },
          { field: 'description', type: 'text', interface: 'textarea' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['todo', 'in_progress', 'review', 'done']
          },
          {
            field: 'priority',
            type: 'string',
            interface: 'select',
            options: ['low', 'medium', 'high', 'critical']
          },
          { field: 'due_date', type: 'datetime', interface: 'datetime' },
          { field: 'percent_complete', type: 'integer', interface: 'input' }
        ]
      }
    ]
  },
  event_manager: {
    name: 'Event Manager',
    description: 'Events, venues, attendees',
    collections: [
      {
        name: 'events',
        display_name: 'Events',
        fields: [
          { field: 'title', type: 'string', interface: 'input', required: true },
          { field: 'description', type: 'text', interface: 'textarea' },
          { field: 'start_at', type: 'datetime', interface: 'datetime', required: true },
          { field: 'end_at', type: 'datetime', interface: 'datetime' },
          { field: 'location', type: 'string', interface: 'input' },
          { field: 'max_attendees', type: 'integer', interface: 'input' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['draft', 'published', 'cancelled']
          }
        ]
      },
      {
        name: 'attendees',
        display_name: 'Attendees',
        fields: [
          { field: 'first_name', type: 'string', interface: 'input', required: true },
          { field: 'last_name', type: 'string', interface: 'input', required: true },
          { field: 'email', type: 'string', interface: 'input', required: true },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['registered', 'confirmed', 'attended', 'cancelled']
          }
        ]
      }
    ]
  },
  ecommerce: {
    name: 'E-Commerce',
    description: 'Products, orders, inventory movements + low-stock alert',
    collections: [
      {
        name: 'products',
        display_name: 'Products',
        fields: [
          { field: 'name', type: 'string', interface: 'input', required: true },
          { field: 'slug', type: 'string', interface: 'input', required: true },
          { field: 'description', type: 'text', interface: 'textarea' },
          { field: 'price', type: 'decimal', interface: 'input', required: true },
          { field: 'compare_at_price', type: 'decimal', interface: 'input' },
          { field: 'sku', type: 'string', interface: 'input' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['draft', 'active', 'archived']
          },
          { field: 'stock_quantity', type: 'integer', interface: 'input' },
          { field: 'low_stock_threshold', type: 'integer', interface: 'input' },
          { field: 'image', type: 'uuid', interface: 'input' },
          { field: 'category', type: 'string', interface: 'input' },
          { field: 'is_featured', type: 'boolean', interface: 'toggle' }
        ]
      },
      {
        name: 'orders',
        display_name: 'Orders',
        fields: [
          { field: 'order_number', type: 'string', interface: 'input', required: true },
          { field: 'customer_email', type: 'string', interface: 'input', required: true },
          { field: 'customer_name', type: 'string', interface: 'input' },
          {
            field: 'status',
            type: 'string',
            interface: 'select',
            options: ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']
          },
          { field: 'subtotal', type: 'decimal', interface: 'input' },
          { field: 'tax', type: 'decimal', interface: 'input' },
          { field: 'shipping', type: 'decimal', interface: 'input' },
          { field: 'total', type: 'decimal', interface: 'input' },
          { field: 'shipping_address', type: 'text', interface: 'textarea' },
          { field: 'notes', type: 'text', interface: 'textarea' },
          { field: 'placed_at', type: 'datetime', interface: 'datetime' }
        ]
      },
      {
        name: 'inventory_movements',
        display_name: 'Inventory Movements',
        fields: [
          { field: 'product', type: 'integer', interface: 'input', required: true },
          {
            field: 'type',
            type: 'string',
            interface: 'select',
            options: ['received', 'sold', 'adjusted', 'returned']
          },
          { field: 'quantity', type: 'integer', interface: 'input', required: true },
          { field: 'reference', type: 'string', interface: 'input' },
          { field: 'note', type: 'text', interface: 'textarea' },
          { field: 'moved_at', type: 'datetime', interface: 'datetime' }
        ]
      }
    ],
    relations: [
      {
        many_collection: 'inventory_movements',
        many_field: 'product',
        one_collection: 'products',
        one_field: 'id'
      }
    ],
    alerts: [
      {
        name: 'Low stock',
        category: 'inventory',
        collection: 'products',
        field: 'stock_quantity',
        operator: 'lt',
        threshold: 5,
        unit: 'count'
      }
    ]
  }
}

export async function collectionPresetsRoutes(app: FastifyInstance) {
  // GET /collection-presets — list all presets
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const list = Object.entries(PRESETS).map(([id, preset]) => ({
      id,
      name: preset.name,
      description: preset.description,
      collections: preset.collections.map((c) => c.name),
      fields_count: preset.collections.reduce((n, c) => n + c.fields.length, 0)
    }))
    return reply.send({ data: list })
  })

  // POST /collection-presets/:id/install — install a preset (metadata only)
  app.post('/:id/install', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const preset = PRESETS[id]
    if (!preset) return reply.code(404).send({ error: 'Preset not found' })

    const installed: string[] = []
    const now = new Date()

    for (const col of preset.collections) {
      // Check if already exists
      const existing = await db('nivaro_collections').where({ collection: col.name }).first()

      if (!existing) {
        await db('nivaro_collections').insert({
          collection: col.name,
          display_name: col.display_name,
          accountability: 'all',
          hidden: 0,
          singleton: 0,
          versioning: 0,
          workspace: req.user?.current_workspace ?? null,
          created_at: now,
          updated_at: now
        })
      }

      // Insert fields that don't already exist
      let sortIndex = 1
      for (const fieldDef of col.fields) {
        const existingField = await db('nivaro_fields')
          .where({ collection: col.name, field: fieldDef.field })
          .first()

        if (!existingField) {
          await db('nivaro_fields').insert({
            collection: col.name,
            field: fieldDef.field,
            type: fieldDef.type,
            interface: fieldDef.interface,
            required: fieldDef.required ? 1 : 0,
            options:
              fieldDef.options && fieldDef.options.length > 0
                ? JSON.stringify({ choices: fieldDef.options })
                : null,
            hidden: 0,
            readonly: 0,
            computed_store: 0,
            sort: sortIndex,
            created_at: now,
            updated_at: now
          })
        }
        sortIndex++
      }

      installed.push(col.name)
    }

    // Insert M2O relation rows (skip if an identical relation already exists)
    for (const rel of preset.relations ?? []) {
      const existingRel = await db('nivaro_relations')
        .where({ many_collection: rel.many_collection, many_field: rel.many_field })
        .first()

      if (!existingRel) {
        await db('nivaro_relations').insert({
          many_collection: rel.many_collection,
          many_field: rel.many_field,
          one_collection: rel.one_collection,
          one_field: rel.one_field ?? 'id',
          one_collection_field: null,
          one_allowed_collections: null,
          junction_field: null,
          sort_field: null,
          one_deselect_action: 'nullify'
        })
      }
    }

    // Insert alert definitions (best-effort — preset still installs if the
    // alert table shape differs or the alerts feature is unavailable)
    for (const alert of preset.alerts ?? []) {
      try {
        const existingAlert = await db('nivaro_alert_definitions')
          .where({ name: alert.name, collection: alert.collection, field: alert.field })
          .first()

        if (!existingAlert) {
          await db('nivaro_alert_definitions').insert({
            name: alert.name,
            category: alert.category,
            collection: alert.collection,
            field: alert.field,
            operator: alert.operator,
            threshold: alert.threshold,
            unit: alert.unit ?? 'count',
            filters: null,
            cooldown_minutes: 60,
            is_active: 1,
            created_by: req.user?.id ?? null,
            created_at: now,
            updated_at: now
          })
        }
      } catch (err) {
        req.log.warn({ err, alert: alert.name }, 'Preset alert definition insert failed')
      }
    }

    await logActivity({
      action: 'install-preset',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: id,
      comment: installed.join(', '),
      req
    })

    return reply.send({ installed })
  })
}

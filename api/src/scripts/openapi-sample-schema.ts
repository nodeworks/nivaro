/**
 * Generic sample content model for the PUBLIC docs site's OpenAPI reference.
 *
 * www/openapi.json ships with the community docs, so it must never be built
 * from a real instance's registry (that publishes a customer's schema). This
 * fixture renders through the same generateOpenApi() the live
 * /api/dev-tools/openapi.json uses, so the shapes stay honest while the
 * collection names stay generic.
 */
import type { CMSCollection, CMSField } from '../types.js'

type ColSeed = { collection: string; singular: string; plural: string; note: string }
type FieldSeed = {
  field: string
  type: string
  required?: boolean
  note?: string
}

const COLLECTIONS: Array<ColSeed & { fields: FieldSeed[] }> = [
  {
    collection: 'articles',
    singular: 'article',
    plural: 'articles',
    note: 'Editorial content with a publish workflow.',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'title', type: 'string', required: true },
      { field: 'slug', type: 'string', required: true, note: 'URL-safe identifier, unique' },
      { field: 'body', type: 'text', note: 'Rich text (HTML)' },
      { field: 'status', type: 'string', required: true, note: 'draft | review | published' },
      { field: 'author', type: 'integer', note: 'M2O → authors.id' },
      { field: 'category', type: 'integer', note: 'M2O → categories.id' },
      { field: 'published_at', type: 'datetime' },
      { field: 'featured', type: 'boolean' },
      { field: 'read_time_minutes', type: 'integer', note: 'Computed from body length' },
      { field: 'created_at', type: 'datetime', required: true },
      { field: 'updated_at', type: 'datetime', required: true }
    ]
  },
  {
    collection: 'authors',
    singular: 'author',
    plural: 'authors',
    note: 'People who write articles.',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'name', type: 'string', required: true },
      { field: 'email', type: 'string', required: true },
      { field: 'bio', type: 'text' },
      { field: 'avatar', type: 'uuid', note: 'M2O → files.id' },
      { field: 'is_active', type: 'boolean', required: true },
      { field: 'created_at', type: 'datetime', required: true }
    ]
  },
  {
    collection: 'categories',
    singular: 'category',
    plural: 'categories',
    note: 'Hierarchical taxonomy (parent → children).',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'name', type: 'string', required: true },
      { field: 'slug', type: 'string', required: true },
      { field: 'parent', type: 'integer', note: 'M2O → categories.id (self-referential tree)' },
      { field: 'sort', type: 'integer' },
      { field: 'description', type: 'text' }
    ]
  },
  {
    collection: 'tags',
    singular: 'tag',
    plural: 'tags',
    note: 'Free-form labels attached to articles through the articles_tags junction.',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'name', type: 'string', required: true },
      { field: 'color', type: 'string', note: 'Hex color for badges' }
    ]
  },
  {
    collection: 'articles_tags',
    singular: 'article tag',
    plural: 'article tags',
    note: 'M2M junction: articles ⇄ tags.',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'articles_id', type: 'integer', required: true, note: 'M2O → articles.id' },
      { field: 'tags_id', type: 'integer', required: true, note: 'M2O → tags.id' }
    ]
  },
  {
    collection: 'comments',
    singular: 'comment',
    plural: 'comments',
    note: 'Reader comments on an article (O2M from articles).',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'article', type: 'integer', required: true, note: 'M2O → articles.id' },
      { field: 'author_name', type: 'string', required: true },
      { field: 'author_email', type: 'string' },
      { field: 'body', type: 'text', required: true },
      { field: 'approved', type: 'boolean', required: true },
      { field: 'created_at', type: 'datetime', required: true }
    ]
  },
  {
    collection: 'orders',
    singular: 'order',
    plural: 'orders',
    note: 'Example transactional collection — shows numeric/decimal fields and a workflow-bound record.',
    fields: [
      { field: 'id', type: 'uuid', required: true, note: 'Primary key' },
      {
        field: 'order_number',
        type: 'string',
        required: true,
        note: 'Auto-id pattern, e.g. ORD-{seq}'
      },
      { field: 'customer_name', type: 'string', required: true },
      {
        field: 'total',
        type: 'decimal',
        required: true,
        note: 'Stored rollup: sum of order_lines.amount'
      },
      { field: 'currency', type: 'string', required: true },
      { field: 'status', type: 'string', required: true, note: 'Mirrors the pipeline state key' },
      { field: 'placed_at', type: 'datetime', required: true },
      { field: 'notes', type: 'text' }
    ]
  },
  {
    collection: 'order_lines',
    singular: 'order line',
    plural: 'order lines',
    note: 'Line items of an order (O2M from orders).',
    fields: [
      { field: 'id', type: 'integer', required: true, note: 'Primary key' },
      { field: 'order', type: 'uuid', required: true, note: 'M2O → orders.id' },
      { field: 'sku', type: 'string', required: true },
      { field: 'description', type: 'string' },
      { field: 'quantity', type: 'integer', required: true },
      { field: 'unit_price', type: 'decimal', required: true },
      { field: 'amount', type: 'decimal', note: 'Write-computed: quantity * unit_price' }
    ]
  }
]

export function sampleSchema(): {
  collections: CMSCollection[]
  fieldsByCollection: Map<string, CMSField[]>
  projectName: string
} {
  const now = new Date('2026-01-01T00:00:00Z')
  const collections: CMSCollection[] = []
  const fieldsByCollection = new Map<string, CMSField[]>()
  COLLECTIONS.forEach((c, ci) => {
    collections.push({
      id: ci + 1,
      collection: c.collection,
      display_name: c.plural.replace(/^\w/, (m) => m.toUpperCase()),
      singular: c.singular,
      plural: c.plural,
      icon: null,
      note: c.note,
      color: null,
      hidden: c.collection.includes('_'),
      singleton: false,
      sort_field: null,
      archive_field: null,
      archive_value: null,
      unarchive_value: null,
      display_template: null,
      group: null,
      sort: ci,
      accountability: 'all',
      versioning: false,
      workspace: null,
      picker_filter: null,
      created_at: now,
      updated_at: now
    } as CMSCollection)
    fieldsByCollection.set(
      c.collection,
      c.fields.map(
        (f, fi) =>
          ({
            id: ci * 100 + fi,
            collection: c.collection,
            field: f.field,
            type: f.type,
            db_column: null,
            interface: null,
            display: null,
            display_options: null,
            options: null,
            note: f.note ?? null,
            hidden: false,
            readonly: f.field === 'id',
            required: !!f.required,
            sort: fi,
            group: null,
            special: null
          }) as unknown as CMSField
      )
    )
  })
  return { collections, fieldsByCollection, projectName: 'Nivaro CMS' }
}

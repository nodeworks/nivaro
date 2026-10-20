import type { Knex } from 'knex'

/** Narrow a query to one layout type. 'grouped' also matches legacy rows whose
 *  layout_type is NULL (they predate migration 093 and render as grouped). */
export function whereLayoutType(q: Knex.QueryBuilder, type: string): Knex.QueryBuilder {
  if (type !== 'grouped') return q.where('layout_type', type)
  return q.where((b) => {
    b.where('layout_type', 'grouped').orWhereNull('layout_type')
  })
}

/**
 * The activate rule — the only way a layout becomes active: one default per
 * layout type per collection. File layouts are the exception: each active
 * file layout is a PDF button on the record, so several may be on.
 */
export async function activateLayout(
  q: Knex | Knex.Transaction,
  layout: { id: number | string; collection: string; layout_type?: string | null }
): Promise<void> {
  const type = layout.layout_type ?? 'grouped'
  if (type !== 'file') {
    await whereLayoutType(
      q('nivaro_collection_layouts').where({ collection: layout.collection }),
      type
    )
      .whereNot({ id: Number(layout.id) })
      .update({ is_active: 0 })
  }
  await q('nivaro_collection_layouts')
    .where({ id: Number(layout.id) })
    .update({ is_active: 1 })
}

/**
 * Hold the layout row's update lock for the rest of the transaction, so
 * every writer of one layout (the editor's ops batches and the older
 * assignments / field-group / settings routes) runs one at a time and the
 * editor's rev check sees the other writer's result. SQL Server only.
 */
export async function lockLayout(
  trx: Knex | Knex.Transaction,
  layoutId: number | string
): Promise<void> {
  const dialect = String(
    (trx as unknown as { client?: { config?: { client?: unknown } } }).client?.config?.client ?? ''
  )
  if (!/mssql/i.test(dialect)) return
  await trx.raw('SELECT id FROM nivaro_collection_layouts WITH (UPDLOCK, HOLDLOCK) WHERE id = ?', [
    Number(layoutId)
  ])
}

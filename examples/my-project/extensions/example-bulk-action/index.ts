import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-bulk-action',

  async register({ bulkActions, database, logger }) {
    // Appears in the bulk action bar for the "orders" collection.
    // Replace with your real logic.
    bulkActions.register({
      id: 'mark-fulfilled',
      label: 'Mark fulfilled',
      icon: 'CheckCircle2',
      collections: ['orders'],

      async execute({ ids }) {
        const updated = await database('orders')
          .whereIn('id', ids)
          .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })

        logger.info({ count: updated }, 'Orders marked fulfilled')
        return { message: `${updated} order${updated === 1 ? '' : 's'} marked as fulfilled` }
      }
    })
  }
}

export default extension

import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-item-action',

  async register({ itemActions, callExternalApi, logger }) {
    // Adds a "Push to ERP" button in the item editor toolbar.
    itemActions.register({
      id: 'push-to-erp',
      label: 'Push to ERP',
      icon: 'Send',
      collections: ['invoices'],
      variant: 'outline',

      async execute({ collection, itemId }) {
        logger.info({ collection, itemId }, 'Pushing to ERP')

        // Uses an external API configured in Nivaro Settings → External APIs
        const result = await callExternalApi('my-erp', {
          method: 'POST',
          path: `/invoices`,
          body: { source_id: itemId }
        })

        if (!result.ok) throw new Error('ERP rejected the push')
        return { message: `Invoice ${itemId} pushed to ERP successfully` }
      }
    })
  }
}

export default extension

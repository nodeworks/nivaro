/**
 * Read-only registry endpoints for all extension-registered capabilities.
 * These are fetched by the admin UI to discover what extensions have added.
 */
import type { FastifyInstance } from 'fastify'
import { bulkActionRegistry } from '../extensions/bulk-actions.js'
import { collectionViewRegistry } from '../extensions/collection-views.js'
import { dashboardWidgetRegistry } from '../extensions/dashboard-widgets.js'
import { fieldTypeRegistry } from '../extensions/field-types.js'
import { importParserRegistry } from '../extensions/import-parsers.js'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { notificationChannelRegistry } from '../extensions/notification-channels.js'
import { storageAdapterRegistry } from '../extensions/storage-adapters.js'
import { validatorRegistry } from '../extensions/validators.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'

export async function extensionRegistryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/extension-registry', { preHandler: [requireAuth] }, async (req) => {
    const collection = (req.query as Record<string, string>).collection
    return {
      data: {
        bulkActions: bulkActionRegistry.list(collection).map(({ execute: _x, ...rest }) => rest),
        itemActions: itemActionRegistry.list(collection).map(({ execute: _x, ...rest }) => rest),
        notificationChannels: notificationChannelRegistry
          .list()
          .map(({ deliver: _x, ...rest }) => rest),
        dashboardWidgets: dashboardWidgetRegistry.list(),
        fieldTypes: fieldTypeRegistry
          .list()
          .map(({ serialize: _s, deserialize: _d, ...rest }) => rest),
        storageAdapters: storageAdapterRegistry.list(),
        activeStorageAdapter: storageAdapterRegistry.activeName,
        collectionViews: collectionViewRegistry.list(collection),
        importParsers: importParserRegistry.list(),
        validators: validatorRegistry.list()
      }
    }
  })
}

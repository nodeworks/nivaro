/**
 * Registers a custom Kanban view for collections.
 * The UI bundle (ui.js) is served from this extension's folder and renders
 * inside an iframe in the collection browser.
 *
 * The bundle receives data via postMessage:
 *   { type: 'nivaro:view:data', collection, items, fields }
 * It emits back:
 *   { type: 'nivaro:view:open', id }  — to open an item
 */
import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-collection-view',

  register({ collectionViews }) {
    collectionViews.register({
      id: 'kanban',
      label: 'Kanban',
      icon: 'Columns3',
      // bundleUrl is set automatically from manifest.json when served via the extension route
      bundleUrl: '/api/extensions/example-collection-view/ui.js',
      fieldMappings: [
        { key: 'statusField', label: 'Status field', required: true },
        { key: 'titleField', label: 'Title field', required: true },
        { key: 'assigneeField', label: 'Assignee field' }
      ]
    })
  }
}

export default extension

// Investigation group "entities" (Traffic Map drill-down, #1199 #1200 #1203): the panels for
// the nodes of the map — caller, entity, query, widget, page and down.
// Imported once from registry/index.ts; edit only this folder.
import { inspectables } from '../../registry/inspectables'
import { register } from '../../registry/registry'
import { CallerPanel } from './CallerPanel'
import { QueryPanel, WidgetPanel } from './DefinitionPanels'
import { EntityPanel } from './EntityPanel'
import { callerTitle, downTitle, entityTitle, pageTitle, queryTitle, widgetTitle } from './logic'
import { DownPanel, PagePanel } from './PageDownPanels'

register(inspectables, { id: 'caller', label: 'Caller', Panel: CallerPanel, title: callerTitle })
register(inspectables, { id: 'entity', label: 'Entity', Panel: EntityPanel, title: entityTitle })
register(inspectables, { id: 'query', label: 'Query', Panel: QueryPanel, title: queryTitle })
register(inspectables, { id: 'widget', label: 'Widget', Panel: WidgetPanel, title: widgetTitle })
register(inspectables, { id: 'page', label: 'Page', Panel: PagePanel, title: pageTitle })
register(inspectables, { id: 'down', label: 'Downstream', Panel: DownPanel, title: downTitle })

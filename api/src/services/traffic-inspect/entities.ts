// api/src/services/traffic-inspect/entities.ts
/**
 * Traffic Map drill-down, group "entities" (#1199 #1200 #1203): the inspect sources for the
 * nodes of the map — `caller`, `entity`, `query`, `widget`, `page` and `down`. Registered at
 * module load; routes/traffic-map-extras/inspect-entities.ts imports this module.
 */
import { registerInspectSource } from '../traffic-inspect.js'
import { callerDetail, callerPeek } from './entities-caller.js'
import {
  parseCallerKey,
  parseEntityRef,
  parsePageRef,
  validDownId,
  validQuerySlug,
  validWidgetId
} from './entities-logic.js'
import {
  downDetail,
  downPeek,
  entityDetail,
  entityPeek,
  pageDetail,
  pagePeek,
  queryDetail,
  queryPeek,
  widgetDetail,
  widgetPeek
} from './entities-sources.js'

registerInspectSource({
  kind: 'caller',
  validId: (id) => parseCallerKey(id) != null,
  peek: callerPeek,
  detail: callerDetail
})

registerInspectSource({
  kind: 'entity',
  validId: (id) => parseEntityRef(id) != null,
  peek: (id) => entityPeek(id),
  detail: entityDetail
})

registerInspectSource({
  kind: 'query',
  validId: validQuerySlug,
  peek: (id) => queryPeek(id),
  detail: queryDetail
})

registerInspectSource({
  kind: 'widget',
  validId: validWidgetId,
  peek: (id) => widgetPeek(id),
  detail: widgetDetail
})

registerInspectSource({
  kind: 'page',
  validId: (id) => parsePageRef(id) != null,
  peek: pagePeek,
  detail: pageDetail
})

registerInspectSource({
  kind: 'down',
  validId: validDownId,
  peek: (id) => downPeek(id),
  detail: downDetail
})

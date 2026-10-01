/**
 * Deep measurement (group B2: #1108 #1119 #1134 #1135 #1136 #1145 #1146 #1151) — inspector
 * panels, the N+1 node badge and the Hot entities "Trips" column, over the server taps in
 * api/src/services/traffic-taps/.
 */
import './deep-measurement.css'
import { nodeBadges } from '../../registry/canvasLayers'
import { hotColumns } from '../../registry/hotColumns'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { nPlusOneBadge } from './logic'
import {
  AmplificationPanel,
  collectionApplies,
  entityApplies,
  FieldHeatPanel,
  GraphqlFieldsPanel,
  graphqlApplies,
  HotRecordsPanel,
  ReadShapesPanel,
  RequestCostPanel,
  TripsCell
} from './panels'

register(nodeBadges, { id: 'n-plus-one', order: 20, badge: nPlusOneBadge })

register(hotColumns, {
  id: 'trips',
  header: 'Trips',
  align: 'right',
  cell: (row) => <TripsCell k={row.key} />
})

register(inspectorPanels, {
  id: 'request-cost',
  order: 20,
  applies: entityApplies,
  Component: RequestCostPanel
})
register(inspectorPanels, {
  id: 'write-amplification',
  order: 21,
  applies: entityApplies,
  Component: AmplificationPanel
})
register(inspectorPanels, {
  id: 'hot-records',
  order: 22,
  applies: collectionApplies,
  Component: HotRecordsPanel
})
register(inspectorPanels, {
  id: 'field-heat',
  order: 23,
  applies: collectionApplies,
  Component: FieldHeatPanel
})
register(inspectorPanels, {
  id: 'read-shapes',
  order: 24,
  applies: collectionApplies,
  Component: ReadShapesPanel
})
register(inspectorPanels, {
  id: 'graphql-fields',
  order: 25,
  applies: graphqlApplies,
  Component: GraphqlFieldsPanel
})

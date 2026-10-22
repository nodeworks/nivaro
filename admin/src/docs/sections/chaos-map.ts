import type { DocSection } from '../types.js'

/** #2851 Chaos layer on the Traffic Map (and #2841 Simulate down from the node menu). */
export const chaosTrafficMapDocs: DocSection = {
  id: 'chaos-traffic-map',
  label: 'Chaos on the Traffic Map',
  content: [
    { type: 'h1', id: 'chaos-traffic-map', text: 'Chaos on the Traffic Map' },
    {
      type: 'p',
      text: 'Where chaos drills are allowed (never in cloud mode; on production only with CHAOS_ENABLED=true), the Traffic Map shows every armed fault on the nodes it acts on, so nobody reads a drill as a real outage. Where chaos is refused, nothing here appears.'
    },
    { type: 'h2', id: 'chaos-traffic-map-armed', text: 'Armed faults on the map' },
    {
      type: 'p',
      text: 'A node a fault acts on is hatched in red with a dashed outline, and a label names the fault and the time it has left (the soonest to end, plus how many more). The edges into a faulted database, Redis, email or partner node are dashed. The toolbar shows the drill and links to its run; selecting a hatched node lists the drills acting on it, with Open run.'
    },
    {
      type: 'table',
      head: ['The fault acts at', 'Drawn on'],
      rows: [
        ['Every request, a share or one replica (http.request)', 'Every API lane'],
        ['Routes matching a pattern', 'The entities whose routes match'],
        ['One person', 'That person on the callers side'],
        ['The database (db.*), or one table', 'SQL Server, and that table’s entity'],
        ['Redis (redis.*)', 'Redis'],
        ['Email, SMS, push (mail.*, sms.*, push.*)', 'That channel'],
        ['Partner calls (external.*)', 'Every partner node'],
        ['File storage, AI providers', 'File storage, each AI node'],
        ['Socket drills', 'The Sockets lane'],
        ['The scheduler (cron.*)', 'The scheduled job nodes']
      ]
    },
    { type: 'h2', id: 'chaos-traffic-map-inject', text: 'Inject fault here' },
    {
      type: 'p',
      text: 'Right-click a node, or use the inspector’s action row, for Inject fault here. It opens the chaos console on the Faults tab with that fault’s start form already aimed at the node: a route pattern for an endpoint or a lane, the table for a collection with a database fault, the person for a caller, everything for a data store, a channel or a partner. Nothing starts until you press Run there. Socket drills open the Realtime page’s own drill form.'
    },
    {
      type: 'p',
      text: 'The same right-click menu offers Simulate down on a dependency: what would break if it went away, worked out from recorded traffic, with nothing switched off (see Traffic Map: Act).'
    },
    {
      type: 'note',
      text: 'The console link is /chaos?tab=faults&fault=<fault key>&target=<kind>:<value>, for example target=route:/api/items/orders* or target=table:orders. A target the fault cannot take is ignored and the form opens with its usual default.'
    }
  ]
}

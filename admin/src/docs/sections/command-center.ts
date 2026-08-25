import type { DocSection } from '../types.js'

export const commandCenterDocs: DocSection = {
  id: 'command-center',
  label: 'Command Center',
  content: [
    { type: 'h1', id: 'command-center', text: 'Command Center' },
    {
      type: 'p',
      text: 'The Command Center at /command is a live operations wallboard: a map of your records and people, a pipeline flow board, a risk strip, throughput numbers, and a ticker of recent activity — all on one dark, glanceable screen. Everything refreshes on its own (the snapshot every 20 seconds, the map every 60), and a Refresh button in the header re-pulls the whole board on demand.'
    },
    {
      type: 'note',
      text: 'The page works for every authenticated user — each pane only shows what that person is allowed to read. Only the System health rail is admin-only.'
    },
    { type: 'h2', id: 'command-center-map', text: 'The live map' },
    {
      type: 'p',
      text: 'The map is an OpenStreetMap view with two kinds of layer, toggled by the chips in the panel header. Record layers show one pin per record of a geocoded collection (locations by default); the People chip shows green bubbles for who is online and where. Clicking a chip that is already selected hides that layer; clicking a different collection chip switches to it.'
    },
    {
      type: 'ul',
      items: [
        'Record pins come from any collection that has latitude/longitude columns (latitude/lat and longitude/lng/lon are auto-detected), read through the normal items API — so role permissions, row-level security, and user scopes all apply to what you see. The first 500 records are plotted.',
        'Pin color follows the record: red with a pulsing ring when its SLA is breached, amber on SLA warning, otherwise the workflow state color. Nearby pins cluster into a numbered disc — click a cluster to zoom in, click a single pin to open the record.',
        'People bubbles appear at geocoded office locations (one bubble per office, sized by how many people are online there) and, for people without a resolved office, at region centroids computed from the average position of that region’s locations. A region needs at least two geocoded locations before it earns a centroid.',
        'The status line under the map reports how many records are plotted, whether the 500-record cap was hit, and how many people groups are on.'
      ]
    },
    { type: 'h2', id: 'command-center-panels', text: 'Flow board, people, and ticker' },
    {
      type: 'ul',
      items: [
        'Pipeline flow — one bar per workflow-bound collection you can read, segmented by state: each segment’s width is that state’s share of the open records, tinted with the state color, with a legend of counts underneath. Clicking a segment opens that collection’s browser.',
        'People on now — everyone currently online (active in the last 70 seconds), grouped by office first and then by region, with each person’s name as a pill. Clicking a group flies the map to that office or region. Non-admins with restricted user scopes see only colleagues whose scopes overlap their own on every restricted dimension.',
        'Header strip — live clock, online/idle counts, transitions today with a delta versus the same time yesterday (from workflow history), and a red open-issues pill that links to /issues when anything is open.',
        'Risk numbers — at-risk and tracked counts come from the materialized queue caches, and open issues from the issue log seen in the last 90 days.',
        'Live ticker — the most recent creates, updates, deletes, and pipeline transitions across business collections, filtered to collections you can read. Each pill shows who did what and links to the record. A quiet ticker for a low-permission user is normal.'
      ]
    },
    { type: 'h3', text: 'System health rail (admins)' },
    {
      type: 'p',
      text: 'Admins get an extra rail: database and Redis status dots, error and request counts for the last hour, running and recently failed background jobs, process memory, and event-loop lag. The server never sends this block to non-admins, so the panel simply does not exist for them.'
    },
    { type: 'h2', id: 'command-center-profile-capture', text: 'Where office locations come from' },
    {
      type: 'p',
      text: 'On instances using Microsoft sign-in, each login also captures the user’s organizational profile from Microsoft Graph under the standard User.Read scope — no extra admin consent is needed. Alongside the existing title, company, department, and phone, Nivaro now captures office location, city, state, country, employee ID, and preferred language, and stores them on the user record.'
    },
    {
      type: 'ul',
      items: [
        'The directory (Microsoft Entra / Azure AD) is the source of truth: every login re-writes these fields from Graph, so a value edited by hand is overwritten at the person’s next sign-in. A field Graph does not return keeps its previous value rather than being cleared.',
        'The Graph call runs inside the login with a 5-second budget and fails quietly — a slow or unavailable Graph never blocks anyone from signing in; the profile just stays as it was.',
        'When a login carries an office location, it is geocoded in the background: first against your own locations collection (an exact street-address match wins and costs nothing), then via OpenStreetMap’s public geocoder. The resolved coordinates become that person’s office pin on the Command Center map.',
        'Geocoding remembers which address it resolved, so an unchanged office costs nothing on later logins; only a changed address triggers a new lookup. An address that cannot be resolved is retried at the next login, and that person appears in region bubbles (or a "No location set" group) instead.'
      ]
    },
    {
      type: 'note',
      text: 'Office location is visible to everyone in the people directory, like title and department. Employee ID and city stay admin-only.'
    }
  ]
}

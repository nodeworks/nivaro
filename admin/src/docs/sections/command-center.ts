import type { DocSection } from '../types.js'

export const commandCenterDocs: DocSection = {
  id: 'command-center',
  label: 'Command Center',
  content: [
    { type: 'h1', id: 'command-center', text: 'Command Center' },
    {
      type: 'p',
      text: 'The Command Center at /command is one live board for what is happening in the business right now: what needs someone (Needs attention), where the work physically is (the map), what is moving (pipeline flow, throughput, today’s forecast and the live feed), who is on, and a one-line system status that hands off to the Traffic Map for the machine itself. Every number opens its real screen, and every pane shows only what you are allowed to read.'
    },
    {
      type: 'note',
      text: 'The board follows the app’s light/dark theme. Choose Always dark in Customise for a wall screen; TV mode and wallboard links are always dark.'
    },
    { type: 'h2', id: 'command-center-attention', text: 'Needs attention' },
    {
      type: 'p',
      text: 'One ranked list (most severe, then oldest) of the things that need a person: records past or near their SLA deadline, records stuck in one state longer than the board’s stuck threshold (7 days by default), approval steps whose every approver is away or that have waited too long, and alert hits from the last 24 hours. Administrators also see failing integrations and coverage gaps. The header shows “N past deadline” and “N near deadline” chips that jump to the list.'
    },
    {
      type: 'ul',
      items: [
        'Open a record from any row to see it in the side panel without leaving the board.',
        'Nudge sends the record’s current owners a notification (once per person per record every 30 minutes) and is logged in the record’s activity.',
        'Reassign moves a group of stuck records to another person through the normal owner change, after a second click to confirm; records you may not change are listed with the reason.',
        'Approve and pipeline moves run through the normal transition and approval routes, with an inline confirm.',
        'Alert me (administrators) opens a new alert definition already filled in from the row.'
      ]
    },
    { type: 'h2', id: 'command-center-map', text: 'The live map' },
    {
      type: 'p',
      text: 'Record pins come from any collection with latitude and longitude fields (the board finds them; administrators choose which ones in Board settings, opened from the gear on the map). Pins are read through the normal items API, so permissions, row filters and User Scopes apply; the first 500 are plotted. Pin colour is the record’s workflow state, amber near its SLA deadline and red (pulsing) past it; the map key names every colour in words. Clusters take the colour of their most urgent record.'
    },
    {
      type: 'ul',
      items: [
        'Layers: SLA heat, Activity (records changed in the last 15 minutes) and Out today (people out of office, at their office or region).',
        'Filter chips narrow the pins by state, SLA and owner.',
        'People bubbles show who is online at their office, or at their region’s centre when they have no office address.',
        'An instance with no geocoded collection gets a short explanation of how to add latitude and longitude fields; the rest of the board works without a map.'
      ]
    },
    { type: 'h2', id: 'command-center-regions', text: 'Regions and Board settings' },
    {
      type: 'p',
      text: 'Pick a region in the header (or click a region on the map) to focus the whole board on it: the map flies there and flow, attention, people, throughput, workload and the feed narrow to that region. A read that cannot place its records in regions says so and shows everywhere.'
    },
    {
      type: 'p',
      text: 'Regions come from the data model, never from fixed table names: the board looks for a collection the map’s records link to (directly or through a junction) and for a User Scope dimension that names it, so people can be placed too. Administrators can confirm or change the source, the map collections and the stuck threshold in Board settings (stored in nivaro_settings.command_center, migration 523).'
    },
    {
      type: 'h2',
      id: 'command-center-panels',
      text: 'Flow, throughput, forecast, workload and people'
    },
    {
      type: 'ul',
      items: [
        'Pipeline flow — open records per state for each workflow-bound collection you can read, with the oldest and median age per state, how many are stuck, whether the backlog grew or shrank over 7 days and roughly how many days it takes to clear. Clicking a state opens the list filtered to it.',
        'Throughput today — pipeline moves per hour today against yesterday and the 7-day average. Administrators see deploy and configuration-change markers on it. Days follow your profile time zone (else the instance’s, else Eastern).',
        'Today’s forecast — new records and completions per hour against the same weekday over the last four weeks, with a “falling behind” warning in words.',
        'Workload — open records per owner against their usual load (over, normal, idle, out). Administrators see everyone; managers see their direct reports; the panel is hidden for others.',
        'People on now — online people grouped by office and region (collapsed to counts until opened), each with the page or record they have open when you may see it. Administrators can open the Traffic Map following a person and send a group a short message.',
        'Partners (administrators) — one health dot per integration partner with open problems, linking to the Integrations console.',
        'Live feed — readable sentences for recent changes you can see, live for administrators and refreshed every 10 seconds for everyone else. Pause it, or filter to records, pipeline moves or your team.'
      ]
    },
    { type: 'h2', id: 'command-center-time', text: 'Rewind, brief and the Traffic Map' },
    {
      type: 'ul',
      items: [
        'Rewind — the time bar in the header moves the board back up to seven days (to the minute). Flow counts, the feed and throughput answer for that moment; panels that can only answer live say “live only”. Back to live returns to now. Clicking a spike on the Traffic card rewinds to that minute.',
        'What changed? — a short plain-language summary of the last hour, built only from figures you can see on the board (AI writes it when AI is set up; otherwise the facts are listed).',
        'System status (administrators) — one header pill: “All systems normal” or the issues found (database or Redis down, errors, failed jobs, event-loop lag), with links to the Traffic Map and Health. Detailed machine figures live in the Traffic Map.',
        'The Traffic Map’s inspector offers “See on Command Center” for collection nodes, and the board links collections to their Traffic Map node.',
        'A banner shows while a chaos drill runs, maintenance mode is on or (administrators) an incident is open.'
      ]
    },
    { type: 'h2', id: 'command-center-customise', text: 'Customise, links, keyboard and TV mode' },
    {
      type: 'ul',
      items: [
        'Customise — show, hide and reorder panels, save named views (region, map collection and filters) and pick the theme. Administrators also set each role’s starting layout. Your own layout is kept in your profile (nivaro_users.preferences.command_center).',
        'Copy link — the address carries the view: region, at (rewind instant), map (collection), peek (collection:id) and tv=1.',
        'Keyboard — f full screen, t TV mode, r refresh, g region picker, 1–9 a region (0 = everywhere), Esc closes the record panel or leaves TV mode, ? lists the shortcuts.',
        'TV mode — larger type, full screen and, after a minute without input, the board cycles through regions.',
        'On a phone the board stacks with Needs attention first and the map behind “Show map”.'
      ]
    },
    { type: 'h3', text: 'Wallboard links (administrators)' },
    {
      type: 'p',
      text: 'A wallboard link shows the board on a screen nobody signs in to, at /command/kiosk#<token> (the token sits after the #, which browsers never send to a server, so it cannot reach a log), always in TV mode and read-only (no moves, nudges or messages). It is a business board, not an admin console: it shows record counts, the flow, the map and throughput the administrator who made it can see, but never the system, traffic or partner panels, deploy or incident markers, integration problems, open issues, names of people, the live feed, workload or record peeks. It stays on the region and map collection chosen when the link was made. The link expires after 1–90 days, can be revoked in Customise, and stops working when its maker is suspended, removed or no longer an administrator. Only a fingerprint of the token is stored, so the address is shown once, when the link is made; it is masked in request logs.'
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

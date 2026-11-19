import type { DocSection } from '../types.js'

export const dbConnectionsDocs: DocSection = {
  id: 'db-connections',
  label: 'Database Connections',
  content: [
    { type: 'h1', id: 'db-connections', text: 'Database Connections' },
    {
      type: 'p',
      text: 'The Connections tab of the Database page (/database/connections, Operations → Database) shows who holds a database connection right now and who is waiting for one, on every API process at once. When the request pool is full, it answers in seconds which person, API key, assistant, route, job or flow has the connections. Admins only; self-hosted only.'
    },
    { type: 'h2', id: 'db-connections-page', text: 'The page' },
    {
      type: 'ul',
      items: [
        'Totals: connections in use across every process for the request pools and the background pools, how many acquires are waiting, and how many heavy-read slots are held or queued.',
        'Processes: one row per API process (web, worker, importer, exporter, realtime) with a bar per pool — in use, free, and, past the line, acquires waiting for a connection.',
        'Who holds connections: grouped by person (a signed-in person, an API key, an MCP assistant, System for jobs, Signed out) or by feature (the route template, Job: <name>, Flow: <name>, Import worker, or a labelled background task). Every column sorts. Biggest share is the highest share of ONE process’s pool; over 25% the row is marked.',
        'Longest holders: the connections held longest, with the feature, the person, the pool and the process. A connection taken inside a heavy-read slot says “read slot”.',
        'Waiting: acquires still queued, oldest first (only while there are any).',
        'Held most of a pool: the last 24 hours of times one person or feature held more than half of a pool for 30 seconds or more.'
      ]
    },
    {
      type: 'p',
      text: 'Every row opens what is behind it: a request opens its request story (/health/request-story), a person their Activity tab, an API key the API keys page, an assistant the MCP connections page, a job the Jobs page, a flow its editor. The page refreshes every 3 seconds while the tab is visible; Pause stops it.'
    },
    { type: 'h2', id: 'db-connections-how', text: 'How it is measured' },
    {
      type: 'p',
      text: 'Each process notes the borrower when a connection is requested from its pool: the request (its id, route and caller), the job, flow or import it belongs to, or a feature label. Nothing is read, written or sent while that happens. The names and the route template are worked out only when someone opens the page. A connection that is waiting is credited to the request that asked for it, not to the request that let one go.'
    },
    {
      type: 'p',
      text: 'Processes answer through Redis only while someone is looking: opening the page sets a short watch key, and every process writes its snapshot every 2 seconds while the key exists. The first look after a quiet spell waits up to 2.5 seconds for the others. A process in the instance roster that still has not answered is named in an amber note and the figures leave it out; a process that has just stopped drops off the roster within 90 seconds.'
    },
    {
      type: 'note',
      text: 'The page never shows SQL text or bound values. A connection that neither a request, a job, a flow nor a label claims reads as “Background work (unlabelled)” or “Unattributed work”. Code can name its work with withPoolFeature(label, fn) from services/pool-holder-context.ts.'
    },
    { type: 'h2', id: 'db-connections-readiness', text: 'Readiness' },
    {
      type: 'p',
      text: 'The readiness check pool-hogs (Operations) warns when, in the last 24 hours, one person or feature held more than half of a pool for 30 seconds on any process, and lists when, who, how many connections and where.'
    },
    { type: 'h2', id: 'db-connections-api', text: 'API' },
    {
      type: 'pre',
      code: 'GET /api/ops-db/pool-holders   (admin)\n→ { data: { available, at, partial, nodes[], missing[], totals[], by_person[], by_feature[],\n             longest[], waiters[], read_gate, hogs[], thresholds } }'
    },
    {
      type: 'p',
      text: 'available is false in cloud mode. partial is true when a process in the instance roster did not answer; missing names it. by_person / by_feature rows carry holding, waiting, by_pool, max_share (0–1 of one process’s pool) with max_share_node and max_share_pool, hot (over 25%), oldest_ms, top (the other side’s top three) and sample_request_id.'
    }
  ]
}

import type { DocSection } from '../types.js'

export const fileDownloadsGuide: DocSection = {
  id: 'file-downloads',
  label: 'File downloads',
  content: [
    { type: 'h1', id: 'file-downloads', text: 'File downloads' },
    {
      type: 'p',
      text: 'Every time a signed-in person downloads a stored file, or opens it in the browser, Nivaro writes one activity entry on each record the file belongs to (up to five). The entry reads "downloaded “quote.pdf” on Workflow 85607" on the record’s history, in the person’s own activity and in the Activity log, and it is kept for as long as the rest of the activity log. A file that belongs to no record is logged on the file itself.'
    },
    {
      type: 'ul',
      items: [
        'Counted: `GET /api/files/:id` with `download=1` (every file link in the apps) and a direct open of the file.',
        'Not counted: thumbnails (`/files/:id/transform`), an image a page shows inline (the browser’s `Sec-Fetch-Dest`; only image files — any other file fetched that way still counts), HEAD requests, and the same person fetching the same file again within a minute. The later pieces of a streamed video fold into one entry per person and file per 30 minutes. The decision is the server’s: no request header can switch off a download with `download=1`. Raw storage-key reads (`/files/raw/*`) count the same way.',
        'Each entry records who, which file, which record, and the app it came from: `admin`, the host name of another front end, or `direct` for a link with no page behind it.',
        'Nothing is logged when the file could not be sent (no access, missing from storage).'
      ]
    },
    { type: 'h2', id: 'file-downloads-record', text: 'On a record' },
    {
      type: 'p',
      text: 'For administrators, each file on a record form carries a small people count beside its "used in" chip: how many people downloaded it from that record. Hovering names them; clicking lists each person with how many times and when. A file nobody downloaded shows nothing, and other people never see the count (`GET /api/file-downloads/on-record?collection=&item=&ids=`, administrators only). Both chips are on by default and can be turned off per field in the layout editor (Rules tab → Show where each file was used / Show who downloaded each file; placement overrides `file_used_in: false` and `file_downloads: false`).'
    },
    { type: 'h2', id: 'file-downloads-report', text: 'The report' },
    {
      type: 'p',
      text: 'Reports → File downloads (`/reports/downloads`, administrators only) folds the downloads in a date range (the last 30 days by default) by file, by person and by record, or lists every download. Filter by collection and person; Export CSV writes one line per download. Downloads on records you cannot open (User Scopes, row filters) are left out, and the newest 20,000 downloads in the range are counted (`GET /api/file-downloads/report?from=&to=&collection=&user=&format=csv`).'
    }
  ]
}

import type { DocSection } from '../types.js'

export const helpVideosGuide: DocSection = {
  id: 'help-videos',
  label: 'Help Videos',
  content: [
    { type: 'h1', id: 'help-videos', text: 'Help Videos' },
    {
      type: 'p',
      text: 'Short screen recordings that show people how a screen works. Authors record in the browser, cut and annotate in a visual editor, and publish; everyone else watches them in the Videos library, from the Videos button on the screen a video explains, and — when a video is required for their role — from My Work until they have watched it.'
    },
    { type: 'h3', text: 'Who can record' },
    {
      type: 'p',
      text: 'Administrators always can. Videos → Who can record adds roles whose members may record and edit too. Everyone else can only watch, and only the videos whose visibility includes them ("Everyone" or the chosen roles). A video limited to roles with none chosen (or whose last chosen role was deleted) is visible to authors only.'
    },
    { type: 'h3', text: 'Recording' },
    {
      type: 'p',
      text: 'Record a video (or "Record one for this screen" from a Videos button) asks for a screen, window or tab and, optionally, a microphone. A three-second countdown starts it; a small bar shows the time and stops it. Recording follows you from page to page — the bar stays up while you navigate, so you can record a walk-through across screens — and inside a dialog or sheet the bar and setup open inside it. The recording uploads in five-second parts while it runs and keeps unsent parts in the browser, so a dropped connection or a closed tab loses nothing — the next time you open the recorder it offers to finish the upload. A recording that finished uploading but was never saved as a video (the tab closed during the save) is offered there too, ready to save or discard; one left unsaved for a week is deleted. Recordings are limited to 30 minutes.'
    },
    { type: 'h3', text: 'Editing' },
    {
      type: 'ul',
      items: [
        'Cut: split at the playhead (S) and delete the piece; trim the ends by dragging. Silent stretches are suggested as cuts. You cannot cut everything — at least one second stays.',
        'Speed: play a piece at 1×, 1.5×, 2× or 4×.',
        'Chapters and poster: add a chapter at the playhead; choose the frame the library shows.',
        'Callouts, arrows, boxes and click ripples: draw on the preview, then set the text and how long it shows. "Add click ripples" places one at every click the recorder saw; a ripple from a recorded click says what was clicked (hover its bar, or select it).',
        'Zoom: draw the area to zoom into; the video eases in and out.',
        'Blur: hide part of the screen (or the whole frame) for a stretch of time.',
        'Captions: type them along the timeline; viewers turn them on with CC.',
        'Undo and redo cover every change (Ctrl/Cmd+Z, Shift for redo). Edits save as you go; nothing reaches viewers until you publish.'
      ]
    },
    { type: 'h3', text: 'Show me on this page' },
    {
      type: 'p',
      text: 'When you record this tab with "Capture my clicks" on, each click also notes what was clicked: the button, link, tab or field by its name and kind, a stable marker on the page when there is one, and which screen it was on. Once the video is published, a viewer who opens it on that screen gets "Show me on this page": the video closes and a guided walk rings each thing to click on the real screen, in order, with the text of the callout or box you placed beside that click (else "Click Approve"). Clicking the ringed element moves on — the click works as usual — or use Next, Back, Skip and Exit (Esc). A step the screen does not show after a few seconds says so and offers "Watch this step", which opens the video at that moment; a step recorded on another screen says so, with Go there when it was this app. Clicks you cut out of the video are left out of the walk.'
    },
    {
      type: 'note',
      text: 'Privacy: only the name of a field is noted, never its value or what was typed, and nothing at all is noted inside an area marked nvr-no-record (the same mask session replay uses) — there the click keeps only its position. Window and whole-screen recordings keep positions only. Videos recorded before this have no walk.'
    },
    { type: 'h3', text: 'Where a video shows' },
    {
      type: 'p',
      text: 'Details → Where it shows. Pick record forms (a collection) and, optionally, the pipeline steps a video applies to. Choosing steps limits the video to those steps — a video for the Manager Approval step shows on records in that step and nowhere else — and one with no steps picked shows at every step. Other pages appear in the list once they have been opened with a Videos button on them.'
    },
    { type: 'h3', text: 'Publishing, versions and required viewing' },
    {
      type: 'p',
      text: 'Publish needs a title and at least one place to show. Every published cut is kept under Versions; restoring copies an older cut into a new draft and overwrites nothing. Opening the editor makes a draft, so Publish stays off, with "No changes since the last publish" beside it, while the draft is exactly what is published. A publish queues a render on the server. Viewers get the original recording only when the cut leaves it untouched in every way that matters: no blurs, no cuts, no trim and no callouts or boxes (a callout is an opaque panel and the label inside a box can cover a field; arrows, ripples and zooms are drawn live). Any other video plays as the finished render, and until that render is ready viewers see "Getting ready" in the library. Authors always see their latest edits applied live.'
    },
    {
      type: 'p',
      text: 'Required for: people in those roles get an in-app notification and, if their browser is subscribed, a browser push, and see the video in My Work until they have watched most of it (18 of its 20 five-percent sections). "Ask everyone to watch again" on a later publish resets that; when nothing else changed, Publish offers only that and the video itself is not published again. Marking a video required tells real people at once, so test it with a throwaway role.'
    },
    { type: 'h3', text: 'Stats' },
    {
      type: 'p',
      text: 'Stats shows how many people watched, how many watched most of it, the total hours watched, and where people stop — the share of viewers who reached each 5% of the video. Administrators can also delete an archived video for good with Delete permanently on the Archived tab (only archived videos can be deleted permanently), which removes every version, the recording and video files, the viewing record and any required viewing and cannot be undone.'
    }
  ]
}

export const helpVideosApi: DocSection = {
  id: 'help-videos-api',
  label: 'Help Videos API',
  content: [
    { type: 'h1', id: 'help-videos-api', text: 'Help Videos API' },
    {
      type: 'p',
      text: 'Everything the library, editor and player do goes through /api/help-videos, and @nivaro/sdk carries a command for each route (listHelpVideos, helpVideosFor, readHelpVideo, saveHelpVideoDraft, publishHelpVideo, recordHelpVideoProgress, …). Edits are stored as instructions, not as a new video file: kept segments with speeds, chapters, annotations, zooms, blurs, captions and a poster frame, all timed in the recording’s own clock.'
    },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          'GET /help-videos',
          'everyone',
          'Library: search, category, status (authors), page; returns can_author'
        ],
        [
          'GET /help-videos/for?collection=&item=&page=',
          'everyone',
          'Videos for a screen; the server reads the record’s pipeline step itself'
        ],
        [
          'GET /help-videos/:id',
          'viewers',
          'One video; authors also get the draft, visibility and required roles'
        ],
        [
          'GET /help-videos/:id/stream | /captions.vtt | /poster',
          'signed link',
          'Media for <video>/<track>/<img>; byte ranges; the ?st= ticket is re-checked against the person’s role on every request'
        ],
        [
          'POST /help-videos/:id/progress',
          'viewers',
          'Position, watched time and the 20-section map'
        ],
        [
          'GET /help-videos/required/mine',
          'everyone',
          'Required videos not watched since they became required'
        ],
        [
          'POST /help-videos/uploads, PUT …/parts/:n, POST …/finalize',
          'authors',
          'Chunked recording upload (parts ≤ 8 MB, total ≤ 1.2 GB, webm or mp4)'
        ],
        ['POST /help-videos', 'authors', 'Create a video from a finalized upload'],
        [
          'PUT /help-videos/:id/draft/edits',
          'authors',
          'Save the draft; send base_hash to get 409 HELP_VIDEO_EDITS_CONFLICT when someone else saved first'
        ],
        [
          'POST /help-videos/:id/publish',
          'authors',
          'Publish the draft; watch_again resets required viewing'
        ],
        ['POST /help-videos/:id/render', 'authors', 'Queue a render again'],
        [
          'GET /help-videos/:id/walk',
          'viewers',
          '"Show me on this page": the published version’s labelled clicks inside kept pieces, in order — label, role, hook, page_key, path, origin, edited_ms and the nearby callout/box text. Never the draft'
        ],
        ['GET /help-videos/:id/analytics', 'authors', 'Viewers, completion, hours, drop-off']
      ]
    },
    { type: 'h3', text: 'Rendering' },
    {
      type: 'p',
      text: 'A publish queues one render: Chromium draws the callouts, ffmpeg composites cuts, speed, zoom, blur and the drawings in one pass to H.264 MP4 (1080p at most), plus WebVTT captions and a poster. Each render is a Background Jobs run of kind render, and it holds the heavy job slot for its whole run. ffmpeg runs at the lowest CPU priority with a thread cap so a render never starves requests on the same server. VIDEO_RENDER_THREADS (default 2) sets the cap.'
    },
    {
      type: 'p',
      text: 'Which server renders what: a server works through the whole queue when rendering is allowed and it either ticks crons or has VIDEO_RENDER=on; any other server renders only the versions it published itself. VIDEO_RENDER=off or NIVARO_ROLE=web stops a process from rendering at all (another process picks the job up; with none, viewers of a cut that needs a render see "Getting ready" until one runs). Renders older than the current edits are deleted after 30 days.'
    },
    {
      type: 'note',
      text: 'The release image includes ffmpeg. A self-hosted install built another way needs ffmpeg on the PATH for renders and for fixing up browser recordings at upload.'
    },
    {
      type: 'warn',
      text: 'Video streams straight from local or network-mounted storage. On an S3 or Azure storage driver every byte-range request reads the whole stored object into memory before sending the requested slice, and storing a finished recording or render reads the whole file too — fine for short tutorials, but a 30-minute recording can mean a gigabyte of memory per seek. Keep help videos on local or network storage, or keep them short, until remote drivers gain ranged reads.'
    }
  ]
}

export const sdkHelpVideos: DocSection = {
  id: 'sdk-help-videos',
  label: 'Help Videos',
  content: [
    { type: 'h1', id: 'sdk-help-videos', text: 'SDK — Help Videos' },
    {
      type: 'p',
      text: 'Tutorial recordings: upload, edit, version, publish, choose where they show, require viewing and track progress. Authoring commands need an author (an administrator or a role in the author setting); reading and progress need only visibility.'
    },
    {
      type: 'pre',
      code: `import {
  openHelpVideoUpload, finalizeHelpVideoUpload, createHelpVideo,
  setHelpVideoContexts, publishHelpVideo, helpVideosFor,
} from '@nivaro/sdk'

// 1. Open an upload, send the bytes, finalize, create the video
const { data: up } = await nivaro.request(openHelpVideoUpload('video/webm'))
let part = up.next_part
for (const chunk of chunks) {
  // Raw PUT — not a Command, because Commands JSON-encode their bodies.
  await fetch(\`\${baseUrl}/api/help-videos/uploads/\${up.id}/parts/\${part++}\`, {
    method: 'PUT',
    headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/octet-stream' },
    body: chunk, // at most 8 MB per part; the response is the upload session
  })
}
await nivaro.request(finalizeHelpVideoUpload(up.id, { duration_ms }))
const { data: video } = await nivaro.request(createHelpVideo({ upload_id: up.id, title: 'Raise a PO' }))

// 2. Say where it shows, then publish
await nivaro.request(setHelpVideoContexts(video.id, [{ kind: 'page', key: 'inbox', state_key: null }]))
await nivaro.request(publishHelpVideo(video.id))

// 3. Show the right videos on a screen
const { data } = await nivaro.request(helpVideosFor({ collection: 'purchase_orders', item: 42 }))`
    },
    { type: 'h3', text: 'Response notes' },
    {
      type: 'ul',
      items: [
        '`stream_url`, `captions_url` and `poster_url` are ticketed (`?st=`): hand them to `<video>`, `<track>` and `<img>` as-is. Authors also get `draft_stream_url` and `draft_captions_url`.',
        '`published.playable` is `false` when a viewer’s stream would answer 409 (the video is still being prepared); authors always get `true`.',
        '`required` is true when the video is required for the caller’s own role. Authors also get `required_role_ids`. `my_progress` is the caller’s own progress (or `null`).',
        '`recordHelpVideoProgress` takes `buckets` as a 20-character `0`/`1` string (the 5% sections seen) and answers `{ data: { completed } }`, or no body (204) for a masquerade session.',
        '`listHelpVideos` and `helpVideosFor` carry `can_author`, so a screen can offer "Add a video" without a second call.'
      ]
    },
    { type: 'h3', text: 'Errors callers must handle' },
    {
      type: 'table',
      head: ['Status', 'code', 'When'],
      rows: [
        [
          '409',
          '`HELP_VIDEO_PROCESSING`',
          'A viewer requested `stream_url` before a current render exists and the original cannot be shown. Check `published.playable`, retry later.'
        ],
        [
          '409',
          '`HELP_VIDEO_EDITS_CONFLICT`',
          '`saveHelpVideoDraft` with a stale `base_hash`. The body carries `current_hash`; reload the draft and merge.'
        ],
        [
          '409',
          '`UPLOAD_CLOSED`',
          'The upload is already finalized or finishing; or, on discard, already used by a video or discarded.'
        ],
        ['422', '`UPLOAD_NOT_VIDEO`', 'A part is not a WebM or MP4 recording.'],
        ['422', '`UPLOAD_TOO_LONG`', 'The recording is longer than 30 minutes (on finalize).'],
        [
          '422',
          '`HELP_VIDEO_NOT_READY`',
          '`publishHelpVideo` before the checklist is done; the body lists `missing`.'
        ],
        [
          '409',
          '`HELP_VIDEO_NOTHING_TO_PUBLISH`',
          '`publishHelpVideo` with no draft, or a draft that is exactly the published version (`draft_matches_published`). With `watch_again` on a video someone must watch, it re-asks them instead.'
        ],
        [
          '422',
          '`HELP_VIDEO_EDITS_INVALID`',
          '`saveHelpVideoDraft` with edits that cannot be kept, such as cuts that leave less than a second. The message says why; the stored draft is unchanged.'
        ],
        [
          '409',
          '`HELP_VIDEO_NOTHING_TO_RENDER`',
          '`rerenderHelpVideo` for a version that does not exist.'
        ],
        ['403', '`HELP_VIDEO_AUTHOR_ONLY`', 'An authoring command by a non-author.'],
        ['404', '`HELP_VIDEO_NOT_FOUND`', 'Unknown id, or a video the caller may not see.']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['listHelpVideos(params?)', 'GET /help-videos', 'Authenticated'],
        ['readHelpVideo(id)', 'GET /help-videos/:id', 'Authenticated'],
        ['helpVideosFor(params)', 'GET /help-videos/for', 'Authenticated'],
        ['createHelpVideo(body)', 'POST /help-videos', 'Author'],
        ['updateHelpVideo(id, body)', 'PATCH /help-videos/:id', 'Author'],
        ['setHelpVideoContexts(id, contexts)', 'PUT /help-videos/:id/contexts', 'Author'],
        ['setHelpVideoRequirements(id, role_ids)', 'PUT /help-videos/:id/requirements', 'Author'],
        [
          'archiveHelpVideo(id, opts?)',
          'DELETE /help-videos/:id',
          'Author (purge: admin, archived videos only)'
        ],
        ['readHelpVideoDraft(id)', 'GET /help-videos/:id/draft/edits', 'Author'],
        ['saveHelpVideoDraft(id, edits, base_hash?)', 'PUT /help-videos/:id/draft/edits', 'Author'],
        ['publishHelpVideo(id, opts?)', 'POST /help-videos/:id/publish', 'Author'],
        ['rerecordHelpVideo(id, upload_id)', 'POST /help-videos/:id/rerecord', 'Author'],
        ['listHelpVideoVersions(id)', 'GET /help-videos/:id/versions', 'Author'],
        [
          'restoreHelpVideoVersion(id, versionId)',
          'POST /help-videos/:id/versions/:vid/restore',
          'Author'
        ],
        ['rerenderHelpVideo(id, opts?)', 'POST /help-videos/:id/render', 'Author'],
        ['recordHelpVideoProgress(id, body)', 'POST /help-videos/:id/progress', 'Authenticated'],
        ['readRequiredHelpVideos()', 'GET /help-videos/required/mine', 'Authenticated'],
        ['readHelpVideoAnalytics(id)', 'GET /help-videos/:id/analytics', 'Author'],
        ['readHelpVideoWalk(id)', 'GET /help-videos/:id/walk', 'Authenticated'],
        ['openHelpVideoUpload(mime)', 'POST /help-videos/uploads', 'Author'],
        ['finalizeHelpVideoUpload(id, meta?)', 'POST /help-videos/uploads/:id/finalize', 'Author'],
        ['listMyHelpVideoUploads()', 'GET /help-videos/uploads/mine', 'Author'],
        ['abandonHelpVideoUpload(id)', 'DELETE /help-videos/uploads/:id', 'Author'],
        ['listHelpVideoPages()', 'GET /help-videos/pages', 'Authenticated'],
        ['registerHelpVideoPage(body)', 'POST /help-videos/pages', 'Author']
      ]
    }
  ]
}

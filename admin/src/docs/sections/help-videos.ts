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
    {
      type: 'p',
      text: "Clean screen while recording (on by default, remembered per browser) keeps the author's own things out of the video: from the countdown until you stop, notification counts, the chat button and panel, toasts, banners (announcements, update and reload notices, View as) and floating chips are hidden, notification sounds stay silent, and your name, email and photo in the app's menus read Demo User. Pausing keeps the screen clean; stopping, cancelling or closing the recorder brings everything back at once. Other people's names and photos on the page are not changed — check the screen before you start, or blur in the editor."
    },
    { type: 'h3', text: 'Uploading a video file' },
    {
      type: 'p',
      text: 'Upload a video (beside Record a video, or "Upload a video" from a Videos button, which pre-fills that screen) takes an MP4, WebM or MOV made elsewhere — up to 30 minutes and 1.2 GB, the same limits as a recording. It goes through the same upload as a recording and opens the editor on a new draft. The server judges the file by its contents, never its name: it reads the streams, keeps an H.264 MP4 or a VP8/VP9 WebM as it is (an MP4 is rewritten so playback starts before the whole file loads), converts only the sound when a browser cannot play it (for example the PCM audio of many MOV files), and converts anything else — HEVC from a phone, ProRes, AV1, 10-bit video — to H.264 with AAC sound, at most 2560 pixels on the long side. Converting runs in the background at low priority and takes a few minutes for a long video; the dialog shows its progress and Cancel stops it. A file that is not a video, has no picture or cannot be read is refused with the reason. An uploaded file has no recorded clicks or microphone levels, so the editor offers no automatic click ripples or pause suggestions for it (add ripples by hand with the Ripple tool). If the connection drops, picking the same file again carries on where the upload stopped.'
    },
    { type: 'h3', text: 'Editing' },
    {
      type: 'ul',
      items: [
        'Cut: split at the playhead (S) and delete the piece; trim the ends by dragging. Silent stretches are suggested as cuts. You cannot cut everything — at least one second stays.',
        'Speed: play a piece at 1×, 1.5×, 2× or 4×.',
        'Chapters and poster: add a chapter at the playhead; choose the frame the library shows. Use this frame while the preview shows the title card or end card makes that card the poster. The library shows a new poster once the video is published and rendered.',
        'Callouts, arrows, boxes and click ripples: draw on the preview, then set the text and how long it shows. Callouts, boxes and arrows fade in and out over a fifth of a second (half their length when shorter), in the published video and in the preview while it plays; paused, they show solid so what you just drew is easy to see. "Add click ripples" places one at every click the recorder saw; a ripple from a recorded click says what was clicked (hover its bar, or select it). Each ripple makes a soft tick as it plays (one tick for ripples less than 0.08 s apart): the render mixes it into the finished sound, and the live preview plays it at the video’s volume.',
        'Jumping from the side panel (a chapter, a caption, Jump to it, Show it) offers Back to the spot you were at, with the selection you had, until you use it, close it or move the playhead on the timeline.',
        'Zoom: draw the area to zoom into; the video eases in and out.',
        'Blur: hide part of the screen (or the whole frame) for a stretch of time.',
        'Captions: type them along the timeline; viewers turn them on with CC.',
        'Intro, outro and banners: a title card before the recording (title, first line of the description and, if you like, the chapter list), an end card after it with a closing line you write, and chapter banners — each chapter’s title as a lower-third for a few seconds as it starts. Cards are 2 to 6 seconds each and add their own time; they never cover any of the recording. All three use the instance brand (name and colour from Settings, and the cards’ own logo, else the instance logo) and are off until you switch them on. Name on the cards replaces the instance name for this video only (leave it blank to keep the instance name); the logo and colour stay. The title card shows the brand at the top, the video’s length, the title and subtitle on the left and the chapters in a column on the right; the end card shows a check, what the viewer just finished and your closing line; a banner shows the chapter’s number on a tile in the brand colour with “Chapter 2 of 5” above its title. A brand colour too dark to read on the dark card is lightened automatically. Each card has an Animation (None, Subtle, Lively) for how the logo, title and lines arrive, and a Transition (Cut, Fade, Through black, Slide, Zoom, Wipe) for how the title card hands over to the recording and how the end card takes over from it; a new card starts Subtle with a Fade, and a card made before these settings keeps its still look. Transitions play inside the card’s own seconds, over the recording’s first or last frame. Chapter banners have their own Animation. Play it plays a card from its start in the preview. A card drawn with motion becomes the poster once it has finished arriving, and Show it under the poster jumps to that moment. When the cards have no logo the panel says so, and an administrator can upload one there. That logo is for the help-video cards only and is stored with the settings themselves (a PNG, JPEG, GIF, WebP or SVG of 2 MB or less), so it follows the settings to other environments; the instance logo in Settings → Project (sign-in page, sidebar) is not changed, and the cards fall back to it when they have none of their own.',
        'Background music: switch it on under Background music and pick a track from the library (Calm, Bright and Focus are generated by Nivaro, so there is nothing to license; an administrator can add more) upload a file of your own (MP3, M4A, WAV, OGG or FLAC, up to 40 MB and 20 minutes; it is converted to AAC and belongs to this video), or choose Find free music to search Openverse for public-domain (CC0) sounds and music: Listen plays the opening, + adds the track to this video. Only CC0 and public-domain tracks are offered, so no credit is needed; each imported file keeps its creator, license and a link to where it came from. The music loops for the whole video, cards included, fades in at the start and out at the end, and gets quieter while someone speaks (switch that off with Quieter while someone speaks). Volume sets its level; to change it under one part, select that piece on the timeline and choose Off, Low, Half or Full. The preview mixes the music live and lowers it on the recorded microphone levels (an uploaded video has none, so the preview plays it at one level); the published video lowers it under the actual speech. A video with music is always watched as its render, so viewers wait for the render to finish.',
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
      text: 'Publish needs a title and at least one place to show. Every published cut is kept under Versions; restoring copies an older cut into a new draft and overwrites nothing. Opening the editor makes a draft, so Publish stays off, with "No changes since the last publish" beside it, while the draft is exactly what is published. A publish queues a render on the server. Viewers get the original recording only when the cut leaves it untouched in every way that matters: no blurs, no cuts, no trim, no intro or end card, no chapter banners and no callouts or boxes (a callout is an opaque panel and the label inside a box can cover a field; arrows, ripples and zooms are drawn live). Any other video plays as the finished render, and until that render is ready viewers see "Getting ready" in the library. Authors always see their latest edits applied live.'
    },
    {
      type: 'p',
      text: 'Required for: people in those roles get an in-app notification and, if their browser is subscribed, a browser push, and see the video in My Work until they have watched most of it (18 of its 20 five-percent sections). "Ask everyone to watch again" on a later publish resets that; when nothing else changed, Publish offers only that and the video itself is not published again. Marking a video required tells real people at once, so test it with a throwaway role.'
    },
    { type: 'h3', text: 'Downloading' },
    {
      type: 'p',
      text: 'People who can watch a video can save it to their computer from Download in the player or under it: the video and, when it has captions, the captions as .vtt or .srt. They get the same file the player gives them — the finished render, or the original only when nothing in it is hidden — so a video still being rendered says it can be downloaded once it is ready. Details → Downloads turns this off for one video; authors and administrators can always download, and Versions → Download draft also offers the original recording. Every download is recorded in the activity log.'
    },
    { type: 'h3', text: 'Moving videos to another instance' },
    {
      type: 'p',
      text: 'Content Promotion → Help videos moves published videos to another instance: record and polish on staging, then bring them to production. Export packages the chosen videos (each one’s published version with its edits, chapters and captions, the recording, the render, captions and poster, and where it shows) into one file. On the other instance, Choose package uploads it, checks it and shows what applying it would do before anything is written. A video keeps its id, so a later package of the same video adds a new version there instead of a second video. Who can watch and required viewing do not travel, because role ids differ between instances: a new video arrives published but visible to authors only until someone chooses who can watch, and an updated one keeps its settings there. Screens on a collection or step that does not exist there are listed and skipped, and the render is reused when it matches the edits, otherwise the video is rendered after the import. Administrators only, on both ends.'
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
      text: 'Everything the library, editor and player do goes through /api/help-videos, and @nivaro/sdk carries a command for each route (listHelpVideos, helpVideosFor, readHelpVideo, saveHelpVideoDraft, publishHelpVideo, recordHelpVideoProgress, …). Edits are stored as instructions, not as a new video file: kept segments with speeds, chapters, annotations, zooms, blurs, captions and a poster frame, all timed in the recording’s own clock — plus, only while switched on, an `intro` card, an `outro` card and `chapter_banners`. The cards add edited time: edited time = intro + the kept pieces at their speeds + outro, so every edited position (chapter ticks, captions, progress) starts after the intro.'
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
          'Chunked upload (parts ≤ 8 MB, total ≤ 1.2 GB). A recording sends mime webm/mp4; a picked file sends source "upload" with its name and size, the first part decides its container, and finalize answers 202 while the file is checked or converted'
        ],
        [
          'GET /help-videos/uploads/:id',
          'authors',
          'One upload: status, and for a picked file its phase (checking, converting, saving), progress and, when it was refused, error and error_code'
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
          'GET /help-videos/music',
          'authors',
          'The music library: generated tracks, then any an administrator added'
        ],
        ['GET /help-videos/music/:key', 'authors', 'A library track’s audio'],
        [
          'GET · POST /help-videos/:id/music',
          'authors',
          'List or upload (multipart `file`) this video’s own music; 422 MUSIC_NOT_AUDIO / MUSIC_TOO_LONG, 413 MUSIC_TOO_LARGE'
        ],
        [
          'GET /help-videos/music/openverse?q=&page=',
          'authors',
          'Searches Openverse for CC0 / public-domain audio (the server asks; 20 per page, cached ten minutes); 429 OPENVERSE_BUSY, 502 OPENVERSE_UNREACHABLE'
        ],
        [
          'GET /help-videos/music/openverse/:trackId/preview',
          'authors',
          'The opening of an Openverse track (up to 512 KB) for Listen'
        ],
        [
          'POST /help-videos/:id/music/openverse',
          'authors',
          'Body `{openverse_id}`: imports that track as this video’s music (license re-checked on Openverse; the same track twice is kept once); 422 OPENVERSE_LICENSE'
        ],
        [
          'GET · DELETE /help-videos/:id/music/:musicId',
          'authors',
          'Play or remove an uploaded music file; 409 MUSIC_IN_USE while a version uses it'
        ],
        [
          'GET /help-videos/:id/walk',
          'viewers',
          '"Show me on this page": the published version’s labelled clicks inside kept pieces, in order — label, role, hook, page_key, path, origin, edited_ms and the nearby callout/box text. Never the draft'
        ],
        ['GET /help-videos/:id/analytics', 'authors', 'Viewers, completion, hours, drop-off'],
        [
          'GET /help-videos/:id/download?st=&file=video|captions.vtt|captions.srt',
          'signed link',
          'The file playback would give this person, as an attachment; 403 HELP_VIDEO_DOWNLOAD_OFF when downloads are off for viewers; authors may add source=1'
        ],
        [
          'GET /help-videos/:id/download-link?file=&draft=',
          'viewers',
          'A fresh ticketed download link'
        ],
        [
          'POST /help-videos/packages',
          'administrators',
          'A 10-minute link to a package (tar) of published videos'
        ],
        [
          'POST /help-videos/packages/imports, PUT …/parts/:n, POST …/preview, POST …/apply',
          'administrators',
          'Upload a package in 8 MB parts (4 GB at most; HELP_VIDEO_PACKAGE_MAX_MB), check and preview it, then apply'
        ]
      ]
    },
    { type: 'h3', text: 'Clean recording in a host app' },
    {
      type: 'p',
      text: 'While a clean recording runs, the recorder sets data-nvr-recording-clean on the html element. Anything a host app tags with data-nvr-recording-hide is hidden (data-nvr-recording-hide="keep-space" keeps its box so nothing shifts), Sonner toasts are hidden, and the shared components already tag their own counts, banners, chips and the chat panel. useCleanRecording() is true while it runs, DEMO_USER holds the stand-in name, and setRecordingSelf(userId) tells UserAvatar whose photo to replace (it falls back to ItemEditAuthContext.userId). The CSS ships in @nivaro/react\'s styles.css; a host with its own stylesheet should carry the same rules.'
    },
    { type: 'h3', text: 'Rendering' },
    {
      type: 'p',
      text: 'A publish queues one render: Chromium draws the callouts, the intro and end cards and the chapter banners (in the instance brand; a moving card is drawn frame by frame, only where something moves), ffmpeg composites cuts, speed, zoom, blur and the drawings in one pass to H.264 MP4 (1080p at most) with the cards joined before and after (silent when the recording has sound), plus WebVTT captions and a poster. A blank card title or subtitle uses the video’s title and description as they are when the render runs: renaming a video later does not re-render it. Each render is a Background Jobs run of kind render, and it holds the heavy job slot for its whole run. ffmpeg runs at the lowest CPU priority with a thread cap so a render never starves requests on the same server. VIDEO_RENDER_THREADS (default 2) sets the cap.'
    },
    {
      type: 'p',
      text: 'Which server renders what: a server works through the whole queue when rendering is allowed and it either ticks crons or has VIDEO_RENDER=on; any other server renders only the versions it published itself. VIDEO_RENDER=off or NIVARO_ROLE=web stops a process from rendering at all (another process picks the job up; with none, viewers of a cut that needs a render see "Getting ready" until one runs). Renders older than the current edits are deleted after 30 days.'
    },
    {
      type: 'note',
      text: 'The release image includes ffmpeg. A self-hosted install built another way needs ffmpeg on the PATH for renders, for fixing up browser recordings at upload, and for uploaded video files (without it, uploading a file answers 503 UPLOAD_NO_FFMPEG).'
    },
    {
      type: 'p',
      text: 'More music for the library: set HELP_VIDEO_MUSIC_DIR to a folder holding audio files and a music.json like {"tracks":[{"key":"uplift","title":"Uplift","description":"Bright and steady.","file":"uplift.mp3"}]}. Keys are lower-case words (a-z, 0-9, dashes) and may not reuse calm, bright or focus; files are plain names inside the folder (WAV, MP3, M4A, OGG or FLAC). The folder is read again every minute. Use only music you hold the rights to; CC0 tracks (for example from Freesound or Openverse with the CC0 filter) need no credit.'
    },
    {
      type: 'p',
      text: 'Find free music asks Openverse (api.openverse.org) from the server; the browser never talks to it. Set HELP_VIDEO_OPENVERSE=off on an instance without internet access or where outside downloads are not allowed. Anonymous searches are rate-limited by Openverse; OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET (registered at api.openverse.org) raise the limit.'
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
        '`listHelpVideos` and `helpVideosFor` carry `can_author`, so a screen can offer "Add a video" without a second call.',
        '`download_urls` (`video`, `captions_vtt`, `captions_srt`) are ticketed attachment links, or `null` when the caller may not download. Authors also get `allow_downloads` and `draft_download_urls`.'
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
        [
          '403',
          '`HELP_VIDEO_DOWNLOAD_OFF`',
          'A viewer asked for a download of a video whose downloads are turned off (`download_urls` is `null` then).'
        ],
        [
          '422',
          '`HELP_VIDEO_PACKAGE_INVALID`',
          'A package that is not a help-video package, is damaged or holds no usable video.'
        ],
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
        ['registerHelpVideoPage(body)', 'POST /help-videos/pages', 'Author'],
        [
          'readHelpVideoDownloadLink(id, opts?)',
          'GET /help-videos/:id/download-link',
          'Authenticated (draft: author)'
        ],
        ['exportHelpVideoPackage(ids)', 'POST /help-videos/packages', 'Admin'],
        ['openHelpVideoPackageImport()', 'POST /help-videos/packages/imports', 'Admin'],
        [
          'previewHelpVideoPackageImport(id)',
          'POST /help-videos/packages/imports/:id/preview',
          'Admin'
        ],
        [
          'applyHelpVideoPackageImport(id, video_ids?)',
          'POST /help-videos/packages/imports/:id/apply',
          'Admin'
        ],
        ['discardHelpVideoPackageImport(id)', 'DELETE /help-videos/packages/imports/:id', 'Admin']
      ]
    }
  ]
}

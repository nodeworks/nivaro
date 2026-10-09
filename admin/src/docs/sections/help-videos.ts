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
        'Cut: split at the playhead (S) and delete the piece; trim the ends by dragging. You cannot cut everything — at least one second stays.',
        'Suggested edits (the toolbar button beside the drawing tools): long pauses in the narration (3 seconds or more of quiet microphone), and on a recording of your own tab also stretches where nothing happens (no mouse, scroll or key for 3 seconds or more) and typing in a text field. Pauses and still stretches are suggested as cuts, typing as 4× so viewers still see what was entered; each row offers both, or dismiss it for this session. The recorder notes only that you typed, never what or which keys, and nothing inside an area marked .nvr-no-record. Stretches where you speak are never suggested, a cut wins where a cut and a speed-up overlap, and a stretch you have already cut or sped up leaves the list. An uploaded file, and a recording of another window or the screen, has no typing or stillness to suggest.',
        'One author at a time: opening a video in the editor takes its edit lock (the lock icon in the header — add a note for others, or release it). Anyone else who opens it sees who is editing and a read-only editor, and can ask them to wrap up, ask to be next (the lock comes to them when it frees) or, as an administrator or a role allowed to take over locks, take over. Closing the editor releases the lock, and an editor left idle past the lock idle limit lets it go. When the lock comes back to you the editor loads the latest draft; if two people still save the same draft, the save that arrives second is told and offered a reload.',
        'Speed: play a piece at 0.5× (slow motion, for a fast menu or drag), 1×, 1.5×, 2× or 4×. Narration under a slowed or sped-up piece keeps its pitch.',
        'Chapters and poster: add a chapter at the playhead; choose the frame the library shows. Use this frame while the preview shows the title card or end card makes that card the poster. The library shows a new poster once the video is published and rendered.',
        'Callouts, arrows, boxes and click ripples: draw on the preview, then set the text and how long it shows. Callouts, boxes and arrows fade in and out over a fifth of a second (half their length when shorter), in the published video and in the preview while it plays; paused, they show solid so what you just drew is easy to see. "Add click ripples" places one at every click the recorder saw; a ripple from a recorded click says what was clicked (hover its bar, or select it). Each ripple makes a soft tick as it plays (one tick for ripples less than 0.08 s apart): the render mixes it into the finished sound, and the live preview plays it at the video’s volume.',
        'Jumping from the side panel (a chapter, a caption, Jump to it, Show it) offers Back to the spot you were at, with the selection you had, until you use it, close it or move the playhead on the timeline.',
        'Steps: the Step tool draws a numbered badge, alone or with text beside it in a callout. Steps number themselves 1, 2, 3 in the order they appear and renumber when you move one; a step inside a cut has no number. Select a step to set the badge Shape (Circle, Square) and Size (Small, Medium, Large) for every step in the video.',
        'Spotlight: draw the one area to keep lit; the rest of the frame dims while it shows. Spotlights sit under every other drawing, so a callout on the dimmed part stays readable.',
        'Length from text: a new callout, step or typed-along caption stays up as long as its text takes to read (about 3 words a second, never under 2 seconds), and keeps following its text while you type, until you set its length by hand. When anything with text is shorter than that, the side panel says "Short for its text" with a one-click fix.',
        'Zoom: draw the area to zoom into; the video eases in and out.',
        'Crop: the Crop tool shows the whole recorded frame; drag over the part viewers should see (to leave out a sidebar or empty margins) for the whole video. Show the whole frame removes it. Blurs, drawings and zoom areas stay where you put them on the recording; zooms move within the cropped picture (a zoom area larger than the crop shows the whole crop). The intro card, end card and banners are full frames of the cropped size. A cropped video is always watched as its render.',
        'Blur: hide part of the screen (or the whole frame) for a stretch of time.',
        'Captions: type them along the timeline; viewers turn them on with CC.',
        'Intro, outro and banners: a title card before the recording (title, first line of the description and, if you like, the chapter list), an end card after it with a closing line you write, and chapter banners — each chapter’s title as a lower-third for a few seconds as it starts. Cards are 2 to 6 seconds each and add their own time; they never cover any of the recording. All three use the instance brand (name and colour from Settings, and the cards’ own logo, else the instance logo) and are off until you switch them on. Name on the cards replaces the instance name for this video only (leave it blank to keep the instance name); the logo and colour stay. The title card shows the brand at the top, the video’s length, the title and subtitle on the left and the chapters in a column on the right; the end card shows a check, what the viewer just finished and your closing line; a banner shows the chapter’s number on a tile in the brand colour with “Chapter 2 of 5” above its title. A brand colour too dark to read on the dark card is lightened automatically. Each card has an Animation (None, Subtle, Lively) for how the logo, title and lines arrive, and a Transition (Cut, Fade, Through black, Slide, Zoom, Wipe) for how the title card hands over to the recording and how the end card takes over from it; a new card starts Subtle with a Fade, and a card made before these settings keeps its still look. Transitions play inside the card’s own seconds, over the recording’s first or last frame. Chapter banners have their own Animation. Play it plays a card from its start in the preview. A card drawn with motion becomes the poster once it has finished arriving, and Show it under the poster jumps to that moment. When the cards have no logo the panel says so, and an administrator can upload one there. That logo is for the help-video cards only and is stored with the settings themselves (a PNG, JPEG, GIF, WebP or SVG of 2 MB or less), so it follows the settings to other environments; the instance logo in Settings → Project (sign-in page, sidebar) is not changed, and the cards fall back to it when they have none of their own.',
        'Background music: switch it on under Background music and pick a track from the library (Calm, Bright and Focus are generated by Nivaro, so there is nothing to license; an administrator can add more) upload a file of your own (MP3, M4A, WAV, OGG or FLAC, up to 40 MB and 20 minutes; it is converted to AAC and belongs to this video), or choose Find free music to search Openverse for public-domain (CC0) sounds and music: Listen plays the opening, + adds the track to this video. Only CC0 and public-domain tracks are offered, so no credit is needed; each imported file keeps its creator, license and a link to where it came from. The music loops for the whole video, cards included, fades in at the start and out at the end, and gets quieter while someone speaks (switch that off with Quieter while someone speaks). Volume sets its level; to change it under one part, select that piece on the timeline and choose Off, Low, Half or Full. The preview mixes the music live and lowers it on the recorded microphone levels (an uploaded video has none, so the preview plays it at one level); the published video lowers it under the actual speech. A video with music is always watched as its render, so viewers wait for the render to finish.',
        'Narration: switch on Improve audio to even out how loud the narration is (to about -16 LUFS) and lower background noise in the published video. The preview in the editor plays the narration as recorded; only the render carries the cleanup, so viewers wait for the render. Off by default.',
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
      text: 'Publish needs a title and at least one place to show. Every published cut is kept under Versions; restoring copies an older cut into a new draft and overwrites nothing. Opening the editor makes a draft, so Publish stays off, with "No changes since the last publish" beside it, while the draft is exactly what is published. A publish queues a render on the server. Viewers get the original recording only when the cut leaves it untouched in every way that matters: no blurs, no cuts, no trim, no intro or end card, no chapter banners, no crop and no callouts, steps or boxes (a callout is an opaque panel and the label inside a box can cover a field; arrows, ripples, spotlights and zooms are drawn live). Any other video plays as the finished render, and until that render is ready viewers see "Getting ready" in the library. Authors always see their latest edits applied live.'
    },
    {
      type: 'p',
      text: 'Required for: people in those roles get an in-app notification and, if their browser is subscribed, a browser push, and see the video in My Work until they have watched most of it (18 of its 20 five-percent sections). "Ask everyone to watch again" on a later publish resets that; when nothing else changed, Publish offers only that and the video itself is not published again. Marking a video required tells real people at once, so test it with a throwaway role.'
    },
    { type: 'h3', text: 'Telling viewers what changed' },
    {
      type: 'p',
      text: 'When you publish changes to a video people have already watched, Publish asks "What changed?" (optional, up to 500 characters). Anyone who watched an earlier version sees that note above the player — "Updated since you watched it" — with Jump to what changed, which starts at the chapter the first change falls in (or a couple of seconds before it when there are no chapters). A re-recorded video says so and has no jump: watch it from the start. "Ask everyone to watch again" carries the same note into the notification ("What changed: …") and shows it to the people asked; with nothing else to publish, the note is saved on the version already published. People who are required to watch also see the note in My Work.'
    },
    {
      type: 'p',
      text: 'How the first change is found, comparing the version they watched with the published one: a different recording changes the whole video; otherwise the earliest of — the intro card or background music changing (the start), the first kept piece that differs in start, end, speed or music level, any caption, chapter, callout, arrow, box, ripple, zoom or blur added, removed or changed (at its start; one inside a cut counts from the next kept moment), chapter banners switched on or off (the first chapter), and the end card (where it starts). Moving only the poster is not a change viewers see. The note disappears once the person watches the new version.'
    },
    { type: 'h3', text: 'Links to a moment' },
    {
      type: 'p',
      text: 'Copy link under the player copies a link to the video at the current time, at the chapter playing now, or from the start. A link is the videos page with ?watch=<video id>&t=<whole seconds>, and a chapter link adds &c=<chapter id>; when both are present the chapter wins if it still exists, otherwise the time is used. Paste one into chat and it shows a card with the poster, title, length and where it starts — but only for people who can watch that video (the card is built for each reader with the same check as the library); everyone else sees the plain link. A card opens the video in the reader’s own app, whichever app the link was copied from.'
    },
    { type: 'h3', text: 'Captions and transcripts' },
    {
      type: 'p',
      text: 'The settings button beside CC in the player sets caption size (Small to Largest), background (None, Shaded, Solid) and position (bottom or top). The choice is saved for the person and applies to every video. When a video has captions, Download offers a Transcript (.txt): the title, then every caption with its time under a heading for each chapter. Anyone who can watch the video can download the transcript, even when Downloads is turned off for the video file, and each transcript download is recorded in the activity log like other downloads.'
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
    { type: 'h3', text: 'Ask AI answers with a video' },
    {
      type: 'p',
      text: 'Ask AI searches the videos the person asking may watch — published videos only, by the same who-can-watch rules as the library — when a question is about how to do something in the app. It looks in titles, chapter names, the captions and descriptions, best matches first (title, then chapter, then caption, then description), and cites a video as a link such as "Watch 0:42 of How to submit to warehouse" that opens the player at that moment. A draft or a video the person may not watch is never offered. Extensions can ship starter videos of their own (see Extension Development → Help videos).'
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
      text: 'Everything the library, editor and player do goes through /api/help-videos, and @nivaro/sdk carries a command for each route (listHelpVideos, helpVideosFor, readHelpVideo, saveHelpVideoDraft, publishHelpVideo, recordHelpVideoProgress, …). Edits are stored as instructions, not as a new video file: kept segments with speeds, chapters, annotations, zooms, blurs, captions and a poster frame, all timed in the recording’s own clock — plus, only while switched on, an `intro` card, an `outro` card and `chapter_banners`, and only when set, a `crop` rect (fractions of the recorded frame) and a `step_style` ({shape, size}, absent = circle, medium). Speeds are 0.5, 1, 1.5, 2 or 4; annotation types are callout, step, arrow, box, spotlight and ripple. The cards add edited time: edited time = intro + the kept pieces at their speeds + outro, so every edited position (chapter ticks, captions, progress) starts after the intro.'
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
          'One video; authors also get the draft, visibility and required roles. whats_new (kind updated | again, note, jump_ms, chapter, whole) says what changed since this person last watched; transcript_url is the ticketed transcript'
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
          'Chunked upload (parts ≤ 8 MB, total ≤ 1.2 GB). A recording sends mime webm/mp4; a picked file sends source "upload" with its name and size, the first part decides its container, and finalize answers 202 while the file is checked or converted. A recording’s finalize may carry `activity`: `[{ kind: "typing" | "idle", start_ms, end_ms }]` (only that it happened, never what was typed; checked, merged and capped at 1,000 spans); GET …/draft/edits returns it as `activity`'
        ],
        [
          'GET · POST · DELETE /item-locks/nivaro_help_videos/:id/lock (+ /heartbeat, /lock/request, /lock/queue, /lock/force)',
          'authors',
          'The editor’s lock: the record lock routes under the name nivaro_help_videos, gated by the help-video author check (404 for an id that is not a uuid). No other nivaro_ or directus_ table can be locked (403)'
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
          'Publish the draft; watch_again resets required viewing; note (≤ 500 characters) is what changed, shown to people who watched an earlier version and sent with watch_again'
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
          'GET /help-videos/:id/transcript.txt?st=',
          'signed link',
          'Plain-text transcript (captions under chapter headings) for anyone who can watch; not gated by Downloads; 404 HELP_VIDEO_NO_CAPTIONS. The video’s transcript_url carries it'
        ],
        [
          'GET /help-videos/:id/download-link?file=&draft=',
          'viewers',
          'A fresh ticketed download link'
        ],
        [
          'GET · PATCH /help-videos/settings',
          'administrators',
          'Render settings: `{encoder: {preset, crf, two_pass_over_minutes, hardware}}`, with where each value comes from and the hardware encoders this server can use (`?fresh=1` checks again). A key set to null goes back to the environment / default; 409 HELP_VIDEO_SETTINGS_MIGRATION_PENDING before migration 410'
        ],
        [
          'GET /help-videos/house-style',
          'authors',
          'The house style: `{migrated, house_style, is_default, defaults}`. The editor uses it for new callouts and for Apply house style'
        ],
        [
          'PATCH /help-videos/house-style',
          'administrators',
          'Body `{house_style}`: an object is merged over the stored style (every bad key is named, 400), null goes back to the standard look. 409 HELP_VIDEO_SETTINGS_MIGRATION_PENDING before migration 410'
        ],
        [
          'GET /help-videos/render-queue',
          'administrators',
          'Renders running and waiting: place in the queue, progress, encoder, and estimates from past renders'
        ],
        [
          'POST /help-videos/render-queue/:versionId/cancel',
          'administrators',
          'Cancel a waiting or running render; the version stays on live playback. 409 HELP_VIDEO_RENDER_NOT_ACTIVE when it is not queued or rendering'
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
      text: 'A publish queues one render: Chromium draws the callouts, the intro and end cards and the chapter banners (in the instance brand; a moving card is drawn frame by frame, only where something moves), ffmpeg composites blur and the drawings on the whole recorded frame, then the crop, zoom, cuts and speed in one pass (a cropped video comes out at the cropped size, the recording scaled so it is at most 1080p and never enlarged) to H.264 MP4 (1080p at most) with the cards joined before and after (silent when the recording has sound), plus WebVTT captions and a poster. A blank card title or subtitle uses the video’s title and description as they are when the render runs: renaming a video later does not re-render it. Each render is a Background Jobs run of kind render, and it holds the heavy job slot for its whole run. ffmpeg runs at the lowest CPU priority with a thread cap so a render never starves requests on the same server. VIDEO_RENDER_THREADS (default 2) sets the cap.'
    },
    {
      type: 'p',
      text: 'Which server renders what: a server works through the whole queue when rendering is allowed and it either ticks crons or has VIDEO_RENDER=on; any other server renders only the versions it published itself. VIDEO_RENDER=off or NIVARO_ROLE=web stops a process from rendering at all (another process picks the job up; with none, viewers of a cut that needs a render see "Getting ready" until one runs). Renders older than the current edits are deleted after 30 days.'
    },
    { type: 'h3', text: 'Render settings' },
    {
      type: 'p',
      text: "Videos → Render settings (administrators) chooses how renders are encoded. Quality is the x264 CRF (16–32, default 23; lower is sharper and larger) and Speed the x264 preset (default veryfast). Two-pass encoding, for videos longer than a set number of minutes, aims at a bitrate worked out from Quality and keeps a long video's file size steady; it takes about twice as long. Use a hardware encoder turns on VideoToolbox (macOS) or VAAPI (Linux, /dev/dri) when the server has one that works: each server checks once, with a one-frame test encode. Hardware encoders have no presets and no CRF: VideoToolbox gets a bitrate worked out from Quality (about 4.4 Mbit/s for 1080p at 23), VAAPI runs constant QP at the Quality number. If a hardware encode fails, the video is encoded again in software and that encoder is skipped for an hour on that server. The defaults are the encode every earlier version used (software, veryfast, 23)."
    },
    {
      type: 'p',
      text: 'Each value can also come from the server environment, used when the setting is not set: HELP_VIDEO_ENCODER_PRESET, HELP_VIDEO_ENCODER_CRF, HELP_VIDEO_TWO_PASS_OVER_MINUTES, HELP_VIDEO_HARDWARE_ENCODER (off or auto). HELP_VIDEO_VAAPI_DEVICE names the VAAPI device (default /dev/dri/renderD128).'
    },
    { type: 'h3', text: 'House style' },
    {
      type: 'p',
      text: "Videos → House style (administrators) sets the look every new video starts from: the colour new callouts, steps, boxes and arrows start in, the text size in callouts, boxes and steps, the step badge shape and size, how captions look, an intro card (length, a list of chapters, motion and transition; it shows the video's own title and description), an end card (length, text, motion and transition) and Improve audio. A video gets these when it is created, from a recording or an uploaded file. A video that already exists keeps its own choices: nothing changes it until an author opens it in the editor and presses Apply house style (the House style section in the right-hand column), which lists exactly what will change first and is one undo step. Applying never removes a card the house style leaves off, and keeps any card text the video already has. Before migration 410 the house style is the standard look and cannot be saved."
    },
    {
      type: 'p',
      text: "Two of these are per-video settings an author can also change by hand: Text size in the Inspector for a callout, box or step (it sizes the text in all of them), and Caption look under Captions. The caption look is what viewers see until they choose their own in the player; a viewer's own choice wins, setting by setting."
    },
    { type: 'h3', text: 'The render queue' },
    {
      type: 'p',
      text: 'Background Jobs lists help-video renders while there are any: the one rendering with its progress and encoder, the ones waiting in the order they will run, and when each should be done, estimated from the median render time per minute of recording over recent renders. Cancel stops a render at once (ffmpeg and the card drawing are stopped, and the next render can start) or takes a waiting one off the queue. The version keeps playing with its edits applied live and its status says it was cancelled; nothing queues it again on its own. An author queues it again with Render again in the editor. A render running on another server stops within a few seconds.'
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanPrimitives, stripComments } from './slim-parity-scan.js'

// Slim parity guard. EFP web runs the slim image (no Chromium, no ffmpeg); a
// media or browser call that runs on it fails for people. Every call site of
// a primitive that needs one of those binaries (and of the local-only entry
// points built on them) must be in a module listed here, with how it stays
// off a slim process, and the number of call sites must match: a new one,
// even in a listed module, fails until someone has looked at where it runs.

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../..')

type Role =
  /** The primitive itself, or a wrapper that hands work to the render peer
   *  when the binary is not here. */
  | 'binary'
  /** Runs only on the render peer (a full-image process), behind its token. */
  | 'peer-side'
  /** Runs only where the binary is: a slim process hands the job to the
   *  media worker or never claims it. `guards` prove the check is there. */
  | 'worker-only'
  /** Local when the binary is here, else the same work on the render peer. */
  | 'local-or-peer'
  /** Spawns something both images lack or share alike (no slim difference). */
  | 'not-media'

interface Reviewed {
  calls: Record<string, number>
  role: Role
  why: string
  /** Patterns that must stay in the module: the check that keeps it off slim. */
  guards?: RegExp[]
}

const REVIEWED: Record<string, Reviewed> = {
  'services/ffmpeg.ts': {
    role: 'binary',
    calls: { probeVideoLocal: 2, probeStreamsLocal: 1, remuxToFileLocal: 2, child_process: 1 },
    why: 'The ffmpeg wrappers: probeVideo / probeStreams / remuxToFile / remuxAndProbe go to the render peer when there is no local ffmpeg.',
    guards: [/async function delegate\(\)/, /peerFileOp\('remux'/]
  },
  'services/pdf-layout.ts': {
    role: 'binary',
    calls: {
      getBrowser: 2,
      htmlToPdfLocal: 1,
      htmlToPngLocal: 1,
      'puppeteer.launch': 1,
      'import puppeteer': 2
    },
    why: 'Chromium itself: htmlToPdf and htmlToPng (the MCP form image, #3216) go to the render peer without a local Chromium; getBrowser refuses with RENDER_UNAVAILABLE.',
    guards: [/peerHtmlToPdf\(/, /peerHtmlToPng\(/, /throw renderUnavailable\('pdf'\)/]
  },
  'routes/internal-render.ts': {
    role: 'peer-side',
    calls: {
      probeVideoLocal: 2,
      probeStreamsLocal: 1,
      remuxToFileLocal: 1,
      htmlToPdfLocal: 1,
      htmlToPngLocal: 1,
      pdfPageImagesLocal: 1,
      convertUploadedFile: 1,
      convertMusicFile: 1,
      detectHardwareEncoders: 1
    },
    why: 'The render peer routes: run on the full image only, refuse 503 without the binary.',
    guards: [/hasLocalChromium\(\)\)\)\s*return refuse/, /hasFfmpeg\(\)\)\)\s*return refuse/]
  },
  'services/help-video-render.ts': {
    role: 'worker-only',
    calls: {
      runFfmpeg: 2,
      captureCards: 1,
      rasterizeAnnotations: 1,
      renderOne: 1,
      musicForRender: 1
    },
    why: 'The help-video render queue (cards, annotations, music, encode): the slim image never takes a row (renderingAllowed).',
    guards: [/imageVariant\(\) === 'slim'\) return false/, /kickMediaWorker\('render'\)/]
  },
  'services/help-video-cards.ts': {
    role: 'worker-only',
    calls: { getBrowser: 1 },
    why: 'Card frames for a render: called only by help-video-render.ts (captureCards, counted there).'
  },
  'services/help-video-annotations.ts': {
    role: 'worker-only',
    calls: { getBrowser: 1 },
    why: 'Annotation overlays for a render: called only by help-video-render.ts (rasterizeAnnotations, counted there).'
  },
  'services/help-video-clips.ts': {
    role: 'worker-only',
    calls: { runFfmpeg: 1, renderClip: 1 },
    why: 'Clips: createClip hands the id to the media worker without ffmpeg; renderClip never claims a row without ffmpeg.',
    guards: [
      /mediaPlacement\('clip'\)/,
      /handOff\('clip'/,
      /if \(!\(await hasFfmpeg\(\)\)\) return 'skipped'/
    ]
  },
  'services/help-video-captions.ts': {
    role: 'worker-only',
    calls: { runFfmpeg: 1, child_process: 1, processCaptionJob: 1 },
    why: 'Generated captions: startCaptionJob hands the job to the media worker without ffmpeg. The spawn is the optional local Whisper command (in neither image).',
    guards: [/mediaPlacement\('captions'\)/, /handOff\('captions'/]
  },
  'services/help-video-extras.ts': {
    role: 'worker-only',
    calls: { runFfmpeg: 2, buildMediaExtras: 2 },
    why: 'Upload thumbnails and waveform: startMediaExtras hands the ids to the media worker without ffmpeg.',
    guards: [
      /mediaPlacement\('extras'\)/,
      /handOff\('extras'/,
      /if \(!\(await hasFfmpeg\(\)\)\) return null/
    ]
  },
  'services/session-replay-export.ts': {
    role: 'worker-only',
    calls: { getBrowser: 1, captureWithPuppeteer: 1, runWebmExport: 1 },
    why: 'Session-replay WebM: enqueueWebmExport hands the job to the media worker without ffmpeg and Chromium.',
    guards: [
      /mediaPlacement\('replay-webm'\)/,
      /handOff\('replay-webm'/,
      /canRunHere\('replay-webm'\)/
    ]
  },
  'services/pdf-pages.ts': {
    role: 'local-or-peer',
    calls: { getBrowser: 1, pdfPageImagesLocal: 1 },
    why: 'PDF pages as pictures (#3186 paper forms): drawn here with Chromium, else on the render peer (pdf-pages).',
    guards: [/peerPdfPages\(pdf/, /throw renderUnavailable\('pdf'\)/]
  },
  'services/help-video-encoder.ts': {
    role: 'local-or-peer',
    calls: { ffmpegOutput: 2, detectHardwareEncoders: 2 },
    why: 'Encoder report: renderHostEncoders asks the render peer without local ffmpeg; detection itself stops without ffmpeg.',
    guards: [/peerEncoders</, /if \(!\(await hasFfmpeg\(\)\)\) return report/]
  },
  'services/help-video-music.ts': {
    role: 'local-or-peer',
    calls: { runFfmpeg: 1, probeVideoLocal: 2, convertMusicFile: 1 },
    why: "Music: an author's file converts here with ffmpeg, else on the render peer (convert-music).",
    guards: [
      /\(await hasFfmpeg\(\)\)\s*\?\s*await convertMusicFile/,
      /peerFileOp<MusicProbe>\('convert-music'/
    ]
  },
  'services/help-video-uploads.ts': {
    role: 'local-or-peer',
    calls: { runFfmpeg: 1, probeVideoLocal: 1, probeStreamsLocal: 1, convertUploadedFile: 1 },
    why: 'A picked file converts here with ffmpeg, else on the render peer (convert-upload); recordings remux via remuxAndProbe.',
    guards: [
      /if \(await hasFfmpeg\(\)\) \{\s*converted = await convertUploadedFile/,
      /peerFileOp<ConvertedUpload>\('convert-upload'/
    ]
  },
  'services/document-extract.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'pdftotext (poppler) for document text, with a JS fallback: neither image ships it.'
  },
  'services/staged-imports.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'smbclient for share drops: the same in both images.'
  },
  'services/release-runs.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'Release tooling (local dev only): node scripts, ps, curl.'
  },
  'services/runbook-runs.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'Host runbooks run by the runbook agent on the host, not in the image.'
  },
  'scripts/runbook-agent.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'The host-side runbook agent (not run in the image).'
  },
  'scripts/dead-columns-check.ts': {
    role: 'not-media',
    calls: { child_process: 1 },
    why: 'A developer script (git grep).'
  }
}

const HOW =
  'The slim image (EFP web) has no ffmpeg or Chromium. Route the work through the render peer ' +
  '(services/render-peer.ts) when a request waits on the result, or hand it to the media worker ' +
  '(services/media-handoff.ts: mediaPlacement + handOff) when it is an artefact made in the ' +
  'background; then add or update the entry in REVIEWED (slim-parity-guard.test.ts) with how it ' +
  'stays off a slim process.'

describe('slim parity guard', () => {
  const found = scanPrimitives(SRC)

  it('finds the primitives at all (the scanner works)', () => {
    expect(found['services/ffmpeg.ts']?.child_process).toBe(1)
    expect(found['services/pdf-layout.ts']?.['puppeteer.launch']).toBe(1)
  })

  it('every media or browser call site is in a reviewed module', () => {
    const unreviewed = Object.entries(found)
      .filter(([file]) => !REVIEWED[file])
      .map(([file, calls]) => `${file}: ${Object.keys(calls).join(', ')}`)
    expect(
      unreviewed,
      `Unreviewed media/browser call sites:\n${unreviewed.join('\n')}\n\n${HOW}`
    ).toEqual([])
  })

  it('no reviewed module gained or lost a call site unseen', () => {
    const drift: string[] = []
    for (const [file, r] of Object.entries(REVIEWED)) {
      const have = found[file] ?? {}
      for (const name of new Set([...Object.keys(have), ...Object.keys(r.calls)])) {
        if ((have[name] ?? 0) !== (r.calls[name] ?? 0))
          drift.push(
            `${file}: ${name} has ${have[name] ?? 0} call site(s), reviewed ${r.calls[name] ?? 0}`
          )
      }
    }
    expect(drift, `${drift.join('\n')}\n\nLook at where each new call runs on EFP. ${HOW}`).toEqual(
      []
    )
  })

  it('each worker-only and local-or-peer module keeps the check that keeps it off slim', () => {
    const missing: string[] = []
    for (const [file, r] of Object.entries(REVIEWED)) {
      if (!r.guards) continue
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'))
      for (const g of r.guards) if (!g.test(code)) missing.push(`${file}: ${g}`)
    }
    expect(missing, `A slim-safety check is gone:\n${missing.join('\n')}\n\n${HOW}`).toEqual([])
  })
})

import type { DocSection } from '../types.js'

export const releaseImageDocs: DocSection = {
  id: 'release-image',
  label: 'Release image',
  content: [
    { type: 'h1', id: 'release-image', text: 'Release image' },
    {
      type: 'p',
      text: 'Nivaro ships as one Docker image that holds the API and the admin app: `nodeworks/nivaro:<version>`. A second, smaller image, `nodeworks/nivaro:<version>-slim`, leaves out Chromium and ffmpeg. Both are built from `Dockerfile.release` for amd64 and arm64, and both are signed.'
    },
    {
      type: 'table',
      head: ['Image', 'Build target', 'What it has'],
      rows: [
        [
          '`nodeworks/nivaro:<v>` (and `latest`)',
          '`runner` (the default)',
          'Everything. Makes PDFs and help videos itself.'
        ],
        [
          '`nodeworks/nivaro:<v>-slim` (and `latest-slim`)',
          '`runner-slim`',
          'No Chromium, no ffmpeg, no fonts (about 800 MB smaller). Sends that work to a render server, see below.'
        ]
      ]
    },
    { type: 'h2', id: 'release-image-user', text: 'Runs as uid 1000, not root' },
    {
      type: 'p',
      text: 'The API, Chromium and ffmpeg run as the `node` user (uid 1000, gid 1000). The image owns `/app/uploads` and `/app/work` as that user, so a new named volume mounted on them gets the right owner the first time.'
    },
    {
      type: 'warn',
      text: 'A volume made by an image older than 0.3.5 (which ran as root), a bind mount or an NFS share keeps its owner. Make it writable for uid 1000 once, for example `docker run --rm -v nivaro_uploads:/app/uploads alpine chown -R 1000:1000 /app/uploads`. Until then the container logs "/app/uploads is not writable by uid 1000" at start and uploads fail.'
    },
    { type: 'h2', id: 'release-image-paths', text: 'What it writes (read-only root filesystem)' },
    {
      type: 'p',
      text: 'The process writes only to the three paths below, so you can run it with a read-only root filesystem (`read_only: true`, `docker run --read-only`).'
    },
    {
      type: 'table',
      head: ['Path', 'What goes there', 'Mount'],
      rows: [
        ['`/app/uploads`', 'Stored files (local storage driver).', 'A volume. Keep it.'],
        [
          '`/app/work`',
          '`TMPDIR=/app/work/tmp`: scratch files, help-video uploads in progress, renders and the music cache (VIDEO_WORK_DIR defaults here), heap snapshots, Chromium profiles, render-server inputs. `HOME=/app/work/home`: font and browser caches.',
          'A volume, or a tmpfs owned by uid 1000 (`--tmpfs /app/work:uid=1000,gid=1000`). The entrypoint creates `tmp` and `home` when they are missing.'
        ],
        ['`/tmp`', 'Anything a library writes there directly.', 'A tmpfs.']
      ]
    },
    {
      type: 'note',
      text: 'Installing, enabling or disabling an extension from the admin writes to `/app/api/extensions`. On a read-only root that fails unless the extensions folder is mounted writable. Deployments that mount their extensions read-only manage them outside the app.'
    },
    { type: 'h2', id: 'release-image-tini', text: 'tini as PID 1' },
    {
      type: 'p',
      text: 'The entrypoint is `["/sbin/tini", "--", "/app/docker-entrypoint.sh"]` and the command is `node api/dist/index.js`. tini passes SIGTERM to the API, so `docker stop` runs the API drain, and it cleans up Chromium and ffmpeg processes left behind by a crash. If you override the command (for example `sh -c "...; exec node api/dist/index.js"`), the entrypoint still runs first.'
    },
    { type: 'h2', id: 'release-image-health', text: 'Health check' },
    {
      type: 'p',
      text: 'The image has a HEALTHCHECK, so plain `docker run` and Compose show a health status too. It checks liveness only: `/app/healthcheck.sh` calls `GET /api/version` with busybox wget every 30 seconds (5 second timeout, 3 retries). The 150 second start period covers migrations at boot. In cloud mode it calls `/api/ready`, which needs no tenant. `NIVARO_HEALTHCHECK_PATH` changes the path. Readiness for traffic is a separate question; use `/api/ready` for that.'
    },
    { type: 'h2', id: 'release-image-heap', text: 'Node heap from the memory limit' },
    {
      type: 'p',
      text: 'Node 22 sets its heap to about half of the container memory limit (measured: 524 MB at 1 GB, 1328 MB at 2.5 GB) and cannot change it after it starts. At start, the entrypoint reads the limit (cgroup v2 `/sys/fs/cgroup/memory.max`, otherwise cgroup v1 `/sys/fs/cgroup/memory/memory.limit_in_bytes`) and adds `--max-old-space-size=<75% of the limit in MB>` to `NODE_OPTIONS`. For example, a 2560 MB limit gives 1920 and a 1536 MB limit gives 1152.'
    },
    {
      type: 'ul',
      items: [
        'Nothing is added when there is no limit (`max`, the cgroup v1 "unlimited" value, or more than the host has), when the limit is under 256 MB, or when `NODE_OPTIONS` already sets `--max-old-space-size`.',
        '`NIVARO_HEAP_FROM_CGROUP=off` turns it off.',
        '`NODE_OPTIONS` is exported, so a node process started by a wrapper command gets the flag too.'
      ]
    },
    { type: 'h2', id: 'release-image-slim', text: 'The slim image and the render server' },
    {
      type: 'p',
      text: 'A slim process has no Chromium and no ffmpeg. When `RENDER_URL` is set, it sends PDFs, video probes, recording remuxes, uploaded-video conversions and music conversions to that process. The answers are the same as when the work runs locally. Without `RENDER_URL`, that work fails with a 503 that says what is missing.'
    },
    {
      type: 'table',
      head: ['Setting', 'Where', 'What it does'],
      rows: [
        [
          '`RENDER_URL`',
          'Slim processes',
          'Address of a full process, with no path, for example `http://nivaro_worker:3055`. Use an internal network only.'
        ],
        [
          '`RENDER_TOKEN`',
          'Both sides',
          'Shared secret, sent as `Authorization: Bearer <token>`. On the full process it turns on the render routes; without it they do not exist. `RENDER_TOKEN_FILE` and /run/secrets work as for every secret.'
        ],
        [
          '`RENDER_PEER_CLOUD=on`',
          'Full process, cloud mode',
          'In cloud mode the render routes stay off unless this is also set.'
        ],
        [
          '`NIVARO_IMAGE_VARIANT`',
          'Set by the image',
          '`slim` or `full`. A slim process never takes help-video renders from the queue.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Some work stays with a process that has the binaries: help-video renders (VIDEO_RENDER and NIVARO_ROLE decide which process renders), clips, captions, thumbnails and waveforms, and video exports of session recordings. Run at least one full process with `VIDEO_RENDER=on` beside slim web processes. A full process renders locally even when `RENDER_URL` is set.'
    },
    {
      type: 'p',
      text: 'The render routes are under `/api/internal/render/` and are not part of the public API. `GET /api/internal/render/health` (with the bearer) answers `{ ok, chromium, ffmpeg, version }`. A wrong or missing token gets 401. The routes are left out of the API log, the Traffic Map, the rate limit and the maintenance freeze. On a slim process, `/api/preflight` (check `render`) and the readiness check `render-peer` report whether the render server answers.'
    },
    { type: 'h2', id: 'release-image-verify', text: 'Verify the signature' },
    {
      type: 'p',
      text: 'Every release image is signed with cosign keyless signing (GitHub OIDC, Sigstore) by its digest, both the multi-arch index the tag points to and each platform image. Verify the digest you deploy:'
    },
    {
      type: 'pre',
      code: `cosign verify nodeworks/nivaro@sha256:<digest> \\
  --certificate-identity-regexp '^https://github.com/nodeworks/nivaro/.github/workflows/docker-hub.yml@refs/tags/' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com`
    },
    {
      type: 'p',
      text: 'The signing certificate names the workflow file and the release tag (`refs/tags/@app-<version>`). Images built by a manual workflow run carry a branch ref and do not pass this check.'
    }
  ]
}

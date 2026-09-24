/**
 * When this build of @nivaro/shared was made. The source always says null;
 * `pnpm build` (scripts/stamp-build.mjs) rewrites only dist/build-info.js with
 * the build time, so a dev admin can tell it is running a stale copy of the
 * shared code (the dev API reports the stamp on disk). A bare `tsc` leaves it
 * null = unknown, which never warns.
 */
export const SHARED_BUILT_AT: string | null = null

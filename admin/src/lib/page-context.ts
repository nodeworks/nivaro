/**
 * Page-context headers (Traffic Map #1113 / #1116). The one implementation lives in
 * packages/shared (it ships to SDK hosts); imported by path because admin's typecheck reads the
 * BUILT shared package, which only carries it after the next shared build.
 */

export {
  clientVersion,
  setClientBuild
} from '../../../packages/shared/src/lib/client-version'
export {
  installPageContextFetch,
  pageContextHeaders,
  pagePattern
} from '../../../packages/shared/src/lib/page-context'

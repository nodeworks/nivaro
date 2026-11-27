/**
 * Every EAS GraphQL document the Expo adapter sends, as plain strings (no Apollo, no codegen).
 * https://api.expo.dev/graphql
 *
 * CERTAINTY: the shapes below follow what the public eas-cli generates against the schema.
 * They were written without a live account, so any name marked UNVERIFIED must be confirmed on a
 * throwaway Expo account before release (the spec's "one live check per provider"). All of the
 * adapter's schema knowledge lives in this one file so a correction touches nothing else.
 */

/** Robot or user: who the token is and which accounts it reaches. `meActor` is used by `eas whoami`. */
export const Q_WHOAMI = `query HubWhoami {
  meActor { __typename id accounts { id name } }
}`

/** An account by name (id is needed to create an app). */
export const Q_ACCOUNT = `query HubAccount($name: String!) {
  account { byName(accountName: $name) { id name } }
}`

/** UNVERIFIED: Account.apps(offset, limit) — older schemas call it `apps`, newer `appsPaginated`. */
export const Q_ACCOUNT_APPS = `query HubAccountApps($name: String!, $offset: Int!, $limit: Int!) {
  account { byName(accountName: $name) { id apps(offset: $offset, limit: $limit) { id slug name fullName privacy } } }
}`

export const Q_APP_BY_ID = `query HubAppById($id: String!) {
  app { byId(appId: $id) { id slug name fullName privacy } }
}`

export const Q_APP_BY_FULL_NAME = `query HubAppByFullName($fullName: String!) {
  app { byFullName(fullName: $fullName) { id slug name fullName privacy } }
}`

/** UNVERIFIED: AppInput field names (accountId, projectName, privacy). */
export const M_CREATE_APP = `mutation HubCreateApp($input: AppInput!) {
  app { createApp(appInput: $input) { id slug name fullName privacy } }
}`

/** UNVERIFIED: the delete mutation for an app (eas-cli: scheduleAppDeletion). */
export const M_DELETE_APP = `mutation HubDeleteApp($id: ID!) {
  app { scheduleAppDeletion(appId: $id) { id } }
}`

export const Q_BRANCHES = `query HubBranches($appId: String!, $offset: Int!, $limit: Int!) {
  app { byId(appId: $appId) { id updateBranches(offset: $offset, limit: $limit) { id name } } }
}`

export const M_CREATE_BRANCH = `mutation HubCreateBranch($appId: ID!, $name: String!) {
  updateBranch { createUpdateBranchForApp(appId: $appId, name: $name) { id name } }
}`

export const M_DELETE_BRANCH = `mutation HubDeleteBranch($id: ID!) {
  updateBranch { deleteUpdateBranch(branchId: $id) { id } }
}`

/** branchMapping is a JSON string: {"version":0,"data":[{"branchId":"…","branchMappingLogic":"true"}]}. */
export const Q_CHANNELS = `query HubChannels($appId: String!, $offset: Int!, $limit: Int!) {
  app { byId(appId: $appId) { id updateChannels(offset: $offset, limit: $limit) { id name branchMapping } } }
}`

export const M_CREATE_CHANNEL = `mutation HubCreateChannel($appId: ID!, $name: String!, $branchMapping: String) {
  updateChannel { createUpdateChannelForApp(appId: $appId, name: $name, branchMapping: $branchMapping) { id name branchMapping } }
}`

/** The "point at branch" write. */
export const M_POINT_CHANNEL = `mutation HubPointChannel($id: ID!, $branchMapping: String!) {
  updateChannel { editUpdateChannel(channelId: $id, branchMapping: $branchMapping) { id name branchMapping } }
}`

export const M_DELETE_CHANNEL = `mutation HubDeleteChannel($id: ID!) {
  updateChannel { deleteUpdateChannel(channelId: $id) { id } }
}`

/** UNVERIFIED: `environmentVariables` arguments on App and the returned fields. */
export const Q_ENV_VARS = `query HubEnvVars($appId: String!) {
  app { byId(appId: $appId) { id environmentVariables { id name visibility environments } } }
}`

export const M_CREATE_ENV_VAR = `mutation HubCreateEnvVar($appId: ID!, $input: CreateEnvironmentVariableInput!) {
  environmentVariable { createEnvironmentVariableForApp(appId: $appId, environmentVariableData: $input) { id name visibility environments } }
}`

export const M_UPDATE_ENV_VAR = `mutation HubUpdateEnvVar($input: UpdateEnvironmentVariableInput!) {
  environmentVariable { updateEnvironmentVariable(environmentVariableData: $input) { id name visibility environments } }
}`

export const M_DELETE_ENV_VAR = `mutation HubDeleteEnvVar($id: ID!) {
  environmentVariable { deleteEnvironmentVariable(id: $id) { id } }
}`

/** UNVERIFIED: builds by id and their fields (platform, status, buildProfile, gitCommitHash). */
export const Q_BUILD = `query HubBuild($id: ID!) {
  builds { byId(buildId: $id) { id status platform buildProfile gitCommitHash app { id } } }
}`

export const Q_BUILDS = `query HubBuilds($appId: String!, $offset: Int!, $limit: Int!) {
  app { byId(appId: $appId) { id builds(offset: $offset, limit: $limit) { id status platform buildProfile gitCommitHash } } }
}`

/**
 * UNVERIFIED and likely to need replacing: EAS starts a build from an uploaded project archive
 * (`createAndroidBuild` / `createIosBuild` after a source upload), which is eas-cli's job. This
 * document is the one place a Hub-side trigger plugs in (a GitHub-linked build or a workflow run).
 */
export const M_TRIGGER_BUILD = `mutation HubTriggerBuild($appId: ID!, $platform: AppPlatform!, $profile: String!, $gitRef: String) {
  build { triggerBuildFromGit(appId: $appId, platform: $platform, buildProfile: $profile, gitRef: $gitRef) { id status platform buildProfile } }
}`

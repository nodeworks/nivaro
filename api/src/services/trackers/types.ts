export interface RemoteIssue {
  id: number
  iid: number
  project_id: number
  web_url: string
  title: string
  state: 'opened' | 'closed'
  labels: string[]
  assignees: Array<{ id: number; username: string; name: string }>
  milestone: { id: number; title: string } | null
  updated_at: string
  description: string | null
}

export interface RemoteNote {
  id: number
  body: string
  author: { username: string; name: string }
  created_at: string
  system: boolean
  /** An internal (confidential) note: project members only in GitLab — never mirrored. */
  internal?: boolean
}

export interface CreateIssueInput {
  title: string
  description: string
  labels?: string[]
  assignee_ids?: number[]
  milestone_id?: number
  due_date?: string
  weight?: number
  confidential?: boolean
  issue_type?: 'issue' | 'incident'
}

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: 'auth' | 'not_found' | 'rate' | 'server' | 'network' | 'invalid'
  ) {
    super(message)
    this.name = 'TrackerError'
  }
}

export interface TrackerProvider {
  whoami(): Promise<{ username: string; name: string }>
  project(
    idOrPath: string | number
  ): Promise<{ id: number; path_with_namespace: string; access_level: number | null }>
  searchProjects(q: string): Promise<Array<{ id: number; path_with_namespace: string }>>
  searchUsers(
    q: string,
    projectId: number
  ): Promise<Array<{ id: number; username: string; name: string }>>
  createIssue(projectId: number, input: CreateIssueInput): Promise<RemoteIssue>
  getIssue(projectId: number, iid: number): Promise<RemoteIssue>
  findIssueByMarker(projectId: number, marker: string): Promise<RemoteIssue | null>
  updatedIssues(projectId: number, since: Date): Promise<RemoteIssue[]>
  setState(projectId: number, iid: number, state: 'close' | 'reopen'): Promise<RemoteIssue>
  /** Add and remove labels in one call (GitLab creates unknown added labels). */
  setLabels(projectId: number, iid: number, add: string[], remove: string[]): Promise<RemoteIssue>
  /** The project's labels (group labels included), at most 500. */
  listLabels(
    projectId: number
  ): Promise<Array<{ name: string; color: string; description: string | null }>>
  /** Open issues whose title matches `q`, at most 20. */
  searchOpenIssues(projectId: number, q: string): Promise<RemoteIssue[]>
  addNote(projectId: number, iid: number, body: string): Promise<RemoteNote>
  notes(projectId: number, iid: number, since?: Date): Promise<RemoteNote[]>
  upload(
    projectId: number,
    file: { name: string; mime: string; data: Buffer }
  ): Promise<{ markdown: string }>
}

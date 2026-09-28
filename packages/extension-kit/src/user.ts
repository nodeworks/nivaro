/**
 * The person an extension is handed — on a hook context, an integrity fix,
 * a chat-bot tool call. The API's own `User` row carries more (tokens, key
 * scopes); everything here is what an extension may reasonably read, and the
 * API's row is assignable to it.
 */
export interface ExtensionUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  role: string | null
  status: 'active' | 'inactive' | 'suspended'
  /** NULL = a person; else integration | bot | service | placeholder. */
  account_kind?: 'integration' | 'bot' | 'service' | 'placeholder' | null
  title?: string | null
  phone?: string | null
  department?: string | null
  company?: string | null
  manager_id: string | null
  delegate_id: string | null
  delegate_expires_at: Date | null
  is_out_of_office: boolean
  preferences: Record<string, unknown> | null
  current_workspace: string | null
}

/** Stand-in until Task 1's real file merges: the built-in phone app client and its sign-in switch. */
export interface MobileClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

export function mobileSignInEnabled(): boolean {
  return (process.env.MOBILE_SIGNIN ?? '').trim().toLowerCase() !== 'off'
}

export function mobileClients(): MobileClient[] {
  return [
    {
      client_id: 'nivaro-mobile',
      client_name: 'Nivaro',
      redirect_uris: ['dev.nivaro.app:/oauth/callback']
    }
  ]
}

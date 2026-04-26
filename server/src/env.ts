export type AppBindings = CloudflareBindings & {
  CLIENT_ID: string
  CLIENT_SECRET: string
  /** HMAC secret for `setSignedCookie` / `getSignedCookie` (e.g. 32+ byte random string) */
  SESSION_SECRET: string
}

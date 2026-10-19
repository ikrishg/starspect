import { decrypt, encrypt } from './auth'

export const formatStoredGitHubToken = (encrypted: Awaited<ReturnType<typeof encrypt>>) =>
  `${encrypted.iv}.${encrypted.data}`

export const encryptGitHubToken = async (token: string, secret: string) => {
  const encrypted = await encrypt(token, secret)
  return formatStoredGitHubToken(encrypted)
}

export const decryptGitHubToken = async (stored: string, secret: string) => {
  const separator = stored.indexOf('.')
  if (separator === -1) {
    return stored
  }

  const iv = stored.slice(0, separator)
  const data = stored.slice(separator + 1)
  return decrypt({ iv, data }, secret)
}

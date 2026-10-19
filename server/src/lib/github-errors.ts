import { RequestError } from '@octokit/request-error'

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }

  const record = headers as Record<string, string | string[] | undefined>
  const direct = record[name] ?? record[name.toLowerCase()]
  if (typeof direct === 'string') {
    return direct
  }
  if (Array.isArray(direct)) {
    return direct[0]
  }

  const getter = (headers as { get?: (key: string) => string | null }).get
  if (typeof getter === 'function') {
    const value = getter(name)
    return value ?? undefined
  }

  return undefined
}

const bodyMentionsRateLimit = (error: RequestError): boolean => {
  const data = error.response?.data
  if (typeof data === 'string') {
    return data.toLowerCase().includes('rate limit')
  }
  if (data && typeof data === 'object') {
    return JSON.stringify(data).toLowerCase().includes('rate limit')
  }
  return error.message.toLowerCase().includes('rate limit')
}

/** True when GitHub signals an API rate limit (not e.g. a disabled repo 403). */
export const isGitHubRateLimitResponse = (error: unknown): boolean => {
  if (!(error instanceof RequestError)) {
    return false
  }

  if (error.status !== 403 && error.status !== 429) {
    return false
  }

  const headers = error.response?.headers
  const remaining = headerValue(headers, 'x-ratelimit-remaining')
  if (remaining === '0') {
    return true
  }

  if (headerValue(headers, 'retry-after')) {
    return true
  }

  return bodyMentionsRateLimit(error)
}

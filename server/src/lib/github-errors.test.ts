import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@octokit/request-error'
import { isGitHubRateLimitResponse } from './github-errors'

const requestError = (
  status: number,
  headers: Record<string, string> = {},
  message = 'error',
) =>
  new RequestError(message, status, {
    request: { method: 'GET', url: 'https://api.github.com/users/x', headers: {} },
    response: { status, headers, url: 'https://api.github.com/users/x', data: {} },
  })

describe('isGitHubRateLimitResponse', () => {
  it('detects x-ratelimit-remaining 0', () => {
    assert.equal(
      isGitHubRateLimitResponse(
        requestError(403, { 'x-ratelimit-remaining': '0' }),
      ),
      true,
    )
  })

  it('detects retry-after', () => {
    assert.equal(
      isGitHubRateLimitResponse(requestError(429, { 'retry-after': '60' })),
      true,
    )
  })

  it('treats other 403 responses as not rate limits', () => {
    assert.equal(
      isGitHubRateLimitResponse(
        requestError(403, {}, 'Repository access blocked'),
      ),
      false,
    )
  })
})

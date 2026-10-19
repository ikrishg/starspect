import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGithubRepository, validateGithubOwner, validateGithubRepo } from './github-names'

describe('validateGithubRepo', () => {
  it('rejects . and ..', () => {
    assert.equal(validateGithubRepo('.'), false)
    assert.equal(validateGithubRepo('..'), false)
  })

  it('rejects path traversal tricks', () => {
    assert.equal(validateGithubRepo('../secrets'), false)
    assert.equal(validateGithubRepo('foo/bar'), false)
  })
})

describe('validateGithubOwner', () => {
  it('rejects owners that do not match GitHub rules', () => {
    assert.equal(validateGithubOwner('-bad'), false)
    assert.equal(validateGithubOwner('owner/repo'), false)
  })
})

describe('normalizeGithubRepository', () => {
  it('lowercases owner and repo for cache keys', () => {
    const result = normalizeGithubRepository('Octo-Org', 'My-Repo')
    assert.ok(!('error' in result))
    if ('error' in result) {
      return
    }
    assert.equal(result.owner, 'octo-org')
    assert.equal(result.repo, 'my-repo')
    assert.equal(result.cacheKey, 'octo-org/my-repo')
  })

  it('rejects dot-only repo names', () => {
    const result = normalizeGithubRepository('octocat', '.')
    assert.ok('error' in result)
  })
})

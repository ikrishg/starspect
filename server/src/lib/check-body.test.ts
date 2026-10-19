import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCheckBody } from './check-body'

describe('parseCheckBody', () => {
  it('rejects null', () => {
    const result = parseCheckBody(null)
    assert.equal(result.ok, false)
  })

  it('rejects non-string owner or repo', () => {
    assert.equal(parseCheckBody({ owner: 123, repo: 'x' }).ok, false)
    assert.equal(parseCheckBody({ owner: 'o', repo: 1 }).ok, false)
  })

  it('accepts string owner and repo', () => {
    const result = parseCheckBody({ owner: 'octo', repo: 'hello' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.value, { owner: 'octo', repo: 'hello' })
    }
  })
})

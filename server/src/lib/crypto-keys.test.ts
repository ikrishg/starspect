import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSessionCryptoKey, getTokenCryptoKey } from './crypto-keys'

const validSecret = () => btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))
const otherValidSecret = () => btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))

describe('crypto-keys', () => {
  it('validates secret length on every derivation', async () => {
    const bad = btoa('short')
    await assert.rejects(() => getSessionCryptoKey(bad))
  })

  it('caches keys per secret value', async () => {
    const a1 = await getSessionCryptoKey(validSecret())
    const a2 = await getSessionCryptoKey(validSecret())
    const b = await getTokenCryptoKey(otherValidSecret())
    assert.equal(a1, a2)
    assert.notEqual(a1, b)
  })
})

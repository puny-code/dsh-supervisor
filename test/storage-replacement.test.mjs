import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

test('storage service replacement reopens all domains on the new facility', async () => {
  const calls = []
  function facility(label) {
    return { async open(spec) {
      calls.push(`${label}:${spec.name}`)
      return { global: { get: () => ({}) }, table: () => ({ keys: () => [] }), close: async () => {} }
    } }
  }
  let active = facility('old')
  const ctx = { get: name => name === 'storageDomain' ? active : undefined }
  await __internals.healthOf(ctx)
  active = facility('new')
  await __internals.healthOf(ctx)
  assert.equal(calls.filter(x => x.startsWith('new:')).length, 4)
})

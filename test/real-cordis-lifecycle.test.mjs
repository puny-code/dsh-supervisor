import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as supervisor from '../index.js'

// Prefer this project's dependency; the second location is a locally installed
// workspace copy. Neither path relies on the Desktop app.asar archive.
const resolvers = [createRequire(import.meta.url), createRequire(new URL('../../fork-work/dsh-search-index/package.json', import.meta.url))]
let cordisPath
for (const require of resolvers) {
  try { cordisPath = require.resolve('cordis'); break } catch {}
}
const cordis = cordisPath ? await import(pathToFileURL(cordisPath)) : null

async function until(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

test('real Cordis: late connection, removal, re-registration and plugin unload', { skip: !cordis && 'local cordis package unavailable' }, async t => {
  const ctx = new cordis.Context()
  const tools = new Map()
  const routes = new Map()
  let registrations = 0
  let unregistrations = 0
  const offTools = ctx.provide('tools', { register(tool) {
    tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  } })
  const fiber = ctx.plugin(supervisor)
  let offConnection
  t.after(async () => {
    await fiber.dispose()
    if (offConnection) await offConnection()
    await offTools()
  })
  await until(() => tools.has('supervisor'), 'supervisor tool did not register')
  assert.equal(routes.size, 0)

  const connection = { fetch: { register(route) {
    assert.equal(routes.has(route.path), false, 'duplicate route')
    registrations++
    routes.set(route.path, route)
    return () => { unregistrations++; routes.delete(route.path) }
  } } }
  const path = '/api/dsh-supervisor/rpc'
  offConnection = ctx.provide('connection', connection)
  await until(() => routes.has(path), 'late connection did not register route')
  const response = await routes.get(path).fetch(new Request('http://localhost' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'beacon', payload: { stage: 'test' } }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, value: null })
  await offConnection()
  offConnection = undefined
  await until(() => !routes.has(path), 'removing connection did not remove route')
  assert.equal(tools.has('supervisor'), true)
  offConnection = ctx.provide('connection', connection)
  await until(() => routes.has(path), 're-registered connection did not restore route')
  assert.equal(registrations, 2)
  assert.equal(unregistrations, 1)
  await fiber.dispose()
  assert.equal(routes.has(path), false, 'unload did not remove route')
  assert.equal(tools.has('supervisor'), false, 'unload did not unregister tool')
  assert.equal(unregistrations, 2)
})

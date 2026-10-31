import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// A small Cordis lifecycle double: effects are scoped and injected children
// start when all their dependencies become available, then dispose with parent.
function fakeContext() {
  const services = new Map()
  const tools = new Map()
  const children = []
  const effects = []
  const routes = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) { return services.get(name) },
    on() { return () => {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    inject(dependencies, callback) {
      const child = { dependencies, callback, started: false, effects: [] }
      children.push(child)
      start(child)
      return { dispose: async () => disposeChild(child) }
    },
  }
  function start(child) {
    if (child.started || !child.dependencies.every((name) => services.has(name))) return
    child.started = true
    const scoped = { ...ctx, effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') child.effects.push(dispose)
      return dispose
    } }
    const dispose = child.callback(scoped)
    if (typeof dispose === 'function') child.effects.push(dispose)
  }
  async function disposeChild(child) {
    for (const dispose of child.effects.splice(0).reverse()) await dispose()
  }
  return {
    ctx, tools, routes,
    provideConnection() {
      services.set('connection', {
        fetch: { register(route) {
          assert.equal(routes.has(route.path), false, 'route registered twice')
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        } },
        rpc: { handle() { return async () => {} } },
      })
      for (const child of children) start(child)
    },
    async dispose() {
      for (const child of children.slice().reverse()) await disposeChild(child)
      for (const dispose of effects.splice(0).reverse()) await dispose()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('late connection registers HTTP RPC, serves JSON POST, and unregisters on unload', async (t) => {
  const host = fakeContext()
  t.after(() => host.dispose())
  apply(host.ctx)
  assert.equal(host.routes.has('/api/dsh-supervisor/rpc'), false)
  host.provideConnection()
  const route = host.routes.get('/api/dsh-supervisor/rpc')
  assert.ok(route, 'late connection must register the HTTP RPC route')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  const response = await route.fetch(new Request('http://localhost/api/dsh-supervisor/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'beacon', payload: { stage: 'test', detail: 'hello' } }),
  }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json\b/)
  assert.deepEqual(await response.json(), { ok: true, value: null })
  await host.dispose()
  assert.equal(host.routes.has('/api/dsh-supervisor/rpc'), false, 'unload removes the route')
})

test('tool remains available without connection and is removed on unload', async (t) => {
  const host = fakeContext()
  t.after(() => host.dispose())
  apply(host.ctx)
  assert.equal(typeof host.tools.get('supervisor')?.execute, 'function')
  await host.dispose()
  assert.equal(host.tools.has('supervisor'), false)
})

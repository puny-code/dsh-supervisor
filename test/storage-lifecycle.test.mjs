import test from 'node:test'
import assert from 'node:assert/strict'

let serial = 0
async function fresh() {
  return import(`../index.js?storage-lifecycle=${++serial}`)
}
const names = ['supervisor', 'supervisor_settings', 'supervisor_sessions', 'supervisor_workspaces']
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function facility({ fail = new Set(), gate, closeGate } = {}) {
  const calls = []
  const closed = []
  const domains = Object.fromEntries(names.map((name) => [name, {
    global: { get: () => ({ budgetMigrated: true }), set: async () => {} },
    table: () => ({ keys: () => [] }),
    close: async () => { closed.push(name); if (closeGate) await closeGate.promise },
  }]))
  return {
    calls, closed, fail, domains,
    async open(spec) {
      calls.push(spec.name)
      if (gate && spec.name === names[0]) await gate.promise
      if (fail.has(spec.name)) throw new Error(`open ${spec.name} failed`)
      return domains[spec.name]
    },
  }
}
function context(getFacility) {
  let dispose
  const ctx = {
    get: (name) => name === 'storageDomain' ? getFacility() : undefined,
    on: () => () => {},
    inject: () => ({ dispose: async () => {} }),
    tools: { register: () => () => {} },
    effect: (fn) => { dispose = fn() },
  }
  return { ctx, dispose: () => dispose() }
}

test('service missing then restored is retried', async () => {
  const { __internals } = await fresh()
  const store = facility()
  let active
  const { ctx } = context(() => active)
  assert.equal((await __internals.healthOf(ctx)).storage.available, false)
  active = store
  assert.equal((await __internals.healthOf(ctx)).storage.available, true)
  assert.deepEqual(store.calls, names)
})

test('retry a failed domain without reopening successful domains', async () => {
  const { __internals } = await fresh()
  const store = facility({ fail: new Set(['supervisor_workspaces']) })
  const { ctx } = context(() => store)
  const first = await __internals.healthOf(ctx)
  assert.equal(first.storage.tables.counters, undefined)
  store.fail.clear()
  const second = await __internals.healthOf(ctx)
  assert.equal(second.storage.tables.counters, 0)
  assert.deepEqual(store.calls, [...names, 'supervisor_workspaces'])
})

test('concurrent callers open each domain only once', async () => {
  const { __internals } = await fresh()
  const gate = deferred()
  const store = facility({ gate })
  const { ctx } = context(() => store)
  const requests = Array.from({ length: 8 }, () => __internals.healthOf(ctx))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(store.calls, ['supervisor'])
  gate.resolve()
  const results = await Promise.all(requests)
  assert.ok(results.every((result) => result.storage.available))
  assert.deepEqual(store.calls, names)
})

test('unload closes all four domains', async () => {
  const { apply, __internals } = await fresh()
  const closeGate = deferred()
  const store = facility({ closeGate })
  const harness = context(() => store)
  apply(harness.ctx)
  await __internals.healthOf(harness.ctx)
  const disposing = Promise.resolve(harness.dispose())
  await new Promise((resolve) => setImmediate(resolve))
  try {
    assert.deepEqual([...store.closed].sort(), [...names].sort())
  } finally {
    closeGate.resolve()
    await disposing
  }
})

test('old context cannot reopen storage after unload', async () => {
  const { apply, __internals } = await fresh()
  const store = facility()
  const harness = context(() => store)
  apply(harness.ctx)
  await __internals.healthOf(harness.ctx)
  await harness.dispose()
  const count = store.calls.length
  assert.equal((await __internals.healthOf(harness.ctx)).storage.available, false)
  assert.equal(store.calls.length, count)
})

test('new generation does not reuse old storage while route disposal waits', async () => {
  const { apply, __internals } = await fresh()
  const routeGate = deferred()
  const store = facility()
  const old = context(() => store)
  old.ctx.inject = () => ({ dispose: () => routeGate.promise })
  apply(old.ctx)
  await __internals.healthOf(old.ctx)
  const oldDisposing = old.dispose()
  const newer = context(() => store)
  apply(newer.ctx)
  const health = __internals.healthOf(newer.ctx)
  await new Promise(resolve => setImmediate(resolve))
  routeGate.resolve()
  await oldDisposing
  await health
  assert.equal(store.calls.length, 8, 'new generation must open its own four domains')
  await newer.dispose()
})

test('pending old open closes before a new generation opens its facility', async () => {
  const { apply, __internals } = await fresh()
  const gate = deferred()
  const oldStore = facility({ gate })
  const newStore = facility()
  const old = context(() => oldStore)
  apply(old.ctx)
  await new Promise(resolve => setImmediate(resolve))
  const disposing = old.dispose()
  const newer = context(() => newStore)
  apply(newer.ctx)
  const health = __internals.healthOf(newer.ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(newStore.calls.length, 0)
  gate.resolve()
  await disposing
  assert.equal((await health).storage.available, true)
  assert.deepEqual([...oldStore.closed].sort(), [...names].sort())
  assert.deepEqual(newStore.calls, names)
  await newer.dispose()
})

test('unload waits for asynchronous domain closes', async () => {
  const { apply, __internals } = await fresh()
  const closeGate = deferred()
  const store = facility({ closeGate })
  const harness = context(() => store)
  apply(harness.ctx)
  await __internals.healthOf(harness.ctx)
  let finished = false
  const disposing = Promise.resolve(harness.dispose()).then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  try {
    assert.equal(finished, false, 'disposer must wait for close promises')
  } finally {
    closeGate.resolve()
    await disposing
  }
})

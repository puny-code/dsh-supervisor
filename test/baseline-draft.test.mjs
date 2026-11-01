import test from 'node:test'
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { draftBaseline, markSessionEngaged, ensureBaseline } = __internals

function memTable() {
  const rows = new Map()
  return {
    get: (k) => rows.get(String(k)),
    put: async (k, v) => { rows.set(String(k), v) },
    entries: function* () { yield* rows.entries() },
    keys: function* () { yield* rows.keys() },
  }
}
function fakeFacility() {
  const tables = {}
  const name = (n) => (tables[n] ||= memTable())
  return {
    tables,
    async open(spec) {
      return {
        global: { get: () => ({ budgetMigrated: true }), set: async () => {} },
        table: name,
        close: async () => {},
      }
    },
  }
}
function ctxFor(facility) {
  return { get: (n) => (n === 'storageDomain' ? facility : undefined) }
}

test('draftBaseline turns the requirement ledger into baseline fields', () => {
  const facility = fakeFacility()
  const domain = { table: (n) => facility.tables[n] || (facility.tables[n] = memTable()) }
  const rows = [
    { reqId: 'a', workspaceId: 'ws', kind: 'goal', strength: 'hard', status: 'active', text: '做出天监独立页' },
    { reqId: 'b', workspaceId: 'ws', kind: 'constraint', strength: 'hard', status: 'active', text: '不要引入新依赖' },
    { reqId: 'c', workspaceId: 'ws', kind: 'constraint', strength: 'soft', status: 'active', text: '界面贴近 DSH 风格' },
    { reqId: 'd', workspaceId: 'ws', kind: 'direction', strength: 'hard', status: 'active', text: '用 React.createElement' },
    { reqId: 'e', workspaceId: 'ws', kind: 'goal', strength: 'hard', status: 'revoked', text: '已撤销的要求' },
  ]
  for (const row of rows) facility.tables.requirements = facility.tables.requirements || memTable()
  facility.tables.requirements = memTable()
  for (const row of rows) facility.tables.requirements.put(row.reqId, row)

  const draft = draftBaseline({}, { domain, workspaceId: 'ws', sessionId: '' })
  assert.deepEqual(draft.goals, ['做出天监独立页'])
  assert.deepEqual(draft.constraints.hard, ['不要引入新依赖'])
  assert.deepEqual(draft.constraints.soft, ['界面贴近 DSH 风格'])
  assert.deepEqual(draft.directions, ['用 React.createElement'])
  assert.equal(draft.intent, '做出天监独立页')
  assert.equal(draft.sources.requirements, 4)
})

test('project start auto-creates the first baseline from the user request', async () => {
  const facility = fakeFacility()
  const domain = { table: (n) => facility.tables[n] || (facility.tables[n] = memTable()) }
  facility.tables.requirements = memTable()
  facility.tables.requirements.put('r1', { reqId: 'r1', workspaceId: 'ws', kind: 'goal', strength: 'hard', status: 'active', text: '做一个天监工作台' })
  facility.tables.requirements.put('r2', { reqId: 'r2', workspaceId: 'ws', kind: 'constraint', strength: 'hard', status: 'active', text: '不要引入新依赖' })

  const first = await ensureBaseline({}, { domain, workspaceId: 'ws', sessionId: '' })
  assert.equal(first.created, true)
  assert.equal(first.baseline.revision, 1)
  assert.equal(first.baseline.source, 'auto')
  assert.deepEqual(first.baseline.goals, ['做一个天监工作台'])

  const second = await ensureBaseline({}, { domain, workspaceId: 'ws', sessionId: '' })
  assert.equal(second.created, false)
  assert.equal(second.baseline.revision, 1, 'existing baseline must not be rewritten')
})

test('no material means no baseline is invented', async () => {
  const facility = fakeFacility()
  const domain = { table: (n) => facility.tables[n] || (facility.tables[n] = memTable()) }
  facility.tables.requirements = memTable()
  const result = await ensureBaseline({}, { domain, workspaceId: 'empty-ws', sessionId: '' })
  assert.equal(result.created, false)
  assert.equal(result.baseline, null)
})

test('calling the supervisor engages a session that never chose a preference', async () => {
  const facility = fakeFacility()
  const ctx = ctxFor(facility)
  assert.equal(await markSessionEngaged(ctx, 'session-1'), true)
  const prefs = facility.tables.supervisor_sessions || facility.tables.prefs
  assert.equal(prefs.get('session-1').enabled, true)
})

test('an explicit disable is never overridden by a later tool call', async () => {
  const facility = fakeFacility()
  const ctx = ctxFor(facility)
  await markSessionEngaged(ctx, 'session-2')
  const sessionsTable = facility.tables.supervisor_sessions || facility.tables.prefs
  await sessionsTable.put('session-2', { enabled: false, viewedReviewId: '', updatedAt: 'x' })
  assert.equal(await markSessionEngaged(ctx, 'session-2'), false)
  assert.equal(sessionsTable.get('session-2').enabled, false)
})

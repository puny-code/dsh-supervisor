/**
 * 天监 (dsh-supervisor) — Host half of the plugin.
 *
 * v0.2 wires the two foundations the whole design rests on:
 *   1. a persistent storage domain (authoritative baseline / reviews / journal),
 *   2. one multi-action `supervisor` tool the builder agent calls at stage
 *      boundaries, and that the future UI reads through.
 *
 * The review engine (evidence packet, 司天 assembler, 观天 child agent) lands in
 * later batches; until then `report` records the stage and returns a pending
 * review, so the storage + tool contract can be exercised end to end.
 *
 * Note: this module deliberately imports nothing but Node builtins. The plugin
 * lives outside the profile and is symlinked in, so bare-specifier resolution
 * for third-party packages is unreliable; a tiny local validator replaces zod.
 */

import { createHash } from 'node:crypto'

export const name = 'dsh-supervisor'

/** The tool registry is a hard dependency: without it this plugin does nothing. */
export const inject = ['tools']

/** Reported by `health` and the UI footer; keep in step with package.json. */
const SUPERVISOR_VERSION = 'v1.4.7'

// ---------------------------------------------------------------------------
// Minimal structural validator (the only thing the storage domain needs from
// zod is `parse` / `safeParse`, so a ~70 line stand-in keeps us dependency-free)
// ---------------------------------------------------------------------------

const MISSING = Symbol('missing')

function fail(message) {
  const err = new Error(message)
  err.issues = [{ message }]
  throw err
}

const F = {
  str: (dflt) => ({ kind: 'str', dflt }),
  num: (dflt) => ({ kind: 'num', dflt }),
  int: (dflt) => ({ kind: 'int', dflt }),
  bool: (dflt) => ({ kind: 'bool', dflt }),
  any: (dflt) => ({ kind: 'any', dflt }),
  arr: (inner, dflt) => ({ kind: 'arr', inner, dflt }),
  obj: (shape, dflt) => ({ kind: 'obj', shape, dflt }),
  enumOf: (values, dflt) => ({ kind: 'enum', values, dflt }),
}

function coerce(spec, value, path) {
  if (value === undefined || value === null) {
    if (spec.dflt !== undefined) return typeof spec.dflt === 'function' ? spec.dflt() : spec.dflt
    return MISSING
  }
  switch (spec.kind) {
    case 'str':
      if (typeof value !== 'string') fail(`${path} must be a string`)
      return value
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a number`)
      return value
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${path} must be an integer`)
      return value
    case 'bool':
      if (typeof value !== 'boolean') fail(`${path} must be a boolean`)
      return value
    case 'enum':
      if (!spec.values.includes(value)) fail(`${path} must be one of ${spec.values.join(', ')}`)
      return value
    case 'arr': {
      if (!Array.isArray(value)) fail(`${path} must be an array`)
      return value.map((item, i) => {
        const out = coerce(spec.inner, item, `${path}[${i}]`)
        if (out === MISSING) fail(`${path}[${i}] is invalid`)
        return out
      })
    }
    case 'obj': {
      if (typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`)
      return build(spec.shape, value, path)
    }
    case 'any':
      return value
    default:
      return value
  }
}

function build(shape, value, path = 'value') {
  const src = value && typeof value === 'object' ? value : {}
  const out = {}
  for (const key of Object.keys(shape)) {
    const result = coerce(shape[key], src[key], path ? `${path}.${key}` : key)
    if (result === MISSING) fail(`${path}.${key} is required`)
    out[key] = result
  }
  return out
}

function schema(shape) {
  return {
    parse(value) {
      return build(shape, value)
    },
    safeParse(value) {
      try {
        return { success: true, data: build(shape, value) }
      } catch (err) {
        return { success: false, error: { message: String(err && err.message), issues: err.issues ?? [] } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Storage domain declaration
// ---------------------------------------------------------------------------

const DOMAIN_NAME = 'supervisor'
const DOMAIN_VERSION = 1

const BASELINE = schema({
  workspaceId: F.str(),
  revision: F.int(0),
  intent: F.str(''),
  goals: F.arr(F.str(), () => []),
  constraints: F.obj(
    { hard: F.arr(F.str(), () => []), soft: F.arr(F.str(), () => []) },
    () => ({ hard: [], soft: [] }),
  ),
  directions: F.arr(F.str(), () => []),
  decisions: F.arr(F.obj({ at: F.str(), text: F.str() }), () => []),
  createdAt: F.str(),
  updatedAt: F.str(),
})

const REVIEW = schema({
  reviewId: F.str(),
  workspaceId: F.str(),
  sessionId: F.str(''),
  stageSeq: F.int(0),
  createdAt: F.str(),
  verdict: F.enumOf(['pending', 'aligned', 'minor', 'drift', 'critical'], 'pending'),
  summary: F.str(''),
  findings: F.arr(F.obj({ kind: F.str(), severity: F.str(), detail: F.str() }), () => []),
  suggestion: F.str(''),
  blocking: F.bool(false),
  engine: F.enumOf(['light', 'full', 'handover'], 'light'),
  handover: F.bool(false),
  model: F.str(''),
  modelSource: F.str(''),
  upgradeReason: F.str(''),
  durationMs: F.int(0),
  tokens: F.int(0),
  supersedes: F.str(''),
})

const STAGE_REPORT = schema({
  reportId: F.str(),
  workspaceId: F.str(),
  sessionId: F.str(''),
  stageSeq: F.int(0),
  submittedAt: F.str(),
  claim: F.str(''),
  touched: F.arr(F.str(), () => []),
  reviewId: F.str(''),
  trigger: F.obj({ kind: F.str(''), at: F.str(''), by: F.str('') }, () => ({ kind: '', at: '', by: '' })),
  evidence: F.any(null),
})

const JOURNAL_ENTRY = schema({
  seq: F.int(0),
  ts: F.str(),
  type: F.str(),
  payload: F.any(null),
  prevHash: F.str(''),
  hash: F.str(),
})

const COUNTER_SHAPE = {
  lastReviewAt: F.str(''),
  reviewCount: F.int(0),
  criticalCount: F.int(0),
  driftStreak: F.int(0),
  lastStageSeq: F.int(0),
  lastAutoReviewAt: F.str(''),
  lastInterruptAt: F.str(''),
  pendingNotice: F.any(null),
  lastAck: F.any(null),
}

const COUNTERS = schema(COUNTER_SHAPE)

const DEFAULT_COUNTERS = {
  lastReviewAt: '',
  reviewCount: 0,
  criticalCount: 0,
  driftStreak: 0,
  lastStageSeq: 0,
  lastAutoReviewAt: '',
  lastInterruptAt: '',
  pendingNotice: null,
  lastAck: null,
}

/**
 * Session-scoped counters. 严重偏移 / 连续偏移是会话级的：谁的会话偏了，
 * 就记在谁的账上、打断谁——A 会话的烂账不再记到 B 会话头上。
 * Per-record layout: a new table needs no domain version bump.
 */
const SESSION_COUNTERS = schema({
  workspaceId: F.str(''),
  sessionId: F.str(''),
  ...COUNTER_SHAPE,
})

const SESSION_BASELINE = schema({
  scope: F.enumOf(['session'], 'session'),
  sessionId: F.str(),
  workspaceId: F.str(''),
  revision: F.int(1),
  intent: F.str(''),
  goals: F.arr(F.str(), () => []),
  constraints: F.obj(
    { hard: F.arr(F.str(), () => []), soft: F.arr(F.str(), () => []) },
    () => ({ hard: [], soft: [] }),
  ),
  directions: F.arr(F.str(), () => []),
  decisions: F.arr(F.obj({ at: F.str(), text: F.str() }), () => []),
  createdAt: F.str(),
  updatedAt: F.str(),
})

const TRANSCRIPT = schema({
  reviewId: F.str(),
  sessionId: F.str(''),
  workspaceId: F.str(''),
  stageSeq: F.int(0),
  createdAt: F.str(),
  engine: F.enumOf(['light', 'full', 'handover'], 'light'),
  model: F.str(''),
  // 司天 brief == everything 观天 was handed; the raw passes below are its thinking.
  brief: F.str(''),
  assembleNotes: F.str(''),
  assemble: F.any(null),
  baselineRevision: F.int(0),
  lightRaw: F.str(''),
  deepAnalysisRaw: F.str(''),
  deepVerifyRaw: F.str(''),
  verdict: F.str(''),
  modelSource: F.str(''),
  upgradeReason: F.str(''),
  durationMs: F.int(0),
  evidenceStructured: F.any(null),
  notes: F.str(''),
})

/**
 * P1 · 用户要求台账. One row per requirement the user actually stated, so a
 * requirement that appeared three stages ago is still visible to 观天 after the
 * per-stage evidence window has moved on.
 *
 * Per-record layout: adding a table needs no version bump (first write
 * materializes the file); only changing an EXISTING table's schema would.
 */
const REQUIREMENT = schema({
  reqId: F.str(),
  workspaceId: F.str(''),
  sessionId: F.str(''),
  text: F.str(''),
  kind: F.enumOf(['goal', 'constraint', 'direction', 'preference'], 'goal'),
  strength: F.enumOf(['hard', 'soft'], 'hard'),
  status: F.enumOf(['active', 'superseded', 'revoked'], 'active'),
  sourceSeq: F.int(0),
  sourceQuote: F.str(''),
  turn: F.int(0),
  at: F.str(''),
  origin: F.enumOf(['extract', 'review', 'both'], 'extract'),
  supersedes: F.str(''),
})

const WORKSPACES_SPEC = {
  name: 'supervisor_workspaces',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    counters: { valueSchema: COUNTERS },
    session_counters: { valueSchema: SESSION_COUNTERS },
    session_baselines: { valueSchema: SESSION_BASELINE },
    transcripts: { valueSchema: TRANSCRIPT },
  },
}

const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: { schema: COUNTERS, initial: DEFAULT_COUNTERS },
  tables: {
    baselines: { valueSchema: BASELINE },
    reviews: { valueSchema: REVIEW },
    reports: { valueSchema: STAGE_REPORT },
    journal: { valueSchema: JOURNAL_ENTRY },
    requirements: { valueSchema: REQUIREMENT },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERDICT_TEXT = {
  pending: '待审',
  aligned: '对齐',
  minor: '轻微调整',
  drift: '存在偏移',
  critical: '严重偏移',
}

const ACTIONS = [
  'status',
  'baseline_set',
  'report',
  'review',
  'evidence',
  'review_list',
  'journal_tail',
  'settings',
  'ack',
  'diag',
  'ui_state',
  'children',
  'child_read',
]

function now() {
  return new Date().toISOString()
}

function shortId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function cwdOfSession(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (session) {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.get === 'function') {
        try {
          const dir = workingDirectory.get(session)
          if (typeof dir === 'string' && dir) return dir
        } catch {
          /* fall through to the header */
        }
      }
      if (session.header && typeof session.header.cwd === 'string' && session.header.cwd) return session.header.cwd
    }
  } catch {
    /* fall through */
  }
  return process.cwd()
}

function cwdOf(ctx, exec) {
  const agent = exec && exec.agent
  return agent && agent.id ? cwdOfSession(ctx, agent.id) : process.cwd()
}

function workspaceIdForCwd(cwd) {
  const base = String(cwd).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(-48) || 'workspace'
  const digest = createHash('sha256').update(String(cwd)).digest('hex').slice(0, 12)
  return `${base}-${digest}`
}

function workspaceIdOf(ctx, exec) {
  return workspaceIdForCwd(cwdOf(ctx, exec))
}

function hashEntry(prevHash, body) {
  return createHash('sha256').update(prevHash).update(JSON.stringify(body)).digest('hex').slice(0, 32)
}

// Journal writes are read-modify-write (max seq + 1) and MUST be serialized:
// the fire-and-forget kyzmem reflow races the report flow's own entries,
// and two writers computing the same seq silently overwrite each other
// (acceptance b10-accept caught exactly this: kyzmem_reflowed lost to
// stage_reported). One process-wide chain; every writer awaits its turn.
let journalWriteChain = Promise.resolve()

function appendJournal(domain, type, payload) {
  const run = journalWriteChain.then(() => appendJournalInner(domain, type, payload))
  journalWriteChain = run.catch(() => {})
  return run
}

async function appendJournalInner(domain, type, payload) {  const table = domain.table('journal')
  const numbers = [...table.keys()].map((k) => Number(k)).filter((n) => Number.isFinite(n))
  const seq = numbers.length ? Math.max(...numbers) + 1 : 1
  const body = { seq, ts: now(), type, payload }
  const prev = numbers.length ? table.get(String(seq - 1)) : undefined
  const prevHash = prev ? prev.hash : ''
  const entry = JOURNAL_ENTRY.parse({ ...body, prevHash, hash: hashEntry(prevHash, body) })
  await table.put(String(seq), entry)
  return entry
}

/** Stage numbers are per workspace, never global: two projects must not share a counter. */
function nextStageSeq(domain, workspaceId) {
  let max = 0
  for (const [, report] of domain.table('reports').entries()) {
    if (report.workspaceId === workspaceId && report.stageSeq > max) max = report.stageSeq
  }
  return max + 1
}

// ---------------------------------------------------------------------------
// Evidence collector (B3)
//
// The session log is the only source of truth, and one kind of evidence is
// perishable: `workspace/changes` carries nothing but a turn number, while the
// diff snapshot it points at lives in a host recorder that is gone once the
// session is disposed. So the collector keeps a small in-memory accumulator per
// session, folds `session/event` into it, samples the workspace diff the moment
// that event arrives, and only materializes a record when `report` runs.
// Nothing here may throw into the event stream or do async work.
// ---------------------------------------------------------------------------

const MAX_LIST = 24
/** How many user turns stay in the rolling timeline handed to 观天. */
const MAX_USER_TIMELINE = 60
const accumulators = new Map()

function newAccumulator(sessionId) {
  return {
    sessionId,
    openedAt: now(),
    lastSeq: 0,
    turns: 0,
    steps: 0,
    lastTurnEnd: '',
    files: new Map(),
    touched: {},
    model: null,
    tools: {},
    toolErrors: [],
    tests: [],
    todos: [],
    goal: null,
    // Structured user timeline (P0): the only channel through which the user's
    // own words reach 观天. `userSeen` dedupes the same text arriving twice
    // (inbox splice + user/message is the common double).
    userTimeline: [],
    // Agent-originated traffic (steered child messages, subagent settlements,
    // teammate relays) is machine text, NOT the user's words: it gets its own
    // timeline so the reviewer can weight it for what it is.
    agentMessages: [],
  pendingQuestions: {},
    userSeen: new Set(),
    // P1 ledger bookkeeping.
    ledgerDirty: false,
    lastExtractSeq: 0,
    eventCount: 0,
    eventTypes: {},
    lastChangeSeq: 0,
  }
}

function accumulatorOf(sessionId) {
  let acc = accumulators.get(sessionId)
  if (!acc) {
    acc = newAccumulator(sessionId)
    accumulators.set(sessionId, acc)
  }
  return acc
}

function pushCapped(list, value) {
  list.push(value)
  if (list.length > MAX_LIST) list.splice(0, list.length - MAX_LIST)
}

/** Tool arguments arrive as a JSON string; pull a shell command out of them. */
function commandOf(rawArguments) {
  if (typeof rawArguments !== 'string' || !rawArguments) return ''
  try {
    const parsed = JSON.parse(rawArguments)
    if (parsed && typeof parsed.command === 'string') return parsed.command.slice(0, 300)
    if (parsed && typeof parsed.cmd === 'string') return parsed.cmd.slice(0, 300)
  } catch {
    return ''
  }
  return ''
}

/** Tool arguments arrive as a JSON string; pull a file path out of them. */
function pathOfArguments(rawArguments) {
  if (typeof rawArguments !== 'string' || !rawArguments) return ''
  try {
    const parsed = JSON.parse(rawArguments)
    if (!parsed || typeof parsed !== 'object') return ''
    for (const key of ['file_path', 'filePath', 'path']) {
      if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key].slice(0, 300)
    }
  } catch {
    return ''
  }
  return ''
}

/**
 * `user/message` carries `{id, role, content, source}`; content may be plain
 * text or blocks. Normalize to `{text, attachments}` — attachments matter
 * because "看这张截图" is meaningless to 观天 without knowing an image existed.
 */
function messageParts(data) {
  const message = data && data.message ? data.message : data
  if (!message) return { text: '', attachments: [] }
  const attachments = []
  const texts = []
  const takeBlocks = (blocks) => {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'image') attachments.push({ kind: 'image', name: String(block.name || block.path || 'image').slice(0, 120) })
      else if (block.type === 'file') attachments.push({ kind: 'file', name: String(block.name || block.path || 'file').slice(0, 120) })
    }
  }
  if (typeof message === 'string') texts.push(message)
  else if (typeof message.text === 'string') texts.push(message.text)
  else if (Array.isArray(message.content)) takeBlocks(message.content)
  return { text: texts.join(' ').trim(), attachments }
}

/** Legacy string-only form of {@link messageParts}. */
function messageText(data) {
  return messageParts(data).text
}

/** Strip the runtime reminders the harness appends to a user turn. */
function stripReminders(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Long instructions put the constraint in the tail ("……另外不要动 A 模块"),
 * so a plain head slice loses exactly the part that matters. Keep head + tail.
 */
function clipUserText(text) {
  const clean = stripReminders(text)
  const fullLen = clean.length
  if (fullLen <= 600) return { text: clean, truncated: false, fullLen }
  return { text: `${clean.slice(0, 400)} … ${clean.slice(-150)}`, truncated: true, fullLen }
}

const USER_SOURCE_KINDS = new Set(['user', 'user-question-reply'])

/**
 * A question answer is a JSON blob (`{answers:[{id,selected}]}`). The reviewer
 * cannot read that as "the user decided X", so render it as plain lines.
 */
function formatQuestionAnswers(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  const list = parsed && Array.isArray(parsed.answers) ? parsed.answers : null
  if (!list || !list.length) return raw
  const lines = []
  for (const answer of list) {
    if (!answer || typeof answer !== 'object') continue
    const id = String(answer.id || answer.header || '问题').trim()
    const picked = Array.isArray(answer.selected)
      ? answer.selected.map((v) => String(v && v.label ? v.label : v)).filter(Boolean)
      : []
    const free = String(answer.text || answer.answer || answer.value || '').trim()
    const value = picked.length ? picked.join('、') : free
    if (value) lines.push(`${id}：${value}`)
  }
  if (!lines.length) return raw
  return `用户已就以下问题拍板 —— ${lines.join('；')}`
}

/** `source.kind` is the only reliable "a human said this" switch. */
function userSourceKind(data) {
  const source = data && data.source
  const kind = source && typeof source.kind === 'string' ? source.kind : ''
  return USER_SOURCE_KINDS.has(kind) ? kind : ''
}

/**
 * Append one item to the rolling user timeline. Dedupe is by normalized text:
 * the same instruction lands twice (inbox splice + user/message).
 */
function pushUserEntry(acc, entry) {
  if (!entry || !entry.text) return false
  const key = entry.text.slice(0, 160)
  if (acc.userSeen.has(key)) return false
  acc.userSeen.add(key)
  acc.userTimeline.push(entry)
  if (acc.userTimeline.length > MAX_USER_TIMELINE) {
    const dropped = acc.userTimeline.splice(0, acc.userTimeline.length - MAX_USER_TIMELINE)
    for (const old of dropped) acc.userSeen.delete(old.text.slice(0, 160))
  }
  acc.ledgerDirty = true
  return true
}

/**
 * Append one item to the agent-message timeline (child/teammate traffic).
 * No ledger side effects: this is machine text, never a user requirement.
 * Capped rolling window, oldest drops first.
 */
const MAX_AGENT_MSGS = 30
function pushAgentEntry(acc, entry) {
  if (!entry || !entry.text) return false
  acc.agentMessages.push(entry)
  if (acc.agentMessages.length > MAX_AGENT_MSGS) {
    acc.agentMessages.splice(0, acc.agentMessages.length - MAX_AGENT_MSGS)
  }
  return true
}

/**
 * source.kind values that mean "a subagent/teammate said this", as opposed to
 * the user (USER_SOURCE_KINDS) or harness machine chatter (time-context,
 * skill-catalog, runtime-context …). Substring match on purpose: exact kind
 * strings were never published, only examples seen in the wild
 * (agent-message, subagent-settled).
 */
const AGENT_KIND_RE = /agent|subagent|team|member|coordinator/i
function agentKindLabel(kind) {
  const raw = String(kind || '')
  if (/subagent/i.test(raw)) return '子会话'
  if (/team|member|coordinator/i.test(raw)) return '队友'
  return '转述'
}

const USER_EVENT_TYPES = ['user/message', 'agent/inbox/spliced', 'command/run']
// Question answers arrive as tool results, so a cold replay must fold those too —
// otherwise the reviewer keeps asking for decisions the user already made.
const BACKFILL_EVENT_TYPES = USER_EVENT_TYPES.concat(['tool/call', 'tool/result'])
const backfilledSessions = new Set()

/**
 * The collector only starts when the plugin loads, so a long-running session
 * would otherwise show an empty "user's own words" list. Replay the session's
 * own log once, cold, through the same folding code — the session log is the
 * authoritative source, and `sessionQuery` reads live or persisted sessions.
 */
async function backfillUserTimeline(ctx, sessionId) {
  if (!sessionId || backfilledSessions.has(sessionId)) return { backfilled: false }
  if (!accumulators.has(sessionId)) return { backfilled: false }
  backfilledSessions.add(sessionId)
  try {
    const query = ctx.get('sessionQuery')
    if (!query) return { backfilled: false }
    // NOTE: `listEvents` returns lightweight records (no `data`); only
    // `readSession` replays the log into full SessionEvent objects.
    const snapshot =
      typeof query.readSession === 'function' ? await query.readSession(sessionId) : null
    const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
    if (!events.length) return { backfilled: false }
    let found = 0
    for (const event of events) {
      const before = accumulatorOf(sessionId).userTimeline.length
      foldEvent(ctx, { id: sessionId }, event, BACKFILL_EVENT_TYPES)
      if (accumulatorOf(sessionId).userTimeline.length > before) found += 1
    }
    const acc = accumulatorOf(sessionId)
    acc.userTimeline.sort((a, b) => Number(a.seq) - Number(b.seq))
    if (found > 0) acc.ledgerDirty = true
    noteBeacon('user-backfill', `${sessionId.slice(0, 24)} events=${events.length} user=${found}`)
    return { backfilled: true, events: events.length, user: found }
  } catch (err) {
    return { backfilled: false, error: String((err && err.message) || err) }
  }
}

/** Merge one workspace diff snapshot into the stage accumulator. */
function mergeDiff(acc, summary) {
  if (!summary || !Array.isArray(summary.files)) return
  for (const file of summary.files) {
    if (!file || typeof file.path !== 'string') continue
    const previous = acc.files.get(file.path) || { path: file.path, added: 0, deleted: 0 }
    previous.added += Number(file.added) || 0
    previous.deleted += Number(file.deleted) || 0
    if (file.binary) previous.binary = true
    acc.files.set(file.path, previous)
  }
}

function foldEvent(ctx, session, event, typeFilter) {
  if (!session || !event) return
  if (typeFilter && typeFilter.indexOf(event.type) < 0) return
  const acc = accumulatorOf(session.id)
  acc.eventCount += 1
  acc.eventTypes[event.type] = (acc.eventTypes[event.type] || 0) + 1
  if (Number.isFinite(event.seq)) acc.lastSeq = Math.max(acc.lastSeq, event.seq)
  // `session/event` hands over the live envelope, but cold records from
  // `sessionQuery` may wrap it; accept both without crashing on either.
  const data = event.data || (event.event && event.event.data) || event.payload || {}
  if (!acc.eventShapeSample) {
    try {
      acc.eventShapeSample = JSON.stringify(Object.keys(event)) + ' :: ' + JSON.stringify(event).slice(0, 300)
    } catch {
      acc.eventShapeSample = '<unserializable>'
    }
  }
  switch (event.type) {
    case 'turn/start':
      acc.turns += 1
      break
    case 'step/start':
      acc.steps += 1
      break
    case 'turn/end':
      acc.lastTurnEnd = (data.reason && data.reason.kind) || 'unknown'
      break
    case 'request/header': {
      try {
        acc.headerRaw = JSON.stringify(data).slice(0, 400)
      } catch {
        acc.headerRaw = '<unserializable>'
      }
      const header = data.header && typeof data.header === 'object' ? data.header : data
      const config = header.config && typeof header.config === 'object' ? header.config : header
      const provider = typeof config.provider === 'string' ? config.provider : ''
      const model = typeof config.model === 'string' ? config.model : ''
      if (provider && model) acc.model = { provider, model }
      break
    }
    case 'tool/call': {
      const toolName = typeof data.name === 'string' ? data.name : 'unknown'
      acc.tools[toolName] = (acc.tools[toolName] || 0) + 1
      if (/bash|pwsh|shell|job/i.test(toolName)) {
        const command = commandOf(data.arguments)
        if (command) pushCapped(acc.tests, { tool: toolName, command })
      }
      if (toolName === 'ask_user_question') {
        const qid = String(data.callId || '')
        if (qid) acc.pendingQuestions[qid] = { seq: Number.isFinite(event.seq) ? event.seq : 0, turn: acc.turns, step: acc.steps }
      }
      if (toolName === 'write' || toolName === 'edit') {
        const path = pathOfArguments(data.arguments)
        if (path) acc.touched[path] = (acc.touched[path] || 0) + 1
      }
      break
    }
    case 'tool/result': {
      // A question's answer comes back as a tool result, not a user/message, so
      // without this the reviewer never sees what the user actually decided.
      const resultMsg = data.message && typeof data.message === 'object' ? data.message : data
      const resultCallId = String(resultMsg.toolCallId || data.toolCallId || '')
      const pending = resultCallId ? acc.pendingQuestions[resultCallId] : null
      if (pending) {
        delete acc.pendingQuestions[resultCallId]
        const parts = messageParts(resultMsg)
        const readable = formatQuestionAnswers(parts.text)
        const clipped = clipUserText(readable)
        if (clipped.text) {
          pushUserEntry(acc, {
            seq: pending.seq,
            time: now(),
            kind: 'answer',
            sourceKind: 'question-reply',
            text: clipped.text,
            truncated: clipped.truncated,
            fullLen: clipped.fullLen,
            attachments: [],
            turn: pending.turn,
            step: pending.step,
          })
        }
      }
      if (data.error) {
        pushCapped(acc.toolErrors, {
          code: String(data.error.code || data.error.name || 'error'),
          reason: String(data.error.reason || '').slice(0, 200),
        })
      }
      break
    }
    case 'workspace/changes': {
      acc.lastChangeSeq = event.seq
      try {
        const changes = ctx.get('workspaceChanges')
        if (changes && typeof changes.summary === 'function') {
          mergeDiff(acc, changes.summary(session.id, event.seq))
        }
      } catch {
        /* the recorder may already be gone; the stage keeps whatever it had */
      }
      break
    }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : []
      acc.todos = todos.slice(-MAX_LIST).map((todo) => ({
        content: String((todo && todo.content) || '').slice(0, 200),
        status: String((todo && todo.status) || ''),
      }))
      break
    }
    case 'goal/change': {
      const goal = data.goal || data
      if (goal && typeof goal === 'object') {
        acc.goal = {
          objective: String(goal.objective || '').slice(0, 300),
          // The runtime publishes `phase` (active/paused/completed/blocked);
          // `status` never existed here — that empty column is a real bug fix.
          status: String(goal.phase || goal.status || ''),
          revision: Number(goal.revision) || 0,
        }
      }
      break
    }
    case 'user/message': {
      // Only a human's own words belong in the timeline. 177 user/message rows
      // in one session produced just 44 real ones; the rest are time-context,
      // memory blocks, subagent summaries and other machine chatter.
      // Agent-originated rows (agent-message, subagent-settled, teammate
      // relays) go to the SEPARATE agent timeline instead of being dropped.
      const sourceKind = userSourceKind(data)
      if (!acc.userShapeSamples) acc.userShapeSamples = []
      if (acc.userShapeSamples.length < 3) {
        try {
          acc.userShapeSamples.push(JSON.stringify(event).slice(0, 240))
        } catch {
          acc.userShapeSamples.push('<unserializable>')
        }
      }
      const rawKind = data && data.source && typeof data.source.kind === 'string' ? data.source.kind : ''
      if (!sourceKind) {
        if (rawKind && AGENT_KIND_RE.test(rawKind)) {
          const parts = messageParts(data)
          const clipped = clipUserText(parts.text)
          if (clipped.text || parts.attachments.length) {
            pushAgentEntry(acc, {
              seq: Number.isFinite(event.seq) ? event.seq : 0,
              time: typeof event.time === 'string' ? event.time : now(),
              kind: rawKind,
              text: clipped.text,
              truncated: clipped.truncated,
              fullLen: clipped.fullLen,
              attachments: parts.attachments,
              turn: acc.turns,
              step: acc.steps,
            })
          }
        }
        break
      }
      const parts = messageParts(data)
      const clipped = clipUserText(parts.text)
      if (!clipped.text && !parts.attachments.length) break
      pushUserEntry(acc, {
        seq: Number.isFinite(event.seq) ? event.seq : 0,
        time: typeof event.time === 'string' ? event.time : now(),
        kind: 'prompt',
        sourceKind,
        text: clipped.text,
        truncated: clipped.truncated,
        fullLen: clipped.fullLen,
        attachments: parts.attachments,
        turn: acc.turns,
        step: acc.steps,
      })
      break
    }
    case 'agent/inbox/spliced': {
      // Mid-turn interjections have no dedicated event: they arrive as inbox
      // splices. `next-step` = steer (this turn), `next-turn` = queued follow-up.
      const items = Array.isArray(data.inserted) ? data.inserted : Array.isArray(data.messages) ? data.messages : []
      const target = String(data.target || '')
      for (const item of items) {
        const sourceKind = userSourceKind(item)
        const itemKind = item && item.source && typeof item.source.kind === 'string' ? item.source.kind : ''
        if (!sourceKind) {
          // A child steering THIS turn through the inbox is still the child's
          // voice, not the user's: same separate timeline.
          if (itemKind && AGENT_KIND_RE.test(itemKind)) {
            const aParts = messageParts(item)
            const aClipped = clipUserText(aParts.text)
            if (aClipped.text) {
              pushAgentEntry(acc, {
                seq: Number.isFinite(event.seq) ? event.seq : 0,
                time: typeof event.time === 'string' ? event.time : now(),
                kind: `${itemKind}:${target || 'splice'}`,
                text: aClipped.text,
                truncated: aClipped.truncated,
                fullLen: aClipped.fullLen,
                attachments: aParts.attachments,
                turn: acc.turns,
                step: acc.steps,
              })
            }
          }
          continue
        }
        const parts = messageParts(item)
        const clipped = clipUserText(parts.text)
        if (!clipped.text) continue
        pushUserEntry(acc, {
          seq: Number.isFinite(event.seq) ? event.seq : 0,
          time: typeof event.time === 'string' ? event.time : now(),
          kind: target === 'next-step' ? 'steer' : 'followup',
          sourceKind,
          text: clipped.text,
          truncated: clipped.truncated,
          fullLen: clipped.fullLen,
          attachments: parts.attachments,
          turn: acc.turns,
          step: acc.steps,
        })
      }
      break
    }
    case 'command/run': {
      // Slash commands are typed by the user: `/i-have-adhd`, `/systematic-debugging`
      // are standing instructions, not noise.
      if (!userSourceKind(data) && !userSourceKind(data.command || {})) break
      const line = String(data.line || data.text || data.raw || '').trim()
      const name = String(data.name || data.commandId || '').trim()
      const clipped = clipUserText(line || (name ? `/${name}` : ''))
      if (!clipped.text) break
      pushUserEntry(acc, {
        seq: Number.isFinite(event.seq) ? event.seq : 0,
        time: typeof event.time === 'string' ? event.time : now(),
        kind: 'command',
        text: clipped.text,
        truncated: clipped.truncated,
        fullLen: clipped.fullLen,
        attachments: [],
        turn: acc.turns,
        step: acc.steps,
      })
      break
    }
    case 'approval/decided': {
      if (!userSourceKind(data) && !userSourceKind(data.decision || {})) break
      const decision = data.decision || data
      const text = `审批 ${String((decision && (decision.outcome || decision.kind)) || '')}：${String(
        (decision && (decision.reason || decision.title)) || '',
      ).slice(0, 200)}`
      const clipped = clipUserText(text)
      if (clipped.text) {
        pushUserEntry(acc, {
          seq: Number.isFinite(event.seq) ? event.seq : 0,
          time: typeof event.time === 'string' ? event.time : now(),
          kind: 'approval',
          text: clipped.text,
          truncated: false,
          fullLen: clipped.fullLen,
          attachments: [],
          turn: acc.turns,
          step: acc.steps,
        })
      }
      break
    }
    case 'session/title': {
      // A title the user typed by hand is their own one-line summary of the task.
      if (!userSourceKind(data)) break
      const clipped = clipUserText(String(data.title || ''))
      if (!clipped.text) break
      pushUserEntry(acc, {
        seq: Number.isFinite(event.seq) ? event.seq : 0,
        time: typeof event.time === 'string' ? event.time : now(),
        kind: 'title',
        text: clipped.text,
        truncated: false,
        fullLen: clipped.fullLen,
        attachments: [],
        turn: acc.turns,
        step: acc.steps,
      })
      break
    }
    default:
      break
  }
}

function attachCollector(ctx) {
  return ctx.on('session/event', (session, event) => {
    try {
      foldEvent(ctx, session, event)
    } catch {
      /* a collector bug must never break the session stream */
    }
  })
}

/** Materialize the accumulator into the compact evidence object that gets stored. */
function evidenceOf(sessionId) {
  const acc = accumulators.get(sessionId)
  if (!acc) return null
  const allFiles = [...acc.files.values()]
  const files = allFiles.sort((a, b) => b.added + b.deleted - (a.added + a.deleted)).slice(0, MAX_LIST)
  let added = 0
  let deleted = 0
  for (const file of allFiles) {
    added += file.added
    deleted += file.deleted
  }
  const toolTotal = Object.keys(acc.tools).reduce((sum, key) => sum + acc.tools[key], 0)
  const topEvents = Object.entries(acc.eventTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .reduce((out, [type, count]) => {
      out[type] = count
      return out
    }, {})
  return {
    openedAt: acc.openedAt,
    capturedAt: now(),
    turns: acc.turns,
    steps: acc.steps,
    lastTurnEnd: acc.lastTurnEnd,
    files,
    touchedFiles: Object.entries(acc.touched)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_LIST),
    model: acc.model,
    headerRaw: acc.headerRaw || '',
    diffStat: { files: acc.files.size, added, deleted },
    toolCalls: { total: toolTotal, byName: acc.tools },
    toolErrors: acc.toolErrors.slice(-5),
    tests: acc.tests.slice(-5),
    todos: acc.todos,
    goal: acc.goal,
    // Answers come from the question tool, not from the user keyboard: keep
    // them apart so the reviewer can weight each source for what it is.
    userTimeline: acc.userTimeline.filter((entry) => entry.kind !== 'answer'),
    userAnswers: acc.userTimeline.filter((entry) => entry.kind === 'answer').slice(-8),
    agentMessages: Array.isArray(acc.agentMessages) ? acc.agentMessages.slice(-MAX_AGENT_MSGS) : [],
    eventCount: acc.eventCount,
    topEvents,
  }
}

/**
 * Reset the per-stage evidence but KEEP the user timeline and the ledger cursor:
 * "what the user asked for" must outlive a stage boundary, otherwise every
 * review is judged against only the last few minutes of conversation.
 */
function resetAccumulator(sessionId) {
  const acc = accumulators.get(sessionId)
  if (!acc) return
  const keptTimeline = acc.userTimeline
  const keptAgents = Array.isArray(acc.agentMessages) ? acc.agentMessages : []
  const keptSeen = acc.userSeen
  const keptSeq = acc.lastSeq
  const keptExtract = acc.lastExtractSeq
  const keptDirty = acc.ledgerDirty
  accumulators.set(sessionId, {
    ...newAccumulator(sessionId),
    userTimeline: keptTimeline,
    agentMessages: keptAgents,
    userSeen: keptSeen,
    lastSeq: keptSeq,
    lastExtractSeq: keptExtract,
    ledgerDirty: keptDirty,
    // Cumulative per-session counters survive a stage reset (they describe the
    // session, not the stage).
    turns: acc.turns,
    steps: acc.steps,
    model: acc.model,
    headerRaw: acc.headerRaw,
  })
}

// ---------------------------------------------------------------------------
// Domain lifecycle (lazy + resilient: a storage failure never blocks work)
// ---------------------------------------------------------------------------

const retiredStorageContexts = new WeakSet()
let domainPromise
let storageHandles = {}
let storageFacility
let storageClosing = Promise.resolve()

async function storage(ctx) {
  if (retiredStorageContexts.has(ctx)) return { error: '天监已卸载', failures: {} }
  if (!domainPromise) {
    const handles = storageHandles
    const closing = storageClosing
    const attempt = (async () => {
      await closing
      const failures = {}
      let facility
      try { facility = ctx.get('storageDomain') } catch (err) {
        return { ...handles, failures, error: String((err && err.message) || err) }
      }
      if (!facility) return { failures, error: 'storageDomain 服务不可用' }
      if (storageFacility && storageFacility !== facility) {
        await Promise.allSettled(Object.values(handles).map((handle) => Promise.resolve().then(() => handle.close())))
        for (const key of Object.keys(handles)) delete handles[key]
      }
      storageFacility = facility
      for (const [key, spec] of [['domain', DOMAIN_SPEC], ['settings', SETTINGS_SPEC], ['sessions', SESSIONS_SPEC], ['workspaces', WORKSPACES_SPEC]]) {
        if (handles[key]) continue
        try { handles[key] = await facility.open(spec) } catch (err) {
          failures[spec.name] = String((err && err.message) || err)
        }
      }
      return { ...handles, failures, error: failures[DOMAIN_SPEC.name] }
    })()
    domainPromise = attempt
    attempt.finally(() => { if (domainPromise === attempt) domainPromise = undefined }).catch(() => {})
  }
  return domainPromise
}

async function closeStorage() {
  const pending = domainPromise
  const handles = storageHandles
  domainPromise = undefined
  storageHandles = {}
  storageFacility = undefined
  const previous = storageClosing
  storageClosing = (async () => {
    await previous
    if (pending) await pending.catch(() => {})
    await Promise.allSettled(Object.values(handles).map((handle) => Promise.resolve().then(() => handle.close())))
  })()
  await storageClosing
}

// ---------------------------------------------------------------------------
// Per-workspace / per-session state (the domain above is shared by every project,
// so anything that must not leak across projects lives in `supervisor_workspaces`).
// ---------------------------------------------------------------------------

/** Storage key for one session's counters. Wash both halves so the joiner '__' is unambiguous. */
function sessionCounterKey(workspaceId, sessionId) {
  const clean = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'unknown'
  return `${clean(workspaceId)}__${clean(sessionId)}`
}

async function countersOf(ctx, workspaceId, sessionId) {
  const { workspaces, domain } = await storage(ctx)
  if (!workspaces) return { ...DEFAULT_COUNTERS }
  const ws = String(workspaceId || '')
  if (sessionId) {
    // Session-scoped: this session's own streaks. Seed once from the legacy
    // workspace row (clocks + unseen notice carry over) but never the streaks.
    const sid = String(sessionId)
    try {
      const table = workspaces.table('session_counters')
      const key = sessionCounterKey(ws, sid)
      const hit = table.get(key)
      if (hit) return SESSION_COUNTERS.parse(hit)
      const seeded = { ...DEFAULT_COUNTERS, workspaceId: ws, sessionId: sid }
      try {
        const legacy = workspaces.table('counters').get(ws)
        if (legacy) {
          const old = COUNTERS.parse(legacy)
          seeded.pendingNotice = old.pendingNotice || null
          seeded.lastReviewAt = old.lastReviewAt || ''
          seeded.lastStageSeq = old.lastStageSeq || 0
          seeded.lastAutoReviewAt = old.lastAutoReviewAt || ''
          seeded.lastInterruptAt = old.lastInterruptAt || ''
          seeded.lastAck = old.lastAck || null
          // Move the notice: it now lives on this session's row.
          if (old.pendingNotice) {
            await workspaces.table('counters').put(ws, { ...old, pendingNotice: null })
          }
        }
      } catch {
        /* seed clean */
      }
      const row = SESSION_COUNTERS.parse(seeded)
      try {
        await table.put(key, row)
      } catch {
        /* read-through is best-effort */
      }
      return row
    } catch {
      return { ...DEFAULT_COUNTERS }
    }
  }
  try {
    const record = workspaces.table('counters').get(ws)
    if (record) return COUNTERS.parse(record)
    // No row yet: derive from this workspace's own review history instead of
    // borrowing another project's streak.
    const derived = { ...DEFAULT_COUNTERS }
    if (domain) {
      const rows = []
      for (const [, review] of domain.table('reviews').entries()) {
        if (!review || review.workspaceId !== workspaceId) continue
        rows.push(review)
      }
      rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      derived.reviewCount = rows.length
      for (const review of rows) {
        if (review.verdict === 'critical') derived.criticalCount += 1
        if (review.verdict === 'drift' || review.verdict === 'critical') derived.driftStreak += 1
        else if (review.verdict && review.verdict !== 'pending') derived.driftStreak = 0
        if (review.createdAt && review.createdAt > derived.lastReviewAt) derived.lastReviewAt = review.createdAt
      }
    }
    return derived
  } catch {
    return { ...DEFAULT_COUNTERS }
  }
}

async function saveCounters(ctx, workspaceId, next, sessionId) {
  const { workspaces } = await storage(ctx)
  if (!workspaces) return false
  const ws = String(workspaceId || '')
  try {
    if (sessionId) {
      const row = SESSION_COUNTERS.parse({
        ...next,
        workspaceId: ws,
        sessionId: String(sessionId),
      })
      await workspaces.table('session_counters').put(sessionCounterKey(ws, sessionId), row)
      return true
    }
    await workspaces.table('counters').put(ws, COUNTERS.parse(next))
    return true
  } catch {
    return false
  }
}

/**
 * Project-level rollup: sums session rows of one workspace. Display-only —
 * decisions (blocking, interrupt) always read the session row via countersOf.
 * Workspaces that never migrated still contribute their legacy row.
 */
async function workspaceCountersOf(ctx, workspaceId) {
  const { workspaces } = await storage(ctx)
  const total = { ...DEFAULT_COUNTERS }
  if (!workspaces) return total
  const ws = String(workspaceId || '')
  let bestNoticeAt = ''
  let sawSession = false
  try {
    for (const [, record] of workspaces.table('session_counters').entries()) {
      if (!record || record.workspaceId !== ws) continue
      let c
      try {
        c = SESSION_COUNTERS.parse(record)
      } catch {
        continue
      }
      sawSession = true
      total.reviewCount += c.reviewCount || 0
      total.criticalCount += c.criticalCount || 0
      if ((c.driftStreak || 0) > (total.driftStreak || 0)) total.driftStreak = c.driftStreak || 0
      if (c.lastReviewAt && c.lastReviewAt > total.lastReviewAt) total.lastReviewAt = c.lastReviewAt
      if (c.lastAutoReviewAt && c.lastAutoReviewAt > total.lastAutoReviewAt) total.lastAutoReviewAt = c.lastAutoReviewAt
      if (c.lastInterruptAt && c.lastInterruptAt > (total.lastInterruptAt || '')) total.lastInterruptAt = c.lastInterruptAt
      if ((c.lastStageSeq || 0) > (total.lastStageSeq || 0)) total.lastStageSeq = c.lastStageSeq || 0
      if (c.pendingNotice && (c.lastReviewAt || '') >= bestNoticeAt) {
        bestNoticeAt = c.lastReviewAt || ''
        total.pendingNotice = c.pendingNotice
      }
    }
  } catch {
    /* a broken row must not blank the panel */
  }
  // Pre-migration history lives only in the legacy workspace row, which is
  // frozen once sessions start writing their own rows — its counts still add
  // up, but its streak must not resurrect after sessions reset their own.
  try {
    const legacy = workspaces.table('counters').get(ws)
    if (legacy) {
      const old = COUNTERS.parse(legacy)
      total.reviewCount += old.reviewCount || 0
      total.criticalCount += old.criticalCount || 0
      if (!sawSession) {
        if ((old.driftStreak || 0) > (total.driftStreak || 0)) total.driftStreak = old.driftStreak || 0
        if (old.pendingNotice && (old.lastReviewAt || '') >= bestNoticeAt) {
          total.pendingNotice = old.pendingNotice
        }
      }
      if (old.lastReviewAt && old.lastReviewAt > total.lastReviewAt) total.lastReviewAt = old.lastReviewAt
      if (old.lastAutoReviewAt && old.lastAutoReviewAt > total.lastAutoReviewAt) total.lastAutoReviewAt = old.lastAutoReviewAt
      if (old.lastInterruptAt && old.lastInterruptAt > (total.lastInterruptAt || '')) total.lastInterruptAt = old.lastInterruptAt
      if ((old.lastStageSeq || 0) > (total.lastStageSeq || 0)) total.lastStageSeq = old.lastStageSeq || 0
    }
  } catch {
    /* fall through with whatever accumulated */
  }
  return total
}

async function sessionBaselineOf(ctx, sessionId) {
  const { workspaces } = await storage(ctx)
  if (!workspaces || !sessionId) return null
  try {
    return workspaces.table('session_baselines').get(String(sessionId)) || null
  } catch {
    return null
  }
}

function mergeBaselines(project, session) {
  if (!project && !session) return null
  const source = session || {}
  const base = project || {}
  const pick = (key, fallback) => (source[key] !== undefined && source[key] !== null ? source[key] : base[key] !== undefined ? base[key] : fallback)
  const constraints = source.constraints || base.constraints || { hard: [], soft: [] }
  return {
    revision: base.revision || 0,
    sessionRevision: session ? session.revision : 0,
    scope: session && project ? 'project+session' : session ? 'session' : 'project',
    intent: pick('intent', ''),
    goals: pick('goals', []),
    constraints: { hard: constraints.hard || [], soft: constraints.soft || [] },
    directions: pick('directions', []),
    decisions: pick('decisions', []),
    updatedAt: pick('updatedAt', ''),
  }
}

async function aggregateCounters(ctx) {
  const { workspaces, domain } = await storage(ctx)
  const total = { ...DEFAULT_COUNTERS, workspaces: 0, pendingNotices: [], maxDriftStreak: 0 }
  if (!workspaces) return total
  // Discover workspaces from every table that carries a workspaceId, so a
  // project shows up even before its first session row exists.
  const ids = new Set()
  const collect = (tableName, keyFn) => {
    try {
      for (const [key, record] of workspaces.table(tableName).entries()) {
        if (!record) continue
        const id = keyFn(key, record)
        if (id) ids.add(id)
      }
    } catch {
      /* a broken table must not blank the panel */
    }
  }
  collect('session_counters', (key, record) => record.workspaceId || null)
  collect('counters', (key) => key || null)
  collect('session_baselines', (key, record) => record.workspaceId || key || null)
  if (domain) {
    try {
      for (const [, record] of domain.table('baselines').entries()) {
        if (record && record.workspaceId) ids.add(record.workspaceId)
      }
    } catch {
      /* baselines enrich, they do not gate */
    }
  }
  for (const id of ids) {
    let c
    try {
      c = await workspaceCountersOf(ctx, id)
    } catch {
      continue
    }
    total.workspaces += 1
    total.reviewCount += c.reviewCount
    total.criticalCount += c.criticalCount
    if ((c.driftStreak || 0) > total.maxDriftStreak) total.maxDriftStreak = c.driftStreak || 0
    if (c.lastReviewAt && c.lastReviewAt > total.lastReviewAt) total.lastReviewAt = c.lastReviewAt
    if (c.lastInterruptAt && c.lastInterruptAt > (total.lastInterruptAt || '')) total.lastInterruptAt = c.lastInterruptAt
    if (c.pendingNotice) total.pendingNotices.push({ workspaceId: id, ...c.pendingNotice })
  }
  total.pendingNotice = total.pendingNotices[0] || null
  return total
}

async function clearNotices(ctx, workspaceId) {
  const { workspaces } = await storage(ctx)
  if (!workspaces) return false
  const only = typeof workspaceId === 'string' && workspaceId ? workspaceId : ''
  let cleared = false
  try {
    for (const [key, record] of workspaces.table('session_counters').entries()) {
      if (!record || !record.pendingNotice) continue
      if (only && record.workspaceId !== only) continue
      const c = SESSION_COUNTERS.parse(record)
      await workspaces.table('session_counters').put(key, {
        ...c,
        pendingNotice: null,
        lastAck: { at: now(), via: 'ui' },
      })
      cleared = true
    }
  } catch {
    return cleared
  }
  // Legacy workspace rows (pre-session-counters): clear them too so a notice
  // parked before the migration does not stick around forever.
  try {
    for (const [key, record] of workspaces.table('counters').entries()) {
      if (only && key !== only) continue
      if (!record || !record.pendingNotice) continue
      const c = COUNTERS.parse(record)
      await workspaces.table('counters').put(key, {
        ...c,
        pendingNotice: null,
        lastAck: { at: now(), via: 'ui' },
      })
      cleared = true
    }
  } catch {
    return cleared
  }
  return cleared
}

async function saveTranscript(ctx, reviewId, record) {
  const { workspaces } = await storage(ctx)
  if (!workspaces || !reviewId) return false
  try {
    await workspaces.table('transcripts').put(String(reviewId), TRANSCRIPT.parse(record))
    return true
  } catch {
    return false
  }
}

async function transcriptOf(ctx, reviewId) {
  const { workspaces } = await storage(ctx)
  if (!workspaces || !reviewId) return null
  try {
    const record = workspaces.table('transcripts').get(String(reviewId))
    return record ? plain(record) : null
  } catch {
    return null
  }
}

/** Journal entries pinned to one review, newest first (audit trail). */
async function journalTrail(ctx, reviewId) {
  if (!reviewId) return []
  const { domain } = await storage(ctx)
  if (!domain) return []
  try {
    const rows = []
    for (const [, entry] of domain.table('journal').entries()) {
      if (!entry) continue
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {}
      if (payload.reviewId !== reviewId) continue
      rows.push({ seq: entry.seq, type: entry.type, ts: entry.ts })
    }
    rows.sort((a, b) => Number(b.seq) - Number(a.seq))
    return rows.slice(0, 40)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionStatus(ctx, exec) {
  const { domain, error } = await storage(ctx)
  const workspaceId = workspaceIdOf(ctx, exec)
  if (!domain) {
    return {
      status: 'degraded',
      message: `天监 ${SUPERVISOR_VERSION}：存储不可用（${error}）。基线无法保存，其它功能照常，请不要因此中断施工。`,
      data: { workspaceId, storage: 'unavailable', baseline: null, counters: null },
    }
  }
  const baseline = domain.table('baselines').get(workspaceId)
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  // Session row drives this session's decisions; the workspace rollup is
  // display-only so the numbers stay comparable with the Tab.
  const counters = await countersOf(ctx, workspaceId, sessionId)
  const totals = await workspaceCountersOf(ctx, workspaceId)
  const lines = [
    `天监 ${SUPERVISOR_VERSION} · 工作区 ${workspaceId}`,
    baseline
      ? `基线：第 ${baseline.revision} 版 · 意图「${baseline.intent || '未填写'}」· 目标 ${baseline.goals.length} 条 · 硬约束 ${baseline.constraints.hard.length} 条 · 软约束 ${baseline.constraints.soft.length} 条 · 方向 ${baseline.directions.length} 条`
      : '基线：尚未建立（需用户批准后调用 baseline_set）',
    `本会话审查 ${counters.reviewCount} 次（严重 ${counters.criticalCount} · 连续偏移 ${counters.driftStreak}）`,
    `项目累计审查 ${totals.reviewCount} 次（严重 ${totals.criticalCount} · 最大连续偏移 ${totals.driftStreak}）`,
    `最近审查：${counters.lastReviewAt || totals.lastReviewAt || '无'}`,
  ]
  if (counters.pendingNotice && counters.pendingNotice.message) {
    lines.unshift(
      `⚠ 待处理提醒：${counters.pendingNotice.message}`,
      '（处理完用 supervisor action=ack 清掉这条提醒）',
    )
  }
  return {
    status: 'ok',
    message: lines.join('\n'),
    data: { workspaceId, storage: 'ready', baseline: baseline ?? null, counters, workspaceCounters: totals },
  }
}

/** Clear the pending blocking notice once the user has seen it. */
async function actionAck(ctx, exec) {
  const { domain, error } = await storage(ctx)
  if (!domain) return { status: 'degraded', message: `天监：存储不可用（${error}）。`, data: { cleared: false } }
  const workspaceId = workspaceIdOf(ctx, exec)
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  const counters = await countersOf(ctx, workspaceId, sessionId)
  if (!counters.pendingNotice) {
    // Be honest: another session of the same project may still hold one.
    const totals = await workspaceCountersOf(ctx, workspaceId)
    const extra = totals.pendingNotice ? '（本会话没有，但项目下其它会话还有 1 条待处理）' : ''
    return { status: 'ok', message: `天监：本会话没有待处理的提醒。${extra}`, data: { cleared: false } }
  }
  const was = counters.pendingNotice
  await saveCounters(ctx, workspaceId, { ...counters, pendingNotice: null }, sessionId)
  await appendJournal(domain, 'notice_acknowledged', { verdict: was.verdict || '', reviewId: was.reviewId || '' })
  return { status: 'ok', message: `天监：已清掉提醒（${was.message || was.verdict || '未注明'}）。`, data: { cleared: true } }
}

/**
 * The exact JSON the browser half renders from. Useful when the panel is not on
 * screen: whatever is wrong in the UI can be spotted here instead.
 */
async function actionUiState(ctx, exec) {
  const overview = await overviewOf(ctx)
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  const session = await sessionStateOf(ctx, sessionId)
  // Write the exact JSON out so the renderer can be exercised offline.
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(process.env.USERPROFILE || '.', 'AppData', 'Local', 'Temp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'dsh-supervisor-snapshot.json'), JSON.stringify(overview, null, 2), 'utf8')
    writeFileSync(join(dir, 'dsh-supervisor-session.json'), JSON.stringify(session, null, 2), 'utf8')
  } catch (err) {
    /* the dump is a convenience, never a failure */
  }
  const line =
    overview && overview.storage === 'ok'
      ? `天监 UI 快照：工作区 ${overview.workspaceCount} 个 · 审查 ${overview.reviews.length} 条（对齐 ${overview.verdicts.aligned} / 轻微 ${overview.verdicts.minor} / 偏移 ${overview.verdicts.drift} / 严重 ${overview.verdicts.critical}）· 台账 ${overview.journal.length} 行；本会话：${session.enabled ? '已启用' : '已停用'}，阶段 ${session.stage ? session.stage.stageSeq : '—'}，裁决 ${(session.review && session.review.verdict) || '暂无'}`
      : `天监 UI 快照：存储不可用（${(overview && overview.error) || '未知'}）`
  return { status: 'ok', message: line, data: { overview, session } }
}

/**
 * Diagnostic: report what this host actually knows about the browser half, so a
 * silently missing panel can be told apart from a panel that registered and threw.
 */
async function actionDiag(ctx) {
  const findings = []
  const data = {}
  const record = (label, value) => findings.push(`${label}：${value}`)

  try {
    const modules = ctx.get('clientModules')
    data.clientModules = Boolean(modules)
    if (modules && typeof modules.graph === 'function') {
      const graph = await modules.graph()
      const text = JSON.stringify(graph || {})
      data.graphBytes = text.length
      data.supervisorInGraph = text.indexOf('dsh-supervisor') >= 0
      record('客户端 bundle 图', data.supervisorInGraph ? '包含 dsh-supervisor' : '不包含 dsh-supervisor')
      if (data.supervisorInGraph) {
        const at = text.indexOf('dsh-supervisor')
        data.graphHit = text.slice(Math.max(0, at - 320), at + 320)
        record('图命中片段', data.graphHit)
      }
      try {
        const fs = ctx.get('fs')
        const dump = 'C:\\Users\\LIU\\Documents\\deepseek-harness\\default-workspace\\.supervisor-diag-graph.json'
        await fs.writeText(dump, JSON.stringify(graph, null, 2))
        data.graphDumped = dump
      } catch (err) {
        data.graphDumpError = String((err && err.message) || err)
        record('图落盘', `失败：${data.graphDumpError}`)
      }
      if (!data.supervisorInGraph && graph && typeof graph === 'object') {
        data.graphKeys = Object.keys(graph).slice(0, 12)
      }
    } else {
      record('客户端 bundle 图', 'clientModules 服务不可用')
    }
  } catch (err) {
    data.clientModulesError = String((err && err.message) || err)
    record('客户端 bundle 图', `读取失败：${data.clientModulesError}`)
  }

  try {
    const connection = ctx.get('connection')
    data.connection = Boolean(connection && connection.rpc && typeof connection.rpc.handle === 'function')
    record('RPC 通道', data.connection ? '可用' : '不可用')
  } catch (err) {
    data.connection = false
    data.connectionError = String((err && err.message) || err)
    record('RPC 通道', '不可用')
  }

  data.expectedSurfaces = [
    'sidebar.panellist',
    'main',
    'conversation.input.right',
    'conversation.view',
  ]
  record('期望挂载点', `${data.expectedSurfaces.length} 个`)

  try {
    const store = await storage(ctx)
    data.storageProbe = {
      main: Boolean(store.domain),
      settings: Boolean(store.settings),
      sessions: Boolean(store.sessions),
      workspaces: Boolean(store.workspaces),
      error: store.error ? String(store.error) : null,
    }
    record(
      '存储域',
      `主域 ${data.storageProbe.main ? 'ok' : '×'} · 设置 ${data.storageProbe.settings ? 'ok' : '×'} · 会话 ${data.storageProbe.sessions ? 'ok' : '×'} · 工作区 ${data.storageProbe.workspaces ? 'ok' : '×'}` +
        (data.storageProbe.error ? ` · 错误：${data.storageProbe.error}` : ''),
    )
    if (store.failures && Object.keys(store.failures).length) {
      record(
        '存储域失败原因',
        Object.keys(store.failures)
          .map((name) => `${name}: ${store.failures[name]}`)
          .join(' | '),
      )
    }
  } catch (err) {
    record('存储域', '读取失败：' + String((err && err.message) || err))
  }

  data.rpcCalls = rpcStats.calls
  data.rpcByEndpoint = { ...rpcStats.byEndpoint }
  data.rpcHello = rpcStats.hello
  data.reflow = { ...lastReflow }
  record(
    '经验回流（kyzmem）',
    lastReflow.ok === true
      ? `正常（${lastReflow.at} ${lastReflow.detail}）`
      : lastReflow.ok === false
        ? `跳过/失败（${lastReflow.at} ${lastReflow.detail}）`
        : '尚未执行（下一次审查落库后触发）',
  )
  record(
    '浏览器半边是否跑起来',
    rpcStats.hello
      ? `是（hello ${rpcStats.hello.at}，挂载点 ${(rpcStats.hello.surfaces || []).join(' / ') || '无'}）`
      : rpcStats.calls > 0
        ? `是（已调用 ${rpcStats.calls} 次，但没发 hello）`
        : '没有——一次 RPC 都没收到',
  )

  data.beacons = rpcStats.beacons.slice(-12)
  if (data.beacons.length) {
    record('浏览器信标', data.beacons.map((b) => `${b.stage}${b.detail ? `(${b.detail})` : ''}`).join(' → '))
  } else {
    record('浏览器信标', '一个都没收到')
  }

  return {
    status: 'ok',
    message: `天监诊断：\n${findings.map((line) => `· ${line}`).join('\n')}`,
    data,
  }
}

async function actionBaselineSet(ctx, exec, args) {
  const { domain, error } = await storage(ctx)
  const workspaceId = workspaceIdOf(ctx, exec)
  if (!domain) {
    return { status: 'error', message: `天监：存储不可用（${error}），基线未保存。`, data: { workspaceId } }
  }
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  const scope = args && args.scope === 'session' ? 'session' : 'project'
  const stamp = now()
  const pickArray = (value, fallback) => (Array.isArray(value) && value.length ? value.filter((x) => typeof x === 'string') : fallback)

  // A session baseline narrows this conversation only; it never rewrites the project one.
  if (scope === 'session') {
    const { workspaces } = await storage(ctx)
    if (!workspaces || !sessionId) {
      return {
        status: 'degraded',
        message: '天监：会话基线需要会话上下文与可用存储，本次未保存（项目基线不受影响）。',
        data: { workspaceId, sessionId, scope: 'session' },
      }
    }
    const prev = workspaces.table('session_baselines').get(sessionId)
    const record = SESSION_BASELINE.parse({
      sessionId,
      workspaceId,
      revision: (prev ? prev.revision : 0) + 1,
      intent: typeof args.intent === 'string' && args.intent.trim() ? args.intent.trim() : prev ? prev.intent : '',
      goals: pickArray(args.goals, prev ? prev.goals : []),
      constraints: {
        hard: args.constraints && Array.isArray(args.constraints.hard) ? args.constraints.hard.filter((x) => typeof x === 'string') : prev ? prev.constraints.hard : [],
        soft: args.constraints && Array.isArray(args.constraints.soft) ? args.constraints.soft.filter((x) => typeof x === 'string') : prev ? prev.constraints.soft : [],
      },
      directions: pickArray(args.directions, prev ? prev.directions : []),
      decisions: prev ? prev.decisions : [],
      createdAt: prev ? prev.createdAt : stamp,
      updatedAt: stamp,
    })
    await workspaces.table('session_baselines').put(String(sessionId), record)
    await appendJournal(domain, 'session_baseline_updated', { workspaceId, sessionId, revision: record.revision })
    return {
      status: 'ok',
      message: `天监：会话基线已保存为第 ${record.revision} 版（目标 ${record.goals.length} 条 · 硬约束 ${record.constraints.hard.length} 条 · 软约束 ${record.constraints.soft.length} 条 · 方向 ${record.directions.length} 条）。项目基线未被改动。`,
      data: { workspaceId, sessionId, scope: 'session', sessionBaseline: record },
    }
  }

  const existing = domain.table('baselines').get(workspaceId)
  const record = BASELINE.parse({
    workspaceId,
    revision: (existing ? existing.revision : 0) + 1,
    intent: typeof args.intent === 'string' && args.intent.trim() ? args.intent.trim() : existing ? existing.intent : '',
    goals: pickArray(args.goals, existing ? existing.goals : []),
    constraints: {
      hard: args.constraints && Array.isArray(args.constraints.hard) ? args.constraints.hard.filter((x) => typeof x === 'string') : existing ? existing.constraints.hard : [],
      soft: args.constraints && Array.isArray(args.constraints.soft) ? args.constraints.soft.filter((x) => typeof x === 'string') : existing ? existing.constraints.soft : [],
    },
    directions: pickArray(args.directions, existing ? existing.directions : []),
    decisions: existing ? existing.decisions : [],
    createdAt: existing ? existing.createdAt : stamp,
    updatedAt: stamp,
  })
  await domain.table('baselines').put(workspaceId, record)
  await appendJournal(domain, 'baseline_updated', { workspaceId, revision: record.revision })
  return {
    status: 'ok',
    message: `天监：项目基线已保存为第 ${record.revision} 版（目标 ${record.goals.length} 条 · 硬约束 ${record.constraints.hard.length} 条 · 软约束 ${record.constraints.soft.length} 条 · 方向 ${record.directions.length} 条）。`,
    data: { workspaceId, scope: 'project', baseline: record },
  }
}

async function actionReport(ctx, exec, args) {
  const { domain, settings: settingsDomain, error } = await storage(ctx)
  const workspaceId = workspaceIdOf(ctx, exec)
  if (!domain) {
    return {
      status: 'degraded',
      message: `天监：存储不可用（${error}），本阶段汇报未记录；请继续施工，不要因此中断。`,
      data: { workspaceId, recorded: false },
    }
  }
  const stageSeq = nextStageSeq(domain, workspaceId)
  const reportId = shortId('rpt')
  const stamp = now()
  const claim = typeof args.summary === 'string' ? args.summary.trim() : ''
  const touched = Array.isArray(args.touched) ? args.touched.filter((x) => typeof x === 'string') : []
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  await backfillUserTimeline(ctx, sessionId)
  // Refresh the ledger from any user messages that no review has seen yet, so
  // this stage is judged against the user's CURRENT words, not a stale baseline.
  const ledgerFlush = await flushLedger(ctx, { domain, settingsDomain, workspaceId, sessionId })
  const evidence = evidenceOf(sessionId)
  const sessionModel = sessionModelOf(ctx, sessionId) || (evidence && evidence.model) || null
  const projectBaseline = domain.table('baselines').get(workspaceId) || null
  const sessionBaseline = await sessionBaselineOf(ctx, sessionId)
  // 观天 reads the merge: project rules, narrowed by anything this session added.
  const baseline = mergeBaselines(projectBaseline, sessionBaseline)

  const outcome = await runReview(ctx, {
    domain,
    settingsDomain,
    workspaceId,
    sessionId,
    stageSeq,
    baseline,
    evidence,
    report: { claim, touched },
    sessionModel,
    parentAgent: exec && exec.agent ? exec.agent : null,
    signal: exec && exec.signal ? exec.signal : undefined,
  })

  let reviewId
  if (outcome.ok) {
    reviewId = outcome.review.reviewId
  } else {
    reviewId = shortId('rev')
    await domain
      .table('reviews')
      .put(
        reviewId,
        REVIEW.parse({
          reviewId,
          workspaceId,
          sessionId,
          stageSeq,
          createdAt: stamp,
          verdict: 'pending',
          summary: `审查未完成：${outcome.error}`,
          engine: 'light',
        }),
      )
  }

  await domain.table('reports').put(
    reportId,
    STAGE_REPORT.parse({
      reportId,
      workspaceId,
      sessionId,
      stageSeq,
      submittedAt: stamp,
      claim,
      touched,
      reviewId,
      trigger: { kind: 'report', at: stamp, by: sessionId || 'agent' },
      evidence,
    }),
  )
  const counters = await countersOf(ctx, workspaceId, sessionId)
  await saveCounters(ctx, workspaceId, {
    ...counters,
    lastStageSeq: Math.max(counters.lastStageSeq || 0, stageSeq),
  }, sessionId)
  await appendJournal(domain, 'stage_reported', { workspaceId, stageSeq, reportId, reviewId })
  resetAccumulator(sessionId)

  const diff = evidence && evidence.diffStat ? evidence.diffStat : null
  const userLine = evidence && Array.isArray(evidence.userTimeline) && evidence.userTimeline.length
    ? `用户原话 ${evidence.userTimeline.length} 条（最新 U${evidence.userTimeline[evidence.userTimeline.length - 1].seq}）`
    : '用户原话 0 条'
  const ledgerLine = ledgerFlush && ledgerFlush.ok && ledgerFlush.stats
    ? ` · 台账 +${ledgerFlush.stats.added}/改${ledgerFlush.stats.superseded}/撤${ledgerFlush.stats.revoked}/交叉确认${ledgerFlush.stats.crossConfirmed}`
    : ''
  const evidenceLine = evidence
    ? `证据：${diff ? `${diff.files} 个文件 +${diff.added}/-${diff.deleted}` : '无文件改动'} · ` +
      `${evidence.turns} 回合 / ${evidence.steps} 步 · 工具 ${evidence.toolCalls.total} 次` +
      (evidence.tests.length ? ` · 命令 ${evidence.tests.length} 条` : '') +
      ` · ${userLine}${ledgerLine}`
    : '证据：本会话尚未采集到事件'

  const head = outcome.ok
    ? verdictMessage(outcome.review, stageSeq)
    : `天监：第 ${stageSeq} 阶段已收到，但审查未执行（${outcome.error}）。当前结论：待审 —— 请继续施工，不要因此中断。`

  return {
    status: outcome.ok ? 'ok' : 'degraded',
    message: [head, evidenceLine].filter(Boolean).join('\n'),
    data: {
      workspaceId,
      stageSeq,
      reportId,
      reviewId,
      verdict: outcome.ok ? outcome.review.verdict : 'pending',
      blocking: outcome.ok ? outcome.blocking : false,
      engine: outcome.ok ? outcome.engine : 'none',
      model: outcome.ok ? outcome.review.model : null,
      evidence,
    },
  }
}

/** Manually re-run the light review on the latest recorded stage. */
async function actionReview(ctx, exec) {
  const { domain, settings: settingsDomain, error } = await storage(ctx)
  const workspaceId = workspaceIdOf(ctx, exec)
  if (!domain) {
    return { status: 'degraded', message: `天监：存储不可用（${error}）。`, data: { reviewed: false } }
  }
  const reports = [...domain.table('reports').entries()]
    .filter(([, r]) => r.workspaceId === workspaceId)
    .sort((a, b) => b[1].stageSeq - a[1].stageSeq)
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  await backfillUserTimeline(ctx, sessionId)
  try {
    await flushLedger(ctx, { domain, settingsDomain, workspaceId, sessionId })
  } catch {
    /* a failed extraction must not block the review */
  }
  const last = reports.length ? reports[0][1] : null
  const evidence = last && last.evidence ? last.evidence : evidenceOf(sessionId)
  const stageSeq = last ? last.stageSeq : nextStageSeq(domain, workspaceId)
  const baseline = domain.table('baselines').get(workspaceId) || null
  const sessionModel = sessionModelOf(ctx, sessionId) || (evidence && evidence.model) || null
  const outcome = await runReview(ctx, {
    domain,
    settingsDomain,
    workspaceId,
    sessionId,
    stageSeq,
    baseline,
    evidence,
    report: last ? { claim: last.claim, touched: last.touched } : null,
    sessionModel,
    parentAgent: exec && exec.agent ? exec.agent : null,
    signal: exec && exec.signal ? exec.signal : undefined,
  })
  if (!outcome.ok) {
    return {
      status: 'degraded',
      message: `天监：审查未执行（${outcome.error}）。请用 supervisor action=settings 配置审查模型。`,
      data: { reviewed: false, error: outcome.error },
    }
  }
  // Manual re-runs get their own report row so the trigger trail shows
  // kind 'manual' instead of silently inheriting the original entry.
  try {
    const manualStamp = now()
    const manualReportId = shortId('rpt')
    await domain.table('reports').put(
      manualReportId,
      STAGE_REPORT.parse({
        reportId: manualReportId,
        workspaceId,
        sessionId,
        stageSeq,
        submittedAt: manualStamp,
        claim: last ? last.claim || '' : '',
        touched: last && Array.isArray(last.touched) ? last.touched : [],
        reviewId: outcome.review.reviewId,
        trigger: { kind: 'manual', at: manualStamp, by: sessionId || 'agent' },
        evidence: evidence || null,
      }),
    )
  } catch {
    /* the review itself already landed; a missing manual row is cosmetic */
  }
  return {
    status: 'ok',
    message: verdictMessage(outcome.review, stageSeq),
    data: { reviewed: true, review: outcome.review, blocking: outcome.blocking },
  }
}

const SETTINGS_KEYS = [
  'enabled',
  'engine',
  'lightProvider',
  'lightModel',
  'deepProvider',
  'deepModel',
  'deepOnDrift',
  'timeoutMs',
  'maxBriefChars',
  'userVoiceChars',
  'requirementsChars',
  'evidenceChars',
  'ledgerEnabled',
  'ledgerMaxActive',
  'driftStreakLimit',
  'criticalLimit',
  'autoReviewMinutes',
  'interruptEnabled',
  'interruptCooldownMs',
  'agentVoiceChars',
  'childDigest',
  'kyzmemReflow',
]

async function actionSettings(ctx, exec, args) {
  const { settings: settingsDomain, error } = await storage(ctx)
  if (!settingsDomain) {
    return { status: 'degraded', message: `天监：设置域不可用（${error}）。`, data: { settings: DEFAULT_SETTINGS } }
  }
  const current = settingsOf(settingsDomain)
  const patch = args && args.config && typeof args.config === 'object' ? args.config : {}
  const next = { ...current }
  for (const key of SETTINGS_KEYS) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  try {
    const validated = SETTINGS.parse(next)
    if (Object.keys(patch).length) await settingsDomain.global.set(validated)
    const modelLine = validated.lightModel
      ? `轻审模型：${validated.lightProvider}/${validated.lightModel}`
      : '轻审模型：跟随当前会话模型'
    const engineText =
      validated.engine === 'light' ? '只用轻审' : validated.engine === 'deep' ? '只走深审' : '自动（轻审后按需升级深审）'
    const deepLine = [validated.deepProvider, validated.deepModel].filter(Boolean).join('/') || '跟随轻审模型'
    return {
      status: 'ok',
      message: [
        `天监设置${Object.keys(patch).length ? '已更新' : ''}`,
        `审查开关：${validated.enabled ? '开启' : '关闭'} · 引擎：${engineText} · 偏移后升级深审：${validated.deepOnDrift ? '开' : '关'}`,
        modelLine,
        `深审模型：${deepLine}`,
        `超时：${validated.timeoutMs}ms · 简报上限：${validated.maxBriefChars} 字（用户原话 ${validated.userVoiceChars} / 台账 ${validated.requirementsChars} / 证据 ${validated.evidenceChars}，三块独立预算）`,
        `用户要求台账：${validated.ledgerEnabled ? `开启（最多 ${validated.ledgerMaxActive} 条有效）` : '关闭'}`,
        `子会话可见：回传时间线 ${validated.agentVoiceChars} 字 · 审查摘要：${validated.childDigest ? '开启' : '关闭'}`,
        `经验回流：${validated.kyzmemReflow ? '开启（审查落库后写一条阶段教训到 kyzmem，不可用时跳过）' : '关闭'}`,
        `阻断阈值：连续偏移 ${validated.driftStreakLimit} 轮 / 严重偏移累计 ${validated.criticalLimit} 次`,
        `定时兜底：每 ${validated.autoReviewMinutes} 分钟最多审一次 · 阈值打断：${validated.interruptEnabled ? '开启' : '关闭'}（冷却 ${Math.round(validated.interruptCooldownMs / 60000)} 分钟）`,
      ].join('\n'),
      data: { settings: validated, changed: Object.keys(patch).length > 0 },
    }
  } catch (err) {
    return { status: 'error', message: `天监：设置值不合法（${String((err && err.message) || err)}）。`, data: {} }
  }
}

async function actionChildren(ctx, exec) {
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  const list = await listSessionChildren(ctx, sessionId)
  const team = await listTeammates(ctx, exec && exec.agent ? exec.agent : null)
  const children = Array.isArray(list.children) ? list.children : []
  const teammates = Array.isArray(team.teammates) ? team.teammates : []
  const tasks = Array.isArray(team.tasks) ? team.tasks : []
  const notes = [...(Array.isArray(list.notes) ? list.notes : []), ...(Array.isArray(team.notes) ? team.notes : [])]
  const lines = ['天监：本会话的子会话与队友（只读目录）']
  if (children.length) {
    lines.push(`子会话 ${children.length} 个：`)
    for (const c of children.slice(0, 12)) {
      lines.push(`  · ${c.label ? `${c.label}（` : ''}${String(c.id).slice(0, 12)}${c.label ? '）' : ''}${c.status ? ` —— ${c.status}` : ''}`)
    }
    if (children.length > 12) lines.push(`  …等共 ${children.length} 个`)
  } else {
    lines.push('子会话：无（本会话没有派生子代理）')
  }
  if (teammates.length) {
    lines.push(`队友 ${teammates.length} 人：`)
    for (const t of teammates.slice(0, 8)) {
      lines.push(`  · ${t.name}${t.role ? `（${t.role}）` : ''}${t.status ? ` —— ${t.status}` : ''}`)
    }
  } else {
    lines.push('队友：无（或需在会话内调用才能列出）')
  }
  if (tasks.length) {
    lines.push(`任务板 ${tasks.length} 项：`)
    for (const t of tasks.slice(0, 8)) lines.push(`  · ${t.title}${t.status ? ` —— ${t.status}` : ''}`)
  }
  if (notes.length) lines.push(`备注：${notes.join('；').slice(0, 300)}`)
  lines.push('深挖某子会话：supervisor action=child_read childId=<完整 id>')
  return {
    status: 'ok',
    message: lines.join('\n'),
    data: { children, teammates, tasks, notes },
  }
}

async function actionChildRead(ctx, exec, args) {
  const childId = args && typeof args.childId === 'string' ? args.childId.trim() : ''
  if (!childId) {
    return { status: 'error', message: '天监：child_read 需要 childId（先用 supervisor action=children 查目录）。', data: {} }
  }
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  // Scope gate: only this session itself or its own descendants.
  if (childId !== sessionId) {
    const subagents = safeGet(ctx, 'subagents')
    if (!subagents || typeof subagents.listChildren !== 'function') {
      return { status: 'error', message: '天监：无法核验子会话归属（subagents 不可用），拒绝回读其它会话。', data: {} }
    }
    let list
    try {
      list = await listSessionChildren(ctx, sessionId)
    } catch {
      list = null
    }
    const ids = list && Array.isArray(list.children) ? list.children.map((c) => c.id) : []
    if (!ids.includes(childId)) {
      return { status: 'error', message: `天监：${childId.slice(0, 12)} 不是本会话的子会话（只能回读自己或自己的子会话）。`, data: {} }
    }
  }
  const rawLimit = args && args.childLimit !== undefined ? Number(args.childLimit) : 40
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 40, CHILD_READ_MAX_ROWS))
  const types =
    args && Array.isArray(args.childTypes) ? args.childTypes.filter((t) => typeof t === 'string' && t) : null
  const read = await readChildSession(ctx, childId, { limit, types })
  if (!read.ok) return { status: 'error', message: `天监：${read.error}`, data: {} }
  const scope = childId === sessionId ? '本会话' : '子会话'
  return {
    status: 'ok',
    message: [
      `天监：${scope} ${childId.slice(0, 12)} —— 共 ${read.total} 个事件，回读 ${read.returned} 条${read.skipped ? `（跳过 ${read.skipped} 条无关事件）` : ''}：`,
      ...read.rows,
    ].join('\n'),
    data: read,
  }
}

async function actionEvidence(ctx, exec) {
  const sessionId = exec && exec.agent ? exec.agent.id : ''
  const backfill = await backfillUserTimeline(ctx, sessionId)
  const evidence = evidenceOf(sessionId)
  if (!evidence) {
    return {
      status: 'ok',
      message: '天监：本会话还没有采集到任何事件（采集器随插件加载启动，之前的活动不在记录内）。',
      data: { evidence: null, backfill },
    }
  }
  const diff = evidence.diffStat
  const tools = Object.entries(evidence.toolCalls.byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ')
  const files = evidence.files.slice(0, 8).map((f) => `  · ${f.path} +${f.added}/-${f.deleted}`)
  return {
    status: 'ok',
    message: [
      `天监：当前阶段证据（${evidence.turns} 回合 / ${evidence.steps} 步 / 事件 ${evidence.eventCount} 条）`,
      `文件：${diff.files} 个 +${diff.added}/-${diff.deleted}`,
      ...files,
      `工具：${tools || '无'}`,
      `命令：${evidence.tests.length ? evidence.tests.map((t) => t.command.slice(0, 60)).join(' | ') : '无'}`,
      `待办：${evidence.todos.length ? evidence.todos.map((t) => `${t.status}:${t.content.slice(0, 20)}`).join(' / ') : '无'}`,
      `目标：${evidence.goal ? `${evidence.goal.status} ${evidence.goal.objective.slice(0, 40)}` : '无'}`,
      `用户原话：${evidence.userTimeline.length ? `${evidence.userTimeline.length} 条（最近 U${evidence.userTimeline[evidence.userTimeline.length - 1].seq} ${String(evidence.userTimeline[evidence.userTimeline.length - 1].text).slice(0, 60)}）` : '无'}`,
      `事件分布：${Object.entries(evidence.topEvents).map(([type, count]) => `${type}×${count}`).join(' ')}`,
      `user/message 样本：${((accumulators.get(sessionId) || {}).userShapeSamples || []).join(' ||| ') || '未采集到'}`,
      `事件记录键：${(accumulators.get(sessionId) || {}).eventShapeSample || '未采集到'}`,
      `请求头样本：${evidence.headerRaw || '无'}`,
      evidence.diffStat.files === 0
        ? '提示：文件级证据在回合结束时写入（workspace/changes 事件），本回合结束前为 0 是正常的。'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    data: { evidence },
  }
}

async function actionReviewList(ctx, exec, args) {
  const { domain, error } = await storage(ctx)
  const workspaceId = workspaceIdOf(ctx, exec)
  if (!domain) {
    return { status: 'degraded', message: `天监：存储不可用（${error}）。`, data: { reviews: [] } }
  }
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, args.limit)) : 5
  const rows = [...domain.table('reviews').entries()]
    .filter(([, r]) => r.workspaceId === workspaceId)
    .sort((a, b) => b[1].stageSeq - a[1].stageSeq)
    .slice(0, limit)
  if (!rows.length) {
    return { status: 'ok', message: '天监：本工作区还没有审查记录。', data: { workspaceId, reviews: [] } }
  }
  const lines = rows.map(([, r]) => `· 第 ${r.stageSeq} 阶段 [${VERDICT_TEXT[r.verdict] || r.verdict}] ${r.summary.slice(0, 90)}`)
  return {
    status: 'ok',
    message: `天监：最近 ${rows.length} 条审查\n${lines.join('\n')}`,
    data: { workspaceId, reviews: rows.map(([, r]) => r) },
  }
}

async function actionJournalTail(ctx, exec, args) {
  const { domain, error } = await storage(ctx)
  if (!domain) {
    return { status: 'degraded', message: `天监：存储不可用（${error}）。`, data: { entries: [] } }
  }
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 10
  const keys = [...domain.table('journal').keys()].map(Number).sort((a, b) => b - a).slice(0, limit)
  const entries = keys.map((k) => domain.table('journal').get(String(k))).filter(Boolean)
  const lines = entries.map((e) => `#${e.seq} ${e.ts} ${e.type} ${String(e.hash).slice(0, 8)}`)
  return {
    status: 'ok',
    message: entries.length ? `天监：日志尾部 ${entries.length} 条\n${lines.join('\n')}` : '天监：日志为空。',
    data: { entries },
  }
}

// ---------------------------------------------------------------------------
// Runtime settings (separate single-layout domain: the review-engine knobs)
// ---------------------------------------------------------------------------

const SETTINGS = schema({
  enabled: F.bool(true),
  engine: F.enumOf(['auto', 'light', 'deep'], 'auto'),
  lightProvider: F.str(''),
  lightModel: F.str(''),
  deepProvider: F.str(''),
  deepModel: F.str(''),
  deepOnDrift: F.bool(true),
  timeoutMs: F.int(90000),
  maxBriefChars: F.int(8000),
  // Independent budgets: the two authority blocks (user's own words, ledger)
  // are budgeted separately so long evidence can never squeeze them out.
  userVoiceChars: F.int(1600),
  requirementsChars: F.int(900),
  evidenceChars: F.int(4200),
  ledgerEnabled: F.bool(true),
  ledgerMaxActive: F.int(80),
  budgetMigrated: F.bool(false),
  // Child-session visibility: agent回传 timeline budget + review digest switch.
  agentVoiceChars: F.int(800),
  childDigest: F.bool(true),
  // B10 kyzmem 经验回流：每次审查落库后写一条阶段教训；kyzmem 不可用时跳过。
  kyzmemReflow: F.bool(true),
  driftStreakLimit: F.int(2),
  criticalLimit: F.int(3),
  autoReviewMinutes: F.int(20),
  interruptEnabled: F.bool(false),
  interruptCooldownMs: F.int(1800000),
})

const DEFAULT_SETTINGS = {
  enabled: true,
  engine: 'auto',
  lightProvider: '',
  lightModel: '',
  deepProvider: '',
  deepModel: '',
  deepOnDrift: true,
  timeoutMs: 90000,
  maxBriefChars: 8000,
  userVoiceChars: 1600,
  requirementsChars: 900,
  evidenceChars: 4200,
  ledgerEnabled: true,
  ledgerMaxActive: 80,
  budgetMigrated: false,
  agentVoiceChars: 800,
  childDigest: true,
  kyzmemReflow: true,
  driftStreakLimit: 2,
  criticalLimit: 3,
  autoReviewMinutes: 20,
  interruptEnabled: false,
  interruptCooldownMs: 1800000,
}

const SETTINGS_SPEC = {
  name: 'supervisor_settings',
  version: 1,
  layout: 'single',
  invalidRecords: 'backup-and-skip',
  global: { schema: SETTINGS, initial: DEFAULT_SETTINGS },
  tables: {
    meta: { valueSchema: schema({ note: F.str('') }) },
  },
}

function settingsOf(settingsDomain) {
  if (!settingsDomain) return { ...DEFAULT_SETTINGS }
  try {
    const stored = settingsDomain.global.get()
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

// ---------------------------------------------------------------------------
// Per-session preferences — 天监 is session-scoped, not project-scoped.
// ---------------------------------------------------------------------------

const SESSION_PREF = schema({
  enabled: F.bool(true),
  // The review this session's lamp has already shown; clears the lamp back to green.
  viewedReviewId: F.str(''),
  updatedAt: F.str(''),
})

const SESSIONS_SPEC = {
  name: 'supervisor_sessions',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    prefs: { valueSchema: SESSION_PREF },
  },
}

function sessionPrefOf(sessionsDomain, sessionId) {
  // Fresh sessions start DISABLED (grey lamp): supervision is opt-in per
  // session — the pill click enables it, only the Tab can turn it off.
  const fallback = { enabled: false, viewedReviewId: '', updatedAt: '' }
  if (!sessionsDomain || !sessionId) return fallback
  try {
    const record = sessionsDomain.table('prefs').get(String(sessionId))
    if (!record) return fallback
    return {
      enabled: record.enabled !== false,
      viewedReviewId: record.viewedReviewId || '',
      updatedAt: record.updatedAt || '',
    }
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Session lamp bookkeeping: "unread verdict" and "review in flight".
// ---------------------------------------------------------------------------

async function setSessionViewed(ctx, sessionId, reviewId) {
  const { sessions: sessionsDomain } = await storage(ctx)
  if (!sessionsDomain || !sessionId) return { ok: false, code: 'storage-unavailable' }
  const current = sessionPrefOf(sessionsDomain, sessionId)
  const record = SESSION_PREF.parse({
    enabled: current.enabled,
    viewedReviewId: String(reviewId || ''),
    updatedAt: now(),
  })
  await sessionsDomain.table('prefs').put(String(sessionId), record)
  return { ok: true, pref: plain(record) }
}

const REVIEWING = new Map()

function bumpReviewing(sessionId, delta) {
  const key = String(sessionId || '')
  if (!key) return
  const next = (REVIEWING.get(key) || 0) + delta
  if (next > 0) REVIEWING.set(key, next)
  else REVIEWING.delete(key)
}

function isReviewing(sessionId) {
  return (REVIEWING.get(String(sessionId || '')) || 0) > 0
}

// ---------------------------------------------------------------------------
// B4 · 司天汇编 (the stateless assembler): baseline + evidence + history → brief
// ---------------------------------------------------------------------------

function renderList(title, items, prefix = '  - ') {
  if (!Array.isArray(items) || !items.length) return `${title}：（无）`
  return `${title}：\n${items.map((item) => `${prefix}${item}`).join('\n')}`
}

function renderBaseline(baseline) {
  if (!baseline) {
    return [
      '## 基线',
      '（尚未登记基线：本轮审查只能依据施工方的自述与证据，请把结论强度降到最低。）',
    ].join('\n')
  }
  const decisions = (baseline.decisions || []).slice(-5).map((d) => `${d.at} ${d.text}`)
  return [
    `## 基线（第 ${baseline.revision} 版，用户批准）`,
    `意图：${baseline.intent || '（未填写）'}`,
    renderList('目标', baseline.goals, '  ').replace('目标：', '目标：').split('\n').join('\n'),
    renderList('硬约束（违反即 blocker）', baseline.constraints ? baseline.constraints.hard : [], '  '),
    renderList('软约束（违反需说明理由）', baseline.constraints ? baseline.constraints.soft : [], '  '),
    renderList('技术方向', baseline.directions, '  '),
    decisions.length ? renderList('已记录的决定', decisions, '  ') : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function renderEvidence(evidence) {
  if (!evidence) return '## 机器采集的证据\n（本会话尚无采集数据）'
  const lines = [
    '## 机器采集的证据（施工方未经手）',
    `证据采集窗口：${evidence.openedAt || '未知'} 起（采集器随插件加载启动，早于此的活动不在记录内）`,
    `回合 ${evidence.turns} · 步 ${evidence.steps} · 最近回合结束原因：${evidence.lastTurnEnd || '进行中'}`,
    `改动：${evidence.diffStat.files} 个文件 +${evidence.diffStat.added}/-${evidence.diffStat.deleted}`,
  ]
  for (const file of evidence.files.slice(0, 12)) lines.push(`  · ${file.path} +${file.added}/-${file.deleted}`)
  if (!evidence.diffStat.files && evidence.touchedFiles && evidence.touchedFiles.length) {
    lines.push(`  （按工具调用推定被写/改的文件：${evidence.touchedFiles.map((f) => f.path).slice(0, 10).join(', ')}）`)
  }
  const tools = Object.entries(evidence.toolCalls.byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}×${count}`)
  lines.push(`工具调用 ${evidence.toolCalls.total} 次：${tools.join(' ') || '无'}`)
  if (evidence.tests.length) lines.push(`命令：${evidence.tests.map((t) => String(t.command).slice(0, 80)).join(' | ')}`)
  if (evidence.toolErrors.length) {
    lines.push(`工具失败：${evidence.toolErrors.map((e) => `${e.code}${e.reason ? `(${e.reason.slice(0, 60)})` : ''}`).join(' | ')}`)
  }
  if (evidence.todos.length) lines.push(`待办：${evidence.todos.map((t) => `${t.status}:${t.content.slice(0, 30)}`).join(' / ')}`)
  if (evidence.goal) lines.push(`目标（运行时）：${evidence.goal.status} ${evidence.goal.objective}`)
  return lines.join('\n')
}

const USER_KIND_LABEL = {
  prompt: '提问',
  steer: '插话',
  followup: '追加',
  command: '命令',
  approval: '审批',
  title: '改名',
  answer: '拍板',
}

/**
 * P0 · the user's own words, with anchors. This block is the answer to "天监
 * judged me against a requirement I already changed two stages ago".
 */
function renderUserTimeline(evidence, { recent = 12, chars = 1600 } = {}) {
  const all = evidence && Array.isArray(evidence.userTimeline) ? evidence.userTimeline : []
  if (!all.length) {
    return '## 用户原话\n（本次阶段没有采集到用户本人的消息——请勿据此推断用户没有提要求，可能只是窗口外）'
  }
  const first = all[0]
  const tail = all.slice(-recent)
  const list = first && tail.indexOf(first) < 0 ? [first, ...tail] : tail
  const omitted = all.length - list.length
  const lines = ['## 用户原话（按时间，最新在后；U<序号> 可被 findings 引用）']
  // Fill the budget from the NEWEST entry backwards: when space runs out it is
  // the old chatter that must go, never the instruction the user just gave.
  let spent = 0
  let cut = false
  const rendered = []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i]
    const stamp = String(entry.time || '').slice(11, 16)
    const label = USER_KIND_LABEL[entry.kind] || entry.kind
    const atts = entry.attachments && entry.attachments.length ? ` [附件×${entry.attachments.length}]` : ''
    let text = String(entry.text || '')
    if (spent >= chars) {
      cut = true
      break
    }
    if (spent + text.length > chars) {
      const room = Math.max(80, chars - spent)
      text = `${text.slice(0, room)}…`
      spent = chars
    } else {
      spent += text.length
    }
    rendered.push(`- U${entry.seq || '?'} [${label}${stamp ? ` ${stamp}` : ''}]${atts} ${text}`)
    if (spent >= chars) {
      cut = i > 0
      break
    }
  }
  rendered.reverse()
  if (cut) lines.push(`（更早的消息因字数上限未列出；完整时间线见天监 Tab）`)
  for (const line of rendered) lines.push(line)
  if (omitted > 0) lines.push(`（另有 ${omitted} 条较早的消息未列出；完整时间线见天监 Tab）`)
  return lines.join('\n')
}

/**
 * Decisions the user made through the question tool. Not their own words, so
 * this block is labelled as such instead of padding the transcript section.
 */
function renderUserAnswers(evidence, { chars = 800 } = {}) {
  const list = evidence && Array.isArray(evidence.userAnswers) ? evidence.userAnswers : []
  if (!list.length) return ""
  const lines = ["## 用户拍板（经提问工具作答，非用户原话；A<序号> 为对应提问调用）"]
  let spent = 0
  for (const entry of list) {
    const text = String(entry.text || "")
    const room = chars - spent
    if (room <= 0) break
    if (text.length > room) {
      lines.push(`- A${entry.seq || "?"} ${text.slice(0, Math.max(80, room))}…`)
      break
    }
    spent += text.length
    lines.push(`- A${entry.seq || "?"} ${text}`)
  }
  return lines.join("\n")
}

/**
 * Child/teammate traffic is machine text: it carries conclusions, not orders.
 * Its own section with R<seq> anchors so findings can cite it without ever
 * confusing it with the user's own words. Empty → the section is omitted, not
 * padded: no children, no cost.
 */
function renderAgentMessages(evidence, { chars = 800 } = {}) {
  const list = evidence && Array.isArray(evidence.agentMessages) ? evidence.agentMessages : []
  if (!list.length) return ''
  const lines = ['## 子代理回传（子会话/队友转述的机器文本，非用户原话；R<序号> 供 findings 引用）']
  let spent = 0
  for (const entry of list) {
    const label = agentKindLabel(entry.kind)
    const text = String(entry.text || '')
    const room = chars - spent
    if (room <= 0) break
    if (text.length > room) {
      lines.push(`- R${entry.seq || '?'} [${label}] ${text.slice(0, Math.max(80, room))}…`)
      break
    }
    spent += text.length
    const tail = entry.truncated ? '…' : ''
    lines.push(`- R${entry.seq || '?'} [${label}] ${text}${tail}`)
  }
  return lines.join('\n')
}

/** P1 · the ledger: requirements that outlived the evidence window. */
function renderRequirements(requirements, { chars = 900 } = {}) {
  const active = (Array.isArray(requirements) ? requirements : []).filter((r) => r && r.status === 'active')
  if (!active.length) {
    return '## 用户要求台账\n（暂无跨阶段要求记录：本轮只能依据基线、用户原话与自述判断）'
  }
  const lines = ['## 用户要求台账（跨阶段有效；`(单源)` = 仅一条提取路径产出，可信度略低）']
  let spent = 0
  for (const req of active) {
    const mark = req.strength === 'soft' ? '软' : '硬'
    const src = req.origin === 'both' ? '' : ' (单源)'
    const line = `- [${req.kind}/${mark}]${src} ${req.text} — U${req.sourceSeq || '?'}`
    if (spent + line.length > chars) {
      lines.push(`（另有 ${active.length - lines.length + 1} 条要求未列出）`)
      break
    }
    spent += line.length
    lines.push(line)
  }
  return lines.join('\n')
}

function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return '## 历史审查\n（这是本工作区的第一次审查）'
  const lines = history.map(
    (r) => `  · 第 ${r.stageSeq} 阶段 [${VERDICT_TEXT[r.verdict] || r.verdict}] ${String(r.summary).slice(0, 100)}`,
  )
  return ['## 历史审查（最近 3 次）', ...lines].join('\n')
}

/**
 * What the Tab's 分析记录 needs, computed at review time and stored with the
 * transcript: which baseline revision the brief pinned, how much evidence went
 * in, whether the evidence block was truncated. All inputs exist at the call
 * site — this only snapshots them.
 */
function assembleInfo({ baseline, evidence, history, brief, limit, stats }) {
  const max = Number.isFinite(limit) && limit > 500 ? limit : 8000
  const counts = stats && typeof stats === 'object' ? stats : {}
  return {
    baselineRevision: baseline && Number.isFinite(baseline.revision) ? baseline.revision : 0,
    baselineScope: baseline && baseline.scope ? baseline.scope : '',
    evidenceFiles: evidence && Array.isArray(evidence.files) ? evidence.files.length : 0,
    historyCount: Array.isArray(history) ? history.length : 0,
    userVoiceCount: Number.isFinite(counts.userVoiceCount) ? counts.userVoiceCount : 0,
    requirementCount: Number.isFinite(counts.requirementCount) ? counts.requirementCount : 0,
    agentMessageCount: Number.isFinite(counts.agentMessageCount) ? counts.agentMessageCount : 0,
    evidenceTruncated:
      typeof counts.evidenceTruncated === 'boolean'
        ? counts.evidenceTruncated
        : typeof brief === 'string' && brief.includes('已截断'),
    briefChars: typeof brief === 'string' ? brief.length : 0,
    maxBriefChars: max,
  }
}

/** Trimmed copy of the live evidence packet, stored per review for audit. */
function evidenceSnapshot(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const pick = (key) => (evidence[key] !== undefined ? evidence[key] : null)
  return {
    openedAt: pick('openedAt'),
    capturedAt: pick('capturedAt'),
    turns: pick('turns'),
    steps: pick('steps'),
    lastTurnEnd: pick('lastTurnEnd'),
    files: Array.isArray(evidence.files) ? evidence.files : [],
    touchedFiles: Array.isArray(evidence.touchedFiles) ? evidence.touchedFiles : [],
    diffStat: pick('diffStat'),
    toolCalls: pick('toolCalls'),
    toolErrors: Array.isArray(evidence.toolErrors) ? evidence.toolErrors : [],
    tests: Array.isArray(evidence.tests) ? evidence.tests : [],
    userTimeline: Array.isArray(evidence.userTimeline) ? evidence.userTimeline : [],
    eventCount: pick('eventCount'),
  }
}

/**
 * Panel 2.10: where would the NEXT review's models actually come from, with no
 * session context? Same resolution the review path uses, sessionModel = null.
 */
function modelResolutionOf(settings) {
  const light = resolveLightModel(settings, null)
  const deepExplicit =
    (settings.deepProvider || '').trim() && (settings.deepModel || '').trim()
      ? { provider: settings.deepProvider.trim(), model: settings.deepModel.trim(), source: 'settings' }
      : null
  const deep = deepExplicit ||
    (light ? { provider: light.provider, model: light.model, source: 'settings←light' } : null)
  const shape = (resolved) =>
    resolved ? { provider: resolved.provider, model: resolved.model, source: resolved.source } : null
  return { light: shape(light), deep: shape(deep) }
}

/**
 * Assemble the 司天 brief. Order matters: the two blocks that carry authority
 * (baseline, the user's own words) come first and get their own budgets, so a
 * long evidence list can never push them out. Only evidence/history are
 * trimmed, and the trim is reported to the reviewer.
 */
function buildBrief({ baseline, evidence, history, report, requirements, limit, settings, childDigest }) {
  const max = Number.isFinite(limit) && limit > 500 ? limit : 8000
  const budget = settings && typeof settings === 'object' ? settings : {}
  const userChars = Number.isFinite(budget.userVoiceChars) && budget.userVoiceChars > 200 ? budget.userVoiceChars : 1600
  const reqChars = Number.isFinite(budget.requirementsChars) && budget.requirementsChars > 200 ? budget.requirementsChars : 900
  const agentChars = Number.isFinite(budget.agentVoiceChars) && budget.agentVoiceChars > 200 ? budget.agentVoiceChars : 800
  const evidenceCap = Number.isFinite(budget.evidenceChars) && budget.evidenceChars > 500 ? budget.evidenceChars : 4200
  const claim = report && report.claim ? `## 施工方自述\n${report.claim}` : '## 施工方自述\n（未提交说明）'
  const touched = report && report.touched && report.touched.length ? `\n自述涉及文件：${report.touched.join(', ')}` : ''
  const baselineText = renderBaseline(baseline)
  const userText = renderUserTimeline(evidence, { chars: userChars })
  const reqText = renderRequirements(requirements, { chars: reqChars })
  const answersText = renderUserAnswers(evidence)
  const agentText = renderAgentMessages(evidence, { chars: agentChars })
  const digestText = typeof childDigest === 'string' && childDigest ? childDigest : ''
  const historyText = renderHistory(history)
  const evidenceText = renderEvidence(evidence)
  const reserved =
    baselineText.length +
    userText.length +
    reqText.length +
    answersText.length +
    agentText.length +
    digestText.length +
    claim.length +
    touched.length +
    historyText.length
  let evidenceCap2 = evidenceCap
  const room = max - reserved
  if (room < evidenceCap2) evidenceCap2 = Math.max(800, room)
  const evidenceOut =
    evidenceText.length > evidenceCap2
      ? `${evidenceText.slice(0, evidenceCap2)}\n…（证据超过字数上限，已截断；基线与用户原话始终完整给出）`
      : evidenceText
  return {
    text: [baselineText, reqText, userText, answersText, agentText, digestText, claim + touched, evidenceOut, historyText]
      .filter((part) => Boolean(part))
      .join('\n\n'),
    stats: {
      userVoiceCount: evidence && Array.isArray(evidence.userTimeline) ? evidence.userTimeline.length : 0,
      requirementCount: Array.isArray(requirements) ? requirements.filter((r) => r && r.status === 'active').length : 0,
      agentMessageCount: evidence && Array.isArray(evidence.agentMessages) ? evidence.agentMessages.length : 0,
      evidenceTruncated: evidenceText.length > evidenceCap2,
      chars: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// P1 · 用户要求台账 (requirement ledger)
//
// Two independent producers write into the same ledger and cross-confirm:
//   · extract — a small dedicated call after new user messages arrive
//   · review  — 观天 emits requirement ops alongside its verdict
// An item confirmed by both is trustworthy; an item from one path only is
// marked `(单源)` in the brief so the reviewer can weight it accordingly.
// ---------------------------------------------------------------------------

const REQUIREMENT_KINDS = new Set(['goal', 'constraint', 'direction', 'preference'])

const REQUIREMENT_EXTRACT_SYSTEM = [
  '你是「天监·司天」的要求归纳环节。你只做一件事：把用户**明确说出的要求**整理成可持续沿用的台账条目。',
  '',
  '条目分四类：goal（要做成什么）、constraint（不能违反的限制，尤其"不要/禁止/必须"）、direction（技术方向或偏好做法）、preference（表达偏好）。',
  '',
  '规则：',
  '1. 只记录用户本人说的；不要记录你自己的推断或施工方的说法。没有明确要求就输出空 ops。',
  '2. 用户改主意时用 supersede（target 填旧条目的原文片段）；明确撤销用 revoke。',
  '3. 一条要求一句话，≤60 字，保留可判定的具体信息（文件名、阈值、禁令）。',
  '4. "继续"、提问、抱怨、闲聊都不算要求。',
  '5. 只输出严格 JSON（不要 markdown、不要解释；字符串值内一律不使用英文双引号（需要引用时用「」），否则 JSON 无法解析。）：',
  '{"ops":[{"op":"add|supersede|revoke","text":"要求原文","kind":"goal|constraint|direction|preference","strength":"hard|soft","target":"旧条目片段","quote":"用户原话片段"}]}',
].join('\n')

function normalizeRequirement(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 200)
}

function requirementId(text) {
  const norm = normalizeRequirement(text)
  let hash = 5381
  for (let i = 0; i < norm.length; i += 1) hash = ((hash << 5) + hash + norm.charCodeAt(i)) >>> 0
  return `req-${hash.toString(36)}`
}

function activeRequirements(domain, workspaceId) {
  if (!domain) return []
  try {
    return [...domain.table('requirements').entries()]
      .map(([, req]) => req)
      .filter((req) => req && req.workspaceId === workspaceId && req.status === 'active')
      .sort((a, b) => (b.sourceSeq || 0) - (a.sourceSeq || 0))
  } catch {
    return []
  }
}

function matchRequirement(list, target) {
  const norm = normalizeRequirement(target)
  if (!norm) return null
  for (const req of list) {
    const other = normalizeRequirement(req.text)
    if (!other) continue
    if (other.includes(norm) || norm.includes(other)) return req
  }
  return null
}

async function applyRequirementOps(ctx, { domain, workspaceId, sessionId, ops, origin, evidence }) {
  const stats = { added: 0, superseded: 0, revoked: 0, crossConfirmed: 0 }
  if (!domain || !Array.isArray(ops) || !ops.length) return stats
  const table = domain.table('requirements')
  const stamp = now()
  const timeline = evidence && Array.isArray(evidence.userTimeline) ? evidence.userTimeline : []
  const lastSeq = timeline.length ? timeline[timeline.length - 1].seq || 0 : 0
  for (const raw of ops) {
    try {
      const op = String((raw && raw.op) || '').toLowerCase()
      let active = activeRequirements(domain, workspaceId)
      if (op === 'revoke') {
        const hit = matchRequirement(active, raw && raw.target)
        if (hit) {
          await table.put(hit.reqId, REQUIREMENT.parse({ ...hit, status: 'revoked', at: stamp }))
          stats.revoked += 1
        }
        continue
      }
      const text = String((raw && raw.text) || '').trim().slice(0, 120)
      if (!text) continue
      const kind = REQUIREMENT_KINDS.has(raw && raw.kind) ? raw.kind : 'goal'
      const strength = raw && raw.strength === 'soft' ? 'soft' : 'hard'
      const same = matchRequirement(active, text)
      if (same) {
        // Cross-path confirmation: the same requirement seen by both producers.
        if (same.origin && same.origin !== origin && same.origin !== 'both') {
          await table.put(same.reqId, REQUIREMENT.parse({ ...same, origin: 'both' }))
          stats.crossConfirmed += 1
        }
        continue
      }
      const superseded = op === 'supersede' ? matchRequirement(active, raw && raw.target) : null
      const reqId = requirementId(text)
      active = activeRequirements(domain, workspaceId)
      await table.put(
        reqId,
        REQUIREMENT.parse({
          reqId,
          workspaceId,
          sessionId,
          text,
          kind,
          strength,
          status: 'active',
          sourceSeq: Number(raw && raw.sourceSeq) || lastSeq,
          sourceQuote: String((raw && raw.quote) || '').slice(0, 160),
          turn: 0,
          at: stamp,
          origin: origin === 'review' ? 'review' : 'extract',
          supersedes: superseded ? superseded.reqId : '',
        }),
      )
      stats.added += 1
      if (superseded) {
        await table.put(superseded.reqId, REQUIREMENT.parse({ ...superseded, status: 'superseded', at: stamp }))
        stats.superseded += 1
      }
    } catch {
      /* one malformed op must never break the batch */
    }
  }
  return stats
}

/**
 * Models like to put unescaped ASCII quotes inside Chinese prose, which kills
 * JSON.parse. Walk the text once and turn any quote that cannot be structural
 * into a typographic one, so a nearly-valid answer still parses.
 */
function repairJsonQuotes(raw) {
  let out = ''
  let inString = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '\\') {
      out += ch
      if (i + 1 < raw.length) {
        out += raw[i + 1]
        i += 1
      }
      continue
    }
    if (ch !== '"') {
      out += ch
      continue
    }
    if (!inString) {
      inString = true
      out += ch
      continue
    }
    let j = i + 1
    while (j < raw.length && /\s/.test(raw[j])) j += 1
    const next = raw[j]
    if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
      inString = false
      out += ch
    } else {
      out += '\u201d'
    }
  }
  return out
}

/** Parse the outermost JSON object, repairing stray quotes once if needed. */
function parseIntent(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = text.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    try {
      return JSON.parse(repairJsonQuotes(slice))
    } catch {
      return null
    }
  }
}

function parseLedgerOps(text) {
  const parsed = parseIntent(text)
  if (!parsed) return null
  return Array.isArray(parsed.ops) ? parsed.ops.slice(0, 24) : []
}

const ledgerBusy = new Set()

/** Best-effort extraction of new user requirements for one session. */
async function extractRequirements(ctx, { domain, settingsDomain, workspaceId, sessionId, timeoutMs }) {
  const settings = settingsOf(settingsDomain)
  if (!settings.ledgerEnabled) return { ok: false, skipped: true, error: '台账提炼已关闭' }
  const acc = accumulators.get(sessionId)
  if (!acc) return { ok: false, skipped: true, error: '本会话没有采集器' }
  const fresh = acc.userTimeline.filter((entry) => (entry.seq || 0) > (acc.lastExtractSeq || 0))
  if (!fresh.length) {
    acc.ledgerDirty = false
    return { ok: true, stats: null, count: 0 }
  }
  const target = resolveLightModel(settings, sessionModelOf(ctx, sessionId) || acc.model || null)
  if (!target) return { ok: false, error: '未能确定提炼模型（请设置 lightProvider/lightModel 或使用可见模型的会话）' }
  const active = activeRequirements(domain, workspaceId)
  const ledgerText = active.length
    ? active.slice(0, 40).map((req) => `- [${req.kind}/${req.strength}] ${req.text}`).join('\n')
    : '（空）'
  const freshText = fresh
    .slice(-12)
    .map((entry) => `- U${entry.seq} [${entry.kind}] ${entry.text}`)
    .join('\n')
  const user = `当前台账（active）：\n${ledgerText}\n\n新增的用户消息（按时间，U 后面的数字是锚点）：\n${freshText}\n\n请输出 ops JSON。`
  const call = await callModel(ctx, {
    provider: target.provider,
    model: target.model,
    system: REQUIREMENT_EXTRACT_SYSTEM,
    user,
    timeoutMs: Number(timeoutMs) > 0 ? timeoutMs : Math.min(settings.timeoutMs, 30000),
  })
  if (!call.ok) return { ok: false, error: call.error }
  const ops = parseLedgerOps(call.text)
  if (!ops) return { ok: false, error: `台账输出无法解析：${call.text.slice(0, 120)}` }
  const stats = await applyRequirementOps(ctx, {
    domain,
    workspaceId,
    sessionId,
    ops,
    origin: 'extract',
    evidence: evidenceOf(sessionId),
  })
  acc.lastExtractSeq = acc.lastSeq
  acc.ledgerDirty = false
  if (ops.length) {
    await appendJournal(domain, 'requirements_extracted', { workspaceId, stats })
  }
  return { ok: true, stats, count: ops.length }
}

/** Flush pending extractions before a review so 观天 sees the current ledger. */
async function flushLedger(ctx, { domain, settingsDomain, workspaceId, sessionId }) {
  const acc = accumulators.get(sessionId)
  if (!acc || !acc.ledgerDirty || ledgerBusy.has(sessionId)) return null
  ledgerBusy.add(sessionId)
  try {
    return await extractRequirements(ctx, { domain, settingsDomain, workspaceId, sessionId, timeoutMs: 25000 })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  } finally {
    ledgerBusy.delete(sessionId)
  }
}

/** Background tick: pick up user messages that no review has touched yet. */
function startLedger(ctx) {
  const timer = ctx.get('timer')
  if (!timer || typeof timer.interval !== 'function') return () => {}
  const handle = timer.interval(() => {
    void (async () => {
      try {
        const { domain, settings: settingsDomain } = await storage(ctx)
        if (!domain) return
        const settings = settingsOf(settingsDomain)
        if (!settings.ledgerEnabled) return
        for (const [sessionId, acc] of accumulators) {
          if (!acc.ledgerDirty || ledgerBusy.has(sessionId)) continue
          ledgerBusy.add(sessionId)
          try {
            const workspaceId = workspaceIdOfSession(ctx, sessionId)
            await extractRequirements(ctx, {
              domain,
              settingsDomain,
              workspaceId,
              sessionId,
              timeoutMs: Math.min(settings.timeoutMs, 30000),
            })
          } finally {
            ledgerBusy.delete(sessionId)
          }
        }
      } catch {
        /* the ledger must never disturb the session stream */
      }
    })()
  }, 60000)
  return () => {
    try {
      if (typeof handle === 'function') handle()
      else if (handle && typeof handle.dispose === 'function') handle.dispose()
    } catch {
      /* ignore */
    }
  }
}


// ---------------------------------------------------------------------------
// B5 · 观天轻审: one isolated model call, strict JSON verdict back
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM = [
  '你是「天监·观天」，一名独立的需求监督审查者。',
  '你唯一要判断的是：施工方刚刚完成的这个阶段，是否偏离了用户批准的基线与用户本人提出的要求。你不评价代码风格好坏，也不替施工方设计实现。',
  '',
  '审查规则：',
  '1. 权威顺序：**用户最新明确要求 > 基线 > 施工方自述**。',
  '   基线是用户批准的长期约束；但用户随时可能改主意。当"用户原话"里出现了比基线更新的明确要求时，以用户原话为准。',
  '1b. 若用户的最新要求与基线冲突：不要直接判 drift。判 minor 且 findings 的 kind 写 "baseline-stale"，detail 说明"用户已改要求，基线第 N 版需要更新"，并把 blocking 设为 true —— 这是要用户拍板的事，不是施工方的错。',
  '1c. 「子代理回传」与「子会话摘要」是机器转述（子会话/队友的结论），权威性低于用户原话：与用户原话冲突时以用户原话为准；只能用它们补全事实链，不能单独据此判 drift。引用时用 R<序号> 锚点（如 R9120）。',
  '2. 只依据给出的证据与汇报下判断，不臆测未提供的信息；证据不足时写进 findings 并降低结论强度。',
  '2b. 若证据采集窗口明显短于阶段本身（例如插件刚重载），自述提到窗口外的改动属于正常，不要因此判定「证据与自述矛盾」。',
  '3. 「合情合理」＝该决定服务于基线或用户最新要求里已列出的目标，且不违反任何硬约束。',
  '4. 越界情形：扩大功能范围、改变用户可见行为、违反硬约束、偏离技术方向、擅自引入依赖或破坏性改动。',
  '4b. 引用用户要求时**必须带锚点**（如 U8557）；找不到锚点支持的判断，只能写进 findings 的"证据不足"，不能据此判 drift。',
  '5. 输出必须是严格 JSON（不要 markdown 代码块、不要任何解释文字；字符串值内一律不使用英文双引号（需要引用时用「」），否则 JSON 无法解析。），形状如下：',
  '{"verdict":"aligned|minor|drift|critical","summary":"一句话结论","findings":[{"kind":"scope|behavior|constraint|direction|quality|risk|baseline-stale","severity":"low|medium|high","detail":"具体事实"}],"suggestion":"给施工方的一条可执行建议","blocking":false,"requirements":[{"op":"add|supersede|revoke","text":"用户明确提出的要求（≤60 字）","kind":"goal|constraint|direction|preference","strength":"hard|soft","target":"被取代/撤销的旧条目片段","quote":"用户原话片段"}]}',
  '',
  '判级标准：aligned＝完全对齐；minor＝有小问题但未越界；drift＝已出现需求偏移或范围扩张；critical＝违反硬约束、改变用户可见行为或重大架构偏离。',
  'blocking 仅在结论为 critical、基线已过期需用户裁决、或该问题必须由用户拍板时为 true。findings 最多 5 条，每条 detail 不超过 120 字。',
  'requirements 只记录**用户在"用户原话"里明确提出的**要求（不是施工方的计划）；没有就留空数组。',
].join('\n')

function parseVerdict(text) {
  const parsed = parseIntent(text)
  if (!parsed || typeof parsed !== 'object') return null
  const allowed = ['aligned', 'minor', 'drift', 'critical']
  const verdict = allowed.includes(parsed.verdict) ? parsed.verdict : 'minor'
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .filter((f) => f && typeof f === 'object')
        .slice(0, 5)
        .map((f) => ({
          kind: String(f.kind || 'risk').slice(0, 20),
          severity: ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'medium',
          detail: String(f.detail || '').slice(0, 300),
        }))
    : []
  return {
    verdict,
    summary: String(parsed.summary || '').slice(0, 400),
    findings,
    suggestion: String(parsed.suggestion || '').slice(0, 400),
    blocking: parsed.blocking === true,
    requirements: Array.isArray(parsed.requirements) ? parsed.requirements.slice(0, 12) : [],
  }
}

async function callModel(ctx, { provider, model, system, user, timeoutMs }) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm 服务不可用' }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }, Math.max(10000, Number(timeoutMs) || 90000))
  let text = ''
  let finish = ''
  let failure = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal: controller.signal,
      temperature: 0,
    })
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text || ''
      else if (chunk.type === 'finish') {
        finish = chunk.reason && chunk.reason.kind ? chunk.reason.kind : ''
        if (chunk.reason && chunk.reason.failure) {
          failure = String(chunk.reason.failure.message || chunk.reason.failure.code || '调用失败')
        }
      }
    }
  } catch (err) {
    failure = String((err && err.message) || err)
  } finally {
    clearTimeout(timer)
  }
  if (failure) return { ok: false, error: failure, text }
  if (!text.trim()) return { ok: false, error: `模型没有返回文本（finish=${finish || 'unknown'}）`, text }
  return { ok: true, text, finish }
}

function resolveLightModel(settings, sessionModel) {
  const provider = (settings.lightProvider || '').trim()
  const model = (settings.lightModel || '').trim()
  if (provider && model) return { provider, model, source: 'settings' }
  if (sessionModel && sessionModel.provider && sessionModel.model) {
    return { provider: sessionModel.provider, model: sessionModel.model, source: 'session' }
  }
  return null
}

/** Best-effort discovery of the model the running session is using. */
function sessionModelOf(ctx, sessionId) {
  const acc = accumulators.get(sessionId)
  if (acc && acc.model && acc.model.provider && acc.model.model) return acc.model
  try {
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = session && (session.requestHeader || session.header)
    if (header && typeof header === 'object') {
      const config = header.config && typeof header.config === 'object' ? header.config : header
      const provider = config.provider || (header.route && header.route.provider) || ''
      const model = config.model || (header.route && header.route.model) || ''
      if (provider && model) return { provider, model }
    }
  } catch {
    /* fall through */
  }
  return null
}

function recentReviewDigest(domain, workspaceId, limit) {
  return [...domain.table('reviews').entries()]
    .filter(([, r]) => r.workspaceId === workspaceId && r.verdict !== 'pending')
    .sort((a, b) => b[1].stageSeq - a[1].stageSeq)
    .slice(0, limit)
    .map(([, r]) => r)
}

function nextCounters(counters, verdict) {
  const off = verdict === 'drift' || verdict === 'critical'
  return {
    ...counters,
    reviewCount: (counters.reviewCount || 0) + 1,
    lastReviewAt: now(),
    criticalCount: verdict === 'critical' ? (counters.criticalCount || 0) + 1 : counters.criticalCount || 0,
    driftStreak: off ? (counters.driftStreak || 0) + 1 : 0,
  }
}

/** Run one light review and persist it. Never throws: failures are reported. */
async function runLightReview(ctx, deps, opts = {}) {
  const { domain, settingsDomain, workspaceId, stageSeq, baseline, evidence, report, sessionModel } = deps
  const startedAt = Date.now()
  const settings = settingsOf(settingsDomain)
  if (!settings.enabled) return { ok: false, skipped: true, error: '审查已关闭（supervisor settings enabled=false）' }
  const target = resolveLightModel(settings, sessionModel)
  if (!target) {
    return {
      ok: false,
      error: '未能确定审查模型：请用 supervisor action=settings 设置 lightProvider 与 lightModel。',
    }
  }
  const history = recentReviewDigest(domain, workspaceId, 3)
  const requirements = activeRequirements(domain, workspaceId)
  const briefObj = buildBrief({
    baseline,
    evidence,
    history,
    report,
    requirements,
    limit: settings.maxBriefChars,
    settings,
    childDigest: deps.childDigest,
  })
  const brief = briefObj.text
  const call = await callModel(ctx, {
    provider: target.provider,
    model: target.model,
    system: REVIEW_SYSTEM,
    user: brief,
    timeoutMs: settings.timeoutMs,
  })
  if (!call.ok) return { ok: false, error: call.error, engine: 'light', model: target }
  const parsed = parseVerdict(call.text)
  if (!parsed) return { ok: false, error: `裁决无法解析：${call.text.slice(0, 160)}`, engine: 'light', model: target }
  // The reviewer's own requirement ops (path B of the cross-check).
  const reqStats = await applyRequirementOps(ctx, {
    domain,
    workspaceId,
    sessionId: deps.sessionId || '',
    ops: parsed.requirements,
    origin: 'review',
    evidence,
  })
  const counters = opts.countersBase || (await countersOf(ctx, workspaceId, deps.sessionId))
  const stamp = now()
  const reviewId = shortId('rev')
  const updated = nextCounters(counters, parsed.verdict)
  const blocking =
    parsed.blocking ||
    updated.criticalCount >= settings.criticalLimit ||
    updated.driftStreak >= settings.driftStreakLimit
  const review = REVIEW.parse({
    reviewId,
    workspaceId,
    sessionId: deps.sessionId || '',
    stageSeq,
    createdAt: stamp,
    verdict: parsed.verdict,
    summary: parsed.summary || parsed.suggestion || '',
    findings: parsed.findings,
    suggestion: parsed.suggestion,
    blocking,
    engine: 'light',
    handover: false,
    model: `${target.provider}/${target.model}`,
    modelSource: target.source || '',
    upgradeReason: opts.upgradeReason || 'direct-light',
    durationMs: Date.now() - startedAt,
    tokens: 0,
  })
  await domain.table('reviews').put(reviewId, review)
  await saveCounters(ctx, workspaceId, blocking ? { ...updated, pendingNotice: noticeFor(review) } : updated, deps.sessionId)
  // Keep 观天's raw reasoning next to its verdict so the Tab can show the whole pass.
  await saveTranscript(ctx, reviewId, {
    reviewId,
    sessionId: deps.sessionId || '',
    workspaceId,
    stageSeq,
    createdAt: stamp,
    engine: 'light',
    model: `${target.provider}/${target.model}`,
    modelSource: target.source || '',
    upgradeReason: opts.upgradeReason || 'direct-light',
    durationMs: Date.now() - startedAt,
    brief,
    assembleNotes: `基线：${baseline ? `第 ${baseline.revision} 版` : '未登记'} · 用户原话 ${briefObj.stats.userVoiceCount} 条 · 台账 ${briefObj.stats.requirementCount} 条 · 证据：${evidence ? `${(evidence.files || []).length} 文件` : '无'}${reqStats.added || reqStats.superseded ? ` · 本轮新增/更新要求 ${reqStats.added}/${reqStats.superseded}` : ''}`,
    assemble: assembleInfo({ baseline, evidence, history, brief, limit: settings.maxBriefChars, stats: briefObj.stats }),
    baselineRevision: baseline && Number.isFinite(baseline.revision) ? baseline.revision : 0,
    evidenceStructured: evidenceSnapshot(evidence),
    lightRaw: call.text,
    verdict: parsed.verdict,
  })
  await appendJournal(domain, 'review_completed', {
    workspaceId,
    stageSeq,
    reviewId,
    verdict: parsed.verdict,
    blocking,
    engine: 'light',
    model: review.model,
  })
  return { ok: true, review, blocking, settings, engine: 'light', model: target }
}

function verdictMessage(review, stageSeq) {
  const lines = [`天监：第 ${stageSeq} 阶段审查完成 —— 【${VERDICT_TEXT[review.verdict] || review.verdict}】`]
  if (review.summary) lines.push(`结论：${review.summary}`)
  if (review.findings.length) {
    lines.push('发现：')
    for (const f of review.findings) lines.push(`  · [${f.severity}/${f.kind}] ${f.detail}`)
  }
  if (review.suggestion) lines.push(`建议：${review.suggestion}`)
  if (review.blocking) lines.push('⚠ 该阶段被标记为阻塞级：请暂停新增工作，先向用户说明并取得裁决。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// B6 · 观天深审 (two passes: 细读找疑点 → 对抗核验出裁决) + engine selection
// ---------------------------------------------------------------------------

const DEEP_ANALYSIS_SYSTEM = [
  '你是「观天·细读」，需求监督流程的第一道分析环节。',
  '你会收到一份审查简报：用户批准的基线（意图 / 目标 / 硬约束 / 软约束 / 技术方向）、本阶段机器采集的证据、以及施工方的自述。',
  '你的任务不是下最终结论，而是找出**值得怀疑的点**：范围扩大、用户可见行为改变、约束被违反、技术方向漂移、证据与自述不符、明显未完成却宣称完成。',
  '要求：',
  '1. 每条疑点都要指出依据来自简报的哪一段（basis 字段）。',
  '2. 最多 8 条，按严重程度从高到低。',
  '3. 不要复述基线，不要给建议，不要下最终裁决。',
  '只输出 JSON（字符串值内一律不使用英文双引号（需要引用时用「」），否则 JSON 无法解析。）：{"suspicions":[{"kind":"scope|behavior|constraint|direction|risk","severity":"low|medium|high","detail":"...","basis":"..."}],"notes":"..."}',
].join('\n')

const DEEP_VERIFY_SYSTEM = [
  REVIEW_SYSTEM,
  '',
  '## 本次是深审（第二道关）',
  '你是第二审阅者。简报末尾会给出第一位审阅者提出的疑点清单，请你逐条核对。',
  '规则：只有证据支持、或证据明显与之矛盾的疑点才保留；证据不足的一律丢弃，不要因为「有人提过」就采信。',
  '宁可判 aligned，也不要凭空指控。最终输出必须仍是那一个 JSON 对象。',
].join('\n')

function parseSuspicions(text) {
  const parsed = parseIntent(text)
  if (!parsed || typeof parsed !== 'object') return null
  const list = Array.isArray(parsed.suspicions) ? parsed.suspicions : []
  return list
    .filter((s) => s && typeof s === 'object')
    .slice(0, 8)
    .map((s) => ({
      kind: String(s.kind || 'risk').slice(0, 20),
      severity: ['low', 'medium', 'high'].includes(s.severity) ? s.severity : 'medium',
      detail: String(s.detail || '').slice(0, 300),
      basis: String(s.basis || '').slice(0, 200),
    }))
}

function resolveDeepModel(settings, sessionModel) {
  const provider = (settings.deepProvider || settings.lightProvider || '').trim()
  const model = (settings.deepModel || settings.lightModel || '').trim()
  if (provider && model) return { provider, model, source: 'settings' }
  return resolveLightModel(settings, sessionModel)
}

function renderSuspicions(suspicions) {
  if (!suspicions || !suspicions.length) return '（第一位审阅者没有提出具体疑点。）'
  return suspicions
    .map((s, i) => `${i + 1}. [${s.severity}/${s.kind}] ${s.detail}${s.basis ? `（依据：${s.basis}）` : ''}`)
    .join('\n')
}

/** Two-pass deep review. Same persistence contract as the light one. */
// ---------------------------------------------------------------------------
// Deep review via 观天 subagent （真子代理，干净上下文）
//
// engine=deep 或轻审升级时，优先派一个带 `guantian` 预设的 spawn 子代理做深审：
// 它看不到施工会话的上下文，只拿到本轮简报材料，自己可读仓库验证。
// 超时按拍板执行：10 分钟软提醒（steer 一句"准备收尾"）→ 15 分钟硬超时 →
// 派接棒观天（handover:true，5 分钟，直接给裁决）→ 再失败则回退本地两段式。
// 任何一步失败都不影响审查本身：wrapper 永远有本地回退。
// ---------------------------------------------------------------------------

const GUANTAIN_PRESET = 'guantian'
const DEEP_SOFT_MS = 10 * 60 * 1000
const DEEP_HARD_MS = 15 * 60 * 1000
const DEEP_HANDOVER_MS = 5 * 60 * 1000

function buildGuantianPrompt(brief, { handover } = {}) {
  return [
    handover
      ? '你是接棒观天。上一位观天未能按时完成，你不做新的调研，只依据下面已给的材料直接给出裁决。'
      : '你是观天。施工方提交了本阶段的自述与证据，你在干净上下文里审阅：判断是否发生需求偏移。',
    '材料（基线永远完整，引用用户原话时标注 U<seq>，引用子代理回传时标注 R<序号>；与基线冲突的按 baseline-stale 处理，不要判施工方的错）：',
    brief,
    [
      '输出契约：你的最后一条回复里必须包含且仅包含一个 JSON 代码块，形状如下（verdict 只能是 aligned/minor/drift/critical 四选一；findings 最多 5 条，每条 {kind, severity: low/medium/high, detail}）：',
      '```json',
      '{"verdict":"aligned","summary":"一句话结论","findings":[],"suggestion":"给施工方的纠偏建议","blocking":false,"requirements":[]}',
      '```',
      '先写你的分析过程，最后再给出上面的 JSON 块（解析只取首个 { 到末个 }，JSON 之外可以有中文分析）。',
    ].join('\n'),
  ].join('\n\n')
}

function resolveDeepParent(ctx, deps) {
  if (deps.parentAgent) return deps.parentAgent
  try {
    const agents = safeGet(ctx, 'agents')
    if (agents && typeof agents.get === 'function') {
      const agent = agents.get(deps.sessionId)
      if (agent) return agent
    }
  } catch {
    /* fall through to local */
  }
  return null
}

async function spawnGuantian(ctx, { parent, signal, brief, model, handover, label }) {
  const subagents = safeGet(ctx, 'subagents')
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { ok: false, error: 'subagents 服务不可用' }
  }
  let providers = []
  try {
    providers = subagents.list() || []
  } catch {
    providers = []
  }
  if (providers.length && !providers.includes('spawn')) return { ok: false, error: 'spawn provider 不可用' }
  // Capability pre-check: only ask for what this provider supports.
  let caps = null
  try {
    const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider('spawn') : null
    caps = (provider && provider.capabilities) || null
  } catch {
    caps = null
  }
  const prompt = buildGuantianPrompt(brief, { handover })
  const request = { prompt: [{ type: 'text', text: prompt }], parent }
  const wantsPreset = !caps || caps.agentPreset !== false
  if (wantsPreset) request.agentPreset = GUANTAIN_PRESET
  if (model && model.provider && model.model && (!caps || caps.agentOptions !== false)) {
    request.agentOptions = { provider: model.provider, model: model.model }
  }
  try {
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: label || (handover ? '接棒观天' : '观天深审'),
      request,
      signal,
      delivery: 'parent',
    })
    return {
      ok: true,
      activation,
      childId: activation.childId || '',
      via: request.agentPreset ? 'spawn/guantian' : 'spawn/inherit',
    }
  } catch (err) {
    return { ok: false, error: `派生观天失败：${String((err && err.message) || err).slice(0, 200)}` }
  }
}

async function steerGuantian(ctx, parent, childId, text) {
  try {
    const subagents = safeGet(ctx, 'subagents')
    if (!subagents || typeof subagents.sendMessage !== 'function') return false
    await subagents.sendMessage(parent, childId, text, { delivery: 'steer' })
    return true
  } catch {
    try {
      const subagents = safeGet(ctx, 'subagents')
      if (!subagents || typeof subagents.sendMessage !== 'function') return false
      await subagents.sendMessage(parent, childId, text)
      return true
    } catch {
      return false
    }
  }
}

// Run one 观天 child to completion with soft/hard timeouts. Returns
// {ok:true, output, childId, via, stopReason} or {ok:false, error, timedOut}.
// The child's final answer lives in the CHILD session log — activation.result
// is only a completion signal (its `output` field comes back empty; the real
// text is delivered to the parent inbox and, authoritatively, to the child's
// own session). So: wait for completion, then read the child session and take
// the verdict from its assistant messages. Polls until the verdict keyword
// appears or the caller's signal aborts (hard timeout owns the deadline).
async function collectChildOutput(ctx, childId, signal) {
  const query = safeGet(ctx, 'sessionQuery')
  if (!query || typeof query.readSession !== 'function') return ''
  const sleep = (ms) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  let lastText = ''
  for (;;) {
    let snap = null
    try {
      snap = await query.readSession(String(childId))
    } catch {
      snap = null
    }
    const events = snap && Array.isArray(snap.events) ? snap.events : []
    const texts = []
    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      if (event.type === 'assistant/message') {
        try {
          const t = messageParts(event.data).text
          if (t) texts.push(t)
        } catch {
          /* skip one bad message */
        }
      }
    }
    if (texts.length) lastText = texts.join('\n\n').slice(-20000)
    if (lastText.includes('"verdict"')) return lastText
    try {
      await sleep(8000)
    } catch {
      return lastText
    }
  }
}

async function awaitGuantian(ctx, { parent, signal, brief, model, handover, timeoutMs, softMs }) {
  const controller = new AbortController()
  let parentAborted = false
  if (signal) {
    if (signal.aborted) {
      controller.abort()
      parentAborted = true
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }
  const spawn = await spawnGuantian(ctx, { parent, signal: controller.signal, brief, model, handover })
  if (!spawn.ok) return { ok: false, error: spawn.error, timedOut: false }
  let softTimer = null
  if (softMs && softMs > 0) {
    softTimer = setTimeout(() => {
      void (async () => {
        const ok = await steerGuantian(ctx, parent, spawn.childId, '观天：已用时 10 分钟，请准备收尾，在 5 分钟内给出裁决 JSON。')
        try {
          const store = await storage(ctx)
          if (store.domain) {
            await appendJournal(store.domain, 'deep_review_nudge', {
              workspaceId: '',
              stageSeq: 0,
              childId: spawn.childId,
              steered: ok,
            })
          }
        } catch {
          /* the nudge itself must not fail anything */
        }
      })()
    }, softMs)
  }
  const hardTimer = setTimeout(() => controller.abort(), Math.max(30000, timeoutMs))
  let result = null
  let failed = ''
  try {
    result = await Promise.race([
      spawn.activation.result,
      new Promise((_, reject) => {
        if (controller.signal.aborted) reject(new Error('aborted'))
        else controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    ])
  } catch (err) {
    failed = String((err && err.message) || err)
  } finally {
    if (softTimer) clearTimeout(softTimer)
    clearTimeout(hardTimer)
  }
  // activation.result is only a completion signal — its `output` field comes
  // back empty. The real answer lives in the child session log.
  const stopReason =
    result && (result.stopReason || result.status || result.reason)
      ? String(result.stopReason || result.status || result.reason)
      : ''
  let output = ''
  if (!failed) {
    try {
      output = await collectChildOutput(ctx, spawn.childId, controller.signal)
    } catch (err) {
      failed = String((err && err.message) || err)
    }
  }
  try {
    if (typeof spawn.activation.dispose === 'function') await spawn.activation.dispose()
  } catch {
    /* disposal is best-effort */
  }
  if (failed && !output.trim()) {
    const aborted = controller.signal.aborted
    return { ok: false, error: failed ? failed.slice(0, 200) : `观天没有返回文本（stopReason=${stopReason || 'unknown'}）`, timedOut: aborted && !parentAborted }
  }
  if (!output.trim()) {
    return { ok: false, error: `观天没有返回文本（stopReason=${stopReason || 'unknown'}）`, timedOut: false }
  }
  return { ok: true, output, childId: spawn.childId, via: spawn.via, stopReason }
}

async function runDeepReviewViaSubagent(ctx, deps, opts, { handover, timeoutMs, softMs }) {
  const settings = settingsOf(deps.settingsDomain)
  const target = resolveDeepModel(settings, deps.sessionModel)
  if (!target) {
    return { ok: false, error: '未能确定深审模型：请用 supervisor action=settings 设置 deepProvider/deepModel（或 light 那两个）。', timedOut: false }
  }
  const parent = resolveDeepParent(ctx, deps)
  if (!parent) return { ok: false, error: '拿不到施工方会话（会话可能已释放），无法派生观天。', timedOut: false }
  const startedAt = Date.now()
  const history = recentReviewDigest(deps.domain, deps.workspaceId, 5)
  const limit = Math.max(6000, Math.round((settings.maxBriefChars || 8000) * 2))
  const requirements = activeRequirements(deps.domain, deps.workspaceId)
  const briefObj = buildBrief({
    baseline: deps.baseline,
    evidence: deps.evidence,
    history,
    report: deps.report,
    requirements,
    limit,
    settings,
    childDigest: deps.childDigest,
  })
  const run = await awaitGuantian(ctx, {
    parent,
    signal: deps.signal,
    brief: briefObj.text,
    model: target,
    handover,
    timeoutMs,
    softMs,
  })
  if (!run.ok) return run
  const parsed = parseVerdict(run.output)
  if (!parsed) {
    return { ok: false, error: `观天裁决无法解析：${run.output.slice(0, 160)}`, timedOut: false, childId: run.childId, via: run.via }
  }
  const landed = await landDeepReview(ctx, deps, opts, {
    brief: briefObj.text,
    briefStats: briefObj.stats,
    analysisRaw: `观天子代理（childId=${run.childId}，stopReason=${run.stopReason || 'completed'}，via=${run.via}）`,
    verifyRaw: run.output,
    suspicionsNotes: '',
    parsed,
    target: { provider: target.provider, model: target.model, source: target.source || '' },
    startedAt,
    handover: handover === true,
    via: run.via,
  })
  return { ...landed, timedOut: false }
}

async function runDeepReview(ctx, deps, opts = {}) {
  // Preferred path: a real 观天 child in a clean context.
  try {
    const via = await runDeepReviewViaSubagent(ctx, deps, opts, {
      handover: false,
      timeoutMs: DEEP_HARD_MS,
      softMs: DEEP_SOFT_MS,
    })
    if (via.ok) return via
    if (via.timedOut) {
      try {
        const store = await storage(ctx)
        if (store.domain) {
          await appendJournal(store.domain, 'deep_review_timeout', {
            workspaceId: deps.workspaceId,
            stageSeq: deps.stageSeq,
            childId: via.childId || '',
          })
        }
      } catch {
        /* ignore */
      }
      // Handover 观天：不调研，只依据已有材料补报告。
      try {
        const ho = await runDeepReviewViaSubagent(ctx, deps, opts, {
          handover: true,
          timeoutMs: DEEP_HANDOVER_MS,
          softMs: 0,
        })
        if (ho.ok) return ho
      } catch {
        /* fall through to local */
      }
    } else {
      try {
        const store = await storage(ctx)
        if (store.domain) {
          await appendJournal(store.domain, 'deep_subagent_failed', {
            workspaceId: deps.workspaceId,
            stageSeq: deps.stageSeq,
            error: via.error || '',
          })
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* any surprise → local fallback below */
  }
  return runDeepReviewLocal(ctx, deps, opts)
}

async function runDeepReviewLocal(ctx, deps, opts = {}) {
  const { domain, settingsDomain, workspaceId, stageSeq, baseline, evidence, report, sessionModel } = deps
  const startedAt = Date.now()
  const settings = settingsOf(settingsDomain)
  const target = resolveDeepModel(settings, sessionModel)
  if (!target) {
    return { ok: false, error: '未能确定深审模型：请用 supervisor action=settings 设置 deepProvider/deepModel（或 light 那两个）。' }
  }
  const upgradeReason = opts.upgradeReason || 'manual-deep'
  const history = recentReviewDigest(domain, workspaceId, 5)
  const limit = Math.max(6000, Math.round((settings.maxBriefChars || 8000) * 2))
  const requirements = activeRequirements(domain, workspaceId)
  const briefObj = buildBrief({ baseline, evidence, history, report, requirements, limit, settings, childDigest: deps.childDigest })
  const brief = briefObj.text
  const timeoutMs = Math.max(20000, Math.round((settings.timeoutMs || 90000) * 1.5))

  const first = await callModel(ctx, { provider: target.provider, model: target.model, system: DEEP_ANALYSIS_SYSTEM, user: brief, timeoutMs })
  const suspicions = first.ok ? parseSuspicions(first.text) : null
  const verifyUser = [
    brief,
    '',
    '## 第一位审阅者（观天·细读）提出的疑点',
    renderSuspicions(suspicions),
  ].join('\n')
  const second = await callModel(ctx, {
    provider: target.provider,
    model: target.model,
    system: DEEP_VERIFY_SYSTEM,
    user: verifyUser,
    timeoutMs,
  })
  if (!second.ok) return { ok: false, error: second.error, engine: 'full', model: target }
  const parsed = parseVerdict(second.text)
  if (!parsed) return { ok: false, error: `深审裁决无法解析：${second.text.slice(0, 160)}`, engine: 'full', model: target }
  return landDeepReview(ctx, deps, opts, {
    brief,
    briefStats: briefObj.stats,
    analysisRaw: first.text || '',
    verifyRaw: second.text || '',
    suspicionsNotes: Array.isArray(suspicions) && suspicions.length ? suspicions.map((s) => `[${s.kind || '?'}] ${s.detail || ''}`).join('\n') : '',
    parsed,
    target,
    startedAt,
    handover: false,
    via: 'local-llm',
  })
}

// Shared landing for both deep-review paths (local two-call LLM and 观天
// subagent): counters, REVIEW row, transcript, journal. Exactly one landing
// per review — callers must not duplicate any of these writes.
async function landDeepReview(ctx, deps, opts, src) {
  const { domain, workspaceId, stageSeq, baseline, evidence } = deps
  const settings = settingsOf(deps.settingsDomain)
  const parsed = src.parsed
  const target = src.target
  const reqStats = await applyRequirementOps(ctx, {
    domain,
    workspaceId,
    sessionId: deps.sessionId || '',
    ops: parsed.requirements,
    origin: 'review',
    evidence,
  })

  const base = opts.countersBase || (await countersOf(ctx, workspaceId, deps.sessionId))
  const counters = nextCounters(base, parsed.verdict)
  const blocking =
    parsed.blocking || counters.criticalCount >= settings.criticalLimit || counters.driftStreak >= settings.driftStreakLimit
  const reviewId = shortId('rev')
  const handover = src.handover === true
  const upgradeReason = handover ? `handover:${opts.upgradeReason || 'timeout'}` : opts.upgradeReason || 'manual-deep'
  const review = REVIEW.parse({
    reviewId,
    workspaceId,
    sessionId: deps.sessionId || '',
    stageSeq,
    createdAt: now(),
    verdict: parsed.verdict,
    summary: parsed.summary || parsed.suggestion || '',
    findings: parsed.findings,
    suggestion: parsed.suggestion,
    blocking,
    engine: 'full',
    handover,
    model: `${target.provider}/${target.model}`,
    modelSource: target.source || '',
    upgradeReason,
    durationMs: Date.now() - src.startedAt,
    tokens: 0,
    supersedes: opts.supersedes || '',
  })
  await domain.table('reviews').put(reviewId, review)
  await saveCounters(ctx, workspaceId, { ...counters, ...(blocking ? { pendingNotice: noticeFor(review) } : {}) }, deps.sessionId)
  await saveTranscript(ctx, reviewId, {
    reviewId,
    sessionId: deps.sessionId || '',
    workspaceId,
    stageSeq,
    createdAt: review.createdAt,
    engine: 'full',
    model: review.model,
    modelSource: target.source || '',
    upgradeReason,
    durationMs: Date.now() - src.startedAt,
    brief: src.brief,
    assembleNotes: `深审（${src.via || ''}） · 基线：${baseline ? `第 ${baseline.revision} 版` : '未登记'} · 用户原话 ${src.briefStats.userVoiceCount} 条 · 台账 ${src.briefStats.requirementCount} 条 · 证据：${evidence ? `${(evidence.files || []).length} 文件` : '无'}${reqStats.added || reqStats.superseded ? ` · 本轮新增/更新要求 ${reqStats.added}/${reqStats.superseded}` : ''}`,
    assemble: assembleInfo({ baseline, evidence, history: recentReviewDigest(domain, workspaceId, 5), brief: src.brief, limit: 16000, stats: src.briefStats }),
    baselineRevision: baseline && Number.isFinite(baseline.revision) ? baseline.revision : 0,
    evidenceStructured: evidenceSnapshot(evidence),
    lightRaw: '',
    deepAnalysisRaw: src.analysisRaw || '',
    deepVerifyRaw: src.verifyRaw || '',
    verdict: parsed.verdict,
    notes: src.suspicionsNotes || '',
  })
  await appendJournal(domain, 'deep_review_completed', {
    workspaceId,
    stageSeq,
    reviewId,
    verdict: parsed.verdict,
    blocking,
    engine: 'full',
    model: review.model,
    handover,
    via: src.via || '',
    suspicions: 0,
    supersedes: opts.supersedes || '',
  })
  return { ok: true, review, blocking, settings, engine: 'full', model: target }
}

function noticeFor(review) {
  return {
    at: now(),
    reviewId: review.reviewId,
    verdict: review.verdict,
    message: `天监：第 ${review.stageSeq} 阶段的裁决是【${VERDICT_TEXT[review.verdict] || review.verdict}】，需要用户先看一眼。`,
  }
}

// ---------------------------------------------------------------------------
// Child-session visibility: 子会话与队友只读链路
//
// 施工方的子代理/teammate 是独立会话，本插件之前完全看不见它们：
//   · children action 列出本会话的子会话 + 队友（只读目录）
//   · child_read action 按需回读指定子会话（窗口 + 截断，有硬上限）
//   · 审查时自动附一段紧凑摘要（settings.childDigest 开关），深挖走工具
// 全部只读：不创建、不发消息、不中断任何会话。
// ---------------------------------------------------------------------------

const CHILD_DIGEST_CHARS = 1500
const CHILD_READ_MAX_ROWS = 100
const CHILD_READ_MAX_CHARS = 6000

/** Defensive: directory entries were never published with exact field names. */
function normalizeChildRow(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id =
    entry.childId || entry.childSessionId || entry.sessionId || entry.id || ''
  if (!id) return null
  let label = entry.label || entry.title || entry.name || ''
  if (Array.isArray(entry.prompt)) {
    try {
      const first = entry.prompt.find((b) => b && b.type === 'text' && b.text)
      if (first) label = String(first.text).slice(0, 80)
    } catch {
      /* keep label as-is */
    }
  }
  return {
    id: String(id),
    label: String(label || '').slice(0, 120),
    status: String(entry.status || entry.state || entry.stopReason || ''),
  }
}

async function listSessionChildren(ctx, sessionId) {
  const out = { children: [], teammates: [], tasks: [], notes: [] }
  if (!sessionId) {
    out.notes.push('无法确定当前会话')
    return out
  }
  const subagents = safeGet(ctx, 'subagents')
  if (subagents && typeof subagents.listChildren === 'function') {
    try {
      const rows = await subagents.listChildren(sessionId)
      for (const row of Array.isArray(rows) ? rows : []) {
        const norm = normalizeChildRow(row)
        if (norm) out.children.push(norm)
      }
    } catch (err) {
      out.notes.push(`子会话目录读取失败：${String((err && err.message) || err).slice(0, 120)}`)
    }
    try {
      if (typeof subagents.listDescendants === 'function') {
        const rows = await subagents.listDescendants(sessionId)
        const seen = new Set(out.children.map((c) => c.id))
        for (const row of Array.isArray(rows) ? rows : []) {
          const norm = normalizeChildRow(row)
          if (norm && !seen.has(norm.id)) {
            seen.add(norm.id)
            out.children.push(norm)
          }
        }
      }
    } catch {
      /* descendants are a bonus; direct children suffice */
    }
  } else {
    out.notes.push('subagents 服务不可用，无法列出子会话')
  }
  return out
}

/** Teammate directory needs a live Agent caller; resolved at the action site. */
async function listTeammates(ctx, caller) {
  const out = { teammates: [], tasks: [], notes: [] }
  const teams = safeGet(ctx, 'agentTeams')
  if (!teams || typeof teams.listMembers !== 'function' || !caller) {
    if (!caller) out.notes.push('无有效调用者，跳过队友目录（需在会话内调用）')
    else out.notes.push('agentTeams 服务不可用，无法列出队友')
    return out
  }
  try {
    const members = await teams.listMembers(caller)
    for (const m of Array.isArray(members) ? members : []) {
      if (!m || typeof m !== 'object') continue
      out.teammates.push({
        name: String(m.name || m.id || m.target || 'teammate').slice(0, 80),
        role: String(m.role || ''),
        status: String(m.status || m.state || ''),
      })
    }
  } catch (err) {
    out.notes.push(`队友目录读取失败：${String((err && err.message) || err).slice(0, 120)}`)
    return out
  }
  try {
    if (typeof teams.listTasks === 'function') {
      const tasks = await teams.listTasks()
      const rows = Array.isArray(tasks) ? tasks : []
      out.tasks = rows.slice(0, 8).map((t) => ({
        title: String((t && (t.title || t.subject || t.id)) || '').slice(0, 120),
        status: String((t && (t.status || t.state)) || ''),
      }))
      if (rows.length > out.tasks.length) out.tasks.push({ title: `…等共 ${rows.length} 项`, status: '' })
    }
  } catch {
    /* task board is a bonus */
  }
  return out
}

// Event types worth rendering when reading a child session. Everything else
// (step ticks, stream chunks, header dumps) is skipped by default and counted.
const CHILD_READ_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/end',
  'goal/change',
  'todo/write',
  'command/run',
  'approval/decided',
  'session/title',
  'deliverables/presented',
  'subagent/start',
  'subagent/end',
])

function renderChildEvent(event) {
  const type = event && event.type ? String(event.type) : '?'
  const seq = event && Number.isFinite(event.seq) ? event.seq : '?'
  const head = `#${seq} [${type}]`
  try {
    const data = event && event.data ? event.data : null
    if (type === 'user/message') {
      const kind = data && data.source && data.source.kind ? String(data.source.kind) : ''
      const who = kind === 'user' || kind === 'user-question-reply' ? '用户' : agentKindLabel(kind)
      const text = messageParts(data).text.replace(/\s+/g, ' ').slice(0, 400)
      return text ? `${head} ${who}：${text}` : ''
    }
    if (type === 'assistant/message') {
      const text = messageParts(data).text.replace(/\s+/g, ' ').slice(0, 400)
      return text ? `${head} 施工方：${text}` : ''
    }
    if (type === 'tool/call') {
      const name = data && data.name ? String(data.name) : '?'
      if (name === 'ask_user_question') return `${head} 提问用户（ask_user_question）`
      const argText = (() => {
        try {
          const raw = data && data.arguments !== undefined ? JSON.stringify(data.arguments) : ''
          return raw.replace(/\s+/g, ' ').slice(0, 120)
        } catch {
          return ''
        }
      })()
      return `${head} 调用 ${name}${argText ? ` ${argText}` : ''}`
    }
    if (type === 'tool/result') {
      const err = data && (data.error || (data.value && data.value.error))
      if (!err) return ''
      return `${head} 失败：${JSON.stringify(err).slice(0, 200)}`
    }
    if (type === 'turn/end') {
      const reason =
        data && data.reason && (data.reason.kind || data.reason)
          ? String(data.reason.kind || data.reason)
          : ''
      return `${head} 回合结束${reason ? `（${reason}）` : ''}`
    }
    if (CHILD_READ_TYPES.has(type)) {
      return `${head} ${JSON.stringify(data).replace(/\s+/g, ' ').slice(0, 200)}`
    }
    return ''
  } catch {
    return head
  }
}

async function readChildSession(ctx, childId, { limit = 40, types = null } = {}) {
  const query = safeGet(ctx, 'sessionQuery')
  if (!query || typeof query.readSession !== 'function') {
    return { ok: false, error: 'sessionQuery 服务不可用，无法回读子会话' }
  }
  const maxRows = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 40, CHILD_READ_MAX_ROWS))
  let snap
  try {
    snap = await query.readSession(String(childId))
  } catch (err) {
    return { ok: false, error: `回读失败：${String((err && err.message) || err).slice(0, 160)}` }
  }
  const events = snap && Array.isArray(snap.events) ? snap.events : []
  const only = Array.isArray(types) && types.length ? new Set(types.map((t) => String(t))) : null
  const rows = []
  let skipped = 0
  let spent = 0
  // Newest-first: the reviewer cares about where the child ENDED UP.
  for (let i = events.length - 1; i >= 0 && rows.length < maxRows; i--) {
    const event = events[i]
    const type = event && event.type ? String(event.type) : ''
    if (only ? !only.has(type) : !CHILD_READ_TYPES.has(type)) {
      skipped++
      continue
    }
    const line = renderChildEvent(event).slice(0, 400)
    if (!line) {
      skipped++
      continue
    }
    if (spent + line.length > CHILD_READ_MAX_CHARS) {
      skipped++
      continue
    }
    spent += line.length
    rows.push(line)
  }
  return { ok: true, childId: String(childId), total: events.length, returned: rows.length, skipped, rows }
}

/**
 * Compact per-review digest: who exists below this session and where each
 * child ended up. Bounded: ≤5 children × 6 rows, section ≤1500 chars.
 * Anything deeper is one `child_read` call away — for the human, not the model.
 */
async function summarizeChildren(ctx, sessionId, settings) {
  if (!settings || settings.childDigest === false) return ''
  let list
  try {
    list = await listSessionChildren(ctx, sessionId)
  } catch {
    return ''
  }
  const kids = Array.isArray(list.children) ? list.children.slice(0, 5) : []
  if (!kids.length) return ''
  const lines = ['## 子会话摘要（天监按需回读；用 supervisor action=child_read + childId 深挖）']
  for (const kid of kids) {
    const tag = kid.label ? `${kid.label}（${kid.id.slice(0, 12)}）` : kid.id.slice(0, 12)
    let tail = kid.status || '状态未知'
    try {
      const read = await readChildSession(ctx, kid.id, { limit: 6 })
      if (read.ok && read.rows.length) tail = read.rows.slice(0, 3).join(' ／ ').slice(0, 300)
      else if (read.ok) tail = `共 ${read.total} 个事件，无实质内容`
    } catch {
      /* keep status only */
    }
    lines.push(`- ${tag}：${tail}`)
  }
  const text = lines.join('\n')
  return text.length > CHILD_DIGEST_CHARS ? `${text.slice(0, CHILD_DIGEST_CHARS)}\n…（摘要超长已截断）` : text
}

/**
 * The public review entry point: runs the light pass, then upgrades to the deep
 * pass when the verdict is off-baseline (or the stage is large) and the setting
 * allows it. Never throws.
 */
// ---------------------------------------------------------------------------
// B10 · kyzmem 经验回流：每次审查落库后写一条"阶段教训"，供未来类似项目检索。
//
// 定位（spec §5 B3）：只做叙事召回，不承载基线。kyzmem 没有 ctx 服务，
// 唯一入口是它的模型工具 kyzmem_save —— 这里直接调它的 ToolDefinition.execute，
// 绕开工具执行管线（不触发 pre-execute 事件、不经过 approval、不污染会话）。
// exec 必须带真 agent：kyzmem 用 exec.agent.session.header.cwd 解析"项目宫殿"
// （sessionCwdOf），拿不到就回退进程目录，会写错库。
//
// 自检与回滚：写前查工具是否存在；写后验返回值；任何一步失败 →
// 审查照常返回（绝不因回流失败而失败），只写一条 journal 留痕。
// 开关：settings.kyzmemReflow（默认开）。永不抛错。
// ---------------------------------------------------------------------------

const KYZMEM_REFLOW_TIMEOUT_MS = 60000

// Last reflow outcome, surfaced in `supervisor action=diag`. Module-level is
// fine: it is observability, not review state.
const lastReflow = { at: '', ok: null, detail: '尚未执行' }

function lessonTextFor({ workspaceId, stageSeq, verdict, engine, review }) {
  const ws = workspaceLabel(workspaceId)
  const lines = [`【天监·${ws}·第${stageSeq}阶段】裁决：${verdict}（${engine || '?'}审）`]
  const findings = review && Array.isArray(review.findings) ? review.findings.slice(0, 3) : []
  for (const f of findings) {
    const kind = f && f.kind ? String(f.kind) : 'note'
    const detail = f && f.detail ? String(f.detail).replace(/\s+/g, ' ').slice(0, 120) : ''
    if (detail) lines.push(`- [${kind}] ${detail}`)
  }
  const suggestion = review && review.suggestion ? String(review.suggestion).replace(/\s+/g, ' ').slice(0, 150) : ''
  if (suggestion) lines.push(`纠偏：${suggestion}`)
  return lines.join('\n').slice(0, 600)
}

async function reflowToKyzmem(ctx, { domain, workspaceId, sessionId, stageSeq, review }) {
  const fail = async (reason) => {
    lastReflow.at = now()
    lastReflow.ok = false
    lastReflow.detail = reason
    try {
      await appendJournal(domain, 'kyzmem_skipped', { workspaceId, stageSeq, reason })
    } catch {
      /* journal is a bonus */
    }
  }
  let settings
  try {
    const pack = await storage(ctx)
    settings = settingsOf(pack.settings)
  } catch {
    return fail('设置域不可读')
  }
  if (!settings || settings.kyzmemReflow === false) return fail('已关闭（kyzmemReflow=false）')
  const tools = safeGet(ctx, 'tools')
  const def = tools && typeof tools.get === 'function' ? tools.get('kyzmem_save') : undefined
  if (!def || typeof def.execute !== 'function') return fail('kyzmem_save 工具不存在（kyzmem 未安装或未启用）')
  // Real agent first: kyzmem resolves the project palace from its session cwd.
  let agent = null
  try {
    const agents = safeGet(ctx, 'agents')
    if (agents && typeof agents.get === 'function') agent = agents.get(sessionId) || null
  } catch {
    agent = null
  }
  if (!agent || !agent.session || !agent.session.header || !agent.session.header.cwd) {
    let cwd = ''
    try {
      cwd = cwdOfSession(ctx, sessionId) || ''
    } catch {
      cwd = ''
    }
    if (!cwd) return fail('拿不到会话 cwd（会话可能已释放），不写错库')
    agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd }, snapshotEvents: () => [] },
    }
  }
  const content = lessonTextFor({ workspaceId, stageSeq, verdict: review.verdict, engine: review.engine, review })
  const placard = `天监阶段教训-${workspaceLabel(workspaceId)}-S${stageSeq}`.slice(0, 30)
  let timer = null
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const exec = { agent, signal: controller ? controller.signal : undefined }
    timer = setTimeout(() => {
      try {
        if (controller) controller.abort()
      } catch {
        /* ignore */
      }
    }, KYZMEM_REFLOW_TIMEOUT_MS)
    const ret = await def.execute(
      {
        content,
        kind: 'episode',
        scope: 'project',
        importance: 0.6,
        placard,
        entities: [{ name: '天监', kind: 'concept' }],
      },
      exec,
    )
    const memId = ret && (ret.id || (ret.record && ret.record.id)) ? String(ret.id || ret.record.id) : ''
    lastReflow.at = now()
    lastReflow.ok = true
    lastReflow.detail = memId ? `已写入（id=${memId}）` : '已写入'
    try {
      await appendJournal(domain, 'kyzmem_reflowed', {
        workspaceId,
        stageSeq,
        reviewId: review.reviewId,
        memoryId: memId || null,
      })
    } catch {
      /* journal is a bonus */
    }
  } catch (err) {
    await fail(`写入失败：${String((err && err.message) || err).slice(0, 160)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runReview(ctx, deps) {  const sessionId = deps && deps.sessionId
  bumpReviewing(sessionId, 1)
  try {
    const outcome = await runReviewWork(ctx, deps)
    if (outcome && outcome.ok && outcome.review && outcome.review.reviewId) {
      // A fresh verdict lights the lamp until the 天监 Tab has been opened.
      try {
        await setSessionViewed(ctx, sessionId, '')
      } catch {
        /* the lamp is cosmetic; never fail a review over it */
      }
      // B10: fire-and-forget lesson reflow. Never blocks or fails the review.
      try {
        void reflowToKyzmem(ctx, {
          domain: deps.domain,
          workspaceId: deps.workspaceId,
          sessionId,
          stageSeq: deps.stageSeq,
          review: outcome.review,
        }).catch(() => {})
      } catch {
        /* reflow must never break a review */
      }
    }
    return outcome
  } finally {
    bumpReviewing(sessionId, -1)
  }
}

async function runReviewWork(ctx, deps) {
  const settings = settingsOf(deps.settingsDomain)
  if (!settings.enabled) return { ok: false, skipped: true, error: '审查已关闭（supervisor settings enabled=false）' }
  const base = await countersOf(ctx, deps.workspaceId, deps.sessionId)
  const engine = settings.engine || 'auto'
  // One shared digest for both passes: children are read once per review.
  try {
    if (!deps.childDigest) deps.childDigest = await summarizeChildren(ctx, deps.sessionId, settings)
  } catch {
    /* digest is a bonus; the review must proceed without it */
  }
  if (engine === 'deep') return runDeepReview(ctx, deps, { countersBase: base })

  const light = await runLightReview(ctx, deps, { countersBase: base })
  if (engine === 'light' || !light.ok) return light

  const big =
    deps.evidence &&
    (((deps.evidence.files || []).length >= 8) || ((deps.evidence.touchedFiles || []).length >= 8))
  const suspicious = light.review.verdict === 'drift' || light.review.verdict === 'critical'
  if (!settings.deepOnDrift || !(suspicious || big)) return light

  const deep = await runDeepReview(ctx, deps, {
    countersBase: base,
    supersedes: light.review.reviewId,
    upgradeReason: `auto-upgrade:${light.review.verdict}`,
  })
  if (!deep.ok) {
    try {
      await appendJournal(deps.domain, 'deep_review_failed', { stageSeq: deps.stageSeq, error: deep.error })
    } catch {
      /* ignore */
    }
    return light
  }
  return deep
}

// ---------------------------------------------------------------------------
// B7 · 定时兜底审查 + 阈值强制打断
// ---------------------------------------------------------------------------

let schedulerDisposer = null

function startAutoReview(ctx) {
  const timer = ctx.get('timer')
  if (!timer || typeof timer.interval !== 'function') return () => {}
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const { domain, settings: settingsDomain } = await storage(ctx)
      if (!domain || !settingsDomain) return
      const settings = settingsOf(settingsDomain)
      if (!settings.enabled || !settings.autoReviewMinutes) return
      const nowMs = Date.now()
      const quietFor = (stamp) => (stamp ? nowMs - Date.parse(stamp) : Number.POSITIVE_INFINITY)

      let picked = null
      for (const acc of accumulators.values()) {
        const worked = acc.turns > 0 && (acc.files.size > 0 || acc.touched.size > 0)
        if (!worked) continue
        if (!picked || acc.eventCount > picked.eventCount) picked = acc
      }
      if (!picked) return

      const sessionId = picked.sessionId
      const workspaceId = workspaceIdForCwd(cwdOfSession(ctx, sessionId))
      const counters = await countersOf(ctx, workspaceId, sessionId)
      if (quietFor(counters.lastReviewAt) < settings.autoReviewMinutes * 60000) return
      if (quietFor(counters.lastAutoReviewAt) < settings.autoReviewMinutes * 60000) return
      const baseline = domain.table('baselines').get(workspaceId) || null
      if (!baseline) return
      const evidence = evidenceOf(sessionId)
      if (!evidence) return
      const stageSeq = nextStageSeq(domain, workspaceId)
      const outcome = await runReview(ctx, {
        domain,
        settingsDomain,
        workspaceId,
        sessionId,
        stageSeq,
        baseline,
        evidence,
        report: { claim: '（定时兜底：施工方没有在阶段边界汇报，天监按时间兜底复审一次）', touched: [] },
        sessionModel: sessionModelOf(ctx, sessionId),
      })
      if (!outcome.ok) return
      const after = await countersOf(ctx, workspaceId, sessionId)
      await saveCounters(ctx, workspaceId, { ...after, lastAutoReviewAt: now() }, sessionId)
      // The auto pass consumes the stage number, so it owns a report row too —
      // otherwise the next manual report reuses the same seq and the Tab's
      // "current stage" mixes two reviews. kind 'auto' is the trigger trail.
      try {
        const autoStamp = now()
        const autoReportId = shortId('rpt')
        await domain.table('reports').put(
          autoReportId,
          STAGE_REPORT.parse({
            reportId: autoReportId,
            workspaceId,
            sessionId,
            stageSeq,
            submittedAt: autoStamp,
            claim: '（定时兜底：施工方没有在阶段边界汇报，天监按时间兜底复审一次）',
            touched: [],
            reviewId: outcome.review.reviewId,
            trigger: { kind: 'auto', at: autoStamp, by: 'scheduler' },
            evidence,
          }),
        )
      } catch {
        /* the review itself already landed; a missing auto row is cosmetic */
      }
      resetAccumulator(sessionId)
      await appendJournal(domain, 'auto_review', {
        workspaceId,
        stageSeq,
        reviewId: outcome.review.reviewId,
        verdict: outcome.review.verdict,
        blocking: outcome.blocking,
      })
    } catch {
      /* a background tick must never surface an error */
    } finally {
      busy = false
    }
  }
  schedulerDisposer = timer.interval(() => {
    void tick()
  }, 60000)
  return () => {
    try {
      if (schedulerDisposer) schedulerDisposer()
    } catch {
      /* ignore */
    }
    schedulerDisposer = null
  }
}

/**
 * Threshold interrupt (decision #19): once the drift counters reach their
 * limits, the next step of that session is refused, the counters are cleared
 * and the notice is parked for the UI. This is the one place where 天监 is
 * allowed to stop the builder — and it never touches the conversation history.
 */
function attachInterrupt(ctx) {
  return ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch {
      return undefined
    }
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const agent = payload && payload.agent
      const sessionId = agent && agent.id
      if (!sessionId || !accumulators.has(sessionId)) return decision
      const { domain, settings: settingsDomain } = await storage(ctx)
      if (!domain || !settingsDomain) return decision
      const settings = settingsOf(settingsDomain)
      if (!settings.interruptEnabled) return decision
      const workspaceId = workspaceIdForCwd(cwdOfSession(ctx, sessionId))
      const counters = await countersOf(ctx, workspaceId, sessionId)
      const dueCritical = (counters.criticalCount || 0) >= settings.criticalLimit
      const dueStreak = (counters.driftStreak || 0) >= settings.driftStreakLimit
      if (!dueCritical && !dueStreak) return decision
      const last = counters.lastInterruptAt ? Date.parse(counters.lastInterruptAt) : 0
      if (last && Date.now() - last < settings.interruptCooldownMs) return decision
      const reason = dueCritical
        ? `严重偏移累计 ${counters.criticalCount} 次`
        : `连续 ${counters.driftStreak} 轮存在偏移`
      await saveCounters(ctx, workspaceId, {
        ...counters,
        criticalCount: 0,
        driftStreak: 0,
        lastInterruptAt: now(),
        pendingNotice: {
          at: now(),
          verdict: 'critical',
          message: `天监已按阈值打断本轮施工（${reason}）。请先查看审查结论，再决定是否继续。`,
        },
      }, sessionId)
      try {
        await appendJournal(domain, 'interrupt_fired', {
          sessionId,
          reason,
          criticalCount: counters.criticalCount,
          driftStreak: counters.driftStreak,
        })
      } catch {
        /* ignore */
      }
      return { kind: 'reject' }
    } catch {
      return decision
    }
  })
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UI bridge (B8): the browser half reads one snapshot over this package's own
// RPC channel and writes the two things a control may change. Everything the
// Host sends is plain JSON — no Dates, no undefined, no service handles.
// ---------------------------------------------------------------------------

const RPC_CHANNEL = '/dsh-supervisor'

function plain(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function countOf(list) {
  return Array.isArray(list) ? list.length : 0
}

function baselineSummaries(domain) {
  const rows = []
  for (const [workspaceId, record] of domain.table('baselines').entries()) {
    if (!record) continue
    rows.push({
      workspaceId,
      revision: record.revision,
      intent: record.intent || '',
      goals: countOf(record.goals),
      hard: record.constraints ? countOf(record.constraints.hard) : 0,
      soft: record.constraints ? countOf(record.constraints.soft) : 0,
      directions: countOf(record.directions),
      updatedAt: record.updatedAt || '',
    })
  }
  return rows
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 12)
}

function recentReviews(domain, limit) {
  const rows = []
  for (const [, record] of domain.table('reviews').entries()) {
    if (record) rows.push(record)
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return rows.slice(0, limit).map(reviewRowOf)
}

function recentJournal(domain, limit) {
  const rows = []
  for (const [, record] of domain.table('journal').entries()) {
    if (record) rows.push(record)
  }
  rows.sort((a, b) => Number(b.seq) - Number(a.seq))
  return rows.slice(0, limit).map(recentJournalRow)
}

function stageReports(domain, limit) {
  const rows = []
  for (const [, record] of domain.table('reports').entries()) {
    if (record) rows.push(record)
  }
  // submittedAt is the schema field; createdAt never existed on reports
  // (older mapping read a missing key and always produced undefined).
  const stampOf = (report) => report.submittedAt || report.createdAt || ''
  rows.sort((a, b) => Number(b.stageSeq) - Number(a.stageSeq) || String(stampOf(b)).localeCompare(String(stampOf(a))))
  return rows.slice(0, limit).map((report) => ({
    id: report.reportId || report.id,
    reportId: report.reportId || report.id,
    stageSeq: report.stageSeq,
    workspaceId: report.workspaceId,
    sessionId: report.sessionId || '',
    claim: report.claim || '',
    touched: Array.isArray(report.touched) ? report.touched : [],
    submittedAt: stampOf(report),
    reviewId: report.reviewId || '',
    trigger:
      report.trigger && typeof report.trigger === 'object'
        ? { kind: report.trigger.kind || '', at: report.trigger.at || '', by: report.trigger.by || '' }
        : { kind: '', at: '', by: '' },
    files: countOf(report.files),
    verdict: report.verdict || 'pending',
  }))
}

async function buildSnapshot(ctx) {
  const { domain, settings: settingsDomain, error } = await storage(ctx)
  const settings = plain(settingsOf(settingsDomain))
  if (!domain) {
    return {
      storage: 'unavailable',
      error: error ? String(error) : '',
      settings,
      counters: null,
      baselines: [],
      reviews: [],
      reports: [],
      journal: [],
      updatedAt: now(),
    }
  }
  return {
    storage: 'ok',
    error: null,
    settings,
    counters: plain(domain.global.get()),
    baselines: plain(baselineSummaries(domain)),
    reviews: plain(recentReviews(domain, 8)),
    reports: plain(stageReports(domain, 8)),
    journal: plain(recentJournal(domain, 8)),
    updatedAt: now(),
  }
}

async function saveSettingsPatch(ctx, patch, meta) {
  const { domain, settings: settingsDomain } = await storage(ctx)
  if (!settingsDomain) return { ok: false, code: 'storage-unavailable' }
  const current = settingsOf(settingsDomain)
  const next = { ...current }
  const source = patch && typeof patch === 'object' ? patch : {}
  const changed = []
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    next[key] = source[key]
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) changed.push(key)
  }
  const parsed = SETTINGS.parse(next)
  await settingsDomain.global.set(parsed)
  if (changed.length && domain) {
    // Settings used to change with no trace at all, so "did it take effect?"
    // was unanswerable. One journal line per accepted change makes the edit
    // auditable and lets the UI show a real change history.
    const before = {}
    const after = {}
    for (const key of changed) {
      before[key] = current[key]
      after[key] = parsed[key]
    }
    try {
      await appendJournal(domain, 'settings_changed', {
        via: (meta && meta.via) || 'ui',
        workspaceId: (meta && meta.workspaceId) || '*',
        changed,
        before,
        after,
      })
    } catch {
      /* a journal write failure must not lose the setting change */
    }
  }
  return { ok: true, settings: plain(parsed), changed }
}

async function acknowledgeNotice(ctx, workspaceId) {
  const { domain } = await storage(ctx)
  if (!domain) return { ok: false, code: 'storage-unavailable' }
  const only = typeof workspaceId === 'string' && workspaceId ? workspaceId : ''
  const cleared = await clearNotices(ctx, only)
  if (!cleared) return { ok: true, cleared: false }
  try {
    await appendJournal(domain, 'notice_acknowledged', { via: 'ui', workspaceId: only || '*' })
  } catch {
    /* the notice is cleared even when the journal write fails */
  }
  return { ok: true, cleared: true, workspaceId: only || '*' }
}

/**
 * Runtime counters for the browser half. The panel polls `snapshot` every 12s,
 * so a non-zero count here proves the client module actually loaded and ran —
 * which is the one thing the host side cannot otherwise observe.
 */
const rpcStats = { calls: 0, byEndpoint: Object.create(null), lastAt: null, hello: null, errors: [], beacons: [] }

function noteBeacon(stage, detail) {
  rpcStats.beacons.push({ at: new Date().toISOString(), stage: String(stage || ''), detail: String(detail || '').slice(0, 300) })
  if (rpcStats.beacons.length > 40) rpcStats.beacons.shift()
}

/**
 * A plain HTTP beacon the client module can hit from its very first line — before
 * `ctx`, React or the RPC channel exist. It is the only evidence that survives a
 * browser half which dies before it can talk.
 */
function attachBeacon(ctx) {
  try {
    const connection = ctx.get('connection')
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      noteBeacon('beacon-no-fetch-service', 'connection.fetch missing')
      return () => {}
    }
    // The Fetch route namespace is owned by the host connection layer; its exact
    // path rule is not documented, so try the plausible spellings until one takes.
    const candidates = ['/api/dsh-supervisor/beacon', '/api/supervisor/beacon', '/dsh-supervisor/beacon']
    for (const path of candidates) {
      try {
        const dispose = connection.fetch.register({
          path,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const url = new URL(request.url, 'http://beacon.local')
              noteBeacon(url.searchParams.get('stage') || '', url.searchParams.get('detail') || '')
            } catch (err) {
              noteBeacon('beacon-parse-error', String((err && err.message) || err))
            }
            return new Response(null, { status: 204 })
          },
        })
        noteBeacon('beacon-path-ok', path)
        return () => {
          Promise.resolve(dispose)
            .then((fn) => {
              if (typeof fn === 'function') fn()
            })
            .catch(() => {})
        }
      } catch (err) {
        noteBeacon('beacon-path-rejected', `${path}: ${(err && err.message) || err}`)
      }
    }
    return () => {}
  } catch (err) {
    noteBeacon('beacon-register-failed', String((err && err.message) || err))
    return () => {}
  }
}

function workspaceIdOfSession(ctx, sessionId) {
  return workspaceIdForCwd(cwdOfSession(ctx, sessionId))
}

/** Cross-project rollup for the sidebar page (whole-plugin view). */
async function overviewOf(ctx) {
  const { domain, settings: settingsDomain, sessions: sessionsDomain, error } = await storage(ctx)
  const settings = plain(settingsOf(settingsDomain))
  if (!domain) {
    return {
      storage: 'unavailable',
      error: error ? String(error) : '',
      settings,
      workspaceCount: 0,
      sessionCount: 0,
      baselines: [],
      reviews: [],
      verdicts: { aligned: 0, minor: 0, drift: 0, critical: 0, pending: 0 },
      reports: [],
      journal: [],
      counters: null,
      modelResolution: null,
      thresholds: null,
      updatedAt: now(),
    }
  }
  const baselines = plain(baselineSummaries(domain))
  const reviews = plain(recentReviews(domain, 20))
  const verdicts = { aligned: 0, minor: 0, drift: 0, critical: 0, pending: 0 }
  for (const review of reviews) {
    if (Object.prototype.hasOwnProperty.call(verdicts, review.verdict)) verdicts[review.verdict] += 1
  }
  let sessionCount = 0
  if (sessionsDomain) {
    try {
      sessionCount = sessionsDomain.table('prefs').size()
    } catch {
      sessionCount = 0
    }
  }
  const agg = await aggregateCounters(ctx)
  return {
    storage: 'ok',
    error: null,
    settings,
    workspaceCount: baselines.length,
    sessionCount,
    baselines,
    reviews,
    verdicts,
    reports: plain(stageReports(domain, 6)),
    journal: plain(recentJournal(domain, 12)),
    counters: plain(agg),
    modelResolution: modelResolutionOf(settings),
    thresholds: {
      critical: { count: agg.criticalCount, limit: settings.criticalLimit },
      streak: { maxStreak: agg.maxDriftStreak || 0, limit: settings.driftStreakLimit },
      interruptEnabled: settings.interruptEnabled === true,
      cooldownMs: settings.interruptCooldownMs,
      lastInterruptAt: agg.lastInterruptAt || '',
    },
    updatedAt: now(),
  }
}

/** Everything the session-scoped surfaces (composer pill + 天监 Tab) need. */
/**
 * One-time lazy migration: reports written before sessionId was recorded
 * belong to whichever session their review belongs to. Without this, legacy
 * reports match every session and every Tab shows the same "current stage".
 */
let __reportBackfillDone = false
async function backfillReportSessions(domain) {
  if (__reportBackfillDone) return
  __reportBackfillDone = true
  try {
    const reports = domain.table('reports')
    const reviews = domain.table('reviews')
    for (const [id, report] of reports.entries()) {
      if (!report || report.sessionId) continue
      let sid = ''
      if (report.reviewId) {
        try {
          const rev = reviews.get(report.reviewId)
          if (rev && rev.sessionId) sid = rev.sessionId
        } catch {
          /* keep empty */
        }
      }
      if (sid) {
        await reports.put(id, STAGE_REPORT.parse({ ...report, sessionId: sid }))
      }
    }
  } catch {
    /* best-effort */
  }
}

async function sessionStateOf(ctx, sessionId) {
  await backfillUserTimeline(ctx, sessionId)
  const { domain, settings: settingsDomain, sessions: sessionsDomain, error } = await storage(ctx)
  const settings = plain(settingsOf(settingsDomain))
  const pref = sessionPrefOf(sessionsDomain, sessionId)
  const workspaceId = sessionId ? workspaceIdOfSession(ctx, sessionId) : ''
  const base = {
    sessionId: sessionId || '',
    workspaceId,
    enabled: pref.enabled && settings.enabled !== false,
    pref,
    settings,
    storage: domain ? 'ok' : 'unavailable',
    error: error ? String(error) : null,
    updatedAt: now(),
  }
  let evidence = null
  try {
    const collected = evidenceOf(sessionId)
    evidence = collected
      ? { turns: collected.turns, steps: collected.steps, files: (collected.files || []).length, touched: (collected.touchedFiles || []).length, diffStat: collected.diffStat }
      : null
  } catch {
    evidence = null
  }
  if (!domain) {
    return {
      ...base,
      baseline: null,
      baselineFull: null,
      sessionBaseline: null,
      stage: null,
      review: null,
      reviews: [],
      journal: [],
      pendingNotice: null,
      noticeAck: null,
      counters: null,
      evidence,
      userTimeline: [],
      userLedger: [],
      reviewing: isReviewing(sessionId),
      unread: false,
    }
  }
  // Two levels: the project baseline (per workspace) and this session's own
  // additions; the review engine gets the merge, the Tab shows both.
  await backfillReportSessions(domain)
  let projectBaseline = null
  try {
    projectBaseline = domain.table('baselines').get(workspaceId) || null
  } catch {
    projectBaseline = null
  }
  const sessionBaseline = await sessionBaselineOf(ctx, sessionId)
  const summarize = (record, scope) =>
    record
      ? {
          scope,
          revision: record.revision,
          intent: record.intent || '',
          goals: (record.goals || []).length,
          hard: ((record.constraints || {}).hard || []).length,
          soft: ((record.constraints || {}).soft || []).length,
          directions: (record.directions || []).length,
          updatedAt: record.updatedAt || '',
        }
      : null
  const baseline = summarize(projectBaseline, 'project')
  const sessionBaselineView = summarize(sessionBaseline, 'session')
  const allReviews = plain(recentReviews(domain, 60))
  // Strict scoping: a review only shows up in the session (and project) it belongs to.
  const mine = sessionId
    ? allReviews.filter((review) => review.sessionId === sessionId)
    : allReviews.filter((review) => !review.sessionId && review.workspaceId === workspaceId)
  // The project still keeps its audit trail: reviews from earlier sessions of the
  // same workspace are shown separately, never mixed into this session's verdict.
  const workspaceReviews = allReviews
    .filter((review) => review.workspaceId === workspaceId && !mine.some((item) => item.id === review.id))
    .slice(0, 5)
  const review = mine.find((item) => item.verdict && item.verdict !== 'pending') || null
  const reports = plain(stageReports(domain, 40)).filter(
    (report) => !sessionId || !report.sessionId || report.sessionId === sessionId,
  )
  const counters = await countersOf(ctx, workspaceId, sessionId)
  // Workspace rollup for display: the Tab shows 本会话 numbers from `counters`
  // and keeps project totals here so nothing that said 同项目累计 goes stale.
  const workspaceCounters = await workspaceCountersOf(ctx, workspaceId)
  // P0/P1 surfaces: the user's own words and the cross-stage ledger, so the Tab
  // can answer "what did I actually ask for" without opening the review.
  let userTimeline = []
  let userLedger = []
  try {
    const collected = evidenceOf(sessionId)
    userTimeline = collected && Array.isArray(collected.userTimeline)
      ? collected.userTimeline.slice(-20).map((entry) => ({
          seq: entry.seq,
          time: entry.time,
          kind: entry.kind,
          text: entry.text,
          truncated: Boolean(entry.truncated),
          attachments: entry.attachments ? entry.attachments.length : 0,
        }))
      : []
  } catch {
    userTimeline = []
  }
  try {
    userLedger = plain(activeRequirements(domain, workspaceId)).slice(0, 40)
  } catch {
    userLedger = []
  }
  // Full baseline texts: the Tab answers "which rule did I break" from these,
  // not from the count-only summaries above.
  const baselineFull = {
    project: projectBaseline ? plain(projectBaseline) : null,
    session: sessionBaseline ? plain(sessionBaseline) : null,
  }
  // Session-scoped audit trail: journal entries for this workspace that belong
  // to this session — directly, or via one of this session's reviews.
  let journal = []
  try {
    const mineIds = new Set(mine.map((item) => item.reviewId || item.id).filter(Boolean))
    const rows = []
    for (const [, entry] of domain.table('journal').entries()) {
      if (!entry) continue
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {}
      if (payload.workspaceId && payload.workspaceId !== workspaceId) continue
      if (payload.sessionId && sessionId && payload.sessionId !== sessionId) continue
      if (!payload.sessionId && payload.reviewId && !mineIds.has(payload.reviewId)) continue
      rows.push({ seq: entry.seq, type: entry.type, ts: entry.ts })
    }
    rows.sort((a, b) => Number(b.seq) - Number(a.seq))
    journal = rows.slice(0, 20)
  } catch {
    journal = []
  }
  return {
    ...base,
    baseline,
    baselineFull,
    sessionBaseline: sessionBaselineView,
    baselineScope: sessionBaseline ? (projectBaseline ? 'project+session' : 'session') : 'project',
    stage: reports.length ? reports[0] : null,
    review,
    reviews: mine.slice(0, 6),
    workspaceReviews,
    journal,
    pendingNotice: counters ? counters.pendingNotice : null,
    noticeAck: counters && counters.lastAck ? counters.lastAck : null,
    counters: counters
      ? {
          reviewCount: counters.reviewCount,
          criticalCount: counters.criticalCount,
          driftStreak: counters.driftStreak,
          lastReviewAt: counters.lastReviewAt,
          lastAutoReviewAt: counters.lastAutoReviewAt || '',
        }
      : null,
    workspaceCounters: workspaceCounters
      ? {
          reviewCount: workspaceCounters.reviewCount,
          criticalCount: workspaceCounters.criticalCount,
          driftStreak: workspaceCounters.driftStreak,
          lastReviewAt: workspaceCounters.lastReviewAt,
        }
      : null,
    evidence,
    userTimeline,
    userLedger,
    reviewing: isReviewing(sessionId),
    unread: Boolean(review && review.reviewId && pref.viewedReviewId !== review.reviewId),
  }
}

async function setSessionEnabled(ctx, sessionId, enabled) {
  const { sessions: sessionsDomain } = await storage(ctx)
  if (!sessionsDomain) return { ok: false, code: 'storage-unavailable' }
  const current = sessionPrefOf(sessionsDomain, sessionId)
  const record = SESSION_PREF.parse({
    enabled: enabled !== false,
    viewedReviewId: current.viewedReviewId || '',
    updatedAt: now(),
  })
  await sessionsDomain.table('prefs').put(String(sessionId), record)
  return { ok: true, pref: plain(record) }
}

// ---------------------------------------------------------------------------
// Cross-project queries (independent page / standalone panel)
//
// The narrow sidebar page and the session Tab both answer "what is happening
// *here*". The standalone page has no session at all, so it needs aggregates
// the two other surfaces never built: one row per workspace, a filterable
// review feed, a verifiable journal chain and a health readout. Everything
// below is read-only and defensive — a broken record must never blank a panel.
// ---------------------------------------------------------------------------

function workspaceLabel(id) {
  const text = String(id || '')
  if (!text) return '（未知项目）'
  const parts = text.split(/[_\\/]+/).filter(Boolean)
  const tail = parts.length ? parts[parts.length - 1] : text
  return tail.replace(/-[0-9a-f]{12}$/i, '') || tail
}

function reviewRowOf(review) {
  return {
    id: review.reviewId || review.id,
    reviewId: review.reviewId || review.id,
    sessionId: review.sessionId || '',
    stageSeq: review.stageSeq,
    workspaceId: review.workspaceId,
    verdict: review.verdict,
    engine: review.engine,
    handover: Boolean(review.handover),
    model: review.model,
    modelSource: review.modelSource || '',
    upgradeReason: review.upgradeReason || '',
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : 0,
    blocking: Boolean(review.blocking),
    createdAt: review.createdAt,
    summary: review.summary || '',
    suggestion: review.suggestion || '',
    tokens: Number.isFinite(review.tokens) ? review.tokens : 0,
    supersedes: review.supersedes || '',
    findings: Array.isArray(review.findings)
      ? review.findings.slice(0, 6).map((finding) => ({
          kind: finding.kind,
          severity: finding.severity,
          detail: finding.detail,
        }))
      : [],
  }
}

async function workspaceRows(ctx) {
  const { domain, workspaces } = await storage(ctx)
  if (!workspaces) return { ok: false, code: 'storage-unavailable' }
  const rows = new Map()
  const ensure = (rawId) => {
    const key = String(rawId || '')
    if (!rows.has(key)) {
      rows.set(key, {
        workspaceId: key,
        label: workspaceLabel(key),
        reviewCount: 0,
        criticalCount: 0,
        driftStreak: 0,
        lastReviewAt: '',
        lastVerdict: '',
        lastStageSeq: 0,
        pendingNotice: null,
        baselineRevision: 0,
        goals: 0,
        hard: 0,
        soft: 0,
        sessionCount: 0,
        requirementCount: 0,
        _sessions: new Set(),
      })
    }
    return rows.get(key)
  }
  try {
    // Session rows roll up per workspace; legacy workspace rows only fill in
    // projects that have no session row yet (pre-migration).
    const seen = new Set()
    for (const [, record] of workspaces.table('session_counters').entries()) {
      if (!record || !record.workspaceId) continue
      let c
      try {
        c = SESSION_COUNTERS.parse(record)
      } catch {
        continue
      }
      seen.add(c.workspaceId)
      const row = ensure(c.workspaceId)
      row.reviewCount += c.reviewCount || 0
      row.criticalCount += c.criticalCount || 0
      if ((c.driftStreak || 0) > (row.driftStreak || 0)) row.driftStreak = c.driftStreak || 0
      if (c.lastReviewAt && c.lastReviewAt > (row.lastReviewAt || '')) row.lastReviewAt = c.lastReviewAt
      if ((c.lastStageSeq || 0) > (row.lastStageSeq || 0)) row.lastStageSeq = c.lastStageSeq || 0
      if (c.pendingNotice) {
        if (!row.pendingNotice || (c.lastReviewAt || '') >= (row._noticeAt || '')) {
          row._noticeAt = c.lastReviewAt || ''
          row.pendingNotice = plain(c.pendingNotice)
        }
      }
    }
    for (const [key, record] of workspaces.table('counters').entries()) {
      if (!record || seen.has(key)) continue
      const counters = COUNTERS.parse(record)
      const row = ensure(key)
      row.reviewCount = counters.reviewCount
      row.criticalCount = counters.criticalCount
      row.driftStreak = counters.driftStreak
      row.lastReviewAt = counters.lastReviewAt || ''
      row.lastStageSeq = counters.lastStageSeq || 0
      row.pendingNotice = counters.pendingNotice ? plain(counters.pendingNotice) : null
    }
  } catch {
    /* counters are advisory: keep whatever rows already exist */
  }
  if (domain) {
    try {
      for (const [key, record] of domain.table('baselines').entries()) {
        if (!record) continue
        const row = ensure(record.workspaceId || key)
        row.baselineRevision = record.revision || 0
        row.goals = Array.isArray(record.goals) ? record.goals.length : 0
        const constraints = record.constraints || {}
        row.hard = Array.isArray(constraints.hard) ? constraints.hard.length : 0
        row.soft = Array.isArray(constraints.soft) ? constraints.soft.length : 0
      }
    } catch {
      /* same: baselines enrich, they do not gate the table */
    }
    try {
      for (const [, record] of domain.table('reviews').entries()) {
        if (!record) continue
        const row = ensure(record.workspaceId)
        if (record.sessionId) row._sessions.add(record.sessionId)
        if (String(record.createdAt || '') >= String(row.lastReviewAt || '')) {
          row.lastReviewAt = record.createdAt || row.lastReviewAt
          row.lastVerdict = record.verdict || row.lastVerdict
        }
      }
    } catch {
      /* reviews enrich too */
    }
    try {
      for (const [, record] of domain.table('requirements').entries()) {
        if (!record || record.status !== 'active') continue
        ensure(record.workspaceId).requirementCount += 1
      }
    } catch {
      /* requirements are optional */
    }
  }
  const list = Array.from(rows.values()).map((row) => {
    const { _sessions, _noticeAt, ...rest } = row
    return { ...rest, sessionCount: _sessions.size }
  })
  list.sort((a, b) => {
    if ((b.driftStreak || 0) !== (a.driftStreak || 0)) return (b.driftStreak || 0) - (a.driftStreak || 0)
    return String(b.lastReviewAt || '').localeCompare(String(a.lastReviewAt || ''))
  })
  return { ok: true, workspaces: list, updatedAt: now() }
}

function reviewsQuery(domain, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100)
  const offset = Math.max(Number(options.offset) || 0, 0)
  const pick = (key) => (typeof options[key] === 'string' ? options[key] : '')
  const onlyWorkspace = pick('workspaceId')
  const onlyVerdict = pick('verdict')
  const onlyEngine = pick('engine')
  const onlySession = pick('sessionId')
  const rows = []
  try {
    for (const [, record] of domain.table('reviews').entries()) {
      if (record) rows.push(record)
    }
  } catch {
    return { total: 0, matched: 0, offset, limit, rows: [] }
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  const matched = rows.filter(
    (row) =>
      (!onlyWorkspace || row.workspaceId === onlyWorkspace) &&
      (!onlyVerdict || row.verdict === onlyVerdict) &&
      (!onlyEngine || row.engine === onlyEngine) &&
      (!onlySession || row.sessionId === onlySession),
  )
  return {
    total: rows.length,
    matched: matched.length,
    offset,
    limit,
    rows: matched.slice(offset, offset + limit).map(reviewRowOf),
  }
}

function journalQuery(domain, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 200)
  const offset = Math.max(Number(options.offset) || 0, 0)
  const onlyType = typeof options.type === 'string' ? options.type : ''
  const onlyWorkspace = typeof options.workspaceId === 'string' ? options.workspaceId : ''
  const rows = []
  try {
    for (const [, record] of domain.table('journal').entries()) {
      if (record) rows.push(record)
    }
  } catch {
    return { total: 0, matched: 0, rows: [], chain: { checked: 0, ok: true, firstBrokenSeq: null } }
  }
  rows.sort((a, b) => Number(b.seq) - Number(a.seq))
  // Every entry was written with {seq, ts, type, payload} as the hashed body;
  // recomputing it turns "the chain exists" into "the chain was not edited".
  const chain = { checked: 0, ok: true, firstBrokenSeq: null }
  const ascending = rows.slice().sort((a, b) => Number(a.seq) - Number(b.seq))
  let previous = null
  for (const entry of ascending) {
    try {
      const body = { seq: entry.seq, ts: entry.ts, type: entry.type, payload: entry.payload }
      if (previous && String(entry.prevHash || '') !== String(previous.hash || '')) {
        chain.ok = false
        if (chain.firstBrokenSeq === null) chain.firstBrokenSeq = entry.seq
      }
      if (hashEntry(String(entry.prevHash || ''), body) !== entry.hash) {
        chain.ok = false
        if (chain.firstBrokenSeq === null) chain.firstBrokenSeq = entry.seq
      }
      chain.checked += 1
      previous = entry
    } catch {
      /* a single unparsable entry must not abort verification */
    }
  }
  const matched = rows.filter((row) => {
    if (onlyType && row.type !== onlyType) return false
    if (onlyWorkspace) {
      const scope = row.payload && typeof row.payload === 'object' ? row.payload.workspaceId : ''
      if (scope && scope !== onlyWorkspace && scope !== '*') return false
    }
    return true
  })
  return {
    total: rows.length,
    matched: matched.length,
    offset,
    limit,
    chain,
    rows: matched.slice(offset, offset + limit).map((row) => recentJournalRow(row)),
  }
}

function recentJournalRow(entry) {
  return {
    seq: entry.seq,
    type: entry.type,
    ts: entry.ts,
    hash: entry.hash,
    prevHash: entry.prevHash || '',
    payload: entry.payload && typeof entry.payload === 'object' ? plain(entry.payload) : null,
  }
}

async function requirementsList(ctx, opts) {
  const { domain } = await storage(ctx)
  if (!domain) return { ok: false, code: 'storage-unavailable' }
  const options = opts && typeof opts === 'object' ? opts : {}
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200)
  const onlyWorkspace = typeof options.workspaceId === 'string' ? options.workspaceId : ''
  const onlyStatus = typeof options.status === 'string' ? options.status : ''
  const rows = []
  try {
    for (const [, record] of domain.table('requirements').entries()) {
      if (record) rows.push(record)
    }
  } catch {
    return { ok: true, total: 0, rows: [] }
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  const filtered = rows.filter(
    (row) =>
      (!onlyWorkspace || row.workspaceId === onlyWorkspace) && (!onlyStatus || row.status === onlyStatus),
  )
  return {
    ok: true,
    total: rows.length,
    matched: filtered.length,
    rows: filtered.slice(0, limit).map((row) => plain(row)),
  }
}

async function healthOf(ctx) {
  const { domain, workspaces, settings: settingsDomain } = await storage(ctx)
  const counts = {}
  const readCount = (table) => {
    try {
      return table.keys().length
    } catch {
      return -1
    }
  }
  if (domain) {
    for (const name of ['baselines', 'reviews', 'reports', 'journal', 'requirements']) {
      counts[name] = readCount(domain.table(name))
    }
  }
  if (workspaces) {
    for (const name of ['counters', 'session_baselines', 'prefs', 'transcripts']) {
      try {
        counts[name] = readCount(workspaces.table(name))
      } catch {
        counts[name] = -1
      }
    }
  }
  return {
    ok: true,
    updatedAt: now(),
    storage: {
      available: Boolean(domain) || Boolean(workspaces),
      domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
      tables: counts,
    },
    rpc: {
      calls: rpcStats.calls,
      lastAt: rpcStats.lastAt,
      hello: rpcStats.hello,
      errors: rpcStats.errors.slice(-5),
      byEndpoint: plain(rpcStats.byEndpoint),
    },
    settings: settingsDomain ? plain(settingsOf(settingsDomain)) : null,
    build: SUPERVISOR_VERSION,
  }
}

function noteRpc(endpoint) {
  rpcStats.calls += 1
  const key = String(endpoint)
  rpcStats.byEndpoint[key] = (rpcStats.byEndpoint[key] || 0) + 1
  rpcStats.lastAt = new Date().toISOString()
}

function supervisorRpcHandler(ctx) {
  return async (endpoint, payload) => {
    noteRpc(endpoint)
    try {
      if (endpoint === 'beacon') {
        // Same route as the RPC calls; the browser has no other reachable path.
        const detail = (payload && typeof payload === 'object' ? payload : {}) || {}
        noteBeacon(String(detail.stage || ''), String(detail.detail || ''))
        return { ok: true, value: null }
      }
      if (endpoint === 'ui.hello') {
        const surfaces = payload && Array.isArray(payload.surfaces) ? payload.surfaces : []
        rpcStats.hello = { at: new Date().toISOString(), surfaces }
        return { ok: true, value: { channel: RPC_CHANNEL, stats: { calls: rpcStats.calls } } }
      }
      if (endpoint === 'snapshot' || endpoint === 'overview') return { ok: true, value: await overviewOf(ctx) }
      if (endpoint === 'workspaces.list') {
        const rows = await workspaceRows(ctx)
        return rows.ok
          ? { ok: true, value: rows }
          : { ok: false, error: { code: rows.code, message: '存储不可用，无法读取项目聚合', details: {} } }
      }
      if (endpoint === 'reviews.query') {
        const { domain } = await storage(ctx)
        if (!domain) {
          return { ok: false, error: { code: 'storage-unavailable', message: '存储不可用，无法读取审查流水', details: {} } }
        }
        return { ok: true, value: reviewsQuery(domain, payload) }
      }
      if (endpoint === 'journal.query') {
        const { domain } = await storage(ctx)
        if (!domain) {
          return { ok: false, error: { code: 'storage-unavailable', message: '存储不可用，无法读取审计链', details: {} } }
        }
        return { ok: true, value: journalQuery(domain, payload) }
      }
      if (endpoint === 'requirements.list') {
        const result = await requirementsList(ctx, payload)
        return result.ok
          ? { ok: true, value: result }
          : { ok: false, error: { code: result.code, message: '存储不可用，无法读取要求台账', details: {} } }
      }
      if (endpoint === 'health') {
        const value = await healthOf(ctx)
        return { ok: true, value }
      }
      if (endpoint === 'session.state') {
        const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
        return { ok: true, value: await sessionStateOf(ctx, sessionId) }
      }
      if (endpoint === 'session.toggle') {
        const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
        if (!sessionId) {
          return { ok: false, error: { code: 'missing-session', message: '缺少 sessionId', details: {} } }
        }
        const result = await setSessionEnabled(ctx, sessionId, payload ? payload.enabled : undefined)
        return result.ok
          ? { ok: true, value: { enabled: Boolean(result.pref && result.pref.enabled) } }
          : { ok: false, error: { code: result.code, message: '存储不可用，开关未保存', details: {} } }
      }
      if (endpoint === 'session.setEnabled') {
        // The composer pill may only switch 天监 ON; switching it off lives in the Tab.
        const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
        if (!sessionId) {
          return { ok: false, error: { code: 'missing-session', message: '缺少 sessionId', details: {} } }
        }
        const result = await setSessionEnabled(ctx, sessionId, payload ? payload.enabled !== false : true)
        return result.ok
          ? { ok: true, value: { enabled: Boolean(result.pref && result.pref.enabled) } }
          : { ok: false, error: { code: result.code, message: '存储不可用，开关未保存', details: {} } }
      }
      if (endpoint === 'session.viewed') {
        const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
        if (!sessionId) {
          return { ok: false, error: { code: 'missing-session', message: '缺少 sessionId', details: {} } }
        }
        const state = await sessionStateOf(ctx, sessionId)
        const result = await setSessionViewed(ctx, sessionId, (state.review && state.review.reviewId) || '')
        return result.ok
          ? { ok: true, value: { viewed: true } }
          : { ok: false, error: { code: result.code, message: '存储不可用，已读状态未保存', details: {} } }
      }
      if (endpoint === 'settings.set') {
        const result = await saveSettingsPatch(ctx, payload)
        return result.ok
          ? { ok: true, value: { settings: result.settings } }
          : { ok: false, error: { code: result.code, message: '存储不可用，设置未保存', details: {} } }
      }
      if (endpoint === 'review.transcript') {
        // The Tab pulls this once per review: 司天 brief + 观天's raw passes.
        const reviewId = payload && typeof payload.reviewId === 'string' ? payload.reviewId : ''
        const record = await transcriptOf(ctx, reviewId)
        return { ok: true, value: { transcript: record } }
      }
      if (endpoint === 'review.trail') {
        // Machine-readable audit chain for one review: journal entries whose
        // payload pins this reviewId (stage_reported / review_completed /
        // deep_review_completed / auto_review …).
        const reviewId = payload && typeof payload.reviewId === 'string' ? payload.reviewId : ''
        const trail = await journalTrail(ctx, reviewId)
        return { ok: true, value: { reviewId, trail } }
      }
      if (endpoint === 'notice.ack') {
        const result = await acknowledgeNotice(ctx, payload && payload.workspaceId)
        return result.ok
          ? { ok: true, value: { cleared: Boolean(result.cleared), workspaceId: result.workspaceId || '*' } }
          : { ok: false, error: { code: result.code, message: '存储不可用，提醒未清除', details: {} } }
      }
      return {
        ok: false,
        error: { code: 'unknown-endpoint', message: `未知 endpoint: ${String(endpoint)}`, details: {} },
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'supervisor-failed',
          message: String((err && err.message) || err),
          details: {},
        },
      }
    }
  }
}

function attachRpc(ctx) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  if (!connection || !connection.rpc || typeof connection.rpc.handle !== 'function') return () => {}
  let cancelled = false
  let disposer = null
  try {
    const pending = connection.rpc.handle(RPC_CHANNEL, supervisorRpcHandler(ctx))
    if (typeof pending === 'function') {
      disposer = pending
    } else if (pending && typeof pending.then === 'function') {
      pending
        .then((off) => {
          if (typeof off !== 'function') return
          if (cancelled) {
            Promise.resolve()
              .then(() => off())
              .catch(() => {})
            return
          }
          disposer = off
        })
        .catch(() => {})
    }
  } catch {
    return () => {}
  }
  return () => {
    cancelled = true
    if (!disposer) return
    try {
      const off = disposer
      disposer = null
      const result = off()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

/**
 * The same endpoints over a plain HTTP POST. The package-private RPC channel is
 * the intended route, but a client half that cannot resolve it still reaches the
 * host here — this is the channel the beacons already proved.
 */
function attachRpcHttp(ctx) {
  try {
    const connection = ctx.get('connection')
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      noteBeacon('http-rpc-unavailable', 'connection.fetch.register unavailable')
      return () => {}
    }
    const handler = supervisorRpcHandler(ctx)
    const dispose = connection.fetch.register({
      path: '/api/dsh-supervisor/rpc',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null
        try {
          body = typeof request.json === 'function' ? await request.json() : JSON.parse(await request.text())
        } catch {
          body = null
        }
        const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : ''
        let result
        try {
          result = await handler(endpoint, body ? body.payload : null)
        } catch (err) {
          result = { ok: false, error: { code: 'http-rpc-failed', message: String((err && err.message) || err), details: {} } }
        }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    })
    noteBeacon('http-rpc-registered', '/api/dsh-supervisor/rpc')
    return async () => {
      const off = await Promise.resolve(dispose)
      if (typeof off === 'function') await off()
    }
  } catch (err) {
    noteBeacon('http-rpc-register-failed', String((err && err.message) || err))
    return () => {}
  }
}

const DESCRIPTION =
  '天监 (supervisor) — 本项目需求的监督者。施工方在每个阶段边界调用它：' +
  'report（提交阶段汇报，并由「观天」在干净上下文里做一次轻量审查、当场返回裁决与纠偏建议）、' +
  'review（对最近一个已记录阶段重跑一次审查）、evidence（查看当前阶段已采集的证据）、status（查看基线与审查计数）、' +
  'baseline_set（经用户批准后登记或更新基线：意图/目标/硬约束/软约束/技术方向）、' +
  'review_list（查看历史审查）、journal_tail（查看审计日志）、ack（清掉阻塞提醒）、settings（查看或修改审查配置：开关/引擎/模型/超时/阻断阈值/定时兜底/阈值打断）。' +
  '证据由插件自动采集（改动文件与行数、工具调用、错误、命令、待办、目标、用户请求），施工方无需整理。' +
  '审查分两档：轻审（单次调用）与深审（先找疑点、再对抗核验）；轻审判出偏移或阶段很大时可自动升级为深审。' +
  '两项后台能力：距上次审查太久会按时间兜底复审；连续偏移或严重偏移达阈值时，天监会在下一次准备步骤强制打断施工并挂出提醒。' +
  '裁决分四档：对齐 / 轻微调整 / 存在偏移 / 严重偏移；标为阻塞级时必须先向用户报告。'

function supervisorTool(ctx) {
  return {
    name: 'supervisor',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要执行的动作。',
        },
        intent: { type: 'string', description: 'baseline_set：一句话说明项目意图。' },
        goals: { type: 'array', items: { type: 'string' }, description: 'baseline_set：项目目标清单（用户原话或已批准的需求）。' },
        directions: { type: 'array', items: { type: 'string' }, description: 'baseline_set：已确定的技术方向。' },
        constraints: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hard: { type: 'array', items: { type: 'string' }, description: '硬约束：违反即否决。' },
            soft: { type: 'array', items: { type: 'string' }, description: '软约束：违反需说明理由。' },
          },
          description: 'baseline_set：项目约束。',
        },
        summary: { type: 'string', description: 'report：本阶段做了什么、为什么这么做。' },
        touched: { type: 'array', items: { type: 'string' }, description: 'report：本阶段新增或修改的文件路径。' },
        limit: { type: 'number', description: 'review_list / journal_tail：返回条数上限。' },
        config: {
          type: 'object',
          additionalProperties: false,
          description: 'settings：要修改的配置项（不传则只查看当前设置）。',
          properties: {
            enabled: { type: 'boolean', description: '是否启用审查。' },
            engine: { type: 'string', enum: ['auto', 'light', 'deep'], description: '审查引擎：auto（轻审后按需升级深审）/ light / deep。' },
            lightProvider: { type: 'string', description: '轻审使用的 provider（留空则跟随当前会话模型）。' },
            lightModel: { type: 'string', description: '轻审使用的模型 id（留空则跟随当前会话模型）。' },
            deepProvider: { type: 'string', description: '深审使用的 provider（留空则跟随轻审）。' },
            deepModel: { type: 'string', description: '深审使用的模型 id（留空则跟随轻审）。' },
            deepOnDrift: { type: 'boolean', description: '轻审判定存在偏移/严重偏移时，是否自动升级为两段式深审。' },
            timeoutMs: { type: 'number', description: '单次审查调用超时（毫秒）。' },
            maxBriefChars: { type: 'number', description: '送审简报的最大字符数（深审按 2 倍）。' },
            userVoiceChars: { type: 'number', description: '「用户原话」段的独立字数预算（默认 1600，不参与证据截断）。' },
            requirementsChars: { type: 'number', description: '「用户要求台账」段的独立字数预算（默认 900）。' },
            evidenceChars: { type: 'number', description: '机器证据段的字数上限（默认 4200）。' },
            ledgerEnabled: { type: 'boolean', description: '是否启用跨阶段「用户要求台账」（独立提炼 + 审查交叉校验）。' },
            ledgerMaxActive: { type: 'number', description: '台账保留的有效要求上限。' },
            driftStreakLimit: { type: 'number', description: '连续偏移多少轮算阻塞级。' },
            criticalLimit: { type: 'number', description: '严重偏移累计多少次算阻塞级。' },
            autoReviewMinutes: { type: 'number', description: '定时兜底：距上次审查超过多少分钟且回合已结束有改动时自动复审一次（0=关闭）。' },
            interruptEnabled: { type: 'boolean', description: '达到阻断阈值时，是否在下一次准备步骤强制打断施工（agent/pre-step reject）。' },
            interruptCooldownMs: { type: 'number', description: '两次强制打断之间的冷却时间（毫秒）。' },
            agentVoiceChars: { type: 'number', description: '「子代理回传」段的独立字数预算（默认 800）。' },
            childDigest: { type: 'boolean', description: '审查时是否自动附带子会话摘要（默认开启，深挖走 child_read）。' },
            kyzmemReflow: { type: 'boolean', description: '每次审查落库后是否向 kyzmem 写一条阶段教训（经验回流；kyzmem 不可用时自动跳过）。' },
          },
        },
        childId: { type: 'string', description: 'child_read：要回读的子会话 id（children 目录里给的完整 id）。' },
        childLimit: { type: 'number', description: 'child_read：最多回读多少条（默认 40，上限 100，从新往旧）。' },
        childTypes: { type: 'array', items: { type: 'string' }, description: 'child_read：只回读这些事件类型（默认只看实质事件）。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          message: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['status', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `天监 · ${args && args.action ? args.action : 'supervisor'}`,
      kind: 'other',
      rawInput: args,
    }),
    execute: async (args, exec) => {
      const action = args && args.action
      switch (action) {
        case 'status':
          return actionStatus(ctx, exec)
        case 'baseline_set':
          return actionBaselineSet(ctx, exec, args)
        case 'report':
          return actionReport(ctx, exec, args)
        case 'review':
          return actionReview(ctx, exec, args)
        case 'settings':
          return actionSettings(ctx, exec, args)
        case 'evidence':
          return actionEvidence(ctx, exec)
        case 'review_list':
          return actionReviewList(ctx, exec, args)
        case 'journal_tail':
          return actionJournalTail(ctx, exec, args)
        case 'ack':
          return actionAck(ctx)
        case 'diag':
          return actionDiag(ctx)
        case 'ui_state':
          return actionUiState(ctx, exec)
        case 'children':
          return actionChildren(ctx, exec)
        case 'child_read':
          return actionChildRead(ctx, exec, args)
        default:
          return { status: 'error', message: `天监：未知 action「${action}」。可用：${ACTIONS.join(' / ')}。` }
      }
    },
  }
}

/**
 * The browser half talks to the host through a plain Node HTTP route on the
 * host's own webServer (the same mechanism dsh-pocket uses). connection.fetch
 * does not exist on this host, so the earlier /api route never registered.
 * Body: {endpoint, payload}. Endpoint "beacon" only records a breadcrumb.
 */
const WEB_ROUTE_PATH = '/dsh-supervisor'

function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function attachWebRoute(ctx) {
  const webServer = safeGet(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    noteBeacon('web-route-unavailable', 'webServer service missing')
    return () => {}
  }
  const connection = safeGet(ctx, 'connection')
  const handler = supervisorRpcHandler(ctx)
  const route = {
    kind: 'prefix',
    path: WEB_ROUTE_PATH,
    handler: async (req, res) => {
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      let rejection
      if (connection && typeof connection.requestRejection === 'function') {
        try {
          rejection = connection.requestRejection(req)
        } catch {
          rejection = 403
        }
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        send(405, { ok: false, error: { code: 'bad-request', message: 'POST only', details: { issues: [] } } })
        return
      }
      const body = await readJsonBody(req)
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : ''
      if (endpoint === 'beacon') {
        const detail = body.payload || {}
        noteBeacon(String(detail.stage || ''), String(detail.detail || ''))
        send(200, { ok: true, value: null })
        return
      }
      let result
      try {
        result = await handler(endpoint, body ? body.payload : null)
      } catch (err) {
        result = { ok: false, error: { code: 'http-rpc-failed', message: String((err && err.message) || err), details: {} } }
      }
      send(200, result)
    },
  }
  let disposed = false
  let off = null
  try {
    const registered = webServer.register(route)
    if (typeof registered === 'function') {
      off = registered
    } else if (registered && typeof registered.then === 'function') {
      registered
        .then((fn) => {
          if (typeof fn !== 'function') return
          if (disposed) fn()
          else off = fn
        })
        .catch((err) => noteBeacon('web-route-register-failed', String((err && err.message) || err)))
    }
    noteBeacon('web-route-registered', WEB_ROUTE_PATH)
  } catch (err) {
    noteBeacon('web-route-register-failed', String((err && err.message) || err))
  }
  return () => {
    disposed = true
    try {
      if (typeof off === 'function') {
        const result = off()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Register the tool as an effect owned by this plugin context, so unloading the
 * plugin removes it again; the storage domain is closed on the same disposer.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const unregisterCollector = attachCollector(ctx)
    const unregisterInterrupt = attachInterrupt(ctx)
    const stopScheduler = startAutoReview(ctx)
    const stopLedger = startLedger(ctx)
    // Register the browser route only while its connection service is present.
    // Unlike a one-shot ctx.get(), inject reinstalls it if the service arrives late.
    const routeContexts = new Set()
    const routeFiber = ctx.inject(['connection'], (connectionCtx) => {
      routeContexts.add(connectionCtx)
      const unregisterRoute = attachRpcHttp(connectionCtx)
      return async () => {
        retiredStorageContexts.add(connectionCtx)
        routeContexts.delete(connectionCtx)
        await unregisterRoute()
      }
    })
    const unregister = ctx.tools.register(supervisorTool(ctx))
    void (async () => {
      try {
        const { settings: settingsDomain } = await storage(ctx)
        if (!settingsDomain) return
        const stored = settingsOf(settingsDomain)
        if (stored.budgetMigrated) return
        const next = { ...stored, maxBriefChars: Math.max(stored.maxBriefChars || 0, 8000), budgetMigrated: true }
        await settingsDomain.global.set(SETTINGS.parse(next))
      } catch {
        /* a settings migration must never block load */
      }
    })()
    return async () => {
      retiredStorageContexts.add(ctx)
      for (const connectionCtx of routeContexts) retiredStorageContexts.add(connectionCtx)
      try {
        unregisterCollector()
      } catch {
        /* ignore */
      }
      try {
        unregisterInterrupt()
      } catch {
        /* ignore */
      }
      try {
        stopScheduler()
      } catch {
        /* ignore */
      }
      try {
        stopLedger()
      } catch {
        /* ignore */
      }
      // Detach this generation's storage before awaiting any unrelated teardown.
      const storageCleanup = closeStorage()
      try {
        if (routeFiber && typeof routeFiber.dispose === 'function') await routeFiber.dispose()
      } catch (err) {
        noteBeacon('http-rpc-dispose-failed', String((err && err.message) || err))
      }
      unregister()
      accumulators.clear()
      await storageCleanup
    }
  }, 'dsh-supervisor: supervisor tool + evidence collector + storage domain')
}

/**
 * Offline test hook. Not part of the plugin contract: the runtime only reads
 * {name, inject, apply}. `dev-supervisor-host-test.mjs` uses this to exercise
 * the read-only query helpers against a fake storage facility without booting
 * the whole harness (and without needing the GUI's auth token).
 */
export const __internals = {
  workspaceLabel,
  reviewRowOf,
  recentJournalRow,
  workspaceRows,
  reviewsQuery,
  journalQuery,
  requirementsList,
  healthOf,
  normalizeChildRow,
  readChildSession,
  summarizeChildren,
  renderChildEvent,
  sessionCounterKey,
  workspaceCountersOf,
  countersOf,
  saveCounters,
  clearNotices,
}

// dsh-supervisor client half.
//
// Three surfaces, three jobs:
//   sidebar.panellist + main   → the plugin as a whole: cross-project rollup + settings
//   conversation.input.right   → this session's 天监: state badge + on/off (inside
//                                the composer tool row, so the input box keeps its height)
//   conversation.view (天监)   → this session's 天监: what it has seen and ruled
//
// 天监 is session-scoped: a session is supervised or it is not. Baselines stay
// keyed by workspace (a project's intent spans its sessions), but every surface
// here asks the host for one session's view.
//
// The whole file is an IIFE on purpose: the module loader may evaluate the bundle
// again on reload, and a top-level `const` would then throw "already been declared".
;(function () {
  'use strict'

  var CHANNEL = '/dsh-supervisor'
  var RPC_PATH = '/api/dsh-supervisor/rpc'
  var PANEL_ID = 'dsh-supervisor'
  var VIEW_ID = 'supervisor'
  var POLL_MS = 12000
  var CLIENT_BUILD = 'v1.5.2'

  var React = null
  try {
    React = require('react')
  } catch (err) {
    React = null
  }

  // `styles` is one of the four factory builtins (ctx/React/host/styles/console),
  // NOT a ctx service: require it, and only fall back to ctx.get for older hosts.
  var styleHost = null
  try {
    styleHost = require('styles') || null
  } catch (err) {
    styleHost = null
  }

  function beacon(stage, detail) {
    var text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
    var body = JSON.stringify({
      endpoint: 'beacon',
      payload: { stage: String(stage), detail: String(text).slice(0, 400) + ' · ' + CLIENT_BUILD },
    })
    try {
      if (typeof fetch !== 'function') return
      fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {})
    } catch (err) {
      /* beacons are best-effort */
    }
  }

  function serviceOf(ctx, name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch (err) {
      return undefined
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }

  // -------------------------------------------------------------------------
  // Transport: one function, three routes, failures reported honestly.
  // -------------------------------------------------------------------------
  function makeRpc(ctx) {
    return async function call(endpoint, payload) {
      var body = JSON.stringify({ endpoint: String(endpoint), payload: payload === undefined ? null : payload })
      var failures = []
      if (typeof fetch === 'function') {
        for (var i = 0; i < 2; i += 1) {
          try {
            var response = await fetch(RPC_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: body,
              cache: 'no-store',
            })
            if (response && typeof response.json === 'function') {
              var raw = ''
              try {
                raw = await response.text()
              } catch (readErr) {
                raw = ''
              }
              if (raw) {
                try {
                  var parsed = JSON.parse(raw)
                  if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed
                } catch (parseErr) {
                  failures.push('响应不是 JSON（HTTP ' + String(response.status) + '，' + raw.slice(0, 40) + '）')
                  if (i === 0) await delay(400)
                  continue
                }
              }
              failures.push(
                '宿主通道无响应体（HTTP ' + String(response.status) + '）',
              )
            } else {
              failures.push('HTTP ' + String(response && response.status))
            }
          } catch (err) {
            failures.push(String((err && err.message) || err))
          }
          if (i === 0) await delay(400)
        }
      }
      return {
        ok: false,
        error: { code: 'transport', message: failures.length ? failures.join(' · ') : '无法连接天监宿主', details: {} },
      }
    }
  }

  // -------------------------------------------------------------------------
  // Design tokens: the host's aliases, nothing else. Light/dark and every theme
  // override (including dsh-k-bloom-theme) reach these through CSS variables.
  // -------------------------------------------------------------------------
  var T = {
    text: 'var(--dsw-alias-label-primary, #1f2328)',
    dim: 'var(--dsw-alias-label-secondary, #6b7280)',
    surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    nested: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
    base: 'var(--dsw-alias-bg-base, #ffffff)',
    border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
    borderStrong: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.18))',
    brand: 'var(--dsw-alias-brand-primary, #3b5bdb)',
    ok: 'var(--dsw-alias-state-success-primary, #1f9d55)',
    warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
    bad: 'var(--dsw-alias-state-error-primary, #c53030)',
    idle: 'var(--dsw-alias-state-idle-primary, #9aa3b2)',
  }

  var VERDICT = {
    aligned: { label: '对齐', color: T.ok },
    minor: { label: '轻微调整', color: T.idle },
    drift: { label: '存在偏移', color: T.warn },
    critical: { label: '严重偏移', color: T.bad },
    pending: { label: '待审', color: T.idle },
  }

  var ENGINE_LABEL = { light: '轻审', full: '深审', deep: '深审', handover: '接管' }

  function verdictOf(value) {
    return VERDICT[value] || VERDICT.pending
  }

  function num(value, fallback) {
    var number = Number(value)
    return Number.isFinite(number) ? String(number) : fallback === undefined ? '—' : fallback
  }

  function shortTime(iso) {
    if (typeof iso !== 'string' || !iso) return '—'
    var date = new Date(iso)
    if (!Number.isFinite(date.getTime())) return '—'
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n)
    }
    return pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  function shortWorkspace(id) {
    if (typeof id !== 'string' || !id) return '—'
    var cut = id.lastIndexOf('-')
    return cut > 8 ? id.slice(0, cut) : id
  }

  // Panel-only view helpers: derive display strings, never fetch.
  function policyOf(s) {
    var eng = (s && s.engine) || 'auto'
    var engLabel = eng === 'light' ? '仅轻审' : eng === 'deep' ? '仅深审' : '自动（轻审先行）'
    var up = s && s.deepOnDrift === false ? '偏移不升级' : '偏移升深审'
    var auto = s && s.autoReviewMinutes ? '兜底 ' + s.autoReviewMinutes + ' 分钟' : '兜底关'
    var intr = s && s.interruptEnabled ? '打断开' : '打断关'
    return engLabel + ' · ' + up + ' · ' + auto + ' · ' + intr
  }

  function modelText(entry, fallback) {
    if (entry && (entry.provider || entry.model)) {
      var who = [entry.provider, entry.model].filter(Boolean).join(' / ')
      return entry.source ? who + '（' + entry.source + '指定）' : who
    }
    return fallback
  }

  function pctOf(count, limit) {
    var c = Number(count)
    var l = Number(limit)
    if (!Number.isFinite(c) || !Number.isFinite(l) || l <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((c / l) * 100)))
  }

  // -------------------------------------------------------------------------
  // Small primitives (host-shaped, host tokens, our own markup only).
  // -------------------------------------------------------------------------
  var styles = {
    page: {
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      padding: '24px 28px 40px',
      color: T.text,
      fontSize: '13px',
      lineHeight: 1.55,
      overflowY: 'auto',
      height: '100%',
      boxSizing: 'border-box',
    },
    masthead: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
    mark: {
      width: '34px',
      height: '34px',
      flex: '0 0 auto',
      borderRadius: '10px',
      background: T.nested,
      display: 'grid',
      placeItems: 'center',
      border: '1px solid ' + T.border,
    },
    title: { margin: 0, fontSize: '16px', fontWeight: 600 },
    titleSmall: { margin: 0, fontSize: '15px', fontWeight: 600 },
    subtitle: {
      margin: '2px 0 0',
      color: T.dim,
      fontSize: '12px',
    },
    section: { display: 'flex', flexDirection: 'column', gap: '10px' },
    sectionHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
    sectionTitle: { margin: 0, fontSize: '12.5px', fontWeight: 600, color: T.text },
    hint: { margin: 0, color: T.dim, fontSize: '11px' },
    stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px' },
    stat: {
      background: T.surface,
      border: '1px solid ' + T.border,
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
    },
    statValue: { fontSize: '20px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.2px' },
    statLabel: { color: T.dim, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    card: {
      background: T.surface,
      border: '1px solid ' + T.border,
      borderRadius: '10px',
      padding: '12px 16px',
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '7px 0',
      borderBottom: '1px solid ' + T.border,
    },
    rowLast: { borderBottom: 'none' },
    rowLabel: { color: T.dim, fontSize: '12px', flex: '0 0 auto' },
    rowValue: { color: T.text, fontSize: '12px', textAlign: 'right', wordBreak: 'break-word' },
    chip: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 9px',
      borderRadius: '999px',
      border: '1px solid ' + T.border,
      background: T.nested,
      fontSize: '11px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
    },
    button: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '5px 11px',
      borderRadius: '8px',
      border: '1px solid ' + T.borderStrong,
      background: T.surface,
      color: T.text,
      fontSize: '12px',
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease',
    },
    segmented: {
      display: 'inline-flex',
      padding: '2px',
      gap: '2px',
      borderRadius: '9px',
      border: '1px solid ' + T.border,
      background: T.nested,
    },
    segment: {
      padding: '3px 10px',
      borderRadius: '7px',
      border: 'none',
      background: 'transparent',
      color: T.dim,
      fontSize: '11.5px',
      cursor: 'pointer',
      transition: 'background 160ms ease, color 160ms ease',
    },
    segmentOn: {
      background: T.surface,
      color: T.text,
      fontWeight: 600,
      boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
    },
    bar: { display: 'flex', height: '6px', borderRadius: '999px', overflow: 'hidden', background: T.nested, border: '1px solid ' + T.border },
    input: {
      width: '60px',
      padding: '4px 8px',
      borderRadius: '7px',
      border: '1px solid ' + T.borderStrong,
      background: T.base,
      color: T.text,
      fontSize: '12px',
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
    },
    empty: { color: T.dim, fontSize: '12px', padding: '8px 0' },
    mono: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '11px',
      color: T.dim,
    },
    dot: { width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto', display: 'inline-block' },
    notice: {
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
      background: T.surface,
      border: '1px solid ' + T.bad,
      borderRadius: '10px',
      padding: '12px 14px',
    },
    noticeTitle: { margin: 0, fontSize: '12.5px', fontWeight: 700, color: T.bad },
    noticeText: { margin: '2px 0 0', fontSize: '12px', color: T.text, wordBreak: 'break-word' },
    metaLine: { margin: '2px 0 0', fontSize: '11px', color: T.dim, wordBreak: 'break-word' },
    kicker: { margin: '8px 0 2px', fontSize: '11.5px', fontWeight: 600, color: T.dim },
    oneLiner: { margin: '2px 0 6px', fontSize: '11.5px', color: T.dim, wordBreak: 'break-word' },
    meterTrack: { height: '6px', borderRadius: '999px', overflow: 'hidden', background: T.nested, border: '1px solid ' + T.border },
    meterFill: { height: '100%', borderRadius: '999px', transition: 'width 200ms ease' },
    syncLine: { margin: '-6px 0 0', color: T.dim, fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
    noticeBar: { display: 'flex', alignItems: 'center', gap: '10px', background: T.surface, border: '1px solid ' + T.bad, borderLeftWidth: '4px', borderRadius: '10px', padding: '10px 12px', fontSize: '12px' },
    policyCard: { background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '2px' },
    policyLead: { margin: 0, fontSize: '13px', fontWeight: 600, color: T.text },
    meter: { height: '6px', borderRadius: '999px', overflow: 'hidden', background: T.nested, border: '1px solid ' + T.border, minWidth: '90px', flex: '1 1 auto' },
    meterFill: { display: 'block', height: '100%', transition: 'width 260ms ease' },
    fieldGrid: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
    textInput: { width: '130px', padding: '4px 8px', borderRadius: '7px', border: '1px solid ' + T.borderStrong, background: T.base, color: T.text, fontSize: '12px' },
    badge: { display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: '999px', border: '1px solid ' + T.bad, color: T.bad, fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap' },
    suggest: { margin: '2px 0 8px 15px', fontSize: '12px', color: T.text, borderLeft: '2px solid ' + T.borderStrong, paddingLeft: '8px' },
    echo: { margin: '8px 0 0', fontSize: '11.5px' },
    warnLine: { margin: '4px 0 0', fontSize: '11.5px', color: T.text, fontWeight: 600 },
    foldGap: { display: 'flex', flexDirection: 'column', gap: '10px' },
    // Inside the composer's tool row the entry must not add a row of its own:
    // no vertical padding, no full width — just an inline chip on the right.
    pillDock: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0' },
  }

  function Dot(props) {
    var size = props.size || 7
    var style = {
      width: size,
      height: size,
      borderRadius: '50%',
      background: props.color,
      display: 'inline-block',
      flex: '0 0 auto',
    }
    if (props.style) style = Object.assign(style, props.style)
    return React.createElement('span', { style: style, 'aria-hidden': 'true' })
  }

  function Stat(props) {
    return React.createElement(
      'div',
      { style: styles.stat, title: props.hint || undefined },
      React.createElement('span', { style: styles.statValue }, props.value),
      React.createElement('span', { style: styles.statLabel }, props.label),
    )
  }

  function Row(props) {
    return React.createElement(
      'div',
      { style: props.last ? Object.assign({}, styles.row, styles.rowLast) : styles.row },
      React.createElement('span', { style: styles.rowLabel }, props.label),
      React.createElement('span', { style: styles.rowValue }, props.value),
    )
  }

  // Structured transcript rendering (editorial direction: hierarchy first).
  // Model outputs arrive as JSON strings or markdown-lite; parse them
  // defensively into rows. Anything unparseable falls back to raw <pre>,
  // so a weird payload can never break the Tab.
  function tryJson(text) {
    if (typeof text !== 'string') return null
    var trimmed = text.trim()
    if (!trimmed) return null
    var head = trimmed.charAt(0)
    if (head !== '{' && head !== '[') return null
    try {
      return JSON.parse(trimmed)
    } catch (err) {
      return null
    }
  }

  var KIND_LABEL = { risk: '风险', scope: '范围', behavior: '行为', direction: '方向', evidence: '证据', process: '流程', constraint: '约束', quality: '质量', goal: '目标', preference: '偏好' }

  function severityColor(severity) {
    return severity === 'high' ? T.bad : severity === 'medium' ? T.warn : T.dim
  }

  function KindChip(props) {
    return React.createElement(
      'span',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 7px',
          borderRadius: '999px',
          border: '1px solid ' + T.borderStrong,
          fontSize: '10.5px',
          color: T.dim,
          whiteSpace: 'nowrap',
          flex: '0 0 auto',
        },
      },
      KIND_LABEL[props.kind] || String(props.kind || '其它'),
    )
  }

  function FindingRow(props) {
    var finding = props.finding || {}
    return React.createElement(
      'li',
      {
        key: props.rowKey,
        style: { fontSize: '12px', color: T.text, display: 'flex', gap: '8px', alignItems: 'flex-start' },
      },
      React.createElement('span', { style: { paddingTop: '5px' } }, React.createElement(Dot, { color: severityColor(finding.severity), size: 5 })),
      React.createElement(
        'span',
        { style: { minWidth: 0 } },
        finding.kind
          ? React.createElement(
              'span',
              { style: { display: 'inline-flex', marginRight: '6px', verticalAlign: '1px' } },
              React.createElement(KindChip, { kind: finding.kind }),
            )
          : null,
        React.createElement('span', null, String(finding.detail || '')),
        finding.basis
          ? React.createElement(
              'span',
              { style: { display: 'block', color: T.dim, fontSize: '11px', marginTop: '2px' } },
              '依据：' + String(finding.basis),
            )
          : null,
      ),
    )
  }

  function FindingsList(props) {
    var items = Array.isArray(props.items) ? props.items : []
    var capped = typeof props.limit === 'number' ? items.slice(0, props.limit) : items
    if (!capped.length) return null
    return React.createElement(
      'ul',
      { style: { margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px', listStyle: 'none' } },
      capped.map(function (finding, index) {
        return React.createElement(FindingRow, { key: 'finding-' + index, rowKey: 'finding-' + index, finding: finding })
      }),
    )
  }

  function RawPre(props) {
    return React.createElement(
      'pre',
      {
        style: {
          margin: '8px 0 0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          fontSize: '11.5px',
          lineHeight: 1.6,
          color: T.text,
          maxHeight: '260px',
          overflow: 'auto',
        },
      },
      props.text,
    )
  }

  function Fold(props) {
    return React.createElement(
      'details',
      {
        style: { border: '1px solid ' + T.border, borderRadius: '8px', background: T.nested },
      },
      React.createElement(
        'summary',
        { style: { cursor: 'pointer', fontSize: '11.5px', color: T.text, padding: '8px 10px', listStyle: 'none' } },
        React.createElement('span', { style: { color: T.dim } }, props.kicker ? props.kicker + ' · ' : ''),
        React.createElement('span', { style: { fontWeight: 600 } }, props.title),
        React.createElement('span', { style: { color: T.dim } }, ' · ' + props.count),
      ),
      React.createElement('div', { style: { padding: '0 10px 10px' } }, props.children),
    )
  }

  // 司天简报是 markdown-lite：## 标题 / - 列表 / 普通段落。
  function BriefBlock(props) {
    var text = String(props.text || '').trim()
    if (!text) return null
    var nodes = []
    var listBuf = []
    function flushList() {
      if (!listBuf.length) return
      var items = listBuf
      listBuf = []
      nodes.push(
        React.createElement(
          'ul',
          { key: 'ul-' + nodes.length, style: { margin: '4px 0 6px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' } },
          items.map(function (item, index) {
            return React.createElement('li', { key: 'li-' + index, style: { fontSize: '12px', color: T.text } }, item)
          }),
        ),
      )
    }
    text.split('\n').forEach(function (rawLine, index) {
      var line = rawLine.replace(/\s+$/, '')
      var trimmed = line.trim()
      if (!trimmed) {
        flushList()
        return
      }
      var heading = trimmed.match(/^#{1,3}\s+(.*)$/)
      if (heading) {
        flushList()
        nodes.push(
          React.createElement(
            'h4',
            { key: 'h-' + index, style: { margin: '8px 0 2px', fontSize: '12.5px', fontWeight: 700, color: T.text } },
            heading[1],
          ),
        )
        return
      }
      var bullet = trimmed.match(/^(?:[-*•]|(?:\d+)[.)])\s+(.*)$/)
      var indented = !bullet && /^\s{2,}\S/.test(line)
      if (bullet || indented) {
        listBuf.push(bullet ? bullet[1] : trimmed)
        return
      }
      flushList()
      nodes.push(
        React.createElement('p', { key: 'p-' + index, style: { margin: '4px 0', fontSize: '12px', color: T.text } }, trimmed),
      )
    })
    flushList()
    return React.createElement(
      Fold,
      { kicker: props.kicker, title: props.title, count: '简报全文' },
      React.createElement('div', { style: { paddingTop: '2px' } }, nodes),
    )
  }

  // 观天细读：JSON 疑点数组 → 结构化行；非 JSON → 原文。
  function SuspicionsBlock(props) {
    var text = String(props.text || '').trim()
    if (!text) return null
    var parsed = tryJson(text)
    var items = parsed && Array.isArray(parsed.suspicions) ? parsed.suspicions : null
    return React.createElement(
      Fold,
      { kicker: props.kicker, title: props.title, count: items ? items.length + ' 条疑点' : text.length + ' 字原文' },
      items
        ? React.createElement(FindingsList, { items: items })
        : React.createElement(RawPre, { text: text }),
    )
  }

  // 观天核验：JSON 裁决 → 裁决章 + 结论 + findings；非 JSON → 原文。
  function VerdictBlock(props) {
    var text = String(props.text || '').trim()
    if (!text) return null
    var parsed = tryJson(text)
    var usable = parsed && typeof parsed === 'object' && (parsed.verdict || parsed.summary || Array.isArray(parsed.findings))
    if (!usable) {
      return React.createElement(Fold, { kicker: props.kicker, title: props.title, count: text.length + ' 字原文' }, React.createElement(RawPre, { text: text }))
    }
    var meta = verdictOf(parsed.verdict)
    return React.createElement(
      Fold,
      {
        kicker: props.kicker,
        title: props.title,
        count: meta.label + (Array.isArray(parsed.findings) ? ' · ' + parsed.findings.length + ' 条' : ''),
      },
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        React.createElement(
          'span',
          { style: Object.assign({}, styles.chip, { borderColor: meta.color, color: meta.color, alignSelf: 'flex-start' }) },
          React.createElement(Dot, { color: meta.color, size: 6 }),
          meta.label,
        ),
        parsed.summary
          ? React.createElement('p', { style: { margin: 0, fontSize: '12.5px', color: T.text } }, String(parsed.summary))
          : null,
        React.createElement(FindingsList, { items: parsed.findings }),
      ),
    )
  }

  // 疑点清单：[kind] 前缀行 → chip + 文本。
  function NotesBlock(props) {
    var text = String(props.text || '').trim()
    if (!text) return null
    var rows = text.split('\n').map(function (line) {
      return line.trim()
    }).filter(Boolean)
    var structured = rows.length > 0 && rows.every(function (line) {
      return /^\[[^\]]+\]/.test(line)
    })
    var body = structured
      ? rows.map(function (line, index) {
          var match = line.match(/^\[([^\]]+)\]\s*(.*)$/)
          return React.createElement(
            'div',
            { key: 'note-' + index, style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px' } },
            React.createElement(KindChip, { kind: match[1] }),
            React.createElement('span', { style: { color: T.text, minWidth: 0 } }, match[2]),
          )
        })
      : React.createElement(RawPre, { text: text })
    return React.createElement(
      Fold,
      { kicker: props.kicker, title: props.title, count: structured ? rows.length + ' 条' : text.length + ' 字' },
      structured
        ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, body)
        : body,
    )
  }

  // -- Tab 第二轮视觉：编辑杂志式信息链（A–G），纯渲染层 ----------------------
  // 所有文案走 safeStr：缺字段时显示"—/未记录"，永不出现 undefined 文本。
  function safeStr(value, fallback) {
    if (value === null || value === undefined) return fallback === undefined ? '—' : fallback
    var text = String(value)
    return text.trim() ? text : fallback === undefined ? '—' : fallback
  }

  function fmtDur(ms) {
    var n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return '未记录'
    if (n < 1000) return String(Math.round(n)) + ' 毫秒'
    return (n / 1000).toFixed(1) + ' 秒'
  }

  var TRIGGER_LABEL = { report: '施工方汇报', auto: '定时兜底', manual: '手动重跑' }

  function triggerText(trigger) {
    var t = trigger && typeof trigger === 'object' ? trigger : null
    if (!t || !t.kind) return '触发未记录'
    var label = TRIGGER_LABEL[t.kind] || String(t.kind)
    var when = t.at ? shortTime(t.at) : ''
    var by = t.by ? String(t.by).trim() : ''
    return label + (when && when !== '—' ? ' · ' + when : '') + (by ? ' · 经手 ' + by : '')
  }

  function upgradeText(reason) {
    var r = String(reason || '')
    if (!r) return '未记录'
    if (r === 'direct-light') return '直接轻审'
    if (r === 'manual-deep') return '指定深审'
    if (r.indexOf('auto-upgrade:') === 0) {
      var first = r.slice('auto-upgrade:'.length)
      return '轻审判偏 · 自动升级深审（初判' + verdictOf(first).label + '）'
    }
    return r
  }

  function modelSourceText(source) {
    if (source === 'settings') return '配置指定'
    if (source === 'session') return '跟随会话'
    if (source === 'settings←light') return '配置（沿用轻审分档）'
    return '未记录'
  }

  function shortIdTail(id) {
    var s = String(id || '')
    return s.length > 18 ? '…' + s.slice(-8) : s
  }

  // 审计"复制原文"入口：优先 clipboard，降级 textarea；无位移动效。
  function CopyText(props) {
    var doneState = React.useState(false)
    var done = doneState[0]
    var setDone = doneState[1]
    function mark() {
      setDone(true)
      setTimeout(function () {
        setDone(false)
      }, 1200)
    }
    function copy() {
      var text = String(props.text || '')
      if (!text) return
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(mark, function () {})
          return
        }
      } catch (err) {
        /* fall through to the legacy path */
      }
      try {
        var area = document.createElement('textarea')
        area.value = text
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
        mark()
      } catch (err) {
        /* clipboard unavailable: stay silent, never break the Tab */
      }
    }
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: copy,
        title: '复制原文（一字不差）',
        style: Object.assign({}, styles.button, { padding: '2px 9px', fontSize: '11px', alignSelf: 'flex-start' }),
      },
      done ? '已复制' : safeStr(props.label, '复制原文'),
    )
  }

  // 距阈值仪表：文字 + 色条（超限转红），窄屏下纵向堆叠不断行。
  function Meter(props) {
    var raw = Number(props.value)
    var lim = Number(props.limit)
    var safe = Number.isFinite(raw) ? raw : 0
    var top = Number.isFinite(lim) && lim > 0 ? lim : 0
    var ratio = top > 0 ? Math.min(1, safe / top) : 0
    var hot = top > 0 && safe >= top
    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: '1 1 140px' } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
        React.createElement('span', { style: styles.rowLabel }, props.label),
        React.createElement(
          'span',
          { style: { fontSize: '12px', color: hot ? T.bad : T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
          String(safe) + (top > 0 ? ' / ' + String(top) : ''),
        ),
      ),
      React.createElement(
        'div',
        { style: styles.meterTrack, role: 'img', 'aria-label': String(props.label) + String(safe) + (top > 0 ? '，阈值' + String(top) : '') },
        React.createElement('div', {
          style: Object.assign({}, styles.meterFill, { width: String(Math.round(ratio * 100)) + '%', background: hot ? T.bad : T.brand }),
        }),
      ),
    )
  }

  function baseList(items) {
    var list = Array.isArray(items) ? items : []
    if (!list.length) return React.createElement('p', { style: styles.empty }, '（空）')
    return React.createElement(
      'ol',
      { style: { margin: '2px 0 8px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' } },
      list.map(function (item, index) {
        var line = item && typeof item === 'object' ? String(item.text || '') : String(item || '')
        return React.createElement('li', { key: 'bl-' + index, style: { fontSize: '12px', color: T.text } }, line)
      }),
    )
  }

  // A3/A4：基线全文折叠（默认收起）+ 纯文本复制口。
  function BaselineFullFold(props) {
    var record = props.record && typeof props.record === 'object' ? props.record : null
    if (!record) return null
    var goals = Array.isArray(record.goals) ? record.goals : []
    var hard = record.constraints && Array.isArray(record.constraints.hard) ? record.constraints.hard : []
    var soft = record.constraints && Array.isArray(record.constraints.soft) ? record.constraints.soft : []
    var dirs = Array.isArray(record.directions) ? record.directions : []
    var decisions = Array.isArray(record.decisions) ? record.decisions : []
    var total = goals.length + hard.length + soft.length + dirs.length + decisions.length
    var plain = ['意图：' + safeStr(record.intent, '（未填写）')]
      .concat(goals.map(function (g, i) { return '目标' + (i + 1) + '：' + String(g) }))
      .concat(hard.map(function (h, i) { return '硬约束' + (i + 1) + '：' + String(h) }))
      .concat(soft.map(function (s, i) { return '软约束' + (i + 1) + '：' + String(s) }))
      .concat(dirs.map(function (d, i) { return '技术方向' + (i + 1) + '：' + String(d) }))
      .concat(decisions.map(function (d) { return '已记录决定：' + String((d && d.text) || d) }))
      .join('\n')
    return React.createElement(
      Fold,
      { kicker: props.kicker, title: '基线全文', count: '第 ' + num(record.revision) + ' 版 · ' + total + ' 条' },
      React.createElement('p', { style: { margin: '6px 0', fontSize: '12px', color: T.text } }, safeStr(record.intent, '（未填写）')),
      React.createElement('h4', { style: styles.kicker }, '目标（' + goals.length + '）'),
      baseList(goals),
      React.createElement('h4', { style: styles.kicker }, '硬约束（' + hard.length + '）'),
      baseList(hard),
      React.createElement('h4', { style: styles.kicker }, '软约束（' + soft.length + '）'),
      baseList(soft),
      React.createElement('h4', { style: styles.kicker }, '技术方向（' + dirs.length + '）'),
      baseList(dirs),
      decisions.length
        ? React.createElement('h4', { style: styles.kicker }, '已记录决定（' + decisions.length + '）')
        : null,
      decisions.length ? baseList(decisions) : null,
      React.createElement(CopyText, { text: plain, label: '复制基线全文' }),
    )
  }

  // B3：结构化证据明细折叠（transcript.evidenceStructured；缺失时整块隐藏）。
  function EvidenceStructFold(props) {
    var ev = props.data && typeof props.data === 'object' ? props.data : null
    if (!ev) return null
    var files = Array.isArray(ev.files) ? ev.files : []
    var tests = Array.isArray(ev.tests) ? ev.tests : []
    var asks = Array.isArray(ev.userAsks) ? ev.userAsks : []
    var tools = ev.toolCalls && typeof ev.toolCalls === 'object' ? ev.toolCalls : null
    var callText = '（无）'
    if (tools) {
      var source = tools.byName && typeof tools.byName === 'object' ? tools.byName : tools
      var names = Object.keys(source)
      callText = names.length
        ? names.map(function (k) { return k + '×' + num(source[k], '?') }).join(' · ')
        : '（无）'
    }
    var shown = files.slice(0, 12)
    return React.createElement(
      Fold,
      { kicker: '机采', title: '证据明细', count: files.length + ' 文件 · ' + tests.length + ' 测试 · ' + asks.length + ' 原话' },
      React.createElement(Row, {
        label: '窗口',
        value: safeStr(ev.openedAt ? shortTime(ev.openedAt) : '', '—') + ' → ' + safeStr(ev.lastTurnEnd || ev.capturedAt ? shortTime(ev.lastTurnEnd || ev.capturedAt) : '', '—'),
      }),
      React.createElement(Row, { label: '工具调用', value: callText }),
      React.createElement(
        'div',
        { style: { padding: '6px 0' } },
        React.createElement('h4', { style: styles.kicker }, '文件（' + files.length + '）'),
        shown.length
          ? React.createElement(
              'ul',
              { style: { margin: '2px 0 6px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' } },
              shown.map(function (item, index) {
                var name = typeof item === 'string' ? item : safeStr(item && (item.path || item.file || item.name), '（未命名文件）')
                return React.createElement('li', { key: 'ef-' + index, style: { fontSize: '11.5px', color: T.text, wordBreak: 'break-all' } }, name)
              }),
            )
          : React.createElement('p', { style: styles.empty }, '（空）'),
        files.length > shown.length ? React.createElement('p', { style: styles.metaLine }, '等 ' + (files.length - shown.length) + ' 个未列出，原文见分析记录') : null,
        React.createElement('h4', { style: styles.kicker }, '测试（' + tests.length + '）'),
        tests.length
          ? React.createElement(
              'ul',
              { style: { margin: '2px 0 6px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' } },
              tests.map(function (t, index) {
                var line = typeof t === 'string' ? t : safeStr(t.cmd || t.name, '测试') + ' · ' + safeStr(t.status || t.result, '结果未记录')
                return React.createElement('li', { key: 'et-' + index, style: { fontSize: '11.5px', color: T.text } }, line)
              }),
            )
          : React.createElement('p', { style: styles.empty }, '（空）'),
        React.createElement('h4', { style: styles.kicker }, '用户原话（' + asks.length + '）'),
        asks.length
          ? React.createElement(
              'ol',
              { style: { margin: '2px 0 6px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' } },
              asks.map(function (a, index) {
                return React.createElement('li', { key: 'ea-' + index, style: { fontSize: '11.5px', color: T.text } }, String(a))
              }),
            )
          : React.createElement('p', { style: styles.empty }, '（空）'),
        React.createElement(CopyText, { text: JSON.stringify(ev, null, 2), label: '复制证据原文' }),
      ),
    )
  }

  // G4：本轮链路（review.trail 懒加载：点开才拉，与 transcript 同模式，不进 12s 轮询）。
  function TrailView(props) {
    var st = React.useState({ open: false, loading: false, trail: null })
    var s = st[0]
    var setS = st[1]
    function toggle() {
      if (s.trail) {
        setS(Object.assign({}, s, { open: !s.open }))
        return
      }
      if (s.loading) return
      setS({ open: true, loading: true, trail: null })
      props.rpc('review.trail', { reviewId: props.reviewId })
        .then(function (result) {
          var v = result && result.ok ? result.value : null
          setS({ open: true, loading: false, trail: v && Array.isArray(v.trail) ? v.trail : [] })
        })
        .catch(function () {
          setS({ open: true, loading: false, trail: [] })
        })
    }
    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      React.createElement(
        'button',
        { type: 'button', onClick: toggle, style: Object.assign({}, styles.button, { padding: '2px 9px', fontSize: '11px', alignSelf: 'flex-start' }) },
        (s.open ? '收起' : '展开') + '本轮链路' + (s.trail ? '（' + s.trail.length + '）' : ''),
      ),
      !s.open
        ? null
        : s.loading
          ? React.createElement('p', { style: styles.empty }, '正在读取链路…')
          : !s.trail || !s.trail.length
            ? React.createElement('p', { style: styles.empty }, '本轮暂无链路事件（早期版本审查可能未留痕）。')
            : React.createElement(
                'ul',
                { style: { margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', listStyle: 'none' } },
                s.trail.map(function (entry, index) {
                  return React.createElement(
                    'li',
                    { key: 'tr-' + index, style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '11.5px' } },
                    React.createElement('span', { style: styles.mono }, '#' + num(entry.seq)),
                    React.createElement('span', { style: { color: T.text } }, safeStr(entry.type)),
                    React.createElement('span', { style: styles.mono }, entry.ts ? shortTime(entry.ts) : '—'),
                  )
                }),
              ),
    )
  }

  // G2：确认按钮（调既有 notice.ack，成功后刷新 session.state）。
  function AckButton(props) {
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    function ack() {
      if (busy) return
      setBusy(true)
      props.rpc('notice.ack', {})
        .then(function () {
          setBusy(false)
          if (props.onDone) props.onDone()
        })
        .catch(function () {
          setBusy(false)
        })
    }
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: ack,
        disabled: busy,
        title: '确认已知悉这条提醒',
        style: Object.assign({}, styles.button, { cursor: busy ? 'progress' : 'pointer' }),
      },
      busy ? '确认中…' : '确认已知悉',
    )
  }

  function Section(props) {
    return React.createElement(
      'section',
      { style: styles.section },
      React.createElement(
        'div',
        { style: styles.sectionHead },
        React.createElement('h3', { style: styles.sectionTitle }, props.title),
        props.hint ? React.createElement('p', { style: styles.hint }, props.hint) : null,
      ),
      props.children,
    )
  }

  function Switch(props) {
    var on = Boolean(props.checked)
    return React.createElement(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: props.onToggle,
        style: {
          position: 'relative',
          width: '34px',
          height: '19px',
          borderRadius: '999px',
          border: '1px solid ' + (on ? T.brand : T.borderStrong),
          background: on ? T.brand : T.nested,
          cursor: props.disabled ? 'not-allowed' : 'pointer',
          transition: 'background 180ms ease, border-color 180ms ease',
          flex: '0 0 auto',
          padding: 0,
        },
      },
      React.createElement('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '17px' : '2px',
          width: '13px',
          height: '13px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 180ms ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
        },
      }),
    )
  }

  function Segmented(props) {
    var options = props.options || []
    return React.createElement(
      'div',
      { style: styles.segmented, role: 'group', 'aria-label': props.label },
      options.map(function (option) {
        var on = option.value === props.value
        return React.createElement(
          'button',
          {
            key: option.value,
            type: 'button',
            onClick: function () {
              props.onChange(option.value)
            },
            style: on ? Object.assign({}, styles.segment, styles.segmentOn) : styles.segment,
            'aria-pressed': on ? 'true' : 'false',
          },
          option.label,
        )
      }),
    )
  }

  // 天眼 mark — hand-drawn, never an emoji.
  function Seal(props) {
    var size = props.size || 34
    // mono: sidebar icon. Rings go quiet grey (theme secondary label);
    // the eye stays a dark emblem in every theme: dark almond disc, fixed
    // near-white iris with a dark pupil — never flips with the theme.
    var ink = props.mono ? T.text : T.brand
    var ring = props.mono ? T.dim : T.brand
    var almondFill = props.mono ? '#0f1330' : 'none'
    var irisFill = props.mono ? '#e9edf5' : ink
    var pupilFill = props.mono ? '#0f1330' : T.surface
    return React.createElement(
      'svg',
      { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true', style: { display: 'block' } },
      React.createElement('circle', { cx: 32, cy: 32, r: 27, fill: 'none', stroke: ring, strokeWidth: 1.6, opacity: 0.5 }),
      React.createElement('circle', { cx: 32, cy: 32, r: 22, fill: 'none', stroke: ring, strokeWidth: 0.8, opacity: 0.28 }),
      React.createElement('path', {
        d: 'M13 32 Q32 15 51 32 Q32 49 13 32 Z',
        fill: almondFill,
        stroke: ink,
        strokeWidth: 1.8,
        strokeLinejoin: 'round',
      }),
      React.createElement('circle', { cx: 32, cy: 32, r: 6.5, fill: irisFill, opacity: 0.9 }),
      React.createElement('circle', { cx: 32, cy: 32, r: 2.4, fill: pupilFill }),
    )
  }

  function usePoll(rpc, endpoint, payload, intervalMs) {
    var state = React.useState({ data: null, error: null, loading: true, at: 0 })
    var value = state[0]
    var setValue = state[1]
    var bumpState = React.useState(0)
    var bump = bumpState[1]
    var payloadKey = JSON.stringify(payload || null)
    React.useEffect(
      function () {
        var cancelled = false
        var timer = null
        var latest = null
        function load() {
          rpc(endpoint, payload)
            .then(function (result) {
              if (cancelled) return
              if (result && result.ok) {
                latest = result.value || null
                setValue({ data: latest, error: null, loading: false, at: Date.now() })
              } else {
                setValue({
                  data: latest,
                  error: (result && result.error && result.error.message) || '未知错误',
                  loading: false,
                  at: Date.now(),
                })
              }
            })
            .catch(function (err) {
              if (cancelled) return
              setValue({ data: latest, error: String((err && err.message) || err), loading: false, at: Date.now() })
            })
        }
        load()
        if (intervalMs > 0) timer = setInterval(load, intervalMs)
        return function () {
          cancelled = true
          if (timer) clearInterval(timer)
        }
      },
      [endpoint, payloadKey, bump],
    )
    return [
      value,
      function refresh() {
        bump(function (n) {
          return n + 1
        })
      },
    ]
  }

  function sessionIdOf(props) {
    if (typeof props.sessionId === 'string' && props.sessionId) return props.sessionId
    if (props.session && typeof props.session.id === 'string') return props.session.id
    if (typeof props.id === 'string' && props.id) return props.id
    return ''
  }

  // -------------------------------------------------------------------------
  // Surface 1 — the whole plugin: cross-project rollup + settings.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Overview surface — instrument-bench layout.
  // Read order is urgency-first: state strip, alert, metric rail, then grouped
  // readouts (verdicts + thresholds, reviews, baselines) and one consolidated
  // policy/config form. Hairline rules plus a monospace readout voice replace
  // the stacked-card look. Local style table + local primitives only: the
  // shared `styles` object is used by the other surfaces and is never touched.
  // -------------------------------------------------------------------------

  var PANEL_UI = {
    page: {
      width: '100%',
      maxWidth: '560px',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '14px 14px 26px',
      color: T.text,
      fontSize: '13px',
      lineHeight: 1.5,
      overflowY: 'auto',
      height: '100%',
      boxSizing: 'border-box',
    },
    top: { display: 'flex', flexDirection: 'column', gap: '3px', paddingBottom: '8px', borderBottom: '1px solid ' + T.border },
    head: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 },
    title: { margin: 0, fontSize: '15px', fontWeight: 600 },
    kicker: { fontSize: '11px', color: T.dim, whiteSpace: 'nowrap' },
    headSpacer: { flex: '1 1 auto' },
    state: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' },
    stateText: { fontSize: '11.5px', color: T.dim, whiteSpace: 'nowrap' },
    meta: { margin: 0, fontSize: '11.5px', color: T.dim, wordBreak: 'break-word' },
    badLine: { margin: 0, fontSize: '12px', color: T.bad, wordBreak: 'break-word' },
    alert: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '9px',
      padding: '11px 13px',
      background: T.surface,
      border: '1px solid ' + T.border,
      borderLeft: '2px solid ' + T.bad,
      borderRadius: '10px',
    },
    alertBody: { flex: '1 1 auto', minWidth: 0 },
    alertText: {
      margin: 0,
      fontSize: '12.5px',
      color: T.text,
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      wordBreak: 'break-word',
    },
    alertMeta: { margin: '2px 0 0', fontSize: '11.5px', color: T.dim },
    btn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 7px',
      borderRadius: '7px',
      border: '1px solid ' + T.borderStrong,
      background: T.base,
      color: T.text,
      fontSize: '12px',
      lineHeight: '15px',
      cursor: 'pointer',
      flex: '0 0 auto',
    },
    rail: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      overflow: 'hidden',
      background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px',
    },
    railCell: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '7px 8px 6px', minWidth: 0 },
    railDivider: { borderLeft: '1px solid ' + T.border },
    railValue: {
      fontSize: '20px',
      fontWeight: 600,
      lineHeight: '1.05',
      fontVariantNumeric: 'tabular-nums',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    railLabel: { fontSize: '11px', color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    pane: {
      display: 'flex',
      flexDirection: 'column',
      gap: '9px',
      padding: '12px 14px',
      background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px',
    },
    paneHead: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
    paneTick: { width: '2px', height: '9px', borderRadius: '4px', background: T.borderStrong, flex: '0 0 auto' },
    paneTitle: { margin: 0, fontSize: '12px', fontWeight: 700, color: T.text, whiteSpace: 'nowrap' },
    paneHint: { fontSize: '11px', color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    paneMeta: {
      marginLeft: 'auto',
      fontSize: '11px',
      color: T.dim,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '50%',
    },
    dist: {
      display: 'flex',
      height: '8px',
      borderRadius: '6px',
      overflow: 'hidden',
      background: T.nested,
      border: '1px solid ' + T.border,
    },
    legend: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: '3px 6px' },
    legendItem: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: T.dim, minWidth: 0 },
    legendCount: { marginLeft: 'auto', color: T.text, fontVariantNumeric: 'tabular-nums' },
    meterGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: '4px 10px' },
    meterBlock: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
    meterHead: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 },
    meterLabel: { fontSize: '11.5px', color: T.dim, whiteSpace: 'nowrap' },
    meterValue: { marginLeft: 'auto', fontSize: '12px', color: T.text, fontVariantNumeric: 'tabular-nums' },
    meterTrack: { height: '3px', borderRadius: '6px', background: T.nested, border: '1px solid ' + T.border, overflow: 'hidden' },
    meterFill: { display: 'block', height: '100%', borderRadius: '4px', transition: 'width 260ms ease' },
    statusLine: { margin: 0, display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', fontSize: '11.5px', color: T.dim },
    table: { display: 'flex', flexDirection: 'column' },
    thead: { display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px 62px', gap: '6px', paddingBottom: '2px' },
    th: { fontSize: '11px', color: T.dim, whiteSpace: 'nowrap', textAlign: 'left' },
    recRow: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 0', borderTop: '1px solid ' + T.border },
    recRowFirst: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '5px 0 6px' },
    recRowBlock: { borderLeft: '2px solid ' + T.bad, paddingLeft: '7px' },
    recGrid: { display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px 62px', gap: '6px', alignItems: 'baseline' },
    recStage: { fontSize: '12px', color: T.text },
    recVerdict: { fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    recEngine: { fontSize: '11px', color: T.dim, textAlign: 'right', whiteSpace: 'nowrap' },
    recTime: { fontSize: '11px', color: T.dim, textAlign: 'right', whiteSpace: 'nowrap' },
    recMeta: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', fontSize: '11px', color: T.dim },
    recFlag: { fontSize: '10.5px', color: T.bad, border: '1px solid ' + T.bad, borderRadius: '6px', padding: '0 3px' },
    recSuggest: {
      margin: 0,
      fontSize: '12px',
      color: T.text,
      borderLeft: '2px solid ' + T.border,
      paddingLeft: '6px',
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      wordBreak: 'break-word',
    },
    baseRow: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '6px 0', borderTop: '1px solid ' + T.border },
    baseRowFirst: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '4px 0 6px' },
    baseHead: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 },
    baseName: {
      fontSize: '12px',
      fontWeight: 600,
      color: T.text,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    baseTime: { marginLeft: 'auto', fontSize: '11px', color: T.dim, whiteSpace: 'nowrap' },
    baseIntent: {
      margin: 0,
      fontSize: '12px',
      color: T.dim,
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      wordBreak: 'break-word',
    },
    baseCounts: { margin: 0, fontSize: '11px', color: T.dim },
    policy: { margin: 0, paddingLeft: '7px', borderLeft: '2px solid ' + T.brand, fontSize: '12px', fontWeight: 600, color: T.text, wordBreak: 'break-word' },
    chain: { display: 'flex', flexDirection: 'column', gap: '1px' },
    step: { display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', gap: '6px', alignItems: 'center' },
    stepTag: { fontSize: '11px', color: T.dim },
    stepValue: {
      fontSize: '12px',
      color: T.text,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      minWidth: 0,
    },
    stepSrc: { fontSize: '11px', color: T.dim, border: '1px solid ' + T.border, borderRadius: '6px', padding: '0 3px', whiteSpace: 'nowrap' },
    arrow: { display: 'flex', alignItems: 'center', gap: '5px', paddingLeft: '7px' },
    arrowLabel: { fontSize: '11px', color: T.dim },
    group: { display: 'flex', flexDirection: 'column', gap: '4px' },
    groupHead: { display: 'flex', alignItems: 'center', gap: '6px' },
    groupLabel: { fontSize: '11px', color: T.dim, whiteSpace: 'nowrap' },
    groupRule: { flex: '1 1 auto', height: '1px', background: T.border },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '5px 8px' },
    field: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
    fieldLabel: { fontSize: '11.5px', color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    fieldNote: { fontSize: '11.5px', color: T.dim, flex: '1 1 110px', minWidth: 0 },
    inlineField: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' },
    numInput: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '2px 6px',
      borderRadius: '7px',
      border: '1px solid ' + T.borderStrong,
      background: T.base,
      color: T.text,
      fontSize: '12px',
      lineHeight: '16px',
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
    },
    numInputOff: { background: T.nested, color: T.dim },
    textInput: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '2px 6px',
      borderRadius: '7px',
      border: '1px solid ' + T.borderStrong,
      background: T.base,
      color: T.text,
      fontSize: '12px',
      lineHeight: '16px',
    },
    controlRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
    controlTail: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
    numBox: { width: '56px', flex: '0 0 auto' },
    note: { margin: 0, fontSize: '11px', color: T.dim, lineHeight: 1.45 },
    warn: { margin: 0, fontSize: '11.5px', color: T.warn, lineHeight: 1.45 },
    echo: { margin: 0, fontSize: '12px', color: T.text },
    empty: { margin: 0, padding: '3px 0', fontSize: '12px', color: T.dim, lineHeight: 1.5 },
    ledgerLine: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', fontSize: '12px', color: T.text },
    ledgerTime: { marginLeft: 'auto', fontSize: '11px', color: T.dim },
    footer: { margin: 0, paddingTop: '6px', borderTop: '1px solid ' + T.border, fontSize: '11px', color: T.dim, lineHeight: 1.5 },
  }

  // Model landing helpers: the panel already receives resolved entries from the
  // host, so these only shape text. `settings←light` means "inherited".
  function svLanding(entry) {
    if (!entry) return ''
    var provider = String(entry.provider || '')
    var model = String(entry.model || '')
    if (provider && model && model.indexOf(provider) !== 0) return provider + ' / ' + model
    return model || provider
  }

  function svSource(source) {
    var key = String(source || '')
    if (key === 'settings') return '自选'
    if (key === 'session') return '跟随会话'
    if (key && key.indexOf('light') >= 0) return '跟随轻审'
    return key ? key : '继承'
  }

  function svDur(ms) {
    var value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) return ''
    if (value < 1000) return Math.round(value) + 'ms'
    return String(Math.round(value / 100) / 10) + 's'
  }

  function svNumInput(cfg) {
    var style = cfg.disabled ? Object.assign({}, PANEL_UI.numInput, PANEL_UI.numInputOff) : PANEL_UI.numInput
    return React.createElement('input', {
      type: 'number',
      min: cfg.min,
      max: cfg.max,
      step: cfg.step,
      value: cfg.value,
      disabled: cfg.disabled,
      'aria-label': cfg.label,
      style: style,
      onChange: cfg.onChange,
    })
  }

  function svTextInput(cfg) {
    return React.createElement('input', {
      type: 'text',
      defaultValue: cfg.value,
      placeholder: cfg.placeholder,
      'aria-label': cfg.label,
      style: PANEL_UI.textInput,
      onBlur: function (event) {
        cfg.onCommit(String(event.target.value || '').trim())
      },
    })
  }

  function SvPane(props) {
    return React.createElement(
      'section',
      { style: PANEL_UI.pane, 'aria-label': props.title },
      React.createElement(
        'header',
        { style: PANEL_UI.paneHead },
        React.createElement('span', { style: PANEL_UI.paneTick, 'aria-hidden': 'true' }),
        React.createElement('h3', { style: PANEL_UI.paneTitle }, props.title),
        props.hint ? React.createElement('span', { style: PANEL_UI.paneHint }, props.hint) : null,
        props.meta ? React.createElement('span', { style: PANEL_UI.paneMeta }, props.meta) : null,
      ),
      props.children,
    )
  }

  function SvRail(props) {
    var items = props.items || []
    return React.createElement(
      'div',
      { style: PANEL_UI.rail, role: 'group', 'aria-label': props.label },
      items.map(function (item, index) {
        var cell = index ? Object.assign({}, PANEL_UI.railCell, PANEL_UI.railDivider) : PANEL_UI.railCell
        var value = item.tone ? Object.assign({}, PANEL_UI.railValue, { color: item.tone }) : PANEL_UI.railValue
        return React.createElement(
          'div',
          { key: item.key || String(index), style: cell, title: item.hint },
          React.createElement('span', { style: value }, item.value),
          React.createElement('span', { style: PANEL_UI.railLabel }, item.label),
        )
      }),
    )
  }

  function SvMeter(props) {
    var pct = Number(props.pct)
    if (!Number.isFinite(pct)) pct = 0
    pct = Math.max(0, Math.min(100, Math.round(pct)))
    var hot = Boolean(props.hot)
    return React.createElement(
      'div',
      { style: PANEL_UI.meterBlock },
      React.createElement(
        'div',
        { style: PANEL_UI.meterHead },
        React.createElement('span', { style: PANEL_UI.meterLabel }, props.label),
        React.createElement('span', { style: hot ? Object.assign({}, PANEL_UI.meterValue, { color: T.bad }) : PANEL_UI.meterValue }, props.readout),
      ),
      React.createElement(
        'div',
        {
          style: PANEL_UI.meterTrack,
          role: 'progressbar',
          'aria-label': props.label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': pct,
        },
        React.createElement('span', { style: Object.assign({}, PANEL_UI.meterFill, { width: pct + '%', background: hot ? T.bad : T.brand }) }),
      ),
    )
  }

  function SvField(props) {
    return React.createElement(
      'div',
      { style: PANEL_UI.field },
      React.createElement('span', { style: PANEL_UI.fieldLabel }, props.label),
      props.children,
    )
  }

  function SvGroup(props) {
    return React.createElement(
      'div',
      { style: PANEL_UI.group },
      React.createElement(
        'div',
        { style: PANEL_UI.groupHead },
        React.createElement('span', { style: PANEL_UI.groupLabel }, props.title),
        React.createElement('span', { style: PANEL_UI.groupRule, 'aria-hidden': 'true' }),
      ),
      props.children,
    )
  }

  function SvStep(props) {
    var value = PANEL_UI.stepValue
    if (props.muted) value = Object.assign({}, value, { color: T.dim })
    if (props.warn) value = Object.assign({}, value, { color: T.bad })
    var src = props.warn ? Object.assign({}, PANEL_UI.stepSrc, { borderColor: T.bad, color: T.bad }) : PANEL_UI.stepSrc
    return React.createElement(
      'div',
      { style: PANEL_UI.step },
      React.createElement('span', { style: PANEL_UI.stepTag }, props.tag),
      React.createElement('span', { style: value, title: props.title || undefined }, props.value),
      React.createElement('span', { style: src }, props.src),
    )
  }

  function SvArrow(props) {
    return React.createElement(
      'div',
      { style: PANEL_UI.arrow },
      React.createElement(
        'svg',
        { width: 10, height: 12, viewBox: '0 0 10 12', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block', flex: '0 0 auto' } },
        React.createElement('path', { d: 'M5 0.5V8.6', stroke: T.borderStrong, strokeWidth: 1.2, strokeLinecap: 'round', fill: 'none' }),
        React.createElement('path', { d: 'M1.8 6.2L5 9.6l3.2-3.4', stroke: T.borderStrong, strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }),
      ),
      React.createElement('span', { style: PANEL_UI.arrowLabel }, props.label),
    )
  }

  function SvBtn(props) {
    return React.createElement(
      'button',
      { type: 'button', onClick: props.onClick, 'aria-label': props.ariaLabel || props.label, title: props.title || undefined, style: PANEL_UI.btn },
      props.label,
    )
  }

  function SvWarn(props) {
    return React.createElement('p', { style: PANEL_UI.warn }, props.text)
  }

  function SvEmpty(props) {
    return React.createElement('p', { style: PANEL_UI.empty }, props.text)
  }

  // One review row: a four-column readout line plus the inline advice and the
  // collapsed findings. Grid columns stay fixed so every row aligns.
  function SvReviewRow(props) {
    var review = props.review || {}
    var meta = verdictOf(review.verdict)
    var findings = Array.isArray(review.findings) ? review.findings : []
    var base = props.first ? PANEL_UI.recRowFirst : PANEL_UI.recRow
    if (review.blocking) base = Object.assign({}, base, PANEL_UI.recRowBlock)
    var duration = svDur(review.durationMs)
    var label =
      '第' +
      num(review.stageSeq) +
      '阶段 ' +
      meta.label +
      ' ' +
      (ENGINE_LABEL[review.engine] || '—') +
      ' ' +
      shortTime(review.createdAt)
    return React.createElement(
      'div',
      { style: base, role: 'listitem', 'aria-label': label },
      React.createElement(
        'div',
        { style: PANEL_UI.recGrid },
        React.createElement('span', { style: PANEL_UI.recStage }, '#' + num(review.stageSeq)),
        React.createElement('span', { style: Object.assign({}, PANEL_UI.recVerdict, { color: meta.color }) }, meta.label),
        React.createElement('span', { style: PANEL_UI.recEngine, title: review.upgradeReason ? String(review.upgradeReason) : undefined }, ENGINE_LABEL[review.engine] || '—'),
        React.createElement('span', { style: PANEL_UI.recTime }, shortTime(review.createdAt)),
      ),
      React.createElement(
        'div',
        { style: PANEL_UI.recMeta },
        React.createElement('span', null, shortWorkspace(review.workspaceId)),
        review.blocking ? React.createElement('span', { style: PANEL_UI.recFlag }, '阻塞') : null,
        duration ? React.createElement('span', null, '· ' + duration) : null,
        review.handover ? React.createElement('span', null, '· 交接') : null,
      ),
      review.suggestion ? React.createElement('p', { style: PANEL_UI.recSuggest }, '建议：' + String(review.suggestion).slice(0, 110)) : null,
      findings.length
        ? React.createElement(
            Fold,
            { kicker: '疑点', title: '第 ' + num(review.stageSeq) + ' 阶段', count: findings.length + ' 条' },
            React.createElement(FindingsList, { items: findings, limit: 6 }),
          )
        : null,
    )
  }

  function SupervisorPanel(props) {
    var rpc = props.rpc
    var polled = usePoll(rpc, 'overview', null, POLL_MS)
    var view = polled[0]
    var refresh = polled[1]
    var data = view.data
    var settings = (data && data.settings) || {}
    var verdicts = (data && data.verdicts) || { aligned: 0, minor: 0, drift: 0, critical: 0, pending: 0 }
    var fixed = {
      aligned: verdicts.aligned || 0,
      minor: verdicts.minor || 0,
      drift: verdicts.drift || 0,
      critical: verdicts.critical || 0,
      pending: verdicts.pending || 0,
    }
    var total = fixed.aligned + fixed.minor + fixed.drift + fixed.critical + fixed.pending
    var noticeState = React.useState('')
    var notice = noticeState[0]
    var setNotice = noticeState[1]
    var rowsState = React.useState({})
    var rows = rowsState[0]
    var setRows = rowsState[1]

    function save(patch) {
      setRows(Object.assign({}, rows, patch))
      rpc('settings.set', patch).then(function (result) {
        if (result && result.ok) {
          setNotice('已保存 · 下次审查按新值跑')
          refresh()
        } else {
          setNotice('未保存 · 已保留你的输入：' + String((result && result.error && result.error.message) || '保存失败'))
        }
        setTimeout(function () {
          setNotice('')
        }, 2400)
      })
    }

    function saveGuard(kind, patch) {
      try {
        if (kind === 'disable' && !window.confirm('确定关闭全项目审查？关闭后主动汇报、兜底与打断都不再运行，只保留台账记录。')) return
        if (kind === 'threshold' && !window.confirm('阈值越小越容易触发打断，确定修改？')) return
        if (kind === 'interrupt' && !window.confirm('开启后达到阈值将强制终止施工回合并提醒用户，确定开启？')) return
      } catch (err) {}
      save(patch)
    }

    function ack() {
      rpc('notice.ack', {}).then(function (result) {
        if (result && result.ok) {
          setNotice('已确认收到')
          refresh()
        } else {
          setNotice('未保存 · 提醒未清除：' + String((result && result.error && result.error.message) || '保存失败'))
        }
        setTimeout(function () {
          setNotice('')
        }, 2400)
      })
    }

    function setting(key, fallback) {
      return Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : settings[key] !== undefined ? settings[key] : fallback
    }

    var counters = (data && data.counters) || {}
    var notices = (data && data.pendingNotices) || counters.pendingNotices || []
    var pending = counters.pendingNotice || notices[0] || null
    var pendingCount = notices.length || (pending ? 1 : 0)
    var baselines = (data && data.baselines) || []
    var reviews = (data && data.reviews) || []
    var mr = (data && data.modelResolution) || {}
    var th = (data && data.thresholds) || {}
    var thCrit = th.critical || {}
    var thStreak = th.streak || {}
    var journal = (data && data.journal) || []
    var latestJ = journal[0] || null
    var live = Object.assign({}, settings, rows)

    var loading = !data && !view.error
    var tone = view.error ? T.bad : loading ? T.idle : T.ok
    var stateText = view.error ? '连接异常' : loading ? '同步中' : '已同步'
    var metaBits = ['数据 ' + shortTime(data && data.updatedAt)]
    if (data) metaBits.push(num(data.workspaceCount) + ' 工作区', num(data.sessionCount) + ' 会话')
    metaBits.push('每 ' + num(POLL_MS / 1000) + ' 秒轮询')

    var railItems = [
      { key: 'ws', label: '工作区', value: data ? num(data.workspaceCount) : '…', hint: '受监察的工作区数（= 基线数）' },
      { key: 'reviews', label: '审查', value: data ? num(counters.reviewCount) : '…', hint: '跨项目累计审查次数' },
      {
        key: 'critical',
        label: '严重',
        value: data ? num(counters.criticalCount) : '…',
        hint: '跨项目累计严重偏移次数',
        tone: Number(counters.criticalCount) > 0 ? T.bad : null,
      },
      {
        key: 'pending',
        label: '待办',
        value: data ? num(pendingCount) : '…',
        hint: '需要你确认的提醒数',
        tone: pendingCount > 0 ? T.bad : null,
      },
    ]

    var segments = [
      { key: 'aligned', count: fixed.aligned },
      { key: 'minor', count: fixed.minor },
      { key: 'drift', count: fixed.drift },
      { key: 'critical', count: fixed.critical },
      { key: 'pending', count: fixed.pending },
    ]
    var distLabel =
      '裁决分布：' +
      segments
        .map(function (seg) {
          return verdictOf(seg.key).label + ' ' + num(seg.count)
        })
        .join('，')

    var streakLimit = Number(thStreak.limit)
    var criticalLimit = Number(thCrit.limit)
    var streakHot = Number.isFinite(streakLimit) && streakLimit > 0 && Number(thStreak.maxStreak) >= streakLimit
    var criticalHot = Number.isFinite(criticalLimit) && criticalLimit > 0 && Number(thCrit.count) >= criticalLimit
    var atThreshold = streakHot || criticalHot
    var cooldownMin = Math.round(Number(th.cooldownMs || 0) / 60000)
    var interruptBits = ['打断 ' + (th.interruptEnabled ? '开' : '关'), '冷却 ' + num(cooldownMin) + ' 分', th.lastInterruptAt ? '上次 ' + shortTime(th.lastInterruptAt) : '未打断过']

    var engineValue = setting('engine', 'auto')
    var upgradeLabel = engineValue === 'light' ? '固定轻审 · 不升级' : setting('deepOnDrift', true) === false ? '偏移时不升级' : '偏移时升级'
    var lightLanding = svLanding(mr.light) || '跟随当前会话'
    var deepLanding = svLanding(mr.deep) || (mr.light ? '跟随轻审' : '跟随当前会话')
    var lightSrc = mr.light && mr.light.source ? svSource(mr.light.source) : '继承会话'
    var deepSrc = mr.deep && mr.deep.source ? svSource(mr.deep.source) : mr.light ? '继承轻审' : '继承会话'
    var lightTitle = mr.light
      ? [mr.light.provider, mr.light.model, mr.light.source].filter(Boolean).join(' · ')
      : '未落到具体模型 · 由会话模型兜底'
    var deepTitle = mr.deep
      ? [mr.deep.provider, mr.deep.model, mr.deep.source].filter(Boolean).join(' · ')
      : mr.light
        ? '未单列 · 跟随轻审'
        : '未落到具体模型 · 由会话模型兜底'

    var lightHalf = Boolean(setting('lightProvider', '') || setting('lightModel', '')) && !(setting('lightProvider', '') && setting('lightModel', ''))
    var deepHalf = Boolean(setting('deepProvider', '') || setting('deepModel', '')) && !(setting('deepProvider', '') && setting('deepModel', ''))
    var briefSmall = Number(setting('maxBriefChars', 6000)) < 4000
    var autoMin = Number(setting('autoReviewMinutes', 20))
    var autoText = autoMin > 0 ? '每 ' + num(autoMin) + ' 分钟无汇报且有改动时补审' : '已关闭（0 = 关闭兜底）'
    var enabledOn = setting('enabled', true) !== false
    var interruptOn = setting('interruptEnabled', false) === true
    var stale = Boolean(data && data.storage === 'unavailable')
    var reviewsShown = Math.min(reviews.length, 6)
    var baselinesShown = Math.min(baselines.length, 4)
    var latestHash = latestJ && typeof latestJ.hash === 'string' ? latestJ.hash.slice(0, 8) : '—'

    return React.createElement(
      'div',
      { style: PANEL_UI.page, 'data-supervisor-panel': PANEL_ID },

      // 1 — state strip: identity, freshness, and the one manual refresh.
      React.createElement(
        'div',
        { style: PANEL_UI.top },
        React.createElement(
          'header',
          { style: PANEL_UI.head },
          React.createElement(Seal, { size: 20, mono: true }),
          React.createElement('h1', { style: PANEL_UI.title }, '天监'),
          React.createElement('span', { style: PANEL_UI.kicker }, 'SUPERVISOR'),
          React.createElement('span', { style: PANEL_UI.headSpacer }),
          React.createElement(
            'span',
            { style: PANEL_UI.state },
            React.createElement(Dot, { color: tone, size: 6 }),
            React.createElement('span', { style: PANEL_UI.stateText }, stateText),
          ),
          React.createElement(SvBtn, { label: '刷新', ariaLabel: '立即刷新天监数据', title: '立即重新读取（平时每 12 秒自动刷新）', onClick: refresh }),
        ),
        React.createElement('p', { style: PANEL_UI.meta }, metaBits.join(' · ')),
        view.error ? React.createElement('p', { style: PANEL_UI.badLine }, '同步异常：' + String(view.error) + '（以下数字可能滞后）') : null,
        stale ? React.createElement('p', { style: PANEL_UI.warn }, '台账不可用 · 界面只读，写入会失败') : null,
      ),

      // 2 — alert zone: only when something waits for a human.
      pending
        ? React.createElement(
            'div',
            { style: PANEL_UI.alert, role: 'alert' },
            React.createElement(Dot, { color: T.bad, size: 7 }),
            React.createElement(
              'div',
              { style: PANEL_UI.alertBody },
              React.createElement('p', { style: PANEL_UI.alertText }, String(pending.message || '有待处理提醒需要你看一眼').slice(0, 140)),
              React.createElement(
                'p',
                { style: PANEL_UI.alertMeta },
                (pending.workspaceId ? shortWorkspace(pending.workspaceId) + ' · ' : '') +
                  (pendingCount > 1 ? pendingCount + ' 条待确认 · ' : '') +
                  shortTime(pending.at),
              ),
            ),
            React.createElement(SvBtn, { label: '确认', ariaLabel: '确认收到提醒', onClick: ack }),
          )
        : null,

      // 3 — metric rail: four numbers on one line, no cards.
      React.createElement(SvRail, { label: '总览指标', items: railItems }),

      // 4 — verdict distribution and threshold progress share one block.
      React.createElement(
        SvPane,
        { title: '裁决 · 阈值', hint: total ? '最近 20 条' : '', meta: total ? num(total) + ' 次' : '无记录' },
        total
          ? React.createElement(
              'div',
              { style: PANEL_UI.dist, role: 'img', 'aria-label': distLabel },
              segments.map(function (seg) {
                if (!seg.count) return null
                return React.createElement('span', {
                  key: seg.key,
                  style: { width: (seg.count / total) * 100 + '%', background: verdictOf(seg.key).color, transition: 'width 260ms ease' },
                  title: verdictOf(seg.key).label + ' ' + seg.count,
                })
              }),
            )
          : React.createElement(SvEmpty, { text: '还没有审查记录 · 分布从第一条报告开始统计' }),
        total
          ? React.createElement(
              'div',
              { style: PANEL_UI.legend },
              segments.map(function (seg) {
                return React.createElement(
                  'span',
                  { key: seg.key, style: PANEL_UI.legendItem },
                  React.createElement(Dot, { color: verdictOf(seg.key).color, size: 5 }),
                  React.createElement('span', null, verdictOf(seg.key).label),
                  React.createElement('span', { style: PANEL_UI.legendCount }, num(seg.count)),
                )
              }),
            )
          : null,
        React.createElement(
          'div',
          { style: PANEL_UI.meterGrid },
          React.createElement(SvMeter, {
            label: '连续偏移',
            readout: num(thStreak.maxStreak) + ' / ' + num(thStreak.limit),
            pct: pctOf(thStreak.maxStreak, thStreak.limit),
            hot: streakHot,
          }),
          React.createElement(SvMeter, {
            label: '严重累计',
            readout: num(thCrit.count) + ' / ' + num(thCrit.limit),
            pct: pctOf(thCrit.count, thCrit.limit),
            hot: criticalHot,
          }),
        ),
        React.createElement('p', { style: PANEL_UI.statusLine }, interruptBits.join(' · ')),
        atThreshold
          ? React.createElement('p', { style: interruptOn ? PANEL_UI.badLine : PANEL_UI.warn }, interruptOn ? '已达阈值 · 下一次准备步骤会被打断' : '已达阈值 · 打断未开启，只记分不拦人')
          : null,
      ),

      // 5 — recent reviews as a compact table.
      React.createElement(
        SvPane,
        { title: '最近审查', meta: reviews.length ? num(reviewsShown) + ' / ' + num(reviews.length) : '—' },
        !data
          ? React.createElement(SvEmpty, { text: '正在读取…' })
          : !reviews.length
            ? React.createElement(SvEmpty, { text: '还没有审查记录。施工代理每完成一个阶段调用 supervisor report，这里就会出现裁决。' })
            : React.createElement(
                'div',
                { style: PANEL_UI.table, role: 'list', 'aria-label': '最近审查' },
                React.createElement(
                  'div',
                  { style: PANEL_UI.thead, 'aria-hidden': 'true' },
                  React.createElement('span', { style: PANEL_UI.th }, '阶段'),
                  React.createElement('span', { style: PANEL_UI.th }, '裁决'),
                  React.createElement('span', { style: PANEL_UI.th }, '引擎'),
                  React.createElement('span', { style: PANEL_UI.th }, '时间'),
                ),
                reviews.slice(0, 6).map(function (review, index) {
                  return React.createElement(SvReviewRow, {
                    key: review.id || review.reviewId || 'review-' + index,
                    review: review,
                    first: index === 0,
                  })
                }),
              ),
      ),

      // 6 — baselines as a compact list, newest first.
      React.createElement(
        SvPane,
        { title: '基线', meta: num(baselines.length) + ' 个' },
        !data
          ? React.createElement(SvEmpty, { text: '正在读取…' })
          : !baselines.length
            ? React.createElement(SvEmpty, { text: '还没有基线。用户批准后调用 baseline_set 建立。' })
            : [
                baselines.slice(0, 4).map(function (baseline, index) {
                  return React.createElement(
                    'div',
                    { key: baseline.workspaceId || 'baseline-' + index, style: index ? PANEL_UI.baseRow : PANEL_UI.baseRowFirst },
                    React.createElement(
                      'div',
                      { style: PANEL_UI.baseHead },
                      React.createElement('span', { style: PANEL_UI.baseName }, shortWorkspace(baseline.workspaceId) + ' · r' + num(baseline.revision)),
                      React.createElement('span', { style: PANEL_UI.baseTime }, shortTime(baseline.updatedAt)),
                    ),
                    React.createElement('p', { style: PANEL_UI.baseIntent }, String(baseline.intent || '未填写意图')),
                    React.createElement(
                      'p',
                      { style: PANEL_UI.baseCounts },
                      '目标 ' + num(baseline.goals) + ' · 硬 ' + num(baseline.hard) + ' · 软 ' + num(baseline.soft) + ' · 方向 ' + num(baseline.directions),
                    ),
                  )
                }),
                baselines.length > 4
                  ? React.createElement(SvEmpty, { key: 'baseline-more', text: '另有 ' + num(baselines.length - 4) + ' 个 · 全文在会话 Tab 的「基线」' })
                  : null,
              ],
      ),

      // 7 — one consolidated policy + config form: chain readout on top,
      //     controls grouped underneath, two columns where fields are short.
      React.createElement(
        SvPane,
        { title: '政策 · 配置', hint: '写 supervisor_settings' },
        React.createElement('p', { style: PANEL_UI.policy }, policyOf(live)),
        notice
          ? React.createElement(
              'p',
              { style: /失败|未保存/.test(notice) ? Object.assign({}, PANEL_UI.echo, { color: T.bad }) : PANEL_UI.echo, role: 'status', 'aria-live': 'polite' },
              notice,
            )
          : null,
        React.createElement(
          'div',
          { style: PANEL_UI.chain },
          React.createElement(SvStep, { tag: '轻审', value: lightLanding, src: lightSrc, title: lightTitle }),
          React.createElement(SvArrow, { label: upgradeLabel }),
          React.createElement(SvStep, {
            tag: '深审',
            value: deepLanding,
            src: deepSrc,
            title: deepTitle,
            muted: engineValue === 'light',
          }),
        ),
        React.createElement(
          SvGroup,
          { title: '引擎' },
          React.createElement(
            'div',
            { style: PANEL_UI.controlRow },
            React.createElement(Segmented, {
              label: '审阅引擎',
              value: engineValue,
              options: [
                { value: 'auto', label: '自动' },
                { value: 'light', label: '轻审' },
                { value: 'deep', label: '深审' },
              ],
              onChange: function (value) {
                save({ engine: value })
              },
            }),
            React.createElement(
              'span',
              { style: PANEL_UI.controlTail },
              React.createElement('span', { style: PANEL_UI.fieldLabel }, '偏移升深审'),
              React.createElement(Switch, {
                label: '偏移时自动升级为深审',
                checked: setting('deepOnDrift', true) !== false,
                disabled: engineValue === 'light',
                onToggle: function () {
                  save({ deepOnDrift: setting('deepOnDrift', true) === false })
                },
              }),
            ),
          ),
          React.createElement('p', { style: PANEL_UI.note }, '自动 = 轻审先行；引擎固定轻审时升级开关不生效。'),
        ),
        React.createElement(
          SvGroup,
          { title: '模型' },
          React.createElement(
            'div',
            { style: PANEL_UI.grid2 },
            React.createElement(
              SvField,
              { label: '轻审服务商' },
              svTextInput({
                value: setting('lightProvider', ''),
                label: '轻审服务商',
                placeholder: '留空跟会话',
                onCommit: function (value) {
                  if (value !== String(setting('lightProvider', '') || '')) save({ lightProvider: value })
                },
              }),
            ),
            React.createElement(
              SvField,
              { label: '轻审模型' },
              svTextInput({
                value: setting('lightModel', ''),
                label: '轻审模型',
                placeholder: '留空跟会话',
                onCommit: function (value) {
                  if (value !== String(setting('lightModel', '') || '')) save({ lightModel: value })
                },
              }),
            ),
            React.createElement(
              SvField,
              { label: '深审服务商' },
              svTextInput({
                value: setting('deepProvider', ''),
                label: '深审服务商',
                placeholder: '留空跟轻审',
                onCommit: function (value) {
                  if (value !== String(setting('deepProvider', '') || '')) save({ deepProvider: value })
                },
              }),
            ),
            React.createElement(
              SvField,
              { label: '深审模型' },
              svTextInput({
                value: setting('deepModel', ''),
                label: '深审模型',
                placeholder: '留空跟轻审',
                onCommit: function (value) {
                  if (value !== String(setting('deepModel', '') || '')) save({ deepModel: value })
                },
              }),
            ),
          ),
          lightHalf ? React.createElement(SvWarn, { text: '轻审只填了一半 · 未成对时回退跟随会话' }) : null,
          deepHalf ? React.createElement(SvWarn, { text: '深审只填了一半 · 未成对时跟随轻审' }) : null,
        ),
        React.createElement(
          SvGroup,
          { title: '阈值 · 打断' },
          React.createElement(
            'div',
            { style: PANEL_UI.grid2 },
            React.createElement(
              SvField,
              { label: '连续偏移阈值（轮）' },
              svNumInput({
                value: num(setting('driftStreakLimit', 2)),
                min: 1,
                max: 20,
                label: '连续偏移阈值',
                disabled: !interruptOn,
                onChange: function (event) {
                  var value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1) saveGuard('threshold', { driftStreakLimit: value })
                },
              }),
            ),
            React.createElement(
              SvField,
              { label: '严重累计阈值（次）' },
              svNumInput({
                value: num(setting('criticalLimit', 3)),
                min: 1,
                max: 20,
                label: '严重偏移阈值',
                disabled: !interruptOn,
                onChange: function (event) {
                  var value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1) saveGuard('threshold', { criticalLimit: value })
                },
              }),
            ),
          ),
          React.createElement(
            'div',
            { style: PANEL_UI.controlRow },
            React.createElement(
              'span',
              { style: PANEL_UI.controlTail },
              React.createElement('span', { style: PANEL_UI.fieldLabel }, '强制打断'),
              React.createElement(Switch, {
                label: '达到阈值时强制打断施工',
                checked: interruptOn,
                onToggle: function () {
                  if (setting('interruptEnabled', false) !== true) saveGuard('interrupt', { interruptEnabled: true })
                  else save({ interruptEnabled: false })
                },
              }),
            ),
            React.createElement(
              'label',
              { style: PANEL_UI.inlineField },
              React.createElement('span', { style: PANEL_UI.fieldLabel }, '冷却（分）'),
              React.createElement(
                'span',
                { style: PANEL_UI.numBox },
                svNumInput({
                  value: num(Math.round(Number(setting('interruptCooldownMs', 1800000)) / 60000)),
                  min: 1,
                  max: 1440,
                  label: '打断冷却分钟数',
                  onChange: function (event) {
                    var value = Number(event.target.value)
                    if (Number.isFinite(value) && value >= 1 && value <= 1440) save({ interruptCooldownMs: value * 60000 })
                  },
                }),
              ),
            ),
          ),
          React.createElement('p', { style: PANEL_UI.note }, '阈值越小越容易触发；打断关闭时阈值暂不生效。'),
        ),
        React.createElement(
          SvGroup,
          { title: '单次限额' },
          React.createElement(
            'div',
            { style: PANEL_UI.grid2 },
            React.createElement(
              SvField,
              { label: '超时（秒）' },
              svNumInput({
                value: num(Math.round(Number(setting('timeoutMs', 90000)) / 1000)),
                min: 5,
                max: 600,
                label: '单次审查超时秒数',
                onChange: function (event) {
                  var value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 5 && value <= 600) save({ timeoutMs: value * 1000 })
                },
              }),
            ),
            React.createElement(
              SvField,
              { label: '送审材料（字）' },
              svNumInput({
                value: num(setting('maxBriefChars', 6000)),
                min: 1000,
                max: 20000,
                step: 500,
                label: '送审材料上限字数',
                onChange: function (event) {
                  var value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 1000) save({ maxBriefChars: value })
                },
              }),
            ),
          ),
          briefSmall ? React.createElement(SvWarn, { text: '低于 4000 字时深审仍按 4000 字取数，基线可能被截断' }) : null,
        ),
        React.createElement(
          SvGroup,
          { title: '定时兜底' },
          React.createElement(
            'div',
            { style: PANEL_UI.controlRow },
            React.createElement(
              'span',
              { style: PANEL_UI.numBox },
              svNumInput({
                value: num(setting('autoReviewMinutes', 20)),
                min: 0,
                max: 240,
                label: '定时兜底间隔分钟数，0 表示关闭',
                onChange: function (event) {
                  var value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 0 && value <= 240) save({ autoReviewMinutes: value })
                },
              }),
            ),
            React.createElement('span', { style: PANEL_UI.fieldNote }, autoText),
          ),
        ),
        React.createElement(
          SvGroup,
          { title: '总闸' },
          React.createElement(
            'div',
            { style: PANEL_UI.controlRow },
            React.createElement(
              'span',
              { style: PANEL_UI.controlTail },
              React.createElement('span', { style: PANEL_UI.fieldLabel }, '审阅开关'),
              React.createElement(Switch, {
                label: '审阅开关',
                checked: enabledOn,
                onToggle: function () {
                  if (setting('enabled', true) !== false) saveGuard('disable', { enabled: false })
                  else save({ enabled: true })
                },
              }),
            ),
            React.createElement('span', { style: PANEL_UI.fieldNote }, enabledOn ? '在跑 · 主动汇报与兜底正常' : '已停跑 · 只记台账'),
          ),
          React.createElement('p', { style: PANEL_UI.note }, '关掉后主动汇报、兜底与打断都不跑，只记台账。'),
          React.createElement(
            'div',
            { style: PANEL_UI.controlRow },
            React.createElement(
              'span',
              { style: PANEL_UI.controlTail },
              React.createElement('span', { style: PANEL_UI.fieldLabel }, '经验回流'),
              React.createElement(Switch, {
                label: '审查落库后写一条阶段教训到 kyzmem',
                checked: setting('kyzmemReflow', true) !== false,
                onToggle: function () {
                  save({ kyzmemReflow: setting('kyzmemReflow', true) === false })
                },
              }),
            ),
            React.createElement('span', { style: PANEL_UI.fieldNote }, setting('kyzmemReflow', true) === false ? '已停 · 不写 kyzmem' : '开 · kyzmem 不可用时自动跳过'),
          ),
          React.createElement('p', { style: PANEL_UI.note }, '只做经验召回、不碰基线；跳过与写入都会记一条台账。'),
        ),
      ),

      // 8 — ledger health: one line up front, the rows folded away.
      React.createElement(
        SvPane,
        { title: '台账', hint: '哈希链', meta: num(journal.length) + ' 行' },
        !journal.length
          ? React.createElement(SvEmpty, { text: '台账还是空的。' })
          : [
              React.createElement(
                'div',
                { key: 'ledger-head', style: PANEL_UI.ledgerLine },
                React.createElement(Dot, { color: T.ok, size: 6 }),
                React.createElement('span', null, '最新 #' + (latestJ ? num(latestJ.seq) : '—') + ' ' + String((latestJ && latestJ.type) || '—')),
                React.createElement('span', { style: PANEL_UI.ledgerTime }, latestHash + ' · ' + shortTime(latestJ && latestJ.ts)),
              ),
              React.createElement(
                Fold,
                { key: 'ledger-fold', kicker: '台账', title: '最近记录', count: Math.min(journal.length, 12) + ' 行' },
                journal.slice(0, 12).map(function (entry, index) {
                  return React.createElement(Row, {
                    key: entry.seq || 'journal-' + index,
                    last: index === Math.min(journal.length, 12) - 1,
                    label: '#' + num(entry.seq) + ' ' + String(entry.type || '—'),
                    value: (typeof entry.hash === 'string' ? entry.hash.slice(0, 8) : '—') + ' · ' + shortTime(entry.ts),
                  })
                }),
              ),
            ],
      ),

      React.createElement(
        'p',
        { style: PANEL_UI.footer },
        '天监只读会话、只写自己的台账。它不能改代码、不能改基线、不能改写你的消息；唯一的例外是你在上面打开的「强制打断」。',
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Surface 2 — composer-left pill: this session's state and its switch.
  // -------------------------------------------------------------------------
  function SessionPill(props) {
    var rpc = props.rpc
    var sessionId = sessionIdOf(props)
    var polled = usePoll(rpc, 'session.state', { sessionId: sessionId }, POLL_MS)
    var view = polled[0]
    var refresh = polled[1]
    var data = view.data
    var review = (data && data.review) || null
    var enabled = data ? data.enabled !== false : true
    // Without a session id there is nothing honest to show; stay quiet instead of
    // reporting another session's state.
    var live = Boolean(sessionId)
    var reviewing = Boolean(data && data.reviewing)
    var unread = Boolean(data && data.unread)
    var verdict = (review && review.verdict) || ''
    var blocking = Boolean(review && review.blocking)
    // Lamp contract: grey = off, green = watching, yellow = drifted, red = interrupted;
    // it breathes while 司天/观天 are reading, and goes back to green once the Tab was seen.
    var color = !live || !data || !enabled
      ? T.idle
      : reviewing
        ? T.brand
        : !unread
          ? T.ok
          : blocking || verdict === 'critical'
            ? T.bad
            : verdict === 'drift'
              ? T.warn
              : T.ok
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]

    var hintState = React.useState('')
    var hint = hintState[0]
    var setHint = hintState[1]

    // Hover-to-expand: while the pointer rests on an enabled pill, a second
    // label slides open next to「天监」— either the short status or, when the
    // auto-review tripwire is armed, a live countdown to the next auto pass.
    var hoverState = React.useState(false)
    var expanded = hoverState[0]
    var setExpanded = hoverState[1]
    var nowState = React.useState(0)
    var nowMs = nowState[0]
    var setNowMs = nowState[1]

    React.useEffect(function () {
      if (!expanded) return undefined
      setNowMs(Date.now())
      var timer = setInterval(function () {
        setNowMs(Date.now())
      }, 1000)
      return function () {
        clearInterval(timer)
      }
    }, [expanded])

    // A short line of feedback next to the pill, so a click is never silent.
    function flash(text) {
      setHint(text)
      setTimeout(function () {
        setHint('')
      }, 3600)
    }

    function switchOn() {
      if (busy) return
      if (!live) {
        flash('无法确定当前会话，请在对话里点击')
        return
      }
      if (data && enabled) {
        flash(reviewing ? '观天正在审阅本阶段…' : '天监正在监察本会话 · 详情见顶部「天监」标签页')
        refresh()
        return
      }
      setBusy(true)
      rpc('session.setEnabled', { sessionId: sessionId, enabled: true })
        .then(function (result) {
          if (result && result.ok) {
            flash('天监已在本会话启用')
            refresh()
          } else {
            flash('启用失败：' + String((result && result.error && result.error.message) || '宿主未响应'))
          }
          setTimeout(function () {
            setBusy(false)
          }, 140)
        })
        .catch(function (err) {
          flash('启用失败：' + String((err && err.message) || err))
          setBusy(false)
        })
    }

    // Countdown source, mirroring the host tripwire: the next auto pass fires
    // once both lastReviewAt and lastAutoReviewAt are older than
    // autoReviewMinutes and this session has unreviewed work. When any of
    // those is missing we fall back to the plain status word.
    var pillSettings = (data && data.settings) || {}
    var autoMin = Number(pillSettings.autoReviewMinutes) || 0
    var pillCounters = (data && data.counters) || null
    function pillStampMs(stamp) {
      var t = Date.parse(stamp)
      return isNaN(t) ? 0 : t
    }
    var lastQuietBase = pillCounters
      ? Math.max(pillStampMs(pillCounters.lastReviewAt), pillStampMs(pillCounters.lastAutoReviewAt))
      : 0
    var pillEvidence = (data && data.evidence) || null
    var pillWorked = Boolean(pillEvidence) && Number(pillEvidence.turns) > 0
      && (Number(pillEvidence.files) > 0 || Number(pillEvidence.touched) > 0)
    var pillHasBaseline = Boolean(data && data.baseline)
    var showCountdown = live && enabled && autoMin > 0 && pillWorked && pillHasBaseline && !reviewing
    var remainMs = showCountdown ? lastQuietBase + autoMin * 60000 - (nowMs || Date.now()) : 0
    function fmtRemain(ms) {
      var total = Math.max(0, Math.ceil(ms / 1000))
      var mins = Math.floor(total / 60)
      var secs = total % 60
      return mins + ' 分 ' + (secs < 10 ? '0' + secs : secs) + ' 秒'
    }
    var shortStatus = reviewing
      ? '审阅中…'
      : !unread
        ? '监察中'
        : blocking || verdict === 'critical'
          ? '严重偏移'
          : verdict === 'drift'
            ? '存在偏移'
            : '已对齐'
    var expandText = !live || !data
      ? ''
      : showCountdown
        ? remainMs > 0 ? '兜底审核 ' + fmtRemain(remainMs) : '兜底审核即将触发'
        : shortStatus

    var title = !live
      ? '天监：无法确定当前会话'
      : !data
        ? '天监：正在读取本会话状态'
        : !enabled
          ? '天监在这条会话里已停用，点击启用'
          : reviewing
            ? '观天正在审阅本阶段…'
            : !unread
              ? '天监正在监察本会话'
              : blocking || verdict === 'critical'
                ? '最近裁决：严重偏移 —— 打开「天监」标签页查看'
                : verdict === 'drift'
                  ? '最近裁决：存在偏移 —— 打开「天监」标签页查看'
                  : '最近裁决：已对齐 —— 打开「天监」标签页查看'

    // The feedback line floats over the composer instead of stretching this row:
    // this entry must never add more than one badge row of height, otherwise it
    // pushes the IG5 badge above it out of place.
    return React.createElement(
      'div',
      { style: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' } },
      hint
        ? React.createElement(
            'span',
            {
              role: 'status',
              style: {
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 4px)',
                zIndex: 5,
                fontSize: '11.5px',
                color: T.dim,
                whiteSpace: 'nowrap',
                background: T.overlay,
                border: '1px solid ' + T.border,
                borderRadius: '8px',
                padding: '4px 8px',
              },
            },
            hint,
          )
        : null,
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: switchOn,
          onMouseEnter: function () {
            if (live && data && enabled) setExpanded(true)
          },
          onMouseLeave: function () {
            setExpanded(false)
          },
          title: title,
          'aria-pressed': enabled ? 'true' : 'false',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-label': '天监',
          className: 'sv-badge',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '2px 10px',
            borderRadius: '9999px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05))',
            color: 'var(--dsw-alias-label-secondary, #94a3b8)',
            fontSize: '11px',
            lineHeight: '18px',
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: busy ? 'progress' : 'pointer',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          },
        },
        React.createElement(Dot, {
          color: color,
          size: 7,
          style: reviewing ? { animation: 'dsh-supervisor-breathe 1.15s ease-in-out infinite' } : null,
        }),
        '天监',
        live && data && enabled
          ? React.createElement(
              'span',
              {
                'aria-hidden': 'true',
                style: {
                  display: 'inline-block',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  verticalAlign: 'middle',
                  maxWidth: expanded ? '300px' : '0px',
                  opacity: expanded ? 1 : 0,
                  transition: 'max-width 280ms cubic-bezier(.32,.72,0,1), opacity 200ms ease',
                },
              },
              ' · ' + expandText,
            )
          : null,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Surface 3 — the 天监 Tab: what this session's supervisor has seen and ruled.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Tab · 监察台（editorial workbench）
  // 版式：报头（刊头 + 状态灯）/ 提醒带 / KPI 横带 / 双栏主体（左「裁决·核对」，右「动作·
  // 阈值·元信息」）/ 底部「阶段台账 · 审计链 · 分析记录」表。所有样式只在这里定义：
  // 共享 styles 与主题 token 不动，颜色一律走 T.*，字体只用系统可用字族。
  // -------------------------------------------------------------------------
  var TAB_VERDICT_ORDER = ['aligned', 'minor', 'drift', 'critical']
  var TAB_UI = {
    page: { padding: '16px 20px 30px', gap: '0px', fontSize: '13px' },
    masthead: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      paddingBottom: '9px',
      borderBottom: '2px solid ' + T.borderStrong,
    },
    mastRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    mark: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '30px',
      height: '30px',
      flex: '0 0 auto',
      border: '1px solid ' + T.borderStrong,
      borderRadius: '6px',
      background: T.surface,
    },
    mastText: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
    mastTitle: {
      margin: 0,
      fontSize: '17px',
      fontWeight: 600,
      lineHeight: '1.2',
      color: T.text,
    },
    mastIssue: {
      margin: 0,
      fontSize: '12px',
      fontVariantNumeric: 'tabular-nums',
      color: T.dim,
      wordBreak: 'break-word',
    },
    lights: { display: 'inline-flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginLeft: 'auto' },
    light: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      border: '1px solid ' + T.border,
      padding: '1px 7px 2px',
      fontSize: '11.5px',
      color: T.dim,
      whiteSpace: 'nowrap',
    },
    lightOn: { borderColor: T.ok, color: T.ok },
    lightWarn: { borderColor: T.warn, color: T.warn },
    lightBad: { borderColor: T.bad, color: T.bad },
    action: {
      border: '1px solid ' + T.borderStrong,
      background: T.surface,
      color: T.text,
      fontSize: '12.5px',
      fontWeight: 600,
      padding: '4px 11px 5px',
      borderRadius: '6px',
      transition: 'background 180ms ease, border-color 180ms ease, color 180ms ease',
    },
    actionHover: { background: T.nested, borderColor: T.text },
    errorStrip: {
      border: '1px solid ' + T.warn,
      background: T.surface,
      padding: '6px 10px',
      fontSize: '12.5px',
      color: T.text,
      marginTop: '10px',
    },
    banner: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      borderLeft: '2px solid ' + T.bad,
      borderTop: '1px solid ' + T.border,
      borderRight: '1px solid ' + T.border,
      borderBottom: '1px solid ' + T.border,
      background: T.surface,
      borderRadius: '10px',
      padding: '12px 14px',
      marginTop: '12px',
    },
    bannerHead: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      fontSize: '12px',
      fontWeight: 700,
      color: T.bad,
    },
    bannerBody: {
      margin: 0,
      fontSize: '13px',
      lineHeight: '1.6',
      color: T.text,
      wordBreak: 'break-word',
    },
    tape: {
      display: 'flex',
      flexWrap: 'wrap',
      marginTop: '12px',
      overflow: 'hidden',
      background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px',
    },
    tapeCell: {
      flex: '1 1 104px',
      minWidth: '92px',
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      padding: '10px 12px 11px',
      borderRight: '1px solid ' + T.border,
    },
    tapeLabel: {
      fontSize: '11.5px',
      fontWeight: 700,
      color: T.dim,
      whiteSpace: 'nowrap',
    },
    tapeValue: {
      fontSize: '21px',
      lineHeight: '1.1',
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      color: T.text,
    },
    tapeHint: {
      fontSize: '11.5px',
      lineHeight: '1.35',
      color: T.dim,
      wordBreak: 'break-word',
    },
    tapeNote: { margin: '8px 0 0', fontSize: '11.5px', lineHeight: '1.5', color: T.dim },
    grid: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      gap: '16px 20px',
      marginTop: '16px',
    },
    colMain: { flex: '1 1 460px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' },
    colRail: { flex: '0 1 292px', minWidth: '244px', display: 'flex', flexDirection: 'column', gap: '14px' },
    block: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: '9px', padding: '12px 14px', background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px' },
    blockHead: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      flexWrap: 'wrap',
      borderBottom: '1px solid ' + T.borderStrong,
      paddingBottom: '4px',
      marginBottom: '9px',
    },
    blockTitle: {
      margin: 0,
      fontSize: '13px',
      fontWeight: 700,
      color: T.text,
    },
    blockKicker: {
      fontSize: '11px',
      color: T.dim,
    },
    blockNote: {
      marginLeft: 'auto',
      fontSize: '11.5px',
      color: T.dim,
      fontVariantNumeric: 'tabular-nums',
      wordBreak: 'break-word',
    },
    band: {
      marginTop: '18px',
      paddingTop: '14px',
      borderTop: '2px solid ' + T.borderStrong,
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    },
    lead: { display: 'flex', flexDirection: 'column', gap: '9px' },
    leadTop: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
    verdictWord: {
      margin: 0,
      fontSize: '29px',
      lineHeight: '1.05',
      fontWeight: 600,
    },
    flags: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', minWidth: 0, flex: '1 1 180px' },
    flagBad: {
      border: '1px solid ' + T.bad,
      color: T.bad,
      padding: '1px 7px 2px',
      fontSize: '12px',
      fontWeight: 700,
      whiteSpace: 'nowrap',
    },
    flagWarn: {
      border: '1px solid ' + T.warn,
      color: T.warn,
      padding: '1px 7px 2px',
      fontSize: '12px',
      fontWeight: 700,
      whiteSpace: 'nowrap',
    },
    statusLine: { margin: 0, fontSize: '13px', lineHeight: '1.6', color: T.text },
    summary: {
      margin: 0,
      fontSize: '13px',
      lineHeight: '1.75',
      color: T.text,
      wordBreak: 'break-word',
    },
    subKicker: {
      margin: '0 0 4px',
      fontSize: '12px',
      fontWeight: 700,
      color: T.dim,
    },
    advice: {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      borderLeft: '2px solid ' + T.warn,
      padding: '1px 0 1px 10px',
    },
    adviceLabel: {
      fontSize: '11.5px',
      fontWeight: 700,
      color: T.warn,
    },
    adviceText: {
      margin: 0,
      fontSize: '13px',
      lineHeight: '1.75',
      color: T.text,
      wordBreak: 'break-word',
    },
    empty: { margin: 0, fontSize: '12.5px', lineHeight: '1.6', color: T.dim },
    excerpt: {
      margin: 0,
      fontSize: '12.5px',
      lineHeight: '1.65',
      color: T.dim,
      wordBreak: 'break-word',
    },
    table: {
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      padding: '12px 14px',
      background: T.surface, border: '1px solid ' + T.border, borderRadius: '10px',
    },
    trow: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      flexWrap: 'wrap',
      padding: '5px 0',
      borderBottom: '1px solid ' + T.border,
    },
    trowHead: { borderBottom: '1px solid ' + T.borderStrong, paddingBottom: '3px' },
    trowLast: { borderBottom: 'none' },
    th: {
      fontSize: '11px',
      fontWeight: 700,
      color: T.dim,
    },
    cStage: { flex: '0 0 52px', fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: T.text },
    cVerdict: { flex: '0 0 78px', fontSize: '12px', fontWeight: 600 },
    cEngine: { flex: '0 0 44px', fontSize: '12px', color: T.dim },
    cTime: { flex: '0 0 76px', fontSize: '12px', color: T.dim, fontVariantNumeric: 'tabular-nums' },
    cNote: { flex: '1 1 190px', minWidth: 0, fontSize: '12px', color: T.dim, lineHeight: '1.55', wordBreak: 'break-word' },
    checkLabel: { flex: '0 0 56px', fontSize: '12px', color: T.dim },
    checkCell: { flex: '1 1 84px', minWidth: 0, fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: T.text, wordBreak: 'break-word' },
    verdictBad: { color: T.bad, fontWeight: 600 },
    verdictOk: { color: T.ok, fontWeight: 600 },
    distBar: {
      display: 'flex',
      height: '11px',
      border: '1px solid ' + T.borderStrong,
      background: T.base,
      overflow: 'hidden',
    },
    distSeg: { display: 'block', height: '100%', minWidth: '3px' },
    distEmpty: {
      flex: '1 1 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '11.5px',
      color: T.dim,
    },
    distLegend: { display: 'flex', flexWrap: 'wrap', gap: '3px 11px', paddingTop: '7px' },
    legendItem: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      fontSize: '12px',
      fontVariantNumeric: 'tabular-nums',
      color: T.text,
    },
    legendSwatch: { display: 'inline-block', width: '7px', height: '7px', flex: '0 0 auto', border: '1px solid ' + T.border },
    legendZero: { color: T.dim },
    meterWrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
    metaList: { display: 'flex', flexDirection: 'column', gap: '5px' },
    metaItem: { display: 'flex', alignItems: 'baseline', gap: '8px', justifyContent: 'space-between' },
    metaLabel: {
      fontSize: '12px',
      color: T.dim,
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
    },
    metaValue: {
      fontSize: '12px',
      color: T.text,
      textAlign: 'right',
      minWidth: 0,
      wordBreak: 'break-word',
      fontVariantNumeric: 'tabular-nums',
    },
    metaStrong: { color: T.text, fontWeight: 600 },
    railNote: { margin: '7px 0 0', fontSize: '12px', lineHeight: '1.55', color: T.dim, wordBreak: 'break-word' },
    copyRow: { display: 'flex', gap: '7px', flexWrap: 'wrap', paddingTop: '2px' },
    footNote: {
      margin: '7px 0 0',
      fontSize: '11.5px',
      color: T.dim,
      wordBreak: 'break-word',
    },
    voiceList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '7px' },
    voiceItem: {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      paddingBottom: '6px',
      borderBottom: '1px solid ' + T.border,
    },
    voiceItemLast: { paddingBottom: 0, borderBottom: 'none' },
    voiceSeq: {
      flex: '0 0 auto',
      fontSize: '11px',
      fontWeight: 700,
      color: T.dim,
      fontVariantNumeric: 'tabular-nums',
    },
    voiceKind: { flex: '0 0 auto', fontSize: '11px', fontWeight: 600, color: T.brand },
    voiceText: {
      margin: 0,
      flex: '1 1 auto',
      minWidth: 0,
      fontSize: '12.5px',
      lineHeight: '1.55',
      color: T.text,
      wordBreak: 'break-word',
    },
    ledgerList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
    ledgerItem: { display: 'flex', alignItems: 'baseline', gap: '8px' },
    ledgerId: {
      flex: '0 0 auto',
      fontSize: '11px',
      color: T.dim,
      fontVariantNumeric: 'tabular-nums',
    },
    ledgerText: { margin: 0, flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', lineHeight: '1.5', color: T.text, wordBreak: 'break-word' },
    ledgerSrc: { flex: '0 0 auto', fontSize: '10.5px', color: T.dim },
  }

  function TabBlock(props) {
    return React.createElement(
      'section',
      { style: TAB_UI.block, role: 'region', 'aria-label': String(props.title || props.kicker || '分区') },
      React.createElement(
        'div',
        { style: TAB_UI.blockHead },
        React.createElement('h3', { style: TAB_UI.blockTitle }, String(props.title || '')),
        props.kicker ? React.createElement('span', { style: TAB_UI.blockKicker }, String(props.kicker)) : null,
        props.note ? React.createElement('span', { style: TAB_UI.blockNote }, String(props.note)) : null,
      ),
      props.children,
    )
  }

  function TabTapeCell(props) {
    return React.createElement(
      'div',
      { style: TAB_UI.tapeCell },
      React.createElement('span', { style: TAB_UI.tapeLabel }, String(props.label || '')),
      React.createElement(
        'span',
        { style: Object.assign({}, TAB_UI.tapeValue, props.tone ? { color: props.tone } : null) },
        String(props.value),
      ),
      props.hint ? React.createElement('span', { style: TAB_UI.tapeHint }, String(props.hint)) : null,
    )
  }

  function TabMetaItem(props) {
    return React.createElement(
      'div',
      { style: TAB_UI.metaItem },
      React.createElement('span', { style: TAB_UI.metaLabel }, String(props.label || '')),
      React.createElement(
        'span',
        { style: props.strong ? Object.assign({}, TAB_UI.metaValue, TAB_UI.metaStrong) : TAB_UI.metaValue },
        String(props.value),
      ),
    )
  }

  function TabActionButton(props) {
    var hoverState = React.useState(false)
    var hover = hoverState[0]
    var setHover = hoverState[1]
    var style = Object.assign(
      {},
      TAB_UI.action,
      hover && !props.disabled ? TAB_UI.actionHover : null,
      { cursor: props.disabled ? 'progress' : 'pointer' },
      props.style || null,
    )
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled || false,
        'aria-label': String(props.ariaLabel || props.label || ''),
        style: style,
        onMouseEnter: function () {
          setHover(true)
        },
        onMouseLeave: function () {
          setHover(false)
        },
        onFocus: function () {
          setHover(true)
        },
        onBlur: function () {
          setHover(false)
        },
      },
      String(props.label || ''),
    )
  }

  // 裁决分布：分段条 + 计数图例。用「条」而不是四张卡片，是因为它是同一类数据的占比。
  function TabDistBar(props) {
    var reviews = Array.isArray(props.reviews) ? props.reviews : []
    var counts = { aligned: 0, minor: 0, drift: 0, critical: 0 }
    var index
    var parts = []
    for (index = 0; index < reviews.length; index += 1) {
      var key = reviews[index] && reviews[index].verdict
      if (key && Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1
    }
    var total = counts.aligned + counts.minor + counts.drift + counts.critical
    for (index = 0; index < TAB_VERDICT_ORDER.length; index += 1) {
      var name = TAB_VERDICT_ORDER[index]
      var count = counts[name]
      if (!count) continue
      parts.push(
        React.createElement('span', {
          key: 'seg-' + name,
          style: Object.assign({}, TAB_UI.distSeg, { flex: count + ' 1 0', background: verdictOf(name).color }),
        }),
      )
      if (total > 1) parts.push('')
    }
    return React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        {
          style: TAB_UI.distBar,
          role: 'img',
          'aria-label':
            '本会话裁决分布：对齐 ' +
            counts.aligned +
            ' 条，轻微调整 ' +
            counts.minor +
            ' 条，存在偏移 ' +
            counts.drift +
            ' 条，严重偏移 ' +
            counts.critical +
            ' 条',
        },
        total > 0
          ? parts.filter(function (node) {
              return node
            })
          : React.createElement('span', { style: TAB_UI.distEmpty }, '暂无裁决样本'),
      ),
      React.createElement(
        'div',
        { style: TAB_UI.distLegend },
        TAB_VERDICT_ORDER.map(function (name, order) {
          var meta = verdictOf(name)
          var count = counts[name]
          return React.createElement(
            'span',
            {
              key: 'lg-' + name,
              style: count ? TAB_UI.legendItem : Object.assign({}, TAB_UI.legendItem, TAB_UI.legendZero),
            },
            React.createElement('span', { style: Object.assign({}, TAB_UI.legendSwatch, { background: count ? meta.color : 'transparent' }) }),
            String(meta.label),
            React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(count)),
          )
        }),
      ),
    )
  }

  // 用户原话：天监判断的第一权威。它是独立预算注入审查的，这里只做呈现，
  // 让用户能当场核对「天监到底看到了我说的哪几句」。
  function TabVoiceBlock(props) {
    var timeline = Array.isArray(props.timeline) ? props.timeline : []
    if (!timeline.length) {
      return React.createElement(
        TabBlock,
        { title: '用户原话', kicker: 'USER', note: '0 条' },
        React.createElement(
          'p',
          { style: TAB_UI.empty },
          '本会话还没采集到你的消息：采集器只从插件启用那一刻开始记录。',
        ),
      )
    }
    var shown = timeline.slice(-8)
    var rows = shown.map(function (entry, index) {
      var kind = safeStr(entry.kind, 'message')
      var label = kind === 'steer' ? '插话' : kind === 'answer' ? '回答' : kind === 'command' ? '命令' : '消息'
      return React.createElement(
        'li',
        {
          key: 'uv-' + (entry.seq || index),
          style: index === shown.length - 1 ? Object.assign({}, TAB_UI.voiceItem, TAB_UI.voiceItemLast) : TAB_UI.voiceItem,
        },
        React.createElement('span', { style: TAB_UI.voiceSeq }, 'U' + num(entry.seq)),
        React.createElement('span', { style: TAB_UI.voiceKind }, label),
        React.createElement('p', { style: TAB_UI.voiceText }, safeStr(entry.text, '') + (entry.truncated ? ' …' : '')),
      )
    })
    return React.createElement(
      TabBlock,
      {
        title: '用户原话',
        kicker: 'USER',
        note: timeline.length + ' 条 · 最近 8 条' + (timeline.length > 8 ? '（更早的已折叠）' : ''),
      },
      React.createElement('ul', { style: TAB_UI.voiceList }, rows),
      React.createElement(
        'p',
        { style: TAB_UI.footNote },
        '这些原话会作为「用户原话」段独立注入司天与观天，且优先级高于基线：你最新的话就是判据。',
      ),
    )
  }

  // 用户要求台账：跨阶段积累的「你到底要什么」，审查时按 active 注入。
  function TabLedgerBlock(props) {
    var ledger = Array.isArray(props.ledger) ? props.ledger : []
    if (!ledger.length) {
      return React.createElement(
        TabBlock,
        { title: '用户要求台账', kicker: 'REQ', note: '0 条' },
        React.createElement(
          'p',
          { style: TAB_UI.empty },
          '台账还空着：下次审查会把「用户原话」提炼进台账（自动写入，不需要你确认）。',
        ),
      )
    }
    var crossConfirmed = 0
    var rows = ledger.slice(0, 12).map(function (item, index) {
      if (num(item.evidenceCount) >= 2) crossConfirmed += 1
      return React.createElement(
        'li',
        { key: 'req-' + (item.id || index), style: TAB_UI.ledgerItem },
        React.createElement('span', { style: TAB_UI.ledgerId }, '#' + safeStr(item.id, '')),
        React.createElement('p', { style: TAB_UI.ledgerText }, safeStr(item.text, '')),
        React.createElement(
          'span',
          { style: TAB_UI.ledgerSrc },
          num(item.evidenceCount) >= 2 ? '交叉确认 ×' + num(item.evidenceCount) : '单源',
        ),
      )
    })
    return React.createElement(
      TabBlock,
      {
        title: '用户要求台账',
        kicker: 'REQ',
        note: ledger.length + ' 条有效 · ' + crossConfirmed + ' 条交叉确认',
      },
      React.createElement('ul', { style: TAB_UI.ledgerList }, rows),
      React.createElement(
        'p',
        { style: TAB_UI.footNote },
        '台账按项目跨会话累积；标记「单源」的条目只有一次证据，可靠性较低。',
      ),
    )
  }

  // 阶段台账：表格而不是一叠卡片 —— 同一形状的行才能被眼睛竖着扫。
  function TabReviewTable(props) {
    var reviews = Array.isArray(props.reviews) ? props.reviews : []
    if (!reviews.length) {
      return React.createElement('p', { style: TAB_UI.empty }, '还没有审查记录。')
    }
    var rows = reviews.slice(0, 6).map(function (item, index, list) {
      var itemMeta = verdictOf(item.verdict)
      var note = safeStr(
        item.suggestion || (Array.isArray(item.findings) && item.findings[0] ? item.findings[0].detail : ''),
        '',
      )
      return React.createElement(
        'div',
        {
          key: item.id || 'st-' + index,
          style: index === list.length - 1 ? Object.assign({}, TAB_UI.trow, TAB_UI.trowLast) : TAB_UI.trow,
          role: 'row',
        },
        React.createElement('span', { style: TAB_UI.cStage, role: 'cell' }, '第 ' + num(item.stageSeq) + ' 阶段'),
        React.createElement(
          'span',
          { style: Object.assign({}, TAB_UI.cVerdict, { color: itemMeta.color }), role: 'cell' },
          itemMeta.label,
        ),
        React.createElement('span', { style: TAB_UI.cEngine, role: 'cell' }, ENGINE_LABEL[item.engine] || '—'),
        React.createElement('span', { style: TAB_UI.cTime, role: 'cell' }, shortTime(item.createdAt)),
        note ? React.createElement('span', { style: TAB_UI.cNote, role: 'cell' }, note.length > 140 ? note.slice(0, 140) + '…' : note) : null,
      )
    })
    return React.createElement(
      'div',
      { style: TAB_UI.table, role: 'table', 'aria-label': '本会话阶段台账' },
      React.createElement(
        'div',
        { style: Object.assign({}, TAB_UI.trow, TAB_UI.trowHead), role: 'row' },
        React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 52px' }), role: 'columnheader' }, '阶段'),
        React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 78px' }), role: 'columnheader' }, '裁决'),
        React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 44px' }), role: 'columnheader' }, '引擎'),
        React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 76px' }), role: 'columnheader' }, '时间'),
        React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '1 1 190px' }), role: 'columnheader' }, '要点'),
      ),
      rows,
    )
  }

  function SupervisorTab(props) {
    var rpc = props.rpc
    var sessionId = sessionIdOf(props)
    var polled = usePoll(rpc, 'session.state', { sessionId: sessionId }, POLL_MS)
    var view = polled[0]
    var refresh = polled[1]
    var data = view.data
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]

    // Opening this Tab is what clears the lamp: the verdict has now been seen.
    var markId = (data && data.review && data.review.reviewId) || ''
    var markedState = React.useState('')
    var marked = markedState[0]
    var setMarked = markedState[1]
    React.useEffect(function () {
      if (!sessionId || !data || !data.unread || !markId || marked === markId) return
      setMarked(markId)
      rpc('session.viewed', { sessionId: sessionId })
        .then(function (result) {
          if (result && result.ok) refresh()
        })
        .catch(function () {})
    }, [sessionId, markId, marked])

    function toggle() {
      if (busy || !sessionId || !data) return
      setBusy(true)
      rpc('session.toggle', { sessionId: sessionId, enabled: data.enabled === false })
        .then(function (result) {
          if (result && result.ok) refresh()
          setTimeout(function () {
            setBusy(false)
          }, 140)
        })
        .catch(function () {
          setBusy(false)
        })
    }

    var review = (data && data.review) || null
    var meta = verdictOf(review && review.verdict)
    var verdictKey = review && review.verdict && VERDICT[review.verdict] ? review.verdict : 'pending'
    var baseline = (data && data.baseline) || null
    var sessionBaseline = (data && data.sessionBaseline) || null
    var reviewId = (review && review.reviewId) || ''
    var workspaceReviews = (data && Array.isArray(data.workspaceReviews)) ? data.workspaceReviews : []
    // 观天/司天 的分析过程：按 reviewId 拉一次，用户展开才看，省得每 12 秒搬一次大文本。
    var transcriptState = React.useState({ reviewId: '', loading: false, data: null })
    var transcript = transcriptState[0]
    var setTranscript = transcriptState[1]
    React.useEffect(function () {
      if (!reviewId || transcript.reviewId === reviewId) return
      setTranscript({ reviewId: reviewId, loading: true, data: null })
      rpc('review.transcript', { reviewId: reviewId })
        .then(function (result) {
          var payload = result && result.ok ? result.value : null
          setTranscript({ reviewId: reviewId, loading: false, data: payload ? payload.transcript : null })
        })
        .catch(function () {
          setTranscript({ reviewId: reviewId, loading: false, data: null })
        })
    }, [reviewId])
    var stage = (data && data.stage) || null
    var evidence = (data && data.evidence) || null
    var counters = (data && data.counters) || null
    var settings = (data && data.settings) || {}
    var pendingNotice = (data && data.pendingNotice) || null
    var noticeAck = (data && data.noticeAck) || null
    var journal = (data && Array.isArray(data.journal)) ? data.journal : []
    var reviews = (data && Array.isArray(data.reviews)) ? data.reviews : []
    var findings = review && Array.isArray(review.findings) ? review.findings : []
    var touched = stage && Array.isArray(stage.touched) ? stage.touched : []
    var ackAt = noticeAck && noticeAck.at ? String(noticeAck.at) : ''
    var needsAck = Boolean(pendingNotice) && !ackAt

    function limitOf(value, fallback) {
      var n = Number(value)
      return Number.isFinite(n) && n > 0 ? n : fallback
    }

    function clip(text, max) {
      var s = String(text == null ? '' : text)
      return s.length > max ? s.slice(0, max) + '…' : s
    }

    var criticalLimit = limitOf(settings.criticalLimit, 3)
    var streakLimit = limitOf(settings.driftStreakLimit, 2)
    var criticalCount = counters && Number.isFinite(Number(counters.criticalCount)) ? Number(counters.criticalCount) : 0
    var streakCount = counters && Number.isFinite(Number(counters.driftStreak)) ? Number(counters.driftStreak) : 0
    var machineFiles = evidence && Number.isFinite(Number(evidence.files)) ? Number(evidence.files) : null
    var matchedFiles = machineFiles === null || !stage ? null : touched.length === machineFiles
    var interrupting = settings.interruptEnabled === true
    var triggerLine = stage ? triggerText(stage.trigger) : ''
    var triggerNote = stage ? '第 ' + num(stage.stageSeq) + ' 阶段 · ' + (triggerLine === '未记录' ? '触发未记录' : triggerLine) : '尚无汇报'

    var statusCopy = {
      critical: '本阶段判定严重偏移：先处理纠偏指令，再谈下一步。',
      drift: '本阶段存在偏移：按纠偏指令修正后再继续。',
      minor: '本阶段基本对齐：按建议微调即可继续。',
      aligned: '本阶段对齐：可继续施工。',
      pending: '尚无结论：施工方汇报后这里会出现裁决。',
    }

    var header = React.createElement(
      'header',
      { style: TAB_UI.masthead },
      React.createElement(
        'div',
        { style: TAB_UI.mastRow },
        React.createElement('span', { style: TAB_UI.mark }, React.createElement(Seal, { size: 20 })),
        React.createElement(
          'div',
          { style: TAB_UI.mastText },
          React.createElement('h2', { style: TAB_UI.mastTitle }, '天监 · 本会话'),
          React.createElement(
            'p',
            { style: TAB_UI.mastIssue },
            data
              ? '第 ' +
                num(stage ? stage.stageSeq : null) +
                ' 阶段 · ' +
                (ENGINE_LABEL[review && review.engine] || '未派发') +
                ' · 派发 ' +
                shortTime(review && review.createdAt) +
                ' · 更新 ' +
                shortTime(data.updatedAt)
              : '正在读取本会话的监察状态…',
          ),
        ),
        React.createElement(
          'div',
          { style: TAB_UI.lights },
          data
            ? React.createElement(
                'span',
                { style: data.enabled === false ? TAB_UI.light : Object.assign({}, TAB_UI.light, TAB_UI.lightOn) },
                React.createElement(Dot, { color: data.enabled === false ? T.idle : T.ok, size: 6 }),
                data.enabled === false ? '已停用' : '监察中',
              )
            : null,
          data && data.reviewing
            ? React.createElement(
                'span',
                { style: Object.assign({}, TAB_UI.light, TAB_UI.lightWarn) },
                React.createElement(Dot, { color: T.warn, size: 6 }),
                '正在审查',
              )
            : null,
          data && data.unread
            ? React.createElement(
                'span',
                { style: Object.assign({}, TAB_UI.light, TAB_UI.lightBad) },
                React.createElement(Dot, { color: T.bad, size: 6 }),
                '有未读结论',
              )
            : null,
          data
            ? React.createElement(TabActionButton, {
                label: data.enabled === false ? '启用天监' : '停用天监',
                ariaLabel: data.enabled === false ? '启用本会话天监' : '停用本会话天监',
                disabled: busy,
                onClick: toggle,
              })
            : null,
        ),
      ),
    )

    var errorStrip = view.error
      ? React.createElement(
          'div',
          { style: TAB_UI.errorStrip, role: 'status' },
          '宿主暂时没有回应：' + view.error + '（会自动重试）',
        )
      : null

    var banner = pendingNotice
      ? React.createElement(
          'div',
          { style: TAB_UI.banner, role: 'alert', 'aria-label': '待处理提醒' },
          React.createElement(
            'div',
            { style: TAB_UI.bannerHead },
            React.createElement(Dot, { color: T.bad, size: 8 }),
            '待处理提醒 · ' + verdictOf(pendingNotice.verdict).label,
            React.createElement(
              'span',
              { style: { marginLeft: 'auto', fontSize: '11.5px', color: T.dim } },
              shortTime(pendingNotice.at) + (ackAt ? ' · 已确认 ' + shortTime(ackAt) : ' · 待确认'),
            ),
          ),
          React.createElement('p', { style: TAB_UI.bannerBody }, safeStr(pendingNotice.message, '有阻塞级结论待处理')),
        )
      : null

    var tape = React.createElement(
      'div',
      { style: TAB_UI.tape, role: 'group', 'aria-label': '本会话关键指标' },
      React.createElement(TabTapeCell, {
        label: '阶段',
        value: stage ? '第 ' + num(stage.stageSeq) + ' 阶段' : '—',
        hint: stage ? triggerText(stage.trigger) : '尚无汇报',
      }),
      React.createElement(TabTapeCell, {
        label: '证据',
        value: evidence ? num(evidence.turns) + ' / ' + num(evidence.files) : '—',
        hint: '回合 / 文件' + (evidence && evidence.diffStat ? ' · +' + num(evidence.diffStat.added) + '/-' + num(evidence.diffStat.deleted) : ''),
      }),
      React.createElement(TabTapeCell, {
        label: '审查次数',
        value: counters ? num(counters.reviewCount) : '—',
        hint: counters ? '同项目累计 · 最近 ' + shortTime(counters.lastReviewAt) : '同项目累计',
      }),
      React.createElement(TabTapeCell, {
        label: '严重偏移',
        value: num(criticalCount) + ' / ' + num(criticalLimit),
        tone: criticalCount >= criticalLimit ? T.bad : T.text,
        hint: criticalCount >= criticalLimit ? '已达打断阈值 · 同项目累计' : '阈值 ' + num(criticalLimit) + ' 次 · 同项目累计',
      }),
      React.createElement(TabTapeCell, {
        label: '连续偏移',
        value: num(streakCount) + ' / ' + num(streakLimit),
        tone: streakCount >= streakLimit ? T.warn : T.text,
        hint: streakCount >= streakLimit ? '已达打断阈值 · 同项目累计' : '阈值 ' + num(streakLimit) + ' 轮 · 同项目累计',
      }),
      React.createElement(TabTapeCell, {
        label: '基线',
        value: baseline ? '第 ' + num(baseline.revision) + ' 版' : '未建立',
        hint: baseline
          ? (data && data.baselineScope === 'project+session' ? '项目 + 会话' : data && data.baselineScope === 'session' ? '仅会话' : '项目基线') +
            ' · ' +
            shortTime(baseline.updatedAt)
          : '尚未登记',
      }),
    )

    var lead = React.createElement(
      TabBlock,
      {
        title: '当前裁决',
        kicker: review ? 'VERDICT' : '',
        note: review ? (ENGINE_LABEL[review.engine] || '审阅') + ' · ' + shortTime(review.createdAt) : '待审',
      },
      !review
        ? React.createElement(
            'p',
            { style: TAB_UI.empty },
            '还没有裁决。施工代理在阶段边界调用 supervisor report 后，这里会出现结论与纠偏建议。',
          )
        : React.createElement(
            'div',
            { style: TAB_UI.lead },
            React.createElement(
              'div',
              { style: TAB_UI.leadTop },
              React.createElement('h4', { style: Object.assign({}, TAB_UI.verdictWord, { color: meta.color }) }, meta.label),
              React.createElement(
                'div',
                { style: TAB_UI.flags },
                review.blocking
                  ? React.createElement('span', { style: TAB_UI.flagBad }, '阻塞级 · 需先处理')
                  : React.createElement(
                      'span',
                      { style: Object.assign({}, TAB_UI.flagWarn, { borderColor: T.border, color: T.dim }) },
                      '未阻塞',
                    ),
                review.handover ? React.createElement('span', { style: TAB_UI.flagWarn }, '接棒 · 信息不全') : null,
              ),
            ),
            React.createElement(
              'p',
              { style: Object.assign({}, TAB_UI.statusLine, review.blocking ? { fontWeight: 600 } : null) },
              statusCopy[verdictKey] || statusCopy.pending,
            ),
            review.summary ? React.createElement('p', { style: TAB_UI.summary }, String(review.summary)) : null,
            findings.length
              ? React.createElement(
                  'div',
                  null,
                  React.createElement('p', { style: TAB_UI.subKicker }, '疑点 · ' + findings.length + ' 条'),
                  React.createElement(FindingsList, { items: findings, limit: 6 }),
                )
              : null,
            review.suggestion
              ? React.createElement(
                  'div',
                  { style: TAB_UI.advice },
                  React.createElement('span', { style: TAB_UI.adviceLabel }, '纠偏指令'),
                  React.createElement('p', { style: TAB_UI.adviceText }, String(review.suggestion)),
                )
              : null,
          ),
    )

    var checkRows = [
      {
        key: 'files',
        label: '文件',
        claim: String(touched.length) + ' 个',
        machine: machineFiles === null ? '未采集' : String(machineFiles) + ' 个',
        verdict: matchedFiles === null ? '—' : matchedFiles ? '一致' : '不一致',
        bad: matchedFiles === false,
      },
      {
        key: 'turns',
        label: '回合 / 步',
        claim: '—',
        machine: evidence ? num(evidence.turns) + ' / ' + num(evidence.steps) : '未采集',
        verdict: '—',
        bad: false,
      },
      {
        key: 'diff',
        label: '改动',
        claim: '—',
        machine: evidence && evidence.diffStat
          ? '+' + num(evidence.diffStat.added) + ' / -' + num(evidence.diffStat.deleted)
          : '未采集',
        verdict: '—',
        bad: false,
      },
    ]

    var trigger = React.createElement(
      TabBlock,
      {
        title: '触发与核对',
        kicker: 'EVIDENCE',
        note: triggerNote,
      },
      !stage
        ? React.createElement('p', { style: TAB_UI.empty }, '施工代理尚未提交阶段汇报，尚无触发输入。')
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
            React.createElement(
              'div',
              { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'baseline' } },
              React.createElement(
                'span',
                { style: { fontSize: '11.5px', color: T.dim } },
                '链路 · 阶段 ' + num(stage.stageSeq) + ' · 报告 ' + (shortIdTail(stage.reportId || stage.id) || '—') + ' · 审查 ' + (shortIdTail(stage.reviewId) || '—'),
              ),
              React.createElement(
                'span',
                {
                  style: {
                    fontSize: '11.5px',
                    fontWeight: 600,
                    color: matchedFiles === false ? T.warn : T.dim,
                  },
                },
                matchedFiles === null
                  ? '核对 · 机采缺失，无法比对'
                  : matchedFiles
                    ? '核对 · 自述与机采一致'
                    : '核对 · 自述与机采不一致，值得核对',
              ),
            ),
            React.createElement(
              'div',
              { style: TAB_UI.table, role: 'table', 'aria-label': '自述与机采对照' },
              React.createElement(
                'div',
                { style: Object.assign({}, TAB_UI.trow, TAB_UI.trowHead), role: 'row' },
                React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 56px' }), role: 'columnheader' }, '对照项'),
                React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '1 1 84px' }), role: 'columnheader' }, '施工方自述'),
                React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '1 1 84px' }), role: 'columnheader' }, '机器采集'),
                React.createElement('span', { style: Object.assign({}, TAB_UI.th, { flex: '0 0 52px' }), role: 'columnheader' }, '判定'),
              ),
              checkRows.map(function (row, index, list) {
                return React.createElement(
                  'div',
                  {
                    key: 'ck-' + row.key,
                    style: index === list.length - 1 ? Object.assign({}, TAB_UI.trow, TAB_UI.trowLast) : TAB_UI.trow,
                    role: 'row',
                  },
                  React.createElement('span', { style: TAB_UI.checkLabel, role: 'cell' }, row.label),
                  React.createElement('span', { style: TAB_UI.checkCell, role: 'cell' }, row.claim),
                  React.createElement('span', { style: TAB_UI.checkCell, role: 'cell' }, row.machine),
                  React.createElement(
                    'span',
                    { style: Object.assign({}, TAB_UI.checkCell, { flex: '0 0 52px' }, row.bad ? TAB_UI.verdictBad : null), role: 'cell' },
                    row.verdict,
                  ),
                )
              }),
            ),
            React.createElement(
              'p',
              { style: TAB_UI.excerpt },
              '自述摘录 · ' +
                (String(stage.claim || '').length > 80
                  ? String(stage.claim).slice(0, 80) + '…'
                  : safeStr(stage.claim, '（未填写说明）')),
            ),
            React.createElement(
              Fold,
              { kicker: '施工方', title: '自述全文', count: String(stage.claim || '').length + ' 字' },
              React.createElement(
                'p',
                { style: { margin: '6px 0', fontSize: '12px', lineHeight: '1.7', color: T.text, wordBreak: 'break-word' } },
                safeStr(stage.claim, '（未填写说明）'),
              ),
              touched.length
                ? React.createElement(
                    'ul',
                    { style: { margin: '2px 0 6px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' } },
                    touched.map(function (file, index) {
                      return React.createElement(
                        'li',
                        { key: 'tc-' + index, style: { fontSize: '11.5px', color: T.text, wordBreak: 'break-all' } },
                        String(file),
                      )
                    }),
                  )
                : React.createElement('p', { style: TAB_UI.empty }, '自述未列出文件'),
              React.createElement(CopyText, {
                text: String(stage.claim || '') + '\n自述涉及文件：' + (touched.length ? touched.join(', ') : ''),
                label: '复制自述',
              }),
            ),
            transcript.data && transcript.data.evidenceStructured
              ? React.createElement(EvidenceStructFold, { data: transcript.data.evidenceStructured })
              : null,
          ),
    )

    var railAck = React.createElement(
      TabBlock,
      { title: '确认动作', kicker: 'ACTION', note: needsAck ? '需要你确认' : ackAt ? '已确认' : '无待办' },
      React.createElement(
        'p',
        { style: Object.assign({}, TAB_UI.railNote, { margin: '0 0 8px' }) },
        pendingNotice
          ? needsAck
            ? '提醒 ' + shortTime(pendingNotice.at) + ' 发出 · 尚未确认。确认后审计链会记一笔。'
            : '已确认 · ' + shortTime(ackAt)
          : '当前没有待确认的提醒。',
      ),
      needsAck
        ? React.createElement(AckButton, {
            rpc: rpc,
            onDone: function () {
              refresh()
            },
          })
        : null,
      React.createElement(
        'p',
        { style: TAB_UI.railNote },
        data && data.unread ? '未读结论：有新结论没看过（打开本页即标记已读）。' : '未读结论：无。',
      ),
    )

    var railMeters = React.createElement(
      TabBlock,
      { title: '阈值仪表', kicker: 'THRESHOLD', note: interrupting ? '打断已开' : '打断关闭' },
      React.createElement(
        'div',
        { style: TAB_UI.meterWrap },
        React.createElement(Meter, { label: '严重偏移', value: criticalCount, limit: criticalLimit }),
        React.createElement(Meter, { label: '连续偏移', value: streakCount, limit: streakLimit }),
      ),
      React.createElement(
        'p',
        { style: TAB_UI.railNote },
        criticalCount >= criticalLimit || streakCount >= streakLimit
          ? '已达打断阈值：下一次审查前请先收口。'
          : '再 ' +
            num(Math.max(0, criticalLimit - criticalCount)) +
            ' 次严重偏移或再 ' +
            num(Math.max(0, streakLimit - streakCount)) +
            ' 轮偏移，触发强制打断。',
      ),
      React.createElement('p', { style: TAB_UI.railNote }, '分档：' + policyOf(settings)),
    )

    var railDist = React.createElement(
      TabBlock,
      { title: '裁决分布', kicker: 'DISTRIBUTION', note: reviews.length ? reviews.length + ' 条样本' : '' },
      React.createElement(TabDistBar, { reviews: reviews }),
    )

    var railMeta = React.createElement(
      TabBlock,
      { title: '派发', kicker: 'DISPATCH' },
      React.createElement(
        'div',
        { style: TAB_UI.metaList },
        React.createElement(TabMetaItem, {
          label: '模型',
          strong: true,
          value: review && review.model ? String(review.model) : '未记录',
        }),
        React.createElement(TabMetaItem, { label: '来源', value: modelSourceText(review && review.modelSource) }),
        React.createElement(TabMetaItem, { label: '派发', value: review ? upgradeText(review.upgradeReason) : '未记录' }),
        React.createElement(TabMetaItem, { label: '耗时', value: review ? fmtDur(review.durationMs) : '未记录' }),
        React.createElement(TabMetaItem, { label: '引擎', value: review ? (ENGINE_LABEL[review.engine] || '未记录') : '未记录' }),
      ),
      review && String(review.modelSource || '') === '' && review.model
        ? React.createElement('p', { style: TAB_UI.railNote }, '这条审查没有记录模型来源分档，按未记录处理。')
        : null,
    )

    var railBaseline = React.createElement(
      TabBlock,
      { title: '基线', kicker: 'BASELINE', note: baseline ? '第 ' + num(baseline.revision) + ' 版' : '未建立' },
      React.createElement(
        'div',
        { style: TAB_UI.metaList },
        React.createElement(TabMetaItem, {
          label: '项目',
          value: baseline ? '第 ' + num(baseline.revision) + ' 版 · ' + shortTime(baseline.updatedAt) : '尚未登记',
        }),
        React.createElement(TabMetaItem, {
          label: '条目',
          value: baseline
            ? '目标 ' + num(baseline.goals) + ' · 硬 ' + num(baseline.hard) + ' · 软 ' + num(baseline.soft) + ' · 方向 ' + num(baseline.directions)
            : '—',
        }),
        React.createElement(TabMetaItem, {
          label: '会话',
          value: sessionBaseline ? '第 ' + num(sessionBaseline.revision) + ' 版 · 只收紧本会话' : '未登记 · 沿用项目',
        }),
        sessionBaseline
          ? React.createElement(TabMetaItem, {
              label: '会话条目',
              value:
                '目标 ' +
                num(sessionBaseline.goals) +
                ' · 硬 ' +
                num(sessionBaseline.hard) +
                ' · 软 ' +
                num(sessionBaseline.soft) +
                ' · 方向 ' +
                num(sessionBaseline.directions),
            })
          : null,
      ),
      baseline && baseline.intent
        ? React.createElement('p', { style: TAB_UI.railNote }, '意图 · ' + clip(baseline.intent, 64))
        : null,
      sessionBaseline && sessionBaseline.intent
        ? React.createElement('p', { style: TAB_UI.railNote }, '会话意图 · ' + clip(sessionBaseline.intent, 64))
        : null,
      React.createElement(BaselineFullFold, {
        kicker: '项目',
        record: data && data.baselineFull ? data.baselineFull.project : null,
      }),
      sessionBaseline
        ? React.createElement(BaselineFullFold, {
            kicker: '会话',
            record: data && data.baselineFull ? data.baselineFull.session : null,
          })
        : React.createElement(
            'p',
            { style: TAB_UI.railNote },
            '本会话没有额外基线：它只会收紧项目基线。登记方式 supervisor baseline_set scope=session。',
          ),
    )

    var main = React.createElement(
      'div',
      { style: TAB_UI.grid },
      React.createElement(
        'div',
        { style: TAB_UI.colMain },
        lead,
        React.createElement(TabVoiceBlock, {
          timeline: data && Array.isArray(data.userTimeline) ? data.userTimeline : [],
        }),
        React.createElement(TabLedgerBlock, {
          ledger: data && Array.isArray(data.userLedger) ? data.userLedger : [],
        }),
        trigger,
      ),
      React.createElement('div', { style: TAB_UI.colRail }, railAck, railMeters, railDist, railMeta, railBaseline),
    )

    var history = React.createElement(
      TabBlock,
      { title: '阶段台账', kicker: 'LEDGER', note: reviews.length ? reviews.length + ' 条 · 时间倒序' : '' },
      React.createElement(TabReviewTable, { reviews: reviews }),
      workspaceReviews.length
        ? React.createElement(
            'p',
            { style: TAB_UI.footNote },
            '同项目其它会话另有 ' + workspaceReviews.length + ' 条审查 · 只做背景，不计入本页裁决与计数。',
          )
        : null,
    )

    var audit = React.createElement(
      TabBlock,
      { title: '审计链', kicker: 'AUDIT', note: journal.length ? journal.length + ' 个事件' : '无事件' },
      journal.length
        ? React.createElement(
            Fold,
            { kicker: '审计', title: '会话台账', count: journal.length + ' 事件' },
            React.createElement(
              'ul',
              { style: { margin: '6px 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', listStyle: 'none' } },
              journal.map(function (entry, index) {
                return React.createElement(
                  'li',
                  { key: 'jn-' + index, style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '11.5px' } },
                  React.createElement('span', { style: styles.mono }, '#' + num(entry.seq)),
                  React.createElement('span', { style: { color: T.text } }, safeStr(entry.type)),
                  React.createElement('span', { style: styles.mono }, entry.ts ? shortTime(entry.ts) : '—'),
                )
              }),
            ),
            reviewId ? React.createElement(TrailView, { rpc: rpc, reviewId: reviewId }) : null,
          )
        : React.createElement('p', { style: TAB_UI.empty }, '还没有审计事件。'),
    )

    var analysis = React.createElement(
      TabBlock,
      {
        title: '分析记录',
        kicker: 'TRANSCRIPT',
        note: !reviewId
          ? ''
          : transcript.loading
            ? '读取中…'
            : transcript.data
              ? (ENGINE_LABEL[transcript.data.engine] || transcript.data.engine || '审阅') +
                ' · ' +
                shortTime(transcript.data.createdAt) +
                (transcript.data.model ? ' · ' + String(transcript.data.model).split('/').pop() : '')
              : '司天简报 + 观天原文',
      },
      !reviewId
        ? React.createElement(
            'p',
            { style: TAB_UI.empty },
            '跑一次 report / review 之后，这里会留下司天交给观天的完整简报，以及观天每一段的原始输出。',
          )
        : transcript.loading
          ? React.createElement('p', { style: TAB_UI.empty }, '正在读取分析记录…')
          : !transcript.data
            ? React.createElement('p', { style: TAB_UI.empty }, '这一条审查没有留下分析记录（可能是早期版本生成的）。')
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                transcript.data.assembleNotes
                  ? React.createElement(
                      'p',
                      { style: { margin: 0, fontSize: '11px', lineHeight: '1.6', color: T.dim } },
                      '审阅方式：' + String(transcript.data.assembleNotes),
                    )
                  : null,
                transcript.data.assemble && typeof transcript.data.assemble === 'object'
                  ? React.createElement(
                      'p',
                      { style: styles.metaLine },
                      '基线第 ' +
                        num(transcript.data.assemble.baselineRevision, '—') +
                        ' 版 · 证据 ' +
                        num(transcript.data.assemble.evidenceFiles, '—') +
                        ' 文件 · 历史 ' +
                        num(transcript.data.assemble.historyCount, '—') +
                        ' 条 · 简报 ' +
                        num(transcript.data.assemble.briefChars, '—') +
                        '/' +
                        num(transcript.data.assemble.maxBriefChars, '—') +
                        ' 字' +
                        (transcript.data.assemble.evidenceTruncated ? ' · 证据已截断' : ''),
                    )
                  : null,
                transcript.data.baselineRevision
                  ? React.createElement(
                      'p',
                      { style: styles.metaLine },
                      '本次审查 pin 基线第 ' + num(transcript.data.baselineRevision) + ' 版',
                    )
                  : null,
                React.createElement(BriefBlock, { kicker: '司天', title: '简报', text: transcript.data.brief }),
                React.createElement(SuspicionsBlock, {
                  kicker: '观天',
                  title: '细读',
                  text: transcript.data.deepAnalysisRaw || transcript.data.lightRaw,
                }),
                transcript.data.deepVerifyRaw
                  ? React.createElement(VerdictBlock, { kicker: '观天', title: '核验', text: transcript.data.deepVerifyRaw })
                  : null,
                transcript.data.notes
                  ? React.createElement(NotesBlock, { kicker: '观天', title: '疑点清单', text: transcript.data.notes })
                  : null,
                React.createElement(
                  'div',
                  { style: TAB_UI.copyRow },
                  transcript.data.brief ? React.createElement(CopyText, { text: transcript.data.brief, label: '复制简报' }) : null,
                  transcript.data.deepAnalysisRaw || transcript.data.lightRaw
                    ? React.createElement(CopyText, {
                        text: transcript.data.deepAnalysisRaw || transcript.data.lightRaw,
                        label: '复制细读原文',
                      })
                    : null,
                  transcript.data.deepVerifyRaw
                    ? React.createElement(CopyText, { text: transcript.data.deepVerifyRaw, label: '复制核验原文' })
                    : null,
                ),
              ),
    )

    var band = React.createElement('div', { style: TAB_UI.band }, history, audit, analysis)

    var loading = !data
      ? React.createElement(
          'div',
          { style: { paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('p', { style: TAB_UI.empty }, '正在读取本会话的监察状态…'),
          React.createElement('p', { style: TAB_UI.empty }, '若一直停在这里，说明宿主没有回应；页面会自动重试。'),
        )
      : null

    return React.createElement(
      'div',
      {
        style: Object.assign({}, styles.page, TAB_UI.page),
        'data-supervisor-tab': VIEW_ID,
        role: 'region',
        'aria-label': '天监 · 本会话监察台',
      },
      header,
      loading,
      errorStrip,
      banner,
      tape,
      React.createElement(
        'p',
        { style: TAB_UI.tapeNote },
        '口径：审查次数、严重偏移、连续偏移按项目（工作区）累计，不是单会话计数；阶段与证据只属本会话。',
      ),
      data ? main : null,
      data ? band : null,
    )
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------
  // A render-time throw inside a slot entry is contained here instead of
  // taking the entry down: the supervisor must never be the reason the harness
  // looks broken.
  var Boundary = null
  try {
    if (React && React.Component) {
      Boundary = class SupervisorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error) {
          beacon('render-failed', String((error && error.message) || error))
        }
        render() {
          if (this.state.error) {
            return React.createElement(
              'div',
              { style: { padding: '10px 14px', color: T.dim, fontSize: '11.5px' } },
              '天监界面渲染出错：' + String((this.state.error && this.state.error.message) || this.state.error),
            )
          }
          return this.props.children
        }
      }
    }
  } catch (err) {
    Boundary = null
  }

  function guarded(node) {
    return Boundary ? React.createElement(Boundary, null, node) : node
  }

  function PanelEntry(props) {
    return guarded(React.createElement(SupervisorPanel, { rpc: props.rpc }))
  }

  function PillEntry(props) {
    return guarded(React.createElement(SessionPill, props))
  }

  // Dock row above the composer: centred, exactly as wide as the composer card.
  // Copies the host's own width recipe (the *_bar pattern: a centred bar whose
  // max-width is driven by --dsh-composer-card-max-width). No DOM measuring, no
  // hash class names, no resize listeners — the row follows the card at every
  // viewport width and never adds more than one badge row of height, so the
  // IG5 badge above it is not pushed around.
  function DockAlign(props) {
    return React.createElement(
      'div',
      {
        'data-supervisor-dock': '1',
        style: { display: 'flex', justifyContent: 'center', width: '100%', margin: '-30px 0 0', padding: 0 },
      },
      React.createElement(
        'div',
        {
          style: {
            width: '100%',
            maxWidth: 'var(--dsh-composer-card-max-width, 768px)',
            margin: '0 auto',
            padding: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            position: 'relative',
          },
        },
        props.children,
      ),
    )
  }

  function DockEntry(props) {
    return guarded(React.createElement(DockAlign, null, React.createElement(SessionPill, props)))
  }

  function TabEntry(props) {
    return guarded(React.createElement(SupervisorTab, props))
  }

  // -------------------------------------------------------------------------
  // Better Sidebar compatibility
  // -------------------------------------------------------------------------
  // `dsh-better-sidebar` publishes a client service as `ctx.betterSidebar`
  // whose registry takes tab descriptors from other plugins. Registering one
  // puts 天监's overview page next to the host's own sidebar tabs (file tree,
  // editor, changes…) so the page can be read without leaving the conversation.
  //
  // Optional by design: the service only exists when that plugin is installed
  // AND its client half has activated, which can happen after us, so we retry
  // a few times and never let a missing service fail the bundle. `ctx.get`
  // (not `ctx.betterSidebar`) is deliberate: an undeclared property access
  // throws in cordis, and `inject` on a client plugin we do not require would
  // block activation when the plugin is absent.
  var betterTabRender = null

  function mountBetterSidebar(ctx, rpc) {
    var off = null
    var tries = 0

    // dsh-better-sidebar keeps a tab *type* registered across our reloads, so a
    // second registerTab throws "already registered". Rendering through this
    // holder keeps the surviving tab bound to the current rpc instead of the
    // disposed closure from the previous instance.
    betterTabRender = function () {
      return guarded(React.createElement(SupervisorPanel, { rpc: rpc, inSidebar: true }))
    }

    function attempt() {
      if (off) return
      var svc = serviceOf(ctx, 'betterSidebar')
      if (!svc || typeof svc.registerTab !== 'function') {
        if (tries < 20) {
          tries += 1
          try {
            setTimeout(attempt, 500)
          } catch (err) {
            /* ignore */
          }
        }
        return
      }
      try {
        off = svc.registerTab({
          id: 'dsh-supervisor:overview',
          title: '天监',
          description: '需求监督：跨项目的裁决台账、阈值与政策配置',
          order: 51,
          single: true,
          icon: function (size) {
            return React.createElement(Seal, { size: size || 14, mono: true })
          },
          component: function (props) {
            // The sidebar gives the same package-private RPC; the page is
            // cross-project, so no session scope is threaded through.
            return betterTabRender ? betterTabRender(props) : null
          },
        })
        beacon('better-sidebar', 'registered')
      } catch (err) {
        var message = String((err && err.message) || err)
        if (message.indexOf('already registered') >= 0) {
          // Our own tab survived the reload: reuse it instead of failing.
          off = function () {}
          beacon('better-sidebar-reused', 'tab type kept from a previous load')
        } else {
          off = null
          beacon('better-sidebar-failed', message)
        }
      }
    }

    attempt()

    return function () {
      if (typeof off === 'function') {
        try {
          off()
        } catch (err) {
          /* ignore */
        }
      }
      off = null
    }
  }

  // ---------------------------------------------------------------------------
  // Standalone page (`main` slot) — 天监跨项目工作台 (rewritten v1.5.0).
  // Source: main-page-new.js (page-smith). Spliced by lead; do not hand-edit.
  // ---------------------------------------------------------------------------

// dsh-supervisor 独立页（main slot）——天监跨项目工作台。
// IIFE 作用域：plain var + function，React.createElement，无 JSX/imports/exports。
// 复用外层自由变量：React / T / guarded / beacon / usePoll / POLL_MS / CLIENT_BUILD /
// shortWorkspace / verdictOf / ENGINE_LABEL / policyOf / modelText / svDur /
// svLanding / svSource / num / shortTime / safeStr / fmtDur / Dot / Row / Fold /
// FindingsList / BriefBlock / SuspicionsBlock / VerdictBlock / NotesBlock /
// EvidenceStructFold / TrailView / CopyText / Meter / KindChip / RawPre / Seal。
// 本文件只定义以 Svm 开头的新标识，不重定义外层任何名字。

var SvmCss = ''
  + '.svm-root{--svm-accent:var(--dsw-alias-brand-primary,#3b5bdb);'
  + '--svm-on-accent:var(--dsw-alias-label-primary-foreground,#ffffff);'
  + '--svm-ink:var(--dsw-alias-label-primary,#1f2328);'
  + '--svm-dim:var(--dsw-alias-label-secondary,#6b7280);'
  + '--svm-faint:var(--dsw-alias-label-tertiary,#9aa3b2);'
  + '--svm-sheet:var(--dsw-alias-bg-base,#ffffff);'
  + '--svm-surface:var(--dsw-alias-bg-layer-1,#ffffff);'
  + '--svm-strong:var(--dsw-alias-bg-layer-2,#f6f7f9);'
  + '--svm-hair:var(--dsw-alias-border-l1,rgba(0,0,0,0.10));'
  + '--svm-hair2:var(--dsw-alias-border-l2,rgba(0,0,0,0.18));'
  + '--svm-ok:var(--dsw-alias-state-success-primary,#1f9d55);'
  + '--svm-warn:var(--dsw-alias-state-warn-primary,#b7791f);'
  + '--svm-bad:var(--dsw-alias-state-error-primary,#c53030);'
  + '--svm-shadow:0 1px 2px rgba(16,24,40,0.05),0 8px 28px rgba(16,24,40,0.08);'
  + '--svm-pop:0 12px 48px rgba(16,24,40,0.22);'
  + 'width:100%;height:100%;overflow-y:auto;overflow-x:hidden;'
  + 'padding:0 32px 44px;scroll-padding-top:96px;background:var(--svm-sheet);'
  + 'color:var(--svm-ink);font-size:13px;line-height:1.55;}'
  + '.svm-root::-webkit-scrollbar{width:8px;height:8px;}'
  + '.svm-root::-webkit-scrollbar-thumb{background:var(--svm-hair2);border-radius:8px;}'
  + '.svm-col{max-width:1160px;margin:0 auto;padding-top:16px;isolation:isolate;}'
  + '.svm-col>*{animation:svmIn 360ms cubic-bezier(.16,1,.3,1) both;}'
  + '.svm-col>*:nth-child(2){animation-delay:60ms;}'
  + '.svm-col>*:nth-child(3){animation-delay:120ms;}'
  + '.svm-col>*:nth-child(4){animation-delay:180ms;}'
  + '.svm-col>*:nth-child(5){animation-delay:240ms;}'
  + '.svm-col>*:nth-child(6){animation-delay:300ms;}'
  + '@keyframes svmIn{from{opacity:0;transform:translateY(6px);filter:blur(2px);}to{opacity:1;transform:none;filter:none;}}'
  + '.svm-stick{position:sticky;top:0;z-index:40;margin:0 -32px;padding:10px 32px 12px;'
  + 'background:var(--svm-sheet);border-bottom:1px solid var(--svm-hair);}'
  + '.svm-mast{display:flex;align-items:center;gap:12px;min-height:30px;flex-wrap:wrap;}'
  + '.svm-mark{width:34px;height:34px;flex:0 0 auto;border-radius:10px;display:grid;place-items:center;'
  + 'background:var(--svm-strong);border:1px solid var(--svm-hair);color:var(--svm-ink);}'
  + '.svm-title{margin:0;font-size:20px;font-weight:660;letter-spacing:-0.01em;line-height:1.2;}'
  + '.svm-sub{margin:2px 0 0;font-size:12px;color:var(--svm-dim);font-variant-numeric:tabular-nums;}'
  + '.svm-lamps{display:flex;align-items:center;gap:12px;flex:0 0 auto;font-size:11.5px;color:var(--svm-dim);'
  + 'font-variant-numeric:tabular-nums;white-space:nowrap;}'
  + '.svm-lamp{display:inline-flex;align-items:center;gap:5px;}'
  + '.svm-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex:0 0 auto;}'
  + '.svm-card{background:var(--svm-surface);border:1px solid var(--svm-hair);border-radius:14px;'
  + 'padding:16px 20px;box-shadow:var(--svm-shadow);margin-top:16px;}'
  + '.svm-sec-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap;}'
  + '.svm-sec-head h2{margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;color:var(--svm-dim);}'
  + '.svm-hint{margin:0;font-size:11px;color:var(--svm-faint);line-height:1.4;}'
  + '.svm-sec-act{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}'
  + '.svm-banner{display:flex;gap:12px;align-items:flex-start;margin-top:16px;padding:12px 16px;'
  + 'background:var(--svm-surface);border:1px solid var(--svm-hair);border-left:2px solid var(--svm-bad);'
  + 'border-radius:14px;box-shadow:var(--svm-shadow);}'
  + '.svm-banner.ok{border-left-color:var(--svm-accent);}'
  + '.svm-banner p{margin:0;font-size:12.5px;}'
  + '.svm-banner .svm-meta{margin-top:2px;}'
  + '.svm-tape{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin-top:16px;}'
  + '.svm-tile{background:var(--svm-surface);border:1px solid var(--svm-hair);border-radius:10px;'
  + 'padding:12px 16px;display:flex;flex-direction:column;gap:2px;min-width:0;}'
  + '.svm-tile b{font-size:22px;font-weight:620;letter-spacing:-0.02em;line-height:1;font-variant-numeric:tabular-nums;}'
  + '.svm-tile span{font-size:11px;color:var(--svm-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
  + '.svm-tile small{font-size:10.5px;color:var(--svm-faint);font-variant-numeric:tabular-nums;}'
  + '.svm-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px;padding:10px 12px;'
  + 'background:var(--svm-surface);border:1px solid var(--svm-hair);border-radius:14px;box-shadow:var(--svm-shadow);}'
  + '.svm-seg{display:inline-flex;padding:2px;gap:2px;border-radius:10px;border:1px solid var(--svm-hair);'
  + 'background:var(--svm-strong);}'
  + '.svm-seg button{border:0;background:transparent;color:var(--svm-dim);font-size:12px;padding:4px 12px;'
  + 'border-radius:8px;cursor:pointer;transition:background 160ms ease,color 160ms ease;white-space:nowrap;}'
  + '.svm-seg button.on{background:var(--svm-surface);color:var(--svm-ink);box-shadow:inset 0 0 0 1px var(--svm-hair2);}'
  + '.svm-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:8px;font-size:11px;'
  + 'background:var(--svm-strong);border:1px solid var(--svm-hair);color:var(--svm-dim);cursor:pointer;'
  + 'transition:background 160ms ease,border-color 160ms ease,color 160ms ease;white-space:nowrap;}'
  + '.svm-chip.on{background:color-mix(in srgb,var(--svm-accent) 10%,transparent);'
  + 'border-color:var(--svm-accent);color:var(--svm-accent);}'
  + '.svm-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:8px;font-size:12px;'
  + 'border:1px solid var(--svm-hair2);background:var(--svm-surface);color:var(--svm-ink);cursor:pointer;'
  + 'transition:background 160ms ease,border-color 160ms ease;white-space:nowrap;}'
  + '.svm-btn:hover{background:color-mix(in srgb,var(--svm-accent) 5%,transparent);'
  + 'border-color:color-mix(in srgb,var(--svm-accent) 55%,var(--svm-hair2));}'
  + '.svm-btn:active{transform:scale(0.96);}'
  + '.svm-btn.primary{background:var(--svm-accent);border-color:var(--svm-accent);color:var(--svm-on-accent);}'
  + '.svm-btn.danger{color:var(--svm-bad);border-color:color-mix(in srgb,var(--svm-bad) 45%,var(--svm-hair2));}'
  + '.svm-btn:disabled{opacity:0.55;cursor:default;}'
  + '.svm-btn.sm{height:24px;padding:0 9px;font-size:11px;}'
  + '.svm-inp{height:28px;padding:0 10px;font-size:12px;color:var(--svm-ink);background:var(--svm-strong);'
  + 'border:1px solid transparent;border-radius:8px;outline:none;transition:border-color 160ms ease,box-shadow 160ms ease;}'
  + '.svm-inp:focus{background:var(--svm-surface);border-color:var(--svm-accent);'
  + 'box-shadow:0 0 0 3px color-mix(in srgb,var(--svm-accent) 15%,transparent);}'
  + 'select.svm-inp{cursor:pointer;padding-right:24px;}'
  + '.svm-root :focus-visible{outline:none;border-color:var(--svm-accent);'
  + 'box-shadow:0 0 0 3px color-mix(in srgb,var(--svm-accent) 15%,transparent);}'
  + '.svm-work{display:grid;grid-template-columns:1.6fr 1fr;gap:16px;margin-top:16px;align-items:start;}'
  + '.svm-main{display:flex;flex-direction:column;gap:16px;min-width:0;}'
  + '.svm-main .svm-card{margin-top:0;}'
  + '.svm-side{position:sticky;top:12px;display:flex;flex-direction:column;gap:16px;min-width:0;}'
  + '.svm-side .svm-card{margin-top:0;}'
  + '.svm-rows{display:flex;flex-direction:column;border-top:1px solid var(--svm-hair);}'
  + '.svm-row{display:grid;grid-template-columns:92px minmax(0,1fr) auto;gap:12px;align-items:start;'
  + 'padding:12px;border-bottom:1px solid var(--svm-hair);border-radius:10px;cursor:pointer;'
  + 'transition:background 160ms ease;border-left:2px solid transparent;}'
  + '.svm-row:hover{background:color-mix(in srgb,var(--svm-accent) 5%,transparent);}'
  + '.svm-row.block{border-left-color:var(--svm-bad);}'
  + '.svm-rtime{font-size:11.5px;color:var(--svm-dim);font-variant-numeric:tabular-nums;line-height:1.5;}'
  + '.svm-rmain{min-width:0;}'
  + '.svm-pt{margin:0;font-size:13px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;'
  + '-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}'
  + '.svm-meta{margin:3px 0 0;font-size:11px;color:var(--svm-faint);display:flex;gap:8px;flex-wrap:wrap;'
  + 'font-variant-numeric:tabular-nums;}'
  + '.svm-rv{display:flex;flex-direction:column;gap:4px;align-items:flex-end;}'
  + '.svm-pill{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 6px;border-radius:5px;'
  + 'font-size:10px;letter-spacing:0.03em;background:var(--svm-strong);border:1px solid var(--svm-hair);'
  + 'white-space:nowrap;font-variant-numeric:tabular-nums;}'
  + '.svm-pager{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;flex-wrap:wrap;}'
  + '.svm-pager span{font-size:11.5px;color:var(--svm-dim);font-variant-numeric:tabular-nums;}'
  + '.svm-empty{margin:0;padding:18px 8px;text-align:center;font-size:11.5px;color:var(--svm-faint);}'
  + '.svm-err{margin:0;padding:10px 12px;font-size:12px;color:var(--svm-bad);word-break:break-word;}'
  + '.svm-dist{display:flex;flex-direction:column;gap:6px;}'
  + '.svm-dist-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--svm-dim);}'
  + '.svm-dist-row b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--svm-ink);font-weight:600;}'
  + '.svm-bar{flex:1 1 auto;height:5px;border-radius:3px;background:var(--svm-strong);overflow:hidden;min-width:40px;}'
  + '.svm-bar i{display:block;height:100%;border-radius:3px;}'
  + '.svm-kv{display:flex;flex-direction:column;}'
  + '.svm-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;}'
  + '.svm-field{display:flex;flex-direction:column;gap:4px;min-width:0;}'
  + '.svm-field label{font-size:11px;color:var(--svm-dim);}'
  + '.svm-field .svm-inp{width:100%;box-sizing:border-box;}'
  + '.svm-note{margin:8px 0 0;font-size:11.5px;color:var(--svm-dim);min-height:16px;}'
  + '.svm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;'
  + 'font-variant-numeric:tabular-nums;}'
  + '.svm-hist{display:flex;flex-direction:column;border-top:1px solid var(--svm-hair);margin-top:8px;}'
  + '.svm-hist-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;padding:7px 2px;'
  + 'border-bottom:1px solid var(--svm-hair);color:var(--svm-dim);flex-wrap:wrap;}'
  + '.svm-ov{position:fixed;inset:0;z-index:41;background:rgba(16,24,40,0.42);display:flex;justify-content:flex-end;}'
  + '.svm-dr{width:min(600px,94vw);height:100%;overflow-y:auto;background:var(--svm-sheet);'
  + 'border-left:1px solid var(--svm-hair2);box-shadow:var(--svm-pop);padding:20px 24px 48px;box-sizing:border-box;'
  + 'animation:svmSlide 220ms cubic-bezier(.32,.72,0,1) both;}'
  + '@keyframes svmSlide{from{opacity:0;transform:translateX(24px);}to{opacity:1;transform:none;}}'
  + '.svm-dr-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;}'
  + '.svm-dr-head h3{margin:0;font-size:15px;font-weight:650;flex:1 1 auto;min-width:0;}'
  + '.svm-dr-sec{margin-top:14px;}'
  + '.svm-echo{font-size:11px;color:var(--svm-faint);font-variant-numeric:tabular-nums;}'
  + '@media (max-width:1024px){.svm-work{grid-template-columns:1fr;}.svm-side{position:static;}}'
  + '@media (max-width:768px){.svm-root{padding:0 16px 36px;}.svm-stick{margin:0 -16px;padding:8px 16px 10px;}}'
  + '@media (max-width:640px){.svm-row{grid-template-columns:1fr;gap:6px;}.svm-rv{flex-direction:row;align-items:center;}}'
  + '@media (prefers-reduced-motion:reduce){.svm-root *,.svm-root *::before,.svm-root *::after'
  + '{animation:none !important;transition:none !important;}}';

// ---- 小工具（只新增 Svm 前缀名，不碰外层） ----
function SvmArr(v) {
  return Array.isArray(v) ? v : [];
}

function SvmObj(v) {
  return v && typeof v === 'object' ? v : {};
}

function SvmClip(text, max) {
  var s = String(text == null ? '' : text).split('\n')[0] || '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function SvmRel(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  var t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  var d = Date.now() - t;
  if (d < 0) d = 0;
  var m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  var days = Math.floor(h / 24);
  if (days < 30) return days + ' 天前';
  return shortTime(iso);
}

function SvmHash8(h) {
  var s = String(h == null ? '' : h);
  return s ? s.slice(0, 8) : '—';
}

function SvmPick(obj, keys) {
  for (var i = 0; i < keys.length; i += 1) {
    var v = obj ? obj[keys[i]] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// reviews.query 返回形态兜底：{reviews} / {rows} / 直接数组。
function SvmRowsOf(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.reviews)) return value.reviews;
  if (Array.isArray(value.rows)) return value.rows;
  if (Array.isArray(value.items)) return value.items;
  return null;
}

var SvmKindLabel = {
  goal: '目标', constraint: '约束', direction: '方向', preference: '偏好',
  quality: '质量', risk: '风险', scope: '范围', behavior: '行为',
  evidence: '证据', process: '流程',
};

var SvmStatusLabel = { active: '生效', superseded: '已取代', revoked: '已撤销' };
var SvmVerdictKeys = ['aligned', 'minor', 'drift', 'critical', 'pending'];

function SvmEngineLabel(e) {
  if (e === 'light') return '轻审';
  if (e === 'full' || e === 'deep') return '深审';
  if (e === 'handover') return '接管';
  return '—';
}

function SvmIcoRefresh() {
  return React.createElement(
    'svg',
    { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    React.createElement('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.8v3h-3' }),
  );
}

function SvmIcoWarn() {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    React.createElement('path', { d: 'M8 1.8 15 13.8H1L8 1.8zM8 6v3.4M8 11.6v0.2' }),
  );
}

function SvmIcoX() {
  return React.createElement(
    'svg',
    { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' },
    React.createElement('path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }),
  );
}

function SvmEmpty(text) {
  return React.createElement('p', { className: 'svm-empty' }, text);
}

// 通用小节卡片。
function SvmSec(props) {
  return React.createElement(
    'section',
    { className: 'svm-card', id: props.id || undefined, 'aria-label': props.title },
    React.createElement(
      'div',
      { className: 'svm-sec-head' },
      React.createElement('h2', null, props.title),
      props.hint ? React.createElement('p', { className: 'svm-hint' }, props.hint) : null,
      props.actions ? React.createElement('div', { className: 'svm-sec-act' }, props.actions) : null,
    ),
    props.children,
  );
}

// KPI 小砖。
function SvmTile(props) {
  return React.createElement(
    'div',
    { className: 'svm-tile', title: props.hint || undefined },
    React.createElement('b', { style: props.tone ? { color: props.tone } : undefined }, props.value),
    React.createElement('span', null, props.label),
    props.sub ? React.createElement('small', null, props.sub) : null,
  );
}

// ---- 报头（吸顶壳内） ----
function SvmMast(props) {
  var d = props.data || {};
  var storage = d.storage;
  var storageBad = storage === 'unavailable' || storage === 'down' || storage === 'error';
  var storageTxt = !storage ? '存储未知' : storage === 'ok' ? '存储正常' : storageBad ? '存储异常' : '存储 ' + String(storage);
  var storageColor = !storage ? T.dim : storage === 'ok' ? T.ok : storageBad ? T.bad : T.warn;
  return React.createElement(
    'div',
    { className: 'svm-stick' },
    React.createElement(
      'div',
      { className: 'svm-mast' },
      React.createElement('span', { className: 'svm-mark' }, React.createElement(Seal, { size: 20 })),
      React.createElement(
        'div',
        { style: { minWidth: 0 } },
        React.createElement('h1', { className: 'svm-title' }, '天监'),
        React.createElement(
          'p',
          { className: 'svm-sub' },
          String(props.projectCount) + ' 个项目'
          + (props.wsErr ? ' · 项目表读取失败' : '')
          + ' · 数据 ' + shortTime(d.updatedAt)
          + ' · 每 ' + String(Math.round(POLL_MS / 1000)) + ' 秒轮询',
        ),
      ),
      React.createElement(
        'div',
        { className: 'svm-lamps' },
        React.createElement(
          'span',
          { className: 'svm-lamp', title: 'overview.storage' },
          React.createElement(Dot, { color: storageColor, size: 7 }),
          storageTxt,
        ),
        React.createElement(
          'span',
          { className: 'svm-lamp', title: '待确认提醒数（overview.counters.pendingNotice）' },
          React.createElement(Dot, { color: props.pendingCount > 0 ? T.bad : T.ok, size: 7 }),
          props.pendingCount > 0 ? String(props.pendingCount) + ' 条待办' : '无待办',
        ),
        React.createElement(
          'span',
          { className: 'svm-lamp', title: '审阅活动' },
          React.createElement(Dot, { color: d.reviewing ? T.brand : T.idle, size: 7 }),
          d.reviewing ? '审阅中' : '空闲',
        ),
      ),
      React.createElement(
        'div',
        { className: 'svm-actions' },
        viewErrorTag(props.viewError),
        React.createElement(
          'button',
          { type: 'button', className: 'svm-btn', onClick: props.onRefresh, title: '立即重拉全部数据' },
          React.createElement(SvmIcoRefresh, null),
          '刷新',
        ),
      ),
    ),
  );
}

function viewErrorTag(msg) {
  if (!msg) return null;
  return React.createElement(
    'span',
    { className: 'svm-lamp', title: String(msg), style: { color: T.bad } },
    React.createElement(Dot, { color: T.bad, size: 7 }),
    '连接异常',
  );
}

// ---- 横幅：存储异常 / 首条待办 ----
function SvmBanner(props) {
  var storage = props.storage;
  var down = storage === 'unavailable' || storage === 'down' || storage === 'error';
  var first = props.notices && props.notices.length ? props.notices[0] : null;
  if (!down && !first) return null;
  var verdict = first ? verdictOf(first.verdict) : null;
  var stageTxt = first && (first.stageSeq != null || first.stage)
    ? '第 ' + num(first.stageSeq != null ? first.stageSeq : first.stage, '—') + ' 阶段'
    : '';
  return React.createElement(
    'div',
    { className: 'svm-banner' + ((!down && first) ? ' ok' : ''), role: 'alert' },
    React.createElement('span', { style: { color: down ? T.bad : T.brand, paddingTop: '1px' } }, React.createElement(SvmIcoWarn, null)),
    React.createElement(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0 } },
      down ? React.createElement('p', { style: { color: T.bad } }, '存储不可用，数据可能滞后（overview.storage = ' + String(storage) + '）。') : null,
      first
        ? React.createElement(
          'p',
          null,
          (verdict && first.verdict ? '【' + verdict.label + '】' : '')
          + SvmClip(first.message || first.summary || '有待确认的提醒', 120),
        )
        : null,
      first
        ? React.createElement(
          'p',
          { className: 'svm-meta' },
          React.createElement('span', null, shortWorkspace(first.workspaceId)),
          stageTxt ? React.createElement('span', null, stageTxt) : null,
          first.at ? React.createElement('span', { title: String(first.at) }, SvmRel(first.at)) : null,
          props.notices.length > 1 ? React.createElement('span', null, '等 ' + props.notices.length + ' 条') : null,
        )
        : null,
    ),
    first
      ? React.createElement(
        'button',
        { type: 'button', className: 'svm-btn sm', onClick: function () { props.onAck(first.workspaceId); } },
        '确认',
      )
      : null,
  );
}

// ---- KPI 带 ----
function SvmTape(props) {
  var c = props.counters;
  var th = props.thresholds;
  var thCrit = SvmObj(th.critical);
  var thStreak = SvmObj(th.streak);
  var total = props.alignTotal;
  var rate = total > 0 ? Math.round((props.verdicts.aligned / total) * 100) + '%' : '—';
  return React.createElement(
    'div',
    { className: 'svm-tape', 'aria-label': '关键指标' },
    React.createElement(SvmTile, { value: num(c.reviewCount, '0'), label: '审查', hint: '跨项目累计审查次数' }),
    React.createElement(SvmTile, {
      value: num(c.criticalCount, '0'), label: '严重偏移', hint: '跨项目累计严重偏移次数',
      tone: Number(c.criticalCount) > 0 ? T.bad : undefined,
      sub: '阈值 ' + num(thCrit.limit, '—'),
    }),
    React.createElement(SvmTile, {
      value: num(props.maxStreak, '0'), label: '连续偏移', hint: '最长连续偏移轮数',
      tone: props.streakHot ? T.warn : undefined,
      sub: '阈值 ' + num(thStreak.limit, '—'),
    }),
    React.createElement(SvmTile, {
      value: num(props.pendingCount, '0'), label: '待办', hint: '需要确认的提醒数',
      tone: props.pendingCount > 0 ? T.bad : undefined,
    }),
    React.createElement(SvmTile, { value: num(props.projectCount, '0'), label: '项目', hint: '受监察的工作区数' }),
    React.createElement(SvmTile, { value: num(props.baselineCount, '0'), label: '基线', hint: '已登记项目基线数（≤12 摘要）' }),
    React.createElement(SvmTile, { value: rate, label: '对齐率', hint: '样本内对齐占比（最近 ' + total + ' 条）' }),
    React.createElement(SvmTile, {
      value: c.lastReviewAt ? SvmRel(c.lastReviewAt) : '—',
      label: '最近审查', hint: c.lastReviewAt ? String(c.lastReviewAt) : '尚无审查',
    }),
  );
}

// ---- 工具条（全客户端本地） ----
function SvmTools(props) {
  var fs = props.fs;
  var viewSeg = React.createElement(
    'div',
    { className: 'svm-seg', role: 'tablist', 'aria-label': '视图' },
    React.createElement(
      'button',
      { type: 'button', className: fs.view === 'review' ? 'on' : '', onClick: function () { props.onF({ view: 'review' }); } },
      '审查流水',
    ),
    React.createElement(
      'button',
      { type: 'button', className: fs.view === 'project' ? 'on' : '', onClick: function () { props.onF({ view: 'project' }); } },
      '项目矩阵',
    ),
    React.createElement(
      'button',
      { type: 'button', className: fs.view === 'settings' ? 'on' : '', onClick: function () { props.onF({ view: 'settings' }); } },
      '插件设置',
    ),
  );
  if (fs.view === 'settings') {
    return React.createElement(
      'div',
      { className: 'svm-tools' },
      viewSeg,
      React.createElement('span', { className: 'svm-echo' }, '插件运行参数 · 改动即时写回宿主（危险操作需二次确认）'),
    );
  }
  var rangeSeg = React.createElement(
    'div',
    { className: 'svm-seg', 'aria-label': '时间范围' },
    React.createElement(
      'button',
      { type: 'button', className: fs.range === '24h' ? 'on' : '', onClick: function () { props.onF({ range: '24h' }); } },
      '24 小时',
    ),
    React.createElement(
      'button',
      { type: 'button', className: fs.range === '7d' ? 'on' : '', onClick: function () { props.onF({ range: '7d' }); } },
      '7 天',
    ),
    React.createElement(
      'button',
      { type: 'button', className: fs.range === 'all' ? 'on' : '', onClick: function () { props.onF({ range: 'all' }); } },
      '全部',
    ),
  );
  var wsSel = React.createElement(
    'select',
    {
      className: 'svm-inp', value: fs.ws, 'aria-label': '项目筛选',
      onChange: function (e) { props.onF({ ws: e.target.value }); },
    },
    React.createElement('option', { value: '' }, '全部项目'),
    props.wsOptions.map(function (o) {
      return React.createElement('option', { key: o.id, value: o.id }, o.label);
    }),
  );
  var chips = SvmVerdictKeys.map(function (k) {
    var meta = verdictOf(k);
    return React.createElement(
      'button',
      {
        type: 'button', key: k,
        className: 'svm-chip' + (fs.verdict === k ? ' on' : ''),
        title: '按裁决筛选（客户端计数）',
        onClick: function () { props.onF({ verdict: fs.verdict === k ? '' : k }); },
      },
      React.createElement(Dot, { color: meta.color, size: 6 }),
      meta.label + ' ' + num(props.verdictCounts[k], '0'),
    );
  });
  var search = React.createElement('input', {
    className: 'svm-inp', type: 'search', placeholder: '搜索摘要 / 项目 / 阶段…',
    value: fs.q, 'aria-label': '搜索审查',
    onChange: function (e) { props.onF({ q: e.target.value }); },
    style: { minWidth: '180px' },
  });
  return React.createElement(
    'div',
    { className: 'svm-tools' },
    viewSeg,
    rangeSeg,
    wsSel,
    chips,
    search,
    React.createElement('span', { className: 'svm-echo' }, props.echo),
  );
}

// ---- 审查流水表（真分页：reviews.query limit≤100，本地切片） ----
function SvmReviewTable(props) {
  var rows = props.pageRows;
  var body = null;
  if (props.loading && !rows.length) {
    body = SvmEmpty('正在读取审查记录…');
  } else if (!rows.length) {
    body = SvmEmpty(props.qActive ? '没有符合筛选的审查（换个条件试试）。' : '尚无审查记录。');
  } else {
    body = React.createElement(
      'div',
      { className: 'svm-rows', role: 'list' },
      rows.map(function (r, i) {
        return React.createElement(SvmReviewRow, {
          key: r.reviewId || r.id || (String(r.sessionId || '') + '#' + String(r.stageSeq) + '#' + i),
          review: r,
          first: i === 0,
          onOpen: props.onOpen,
        });
      }),
    );
  }
  var totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  var pager = React.createElement(
    'div',
    { className: 'svm-pager' },
    React.createElement(
      'button',
      { type: 'button', className: 'svm-btn sm', disabled: props.page <= 0, onClick: function () { props.onPage(props.page - 1); } },
      '上一页',
    ),
    React.createElement(
      'span',
      null,
      '第 ' + (props.page + 1) + ' / ' + totalPages + ' 页 · 共 ' + props.total + ' 条'
      + (props.usingSample ? '（overview 样本≤20）' : '（reviews.query 全量）'),
    ),
    React.createElement(
      'button',
      {
        type: 'button', className: 'svm-btn sm', disabled: props.page + 1 >= totalPages,
        onClick: function () { props.onPage(props.page + 1); },
      },
      '下一页',
    ),
    React.createElement(
      'select',
      {
        className: 'svm-inp', value: String(props.pageSize), 'aria-label': '每页条数',
        onChange: function (e) { props.onSize(Number(e.target.value) || 20); },
      },
      React.createElement('option', { value: '20' }, '20 / 页'),
      React.createElement('option', { value: '50' }, '50 / 页'),
      React.createElement('option', { value: '100' }, '100 / 页'),
    ),
  );
  return React.createElement(
    SvmSec,
    {
      title: '审查流水', hint: '时间倒序 · 点击行看 transcript 全文',
      actions: props.rqErr ? React.createElement('span', { className: 'svm-echo' }, '全量接口异常，已回退样本') : null,
    },
    body,
    pager,
  );
}

function SvmReviewRow(cfg) {
  var r = cfg.review || {};
  var meta = verdictOf(r.verdict);
  var findings = SvmArr(r.findings);
  var point = SvmClip(r.summary || (r.suggestion ? String(r.suggestion).split('\n')[0] : '') || (findings[0] ? findings[0].detail : ''), 110);
  var dur = svDur(r.durationMs);
  var key = r.reviewId || r.id || (String(r.sessionId || '') + '#' + String(r.stageSeq));
  return React.createElement(
    'div',
    {
      className: 'svm-row' + (r.blocking ? ' block' : ''), role: 'listitem', key: key,
      tabIndex: 0, title: (r.createdAt ? String(r.createdAt) : '')
        + (r.upgradeReason ? '\n升级原因：' + String(r.upgradeReason) : ''),
      onClick: function () { cfg.onOpen(r); },
      onKeyDown: function (e) { if (e && e.key === 'Enter') cfg.onOpen(r); },
    },
    React.createElement(
      'div',
      { className: 'svm-rtime' },
      React.createElement('div', null, SvmRel(r.createdAt)),
      React.createElement('div', { title: String(r.createdAt || '') }, '#' + num(r.stageSeq)),
    ),
    React.createElement(
      'div',
      { className: 'svm-rmain' },
      React.createElement('p', { className: 'svm-pt' }, point || '（无摘要）'),
      React.createElement(
        'p',
        { className: 'svm-meta' },
        React.createElement('span', null, shortWorkspace(r.workspaceId)),
        React.createElement('span', null, SvmEngineLabel(r.engine)),
        dur ? React.createElement('span', null, dur) : null,
        r.handover ? React.createElement('span', null, '交接') : null,
        findings.length ? React.createElement('span', null, findings.length + ' 疑点') : null,
        r.tokens != null ? React.createElement('span', { className: 'svm-mono' }, num(r.tokens) + ' tokens') : null,
      ),
    ),
    React.createElement(
      'div',
      { className: 'svm-rv' },
      React.createElement(
        'span',
        { className: 'svm-pill', style: { color: meta.color, borderColor: meta.color } },
        React.createElement(Dot, { color: meta.color, size: 6 }),
        meta.label,
      ),
      r.blocking ? React.createElement('span', { className: 'svm-pill', style: { color: T.bad, borderColor: T.bad } }, '阻塞') : null,
    ),
  );
}

// ---- 项目矩阵（workspaces.list） ----
function SvmProjectMatrix(props) {
  var rows = props.rows;
  var body = null;
  if (props.loading && !rows.length) {
    body = SvmEmpty('正在读取项目表…');
  } else if (!rows.length) {
    body = SvmEmpty(props.wsErr ? '项目表读取失败：' + String(props.wsErr) : '尚无项目。');
  } else {
    body = React.createElement(
      'div',
      { className: 'svm-rows', role: 'list' },
      rows.map(function (w) {
        var id = w.id;
        return React.createElement(
          'div',
          {
            className: 'svm-row', role: 'listitem', key: id,
            tabIndex: 0, title: '点击：按此项目过滤并切到审查流水',
            onClick: function () { props.onPick(id); },
            onKeyDown: function (e) { if (e && e.key === 'Enter') props.onPick(id); },
          },
          React.createElement(
            'div',
            { className: 'svm-rtime' },
            React.createElement('div', { style: { color: T.text, fontSize: '12.5px', fontWeight: 600 } }, w.short),
            React.createElement('div', { title: String(w.lastReviewAt || '') }, w.lastReviewAt ? SvmRel(w.lastReviewAt) : '未审'),
          ),
          React.createElement(
            'div',
            { className: 'svm-rmain' },
            React.createElement(
              'p',
              { className: 'svm-meta', style: { margin: 0 } },
              React.createElement('span', null, '基线 r' + num(w.baselineRevision)),
              React.createElement('span', null, '审查 ' + num(w.reviewCount, '0')),
              React.createElement('span', null, '连续 ' + num(w.driftStreak, '0') + '/' + num(props.streakLimit)),
              React.createElement('span', { style: Number(w.criticalCount) > 0 ? { color: T.bad } : undefined },
                '严重 ' + num(w.criticalCount, '0') + '/' + num(props.critLimit)),
              React.createElement('span', null, '要求 ' + num(w.reqCount, '0')),
              w.sessionCount ? React.createElement('span', null, w.sessionCount + ' 会话') : null,
              w.lastStageSeq != null ? React.createElement('span', null, '最近 #' + num(w.lastStageSeq)) : null,
            ),
          ),
          React.createElement(
            'div',
            { className: 'svm-rv' },
            w.lastVerdict
              ? React.createElement(
                'span',
                { className: 'svm-pill', style: { color: verdictOf(w.lastVerdict).color, borderColor: verdictOf(w.lastVerdict).color } },
                verdictOf(w.lastVerdict).label,
              )
              : React.createElement('span', { className: 'svm-pill' }, '未审'),
            w.pending ? React.createElement('span', { className: 'svm-pill', style: { color: T.bad, borderColor: T.bad } }, '待办') : null,
          ),
        );
      }),
    );
  }
  return React.createElement(
    SvmSec,
    { title: '项目矩阵', hint: '行点击 = 按项目过滤并切到审查流水（overview + workspaces.list 派生）' },
    body,
  );
}

// ---- 右轨 ----
function SvmRail(props) {
  var notices = props.notices.slice(0, 4);
  var queue = React.createElement(
    SvmSec,
    {
      title: '处置队列',
      hint: 'pendingNotices[0..4]',
      actions: props.notices.length
        ? React.createElement('button', { type: 'button', className: 'svm-btn sm', onClick: props.onAckAll }, '全部确认')
        : null,
    },
    notices.length
      ? React.createElement(
        'div',
        { className: 'svm-rows' },
        notices.map(function (n, i) {
          return React.createElement(
            'div',
            {
              className: 'svm-row', key: 'n' + i, style: { gridTemplateColumns: 'minmax(0,1fr) auto', cursor: 'default' },
              title: String(n.at || ''),
            },
            React.createElement(
              'div',
              { className: 'svm-rmain' },
              React.createElement('p', { className: 'svm-pt' }, SvmClip(n.message || n.summary || '待确认提醒', 90)),
              React.createElement(
                'p',
                { className: 'svm-meta' },
                React.createElement('span', null, shortWorkspace(n.workspaceId)),
                n.stageSeq != null ? React.createElement('span', null, '#' + num(n.stageSeq)) : null,
                n.at ? React.createElement('span', null, SvmRel(n.at)) : null,
              ),
            ),
            React.createElement(
              'div',
              { className: 'svm-rv' },
              React.createElement(
                'button',
                { type: 'button', className: 'svm-btn sm', onClick: function () { props.onAck(n.workspaceId); } },
                '确认',
              ),
            ),
          );
        }),
      )
      : SvmEmpty('队列已清空。'),
  );
  var th = props.thresholds;
  var thCrit = SvmObj(th.critical);
  var thStreak = SvmObj(th.streak);
  var policy = React.createElement(
    SvmSec,
    { title: '政策', hint: 'policyOf(settings) + 模型落点' },
    React.createElement('p', { className: 'svm-pt', style: { marginBottom: '8px' } }, policyOf(props.settings)),
    React.createElement(Row, { label: '轻审模型', value: svLanding(props.mr.light) || '跟随当前会话' }),
    React.createElement(Row, { label: '深审模型', value: svLanding(props.mr.deep) || (props.mr.light ? '跟随轻审' : '跟随当前会话'), last: true }),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
      React.createElement('button', { type: 'button', className: 'svm-btn sm', onClick: function () { var el = document.querySelector('#svm-policy'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, '调参'),
      React.createElement('button', { type: 'button', className: 'svm-btn sm', onClick: function () { var el = document.querySelector('#svm-audit'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, '审计'),
    ),
  );
  var meters = React.createElement(
    SvmSec,
    { title: '阈值', hint: '超限转红' },
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      React.createElement(Meter, { label: '严重偏移', value: thCrit.count, limit: thCrit.limit }),
      React.createElement(Meter, { label: '连续偏移', value: thStreak.maxStreak, limit: thStreak.limit }),
    ),
  );
  var distItems = SvmVerdictKeys.map(function (k) {
    var c = Number(props.verdicts[k]) || 0;
    var pct = props.alignTotal > 0 ? Math.round((c / props.alignTotal) * 100) : 0;
    return React.createElement(
      'div',
      { className: 'svm-dist-row', key: k },
      React.createElement(Dot, { color: verdictOf(k).color, size: 6 }),
      React.createElement('span', null, verdictOf(k).label),
      React.createElement('span', { className: 'svm-bar' }, React.createElement('i', { style: { width: pct + '%', background: verdictOf(k).color } })),
      React.createElement('b', null, String(c)),
    );
  });
  var dist = React.createElement(
    SvmSec,
    { title: '裁决分布', hint: 'overview.reviews 样本' },
    React.createElement('div', { className: 'svm-dist' }, distItems),
  );
  var b0 = props.baselines[0] || null;
  var hea = SvmObj(props.health);
  var rpcInfo = SvmObj(hea.rpc);
  var healthy = React.createElement(
    SvmSec,
    { title: '基线 · 健康' },
    React.createElement(Row, {
      label: '基线头', value: b0 ? shortWorkspace(b0.workspaceId) + ' r' + num(b0.revision) : '—',
    }),
    React.createElement(Row, { label: '存储', value: props.storage === 'ok' ? '可用' : String(props.storage || '未知') }),
    React.createElement(Row, { label: '构建', value: String(CLIENT_BUILD) }),
    React.createElement(Row, { label: '轮询', value: String(Math.round(POLL_MS / 1000)) + ' 秒' }),
    React.createElement(Row, {
      label: 'RPC', last: true,
      value: rpcInfo.calls != null ? String(rpcInfo.calls) + ' 次' + (rpcInfo.lastAt ? ' · ' + SvmRel(rpcInfo.lastAt) : '') : '—',
    }),
  );
  return React.createElement('div', { className: 'svm-side' }, queue, policy, meters, dist, healthy);
}

// ---- 要求台账（requirements.list{limit:200}） ----
function SvmReqs(props) {
  var rows = props.pageRows;
  var expState = React.useState(false);
  var expanded = expState[0];
  var setExpanded = expState[1];
  var shown = expanded ? rows : rows.slice(0, 60);
  var body = null;
  if (props.loading && !rows.length) {
    body = SvmEmpty('正在读取要求台账…');
  } else if (!rows.length) {
    body = SvmEmpty('台账为空。');
  } else {
    body = React.createElement(
      'div',
      { className: 'svm-rows', role: 'list' },
      shown.map(function (r, i) {
        var id = r.reqId || r.id || ('req' + i);
        var kind = SvmKindLabel[r.kind] || String(r.kind || '其它');
        var st = SvmStatusLabel[r.status] || String(r.status || '未知');
        var stColor = r.status === 'active' ? T.ok : r.status === 'revoked' ? T.bad : T.dim;
        return React.createElement(
          'div',
          {
            className: 'svm-row', role: 'listitem', key: id,
            style: { gridTemplateColumns: 'minmax(0,1fr) auto' },
            tabIndex: 0, title: String(r.updatedAt || r.at || ''),
            onClick: function () { props.onOpen(r); },
            onKeyDown: function (e) { if (e && e.key === 'Enter') props.onOpen(r); },
          },
          React.createElement(
            'div',
            { className: 'svm-rmain' },
            React.createElement('p', { className: 'svm-pt' }, SvmClip(r.text || r.content, 120) || '（空）'),
            React.createElement(
              'p',
              { className: 'svm-meta' },
              React.createElement('span', { className: 'svm-mono' }, String(id).slice(0, 18)),
              React.createElement('span', null, shortWorkspace(r.workspaceId || r.workspace)),
              r.updatedAt || r.at ? React.createElement('span', null, SvmRel(r.updatedAt || r.at)) : null,
            ),
          ),
          React.createElement(
            'div',
            { className: 'svm-rv', style: { flexDirection: 'row' } },
            React.createElement('span', { className: 'svm-pill' }, kind),
            React.createElement('span', { className: 'svm-pill' }, String(r.strength === 'hard' ? '硬' : r.strength === 'soft' ? '软' : (r.strength || '—'))),
            React.createElement('span', { className: 'svm-pill', style: { color: stColor, borderColor: stColor } }, st),
          ),
        );
      }),
    );
  }
  return React.createElement(
    SvmSec,
    {
      title: '要求台账',
      hint: '共 ' + props.total + ' · 生效 ' + props.cActive + ' · 硬 ' + props.cHard + ' · 已取代 ' + props.cSup + ' · 已撤销 ' + props.cRev
        + (expanded ? '' : (rows.length > 60 ? ' · 仅列前 60' : '')),
      actions: rows.length > 60
        ? React.createElement(
          'button',
          { type: 'button', className: 'svm-btn sm', onClick: function () { setExpanded(!expanded); } },
          expanded ? '收起' : '展开全部（' + rows.length + '）',
        )
        : null,
    },
    props.reqErr ? React.createElement('p', { className: 'svm-err' }, '台账读取失败：' + String(props.reqErr)) : null,
    body,
  );
}

// ---- 基线摘要（overview.baselines ≤12） ----
function SvmBases(props) {
  var list = props.baselines.slice(0, 12);
  if (!list.length) return React.createElement(SvmSec, { title: '基线', hint: 'overview.baselines' }, SvmEmpty('尚无基线。'));
  return React.createElement(
    SvmSec,
    { title: '基线', hint: '跨项目摘要（全文在会话 Tab 看）· ' + list.length + ' 条' },
    list.map(function (b, i) {
      var goals = SvmArr(b.goals);
      var hard = SvmArr(b.constraints && b.constraints.hard);
      var soft = SvmArr(b.constraints && b.constraints.soft);
      var dirs = SvmArr(b.directions);
      var key = (b.workspaceId || i) + '#r' + String(b.revision);
      return React.createElement(
        Fold,
        { key: key, kicker: '基线', title: shortWorkspace(b.workspaceId) + ' · r' + num(b.revision), count: SvmRel(b.updatedAt) },
        b.intent ? React.createElement('p', { style: { margin: '6px 0', fontSize: '12px', color: T.text } }, String(b.intent)) : null,
        React.createElement(
          'p',
          { className: 'svm-meta', style: { margin: '0 0 4px' } },
          React.createElement('span', null, '目标 ' + goals.length),
          React.createElement('span', null, '硬约束 ' + hard.length),
          React.createElement('span', null, '软约束 ' + soft.length),
          React.createElement('span', null, '方向 ' + dirs.length),
        ),
        React.createElement(
          'button',
          { type: 'button', className: 'svm-btn sm', onClick: function () { props.onOpen(b); } },
          '看详情',
        ),
      );
    }),
  );
}

// ---- 政策带（overview.settings 14 字段 + settings.set + 历史） ----
function SvmPolicy(props) {
  var v = props.val;
  var save = props.save;
  function numField(key, label, min, max, step, danger) {
    return React.createElement(
      'div',
      { className: 'svm-field', key: key },
      React.createElement('label', null, label),
      React.createElement('input', {
        className: 'svm-inp', type: 'number', min: min, max: max, step: step,
        value: v(key, ''), 'aria-label': label,
        onChange: function (e) {
          var patch = {};
          patch[key] = Number(e.target.value);
          props.draft(patch);
        },
        onBlur: function (e) {
          var n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          var patch = {};
          patch[key] = n;
          save(patch, danger);
        },
      }),
    );
  }
  function textField(key, label) {
    return React.createElement(
      'div',
      { className: 'svm-field', key: key },
      React.createElement('label', null, label),
      React.createElement('input', {
        className: 'svm-inp', type: 'text', value: v(key, ''), 'aria-label': label,
        placeholder: '跟随会话', title: '失焦保存',
        onChange: function (e) {
          var patch = {};
          patch[key] = String(e.target.value);
          props.draft(patch);
        },
        onBlur: function (e) {
          var patch = {};
          patch[key] = String(e.target.value).trim();
          save(patch);
        },
      }),
    );
  }
  var engSel = React.createElement(
    'div',
    { className: 'svm-field', key: 'engine' },
    React.createElement('label', null, '审查引擎'),
    React.createElement(
      'select',
      {
        className: 'svm-inp', value: v('engine', 'auto'), 'aria-label': '审查引擎',
        onChange: function (e) { save({ engine: e.target.value }); },
      },
      React.createElement('option', { value: 'auto' }, '自动（轻审先行）'),
      React.createElement('option', { value: 'light' }, '仅轻审'),
      React.createElement('option', { value: 'deep' }, '仅深审'),
    ),
  );
  function checkField(key, label, danger) {
    return React.createElement(
      'div',
      { className: 'svm-field', key: key },
      React.createElement('label', null, label),
      React.createElement(
        'button',
        {
          type: 'button', className: 'svm-btn sm', 'aria-pressed': v(key, false) === true ? 'true' : 'false',
          onClick: function () {
            var patch = {};
            patch[key] = !(v(key, false) === true);
            save(patch, danger);
          },
        },
        v(key, false) === true ? '开' : '关',
      ),
    );
  }
  var hist = props.histRows.length
    ? React.createElement(
      'div',
      { className: 'svm-hist' },
      props.histRows.slice(0, 8).map(function (j, i) {
        var p = SvmObj(j.payload);
        var key = SvmPick(p, ['key', 'field', 'name']) || SvmPick(j, ['key']) || '—';
        var from = SvmPick(p, ['from', 'oldValue', 'old']) != null ? String(SvmPick(p, ['from', 'oldValue', 'old'])) : '—';
        var to = SvmPick(p, ['to', 'newValue', 'new']) != null ? String(SvmPick(p, ['to', 'newValue', 'new'])) : '—';
        var via = SvmPick(p, ['via', 'by', 'source']) || '';
        return React.createElement(
          'div',
          { className: 'svm-hist-row', key: 'h' + i },
          React.createElement('span', { className: 'svm-mono' }, '#' + num(j.seq)),
          React.createElement('span', null, SvmClip(key, 24)),
          React.createElement('span', { className: 'svm-mono' }, SvmClip(from, 18) + ' → ' + SvmClip(to, 18)),
          via ? React.createElement('span', null, via) : null,
          React.createElement('span', { style: { marginLeft: 'auto' } }, j.ts ? SvmRel(j.ts) : ''),
        );
      }),
    )
    : SvmEmpty('暂无政策变更历史。');
  return React.createElement(
    SvmSec,
    { title: '政策', hint: 'overview.settings · 危险操作需二次确认 · 写 settings.set', id: 'svm-policy' },
    React.createElement(
      'div',
      { className: 'svm-grid2' },
      checkField('enabled', '总开关', 'disable'),
      engSel,
      checkField('deepOnDrift', '偏移升深审'),
      checkField('interruptEnabled', '阈值打断', 'interrupt'),
      checkField('kyzmemReflow', '经验回流'),
      numField('criticalLimit', '严重阈值', 1, 99, 1, 'threshold'),
      numField('driftStreakLimit', '连续阈值', 1, 99, 1, 'threshold'),
      numField('autoReviewMinutes', '兜底（分钟，0=关）', 0, 1440, 1),
      React.createElement(
        'div',
        { className: 'svm-field', key: 'timeoutMs' },
        React.createElement('label', null, '单轮超时（秒）'),
        React.createElement('input', {
          className: 'svm-inp', type: 'number', min: 5, max: 600, step: 5,
          value: Math.round(Number(v('timeoutMs', 60000)) / 1000), 'aria-label': '单轮超时（秒）',
          onChange: function (e) { props.draft({ timeoutMs: (Number(e.target.value) || 60) * 1000 }); },
          onBlur: function (e) { save({ timeoutMs: (Number(e.target.value) || 60) * 1000 }); },
        }),
      ),
      numField('maxBriefChars', '简报上限（字）', 500, 40000, 100),
      React.createElement(
        'div',
        { className: 'svm-field', key: 'interruptCooldownMs' },
        React.createElement('label', null, '打断冷却（分钟）'),
        React.createElement('input', {
          className: 'svm-inp', type: 'number', min: 1, max: 1440, step: 1,
          value: Math.round(Number(v('interruptCooldownMs', 600000)) / 60000), 'aria-label': '打断冷却（分钟）',
          onChange: function (e) { props.draft({ interruptCooldownMs: (Number(e.target.value) || 10) * 60000 }); },
          onBlur: function (e) { save({ interruptCooldownMs: (Number(e.target.value) || 10) * 60000 }); },
        }),
      ),
      textField('lightProvider', '轻审 provider'),
      textField('lightModel', '轻审 model'),
      textField('deepProvider', '深审 provider'),
      textField('deepModel', '深审 model'),
    ),
    props.note ? React.createElement('p', { className: 'svm-note' }, props.note) : null,
    React.createElement('div', { className: 'svm-dr-sec' }, React.createElement('p', { className: 'svm-hint' }, '变更历史（journal type=settings_changed）'), hist),
  );
}

// ---- 审计与健康（journal.query{limit:20} + health） ----
function SvmAudit(props) {
  var rows = props.rows;
  var chain = props.chain;
  var body = null;
  if (props.loading && !rows.length) {
    body = SvmEmpty('正在读取审计链…');
  } else if (!rows.length) {
    body = SvmEmpty(props.jouErr ? '审计链读取失败：' + String(props.jouErr) : '暂无审计事件。');
  } else {
    body = React.createElement(
      'div',
      { className: 'svm-rows', role: 'list' },
      rows.map(function (j, i) {
        var p = SvmObj(j.payload);
        var keys = Object.keys(p).slice(0, 3).join(' · ');
        var ok = chain[j.seq];
        return React.createElement(
          'div',
          {
            className: 'svm-row', role: 'listitem', key: 'j' + String(j.seq) + '#' + i,
            style: { gridTemplateColumns: '52px minmax(0,1fr) auto' },
            tabIndex: 0, title: '点击看原文',
            onClick: function () { props.onOpen(j); },
            onKeyDown: function (e) { if (e && e.key === 'Enter') props.onOpen(j); },
          },
          React.createElement('div', { className: 'svm-rtime svm-mono' }, '#' + num(j.seq)),
          React.createElement(
            'div',
            { className: 'svm-rmain' },
            React.createElement('p', { className: 'svm-pt' }, safeStr(j.type, '未知类型') + (keys ? ' · ' + SvmClip(keys, 60) : '')),
            React.createElement(
              'p',
              { className: 'svm-meta' },
              React.createElement('span', { className: 'svm-mono' }, SvmHash8(j.hash)),
              j.ts ? React.createElement('span', { title: String(j.ts) }, SvmRel(j.ts)) : null,
            ),
          ),
          React.createElement(
            'div',
            { className: 'svm-rv' },
            ok === undefined
              ? React.createElement('span', { className: 'svm-pill' }, '—')
              : React.createElement(
                'span',
                { className: 'svm-pill', style: { color: ok ? T.ok : T.bad, borderColor: ok ? T.ok : T.bad }, title: ok ? 'prevHash 衔接正常' : 'prevHash 断裂' },
                ok ? '✓ 链' : '✗ 链',
              ),
          ),
        );
      }),
    );
  }
  var hea = SvmObj(props.health);
  var rpcInfo = SvmObj(hea.rpc);
  return React.createElement(
    SvmSec,
    { title: '审计与健康', hint: 'journal.query{limit:20} 服务端验链 · 行点击看原文', id: 'svm-audit' },
    body,
    React.createElement(
      'div',
      { className: 'svm-kv', style: { marginTop: '8px' } },
      React.createElement(Row, { label: '存储', value: props.storage === 'ok' ? '可用' : String(props.storage || '未知') }),
      React.createElement(Row, { label: '审查 / 要求 / 审计', value: num(props.nReviews) + ' / ' + num(props.nReqs) + ' / ' + num(rows.length) }),
      React.createElement(Row, { label: '构建', value: String(hea.build || CLIENT_BUILD) }),
      React.createElement(Row, {
        label: '上次 RPC', last: true,
        value: rpcInfo.lastAt ? SvmRel(rpcInfo.lastAt) + ' · ' + num(rpcInfo.calls, '—') + ' 次' : '—',
      }),
    ),
  );
}

// ---- 抽屉壳 ----
function SvmDrawer(props) {
  return React.createElement(
    'div',
    { className: 'svm-ov', onClick: props.onClose },
    React.createElement(
      'div',
      {
        className: 'svm-dr', role: 'dialog', 'aria-label': props.title,
        onClick: function (e) { e.stopPropagation(); },
      },
      React.createElement(
        'div',
        { className: 'svm-dr-head' },
        React.createElement('h3', null, props.title),
        React.createElement(
          'button',
          { type: 'button', className: 'svm-btn sm', onClick: props.onClose, 'aria-label': '关闭抽屉（Esc）' },
          React.createElement(SvmIcoX, null),
          '关闭',
        ),
      ),
      props.children,
    ),
  );
}

// ---- 审查抽屉：meta + transcript 块 + trail ----
function SvmReviewBody(props) {
  var rpc = props.rpc;
  var r = props.review || {};
  var rid = r.reviewId || r.id || '';
  var st = React.useState({ rid: '', loading: false, data: null });
  var ts = st[0];
  var setTs = st[1];
  React.useEffect(function () {
    if (!rid || ts.rid === rid) return undefined;
    var dead = false;
    setTs({ rid: rid, loading: true, data: null });
    rpc('review.transcript', { reviewId: rid })
      .then(function (result) {
        if (dead) return;
        var v = result && result.ok ? result.value : null;
        setTs({ rid: rid, loading: false, data: v ? v.transcript : null });
      })
      .catch(function () {
        if (!dead) setTs({ rid: rid, loading: false, data: null });
      });
    return function () { dead = true; };
  }, [rid]);
  var meta = verdictOf(r.verdict);
  var findings = SvmArr(r.findings).slice(0, 6);
  var d = ts.data || {};
  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { className: 'svm-meta', style: { marginBottom: '6px' } },
      React.createElement('span', { className: 'svm-pill', style: { color: meta.color, borderColor: meta.color } }, meta.label),
      React.createElement('span', null, '#' + num(r.stageSeq)),
      React.createElement('span', null, shortWorkspace(r.workspaceId)),
      React.createElement('span', null, SvmEngineLabel(r.engine)),
      r.createdAt ? React.createElement('span', { title: String(r.createdAt) }, SvmRel(r.createdAt)) : null,
      r.durationMs ? React.createElement('span', null, fmtDur(r.durationMs)) : null,
      r.blocking ? React.createElement('span', { style: { color: T.bad } }, '阻塞') : null,
    ),
    r.model || r.modelSource || r.upgradeReason
      ? React.createElement(
        'p',
        { className: 'svm-meta' },
        r.model ? React.createElement('span', { className: 'svm-mono' }, String(r.model).split('/').pop()) : null,
        r.modelSource ? React.createElement('span', null, '来源' + String(r.modelSource)) : null,
        r.upgradeReason ? React.createElement('span', null, '升级：' + SvmClip(r.upgradeReason, 60)) : null,
        r.supersedes ? React.createElement('span', null, '取代 ' + SvmHash8(r.supersedes)) : null,
      )
      : null,
    r.summary ? React.createElement('p', { className: 'svm-pt', style: { margin: '8px 0' } }, String(r.summary)) : null,
    r.suggestion ? React.createElement('p', { className: 'svm-pt', style: { margin: '0 0 8px', color: T.dim } }, '建议：' + SvmClip(r.suggestion, 200)) : null,
    !rid
      ? SvmEmpty('这条记录没有 reviewId，看不到分析原文。')
      : ts.loading
        ? SvmEmpty('正在读取分析记录…')
        : !ts.data
          ? SvmEmpty('这条审查没有留下分析记录（可能是早期版本生成的）。')
          : React.createElement(
            'div',
            { className: 'svm-dr-sec' },
            d.assemble && typeof d.assemble === 'object'
              ? React.createElement(
                'p',
                { className: 'svm-meta', style: { marginBottom: '8px' } },
                React.createElement('span', null, '基线第 ' + num(d.assemble.baselineRevision, '—') + ' 版'),
                React.createElement('span', null, '证据 ' + num(d.assemble.evidenceFiles, '—') + ' 文件'),
                React.createElement('span', null, '简报 ' + num(d.assemble.briefChars, '—') + '/' + num(d.assemble.maxBriefChars, '—') + ' 字'),
              )
              : null,
            React.createElement(BriefBlock, { kicker: '司天', title: '简报', text: d.brief }),
            React.createElement(SuspicionsBlock, { kicker: '观天', title: '细读', text: d.deepAnalysisRaw || d.lightRaw }),
            d.deepVerifyRaw ? React.createElement(VerdictBlock, { kicker: '观天', title: '核验', text: d.deepVerifyRaw }) : null,
            d.notes ? React.createElement(NotesBlock, { kicker: '观天', title: '疑点清单', text: d.notes }) : null,
            findings.length && !(d.deepVerifyRaw && tryJson(String(d.deepVerifyRaw)))
              ? React.createElement(
                'div',
                { className: 'svm-dr-sec' },
                React.createElement('p', { className: 'svm-hint' }, '行内疑点（' + findings.length + '）'),
                React.createElement(FindingsList, { items: findings }),
              )
              : null,
            React.createElement(EvidenceStructFold, { data: d.evidenceStructured }),
            d.brief
              ? React.createElement(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                React.createElement(CopyText, { text: String(d.brief), label: '复制简报' }),
                (d.deepAnalysisRaw || d.lightRaw)
                  ? React.createElement(CopyText, { text: String(d.deepAnalysisRaw || d.lightRaw), label: '复制细读原文' })
                  : null,
              )
              : null,
            React.createElement('div', { className: 'svm-dr-sec' }, React.createElement(TrailView, { rpc: rpc, reviewId: rid })),
          ),
  );
}

// ---- 要求 / 基线 / 审计 / 健康抽屉：只读镜像 ----
function SvmReqBody(props) {
  var r = props.req || {};
  return React.createElement(
    'div',
    null,
    React.createElement('p', { className: 'svm-pt' }, String(r.text || r.content || '（空）')),
    React.createElement(
      'div',
      { className: 'svm-kv', style: { marginTop: '8px' } },
      React.createElement(Row, { label: '编号', value: React.createElement('span', { className: 'svm-mono' }, String(r.reqId || r.id || '—')) }),
      React.createElement(Row, { label: '种类', value: SvmKindLabel[r.kind] || String(r.kind || '—') }),
      React.createElement(Row, { label: '强度', value: r.strength === 'hard' ? '硬约束' : r.strength === 'soft' ? '软约束' : String(r.strength || '—') }),
      React.createElement(Row, { label: '状态', value: SvmStatusLabel[r.status] || String(r.status || '—') }),
      React.createElement(Row, { label: '项目', value: shortWorkspace(r.workspaceId || r.workspace) }),
      React.createElement(Row, { label: '来源轮次', value: r.turn != null ? String(r.turn) : (r.sourceSeq != null ? String(r.sourceSeq) : '—') }),
      React.createElement(Row, { label: '更新', value: r.updatedAt || r.at ? SvmRel(r.updatedAt || r.at) : '—' }),
      React.createElement(Row, { label: '取代', value: r.supersedes ? SvmHash8(r.supersedes) : '—', last: !r.origin && !r.sourceQuote }),
      r.origin ? React.createElement(Row, { label: '来源', value: SvmClip(r.origin, 80), last: !r.sourceQuote }) : null,
      r.sourceQuote ? React.createElement(Row, { label: '原话', value: SvmClip(r.sourceQuote, 80), last: true }) : null,
    ),
    r.sourceQuote ? React.createElement(RawPre, { text: String(r.sourceQuote) }) : null,
  );
}

function SvmBaseBody(props) {
  var b = props.base || {};
  var c = SvmObj(b.constraints);
  var goals = SvmArr(b.goals);
  var hard = SvmArr(c.hard);
  var soft = SvmArr(c.soft);
  var dirs = SvmArr(b.directions);
  function ol(list) {
    if (!list.length) return SvmEmpty('（空）');
    return React.createElement(
      'ol',
      { style: { margin: '2px 0 8px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' } },
      list.map(function (t, i) {
        return React.createElement('li', { key: 'bb' + i, style: { fontSize: '12px', color: T.text } }, String(t));
      }),
    );
  }
  return React.createElement(
    'div',
    null,
    React.createElement(
      'p',
      { className: 'svm-meta' },
      React.createElement('span', null, shortWorkspace(b.workspaceId)),
      React.createElement('span', null, '第 ' + num(b.revision) + ' 版'),
      b.updatedAt ? React.createElement('span', { title: String(b.updatedAt) }, SvmRel(b.updatedAt)) : null,
    ),
    b.intent ? React.createElement('p', { className: 'svm-pt', style: { margin: '8px 0' } }, String(b.intent)) : null,
    React.createElement('p', { className: 'svm-hint' }, '目标（' + goals.length + '）'),
    ol(goals),
    React.createElement('p', { className: 'svm-hint' }, '硬约束（' + hard.length + '）'),
    ol(hard),
    React.createElement('p', { className: 'svm-hint' }, '软约束（' + soft.length + '）'),
    ol(soft),
    React.createElement('p', { className: 'svm-hint' }, '技术方向（' + dirs.length + '）'),
    ol(dirs),
  );
}

function SvmJournalBody(props) {
  var j = props.journal || {};
  var p = SvmObj(j.payload);
  return React.createElement(
    'div',
    null,
    React.createElement(
      'p',
      { className: 'svm-meta' },
      React.createElement('span', { className: 'svm-mono' }, '#' + num(j.seq)),
      React.createElement('span', null, safeStr(j.type, '未知类型')),
      j.ts ? React.createElement('span', { title: String(j.ts) }, SvmRel(j.ts)) : null,
    ),
    React.createElement(
      'div',
      { className: 'svm-kv', style: { marginTop: '8px' } },
      React.createElement(Row, { label: 'hash', value: React.createElement('span', { className: 'svm-mono' }, String(j.hash || '—')) }),
      React.createElement(Row, { label: 'prevHash', value: React.createElement('span', { className: 'svm-mono' }, String(j.prevHash || '—')), last: true }),
    ),
    React.createElement(RawPre, { text: JSON.stringify(p, null, 2) }),
    React.createElement(
      'div',
      { style: { marginTop: '8px' } },
      React.createElement(CopyText, { text: JSON.stringify(j, null, 2), label: '复制事件原文' }),
    ),
  );
}

// ---- 主入口 ----
function SupervisorMain(props) {
  var rpc = props.rpc;
  var polled = usePoll(rpc, 'overview', null, POLL_MS);
  var view = polled[0];
  var refresh = polled[1];
  var data = view.data;

  React.useEffect(function () {
    beacon('main-open', CLIENT_BUILD);
  }, []);

  var fsState = React.useState({ view: 'review', range: 'all', ws: '', verdict: '', engine: '', q: '' });
  var fs = fsState[0];
  var setFsRaw = fsState[1];
  var pageState = React.useState(0);
  var page = pageState[0];
  var setPage = pageState[1];
  var sizeState = React.useState(20);
  var pageSize = sizeState[0];
  var setPageSize = sizeState[1];
  function setF(patch) {
    setFsRaw(Object.assign({}, fs, patch));
    setPage(0);
  }

  var auxState = React.useState({ ws: null, req: null, jou: null, hea: null, wsErr: '', reqErr: '', jouErr: '' });
  var aux = auxState[0];
  var setAux = auxState[1];
  var tickState = React.useState(0);
  var tick = tickState[0];
  var setTick = tickState[1];
  function refreshAll() {
    refresh();
    setTick(function (n) { return n + 1; });
  }

  // 12s 轮询 overview 成功后（按 state.at）重拉四个慢表；本地过滤不触发请求。
  React.useEffect(function () {
    if (!view.at) return undefined;
    var dead = false;
    function one(endpoint, payload) {
      return rpc(endpoint, payload)
        .then(function (res) { return res && res.ok ? res.value : null; })
        .catch(function () { return null; });
    }
    Promise.all([
      one('workspaces.list', null),
      one('requirements.list', { limit: 200 }),
      one('journal.query', { limit: 20 }),
      one('health', null),
    ]).then(function (arr) {
      if (dead) return;
      setAux({
        ws: arr[0], req: arr[1], jou: arr[2], hea: arr[3],
        wsErr: arr[0] ? '' : 'workspaces.list 无返回',
        reqErr: arr[1] ? '' : 'requirements.list 无返回',
        jouErr: arr[2] ? '' : 'journal.query 无返回',
      });
    });
    return function () { dead = true; };
  }, [view.at, tick]);

  // 审查全量：reviews.query{limit≤100 + 服务端过滤}，失败则回退 overview 20 条样本。
  var rqState = React.useState({ rows: null, loading: false, err: '' });
  var rq = rqState[0];
  var setRq = rqState[1];
  var rqKey = [fs.ws, fs.verdict, fs.engine, view.at, tick].join('|');
  React.useEffect(function () {
    var dead = false;
    setRq(function (prev) { return { rows: prev.rows, loading: true, err: '' }; });
    var payload = { limit: 100 };
    if (fs.ws) payload.workspaceId = fs.ws;
    if (fs.verdict) payload.verdict = fs.verdict;
    if (fs.engine) payload.engine = fs.engine;
    rpc('reviews.query', payload)
      .then(function (result) {
        if (dead) return;
        var rows = result && result.ok ? SvmRowsOf(result.value) : null;
        setRq({ rows: rows, loading: false, err: rows ? '' : 'query 回退' });
      })
      .catch(function () {
        if (!dead) setRq(function (prev) { return { rows: prev.rows, loading: false, err: 'query 回退' }; });
      });
    return function () { dead = true; };
  }, [rqKey]);

  var dwState = React.useState(null);
  var dw = dwState[0];
  var setDw = dwState[1];
  React.useEffect(function () {
    if (!dw) return undefined;
    function onKey(e) {
      if (e && e.key === 'Escape') setDw(null);
    }
    document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('keydown', onKey); };
  }, [dw]);

  var rowsState = React.useState({});
  var rows = rowsState[0];
  var setRows = rowsState[1];
  var noteState = React.useState('');
  var note = noteState[0];
  var setNote = noteState[1];

  var over = SvmObj(data);
  var settings = SvmObj(over.settings);
  var counters = SvmObj(over.counters);
  var verdicts = SvmObj(over.verdicts);
  var fixed = {
    aligned: Number(verdicts.aligned) || 0,
    minor: Number(verdicts.minor) || 0,
    drift: Number(verdicts.drift) || 0,
    critical: Number(verdicts.critical) || 0,
    pending: Number(verdicts.pending) || 0,
  };
  var notices = SvmArr(over.pendingNotices || counters.pendingNotices);
  var pendingCount = notices.length || (counters.pendingNotice ? 1 : 0);
  var sampleReviews = SvmArr(over.reviews);
  var alignTotal = sampleReviews.length;
  var thresholds = SvmObj(over.thresholds);
  var baselines = SvmArr(over.baselines);
  var mr = SvmObj(over.modelResolution);

  function valSv(key, fb) {
    if (Object.prototype.hasOwnProperty.call(rows, key)) return rows[key];
    return settings[key] !== undefined ? settings[key] : fb;
  }
  function draftSv(patch) {
    setRows(Object.assign({}, rows, patch));
  }
  function saveSv(patch, dangerKind) {
    if (dangerKind) {
      try {
        if (dangerKind === 'disable' && !window.confirm('确定关闭全项目审查？关闭后主动汇报、兜底与打断都不再运行，只保留台账记录。')) return;
        if (dangerKind === 'threshold' && !window.confirm('阈值越小越容易触发打断，确定修改？')) return;
        if (dangerKind === 'interrupt' && !window.confirm('开启后达到阈值将强制终止施工回合并提醒用户，确定开启？')) return;
      } catch (err) { /* 无确认环境下直接保存 */ }
    }
    setRows(Object.assign({}, rows, patch));
    rpc('settings.set', patch).then(function (result) {
      if (result && result.ok) {
        setNote('已保存 · 下次审查按新值跑');
        refreshAll();
      } else {
        setNote('未保存：' + String((result && result.error && result.error.message) || '保存失败'));
      }
      setTimeout(function () { setNote(''); }, 2600);
    });
  }

  function ackSv(wsId) {
    rpc('notice.ack', wsId ? { workspaceId: wsId } : {})
      .then(function () { refreshAll(); })
      .catch(function () { /* 保持提醒可见，下次轮询重试 */ });
  }
  function ackAllSv() {
    var ids = [];
    notices.forEach(function (n) {
      if (n && n.workspaceId && ids.indexOf(n.workspaceId) < 0) ids.push(n.workspaceId);
    });
    if (!ids.length) {
      ackSv('');
      return;
    }
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return rpc('notice.ack', { workspaceId: id }).catch(function () { return null; });
      });
    });
    chain.then(function () { refreshAll(); });
  }

  // ---- 派生：工作区行 ----
  var wsRaw = SvmRowsOf(aux.ws) || SvmArr(over.workspaces);
  var reqRaw = SvmRowsOf(aux.req) || [];
  var jouRaw = SvmRowsOf(aux.jou) || SvmArr(over.journal);
  var heaVal = aux.hea || SvmObj(over.health);
  var reqCountByWs = {};
  var cActive = 0;
  var cHard = 0;
  var cSup = 0;
  var cRev = 0;
  reqRaw.forEach(function (r) {
    var wid = r.workspaceId || r.workspace || '';
    if (r.status === 'active' || !r.status) {
      cActive += 1;
      if (wid) reqCountByWs[wid] = (reqCountByWs[wid] || 0) + 1;
    }
    if (r.strength === 'hard') cHard += 1;
    if (r.status === 'superseded') cSup += 1;
    if (r.status === 'revoked') cRev += 1;
  });
  var wsRows = wsRaw.map(function (w, i) {
    w = SvmObj(w);
    var c = SvmObj(w.counters);
    var b = SvmObj(w.baseline || w.baselines);
    var id = w.workspaceId || w.id || w.workspace || ('ws' + i);
    return {
      id: id,
      short: shortWorkspace(id),
      baselineRevision: SvmPick(b, ['baselineRevision', 'revision']) != null ? SvmPick(b, ['baselineRevision', 'revision']) : SvmPick(w, ['baselineRevision', 'revision']),
      reviewCount: SvmPick(c, ['reviewCount']) != null ? SvmPick(c, ['reviewCount']) : SvmPick(w, ['reviewCount', 'reviews']),
      driftStreak: SvmPick(c, ['driftStreak', 'maxDriftStreak']) != null ? SvmPick(c, ['driftStreak', 'maxDriftStreak']) : SvmPick(w, ['driftStreak']),
      criticalCount: SvmPick(c, ['criticalCount']) != null ? SvmPick(c, ['criticalCount']) : SvmPick(w, ['criticalCount']),
      lastReviewAt: SvmPick(c, ['lastReviewAt']) || SvmPick(w, ['lastReviewAt']),
      lastStageSeq: SvmPick(c, ['lastStageSeq']) != null ? SvmPick(c, ['lastStageSeq']) : SvmPick(w, ['lastStageSeq']),
      lastVerdict: SvmPick(w, ['lastVerdict']) || SvmPick(c, ['lastVerdict']),
      sessionCount: SvmPick(w, ['sessionCount', '_sessions']),
      reqCount: reqCountByWs[id] || 0,
      pending: Boolean(SvmPick(c, ['pendingNotice']) || (w.pendingNotice)),
    };
  });
  var projectCount = wsRows.length || Number(over.workspaceCount) || 0;

  // ---- 派生：审查行（本地时间范围 + 搜索 + 排序） ----
  var usingSample = !rq.rows;
  var queryRows = rq.rows || sampleReviews;
  var nowMs = Date.now();
  var rangeMs = fs.range === '24h' ? 86400000 : fs.range === '7d' ? 604800000 : 0;
  var q = fs.q.trim().toLowerCase();
  var filtered = queryRows.filter(function (r) {
    if (rangeMs) {
      var t = new Date(r.createdAt).getTime();
      if (!Number.isFinite(t) || nowMs - t > rangeMs) return false;
    }
    if (!usingSample) {
      // 服务端已按 ws/verdict/engine 过滤，这里只补搜索词。
    } else {
      if (fs.ws && r.workspaceId !== fs.ws) return false;
      if (fs.verdict && r.verdict !== fs.verdict) return false;
      if (fs.engine && r.engine !== fs.engine) return false;
    }
    if (q) {
      var hay = String(r.summary || '') + '\n' + String(r.suggestion || '') + '\n'
        + String(r.workspaceId || '') + '\n' + String(r.stageSeq != null ? r.stageSeq : '') + '\n'
        + String(r.reviewId || r.id || '');
      if (hay.toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  });
  filtered.sort(function (a, b) {
    var ta = new Date(a.createdAt).getTime();
    var tb = new Date(b.createdAt).getTime();
    if (!Number.isFinite(ta)) ta = 0;
    if (!Number.isFinite(tb)) tb = 0;
    return tb - ta;
  });
  var verdictCounts = { aligned: 0, minor: 0, drift: 0, critical: 0, pending: 0 };
  filtered.forEach(function (r) {
    if (verdictCounts[r.verdict] !== undefined) verdictCounts[r.verdict] += 1;
    else verdictCounts.pending += 1;
  });
  var totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  var safePage = page > totalPages - 1 ? totalPages - 1 : page;
  var pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  // ---- 派生：审计链（prevHash 衔接校验） ----
  var jouSorted = jouRaw.slice(0).sort(function (a, b) {
    return (Number(a.seq) || 0) - (Number(b.seq) || 0);
  });
  var chain = {};
  for (var ci = 0; ci < jouSorted.length; ci += 1) {
    var cur = jouSorted[ci];
    if (ci === 0) {
      chain[cur.seq] = true;
    } else {
      var prev = jouSorted[ci - 1];
      chain[cur.seq] = !cur.prevHash || !prev.hash || cur.prevHash === prev.hash;
    }
  }
  var jouView = jouSorted.slice(0).reverse().slice(0, 20);
  var histRows = jouRaw.filter(function (j) { return j && j.type === 'settings_changed'; });

  var wsOptions = wsRows.map(function (w) { return { id: w.id, label: w.short }; });
  var echoBits = [];
  if (fs.ws) echoBits.push(shortWorkspace(fs.ws));
  if (fs.verdict) echoBits.push(verdictOf(fs.verdict).label);
  if (fs.engine) echoBits.push(SvmEngineLabel(fs.engine));
  if (fs.range !== 'all') echoBits.push(fs.range === '24h' ? '24小时' : '7天');
  if (q) echoBits.push('含“' + SvmClip(fs.q.trim(), 16) + '”');
  var echo = echoBits.length ? '已选：' + echoBits.join(' · ') : '共 ' + filtered.length + ' 条';

  function openReview(r) {
    setDw({ kind: 'review', review: r });
  }
  function pickWs(id) {
    setF({ view: 'review', ws: id, verdict: '', engine: '', q: '' });
  }

  var maxStreak = Number(counters.maxDriftStreak) || Number(SvmObj(thresholds.streak).maxStreak) || 0;
  var streakHot = Boolean(SvmObj(thresholds.streak).limit) && maxStreak >= Number(SvmObj(thresholds.streak).limit);

  var policyCard = React.createElement(SvmPolicy, {
    val: valSv, save: saveSv, draft: draftSv, note: note, histRows: histRows,
  });

  var mainList = fs.view === 'review'
    ? React.createElement(SvmReviewTable, {
      pageRows: pageRows, total: filtered.length, page: safePage, pageSize: pageSize,
      onPage: function (p) { setPage(Math.max(0, p)); },
      onSize: function (s) { setPageSize(s); setPage(0); },
      onOpen: openReview, loading: rq.loading, usingSample: usingSample,
      rqErr: rq.err, qActive: Boolean(q || fs.ws || fs.verdict || fs.engine || rangeMs),
    })
    : fs.view === 'project'
    ? React.createElement(SvmProjectMatrix, {
      rows: wsRows, onPick: pickWs, loading: !aux.ws && !data,
      wsErr: aux.wsErr && !wsRows.length ? aux.wsErr : '',
      streakLimit: num(SvmObj(thresholds.streak).limit, '—'),
      critLimit: num(SvmObj(thresholds.critical).limit, '—'),
    })
    : policyCard;

  var drawer = null;
  if (dw) {
    var dwTitle = '详情';
    var dwBody = null;
    if (dw.kind === 'review') {
      dwTitle = '审查 #' + num(dw.review.stageSeq) + ' · ' + shortWorkspace(dw.review.workspaceId);
      dwBody = React.createElement(SvmReviewBody, { rpc: rpc, review: dw.review });
    } else if (dw.kind === 'req') {
      dwTitle = '要求 · ' + SvmClip(dw.req.reqId || dw.req.id, 18);
      dwBody = React.createElement(SvmReqBody, { req: dw.req });
    } else if (dw.kind === 'base') {
      dwTitle = '基线 · ' + shortWorkspace(dw.base.workspaceId) + ' r' + num(dw.base.revision);
      dwBody = React.createElement(SvmBaseBody, { base: dw.base });
    } else if (dw.kind === 'journal') {
      dwTitle = '审计事件 #' + num(dw.journal.seq);
      dwBody = React.createElement(SvmJournalBody, { journal: dw.journal });
    }
    drawer = React.createElement(
      SvmDrawer,
      { title: dwTitle, onClose: function () { setDw(null); } },
      dwBody,
    );
  }

  return React.createElement(
    'div',
    { className: 'svm-root', 'data-supervisor-main': '1' },
    React.createElement('style', null, SvmCss),
    React.createElement(
      'div',
      { className: 'svm-col' },
      React.createElement(SvmMast, {
        data: data, projectCount: projectCount, pendingCount: pendingCount,
        viewError: view.error, onRefresh: refreshAll, wsErr: aux.wsErr,
      }),
      React.createElement(SvmBanner, { storage: over.storage, notices: notices, onAck: ackSv }),
      React.createElement(SvmTape, {
        counters: counters, thresholds: thresholds, verdicts: fixed, alignTotal: alignTotal,
        maxStreak: maxStreak, streakHot: streakHot, pendingCount: pendingCount,
        projectCount: projectCount, baselineCount: baselines.length,
      }),
      React.createElement(SvmTools, {
        fs: fs, onF: setF, wsOptions: wsOptions, verdictCounts: verdictCounts, echo: echo,
      }),
      React.createElement(
        'div',
        { className: 'svm-work' },
        React.createElement(
          'div',
          { className: 'svm-main' },
          mainList,
          React.createElement(SvmReqs, {
            pageRows: reqRaw.slice(0, 60), total: reqRaw.length,
            cActive: cActive, cHard: cHard, cSup: cSup, cRev: cRev,
            loading: !aux.req && !data, reqErr: aux.reqErr && !reqRaw.length ? aux.reqErr : '',
            onOpen: function (r) { setDw({ kind: 'req', req: r }); },
          }),
          React.createElement(SvmBases, {
            baselines: baselines,
            onOpen: function (b) { setDw({ kind: 'base', base: b }); },
          }),
          fs.view === 'settings' ? null : policyCard,
          React.createElement(SvmAudit, {
            rows: jouView, chain: chain, loading: !aux.jou && !data,
            jouErr: aux.jouErr && !jouView.length ? aux.jouErr : '',
            storage: over.storage, health: heaVal,
            nReviews: counters.reviewCount, nReqs: reqRaw.length,
            onOpen: function (j) { setDw({ kind: 'journal', journal: j }); },
          }),
        ),
        React.createElement(SvmRail, {
          notices: notices, onAck: ackSv, onAckAll: ackAllSv,
          settings: settings, mr: mr, thresholds: thresholds,
          verdicts: fixed, alignTotal: alignTotal,
          baselines: baselines, storage: over.storage, health: heaVal,
        }),
      ),
    ),
    drawer,
  );
}


  function buildPlugin(ctx) {
    var rpc = makeRpc(ctx)
    var mounted = []
    var styleDispose = null
    var styles0 = styleHost
    if (!styles0 || typeof styles0.insert !== 'function') styles0 = serviceOf(ctx, 'styles')
    beacon('styles-head', 'v1.5.0 standalone mounted')

    function mount(slot, entry, component) {
      try {
        var off = ctx.slots.inject(slot, function () {
          return ctx.slots.register(entry, component)
        })
        mounted.push(off)
      } catch (err) {
        beacon('mount-failed', slot + ': ' + String((err && err.message) || err))
      }
    }

    mount('sidebar.panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 51, label: '天监' }, function Icon() {
      return React.createElement(Seal, { size: 18, mono: true })
    })
    mount('main', { name: 'main', key: PANEL_ID }, function Main(props) {
      return guarded(React.createElement(SupervisorMain, Object.assign({}, props, { rpc: rpc })))
    })
    mount('conversation.input.dock', { name: 'conversation.input.dock', id: PANEL_ID, order: 40 }, function Pill(props) {
      return React.createElement(DockEntry, Object.assign({}, props, { rpc: rpc }))
    })
    mount('conversation.view', { name: 'conversation.view', id: VIEW_ID, order: 40, label: '天监' }, function View(props) {
      return React.createElement(TabEntry, Object.assign({}, props, { rpc: rpc }))
    })

    var offBetterSidebar = mountBetterSidebar(ctx, rpc)

    beacon('applied', mounted.length + ' surfaces')
    return function () {
      try {
        offBetterSidebar()
      } catch (err) {
        /* ignore */
      }
      try {
        if (styleDispose) styleDispose()
      } catch (err) {
        /* ignore */
      }
    }
  }

  function factory(require0) {
    try {
      if (require0) React = require0('react')
    } catch (err) {
      React = null
    }
    if (!React || typeof React.createElement !== 'function' || typeof React.useState !== 'function') {
      // Without React the module must still load: a throwing entry takes the whole
      // web bundle down, and a supervisor is never worth that.
      return { inject: [], apply: function () {} }
    }

    beacon('factory-start', CLIENT_BUILD)

    return {
      inject: ['slots'],
      apply: function (ctx) {
        try {
          beacon('apply-start', CLIENT_BUILD)
          return buildPlugin(ctx)
        } catch (err) {
          beacon('apply-failed', String((err && err.message) || err))
        }
      },
    }
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: 'dsh-supervisor', factory: factory })
  }
})()

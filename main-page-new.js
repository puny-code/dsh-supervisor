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

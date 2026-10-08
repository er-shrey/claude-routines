/* global marked, api */
const $ = (sel, root = document) => root.querySelector(sel);
const viewEl = $('#view');

const state = {
  routines: [],
  approvals: [],
  view: { name: 'home' },
  openTools: new Set(),
  lastRenderKey: '',
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: { html: (token) => esc(token.text ?? token.raw ?? '') },
});
const md = (text) => marked.parse(String(text || ''));

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleText(s = {}) {
  if (s.type === 'calendar') {
    const days = (s.weekdays || []).map(Number).sort();
    const when =
      days.length === 0 || days.length === 7
        ? 'Daily'
        : days.join() === '1,2,3,4,5'
          ? 'Weekdays'
          : days.join() === '0,6'
            ? 'Weekends'
            : days.map((d) => DAYS[d]).join(', ');
    return `${when} at ${s.time || '09:00'}`;
  }
  const m = Number(s.minutes || 5);
  if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
  return m === 1 ? 'Every minute' : `Every ${m} min`;
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function duration(meta) {
  if (!meta) return '—';
  const ms = meta.durationMs ?? (meta.endedAt ? Date.parse(meta.endedAt) - Date.parse(meta.startedAt) : Date.now() - Date.parse(meta.startedAt));
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const cost = (v) => (typeof v === 'number' ? `$${v.toFixed(v < 0.1 ? 4 : 2)}` : '—');
const STATUS_LABELS = { waiting: 'waiting for approval' };
const statusPill = (status) => `<span class="pill ${esc(status)}">${esc(STATUS_LABELS[status] || status || 'never run')}</span>`;

// Why a run ended without a normal result, in plain words.
function failureReason(m) {
  if (!m || m.status === 'running') return '';
  if (m.resultSubtype === 'error_max_turns') return `Stopped after reaching the max turns limit (${m.numTurns ?? '?'} turns). Raise Max turns in Edit.`;
  if (m.resultSubtype === 'error_during_execution') return 'Claude hit an error during the run. See the transcript and stderr.';
  if (m.status === 'timeout') return 'Stopped by the run timeout. Raise Run timeout in Edit.';
  if (m.status === 'stopped') return 'Stopped by you.';
  if (m.status === 'error' && !m.resultText && !m.runnerError) return `claude exited with code ${m.exitCode ?? '?'}. See stderr.`;
  return '';
}

// Pending approvals for one run.
const runApprovals = (routineId, runId) => state.approvals.filter((a) => a.routineId === routineId && a.runId === runId);

// A running run that's blocked on an approval shows as "waiting".
function displayStatus(run) {
  if (!run) return '';
  return run.status === 'running' && runApprovals(run.routineId, run.id).length ? 'waiting' : run.status;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Suggest a reusable allow rule: "gh pr list --json x" -> "Bash(gh pr:*)"
function suggestPattern(toolName, input = {}) {
  if (toolName === 'Bash' && input.command) {
    const words = String(input.command).trim().split(/\s+/);
    const prefix = words[1] && !words[1].startsWith('-') && !/[|;&>]/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${prefix}:*)`;
  }
  return toolName;
}

function toolArgPreview(name, input = {}) {
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return input.description;
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

// ---------- navigation ----------

function go(view) {
  state.view = view;
  state.lastRenderKey = '';
  if (view.name !== 'run') state.openTools.clear();
  render();
}

async function refreshRoutines() {
  state.routines = await api.listRoutines();
  renderSidebar();
}

function renderSidebar() {
  const list = $('#routine-list');
  const v = state.view;
  if (!state.routines.length) {
    list.innerHTML = `<div class="empty-side">No routines yet.</div>`;
  } else {
    list.innerHTML = state.routines
      .map((r) => {
        const status = displayStatus(r.lastRun);
        const active = (v.name === 'routine' || v.name === 'run' || v.name === 'edit') && v.id === r.id;
        return `<button class="routine-item ${active ? 'active' : ''} ${r.enabled ? '' : 'disabled'}" data-action="open-routine" data-id="${esc(r.id)}">
          <span class="dot ${esc(status)}"></span>
          <span class="ri-body">
            <div class="ri-name">${esc(r.name)}</div>
            <div class="ri-sub">${r.enabled ? esc(scheduleText(r.schedule)) : 'Paused'}${r.lastRun ? ` · ${ago(r.lastRun.startedAt)}` : ''}</div>
          </span>
        </button>`;
      })
      .join('');
  }
  const badge = $('#approval-badge');
  badge.hidden = !state.approvals.length;
  badge.textContent = state.approvals.length;
  $('#nav-approvals').classList.toggle('active', v.name === 'approvals');
  $('#nav-settings').classList.toggle('active', v.name === 'settings');
  $('#nav-help').classList.toggle('active', v.name === 'help');
}

async function render() {
  renderSidebar();
  const v = state.view;
  if (v.name === 'routine') return renderRoutine(v.id);
  if (v.name === 'run') return renderRun(v.id, v.runId);
  if (v.name === 'edit') return renderEditor(v.id);
  if (v.name === 'approvals') return renderApprovals();
  if (v.name === 'settings') return renderSettings();
  if (v.name === 'help') return renderHelp(v.section);
  return renderHome();
}

// ---------- home ----------

function renderHome() {
  if (state.routines.length) return go({ name: 'routine', id: state.routines[0].id });
  viewEl.innerHTML = `<div class="view-inner">
    <div class="empty">
      <h2>No routines yet</h2>
      <p>A routine is a prompt or skill file that Claude Code runs headless on a schedule, using your Claude subscription.</p>
      <button class="btn primary" data-action="new-routine">Create your first routine</button>
    </div>
  </div>`;
}

// ---------- routine detail ----------

async function renderRoutine(id) {
  const [r, runs] = await Promise.all([api.getRoutine(id), api.listRuns(id)]);
  if (state.view.name !== 'routine' || state.view.id !== id) return;
  if (!r) return go({ name: 'home' });
  const key = JSON.stringify([r, runs, state.approvals.map((a) => a.id), Math.floor(Date.now() / 30000)]);
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;

  const running = runs.find((x) => x.status === 'running');
  const last = runs[0];
  const pending = state.approvals.filter((a) => a.routineId === id);
  const loadedNote = r.enabled ? (r.loaded ? 'Scheduled in launchd' : 'Not loaded in launchd, try saving again') : 'Paused';

  viewEl.innerHTML = `<div class="view-inner">
    <div class="page-head">
      <div>
        <h1>${esc(r.name)}</h1>
        <div class="sub">${esc(r.description || '')}</div>
      </div>
      <div class="actions">
        <label class="toggle" title="${r.enabled ? 'Pause schedule' : 'Resume schedule'}">
          <input type="checkbox" data-action="toggle-enabled" data-id="${esc(id)}" ${r.enabled ? 'checked' : ''} /><span></span>
        </label>
        <button class="btn" data-action="edit-routine" data-id="${esc(id)}">Edit</button>
        <button class="btn" data-action="open-log" data-id="${esc(id)}">Scheduler log</button>
        <button class="btn primary" data-action="run-now" data-id="${esc(id)}" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run now'}</button>
      </div>
    </div>

    ${pending.length ? `<div class="callout warn section">${pending.length} permission request${pending.length > 1 ? 's' : ''} waiting. <a href="#" data-action="open-run" data-id="${esc(id)}" data-run="${esc(pending[0].runId)}">Review now</a></div>` : ''}

    <div class="grid">
      <div class="card">
        <div class="stat-label">Schedule</div>
        <div class="stat-value">${esc(scheduleText(r.schedule))}</div>
        <div class="stat-note">${esc(loadedNote)}</div>
      </div>
      <div class="card">
        <div class="stat-label">Last run</div>
        <div class="stat-value">${last ? statusPill(displayStatus(last)) : '—'}</div>
        <div class="stat-note">${last ? `${ago(last.startedAt)} · ${duration(last)}` : 'Never run'}</div>
      </div>
      <div class="card">
        <div class="stat-label">Last pre-check</div>
        <div class="stat-value">${r.precheck ? ago(r.state.lastCheckAt) : 'None set'}</div>
        <div class="stat-note">${r.state.lastSkipAt ? `Skipped ${ago(r.state.lastSkipAt)}: ${esc(r.state.lastSkipReason || '')}` : r.precheck ? 'No skips yet' : 'Runs every time'}</div>
      </div>
      <div class="card">
        <div class="stat-label">Runs kept</div>
        <div class="stat-value">${runs.length}</div>
        <div class="stat-note">Total cost ${cost(runs.reduce((s, x) => s + (x.costUsd || 0), 0))} (subscription usage estimate)</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Configuration</div>
      <div class="card">
        <div class="form-row">
          <div><div class="stat-label">Working directory</div><div class="mono">${esc(r.cwd)}</div></div>
          <div><div class="stat-label">Model / max turns</div><div>${esc(r.model || 'Account default')} · ${r.maxTurns} turns</div></div>
          <div><div class="stat-label">Permission mode</div><div>${esc(r.permissionMode)}</div></div>
        </div>
        <div style="margin-top:12px"><div class="stat-label">Allowed tools</div>
          <div>${r.allowedTools.length ? r.allowedTools.map((t) => `<span class="pill mono">${esc(t)}</span>`).join(' ') : '<span class="muted">None. Anything that needs permission will ask in Approvals.</span>'}</div>
        </div>
        ${r.precheck ? `<div style="margin-top:12px"><div class="stat-label">Pre-check</div><div class="mono">${esc(r.precheck)}</div></div>` : ''}
        <details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Prompt</summary><div class="markdown">${md(r.prompt)}</div></details>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Run history</div>
      ${
        runs.length
          ? `<table class="runs">
        <thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Duration</th><th>Turns</th><th>Cost</th><th>Result</th></tr></thead>
        <tbody>${runs
          .map(
            (x) => `<tr data-action="open-run" data-id="${esc(id)}" data-run="${esc(x.id)}">
          <td>${fmtTime(x.startedAt)}</td>
          <td>${statusPill(displayStatus(x))}</td>
          <td class="muted">${esc(x.trigger)}</td>
          <td>${duration(x)}</td>
          <td>${x.numTurns ?? '—'}</td>
          <td>${cost(x.costUsd)}</td>
          <td class="muted" style="max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((x.resultText || x.runnerError || failureReason(x)).slice(0, 140))}${x.permissionDenials?.length ? ` <span class="pill warn">${x.permissionDenials.length} denied</span>` : ''}</td>
        </tr>`,
          )
          .join('')}</tbody></table>`
          : `<div class="empty">No runs yet. Click <b>Run now</b> to try it.</div>`
      }
    </div>
  </div>`;
}

// ---------- run detail ----------

function renderTimeline(events) {
  const results = new Map();
  for (const ev of events) {
    if (ev.type !== 'user') continue;
    for (const c of ev.message?.content || []) if (c.type === 'tool_result') results.set(c.tool_use_id, c);
  }
  const out = [];
  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      const servers = (ev.mcp_servers || []).map((s) => `${s.name} (${s.status})`).join(', ');
      out.push(`<div class="ev system">Session started · model <b>${esc(ev.model)}</b> · permission mode ${esc(ev.permissionMode)} · ${ev.tools?.length || 0} tools${servers ? ` · MCP: ${esc(servers)}` : ''}</div>`);
    } else if (ev.type === 'assistant') {
      const parts = (ev.message?.content || [])
        .map((c) => {
          if (c.type === 'text' && c.text.trim()) return `<div class="markdown">${md(c.text)}</div>`;
          if (c.type === 'tool_use') {
            const res = results.get(c.id);
            const open = state.openTools.has(c.id) ? 'open' : '';
            const resText = res ? toolResultText(res.content) : '';
            return `<details class="tool" data-tool="${esc(c.id)}" ${open}>
              <summary><span class="tool-name">${esc(c.name)}</span><span class="tool-arg">${esc(toolArgPreview(c.name, c.input))}</span>
              ${res ? (res.is_error ? '<span class="pill error">error</span>' : '<span class="pill success">done</span>') : '<span class="pill running">waiting</span>'}</summary>
              <pre>${esc(JSON.stringify(c.input, null, 2))}</pre>
              ${res ? `<pre class="${res.is_error ? 'err' : ''}">${esc(resText.length > 20000 ? resText.slice(0, 20000) + '\n… (truncated)' : resText)}</pre>` : ''}
            </details>`;
          }
          return '';
        })
        .join('');
      if (parts) out.push(`<div class="ev"><div class="ev-head"><span class="who">Claude</span></div>${parts}</div>`);
    }
  }
  return out.join('') || '<div class="muted">No events yet.</div>';
}

async function renderRun(id, runId) {
  const run = await api.getRun(id, runId);
  if (state.view.name !== 'run' || state.view.runId !== runId) return;
  const m = run.meta;
  if (!m) {
    viewEl.innerHTML = `<div class="view-inner"><div class="empty">This run no longer exists.</div></div>`;
    return;
  }
  const pending = runApprovals(id, runId);
  const key = JSON.stringify([m, run.events.length, run.stderr.length, pending.map((a) => a.id)]);
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;
  const scroll = viewEl.scrollTop;
  const routine = state.routines.find((r) => r.id === id);
  const denials = m.permissionDenials || [];

  viewEl.innerHTML = `<div class="view-inner">
    <div class="crumb"><a data-action="open-routine" data-id="${esc(id)}">${esc(routine?.name || id)}</a> / run</div>
    <div class="page-head">
      <div>
        <h1>${fmtTime(m.startedAt)} ${statusPill(displayStatus(m))}</h1>
        <div class="sub">${esc(m.trigger)} run · ${duration(m)} · ${m.numTurns ?? '—'} turns · ${cost(m.costUsd)}${m.model ? ` · ${esc(m.model)}` : ''}</div>
      </div>
      <div class="actions">
        ${m.status === 'running' ? `<button class="btn danger" data-action="stop-run" data-id="${esc(id)}" data-run="${esc(runId)}">Stop</button>` : ''}
        <button class="btn" data-action="open-path" data-path="${esc(run.dir)}">Open run folder</button>
        <button class="btn" data-action="run-now" data-id="${esc(id)}">Run again</button>
      </div>
    </div>

    ${
      pending.length
        ? `<div class="section"><div class="section-title">Waiting for your approval</div>${pending.map((a) => approvalCard(a, false)).join('')}</div>`
        : ''
    }
    ${m.runnerError ? `<div class="callout err section">Runner error: ${esc(m.runnerError)}</div>` : ''}
    ${failureReason(m) && !m.resultText ? `<div class="callout ${m.status === 'stopped' ? 'warn' : 'err'} section">${esc(failureReason(m))}</div>` : ''}
    ${
      /Failed to authenticate|401|OAuth access token/i.test(m.resultText || '')
        ? `<div class="callout err section"><b>The Claude CLI isn't signed in.</b> Scheduled runs use the CLI's login, which is separate from the desktop app's.
           Fix it either way:<br>1. In Terminal run <span class="mono">claude</span>, then <span class="mono">/login</span> and pick your subscription account.<br>
           2. Better for schedules: run <span class="mono">claude setup-token</span> and paste the token into <a href="#" data-action="nav-settings">Settings</a>. It lasts a year and isn't affected when you sign in again elsewhere.</div>`
        : ''
    }

    ${
      denials.length
        ? `<div class="section"><div class="card" style="border-color:var(--warn)">
        <h3>${denials.length} tool call${denials.length > 1 ? 's were' : ' was'} denied</h3>
        <div class="muted" style="margin-bottom:8px">Add rules to the routine's allowed tools so they're allowed without asking next time. You can edit each rule first.</div>
        ${denials
          .map(
            (d, i) => `<div class="denial">
          <input type="checkbox" checked data-denial="${i}" />
          <input type="text" value="${esc(suggestPattern(d.tool_name, d.tool_input))}" data-denial-pattern="${i}" />
          <span class="faint mono" style="max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(toolArgPreview(d.tool_name, d.tool_input))}</span>
        </div>`,
          )
          .join('')}
        <div style="margin-top:8px"><button class="btn primary" data-action="allow-rerun" data-id="${esc(id)}">Allow selected and re-run</button></div>
      </div></div>`
        : ''
    }

    ${
      m.resultText
        ? `<div class="section"><div class="section-title">Result</div><div class="result-box markdown">${md(m.resultText)}</div></div>`
        : ''
    }

    <div class="section">
      <div class="section-title">Transcript <span class="muted" style="font-weight:400">${run.events.length} events</span></div>
      <div class="timeline">${renderTimeline(run.events)}</div>
    </div>

    ${run.stderr.trim() ? `<div class="section"><div class="section-title">stderr</div><pre class="log">${esc(run.stderr)}</pre></div>` : ''}

    <div class="section">
      <details><summary class="muted" style="cursor:pointer">Prompt sent and command</summary>
        <pre class="log" style="margin-top:8px">${esc(run.prompt)}</pre>
        <pre class="log" style="margin-top:8px">${esc(m.command || '')}\ncwd: ${esc(m.cwd || '')}${m.sessionId ? `\nsession: ${esc(m.sessionId)}` : ''}</pre>
      </details>
    </div>
  </div>`;
  viewEl.scrollTop = scroll;
}

// ---------- editor ----------

async function renderEditor(id) {
  const cfg = await api.getConfig();
  const r = id
    ? await api.getRoutine(id)
    : {
        name: '',
        description: '',
        enabled: true,
        schedule: { type: 'interval', minutes: 5 },
        cwd: cfg.home ? cfg.home.replace(/\/\.claude-routines$/, '') : '',
        allowedTools: [...(cfg.defaults.allowedTools || [])],
        disallowedTools: [...(cfg.defaults.disallowedTools || [])],
        permissionMode: cfg.defaults.permissionMode,
        model: cfg.defaults.model,
        maxTurns: cfg.defaults.maxTurns,
        timeoutMinutes: cfg.defaults.timeoutMinutes,
        approvalTimeoutSec: cfg.defaults.approvalTimeoutSec,
        precheck: '',
        mcpConfigPath: '',
        keepRuns: 300,
        prompt: '',
      };
  const s = r.schedule || { type: 'interval', minutes: 5 };
  const days = new Set((s.weekdays || []).map(Number));

  viewEl.innerHTML = `<div class="view-inner">
    <div class="crumb">${id ? `<a data-action="open-routine" data-id="${esc(id)}">${esc(r.name)}</a> / edit` : 'New routine'}</div>
    <div class="page-head"><div><h1>${id ? 'Edit routine' : 'New routine'}</h1></div></div>
    <form class="form" id="routine-form">
      <fieldset>
        <legend>Basics</legend>
        <div class="form">
          <div class="form-row">
            <div class="field"><label>Name</label><input type="text" name="name" required value="${esc(r.name)}" placeholder="PR watcher" /></div>
            <div class="field"><label>Description</label><input type="text" name="description" value="${esc(r.description)}" placeholder="Optional" /></div>
          </div>
          <div class="field">
            <label>Working directory</label>
            <div class="input-with-btn"><input type="text" name="cwd" required value="${esc(r.cwd)}" /><button type="button" class="btn" data-action="pick-folder">Choose…</button></div>
            <span class="hint">Claude runs here, so it picks up that folder's CLAUDE.md, .claude/settings.json and skills.</span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Prompt or skill</legend>
        <div class="form">
          <div class="prompt-toolbar">
            <span class="hint">Write the task in Markdown, upload a .md file, or drop a SKILL.md here. YAML frontmatter is removed before the prompt is sent.</span>
            <button type="button" class="btn" data-action="upload-md">Upload .md</button>
          </div>
          <div class="dropzone" id="dropzone"><textarea class="prompt" name="prompt" required placeholder="# Check new PRs&#10;&#10;List open PRs updated in the last 10 minutes and summarise anything that needs my review…">${esc(r.prompt)}</textarea></div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Schedule</legend>
        <div class="form">
          <div class="seg" id="sched-type">
            <button type="button" data-type="interval" class="${s.type !== 'calendar' ? 'on' : ''}">Every N minutes</button>
            <button type="button" data-type="calendar" class="${s.type === 'calendar' ? 'on' : ''}">At a time of day</button>
          </div>
          <input type="hidden" name="scheduleType" value="${s.type === 'calendar' ? 'calendar' : 'interval'}" />
          <div class="form-row" id="sched-interval" ${s.type === 'calendar' ? 'hidden' : ''}>
            <div class="field"><label>Interval (minutes)</label><input type="number" name="minutes" min="1" value="${esc(s.minutes || 5)}" />
            <span class="hint">launchd has no minimum. Runs don't fire while the Mac is asleep.</span></div>
          </div>
          <div class="form" id="sched-calendar" ${s.type === 'calendar' ? '' : 'hidden'}>
            <div class="field" style="max-width:160px"><label>Time</label><input type="time" name="time" value="${esc(s.time || '09:00')}" /></div>
            <div class="field"><label>Days (none selected = every day)</label>
              <div class="weekdays">${DAYS.map((d, i) => `<label class="${days.has(i) ? 'on' : ''}"><input type="checkbox" name="weekday" value="${i}" ${days.has(i) ? 'checked' : ''} />${d}</label>`).join('')}</div>
            </div>
          </div>
          <div class="field">
            <label>Pre-check command (optional)</label>
            <input type="text" name="precheck" class="mono" value="${esc(r.precheck)}" placeholder='test -n "$(gh pr list --search "updated:>=$(date -v-10M +%FT%T)" --json number -q ".[]")"' />
            <span class="hint">A shell command run first, without Claude. If it exits non-zero the run is skipped and uses no usage. Its stdout is appended to the prompt.</span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Permissions</legend>
        <div class="form">
          <div class="form-row">
            <div class="field"><label>Allowed tools (one per line)</label><textarea name="allowedTools" rows="5" placeholder="Read&#10;Grep&#10;Bash(gh pr list:*)">${esc(r.allowedTools.join('\n'))}</textarea>
              <span class="hint">Allowed without asking. Anything else waits for you in Approvals.</span></div>
            <div class="field"><label>Disallowed tools (one per line)</label><textarea name="disallowedTools" rows="5" placeholder="Bash(rm:*)&#10;WebFetch">${esc((r.disallowedTools || []).join('\n'))}</textarea>
              <span class="hint">Always blocked, never asked.</span></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Permission mode</label>
              <select name="permissionMode">
                ${['default', 'acceptEdits', 'plan'].map((p) => `<option value="${p}" ${r.permissionMode === p ? 'selected' : ''}>${p}</option>`).join('')}
              </select></div>
            <div class="field"><label>Approval timeout (seconds)</label><input type="number" name="approvalTimeoutSec" min="10" value="${esc(r.approvalTimeoutSec)}" />
              <span class="hint">If nobody answers in time, the tool call is denied.</span></div>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Advanced</legend>
        <div class="form">
          <div class="form-row">
            <div class="field"><label>Model</label>
              <select name="model">
                ${[['', 'Account default'], ['haiku', 'Haiku (cheapest)'], ['sonnet', 'Sonnet'], ['opus', 'Opus']].map(([v, l]) => `<option value="${v}" ${r.model === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></div>
            <div class="field"><label>Max turns</label><input type="number" name="maxTurns" min="1" value="${esc(r.maxTurns)}" /></div>
            <div class="field"><label>Run timeout (minutes)</label><input type="number" name="timeoutMinutes" min="1" value="${esc(r.timeoutMinutes)}" /></div>
            <div class="field"><label>Runs to keep</label><input type="number" name="keepRuns" min="10" value="${esc(r.keepRuns)}" /></div>
          </div>
          <div class="field">
            <label>MCP config file (optional)</label>
            <div class="input-with-btn"><input type="text" name="mcpConfigPath" class="mono" value="${esc(r.mcpConfigPath)}" placeholder="/path/to/mcp.json" /><button type="button" class="btn" data-action="pick-json">Choose…</button></div>
            <span class="hint">For Slack, Jira and other connectors. Desktop connectors don't carry over to headless runs.</span>
          </div>
        </div>
      </fieldset>

      <div class="form-footer">
        ${id ? `<button type="button" class="btn danger" data-action="delete-routine" data-id="${esc(id)}" style="margin-right:auto">Delete routine</button>` : ''}
        <button type="button" class="btn" data-action="${id ? 'open-routine' : 'home'}" data-id="${esc(id || '')}">Cancel</button>
        <button type="submit" class="btn primary">${id ? 'Save changes' : 'Create routine'}</button>
      </div>
    </form>
  </div>`;

  const form = $('#routine-form');

  $('#sched-type').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    form.scheduleType.value = b.dataset.type;
    for (const x of $('#sched-type').children) x.classList.toggle('on', x === b);
    $('#sched-interval').hidden = b.dataset.type !== 'interval';
    $('#sched-calendar').hidden = b.dataset.type !== 'calendar';
  });
  form.querySelectorAll('.weekdays input').forEach((cb) =>
    cb.addEventListener('change', () => cb.parentElement.classList.toggle('on', cb.checked)),
  );

  const loadMarkdown = (name, content) => {
    form.prompt.value = content;
    const fm = parseFrontmatter(content);
    if (!form.name.value.trim()) form.name.value = fm.name || name.replace(/\.(md|markdown|txt)$/i, '');
    if (!form.description.value.trim() && fm.description) form.description.value = fm.description;
    toast(`Loaded ${name}`);
  };
  form._loadMarkdown = loadMarkdown;

  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) loadMarkdown(file.name, await file.text());
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form;
    const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    const schedule =
      f.scheduleType.value === 'calendar'
        ? { type: 'calendar', time: f.time.value || '09:00', weekdays: [...f.querySelectorAll('input[name=weekday]:checked')].map((x) => Number(x.value)) }
        : { type: 'interval', minutes: Math.max(1, Number(f.minutes.value) || 5) };
    const input = {
      ...(id ? r : {}),
      id: id || undefined,
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      cwd: f.cwd.value.trim(),
      prompt: f.prompt.value,
      schedule,
      precheck: f.precheck.value.trim(),
      allowedTools: lines(f.allowedTools.value),
      disallowedTools: lines(f.disallowedTools.value),
      permissionMode: f.permissionMode.value,
      approvalTimeoutSec: Number(f.approvalTimeoutSec.value) || 600,
      model: f.model.value,
      maxTurns: Number(f.maxTurns.value) || 15,
      timeoutMinutes: Number(f.timeoutMinutes.value) || 30,
      keepRuns: Number(f.keepRuns.value) || 300,
      mcpConfigPath: f.mcpConfigPath.value.trim(),
    };
    for (const k of ['loaded', 'state', 'lastRun']) delete input[k];
    try {
      const saved = await api.saveRoutine(input);
      await refreshRoutines();
      toast(id ? 'Saved' : 'Routine created and scheduled');
      go({ name: 'routine', id: saved.id });
    } catch (err) {
      toast(`Save failed: ${err.message}`);
    }
  });
}

// ---------- approvals ----------

function approvalCard(a, showRoutine) {
  return `<div class="approval" data-approval="${esc(a.id)}">
    <div class="approval-head">
      <div><div class="title">${showRoutine ? `${esc(a.routineName)} wants` : 'Claude wants'} to use <span class="mono">${esc(a.toolName)}</span></div>
      <div class="muted" style="font-size:12px">Requested ${ago(a.requestedAt)} · auto-denies at ${fmtTime(a.expiresAt)}${showRoutine ? ` · <a href="#" data-action="open-run" data-id="${esc(a.routineId)}" data-run="${esc(a.runId)}">view run</a>` : ''}</div></div>
    </div>
    <pre>${esc(a.input && a.input.command ? a.input.command : JSON.stringify(a.input, null, 2))}</pre>
    <div class="approval-actions">
      <button class="btn ok" data-action="decide" data-behavior="allow" data-id="${esc(a.id)}">Allow once</button>
      <input type="text" value="${esc(suggestPattern(a.toolName, a.input))}" data-pattern-for="${esc(a.id)}" title="Rule added to the routine's allowed tools" />
      <button class="btn" data-action="decide" data-behavior="always" data-id="${esc(a.id)}">Always allow this rule</button>
      <button class="btn danger" data-action="decide" data-behavior="deny" data-id="${esc(a.id)}">Deny</button>
    </div>
  </div>`;
}

function renderApprovals() {
  const list = state.approvals;
  const key = JSON.stringify(list.map((a) => a.id));
  // Don't wipe an input the user is typing into on a periodic refresh.
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;
  viewEl.innerHTML = `<div class="view-inner">
    <div class="page-head"><div><h1>Approvals</h1><div class="sub">Tool calls that running routines are waiting on. The run pauses until you decide or the timeout passes.</div></div></div>
    ${
      list.length
        ? list
            .map((a) => approvalCard(a, true))
            .join('')
        : `<div class="empty"><h2>Nothing waiting</h2><p>When a routine tries a tool that isn't in its allowed list, it shows up here and as a macOS notification.</p></div>`
    }
  </div>`;
}

// Settings live in settings.js.

// ---------- event delegation ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, run } = el.dataset;
  if (el.tagName === 'A') e.preventDefault();

  switch (action) {
    case 'new-routine':
      return go({ name: 'edit', id: null });
    case 'home':
      return go({ name: 'home' });
    case 'open-routine':
      return go({ name: 'routine', id });
    case 'edit-routine':
      return go({ name: 'edit', id });
    case 'open-run':
      return go({ name: 'run', id, runId: run });
    case 'nav-settings':
      return go({ name: 'settings' });
    case 'nav-approvals':
      return go({ name: 'approvals' });
    case 'run-now':
      await api.runNow(id);
      toast('Run started');
      setTimeout(async () => {
        const [latest] = await api.listRuns(id);
        await refreshRoutines();
        if (latest && latest.status === 'running') go({ name: 'run', id, runId: latest.id });
        else go({ name: 'routine', id });
      }, 1500);
      return;
    case 'stop-run':
      await api.stopRun(id, run);
      toast('Stopping…');
      return;
    case 'delete-routine':
      if (await api.deleteRoutine(id)) {
        await refreshRoutines();
        go({ name: 'home' });
      }
      return;
    case 'open-log':
      return api.openLog(id);
    case 'open-path':
      return api.openPath(el.dataset.path);
    case 'pick-folder': {
      const form = $('#routine-form');
      const dir = await api.pickFolder(form.cwd.value);
      if (dir) form.cwd.value = dir;
      return;
    }
    case 'pick-json': {
      const file = await api.pickJson();
      if (file) $('#routine-form').mcpConfigPath.value = file;
      return;
    }
    case 'upload-md': {
      const file = await api.pickMarkdown();
      if (file) $('#routine-form')._loadMarkdown(file.name, file.content);
      return;
    }
    case 'reprobe': {
      const p = await api.probeShell();
      const form = $('#claude-form');
      if (p.claudePath) form.claudePath.value = p.claudePath;
      if (p.pathEnv) form.pathEnv.value = p.pathEnv;
      toast('Detected. Save to apply.');
      return;
    }
    case 'allow-rerun': {
      const patterns = [...document.querySelectorAll('[data-denial]')]
        .filter((cb) => cb.checked)
        .map((cb) => document.querySelector(`[data-denial-pattern="${cb.dataset.denial}"]`).value.trim())
        .filter(Boolean);
      if (!patterns.length) return toast('Select at least one rule');
      await api.allowAndRerun(id, patterns);
      await refreshRoutines();
      toast(`Added ${patterns.length} rule${patterns.length > 1 ? 's' : ''}, re-running`);
      setTimeout(() => go({ name: 'routine', id }), 1200);
      return;
    }
    case 'decide': {
      const behavior = el.dataset.behavior;
      const pattern = document.querySelector(`[data-pattern-for="${id}"]`)?.value.trim();
      await api.decide({
        id,
        behavior: behavior === 'deny' ? 'deny' : 'allow',
        alwaysPattern: behavior === 'always' ? pattern : undefined,
      });
      state.approvals = state.approvals.filter((a) => a.id !== id);
      state.lastRenderKey = '';
      toast(behavior === 'deny' ? 'Denied' : behavior === 'always' ? `Allowed, and added ${pattern}` : 'Allowed once');
      renderSidebar();
      render();
      return;
    }
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action="toggle-enabled"]');
  if (!el) return;
  await api.setEnabled(el.dataset.id, el.checked);
  await refreshRoutines();
  state.lastRenderKey = '';
  render();
  toast(el.checked ? 'Schedule resumed' : 'Schedule paused');
});

// Remember which tool cards are expanded so live refreshes don't collapse them.
document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.tool) return;
    if (d.open) state.openTools.add(d.dataset.tool);
    else state.openTools.delete(d.dataset.tool);
  },
  true,
);

$('#new-routine').addEventListener('click', () => go({ name: 'edit', id: null }));
$('#nav-approvals').addEventListener('click', () => go({ name: 'approvals' }));
$('#nav-settings').addEventListener('click', () => go({ name: 'settings' }));
$('#nav-help').addEventListener('click', () => go({ name: 'help' }));

api.onApprovals((list) => {
  state.approvals = list;
  renderSidebar();
  if (['approvals', 'routine', 'run'].includes(state.view.name)) {
    state.lastRenderKey = '';
    render();
  }
});
api.onNav((nav) => go(nav.view === 'run' ? { name: 'run', id: nav.id, runId: nav.runId } : { name: nav.view }));

// Live refresh for the views that show changing data.
setInterval(async () => {
  if (document.hidden) return;
  await refreshRoutines();
  const v = state.view.name;
  if (v === 'routine') renderRoutine(state.view.id);
  else if (v === 'run') renderRun(state.view.id, state.view.runId);
}, 3000);

(async () => {
  state.approvals = await api.listApprovals();
  await refreshRoutines();
  render();
})();

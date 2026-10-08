/* global api, $, esc, toast, viewEl, state */
// Settings screen. Loaded after app.js and shares its helpers.

const SETTINGS_TABS = [
  ['claude', 'Claude Code'],
  ['vars', 'Variables & secrets'],
  ['mcp', 'MCP servers'],
  ['defaults', 'Routine defaults'],
  ['data', 'Data'],
];

const mcpResults = {};
let mcpEditing = null; // null = closed, '' = new server, otherwise the name being edited

async function renderSettings() {
  const tab = state.settingsTab || 'claude';
  const cfg = await api.getConfig();
  viewEl.innerHTML = `<div class="view-inner">
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Apply to every routine. Secrets are kept in your macOS Keychain.</div></div></div>
    <div class="tabs">${SETTINGS_TABS.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-settings-tab="${k}">${l}</button>`).join('')}</div>
    <div id="settings-body"></div>
  </div>`;
  const body = $('#settings-body');
  if (tab === 'claude') return settingsClaude(body, cfg);
  if (tab === 'vars') return settingsVars(body, cfg);
  if (tab === 'mcp') return settingsMcp(body, cfg);
  if (tab === 'defaults') return settingsDefaults(body, cfg);
  return settingsData(body, cfg);
}

// ---------- Claude Code ----------

async function settingsClaude(body, cfg) {
  body.innerHTML = `<div class="form">
    <div class="card" id="claude-status"><div class="muted">Checking the Claude CLI…</div></div>
    <form class="form" id="claude-form">
      <fieldset><legend>CLI</legend><div class="form">
        <div class="field"><label>claude binary</label><input type="text" name="claudePath" class="mono" value="${esc(cfg.claudePath)}" /></div>
        <div class="field"><label>PATH for scheduled runs</label><textarea name="pathEnv" rows="3">${esc(cfg.pathEnv)}</textarea>
          <span class="hint">launchd starts jobs with a minimal PATH, so this is copied from your login shell. Tools like git, jq and node must be on it.</span></div>
        <div class="row-actions">
          <button type="button" class="btn" data-action="reprobe">Detect from login shell</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </div></fieldset>
    </form>
    <div class="callout"><span class="mono">ANTHROPIC_API_KEY</span> and <span class="mono">ANTHROPIC_AUTH_TOKEN</span> are always removed from runs, so routines use your Claude subscription and nothing is billed to the API.</div>
  </div>`;

  $('#claude-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await api.saveConfig({ claudePath: f.claudePath.value, pathEnv: f.pathEnv.value });
    toast('Saved');
    renderSettings();
  });

  const st = await api.claudeStatus();
  const box = $('#claude-status');
  if (!box) return;
  const a = st.auth || {};
  const signedIn = a.loggedIn;
  const hasToken = (cfg.secrets || []).some((x) => x.name === 'CLAUDE_CODE_OAUTH_TOKEN' && x.isSet);
  box.innerHTML = `
    <div class="status-grid">
      <div><div class="stat-label">Claude Code</div><div class="stat-value">${st.installed && st.version ? `<span class="pill success">Installed</span> ${esc(st.version)}` : '<span class="pill error">Not found</span>'}</div></div>
      <div><div class="stat-label">Signed in</div><div class="stat-value">${signedIn ? `<span class="pill success">Yes</span> ${esc(a.subscriptionType || '')} ${a.authMethod ? `· ${esc(a.authMethod)}` : ''}` : '<span class="pill error">No</span>'}</div>
        ${a.email ? `<div class="stat-note">${esc(a.email)}</div>` : ''}</div>
      <div><div class="stat-label">Long-lived token</div><div class="stat-value">${hasToken ? '<span class="pill success">In Keychain</span>' : '<span class="pill">Not set</span>'}</div></div>
    </div>
    ${
      !st.installed || !st.version
        ? `<div class="callout err" style="margin-top:12px">Install Claude Code, then set the path above:<pre class="log" style="margin-top:6px">npm install -g @anthropic-ai/claude-code</pre></div>`
        : !signedIn
          ? `<div class="callout err" style="margin-top:12px">Scheduled runs can't authenticate. Either run <span class="mono">claude</span> in Terminal and type <span class="mono">/login</span>, or (better for schedules) run <span class="mono">claude setup-token</span> and save the token as the secret <span class="mono">CLAUDE_CODE_OAUTH_TOKEN</span>. <a href="#" data-action="add-oauth-secret">Add it now</a></div>`
          : ''
    }
    <div class="row-actions" style="margin-top:12px"><button class="btn small" data-action="claude-recheck">Check again</button></div>`;
}

// ---------- Variables & secrets ----------

function settingsVars(body, cfg) {
  const env = cfg.env || [];
  const secrets = cfg.secrets || [];
  const prefill = state.secretPrefill || '';
  state.secretPrefill = '';
  body.innerHTML = `<div class="form">
    <div class="callout">Variables are added to every run's environment, so scripts and pre-checks can read them. Secrets stay in the Keychain and are only filled into MCP server settings that reference them as <span class="mono">\${NAME}</span>, unless you tick <b>Expose to shell</b>.</div>

    <fieldset><legend>Variables</legend>
      <form id="vars-form" class="form">
        <table class="kv"><thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
        <tbody id="vars-rows">${env.map((v) => varRow(v.name, v.value)).join('') || ''}</tbody></table>
        <div class="row-actions">
          <button type="button" class="btn" data-action="add-var-row">+ Add variable</button>
          <button type="button" class="btn" data-action="import-env">Import .env file…</button>
          <button type="submit" class="btn primary">Save variables</button>
        </div>
      </form>
    </fieldset>

    <fieldset><legend>Secrets (Keychain)</legend><div class="form">
      ${
        secrets.length
          ? `<table class="kv"><thead><tr><th>Name</th><th>Status</th><th>Expose to shell</th><th>Replace value</th><th></th></tr></thead><tbody>
        ${secrets
          .map(
            (s) => `<tr data-secret="${esc(s.name)}">
          <td class="mono">${esc(s.name)}</td>
          <td>${s.isSet ? '<span class="pill success">Saved</span>' : '<span class="pill error">Missing</span>'}</td>
          <td><label class="toggle"><input type="checkbox" data-action="secret-expose" data-name="${esc(s.name)}" ${s.exposeToShell ? 'checked' : ''} /><span></span></label></td>
          <td><div class="input-with-btn"><input type="password" placeholder="New value" data-secret-value="${esc(s.name)}" autocomplete="off" /><button class="btn small" data-action="secret-replace" data-name="${esc(s.name)}">Save</button></div></td>
          <td><button class="btn small danger" data-action="secret-remove" data-name="${esc(s.name)}">Remove</button></td>
        </tr>`,
          )
          .join('')}</tbody></table>`
          : '<div class="muted">No secrets yet.</div>'
      }
      <form id="secret-add" class="form-row" style="align-items:end">
        <div class="field"><label>Name</label><input type="text" name="name" class="mono" placeholder="BB_APP_PASSWORD" value="${esc(prefill)}" /></div>
        <div class="field"><label>Value</label><input type="password" name="value" autocomplete="off" /></div>
        <div class="field"><label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" name="expose" /> Expose to shell</label>
          <button type="submit" class="btn primary">Add secret</button></div>
      </form>
      <span class="hint">Only expose a secret to the shell if a script must read it from the environment. Anything in the environment can be read by Claude's Bash commands.</span>
    </div></fieldset>
  </div>`;

  if (prefill) $('#secret-add').elements.value.focus();

  $('#vars-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = [...document.querySelectorAll('#vars-rows tr')].map((tr) => ({
      name: tr.querySelector('[data-var-name]').value.trim(),
      value: tr.querySelector('[data-var-value]').value,
    }));
    const bad = rows.find((r) => r.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name));
    if (bad) return toast(`Invalid name: ${bad.name}`);
    await api.saveConfig({ env: rows.filter((r) => r.name) });
    toast('Variables saved');
    renderSettings();
  });

  $('#secret-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api.setSecret({ name: f.name.value.trim(), value: f.value.value, exposeToShell: f.expose.checked });
      toast('Secret saved to Keychain');
      renderSettings();
    } catch (err) {
      toast(cleanErr(err));
    }
  });
}

function varRow(name = '', value = '') {
  return `<tr>
    <td><input type="text" class="mono" data-var-name value="${esc(name)}" placeholder="NAME" /></td>
    <td><input type="text" class="mono" data-var-value value="${esc(value)}" /></td>
    <td><button type="button" class="btn small danger" data-action="remove-var-row">Remove</button></td>
  </tr>`;
}

// ---------- MCP servers ----------

function serverSummary(s) {
  const type = s.type || (s.url ? 'http' : 'stdio');
  return type === 'stdio' ? `${s.command || ''} ${(s.args || []).join(' ')}` : s.url || '';
}

function settingsMcp(body, cfg) {
  const servers = cfg.mcpServers || {};
  const names = Object.keys(servers).sort();
  body.innerHTML = `<div class="form">
    <div class="callout">Servers here are added to <b>every</b> routine run. Connectors from your claude.ai account (Slack, Atlassian…) and servers added with <span class="mono">claude mcp add</span> load on their own, and you don't need to repeat them here. Use <span class="mono">\${NAME}</span> to fill in a variable or secret.</div>

    <div class="section-title" style="margin:0">App servers
      <span class="row-actions">
        <button class="btn small" data-action="mcp-test-all" ${names.length ? '' : 'disabled'}>Test all</button>
        <button class="btn small" data-action="mcp-import-toggle">Import JSON</button>
        <button class="btn small primary" data-action="mcp-new">+ Add server</button>
      </span>
    </div>

    <div id="mcp-import" hidden class="card">
      <div class="field"><label>Paste an <span class="mono">mcpServers</span> JSON block (Claude Code or Claude Desktop format)</label>
        <textarea id="mcp-import-text" rows="8" placeholder='{"mcpServers": {"jira": {"type": "http", "url": "https://…", "headers": {"Authorization": "Bearer \${JIRA_TOKEN}"}}}}'></textarea></div>
      <div class="row-actions" style="margin-top:8px"><button class="btn primary" data-action="mcp-import">Import</button></div>
      <span class="hint">Tip: replace raw tokens with <span class="mono">\${NAME}</span> and save the real value under Secrets, so it isn't stored in plain text.</span>
    </div>

    <div id="mcp-editor"></div>

    ${
      names.length
        ? names
            .map((n) => {
              const s = servers[n];
              const r = mcpResults[n];
              return `<div class="card mcp-card">
          <div class="mcp-head">
            <div style="min-width:0">
              <div><b>${esc(n)}</b> <span class="pill">${esc(s.type || (s.url ? 'http' : 'stdio'))}</span> ${s.disabled ? '<span class="pill warn">disabled</span>' : ''}</div>
              <div class="mono faint ellipsis">${esc(serverSummary(s))}</div>
            </div>
            <div class="row-actions">
              <label class="toggle" title="Include in runs"><input type="checkbox" data-action="mcp-toggle" data-name="${esc(n)}" ${s.disabled ? '' : 'checked'} /><span></span></label>
              <button class="btn small" data-action="mcp-test" data-name="${esc(n)}">Test</button>
              <button class="btn small" data-action="mcp-edit" data-name="${esc(n)}">Edit</button>
              <button class="btn small danger" data-action="mcp-remove" data-name="${esc(n)}">Remove</button>
            </div>
          </div>
          ${
            r
              ? r.pending
                ? '<div class="muted" style="margin-top:8px">Testing…</div>'
                : r.ok
                  ? `<div style="margin-top:8px"><span class="pill success">Connected</span> ${esc(r.server?.name || '')} · ${r.tools.length} tools <span class="faint">${esc(r.tools.slice(0, 8).join(', '))}${r.tools.length > 8 ? '…' : ''}</span></div>`
                  : `<div style="margin-top:8px"><span class="pill error">Failed</span> ${esc(r.error)}${r.stderr ? `<pre class="log" style="margin-top:6px">${esc(r.stderr)}</pre>` : ''}</div>`
              : ''
          }
        </div>`;
            })
            .join('')
        : '<div class="empty" style="padding:28px">No app servers. Add one, or rely on your Claude Code and claude.ai connectors.</div>'
    }

    <fieldset><legend>Check with Claude Code</legend><div class="form">
      <span class="hint">Runs <span class="mono">claude mcp list</span>, which health-checks every server Claude Code would load from that folder: user and project servers plus claude.ai connectors. Tokens in the output are masked.</span>
      <div class="input-with-btn"><input type="text" id="mcp-list-cwd" class="mono" placeholder="Folder (defaults to your home folder)" /><button class="btn" data-action="mcp-claude-list">Run check</button></div>
      <pre class="log" id="mcp-list-out" hidden></pre>
    </div></fieldset>
  </div>`;
  if (mcpEditing !== null) renderMcpEditor(cfg);
}

function renderMcpEditor(cfg) {
  const name = mcpEditing;
  const s = (name && cfg.mcpServers[name]) || { type: 'stdio' };
  const type = s.type || (s.url ? 'http' : 'stdio');
  const kv = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
  const el = $('#mcp-editor');
  el.innerHTML = `<form class="card form" id="mcp-form">
    <h3>${name ? `Edit ${esc(name)}` : 'New MCP server'}</h3>
    <div class="form-row">
      <div class="field"><label>Name</label><input type="text" name="name" class="mono" value="${esc(name || '')}" required /></div>
      <div class="field"><label>Type</label><select name="type">
        ${['stdio', 'http', 'sse'].map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
    </div>
    <div class="form" data-for="stdio">
      <div class="field"><label>Command</label><input type="text" name="command" class="mono" value="${esc(s.command || '')}" placeholder="npx" /></div>
      <div class="field"><label>Arguments (one per line)</label><textarea name="args" rows="3">${esc((s.args || []).join('\n'))}</textarea></div>
      <div class="field"><label>Environment (KEY=VALUE per line)</label><textarea name="env" rows="3" placeholder="API_TOKEN=\${MY_SECRET}">${esc(kv(s.env, '='))}</textarea></div>
    </div>
    <div class="form" data-for="http">
      <div class="field"><label>URL</label><input type="text" name="url" class="mono" value="${esc(s.url || '')}" placeholder="https://mcp.example.com/mcp" /></div>
      <div class="field"><label>Headers (Name: value per line)</label><textarea name="headers" rows="3" placeholder="Authorization: Bearer \${MY_TOKEN}">${esc(kv(s.headers, ': '))}</textarea></div>
    </div>
    <span class="hint">Put tokens in Secrets and reference them as <span class="mono">\${NAME}</span>. They're filled in only when a run starts.</span>
    <div class="row-actions">
      <button type="button" class="btn" data-action="mcp-cancel">Cancel</button>
      <button type="submit" class="btn primary">Save server</button>
    </div>
  </form>`;
  const form = $('#mcp-form');
  const sync = () => {
    const t = form.type.value;
    form.querySelector('[data-for=stdio]').hidden = t !== 'stdio';
    form.querySelector('[data-for=http]').hidden = t === 'stdio';
  };
  form.type.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = form.type.value;
    const parseKv = (text, sep) =>
      Object.fromEntries(
        text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf(sep);
            return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()];
          }),
      );
    const server =
      t === 'stdio'
        ? { type: 'stdio', command: form.command.value.trim(), args: form.args.value.split('\n').map((x) => x.trim()).filter(Boolean), env: parseKv(form.env.value, '=') }
        : { type: t, url: form.url.value.trim(), headers: parseKv(form.headers.value, ':') };
    if (s.disabled) server.disabled = true;
    try {
      await api.saveMcp({ name: form.name.value.trim(), server, oldName: name || undefined });
      mcpEditing = null;
      toast('Server saved');
      renderSettings();
    } catch (err) {
      toast(cleanErr(err));
    }
  });
}

async function runMcpTest(name) {
  mcpResults[name] = { pending: true };
  if (state.view.name === 'settings') renderSettings();
  mcpResults[name] = await api.testMcp(name);
  if (state.view.name === 'settings') renderSettings();
}

// ---------- Routine defaults ----------

function settingsDefaults(body, cfg) {
  const d = cfg.defaults;
  body.innerHTML = `<form class="form" id="defaults-form">
    <div class="callout">Used when you create a new routine. Existing routines keep their own settings.</div>
    <fieldset><legend>Permissions</legend><div class="form">
      <div class="form-row">
        <div class="field"><label>Permission mode</label><select name="permissionMode">
          ${[['default', 'default: ask in Approvals'], ['acceptEdits', 'acceptEdits: file edits allowed'], ['plan', 'plan: read-only']].map(([v, l]) => `<option value="${v}" ${d.permissionMode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
        <div class="field"><label>Approval timeout (seconds)</label><input type="number" name="approvalTimeoutSec" min="10" value="${esc(d.approvalTimeoutSec)}" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Allowed tools (one per line)</label><textarea name="allowedTools" rows="6" placeholder="Read&#10;Grep&#10;Glob&#10;Skill">${esc((d.allowedTools || []).join('\n'))}</textarea></div>
        <div class="field"><label>Disallowed tools (one per line)</label><textarea name="disallowedTools" rows="6" placeholder="Bash(rm:*)">${esc((d.disallowedTools || []).join('\n'))}</textarea></div>
      </div>
      <span class="hint">There's no allow-everything mode. Routines run unattended and read text other people write (Slack, PRs), so a planted instruction could run any command. Use allowed-tool rules and Approvals instead.</span>
    </div></fieldset>
    <fieldset><legend>Run</legend><div class="form-row">
      <div class="field"><label>Model</label><select name="model">
        ${[['', 'Account default'], ['haiku', 'Haiku (cheapest)'], ['sonnet', 'Sonnet'], ['opus', 'Opus']].map(([v, l]) => `<option value="${v}" ${d.model === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>Max turns</label><input type="number" name="maxTurns" min="1" value="${esc(d.maxTurns)}" /></div>
      <div class="field"><label>Run timeout (minutes)</label><input type="number" name="timeoutMinutes" min="1" value="${esc(d.timeoutMinutes)}" /></div>
    </div></fieldset>
    <fieldset><legend>Notifications</legend>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notifications" ${cfg.notifications === false ? '' : 'checked'} /> Show a macOS notification when a routine needs approval</label>
    </fieldset>
    <div class="row-actions" style="justify-content:flex-end"><button type="submit" class="btn primary">Save defaults</button></div>
  </form>`;
  $('#defaults-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    await api.saveConfig({
      defaults: {
        permissionMode: f.permissionMode.value,
        approvalTimeoutSec: Number(f.approvalTimeoutSec.value) || 600,
        allowedTools: lines(f.allowedTools.value),
        disallowedTools: lines(f.disallowedTools.value),
        model: f.model.value,
        maxTurns: Number(f.maxTurns.value) || 15,
        timeoutMinutes: Number(f.timeoutMinutes.value) || 30,
      },
      notifications: f.notifications.checked,
    });
    toast('Defaults saved');
  });
}

// ---------- Data ----------

function settingsData(body, cfg) {
  body.innerHTML = `<div class="form">
    <div class="card">
      <div class="stat-label">Data folder</div><div class="mono">${esc(cfg.home)}</div>
      <div class="stat-note">Routines, run history, approvals and logs. Secrets aren't stored here.</div>
      <div class="row-actions" style="margin-top:10px"><button class="btn" data-action="open-path" data-path="${esc(cfg.home)}">Open in Finder</button></div>
    </div>
    <div class="card">
      <div class="stat-label">Schedules</div>
      <div class="stat-note">Each enabled routine is a LaunchAgent named <span class="mono">com.claude-routines.&lt;id&gt;</span>. Reinstall them if you moved the app or schedules stopped firing.</div>
      <div class="row-actions" style="margin-top:10px"><button class="btn" data-action="reinstall-schedules">Reinstall schedules</button></div>
    </div>
    <div class="card">
      <div class="stat-label">Runtime</div><div class="mono">${esc(cfg.runtimePath || '')}</div>
    </div>
  </div>`;
}

function cleanErr(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-settings-tab]');
  if (tabBtn) {
    state.settingsTab = tabBtn.dataset.settingsTab;
    mcpEditing = null;
    return renderSettings();
  }
  const el = e.target.closest('[data-action]');
  if (!el || state.view.name !== 'settings') return;
  const { action, name } = el.dataset;
  if (el.tagName === 'A') e.preventDefault();
  switch (action) {
    case 'claude-recheck':
      return renderSettings();
    case 'add-oauth-secret':
      state.settingsTab = 'vars';
      state.secretPrefill = 'CLAUDE_CODE_OAUTH_TOKEN';
      return renderSettings();
    case 'add-var-row':
      $('#vars-rows').insertAdjacentHTML('beforeend', varRow());
      return;
    case 'remove-var-row':
      el.closest('tr').remove();
      return;
    case 'import-env': {
      const res = await api.importEnvFile();
      if (res) {
        toast(`Imported ${res.nVars} variable${res.nVars === 1 ? '' : 's'} and ${res.nSecrets} secret${res.nSecrets === 1 ? '' : 's'}`);
        renderSettings();
      }
      return;
    }
    case 'secret-replace': {
      const input = document.querySelector(`[data-secret-value="${CSS.escape(name)}"]`);
      if (!input.value) return toast('Enter a new value');
      const row = (await api.getConfig()).secrets.find((s) => s.name === name);
      await api.setSecret({ name, value: input.value, exposeToShell: row?.exposeToShell });
      toast('Secret updated');
      return renderSettings();
    }
    case 'secret-remove':
      if (!confirm(`Remove ${name} from the Keychain?`)) return;
      await api.removeSecret(name);
      toast('Secret removed');
      return renderSettings();
    case 'mcp-new':
      mcpEditing = '';
      return renderSettings();
    case 'mcp-edit':
      mcpEditing = name;
      return renderSettings();
    case 'mcp-cancel':
      mcpEditing = null;
      return renderSettings();
    case 'mcp-remove':
      if (!confirm(`Remove MCP server ${name}?`)) return;
      await api.removeMcp(name);
      delete mcpResults[name];
      return renderSettings();
    case 'mcp-test':
      return runMcpTest(name);
    case 'mcp-test-all': {
      const cfg = await api.getConfig();
      await Promise.all(Object.keys(cfg.mcpServers || {}).map(runMcpTest));
      return;
    }
    case 'mcp-import-toggle':
      $('#mcp-import').hidden = !$('#mcp-import').hidden;
      return;
    case 'mcp-import':
      try {
        const res = await api.importMcpJson($('#mcp-import-text').value);
        toast(`Imported ${res.count} server${res.count === 1 ? '' : 's'}`);
        renderSettings();
      } catch (err) {
        toast(`Couldn't import: ${cleanErr(err)}`);
      }
      return;
    case 'mcp-claude-list': {
      const out = $('#mcp-list-out');
      out.hidden = false;
      out.textContent = 'Checking servers… this can take up to a minute.';
      el.disabled = true;
      out.textContent = await api.claudeMcpList($('#mcp-list-cwd').value.trim());
      el.disabled = false;
      return;
    }
    case 'reinstall-schedules':
      await api.reinstallSchedules();
      return toast('Schedules reinstalled');
  }
});

document.addEventListener('change', async (e) => {
  if (state.view.name !== 'settings') return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'secret-expose') {
    await api.setSecret({ name: el.dataset.name, exposeToShell: el.checked });
    toast(el.checked ? `${el.dataset.name} will be in the run environment` : `${el.dataset.name} kept out of the run environment`);
  }
  if (el.dataset.action === 'mcp-toggle') {
    const cfg = await api.getConfig();
    const s = { ...cfg.mcpServers[el.dataset.name] };
    if (el.checked) delete s.disabled;
    else s.disabled = true;
    await api.saveMcp({ name: el.dataset.name, server: s, oldName: el.dataset.name });
    renderSettings();
  }
});

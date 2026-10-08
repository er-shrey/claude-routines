const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const store = require('./lib/store');
const launchd = require('./lib/launchd');
const { probeLoginShell, claudeVersion } = require('./lib/env');
const secrets = require('./lib/secrets');
const { collectVars, mcpServersFor } = require('./lib/runenv');
const { testServer } = require('./lib/mcptest');
const { unpacked } = require('./lib/paths');

let win;

function initConfig() {
  store.ensureDirs();
  const cfg = store.getConfig();
  let changed = false;
  if (!cfg.claudePath || !cfg.pathEnv) {
    const probed = probeLoginShell();
    cfg.claudePath = cfg.claudePath || probed.claudePath;
    cfg.pathEnv = cfg.pathEnv || probed.pathEnv;
    changed = true;
  }
  // The runner is executed by this Electron binary in Node mode. If the binary
  // moved (e.g. Electron upgraded), rewrite every LaunchAgent to point at it.
  if (cfg.runtimePath !== process.execPath) {
    cfg.runtimePath = process.execPath;
    changed = true;
  }
  // Older versions kept the OAuth token in config.json; move it to the Keychain.
  if (cfg.oauthToken) {
    try {
      secrets.setSecret('CLAUDE_CODE_OAUTH_TOKEN', cfg.oauthToken);
      cfg.secrets = upsertSecretMeta(cfg.secrets, 'CLAUDE_CODE_OAUTH_TOKEN', false);
      delete cfg.oauthToken;
      changed = true;
    } catch (e) {
      console.error('Token migration failed:', e.message);
    }
  }
  if (changed) {
    store.saveConfig(cfg);
    reinstallAll(cfg);
  }
  return cfg;
}

function reinstallAll(cfg = store.getConfig()) {
  for (const r of store.listRoutines()) {
    try {
      launchd.install(r, cfg);
    } catch (e) {
      console.error(`Failed to install ${r.id}:`, e.message);
    }
  }
}

function upsertSecretMeta(list = [], name, exposeToShell) {
  const rest = list.filter((x) => x.name !== name);
  return [...rest, { name, exposeToShell: Boolean(exposeToShell) }].sort((a, b) => a.name.localeCompare(b.name));
}

// Secret values never leave the main process; the UI only learns whether one is set.
function publicConfig() {
  const cfg = store.getConfig();
  const { oauthToken, ...rest } = cfg;
  return {
    ...rest,
    env: cfg.env || [],
    secrets: (cfg.secrets || []).map((x) => ({ ...x, isSet: secrets.getSecret(x.name) !== null })),
    mcpServers: cfg.mcpServers || {},
    defaults: { ...DEFAULTS, ...(cfg.defaults || {}) },
    home: store.paths.home,
    claudeVersion: claudeVersion(cfg.claudePath),
  };
}

const DEFAULTS = { permissionMode: 'default', model: '', maxTurns: 15, approvalTimeoutSec: 600, timeoutMinutes: 30, allowedTools: [], disallowedTools: [] };

// Same environment rules as a real run, for CLI checks from Settings.
function cliEnv(cfg) {
  const { shell, all } = collectVars(cfg);
  const env = { ...process.env, ...shell };
  if (cfg.pathEnv) env.PATH = cfg.pathEnv;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  if (all.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = all.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

// Mask anything that looks like a credential before showing CLI output.
function maskSecrets(text) {
  return String(text)
    .replace(/((?:token|key|secret|password|auth)[\w-]*=)[^\s&"']+/gi, '$1••••')
    .replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, '$1••••')
    .replace(/((?:authorization|[\w-]*(?:key|token|secret))\s*:\s*)(?!Bearer)[^\s,"'}]+/gi, '$1••••');
}

function startRun(id, trigger = 'manual') {
  const cfg = store.getConfig();
  const child = spawn(process.execPath, [unpacked(path.join(__dirname, 'runner.js')), id, trigger], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ROUTINES_HOME: store.paths.home },
    cwd: store.getRoutine(id)?.cwd || undefined,
    detached: true,
    stdio: ['ignore', fs.openSync(path.join(store.paths.logs, `${id}.log`), 'a'), fs.openSync(path.join(store.paths.logs, `${id}.log`), 'a')],
  });
  child.unref();
  return { ok: true, runtime: cfg.runtimePath };
}

function routineSummary(r) {
  const state = store.getState(r.id);
  const [lastRun] = store.listRuns(r.id, 1);
  return { ...r, state, lastRun: lastRun || null, loaded: r.enabled ? launchd.isLoaded(r.id) : false };
}

function readEvents(file, max = 2000) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
    if (out.length >= max) break;
  }
  return out;
}

function addAllowedTools(id, patterns) {
  const r = store.getRoutine(id);
  if (!r) return null;
  const set = new Set(r.allowedTools || []);
  for (const p of patterns) if (p && p.trim()) set.add(p.trim());
  return store.saveRoutine({ ...r, allowedTools: [...set] });
}

// ---------- IPC ----------

ipcMain.handle('config:get', () => publicConfig());

ipcMain.handle('config:save', (_e, input) => {
  const cfg = store.getConfig();
  const before = `${cfg.claudePath}|${cfg.pathEnv}`;
  if (typeof input.claudePath === 'string') cfg.claudePath = input.claudePath.trim();
  if (typeof input.pathEnv === 'string') cfg.pathEnv = input.pathEnv.trim();
  if (Array.isArray(input.env)) {
    cfg.env = input.env
      .map((x) => ({ name: String(x.name || '').trim(), value: String(x.value ?? '') }))
      .filter((x) => secrets.NAME_RE.test(x.name));
  }
  if (input.defaults) cfg.defaults = { ...DEFAULTS, ...input.defaults };
  if (typeof input.notifications === 'boolean') cfg.notifications = input.notifications;
  store.saveConfig(cfg);
  if (before !== `${cfg.claudePath}|${cfg.pathEnv}`) reinstallAll(cfg);
  return publicConfig();
});

ipcMain.handle('secrets:set', (_e, { name, value, exposeToShell }) => {
  name = String(name || '').trim();
  if (!secrets.NAME_RE.test(name)) throw new Error('Use letters, digits and _ only, not starting with a digit.');
  const cfg = store.getConfig();
  if (typeof value === 'string' && value !== '') secrets.setSecret(name, value);
  else if (secrets.getSecret(name) === null) throw new Error('Enter a value.');
  cfg.secrets = upsertSecretMeta(cfg.secrets, name, exposeToShell);
  store.saveConfig(cfg);
  return publicConfig();
});

ipcMain.handle('secrets:remove', (_e, name) => {
  secrets.deleteSecret(name);
  const cfg = store.getConfig();
  cfg.secrets = (cfg.secrets || []).filter((x) => x.name !== name);
  store.saveConfig(cfg);
  return publicConfig();
});

// Import KEY=VALUE lines (.env style). Names that look sensitive go to the Keychain.
ipcMain.handle('secrets:importEnvFile', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], message: 'Choose a .env or credentials file' });
  if (res.canceled || !res.filePaths[0]) return null;
  const cfg = store.getConfig();
  const env = [...(cfg.env || [])];
  let nSecrets = 0;
  let nVars = 0;
  for (const raw of fs.readFileSync(res.filePaths[0], 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const [, name, rawValue] = m;
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (/PASS|TOKEN|SECRET|KEY|CREDENTIAL|AUTH/i.test(name)) {
      secrets.setSecret(name, value);
      cfg.secrets = upsertSecretMeta(cfg.secrets, name, false);
      nSecrets++;
    } else {
      const i = env.findIndex((x) => x.name === name);
      if (i >= 0) env[i] = { name, value };
      else env.push({ name, value });
      nVars++;
    }
  }
  cfg.env = env;
  store.saveConfig(cfg);
  return { config: publicConfig(), nSecrets, nVars };
});

ipcMain.handle('mcp:save', (_e, { name, server, oldName }) => {
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Server name: letters, digits, - and _ only.');
  if (name === 'routine_approver') throw new Error('That name is reserved.');
  const cfg = store.getConfig();
  cfg.mcpServers = { ...(cfg.mcpServers || {}) };
  if (oldName && oldName !== name) delete cfg.mcpServers[oldName];
  cfg.mcpServers[name] = server;
  store.saveConfig(cfg);
  return publicConfig();
});

ipcMain.handle('mcp:remove', (_e, name) => {
  const cfg = store.getConfig();
  delete (cfg.mcpServers || {})[name];
  store.saveConfig(cfg);
  return publicConfig();
});

// Accepts {"mcpServers": {...}} (Claude Code / Claude Desktop format) or a bare map.
ipcMain.handle('mcp:importJson', (_e, text) => {
  const parsed = JSON.parse(text);
  const map = parsed.mcpServers || parsed;
  const cfg = store.getConfig();
  cfg.mcpServers = { ...(cfg.mcpServers || {}) };
  let n = 0;
  for (const [name, server] of Object.entries(map)) {
    if (!server || typeof server !== 'object' || (!server.command && !server.url)) continue;
    cfg.mcpServers[name] = server;
    n++;
  }
  store.saveConfig(cfg);
  return { config: publicConfig(), count: n };
});

ipcMain.handle('mcp:test', async (_e, name) => {
  const cfg = store.getConfig();
  const server = cfg.mcpServers?.[name];
  if (!server) return { ok: false, error: 'Not found' };
  const { all } = collectVars(cfg);
  const expanded = mcpServersFor({ mcpServers: { [name]: { ...server, disabled: false } } }, all)[name];
  const unresolved = JSON.stringify(expanded).match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g);
  if (unresolved) return { ok: false, error: `Missing variable or secret: ${[...new Set(unresolved)].join(', ')}` };
  return testServer(expanded, cliEnv(cfg));
});

ipcMain.handle('claude:status', () => {
  const cfg = store.getConfig();
  if (!cfg.claudePath) return { installed: false };
  const res = spawnSync(cfg.claudePath, ['auth', 'status'], { env: cliEnv(cfg), encoding: 'utf8', timeout: 20_000 });
  let auth = null;
  try {
    auth = JSON.parse(res.stdout);
  } catch {}
  return { installed: true, version: claudeVersion(cfg.claudePath), auth, raw: auth ? '' : (res.stdout || res.stderr || '').slice(0, 500) };
});

// `claude mcp list` health-checks every server Claude Code knows about (user,
// project and claude.ai connectors). Output is masked and shown only in the app.
ipcMain.handle('claude:mcpList', (_e, cwd) => {
  const cfg = store.getConfig();
  const res = spawnSync(cfg.claudePath, ['mcp', 'list'], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : require('os').homedir(),
    env: cliEnv(cfg),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return maskSecrets((res.stdout || '') + (res.stderr || '')).trim() || 'No output.';
});

ipcMain.handle('app:reinstallSchedules', () => {
  reinstallAll();
  return true;
});

ipcMain.handle('config:probe', () => probeLoginShell());

ipcMain.handle('routines:list', () => store.listRoutines().map(routineSummary));

ipcMain.handle('routines:get', (_e, id) => {
  const r = store.getRoutine(id);
  return r ? routineSummary(r) : null;
});

ipcMain.handle('routines:save', (_e, input) => {
  const saved = store.saveRoutine(input);
  launchd.install(saved, store.getConfig());
  return routineSummary(saved);
});

ipcMain.handle('routines:setEnabled', (_e, id, enabled) => {
  const r = store.getRoutine(id);
  const saved = store.saveRoutine({ ...r, enabled });
  launchd.install(saved, store.getConfig());
  return routineSummary(saved);
});

ipcMain.handle('routines:delete', async (_e, id) => {
  const r = store.getRoutine(id);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete "${r?.name || id}"?`,
    detail: 'This removes its schedule, prompt and all run history. It cannot be undone.',
  });
  if (response !== 0) return false;
  launchd.remove(id);
  store.deleteRoutine(id);
  return true;
});

ipcMain.handle('routines:runNow', (_e, id) => startRun(id, 'manual'));

ipcMain.handle('routines:allowAndRerun', (_e, id, patterns) => {
  addAllowedTools(id, patterns);
  return startRun(id, 'manual');
});

ipcMain.handle('runs:list', (_e, id) => store.listRuns(id, 300));

ipcMain.handle('runs:get', (_e, id, runId) => {
  const dir = store.paths.runDir(id, runId);
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    meta: store.readJson(path.join(dir, 'meta.json')),
    events: readEvents(path.join(dir, 'events.jsonl')),
    stderr: read('stderr.log').slice(-20000),
    prompt: read('prompt.md'),
    dir,
  };
});

ipcMain.handle('runs:stop', (_e, id, runId) => {
  const dir = store.paths.runDir(id, runId);
  const meta = store.readJson(path.join(dir, 'meta.json'));
  if (!meta || meta.status !== 'running') return false;
  store.writeJson(path.join(dir, 'stop.json'), { at: new Date().toISOString() });
  try {
    if (meta.pid) process.kill(meta.pid, 'SIGTERM');
  } catch {}
  return true;
});

ipcMain.handle('approvals:list', () => listApprovals());

ipcMain.handle('approvals:decide', (_e, { id, behavior, alwaysPattern, message }) => {
  const req = store.readJson(path.join(store.paths.pending, `${id}.json`));
  if (!req) return false;
  if (behavior === 'allow' && alwaysPattern) addAllowedTools(req.routineId, [alwaysPattern]);
  store.writeJson(path.join(store.paths.decisions, `${id}.json`), {
    behavior,
    message,
    decidedAt: new Date().toISOString(),
  });
  setTimeout(pollApprovals, 800);
  return true;
});

ipcMain.handle('dialog:pickMarkdown', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  return { name: path.basename(file), content: fs.readFileSync(file, 'utf8') };
});

ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:pickJson', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('help:get', () => fs.readFileSync(path.join(__dirname, 'renderer', 'help', 'help.md'), 'utf8'));
ipcMain.handle('shell:openLog', (_e, id) => shell.openPath(path.join(store.paths.logs, `${id}.log`)));

// ---------- approvals watcher ----------

let knownApprovals = new Set();

function listApprovals() {
  let files = [];
  try {
    files = fs.readdirSync(store.paths.pending).filter((f) => f.endsWith('.json'));
  } catch {}
  const now = Date.now();
  const out = [];
  for (const f of files) {
    const req = store.readJson(path.join(store.paths.pending, f));
    if (!req) continue;
    // The approver removes its own file; one left well past expiry means it died.
    if (Date.parse(req.expiresAt) + 120_000 < now) {
      fs.rmSync(path.join(store.paths.pending, f), { force: true });
      continue;
    }
    out.push(req);
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

function pollApprovals() {
  const list = listApprovals();
  const ids = new Set(list.map((a) => a.id));
  const fresh = list.filter((a) => !knownApprovals.has(a.id));
  const changed = fresh.length || [...knownApprovals].some((id) => !ids.has(id));
  knownApprovals = ids;
  if (app.dock) app.dock.setBadge(list.length ? String(list.length) : '');
  const notify = store.getConfig().notifications !== false;
  for (const a of fresh) {
    if (notify && Notification.isSupported()) {
      const n = new Notification({
        title: `${a.routineName} needs permission`,
        body: `Wants to use ${a.toolName}${a.input && a.input.command ? `: ${String(a.input.command).slice(0, 80)}` : ''}`,
      });
      n.on('click', () => {
        win?.show();
        win?.webContents.send('nav', { view: 'run', id: a.routineId, runId: a.runId });
      });
      n.show();
    }
  }
  if (changed) win?.webContents.send('approvals:changed', list);
}

// ---------- app ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links in rendered content must never navigate the app window away.
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.setName('Claude Routines');

app.whenReady().then(() => {
  // Packaged builds get the icon from the bundle; in development set it on the dock.
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  initConfig();
  createWindow();
  setInterval(pollApprovals, 1500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

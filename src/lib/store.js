// Shared file-backed store. Used by the Electron main process, the runner
// (launched by launchd) and the approver MCP server, so it must only depend
// on Node built-ins.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.ROUTINES_HOME || path.join(os.homedir(), '.claude-routines');

const paths = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  routines: path.join(HOME, 'routines'),
  runs: path.join(HOME, 'runs'),
  locks: path.join(HOME, 'locks'),
  pending: path.join(HOME, 'approvals', 'pending'),
  decisions: path.join(HOME, 'approvals', 'decisions'),
  logs: path.join(HOME, 'logs'),
  routineDir: (id) => path.join(HOME, 'routines', id),
  runsDir: (id) => path.join(HOME, 'runs', id),
  runDir: (id, runId) => path.join(HOME, 'runs', id, runId),
};

const ROUTINE_DEFAULTS = {
  name: 'Untitled routine',
  description: '',
  enabled: true,
  schedule: { type: 'interval', minutes: 5 },
  cwd: os.homedir(),
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  model: '',
  maxTurns: 15,
  timeoutMinutes: 30,
  approvalTimeoutSec: 600,
  precheck: '',
  mcpConfigPath: '',
  keepRuns: 300,
};

function ensureDirs() {
  for (const p of [paths.routines, paths.runs, paths.locks, paths.pending, paths.decisions, paths.logs]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write via temp file + rename so concurrent readers never see half a file.
function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function getConfig() {
  return readJson(paths.config, {}) || {};
}

function saveConfig(cfg) {
  writeJson(paths.config, cfg, 0o600);
}

function slugify(name) {
  const base = String(name || 'routine')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'routine';
  let id = base;
  let n = 2;
  while (fs.existsSync(paths.routineDir(id))) id = `${base}-${n++}`;
  return id;
}

function getRoutine(id) {
  const meta = readJson(path.join(paths.routineDir(id), 'routine.json'));
  if (!meta) return null;
  let prompt = '';
  try {
    prompt = fs.readFileSync(path.join(paths.routineDir(id), 'prompt.md'), 'utf8');
  } catch {}
  return { ...ROUTINE_DEFAULTS, ...meta, id, prompt };
}

function listRoutines() {
  let ids = [];
  try {
    ids = fs.readdirSync(paths.routines);
  } catch {}
  return ids.map(getRoutine).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function saveRoutine(input) {
  const id = input.id || slugify(input.name);
  const { prompt = '', ...rest } = input;
  const meta = { ...ROUTINE_DEFAULTS, ...rest, id, updatedAt: new Date().toISOString() };
  if (!meta.createdAt) meta.createdAt = meta.updatedAt;
  writeJson(path.join(paths.routineDir(id), 'routine.json'), meta);
  fs.writeFileSync(path.join(paths.routineDir(id), 'prompt.md'), prompt);
  return getRoutine(id);
}

function deleteRoutine(id) {
  fs.rmSync(paths.routineDir(id), { recursive: true, force: true });
  fs.rmSync(paths.runsDir(id), { recursive: true, force: true });
  fs.rmSync(path.join(paths.locks, id), { recursive: true, force: true });
}

function getState(id) {
  return readJson(path.join(paths.routineDir(id), 'state.json'), {}) || {};
}

function updateState(id, patch) {
  const next = { ...getState(id), ...patch };
  writeJson(path.join(paths.routineDir(id), 'state.json'), next);
  return next;
}

function listRuns(id, limit = 100) {
  let runIds = [];
  try {
    runIds = fs.readdirSync(paths.runsDir(id)).sort().reverse();
  } catch {}
  return runIds
    .slice(0, limit)
    .map((runId) => readJson(path.join(paths.runDir(id, runId), 'meta.json')))
    .filter(Boolean);
}

function pruneRuns(id, keep) {
  let runIds = [];
  try {
    runIds = fs.readdirSync(paths.runsDir(id)).sort().reverse();
  } catch {}
  for (const runId of runIds.slice(keep)) {
    fs.rmSync(paths.runDir(id, runId), { recursive: true, force: true });
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// mkdir is atomic, so it doubles as a lock. A lock whose owner died is stale.
function acquireLock(id) {
  const dir = path.join(paths.locks, id);
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = readJson(path.join(dir, 'owner.json'), {});
    if (isPidAlive(owner.pid)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  writeJson(path.join(dir, 'owner.json'), { pid: process.pid, at: new Date().toISOString() });
  return true;
}

function releaseLock(id) {
  fs.rmSync(path.join(paths.locks, id), { recursive: true, force: true });
}

function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  paths,
  ROUTINE_DEFAULTS,
  ensureDirs,
  readJson,
  writeJson,
  getConfig,
  saveConfig,
  getRoutine,
  listRoutines,
  saveRoutine,
  deleteRoutine,
  getState,
  updateState,
  listRuns,
  pruneRuns,
  isPidAlive,
  acquireLock,
  releaseLock,
  newRunId,
};

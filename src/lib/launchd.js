// Installs one LaunchAgent per routine so schedules keep firing while the app is closed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const store = require('./store');
const { unpacked } = require('./paths');

const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LABEL_PREFIX = 'com.claude-routines.';
const domain = () => `gui/${process.getuid()}`;

const label = (id) => `${LABEL_PREFIX}${id}`;
const plistPath = (id) => path.join(AGENTS_DIR, `${label(id)}.plist`);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toPlist(value, indent = '  ') {
  if (Array.isArray(value)) {
    return `<array>\n${value.map((v) => `${indent}  ${toPlist(v, indent + '  ')}`).join('\n')}\n${indent}</array>`;
  }
  if (typeof value === 'object') {
    const body = Object.entries(value)
      .map(([k, v]) => `${indent}  <key>${esc(k)}</key>\n${indent}  ${toPlist(v, indent + '  ')}`)
      .join('\n');
    return `<dict>\n${body}\n${indent}</dict>`;
  }
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  return `<string>${esc(value)}</string>`;
}

function scheduleKeys(schedule) {
  if (schedule.type === 'calendar') {
    const [hour, minute] = String(schedule.time || '09:00').split(':').map(Number);
    const days = (schedule.weekdays || []).map(Number);
    if (!days.length) return { StartCalendarInterval: { Hour: hour, Minute: minute } };
    return { StartCalendarInterval: days.map((d) => ({ Weekday: d, Hour: hour, Minute: minute })) };
  }
  return { StartInterval: Math.max(60, Math.round(Number(schedule.minutes || 5) * 60)) };
}

function buildPlist(routine, cfg) {
  const runner = unpacked(path.join(__dirname, '..', 'runner.js'));
  const dict = {
    Label: label(routine.id),
    ProgramArguments: [cfg.runtimePath, runner, routine.id, 'schedule'],
    EnvironmentVariables: {
      ELECTRON_RUN_AS_NODE: '1',
      ROUTINES_HOME: store.paths.home,
      PATH: cfg.pathEnv || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: os.homedir(),
    },
    WorkingDirectory: routine.cwd || os.homedir(),
    StandardOutPath: path.join(store.paths.logs, `${routine.id}.log`),
    StandardErrorPath: path.join(store.paths.logs, `${routine.id}.log`),
    RunAtLoad: false,
    ProcessType: 'Background',
    ...scheduleKeys(routine.schedule || {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${toPlist(dict, '')}
</plist>
`;
}

function unload(id) {
  spawnSync('launchctl', ['bootout', `${domain()}/${label(id)}`], { stdio: 'ignore' });
}

function install(routine, cfg) {
  unload(routine.id);
  if (!routine.enabled) {
    fs.rmSync(plistPath(routine.id), { force: true });
    return;
  }
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(plistPath(routine.id), buildPlist(routine, cfg));
  execFileSync('launchctl', ['bootstrap', domain(), plistPath(routine.id)], { stdio: 'pipe' });
}

function remove(id) {
  unload(id);
  fs.rmSync(plistPath(id), { force: true });
}

function isLoaded(id) {
  return spawnSync('launchctl', ['print', `${domain()}/${label(id)}`], { stdio: 'ignore' }).status === 0;
}

module.exports = { install, remove, isLoaded, plistPath, label };

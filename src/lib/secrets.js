// Secrets live in the macOS login Keychain (service "claude-routines"), never in
// config.json. Only their names are kept in config so the UI can list them.
const { spawnSync } = require('child_process');

const SERVICE = 'claude-routines';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// `security -i` reads commands from stdin, so the value never shows up in `ps`.
function setSecret(name, value) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid name: ${name}`);
  const cmd = `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(name)} -w ${quote(value)}\n`;
  const res = spawnSync('/usr/bin/security', ['-i'], { input: cmd, encoding: 'utf8', timeout: 15_000 });
  if (res.status !== 0) throw new Error((res.stderr || 'Keychain write failed').trim());
}

function getSecret(name) {
  const res = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return res.status === 0 ? res.stdout.replace(/\n$/, '') : null;
}

function deleteSecret(name) {
  spawnSync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
}

module.exports = { setSecret, getSecret, deleteSecret, NAME_RE };

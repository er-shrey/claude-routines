// launchd starts jobs with a bare PATH, so capture the login shell's PATH and
// the absolute claude path once and store them in config.
const { spawnSync } = require('child_process');

function probeLoginShell() {
  const shell = process.env.SHELL || '/bin/zsh';
  const res = spawnSync(shell, ['-l', '-c', 'echo "__PATH__$PATH"; echo "__CLAUDE__$(command -v claude)"'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const out = res.stdout || '';
  const pick = (tag) => {
    const line = out.split('\n').find((l) => l.startsWith(tag));
    return line ? line.slice(tag.length).trim() : '';
  };
  return { pathEnv: pick('__PATH__'), claudePath: pick('__CLAUDE__') };
}

function claudeVersion(claudePath) {
  if (!claudePath) return '';
  const res = spawnSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  return (res.stdout || '').trim();
}

module.exports = { probeLoginShell, claudeVersion };

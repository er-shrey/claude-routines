// Builds the environment and MCP config that every run gets from Settings.
// Shared by the runner and the main process (for connection tests).
const { getSecret } = require('./secrets');

// all: every variable and secret, used to fill ${NAME} in MCP configs.
// shell: what goes into the run's environment. Secrets are left out unless the
// user ticked "expose to shell", so Claude can't simply `echo $TOKEN`.
function collectVars(cfg) {
  const all = {};
  const shell = {};
  for (const { name, value } of cfg.env || []) {
    if (!name) continue;
    all[name] = shell[name] = value ?? '';
  }
  for (const { name, exposeToShell } of cfg.secrets || []) {
    const v = getSecret(name);
    if (v === null) continue;
    all[name] = v;
    if (exposeToShell) shell[name] = v;
  }
  return { all, shell };
}

// Replace ${NAME} with values from vars. Unknown names are left as-is.
function expand(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}

// App-managed MCP servers in Claude Code's --mcp-config shape, with ${VARS} filled in.
function mcpServersFor(cfg, vars) {
  const out = {};
  for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
    if (s.disabled) continue;
    const { disabled, ...rest } = s;
    out[name] = expand(rest, vars);
  }
  return out;
}

module.exports = { collectVars, expand, mcpServersFor };

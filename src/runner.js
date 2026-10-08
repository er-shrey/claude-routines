// Runs one routine once: lock, optional pre-check, then `claude -p` headless.
// Invoked by launchd on schedule and by the app for "Run now".
// Usage: runner.js <routineId> [schedule|manual]
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const store = require('./lib/store');
const { collectVars, mcpServersFor } = require('./lib/runenv');

const routineId = process.argv[2];
const trigger = process.argv[3] || 'schedule';

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${routineId}: ${msg}\n`);
}

// Variables and secrets from Settings, read once per run.
let vars = { all: {}, shell: {} };

function buildEnv(cfg, extra = {}) {
  const env = { ...process.env, ...vars.shell, ...extra };
  if (cfg.pathEnv) env.PATH = cfg.pathEnv;
  // Force subscription auth: an API key in the environment would switch billing to the API.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  if (vars.all.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = vars.all.CLAUDE_CODE_OAUTH_TOKEN;
  else if (cfg.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken;
  return env;
}

function runPrecheck(routine, cfg) {
  if (!routine.precheck || !routine.precheck.trim()) return { ok: true, output: '' };
  const res = spawnSync('/bin/zsh', ['-c', routine.precheck], {
    cwd: routine.cwd,
    env: buildEnv(cfg),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    ok: res.status === 0,
    output: (res.stdout || '').trim().slice(0, 20_000),
    error: (res.stderr || '').trim().slice(0, 2000) || (res.error ? String(res.error) : ''),
    code: res.status,
  };
}

function writeMcpConfig(routine, cfg, runDir, runId) {
  const servers = { ...mcpServersFor(cfg, vars.all) };
  if (routine.mcpConfigPath) {
    const user = store.readJson(routine.mcpConfigPath, {});
    Object.assign(servers, (user && user.mcpServers) || {});
  }
  servers.routine_approver = {
    command: process.execPath,
    args: [path.join(__dirname, 'approver-mcp.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ROUTINES_HOME: store.paths.home,
      ROUTINE_ID: routine.id,
      ROUTINE_NAME: routine.name,
      RUN_ID: runId,
      APPROVAL_TIMEOUT_SEC: String(routine.approvalTimeoutSec || 600),
    },
  };
  // Holds expanded secrets, so it's private and deleted when the run ends.
  const file = path.join(runDir, 'mcp.json');
  store.writeJson(file, { mcpServers: servers }, 0o600);
  return file;
}

function buildArgs(routine, mcpFile) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(routine.maxTurns || 15),
    '--mcp-config', mcpFile,
    '--permission-prompt-tool', 'mcp__routine_approver__approve',
  ];
  if (routine.model) args.push('--model', routine.model);
  if (routine.permissionMode && routine.permissionMode !== 'default') {
    args.push('--permission-mode', routine.permissionMode);
  }
  const allowed = (routine.allowedTools || []).filter(Boolean);
  if (allowed.length) args.push('--allowedTools', ...allowed);
  const disallowed = (routine.disallowedTools || []).filter(Boolean);
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  return args;
}

function stripFrontmatter(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

async function main() {
  store.ensureDirs();
  const routine = store.getRoutine(routineId);
  if (!routine) {
    log('routine not found');
    process.exit(1);
  }
  const cfg = store.getConfig();
  vars = collectVars(cfg);

  if (!store.acquireLock(routineId)) {
    store.updateState(routineId, { lastSkipAt: new Date().toISOString(), lastSkipReason: 'Previous run still in progress' });
    log('skipped: previous run still in progress');
    return;
  }

  let runDir;
  let meta;
  try {
    const check = runPrecheck(routine, cfg);
    store.updateState(routineId, { lastCheckAt: new Date().toISOString() });
    if (!check.ok) {
      store.updateState(routineId, {
        lastSkipAt: new Date().toISOString(),
        lastSkipReason: `Pre-check exited ${check.code}${check.error ? `: ${check.error.split('\n')[0]}` : ''}`,
      });
      log('skipped: pre-check found nothing to do');
      return;
    }

    const runId = store.newRunId();
    runDir = store.paths.runDir(routineId, runId);
    fs.mkdirSync(runDir, { recursive: true });

    let prompt = stripFrontmatter(routine.prompt);
    if (check.output) prompt += `\n\n## Pre-check output\n\n\`\`\`\n${check.output}\n\`\`\`\n`;
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);

    const claudePath = cfg.claudePath || 'claude';
    const mcpFile = writeMcpConfig(routine, cfg, runDir, runId);
    const args = buildArgs(routine, mcpFile);

    meta = {
      id: runId,
      routineId,
      routineName: routine.name,
      trigger,
      status: 'running',
      startedAt: new Date().toISOString(),
      runnerPid: process.pid,
      command: [claudePath, ...args].join(' '),
      cwd: routine.cwd,
    };
    store.writeJson(path.join(runDir, 'meta.json'), meta);
    store.updateState(routineId, { lastRunId: runId, lastRunAt: meta.startedAt });
    log(`run ${runId} started`);

    const approvalMs = (routine.approvalTimeoutSec || 600) * 1000;
    const child = spawn(claudePath, args, {
      cwd: routine.cwd,
      env: buildEnv(cfg, { MCP_TOOL_TIMEOUT: String(approvalMs + 60_000) }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    meta.pid = child.pid;
    store.writeJson(path.join(runDir, 'meta.json'), meta);

    const events = fs.createWriteStream(path.join(runDir, 'events.jsonl'));
    const stderr = fs.createWriteStream(path.join(runDir, 'stderr.log'));
    let finalResult = null;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      events.write(chunk);
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') finalResult = ev;
          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            meta.sessionId = ev.session_id;
            meta.model = ev.model;
            store.writeJson(path.join(runDir, 'meta.json'), meta);
          }
        } catch {}
      }
    });
    child.stderr.pipe(stderr);
    child.stdin.end(prompt);

    const timeout = setTimeout(() => {
      meta.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, (routine.timeoutMinutes || 30) * 60_000);

    const exitCode = await new Promise((resolve) => {
      child.on('error', (e) => {
        stderr.write(`Failed to start claude: ${e.message}\n`);
        resolve(-1);
      });
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : -1)));
    });
    clearTimeout(timeout);
    events.end();
    stderr.end();

    const stopped = store.readJson(path.join(runDir, 'stop.json'));
    meta.endedAt = new Date().toISOString();
    meta.exitCode = exitCode;
    if (finalResult) {
      meta.sessionId = finalResult.session_id || meta.sessionId;
      meta.costUsd = finalResult.total_cost_usd;
      meta.numTurns = finalResult.num_turns;
      meta.durationMs = finalResult.duration_ms;
      meta.resultText = typeof finalResult.result === 'string' ? finalResult.result : '';
      meta.resultSubtype = finalResult.subtype;
      meta.permissionDenials = finalResult.permission_denials || [];
    }
    if (stopped) meta.status = 'stopped';
    else if (meta.timedOut) meta.status = 'timeout';
    else if (exitCode === 0 && finalResult && !finalResult.is_error) meta.status = 'success';
    else meta.status = 'error';
    store.writeJson(path.join(runDir, 'meta.json'), meta);
    store.updateState(routineId, { lastStatus: meta.status });
    log(`run ${runId} finished: ${meta.status}`);
  } catch (e) {
    log(`runner error: ${e.stack || e}`);
    if (meta && runDir) {
      meta.status = 'error';
      meta.endedAt = new Date().toISOString();
      meta.runnerError = String(e.message || e);
      store.writeJson(path.join(runDir, 'meta.json'), meta);
    }
  } finally {
    if (runDir) fs.rmSync(path.join(runDir, 'mcp.json'), { force: true });
    store.releaseLock(routineId);
    store.pruneRuns(routineId, routine.keepRuns || 300);
  }
}

main();

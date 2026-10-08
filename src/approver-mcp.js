// Minimal stdio MCP server that Claude Code calls (via --permission-prompt-tool)
// whenever a tool isn't pre-allowed. It drops a request file into the pending
// folder and waits for the desktop app to write a decision. No decision before
// the timeout means deny.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths, readJson, writeJson } = require('./lib/store');

const ROUTINE_ID = process.env.ROUTINE_ID || 'unknown';
const ROUTINE_NAME = process.env.ROUTINE_NAME || ROUTINE_ID;
const RUN_ID = process.env.RUN_ID || 'unknown';
const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_SEC || 600) * 1000;

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function result(text) {
  return { content: [{ type: 'text', text }] };
}

function askForDecision(args) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pendingFile = path.join(paths.pending, `${id}.json`);
  const decisionFile = path.join(paths.decisions, `${id}.json`);
  writeJson(pendingFile, {
    id,
    routineId: ROUTINE_ID,
    routineName: ROUTINE_NAME,
    runId: RUN_ID,
    toolName: args.tool_name,
    input: args.input || {},
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TIMEOUT_MS).toISOString(),
  });

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const decision = readJson(decisionFile);
      const timedOut = Date.now() - started > TIMEOUT_MS;
      if (!decision && !timedOut) return;
      clearInterval(timer);
      fs.rmSync(pendingFile, { force: true });
      fs.rmSync(decisionFile, { force: true });
      if (decision && decision.behavior === 'allow') {
        resolve({ behavior: 'allow', updatedInput: args.input || {} });
      } else {
        resolve({
          behavior: 'deny',
          message: decision
            ? decision.message || 'Denied by the user in Claude Routines.'
            : 'No approval within the timeout. Denied automatically.',
        });
      }
    }, 700);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'routine_approver', version: '0.1.0' },
      },
    });
  }
  if (method === 'tools/list') {
    return send({
      id,
      result: {
        tools: [
          {
            name: 'approve',
            description: 'Asks the user in the Claude Routines app to allow or deny a tool call.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      },
    });
  }
  if (method === 'tools/call') {
    const decision = await askForDecision((params && params.arguments) || {});
    return send({ id, result: result(JSON.stringify(decision)) });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line)).catch((e) => process.stderr.write(String(e) + '\n'));
    } catch (e) {
      process.stderr.write(`Bad message: ${e}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

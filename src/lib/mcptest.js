// Connects to one MCP server, runs initialize + tools/list, and reports back.
const { spawn } = require('child_process');

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-routines-test', version: '0.1.0' } },
};

function testStdio(server, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(server.command, server.args || [], { env: { ...env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let buf = '';
    let stderr = '';
    let info = null;
    const done = (res) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve(res);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `No response within ${timeoutMs / 1000}s`, stderr: stderr.slice(-800) }),
      timeoutMs,
    );
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('exit', (code) => done({ ok: false, error: `Exited with code ${code}`, stderr: stderr.slice(-800) }));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return done({ ok: false, error: msg.error.message });
          info = msg.result?.serverInfo;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          done({ ok: true, server: info, tools: (msg.result?.tools || []).map((t) => t.name) });
        }
      }
    });
    child.stdin.write(JSON.stringify(INIT) + '\n');
  });
}

async function rpcHttp(url, headers, body, sessionId, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (needs authentication: check the token or header)' : ''}: ${text.slice(0, 200)}`);
  // Streamable HTTP may answer as SSE; take the first data line that parses.
  let msg = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        msg = JSON.parse(line.slice(5));
        break;
      } catch {}
    }
  } else if (text.trim()) {
    msg = JSON.parse(text);
  }
  return { msg, sessionId: res.headers.get('mcp-session-id') || sessionId };
}

async function testHttp(server, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = server.headers || {};
    const init = await rpcHttp(server.url, headers, INIT, null, ctrl.signal);
    if (init.msg?.error) throw new Error(init.msg.error.message);
    await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.sessionId ? { 'mcp-session-id': init.sessionId } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: ctrl.signal,
    }).catch(() => {});
    const list = await rpcHttp(server.url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sessionId, ctrl.signal);
    return { ok: true, server: init.msg?.result?.serverInfo, tools: (list.msg?.result?.tools || []).map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `No response within ${timeoutMs / 1000}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function testServer(server, env, timeoutMs = 20_000) {
  const type = server.type || (server.url ? 'http' : 'stdio');
  if (type === 'stdio') return testStdio(server, env, timeoutMs);
  if (type === 'http') return testHttp(server, timeoutMs);
  return Promise.resolve({ ok: false, error: `Type "${type}" can't be tested here. Use "Check with Claude Code".` });
}

module.exports = { testServer };

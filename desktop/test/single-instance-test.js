'use strict';

// Tests the single-instance probe (main.js#isAnotherInstanceRunning) in
// isolation: it must say "running" only for OUR dashboard, and "free to start"
// for a dead port or an unrelated program squatting it.

const http = require('http');
const assert = require('assert');

const { isAnotherInstanceRunning } = require('../src/main');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}`); failed++; }
}

function listen(server, port) {
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}
function close(server) {
  return new Promise((res) => server.close(res));
}

const PORT = 8497; // an unused port for the fakes

async function main() {
  // 1. Nothing listening → free to start.
  check('dead port → not running', (await isAnotherInstanceRunning('127.0.0.1', PORT)) === false);

  // 2. An unrelated program squatting the port (plain text, not our JSON).
  const squatter = await listen(
    http.createServer((req, res) => { res.writeHead(200); res.end('hello from something else'); }),
    PORT
  );
  check('foreign server on port → not running', (await isAnotherInstanceRunning('127.0.0.1', PORT)) === false);
  await close(squatter);

  // 3. Our own dashboard shape (JSON with controlUrl) → already running.
  const ours = await listen(
    http.createServer((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ running: true, controlUrl: `http://127.0.0.1:${PORT}` }));
      } else { res.writeHead(404); res.end(); }
    }),
    PORT
  );
  check('our dashboard on port → running', (await isAnotherInstanceRunning('127.0.0.1', PORT)) === true);
  await close(ours);

  // 4. Back to free once it's gone.
  check('port freed again → not running', (await isAnotherInstanceRunning('127.0.0.1', PORT)) === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

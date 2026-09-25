/**
 * dev-server.js — runs the web app locally against the GAS emulator.
 *   node tests/dev-server.js [port] [--now "2026-09-25 09:00"]
 * Serves doGet() output with a google.script.run shim that forwards
 * api(action, payload, token) calls to the emulated backend.
 * Demo credentials are printed on start (ADMIN01 PIN from INIT_ADMIN_PIN).
 */
'use strict';
const http = require('http');
const { createGasEnv } = require('./gas-mock');

function startServer(opts = {}) {
  const env = createGasEnv({ quiet: !opts.verbose, props: { INIT_ADMIN_ID: 'ADMIN01', INIT_ADMIN_NAME: 'ผู้ดูแลระบบ', INIT_ADMIN_PIN: opts.adminPin || '482913', BASE_URL: 'http://localhost/app' } });
  if (opts.now) env.setNow(opts.now, true);
  env.ctx.setupDatabase();
  env.ctx.setupFirstAdmin();
  env.ctx.seedSampleData();
  if (opts.config) env.setConfig(opts.config);
  env.newExecution();
  env.ctx.runScheduler();
  const pins = {};
  env.logs.join('\n').split('\n').forEach((l) => { const m = l.match(/^(\S+) \((\w+)\) PIN: (\d+)$/); if (m) pins[m[1]] = m[3]; });
  pins.ADMIN01 = opts.adminPin || '482913';

  const shim = `<script>
  (function(){
    function Runner(s, f){ this._s = s; this._f = f; }
    Runner.prototype.withSuccessHandler = function(fn){ return new Runner(fn, this._f); };
    Runner.prototype.withFailureHandler = function(fn){ return new Runner(this._s, fn); };
    Runner.prototype.api = function(a, p, t){
      var s = this._s, f = this._f;
      fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: a, p: p, t: t }) })
        .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(d){ s && s(d); }).catch(function(e){ f && f(e); });
    };
    window.google = { script: { run: new Runner() } };
  })();
  </script>`;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { a, p, t } = JSON.parse(body);
          const out = env.api(a, p, t);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500); res.end(String(e && e.stack || e));
        }
      });
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const u = new URL(req.url, 'http://x');
      env.newExecution();
      const out = env.ctx.doGet({ parameter: Object.fromEntries(u.searchParams) });
      const html = out.getContent().replace('<head>', '<head>' + shim);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(opts.port || 0, () => resolve({ server, env, pins, port: server.address().port }));
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => /^\d+$/.test(a))) || 8080;
  const nowIdx = args.indexOf('--now');
  startServer({ port, now: nowIdx >= 0 ? args[nowIdx + 1] : null, verbose: args.includes('--verbose') }).then(({ port: p, pins }) => {
    console.log('Dev server: http://localhost:' + p);
    console.log('Demo logins:', pins);
  });
}
module.exports = { startServer };

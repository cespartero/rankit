'use strict';
// Rank It server. No external dependencies: Node's built-in http, crypto and fs only.
//
// Runs two web servers from one process so voters can never change the list:
//   VOTE_PORT   (default 8080) - public: voting page, submit your own ranking, live results
//   MANAGE_PORT (default 8081) - manage page: edit the list, settings, results, clear votes
//                                (put this one behind Cloudflare Access)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');
const { createState, HttpError } = require('./state');

const env = process.env;
const VOTE_PORT = Number(env.VOTE_PORT || 8080);
const MANAGE_PORT = Number(env.MANAGE_PORT || 8081);
const MAX_BODY = 200_000;
const COOKIE = 'rankit_voter';

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
let VERSION = 'dev';
try { VERSION = JSON.parse(pub('version.json')).version || 'dev'; } catch (_) {}
// VOTE_URL (optional): the public voting link, shown on the manage page with a Copy button
const VOTE_URL = (env.VOTE_URL || '').trim();
const inject = (html, vars) => html.replace('</head>',
  `<script>${Object.entries(vars).map(([k, v]) => `window.${k}=${JSON.stringify(v).replace(/</g, '\\u003c')};`).join('')}</script>\n</head>`);
const PAGES = {
  vote: inject(pub('vote.html'), { APP_VERSION: VERSION }),
  manage: inject(pub('manage.html'), { APP_VERSION: VERSION, VOTE_URL }),
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Each browser gets a random voter id in a cookie, so people can come back and change their ranking.
// One ranking per browser: it stops casual double-voting, not someone determined to cheat.
function voterId(req, res) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})`));
  if (m) return m[1];
  const id = crypto.randomBytes(16).toString('hex');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  return id;
}

// Server-Sent Events: each screen gets its own view whenever anything changes
function openEvents(state, req, res, view) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const push = () => res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`);
  push();
  const off = state.subscribe(push);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000); // keeps tunnels/proxies from closing it
  req.on('close', () => { off(); clearInterval(ping); });
}

function makeHandler(state, mode) {
  const manage = mode === 'manage';
  return async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const m = req.method;
    try {
      if (m === 'GET' && (p === '/' || p === '/index.html')) {
        if (!manage) voterId(req, res); // set the cookie with the page
        return send(res, 200, PAGES[mode]);
      }
      if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true, mode, version: VERSION });

      if (!manage) {
        if (m === 'GET' && p === '/api/state') { const id = voterId(req, res); return send(res, 200, state.voteView(id)); }
        if (m === 'GET' && p === '/api/events') { const id = voterId(req, res); return openEvents(state, req, res, () => state.voteView(id)); }
        if (m === 'PUT' && p === '/api/ballot') {
          const id = voterId(req, res);
          const b = await readJson(req);
          return send(res, 200, state.submitBallot(id, b.order, b.unknown || []));
        }
        return send(res, 404, { error: 'Not found' }); // the vote port can't change the list
      }

      if (m === 'GET' && p === '/api/state') return send(res, 200, state.manageView());
      if (m === 'GET' && p === '/api/events') return openEvents(state, req, res, () => state.manageView());
      if (m === 'PUT' && p === '/api/list') return send(res, 200, state.saveList(await readJson(req)));
      if (m === 'PATCH' && p === '/api/settings') return send(res, 200, state.saveSettings(await readJson(req)));
      if (m === 'DELETE' && p === '/api/ballots') return send(res, 200, state.clearVotes());
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}

async function main() {
  const store = createStore(env);
  const state = createState({ store, log: { info: (...a) => console.log(...a), error: (...a) => console.error(...a) } });
  await state.init();

  http.createServer(makeHandler(state, 'vote')).listen(VOTE_PORT, () => console.log(`Vote site (public) on :${VOTE_PORT}`));
  http.createServer(makeHandler(state, 'manage')).listen(MANAGE_PORT, () => console.log(`Manage site on :${MANAGE_PORT}`));
  console.log(`Storage: ${store.name}`);
  console.log(`Version: ${VERSION}`);

  const stop = async sig => {
    console.log(`${sig} received, saving and shutting down`);
    try { await state.flush(); } catch (e) { console.error('Final save failed:', e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch(e => { console.error(e); process.exit(1); });

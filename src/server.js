'use strict';
// Rank It server. No external dependencies: Node's built-in http, crypto and fs only.
//
// Runs two web servers from one process so voters can never change the list:
//   VOTE_PORT   (default 8080) - public: enter a code, answer a poll at /p/<id>, live results
//   MANAGE_PORT (default 8081) - manage: create and edit polls, open/close them, results, reports
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
// VOTE_URL (optional): the public vote site's address, used to build each poll's link and QR code
const VOTE_URL = (env.VOTE_URL || '').trim().replace(/\/+$/, '');
const inject = (html, vars) => html.replace('</head>',
  `<script>${Object.entries(vars).map(([k, v]) => `window.${k}=${JSON.stringify(v).replace(/</g, '\\u003c')};`).join('')}</script>\n</head>`);
const PAGES = {
  home: inject(pub('home.html'), { APP_VERSION: VERSION }),
  poll: inject(pub('poll.html'), { APP_VERSION: VERSION }),
  manage: inject(pub('manage.html'), { APP_VERSION: VERSION, VOTE_URL }),
  report: inject(pub('report.html'), { APP_VERSION: VERSION, VOTE_URL }),
};
const ASSETS = { '/assets/qr.js': pub('qr.js'), '/assets/common.js': pub('common.js'), '/assets/common.css': pub('common.css') };

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

// Server-Sent Events: each screen gets fresh data whenever something it shows changes
function openEvents(state, req, res, onChange, initial) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const push = data => res.write(`event: state\ndata: ${JSON.stringify(data)}\n\n`);
  if (initial) push(initial());
  const off = state.subscribe(pollId => { const d = onChange(pollId); if (d !== undefined) push(d); });
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000); // keeps tunnels/proxies from closing it
  req.on('close', () => { off(); clearInterval(ping); });
}

// Slow down anyone trying to guess poll codes: 20 lookups a minute per address
const codeTries = new Map();
function tooManyCodeTries(req) {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
  const t = Date.now(), list = (codeTries.get(ip) || []).filter(x => t - x < 60_000);
  list.push(t); codeTries.set(ip, list);
  if (codeTries.size > 5000) codeTries.clear();
  return list.length > 20;
}

function sendAsset(res, p) {
  const type = p.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  res.end(ASSETS[p]);
}

function makeHandler(state, mode) {
  const manage = mode === 'manage';
  return async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const m = req.method;
    const pollRoute = p.match(/^\/api\/polls\/([a-z0-9]{6,20})(\/[a-z]+)?$/);
    const pid = pollRoute && pollRoute[1], sub = pollRoute && (pollRoute[2] || '');
    try {
      if (m === 'GET' && ASSETS[p]) return sendAsset(res, p);
      if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true, mode, version: VERSION });

      if (!manage) {
        if (m === 'GET' && (p === '/' || p === '/index.html')) { voterId(req, res); return send(res, 200, PAGES.home); }
        if (m === 'GET' && /^\/p\/[a-z0-9]{6,20}\/?$/.test(p)) { voterId(req, res); return send(res, 200, PAGES.poll); }
        const codeRoute = p.match(/^\/api\/code\/(\d{1,8})$/);
        if (m === 'GET' && codeRoute) {
          if (tooManyCodeTries(req)) return send(res, 429, { error: 'Too many tries. Wait a minute and try again.' });
          const poll = state.findByCode(codeRoute[1]);
          return poll ? send(res, 200, { id: poll.id }) : send(res, 404, { error: 'No poll with that code.' });
        }
        if (pid && m === 'GET' && sub === '') { const id = voterId(req, res); return send(res, 200, state.voteView(pid, id)); }
        if (pid && m === 'GET' && sub === '/events') {
          const id = voterId(req, res);
          state.voteView(pid, id); // 404 if the poll doesn't exist
          return openEvents(state, req, res, changed => changed === pid ? (safeView(() => state.voteView(pid, id)) ?? { deleted: true }) : undefined, () => state.voteView(pid, id));
        }
        if (pid && m === 'PUT' && sub === '/response') {
          const id = voterId(req, res);
          const b = await readJson(req);
          return send(res, 200, state.submitResponse(pid, id, b.answers));
        }
        return send(res, 404, { error: 'Not found' }); // the vote port can't create or change polls
      }

      if (m === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, PAGES.manage);
      if (m === 'GET' && /^\/report\/[a-z0-9]{6,20}\/?$/.test(p)) return send(res, 200, PAGES.report);
      if (m === 'GET' && p === '/api/polls') return send(res, 200, state.listPolls());
      if (m === 'POST' && p === '/api/polls') return send(res, 201, state.createPoll(await readJson(req)));
      if (m === 'GET' && p === '/api/events') return openEvents(state, req, res, changed => ({ changed }), () => ({ changed: null }));
      if (pid) {
        if (m === 'GET' && sub === '') return send(res, 200, state.manageView(pid));
        if (m === 'PUT' && sub === '') return send(res, 200, state.updatePoll(pid, await readJson(req)));
        if (m === 'DELETE' && sub === '') return send(res, 200, state.deletePoll(pid));
        if (m === 'POST' && sub === '/open') return send(res, 200, state.openPoll(pid, await readJson(req)));
        if (m === 'POST' && sub === '/close') return send(res, 200, state.closePoll(pid));
        if (m === 'POST' && sub === '/duplicate') return send(res, 201, state.duplicatePoll(pid));
        if (m === 'DELETE' && sub === '/responses') return send(res, 200, state.clearResponses(pid));
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}

function safeView(fn) { try { return fn(); } catch (_) { return null; } }

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

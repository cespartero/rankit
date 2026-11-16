'use strict';
// Rank It state: polls, their questions, everyone's answers, timers and live updates.
//
// A poll has its own link (/p/<slug>) and a 4-digit code, a status (draft, open, closed),
// an optional closing time, and one or more questions:
//   rank   - order the options; "I don't know" allowed. On each ballot the top item scores 100,
//            the bottom 0, spread evenly; an item's score is the average over people who ranked it.
//   choice - pick one option, or any number of options (multi)
//   number - a number, optionally limited by min / max / step, with an optional unit
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LIMITS = { polls: 500, questions: 30, options: 100, text: 200, title: 120, subtitle: 300, responses: 10000 };
const RESULTS_MODES = ['always', 'after-vote', 'hidden'];
const TYPES = ['rank', 'choice', 'number'];
const MAX_TIMER = 2 ** 31 - 1; // setTimeout limit (~24.8 days); longer timers re-arm in steps

const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i, l, o, 0, 1)
const slug = () => Array.from(crypto.randomBytes(8), b => SLUG_CHARS[b % SLUG_CHARS.length]).join('');
const shortId = p => p + crypto.randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const num = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function emptyDb() { return { version: 2, polls: {} }; }

function createState({ store, log = console, now = () => Date.now() }) {
  let db = emptyDb();
  const listeners = new Set();
  const timers = new Map();
  let saveTimer = null;
  let saving = Promise.resolve();

  // ---------- load, migrate, save ----------
  async function init() {
    const loaded = await store.load();
    if (loaded && loaded.polls) db = { ...emptyDb(), ...loaded };
    else if (loaded && Array.isArray(loaded.items)) {
      // Version 1 kept a single ranking list. Keep a copy, then turn it into the first poll.
      if (store.backup) await store.backup('db.v1-backup.json', loaded);
      db = emptyDb();
      const p = migrateV1(loaded);
      db.polls[p.id] = p;
      log.info(`Moved the existing list into poll "${p.title || 'Untitled'}" (code ${p.code}); backup saved as db.v1-backup.json`);
      await store.save(db);
    }
    Object.values(db.polls).forEach(armTimer);
    log.info(`Loaded ${Object.keys(db.polls).length} polls`);
  }

  function migrateV1(old) {
    const q = { id: shortId('q'), type: 'rank', text: old.subtitle || 'Rank these', required: true,
      options: (old.items || []).map(i => ({ id: i.id, text: i.text })) };
    const responses = {};
    for (const [voter, b] of Object.entries(old.ballots || {})) {
      responses[voter] = { at: b.at, answers: { [q.id]: { order: b.order || [], unknown: b.unknown || [] } } };
    }
    return {
      id: slug(), code: newCode(), title: old.title || '', subtitle: '',
      questions: [q], status: old.open === false ? 'closed' : 'open', resultsMode: RESULTS_MODES.includes(old.results) ? old.results : 'always',
      createdAt: new Date(now()).toISOString(), openedAt: new Date(now()).toISOString(), closedAt: old.open === false ? new Date(now()).toISOString() : null,
      closesAt: null, responses,
    };
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saving = saving.then(() => store.save(db)).catch(e => log.error('Save failed:', e)); }, 300);
  }
  async function flush() { clearTimeout(saveTimer); await saving; await store.save(db); }

  function changed(pollId) {
    scheduleSave();
    for (const fn of listeners) { try { fn(pollId); } catch (e) { log.error(e); } }
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ---------- lookups ----------
  function get(id) {
    const p = db.polls[id];
    if (!p) throw new HttpError(404, 'Poll not found.');
    return p;
  }
  function findByCode(code) {
    const c = String(code || '').trim();
    return Object.values(db.polls).find(p => p.code === c && p.status !== 'draft') || null;
  }
  function newCode() {
    const used = new Set(Object.values(db.polls).map(p => p.code));
    for (let digits = 4; ; digits++) {
      for (let tries = 0; tries < 50; tries++) {
        const c = String(crypto.randomInt(10 ** (digits - 1), 10 ** digits));
        if (!used.has(c)) return c;
      }
    }
  }

  // ---------- open / close / timers ----------
  function isOpen(p) { return p.status === 'open' && (!p.closesAt || now() < Date.parse(p.closesAt)); }

  function armTimer(p) {
    clearTimeout(timers.get(p.id));
    timers.delete(p.id);
    if (p.status !== 'open' || !p.closesAt) return;
    const wait = Date.parse(p.closesAt) - now();
    if (wait <= 0) { autoClose(p.id); return; }
    timers.set(p.id, setTimeout(() => (wait > MAX_TIMER ? armTimer(db.polls[p.id] || {}) : autoClose(p.id)), Math.min(wait, MAX_TIMER)));
  }
  function autoClose(id) {
    const p = db.polls[id];
    if (!p || p.status !== 'open') return;
    p.status = 'closed';
    p.closedAt = p.closesAt || new Date(now()).toISOString();
    timers.delete(id);
    log.info(`Poll ${p.code} closed automatically`);
    changed(id);
  }

  function openPoll(id, { durationMinutes, closesAt } = {}) {
    const p = get(id);
    if (!p.questions.length) throw new HttpError(409, 'Add at least one question first.');
    for (const q of p.questions) if (q.type !== 'number' && q.options.length < 2) throw new HttpError(409, `"${q.text || 'A question'}" needs at least 2 options.`);
    let until = null;
    const mins = num(durationMinutes);
    if (mins !== null) {
      if (mins <= 0 || mins > 60 * 24 * 366) throw new HttpError(400, 'Duration must be between 1 minute and a year.');
      until = new Date(now() + mins * 60000).toISOString();
    } else if (closesAt) {
      const t = Date.parse(closesAt);
      if (!Number.isFinite(t) || t <= now()) throw new HttpError(400, 'The closing time must be in the future.');
      until = new Date(t).toISOString();
    }
    p.status = 'open';
    p.closesAt = until;
    p.openedAt = new Date(now()).toISOString();
    p.closedAt = null;
    armTimer(p);
    changed(id);
    return manageView(id);
  }
  function closePoll(id) {
    const p = get(id);
    if (p.status === 'open') { p.status = 'closed'; p.closedAt = new Date(now()).toISOString(); }
    armTimer(p);
    changed(id);
    return manageView(id);
  }

  // ---------- create / edit / delete ----------
  function createPoll(input = {}) {
    if (Object.keys(db.polls).length >= LIMITS.polls) throw new HttpError(409, `At most ${LIMITS.polls} polls. Delete some old ones first.`);
    const p = {
      id: slug(), code: newCode(), title: '', subtitle: '', questions: [], status: 'draft', resultsMode: 'always',
      createdAt: new Date(now()).toISOString(), openedAt: null, closedAt: null, closesAt: null, responses: {},
    };
    db.polls[p.id] = p;
    applyEdits(p, { title: input.title || 'Untitled poll', subtitle: input.subtitle, questions: input.questions || [] });
    changed(p.id);
    return manageView(p.id);
  }

  function duplicatePoll(id) {
    const src = get(id);
    const copy = createPoll({ title: (src.title + ' (copy)').slice(0, LIMITS.title), subtitle: src.subtitle,
      questions: src.questions.map(q => ({ ...q, id: undefined, options: (q.options || []).map(o => ({ text: o.text })) })) });
    db.polls[copy.id].resultsMode = src.resultsMode;
    return manageView(copy.id);
  }

  function deletePoll(id) {
    get(id);
    clearTimeout(timers.get(id)); timers.delete(id);
    delete db.polls[id];
    changed(id);
    return { ok: true };
  }

  function clearResponses(id) { get(id).responses = {}; changed(id); return manageView(id); }

  function updatePoll(id, input) {
    const p = get(id);
    applyEdits(p, input);
    if (input.resultsMode !== undefined) {
      if (!RESULTS_MODES.includes(input.resultsMode)) throw new HttpError(400, 'Unknown results setting.');
      p.resultsMode = input.resultsMode;
    }
    if (input.closesAt !== undefined && p.status === 'open') {
      // change or remove the timer on an open poll
      if (input.closesAt === null || input.closesAt === '') p.closesAt = null;
      else {
        const t = Date.parse(input.closesAt);
        if (!Number.isFinite(t) || t <= now()) throw new HttpError(400, 'The closing time must be in the future.');
        p.closesAt = new Date(t).toISOString();
      }
      armTimer(p);
    }
    changed(id);
    return manageView(id);
  }

  // Questions keep their id (and answers) when sent back with it; options keep their id when their text is unchanged.
  function applyEdits(p, { title, subtitle, questions }) {
    if (title !== undefined) p.title = clean(title, LIMITS.title);
    if (subtitle !== undefined) p.subtitle = clean(subtitle, LIMITS.subtitle);
    if (questions === undefined) return;
    if (!Array.isArray(questions)) throw new HttpError(400, 'questions must be a list.');
    if (questions.length > LIMITS.questions) throw new HttpError(400, `At most ${LIMITS.questions} questions.`);
    const old = new Map(p.questions.map(q => [q.id, q]));
    p.questions = questions.map((raw, i) => {
      const type = TYPES.includes(raw.type) ? raw.type : null;
      if (!type) throw new HttpError(400, `Question ${i + 1} has an unknown type.`);
      const prev = raw.id && old.get(raw.id);
      const q = { id: prev ? prev.id : shortId('q'), type, text: clean(raw.text, LIMITS.text), required: raw.required !== false };
      if (type === 'number') {
        q.min = num(raw.min); q.max = num(raw.max);
        q.step = num(raw.step) && num(raw.step) > 0 ? num(raw.step) : 1;
        q.unit = clean(raw.unit, 20);
        if (q.min !== null && q.max !== null && q.min >= q.max) throw new HttpError(400, `Question ${i + 1}: the minimum must be less than the maximum.`);
      } else {
        const prevOpts = new Map(((prev && prev.type === type) ? prev.options : []).map(o => [o.text, o.id]));
        const seen = new Set();
        q.options = (Array.isArray(raw.options) ? raw.options : [])
          .map(o => clean(typeof o === 'object' && o ? o.text : o, LIMITS.text))
          .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
          .map(text => ({ id: prevOpts.get(text) || shortId('o'), text }));
        if (q.options.length > LIMITS.options) throw new HttpError(400, `Question ${i + 1}: at most ${LIMITS.options} options.`);
        if (type === 'choice') q.multi = !!raw.multi;
      }
      return q;
    });
  }

  // ---------- answers ----------
  // Returns the cleaned answer, or null if the answer doesn't fit the question (e.g. the question was edited).
  function cleanAnswer(q, a) {
    if (!a || typeof a !== 'object') return null;
    const ids = (q.options || []).map(o => o.id);
    if (q.type === 'rank') {
      if (!Array.isArray(a.order)) return null;
      const seen = new Set();
      const pick = list => (Array.isArray(list) ? list : []).map(String).filter(id => ids.includes(id) && !seen.has(id) && seen.add(id));
      const order = pick(a.order), unknown = pick(a.unknown);
      if (order.length === 1 && ids.length > 1) return null; // one ranked item says nothing
      return { order, unknown };
    }
    if (q.type === 'choice') {
      const sel = [...new Set((Array.isArray(a.selected) ? a.selected : []).map(String).filter(id => ids.includes(id)))];
      if (!sel.length || (!q.multi && sel.length > 1)) return null;
      return { selected: sel };
    }
    if (q.type === 'number') {
      const v = num(a.value);
      if (v === null) return null;
      if ((q.min !== null && v < q.min) || (q.max !== null && v > q.max)) return null;
      return { value: round(v, 6) };
    }
    return null;
  }

  function submitResponse(id, voterId, answers) {
    const p = get(id);
    if (!voterId) throw new HttpError(400, 'Missing voter id.');
    if (p.status === 'draft') throw new HttpError(409, "This poll isn't open yet.");
    if (!isOpen(p)) throw new HttpError(409, 'This poll is closed.');
    if (!answers || typeof answers !== 'object') throw new HttpError(400, 'answers must be an object.');
    const out = {};
    p.questions.forEach((q, i) => {
      const label = `Question ${i + 1}`;
      const raw = answers[q.id];
      const blank = raw === undefined || raw === null || (q.type === 'number' && num(raw.value) === null) ||
        (q.type === 'choice' && !(raw.selected || []).length);
      if (blank) { if (q.required) throw new HttpError(400, `${label} needs an answer.`); return; }
      const a = cleanAnswer(q, raw);
      if (!a) {
        if (q.type === 'rank') throw new HttpError(400, `${label}: rank at least 2 items, or mark them all "I don't know".`);
        if (q.type === 'number') throw new HttpError(400, `${label}: enter a number${q.min !== null && q.max !== null ? ` from ${q.min} to ${q.max}` : ''}.`);
        throw new HttpError(400, `${label}: ${q.multi ? 'pick at least one option' : 'pick one option'}.`);
      }
      if (q.type === 'rank' && a.order.length + a.unknown.length !== q.options.length)
        throw new HttpError(400, `${label}: rank every item or mark it "I don't know".`);
      out[q.id] = a;
    });
    if (!p.responses[voterId] && Object.keys(p.responses).length >= LIMITS.responses) throw new HttpError(429, 'This poll has reached its response limit.');
    p.responses[voterId] = { at: new Date(now()).toISOString(), answers: out };
    changed(id);
    return voteView(id, voterId);
  }

  // ---------- results ----------
  function questionResults(q, responses) {
    const answers = responses.map(r => r.answers && cleanAnswer(q, r.answers[q.id])).filter(Boolean);
    if (q.type === 'rank') {
      const sum = {}, rankedBy = {}, firsts = {}, unknownBy = {};
      q.options.forEach(o => { sum[o.id] = 0; rankedBy[o.id] = 0; firsts[o.id] = 0; unknownBy[o.id] = 0; });
      for (const a of answers) {
        a.unknown.forEach(id => unknownBy[id]++);
        const k = a.order.length;
        if (k < 2) continue;
        a.order.forEach((id, i) => { sum[id] += (k - 1 - i) / (k - 1); rankedBy[id]++; if (i === 0) firsts[id]++; });
      }
      const rows = q.options.map(o => ({
        id: o.id, text: o.text, score: rankedBy[o.id] ? Math.round(sum[o.id] / rankedBy[o.id] * 100) : null,
        rankedBy: rankedBy[o.id], unknownBy: unknownBy[o.id], firsts: firsts[o.id],
      })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.rankedBy - a.rankedBy || b.firsts - a.firsts);
      let rank = 0, last;
      rows.forEach((r, i) => { if (r.score === null) { r.rank = null; return; } if (r.score !== last) { rank = i + 1; last = r.score; } r.rank = rank; });
      return { type: 'rank', answered: answers.length, rows };
    }
    if (q.type === 'choice') {
      const count = {};
      q.options.forEach(o => { count[o.id] = 0; });
      answers.forEach(a => a.selected.forEach(id => count[id]++));
      const rows = q.options.map(o => ({ id: o.id, text: o.text, count: count[o.id],
        percent: answers.length ? Math.round(count[o.id] / answers.length * 100) : 0 }))
        .sort((a, b) => b.count - a.count);
      let rank = 0, last;
      rows.forEach((r, i) => { if (r.count !== last) { rank = i + 1; last = r.count; } r.rank = rank; });
      return { type: 'choice', multi: !!q.multi, answered: answers.length, rows };
    }
    // number
    const vals = answers.map(a => a.value).sort((a, b) => a - b);
    const n = vals.length;
    if (!n) return { type: 'number', answered: 0, unit: q.unit, bins: [] };
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    const median = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
    return { type: 'number', answered: n, unit: q.unit, mean: round(mean), median: round(median), min: vals[0], max: vals[n - 1], bins: bins(q, vals) };
  }

  // Bar chart buckets: one bar per value for a small scale (e.g. 1-10), otherwise up to 8 even ranges
  function bins(q, vals) {
    const lo = q.min ?? vals[0], hi = q.max ?? vals[vals.length - 1];
    const steps = Math.round((hi - lo) / q.step) + 1;
    if (steps <= 11 && Number.isInteger(steps)) {
      return Array.from({ length: steps }, (_, i) => {
        const v = round(lo + i * q.step, 6);
        return { label: String(v), count: vals.filter(x => Math.abs(x - v) < q.step / 2).length };
      });
    }
    if (lo === hi) return [{ label: String(lo), count: vals.length }];
    const k = 8, w = (hi - lo) / k;
    return Array.from({ length: k }, (_, i) => {
      const a = lo + i * w, b = i === k - 1 ? hi : lo + (i + 1) * w;
      return { label: `${round(a)}–${round(b)}`, count: vals.filter(x => x >= a && (i === k - 1 ? x <= b : x < b)).length };
    });
  }

  function results(p) {
    const responses = Object.values(p.responses);
    return { respondents: responses.length, questions: p.questions.map(q => ({ id: q.id, ...questionResults(q, responses) })) };
  }

  // ---------- views ----------
  const publicQuestions = p => p.questions.map(q => ({ ...q }));
  function statusOf(p) { return isOpen(p) ? 'open' : p.status === 'draft' ? 'draft' : 'closed'; }

  function voteView(id, voterId) {
    const p = get(id);
    const status = statusOf(p);
    if (status === 'draft') return { id: p.id, status, title: p.title };
    const mine = voterId && p.responses[voterId];
    const showResults = p.resultsMode === 'always' || (p.resultsMode === 'after-vote' && !!mine);
    const r = results(p);
    return {
      id: p.id, code: p.code, status, title: p.title, subtitle: p.subtitle, questions: publicQuestions(p),
      closesAt: status === 'open' ? p.closesAt : null, closedAt: p.closedAt, serverNow: new Date(now()).toISOString(),
      resultsMode: p.resultsMode, respondents: r.respondents,
      myAnswers: mine ? mine.answers : null,
      results: showResults ? r : null,
    };
  }

  function summary(p) {
    return { id: p.id, code: p.code, title: p.title, status: statusOf(p), closesAt: p.closesAt, createdAt: p.createdAt,
      openedAt: p.openedAt, closedAt: p.closedAt, questions: p.questions.length, respondents: Object.keys(p.responses).length };
  }
  function listPolls() {
    return Object.values(db.polls).map(summary).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  function manageView(id) {
    const p = get(id);
    return { ...summary(p), subtitle: p.subtitle, resultsMode: p.resultsMode, questions: publicQuestions(p), results: results(p), serverNow: new Date(now()).toISOString() };
  }

  return {
    init, flush, subscribe, findByCode, isOpen,
    voteView, listPolls, manageView, submitResponse,
    createPoll, duplicatePoll, deletePoll, updatePoll, openPoll, closePoll, clearResponses,
    _db: () => db,
  };
}

module.exports = { createState, HttpError, LIMITS };

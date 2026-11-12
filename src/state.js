'use strict';
// Rank It state: the list being ranked, everyone's ballots, settings, and live updates.
// Results use a Borda count: with n items, 1st place earns n-1 points and last place earns 0.
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LIMITS = { items: 100, itemText: 200, title: 120, subtitle: 300, ballots: 10000 };
const RESULTS_MODES = ['always', 'after-vote', 'hidden'];

const newId = () => 'i' + crypto.randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function emptyDb() {
  return {
    title: '',
    subtitle: '',
    items: [],          // [{id, text}]
    open: true,         // voting open?
    results: 'always',  // who sees results: always | after-vote | hidden (manage site always sees them)
    ballots: {},        // voterId -> {order: [itemId...], at: ISO time}
  };
}

function createState({ store, log = console }) {
  let db = emptyDb();
  const listeners = new Set();
  let saveTimer = null;
  let saving = Promise.resolve();

  async function init() {
    const loaded = await store.load();
    if (loaded && typeof loaded === 'object') db = { ...emptyDb(), ...loaded };
    if (!RESULTS_MODES.includes(db.results)) db.results = 'always';
    log.info(`Loaded ${db.items.length} items and ${Object.keys(db.ballots).length} ballots`);
  }

  // Coalesce bursts of changes into one write
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saving = saving.then(() => store.save(db)).catch(e => log.error('Save failed:', e)); }, 300);
  }
  async function flush() {
    clearTimeout(saveTimer);
    await saving;
    await store.save(db);
  }

  function changed() {
    scheduleSave();
    for (const fn of listeners) { try { fn(); } catch (e) { log.error(e); } }
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function results() {
    const ids = db.items.map(i => i.id);
    const n = ids.length;
    const pts = {}, posSum = {}, posCnt = {}, firsts = {};
    ids.forEach(id => { pts[id] = 0; posSum[id] = 0; posCnt[id] = 0; firsts[id] = 0; });
    let voters = 0;
    for (const b of Object.values(db.ballots)) {
      const order = (b.order || []).filter(id => id in pts);
      if (!order.length) continue;
      voters++;
      order.forEach((id, i) => {
        pts[id] += n - 1 - i;
        posSum[id] += i + 1; posCnt[id]++;
        if (i === 0) firsts[id]++;
      });
    }
    const rows = db.items.map(it => ({
      id: it.id, text: it.text, points: pts[it.id], firsts: firsts[it.id],
      avgPosition: posCnt[it.id] ? Math.round(posSum[it.id] / posCnt[it.id] * 10) / 10 : null,
    })).sort((a, b) => b.points - a.points || b.firsts - a.firsts || (a.avgPosition ?? 999) - (b.avgPosition ?? 999));
    let rank = 0, last = null;
    rows.forEach((r, i) => { if (r.points !== last) { rank = i + 1; last = r.points; } r.rank = rank; });
    return { voters, maxPoints: voters * Math.max(n - 1, 1), rows };
  }

  // What a voter's screen gets. Results are included only when the settings allow it for this voter.
  function voteView(voterId) {
    const mine = voterId && db.ballots[voterId];
    const myOrder = mine ? mine.order.filter(id => db.items.some(i => i.id === id)) : null;
    const showResults = db.results === 'always' || (db.results === 'after-vote' && !!mine);
    const r = results();
    return {
      title: db.title, subtitle: db.subtitle, items: db.items, open: db.open, resultsMode: db.results,
      voters: r.voters,
      myOrder,
      results: showResults ? r : null,
    };
  }

  function manageView() {
    return { title: db.title, subtitle: db.subtitle, items: db.items, open: db.open, resultsMode: db.results, results: results() };
  }

  function submitBallot(voterId, order) {
    if (!voterId) throw new HttpError(400, 'Missing voter id.');
    if (!db.open) throw new HttpError(409, 'Voting is closed.');
    if (!db.items.length) throw new HttpError(409, 'There is nothing to rank yet.');
    if (!Array.isArray(order)) throw new HttpError(400, 'order must be a list.');
    const ids = db.items.map(i => i.id);
    const seen = new Set();
    const clean = order.map(String).filter(id => ids.includes(id) && !seen.has(id) && seen.add(id));
    if (clean.length !== ids.length) throw new HttpError(400, 'Please rank every item.');
    if (!db.ballots[voterId] && Object.keys(db.ballots).length >= LIMITS.ballots) throw new HttpError(429, 'This poll has reached its vote limit.');
    db.ballots[voterId] = { order: clean, at: new Date().toISOString() };
    changed();
    return voteView(voterId);
  }

  // Save the list. Items keep their id (and so their votes) when their text is unchanged.
  function saveList({ title, subtitle, items }) {
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list.');
    const seen = new Set();
    const texts = items.map(t => clean(typeof t === 'object' && t ? t.text : t, LIMITS.itemText))
      .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    if (texts.length > LIMITS.items) throw new HttpError(400, `At most ${LIMITS.items} items.`);
    const byText = new Map(db.items.map(i => [i.text, i.id]));
    db.items = texts.map(text => ({ id: byText.get(text) || newId(), text }));
    if (title !== undefined) db.title = clean(title, LIMITS.title);
    if (subtitle !== undefined) db.subtitle = clean(subtitle, LIMITS.subtitle);
    changed();
    return manageView();
  }

  function saveSettings({ open, results }) {
    if (open !== undefined) db.open = !!open;
    if (results !== undefined) {
      if (!RESULTS_MODES.includes(results)) throw new HttpError(400, 'Unknown results setting.');
      db.results = results;
    }
    changed();
    return manageView();
  }

  function clearVotes() { db.ballots = {}; changed(); return manageView(); }

  return { init, flush, subscribe, voteView, manageView, submitBallot, saveList, saveSettings, clearVotes };
}

module.exports = { createState, HttpError, LIMITS };

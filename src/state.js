'use strict';
// Rank It state: the list being ranked, everyone's ballots, settings, and live updates.
// Results: each voter ranks the items they know and can mark the rest "I don't know".
// Within one ballot, the top item scores 100 and the bottom item 0, spread evenly between.
// An item's score is the average over the people who ranked it; "don't know" doesn't count for or against it.
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
    ballots: {},        // voterId -> {order: [itemId...] best first, unknown: [itemId...], at: ISO time}
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
    const ids = new Set(db.items.map(i => i.id));
    const sum = {}, rankedBy = {}, firsts = {}, unknownBy = {};
    for (const id of ids) { sum[id] = 0; rankedBy[id] = 0; firsts[id] = 0; unknownBy[id] = 0; }
    let voters = 0;
    for (const b of Object.values(db.ballots)) {
      const order = (b.order || []).filter(id => ids.has(id));
      const unknown = (b.unknown || []).filter(id => ids.has(id));
      if (!order.length && !unknown.length) continue;
      voters++;
      unknown.forEach(id => unknownBy[id]++);
      if (order.length < 2) continue; // one ranked item says nothing about how it compares
      const k = order.length;
      order.forEach((id, i) => {
        sum[id] += (k - 1 - i) / (k - 1);
        rankedBy[id]++;
        if (i === 0) firsts[id]++;
      });
    }
    const rows = db.items.map(it => ({
      id: it.id, text: it.text,
      score: rankedBy[it.id] ? Math.round(sum[it.id] / rankedBy[it.id] * 100) : null,
      rankedBy: rankedBy[it.id], unknownBy: unknownBy[it.id], firsts: firsts[it.id],
    })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.rankedBy - a.rankedBy || b.firsts - a.firsts);
    let rank = 0, last;
    rows.forEach((r, i) => {
      if (r.score === null) { r.rank = null; return; }
      if (r.score !== last) { rank = i + 1; last = r.score; }
      r.rank = rank;
    });
    return { voters, rows };
  }

  // What a voter's screen gets. Results are included only when the settings allow it for this voter.
  function voteView(voterId) {
    const mine = voterId && db.ballots[voterId];
    const has = id => db.items.some(i => i.id === id);
    const myOrder = mine ? mine.order.filter(has) : null;
    const myUnknown = mine ? (mine.unknown || []).filter(has) : null;
    const showResults = db.results === 'always' || (db.results === 'after-vote' && !!mine);
    const r = results();
    return {
      title: db.title, subtitle: db.subtitle, items: db.items, open: db.open, resultsMode: db.results,
      voters: r.voters,
      myOrder,
      myUnknown,
      results: showResults ? r : null,
    };
  }

  function manageView() {
    return { title: db.title, subtitle: db.subtitle, items: db.items, open: db.open, resultsMode: db.results, results: results() };
  }

  function submitBallot(voterId, order, unknown = []) {
    if (!voterId) throw new HttpError(400, 'Missing voter id.');
    if (!db.open) throw new HttpError(409, 'Voting is closed.');
    if (!db.items.length) throw new HttpError(409, 'There is nothing to rank yet.');
    if (!Array.isArray(order) || !Array.isArray(unknown)) throw new HttpError(400, 'order and unknown must be lists.');
    const ids = db.items.map(i => i.id);
    const seen = new Set();
    const pick = list => list.map(String).filter(id => ids.includes(id) && !seen.has(id) && seen.add(id));
    const ranked = pick(order);
    const dontKnow = pick(unknown);
    if (ranked.length + dontKnow.length !== ids.length) throw new HttpError(400, 'Please rank every item or mark it "I don\'t know".');
    if (ranked.length < Math.min(2, ids.length)) throw new HttpError(400, 'Please rank at least 2 items.');
    if (!db.ballots[voterId] && Object.keys(db.ballots).length >= LIMITS.ballots) throw new HttpError(429, 'This poll has reached its vote limit.');
    db.ballots[voterId] = { order: ranked, unknown: dontKnow, at: new Date().toISOString() };
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

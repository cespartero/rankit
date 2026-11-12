// Shared helpers for the vote, manage and report pages.
window.RK = (function(){
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function typeLabel(q){
    if (q.type === 'rank') return 'Ranking';
    if (q.type === 'choice') return q.multi ? 'Pick any' : 'Pick one';
    return 'Number' + (q.min !== null && q.max !== null ? ' ' + q.min + '–' + q.max : '');
  }

  function fmtNum(v, unit){ return (Number.isInteger(v) ? v : Math.round(v * 100) / 100) + (unit ? ' ' + unit : ''); }

  // Results for one question, as HTML
  function questionResults(q, r){
    if (!r || !r.answered) return '<div class="empty" style="padding:10px">No answers yet.</div>';
    if (r.type === 'rank') {
      return '<div class="meta"><span>' + plural(r.answered, 'answer', 'answers') + '</span><span>Score 100 = ranked first by everyone who knew it</span></div>' +
        '<div class="qres">' + r.rows.map(x => {
          const bits = [x.score === null ? 'not ranked yet' : 'score ' + x.score];
          if (x.rankedBy) bits.push('ranked by ' + x.rankedBy);
          if (x.unknownBy) bits.push(x.unknownBy + " don't know");
          if (x.firsts) bits.push(x.firsts + '× first');
          return '<div class="r"><span class="rk">' + (x.rank ?? '–') + '</span><span class="nm">' + esc(x.text) + '</span>' +
            '<span class="sc">' + bits.join(' · ') + '</span><span class="bar"><i style="width:' + (x.score || 0) + '%"></i></span></div>';
        }).join('') + '</div>';
    }
    if (r.type === 'choice') {
      return '<div class="meta"><span>' + plural(r.answered, 'answer', 'answers') + '</span>' + (r.multi ? '<span>People could pick more than one</span>' : '') + '</div>' +
        '<div class="qres">' + r.rows.map(x =>
          '<div class="r"><span class="rk">' + (x.count ? x.rank : '–') + '</span><span class="nm">' + esc(x.text) + '</span>' +
          '<span class="sc">' + plural(x.count, 'vote', 'votes') + ' · ' + x.percent + '%</span><span class="bar"><i style="width:' + x.percent + '%"></i></span></div>'
        ).join('') + '</div>';
    }
    const top = Math.max(1, ...r.bins.map(b => b.count));
    return '<div class="stats">' +
        '<div class="stat"><b>' + fmtNum(r.mean, r.unit) + '</b><span>average</span></div>' +
        '<div class="stat"><b>' + fmtNum(r.median, r.unit) + '</b><span>middle (median)</span></div>' +
        '<div class="stat"><b>' + (r.min === r.max ? fmtNum(r.min, r.unit) : fmtNum(r.min) + ' – ' + fmtNum(r.max, r.unit)) + '</b><span>lowest – highest</span></div>' +
        '<div class="stat"><b>' + r.answered + '</b><span>' + (r.answered === 1 ? 'answer' : 'answers') + '</span></div>' +
      '</div>' +
      '<div class="hist">' + r.bins.map(b =>
        '<span class="lbl">' + esc(b.label) + '</span><span class="bar"><i style="width:' + Math.round(b.count / top * 100) + '%"></i></span><span>' + b.count + '</span>'
      ).join('') + '</div>';
  }

  function allResults(poll, results){
    return poll.questions.map((q, i) => {
      const r = results.questions.find(x => x.id === q.id);
      return '<section class="card"><div class="qtitle"><h3>' + (poll.questions.length > 1 ? (i + 1) + '. ' : '') + esc(q.text || 'Question ' + (i + 1)) + '</h3>' +
        '<span class="qtype">' + typeLabel(q) + '</span></div>' + questionResults(q, r) + '</section>';
    }).join('');
  }

  // "2 days 3 hours", "4 min 05 s"
  function countdown(ms){
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d) return d + (d === 1 ? ' day ' : ' days ') + h + (h === 1 ? ' hour' : ' hours');
    if (h) return h + ' h ' + String(m).padStart(2, '0') + ' min';
    return m + ' min ' + String(sec).padStart(2, '0') + ' s';
  }
  const when = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  return { esc, plural, typeLabel, questionResults, allResults, countdown, when, fmtNum };
})();

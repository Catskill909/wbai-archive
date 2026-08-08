// tools/schedule-audit.js — the parts that can be wrong in silence.
//
// The tool's whole value is that it runs unattended every week and is believed.
// That makes two failure modes expensive, and neither announces itself:
//
//   1. The parser stops seeing something. The first hand-rolled pass of the
//      Soundboard audit reported "0 private rows" while private="1" was in the
//      document three times, because <tr ...>(.*?)</tr> stops at each row's
//      NESTED </tr>. A clean, confident, wrong number. (CLAUDE.md §3a.)
//   2. The title matcher gets stricter than the data and reports shows as
//      missing that the app has had all along. Four of those fired on the first
//      real run; every one was a spelling difference. A weekly tool that cries
//      wolf is a weekly tool nobody reads.
//
// So: fixtures with the nested tables in place, and both directions of the
// matcher — pairs that MUST match, and pairs that must NOT.
'use strict';

const T = require('../../tools/schedule-audit.js');

let fails = 0, checks = 0;
function check(ok, msg, extra) {
  checks++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (!ok) fails++;
}

// A row shaped like archive2's real markup: the outer <tr> wraps inner tables
// that close their own </tr> before the play button is ever reached.
function row({ sho, title, date, priv, rss, len = '2:00:03', days = 9, dt = 1785913200 }) {
  return `<tr name="show" id="tt_1" cat="11" sho="${sho}" dt="${dt}" style="height:32px;">` +
    `<td class="showname"><table class="invisible"><tr>` +
    `<td><span class="showtitle">${title}</span></td>` +
    (rss ? `<td><a href="https://archive2.wbai.org/getrss.php?id=${sho}"><img src="rss.png"></a></td>` : '<td></td>') +
    `</tr></table></td>` +
    `<td><span class="showdate">${date}</span></td><td><span class=showlen>${len}</span></td>` +
    `<td class="daystostay"> ${days}</td>` +
    `<td class="action"><table><tr><td class="play">` +
    `<button class="play_button" title="${title}" mp3="https://archive2.wbai.org/mp3/x_${sho}.mp3"${priv ? ' private="1"' : ''} onclick="add_player(this);"></button>` +
    `</td></tr></table></td></tr>`;
}

console.log('#### archive2 row parser');

const html =
  row({ sho: 'ftsb', title: 'From The Soundboard', date: 'Tuesday, August 4, 2026 12:00 am', priv: true, rss: true }) +
  row({ sho: 'ftsb', title: 'From The Soundboard', date: 'Wednesday, August 5, 2026 3:00 am', priv: true, rss: true, days: 10 }) +
  row({ sho: 'dust', title: 'Dustbin of History!', date: 'Thursday, August 6, 2026 12:00 am', priv: false, rss: true }) +
  row({ sho: 'lenlo', title: 'Some Show', date: 'Friday, August 7, 2026 9:00 am', priv: false, rss: false });

const rows = T.parseArchive2(html);
check(rows.length === 4, 'every row is found', rows.length);

// THE TRAP. The play button sits after two nested </tr>; a non-greedy match to
// </tr> never reaches it and reports every row as public.
const priv = rows.filter((r) => r.private);
check(priv.length === 2 && priv.every((r) => r.sho === 'ftsb'),
      'private="1" is seen THROUGH the nested tables (the bug that cost an afternoon)',
      priv.map((r) => r.sho));

// An assertion of absence has to prove it could still see presence, or it passes
// blind. Here: the same parser on the same markup with the flag removed.
const nonePriv = T.parseArchive2(html.replace(/ private="1"/g, ''));
check(nonePriv.length === 4 && nonePriv.every((r) => !r.private),
      'self-test: strip the flag and the parser really reports none');

check(rows.filter((r) => r.hasRSS).length === 3, 'the getrss link is detected per row');
check(rows.find((r) => r.sho === 'lenlo').hasRSS === false, 'and its absence is not invented');
check(rows[0].mp3.endsWith('x_ftsb.mp3'), 'the mp3 is pulled off the play button', rows[0].mp3);
check(rows[0].daysLeft === 9 && rows[1].daysLeft === 10, 'retention is read per row',
      [rows[0].daysLeft, rows[1].daysLeft]);
check(rows[0].dateText === 'Tuesday, August 4, 2026 12:00 am', 'and the air date', rows[0].dateText);
check(rows[0].title === 'From The Soundboard', 'and the title', rows[0].title);

check(T.parseArchive2('<html>their markup changed entirely</html>').length === 0,
      'markup it cannot parse yields 0 rows (the tool treats that as fatal, not as "nothing wrong")');

console.log('\n#### wbai.org grid parser');

const grid = `
  events: [
    { title : "From The Soundboard", start : '2026-08-04T00:00:00', end : '2026-08-04T02:00:00' },
    { title : "From The Soundboard", start : '2026-08-11T00:00', end : '2026-08-11T02:00:00' },
    { title : "Democracy Now!", start : '2026-08-04T08:00:00', end : '2026-08-04T09:00:00' }
  ]`;
const ev = T.parseWbaiGrid(grid);
check(ev.length === 3, 'every event is parsed, both date spellings', ev.length);
const slots = T.weeklySlots(ev);
check(slots.length === 2, 'repeats of the same weekly slot collapse to one', slots.length);
const mid = slots.find((s) => s.title === 'From The Soundboard');
check(mid && mid.day === 2 && mid.time === '00:00',
      'a midnight Tuesday slot lands on Tuesday at 00:00 — not Monday, not 12:00',
      mid && [mid.day, mid.time]);
check(mid && mid.weeks === 2, 'and remembers how many weeks carried it', mid && mid.weeks);

console.log('\n#### title matching — pairs that MUST match');
// Every one of these fired as a false "missing show" on the first real run
// (2026-08-08) and every one was a show the app already had.
const same = [
  ['The Ablitionist Show', 'The Abolitionist Show', 'a misspelling upstream'],
  ['We Decide: America at the Crossroads', 'We Decide Rebroadcast', 'a qualifier and a truncation'],
  ['Radio GBE-New York', 'Radio GBE- NYC', 'an abbreviation'],
  ['On the Count - The Prison And Criminal Justice Report',
   'On the Count: The Prison and Criminal Legal System Transformation Report', 'a renamed subtitle'],
  ['Democracy Now!', 'Democracy Now! Rebroadcast', 'a rebroadcast suffix'],
  ['Haitian All-Starz Radio', 'Haitian All-StarZ Radio', 'inconsistent capitalisation'],
];
for (const [a, b, why] of same) check(T.looksLike(a, b), `matches: ${why}`, [a, b]);

console.log('\n#### title matching — pairs that must NOT match');
// The other half. A matcher loose enough to pair these would report full
// coverage forever and never find anything, which is the quieter failure.
const diffPairs = [
  ['From The Soundboard', 'From The Soundboard - Rebroadcast', 'NOT the same slot'],
  ['Democracy Now!', 'Law and Disorder', 'unrelated'],
  ['Midnight Ravers', 'Groovelines', 'unrelated music shows'],
  ['A Mansion for the Rat', 'Dustbin of History!', 'unrelated arts shows'],
];
// The Rebroadcast pair is the one real trap: it is a substring, so tier 1 pairs
// them on purpose. That is correct for "does the app hold this SHOW" and wrong
// for "is this SLOT covered" — the audit reports the two separately, and this
// records the intent rather than pretending the matcher distinguishes them.
check(T.looksLike(diffPairs[0][0], diffPairs[0][1]),
      'a rebroadcast DOES match its parent show (documented, deliberate)');
for (const [a, b, why] of diffPairs.slice(1)) {
  check(!T.looksLike(a, b), `does not match: ${why}`, [a, b]);
}
check(T.dice('democracy now', 'law and disorder') < 0.72, 'dice keeps unrelated titles apart');

console.log('\n#### why a show has no feed');
// The config cutover (late July 2026) is the most misleading thing in this data:
// archive2 retains ~115 days, so over HALF its rows describe the old, broken
// setup. A show with nothing recorded since then has told us nothing about how
// it is configured today, and must not be reported as a live bug.
const old = T.whyNoFeed({ rows: 4, since: 0, priv: 0 }, '2026-07-26');
check(old.kind === 'no-feed-old', 'nothing recorded since the cutover is OLD CONFIG, not a live finding', old.kind);
check(/retired or renamed/.test(old.why), 'and says so, rather than sending someone after a ghost');

// ftsb, 2026-08-08: both post-cutover recordings private, feed empty.
const privCase = T.whyNoFeed({ rows: 2, since: 2, priv: 2 }, '2026-07-26');
check(privCase.kind === 'no-feed', 'private recordings since the cutover IS a live finding');
check(/untick Private/.test(privCase.why), 'and names the box');
check(/per RECORDING/.test(privCase.why) && /already recorded/.test(privCase.why),
      'and warns that the show-level untick does not publish episodes already recorded — the thing that cost us a wrong prediction');

// soundreb, 2026-08-08: not private, feed empty, then a confessor change
// published its already-recorded Jul 29 episode the same day.
const pod = T.whyNoFeed({ rows: 1, since: 1, priv: 0 }, '2026-07-26');
check(pod.kind === 'no-feed', 'not-private-but-empty is a live finding too');
check(/Podcast box/.test(pod.why), 'and points at the podcast side instead');
check(/retroactiv/i.test(pod.why),
      'and records that a podcast-side fix reaches back over retained episodes (soundreb proved it)');

const mixed = T.whyNoFeed({ rows: 5, since: 3, priv: 2 }, '2026-07-26');
check(mixed.kind === 'no-feed' && /2 of 5/.test(mixed.why), 'a partial private set is quantified', mixed.why);

console.log('\n#### week-over-week diff');
const prev = { at: '2026-08-01T00:00:00Z', findings: [
  { kind: 'no-feed', id: 'ftsb', msg: 'ftsb' },
  { kind: 'no-feed', id: 'soundreb', msg: 'soundreb' },
] };
const now = { findings: [
  { kind: 'no-feed', id: 'soundreb', msg: 'soundreb' },
  { kind: 'no-feed', id: 'newshow', msg: 'newshow' },
] };
const d = T.diff(prev, now);
check(d.isNew.length === 1 && d.isNew[0].id === 'newshow', 'a new finding is flagged NEW');
check(d.resolved.length === 1 && d.resolved[0].id === 'ftsb',
      'a finding that went away is flagged RESOLVED — this is how we learn the fix landed');
check(d.since === '2026-08-01T00:00:00Z', 'and the diff names the run it compares against');
const first = T.diff(null, now);
check(first.isNew.length === 2 && first.since === null, 'a first run reports no diff, not a wall of NEW');

console.log(`\n${fails ? fails + ' FAILED of ' : 'all '}${checks} schedule-audit checks${fails ? '' : ' passed'}`);
process.exit(fails ? 1 : 0);

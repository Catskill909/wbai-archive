// End-to-end live-player tests against the real app in headless Chrome.
// Chrome's resolver is pointed at the fake Icecast (fakestream.js), so the
// shipping code runs completely unmodified — same URL, same CSP, same code path.
//
// The fake station is a true live source: one cursor advances in real time and
// every client is served from wherever it is *now*. There is no rewind and no
// per-client backlog, so bytes a client receives can only be live — which is what
// makes "did it reconnect?" a decisive question rather than an inference.
const { connect, sleep } = require('./cdp');

const APP = 'http://localhost:8080/';
const CTL = 'http://127.0.0.1:8091';
const ctl = async (p) => (await fetch(CTL + p)).json();
const stats = () => ctl('/ctl/stats');
const mark = (m) => ctl('/ctl/mark?m=' + encodeURIComponent(m));

const STRICT = process.argv.includes('--strict');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const PROBE = `
  var els = [].slice.call(document.querySelectorAll('audio'));
  var live = els.filter(function(e){ return e.id !== 'mainAudio'; });
  var el = live[0] || null;
  return {
    liveElements: live.length,
    currentTime: el ? +el.currentTime.toFixed(2) : null,
    paused: el ? el.paused : null,
    src: el ? (el.currentSrc || el.src || '').slice(0, 120) : null,
    drift: (el && el._wall) ? Math.round(((Date.now()-el._wall) - (el.currentTime - el._time)*1000)/1000) : null,
    alertShown: !document.getElementById('lpAlert').hidden,
    alertTitle: document.getElementById('lpAlertTitle').textContent,
    note: document.getElementById('lpNote').textContent,
    barStatus: (document.getElementById('playerStatus')||{}).textContent,
    onAirLabel: (document.querySelector('.on-air-label')||{}).textContent
  };
`;

// Chrome 150 dropped Emulation.setPageVisibilityOverride, so "the user came back
// to the tab" is delivered as the events the browser itself would fire. The code
// under test reads document.visibilityState (visible here), so this is the real path.
const RETURN_TO_TAB = `document.dispatchEvent(new Event('visibilitychange'));
                       window.dispatchEvent(new Event('focus')); return 1;`;

(async () => {
  const p = await connect();
  await p.send('Security.enable');
  await p.send('Security.setIgnoreCertificateErrors', { ignore: true });
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  const pageErrors = [];
  p.on(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.text + ' ' +
        (m.params.exceptionDetails.exception || {}).description);
    }
  });

  // Clean slate: drop any connection a previous run left playing, THEN clear the
  // server ledger, so connection numbering means what the assertions think it does.
  await p.send('Page.navigate', { url: 'about:blank' });
  await sleep(1500);
  await ctl('/ctl/reset');
  await p.send('Page.navigate', { url: APP });
  await sleep(2500);

  const probe = () => p.eval(PROBE);
  const openModal = async () => { await p.click('#onAirBtn'); await sleep(400); };
  const closeModal = async () => { await p.click('#lpClose'); await sleep(400); };
  const tap = async (sel, ms = 8000) => { await p.click(sel); await sleep(ms); };
  // What the docked bar's toggle is ACTUALLY showing — the rendered glyph, not
  // the class that is supposed to produce it (CLAUDE.md §3a). `pause` is read off
  // the path data, so a swapped icon can't pass as one.
  const barToggle = () => p.eval(`
    if(document.getElementById('playerBar').hidden) return { glyph: 'no-bar' };
    var b = document.getElementById('playerToggle');
    var vis = function(el){ return !!el && getComputedStyle(el).display !== 'none'; };
    var svg = b.querySelector('svg'), spin = b.querySelector('.spinner');
    var glyph = 'none';
    if(vis(svg)) glyph = /^M7 5h4/.test(svg.querySelector('path').getAttribute('d')) ? 'pause' : 'play';
    if(vis(spin)) glyph = 'spinner';
    return { glyph: glyph, loadingClass: b.classList.contains('loading'),
             status: (document.getElementById('playerStatus').textContent || '').trim() };
  `);

  console.log(`\n########  autoplay policy: ${STRICT ? 'user-gesture-required (worst case / iOS-like)' : 'Chrome default'}  ########`);

  console.log('\n=== S1: first play opens one connection at the live edge ===');
  await mark('S1 play');
  await openModal();
  await tap('#lpToggle');
  let s = await stats(), v = await probe();
  check('exactly one connection opened', s.total === 1, `total=${s.total}`);
  check('connection is open', s.open === 1, `open=${s.open}`);
  check('audio is advancing', v.currentTime > 0.5, `currentTime=${v.currentTime}s`);
  check('src carries a per-connection cache-buster', /_=\d{13}/.test(v.src || ''), v.src);
  check('exactly one live element in the DOM', v.liveElements === 1, `count=${v.liveElements}`);
  check('On Air button reads "On Air"', v.onAirLabel === 'On Air', v.onAirLabel);
  const conn1 = s.conns[0];

  console.log('\n=== S2: stop closes the socket and discards the element ===');
  await mark('S2 stop');
  await tap('#lpToggle', 1500);
  s = await stats(); v = await probe();
  check('the socket was actually closed', s.open === 0, `open=${s.open}`);
  check('no live element left in the DOM', v.liveElements === 0, `count=${v.liveElements}`);
  check('no new connection opened', s.total === 1, `total=${s.total}`);
  check('modal reads "Paused"', v.note === 'Paused', JSON.stringify(v.note));

  console.log('\n=== S3: THE BUG — play after a long gap must go to the live edge ===');
  console.log('    (idling 25s; the old model would resume this backlog instead)');
  await sleep(25000);
  await mark('S3 replay after 25s idle');
  await tap('#lpToggle');
  s = await stats(); v = await probe();
  const conn2 = s.conns[1];
  check('a SECOND connection was opened', s.total === 2, `total=${s.total}`);
  check('the new element started from scratch, not where it stopped',
    v.currentTime < conn1.sec, `currentTime=${v.currentTime}s vs ${conn1.sec}s already played`);
  check('it joined the live edge 25s further on, not the old position',
    conn2.openedAtCursorSec - conn1.openedAtCursorSec > 25,
    `live cursor advanced ${(conn2.openedAtCursorSec - conn1.openedAtCursorSec).toFixed(1)}s between connections`);
  check('distinct URL from the first connection', conn2.url !== conn1.url, conn2.url);
  check('audio is advancing again', v.currentTime > 0.5, `currentTime=${v.currentTime}s`);

  console.log('\n=== S4: archive playback tears the stream down ===');
  await mark('S4 archive takeover');
  await closeModal();
  // Start an archive episode the way a listener does: open its info sheet, then
  // press Play in the sheet footer.
  //
  // Deliberately NOT `querySelector('.play-btn')` — that selector is view
  // dependent. A gallery card's artwork carries .play-btn but *opens the sheet*
  // rather than playing (app.js: togglePlayFrom is skipped for .card-art), so
  // once the gallery became the default view this clicked open a dialog, started
  // no audio at all, and left the scrim covering #onAirBtn for S5. Both views
  // render .show-open and both reach the same .sheet-play, so this path holds
  // whichever view the app defaults to.
  await p.eval(`
    var opener = document.querySelector('.show-open');
    if(!opener) throw new Error('no .show-open in the listing');
    opener.click(); return 1;`);
  await sleep(600);
  const archiveStarted = await p.eval(`
    var play = document.querySelector('.sheet-play');
    if(!play) return false;
    play.click(); return true;`);
  if (!archiveStarted) throw new Error('S4: the info sheet has no Play button — cannot start archive playback');
  await sleep(2500);
  s = await stats(); v = await probe();
  check('live socket closed by the takeover', s.open === 0, `open=${s.open}`);
  check('live element destroyed', v.liveElements === 0, `count=${v.liveElements}`);
  check('no stray live connection opened', s.total === 2, `total=${s.total}`);
  await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
  await sleep(400);
  await p.eval(`document.getElementById('playerClose').click(); return 1;`);
  await sleep(500);

  console.log('\n=== S5: an outside pause (OS interruption) is a stop, not a pause ===');
  await mark('S5 external pause');
  await openModal();
  await tap('#lpToggle');
  s = await stats();
  check('a third connection opened', s.total === 3, `total=${s.total}`);
  await p.eval(`
    var el = [].slice.call(document.querySelectorAll('audio')).filter(function(e){return e.id!=='mainAudio';})[0];
    el.pause(); return 1;`);
  await sleep(1500);
  s = await stats(); v = await probe();
  check('the interrupted connection was torn down', s.open === 0, `open=${s.open}`);
  check('element discarded, so the next play must reconnect', v.liveElements === 0, `count=${v.liveElements}`);
  await tap('#lpToggle');
  s = await stats();
  check('play after the interruption opens a NEW connection', s.total === 4, `total=${s.total}`);

  console.log('\n=== S6: rapid stop/play does not raise a false failure ===');
  await mark('S6 rapid toggle');
  for (let i = 0; i < 3; i++) { await p.click('#lpToggle'); await sleep(150); }
  await p.click('#lpToggle');
  await sleep(9000);
  v = await probe(); s = await stats();
  check('no failure card shown (AbortError not misreported)', v.alertShown === false, v.alertTitle);
  check('exactly one live element survives', v.liveElements === 1, `count=${v.liveElements}`);
  check('audio recovered and is advancing', v.currentTime > 0.5, `currentTime=${v.currentTime}s`);
  check('no orphaned sockets', s.open === 1, `open=${s.open}`);

  console.log('\n=== S7: drift — a 60s stall must not leave the listener behind live ===');
  await mark('S7 stall 60s');
  const before = await stats();
  await ctl('/ctl/stall?on=1');
  console.log('    (station stalled 60s — drift threshold is 45s)');
  await sleep(60000);
  const mid = await probe();
  check('drift is measured while stalled', mid.drift >= 45, `drift=${mid.drift}s`);
  check('no failure card for a stall (the socket is still open)', mid.alertShown === false, mid.alertTitle);
  await ctl('/ctl/stall?on=0');
  await sleep(4000);
  await p.eval(RETURN_TO_TAB);
  await sleep(9000);
  s = await stats(); v = await probe();
  if (STRICT) {
    // No user gesture behind a drift resync, so play() is refused outright here.
    // The requirement is that this costs the listener nothing.
    check('handover was refused but audio survived', v.liveElements >= 1, `count=${v.liveElements}`);
    check('still playing (old connection handed back)', v.paused === false, `paused=${v.paused}`);
    check('no failure card from a refused background handover', v.alertShown === false, v.alertTitle);
    check('exactly one socket open (no orphan)', s.open === 1, `open=${s.open}`);
  } else {
    check('a fresh connection replaced the stalled one', s.total === before.total + 1,
      `total=${s.total} (was ${before.total})`);
    check('exactly one socket open after the handover', s.open === 1, `open=${s.open}`);
    check('drift reset to ~0 — back at the live edge', v.drift !== null && v.drift < 10, `drift=${v.drift}s`);
    check('audio advancing on the new connection', v.currentTime > 0.5, `currentTime=${v.currentTime}s`);
    check('no failure card', v.alertShown === false, v.alertTitle);
  }

  console.log('\n=== S8: dead station → failure card, then retry recovers ===');
  await mark('S8 station down');
  v = await probe();
  if (v.paused === false || v.liveElements > 0) { await tap('#lpToggle', 1500); }
  await ctl('/ctl/refuse?on=1');
  const beforeFail = (await stats()).total;
  await tap('#lpToggle', 14000);              // play into a refusing server
  v = await probe();
  check('failure card is shown', v.alertShown === true, v.alertTitle);
  check('no live element left behind', v.liveElements === 0, `count=${v.liveElements}`);
  check('the attempt did reach the station', (await stats()).total >= beforeFail, 'ok');
  await ctl('/ctl/refuse?on=0');
  await p.click('#lpAlertRetry');       // a real gesture — a synthetic .click() is
  await sleep(9000);                    // refused under a strict autoplay policy
  v = await probe(); s = await stats();
  check('retry cleared the card', v.alertShown === false, v.alertTitle);
  check('retry is playing again', v.currentTime > 0.5, `currentTime=${v.currentTime}s`);
  check('one socket open', s.open === 1, `open=${s.open}`);

  // Runs LAST on purpose: it opens a connection, and every earlier section
  // asserts on exact connection counts.
  console.log('\n=== S9: the docked bar spins while connecting, like the modal ===');
  await mark('S9 bar connect state');
  await closeModal();                          // the bar owns the stream now
  await tap('#playerToggle', 1500);            // stop from the bar
  check('bar shows play after stopping', (await barToggle()).glyph === 'play',
    JSON.stringify(await barToggle()));
  // What the listener sees between the tap and the first audible frame. Read the
  // rendered glyph, not the class: a `.loading` class whose CSS never landed
  // would still be "set" and still show a pause icon over silence.
  await p.click('#playerToggle');
  let sawSpinner = null, sawPause = null;
  for (let i = 0; i < 60; i++) {               // up to 15s, same budget as a play
    const b = await barToggle();
    if (b.glyph === 'spinner' && sawSpinner === null) sawSpinner = i * 250;
    if (b.glyph === 'pause') { sawPause = i * 250; break; }
    await sleep(250);
  }
  check('the bar spun while connecting', sawSpinner !== null,
    sawSpinner === null ? 'never spun' : `spinner at ${sawSpinner}ms`);
  check('it reached pause once audio was running', sawPause !== null,
    sawPause === null ? 'never played' : `pause at ${sawPause}ms`);
  check('spinner came before pause, i.e. no pause icon over silence',
    sawSpinner !== null && sawPause !== null && sawSpinner < sawPause,
    `spinner ${sawSpinner}ms, pause ${sawPause}ms`);
  // The loop breaks on the first frame the pause icon appears, which is also the
  // first frame of audio — give it a beat before asking whether it kept going.
  await sleep(1500);
  v = await probe();
  check('audio really is advancing behind the pause icon', v.currentTime > 0.5,
    `currentTime=${v.currentTime}s`);

  console.log('\n=== Page health ===');
  check('no uncaught exceptions in the page', pageErrors.length === 0, pageErrors.join(' | ') || 'none');

  const final = await stats();
  console.log('\n--- connection ledger (recorded by the station, not the app) ---');
  for (const c of final.conns) {
    console.log(`  #${c.id}  opened t=${c.openedAt}s at live-cursor ${c.openedAtCursorSec}s  ` +
                `closed ${c.closedAt === null ? '(still open)' : 't=' + c.closedAt + 's'}  delivered ${c.sec}s`);
  }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('DRIVER ERROR', e); process.exit(2); });

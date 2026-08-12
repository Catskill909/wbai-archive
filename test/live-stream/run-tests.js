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

  // A multi-episode show guarantees that S4 can exercise both the profile's
  // named takeover action and the compact controls in its Past episodes route.
  const archivePayload = await (await fetch(APP + 'api/archive')).json();
  const archiveRows = (archivePayload.shows || []).filter(r => r.mp3 && r.sho);
  const archiveCounts = {};
  archiveRows.forEach(r => { archiveCounts[String(r.sho).toLowerCase()] = (archiveCounts[String(r.sho).toLowerCase()] || 0) + 1; });
  const browseFixture = archiveRows.find(r => archiveCounts[String(r.sho).toLowerCase()] > 1);
  if (!browseFixture) throw new Error('S4: no multi-episode archive fixture');

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
  const beforeBrowse = await probe();
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
    var q=document.getElementById('q');
    q.value=${JSON.stringify(browseFixture.title)};
    q.dispatchEvent(new Event('input',{bubbles:true}));
    var opener=Array.from(document.querySelectorAll('.show-open')).find(function(e){return e.dataset.id===${JSON.stringify(String(browseFixture.id))};});
    if(!opener) throw new Error('no fixture .show-open in the listing');
    opener.click(); return 1;`);
  await sleep(600);
  const whileBrowsing = await probe();
  const liveDock = await p.eval(`
    var dock=document.getElementById('sheetPlayerDock');
    var chip=document.getElementById('sheetPlayerLive');
    var play=document.querySelector('.sheet-play');
    return {
      visible:!dock.hidden && dock.getBoundingClientRect().height > 0,
      live:dock.classList.contains('live'),
      chip:chip && !chip.hidden ? chip.textContent.trim() : '',
      state:document.getElementById('sheetPlayerState').textContent.trim(),
      openAria:document.getElementById('sheetPlayerOpen').getAttribute('aria-label') || '',
      playLabel:(play && play.querySelector('.play-label') || {}).textContent || ''
    };`);
  s = await stats();
  check('browsing a show leaves the live connection untouched',
    s.open === 1 && whileBrowsing.currentTime > beforeBrowse.currentTime,
    `open=${s.open} before=${beforeBrowse.currentTime}s after=${whileBrowsing.currentTime}s`);
  check('the modal projects the same live transport while the page bar is covered',
    liveDock.visible && liveDock.live && liveDock.chip === 'Live', JSON.stringify(liveDock));
  check('the live dock names both source and state accessibly',
    /live stream playing/i.test(liveDock.openAria) && /^Playing$/.test(liveDock.state), JSON.stringify(liveDock));
  check('the selected archive action warns that it will replace live',
    / instead$/.test(liveDock.playLabel), liveDock.playLabel);
  await p.eval(`document.querySelector('.sheet-archive-open').click(); return 1;`);
  await sleep(250);
  const archiveWarnings = await p.eval(`return {
    visible:Array.from(document.querySelectorAll('.sheet-episode-instead')).filter(function(e){return !e.hidden;}).length,
    aria:Array.from(document.querySelectorAll('.sheet-episode-play')).map(function(e){return e.getAttribute('aria-label') || '';})
  };`);
  check('compact archive-row actions also warn before taking over live',
    archiveWarnings.visible > 0 && archiveWarnings.aria.every(a => / instead$/.test(a)),
    JSON.stringify(archiveWarnings));
  await p.eval(`document.getElementById('sheetRouteBack').click(); return 1;`);
  await sleep(200);
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

  console.log('\n=== S7: THE SILENT STALL — a stream that dies without saying so ===');
  console.log('    A network that vanishes underneath a listener does not close the');
  console.log('    socket and does not fire `error` — the bytes just stop arriving.');
  console.log('    The station stalling with the connection still open is the same');
  console.log('    event from the element\'s side: `waiting`, and then nothing, ever.');
  console.log('    (Reported 2026-07-30 — a USB-tethered iPhone unplugged mid-stream:');
  console.log('    ERR_NETWORK_CHANGED, no `error`, and the spinner span indefinitely.)');
  await mark('S7 silent stall');
  const before = await stats();
  await ctl('/ctl/stall?on=1');

  console.log('    (station stalled — the first rebuild is due ~8s in)');
  await sleep(22000);
  const mid = await probe();
  const during = await stats();
  check('no failure card while it is still trying', mid.alertShown === false, mid.alertTitle);
  check('it is rebuilding the connection, not waiting forever',
    during.total > before.total, `${during.total - before.total} rebuild attempt(s)`);
  // The original bug was not just that it never recovered — it was that it never
  // SAID anything. An unexplained spinner is indistinguishable from a hang.
  check('it says what it is doing rather than spinning silently',
    /reconnect/i.test(mid.note || ''), JSON.stringify(mid.note));

  console.log('    (holding the stall out to ~60s — drift threshold is 45s)');
  await sleep(40000);
  const late = await probe();
  check('drift is measured across the stall', late.drift >= 45, `drift=${late.drift}s`);
  check('still no failure card at 60s (inside the give-up budget)',
    late.alertShown === false, late.alertTitle);

  // The point of the section: the bytes come back and NOTHING touches the page —
  // no tap, no tab switch, no visibility event, no gesture of any kind. Audio has
  // to return on its own. That is precisely what did not happen on the iPhone.
  await ctl('/ctl/stall?on=0');
  await sleep(25000);
  s = await stats(); v = await probe();
  check('audio came back with no user gesture at all',
    v.paused === false && v.currentTime > 0.5, `paused=${v.paused} currentTime=${v.currentTime}s`);
  check('no failure card', v.alertShown === false, v.alertTitle);
  check('exactly one socket open (every abandoned rebuild was cleaned up)',
    s.open === 1, `open=${s.open}`);
  check('exactly one live element left in the DOM', v.liveElements === 1, `count=${v.liveElements}`);
  if (STRICT) {
    // Every rebuild here is refused by the autoplay policy, so recovery comes
    // from the ORIGINAL connection resuming. The requirement is that all those
    // refusals cost the listener nothing.
    check('recovered on the handed-back connection', v.drift >= 45, `drift=${v.drift}s`);
  } else {
    check('and a resync put it back at the live edge', v.drift !== null && v.drift < 15,
      `drift=${v.drift}s`);
  }
  // The visibility/focus resync path still exists; make sure returning to the tab
  // on top of an already-recovered stream does not disturb it.
  await p.eval(RETURN_TO_TAB);
  await sleep(3000);
  s = await stats(); v = await probe();
  check('returning to the tab afterwards changes nothing', v.paused === false && s.open === 1,
    `paused=${v.paused} open=${s.open}`);

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

  console.log('\n=== S10: a stall that never ends becomes a failure, not a forever-spinner ===');
  console.log('    S7 proves recovery when the bytes come back. This proves the other');
  console.log('    branch: when they never do, the rebuild loop is bounded and the');
  console.log('    listener is told, instead of watching a spinner until they give up.');
  await mark('S10 give-up');
  await openModal();                           // the card lives inside the modal
  v = await probe();
  if (v.paused !== false) { await tap('#lpToggle'); }
  await ctl('/ctl/stall?on=1');
  console.log('    (station stalled indefinitely — give-up budget is 90s)');
  // Sampled at 60s: still inside the budget, so it must still be trying — this is
  // what stops the section from passing on a player that simply failed instantly.
  await sleep(60000);
  const trying = await probe();
  check('at 60s it is still trying, not yet failed', trying.alertShown === false, trying.alertTitle);
  await sleep(45000);
  s = await stats(); v = await probe();
  check('the spinner did NOT spin forever — a failure card was shown',
    v.alertShown === true, v.alertTitle);
  check('the card offers a way out, not a dead end',
    await p.eval(`return !document.getElementById('lpAlertRetry').hidden;`), 'retry visible');
  check('the dead element was thrown away', v.liveElements === 0, `count=${v.liveElements}`);
  check('and its socket with it', s.open === 0, `open=${s.open}`);
  // And the way out works: the station comes back, the listener taps once.
  await ctl('/ctl/stall?on=0');
  await p.click('#lpAlertRetry');
  await sleep(9000);
  s = await stats(); v = await probe();
  check('Try again recovers', v.alertShown === false && v.currentTime > 0.5,
    `card=${v.alertShown} currentTime=${v.currentTime}s`);
  check('one socket open after the retry', s.open === 1, `open=${s.open}`);

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

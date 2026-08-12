// The schedule modal's on-air row, against the real app in headless Chrome.
//
// The row that is broadcasting right now is the only place this dialog has two
// reasonable destinations — the live stream, or that show's archive — and it
// used to guess. A "Listen Live" pill sat on a card whose body silently opened
// the archive instead: same surface, two outcomes, one of them unnamed
// (reported 2026-08-06). It asks now, with a chooser.
//
// The contract this file holds:
//
//   1. The on-air row is MARKED (a Live badge) and every other row is not.
//   2. Tapping ANYWHERE on that row opens the chooser — there is no half of the
//      card that does something else. That is the whole fix; a boundary you
//      cannot see is the bug.
//   3. A row that is NOT on air still goes straight to the sheet. One
//      destination, nothing to ask.
//   4. NOTHING here starts audio. The schedule must never touch an <audio>
//      element; the chooser's Live answer opens the live player and stops
//      (docs/schedule-dev.md).
//   5. The chooser carries no history entry, and its Live answer clears the
//      stale {sched:1} flag — or Back re-opens the schedule and looks dead
//      (fixed once already, 2026-08-06).
//
// The live row is driven by the on-air feed matching a scheduled title, which
// is not reproducible on demand, so these tests force the row's class and then
// assert the ROW's contract. The matching itself is schedTitleMatches' job.
const { connect, sleep } = require('../live-stream/cdp.js');

const APP = 'http://localhost:8080/';
const PORT = 9225;         // clear of live-stream 9222, touch 9223, rail 9224
const MIN = 44;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
}

// Force one row on-air and hand back its show id. It is scrolled into the
// schedule's own viewport first: these tests tap at real coordinates, and a row
// sitting below the fold is tapped at coordinates that belong to something else
// entirely — which is exactly how the first run of this file "failed".
const MAKE_LIVE = `
  var wraps = document.querySelectorAll('.sched-show-wrap');
  if(!wraps.length) return null;
  // Clear any GENUINELY live row first, so '.sched-show-live' means "the row
  // this function forced" and nothing else. Without it the tests below tap
  // '.sched-show-live .sched-show', which is the FIRST match in document order
  // — and when a real on-air show sorts above the forced row, that is a
  // different row than the id being asserted against.
  //
  // It failed exactly that way at 00:12 on 2026-08-08: the live show was
  // Midnight Ravers at 12 AM (row 0), above the row this forces (row 3). Ten
  // minutes earlier the live show was at 9 PM, below it, and the suite passed.
  // A test that only fails between midnight and ~2 am is worse than one that
  // fails always, so this is pinned rather than left to the clock.
  //
  // It also makes "the on-air row is marked, and ONLY it" true to its name:
  // that check uses :not(.sched-show-live), which is satisfied by any other row
  // and so stayed green even while two rows were marked.
  [].forEach.call(document.querySelectorAll('.sched-show-live'), function(el){
    el.classList.remove('sched-show-live');
  });
  var w = wraps[Math.min(3, wraps.length - 1)];
  w.classList.add('sched-show-live');
  w.scrollIntoView({ block: 'center' });
  return w.querySelector('.sched-show').dataset.id;
`;
async function openSchedule(p) {
  await p.send('Page.navigate', { url: APP });
  await sleep(2500);
  await p.eval(`document.getElementById('scheduleBtn').click(); return 1;`);
  await sleep(600);
}
// A real tap, not p.click(): the ghost-click path is live on touch and this
// dialog is opened by exactly that gesture (see test/touch §6).
async function tap(p, sel) {
  const at = await p.eval(`
    var e = document.querySelector(${JSON.stringify(sel)});
    if(!e) return null;
    var r = e.getBoundingClientRect();
    var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
    return { x: x, y: y,
             onScreen: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
             // whatever is actually under that point — a tap goes to the top
             // element, not to the one we named
             hit: (function(){ var el = document.elementFromPoint(x, y); return el ? (el.className || el.tagName) : null; })(),
             contains: (function(){ var el = document.elementFromPoint(x, y); return !!el && (e === el || e.contains(el)); })() };`);
  if (!at) throw new Error('no element for ' + sel);
  // Loud, not silent. A tap dispatched at off-screen coordinates lands on
  // nothing and reads exactly like a broken feature — that cost one confused
  // debugging round on 2026-08-06.
  if (!at.onScreen) throw new Error('refusing to tap ' + sel + ' — it is off screen at ' + at.x + ',' + at.y);
  if (!at.contains) throw new Error('tapping ' + sel + ' would hit "' + at.hit + '" instead');
  const tp = [{ x: at.x, y: at.y, radiusX: 10, radiusY: 10, force: 1, id: 1 }];
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
  await sleep(50);
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(700);
}
const STATE = `
  return {
    chooser: !!document.querySelector('.live-choice.show'),
    sheet: document.getElementById('showSheet').classList.contains('show'),
    sched: !!document.querySelector('.sched-modal.show'),
    livePlayer: !!document.querySelector('.live-player.show'),
    url: location.search,
    hist: history.length,
    schedFlag: !!(history.state && history.state.sched),
    playing: !document.querySelector('audio').paused
  };`;

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 750, deviceScaleFactor: 3, mobile: true });
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log('\n1. the on-air row is marked, and only it');
  await openSchedule(p);
  const id = await p.eval(MAKE_LIVE);
  check('the schedule rendered rows to test', !!id, id);
  const marked = await p.eval(`
    var w = document.querySelector('.sched-show-live');
    var badge = w.querySelector('.sched-live-badge');
    var other = document.querySelector('.sched-show-wrap:not(.sched-show-live) .sched-live-badge');
    return {
      shown: getComputedStyle(badge).display, word: badge.textContent.trim(),
      otherShown: other ? getComputedStyle(other).display : 'none',
      // one control on the row, not two: the card itself
      controls: w.querySelectorAll('button').length,
      rowOverflows: w.scrollWidth > w.clientWidth + 1
    };`);
  check('the on-air row wears a Live badge', marked.shown !== 'none', marked.word);
  check('every other row does not', marked.otherShown === 'none', marked.otherShown);
  check('the row carries ONE control, not a pair competing for the space',
        marked.controls === 1, marked.controls);
  check('and still fits a phone-width row', marked.rowOverflows === false);

  // Teeth: if the probe could not see the badge disappear, the assertions above
  // could be reading a row that was never live.
  const blind = await p.eval(`
    var w = document.querySelector('.sched-show-live');
    w.classList.remove('sched-show-live');
    return getComputedStyle(w.querySelector('.sched-live-badge')).display;`);
  check('SELF-TEST: drop the live class and the badge really vanishes', blind === 'none', blind);

  console.log('\n2. tapping the on-air row asks instead of guessing');
  await openSchedule(p);
  await p.eval(MAKE_LIVE);
  await tap(p, '.sched-show-live .sched-show');
  let s = await p.eval(STATE);
  check('THE WHOLE CARD OPENS THE CHOOSER — no half of it does something else',
        s.chooser === true);
  check('it does not jump straight to the archive', s.sheet === false);
  check('it does not start playing anything', s.playing === false);
  check('the schedule is still there underneath', s.sched === true);
  check('the chooser adds no history entry — Back still belongs to the schedule',
        s.schedFlag === true, s.hist);

  // tapping the badge itself is the same card, so the same thing must happen
  await p.eval(`document.getElementById('liveChoiceCancel').click(); return 1;`);
  await sleep(400);
  await tap(p, '.sched-show-live .sched-live-badge');
  check('tapping the badge does the same as the rest of the card',
        (await p.eval(STATE)).chooser === true);

  console.log('\n3. the three answers');
  const answers = await p.eval(`
    var d = document.querySelector('.live-choice.show');
    var btns = d.querySelectorAll('button');
    var out = [];
    for(var i=0;i<btns.length;i++) out.push({ t: btns[i].textContent.trim(), h: Math.round(btns[i].getBoundingClientRect().height) });
    return { count: btns.length, btns: out, title: document.getElementById('liveChoiceTitle').textContent };`);
  check('exactly three answers: live, archive, dismiss', answers.count === 3, answers.btns.map(b => b.t));
  check('and it names the show it is asking about', !!answers.title, answers.title);
  check('the two real answers clear the touch floor',
        answers.btns[0].h >= MIN && answers.btns[1].h >= MIN,
        answers.btns.map(b => b.h));

  console.log('\n   dismiss');
  await tap(p, '#liveChoiceCancel');
  s = await p.eval(STATE);
  check('Cancel closes the chooser', s.chooser === false);
  check('and leaves the schedule exactly where it was', s.sched === true);
  check('having started nothing', s.playing === false && s.livePlayer === false);

  console.log('\n   past episodes');
  await openSchedule(p);
  const id2 = await p.eval(MAKE_LIVE);
  await tap(p, '.sched-show-live .sched-show');
  await tap(p, '#liveChoiceArchive');
  s = await p.eval(STATE);
  check('the archive answer opens that show\'s sheet', s.sheet === true);
  check('on the right show', s.url.indexOf(id2) !== -1, [s.url, id2]);
  check('the chooser gets out of the way', s.chooser === false);
  check('and no audio was started', s.playing === false);

  console.log('\n   listen live');
  await openSchedule(p);
  await p.eval(MAKE_LIVE);
  const before = await p.eval(STATE);
  await tap(p, '.sched-show-live .sched-show');
  await tap(p, '#liveChoiceLive');
  s = await p.eval(STATE);
  check('the live answer opens the live player', s.livePlayer === true);
  check('the schedule closes behind it', s.sched === false);
  check('it does not also open the archive sheet', s.sheet === false);
  check('the stale {sched} flag is cleared, so Back is not left dead',
        s.schedFlag === false, before.schedFlag + ' -> ' + s.schedFlag);
  check('no history entry was spent on the question', s.hist === before.hist, [before.hist, s.hist]);
  check('and the schedule itself started no archive audio', s.playing === false);

  console.log('\n4. a row that is NOT on air is unchanged');
  await openSchedule(p);
  // No row is live here, so nothing has been scrolled to; put a real one under
  // the finger rather than trusting whatever the first selector match happens
  // to be (tap() refuses off-screen targets, which is how this was caught).
  await p.eval(`
    document.querySelector('.sched-show-wrap .sched-show').scrollIntoView({block:'center'});
    return 1;`);
  await sleep(200);
  await tap(p, '.sched-show-wrap:not(.sched-show-live) .sched-show');
  s = await p.eval(STATE);
  check('it goes straight to the sheet, with nothing to ask', s.sheet === true && s.chooser === false);
  check('starting no audio either', s.playing === false);

  console.log('\n5. Escape belongs to the chooser while it is up');
  await openSchedule(p);
  await p.eval(MAKE_LIVE);
  await tap(p, '.sched-show-live .sched-show');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(500);
  s = await p.eval(STATE);
  check('Escape closes the chooser', s.chooser === false);
  check('and NOT the schedule underneath it', s.sched === true);

  console.log('\n6. the daily list is independent of the day-tab columns');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await openSchedule(p);
  const layout = await p.eval(`
    var time = document.querySelector('.sched-time').getBoundingClientRect();
    var shows = document.querySelector('.sched-shows').getBoundingClientRect();
    return {
      timeWidth: Math.round(time.width),
      gutter: Math.round(shows.left - time.right)
    };`);
  check('desktop time column is only as wide as its widest label',
        layout.timeWidth <= 48, layout.timeWidth);
  check('show cards follow the time labels without a tab-sized spacer',
        layout.gutter <= 10, layout.gutter);

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed\n`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });

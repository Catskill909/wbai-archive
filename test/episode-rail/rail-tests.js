// The show sheet's episode rail, against the real app in headless Chrome.
//
// What the rail is for: the archive listing is episode-level (one card per
// broadcast), and the schedule can only ever hand over a slot's most recent
// row, so the rail is the only way to reach the OTHER episodes of the show you
// are already looking at. A show has between 1 and ~26 of them.
//
// The two rules that matter and are easy to regress:
//   1. Choosing an episode must NOT play it. Play stays one deliberate tap on
//      the control that has always meant play.
//   2. Choosing must not push a history entry, or Back stops meaning "close the
//      sheet" and starts meaning "undo six chip taps" — the same rule the
//      filters follow (app.js, urlFor/syncUrl).
//
// Fixtures are derived from the live listing, never hardcoded: every episode id
// in this archive rotates out within its retention window, so an id written down
// today is a test that fails for the wrong reason in two months.
const { connect, sleep } = require('../live-stream/cdp.js');

const BASE = 'http://localhost:8080';
let fails = 0, checks = 0;
function check(ok, msg, extra) {
  checks++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (!ok) fails++;
}

// Group the listing the way the app does — by lowercased `sho` slug — and pick
// one show at each shape the rail has to handle.
async function pickFixtures() {
  const data = await (await fetch(BASE + '/api/archive')).json();
  const rows = (data.shows || []).filter(r => r.mp3);
  const by = {};
  for (const r of rows) (by[String(r.sho).toLowerCase()] ||= []).push(r);
  const groups = Object.values(by).map(g => g.sort((a, b) => (b.dt || 0) - (a.dt || 0)));
  const bySize = n => groups.find(g => g.length === n);
  const biggest = groups.slice().sort((a, b) => b.length - a.length)[0];
  const few = groups.filter(g => g.length >= 2 && g.length <= 5)
                    .sort((a, b) => b.length - a.length)[0];
  return {
    many: biggest,                                  // scrolls, offers "All N"
    few,                                            // fits, no "All N"
    one: bySize(1),                                 // must render no rail at all
    old: biggest[Math.min(7, biggest.length - 1)]   // opening on a non-newest episode
  };
}

async function open(p, id) {
  await p.send('Page.navigate', { url: BASE + '/?show=' + encodeURIComponent(id) });
  await sleep(1400);
}

(async () => {
  const fx = await pickFixtures();
  if (!fx.many || !fx.few) { console.log('listing has no multi-episode show to test'); process.exit(1); }
  console.log('fixtures: many=' + fx.many[0].sho + '(' + fx.many.length + ')' +
              ' few=' + fx.few[0].sho + '(' + fx.few.length + ')' +
              ' one=' + (fx.one ? fx.one[0].sho : 'none'));

  const p = await connect(9224);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  const READ = `
    var rail = document.getElementById('sheetEpsRail');
    var on = rail && rail.querySelector('.ep.on');
    var lbl = document.querySelector('.sheet-play .play-label');
    // rects, not offsetLeft: the code under test uses offsetLeft, and a check
    // that used it too would share any offsetParent bug with it (one did)
    function inside(el, box){
      var a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1 &&
             a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    }
    return {
      open: document.getElementById('showSheet').classList.contains('show'),
      rail: !!rail,
      chips: rail ? rail.querySelectorAll('.ep').length : 0,
      selected: on ? on.getAttribute('data-id') : null,
      selectedIsFirst: on ? on === rail.querySelector('.ep') : null,
      selectedVisible: on ? inside(on, rail) : null,
      checkedAttr: on ? on.getAttribute('aria-checked') : null,
      checkedCount: rail ? rail.querySelectorAll('.ep[aria-checked="true"]').length : 0,
      tabbable: rail ? rail.querySelectorAll('.ep[tabindex="0"]').length : 0,
      allBtn: (document.querySelector('.eps-all') || {}).textContent || null,
      playLabel: lbl ? lbl.textContent : null,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  `;

  for (const view of [{ n: 'desktop', w: 1280, h: 900, m: false },
                      { n: 'phone', w: 390, h: 844, m: true }]) {
    console.log('\n#### ' + view.n);
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: view.w, height: view.h, deviceScaleFactor: 2, mobile: view.m });

    // --- a show with many episodes ---
    await open(p, fx.many[0].id);
    let s = await p.eval(READ);
    check(s.open && s.rail, 'a many-episode show gets a rail');
    check(s.chips === fx.many.length, 'every episode of the show is offered', [s.chips, fx.many.length]);
    check(s.selected === String(fx.many[0].id), 'the episode the sheet opened on is the selected one');
    check(s.checkedCount === 1 && s.checkedAttr === 'true', 'exactly one chip is aria-checked');
    check(s.tabbable === 1, 'roving tabindex: the rail is a single Tab stop', s.tabbable);
    check(s.selectedVisible, 'the selected chip is inside the rail viewport');
    check(!s.sideways, 'the page does not scroll sideways');
    check(/^All /.test(s.allBtn || ''), 'a long rail offers to show them all', s.allBtn);
    check(s.playLabel === 'Play episode', 'on the newest episode Play says nothing extra', s.playLabel);

    // --- opened on an OLD episode (the deep-link and the "played it last week" case) ---
    await open(p, fx.old.id);
    s = await p.eval(READ);
    check(s.selected === String(fx.old.id) && s.selectedIsFirst === false,
          'opening on a non-newest episode selects that episode, not the newest');
    check(s.selectedVisible, 'and scrolls it into view rather than leaving it off-rail');
    check(/^Play · /.test(s.playLabel || ''),
          'Play names the chosen date, so the pinned button is still true once the rail scrolls away',
          s.playLabel);

    // --- a show with a handful ---
    await open(p, fx.few[0].id);
    s = await p.eval(READ);
    check(s.rail && s.chips === fx.few.length, 'a short rail shows every episode', s.chips);
    check(s.allBtn === null, 'and does not offer "All N" it does not need');
    check(!s.sideways, 'the page does not scroll sideways');

    // --- a show with exactly one ---
    if (fx.one) {
      await open(p, fx.one[0].id);
      s = await p.eval(READ);
      check(s.open && !s.rail, 'a single-episode show renders NO rail (not an empty one)');
    }
  }

  // ---- above the fold ----
  // The rail shipped inside the scrolling body and was therefore invisible on a
  // phone until you scrolled for it — which is the whole feature, missed. It is
  // pinned in the footer now, and this is the assertion that keeps it there:
  // measured against the VIEWPORT, with no scrolling of any kind first.
  console.log('\n#### reachable without scrolling (phone)');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 750, deviceScaleFactor: 3, mobile: true });
  await open(p, fx.many[0].id);
  const fold = await p.eval(`
    var rail = document.getElementById('sheetEpsRail');
    var foot = document.getElementById('sheetFoot');
    var play = document.querySelector('.sheet-play');
    var rr = rail.getBoundingClientRect(), pr = play.getBoundingClientRect();
    return {
      inFooter: foot.contains(rail),
      railOnScreen: rr.top >= 0 && rr.bottom <= innerHeight + 1,
      playOnScreen: pr.bottom <= innerHeight + 1,
      railAbovePlay: rr.bottom <= pr.top + 1,
      linksAboveRail: (function(){
        var l = document.querySelector('.sheet-links');
        return l ? l.getBoundingClientRect().bottom <= rr.top + 1 : null;
      })(),
      bodyScrolledBy: document.getElementById('sheetBody').scrollTop
    };`);
  check(fold.inFooter, 'the rail is pinned in the footer, not in the scrolling body');
  check(fold.bodyScrolledBy === 0, 'nothing was scrolled before measuring', fold.bodyScrolledBy);
  check(fold.railOnScreen, 'the rail is fully on screen on an iPhone-sized viewport');
  check(fold.playOnScreen && fold.railAbovePlay, 'Play sits below the rail and is still on screen');
  check(fold.linksAboveRail !== false, 'the links row sits above the rail');

  // ---- the scroll hint ----
  // A clipped line reads as missing rather than as scrolled-away, so each edge
  // of the body is faded only while something is genuinely past it.
  console.log('\n#### scroll hint');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 620, deviceScaleFactor: 3, mobile: true });
  await open(p, fx.many[0].id);
  const fade = await p.eval(`
    var b = document.getElementById('sheetBody');
    var slack = b.scrollHeight - b.clientHeight;
    var atTop = { top: b.classList.contains('fade-top'), bottom: b.classList.contains('fade-bottom'),
                  masked: getComputedStyle(b).maskImage !== 'none' };
    b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll'));
    var atEnd = { top: b.classList.contains('fade-top'), bottom: b.classList.contains('fade-bottom') };
    b.scrollTop = Math.round(slack/2); b.dispatchEvent(new Event('scroll'));
    var mid = { top: b.classList.contains('fade-top'), bottom: b.classList.contains('fade-bottom') };
    // self-test: with the classes gone the mask must really be absent, or every
    // assertion above is measuring a stylesheet that was never applied
    b.classList.remove('fade-top', 'fade-bottom');
    return { slack: slack, atTop: atTop, atEnd: atEnd, mid: mid,
             strippedMask: getComputedStyle(b).maskImage };`);
  check(fade.slack > 4, 'the fixture body really does overflow (or this proves nothing)', fade.slack);
  check(fade.atTop.bottom === true && fade.atTop.top === false,
        'at the top: the bottom edge is faded, the top edge is not');
  check(fade.atTop.masked, 'and the mask is actually applied, not just the class');
  check(fade.atEnd.top === true && fade.atEnd.bottom === false,
        'at the bottom: it flips — nothing below, something above');
  check(fade.mid.top === true && fade.mid.bottom === true, 'in the middle: both edges fade');
  check(fade.strippedMask === 'none',
        'self-test: strip the classes and the mask really goes away', fade.strippedMask);

  // ---- interaction, on a phone, on the biggest show ----
  console.log('\n#### choosing an episode');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await open(p, fx.many[0].id);
  const before = await p.eval(`return { hist: history.length, url: location.search };`);
  await p.eval(`document.querySelectorAll('.ep')[3].click(); return 1;`);
  await sleep(250);
  const after = await p.eval(`
    var on = document.querySelector('.ep.on');
    return {
      idx: Array.prototype.indexOf.call(document.querySelectorAll('.ep'), on),
      id: on.getAttribute('data-id'),
      url: location.search,
      hist: history.length,
      playing: !document.querySelector('audio').paused,
      barHidden: document.getElementById('playerBar').hidden,
      playLabel: document.querySelector('.sheet-play .play-label').textContent,
      aired: document.querySelector('.sheet-facts').textContent.replace(/\\s+/g, ' ').trim()
    };
  `);
  check(after.idx === 3 && after.id === String(fx.many[3].id), 'the tapped chip becomes the selection');
  check(!after.playing && after.barHidden,
        'CHOOSING AN EPISODE DOES NOT PLAY IT — play stays one deliberate tap');
  check(after.hist === before.hist,
        'no history entry pushed, so Back still means "close the sheet"', [before.hist, after.hist]);
  check(after.url !== before.url && /show=/.test(after.url),
        'the URL follows the choice, so a share link names the exact episode', after.url);
  check(/^Play · /.test(after.playLabel), 'Play names the chosen date', after.playLabel);
  check(after.aired.indexOf(fx.many[3].length) !== -1,
        'the facts row repainted to the chosen episode', after.aired.slice(0, 70));

  console.log('\n#### expanding the rail');
  await p.eval(`document.querySelector('.eps-all').click(); return 1;`);
  await sleep(250);
  const exp = await p.eval(`
    var rail = document.getElementById('sheetEpsRail');
    var on = rail.querySelector('.ep.on');
    var a = on.getBoundingClientRect(), b = rail.getBoundingClientRect();
    return {
      open: document.querySelector('.sheet-eps').classList.contains('open'),
      wrap: getComputedStyle(rail).flexWrap,
      onVisible: a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
      contained: getComputedStyle(rail).overscrollBehaviorY,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      btn: document.querySelector('.eps-all').textContent
    };
  `);
  check(exp.open && exp.wrap === 'wrap', 'expands into a wrapped grid of the same chips');
  check(exp.onVisible, 'the chosen episode is still on screen after expanding');
  check(exp.contained === 'contain', 'the grid contains its own scroll gesture');
  check(!exp.sideways, 'and does not push the page sideways');
  check(/less/i.test(exp.btn), 'the toggle now offers to collapse', exp.btn);

  // ---- the heard marks ----
  // Seeded through localStorage in the app's own format, then reloaded, so this
  // exercises the same path a real listening session leaves behind.
  console.log('\n#### what you have already heard');
  await p.eval(`
    var map = {};
    map[${JSON.stringify(fx.many[1].mp3)}] = { t: 1800, d: 3600, at: Date.now() };
    map[${JSON.stringify(fx.many[2].mp3)}] = { t: 0, d: 3600, at: Date.now(), done: 1 };
    localStorage.setItem('wbai-resume', JSON.stringify(map));
    return 1;
  `);
  await open(p, fx.many[0].id);
  const marks = await p.eval(`
    var eps = document.querySelectorAll('.ep');
    var bar = eps[1].querySelector('.ep-bar');
    return {
      partShown: getComputedStyle(bar).display,
      fill: Math.round(parseFloat(getComputedStyle(bar, '::after').width)),
      barW: Math.round(bar.getBoundingClientRect().width),
      doneShown: getComputedStyle(eps[2].querySelector('.ep-check')).display,
      untouchedBar: getComputedStyle(eps[3].querySelector('.ep-bar')).display,
      untouchedCheck: getComputedStyle(eps[3].querySelector('.ep-check')).display,
      label1: eps[1].getAttribute('aria-label'),
      label2: eps[2].getAttribute('aria-label')
    };
  `);
  check(marks.partShown === 'block', 'a part-heard episode draws a progress bar');
  check(Math.abs(marks.fill / marks.barW - 0.5) < 0.08,
        'filled to the fraction actually heard, not just "some"', [marks.fill, marks.barW]);
  check(marks.doneShown === 'block', 'a finished episode draws a tick');
  check(marks.untouchedBar === 'none' && marks.untouchedCheck === 'none',
        'an untouched episode draws neither');
  check(/50% played/.test(marks.label1 || ''), 'the state reaches screen readers', marks.label1);
  check(/played/.test(marks.label2 || ''), 'including "played" for a finished one', marks.label2);

  // A suite full of "this mark is absent" assertions passes perfectly once the
  // probe goes blind, so make the probe prove it can still see one disappear.
  // (CLAUDE.md §3a.5. Through CSSOM — the CSP silently voids injected <style>.)
  const blind = await p.eval(`
    var eps = document.querySelectorAll('.ep');
    eps[1].classList.remove('part');
    eps[2].classList.remove('done');
    return {
      part: getComputedStyle(eps[1].querySelector('.ep-bar')).display,
      done: getComputedStyle(eps[2].querySelector('.ep-check')).display
    };
  `);
  check(blind.part === 'none' && blind.done === 'none',
        'self-test: strip the classes and the marks really do vanish', blind);

  // ---- the transport must survive choosing another date ----
  //
  // The sheet covers the docked player bar (z-index 180 vs 80), so it owes a
  // transport for everything it hides. It used not to: selecting a second
  // episode mid-listen hid the scrubber and turned Pause into "Play · Jul 31",
  // so the episode still playing had no control anywhere on screen and no mark
  // on its chip either — the listener could neither pause it nor find it.
  //
  // Every check here is on what reaches the viewport (rendered size, computed
  // colour, whether the audio element actually moved), not on whether a class
  // or an attribute was set. CLAUDE.md §3a.
  console.log('\n#### the transport survives choosing another date');
  await p.eval(`localStorage.removeItem('wbai-resume'); return 1;`);
  await open(p, fx.many[0].id);

  // A real synthesized gesture, not el.click(): playback is what the whole
  // section rests on, and an autoplay policy would refuse a programmatic one.
  await p.clickInPlace('.sheet-play');
  await sleep(1500);
  const lit = await p.eval(`
    var a = document.querySelector('audio');
    return { playing: !a.paused && !a.ended, src: a.currentSrc || a.src };
  `);
  check(lit.playing, 'the episode really started (everything below depends on it)', lit.playing);

  const READ_NOW = `
    var a = document.querySelector('audio');
    var eps = document.querySelectorAll('.ep');
    var strip = document.getElementById('sheetNow');
    var scrub = document.getElementById('sheetScrub');
    var lit = document.querySelectorAll('.ep.playing');
    // rendered, not merely declared: hidden, display:none and a collapsed box
    // all mean "the listener cannot see it", and only one of them is a class
    function shown(el){
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none' &&
             el.getBoundingClientRect().height > 2;
    }
    // Resolve --accent through CSSOM (the CSP voids a style attribute) so
    // "how many orange buttons" is counted in painted colour, not in classes.
    var probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    var accent = getComputedStyle(probe).color;
    probe.remove();
    var filled = Array.prototype.filter.call(
      document.querySelectorAll('.sheet-foot button'),
      function(b){ return getComputedStyle(b).backgroundColor === accent; }).length;
    var idx = function(el){ return Array.prototype.indexOf.call(eps, el); };
    return {
      playing: !a.paused && !a.ended,
      src: a.currentSrc || a.src,
      t: a.currentTime,
      stripShown: shown(strip),
      stripText: strip ? strip.textContent.replace(/\\s+/g, ' ').trim() : null,
      toggleLabel: strip ? document.getElementById('sheetNowToggle').getAttribute('aria-label') : null,
      scrubShown: shown(scrub),
      litCount: lit.length,
      litIdx: lit.length ? idx(lit[0]) : -1,
      onIdx: idx(document.querySelector('.ep.on')),
      eq: lit.length ? getComputedStyle(lit[0].querySelector('.ep-eq')).display : null,
      litBar: lit.length ? getComputedStyle(lit[0].querySelector('.ep-bar')).display : null,
      playLabel: document.querySelector('.sheet-play .play-label').textContent,
      orangeButtons: filled
    };
  `;

  const heard = await p.eval(READ_NOW);
  check(heard.litCount === 1 && heard.litIdx === 0 && heard.eq === 'flex',
        'the playing episode is marked on the rail', [heard.litIdx, heard.eq]);
  check(heard.litBar === 'none',
        'and the equaliser replaces the progress bar rather than crowding it', heard.litBar);
  check(!heard.stripShown,
        'no stand-in strip while the selected episode IS the one playing — that is the plain case');

  // A section this full of "the mark is there" needs to prove it can see one
  // leave, or it passes just as happily with a blind probe (CLAUDE.md §3a.5).
  // It has to run HERE, while something is playing: pause below and no chip
  // carries the class, so the probe would find nothing and read as clean. The
  // class comes straight back — the next chip tap repaints through syncEpMarks.
  const blindEq = await p.eval(`
    var el = document.querySelector('.ep.playing');
    el.classList.remove('playing');
    return { eq: getComputedStyle(el.querySelector('.ep-eq')).display };
  `);
  check(blindEq.eq === 'none', 'self-test: strip the class and the equaliser really vanishes', blindEq.eq);

  // The regression itself.
  await p.eval(`document.querySelectorAll('.ep')[3].click(); return 1;`);
  await sleep(400);
  const kept = await p.eval(READ_NOW);
  check(kept.playing && kept.src === lit.src,
        'choosing another date leaves the audio alone — it is a selection, not a switch');
  check(kept.scrubShown, 'THE SCRUBBER SURVIVES: the sheet hides the player bar, so it owes one');
  check(kept.stripShown && /Playing/.test(kept.stripText || ''),
        'and a strip names what is actually in the player', kept.stripText);
  check(/^Pause /.test(kept.toggleLabel || ''),
        'whose button pauses THAT episode, not the selected one', kept.toggleLabel);
  check(kept.litCount === 1 && kept.litIdx === 0 && kept.onIdx === 3,
        'the rail now says two different things: this is playing, that is selected',
        [kept.litIdx, kept.onIdx]);
  check(kept.orangeButtons === 1,
        'exactly ONE filled accent button on screen — the strip reports, the button offers',
        kept.orangeButtons);
  check(/^Play · /.test(kept.playLabel || ''),
        'and that button names what it would switch to', kept.playLabel);

  // Pausing from the strip must not make the strip go away — that would drop the
  // listener back into the hole this whole section is about.
  await p.clickInPlace('.sheet-now-toggle');
  await sleep(500);
  const held = await p.eval(READ_NOW);
  check(!held.playing, 'the strip really pauses the audio', held.playing);
  check(held.stripShown && /Paused/.test(held.stripText || ''),
        'and STAYS, now saying Paused — vanishing here is how you get lost again', held.stripText);
  check(/^Resume /.test(held.toggleLabel || ''), 'offering to resume', held.toggleLabel);

  // One tap back to what you were hearing.
  await p.clickInPlace('.sheet-now-back');
  await sleep(400);
  const home = await p.eval(READ_NOW);
  check(home.onIdx === 0, 'the strip is the way back to the episode in the player', home.onIdx);
  check(!home.stripShown,
        'and retires once it has nothing left to tell you');

  // The same duty for the strip: "it retires" is an assertion of absence, so the
  // probe has to demonstrate it would have seen the strip had it been there.
  const blindStrip = await p.eval(`
    var strip = document.getElementById('sheetNow');
    strip.hidden = false;
    var seen = strip.getBoundingClientRect().height > 2;
    strip.hidden = true;
    return { seen: seen, gone: strip.getBoundingClientRect().height <= 2 };
  `);
  check(blindStrip.seen && blindStrip.gone,
        'self-test: the probe can tell a shown strip from a hidden one', blindStrip);

  await p.eval(`var a=document.querySelector('audio'); a.pause(); a.removeAttribute('src'); return 1;`);

  // ---- keyboard ----
  console.log('\n#### keyboard');
  await open(p, fx.many[0].id);
  await p.eval(`document.querySelectorAll('.ep')[0].focus(); return 1;`);
  for (const key of ['ArrowRight', 'ArrowRight']) {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 37 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
    await sleep(120);
  }
  const kb = await p.eval(`
    var eps = document.querySelectorAll('.ep');
    return {
      idx: Array.prototype.indexOf.call(eps, document.querySelector('.ep.on')),
      focused: document.activeElement.classList.contains('ep'),
      playing: !document.querySelector('audio').paused
    };
  `);
  check(kb.idx === 2, 'arrow keys move the selection along the rail', kb.idx);
  check(kb.focused, 'and focus follows it');
  check(!kb.playing, 'and still nothing has started playing');

  console.log('\n' + (fails ? fails + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' episode-rail checks passed'));
  p.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

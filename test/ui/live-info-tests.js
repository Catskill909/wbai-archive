// "About this show" suite — the live player's artwork as a control, and the
// panel it opens.
//
// Drives the unmodified app. Four JSON responses are faked so the on-air show is
// a known quantity rather than whatever WBAI happens to be broadcasting:
// /api/nowplaying (which show is on air, and its altid), /api/showinfo (the
// harvest the panel reads its prose from), /api/showinfo/<altid> (the per-show
// lookup that covers shows the harvest never met) and /api/programs (emptied, so
// the join under test is the harvest one).
//
// House rule (CLAUDE.md §3a): assert the EFFECT. So "the panel is up" is a
// measured on-screen rectangle, "the player is unreachable behind it" is a
// hit-test at the play button's own coordinates, and each absence claim carries a
// self-test that forces the probe to report the other answer.
//
// ⚠️ ORDERING CONSTRAINT — the Escape section MUST stay last.
// A dispatched Escape key (Input.dispatchKeyEvent, keyDown or rawKeyDown alike)
// permanently stops this headless browser from producing frames for any document
// navigated afterwards: document.timeline.currentTime stays null, every CSS
// transition freezes at its FROM value, and Page.captureScreenshot hangs.
// Measured, not guessed — with an Escape first, the phone sheet reports top:924
// in a 780px viewport (its off-screen start); without one, top:180. That is
// silent poison for a suite built on geometry, which is why requireClock() below
// fails loudly instead of letting a frozen page produce plausible numbers.
const { connect, sleep } = require('../live-stream/cdp.js');
// 9224: live-stream owns 9222 and touch owns 9223. See run.sh.
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (d ? '  -> ' + d : ''))); };

const ALTID = 'ui_test_show';
const NAME = 'The Test Transmission';
const DJ = 'Ada Probe';
// Decisively longer than any panel is tall — WBAI really does carry descriptions
// that run to a dozen paragraphs (Democracy Now!'s), and a fixture that happens
// to fit tests nothing about the scroll container it is supposed to need.
const DESC = 'A programme that exists only inside this test suite. ' +
  ('It covers the ongoing struggle of assertions to observe effects rather than ' +
   'declarations, and is broadcast from a fake now-playing feed. ').repeat(24);
const SITE = 'https://example.org/the-test-transmission';
const FB = 'https://www.facebook.com/thetesttransmission';

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/nowplaying*' },
      { urlPattern: '*/api/showinfo' },
      { urlPattern: '*/api/showinfo/*' },
      { urlPattern: '*/api/programs*' }
    ]
  });

  // What the fake station is currently saying. Mutated between sections.
  let now = { name: NAME, dj: DJ, altid: ALTID, start: '11:00 AM', end: '12:00 PM' };
  let nextUp = { name: 'Whatever Follows', start: '12:00 PM', end: '1:00 PM' };
  let harvest = { [ALTID]: { name: NAME, dj: DJ, desc: DESC, url: SITE, facebook: FB } };
  let detail = null;             // what /api/showinfo/<altid> answers, if anything

  p.on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const url = m.params.request.url;
    let body;
    if (url.includes('/api/nowplaying')) body = { updated: Date.now(), current: now, next: nextUp };
    else if (url.includes('/api/showinfo/')) {
      body = { altid: url.split('/api/showinfo/')[1].split('?')[0], info: detail };
    } else if (url.includes('/api/showinfo')) {
      body = { updated: Date.now(), count: Object.keys(harvest).length, shows: harvest };
    } else body = { updated: Date.now(), count: 0, programs: {} };
    await p.send('Fetch.fulfillRequest', {
      requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64')
    });
  });

  async function load({ w = 1400, h = 1000 } = {}) {
    const touch = w < 700;
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await p.send('Emulation.setTouchEmulationEnabled',
      touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2200);
  }
  const openPlayer = () => p.click('#onAirBtn').then(() => sleep(500));
  const openPanel = () => p.click('#lpInfoBtn').then(() => sleep(500));
  // Park a real cursor over an element's centre (or well away from it) — the hint
  // is a :hover effect, so nothing short of moving the mouse tests it.
  async function hover(sel) {
    const pt = sel ? await p.eval(`
      var r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };`)
      : { x: 5, y: 5 };
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await sleep(320);        // the hint fades in over .14s
  }

  // Is this page still being rendered? Every geometry assertion below is worth
  // exactly as much as the answer — see the ordering constraint at the top.
  async function requireClock(where) {
    const t = await p.eval('return document.timeline.currentTime;');
    const live = typeof t === 'number' && t > 0;
    ok('the page is still being rendered (' + where + ')', live,
      'frames have stopped — every rect below would be a transition’s start value');
    return live;
  }
  async function pressEscape() {
    for (const type of ['keyDown', 'keyUp']) {
      await p.send('Input.dispatchKeyEvent',
        { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    await sleep(350);
  }
  // A trusted click at raw coordinates, landing on whatever is topmost there —
  // the opposite of p.click(), which refuses when the target is covered.
  async function clickAt(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await p.send('Input.dispatchMouseEvent',
        { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(400);
  }

  // Everything the tile and the panel put on screen, measured not declared.
  const SNAP = `
    var btn = document.getElementById('lpInfoBtn');   // the artwork tile itself
    var panel = document.getElementById('lpInfo');
    var hint = document.querySelector('.lp-art-hint');
    var toggle = document.getElementById('lpToggle');
    var body = document.getElementById('lpInfoBody');
    var br = btn.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    var tr = toggle.getBoundingClientRect();
    var overToggle = document.elementFromPoint(tr.left + tr.width/2, tr.top + tr.height/2);
    var overArt = document.elementFromPoint(br.left + br.width/2, br.top + br.height/2);
    var hr = hint.getBoundingClientRect();
    return {
      // the artwork: painted, square, and the topmost thing at its own centre
      artOnScreen: br.width > 0 && br.height > 0,
      artSquare: Math.abs(br.width - br.height) <= 1,
      artHittable: !!(overArt && (overArt === btn || btn.contains(overArt))),
      artIsControl: btn.tagName === 'BUTTON' && btn.disabled === false,
      // the hover hint: what it says, and whether it is actually being shown
      hintText: hint.textContent.trim(),
      hintVisible: parseFloat(getComputedStyle(hint).opacity) > 0.9,
      hintOpacity: getComputedStyle(hint).opacity,
      hintInArt: hr.width > 0 && hr.left >= br.left - 1 && hr.right <= br.right + 1 &&
                 hr.bottom <= br.bottom + 1 && hr.top >= br.top - 1,
      // numbers, not verdicts — this is what a failing hit-test needs to say
      artRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
      vp: [innerWidth, innerHeight],
      overArt: overArt ? (overArt.tagName + '#' + overArt.id) : 'none',
      panelOnScreen: pr.width > 0 && pr.height > 0 &&
                     pr.top >= -1 && pr.bottom <= innerHeight + 1,
      panelBottom: Math.round(innerHeight - pr.bottom),
      title: document.getElementById('lpInfoTitle').textContent,
      host: document.getElementById('lpInfoHost').hidden ? ''
            : document.getElementById('lpInfoHost').textContent,
      desc: document.getElementById('lpInfoDesc').hidden ? ''
            : document.getElementById('lpInfoDesc').textContent,
      note: document.getElementById('lpInfoNote').hidden ? ''
            : document.getElementById('lpInfoNote').textContent,
      links: [].slice.call(document.querySelectorAll('#lpInfoLinks a')).map(function(a){ return a.href; }),
      // A long description has to scroll INSIDE the body. If it grows the dialog
      // instead, the prose spills past the panel's edge — visible only as
      // "panelScrolls", which is why both numbers are here.
      bodyScrolls: body.scrollHeight - body.clientHeight > 8,
      panelScrolls: panel.scrollHeight - panel.clientHeight > 1,
      descBottomInside: Math.round(
        panel.getBoundingClientRect().bottom -
        document.getElementById('lpInfoDesc').getBoundingClientRect().top),
      // what a tap aimed at the play button would actually reach
      overToggle: overToggle ? (overToggle.tagName + '#' + overToggle.id) : 'none',
      toggleReachable: !!(overToggle && (overToggle === toggle || toggle.contains(overToggle))),
      playerOpen: document.getElementById('livePlayer').classList.contains('show'),
      focused: (document.activeElement || {}).id || '',
      liveAudios: [].slice.call(document.querySelectorAll('audio'))
                    .filter(function(e){ return e.id !== 'mainAudio'; }).length
    };
  `;

  // ---- 1. The artwork is the control, and says so on hover ----------------
  console.log('\n1. the artwork is the control, and names itself on hover');
  await load();
  await openPlayer();
  await requireClock('desktop');
  let s = await p.eval(SNAP);
  ok('live player opened', s.playerOpen === true);
  ok('the artwork is painted and square', s.artOnScreen && s.artSquare === true,
    JSON.stringify(s.artRect));
  ok('the artwork is a live control', s.artIsControl === true);
  ok('nothing covers it', s.artHittable === true, s.overArt);
  ok('the panel is not up until it is asked for', s.panelOnScreen === false);
  // The whole point of dropping the corner badge: nothing extra sits on the art
  // at rest. So the hint must be invisible until a pointer arrives, and visible
  // the moment one does — both halves measured, not just the one that is easy.
  await hover(null);
  s = await p.eval(SNAP);
  ok('no hint on the artwork at rest', s.hintVisible === false, s.hintOpacity);
  await hover('#lpInfoBtn');
  s = await p.eval(SNAP);
  ok('hovering the artwork shows the hint', s.hintVisible === true, s.hintOpacity);
  ok('the hint says what it does', s.hintText === 'Show info', s.hintText);
  ok('the hint sits inside the artwork', s.hintInArt === true);
  await hover(null);
  ok('and it goes away when the pointer does',
    (await p.eval(SNAP)).hintVisible === false);

  // ---- 2. Tapping it shows the show's prose and links ---------------------
  console.log('\n2. tapping the artwork opens the description and links');
  await openPanel();     // p.click hit-tests first, so this is also a real target
  s = await p.eval(SNAP);
  ok('panel is on screen, fully inside the viewport', s.panelOnScreen === true);
  ok('it names the on-air show', s.title === NAME, s.title);
  ok('it names the host', s.host === 'with ' + DJ, s.host);
  ok('the description reached the screen',
    s.desc.indexOf('exists only inside this test suite') !== -1, s.desc.slice(0, 60));
  ok('no "nothing yet" note while there is prose', s.note === '', s.note);
  ok('the show website is a link', s.links.indexOf(SITE) !== -1, JSON.stringify(s.links));
  ok('Facebook is a link', s.links.indexOf(FB) !== -1, JSON.stringify(s.links));
  ok('focus moved into the panel', s.focused === 'lpInfoClose', s.focused);
  ok('a long description scrolls inside the body', s.bodyScrolls === true);
  ok('…and does not grow the panel around it', s.panelScrolls === false);
  ok('the description starts inside the panel', s.descBottomInside > 0, String(s.descBottomInside));

  // ---- 3. The player behind it is unreachable ----------------------------
  // The panel is centred over the card, so it is the panel itself that covers
  // Play — and either way, a tap aimed there must not start the stream.
  console.log('\n3. the player behind the panel is out of reach');
  ok('a tap aimed at Play does not reach it', s.toggleReachable === false, s.overToggle);
  const target = await p.eval(`
    var r = document.getElementById('lpToggle').getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };`);
  await clickAt(target.x, target.y);
  s = await p.eval(SNAP);
  ok('so the stream never started', s.liveAudios === 0, String(s.liveAudios));
  ok('the player is still open behind the panel', s.playerOpen === true);

  // The backdrop is the pointer's way out: a tap clear of the panel closes it
  // and hands focus back to the badge it came from.
  console.log('\n3b. a tap on the backdrop closes the panel');
  await clickAt(20, 20);
  s = await p.eval(SNAP);
  ok('panel closed', s.panelOnScreen === false);
  ok('the player is still open', s.playerOpen === true);
  ok('focus returned to the artwork', s.focused === 'lpInfoBtn', s.focused);
  // SELF-TEST for the absence above: the same probe must report Play as reachable
  // now that nothing is over it. An "unreachable" assertion that cannot see
  // "reachable" is indistinguishable from a blind one.
  ok('SELF-TEST: the probe reports Play as reachable once the panel is closed',
    s.toggleReachable === true, s.overToggle);

  // ---- 4. Not a control when there is nothing behind it -------------------
  console.log('\n4. the artwork is only a control when there is something to show');
  now = { name: 'Zzq Unknown Broadcast', dj: '', altid: 'zzq_unknown', start: '', end: '' };
  harvest = {};                 // the harvest has never met this show
  detail = null;                // and archive2 has no record of it either
  await load();
  await openPlayer();
  s = await p.eval(SNAP);
  ok('player opened', s.playerOpen === true);
  ok('the artwork is still there', s.artOnScreen === true);
  ok('but it is not a control', s.artIsControl === false);
  await hover('#lpInfoBtn');
  s = await p.eval(SNAP);
  ok('hovering it promises nothing', s.hintVisible === false, s.hintOpacity);
  // The effect, not just the attribute: a real click must open nothing.
  await p.eval(`var r = document.getElementById('lpInfoBtn').getBoundingClientRect();
                window.__c = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
                return 1;`);
  const dead = await p.eval('return window.__c;');
  await clickAt(dead.x, dead.y);
  ok('and tapping it opens nothing', (await p.eval(SNAP)).panelOnScreen === false);

  // ---- 5. …and it becomes one when the per-show lookup finds prose --------
  // Same empty harvest; archive2 answers this time. Nothing else changes, which
  // is what makes this a test of the lazy fill rather than of the first paint.
  console.log('\n5. a description fetched per-show makes the artwork tappable');
  detail = { name: 'Zzq Unknown Broadcast', desc: 'Harvested on demand, not at boot.' };
  await load();
  await openPlayer();
  s = await p.eval(SNAP);
  ok('the artwork became a control after the lookup landed', s.artIsControl === true);
  await openPanel();
  s = await p.eval(SNAP);
  ok('the panel shows the description that arrived late',
    s.desc === 'Harvested on demand, not at boot.', s.desc);

  // ---- 6. A schedule rollover repaints an open panel ----------------------
  // The poll is every 15s. Worth the wait: a panel that keeps describing the
  // previous programme while the card has already moved on is worse than no
  // panel. Both shows are in the harvest the page loads with, because the bulk
  // /api/showinfo poll only comes round every two minutes — a fixture that
  // pretends the client can learn about a new show mid-test tests the fixture.
  console.log('\n6. the panel follows the schedule while it is open (15s poll)');
  const SECOND = { name: 'The Following Programme', dj: 'Grace Hopper',
                   desc: 'The programme that comes after the test transmission.' };
  harvest = {
    [ALTID]: { name: NAME, dj: DJ, desc: DESC, url: SITE, facebook: FB },
    second_show: SECOND
  };
  now = { name: NAME, dj: DJ, altid: ALTID, start: '11:00 AM', end: '12:00 PM' };
  detail = null;
  await load();
  await openPlayer();
  await openPanel();
  s = await p.eval(SNAP);
  ok('panel opens on the show that is on air', s.title === NAME, s.title);
  now = { name: SECOND.name, dj: SECOND.dj, altid: 'second_show', start: '12:00 PM', end: '1:00 PM' };
  await sleep(17000);
  s = await p.eval(SNAP);
  ok('the panel is still up', s.panelOnScreen === true);
  ok('the title followed the rollover', s.title === SECOND.name, s.title);
  ok('the description followed it too', s.desc === SECOND.desc, s.desc);
  ok('the previous show’s links went with it', s.links.length === 0, JSON.stringify(s.links));

  // ---- 7. Phone: a bottom sheet whose own body scrolls -------------------
  console.log('\n7. on a phone it is a bottom sheet, and the page stays put');
  now = { name: NAME, dj: DJ, altid: ALTID, start: '11:00 AM', end: '12:00 PM' };
  await load({ w: 390, h: 780 });
  await openPlayer();
  if (await requireClock('phone')) {
    s = await p.eval(SNAP);
    ok('the artwork is reachable on a phone too', s.artHittable === true,
      JSON.stringify({ art: s.artRect, vp: s.vp, at: s.overArt }));
    // No hover on a touch screen: the tile stays clean and tapping is the way in.
    ok('no hint is shown where there is no pointer', s.hintVisible === false, s.hintOpacity);
    await openPanel();
    s = await p.eval(SNAP);
    ok('panel is on screen', s.panelOnScreen === true);
    ok('it is flush with the bottom edge', Math.abs(s.panelBottom) <= 1, String(s.panelBottom));
    ok('a long description scrolls inside the panel, not the page',
      s.bodyScrolls === true && s.panelScrolls === false,
      JSON.stringify({ body: s.bodyScrolls, panel: s.panelScrolls }));
    ok('the page itself does not move under a real drag', (await p.pageScrolls()) === false,
      JSON.stringify(p.lastScrollAt));
    // SELF-TEST for that absence: the same sweep must find movement with nothing
    // open, or it proves nothing about the lock.
    await load({ w: 390, h: 780 });
    ok('SELF-TEST: the same sweep does move an unlocked page', (await p.pageScrolls()) === true);
  }

  // ---- 8. Escape closes the panel only ------------------------------------
  // ⚠️ LAST SECTION ON PURPOSE. See the ordering constraint at the top of this
  // file: after this, nothing navigated in this browser renders another frame.
  console.log('\n8. Escape closes the panel, not the player');
  await load();
  await openPlayer();
  await openPanel();
  ok('panel is up', (await p.eval(SNAP)).panelOnScreen === true);
  await pressEscape();
  s = await p.eval(SNAP);
  ok('Escape closed the panel', s.panelOnScreen === false);
  ok('the live player survived the same Escape', s.playerOpen === true);
  ok('focus went back to the artwork', s.focused === 'lpInfoBtn', s.focused);
  await pressEscape();
  ok('a second Escape does close the player',
    (await p.eval(SNAP)).playerOpen === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

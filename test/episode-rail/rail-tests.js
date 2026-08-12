// Show modal / past-episodes route regression, against the real local app.
//
// This suite kept its historical directory name so existing test commands keep
// working. The old expanding rail was replaced by one modal with two internal
// views and a persistent player dock. These are the contracts that matter now:
//   1. the show profile always opens first and names the exact broadcast;
//   2. Past episodes replaces the profile instead of growing beneath it;
//   3. row selection does not play, while the explicit play icon does;
//   4. listening history is legible without color alone;
//   5. the modal player survives browsing and never covers the archive list.
const { connect, sleep } = require('../live-stream/cdp.js');

// Defaults to local development; BASE=https://… runs the identical read/interaction
// audit against a deployed build. Browser state is isolated in the suite's
// temporary Chrome profile, so listening-history fixtures never touch a user's.
const BASE = process.env.BASE || 'http://localhost:8080';
let fails = 0, checks = 0;
function check(ok, msg, extra) {
  checks++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + msg +
    (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (!ok) fails++;
}

function durationSec(row) {
  const m = /(?:(\d+):)?(\d+):(\d+)/.exec(row.length || '');
  return m ? +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : 3600;
}

async function fixtures() {
  const data = await (await fetch(BASE + '/api/archive')).json();
  const rows = (data.shows || []).filter(r => r.mp3);
  const grouped = {};
  for (const row of rows) (grouped[String(row.sho).toLowerCase()] ||= []).push(row);
  const groups = Object.values(grouped)
    .map(g => g.sort((a, b) => (b.dt || 0) - (a.dt || 0)));
  return {
    many: groups.slice().sort((a, b) => b.length - a.length)[0],
    few: groups.find(g => g.length >= 2 && g.length <= 5),
    one: groups.find(g => g.length === 1)
  };
}

async function open(p, id) {
  await p.send('Page.navigate', { url: BASE + '/?show=' + encodeURIComponent(id) });
  await sleep(1200);
}

const READ_PROFILE = `
  var sheet = document.getElementById('showSheet');
  var play = sheet.querySelector('.sheet-play');
  var date = sheet.querySelector('.sheet-selected-date');
  var archive = sheet.querySelector('.sheet-archive-open');
  var archivePrimary = sheet.querySelector('.sheet-archive-primary');
  var archiveCount = sheet.querySelector('.sheet-archive-count');
  var archiveArrow = sheet.querySelector('.sheet-archive-arrow');
  var archiveHistory = sheet.querySelector('.sheet-archive-history');
  var dock = document.getElementById('sheetPlayerDock');
  var cue = document.getElementById('sheetScrollCue');
  var sr = sheet.getBoundingClientRect();
  var pr = play && play.getBoundingClientRect();
  var sel = sheet.querySelector('.sheet-selected');
  var selr = sel && sel.getBoundingClientRect();
  var ar = archive && archive.getBoundingClientRect();
  var apr = archivePrimary && archivePrimary.getBoundingClientRect();
  var identityEnd = sheet.querySelector('.sheet-host') || document.getElementById('sheetTitle');
  var ier = identityEnd && identityEnd.getBoundingClientRect();
  return {
    open: sheet.classList.contains('show'),
    profile: !sheet.classList.contains('archive-view'),
    title: (document.getElementById('sheetTitle') || {}).textContent || '',
    date: date ? date.textContent : '',
    playLabel: (sheet.querySelector('.play-label') || {}).textContent || '',
    playAria: play ? play.getAttribute('aria-label') : '',
    playHidden: play ? play.hidden : true,
    playAlternate: play ? play.classList.contains('is-alternate') : false,
    playInset: pr && selr ? Math.round(pr.left - selr.left) : -1,
    archive: !!archive,
    archiveCompact: !!archivePrimary,
    archiveCenterDelta: ar && apr
      ? Math.round(Math.abs((ar.left + ar.width/2) - (apr.left + apr.width/2)))
      : -1,
    archiveIsPill: ar ? ar.width < sr.width * .85 : false,
    archiveUnderIdentity: ar && ier ? ar.top >= ier.bottom : false,
    archiveArrowGap: archiveCount && archiveArrow
      ? Math.round(archiveArrow.getBoundingClientRect().left - archiveCount.getBoundingClientRect().right)
      : -1,
    archiveSummary: archiveHistory && !archiveHistory.hidden
      ? archiveHistory.textContent.trim().replace(/\\s+/g, ' ') : '',
    count: archive ? +(archive.querySelector('.sheet-archive-count') || {}).textContent : 0,
    dockHidden: dock.hidden,
    playVisible: !!pr && pr.top >= sr.top && pr.bottom <= sr.bottom,
    selectedStatus: (document.getElementById('sheetSelectedListenText') || {}).textContent || '',
    selectedStatusHidden: (document.getElementById('sheetSelectedListen') || {}).hidden,
    cueVisible: !!cue && !cue.hidden,
    cueLabel: cue ? cue.textContent.trim().replace(/\\s+/g, ' ') : '',
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
  };
`;

const READ_ARCHIVE = `
  var sheet = document.getElementById('showSheet');
  var body = document.getElementById('sheetBody');
  var dock = document.getElementById('sheetPlayerDock');
  var br = body.getBoundingClientRect(), dr = dock.getBoundingClientRect();
  var rows = Array.from(sheet.querySelectorAll('.sheet-episode'));
  var accentProbe = document.createElement('i');
  accentProbe.style.color = 'var(--accent)'; document.body.appendChild(accentProbe);
  var accent = getComputedStyle(accentProbe).color; accentProbe.remove();
  var firstPlay = sheet.querySelector('.sheet-episode-play');
  var toggle = document.getElementById('sheetPlayerToggle');
  var back = document.getElementById('sheetRouteBack');
  var backArrow = back.querySelector('svg');
  var inkProbe = document.createElement('i');
  inkProbe.style.color = 'var(--ink)'; document.body.appendChild(inkProbe);
  var ink = getComputedStyle(inkProbe).color; inkProbe.remove();
  return {
    archive: sheet.classList.contains('archive-view'),
    routebar: !document.getElementById('sheetRoutebar').hidden,
    rows: rows.length,
    footEmpty: document.getElementById('sheetFoot').childElementCount === 0,
    statuses: rows.map(r => (r.querySelector('.sheet-episode-status') || {}).textContent || ''),
    openLabels: rows.map(r => (r.querySelector('.sheet-episode-open') || {}).getAttribute('aria-label') || ''),
    visibleStatuses: rows.filter(r => {
      var s = r.querySelector('.sheet-episode-status'); return s && !s.hidden;
    }).map(r => r.querySelector('.sheet-episode-status').textContent),
    bars: rows.filter(r => {
      var b = r.querySelector('.sheet-episode-progress'); return b && !b.hidden;
    }).length,
    dockHidden: dock.hidden,
    bodyClearsDock: dock.hidden || br.bottom <= dr.top + 1,
    audio: document.getElementById('mainAudio').getAttribute('src') || '',
    playerId: document.getElementById('sheetPlayerOpen').dataset.id || '',
    playerArt: (document.getElementById('sheetPlayerArt') || {}).getAttribute('src') || '',
    playerState: (document.getElementById('sheetPlayerState') || {}).textContent || '',
    dockPlaying: dock.classList.contains('is-playing'),
    toggleOrange: getComputedStyle(toggle).backgroundColor === accent,
    rowActionOrange: firstPlay ? getComputedStyle(firstPlay).color === accent : false,
    backArrowBright: getComputedStyle(backArrow).color === ink,
    colors: [accent, getComputedStyle(toggle).backgroundColor,
      firstPlay ? getComputedStyle(firstPlay).color : 'none'],
    backTarget: (function(){
      var r = document.getElementById('sheetRouteBack').getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    })(),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
  };
`;

(async () => {
  const fx = await fixtures();
  if (!fx.many || !fx.few) throw new Error('listing has no multi-episode fixture');
  console.log('fixtures: many=' + fx.many[0].sho + '(' + fx.many.length + ')' +
    ' few=' + fx.few[0].sho + '(' + fx.few.length + ')' +
    ' one=' + (fx.one ? fx.one[0].sho : 'none'));

  const p = await connect(9224);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  for (const view of [
    { name: 'desktop', width: 1280, height: 900, mobile: false },
    { name: 'phone', width: 390, height: 844, mobile: true }
  ]) {
    console.log('\n#### ' + view.name);
    await p.send('Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, deviceScaleFactor: 2, mobile: view.mobile
    });

    await open(p, fx.many[0].id);
    let s = await p.eval(READ_PROFILE);
    check(s.open && s.profile, 'a card/deep link opens the restored Show view first');
    check(s.title === fx.many[0].title, 'the profile preserves the show identity', s.title);
    check(s.date && /\w/.test(s.date), 'the selected broadcast date is visible');
    check(/^(Play|Resume|Pause|Loading) · \w+ \d+/.test(s.playLabel),
      'the primary action always names its episode date', s.playLabel);
    check(s.archive && s.count === fx.many.length,
      'one Past episodes row reports the whole archive', [s.count, fx.many.length]);
    check(s.archiveCompact && s.archiveArrowGap >= 0 && s.archiveArrowGap <= 10,
      'Past episodes label, count and chevron read as one compact route', s.archiveArrowGap);
    check(s.archiveCenterDelta <= 1 && s.archiveIsPill && s.archiveUnderIdentity,
      'the muted Past episodes route is a compact pill under show identity',
      [s.archiveCenterDelta, s.archiveIsPill, s.archiveUnderIdentity]);
    check(s.dockHidden, 'the player dock is absent before audio is loaded');
    check(!s.playAlternate, 'without loaded audio the selected broadcast keeps the primary treatment');
    check(s.playAria.includes(s.playLabel.replace(' · ', ' ')),
      'the primary action accessible name includes the episode date', s.playAria);
    check(s.playVisible, 'the dated primary action is inside the visible modal');
    if (view.mobile) check(s.playInset >= 0 && s.playInset <= 2,
      'the selected broadcast action aligns to the left on phones', s.playInset);
    check(!s.sideways, 'the profile does not create horizontal page scroll');

    await p.clickInPlace('.sheet-archive-open');
    await sleep(150);
    s = await p.eval(READ_ARCHIVE);
    check(s.archive && s.routebar, 'Past episodes replaces the profile and gets a real Back header');
    check(s.backArrowBright, 'the archive Back chevron has a bright, visible exit cue');
    check(s.rows === fx.many.length, 'the archive view contains every episode', [s.rows, fx.many.length]);
    check(s.footEmpty, 'the archive does not grow the profile footer');
    check(s.bodyClearsDock, 'the scroll body reserves the dock region');
    check(!s.sideways, 'the archive view does not create horizontal page scroll');
    if (view.mobile) check(s.backTarget[0] >= 44 && s.backTarget[1] >= 44,
      'the internal Back control keeps a full phone tap target', s.backTarget);

    await p.clickInPlace('.sheet-route-back');
    await sleep(100);
    s = await p.eval(READ_PROFILE);
    check(s.profile, 'Back restores Show view without closing the modal');

    // A row is details/selection, not playback.
    await p.clickInPlace('.sheet-archive-open');
    await p.clickInPlace('.sheet-episode:nth-child(2) .sheet-episode-open');
    await sleep(100);
    s = await p.eval(READ_PROFILE);
    check(s.profile, 'an episode row returns to the selected broadcast profile');
    check(s.dockHidden, 'selecting an episode does not start audio');
    check(/ · \w+ \d+/.test(s.playLabel), 'the newly selected date is named by Play', s.playLabel);

    // Keep the phone loop cheap; one trusted autoplay/transport pass is enough.
    if (view.name === 'desktop') {
      await p.clickInPlace('.sheet-archive-open');
      await p.clickInPlace('.sheet-episode:first-child .sheet-episode-play');
      await sleep(450);
      s = await p.eval(READ_ARCHIVE);
      check(s.archive, 'explicit archive Play leaves the listener in the browser');
      check(!s.dockHidden, 'playback reveals the persistent in-modal dock');
      check(s.audio === fx.many[0].mp3, 'the explicit icon loads that episode', s.audio);
      check(s.playerId === String(fx.many[0].id), 'the dock identifies the audio, not browsing context');
      check(!!s.playerArt, 'the dock includes artwork for the audio actually loaded', s.playerArt);
      check(s.toggleOrange && s.rowActionOrange,
        'transport actions use the one persistent orange playback color', s.colors);
      check(s.dockPlaying === /^Playing/.test(s.playerState),
        'the teal equalizer state is active only while audio is playing', s.playerState);
      check(s.bodyClearsDock, 'the archive still ends above the visible player dock');
      check(/playing|loading/.test(s.openLabels[0]),
        'a changing playback state reaches the row accessible name', s.openLabels[0]);

      await p.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 2, mobile: true
      });
      const targets = await p.eval(`
        var a = document.getElementById('sheetPlayerToggle').getBoundingClientRect();
        var b = document.getElementById('sheetPlayerOpen').getBoundingClientRect();
        return [[Math.round(a.width),Math.round(a.height)],[Math.round(b.width),Math.round(b.height)]];
      `);
      check(targets.every(x => x[0] >= 44 && x[1] >= 44),
        'the in-modal player controls keep full phone tap targets', targets);
      await p.send('Emulation.setDeviceMetricsOverride', {
        width: view.width, height: view.height, deviceScaleFactor: 2, mobile: view.mobile
      });
      // Let the compositor settle after the phone target-size probe. A trusted
      // click dispatched in the same frame as the desktop reflow can land at
      // the old mobile coordinates even though the DOM hit-test has updated.
      await sleep(180);

      await p.clickInPlace('.sheet-episode[data-id="'+fx.many[1].id+'"] .sheet-episode-open');
      await sleep(180);
      s = await p.eval(READ_PROFILE);
      check(s.profile, 'browsing a different loaded-show date returns to its profile');
      check(!s.dockHidden, 'browsing another date cannot hide the active transport');
      check((await p.eval(`return document.getElementById('sheetPlayerOpen').dataset.id;`)) === String(fx.many[0].id),
        'the dock keeps naming the episode actually loaded');
      check(s.playAlternate && / instead$/.test(s.playLabel),
        'a browsed episode becomes a quieter replacement action while other audio is loaded', s.playLabel);

      await p.clickInPlace('.sheet-player-open');
      await sleep(100);
      s = await p.eval(READ_PROFILE);
      check(s.playHidden, 'when the selected episode is already loaded, the dock owns its transport');
    }
  }

  console.log('\n#### short phone overflow guide');
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 568, deviceScaleFactor: 2, mobile: true
  });
  await open(p, fx.many[0].id);
  let short = await p.eval(READ_PROFILE);
  const overflow = await p.eval(`
    var b=document.getElementById('sheetBody');
    var art=document.querySelector('.sheet-art').getBoundingClientRect();
    var cue=document.getElementById('sheetScrollCue').getBoundingClientRect();
    return {slack:b.scrollHeight-b.clientHeight, top:b.scrollTop,
      art:Math.round(art.height), cue:[Math.round(cue.width),Math.round(cue.height)]};
  `);
  check(overflow.slack > 4 && short.cueVisible && /More show information/.test(short.cueLabel),
    'a clipped short-phone profile has an explicit, truthful content guide', [overflow, short.cueLabel]);
  check(overflow.art <= Math.ceil(568 * .22) + 1,
    'short-phone artwork yields height to useful content', overflow.art);
  check(overflow.cue[0] >= 44 && overflow.cue[1] >= 44,
    'the short-phone content guide is a full touch target', overflow.cue);
  await p.eval(`
    var b=document.getElementById('sheetBody');
    b.scrollTop=b.scrollHeight; b.dispatchEvent(new Event('scroll')); return true;
  `);
  await sleep(50);
  short = await p.eval(READ_PROFILE);
  check(!short.cueVisible, 'the content guide leaves once there is nothing below the fold');

  console.log('\n#### listening memory');
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 2, mobile: false
  });
  await open(p, fx.many[1].id);
  const part = fx.many[1], done = fx.many[2];
  const d = durationSec(part), t = Math.max(45, Math.floor(d / 3));
  await p.eval(`
    localStorage.setItem('wbai-resume', ${JSON.stringify(JSON.stringify({
      [part.mp3]: { t, d, at: Date.now() },
      [done.mp3]: { t: 0, d: durationSec(done), at: Date.now(), done: 1 }
    }))});
    return true;
  `);
  await open(p, part.id);
  let s = await p.eval(READ_PROFILE);
  check(/^Resume · /.test(s.playLabel), 'partly heard selected episode offers Resume with its date', s.playLabel);
  check(/in progress/.test(s.archiveSummary) && s.archiveCenterDelta <= 1,
    'listening summary stays centered inside the single-line archive route', s.archiveSummary);
  check(/listened/.test(s.selectedStatus) && /left/.test(s.selectedStatus),
    'Show view explains elapsed and remaining listening time', s.selectedStatus);
  await p.clickInPlace('.sheet-archive-open');
  s = await p.eval(READ_ARCHIVE);
  check(s.visibleStatuses.some(x => /% listened/.test(x)), 'archive writes partial progress in words', s.visibleStatuses);
  check(s.visibleStatuses.includes('Played'), 'archive writes completion in words', s.visibleStatuses);
  check(s.bars >= 1, 'partial progress also has a visual bar');

  if (fx.one) {
    console.log('\n#### single episode');
    await open(p, fx.one[0].id);
    s = await p.eval(READ_PROFILE);
    check(s.profile && !s.archive, 'a one-episode show stays a clean profile with no dead archive route');
  }

  p.close();
  console.log(`\n${checks - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(err => {
  console.error(err.stack || err);
  process.exit(1);
});

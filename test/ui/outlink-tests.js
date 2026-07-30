// Outbound-link suite: on a touch device, leaving the app must leave a way back.
//
// Why this exists: every external link in the app — the sheet's Show website /
// Facebook / Twitter pills, the RSS badges, all ~18 links in the station menu —
// carries target="_blank". On a desktop that is right. On a phone it was a
// one-way door, reported from an iPhone in July 2026: tapping "Show website"
// opened a context with no history of its own, so its Back was dead, and the
// tab holding the app was no longer reachable from Chrome's tab button. The
// only way home was typing the URL. See app.js "Leaving for somewhere else".
//
// House rule (CLAUDE.md §3a): assert the EFFECT. Reading the `target` attribute
// would have passed happily throughout the bug — the attribute was never the
// question. So this dispatches a trusted click on a real link and then counts
// actual browser page targets, reads actual history depth, and actually goes
// back to see where it lands.
const { connect, sleep } = require('../live-stream/cdp.js');
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// Coarse pointer + no hover is the exact condition app.js branches on, so this
// is the emulation, not an approximation of it.
async function touchDevice(p, on) {
  // maxTouchPoints must stay >= 1 even while disabling — CDP rejects 0 outright
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: on ? 5 : 1 });
  await p.send('Emulation.setEmulatedMedia', {
    features: on
      ? [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
         { name: 'hover',   value: 'none'   }, { name: 'any-hover',   value: 'none'   }]
      : []
  });
}

async function pageTargets(p) {
  const t = await p.send('Target.getTargets');
  return t.targetInfos.filter(i => i.type === 'page' && !/^devtools:/.test(i.url)).length;
}

// Opens the station menu and clicks a real wbai.org link in it with a trusted
// mouse event. The menu is used rather than a show sheet because its links are
// present on every run — sheet links depend on whichever episodes the feed is
// currently serving and on that show having a website on file.
async function tapMenuLink(p) {
  await p.eval(`document.getElementById('menuBtn').click(); return 1;`);
  await sleep(700);
  const box = await p.eval(`
    var a = document.querySelector('#menuPanel a[target="_blank"][href^="https://wbai.org"]');
    if (!a) return null;
    var r = a.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: a.href };
  `);
  if (!box) return null;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await p.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    });
  }
  await sleep(2500);
  return box;
}

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Network.enable');
  // wbai.org is never actually fetched by a test. Blocking still lets the
  // navigation commit, which is the only part that matters here.
  await p.send('Network.setBlockedURLs', { urls: ['*://wbai.org/*', '*://*.wbai.org/*'] });

  console.log('1. touch device — leaving must leave a way back');
  await touchDevice(p, true);
  await p.send('Emulation.setDeviceMetricsOverride',
    { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2500);

  const coarse = await p.eval(`return matchMedia('(hover:none) and (pointer:coarse)').matches;`);
  ok('coarse-pointer emulation is live', coarse === true);

  const before = await pageTargets(p);
  const start = await p.eval(`return location.href;`);
  const link = await tapMenuLink(p);
  ok('found a visible external link in the menu', !!link, link && link.href);

  const after = await pageTargets(p);
  ok('no second tab was opened', after === before, before + ' -> ' + after + ' page targets');

  const landed = await p.eval(`return location.href;`);
  ok('this tab navigated to the external site',
    landed !== start && /wbai\.org/.test(landed), landed);

  const depth = await p.eval(`return history.length;`);
  ok('the app is behind it in history', depth >= 2, 'history.length=' + depth);

  // The whole point, stated the way a person experiences it: press Back, and
  // be in the app. Everything above is circumstantial next to this.
  const hist = await p.send('Page.getNavigationHistory');
  await p.send('Page.navigateToHistoryEntry', { entryId: hist.entries.slice(-2)[0].id });
  await sleep(2000);
  const home = await p.eval(`
    return location.host + '|' + (document.getElementById('menuBtn') ? 'app' : 'not-app');
  `);
  ok('Back returns to the app', home === 'localhost:8080|app', home);

  console.log('\n2. SELF-TEST — the probe can still see a second tab');
  // Section 1 rests on "no second tab was opened", and an assertion of absence
  // is worthless until it has been shown it can still report the thing it
  // denies. A fine pointer is exactly the case that must still open one, so it
  // doubles as the desktop regression check: this suite fails if the fix ever
  // leaks onto desktop, and equally if the counter goes blind.
  await touchDevice(p, false);
  await p.send('Emulation.clearDeviceMetricsOverride');
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2000);
  const fine = await p.eval(`return matchMedia('(hover:none) and (pointer:coarse)').matches;`);
  ok('emulation is off (fine pointer, as on a desktop)', fine === false);

  const dBefore = await pageTargets(p);
  const dStart = await p.eval(`return location.href;`);
  await tapMenuLink(p);
  const dAfter = await pageTargets(p);
  ok('desktop still opens a NEW tab (and the counter can see it)',
    dAfter === dBefore + 1, dBefore + ' -> ' + dAfter + ' page targets');
  ok('desktop keeps the app where it was',
    (await p.eval(`return location.href;`)) === dStart);

  // Close the tab that opened, and hand the browser back the way it was found —
  // run.sh shares one browser across suites, so leftover emulation or blocked
  // URLs would silently corrupt whatever runs next.
  const extra = (await p.send('Target.getTargets')).targetInfos
    .filter(i => i.type === 'page' && /wbai\.org/.test(i.url));
  for (const t of extra) await p.send('Target.closeTarget', { targetId: t.targetId });
  await p.send('Network.setBlockedURLs', { urls: [] });
  await touchDevice(p, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

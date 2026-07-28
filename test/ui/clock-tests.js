// Freshness label suite.
//
// Drives the REAL page against a real /api/archive payload whose newest row has
// been moved to a controlled offset, so every branch of the relative label is
// exercised end to end — parse, ingest, render — rather than by calling a copy
// of the function in isolation, which would prove only that the arithmetic is
// right and nothing about whether it reaches the screen.
const { connect, sleep } = require('../live-stream/cdp.js');
// 9224: live-stream owns 9222 and touch owns 9223. See run.sh.
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (d ? '  -> ' + d : ''))); };

(async () => {
  const real = await (await fetch('http://localhost:8080/api/archive')).json();
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/archive*' }] });

  // Rewrites the newest show to `offsetSecs` before now, and the server's scrape
  // stamp to `updatedAgoSecs` before now.
  let offsetSecs = 0, updatedAgoSecs = 120;
  p.on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const now = Date.now();
    const newest = Math.round(now / 1000) - offsetSecs;
    const shows = real.shows.map(r => ({ ...r }));
    const maxDt = shows.reduce((a, r) => Math.max(a, r.dt), 0);
    const shift = newest - maxDt;
    shows.forEach(r => { r.dt = r.dt + shift; });
    const body = m.params.request.url.includes('/head')
      ? { updated: now - updatedAgoSecs * 1000, count: shows.length, latest: newest }
      : { updated: now - updatedAgoSecs * 1000, count: shows.length, latest: newest, shows };
    await p.send('Fetch.fulfillRequest', {
      requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64')
    });
  });

  async function labelAt(secs, w = 390) {
    offsetSecs = secs;
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 700 });
    await p.send('Emulation.setTouchEmulationEnabled',
      w < 700 ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2000);
    return p.eval(`
      var c = document.getElementById('clock');
      return { short: c.querySelector('.clock-short').textContent,
               long: c.querySelector('.clock-long').textContent,
               title: c.title };`);
  }

  console.log('\n1. every branch of the relative label, end to end');
  const cases = [
    [30,          /just now$/,      'just now'],
    [12 * 60,     /12m ago$/,       '12m ago'],
    [3 * 3600,    /3h ago$/,        '3h ago'],
    [20 * 3600,   /20h ago$/,       '20h ago'],
    [26 * 3600,   /yesterday$/,     'yesterday'],
    [3 * 86400,   /3d ago$/,        '3d ago'],
    [20 * 86400,  /[A-Z][a-z]{2} \d+$/, 'a date'],
  ];
  for (const [secs, re, want] of cases) {
    const l = await labelAt(secs);
    ok(`${String(secs).padStart(8)}s ago -> ${want}`, re.test(l.short), l.short);
  }

  console.log('\n2. a fast client clock must not produce a future label');
  // The show timestamp comes from the server; the comparison uses the browser's
  // clock. A device running minutes fast would otherwise render "in 5 minutes".
  const skew = await labelAt(-300);
  ok('newest show 5 min in the "future" reads as just now',
    /just now$/.test(skew.short), skew.short);

  console.log('\n3. the two facts stay separate');
  offsetSecs = 3 * 3600; updatedAgoSecs = 120;
  let l = await labelAt(3 * 3600);
  ok('tooltip names the newest broadcast', /Newest broadcast: /.test(l.title), l.title);
  ok('tooltip reports when the server last checked',
    /Archive checked 2m ago/.test(l.title), JSON.stringify(l.title));
  ok('the strip itself shows the SHOW time, not the check time',
    /3h ago/.test(l.short) && !/2m ago/.test(l.short), l.short);

  // A quiet night (no new shows for hours) must not read as a broken feed:
  // "checked" stays recent while "latest show" ages.
  offsetSecs = 9 * 3600; updatedAgoSecs = 60;
  l = await labelAt(9 * 3600);
  ok('quiet night: show ages but the check stays fresh',
    /9h ago/.test(l.short) && /Archive checked 1m ago/.test(l.title),
    l.short + ' | ' + JSON.stringify(l.title));

  console.log('\n4. desktop shows the wall-clock time of the newest broadcast');
  l = await labelAt(3 * 3600, 1200);
  ok('long form carries a real time of day',
    /Latest show [A-Z][a-z]{2} \d+, \d{1,2}:\d{2} [AP]M$/.test(l.long), l.long);

  console.log('\n5. tapping the label swaps the two facts');
  // The "checked" figure used to live only in `title`, which a phone can never
  // reach — there is no hover. So the label is a button. Assert the RENDERED
  // text changes, not that a class or attribute flipped.
  offsetSecs = 3 * 3600; updatedAgoSecs = 120;
  await labelAt(3 * 3600);
  const rendered = () => p.eval(`
    var c = document.getElementById('clock');
    var L = c.querySelector('.clock-long'), S = c.querySelector('.clock-short');
    var r = c.getBoundingClientRect();
    return { text: getComputedStyle(L).display !== 'none' ? L.textContent : S.textContent,
             tag: c.tagName, disabled: c.disabled,
             h: Math.round(r.height),
             stripH: Math.round(document.querySelector('.result-meta').getBoundingClientRect().height) };`);

  const t0 = await rendered();
  ok('the label is a real button', t0.tag === 'BUTTON' && !t0.disabled, JSON.stringify(t0));
  ok('starts on the newest-show fact', /3h ago/.test(t0.text), t0.text);
  await p.clickInPlace('#clock'); await sleep(300);
  const t1 = await rendered();
  ok('one tap swaps to the checked fact', /2m ago/.test(t1.text) && !/3h ago/.test(t1.text), t1.text);
  await p.clickInPlace('#clock'); await sleep(300);
  const t2 = await rendered();
  ok('a second tap swaps back', t2.text === t0.text, `${t2.text} vs ${t0.text}`);

  ok('tap target is at least 44px', t0.h >= 44, 'h=' + t0.h);
  // ...and it must not have bought that by making the strip taller: the view
  // toggle already sets 52px, so 44 has to fit INSIDE the existing row.
  ok('and it cost the strip no height', t0.stripH <= 52, 'stripH=' + t0.stripH);

  console.log('\n6. SELF-TEST — the harness is really driving the label');
  // If interception silently stopped working, every case above would read the
  // live archive and could still pass by luck. Demand two different offsets
  // produce two different labels.
  const a = await labelAt(45 * 60);
  const b = await labelAt(5 * 3600);
  ok('different injected offsets produce different labels',
    a.short !== b.short, `${a.short} vs ${b.short}`);

  await p.send('Fetch.disable');
  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})();

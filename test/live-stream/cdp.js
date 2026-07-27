// Minimal Chrome DevTools Protocol client. Zero deps — needs
// `node --experimental-websocket` (Node 20).
let seq = 0;

async function connect(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = [];
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, bad } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? bad(new Error(m.error.message)) : ok(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  };
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++seq;
    pending.set(id, { ok, bad });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    on: fn => listeners.push(fn),
    close: () => ws.close(),
    // Evaluate in the page and return the JSON value.
    async eval(expr) {
      const r = await send('Runtime.evaluate', {
        expression: `(function(){ ${expr} })()`,
        returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error('page eval threw: ' + JSON.stringify(r.exceptionDetails.exception));
      }
      return r.result.value;
    },
    // A real, trusted click at the element's centre — this exercises the same
    // user-gesture path a person does, so autoplay rules apply as they really do.
    //
    // ⚠️ SIDE EFFECT: this SCROLLS THE PAGE to bring the target into view. A test
    // that measures scroll position around a click is therefore measuring this
    // helper, not the app — that cost real debugging time once (a phantom
    // "500 -> 163 jump on sheet open" that the app had nothing to do with).
    // If you care about scroll position, use clickInPlace() instead.
    async click(selector) { return doClick.call(this, selector, true); },

    // Same trusted click, but REFUSES to scroll: if the target isn't already in
    // the viewport it throws instead of silently moving the page. Use this
    // whenever the assertion involves scroll position — a loud failure beats a
    // quiet wrong number.
    async clickInPlace(selector) { return doClick.call(this, selector, false); },

    // Did a REAL user scroll gesture move the page? The only honest way to ask
    // whether the page is scroll-locked.
    //
    // ⚠️ Do NOT reach for the two obvious alternatives; both lie:
    //   - `getComputedStyle(body).overflow === 'hidden'` reports the style, not
    //     the effect. It read 'hidden' for months while all six overlays leaked,
    //     because overflow only propagates to the viewport from the ROOT unless
    //     the root's own overflow is `visible`. See touch-dev.md F7.
    //   - assigning `scrollTop` moves a CORRECTLY locked page every time.
    //     `overflow:hidden` blocks input scrolling, not programmatic scrolling.
    // Only synthesized input goes through the compositor path a finger uses.
    //
    // ⚠️ AND: one coordinate is not enough. Whether a drag reaches the document
    // depends entirely on what is under the finger — a point over a panel with
    // `overscroll-behavior:contain` never chains to the page, so it reports
    // "locked" over a wide-open one. Measured with the info sheet deliberately
    // UNLOCKED: (195,500) lands on .sheet-body and does not move the page;
    // (195,800) lands on the footer and moves it 300px. A single mid-screen
    // probe would have called that leak a pass.
    //
    // So sweep: top (scrim/appbar strip), middle, bottom (footer strip) and both
    // side gutters, and report movement if ANY of them moves the document. Short
    // -circuits on the first hit, so the unlocked case stays quick.
    // Restores the original offset, so it's safe to call mid-test.
    async pageScrolls({ distance = 300, settle = 400 } = {}) {
      const vp = await this.eval(`return { w: innerWidth, h: innerHeight };`);
      const points = [
        { x: Math.round(vp.w / 2), y: vp.h - 40 },   // footer strip
        { x: Math.round(vp.w / 2), y: 20 },          // top strip / scrim
        { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) },
        { x: 8, y: Math.round(vp.h / 2) },           // gutters, either side
        { x: vp.w - 8, y: Math.round(vp.h / 2) }
      ];
      for (const pt of points) {
        const before = await this.eval(`return document.scrollingElement.scrollTop;`);
        await send('Input.synthesizeScrollGesture', {
          x: pt.x, y: pt.y, xDistance: 0, yDistance: -distance,
          gestureSourceType: 'touch', speed: 2000, repeatCount: 0
        });
        await sleep(settle);
        const after = await this.eval(`return document.scrollingElement.scrollTop;`);
        await this.eval(`document.scrollingElement.scrollTop = ${before}; return 1;`);
        if (after !== before) { this.lastScrollAt = pt; return true; }
      }
      this.lastScrollAt = null;
      return false;
    }
  };

  async function doClick(selector, mayScroll) {
    // Hit-test after any scrolling: a trusted mouse event lands on whatever is
    // topmost at those coordinates, so clicking a control below its container's
    // fold would silently hit the scrim instead.
    const box = await this.eval(`
      var el = document.querySelector(${JSON.stringify(selector)});
      if(!el) return null;
      var se = document.scrollingElement, was = se.scrollTop;
      ${mayScroll ? `el.scrollIntoView({ block: 'center' });` : ``}
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      var top = document.elementFromPoint(cx, cy);
      return { x: cx, y: cy, w: r.width, h: r.height, scrolledBy: se.scrollTop - was,
               inView: r.top >= 0 && r.bottom <= innerHeight,
               hit: !!(top && (top === el || el.contains(top) || top.contains(el))),
               topEl: top ? (top.tagName + '#' + top.id) : 'none' };
    `);
    if (!box) throw new Error('no element: ' + selector);
    if (box.w === 0 || box.h === 0) throw new Error('element not visible: ' + selector);
    if (!mayScroll && !box.inView) {
      throw new Error(`clickInPlace: ${selector} is outside the viewport — clicking ` +
        `it would scroll the page and corrupt any scroll-position assertion. ` +
        `Scroll to it deliberately first, or use click() if you don't care.`);
    }
    if (!box.hit) throw new Error(`element covered: ${selector} — ${box.topEl} is on top`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
      });
    }
    return { scrolledBy: box.scrolledBy };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { connect, sleep };

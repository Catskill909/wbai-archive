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
    async click(selector) {
      // Scroll it into view first, then hit-test: a trusted mouse event lands on
      // whatever is topmost at those coordinates, so clicking a control that is
      // below its container's fold would silently hit the scrim instead.
      const box = await this.eval(`
        var el = document.querySelector(${JSON.stringify(selector)});
        if(!el) return null;
        el.scrollIntoView({ block: 'center' });
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width/2, cy = r.top + r.height/2;
        var top = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy, w: r.width, h: r.height,
                 hit: !!(top && (top === el || el.contains(top) || top.contains(el))),
                 topEl: top ? (top.tagName + '#' + top.id) : 'none' };
      `);
      if (!box) throw new Error('no element: ' + selector);
      if (box.w === 0 || box.h === 0) throw new Error('element not visible: ' + selector);
      if (!box.hit) throw new Error(`element covered: ${selector} — ${box.topEl} is on top`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
        });
      }
    }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { connect, sleep };

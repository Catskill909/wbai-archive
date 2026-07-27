# Live-stream regression suite

End-to-end tests for the live player, driving the **real, unmodified app** in
headless Chrome against a fake Icecast. Read
[docs/live-audio-pattern.md](../../docs/live-audio-pattern.md) for why the live
player is built the way it is; this is how you prove it still is.

## Run it

```sh
node server.js &          # the app must be up on :8080
cd test/live-stream
./setup.sh                # once — generates tone.mp3 + a self-signed cert
./run.sh                  # Chrome's default autoplay policy
./run.sh --strict         # user-gesture-required (worst case / iOS-like)
```

**Both must pass.** Last known good: 40/40 default, 39/39 strict (2026-07-26).
The strict run is not optional — the drift handover only fails under it, and
that run is the reason a bug was caught before shipping.

Needs macOS + Google Chrome, `ffmpeg` and `openssl` (setup only), and Node 20+.
No npm dependencies.

## How it works

- **`fakestream.js`** — a fake Icecast that is a *true live source*: one cursor
  advances in real time and every client is served from wherever it is **now**.
  No rewind, no per-client backlog. Because it physically cannot replay the past,
  "the client got bytes" is proof it reconnected live. It records a connection
  ledger (when each opened, where in the live timeline it joined, when it closed)
  — that ledger, not the app's own state, is what the assertions read.
  Control API on `:8091`: `/ctl/stall`, `/ctl/refuse`, `/ctl/reset`, `/ctl/stats`.
- **`cdp.js`** — a ~60-line DevTools Protocol client. Its `click()` scrolls into
  view and hit-tests with `elementFromPoint` before dispatching a *trusted*
  mouse event, so autoplay rules apply as they really do and a covered control
  fails loudly instead of silently clicking the thing on top of it.
- **`run-tests.js`** — the scenarios (S1–S8).

Chrome's resolver is pointed at the fake station with `--host-resolver-rules`,
so the app runs with its real URL, real CSP, and no test hooks compiled in.

## Scenarios

| | What it proves |
| --- | --- |
| S1 | A play opens exactly one connection, at the live edge |
| S2 | Stop closes the socket and discards the element |
| S3 | **The original bug** — play after a 25s idle joins the live edge 25s further on, rather than resuming a stale buffer |
| S4 | Archive playback tears the live stream down |
| S5 | An outside pause (OS interruption) is a stop — the next play reconnects |
| S6 | Rapid stop/play does not misreport `AbortError` as a stream failure |
| S7 | A 60s stall is measured as drift, and resolved — by handover under the default policy, by keeping the working connection under the strict one |
| S8 | A dead station shows the failure card, and Retry recovers |

## Gotchas

- **`--mute-audio` is mandatory.** Headless Chrome plays out of the real
  speakers. `run.sh` always passes it; if you invoke Chrome by hand, don't forget.
- The fake station serves **whole MPEG frames**. Chrome will not start on a
  mid-frame byte offset even though ffmpeg decodes it happily.
- Reset order matters: `about:blank` first, *then* `/ctl/reset`, then load the
  app — otherwise a connection left playing by the previous run shifts every count.
- `tone.mp3`, `cert.pem`, `key.pem`, `chrome-profile/` and the logs are generated
  and git-ignored. Never commit the key.

## When a test fails

The connection ledger printed at the end is usually the whole story — it shows
every connection the station saw, when it opened, and where in the live timeline
it joined. Two connections where you expected one means a stray reconnect; one
where you expected two means a resume, which is the original bug returning.
`stream.log` has the same events with timestamps and scenario markers.

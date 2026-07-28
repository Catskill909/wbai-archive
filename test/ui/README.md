# test/ui — UI behaviour suites

Drives the **unmodified** app in headless Chrome against the real server on
:8080. No fake station, no stubbed app code — the only thing ever faked is one
HTTP response (`clock-tests.js` intercepts `/api/archive` so it can control
timestamps).

```sh
node server.js &          # must be running on :8080
./run.sh                  # all three suites
./run.sh ui               # one of: ui | scroll | clock
```

113 assertions. Port **9224** — `test/live-stream` owns 9222, `test/touch` owns
9223.

## What each suite covers

| file | covers |
| --- | --- |
| `ui-tests.js` | theme switch (including the no-flash guarantee), hero copy clamp, the phone meta strip, page gutters, the app bar |
| `scroll-tests.js` | changing a filter/sort/view sends the list back to its first row — and the refresh pill still doesn't |
| `clock-tests.js` | the freshness label: every branch of the relative time, clock skew, and the tap-to-swap control |

## The rule these follow

**Assert the effect, not the declaration** (CLAUDE.md §3a). Concretely, in here
that means:

- Theme is checked by the **painted `background-color` of real elements**, never
  by whether `data-theme` is set.
- The hero clamp is checked by **measured line count**, because
  `-webkit-line-clamp` silently does nothing without `display:-webkit-box` — the
  rule can be present and the paragraph still run full height.
- Layout is checked by **`getBoundingClientRect()` edges**, so "the toggle lines
  up with the listing" is a comparison of two numbers rather than a claim about
  two padding values that happen to be spelled the same.
- The scroll reset is checked by **where the page lands and whether the first row
  is genuinely on screen** — "scrollY got smaller" would pass on a function that
  moved you anywhere at all.

### Self-tests

Every assertion of an *absence* is paired with one that forces the probe to
report a failure, because a suite full of "the page did NOT move" passes
perfectly once the measurement goes blind:

- `ui-tests.js` §5 strips `data-theme` and requires the colour probe to notice.
- `scroll-tests.js` §5 scrolls deep without touching a filter and requires
  `firstRowVisible()` to return **false**.
- `clock-tests.js` §6 demands two different injected offsets produce two
  different labels, so a silently broken interception fails loudly instead of
  passing on live data by luck.

### The no-flash proof

`ui-tests.js` §4 blocks `app.js` entirely and asserts the page is *still*
correctly themed. That is the only honest evidence the theme lands before the
first paint rather than after the bundle runs — `theme-boot.js` exists solely
for that, and if the work ever migrates back into `app.js` this is what catches
it.

## Notes for whoever touches this next

- The profile directory is `ui-profile`, deliberately **without** the substring
  `chrome-profile` in it: `test/live-stream`'s cleanup runs
  `pkill -f "chrome-profile"`, which matches by substring and would kill this
  browser mid-run.
- `run.sh` routes suite output through a temp file rather than a pipe. In POSIX
  `sh` a pipeline's status is the *last* command's, so `node … | grep … || rc=1`
  reports grep's success and swallows every real failure.
- Some suites write to `localStorage` (theme choice, list/gallery preference).
  `run.sh` deletes the profile on every run, so suites never inherit each
  other's state — but if you run a file by hand against a long-lived browser,
  clear those keys first.

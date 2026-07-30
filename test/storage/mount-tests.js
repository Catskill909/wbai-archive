'use strict';

/**
 * probeMount() parser tests.
 *
 * Why these exist: the probe reads /proc/self/mountinfo, which does not exist on
 * macOS. Without a test the parser's first execution ever would be in production,
 * on the one deploy someone is relying on it to diagnose — the precise habit
 * CLAUDE.md §1 and §4 exist to stop. So the fixtures below are real mountinfo
 * lines and the parser is fed them directly.
 *
 * What this does NOT prove: that a Docker volume's mount source really looks
 * like `/var/lib/docker/volumes/<name>/_data` on every host and storage driver.
 * That is an assumption about the world, and no local test can settle it. It is
 * why `mounted`/`volume` are advisory and `instanceId` remains authoritative.
 *
 *   node test/storage/mount-tests.js
 */

const os = require('os');
const path = require('path');

// Requiring server.js runs its boot sequence (seed merge, instance marker), so
// point it at a throwaway directory first. Without this, running the tests
// writes into the repo's real data dir.
process.env.DATA_DIR = path.join(os.tmpdir(), 'wbai-mount-tests');

const { probeMount } = require('../../server.js');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A trimmed but structurally faithful mountinfo from inside a container.
const BASE = [
  '2076 1746 0:191 / / rw,relatime master:602 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
  '2077 2076 0:194 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
  '2078 2076 0:195 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
].join('\n');

const NAMED = BASE + '\n' +
  '2090 2076 259:1 /var/lib/docker/volumes/wbai-archive-data/_data /app/data rw,relatime master:1 - ext4 /dev/nvme0n1p1 rw';

const ANON = BASE + '\n' +
  '2090 2076 259:1 /var/lib/docker/volumes/' +
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' +
  '/_data /app/data rw,relatime master:1 - ext4 /dev/nvme0n1p1 rw';

const BIND = BASE + '\n' +
  '2090 2076 259:1 /srv/wbai/data /app/data rw,relatime master:1 - ext4 /dev/nvme0n1p1 rw';

// The failure this whole feature exists to catch, and the one a first deploy
// can now report on its own: nothing mounted at DATA_DIR at all.
check('no mount at /app/data',
  probeMount('/app/data', BASE),
  { mounted: false, volume: null, anonymousVolume: null });

check('named volume is recognised and not flagged',
  probeMount('/app/data', NAMED),
  { mounted: true, volume: 'wbai-archive-data', anonymousVolume: false });

check('64-hex anonymous volume is flagged',
  probeMount('/app/data', ANON),
  { mounted: true, volume: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', anonymousVolume: true });

check('bind mount counts as mounted, with no volume name to report',
  probeMount('/app/data', BIND),
  { mounted: true, volume: null, anonymousVolume: null });

// A parent directory being a mount point is not the same as DATA_DIR being one.
check('a mount at /app does not count as a mount at /app/data',
  probeMount('/app/data', BASE + '\n2090 2076 259:1 /var/lib/docker/volumes/x/_data /app rw - ext4 /dev/x rw'),
  { mounted: false, volume: null, anonymousVolume: null });

check('space in the mount point is unescaped before comparing',
  probeMount('/app/my data', BASE + '\n2090 2076 259:1 /var/lib/docker/volumes/v1/_data /app/my\\040data rw - ext4 /dev/x rw'),
  { mounted: true, volume: 'v1', anonymousVolume: false });

check('empty mountinfo means no matching mount — false, since we did read it',
  probeMount('/app/data', ''),
  { mounted: false, volume: null, anonymousVolume: null });

/* Unknown must stay distinguishable from absent. `null` means "I could not
 * look, ask the instance marker"; `false` means "this deployment is definitely
 * losing its data". Collapsing the two would raise a false alarm on every local
 * run — and worse, would train everyone to ignore the alarm that matters.
 *
 * Only assertable off Linux: on Linux there IS a /proc, so the unreadable case
 * cannot be reproduced by reading the real one. Skipped rather than faked, and
 * announced, because a silently-skipped test is how a suite ends up green and
 * blind (CLAUDE.md §3a). */
if (process.platform === 'linux') {
  console.log('skip  unreadable /proc yields null (needs a non-Linux host)');
} else {
  check('unreadable /proc yields null, not false',
    probeMount('/app/data'),
    { mounted: null, volume: null, anonymousVolume: null });
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);

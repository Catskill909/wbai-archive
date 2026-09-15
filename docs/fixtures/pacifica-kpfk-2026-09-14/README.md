# Pacifica KPFK public feed evidence — September 14, 2026

These are immutable audit samples, not runtime seed data. Do not serve them as a current live feed or overwrite them during implementation. Add a new dated folder for later captures.

## Provenance

- Base URL: `https://archive.kpfk.org/fe_feed/`.
- Downloaded September 14 at approximately 9:17–9:21 p.m. America/New_York (September 15 UTC).
- All eight filenames returned 200 with JSON in the original audit and were rechecked successfully later in the conversation.
- `catalog.headers.txt` belongs to `fe_catalog_kpfk.json`; other responses have `<filename>.headers` files. Header Date/Last-Modified provide source response times; files were not fetched as a single atomic generation.
- [manifest.json](manifest.json) records original file sizes, SHA-256 hashes and derived summary counts.
- The WPFW PHP configuration response is deliberately not included. Only public front-end JSON files are in this fixture set.
- Full conclusions and limitations: [audit](../../kpfk-json-migration-plan.md).

## Reproduce integrity and summary checks

Run from the repository root:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
p = Path('docs/fixtures/pacifica-kpfk-2026-09-14')
m = json.loads((p / 'manifest.json').read_text())
for entry in m['files']:
    body = (p / entry['file']).read_bytes()
    assert len(body) == entry['bytes'], entry['file']
    assert hashlib.sha256(body).hexdigest() == entry['sha256'], entry['file']
c = json.loads((p / 'fe_catalog_kpfk.json').read_text())
shows = [s for group in c['shows'].values() for s in group]
episodes = [e for group in c['episodes'].values()
            for show in group.values() for e in show.values()]
lookup = {(s['plistid'], s['altid']): s for s in shows}
active = {(e['plistid'], e['altid']) for e in episodes}
assert active <= lookup.keys()
summary = {
    'shows': len(shows),
    'episodes': len(episodes),
    'showsWithEpisodes': len(active),
    'showsWithoutEpisodes': len(shows) - len(active),
    'episodesBySource': {g: sum(len(v) for v in group.values())
                         for g, group in c['episodes'].items()},
    'typeDisagreements': sum(e['type'] != lookup[(e['plistid'], e['altid'])]['type']
                             for e in episodes),
    'maximumPublishedEntries': max(len(e['pub']) for e in episodes)
}
assert summary == m['summary']
print(json.dumps(summary, indent=2))
PY
```

This verifies evidence integrity and reproduces counts; it is not a test of an implemented adapter. Synthetic fixtures for collisions, DST, invalid feeds and outages still need to be added during Phase 2.

# KPFK archive-page comparison evidence

Captured September 14, 2026 (September 15 UTC). Source page: https://archive.kpfk.org/; JSON base: https://archive.kpfk.org/fe_feed/.

- `page-rows.json`: 1,743 recording rows extracted from `tr[name=show]` attributes and associated play buttons/date/duration/day cells; no embedded page configuration retained.
- `page.headers.txt`: page response headers.
- `fe_*.json` and corresponding headers: contemporaneous catalog and three index-listed schedule weeks.
- `show-classification.csv`: all 184 catalog show records, archive/catalog counts, schedule counts and latest dates. Classification is evidence of recordings/scheduling, not an editorial retirement judgment.
- `summary.json`: reconciliation counts, page-only nonzero recordings, JSON-only IDs and differing timestamps.
- `audio-probes.json`: eight one-byte requests, including six page-only nonzero recordings, one zero-duration page-only recording and one JSON-only Aware Show recording. Success does not prove whole-file playback.
- `manifest.json`: SHA-256 hashes and byte counts of the captured/generated evidence files (before this README).

The page and JSON were fetched separately; source generation times can differ. This fixture set supplements rather than replaces the earlier September 14 catalog audit.

See [the audit](../../kpfk/archive-page-audit.md). These files are comparison evidence, not runtime data and not a filter on the JSON episode list.

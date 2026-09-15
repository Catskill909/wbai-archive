# Archive-page and WBAI RSS comparison

Measured September 14, 2026 (September 15 UTC). This is an evidence audit, not an additional source-selection rule. **KPFK displays every episode in Pacifica JSON.** Page/RSS differences do not add, remove or limit KPFK episodes.

## 1. What WBAI actually does today

Reviewed `parseFeedXml()`, `fetchFeed()`, `mergeFeedItems()` and `applyFeeds()` in `server.js`, the public WBAI archive and nine current RSS files.

- The HTML archive discovers show slugs and supplies recording rows.
- Working RSS is a **show-level** eligibility check, not an episode-level cap. `applyFeeds()` explicitly retains older HTML recording rows that fall outside the RSS window for a show with a working feed.
- Matching feed items enrich page rows with episode description, duration and other details.
- `mergeFeedItems()` remembers previously seen RSS items. Fresh metadata wins by MP3 URL. This is legacy XML behavior; the JSON conversion does not need to recreate it.
- WBAI also has legacy fragment filtering and a feed-only synthesis safeguard. Neither is a rule to transplant into the complete KPFK JSON catalog.

Measured source counts:

| Source | Observation | Meaning |
| --- | --- | --- |
| [WBAI archive page](https://archive2.wbai.org/) | 929 dated rows across 135 show slugs | Published page records, not verified playable episode count or production app count |
| [Democracy Now RSS](https://archive2.wbai.org/xml/dn.xml) | 5 items | Page has 40 Democracy Now rows; RSS length is not archive depth |
| [Heavy Waits RSS](https://archive2.wbai.org/xml/heavywaits.xml) | 2 items | Feeds need not share one count |
| Eight of nine sampled RSS feeds | 5 items each | Snapshot evidence, not a global five/six-item rule |
| Local `data/feeds.json` | 128 held feeds, 953 accumulated items, per-feed counts 1–14 | Existing local accumulated store; not a fresh production measurement |

Other RSS samples: `allmixedup`, `awareshow`, `goodmorninnuevayor`, `housing`, `manrat`, `niteshift`, `ricksmithshow` under `https://archive2.wbai.org/xml/`. All returned 200 and five parsed items during this check. The measurements support the user's distinction between the limited RSS window and deeper recording availability.

## 2. KPFK page versus current JSON

Fetched [KPFK's archive page](https://archive.kpfk.org/) at HTTP Date `Tue, 15 Sep 2026 01:48:51 GMT`, then a contemporaneous catalog and three schedule weeks. Catalog `updated` was `1789436702`. They are separate publications, not a transactionally identical capture.

| Measure | HTML page | JSON catalog |
| --- | ---: | ---: |
| Recording entries | 1,743 | 1,143 |
| Shows with recording entries | 108 | 109 |
| Complete directory records | — | 184 |
| Shared recording IDs | 1,128 | 1,128 |
| Entries exclusive to this source | 615 | 15 |

The page's show dropdown has exactly the same 108 slugs as its dated rows. Dates span June 20–September 14, 2026, and rows are sorted by date descending. All 1,743 parsed rows have distinct IDs and distinct MP3 URLs. This confirms the page is a useful record of listed broadcasts; its whole directory is not the same as its archive selector.

The JSON per-show recording counts range from **1 to 69** in this sample. Democracy Now has 69; Background Briefing and the BradCast upload source have 42 each; Informativo Pacifica has 41. Display them all. The feed itself already provides different depths by show.

### What accounts for the 615 page-only entries?

- **609 show zero duration**, all dated July 21, distributed across four Something's Happening show IDs. One sampled zero-duration URL returned 404. Do not generalize that single check to every file.
- **Six show positive duration**, and all six returned `206 audio/mpeg` to a one-byte range request:

| Recording ID | Program | Page duration |
| --- | --- | --- |
| 139555 | Soundwaves | 34:29 |
| 139388 | Middle East In Focus | 15:13 |
| 138831 | LARB Radio Hour | 8:10 |
| 138747 | Working Voices | 44:30 |
| 138745 | Eco-Justice Radio | 0:08 |
| 138146 | Something's Happening B Hour 2 | 8:51 |

These are concrete observations worth reporting to the engineer, but **they are not additions to our JSON-driven archive**. The difference is not a migration blocker or a reason to add scraping back. Whether these represent split recordings or another publication rule remains unconfirmed. Range success is not a full playback test.

### What accounts for the 15 JSON-only entries?

All belong to `aware` (The Aware Show). That show also appears in the published schedule. A sampled JSON-only recording, ID 139483, returned `206 audio/mpeg`. Page intersection would incorrectly hide all 15 JSON episodes. Keep them.

For all 1,128 shared IDs, show slug, MP3 URL and duration agree. Six airDate values differ: the JSON uses round slot times while the page records offsets of seconds or minutes. This suggests normalization to scheduled starts, but the generator's intent is not established. Keep JSON timestamps for JSON episodes; do not repair them using HTML.

## 3. Are the 75 directory-only programs old?

The user's hypothesis is supported as a visibility distinction, but not proven as an editorial retirement date:

| Classification across catalog, archive page and three published weeks | Count | UI implication |
| --- | ---: | --- |
| Has JSON recordings | 109 | Available archive shows; all supplied episodes reachable |
| No recordings, but on published schedule | 2 | Schedule/profile information, without a fabricated episode |
| No recordings and absent from all sampled schedule weeks | 73 | Metadata only; do not promote as current archive programming |

The two scheduled exceptions are **`friedman` — Brad Friedman's BradCast** and **`latw` — LA Theater Works**. BradCast recordings also exist under the different upload ID `bradcast2`; that is a plausible association, not an automatic alias. Confirm aliases before linking a scheduled source to another source's recordings.

Examples of directory ambiguity: `expansizone` has no recordings while `ivmon` carries Expansion Zone recordings; upload `bibliocracya` has none while broadcast `bibliocracy` has recordings. Old IDs, alternate sources and renamed shows are possible explanations. Do not label every unused ID a defunct program or merge by title.

Keep all 184 show records for metadata lookup. Ordinary archive browsing is driven by episode records, not the directory size. Published schedule entries supply separate evidence of scheduled programming. A directory-only record may become useful later without requiring a code change or permanent blacklist.

## 4. Final migration rule

The user has explicitly settled availability: **follow Pacifica's JSON feed exactly for episode membership**. Music's two-week availability is controlled upstream. Talk programs can have five, six or many more entries; the app applies no independent cap or retention window. Do not infer availability from inconsistent `type` fields, `expires`, page membership, duration or a future date.

On a valid refresh, use all episodes in that catalog. On a failed refresh, retain labeled last-good data. Pagination is presentation, not a reduced catalog. The WBAI implementation provides useful examples of preserving archive depth, but KPFK does not need the old XML/page reconstruction rules.

## Evidence files and limits

[KPFK page comparison evidence](../fixtures/kpfk-page-2026-09-14/README.md) includes extracted page rows, fresh catalog/schedule samples, per-show classification CSV, exact discrepancy IDs, probes and checksums. Full page HTML remains a temporary audit download; only recording metadata was retained in the repository, excluding embedded page configuration.

No mass audio validation, legal interpretation, application changes or source-selection changes were performed. A displayed row does not prove full-file playability. Counts are time-specific observations. This audit does not claim 73 programs are definitively retired.

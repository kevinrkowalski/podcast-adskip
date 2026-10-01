# The Daily: why our app often has no ads

## Symptom
Playing [The Daily](https://feeds.simplecast.com/54nAGcIl) (NYT / Simplecast) in PodcastAdSkip **never** (or almost never) includes dynamically inserted ads, while Apple Podcasts / other clients on the **same phone** usually do.

## What we stream
Apple Podcasts lists feed `https://feeds.simplecast.com/Sl5CSM3S` (collection `1200361736`). That feed and `https://feeds.simplecast.com/54nAGcIl` are the same show; enclosure hosts are identical (`nyt.simplecastaudio.com` via Podtrac → pdst.fm → vpixl → Simplecast AIS).

Example enclosure (RSS attribute, **before** entity decode):

```text
https://dts.podtrac.com/redirect.mp3/.../default.mp3?aid=rss_feed&amp;awCollectionId=...&amp;awEpisodeId=...&amp;feed=54nAGcIl
```

iTunes Lookup `episodeUrl` for the same GUID is already decoded and uses `feed=Sl5CSM3S`.

## Root causes (evidence)

### 1. RSS parser left literal `&amp;` in enclosure URLs (fixed)
`apps/mobile/src/api/rss.ts` `attr()` returned raw XML attribute text. After the show screen merges RSS over the iTunes fast path (`mergeEpisodes(parsed.episodes, prev)`), the **RSS** enclosure wins for the same GUID.

Requesting the undecoded URL makes query separators into `aid=rss_feed&amp%3BawCollectionId=...`, so `awCollectionId` / `awEpisodeId` / `feed` are **not** distinct params. Simplecast AIS then cannot target inventory the same way known players do.

**Fix:** `decodeXmlEntities()` on attribute values and text nodes before storing `enclosureUrl`.

### 2. Dynamic Ad Insertion + client identity (partial mitigation)
Final CDN URLs include AIS markers, e.g. `x-ais-classified=download|streaming|unclassified` and a filename token decoding to `p_f_skip=…`. The same episode URL can yield different classified sessions by `User-Agent` / IP.

Playback used `expo-audio` `createAudioPlayer({ uri })` with **no** headers (platform default, often okhttp-like). Analysis downloads similarly sent empty headers.

From a datacenter IP, byte size matched across UAs for a sample episode (inventory/geo often serves a clean file to non-residential IPs). On a phone, other apps still get ads — consistent with UA/IP classification, not a wrong feed.

**Mitigation (careful):** send an IAB-style product User-Agent on stream + analysis download:
`PodcastAdSkip/1.0 (Linux; Android) expo-audio`
We do **not** spoof `Podcasts/…` / AppleCoreMedia. This may improve classification; it cannot invent ad inventory when the CDN serves a clean file for that IP.

### 3. Not the cause
- Wrong show: Apple `Sl5CSM3S` vs user `54nAGcIl` are alternate feed IDs for The Daily; content GUID/episode audio path match.
- Labeling model: unchanged; this is enclosure/request identity, not Whisper/LLM.

## Verification
1. Log `episode.enclosureUrl` after open — must contain `&awCollectionId=` not `&amp;awCollectionId=`.
2. Compare duration/size in our app vs Apple Podcasts on-device for the same episode.
3. If still ad-free on-device after (1), treat remaining gap as DAI/IP/UA policy and keep client-upload analysis aligned with whatever file playback actually received.

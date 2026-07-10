# Phase 1 API Verification Scripts — Hybrid Access

Manual `curl`/`jq` verification scripts for the two reader-facing endpoints
affected by the hybrid fileUrl/content package model. Written against the
`phase1-hybrid-safety-tools` branch (commit `e6d9cda`) as a companion to the
automated regression suite at `server/hybrid-access-regression.test.ts`.

**Golden rule these scripts exist to enforce:**

> `novels.episodes` is a **list/metadata endpoint only**. It must never
> return full episode `content` — not even to a user who purchased the
> episode. Full plaintext content is returned **only** by
> `reader.getEpisode`, and only when the requesting user actually has read
> access to that specific episode.

If any manual test below observes `novels.episodes` returning a non-empty
`content` string, that is a **P0 content-leak regression** — file it
immediately, it means every episode's full text is downloadable from a
single list call regardless of purchase status.

---

## 0. Setup

These endpoints are tRPC procedures mounted at `/api/trpc` with the
`superjson` transformer, so raw HTTP responses are wrapped as
`{"result":{"data":{"json": <actual payload>}}}`. All `jq` filters below
account for that wrapper — if you're inspecting the payload some other way
(browser devtools Network tab, tRPC panel, etc.) just look at the
already-unwrapped JSON object described in "Expected Output".

You need:
- A running dev/preview server (`pnpm dev` or the Manus preview URL).
- A valid session cookie for two test accounts: one that has **purchased**
  at least one episode with plaintext `content`, one with a **legacy
  `fileUrl`-only** episode, and one **unpurchased** account. (See
  `server/hybrid-access-regression.test.ts` Cases A–D for how these
  fixtures are constructed if you need to seed them.)
- `curl` and `jq`.

```bash
BASE_URL="http://localhost:3000"   # or your Manus preview URL
COOKIE="<paste session cookie here>"
NOVEL_ID=123
EPISODE_ID=12345
```

---

## 1. API Verification Script 1: `novels.episodes` Endpoint

### Purpose

Confirm the episode list endpoint returns entitlement **metadata** only —
`hasContent` / `hasLegacyFile` / `canRead` / `hasPurchased` flags, and a
`fileUrl` gated on purchase — and never leaks full `content`.

### Call

```bash
curl -s -G "$BASE_URL/api/trpc/novels.episodes" \
  -H "Cookie: $COOKIE" \
  --data-urlencode "input={\"json\":{\"novelId\":$NOVEL_ID}}" \
  | jq '.result.data.json'
```

### Expected Output — Purchased User

For an episode the logged-in user has purchased **and** that has plaintext
`content` in the database, the correct expected entry is:

```json
{
  "id": 12345,
  "episodeNumber": "1",
  "title": "Chapter 1",
  "hasContent": true,
  "hasLegacyFile": false,
  "canRead": true,
  "hasPurchased": true,
  "isPurchased": true,
  "saleMode": "chapter",
  "saleType": "chapter",
  "fileUrl": null,
  "content": null
}
```

> ❌ **Not** `"content": "HAS_CONTENT"` or any non-null `content` string.
> `hasContent: true` is how the frontend knows this episode is readable on
> the web — the actual text only ever comes from `reader.getEpisode`.

For an episode the user purchased that has a **legacy `fileUrl`** and no
web content:

```json
{
  "id": 22222,
  "episodeNumber": "51 - 100",
  "title": "Package 51-100",
  "hasContent": false,
  "hasLegacyFile": true,
  "canRead": true,
  "hasPurchased": true,
  "isPurchased": true,
  "saleMode": "package",
  "saleType": "package",
  "fileUrl": "https://docs.google.com/document/d/...",
  "content": null
}
```

`fileUrl` is the **only** field in this endpoint's response that may
contain real data gated purely on purchase status (never on `content`) —
and only because `hasLegacyFile` is also `true`. If `hasLegacyFile` is
`false`, `fileUrl` must be `null` regardless of purchase status.

### Expected Output — Unpurchased User

```json
{
  "id": 12345,
  "episodeNumber": "1",
  "title": "Chapter 1",
  "hasContent": true,
  "hasLegacyFile": false,
  "canRead": false,
  "hasPurchased": false,
  "isPurchased": false,
  "saleMode": "chapter",
  "saleType": "chapter",
  "fileUrl": null,
  "content": null
}
```

Note `hasContent`/`hasLegacyFile` still faithfully describe the episode's
data (they are not purchase-gated — they answer "does this episode have X",
not "can this user see X"). `fileUrl` and `content` are the two fields that
are always `null` here, since this user cannot read the episode.

### Critical Checks

- [ ] `hasContent` flag is `true` for episodes with plaintext content,
      `false` otherwise — for **every** user, purchased or not.
- [ ] `hasLegacyFile` flag is `true` for episodes with a legacy `fileUrl`,
      `false` otherwise — for **every** user, purchased or not.
- [ ] **Full `content` is NOT returned from `novels.episodes`** for any
      user, including a purchased one. The response either omits the
      `content` key entirely or sets it to `null`/`undefined`.
- [ ] `fileUrl` is non-null **only** when `canRead === true` **and**
      `hasLegacyFile === true`. Never non-null for an unpurchased user.
- [ ] Full content must only ever be returned from `reader.getEpisode` for
      authorized (purchased or free) users — verify with Script 2 below.

### curl/jq: content-leak check

Run this against the full episode list, for both a purchased and an
unpurchased user session:

```bash
curl -s -G "$BASE_URL/api/trpc/novels.episodes" \
  -H "Cookie: $COOKIE" \
  --data-urlencode "input={\"json\":{\"novelId\":$NOVEL_ID}}" \
  | jq '.result.data.json[] | {
      id,
      hasContent,
      contentLeaked: (.content != null and .content != "")
    }'
```

**Expected:** `contentLeaked` is `false` for **every** episode in the
array, regardless of `hasContent`, `canRead`, or purchase status.

Equivalent single-field check, if you just want to eyeball the raw value:

```bash
curl -s -G "$BASE_URL/api/trpc/novels.episodes" \
  -H "Cookie: $COOKIE" \
  --data-urlencode "input={\"json\":{\"novelId\":$NOVEL_ID}}" \
  | jq '.result.data.json[].content'
```

**Expected:** every line prints `null` (or the key is absent entirely if
you `jq '.result.data.json[] | select(has("content"))'` and get no output).

---

## 2. API Verification Script 2: `reader.getEpisode` Endpoint

### Purpose

Confirm this is the **only** endpoint that returns full plaintext `content`
or a real `fileUrl`, and only to a user with actual read access to that
specific episode.

### Call

```bash
curl -s -G "$BASE_URL/api/trpc/reader.getEpisode" \
  -H "Cookie: $COOKIE" \
  --data-urlencode "input={\"json\":{\"episodeId\":$EPISODE_ID}}" \
  | jq '.result.data.json'
```

### Expected Output — Purchased user, episode has plaintext content

```json
{
  "canRead": true,
  "content": "HAS_CONTENT",
  "episode": {
    "id": 12345,
    "hasContent": true,
    "hasLegacyFile": false,
    "fileUrl": null
  }
}
```

(`"content": "HAS_CONTENT"` here stands in for "the real plaintext string
is present and non-empty" — assert `content != null && content.length > 0`
in your actual check, don't literally match the string `"HAS_CONTENT"`.)

### Expected Output — Purchased user, episode has a legacy fileUrl

```json
{
  "canRead": true,
  "content": null,
  "episode": {
    "id": 22222,
    "hasContent": false,
    "hasLegacyFile": true,
    "fileUrl": "https://docs.google.com/document/d/..."
  }
}
```

`fileUrl` is visible here because the user has purchased the episode. This
is the one legitimate case where a real (non-null) `fileUrl` should appear
in an API response anywhere in the app.

### Expected Output — Unpurchased user

```json
{
  "canRead": false,
  "content": null,
  "episode": {
    "id": 12345,
    "hasContent": true,
    "hasLegacyFile": false,
    "fileUrl": null
  }
}
```

Both `content` and `episode.fileUrl` must be `null` — regardless of what
`hasContent`/`hasLegacyFile` say about the episode itself.

### Critical Checks (unchanged from prior verification passes)

- [ ] Purchased user + episode has content → `content` is present and
      non-empty.
- [ ] Purchased user + episode has a legacy `fileUrl` → `episode.fileUrl`
      is present (the real URL).
- [ ] Unpurchased user → `content` is `null` **and** `episode.fileUrl` is
      `null`, regardless of what the episode actually has.
- [ ] `canRead` accurately reflects purchase/free status for every case
      above.

These `reader.getEpisode` expectations were already correct in prior
verification passes and are **not changed** by this document — Script 1
above is the only endpoint whose expected behavior was previously
mis-documented.

---

## 3. Hybrid Access Test Matrix (cross-reference)

For the full automated version of the cases above (Cases A–E: legacy-file
only, plaintext-only, hybrid, unpurchased, and reading-progress
permissions), see `server/hybrid-access-regression.test.ts`. That suite
exercises both `novels.episodes` and `reader.getEpisode` via
`appRouter.createCaller()` against real DB fixtures and asserts exactly the
expected shapes documented above — treat it as the source of truth if this
document and the code ever disagree.

| Case | Episode has | User | `novels.episodes.content` | `reader.getEpisode.content` | `reader.getEpisode.episode.fileUrl` |
|---|---|---|---|---|---|
| A | fileUrl only | purchased | `null` | `null` | real URL |
| B | content only | purchased | `null` | real text | `null` |
| C | both | purchased | `null` | real text | real URL |
| D | either/both | **not** purchased | `null` | `null` | `null` |

The `novels.episodes.content` column is `null` in **every row** — that is
the one invariant this whole document exists to check.

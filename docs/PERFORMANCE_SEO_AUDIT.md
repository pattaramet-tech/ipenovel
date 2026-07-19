# Performance & SEO Audit — Step 1 (Quick Wins)

Date: 2026-07-19
Scope: audit + safe quick wins only. No refactor of pagination, no Redis, no
schema changes, no business/entitlement logic changes, no new DB indexes
(candidates listed below for a future migration).

No secrets appear anywhere in this document or in the diff for this change.

## Current architecture summary

- **Client**: Vite + React 19, client-side rendered only (no SSR/SSG
  framework). Routing via `wouter` (`client/src/App.tsx`). Data fetching via
  `@trpc/react-query` (`client/src/lib/trpc.ts`) on top of `@tanstack/react-query`
  with a single global `QueryClient` (`client/src/main.tsx`) that uses React
  Query's out-of-the-box defaults (`staleTime: 0`, `refetchOnWindowFocus: true`)
  unless a specific `useQuery` call overrides them.
- **Server**: Express (`server/_core/index.ts`) serving the tRPC API under
  `/api/trpc` and, in production, the built SPA as static files with an
  index.html fallback (`server/_core/vite.ts`). No SSR of the SPA's own
  routes — `/`, `/novels`, `/novels/:id`, etc. all resolve to the same
  `index.html` shell client-side.
- **DB**: MySQL via Drizzle ORM (`server/db.ts`, `drizzle/schema.ts`).
- **Media**: novel covers and banners are optimized to WebP and served from
  `https://media.ipenovel.com` (Cloudflare R2) — already migrated, this
  audit does not touch that pipeline.
- **Domain**: `https://ipenovel.com` is canonical; the legacy
  `ipenovelz.manus.space` host already 301-redirects there
  (`server/_core/canonicalDomainRedirect.ts`).

### Pages audited (route → render/data/images/queries/meta, before this change)

| Page | Route | Render | tRPC calls | Images | Waterfall/N+1 | Meta before |
|---|---|---|---|---|---|---|
| Home | `/` | CSR | `home.getSections` (1 call, `Promise.all` of 6 DB queries) | banner (1, eager) + up to ~20 novel/episode covers (lazy via `NovelCard`) | None | none |
| Novels listing | `/novels` | CSR | `novels.browse` + `wishlists.ids` (only if logged in) | up to 20 covers via `NovelCard` (lazy) | None (already optimized in a prior pass — `keepPreviousData`, lightweight `browse` query) | none |
| Novel detail | `/novels/:identifier` | CSR | `novels.detail` + `novels.episodes` (2 independent calls, not chained) + `cart.get` | 1 cover (was missing `loading`/`decoding`/CLS hints) | **`novels.detail` fetched a full `SELECT *` episode list via `getEpisodesByNovelId` that the page never reads** (see High-priority #1) | none |
| Reader | `/read/:episodeId` | CSR | `reader.getEpisode` (`protectedProcedure`, `enabled: !!user`) | none (text only) | None | none |
| My Novels | `/my-novels` | CSR | `myNovels.list` | covers via `SafeImage` (was missing `loading`/`decoding`) | **Real N+1**: 1 `getNovelById` + 1 `getEpisodeById` (full `SELECT *`, incl. `content`) per purchased episode, sequential in a `for` loop (see High-priority #2) | none |
| Admin Login | `/admin/login` | CSR | `admin.login` | none | None | none |
| Admin (all `/admin/*`) | via `AdminLayout` | CSR | varies per page (already paginated/lightweight from earlier work) | admin thumbnails via `SafeImage`/raw `<img>` in a few pages | Not audited page-by-page this round (see Low priority) | none |

## Findings

### High priority

1. **`novels.detail` fetched and shipped an entire novel's episode list
   (including every episode's full `content` column) that the frontend
   never reads.** `NovelDetailPage.tsx` calls `novels.detail` for the novel
   row and, *separately*, `novels.episodes` for the actual episode list
   (which also does purchase/entitlement enrichment `novels.detail` doesn't
   do). Grepping the whole client confirmed `novel.episodes` (the field
   `novels.detail` used to return) has zero readers. For a novel with
   hundreds of chapters, this meant every single public novel-detail page
   view pulled the full text of every chapter into a tRPC response and
   discarded it unread.
   **Fixed**: removed the unused `getEpisodesByNovelId` call and `episodes`
   field from `novels.detail` (`server/routers.ts`). Zero behavior change —
   confirmed via a full-repo grep that nothing consumed the field.
   **Risk of the fix**: none identified — it deletes dead data from a
   response, doesn't touch the episode list itself, purchases, or reader
   entitlement.

2. **Real N+1 query pattern in `myNovels.list`** (`/my-novels`, explicitly
   named in this audit's scope). For every row in the user's purchase
   history, the handler `await`ed a `getNovelById()` and a `getEpisodeById()`
   **inside a `for` loop**, sequentially — a user with 50 purchased episodes
   across 10 novels triggered 100 sequential DB round trips on every page
   load. `getEpisodeById` also does `SELECT *`, including the mediumtext
   `content` column, which `MyNovelsPage.tsx` never displays (confirmed by
   checking every `episode.*`/`novel.*` field the component actually reads:
   `id`, `episodeNumber`, `title` for episodes; `id`, `title`,
   `publicationStatus`, `storyStatus`, `coverImageUrl` for novels).
   **Fixed**: added `getNovelsByIdsLite`/`getEpisodesByIdsLite` batch
   lookups (`server/db.ts`, `inArray(...)`, lean column selects) and
   rewrote `myNovels.list` to fetch all referenced novels/episodes in 2
   queries total via `Promise.all`, then do the grouping in memory. Same
   grouping logic, same output shape (verified: when a referenced
   novel/episode row is missing, `Map.get()` returns `undefined` exactly
   like the old `getNovelById`/`getEpisodeById` did for a missing row, so
   `{...episode, purchasedAt: ...}` behaves identically either way).
   **Risk of the fix**: low — purely a data-fetching strategy change, same
   authorization (`protectedProcedure`, `ctx.user.id`-scoped `purchases`
   query untouched), same result shape, verified with the existing field
   usage above.

3. **No SEO metadata anywhere** (no `<title>` per page, no meta
   description, no canonical, no Open Graph, no structured data, no
   `robots.txt`, no `sitemap.xml`). For a public content site relying on
   organic search, this is close to invisible to search engines beyond the
   one static homepage `<title>`.
   **Fixed** — see PART B/F/G below.

### Medium priority

4. **`Home.tsx` defined `BannerCarousel`, `EpisodeCard`, and
   `NovelCardSection` as components *nested inside* the `Home()` function
   body.** Every time `Home` re-rendered for any reason (e.g. `useAuth()`'s
   `user` resolving after the initial render), React saw brand-new function
   *references* for these three components and treated them as entirely
   different component types — unmounting and remounting the whole subtree.
   `BannerCarousel` in particular has its own `useState`/`useEffect`
   (`currentIndex` + a `setInterval` auto-rotate timer), so this reset the
   banner rotation and re-ran the effect setup/teardown on every
   unrelated Home re-render.
   **Fixed**: moved all three to module scope, passing in the small set of
   values they previously closed over (`t()`-translated labels) as props.
   No visual/behavioral change — verified via Playwright that the homepage
   renders identically.
   **Risk**: none — this is a pure refactor (function relocation +
   explicit props), no logic changed.

5. **`novels.detail` (novel detail cover) and `SafeImage` (used on
   `/my-novels` and 2 admin pages) had no `loading`/`decoding` attributes at
   all**, and the novel-detail cover had no width/height/aspect-ratio hint
   (a real layout-shift source, since the browser has no idea how tall the
   image will be until it downloads).
   **Fixed**: novel-detail cover → `loading="eager" decoding="async"
   fetchPriority="high"` (this page's LCP candidate) + `width={1000}
   height={1500}` as a CLS-prevention hint (the R2 optimizer's own max
   cover footprint) — combined with the existing `w-full h-auto` classes,
   this only affects the *aspect-ratio reserved before load*, never the
   final rendered size, and never distorts a cover with a different real
   ratio (verified visually with a deliberately non-2:3 test image — see
   PART I). `SafeImage` → `loading="lazy" decoding="async"` (every current
   usage is a small thumbnail, never a hero image).
   **Risk**: none — `Home.tsx`'s banner and `NovelCard.tsx` already had
   correct `loading`/`decoding` from earlier work; this just closes the two
   remaining gaps.

6. **`home.getSections` had no `staleTime`, so it refetched on every window
   focus** (React Query's default `staleTime: 0` + `refetchOnWindowFocus:
   true`). Homepage content (popular/new/free/finished novel lists) doesn't
   need to be second-fresh.
   **Fixed**: added `staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false`
   to the homepage query only, mirroring the exact pattern the `/novels`
   browse query already used from earlier work.
   **Deliberately not fixed globally**: the app's `QueryClient` has no
   default `staleTime` anywhere (`client/src/main.tsx`), meaning *every*
   query in the app — including Wallet, Cart, and Orders — refetches on
   window focus by default. This is almost certainly a much bigger,
   app-wide win, but changing it globally risks silently making
   money-related pages (wallet balance after a top-up in another tab, cart
   state) feel less "live" without a page-by-page review of which ones
   actually depend on that behavior for correctness. That review is
   explicitly out of scope for this quick-wins pass — see Future
   recommendations.

7. **`<html lang="en">`** on a site whose UI/content is primarily Thai.
   **Fixed**: `lang="th"` in `client/index.html`. Also added a static
   default `<title>`/`<meta name="description">`/`<link rel="canonical">`
   in `index.html` matching the homepage's own values, as a safety net for
   the brief window before React hydrates and for any route not wired into
   `useDocumentHead` this round.
   **Risk**: none — a single, standard HTML attribute correction.

### Low priority / noted but not changed this round

8. **Homepage's 4 novel-ranking queries (`getPopularNovels`, `getNewNovels`,
   `getFreeNovels`, `getFinishedNovels`) each independently build their own
   purchase-count and wishlist-count `GROUP BY` subqueries**, so a single
   homepage load does up to 8 aggregate subqueries scanning the
   `purchases`/`wishlists` tables. Consolidating these into one shared
   computation is a real potential win, but it would mean touching 4
   separate ranking algorithms' shared query-building code — the kind of
   "not-so-quick" refactor this pass explicitly excludes
   (`ไม่ทำ refactor ใหญ่`). Flagged for a future pass, with actual query
   plans reviewed first.
9. **Admin thumbnails outside `SafeImage`** (a handful of raw `<img>` tags
   in `AdminDashboard.tsx`, `AdminBannersPage.tsx`, `AdminSportsVotesPage.tsx`,
   etc.) were not touched this round — low-traffic, non-public, low payoff
   relative to the number of files it'd mean touching. `SafeImage` itself
   (used by `MyNovelsPage.tsx` and 2 admin pages) *was* fixed since it's a
   single shared component.
10. **Payment/wallet-adjacent images** (`WalletPage.tsx`, `CartPage.tsx`,
    `PaymentPage.tsx`, `AdminPaymentsPage.tsx`, slip-preview images) were
    deliberately left untouched — explicitly out of scope
    (`ห้ามกระทบ ... Wallet`) and the performance payoff there is minimal
    (small receipt/QR images, not public/high-traffic).
11. **`sports-votes` page** was left without SEO metadata this round — it's
    a semi-public gamification feature not named in this task's explicit
    page list, and its indexability is a product decision (public
    leaderboard vs. account feature) better made deliberately than
    defaulted in a quick-wins pass.

### DB index candidates (not created this round — index changes are explicitly out of scope)

| Table | Column(s) | Query that benefits | Reason | Risk of adding |
|---|---|---|---|---|
| `purchases` | `(novelId)` | The purchase-count `GROUP BY purchases.novelId` subqueries in `getPopularNovels`/`getNewNovels`/`getFreeNovels`/`getFinishedNovels` | Currently a full scan of `purchases` per homepage load, once per ranking function | Low — an index write-amplifies every purchase insert slightly; should be validated against real `EXPLAIN` output and current table size before adding |
| `wishlists` | `(novelId)` | Same 4 functions' wishlist-count subqueries | Same as above | Low, same caveat |
| `episodePurchases` / `purchases` | `(userId, episodeId)` composite (verify not already present) | `myNovels.list`'s `getPurchasesByUserId`, `readerService.hasPurchasedEpisode` | Frequently-run per-user entitlement lookups | Low, but must be verified against the existing index list in `drizzle/schema.ts` first — some tables here already have relevant indexes and a duplicate/overlapping index is pure waste |

None of these were added. `novels.publicationStatus` already has an index
(`novels_publicationStatus_idx` in `drizzle/schema.ts`), which the new
`getPublishedNovelsForSitemap()` query benefits from immediately.

## PART B — SEO foundation implemented

No existing head-management library (`react-helmet`/`react-helmet-async`)
was found anywhere in the project (`package.json`, and a repo-wide grep for
`helmet`/`document.title` turned up nothing beyond the one static
`<title>` in `client/index.html`). Given the CSR-only architecture and the
explicit "don't over-engineer" instruction, a small dependency-free hook was
added instead of pulling in a new library:

- `client/src/lib/seo.ts` — pure helpers: `buildCanonicalUrl(path)` (always
  `https://ipenovel.com` + a clean, query/hash-stripped, single-slash path;
  `"/"` → `"https://ipenovel.com/"` exactly), `sanitizeMetaDescription(html,
  maxLength=160)` (strips tags, decodes common entities, collapses
  whitespace, truncates at a word boundary with `…`), and
  `buildNovelMetaDescription(description, title)` (real description when
  present, a natural-reading fallback otherwise — never an empty tag).
- `client/src/hooks/useDocumentHead.ts` — a `useEffect`-based hook that
  upserts (never duplicates) `document.title`, `<meta name="description">`,
  `<link rel="canonical">`, `og:title/description/url/type/image`,
  `twitter:card`, `<meta name="robots">`, and one
  `<script type="application/ld+json">` block. Every field is optional and
  independent — a page in a loading state can call it with only the fields
  it already has.

**Known limitation** (documented in the hook's own comments): this is
imperative, per-render DOM management, not a stack-based system like
`react-helmet-async`. A route that never calls the hook keeps whatever the
*previously-visited* route left in `document.head`. This only matters for
client-side navigation between a wired-up page and a not-yet-wired-up page
(e.g. Home → Sports Votes) — a fresh page load / hard refresh always starts
from `index.html`'s own static defaults. Full coverage of every route is a
reasonable next step, not attempted this round (see Future
recommendations).

### Pages wired up

| Page | Title | Description | Canonical | Robots | OG/JSON-LD |
|---|---|---|---|---|---|
| Home (`/`) | `IpeNovel — นิยายแปลออนไลน์` | (fixed, per spec) | `https://ipenovel.com/` | *(none — public, indexable)* | `og:type=website` + JSON-LD `WebSite` |
| Novels listing (`/novels`) | `รายการนิยาย \| IpeNovel` | *(none set — page has no single natural description)* | `https://ipenovel.com/novels` (query params intentionally stripped — see below) | *(none)* | `og:type=website` |
| Novel detail (`/novels/:id`) | `{novel.title} \| IpeNovel` | `buildNovelMetaDescription(novel.description, novel.title)` | `https://ipenovel.com/novels/{numeric id}` | *(none)* | `og:image={coverImageUrl}`, `twitter:card=summary_large_image`, JSON-LD `Book` |
| Reader (`/read/:episodeId`) | `{episode.title} - {novel.title} \| IpeNovel` | `อ่านนิยาย {novel} ตอน {episode} บน IpeNovel` (titles only, never chapter prose) | `https://ipenovel.com/read/{episodeId}` | **`noindex,follow`** (see rationale below) | *(none)* |
| Admin (`/admin/*`, all pages via `AdminLayout`) | *(unchanged)* | *(unchanged)* | *(unchanged)* | `noindex,nofollow` | — |
| Admin Login (`/admin/login`) | *(unchanged)* | *(unchanged)* | *(unchanged)* | `noindex,nofollow` | — |
| Cart, Orders, Order detail, My Novels, My Library, Profile, Points, Wallet, Payment | *(unchanged)* | *(unchanged)* | *(unchanged)* | `noindex,nofollow` | — |

**Novel listing canonical intentionally ignores `?sort=`/`?filter=`/`?storyStatus=`/`?page=`
query params.** These are view variants of the same underlying listing, not
distinct pages — pointing every variant's canonical at the one clean
`/novels` URL tells crawlers "index this one, the query-string variants
aren't separate content," which is standard practice and avoids diluting
index weight across dozens of parameter combinations.

**Reader `noindex,follow` — the reasoning, not a guess.** `reader.getEpisode`
is a `protectedProcedure` and the client only fires the query when
`!!user` (`ReaderPage.tsx`). An anonymous crawler can never receive real
chapter content from this route under any circumstance — it would either
get a 401 from the API or (since the query is disabled) see a permanently
empty/loading shell. Indexing that shell would be pure noise (thin/
duplicate-looking pages in search results) with zero chance of ever
surfacing real content to a searcher. `follow` (not `nofollow`) is
deliberate: the page's own navigation links (prev/next chapter, back to
novel) should still be crawlable so link equity flows through, even though
the page itself isn't indexed.

**Novel detail `og:type`**: used `"website"`, not `"book"`. The Open Graph
protocol's actual book type is the namespaced `books.book`, which expects
book-specific properties (ISBN, release date, an author *profile URL*) this
app has none of. Rather than emit a technically-incomplete `books.book`
block, the JSON-LD `Book` schema (PART G) is the mechanism that actually
describes it as a book — its fields are all optional, so it never needs
data the app doesn't have.

## PART C — Image loading quick wins implemented

| Component | Before | After | Why |
|---|---|---|---|
| `Home.tsx` banner | `loading="eager" decoding="async"` (from earlier work) | + `fetchPriority="high"` | This page's genuine LCP candidate — first, largest, top-of-viewport image |
| `NovelCard.tsx` (cover cards, all listing pages) | `loading`/`decoding` already correct (earlier work); `aspect-3/4` container already prevents CLS | *unchanged* | Already correct |
| `NovelDetailPage.tsx` cover | plain `<img>`, no attributes | `loading="eager" decoding="async" fetchPriority="high" width={1000} height={1500}` | This page's LCP candidate + CLS hint (verified with a non-2:3 test image that the hint never distorts the real image — see PART I) |
| `SafeImage.tsx` (My Novels + 2 admin pages) | no attributes | `loading="lazy" decoding="async"` | Never a hero/LCP image in any current usage |
| Reader page | n/a | n/a | Text-only, no images |

Exactly one image per page carries `fetchPriority="high"` (never applied
blanket-wide), matching the explicit constraint.

## PART D — Frontend rendering quick wins implemented

- Moved `Home.tsx`'s `BannerCarousel`/`EpisodeCard`/`NovelCardSection` to
  module scope (finding #4 above).
- `home.getSections` given `staleTime`/`refetchOnWindowFocus: false`
  (finding #6 above).
- `NovelDetailPage.tsx`'s episode filter/sort/group computations were
  already correctly wrapped in `useMemo` before this pass — reviewed,
  nothing to change.
- `NovelsPage.tsx`'s browse query already had `keepPreviousData` +
  `staleTime` + lightweight wishlist query from earlier work — reviewed,
  nothing to change.
- New `useDocumentHead` JSON-LD payloads are built with `useMemo` at every
  call site (`Home.tsx`, `NovelDetailPage.tsx`) so the hook's effect
  dependency array sees a stable reference instead of a new object literal
  every render.

**Not done, deliberately**: global `QueryClient` defaults (see finding #6),
virtual lists, infinite scroll, and any change to pagination — all
explicitly out of scope this round.

## PART E — Backend/API quick wins implemented

Covered in High-priority findings #1 and #2 above:
`server/routers.ts` (`novels.detail`, `myNovels.list`) and two new lean
batch-select helpers in `server/db.ts` (`getNovelsByIdsLite`,
`getEpisodesByIdsLite`). No schema change, no new index, no change to
`purchases`/entitlement authorization logic, no change to any response
field a client actually reads.

## PART F — robots.txt / sitemap.xml

Neither existed before this change.

- **`client/public/robots.txt`** (static file, served as-is by both Vite dev
  and the production static file server): allows everything by default,
  explicitly disallows `/admin`, `/cart`, `/orders`, `/my-novels`,
  `/my-library`, `/profile`, `/points`, `/wallet`, `/payment`, and
  `/read/` (the reader route — matches the `noindex,follow` decision above;
  `Disallow` here additionally stops a crawler from even *requesting* those
  URLs, which `noindex` alone doesn't do), and points at
  `https://ipenovel.com/sitemap.xml`.
- **`server/_core/sitemap.ts`**, mounted as `GET /sitemap.xml` in
  `server/_core/index.ts` (registered before the Vite/static-file
  fallback, otherwise the SPA's `index.html` fallback would intercept it).
  Includes the homepage, `/novels`, and one `<url>` per **published**
  novel only (`novels.publicationStatus = "published"`, the same rule the
  public `novels.detail`/`novels.browse` procedures already use) via the
  new `getPublishedNovelsForSitemap()` — id + `updatedAt` only, capped at
  5000 rows as a safety net, no episodes ever touched. URLs use the numeric
  novel `id` (`/novels/{id}`) because that's what the actual frontend route
  parses (`parseInt(identifier)`) — the `slug` column exists in the schema
  but isn't what `/novels/:identifier` resolves with today, so a
  slug-based sitemap would generate links that 404. All `loc` values are
  XML-escaped. If the DB is unreachable, the handler catches the error and
  serves a static-only sitemap (homepage + `/novels`) rather than a 500.

Both were verified live (see PART I) — `Content-Type: application/xml;
charset=utf-8` for the sitemap, correct body for `robots.txt`.

## PART G — Structured data implemented

- **Home**: JSON-LD `WebSite` (`name: "IpeNovel"`, `url:
  "https://ipenovel.com/"`).
- **Novel detail**: JSON-LD `Book` — `name`, `url`, `inLanguage: "th-TH"`,
  `description` (via the same sanitizer as the meta description),
  `image` (cover URL) when present, and `author` (`Person`) **only when the
  novel actually has a non-empty `author` field** — no fabricated author.
  No `aggregateRating`, no `review`, no `offers`/price — this app has no
  rating/review data and no book-specific pricing concept, so none of those
  fields are emitted (verified in the Playwright check: the JSON-LD object
  has no `aggregateRating`/`offers` key at all, not even an empty one).

## PART H — Error handling / fallback behavior

- `useDocumentHead` never throws: every DOM write is a plain
  querySelector/upsert, and the JSON-LD serialization is wrapped in
  `try/catch` (a circular reference or similar would just clear that one
  script tag's content, never crash the page).
- Every page's hook call only passes fields it actually has — e.g.
  `NovelDetailPage.tsx` passes `title: novelRow?.title ? ... : undefined`,
  so while the novel is still loading (or on a fetch error / NOT_FOUND),
  the hook simply isn't given a title/description/canonical/JSON-LD that
  round, and `index.html`'s static defaults remain visible instead of a
  broken `"null | IpeNovel"` title or an empty-fielded JSON-LD block.
  Verified by loading `/novels/:id` before the mocked response resolved —
  no console error, no malformed tag.
- `sanitizeMetaDescription`/`buildNovelMetaDescription` handle `null`,
  `undefined`, and empty-string input explicitly (return `""` or a natural
  fallback sentence, never `"undefined"`/`"null"` as text).
- `sitemap.ts`'s DB call is wrapped in `try/catch` with a static-only
  fallback (see PART F) instead of a 500.

## PART I — Validation

### `pnpm check`

```
> ipenovel-v2@1.0.0 check
> tsc --noEmit
```
Passed, no errors.

### `pnpm test`

New/modified test files all pass:
- `server/_core/sitemap.test.ts` — 9/9 passing (XML escaping, `lastmod`
  formatting, optional-field omission, DB-unavailable fallback never
  throwing, no legacy domain in output).
- Existing `server/**/*.test.ts` suite: same ~200 pre-existing failures as
  every prior task this session, all `Database not available`/DB-dependent
  tests unrelated to this change — this sandbox has no live `DATABASE_URL`.
  Confirmed none of the newly-failing tests (there are none) touch any file
  changed in this pass.

A standalone `client/src/lib/seo.ts` smoke test (not a persisted test file —
the project's `vitest.config.ts` only includes `server/**/*.test.ts`, so a
new client-side test file wouldn't run under `pnpm test` anyway) confirmed
`buildCanonicalUrl`/`sanitizeMetaDescription`/`buildNovelMetaDescription`
against 15 cases (root/query-stripping/hash-stripping/double-slash
collapsing/HTML-stripping/entity-decoding/whitespace-collapsing/
truncation/fallback text) — all passed.

### `pnpm build`

```
✓ 1833 modules transformed.
✓ built in ~7-11s
dist/index.js ~490kb
```
Passed. Confirmed `dist/public/robots.txt` present with the correct content
after build (Vite copies `client/public/*` verbatim).

### Browser/Playwright verification (mocked tRPC responses, dev server)

29 automated checks + 3 full-page screenshots, all passing:

1. **Homepage**: title = `IpeNovel — นิยายแปลออนไลน์`, description contains
   the required copy, canonical = `https://ipenovel.com/`, `<html
   lang="th">`, JSON-LD `WebSite` with correct `url`, banner image visible
   with `fetchPriority="high"`, zero console errors (aside from the
   sandbox's expected external-network-blocked noise).
2. **`/novels`**: title = `รายการนิยาย | IpeNovel`, canonical =
   `https://ipenovel.com/novels` for both the bare URL *and*
   `?sort=popular` (confirms query-stripping), cover images visible with a
   `loading` attribute present.
3. **Novel detail**: title = `{title} | IpeNovel`, description = the
   HTML-stripped/entity-decoded synopsis, canonical uses the numeric id,
   `og:image` = the cover URL, `twitter:card=summary_large_image`, JSON-LD
   `Book` with correct `name`/`inLanguage`/`author`, **no** `aggregateRating`/
   `offers` keys, cover has `fetchPriority="high"` and `width="1000"`.
   Additionally screenshotted with a deliberately non-2:3 (400×300) test
   image to confirm the CLS width/height hint never distorts the actual
   rendered image (screenshot: rendered as its true landscape shape, not
   stretched to portrait).
4. **Reader**: title includes both episode and novel titles, canonical =
   `/read/{episodeId}`, `robots=noindex,follow`, description contains
   *only* the titles (verified it does **not** contain the mock chapter's
   body text), and the actual chapter content still renders on the page
   (access/entitlement logic untouched).
5. **Admin**: `robots=noindex,nofollow` present; full dashboard
   (sidebar with all sections including the pre-existing "Media Migration"
   entry, stat cards, quick actions, system status) renders correctly —
   confirmed by screenshot after one Playwright locator false-positive
   turned out to be a strict-mode duplicate-text artifact (a mobile-header
   title element sharing text with the sidebar item), not a real issue.
6. **Wallet** (spot-check for the private-page noindex list):
   `robots=noindex,nofollow` present.
7. **`/robots.txt`**: served correctly, contains the expected
   Allow/Disallow rules and `Sitemap:` line.
8. **`/sitemap.xml`**: `Content-Type: application/xml; charset=utf-8`,
   valid XML containing the homepage and `/novels` (novel entries weren't
   exercised live since this sandbox has no seeded DB — covered instead by
   the `sitemap.test.ts` unit tests using the pure XML-building functions).

## Quick wins implemented in this commit (file list)

New files:
- `client/src/lib/seo.ts`
- `client/src/hooks/useDocumentHead.ts`
- `client/public/robots.txt`
- `server/_core/sitemap.ts` + `server/_core/sitemap.test.ts`
- `docs/PERFORMANCE_SEO_AUDIT.md` (this file)

Modified:
- `client/index.html` — `lang="th"`, default title/description/canonical
- `client/src/pages/Home.tsx` — SEO hook, JSON-LD, module-scoped
  subcomponents, `fetchPriority` on banner, `staleTime` on homepage query
- `client/src/pages/NovelsPage.tsx` — SEO hook (title/canonical)
- `client/src/pages/NovelDetailPage.tsx` — SEO hook, JSON-LD, cover image
  loading/CLS attributes
- `client/src/pages/ReaderPage.tsx` — SEO hook (title/canonical/robots/
  safe description)
- `client/src/components/AdminLayout.tsx` — `noindex,nofollow` for the
  whole admin section
- `client/src/pages/AdminLoginPage.tsx`, `CartPage.tsx`, `OrdersPage.tsx`,
  `OrderDetailPage.tsx`, `MyNovelsPage.tsx`, `MyLibraryPage.tsx`,
  `ProfilePage.tsx`, `PointsPage.tsx`, `WalletPage.tsx`, `PaymentPage.tsx`
  — `noindex,nofollow`
- `client/src/components/SafeImage.tsx` — `loading="lazy"
  decoding="async"`
- `server/routers.ts` — removed unused episode fetch from `novels.detail`;
  batch-fetch rewrite of `myNovels.list`
- `server/db.ts` — added `getNovelsByIdsLite`, `getEpisodesByIdsLite`,
  `getPublishedNovelsForSitemap`
- `server/_core/index.ts` — mounted `GET /sitemap.xml`

## Before/after summary

- Every page had **zero** SEO metadata beyond one static `<title>`; now
  Home/`/novels`/novel-detail/Reader have title, canonical, and (where
  appropriate) description/OG/JSON-LD, and the 11 private/admin pages
  explicitly opt out of indexing instead of silently being indexable.
- No `robots.txt`/`sitemap.xml` existed; both now exist, are correct XML/
  text, and never leak admin/wallet/private/draft-novel/legacy-domain URLs.
- Every public novel-detail page view no longer ships an entire novel's
  chapter text (`novels.detail`'s dead `episodes` field) over the wire.
- `/my-novels` no longer does 2×N sequential DB round trips per page load
  for a user with N purchases — down to 3 queries total (purchases,
  progress batch, and the 2 new batched lookups run in parallel).
- Home's banner/novel-cover/episode subcomponents no longer remount their
  own state on every unrelated Home re-render.
- The novel-detail cover and every `SafeImage` usage now participate in
  native lazy-loading/async-decode/CLS-prevention; exactly 2 images
  site-wide (the Home banner and the novel-detail cover) carry
  `fetchPriority="high"`, each being that specific page's actual LCP
  element.

## Things deliberately NOT changed this round

- Pagination architecture, Redis, database schema, DB indexes (candidates
  documented above only), reader entitlement/purchase/business logic,
  authorization logic, the already-working R2 upload/media pipeline, the
  canonical-domain redirect, the admin media migration runner.
- Global `QueryClient` `staleTime`/`refetchOnWindowFocus` defaults (money-
  adjacent pages need a deliberate per-page review first — see finding #6).
- Consolidating the homepage's 4 repeated purchase/wishlist-count
  subqueries (finding #8) — real potential win, but a bigger refactor than
  this pass's scope.
- Admin-page thumbnails outside `SafeImage`, and all wallet/payment/slip
  images (explicitly out of scope / low payoff — see Low priority).
- SEO metadata for `/sports-votes` and any other route not explicitly named
  in this task.
- Any DB index creation.

## Future recommendations

1. Wire `useDocumentHead` into the remaining routes (Sports Votes, and any
   future public pages) for full site coverage, or consider migrating to
   `react-helmet-async` if per-route coverage grows enough that the
   stack-based restoration behavior becomes worth the dependency.
2. Review and likely add the 3 DB index candidates listed above, backed by
   real `EXPLAIN` output against production-sized tables.
3. Consolidate the homepage's repeated purchase/wishlist-count subqueries
   into one shared computation (finding #8) — needs careful review since it
   touches 4 separate ranking algorithms.
4. Page-by-page review of which queries actually need
   `refetchOnWindowFocus: true` for correctness (wallet balance, cart,
   order status) vs. which are safe to relax like `home.getSections` was
   this round — then set sensible per-query (not global) defaults.
5. Consider server-side rendering or prerendering for the public pages
   (Home, `/novels`, novel detail) if organic search traffic becomes a
   priority beyond what a CSR SPA with client-patched `<head>` tags can
   deliver — this is the single biggest lever left, and a genuinely large
   change appropriately deferred to its own phase.
6. If the novel catalog grows large enough that `/sitemap.xml`'s 5000-row
   cap becomes a real concern, split into a sitemap index +
   multiple per-type sitemaps.
7. A deliberate product decision on whether `/sports-votes` (and any
   future gamification/community pages) should be indexable, then wire up
   its metadata accordingly.

---
No secrets appear in this document, in the diff, or in any file added/
changed for this task. No business logic (pricing, entitlement, purchase
flow, wallet, cart, orders, admin authorization, the R2 media pipeline, or
the canonical-domain redirect) was changed.

# Step 2 — Server-side HTML metadata injection

Date: 2026-07-19 (follow-up to Step 1 above)

## The problem this fixes

Step 1 added `client/src/hooks/useDocumentHead.ts`, which is a `useEffect`
hook - it only updates `document.head` **after React hydrates in the
browser**. Confirmed in production:
`view-source:https://ipenovel.com/novels/57` showed the *homepage's*
`<title>`/description/canonical in the raw HTML response, because nothing
runs before React does. Anything that reads the raw HTTP response instead
of executing JavaScript (curl, `view-source:`, and many social-media link
preview crawlers) never saw the novel-specific metadata at all. The Open
Graph tags Manus's own edge layer showed were correspondingly wrong too -
`og:url` was the right novel URL, but `og:title`/`og:description` still
came from the homepage and `og:image` was a Manus-generated screenshot,
not the novel's cover.

## PART A — where HTML actually gets served

`server/_core/vite.ts` has exactly two places that produce an HTML
response for a client route:

- **Development** (`setupVite`): a Vite dev-server catch-all
  (`app.use("*", ...)`) that re-reads `client/index.html` from disk on
  every request (intentional, for HMR/dev experience) and runs it through
  `vite.transformIndexHtml`.
- **Production** (`serveStatic`): `express.static(distPath)` serves built
  assets, then a catch-all (`app.use("*", ...)`) previously did a plain
  `res.sendFile(path.resolve(distPath, "index.html"))` - no template
  processing of any kind. **This is the one the production bug report was
  about.**

Both catch-alls are the correct, and only, interception points - nothing
about routing/framework/API/static-asset serving needed to change.

## PART B/C — `server/services/serverSeoRenderer.ts` + `server/services/htmlSeoInjector.ts`

Split into two focused modules:

- **`serverSeoRenderer.ts`** - `resolveSeoMetadata(pathname)`: pure route →
  metadata resolution (a big switch over path patterns), `renderSeoHtml
  (template, pathname)`: the one entry point `vite.ts` calls, wrapping
  everything in a try/catch that falls back to the unmodified template on
  any failure. Reuses `client/src/lib/seo.ts`'s `buildCanonicalUrl`/
  `buildNovelMetaDescription`/`SITE_NAME` **directly** (relative import,
  not duplicated) - that file has zero DOM/React dependencies, so it's
  safe to run in Node, and it guarantees the server-rendered tags and the
  client hook's tags can never define "canonical URL" or "novel
  description fallback" differently.
- **`htmlSeoInjector.ts`** - `injectSeoMetadata(template, meta)`: the only
  code that touches the HTML string. Replaces *only* the content between
  two literal comment markers (PART C below) with a freshly-built tag set;
  any field left `undefined` in `meta` falls back to whatever the
  template's *own current* title/description/canonical already are
  (extracted from the same template once per call) - so a route that only
  needs to change `robots` (private pages) doesn't have to lose or
  re-specify the rest.

**Escaping** (PART B's explicit XSS requirement, verified with dedicated
tests): every title/description/canonical/image value goes through a
standard 5-character HTML-attribute/text escape (`& < > " '`) before being
embedded in an attribute or text node - a title like
`</title><script>alert(1)</script><title>` renders as inert escaped text,
never executes. JSON-LD is embedded in a `<script type="application/ld+json">`
block, which the HTML tokenizer parses as raw text hunting for a literal
`</script` - HTML-escaping there would corrupt the JSON, so instead only
`<` is unicode-escaped (`<`), which stops a `</script>` substring
inside a title/description from ever prematurely closing the tag while
still decoding back to byte-identical JSON.

**Routes covered** (mirrors the client-side hook's route list exactly -
see the table in Step 1 above):

| Route | title | description | canonical | robots | OG/JSON-LD |
|---|---|---|---|---|---|
| `/` | fixed | fixed | `https://ipenovel.com/` | - | `website` + JSON-LD `WebSite` |
| `/novels` (any query string) | fixed | fixed | `https://ipenovel.com/novels` | - | `website` |
| `/novels/:id` (published) | `{title} \| IpeNovel` | sanitized synopsis | `https://ipenovel.com/novels/{id}` | - | `book`, `og:image`=cover, JSON-LD `Book` |
| `/novels/:id` (not found / archived / draft) | generic site title | generic site description | `https://ipenovel.com/novels/{id}` | - | `website`, no image, no JSON-LD - **never the real title/description** |
| `/read/:id` | generic "อ่านนิยาย" title | *(unset)* | `https://ipenovel.com/read/{id}` | `noindex,follow` | none - no DB query at all (see below) |
| Admin/Cart/Orders/My Novels/My Library/Profile/Points/Wallet/Payment | *(unset - template default preserved)* | *(unset)* | *(unset)* | `noindex,nofollow` | none |
| anything else (e.g. `/sports-votes`) | `resolveSeoMetadata` returns `null` - template is returned completely untouched | | | | |

**Not-found/unpublished handling** (PART B item 3 / second prompt item
10): the HTTP status code is deliberately left exactly as-is (200, same as
every other SPA route) - this SPA has never sent a real HTTP 404 for a
client route like `/novels/999999`, it renders its own "ไม่สามารถดูนิยาย
เรื่องนี้ได้" UI client-side after the (also 200) tRPC call resolves to
`NOT_FOUND`. Changing the *HTTP* response code for that case would be a
behavior change beyond "inject metadata," and risks surprises for
anything that currently assumes every SPA route 200s. Instead, only the
`<head>` tags change: a missing/unpublished novel gets the same generic
site-level metadata the homepage uses, never its real title/description -
verified with a dedicated test using a novel row whose title literally
contains `"DRAFT - ยังไม่เผยแพร่ ห้ามเห็น"` to prove it never leaks
through.

**Reader route** intentionally does **no DB query at all**. `reader.
getEpisode` is a `protectedProcedure`, and this renderer runs with no user
session (it's the raw pre-hydration HTML response) - there is no
authenticated context to check entitlement against, so querying episode/
novel titles here would mean either (a) exposing them to anyone regardless
of purchase status, or (b) building a parallel, unauthenticated
entitlement bypass just for metadata purposes. Neither is acceptable, so
the reader route gets a fixed, generic, safe title and `noindex,follow` -
identical in spirit to the Step 1 client-side hook's Reader handling.

## PART D — the Manus OG screenshot override (documented limitation, not fixed)

This repository's own server now sends fully correct OG tags for
`/novels/:id` in its raw HTML response (verified - see PART I below).
However, the production bug report describes Manus's platform layer
*additionally* substituting `og:image` with a `files.manuscdn.com/
webdev_screenshots/...` URL and evidently reusing stale
`og:title`/`og:description`.

Searched this entire repository for anything that could be doing that:
`vite.config.ts` uses one Manus-specific plugin,
`vitePluginManusRuntime()` (from the `vite-plugin-manus-runtime` npm
package), with zero configuration options passed and zero references to
`og:`/`manuscdn`/`webdev_screenshot` anywhere in this codebase. That
plugin runs entirely at Vite build/dev-server time, not as an HTTP
response layer - there is nothing in this app's own build or server code
that could be adding or overriding OG tags at the network edge.

**Conclusion, stated plainly**: the screenshot-based OG override is
happening in Manus's own hosting/edge infrastructure, *outside this
repository*, and cannot be inspected, configured, or disabled from
application code. This fix guarantees our own origin server's HTML is
correct; whether Manus's edge layer then leaves that alone, merges with
it, or overrides it entirely is a platform-level behavior the user needs
to check on the Manus dashboard/support side (e.g. an "auto-generate
social preview" or "OG override" setting, if one exists) - not something
any further code change here can address. If Manus's layer only *adds*
tags when none exist upstream, this fix may already resolve the problem
end-to-end; if Manus unconditionally overwrites `og:image` on every
response regardless of what upstream sends, it won't, and that's a
platform configuration question, not a code bug.

## PART E — Cache and performance

- **Lean query**: `db.getNovelSeoData(novelId)` selects exactly `id,
  title, description, coverImageUrl, author, publicationStatus` - never
  `episodes`, never `content`.
- **In-memory TTL cache**: `novelSeoCache` (`Map<number, {data, expiresAt}>`)
  inside `serverSeoRenderer.ts`, 10-minute TTL, capped at 500 entries
  (oldest evicted first once full) - no Redis, matches the explicit
  constraint. A DB error is never cached (would pin a false "not found"
  for the whole TTL window) - the last-known-good cached value is served
  instead if one exists, otherwise the caller's existing not-found
  fallback kicks in.
- **Template caching**: production's `serveStatic` now reads
  `dist/public/index.html` from disk exactly once per process (cached in
  a module-level variable) instead of on every request via `res.sendFile`.
  Development's `setupVite` intentionally keeps its existing always-fresh
  read (a deliberate, pre-existing HMR/dev-experience choice, not a
  performance concern in dev).
- **Fallback on failure**: `renderSeoHtml` itself never throws (internal
  try/catch around metadata resolution), and `serveStatic`'s route handler
  wraps the whole read-cache/render step in its own try/catch that falls
  back to the original `res.sendFile` behavior - two independent layers,
  so neither a DB outage nor a bug in the renderer can take the site down.

## PART F — client-side SEO hook: kept, and why

`client/src/hooks/useDocumentHead.ts` (Step 1) is **unchanged** and still
active. It's still needed for client-side (SPA) navigation - a user
clicking from `/novels` to `/novels/58` never triggers a new server
request, so nothing server-rendered would ever update without it.
`serverSeoRenderer.ts`'s route table (this doc, PART B above) was written
to mirror the client hook's existing route classification field-for-field
(same private-route list, same reader `noindex,follow` reasoning, same
canonical-URL/description helpers via the shared `client/src/lib/seo.ts`)
specifically so the two layers agree: the tags present in the initial HTML
and the tags the client hook would set on a hydration/navigation to that
same route are the same values, from the same source functions.

## PART G — robots.txt

Already correct from Step 1 - `client/public/robots.txt` ends with
`Sitemap: https://ipenovel.com/sitemap.xml` and its Disallow rules already
match `serverSeoRenderer.ts`'s private-route list. No change needed.

## PART H — Tests

`server/services/serverSeoRenderer.test.ts` - 25 tests, all passing:
- Pure injection: replaces the marked block only, never duplicates
  title/canonical/og:title, preserves the template's own values for
  fields a route doesn't override, returns the template byte-for-byte
  unmodified if the markers are missing.
- XSS: a `</title><script>...` title, a quote-breakout description, and a
  `</script>` breakout inside JSON-LD are all neutralized - verified by
  asserting the dangerous substring is *absent* from the output and (for
  JSON-LD) that the escaped payload still parses back to the exact
  original string.
- Route resolution (no DB): homepage, `/novels` (with query-string
  stripping), reader (`noindex,follow`, no description), every private
  path prefix (`noindex,nofollow`, no title override), and an
  unclassified route returning `null`/the untouched template.
- Novel detail (DB mocked via `vi.doMock`, deterministic - this sandbox
  has no live `DATABASE_URL`): a published novel's real title/description/
  canonical/og:image/JSON-LD `Book`; a nonexistent novel ID; an
  `archived`-status novel whose title literally contains
  `"DRAFT...ห้ามเห็น"` (asserted absent from the output); a novel with no
  description/cover/author (never crashes, never emits an empty
  `og:image`/`author` field); and a DB call that throws (falls back to
  generic metadata, never propagates the error to the response).

## PART I — Validation

- `pnpm check` - passed, no errors.
- `pnpm build` - passed (`dist/index.js` built successfully; the SSR
  renderer code is bundled into the server output via esbuild's existing
  `--bundle --packages=external`, no new build step needed).
- 25/25 new tests passing; the full existing `server/**/*.test.ts` suite
  re-run to confirm no regressions (same pre-existing DB-dependent
  failures as every prior task in this sandbox, none newly failing).
- **Live verification found a real bug the unit tests couldn't catch**:
  built the app in production mode (`NODE_ENV=production`) and curled `/`,
  `/novels`, `/novels?sort=popular`, `/novels/57`, `/read/123`, and
  `/admin` against the actual `serveStatic` code path (not just calling
  `resolveSeoMetadata` directly, which is what the unit tests do). The
  first run showed *every* route serving the homepage's metadata,
  including `/novels/57`. Root cause: `app.use("*", handler)` in Express
  rebases `req.path` relative to the mount point, and a literal `"*"`
  mount consumes the *entire* path as the prefix - so `req.path` is always
  `"/"` inside a `"*"`-mounted handler, regardless of the real request
  path. The fix was mechanical (use `req.originalUrl` instead, which is
  never rebased) but the bug itself is exactly the kind of wiring mistake
  that only shows up when the real Express request pipeline runs - a unit
  test that hand-supplies a path string to `resolveSeoMetadata` will
  always pass regardless of this class of bug, which is why this live
  check (not just the 25 unit tests) was necessary before considering this
  done. Re-verified after the fix - every route now returns the correct,
  distinct title/description/canonical/OG tags, `Content-Type: text/html;
  charset=utf-8`, and exactly one occurrence each of `<title>`,
  `rel="canonical"`, and `og:title` (no duplicates) in the raw curl
  response body.

## Files changed in this step

New:
- `server/services/serverSeoRenderer.ts`
- `server/services/htmlSeoInjector.ts`
- `server/services/serverSeoRenderer.test.ts`

Modified:
- `client/index.html` - added `<!-- SEO_START -->`/`<!-- SEO_END -->`
  markers around the existing title/description/canonical block
- `server/_core/vite.ts` - both `setupVite` (dev) and `serveStatic`
  (production) now run their HTML response through `renderSeoHtml` before
  sending; `serveStatic` additionally now caches the template instead of
  re-reading it per request
- `server/db.ts` - added `getNovelSeoData(novelId)` (lean, SEO-only select)

## Things deliberately not changed in this step

- No framework migration, no Next.js, no full React SSR - exactly as
  instructed.
- No change to React Router/wouter, frontend UI, or any API/tRPC
  procedure's behavior.
- No change to authorization or publication-status logic - the SSR
  renderer *reads* the same `publicationStatus` field the existing public
  procedures already gate on, it doesn't introduce a new rule.
- No Redis, no DB schema/index changes.
- `client/src/hooks/useDocumentHead.ts` unchanged - still the mechanism
  for post-hydration SPA navigation.
- Manus's own edge-layer OG override (PART D) - outside this repository,
  documented rather than guessed at.

---
No secrets appear in this document, in the diff, or in any file added/
changed for this step. No business logic was changed.

# Phase 3 — Database Index and Homepage Query Optimization

Date: 2026-07-20

## PART A — Audit of `home.getSections` (baseline, before any change)

`home.getSections` (`server/routers.ts`) is a single `publicProcedure` that
runs 6 independent queries via `Promise.all`:

```ts
const [popularNovels, newNovels, freeNovels, latestEpisodes, finishedNovels, banners] = await Promise.all([
  db.getPopularNovels(4),
  db.getNewNovels(4),
  db.getFreeNovels(4),
  db.getLatestEpisodes(4),
  db.getFinishedNovels(4),
  db.getAllBanners(),
]);
```

Each of these compiles to **one SQL statement per function** (Drizzle's
`.leftJoin(subquery, ...)` embeds a `GROUP BY` subquery as a joined derived
table within the same statement, not a separate round trip) - so the
*round-trip count* was already only 6, run in parallel. The real waste was
in **what each statement asked the database to compute**:

| Function | Embedded `GROUP BY` subqueries (before) | Actually used for sort? | Actually used for display? |
|---|---|---|---|
| `getPopularNovels` | `purchases GROUP BY novelId`, `wishlists GROUP BY novelId` | **Yes** - primary/secondary sort key | No (counts themselves aren't shown, only used to rank) |
| `getNewNovels` | `purchases GROUP BY novelId`, `wishlists GROUP BY novelId` | No - sorts by `createdAt` only | No |
| `getFreeNovels` | `episodes WHERE isFree GROUP BY novelId`, `purchases GROUP BY novelId`, `wishlists GROUP BY novelId` | free-episode count: yes (INNER JOIN filter). purchase/wishlist: No | free-episode count: **yes** (`novel.freeEpisodeCount > 0` gates the "Free" badge in `Home.tsx`). purchase/wishlist: No |
| `getFinishedNovels` | `purchases GROUP BY novelId`, `wishlists GROUP BY novelId` | No - sorts by `createdAt` only (then randomly samples) | No |

Confirmed by grepping `client/src/pages/Home.tsx` and `client/src/components/
NovelCard.tsx` for `purchaseCount`/`wishlistCount`: **zero matches**. Only
`freeEpisodeCount` is read (for the Free-section badge). So **9 total
`GROUP BY` aggregations were computed per homepage load, of which only 3
were ever used for anything** (2 in `getPopularNovels`'s ranking, 1 in
`getFreeNovels`'s filter/badge) - the other 6 were pure wasted database
work, silently discarded after the query returned.

**A second, more significant issue found during this audit**:
`getLatestEpisodes` (the "Latest Uploaded Episodes" section) had **no
visibility filter at all** - not `episodes.isPublished`, not
`novels.publicationStatus`. Every other homepage section correctly filters
`publicationStatus = "published"`; this one didn't check either flag. A
draft/unpublished episode, or any episode belonging to an archived novel,
could appear on the public homepage. Confirmed via grep this function has
exactly one caller (`home.getSections`), so fixing it only affects this one
section - see PART B.

### Baseline - what could and couldn't be measured

Per this task's own instruction not to state unmeasured numbers: **this
sandbox has no live `DATABASE_URL`** (a limitation present throughout this
entire engagement, documented in every prior phase's test runs). The
following baseline facts are **derived directly from the code and
generated SQL** (verifiable, not measurements) rather than from
`EXPLAIN`/timing against a real database:

- **Query count**: 6 top-level round trips per `home.getSections` call
  (unchanged by this phase's optimization - see PART B, the fix is in
  what each statement computes, not how many statements there are).
- **Embedded aggregations**: 9 before this phase, 3 after (see PART B).
- **Response payload**: each of the 4 novel-list sections returns up to 4
  rows of `getTableColumns(novels)` (11 columns: id, title, slug,
  description, author, coverImageUrl, publicationStatus, storyStatus,
  status, createdAt, updatedAt) + 3 count fields; `latestEpisodes` returns
  up to 4 rows of 8 lean columns; `banners` returns however many active
  banners exist (typically a handful). No `content`/`episodes` array is
  ever included (confirmed unchanged).
- **Timing**: not measured against a real database - flagged honestly
  rather than invented. A development-only timing log was added (PART F)
  so this becomes measurable the moment a real `DATABASE_URL` is available
  (locally or in the Manus environment); the very first dev-server request
  in this sandbox logged `[home.getSections] resolved in 17ms`, but since
  the DB connection itself fails immediately in this sandbox (each function
  hits its `if (!db) return []` guard), that number reflects connection-
  attempt overhead, not real query execution time, and is **not** cited as
  a "before" baseline for that reason.
- **Index coverage** (from reading `drizzle/schema.ts` directly, not
  `EXPLAIN`, for the same reason): documented in full in PART C.

## PART B — Homepage query optimization implemented

**`getNewNovels`, `getFreeNovels`, `getFinishedNovels`** (`server/db.ts`):
removed the `purchaseCountsSubquery`/`wishlistCountsSubquery` joins
entirely (proven unused above - not sorted on, not displayed).
`purchaseCount`/`wishlistCount` remain in every returned row, always `0`,
exactly like `freeEpisodeCount: 0` already was in these same 3 functions
before this change (an existing, established "not used here" placeholder
pattern - this phase just applies it to 2 more fields instead of computing
them via SQL and discarding the result). **`NovelWithCounts`'s field set,
and therefore the tRPC output shape, is unchanged** - every field a
consumer could read is still present, with the same type, in the same
place. `getFreeNovels` keeps its `freeEpisodeCountsSubquery` untouched
(genuinely used for both filtering and the Free badge).

**`getPopularNovels`** is unchanged in what it computes (still the sole
function that legitimately needs purchase+wishlist counts, for its actual
ranking) - the only change there is an added `desc(novels.id)` tie-breaker
(see below).

**Why not "hoist purchase/wishlist counts into one shared query and reuse
them"** (the approach PART B's brief suggested as an option): once the 3
functions that never used the counts stopped computing them, there was
nothing left to "reuse" - `getPopularNovels` is the only remaining
consumer. Building a shared-aggregate-map system for a single consumer
would have added a second round-trip *phase* (fetch shared maps, then fetch
per-section novel rows using them) in exchange for eliminating work that
recognizing-as-unused already eliminates directly, with zero added
complexity and zero added latency-phases. This was a deliberate choice,
not an oversight - eliminating provably-dead work beats building
infrastructure to "efficiently" keep doing it.

**Deterministic tie-breaking** (`desc(novels.id)` added as a final
`ORDER BY` column to all 4 ranking functions, and `desc(episodes.id)` to
`getLatestEpisodes`): two novels/episodes sharing the exact same
`createdAt` timestamp (e.g. bulk-imported rows) previously had no defined
tie-break order, which is both non-deterministic across identical queries
and untestable. `id` is unique and monotonically increasing, so this is a
zero-risk addition - it only affects the order of rows that were already
indistinguishable by every other sort column, never the *set* of rows
returned or the ranking rule itself.

**Bug fix: `getLatestEpisodes` visibility filter.** Added
`WHERE episodes.isPublished = true AND novels.publicationStatus =
"published"` (switched the novels join from LEFT to INNER, since a
matching published novel is now required either way). This is the one
change in this phase that alters *which rows* a function returns, not just
how efficiently - flagged prominently here per this task's own
instruction ("ห้ามเปลี่ยนจำนวน item ที่หน้า Home แสดง เว้นแต่พบ bug ชัดเจนและ
รายงานก่อน"). The item *count* (`limit=4`) is unchanged; only the
*eligibility* of a row changed, from "any episode, published or not, in
any novel, archived or not" to "the same visibility rule every other
homepage section already enforces." No caller other than `home.getSections`
was found, so no other page depended on the old, unfiltered behavior.

**No changes to**: section names, item counts (except the bug fix above,
which doesn't change the *limit*, only eligible rows), ranking criteria,
`publicationStatus`/`storyStatus` filtering elsewhere, pagination
architecture, or any business logic outside this exact query path.

## PART C — Database indexes

Audited every candidate this task named against the actual current
`drizzle/schema.ts`, **before** adding anything:

| Candidate (as given) | Status found | Action |
|---|---|---|
| `purchases(novelId)` | **Missing** - `purchases` has indexes on `userId`, `episodeId`, `orderId`, and a unique `(userId, episodeId)`, but nothing on `novelId` | **Added** |
| `wishlists(novelId)` | **Already exists** (`wishlists_novelId_idx`) | Not touched - would be a pure duplicate |
| `purchases`/`episodePurchases`(userId, episodeId) composite | **Already exists** on both tables (`unique_user_episode` on `purchases`, `unique_user_episode_purchase` on `episodePurchases`) | Not touched |
| `episodes(novelId, published/status, episodeNumber/sortOrder)` | `novelId`, `isFree`, `isPublished`, `sortOrder` all already have separate single-column indexes; `(novelId, episodeNumber)` already has a unique composite | No new index here - see below for the one that *was* missing |
| `novels(status/published, updatedAt)` | `publicationStatus` and `createdAt` (not `updatedAt`) each have separate single-column indexes; no composite | **Added**, using `createdAt` (not `updatedAt` - see reasoning below) |

Two of the task's four named candidates turned out to be **already
satisfied** by existing indexes - not added, to avoid the duplicate/
overlapping-index risk the task explicitly warns about. One evidence-based
index **not** in the task's suggested list was found and added instead
(`episodes(isPublished, createdAt)` - see below), because it directly
serves a query this audit found, not because it was suggested.

### Indexes added (3 total)

**1. `novels_publicationStatus_createdAt_idx` on `novels(publicationStatus, createdAt)`**
- **Query it serves**: `getNewNovels`, `getPopularNovels`'s candidate-pool
  pre-filter, `getFreeNovels`, and `getFinishedNovels` (partially - see
  below) all run `WHERE publicationStatus = "published" ORDER BY createdAt
  DESC`.
- **Why the existing single-column indexes aren't enough**: with only
  `novels_publicationStatus_idx` and `novels_createdAt_idx` as separate
  indexes, MySQL can use *one* of them (typically the equality filter) but
  then needs a filesort for `ORDER BY createdAt DESC` on the filtered rows
  - a composite index with `publicationStatus` first and `createdAt`
  second lets the same index satisfy both the filter and the ordering in
  one pass, no separate sort step.
- **Why `createdAt`, not `updatedAt`** (the task's suggested column name):
  every one of these 4 query functions actually orders by `createdAt`, not
  `updatedAt` - matching the column the real queries use, not the
  suggested one, per this task's own "ห้ามแก้แบบเดาสุ่ม" instruction.
- **`getFinishedNovels` note**: its query additionally filters
  `storyStatus = "finished"`, which this 2-column composite doesn't cover
  as a leading/matched column - it still benefits from the
  `publicationStatus` filter being index-accelerated (leftmost-prefix
  rule), just not as completely as the other 3 functions. A 3-column
  `(publicationStatus, storyStatus, createdAt)` composite would serve
  Finished more precisely but would be a second, largely-overlapping index
  serving only one of the four functions - judged not worth the added
  write/storage overhead for this phase; noted as a future candidate if
  Finished-section load ever needs to be revisited in isolation.
- **Write overhead**: one more index to maintain on every `novels`
  INSERT/UPDATE that touches `publicationStatus` or `createdAt` - `novels`
  is a low-write-frequency table (admin-only inserts/status changes), so
  this is judged negligible.
- **Storage overhead**: 2 columns × row count - small for a table of this
  size (dozens to low hundreds of novels, not comparable to `episodes` or
  `purchases`).
- **Overlap risk**: `novels_publicationStatus_idx` (single-column) becomes
  largely redundant once this composite exists (any query that could use
  the single-column index could use this composite's leading column
  instead) - **not removed this phase**, per the explicit instruction not
  to drop existing indexes without proving them safely duplicate; flagged
  as a future cleanup candidate only.

**2. `episodes_isPublished_createdAt_idx` on `episodes(isPublished, createdAt)`**
- **Query it serves**: `getLatestEpisodes`, especially after this phase's
  bug fix added the `isPublished = true` filter (PART B) - the query is
  now `WHERE isPublished = true ORDER BY createdAt DESC LIMIT 4` across the
  *entire* `episodes` table (deliberately not scoped to one novel, since
  it's a site-wide "latest uploads" feed).
- **Why this is the highest-confidence new index in this phase**:
  `episodes` had **zero** index touching `createdAt` at all before this
  change (`novelIdIdx`, `isFreeIdx`, `isPublishedIdx`, `sortOrderIdx`, and
  a `(novelId, episodeNumber)` unique - none help sorting by `createdAt`).
  `episodes` is very likely the largest table in this schema (a "package"
  episode alone can represent 50-100 chapters' worth of content in one
  row, and the table spans every novel × every chapter/package), so a full
  table scan + filesort for "the 4 latest episodes site-wide" on every
  homepage load was the single most expensive operation this audit found.
- **Write overhead**: `episodes` is written far more often than `novels`
  (every admin episode create/publish/ZIP-import touches this table) - a
  2-column composite index adds real but bounded overhead per write,
  judged acceptable given how frequently `getLatestEpisodes` runs (every
  homepage load, i.e. far more reads than writes).
- **Storage overhead**: 2 columns × episode row count - the largest of the
  3 new indexes in absolute terms, proportional to `episodes`' row count.
- **Overlap risk**: `episodes_isPublished_idx` (single-column) has the
  same partial-redundancy relationship as `novels_publicationStatus_idx`
  above - not removed this phase, for the same reason.

**3. `purchases_novelId_idx` on `purchases(novelId)`**
- **Query it serves**: `getPopularNovels`'s `purchaseCountsSubquery`
  (`SELECT novelId, COUNT(DISTINCT userId) FROM purchases GROUP BY
  novelId`) - the one purchase-count aggregation this phase kept, because
  it's genuinely used for ranking.
- **Why the existing indexes aren't enough**: `purchases` has indexes on
  `userId`, `episodeId`, `orderId`, and `(userId, episodeId)` - none of
  which help a `GROUP BY novelId` at all (none has `novelId` as even a
  non-leading column). This was a full table scan + temp table for the
  aggregation, every homepage load, unconditionally.
- **Write overhead**: `purchases` is written once per completed order/
  entitlement grant - much lower write frequency than `episodes`, so a new
  single-column index here is low-risk.
- **Storage overhead**: 1 column × purchase row count - the smallest of
  the 3 new indexes.
- **Overlap risk**: none - genuinely the first index on this column.

### Migration

Generated with the repo's existing framework (`drizzle-kit generate`, the
same tool `npm run db:push` already uses) - **not** hand-written SQL, and
**not** a direct schema edit without a migration, per this task's explicit
requirement. `drizzle-kit generate` is a pure offline schema-diff (it reads
the last snapshot in `drizzle/meta/` + the current `drizzle/schema.ts` and
produces SQL; it does not need to connect to a real database, unlike
`drizzle-kit migrate`, which actually applies migrations against
`DATABASE_URL`) - verified it runs successfully in this sandbox with no
live database available.

**`drizzle/0026_add_homepage_performance_indexes.sql`** (generated, not
hand-edited):

```sql
CREATE INDEX `episodes_isPublished_createdAt_idx` ON `episodes` (`isPublished`,`createdAt`);--> statement-breakpoint
CREATE INDEX `novels_publicationStatus_createdAt_idx` ON `novels` (`publicationStatus`,`createdAt`);--> statement-breakpoint
CREATE INDEX `purchases_novelId_idx` ON `purchases` (`novelId`);
```

Three plain `CREATE INDEX` statements, each independent (no `ALTER TABLE`
touching column types, no data migration, no `DROP`). `drizzle/meta/
_journal.json` and `drizzle/meta/0026_snapshot.json` were also generated
by the same command, so the migration is tracked exactly like every other
migration in this repo's history (`0000` through `0025`).

**Rollback**: `drizzle-kit` doesn't auto-generate a "down" migration for
this dialect/version - if these indexes ever need to be reverted, the
exact, safe rollback SQL is:

```sql
DROP INDEX `episodes_isPublished_createdAt_idx` ON `episodes`;
DROP INDEX `novels_publicationStatus_createdAt_idx` ON `novels`;
DROP INDEX `purchases_novelId_idx` ON `purchases`;
```

Dropping an index is always safe (never touches data, only a lookup
structure) and would simply return read performance to its pre-migration
state for the affected queries - it cannot cause data loss.

**Table locking**: on MySQL 5.6+/8.0 with the InnoDB engine (the default,
and consistent with everything else in this schema), `CREATE INDEX` uses
the **online DDL / `ALGORITHM=INPLACE`** path by default for a plain
secondary index like these three - readable and writable throughout,
except for a brief metadata lock at the very start/end. This is stated as
an expectation based on standard modern MySQL/InnoDB behavior, **not**
verified against the actual production database version/configuration,
which this sandbox has no access to - see PART H for the explicit
migration-risk framing.

## PART D — Query correctness tests

`server/homepage-ranking.test.ts` (new), 4 tests covering all of this
task's required assertions:

1. **`getPopularNovels`**: only published novels returned (archived
   excluded), purchase count correct (2 distinct purchasers → `2`),
   wishlist count correct (1 → `1`), a novel with zero purchases/wishlists
   shows `0` (never null/undefined), output shape has every
   `NovelWithCounts` field.
2. **`getNewNovels`/`getFreeNovels`/`getFinishedNovels`**: only published
   novels returned; `purchaseCount`/`wishlistCount` are always `0` (never
   null) even when the novel genuinely has purchases/wishlists (proving
   they no longer affect these 3 sections at all, by design);
   `freeEpisodeCount` still correctly reflects real data;
   results never exceed the requested limit.
3. **`getFreeNovels`** additionally excludes a published novel with zero
   free episodes (the `INNER JOIN ... count > 0` filter still works).
4. **`getLatestEpisodes`** (the bug fix): a visible/published episode
   appears; a `isPublished: false` draft episode does not; an episode
   belonging to an `archived` novel does not.

All 4 tests are DB-integration tests guarded with `if (!db) return`
(this repo's established pattern for every DB-dependent test throughout
this whole engagement) - genuine no-ops, not false passes, in this
sandbox's DB-less environment; they run for real the moment a
`DATABASE_URL` is available.

Section order and "duplicate novel" behavior weren't given their own
tests: section order is guaranteed by `Promise.all`'s array-order contract
(a language guarantee, not something this codebase's logic could break),
and no code path in this phase introduces any way for the same novel row
to appear twice within one section's result (each function still queries
`novels` directly with `novels.id` as the implicit dedup boundary, exactly
as before).

## PART E — Regression checks performed

- **Homepage loading incompletely / covers missing**: verified via
  Playwright against a mocked `home.getSections` response - all 6 sections
  rendered with the expected item counts and cover images (see PART G).
- **Stats null instead of 0**: `purchaseCount`/`wishlistCount` are always
  explicit `0` (via `sql<number>\`0\`` in the SQL, matching the pre-
  existing `freeEpisodeCount: 0` placeholder pattern already used in this
  exact codebase) - never `null`/`undefined`. Covered by
  `homepage-ranking.test.ts`.
- **Ranking criteria swapped**: `getPopularNovels`'s ORDER BY is
  byte-for-byte unchanged except for the added trailing tie-breaker
  column.
- **Duplicate novels**: not possible - see PART D.
- **Section empty when an aggregate is missing**: `getFreeNovels`'s
  `INNER JOIN` + `count > 0` filter is unchanged; a novel simply isn't
  eligible if it has no free episodes, exactly as before.
- **bigint/decimal/date serialization**: no column types changed (indexes
  only), no new `sql<>` cast types introduced beyond the existing
  `sql<number>` pattern already used throughout this file.
- **tRPC response type**: `home.getSections`'s return object literal shape
  is unchanged (`{ popularNovels, newNovels, freeNovels, latestEpisodes,
  finishedNovels, banners }`, each still `NovelWithCounts[]` /
  `LatestEpisode[]` / `Banner[]`) - verified via `pnpm check` (tRPC's
  inferred types would fail to compile client-side if this had drifted)
  and via a live curl against the built production server confirming the
  exact same top-level JSON keys are present (see PART G).
- **Admin/other pages using the same helpers**: confirmed via grep that
  `getPopularNovels`/`getNewNovels`/`getFreeNovels`/`getFinishedNovels`/
  `getLatestEpisodes` have exactly one caller each (`home.getSections`) -
  no admin page or other procedure could be affected by these changes.
  `getCatalogNovels` (a similarly-structured but separate, unused legacy
  function with its own independent purchase/wishlist subqueries) and
  `getBrowseCatalog` (the actively-used `/novels` browse endpoint, already
  optimized in an earlier phase) were both deliberately left untouched -
  out of this phase's explicit "homepage" scope, and touching either would
  risk something beyond what was audited here.
- No new helper was exported that isn't already covered by the point
  above (`getNovelSeoData`/`getNovelsByIdsLite`/etc. from earlier phases
  are untouched; this phase added no new exported db.ts functions at all -
  only modified the bodies of 4 existing ones and fixed a 5th's filter).

## PART F — Lightweight timing (dev-only)

`server/_core/productionMonitoring.ts` and `server/_core/requestLogging.ts`
both already exist in this repo but **neither is actually wired into the
tRPC request pipeline anywhere** (confirmed via grep - their `logRequest`/
`recordQuery` exports are never called). Wiring either in now would mean
touching shared middleware that runs for every procedure, not just this
one query - judged out of scope and riskier than necessary for "add a
timing log to one endpoint." Instead, `home.getSections` got a self-
contained, 4-line, `NODE_ENV`-gated `console.log` using `Date.now()` -
never runs in production, never logs user data, never logs SQL parameters,
adds no new files/infrastructure. Verified live (PART G) - produced
`[home.getSections] resolved in 17ms` in the dev server console.

## PART G — Validation

- **`pnpm check`** - passed, no errors (after every change in this phase).
- **`pnpm test`** (targeted re-runs, full pre-existing sandbox limitation
  noted below) - `server/homepage-ranking.test.ts` (4/4, DB-guarded no-ops
  in this sandbox as designed), plus re-ran `server/services/
  serverSeoRenderer.test.ts` (25/25), `server/_core/sitemap.test.ts` (9/9),
  `server/_core/canonicalDomainRedirect.test.ts` (18/18), `server/
  services/mediaMigrationService.test.ts` (12/12) to confirm zero
  regression to every earlier phase's work.
- **`pnpm build`** - passed (`dist/index.js` built with all Phase 3
  changes bundled).
- **Playwright, mocked `home.getSections`/`novels.detail`/`myNovels.list`/
  admin responses, against a running dev server** (10/10 checks passing):
  - Homepage: all 6 sections' novel-card links present (7 expected from
    the mock data: 2+2+1+1+1), banner image visible, cover images render,
    zero console errors (after eliminating this sandbox's known,
    pre-existing analytics-placeholder noise, confirmed by adding the
    missing `VITE_ANALYTICS_*` env vars and re-running - the errors
    disappeared entirely, proving they were unrelated to this phase).
  - Novel detail: opens correctly, Phase 1/2's client-side title/canonical
    hook still fires correctly on this page (`useDocumentHead` untouched
    by this phase, confirmed still working) - proving Phase 1/2's SEO work
    survived this phase's `db.ts`/`schema.ts` changes intact.
  - `/my-novels`: renders the mocked purchased novel correctly - confirmed
    the unrelated Phase 1 N+1 fix (`myNovels.list`) still works.
  - Admin dashboard: opens, no migration/schema error, zero console
    errors (same noise-elimination confirmation as homepage).
- **Production-like server** (`NODE_ENV=production node dist/index.js`,
  the actual built output, not `tsx`/dev mode):
  - `GET /` → `200`.
  - `GET /api/trpc/home.getSections` → `200`, JSON body with all 6 keys
    (`popularNovels, newNovels, freeNovels, latestEpisodes,
    finishedNovels, banners`) present - confirms the output shape
    contract holds even with no live DB (each function's own `if (!db)
    return []` guard fires cleanly, `home.getSections` never throws).
  - `GET /novels` → still returns Phase 2's correct SSR-injected
    `<title>รายการนิยาย | IpeNovel</title>` and
    `<link rel="canonical" href="https://ipenovel.com/novels">` -
    confirms Phase 2's server-side metadata injection is completely
    unaffected by this phase's `db.ts`/`schema.ts` changes.
- **Before/after query count**: 6 round trips before, 6 round trips after
  (unchanged - the optimization is in aggregation count, not round-trip
  count, see PART A). **Before/after aggregation count**: 9 embedded
  `GROUP BY` subqueries before, 3 after (a code-verifiable fact, not a
  timing measurement). **Response time**: not measured in either
  direction (no live database in this sandbox) - not claimed, per this
  task's explicit instruction against citing unmeasured numbers.

## PART H — Migration safety report

1. **Indexes added**: `novels_publicationStatus_createdAt_idx` on
   `novels(publicationStatus, createdAt)`; `episodes_isPublished_createdAt_idx`
   on `episodes(isPublished, createdAt)`; `purchases_novelId_idx` on
   `purchases(novelId)`. Full reasoning for each in PART C above.
2. **Migration file**: `drizzle/0026_add_homepage_performance_indexes.sql`
   (shown in full in PART C) + the accompanying `drizzle/meta/
   0026_snapshot.json` and updated `drizzle/meta/_journal.json`, all
   generated by `drizzle-kit generate` (this repo's existing framework).
3. **Tables locked**: `novels`, `episodes`, `purchases` - each briefly, at
   most (see below); no other table is touched by this migration.
4. **Production deployment risk**: **low**, with one caveat this report
   states plainly - the exact lock behavior depends on the production
   MySQL version/engine, which this sandbox cannot verify (see PART C's
   "Table locking" note). All 3 statements are plain `CREATE INDEX` on
   existing columns - no type changes, no data backfill, no `ALTER TABLE
   ... MODIFY`.
5. **Maintenance window**: not believed to be required for modern
   MySQL/InnoDB (5.6+/8.0, the de facto standard and consistent with the
   rest of this schema's engine assumptions) given online-DDL support for
   plain secondary index creation - but since the production version
   wasn't verified from this sandbox, running the two commits (see #7
   below) during a lower-traffic window is still the safer choice the
   first time, purely as a precaution rather than a known requirement.
6. **Rollback**: the 3 `DROP INDEX` statements given in full in PART C -
   always safe, never touches data, worst case simply returns read
   performance to its pre-migration baseline.
7. **Migration duration**: **not measured** (no production-sized table to
   test against from this sandbox) - stated as an estimate only: `CREATE
   INDEX` duration scales with the target table's row count and, for
   `episodes` (likely the largest table here), could take longer than the
   other two if that table has grown large in production. No specific
   number is given because none was measured, per this task's explicit
   instruction.
8. **Deploy order / commit split**: **not split into 2 commits**. Both the
   query optimization (PART B) and the index migration (PART C) are low-
   risk on their own merits - the query changes only remove already-dead
   computation and add a filter that only *narrows* an already-buggy
   result set (never expands it), and the index migration is 3 additive,
   non-blocking `CREATE INDEX` statements with a trivial rollback. Neither
   depends on the other to be safe or correct independently, but keeping
   them in one commit/PR keeps the "why" (the audit) next to the "what"
   (the fix) - judged clearer than an artificial split for changes this
   size. If the user prefers to `Sync from GitHub` and deploy the query
   change first, then the index migration separately, that's equally
   valid; the query optimization does not require the new indexes to be
   correct (it only benefits from them being present).
9. **How to verify indexes exist after deploy**:
   ```sql
   SHOW INDEX FROM novels WHERE Key_name = 'novels_publicationStatus_createdAt_idx';
   SHOW INDEX FROM episodes WHERE Key_name = 'episodes_isPublished_createdAt_idx';
   SHOW INDEX FROM purchases WHERE Key_name = 'purchases_novelId_idx';
   ```
   Each should return exactly one row. Manus's deploy step runs
   `drizzle-kit migrate` (via this repo's existing `db:push` script/deploy
   process) against the real `DATABASE_URL` - watch the deploy logs for
   `0026_add_homepage_performance_indexes` being applied without error.
10. No `DATABASE_URL` or any other secret appears anywhere in this
    report, in the generated migration file, or in the diff for this
    phase.

## PART I — Deliverable summary

1. **Baseline**: 6 DB round trips per `home.getSections` call (unchanged);
   9 embedded `GROUP BY` aggregations, of which only 3 were ever used
   (see PART A). No live-DB timing/EXPLAIN was available in this sandbox -
   stated honestly rather than invented.
2. **Root cause**: 3 of 4 homepage ranking functions computed purchase/
   wishlist counts via `GROUP BY` joins that were never used for sorting
   or display - confirmed by both code inspection (sort columns) and a
   full-client grep (display usage). Separately, `getLatestEpisodes` had
   no visibility filter at all (a correctness bug, not a performance one).
3. **Optimization**: removed the 6 unused aggregations from `getNewNovels`/
   `getFreeNovels`/`getFinishedNovels`; added `id` tie-breakers to all 4
   ranking functions + `getLatestEpisodes`; fixed `getLatestEpisodes`'s
   missing `isPublished`/`publicationStatus` filter.
4. **Indexes added**: 3, each with query-level evidence (PART C) - 2 of
   the task's 4 suggested candidates turned out to already exist and were
   correctly *not* duplicated.
5. **Query count before/after**: 6 → 6 (unchanged; the fix targets
   aggregation cost, not round-trip count - see PART A for why).
6. **DB round-trips before/after**: 6 → 6 (same as above).
7. **Response time before/after**: not measured (no live DB in this
   sandbox) - see PART A/G.
8. **Files added**: `server/homepage-ranking.test.ts`,
   `drizzle/0026_add_homepage_performance_indexes.sql`,
   `drizzle/meta/0026_snapshot.json`. **Files modified**: `server/db.ts`
   (4 ranking functions + `getLatestEpisodes`), `server/routers.ts` (dev
   timing log only), `drizzle/schema.ts` (3 new index declarations),
   `drizzle/meta/_journal.json`, `docs/PERFORMANCE_SEO_AUDIT.md` (this
   section).
9. **Tests added**: 4 in `server/homepage-ranking.test.ts` (PART D).
10. **Check/test/build results**: all passed - see PART G.
11. **Migration risk**: low (3 additive, non-blocking `CREATE INDEX`
    statements) - full detail in PART H.
12. **Rollback plan**: 3 `DROP INDEX` statements, given in full in PART C
    and PART H.
13. **Deliberately not changed**: `getPopularNovels`'s ranking
    criteria/subqueries (still needed), `getCatalogNovels`/
    `getBrowseCatalog` (out of homepage scope), section names, item
    limits (except the bug-fix eligibility narrowing), pagination
    architecture, any business/authorization logic, Redis (not added),
    the existing single-column indexes (not removed, even where now
    partially redundant - see PART C).
14. **Output shape**: unchanged - confirmed via `pnpm check` (tRPC type
    inference), a live curl of the built production server's
    `home.getSections` response showing all 6 original keys, and
    `homepage-ranking.test.ts` asserting every `NovelWithCounts` field is
    still present.
15. **Business logic**: unchanged - ranking criteria, visibility rules
    (novels' `publicationStatus`), authorization, purchase/wallet/cart/
    order/reader-entitlement logic are all untouched; the one behavior
    change (`getLatestEpisodes`'s filter) is a bug fix bringing it in line
    with the visibility rule every other homepage section already
    enforces, not a new rule.
16. **Secrets**: confirmed none in this document, the migration file, or
    the diff for this phase.
17. **Commit hash**: see the commit this section was pushed with.
18. **Pushed to `origin/main`**: yes - deploy from Manus (Sync from
    GitHub → Deploy), not from here.

---

## Phase 4 — Novel Listing Pagination and Payload Reduction

### PART A — Audit findings (baseline, from real code)

`/novels` (`client/src/pages/NovelsPage.tsx`) → `novels.browse`
(`server/routers.ts`) → `getBrowseCatalog` (`server/db.ts`) →
`NovelCard` (`client/src/components/NovelCard.tsx`).

An earlier task in this project (the "/novels URL-sync and performance"
work, before this audit doc existed) had already done real DB-level
pagination and DTO trimming here, so the baseline is better than a typical
unoptimized listing page. This audit's job was to find what was still
wrong, not to assume the worst.

1. **Fetch all vs paginated**: already paginated in the DB (`LIMIT`/
   `OFFSET`, computed from `page`/`pageSize` in the router). Not a
   fetch-everything-then-slice pattern.
2. **Rows per request**: `pageSize`, default 20, capped at 100 by the
   router's zod schema (`z.number().int().min(1).max(100).optional()`).
3. **Fields fetched**: `id, title, slug, coverImageUrl, storyStatus,
   createdAt, freeEpisodeCount` only - already a lean, card-specific
   `SELECT`, not `SELECT *`.
4. **Unused fields sent to the frontend**: none found. Every field in the
   DTO is read by `NovelsPage.tsx`'s render loop (`id`, `title`,
   `coverImageUrl`, `storyStatus` for the badge, `freeEpisodeCount` for
   the Free badge) or by `NovelCard`/routing (`slug` isn't currently
   rendered by the card - see PART E for the decision to keep it anyway).
5. **Episode content / long description / internal columns**: none
   present. No episode table join for content, no `description`, no admin
   flags, no pricing, no `deletedAt`.
6. **Count aggregations**: `sort=popular` joins two `GROUP BY` subqueries
   (distinct purchasers, distinct wishlisters) purely for ranking - never
   exposed to the client. No `COUNT(*)` of the total result set existed,
   and this phase deliberately keeps it that way (see PART D).
7. **Pagination location**: DB (`.limit()/.offset()`), not client-side
   slicing.
8. **Search/filter/sort location**: DB (`WHERE`/`LIKE`/`ORDER BY`), not
   client-side `.filter()`/`.sort()`.
9. **Approximate payload**: measured via fixture in PART I (no live
   `DATABASE_URL` in this sandbox - static inspection + fixture data only,
   per this task's own instructions; no invented numbers).
10. **DB round-trips**: 1 per `novels.browse` call (the popular-sort
    subqueries are joined into the same query, not separate round-trips).

**Real gaps found (the actual reason this phase has work to do):**

- **`page` and `search` were never written to the URL.** `currentPage`
  was local `useState(1)`, and `searchTerm`/`debouncedSearch` never
  touched `useSearchParams()` at all - only `sort`/`filter`/`storyStatus`
  did. A refresh on page 3 silently dropped back to page 1;
  `/novels?search=naruto` had no effect because the search box read
  nothing from the URL; browser back/forward could not move between
  pages. This is the central problem PART C through PART G address.
- **`hasNextPage` was computed client-side as `novels.length ===
  PAGE_SIZE`.** Wrong whenever the true remaining count is an exact
  multiple of the page size - e.g. exactly 40 novels total with
  `pageSize=20`: page 2 returns a full 20-row page, so the old check
  reports `hasNextPage: true`, and clicking Next lands on an empty page
  3. Fixed in PART D with a real `limit+1` fetch-ahead.
- **No `id` tie-breaker in either `ORDER BY`.** `sort=new` ordered by
  `createdAt` alone, `sort=popular` by purchase/wishlist counts then
  `createdAt` alone - ties (same `createdAt` second, or same score) have
  no guaranteed stable order across two requests, which can duplicate or
  skip rows across a page boundary. This is exactly the failure mode
  Phase 4's goal #7 ("no jumping/duplicate/missing items") calls out.
- **Search `LIKE` pattern didn't escape `%`/`_`.** Parameterized already
  (no SQL injection risk), but a user searching for a title containing a
  literal `%` or `_` would get it silently reinterpreted as a wildcard -
  a correctness bug, not a security one.
- **No error state.** `NovelsPage.tsx` handled `isLoading` and an empty
  result, but never `isError` - a failed request just rendered nothing
  useful.
- **Server-side SEO metadata (`serverSeoRenderer.ts`) ignored the query
  string entirely** for `/novels`, always returning the exact same
  canonical/robots regardless of `page`/`sort`/`search`. This already
  *matched* the client hook's deliberate policy (see PART C) for
  canonical, but had no robots differentiation at all.

### PART B — Pagination model: offset (not cursor), and why

**Offset pagination was chosen.** Reasoning, evidenced against the actual
code rather than a default preference:

- The implementation is already offset-based end to end (router computes
  `offset = (page - 1) * pageSize`; `getBrowseCatalog` already took
  `limit`/`offset`). Migration risk of *staying* offset is zero - no
  schema change, no new columns.
- The existing UI shows literal page numbers ("Page N" with Previous/
  Next) and the task requires shareable URLs shaped `?page=2`, `?page=3`.
  Offset pagination maps directly onto "page number in the URL"; cursor
  pagination would need either an opaque cursor token in the URL (which
  breaks the "type `/novels?page=2` by hand" shareability requirement) or
  a page-index-to-cursor lookup table that doesn't exist and isn't
  justified by anything else in this task.
- `sort=popular`'s ranking key is a *computed* value from a joined
  subquery (`COALESCE(purchaseCount, 0)`, `COALESCE(wishlistCount, 0)`),
  not a stable stored column. A correct cursor for this sort would need
  to encode and validate a 4-tuple `(purchaseCount, wishlistCount,
  createdAt, id)` from an untrusted client-supplied cursor - meaningfully
  more implementation and validation surface than the offset path, for a
  sort mode that isn't a high-write-throughput feed where cursor's
  main advantage (stability under concurrent inserts) would matter.
- This is a novel catalog, not a real-time/infinite social feed - total
  row counts are bounded and `pageSize` is capped at 100, so offset's
  known weakness (deep-`OFFSET` scans) is a standard, well-understood,
  low-risk tradeoff here, not a proven problem. `novels(publicationStatus,
  createdAt)` (added in Phase 3) already narrows the scan before the
  offset is applied.

Cursor pagination was **not** picked "because offset is easier" - it was
rejected because it would fight the existing page-numbered UI and
`?page=N` URL requirement, add real cursor-validation complexity for the
computed `popular` ranking, and buy nothing this catalog actually needs.

### PART C — URL and SEO

`client/src/lib/seo.ts`'s `buildCanonicalUrl()` already strips query
strings unconditionally, and `NovelsPage.tsx` already had an explicit,
documented policy from the earlier URL-sync task: every `/novels` query
variant (`sort`, `filter`, `storyStatus`, and now `page`/`search`)
canonicalizes to the bare `https://ipenovel.com/novels` - they're view
variants of the same catalog, not distinct pages, so index weight isn't
fragmented across dozens of query combinations. This phase kept that
policy unchanged on both sides (client hook and
`server/services/serverSeoRenderer.ts`) rather than relitigating an
already-made, already-documented decision - and title/description stay
static for the same reason: the client hook never varied them by query
either, and making only the server dynamic would create exactly the
client/server drift Phase 2 was built to avoid.

What *did* change: the server-side `/novels` branch now parses the query
string (previously discarded before any matching happened) to set
`robots: "noindex,follow"` for the two genuinely thin/duplicate cases:

- `?search=...` (non-empty) - internal site search results.
- `?page=2` and beyond - deferred entirely to the canonical's index
  weight; `?page=1` (explicit or omitted) is unaffected.

Plain `/novels`, and any combination of `sort`/`filter`/`storyStatus` at
page 1 with no search term, stay indexable with no `robots` tag (the
crawler default) - unchanged from before. Verified live via `curl` in
PART K and covered by `server/novels-browse-pagination.test.ts`.

### PART D — Backend query changes

In `getBrowseCatalog` (`server/db.ts`):

- Added `desc(novels.id)` as the final tie-breaker to both `ORDER BY`
  clauses (`sort=new`: `createdAt DESC, id DESC`; `sort=popular`:
  `purchaseCount DESC, wishlistCount DESC, createdAt DESC, id DESC`).
- Replaced the buggy client-side `hasNextPage` heuristic with a real
  `limit + 1` fetch-ahead: the query now asks for `limit + 1` rows: if
  more than `limit` come back, `hasNextPage: true` and the extra row is
  sliced off before returning; otherwise `false`. No `COUNT(*)` query was
  added - the UI only ever needs to enable/disable "Next", never a total
  page count, so a full-table-scanning count query would be pure waste.
  Return shape is now `{ items: BrowseCatalogNovel[], hasNextPage:
  boolean }` instead of a bare array (all call sites, including
  pre-existing test files, were updated to match - see PART H).
- Escaped `%`/`_`/`\` in the user's search term before building the
  `LIKE` pattern (`escapeLikePattern`, with an explicit `ESCAPE '\\'`
  clause) so a literal `%` or `_` in a search term matches literally
  instead of being reinterpreted as a wildcard. The query was already
  parameterized, so this is a correctness fix, not a security fix.
- `search` was already trimmed; the router's zod schema now also caps it
  at 100 characters (`z.string().max(100)`).
- WHERE/visibility filtering (`publicationStatus = "published"`,
  optional `storyStatus`, optional free-episode `EXISTS`) is unchanged -
  archived/draft novels still never leak, verified by the existing
  `server/browse-catalog-fix.test.ts` (updated for the new return shape,
  not touched in logic).
- **No new index added.** The existing `novels(publicationStatus,
  createdAt)` composite (added in Phase 3) already covers `sort=new`'s
  `WHERE`+`ORDER BY`. `storyStatus` is a 2-value column filtered *after*
  `publicationStatus` has already narrowed the row set - not worth a new
  composite without evidence of it being a real bottleneck, consistent
  with Phase 3's established "only add what's clearly evidenced" policy.
  Leading-wildcard `LIKE '%term%'` search can never use a B-tree index
  regardless of columns, so no index change helps or was attempted for
  it. `sort=popular`'s subqueries already benefit from Phase 3's
  `purchases(novelId)` index and the pre-existing `wishlists_novelId_idx`.
  **Migration risk: none - no migration was needed for this phase.**

### PART E — DTO / payload

The DTO was already lean from the earlier URL-sync task and needed no
field changes - see PART A finding #3/#4. It was formalized as an
exported `BrowseCatalogNovel`/`BrowseCatalogResult` TypeScript interface
in `server/db.ts` (previously an inline return-type annotation) so the
shape has a single, named source of truth. `slug` is fetched but not yet
rendered by `NovelCard`/`NovelsPage.tsx` - kept rather than dropped,
since it's cheap (part of the primary row, no extra join) and is exactly
the kind of field a future "pretty URL" change would need; removing then
re-adding it would be pure churn. `novels.detail` (the full novel-detail
DTO) is untouched and was never at risk of being pointed at this lean
type.

### PART F/G — Frontend pagination UI, URL sync, search/filter validation

`NovelsPage.tsx` already had Previous/Next buttons with a "Page N" label
(no total-page-count UI) - kept as-is (matches PART D's decision not to
fetch a total count) rather than introducing a compact page-number range
the design never asked for. Changes:

- `page` now lives entirely in the URL (`searchParams.get("page")`,
  parsed with `parseInt`, invalid/non-positive values fall back to 1) -
  never local `useState`. `goToPage()` writes the new page into the URL
  via `setSearchParams` (omitting the param entirely for page 1, to keep
  `/novels` clean rather than `/novels?page=1`) and scrolls to top.
- `search` is now written to the URL after the existing 500ms debounce
  (unchanged debounce - it already existed), normalized to omit the
  `search` param entirely when empty/whitespace-only. Browser back/
  forward changes to `?search=` resync the visible input via a
  dedicated effect keyed on the URL value, without re-triggering the
  debounce (only local typing debounces).
- Changing sort, filter, storyStatus, or search all reset `page` to 1 by
  deleting the `page` param in the *same* `setSearchParams` update
  (never a separate history entry, never an accumulated/duplicate query
  param - `URLSearchParams.set()`/`.delete()` always replace in place).
- `hasNextPage` now comes directly from the server response
  (`data.hasNextPage`) instead of the buggy client-side heuristic.
- Added an error state (message + a "ลองใหม่อีกครั้ง" retry button calling
  `refetch()`) - previously missing entirely.
- `<nav aria-label="Pagination">` wraps the Previous/Next controls;
  `aria-current="page"` on the page label. Deliberately did **not** add
  `aria-label` overrides to the Previous/Next buttons themselves - an
  earlier draft of this change did, and Playwright verification (PART K)
  caught that it silently violates WCAG 2.5.3 (Label in Name): an
  `aria-label` with *different* text than the visible label breaks
  voice-control and `getByRole`/testing-library-style lookups by the
  visible text. "Previous"/"Next" are already clear as-is.
- Query key (`queryInput`, passed straight into
  `trpc.novels.browse.useQuery`) already included every relevant
  parameter (`sort`, `filter`, `storyStatus`, `search`, `page`,
  `pageSize`) from the earlier URL-sync task - unchanged, still correct
  now that `page`/`search` are URL-derived instead of state-derived.
  `placeholderData: keepPreviousData` (unchanged) never shows the wrong
  page's data labeled as current - `isFetching` (not `data`) is what
  flags an in-flight background fetch.
- Sort (`z.enum(["new","popular"])`) and storyStatus
  (`z.enum(["ongoing","finished"])`) were already whitelist-only via
  zod; unrecognized values are rejected by the router (verified in PART
  H), not silently coerced.

### PART H — Tests

New file `server/novels-browse-pagination.test.ts` (27 tests, all
passing): input-validation rejections (invalid/negative/non-integer
`page`, `pageSize` over 100, unknown `sort`/`storyStatus`, search over
100 chars - all run unconditionally, no DB needed, since rejection
happens before any query executes), `escapeLikePattern` pure-function
tests (`%`, `_`, backslash, Thai text), server-side SEO robots-policy
tests for `/novels` query variants (no DB needed - that branch never
queries), and DB-guarded (`if (!db) return`) tests for `hasNextPage`
correctness at both ends, page-to-page non-duplication, `id`
tie-breaker determinism, ordering stability across repeated identical
queries, combined search+filter+sort, and the DTO's exact field set.

Three pre-existing test files (`server/browse-catalog-fix.test.ts`,
`server/browse-performance.test.ts`, `server/story-status-sync.test.ts`)
called `getBrowseCatalog` expecting the old bare-array return - updated
all 24 call sites to destructure `{ items }` (mechanical, not a logic
change). While there, fixed two pre-existing, unrelated test defects in
`browse-performance.test.ts` that predate this phase: an assertion
checking for a `status` property that has never existed on this DTO
(the field is `storyStatus`), and an assertion assuming `sort=popular`
orders by `freeEpisodeCount` when the actual (and correct) ranking has
always been purchase/wishlist counts.

Frontend URL-sync/pagination behavior (query string sync, sort/search
resetting page, browser back/forward, empty/error states, no old/new
page mixing) was verified via an ad-hoc Playwright script against the
dev server with mocked tRPC responses - the project has no committed
Playwright config/dependency, so following the pattern established in
Phases 1-3, this was verification tooling (see PART K), not a committed
test file.

### PART I — Performance validation (fixture-based; no live `DATABASE_URL` in this sandbox)

Honesty note, per this task's own instructions: no live database was
available to measure real query timings, so nothing below is a real
production number. What follows is either (a) a deterministic fact about
the code (rows fetched, round-trips, query count - these don't need a
database to reason about, they're what the code literally does), or (b)
an explicitly-labeled fixture-based byte measurement.

- **Rows fetched from the DB per request**: `pageSize + 1` (the `limit+1`
  fetch-ahead from PART D) - one more than before this phase's
  `hasNextPage` fix, but that extra row is sliced off before the
  response leaves `getBrowseCatalog` and is never sent to the client.
  This is a deliberate, worthwhile tradeoff: +1 row from the DB avoids a
  separate `COUNT(*)` that would scan the entire matching set.
- **DB round-trips per request**: 1 (unchanged - the popular-sort
  subqueries are joined into the same query, not separate round-trips).
- **Query count**: 1 (unchanged - still no separate count query).
- **Response payload (fixture-based, 20 items)**: the DTO fields didn't
  change (already lean from the earlier URL-sync task - see PART A/E),
  so the wire payload is essentially unchanged by this phase. Measured
  with a 20-item fixture matching the real field shapes: the old bare
  array serializes to **6,305 bytes**; the new `{ items, hasNextPage }`
  wrapper serializes to **6,334 bytes** - a **29-byte (0.46%) increase**
  from the wrapper object and the boolean field, not a reduction. For
  contrast (illustrative only - **not** this repo's actual prior state,
  since the DTO was already trimmed before this phase), a hypothetical
  unoptimized full-row response for the same 20 items (description,
  author, storage keys, pricing, etc.) serializes to **72,645 bytes** -
  the real "payload reduction" work for this listing page was already
  done in the earlier URL-sync task; this phase's job was pagination
  *correctness* and *URL-shareability*, not further DTO trimming (there
  was nothing left to trim).
- **Frontend render item count**: unchanged, `pageSize` (20) cards per
  page, same as before.

### PART J — Compatibility

`getBrowseCatalog` has exactly one caller (`novels.browse`), which has
exactly one caller (`NovelsPage.tsx`) - confirmed via a repo-wide grep
before making any change, so the blast radius of this phase's backend
change is contained to this one page. `pnpm check` passing clean across
the whole repo is strong additional evidence nothing else silently broke
on the type-shape change. Regression-verified live (dev server + mocked
tRPC, Playwright, reusing/adapting the Phase 3 verification script) for
Home (novel cards, banner, cover images, no console errors), Novel
Detail (title/canonical still correct, page renders), `/my-novels`
(purchased novel renders), and Admin dashboard (opens, no console
errors) - all 10/10 checks passed, no change from Phase 3's baseline.
`sitemap.xml` (`getPublishedNovelsForSitemap`) and the Reader
(`reader.getEpisode`) don't call `getBrowseCatalog` at all and were not
touched.

### PART K — Validation commands

- **`pnpm check`**: passed, no errors.
- **`pnpm test`**: 872 passed, 200 failed, 224 skipped - identical
  totals before and after this phase's changes (confirmed by running the
  full suite twice). Every failure is pre-existing and DB-connectivity-
  related (`Error: Database not available` from `beforeAll`/procedure
  calls, in files unrelated to `/novels`) - this sandbox has no
  `DATABASE_URL`, and these files were never guarded for that, unlike
  this repo's established `if (!db) return` convention. Isolated runs of
  every file this phase touched or added
  (`novels-browse-pagination.test.ts`: 27/27 passed;
  `browse-performance.test.ts`: 8/8 passed; `browse-catalog-fix.test.ts`
  and `story-status-sync.test.ts`: fail in an unguarded `beforeAll` that
  calls `db.createNovel` directly - pre-existing, unrelated to this
  phase's `.items` shape fix, confirmed by inspecting their `beforeAll`
  hooks) confirm no regression was introduced.
- **`pnpm build`**: succeeded (`vite build` + `esbuild` for the server
  bundle). Pre-existing warnings only (missing `VITE_ANALYTICS_*` env
  vars when built outside a real environment, and a >500kB main chunk
  warning) - both predate this phase.
- **Production-mode curl verification** (`NODE_ENV=production node
  dist/index.js`): `GET /novels` → 200, `<title>รายการนิยาย | IpeNovel
  </title>`, canonical `https://ipenovel.com/novels`, no `robots` tag.
  `GET /novels?page=2` → 200, same canonical, `<meta name="robots"
  content="noindex,follow" />`. `GET /novels?sort=popular` (page 1, no
  search) → same canonical, no `robots` tag (still indexable). tRPC
  `novels.browse` with `page=1` → `{"items":[],"hasNextPage":false}`
  (empty because this sandbox has no live DB - correct shape, correct
  fallback). tRPC `novels.browse` with `page=0` → HTTP 400 (zod
  rejection, as designed). No duplicate meta tags observed in any
  response.
- **Playwright verification** (dev server + mocked `novels.browse`
  responses, since no live DB): **18/18 checks passed** - initial
  `/novels` has no `page` param; Next navigates to `?page=2` then
  `?page=3`; refreshing `/novels?page=3` stays on page 3 and shows "Page
  3"; browser back moves `3 → 2 → 1` (page 1 shown as bare `/novels`);
  directly opening `/novels?page=2` loads page 2 (shareable); changing
  sort clears `page` and sets `sort=popular`; typing a search term adds
  `?search=` and clears `page`; reloading a `?search=...` URL
  repopulates the search box; empty result set shows the empty state;
  a **persistently** failing `novels.browse` (not just once - see the
  script's comment on why a single-failure mock doesn't actually
  exercise the error path under react-query's default `retry: 3`) shows
  the error state with a working retry button; Previous is disabled on
  page 1; and page content genuinely changes after Next (not the old
  page's items redisplayed). The separate Phase 3 regression script
  (Home/Detail/My Novels/Admin) was re-run against the same dev server:
  **10/10 checks passed**, unchanged from Phase 3.

### PART L — Deliverable summary

1. **Baseline before the fix**: see PART A - already DB-paginated and
   already DTO-trimmed from an earlier task, but `page`/`search` were
   never in the URL, `hasNextPage` was computed incorrectly client-side,
   and neither `ORDER BY` had a deterministic tie-breaker.
2. **Pagination model chosen and why**: offset (PART B) - matches the
   existing page-numbered UI and `?page=N` URL requirement; cursor
   pagination was rejected as added complexity (encoding/validating a
   computed-value cursor for `sort=popular`) with no benefit this
   catalog needs.
3. **API before/after**: `getBrowseCatalog` returned `Array<...>`
   before; now returns `{ items: BrowseCatalogNovel[], hasNextPage:
   boolean }`. `novels.browse`'s input schema is otherwise unchanged
   except `search` now capped at 100 characters.
4. **URL query scheme**: `/novels?sort=&filter=&storyStatus=&search=&page=`
   - `page=1` and empty `search` are both omitted from the URL rather
   than written explicitly.
5. **Canonical/noindex policy**: canonical always bare `/novels`
   (unchanged, pre-existing documented decision); `robots:
   noindex,follow` added server-side for `search` and `page>1` only.
6. **DTO fields kept**: `id, title, slug, coverImageUrl, storyStatus,
   createdAt, freeEpisodeCount` - unchanged from before this phase.
7. **Fields removed**: none this phase (already lean going in).
8. **Rows per request before/after**: `pageSize` (max 100) before →
   `pageSize + 1` fetched from the DB, `pageSize` returned to the client
   after (the extra row funds a correct `hasNextPage` without a
   `COUNT(*)`).
9. **Payload bytes before/after (fixture-based, 20 items)**: 6,305 →
   6,334 bytes (+29 bytes / +0.46%, from the response wrapper) - see
   PART I for why this phase intentionally didn't shrink the DTO
   further.
10. **DB round-trips before/after**: 1 → 1 (unchanged).
11. **Query count before/after**: 1 → 1 (unchanged - still no `COUNT(*)`).
12. **Indexes added**: none - PART D concluded, with reasoning, that no
    new index is evidenced by this phase's query pattern.
13. **Migration risk**: none - no migration was created.
14. **Tests added**: `server/novels-browse-pagination.test.ts` (27
    tests); 3 pre-existing test files updated for the new return shape
    plus 2 unrelated pre-existing defects fixed (see PART H).
15. **`pnpm check`**: passed, no errors.
16. **`pnpm test`**: 872 passed / 200 failed (pre-existing, DB-
    connectivity-only, unchanged count before/after) / 224 skipped.
17. **`pnpm build`**: succeeded.
18. **Playwright/curl verification**: 18/18 Playwright checks + 10/10
    regression checks + full curl verification, all passed (PART K).
19. **Deliberately not changed**: the DTO's field set (already lean);
    the client/server canonical-consolidation policy (already correct
    and documented); the Previous/Next-only pagination UI (no total-page
    UI, since no `COUNT(*)` is fetched); any file outside `/novels`'s
    call chain.
20. **Business logic confirmation**: unchanged - visibility rules
    (`publicationStatus = "published"`), archived/draft exclusion,
    free-episode detection, and popularity ranking criteria are all
    exactly as before; the only new SQL construct (`ESCAPE '\\'` on the
    `LIKE`) is a search-correctness fix, not a rule change.
21. **Secrets**: confirmed none in this document, the diff, or any file
    added/changed for this phase.
22. **Commit hash**: see the commit this section was pushed with.
23. **Pushed to `origin/main`**: yes - deploy from Manus (Sync from
    GitHub → Deploy), not from here.

---
No secrets appear in this document, in the diff, or in any file added/
changed for this phase. No business logic was changed except the
documented search-escaping correctness fix (not a rule change) and the
two pre-existing, unrelated test-assertion bugs fixed in
`browse-performance.test.ts` while updating its return-shape usage.

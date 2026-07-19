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

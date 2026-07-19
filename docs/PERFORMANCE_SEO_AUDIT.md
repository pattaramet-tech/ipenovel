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

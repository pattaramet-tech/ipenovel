# IPE-069 R1 — Public Storefront Visual Qualification (2026-10-08)
## Authority and exact baseline
- R0 approved: Premium Editorial / Light-first; public routes only.
- GitHub main, remote main and local origin/main: d1dac25d560fc3f5fd2a553fea1e836d415d71d3.
- Parent repo current branch remains fix/m29-5-11-master-intake-unchanged-restore; clean.
- Isolated worktree: .worktrees/ipe069-public-storefront-redesign on feat/ipe069-public-storefront-redesign.

## Browser evidence
- Read-only isolated Chrome/CDP, no protected tabs selected, no authenticated writes.
- Screenshots: home/catalog/detail at 1440, 768, 390, 320; fold + full = 24 PNG files.
- HTML and layout snapshots for every width, one browser event log.
- Captured outside repo at C:\Users\makel\AppData\Local\Temp\ipe069-baseline-20261008.
- Published sample detail: https://ipenovel.com/novels/4230170.
- No horizontal document overflow at the 12 measured viewports.
- 3 HTTP 400 responses to unresolved %VITE_ANALYTICS_ENDPOINT%/umami (pre-existing environment issue, excluded from frontend redesign).
- Homepage banner caption obscures embedded artwork; homepage does not expose a page-level h1.
- Catalog mixes English labels into Thai storefront; some novels have no cover and require fallback.
- Novel detail without a cover yields an overlarge empty region on desktop.
- Mobile menu opens, but its toggle lacked an accessible name and aria-expanded.

## Target Design
- Tokens: Canvas #F7F5F0, Surface #FFFFFF, Navy #172238, Gold #C7A36B, Accent Text #82551D, Secondary #657184, Border #E7E2D9, Focus #2859A2.
- Typography: existing Prompt; 1280px outer max width; mobile-first at 320-639 / 640-1023 / 1024+.
- Shared tokens are scoped to .ipe-public and .ipe-public-nav. No global Theme changes.
- Homepage: uncluttered image-first hero with caption outside artwork, strong h1, retained live existing sections.
- Catalog: search and filters remain URL-backed; page size 20; wishlist unchanged; 2-column mobile cards.
- Novel detail: balanced book-cover / fallback hero, clear metadata, searchable and sortable published packages.
- Navbar: route guards for /admin/* and /read/* unchanged, auth/cart/language/account recovery unchanged.
- Accessibility: single h1/page; menu aria name/expanded/controls, prominent focus outline, keyboard and reduced-motion.
- SEO: preserve useDocumentHead, canonical, open graph and structured data.
- Commerce: no changes to API contracts, database, payment, purchase/checkout, entitlement or reader.

## Qualification
- R1B visual evidence: PASS with recorded UX problems.
- R1C design qualification: PASS for approved frontend scope.
- Analytics 400 is a separately logged baseline issue, not permission to touch Production configuration.
- Required after implementation: npm run check, npm run build, npm run test:gate, npm run test:e2e:public, focused Cart/Wishlist/Auth/Nav/SEO/A11y regressions, candidate screenshot comparison.
- No merge or production deployment authorized.

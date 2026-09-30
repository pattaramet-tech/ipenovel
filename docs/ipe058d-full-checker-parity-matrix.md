# IPE-058-D Full Checker Parity Matrix

Baseline: `d9f2ecba88475c641291a6f29cedf9e89479d57a`
Legacy source audited: `code-google-sheets/Checker_Main.txt`
Target: pure TypeScript domain behavior only; no Apps Script/DocumentApp/SpreadsheetApp runtime port.

| Legacy rule/function | Input scope | Deterministic? | Current IpeNovel equivalent | Target module | Output class | Auto-apply | Idempotent | Fixture | Deferred |
|---|---|---:|---|---|---|---|---|---|---|
| `highlightForeignCharacters` / `FOREIGN_WORD_RE_V9_` | paragraph text | yes | `editorialForeignChecker.domain.ts` v8 foreign-script detection + UTF-16 offsets | reuse foreign checker | QC_FINDING | no | n/a | Japanese/Chinese/Korean/Devanagari/Cyrillic | no |
| `isLikelyKaomojiV9_` / skip map | paragraph text | yes | `isLikelyKaomoji` | reuse foreign checker | QC_FINDING exception | no | n/a | kaomoji exception | no |
| allow-list sheet lookup | token/config | yes, config-bound | normalized persisted allow-list + `editorialAllowListSha256` | reuse foreign checker | QC_FINDING config | no | n/a | allowed short English/name | no |
| untranslated English ratio / long English | paragraph/tab text | threshold deterministic | v8 long-English spans; short ASCII deliberately non-blocking | reuse foreign checker + vNext aggregate | QC_FINDING | no | n/a | short allowed English; suspicious long English | no |
| Latin-special destructive cleanup | paragraph text | deterministic but destructive | none required; foreign checker reports unsupported residue | vNext | REPORT_ONLY | no | n/a | Latin extended residue | yes: destructive legacy mutation |
| `replaceEmDashWithEllipsis` and Arabic waw substitution | paragraph text | deterministic but semantically unsafe | none | vNext | REPORT_ONLY | no | n/a | em dash / unexpected script residue | yes: content-changing ambiguity |
| `removeAllBlankLines` | tab paragraphs | yes | preparation pipeline `blank_line_cleanup` | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | blank cleanup | no |
| `normalizeChapterTitleFirstLine` / `cleanChapterHeadingAndEpisodePrefix_` | heading paragraph | yes when parsed | `normalizeChapterHeading`, chapter cleanup pipeline | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | heading normalization / Thai digits | no |
| Thai digit conversion | heading/text | yes | `thaiDigitsToArabic`, normalization pipeline | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | Thai digit heading | no |
| range-shaped heading handling | heading metadata | yes | `classifyEditorialChapterNumber` separates single/range/unparseable range-shaped forms | reuse identity contract | QC_FINDING / REPORT_ONLY | no conversion to single | n/a | 001-030 / 1..30 / em-dash range | no |
| duplicate heading-only lines | adjacent heading paragraphs | yes | preparation chapter cleanup removes exact repeated chapter-only heading | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | duplicated heading | no |
| quote/bracket split | paragraph text | yes | preparation `quote_bracket_split` | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | quote split / bracket split | no |
| English-source block cleanup | ordered tab paragraphs | threshold deterministic | `detectEnglishSourceBlock`: HIGH deletes, LOW warns | vNext preview wrapper | PREVIEW_REQUIRED / REPORT_ONLY | HIGH only via explicit preview; LOW never | yes | English-source junk | no |
| source note classification | tab structure | yes | structural anomaly `source_note_only` + confirmation state | reuse structural checker | QC_FINDING | no | n/a | source-note | no |
| source junk / author note / supporter blocks | ordered tab paragraphs | yes, bounded semantic state machine | foreign checker v8 bounded `source_junk` detection | reuse foreign checker; preview transform uses exact findings | QC_FINDING + PREVIEW_REQUIRED | explicit preview/apply only | yes | bounded source junk | no |
| source junk token deletion | finding ranges / whole junk paragraph | yes if finding identity current | `editorialBulkFindingCleanup.domain.ts` validates paragraph key/fingerprint/range | reuse cleanup domain | PREVIEW_REQUIRED | explicit apply only | yes after rerun | bounded junk block | no |
| ending promo cleanup | tail <=15 paragraphs | yes | preparation `cleanupEnding` uses bounded tail patterns | shared safe transforms | SAFE_TRANSFORM | preview/apply only | yes | ending duplicate/promo | no |
| ensure one `จบตอน` | tail/document | deterministic only when chapter evidence permits | legacy pipeline currently inserts unconditionally | vNext guarded ending transform | PREVIEW_REQUIRED | explicit apply only | yes | missing/single end marker | partially: do not insert when chapter evidence insufficient |
| chapter sequence duplicate/missing/jump/out-of-order | ordered chapter identities | yes | structural checker + canonical identity primitives; must not use tabOrder as chapter number | vNext sequence evaluator | QC_FINDING | no | n/a | duplicate/missing/out-of-order | no |
| near-duplicate/copy similarity heuristics | chapter body | heuristic | structural duplicate similarity exists | existing structural checker | REPORT_ONLY / existing QC policy | no | n/a | minimized duplicate case | no new heuristic port |
| formatting: Sarabun/font size/indent/spacing | presentation only | yes | `EDITORIAL_DRAFT_PRESENTATION` | presentation layer only | PRESENTATION_ONLY | n/a | n/a | presentation contract | no text metadata mutation |
| Google Docs watermark/header/footer/tab rename/menu/UI helpers | Docs runtime | runtime-specific | not canonical content | none | PRESENTATION_ONLY / REPORT_ONLY | no | n/a | none | yes: out of domain scope |

## Safety classes

- **AUTO_SAFE**: low-ambiguity deterministic transforms. In IPE-058-D they are still previewable; running the checker never mutates a Draft.
- **PREVIEW_REQUIRED**: deterministic but content-significant operations, including bounded source-junk removal, HIGH-confidence English-source removal, and guarded ending normalization.
- **REPORT_ONLY**: heuristic, destructive-risk, or semantically ambiguous legacy operations. Never auto-fixed.

## Invariants

1. Reuse `editorialForeignChecker`, `editorialStructuralAnomaly`, `editorialIdentityContract`, `editorialBulkFindingCleanup`, Draft/editor revision machinery, and IPE-058-C single-canvas paragraph identities.
2. A range-shaped chapter identity is never coerced into a canonical single episode.
3. Findings target `paragraphKey + utf16 offsets`; stale/missing paragraph keys fail safe with no fallback target.
4. Preview is side-effect free. Apply must pass expected Draft id/version/SHA and existing editor/service drift/idempotency boundaries, creating a new Draft revision.
5. No full novel text is logged or persisted as checker evidence beyond existing bounded finding evidence.

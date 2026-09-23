import { CanonicalFixtureSchema, type CanonicalFixture } from "../contracts";

const SOURCE_DOCUMENT_ID = "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q";
const HISTORICAL_THAI_DOCUMENT_ID =
  "1iLE_8KxtftOIcZuRuU30CVmOQM0W3CnF4HWARAT3vjY";

const SOURCE_DOCS_REVISION =
  "ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk";
const THAI_CURRENT_DOCS_REVISION =
  "ANLCKQmKbq-ZJzMyvDUPEZYooBvgZMlAQj96UTF-wQJrmvUAm6gyY5FFxP3Ig6vj7zJLPcRQ0UmbBjWN6CEYvbPM5_XiPCzlgFQ0oR-H9pQ";

export const NQA_CANONICAL_CAPTURE = {
  capturedDate: "2026-09-24",
  spreadsheetId: "1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y",
  sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
  currentRow: 1562,
  historicalIncidentRow: 1584,
  novelDisplayTitle:
    "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230",
  currentTranslationDocumentId: "1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ",
  currentTranslationAccessAtCapture: "PERMISSION_DENIED",
  historicalTranslationDocumentId: HISTORICAL_THAI_DOCUMENT_ID,
  preparedSourceDocumentId: SOURCE_DOCUMENT_ID,
  webSourceUrl:
    "https://www.webnovel.com/th/book/the-shinobi-of-straw-hats_19016984905951905",
  notes: [
    "The canonical bundle moved from row 1584 to row 1562.",
    "The current C-column document changed after the incident.",
    "Regression identity therefore uses document/revision/tab/hash, not row alone.",
  ],
} as const;

const source196 = {
  document: {
    kind: "google_doc" as const,
    documentId: SOURCE_DOCUMENT_ID,
    docsRevisionToken: SOURCE_DOCS_REVISION,
    driveRevisionId: "4",
    tabId: "t.0",
  },
  chapter: 196,
  internalSequence: 197,
  title: "Search and Rescue",
  variant: null,
  fingerprint: {
    normalizationVersion: "NQA_FIXTURE_V1" as const,
    sha256: "29dfb16657addd2f46c824f3cdb9a2d9d7516ad1b7b9a354b07b6c8aa93fff17",
    charCount: 11389,
    byteCount: 11445,
    paragraphCount: 95,
    startIndex: 170567,
    endIndex: 181956,
  },
};

const source197 = {
  document: {
    kind: "google_doc" as const,
    documentId: SOURCE_DOCUMENT_ID,
    docsRevisionToken: SOURCE_DOCS_REVISION,
    driveRevisionId: "4",
    tabId: "t.0",
  },
  chapter: 197,
  internalSequence: 198,
  title: "Possessing",
  variant: null,
  fingerprint: {
    normalizationVersion: "NQA_FIXTURE_V1" as const,
    sha256: "de05d436cc03526bb80506482b10d908ecfcdc3f3c53365a56253903518be793",
    charCount: 11049,
    byteCount: 11105,
    paragraphCount: 88,
    startIndex: 181957,
    endIndex: 193006,
  },
};

const fixtureCandidates: CanonicalFixture[] = [
  {
    fixtureId: "nqa_fixture_shinobi_196_good_historical_69",
    label: "Source 196 vs Thai 196 historical positive-control candidate",
    source: source196,
    translation: {
      document: {
        kind: "google_doc",
        documentId: HISTORICAL_THAI_DOCUMENT_ID,
        driveRevisionId: "69",
        tabId: "t.t7mcm92c2amf",
      },
      chapter: 196,
      title: "ค้นหาและช่วยเหลือ",
      variant: "historical_revision",
      fingerprint: {
        normalizationVersion: "NQA_FIXTURE_V1",
        sha256:
          "57d53dced4d97bd1eaf35bce87d420cbde15b6f750317a361bed39ab048d1633",
        charCount: 9470,
        byteCount: 27318,
        paragraphCount: 95,
        startIndex: null,
        endIndex: null,
      },
    },
    expectedDecision: "PASS",
    expectedReasonCodes: [],
    goldLabelStatus: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
    provenance: "HISTORICAL_REVISION",
    notes: [
      "Historical export slice excludes the leading tab label before hashing.",
      "Use as a positive control only after explicit human gold-label signoff.",
    ],
  },
  {
    fixtureId: "nqa_fixture_shinobi_197_bad_historical_69",
    label: "Canonical known-bad Chapter 197 incident",
    source: source197,
    translation: {
      document: {
        kind: "google_doc",
        documentId: HISTORICAL_THAI_DOCUMENT_ID,
        driveRevisionId: "69",
        tabId: "t.bf525hytchcg",
      },
      chapter: 197,
      title: "ค้นหาและช่วยเหลือ",
      variant: "historical_revision",
      fingerprint: {
        normalizationVersion: "NQA_FIXTURE_V1",
        sha256:
          "5eb68ab366d0ab258676d07e644799809777bd004f4ed8ff21862dc8e4256ea0",
        charCount: 10189,
        byteCount: 29715,
        paragraphCount: 107,
        startIndex: null,
        endIndex: null,
      },
    },
    expectedDecision: "FAIL",
    expectedReasonCodes: [
      "MEANING_DIVERGENCE",
      "EVENT_MISMATCH",
      "FABRICATION_SUSPECTED",
      "SOURCE_DRIFT",
    ],
    goldLabelStatus: "CANONICAL_INCIDENT",
    provenance: "HISTORICAL_REVISION",
    notes: [
      "Revision 69 contains commander-search, laboratory, and Devon content.",
      "The English source instead contains Sabo, possession, mindscape, and Kurama events.",
    ],
  },
  {
    fixtureId: "nqa_fixture_shinobi_197_corrected_current_90",
    label: "Corrected Chapter 197 positive-control candidate",
    source: source197,
    translation: {
      document: {
        kind: "google_doc",
        documentId: HISTORICAL_THAI_DOCUMENT_ID,
        docsRevisionToken: THAI_CURRENT_DOCS_REVISION,
        driveRevisionId: "90",
        tabId: "t.bf525hytchcg",
      },
      chapter: 197,
      title: "การสิงร่าง(แปลใหม่)",
      variant: "corrected_candidate",
      fingerprint: {
        normalizationVersion: "NQA_FIXTURE_V1",
        sha256:
          "98c4d7e573c8c10735102283a7aff8a653fedd85b759f4deec9f614af0f6922f",
        charCount: 9962,
        byteCount: 28878,
        paragraphCount: 86,
        startIndex: 1,
        endIndex: 9963,
      },
    },
    expectedDecision: "PASS",
    expectedReasonCodes: [],
    goldLabelStatus: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
    provenance: "CURRENT",
    notes: [
      "Current revision contains Sabo, Kurama, and possession-related anchors.",
      "Use as a positive control only after explicit human gold-label signoff.",
    ],
  },
];

export const NQA_CANONICAL_FIXTURES: readonly CanonicalFixture[] =
  fixtureCandidates.map(fixture => CanonicalFixtureSchema.parse(fixture));

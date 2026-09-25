# M06 — Operational Publish Readiness Audit

Status: **historical evidence record; runtime policy superseded by M12D.13**.

M06 originally audited the gap between synthetic publish evidence and real external-provider execution. The useful durable findings were subsequently implemented:

- concrete IpeNovel publish provider adapter;
- durable unattended worker;
- exact ownership epoch/version fencing;
- current source/last-published hash verification and advancement;
- bounded retry/dead-letter;
- provider receipt persistence and reconcile-first recovery;
- structured operational logging;
- durable outbox-derived execution scope.

The original Preview rollout instructions are intentionally removed because they no longer represent the runtime architecture. Real provider publish is now limited to exact `production` or `production-staging` deployment identity plus the approved database fingerprint for that environment.

Historical candidate/control IDs and synthetic receipts from M06 must not be treated as current deployment instructions or as authorization for Production side effects.

Current runtime and operational policy:

- `docs/workspace/M12D13_SIMPLIFY_CONTROLLED_PUBLISH_RUNTIME_POLICY.md`
- `docs/workspace/M12D9_UNATTENDED_CONTROLLED_PUBLISH_WORKER.md`
- `server/workspace/publishExecution.runtime.ts`

The read-only M06 baseline script remains only as historical checkpoint verification. It performs SELECT-only database inspection and does not control publish activation.

# Architecture notes and current boundaries

## Design direction

- PostgreSQL is intended to be authoritative for sequential transaction numbering (`transaction_no_seq`), referential integrity, monetary values (`NUMERIC(19,4)`), and atomic posting.
- Transactions are ordered by `transaction_no`; transaction dates remain report attributes.
- `transactions` hold the applied current/net multipliers, so edits to transaction type configuration do not mutate the stored multipliers of prior entries.
- Double-entry postings are separate from the operational current/net balance effects.
- Derived supplier, customer and account activity uses views over the posting and transaction tables rather than editable duplicated ledgers.
- Historical weekly close and reconciliation structures are represented in the schema, but snapshot-generation and immutability workflows are not yet implemented.

## Implementation assumptions (must be reviewed)

- Currency defaults to KES in initial schema fields; multi-currency valuation and exchange-rate accounting are not implemented.
- Opening-balance tables start in PENDING status. Approval workflows and opening journals are not yet implemented.
- Bank import schema preserves all required columns, but Excel parsing, row validation, hashing and review are not yet implemented.
- Remark extraction schemas are present; pattern execution/entity matching/review UI are not implemented.
- Backend currently accepts a `entered_by` user id from request data. This is unsafe without auth and authorization and is only a temporary development interface. Do not expose it to untrusted users.
- Posting rules currently gate transaction use but do not yet generate/verify the intended postings from configured rules. Explicit posting payloads must never substitute for a reviewed accounting configuration in production.
- Current dashboard aggregates the configured multipliers on posted transaction records; opening balances and effective-date running balance snapshots are not included yet.

## Production blockers

Authentication and RBAC, secure administrator bootstrap, authorization middleware, full transaction posting engine and reversals, accounting-period/weekly-close locking, history-safe recalculation, import/matching/reconciliation workflows, report exports, operational audit coverage, integration tests, and tested backup/restore are outstanding. Refer to the phase checklist in `PROJECT_PROGRESS.md`.

# Manual bank reconciliation

## Workflow

1. Import the bank's `.xlsx` statement and review its original remarks, debit/credit amounts, dates and references.
2. Start or resume reconciliation for the imported statement. Its account must be active and marked reconciliation-enabled.
3. For each statement row, review ledger-posting suggestions. Suggestions may use same-account direction, amount availability, dates and references to help sort results, but are never selected automatically. Bank references are not unique identifiers.
4. Select one or more posted journal lines on the reconciled bank account and enter each allocation explicitly. An incoming bank credit must match debit-side bank postings; a bank debit must match credit-side bank postings. Allocations must add up exactly to the statement row. A posting can be allocated over multiple statement rows only up to its remaining unallocated amount.
5. Approve only when every statement row is matched and the statement closing balance equals the ledger closing balance. The approved snapshot stores the bank balance, ledger balance and zero difference and is immutable.

## Controls and current limits

- Matching is manual; original bank remarks/references are retained and reference collisions do not cause silent matches.
- Matching does not change or post accounting transactions. If a bank fee or other statement item is not in the ledger, post it through the configured transaction workflow and then match it. There is not yet a separate bank-entry classification/exception route.
- Matches use exact account, sign and amount allocation checks in `NUMERIC(19,4)`. A statement row can allocate across multiple journal postings; any one posting's allocations cannot exceed its remaining amount.
- Confirmed matches and approved reconciliations cannot be edited or deleted through the application/database guards.
- Approval requires all rows matched and a zero statement-to-ledger closing difference; there is no override/approval path for an unexplained difference.

## API

- `GET /api/bank-reconciliations` — list prepared/approved reconciliation records.
- `POST /api/bank-reconciliations/prepare` with `{ "statement_id": 123 }` — prepare or resume a statement reconciliation.
- `GET /api/bank-reconciliations/:id` — details, entries, allocations and ledger closing preview.
- `GET /api/bank-reconciliations/:id/entries/:entryId/candidates?q=...` — non-binding ledger suggestions.
- `POST /api/bank-reconciliations/:id/matches` with an entry ID and explicit posting allocations — confirm a manual match.
- `POST /api/bank-reconciliations/:id/approve` — approve after complete matching and zero-difference validation.

Permissions: `reconciliation.read`, `reconciliation.prepare` and `reconciliation.approve`.

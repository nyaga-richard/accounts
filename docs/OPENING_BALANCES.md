# Opening balance batches

## Workflow

1. Open **Opening balances** and create a batch with an effective date and clear description.
2. Enter one or more chart-of-accounts lines. Each line contains either a positive debit or a positive credit, never both. Account debits and credits must balance exactly to four decimal places.
3. Optionally add supplier, customer and cashier opening balances. These subledger figures are stored separately from the chart-of-accounts entries; Ledgerway does **not** infer a control account or automatically link them to a general-ledger balance.
4. Submit the batch. It remains pending and does not affect approved opening-balance reports.
5. An authorized user approves or rejects the pending batch. Approval updates the corresponding opening-balance rows atomically and is recorded in the batch audit and general audit log. Rejection requires a reason.

## Financial and history controls

- PostgreSQL stores monetary amounts as `NUMERIC(19,4)` and the API validates exact decimal strings; binary floating-point is not used to decide whether the opening journal balances.
- An approved batch must have matching account debits/credits. A database trigger repeats this check at the transition to approved.
- An entity may have only one approved opening balance in its respective ledger. Subsequent changes should be posted as ordinary audited transactions, not another opening balance.
- Pending batches may be approved/rejected once. Final batches and lines cannot be edited or deleted through the database triggers; the history is auditable.
- Future effective dates and cutover dates after the earliest posted transaction are rejected because the current ledger snapshots apply approved openings before all registered movements. The database rechecks the cutover rule at approval; posting/reversal services also block dates before an approved cutover.
- Weekly closing includes an approved opening balance whose effective date falls on the first day of the week.
- Account-opening totals are validated independently of subsidiary balances. Before approval, the operator must reconcile supplier/customer/cashier subledger balances to the appropriate chart-of-accounts control balances. Automated control-account mapping and reconciliation is not yet implemented.

## API

- `GET /api/opening-balance-batches` — list batches.
- `GET /api/opening-balance-batches/:id` — batch lines and audit history.
- `POST /api/opening-balance-batches` — prepare a pending batch.
- `POST /api/opening-balance-batches/:id/approve` — approve a balanced batch.
- `POST /api/opening-balance-batches/:id/reject` — reject with a reason.

Required permissions are `opening_balances.read`, `opening_balances.prepare`, and `opening_balances.approve`. The Accounts role receives all three; Viewer receives read only. API permission checks remain authoritative regardless of UI visibility.

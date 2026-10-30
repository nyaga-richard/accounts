# Opening balance batches

## Workflow

1. Open **Opening balances** and create a batch with an effective date and clear description.
2. For manual entries, add one or more chart-of-accounts lines. Each line contains either a positive debit or a positive credit, never both. Account debits and credits must balance exactly to four decimal places.
3. Optionally add supplier, customer and cashier opening balances. These subledger figures are stored separately from chart-of-accounts entries unless a corresponding account line is included.
4. For a supplier spreadsheet, choose **Import supplier spreadsheet**, download the CSV template or select an `.xlsx` or `.csv` file with `Name`, `Code`, and `Opening Balance` headers (the first worksheet is read from `.xlsx` files), preview it, then prepare the batch. Blank/dash values are zero; positive balances are supplier payables and negative balances are debit/prepayments. New supplier masters are created atomically; case-insensitive code/name matches are reused. A code with a different name or an inactive supplier blocks import.
5. The importer creates/reuses KES chart accounts with descriptive codes: `SUP-AP-CTRL` (liability/credit) for positive supplier balances; `SUP-ADVANCES` (asset/debit) for negative balances; and `OPENING-CLEARING` (equity/credit) to offset the net. If a base code is occupied by an incompatible account, a numeric suffix is tried. These generated lines balance the supplier totals exactly. Accounts and supplier rows are included in the same pending batch; no manual account lines are needed for the supplier import. If all balances are zero, supplier masters are imported without creating an empty opening batch.
6. Active supplier-affecting transaction rules with a fixed account on the supplier side are switched to the shared AP control account. Each change is written to transaction-type rule history and the general audit log. User-selected supplier-side accounts and rules without a supplier-side setting are not changed; review those separately.
7. The batch remains pending until an authorized user approves or rejects it. Approval is separate from import, and rejection requires a reason.

## Financial and history controls

- Amounts use exact `NUMERIC(19,4)` arithmetic; the API does not use binary floating point to calculate generated GL lines.
- `Opening Balance Clearing` is a **temporary** balancing equity account, not a claim that the imported supplier list is a complete opening trial balance. Reconcile/reclassify it against the rest of the verified opening assets, liabilities and equity before relying on financial statements.
- The importer groups positive supplier balances into one shared AP control account and negative balances into a supplier advances asset account. Supplier identities and signed opening balances remain available in their subledger.
- An approved batch must have matching account debits and credits; a database trigger repeats the check at approval. An entity may have only one approved opening balance in its respective ledger. Final batches and lines cannot be edited or deleted; amendments should use audited transactions.
- Future effective dates and cutover dates after the earliest posted transaction are rejected. Posting/reversal services block dates before an approved cutover, and weekly closing includes an approved opening effective on the week-start date.
- Account/subledger totals still require operator review. The importer does not assume supplier balances reconcile to other existing control accounts, and it changes only active fixed supplier-side posting rules as described above.
- Supplier import is limited to 5,000 rows, 10 MiB per file and four decimal places. It accepts `.xlsx` and `.csv`; it does not OCR screenshots or image files.

## API

- `GET /api/opening-balance-batches` — list batches.
- `GET /api/opening-balance-batches/:id` — batch lines and audit history.
- `POST /api/opening-balance-batches` — prepare a manually entered pending batch.
- `POST /api/opening-balance-batches/import-preview` — multipart `file` preview for supplier `.xlsx`/`.csv` files; requires `opening_balances.prepare`.
- `POST /api/opening-balance-batches/import` — multipart `file`, `effective_date`, and `description` (optional JSON `accounts` for additional balanced lines); creates/reuses suppliers and generated control/clearing accounts atomically, updates eligible supplier-side posting rules with audit, and prepares the pending batch. Requires `opening_balances.prepare`, `suppliers.write`, and `transaction_types.write` (or `*`).
- `POST /api/opening-balance-batches/:id/approve` — approve a balanced batch.
- `POST /api/opening-balance-batches/:id/reject` — reject with a reason.

Required permissions include `opening_balances.read`, `opening_balances.prepare`, `opening_balances.approve`, `suppliers.write`, and `transaction_types.write` for the corresponding operations. API checks remain authoritative regardless of UI visibility.

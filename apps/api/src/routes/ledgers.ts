import { Router, type Request, type RequestHandler, type Response } from 'express';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
export const ledgersApi=Router();
type AuthenticatedRequest=Request&{appUser:NonNullable<Request['appUser']>};
const wrap=(fn:(req:AuthenticatedRequest,res:Response)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void Promise.resolve(fn(req as AuthenticatedRequest,res)).catch(next)};
ledgersApi.get('/suppliers/:id/statement', requirePermission('suppliers.read'), wrap(async (req, res) => { const supplierId = Number(req.params.id); const supplier = await db('suppliers').where({ supplier_id: supplierId }).first(); if (!supplier)
    throw Object.assign(new Error('Supplier not found'), { status: 404, expose: true }); const clauses: string[] = []; const bindings: (string | number)[] = [supplierId]; if (req.query.from) {
    clauses.push('transaction_date >= ?');
    bindings.push(String(req.query.from));
} if (req.query.to) {
    clauses.push('transaction_date <= ?');
    bindings.push(String(req.query.to));
} if (req.query.transactionNo) {
    clauses.push('transaction_no = ?');
    bindings.push(String(req.query.transactionNo));
} if (req.query.reference) {
    clauses.push('reference ILIKE ?');
    bindings.push(`%${String(req.query.reference)}%`);
} if (req.query.amount) {
    clauses.push('ABS(debit-credit) = ?::numeric');
    bindings.push(String(req.query.amount));
} const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''; const rows = await db.raw(`WITH opening AS (SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM supplier_opening_balances WHERE supplier_id=? AND status='APPROVED'), movements AS (SELECT t.transaction_id,t.transaction_no,t.transaction_date,t.reference,t.description AS particulars,p.credit_amount AS debit,p.debit_amount AS credit,tt.name AS transaction_type FROM transaction_postings p JOIN transactions t USING(transaction_id) JOIN transaction_types tt USING(transaction_type_id) WHERE p.supplier_id=? AND t.status='POSTED'), balances AS (SELECT m.*,opening.amount + SUM(m.debit-m.credit) OVER(ORDER BY m.transaction_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance FROM movements m CROSS JOIN opening) SELECT * FROM balances ${where} ORDER BY transaction_no`, [supplierId, supplierId, ...bindings.slice(1)]); const ob = await db('supplier_opening_balances').where({ supplier_id: supplierId, status: 'APPROVED' }).sum({ amount: 'amount' }).first(); const entries = rows.rows; res.json({ supplier, openingBalance: String(ob?.amount || '0'), entries, closingBalance: entries.length ? String(entries[entries.length - 1].running_balance) : String(ob?.amount || '0') }); }));
ledgersApi.get('/accounts', requirePermission('accounts.read'), wrap(async (_req, res) => res.json(await db('accounts').where({ status: 'ACTIVE' }).orderBy('account_no'))));
ledgersApi.get('/accounts/:id/ledger', requirePermission('accounts.read'), wrap(async (req, res) => { const id = Number(req.params.id), account = await db('accounts').where({ account_id: id }).first(); if (!account)
    throw Object.assign(new Error('Account not found'), { status: 404, expose: true }); const clauses = []; const filters = []; if (req.query.from) {
    clauses.push('transaction_date >= ?');
    filters.push(String(req.query.from));
} if (req.query.to) {
    clauses.push('transaction_date <= ?');
    filters.push(String(req.query.to));
} if (req.query.transactionNo) {
    clauses.push('transaction_no = ?');
    filters.push(String(req.query.transactionNo));
} if (req.query.reference) {
    clauses.push('reference ILIKE ?');
    filters.push(`%${String(req.query.reference)}%`);
} const normal = account.account_nature === 'DEBIT' ? 1 : -1; const movements = await db.raw(`WITH ob AS (SELECT COALESCE(SUM(debit_amount-credit_amount),0)::numeric AS signed FROM account_opening_balances WHERE account_id=? AND status='APPROVED'), m AS (SELECT t.transaction_id,t.transaction_no,t.transaction_date,t.description AS particulars,t.reference,p.debit_amount AS debit,p.credit_amount AS credit FROM transaction_postings p JOIN transactions t USING(transaction_id) WHERE p.account_id=? AND t.status='POSTED'), b AS (SELECT m.*,ob.signed + SUM((m.debit-m.credit)*?::numeric) OVER(ORDER BY m.transaction_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance FROM m CROSS JOIN ob) SELECT * FROM b ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY transaction_no`, [id, id, normal, ...filters]); const open = await db.raw(`SELECT (COALESCE(SUM(debit_amount-credit_amount),0)*?::numeric)::numeric AS balance FROM account_opening_balances WHERE account_id=? AND status='APPROVED'`, [normal, id]); const openingBalance = String(open.rows[0].balance); res.json({ account, openingBalance, entries: movements.rows, closingBalance: movements.rows.length ? String(movements.rows[movements.rows.length - 1].running_balance) : openingBalance }); }));
ledgersApi.get('/customers/:id/statement', requirePermission('customers.read'), wrap(async (req, res) => { const id = Number(req.params.id), customer = await db('customers').where({ customer_id: id }).first(); if (!customer)
    throw Object.assign(new Error('Customer not found'), { status: 404, expose: true }); const clauses = []; const filters = []; if (req.query.from) {
    clauses.push('transaction_date >= ?');
    filters.push(String(req.query.from));
} if (req.query.to) {
    clauses.push('transaction_date <= ?');
    filters.push(String(req.query.to));
} if (req.query.reference) {
    clauses.push('reference ILIKE ?');
    filters.push(`%${String(req.query.reference)}%`);
} const rows = await db.raw(`WITH ob AS (SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM customer_opening_balances WHERE customer_id=? AND status='APPROVED'), m AS (SELECT t.transaction_id,t.transaction_no,t.transaction_date,t.reference,t.description AS particulars,p.debit_amount AS debit,p.credit_amount AS credit FROM transaction_postings p JOIN transactions t USING(transaction_id) WHERE p.customer_id=? AND t.status='POSTED'), b AS (SELECT m.*,ob.amount+SUM(m.debit-m.credit) OVER(ORDER BY m.transaction_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance FROM m CROSS JOIN ob) SELECT * FROM b ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY transaction_no`, [id, id, ...filters]); const ob = await db('customer_opening_balances').where({ customer_id: id, status: 'APPROVED' }).sum({ amount: 'amount' }).first(); res.json({ customer, openingBalance: String(ob?.amount || '0'), entries: rows.rows, closingBalance: rows.rows.length ? String(rows.rows[rows.rows.length - 1].running_balance) : String(ob?.amount || '0') }); }));
ledgersApi.get('/reports/trial-balance', requirePermission('reports.read'), wrap(async (_req, res) => { const rows = await db.raw(`WITH o AS (SELECT account_id,SUM(debit_amount) AS od,SUM(credit_amount) AS oc FROM account_opening_balances WHERE status='APPROVED' GROUP BY account_id), p AS (SELECT p.account_id,SUM(p.debit_amount) AS d,SUM(p.credit_amount) AS c FROM transaction_postings p JOIN transactions t USING(transaction_id) WHERE t.status='POSTED' GROUP BY p.account_id), x AS (SELECT a.account_id,a.account_no,a.account_name,a.account_type,a.account_nature,COALESCE(o.od,0)::numeric AS opening_debit,COALESCE(o.oc,0)::numeric AS opening_credit,COALESCE(p.d,0)::numeric AS period_debit,COALESCE(p.c,0)::numeric AS period_credit,(COALESCE(o.od,0)+COALESCE(p.d,0)-COALESCE(o.oc,0)-COALESCE(p.c,0))::numeric AS net FROM accounts a LEFT JOIN o USING(account_id) LEFT JOIN p USING(account_id) WHERE a.status='ACTIVE') SELECT *,GREATEST(net,0)::numeric AS closing_debit,GREATEST(-net,0)::numeric AS closing_credit FROM x ORDER BY account_no`); const totals = await db.raw(`WITH p AS (SELECT SUM(debit_amount) d,SUM(credit_amount) c FROM transaction_postings p JOIN transactions t USING(transaction_id) WHERE t.status='POSTED'),o AS (SELECT SUM(debit_amount) d,SUM(credit_amount) c FROM account_opening_balances WHERE status='APPROVED') SELECT COALESCE(p.d,0)+COALESCE(o.d,0) AS debits,COALESCE(p.c,0)+COALESCE(o.c,0) AS credits FROM p,o`); res.json({ accounts: rows.rows, totals: totals.rows[0] }); }));

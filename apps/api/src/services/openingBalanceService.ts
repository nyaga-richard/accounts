import type { Knex } from 'knex';

export type OpeningLine = { entity_id: number; amount?: string; debit_amount?: string; credit_amount?: string };
export type CreateOpeningBatch = {
  effective_date: string;
  description: string;
  accounts: OpeningLine[];
  suppliers: OpeningLine[];
  customers: OpeningLine[];
  cashiers: OpeningLine[];
};
const fail = (message: string, status = 422) => Object.assign(new Error(message), { status, expose: true });

function minorUnits(value: string, field: string): bigint {
  const text = String(value);
  const match = /^(-?)(0|[1-9]\d{0,14})(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw fail(`${field} must be a decimal amount with up to four places and fit NUMERIC(19,4)`);
  const magnitude = BigInt(match[2]) * 10000n + BigInt((match[3] || '').padEnd(4, '0') || '0');
  return match[1] ? -magnitude : magnitude;
}

async function assertActiveIds(trx: Knex.Transaction, table: string, key: string, lines: OpeningLine[], label: string) {
  const ids = lines.map(line => line.entity_id);
  if (new Set(ids).size !== ids.length) throw fail(`${label} cannot appear more than once in an opening batch`);
  if (!ids.length) return;
  const active = await trx(table).whereIn(key, ids).where({ status: 'ACTIVE' }).pluck(key);
  const found = new Set(active.map(Number));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) throw fail(`Missing or inactive ${label.toLowerCase()} id(s): ${missing.join(', ')}`);
}

export async function createOpeningBalanceBatch(db: Knex, input: CreateOpeningBatch, userId: number) {
  const accounts = input.accounts || [], suppliers = input.suppliers || [], customers = input.customers || [], cashiers = input.cashiers || [];
  if (!accounts.length) throw fail('At least one chart-of-accounts opening line is required');
  if (!accounts.length && !suppliers.length && !customers.length && !cashiers.length) throw fail('Add at least one opening balance line');
  if (input.effective_date > new Date().toISOString().slice(0, 10)) throw fail('Opening balance effective date cannot be in the future');
  let debitTotal = 0n, creditTotal = 0n;
  for (const line of accounts) {
    const debit = minorUnits(line.debit_amount || '0', 'Debit amount');
    const credit = minorUnits(line.credit_amount || '0', 'Credit amount');
    if (debit < 0n || credit < 0n || (debit > 0n && credit > 0n) || (debit === 0n && credit === 0n)) throw fail('Each account opening line must have one positive debit or credit amount, not both');
    debitTotal += debit; creditTotal += credit;
  }
  if (debitTotal !== creditTotal) throw fail('Account opening debits and credits must balance exactly before saving');
  for (const line of [...suppliers, ...customers, ...cashiers]) {
    const value = minorUnits(line.amount || '0', 'Subledger opening amount');
    if (value === 0n) throw fail('Subledger opening amounts must be non-zero; omit unused entities');
  }
  const same = (a: bigint, b: bigint) => a.toString() === b.toString();
  const decimal = (v: bigint) => `${v < 0n ? '-' : ''}${(v < 0n ? -v : v) / 10000n}.${String((v < 0n ? -v : v) % 10000n).padStart(4, '0')}`;
  if (!same(debitTotal, creditTotal)) throw fail('Account opening totals do not balance');

  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
    const firstPosted = await trx('transactions').where({ status: 'POSTED' }).min({ first_date: 'transaction_date' }).first();
    if (firstPosted?.first_date && input.effective_date > String(firstPosted.first_date).slice(0, 10)) throw fail('Opening balance effective date cannot be after the earliest posted transaction date; opening amounts precede registered movements');
    await Promise.all([
      assertActiveIds(trx, 'accounts', 'account_id', accounts, 'Accounts'),
      assertActiveIds(trx, 'suppliers', 'supplier_id', suppliers, 'Suppliers'),
      assertActiveIds(trx, 'customers', 'customer_id', customers, 'Customers'),
      assertActiveIds(trx, 'cashiers', 'cashier_id', cashiers, 'Cashiers'),
    ]);
    const [batch] = await trx('opening_balance_batches').insert({
      effective_date: input.effective_date, description: input.description.trim(), status: 'PENDING',
      account_debit_total: decimal(debitTotal), account_credit_total: decimal(creditTotal), created_by: userId,
    }).returning('*');
    const batchId = Number(batch.opening_batch_id);
    if (accounts.length) await trx('account_opening_balances').insert(accounts.map(line => ({
      opening_batch_id: batchId, account_id: line.entity_id,
      debit_amount: decimal(minorUnits(line.debit_amount || '0', 'Debit amount')),
      credit_amount: decimal(minorUnits(line.credit_amount || '0', 'Credit amount')),
      effective_date: input.effective_date, status: 'PENDING', created_by: userId,
    })));
    if (suppliers.length) await trx('supplier_opening_balances').insert(suppliers.map(line => ({ opening_batch_id: batchId, supplier_id: line.entity_id, effective_date: input.effective_date, amount: decimal(minorUnits(line.amount || '0', 'Supplier amount')), status: 'PENDING', created_by: userId })));
    if (customers.length) await trx('customer_opening_balances').insert(customers.map(line => ({ opening_batch_id: batchId, customer_id: line.entity_id, effective_date: input.effective_date, amount: decimal(minorUnits(line.amount || '0', 'Customer amount')), status: 'PENDING', created_by: userId })));
    if (cashiers.length) await trx('cashier_opening_balances').insert(cashiers.map(line => ({ opening_batch_id: batchId, cashier_id: line.entity_id, effective_date: input.effective_date, amount: decimal(minorUnits(line.amount || '0', 'Cashier amount')), status: 'PENDING', created_by: userId })));
    const audit = { effective_date: input.effective_date, description: input.description.trim(), account_debit_total: decimal(debitTotal), account_credit_total: decimal(creditTotal), account_line_count: accounts.length, supplier_line_count: suppliers.length, customer_line_count: customers.length, cashier_line_count: cashiers.length };
    await trx('opening_balance_batch_audit').insert({ opening_batch_id: batchId, action: 'PREPARED', old_values: null, new_values: audit, performed_by: userId, reason: 'Opening balance batch prepared' });
    await trx('audit_logs').insert({ user_id: userId, action: 'OPENING_BALANCE_BATCH_PREPARED', table_name: 'opening_balance_batches', record_id: String(batchId), new_values: audit });
    return batch;
  });
}

export async function getOpeningBalanceBatch(db: Knex, batchId: number) {
  const batch = await db('opening_balance_batches').where({ opening_batch_id: batchId }).first();
  if (!batch) throw fail('Opening balance batch not found', 404);
  const [accounts, suppliers, customers, cashiers, history] = await Promise.all([
    db('account_opening_balances as o').join('accounts as a', 'a.account_id', 'o.account_id').where('o.opening_batch_id', batchId).select('o.*', 'a.account_no', 'a.account_name', 'a.account_type', 'a.account_nature').orderBy('a.account_no'),
    db('supplier_opening_balances as o').join('suppliers as s', 's.supplier_id', 'o.supplier_id').where('o.opening_batch_id', batchId).select('o.*', 's.supplier_code', 's.supplier_name').orderBy('s.supplier_name'),
    db('customer_opening_balances as o').join('customers as c', 'c.customer_id', 'o.customer_id').where('o.opening_batch_id', batchId).select('o.*', 'c.customer_code', 'c.customer_name').orderBy('c.customer_name'),
    db('cashier_opening_balances as o').join('cashiers as c', 'c.cashier_id', 'o.cashier_id').where('o.opening_batch_id', batchId).select('o.*', 'c.cashier_code', 'c.cashier_name').orderBy('c.cashier_name'),
    db('opening_balance_batch_audit').where({ opening_batch_id: batchId }).orderBy('performed_at'),
  ]);
  return { batch, accounts, suppliers, customers, cashiers, history };
}

export async function listOpeningBalanceBatches(db: Knex) {
  return db('opening_balance_batches as b').select('b.*')
    .select(db.raw('(SELECT COUNT(*) FROM account_opening_balances x WHERE x.opening_batch_id=b.opening_batch_id) AS account_line_count'))
    .select(db.raw('(SELECT COUNT(*) FROM supplier_opening_balances x WHERE x.opening_batch_id=b.opening_batch_id) AS supplier_line_count'))
    .select(db.raw('(SELECT COUNT(*) FROM customer_opening_balances x WHERE x.opening_batch_id=b.opening_batch_id) AS customer_line_count'))
    .select(db.raw('(SELECT COUNT(*) FROM cashier_opening_balances x WHERE x.opening_batch_id=b.opening_batch_id) AS cashier_line_count'))
    .orderBy('b.created_at', 'desc').limit(200);
}

async function finalize(db: Knex, batchId: number, userId: number, reason: string, outcome: 'APPROVED' | 'REJECTED') {
  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
    const batch = await trx('opening_balance_batches').where({ opening_batch_id: batchId }).forUpdate().first();
    if (!batch) throw fail('Opening balance batch not found', 404);
    if (batch.status !== 'PENDING') throw fail('Only a pending opening balance batch can be finalized', 409);
    if (outcome === 'APPROVED') {
      const checks = [
        ['account_opening_balances', 'account_id', 'account'], ['supplier_opening_balances', 'supplier_id', 'supplier'],
        ['customer_opening_balances', 'customer_id', 'customer'], ['cashier_opening_balances', 'cashier_id', 'cashier'],
      ] as const;
      for (const [table, key, label] of checks) {
        const ids = await trx(table).where({ opening_batch_id: batchId }).pluck(key);
        if (!ids.length) continue;
        const existing = await trx(table).whereIn(key, ids).where({ status: 'APPROVED' }).first();
        if (existing) throw fail(`An approved opening balance already exists for a ${label}; use a posted adjustment transaction`, 409);
      }
    }
    const [updated] = await trx('opening_balance_batches').where({ opening_batch_id: batchId, status: 'PENDING' }).update(outcome === 'APPROVED'
      ? { status: outcome, approved_by: userId, approved_at: trx.fn.now() }
      : { status: outcome, rejected_by: userId, rejected_at: trx.fn.now(), rejection_reason: reason }).returning('*');
    const lineStatus = outcome;
    for (const table of ['account_opening_balances', 'supplier_opening_balances', 'customer_opening_balances', 'cashier_opening_balances']) {
      await trx(table).where({ opening_batch_id: batchId, status: 'PENDING' }).update(outcome === 'APPROVED'
        ? { status: lineStatus, approved_by: userId, approved_at: trx.fn.now() }
        : { status: lineStatus });
    }
    const auditReason = outcome === 'APPROVED' ? 'Balanced opening balance batch approved' : reason;
    await trx('opening_balance_batch_audit').insert({ opening_batch_id: batchId, action: outcome, old_values: batch, new_values: updated, performed_by: userId, reason: auditReason });
    await trx('audit_logs').insert({ user_id: userId, action: `OPENING_BALANCE_BATCH_${outcome}`, table_name: 'opening_balance_batches', record_id: String(batchId), old_values: batch, new_values: updated });
    return updated;
  });
}
export const approveOpeningBalanceBatch = (db: Knex, batchId: number, userId: number) => finalize(db, batchId, userId, '', 'APPROVED');
export const rejectOpeningBalanceBatch = (db: Knex, batchId: number, reason: string, userId: number) => finalize(db, batchId, userId, reason, 'REJECTED');

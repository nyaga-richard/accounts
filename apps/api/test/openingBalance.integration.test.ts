import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { approveOpeningBalanceBatch, createOpeningBalanceBatch, getOpeningBalanceBatch, rejectOpeningBalanceBatch } from '../src/services/openingBalanceService.js';
import { createPostedTransaction } from '../src/services/transactionService.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
describe.skipIf(!enabled)('PostgreSQL opening balance batch integration', () => {
  let userId: number;
  const tag = `OB${Date.now()}`;
  beforeAll(async () => {
    const user = await db('users').where({ status: 'ACTIVE' }).first();
    if (!user) throw new Error('TEST_DATABASE_URL must point at a migrated and seeded test database');
    userId = Number(user.user_id);
  });
  afterAll(async () => { await db.destroy(); });

  it('requires exact account debit-credit balance before preparing a batch', async () => {
    const [debit] = await db('accounts').insert({ account_no: `${tag}-BAD-D`, account_name: `${tag} bad debit`, account_type: 'ASSET', account_nature: 'DEBIT' }).returning('*');
    await expect(createOpeningBalanceBatch(db, { effective_date: '2025-01-01', description: 'Unbalanced test opening', accounts: [{ entity_id: Number(debit.account_id), debit_amount: '100.00', credit_amount: '0' }], suppliers: [], customers: [], cashiers: [] }, userId)).rejects.toThrow(/must balance exactly/);
  });

  it('approves a balanced batch atomically, snapshots subledgers and protects final history', async () => {
    const [cash] = await db('accounts').insert({ account_no: `${tag}-CASH`, account_name: `${tag} cash`, account_type: 'ASSET', account_nature: 'DEBIT' }).returning('*');
    const [capital] = await db('accounts').insert({ account_no: `${tag}-CAP`, account_name: `${tag} capital`, account_type: 'EQUITY', account_nature: 'CREDIT' }).returning('*');
    const [supplier] = await db('suppliers').insert({ supplier_code: `${tag}-S`, supplier_name: `${tag} supplier`, created_by: userId }).returning('*');
    const [customer] = await db('customers').insert({ customer_code: `${tag}-CU`, customer_name: `${tag} customer`, created_by: userId }).returning('*');
    const [cashier] = await db('cashiers').insert({ cashier_code: `${tag}-CA`, cashier_name: `${tag} cashier`, created_by: userId }).returning('*');
    const pending = await createOpeningBalanceBatch(db, {
      effective_date: '2025-01-01', description: 'Initial cutover balances',
      accounts: [{ entity_id: Number(cash.account_id), debit_amount: '12500.25', credit_amount: '0' }, { entity_id: Number(capital.account_id), debit_amount: '0', credit_amount: '12500.25' }],
      suppliers: [{ entity_id: Number(supplier.supplier_id), amount: '700.00' }],
      customers: [{ entity_id: Number(customer.customer_id), amount: '850.50' }],
      cashiers: [{ entity_id: Number(cashier.cashier_id), amount: '-12.25' }],
    }, userId);
    expect(pending.status).toBe('PENDING');
    const approved = await approveOpeningBalanceBatch(db, Number(pending.opening_batch_id), userId);
    expect(approved.status).toBe('APPROVED');
    const detail = await getOpeningBalanceBatch(db, Number(pending.opening_batch_id));
    expect(detail.accounts).toHaveLength(2);
    expect(detail.suppliers[0].amount).toBe('700.0000');
    expect(detail.customers[0].amount).toBe('850.5000');
    expect(detail.cashiers[0].amount).toBe('-12.2500');
    expect(detail.history.map(row => row.action)).toEqual(['PREPARED', 'APPROVED']);
    await expect(db('account_opening_balances').where({ opening_batch_id: pending.opening_batch_id, account_id: cash.account_id }).update({ debit_amount: '1' })).rejects.toThrow(/immutable/);
    const trial = await db('account_opening_balances').where({ opening_batch_id: pending.opening_batch_id }).select(db.raw('sum(debit_amount)::numeric as debit'), db.raw('sum(credit_amount)::numeric as credit')).first();
    expect(String(trial?.debit)).toBe('12500.2500');
    expect(String(trial?.credit)).toBe('12500.2500');
    const [transactionType] = await db('transaction_types').insert({ code: `${tag}-CUT`, name: `${tag} opening cutoff`, created_by: userId }).returning('*');
    await db('transaction_type_rules').insert({ transaction_type_id: transactionType.transaction_type_id, rule_name: 'opening cutoff test', debit_account_id: cash.account_id, credit_account_id: capital.account_id, account_selection_mode: 'FIXED', amount_source: 'TRANSACTION', party_account_side: 'NONE', is_required: true, status: 'ACTIVE' });
    await expect(createPostedTransaction(db, { transaction_date: '2024-12-31', transaction_type_id: Number(transactionType.transaction_type_id), amount: '10', entered_by: userId })).rejects.toThrow(/predates an approved opening balance cutover/);
  });

  it('enforces non-empty balanced account lines at database approval time', async () => {
    const [batch] = await db('opening_balance_batches').insert({ effective_date: '1900-01-01', description: 'Direct database empty batch', status: 'PENDING', created_by: userId }).returning('*');
    await expect(db('opening_balance_batches').where({ opening_batch_id: batch.opening_batch_id }).update({ status: 'APPROVED', approved_by: userId, approved_at: db.fn.now() })).rejects.toThrow(/non-zero balanced debits and credits/);
  });

  it('does not allow a second approved opening balance for an entity and records rejection', async () => {
    const [cash] = await db('accounts').insert({ account_no: `${tag}-DUP-D`, account_name: `${tag} duplicate debit`, account_type: 'ASSET', account_nature: 'DEBIT' }).returning('*');
    const [equity] = await db('accounts').insert({ account_no: `${tag}-DUP-E`, account_name: `${tag} duplicate equity`, account_type: 'EQUITY', account_nature: 'CREDIT' }).returning('*');
    const original = await createOpeningBalanceBatch(db, { effective_date: '2025-01-02', description: 'Original balance', accounts: [{ entity_id: Number(cash.account_id), debit_amount: '20', credit_amount: '0' }, { entity_id: Number(equity.account_id), debit_amount: '0', credit_amount: '20' }], suppliers: [], customers: [], cashiers: [] }, userId);
    await approveOpeningBalanceBatch(db, Number(original.opening_batch_id), userId);
    const [offset] = await db('accounts').insert({ account_no: `${tag}-OFFSET`, account_name: `${tag} offset`, account_type: 'EQUITY', account_nature: 'CREDIT' }).returning('*');
    const duplicate = await createOpeningBalanceBatch(db, { effective_date: '2025-01-03', description: 'Duplicate entity opening', accounts: [{ entity_id: Number(cash.account_id), debit_amount: '10', credit_amount: '0' }, { entity_id: Number(offset.account_id), debit_amount: '0', credit_amount: '10' }], suppliers: [], customers: [], cashiers: [] }, userId);
    await expect(approveOpeningBalanceBatch(db, Number(duplicate.opening_batch_id), userId)).rejects.toThrow(/already exists/);
    expect((await db('opening_balance_batches').where({ opening_batch_id: duplicate.opening_batch_id }).first()).status).toBe('PENDING');

    const [d] = await db('accounts').insert({ account_no: `${tag}-REJ-D`, account_name: `${tag} rejected debit`, account_type: 'ASSET', account_nature: 'DEBIT' }).returning('*');
    const [c] = await db('accounts').insert({ account_no: `${tag}-REJ-C`, account_name: `${tag} rejected credit`, account_type: 'EQUITY', account_nature: 'CREDIT' }).returning('*');
    const rejectable = await createOpeningBalanceBatch(db, { effective_date: '2025-01-04', description: 'Rejectable batch', accounts: [{ entity_id: Number(d.account_id), debit_amount: '3', credit_amount: '0' }, { entity_id: Number(c.account_id), debit_amount: '0', credit_amount: '3' }], suppliers: [], customers: [], cashiers: [] }, userId);
    expect((await rejectOpeningBalanceBatch(db, Number(rejectable.opening_batch_id), 'Duplicate cutover import', userId)).status).toBe('REJECTED');
    await expect(db('account_opening_balances').where({ opening_batch_id: rejectable.opening_batch_id }).delete()).rejects.toThrow(/immutable/);
  });
});

import type { Knex } from 'knex';
export type ChequeFilters = { q?: string; status?: string; direction?: 'ISSUED' | 'RECEIVED'; from?: string; to?: string; limit?: number; offset?: number };
function builder(db: Knex, filters: ChequeFilters) {
  return db('cheques as c')
    .join('transactions as t', 't.transaction_id', 'c.transaction_id')
    .join('transaction_types as tt', 'tt.transaction_type_id', 't.transaction_type_id')
    .leftJoin('accounts as a', 'a.account_id', 'c.account_id')
    .leftJoin('suppliers as s', function () { this.on('s.supplier_id', '=', 't.particulars_id').andOnVal('t.particulars_type', '=', 'SUPPLIER'); })
    .leftJoin('customers as cu', function () { this.on('cu.customer_id', '=', 't.particulars_id').andOnVal('t.particulars_type', '=', 'CUSTOMER'); })
    .where('t.status', 'POSTED')
    .modify(query => {
      if (filters.status) query.andWhere('c.cheque_status', filters.status);
      if (filters.direction) query.andWhere('c.direction', filters.direction);
      if (filters.from) query.andWhere('c.cheque_date', '>=', filters.from);
      if (filters.to) query.andWhere('c.cheque_date', '<=', filters.to);
      if (filters.q) query.andWhere(inner => inner.whereILike('c.cheque_number', `%${filters.q}%`).orWhereILike('c.bank_reference', `%${filters.q}%`).orWhereILike('c.payee_payer', `%${filters.q}%`).orWhereILike('s.supplier_name', `%${filters.q}%`).orWhereILike('cu.customer_name', `%${filters.q}%`).orWhereRaw('CAST(t.transaction_no AS TEXT) ILIKE ?', [`%${filters.q}%`]));
    });
}
const selection = ['c.cheque_id','c.transaction_id','c.cheque_number','c.cheque_date','c.payee_payer','c.account_id','c.direction','c.amount','c.cheque_status','c.bank_reference','c.remarks','c.created_at','t.transaction_no','t.transaction_date','t.reference as transaction_reference','t.description as transaction_description','tt.code as transaction_type_code','tt.name as transaction_type_name','a.account_no','a.account_name','s.supplier_code','s.supplier_name','cu.customer_code','cu.customer_name'];
export async function listCheques(db: Knex, filters: ChequeFilters = {}) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200), offset = Math.max(filters.offset ?? 0, 0);
  const [items, count] = await Promise.all([
    builder(db, filters).select(selection).orderBy('c.cheque_date','desc').orderBy('c.cheque_id','desc').limit(limit).offset(offset),
    builder(db, filters).countDistinct({ total: 'c.cheque_id' }).first(),
  ]);
  return { items, total: Number(count?.total || 0), limit, offset };
}
export async function getChequeDetail(db: Knex, id: number) {
  const cheque = await builder(db, {}).where('c.cheque_id', id).select(selection).first();
  if (!cheque) throw Object.assign(new Error('Cheque not found'), { status: 404, expose: true });
  const history = await db('cheque_status_history').where({ cheque_id: id }).orderBy('changed_at').orderBy('history_id');
  const postings = await db('transaction_postings as p').join('accounts as a','a.account_id','p.account_id').where({ 'p.transaction_id': cheque.transaction_id }).select('p.*','a.account_no','a.account_name').orderBy('p.posting_id');
  return { cheque, history, postings };
}

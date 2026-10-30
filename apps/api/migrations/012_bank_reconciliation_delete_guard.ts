import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS bank_reconciliation_approval_guard ON bank_reconciliations;
    CREATE TRIGGER bank_reconciliation_approval_guard BEFORE UPDATE OR DELETE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION guard_bank_reconciliation_approval();`);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS bank_reconciliation_approval_guard ON bank_reconciliations;
    CREATE TRIGGER bank_reconciliation_approval_guard BEFORE UPDATE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION guard_bank_reconciliation_approval();`);
}

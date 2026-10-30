import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE OR REPLACE FUNCTION check_opening_batch_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE d NUMERIC(19,4); c NUMERIC(19,4);
    BEGIN
      IF NEW.status='APPROVED' AND OLD.status<>'APPROVED' THEN
        IF EXISTS (SELECT 1 FROM transactions WHERE status='POSTED' AND transaction_date<NEW.effective_date) THEN
          RAISE EXCEPTION 'Opening balance effective date cannot be after an existing posted transaction';
        END IF;
        SELECT COALESCE(SUM(debit_amount),0),COALESCE(SUM(credit_amount),0) INTO d,c
          FROM account_opening_balances WHERE opening_batch_id=NEW.opening_batch_id;
        IF d<>c OR d<>NEW.account_debit_total OR c<>NEW.account_credit_total THEN
          RAISE EXCEPTION 'Opening account balances are not balanced (debits %, credits %)',d,c;
        END IF;
      END IF;
      RETURN NEW;
    END $$;`);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`CREATE OR REPLACE FUNCTION check_opening_batch_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE d NUMERIC(19,4); c NUMERIC(19,4);
    BEGIN
      IF NEW.status='APPROVED' AND OLD.status<>'APPROVED' THEN
        SELECT COALESCE(SUM(debit_amount),0),COALESCE(SUM(credit_amount),0) INTO d,c FROM account_opening_balances WHERE opening_batch_id=NEW.opening_batch_id;
        IF d<>c OR d<>NEW.account_debit_total OR c<>NEW.account_credit_total THEN RAISE EXCEPTION 'Opening account balances are not balanced (debits %, credits %)',d,c; END IF;
      END IF;
      RETURN NEW;
    END $$;`);
}

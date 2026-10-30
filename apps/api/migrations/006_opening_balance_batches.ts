import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE opening_balance_batches (
      opening_batch_id BIGSERIAL PRIMARY KEY,
      effective_date DATE NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
      account_debit_total NUMERIC(19,4) NOT NULL DEFAULT 0,
      account_credit_total NUMERIC(19,4) NOT NULL DEFAULT 0,
      created_by BIGINT NOT NULL REFERENCES users,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_by BIGINT REFERENCES users,
      approved_at TIMESTAMPTZ,
      rejected_by BIGINT REFERENCES users,
      rejected_at TIMESTAMPTZ,
      rejection_reason TEXT,
      CHECK (account_debit_total >= 0 AND account_credit_total >= 0),
      CHECK ((status='APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status<>'APPROVED'),
      CHECK ((status='REJECTED' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL) OR status<>'REJECTED')
    );
    CREATE TABLE opening_balance_batch_audit (
      audit_id BIGSERIAL PRIMARY KEY,
      opening_batch_id BIGINT NOT NULL REFERENCES opening_balance_batches,
      action TEXT NOT NULL,
      old_values JSONB,
      new_values JSONB,
      performed_by BIGINT NOT NULL REFERENCES users,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason TEXT NOT NULL
    );
    INSERT INTO permissions(code,description) VALUES
      ('opening_balances.read','Read opening balance batches'),
      ('opening_balances.prepare','Prepare opening balance batches'),
      ('opening_balances.approve','Approve or reject opening balance batches')
      ON CONFLICT(code) DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
      WHERE r.name='Accounts' AND p.code IN ('opening_balances.read','opening_balances.prepare','opening_balances.approve')
      ON CONFLICT(role_id,permission_id) DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
      WHERE r.name='Viewer' AND p.code='opening_balances.read'
      ON CONFLICT(role_id,permission_id) DO NOTHING;
    ALTER TABLE account_opening_balances ADD COLUMN opening_batch_id BIGINT REFERENCES opening_balance_batches;
    ALTER TABLE account_opening_balances ADD COLUMN approved_at TIMESTAMPTZ;
    ALTER TABLE supplier_opening_balances ADD COLUMN opening_batch_id BIGINT REFERENCES opening_balance_batches;
    ALTER TABLE supplier_opening_balances ADD COLUMN approved_at TIMESTAMPTZ;
    ALTER TABLE customer_opening_balances ADD COLUMN opening_batch_id BIGINT REFERENCES opening_balance_batches;
    ALTER TABLE customer_opening_balances ADD COLUMN approved_at TIMESTAMPTZ;
    ALTER TABLE cashier_opening_balances ADD COLUMN opening_batch_id BIGINT REFERENCES opening_balance_batches;
    ALTER TABLE cashier_opening_balances ADD COLUMN approved_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX account_opening_batch_line_uq ON account_opening_balances(opening_batch_id,account_id) WHERE opening_batch_id IS NOT NULL;
    CREATE UNIQUE INDEX supplier_opening_batch_line_uq ON supplier_opening_balances(opening_batch_id,supplier_id) WHERE opening_batch_id IS NOT NULL;
    CREATE UNIQUE INDEX customer_opening_batch_line_uq ON customer_opening_balances(opening_batch_id,customer_id) WHERE opening_batch_id IS NOT NULL;
    CREATE UNIQUE INDEX cashier_opening_batch_line_uq ON cashier_opening_balances(opening_batch_id,cashier_id) WHERE opening_batch_id IS NOT NULL;
    CREATE UNIQUE INDEX account_opening_once_uq ON account_opening_balances(account_id) WHERE status='APPROVED';
    CREATE UNIQUE INDEX supplier_opening_once_uq ON supplier_opening_balances(supplier_id) WHERE status='APPROVED';
    CREATE UNIQUE INDEX customer_opening_once_uq ON customer_opening_balances(customer_id) WHERE status='APPROVED';
    CREATE UNIQUE INDEX cashier_opening_once_uq ON cashier_opening_balances(cashier_id) WHERE status='APPROVED';

    CREATE FUNCTION check_opening_batch_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE d NUMERIC(19,4); c NUMERIC(19,4); n BIGINT;
    BEGIN
      IF NEW.status='APPROVED' AND OLD.status<>'APPROVED' THEN
        IF EXISTS (SELECT 1 FROM transactions WHERE status='POSTED' AND transaction_date<NEW.effective_date) THEN
          RAISE EXCEPTION 'Opening balance effective date cannot be after an existing posted transaction';
        END IF;
        SELECT COUNT(*),COALESCE(SUM(debit_amount),0),COALESCE(SUM(credit_amount),0) INTO n,d,c
          FROM account_opening_balances WHERE opening_batch_id=NEW.opening_batch_id;
        IF n=0 OR d=0 OR d<>c OR d<>NEW.account_debit_total OR c<>NEW.account_credit_total THEN
          RAISE EXCEPTION 'Opening account balances are not balanced (debits %, credits %)',d,c;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER opening_batch_balanced BEFORE UPDATE OF status ON opening_balance_batches
      FOR EACH ROW EXECUTE FUNCTION check_opening_batch_balanced();

    CREATE FUNCTION guard_opening_batch_final() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status<>'PENDING' THEN RAISE EXCEPTION 'Finalized opening balance batches are immutable'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER opening_batch_final_immutable BEFORE UPDATE OR DELETE ON opening_balance_batches
      FOR EACH ROW EXECUTE FUNCTION guard_opening_batch_final();

    CREATE FUNCTION guard_opening_balance_line() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE batch_status TEXT; old_data JSONB; new_data JSONB;
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.opening_batch_id IS NOT NULL THEN
          SELECT status INTO batch_status FROM opening_balance_batches WHERE opening_batch_id=NEW.opening_batch_id;
          IF batch_status IS DISTINCT FROM 'PENDING' OR NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Opening balance lines can only be added to a pending batch'; END IF;
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP='DELETE' THEN
        IF OLD.opening_batch_id IS NOT NULL THEN
          SELECT status INTO batch_status FROM opening_balance_batches WHERE opening_batch_id=OLD.opening_batch_id;
          IF batch_status IS DISTINCT FROM 'PENDING' THEN RAISE EXCEPTION 'Finalized opening balance lines are immutable'; END IF;
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.opening_batch_id IS NOT NULL THEN
        SELECT status INTO batch_status FROM opening_balance_batches WHERE opening_batch_id=OLD.opening_batch_id;
        IF batch_status IS DISTINCT FROM 'PENDING' THEN
          old_data := to_jsonb(OLD)-'status'-'approved_by'-'approved_at';
          new_data := to_jsonb(NEW)-'status'-'approved_by'-'approved_at';
          IF old_data IS DISTINCT FROM new_data OR NOT ((batch_status='APPROVED' AND OLD.status='PENDING' AND NEW.status='APPROVED') OR (batch_status='REJECTED' AND OLD.status='PENDING' AND NEW.status='REJECTED')) THEN
            RAISE EXCEPTION 'Finalized opening balance lines are immutable';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER account_opening_line_guard BEFORE INSERT OR UPDATE OR DELETE ON account_opening_balances FOR EACH ROW EXECUTE FUNCTION guard_opening_balance_line();
    CREATE TRIGGER supplier_opening_line_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_opening_balances FOR EACH ROW EXECUTE FUNCTION guard_opening_balance_line();
    CREATE TRIGGER customer_opening_line_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_opening_balances FOR EACH ROW EXECUTE FUNCTION guard_opening_balance_line();
    CREATE TRIGGER cashier_opening_line_guard BEFORE INSERT OR UPDATE OR DELETE ON cashier_opening_balances FOR EACH ROW EXECUTE FUNCTION guard_opening_balance_line();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS account_opening_line_guard ON account_opening_balances;
    DROP TRIGGER IF EXISTS supplier_opening_line_guard ON supplier_opening_balances;
    DROP TRIGGER IF EXISTS customer_opening_line_guard ON customer_opening_balances;
    DROP TRIGGER IF EXISTS cashier_opening_line_guard ON cashier_opening_balances;
    DROP TRIGGER IF EXISTS opening_batch_final_immutable ON opening_balance_batches;
    DROP TRIGGER IF EXISTS opening_batch_balanced ON opening_balance_batches;
    DROP FUNCTION IF EXISTS guard_opening_balance_line();
    DROP FUNCTION IF EXISTS guard_opening_batch_final();
    DROP FUNCTION IF EXISTS check_opening_batch_balanced();
    DROP INDEX IF EXISTS account_opening_once_uq;
    DROP INDEX IF EXISTS supplier_opening_once_uq;
    DROP INDEX IF EXISTS customer_opening_once_uq;
    DROP INDEX IF EXISTS cashier_opening_once_uq;
    DROP INDEX IF EXISTS account_opening_batch_line_uq;
    DROP INDEX IF EXISTS supplier_opening_batch_line_uq;
    DROP INDEX IF EXISTS customer_opening_batch_line_uq;
    DROP INDEX IF EXISTS cashier_opening_batch_line_uq;
    ALTER TABLE account_opening_balances DROP COLUMN approved_at, DROP COLUMN opening_batch_id;
    ALTER TABLE supplier_opening_balances DROP COLUMN approved_at, DROP COLUMN opening_batch_id;
    ALTER TABLE customer_opening_balances DROP COLUMN approved_at, DROP COLUMN opening_batch_id;
    ALTER TABLE cashier_opening_balances DROP COLUMN approved_at, DROP COLUMN opening_batch_id;
    DROP TABLE opening_balance_batch_audit;
    DROP TABLE opening_balance_batches;
    DELETE FROM role_permissions WHERE permission_id IN (SELECT permission_id FROM permissions WHERE code LIKE 'opening_balances.%');
    DELETE FROM permissions WHERE code LIKE 'opening_balances.%';
  `);
}

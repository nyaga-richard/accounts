import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE bank_reconciliation_match_items ADD COLUMN posting_id BIGINT REFERENCES transaction_postings;
    ALTER TABLE bank_reconciliations ADD COLUMN ledger_closing_balance NUMERIC(19,4);
    ALTER TABLE bank_reconciliations ADD COLUMN closing_difference NUMERIC(19,4);
    CREATE UNIQUE INDEX bank_reconciliation_statement_once_uq ON bank_reconciliations(statement_id) WHERE statement_id IS NOT NULL;
    CREATE UNIQUE INDEX bank_match_entry_once_uq ON bank_reconciliation_match_items(entry_id) WHERE entry_id IS NOT NULL;
    CREATE UNIQUE INDEX bank_match_posting_once_per_match_uq ON bank_reconciliation_match_items(match_id,posting_id) WHERE posting_id IS NOT NULL;
    CREATE INDEX bank_match_posting_capacity_idx ON bank_reconciliation_match_items(posting_id);

    CREATE FUNCTION validate_bank_match_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE item_count INTEGER; entry_count INTEGER; target_entry BIGINT; allocated NUMERIC(19,4); entry_debit NUMERIC(19,4); entry_credit NUMERIC(19,4); recon_account BIGINT; wrong_postings INTEGER;
    BEGIN
      IF NEW.match_status='CONFIRMED' AND OLD.match_status IS DISTINCT FROM 'CONFIRMED' THEN
        SELECT COUNT(*),COUNT(DISTINCT entry_id),MIN(entry_id),COALESCE(SUM(allocated_amount),0)
          INTO item_count,entry_count,target_entry,allocated
          FROM bank_reconciliation_match_items WHERE match_id=NEW.match_id;
        IF item_count=0 OR entry_count<>1 THEN RAISE EXCEPTION 'A confirmed bank match must allocate against exactly one statement entry'; END IF;
        SELECT r.account_id INTO recon_account FROM bank_reconciliations r WHERE r.reconciliation_id=NEW.reconciliation_id AND r.status='PREPARED';
        IF recon_account IS NULL THEN RAISE EXCEPTION 'Bank reconciliation is missing or finalized'; END IF;
        SELECT debit,credit INTO entry_debit,entry_credit FROM bank_statement_entries WHERE entry_id=target_entry AND processing_status='UNMATCHED';
        IF NOT FOUND THEN RAISE EXCEPTION 'Statement entry is missing or already matched'; END IF;
        IF (entry_debit>0 AND entry_credit>0) OR (entry_debit=0 AND entry_credit=0) OR allocated<>GREATEST(entry_debit,entry_credit) THEN
          RAISE EXCEPTION 'Confirmed allocations must exactly equal a single-sided bank statement entry';
        END IF;
        SELECT COUNT(*) INTO wrong_postings FROM bank_reconciliation_match_items i
          JOIN transaction_postings p ON p.posting_id=i.posting_id
          JOIN transactions t ON t.transaction_id=p.transaction_id
          WHERE i.match_id=NEW.match_id AND (p.account_id<>recon_account OR t.status<>'POSTED' OR
            (entry_credit>0 AND p.debit_amount<=p.credit_amount) OR (entry_debit>0 AND p.credit_amount<=p.debit_amount));
        IF wrong_postings>0 THEN RAISE EXCEPTION 'Match items must be posted journal lines on the reconciled bank account with the matching direction'; END IF;
      END IF;
      IF OLD.match_status='CONFIRMED' AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Confirmed bank matches are immutable'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER bank_match_confirm_guard BEFORE UPDATE OR DELETE ON bank_reconciliation_matches FOR EACH ROW EXECUTE FUNCTION validate_bank_match_confirmation();

    CREATE FUNCTION guard_bank_match_item() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE match_state TEXT;
    BEGIN
      IF TG_OP='INSERT' THEN
        SELECT match_status INTO match_state FROM bank_reconciliation_matches WHERE match_id=NEW.match_id;
        IF match_state IS DISTINCT FROM 'PROPOSED' THEN RAISE EXCEPTION 'Bank match items can only be added while a proposal is pending'; END IF;
        IF NEW.posting_id IS NULL OR NEW.allocated_amount IS NULL OR NEW.allocated_amount<=0 THEN RAISE EXCEPTION 'Bank match items require a posting and a positive allocation'; END IF;
        RETURN NEW;
      END IF;
      SELECT match_status INTO match_state FROM bank_reconciliation_matches WHERE match_id=OLD.match_id;
      IF match_state='CONFIRMED' THEN RAISE EXCEPTION 'Items in a confirmed bank match are immutable'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER bank_match_item_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_reconciliation_match_items FOR EACH ROW EXECUTE FUNCTION guard_bank_match_item();

    CREATE FUNCTION guard_matched_statement_entry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.processing_status='MATCHED' AND OLD.processing_status IS DISTINCT FROM 'MATCHED' AND NOT EXISTS (
        SELECT 1 FROM bank_reconciliation_match_items i JOIN bank_reconciliation_matches m ON m.match_id=i.match_id
        WHERE i.entry_id=NEW.entry_id AND m.match_status='CONFIRMED'
      ) THEN RAISE EXCEPTION 'A statement entry cannot be marked matched without a confirmed bank match'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER matched_statement_entry_guard BEFORE UPDATE OF processing_status ON bank_statement_entries FOR EACH ROW EXECUTE FUNCTION guard_matched_statement_entry();

    CREATE FUNCTION guard_bank_reconciliation_approval() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE pending_count INTEGER;
    BEGIN
      IF OLD.status='APPROVED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Approved bank reconciliations are immutable'; END IF;
      IF NEW.status='APPROVED' AND OLD.status<>'APPROVED' THEN
        SELECT COUNT(*) INTO pending_count FROM bank_statement_entries WHERE statement_id=NEW.statement_id AND processing_status<>'MATCHED';
        IF pending_count>0 THEN RAISE EXCEPTION 'Every statement entry must be matched before approval'; END IF;
        IF NEW.closing_difference IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Bank reconciliation difference must be zero before approval'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER bank_reconciliation_approval_guard BEFORE UPDATE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION guard_bank_reconciliation_approval();
  `);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS bank_reconciliation_approval_guard ON bank_reconciliations;
    DROP TRIGGER IF EXISTS matched_statement_entry_guard ON bank_statement_entries;
    DROP TRIGGER IF EXISTS bank_match_item_guard ON bank_reconciliation_match_items;
    DROP TRIGGER IF EXISTS bank_match_confirm_guard ON bank_reconciliation_matches;
    DROP FUNCTION IF EXISTS guard_bank_reconciliation_approval();
    DROP FUNCTION IF EXISTS guard_matched_statement_entry();
    DROP FUNCTION IF EXISTS guard_bank_match_item();
    DROP FUNCTION IF EXISTS validate_bank_match_confirmation();
    DROP INDEX IF EXISTS bank_match_posting_capacity_idx;
    DROP INDEX IF EXISTS bank_match_posting_once_per_match_uq;
    DROP INDEX IF EXISTS bank_match_entry_once_uq;
    DROP INDEX IF EXISTS bank_reconciliation_statement_once_uq;
    ALTER TABLE bank_reconciliations DROP COLUMN closing_difference, DROP COLUMN ledger_closing_balance;
    ALTER TABLE bank_reconciliation_match_items DROP COLUMN posting_id;
  `);
}

import type {Knex} from 'knex';
export async function up(knex:Knex){await knex.raw(`CREATE UNIQUE INDEX transaction_reversals_original_once ON transaction_reversals(original_transaction_id);`);}
export async function down(knex:Knex){await knex.raw(`DROP INDEX transaction_reversals_original_once;`);}

import type {Knex} from 'knex';
export async function up(knex:Knex){await knex.raw(`ALTER TABLE transaction_type_rules ADD COLUMN party_account_side TEXT NOT NULL DEFAULT 'NONE' CHECK(party_account_side IN('DEBIT','CREDIT','NONE'));`);}
export async function down(knex:Knex){await knex.raw(`ALTER TABLE transaction_type_rules DROP COLUMN party_account_side;`);}

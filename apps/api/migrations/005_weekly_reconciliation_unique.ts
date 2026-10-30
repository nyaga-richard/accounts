import type {Knex} from 'knex';
export async function up(knex:Knex){await knex.raw(`CREATE UNIQUE INDEX weekly_reconciliations_closing_once ON weekly_reconciliations(weekly_closing_id) WHERE weekly_closing_id IS NOT NULL;`);}
export async function down(knex:Knex){await knex.raw(`DROP INDEX weekly_reconciliations_closing_once;`);}

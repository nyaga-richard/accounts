import knex from 'knex';
export const db = knex({client:'pg', connection: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://ledgerway:ledgerway@localhost:5432/ledgerway', pool:{min:0,max:10}});

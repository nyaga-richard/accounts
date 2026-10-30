import 'dotenv/config';
const config = { client: 'pg', connection: process.env.DATABASE_URL || 'postgres://ledgerway:ledgerway@localhost:5432/ledgerway', migrations: { directory: './migrations', extension: 'ts' }, pool: { min: 0, max: 10 } };
export default config;

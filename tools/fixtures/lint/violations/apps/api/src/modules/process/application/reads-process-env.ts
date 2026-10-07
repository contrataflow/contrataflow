// Violação: contrataflow/no-process-env (configuração lida fora de src/config/**).
export const databaseUrl = process.env['DATABASE_URL'];

/** Cliente Prisma único do processo (um pool), compartilhado pelas duas formas de transação. */
export const DATABASE_CLIENT = Symbol('DatabaseClient');

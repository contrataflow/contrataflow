import { z } from 'zod';

/** Chave primária: UUIDv7 gerado pela aplicação (DEC-002). */
export const uuidV7Schema = z.uuidv7({ error: 'Informe um identificador UUIDv7 válido.' });

export type UuidV7 = z.infer<typeof uuidV7Schema>;

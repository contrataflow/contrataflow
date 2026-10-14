import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: '' }) });

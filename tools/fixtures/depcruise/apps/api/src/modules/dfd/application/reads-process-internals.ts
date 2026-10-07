// Violação: cross-module-only-via-facade.
import { PrismaProcessRepository } from '../../process/infrastructure/prisma-process.repository.js';

export const repository = PrismaProcessRepository;

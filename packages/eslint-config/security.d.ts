import type { Linter } from 'eslint';

export declare const CODE_FILES: string[];
export declare const BFF_FILES: string[];
export declare const SECURITY_ALLOWLISTS: Readonly<{
  processEnv: string[];
  redis: string[];
  prisma: string[];
  prismaClient: string[];
  dangerousHtml: string[];
  console: string[];
}>;
export declare function security(): Linter.Config[];

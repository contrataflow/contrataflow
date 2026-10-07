import type { Linter } from 'eslint';

export interface ConfigOptions {
  /** Diretório do pacote (`import.meta.dirname`). */
  readonly tsconfigRootDir: string;
}

export declare const GLOBAL_IGNORES: string[];
export declare const DEV_FILES: string[];
export declare function base(options: ConfigOptions): Linter.Config[];

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

/** Raiz do monorepo (tools/lib → ../..). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export type Catalog = Readonly<Record<string, string>>;

export interface WorkspaceConfig {
  readonly packages: readonly string[];
  /** Catálogo padrão (`catalog:`). */
  readonly catalog: Catalog;
  /** Catálogos nomeados (`catalog:<nome>`). */
  readonly catalogs: Readonly<Record<string, Catalog>>;
}

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

export type Manifest = {
  /** Caminho do package.json relativo à raiz, com `/`. */
  readonly path: string;
  readonly name: string;
} & Partial<Record<DependencyField, Readonly<Record<string, string>>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCatalog(value: unknown): Catalog {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => [name, String(version)]),
  );
}

/** Interpreta o conteúdo de pnpm-workspace.yaml. */
export function parseWorkspaceConfig(text: string): WorkspaceConfig {
  const raw: unknown = parse(text);
  const data = isRecord(raw) ? raw : {};
  const packages = Array.isArray(data.packages) ? data.packages.map(String) : [];
  const catalogs = isRecord(data.catalogs)
    ? Object.fromEntries(
        Object.entries(data.catalogs).map(([name, entries]) => [name, toCatalog(entries)]),
      )
    : {};
  return { packages, catalog: toCatalog(data.catalog), catalogs };
}

export function readWorkspaceConfig(root: string): WorkspaceConfig {
  return parseWorkspaceConfig(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
}

/** Expande os padrões de `packages` (`dir/*` ou `dir`) em diretórios com package.json. */
export function expandPackagePatterns(root: string, patterns: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent).sort()) {
        const dir = path.join(parent, entry);
        if (statSync(dir).isDirectory() && existsSync(path.join(dir, 'package.json'))) {
          dirs.push(dir);
        }
      }
    } else if (existsSync(path.join(root, pattern, 'package.json'))) {
      dirs.push(path.join(root, pattern));
    }
  }
  return dirs;
}

export function readManifest(root: string, dir: string): Manifest {
  const file = path.join(dir, 'package.json');
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const data = isRecord(raw) ? raw : {};
  const manifest: Record<string, unknown> = {
    path: path.relative(root, file).split(path.sep).join('/'),
    name: typeof data.name === 'string' ? data.name : '(sem nome)',
  };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = data[field];
    if (isRecord(deps)) manifest[field] = toCatalog(deps);
  }
  return manifest as Manifest;
}

/** package.json da raiz e de todos os pacotes do workspace. */
export function listWorkspaceManifests(root: string, config: WorkspaceConfig): Manifest[] {
  return [root, ...expandPackagePatterns(root, config.packages)].map((dir) =>
    readManifest(root, dir),
  );
}

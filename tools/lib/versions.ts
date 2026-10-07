import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

import { DEPENDENCY_FIELDS, listWorkspaceManifests, readWorkspaceConfig } from './workspace.js';
import type { Catalog, Manifest, WorkspaceConfig } from './workspace.js';

/** Códigos de saída do `pnpm check:versions` (V-02 e V-08 da US-077). */
export type VersionViolationCode = 'VERSION_NOT_PINNED' | 'DUPLICATE_MAJOR';

export interface VersionViolation {
  readonly code: VersionViolationCode;
  /** Onde corrigir: arquivo e, quando houver, pacote/dependência. */
  readonly location: string;
  readonly message: string;
}

/** Versão exata `x.y.z` — sem faixas, tags ou pré-lançamentos. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Bibliotecas críticas que não podem ter duas majors no lockfile (V-08). */
export const CRITICAL_PACKAGES = [
  'react',
  'zod',
  '@prisma/client',
  '@nestjs/core',
  'bullmq',
] as const;

const INTERNAL_SCOPE = '@contrataflow/';
const CATALOG_SPEC = /^catalog:([A-Za-z0-9_-]*)$/;
const DEFAULT_CATALOG = 'default';

function notPinned(location: string, dependency: string, detail: string): VersionViolation {
  return {
    code: 'VERSION_NOT_PINNED',
    location,
    message: `A dependência ${dependency} deve usar \`catalog:\` com versão exata. ${detail}`,
  };
}

function catalogNamed(config: WorkspaceConfig, name: string): Catalog | undefined {
  return name === DEFAULT_CATALOG
    ? (config.catalogs[DEFAULT_CATALOG] ?? config.catalog)
    : config.catalogs[name];
}

/** Toda entrada dos catálogos tem versão exata (RN-FND-01). */
export function checkCatalogs(config: WorkspaceConfig): VersionViolation[] {
  const all: [string, Catalog][] = [
    [DEFAULT_CATALOG, config.catalog],
    ...Object.entries(config.catalogs),
  ];
  return all.flatMap(([catalogName, entries]) =>
    Object.entries(entries)
      .filter(([, version]) => !EXACT_VERSION.test(version))
      .map(([dependency, version]) =>
        notPinned(
          `pnpm-workspace.yaml → catálogo "${catalogName}"`,
          dependency,
          `Encontrado "${version}"; use a versão exata (ex.: "1.2.3").`,
        ),
      ),
  );
}

/** Dependências externas via `catalog:`; internas via `workspace:*` (RN-FND-01/04). */
export function checkManifests(
  manifests: readonly Manifest[],
  config: WorkspaceConfig,
): VersionViolation[] {
  const violations: VersionViolation[] = [];
  for (const manifest of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        const location = `${manifest.path} (${manifest.name}) → ${field}.${dependency}`;
        if (dependency.startsWith(INTERNAL_SCOPE)) {
          if (spec !== 'workspace:*') {
            violations.push({
              code: 'VERSION_NOT_PINNED',
              location,
              message: `O pacote interno ${dependency} deve usar "workspace:*" (encontrado "${spec}").`,
            });
          }
          continue;
        }
        const match = CATALOG_SPEC.exec(spec);
        if (!match) {
          violations.push(notPinned(location, dependency, `Encontrado "${spec}".`));
          continue;
        }
        const catalogName = match[1] === '' || match[1] === undefined ? DEFAULT_CATALOG : match[1];
        const catalog = catalogNamed(config, catalogName);
        if (catalog?.[dependency] === undefined) {
          violations.push(
            notPinned(
              location,
              dependency,
              `Não há entrada para ${dependency} no catálogo "${catalogName}" de pnpm-workspace.yaml.`,
            ),
          );
        }
      }
    }
  }
  return violations;
}

/** Versões de cada pacote presentes no lockfile (`packages:` do pnpm-lock.yaml v9). */
export function lockfileVersions(lockfileText: string): Map<string, Set<string>> {
  const raw: unknown = parse(lockfileText);
  const packages =
    typeof raw === 'object' && raw !== null && 'packages' in raw ? raw.packages : undefined;
  const versions = new Map<string, Set<string>>();
  if (typeof packages !== 'object' || packages === null) return versions;
  for (const entry of Object.keys(packages)) {
    // Remove o sufixo de peers: `next@16.3.8(react@19.2.8)` → `next@16.3.8`.
    const key = entry.replace(/\(.*$/, '');
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    const set = versions.get(name) ?? new Set<string>();
    set.add(version);
    versions.set(name, set);
  }
  return versions;
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  return a.localeCompare(b);
}

/** Uma única major de cada biblioteca crítica entre lockfile e catálogos (V-08). */
export function checkDuplicateMajors(
  locked: ReadonlyMap<string, ReadonlySet<string>>,
  config: WorkspaceConfig,
  critical: readonly string[] = CRITICAL_PACKAGES,
): VersionViolation[] {
  const catalogs = [config.catalog, ...Object.values(config.catalogs)];
  return critical.flatMap((name) => {
    const found = new Set(locked.get(name) ?? []);
    for (const catalog of catalogs) {
      const pinned = catalog[name];
      if (pinned !== undefined) found.add(pinned);
    }
    const majors = new Set([...found].map(majorOf));
    if (majors.size <= 1) return [];
    const list = [...found].sort(compareVersions).join(', ');
    return [
      {
        code: 'DUPLICATE_MAJOR' as const,
        location: `pnpm-lock.yaml → ${name}`,
        message: `Versões duplicadas de ${name}: ${list}.`,
      },
    ];
  });
}

/** Todas as verificações sobre o repositório em `root`. */
export function checkRepository(root: string): VersionViolation[] {
  const config = readWorkspaceConfig(root);
  const lockfile = path.join(root, 'pnpm-lock.yaml');
  const locked = existsSync(lockfile)
    ? lockfileVersions(readFileSync(lockfile, 'utf8'))
    : new Map<string, Set<string>>();
  return [
    ...checkCatalogs(config),
    ...checkManifests(listWorkspaceManifests(root, config), config),
    ...checkDuplicateMajors(locked, config),
  ];
}

export function formatViolation({ code, location, message }: VersionViolation): string {
  return `${code}  ${location}\n  ${message}`;
}

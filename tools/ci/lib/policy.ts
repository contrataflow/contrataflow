// Política versionada do pipeline (US-079 — Campos): `.github/ci-policy.yml`, protegido pelo
// CODEOWNERS (Tech Lead + segurança). Cobertura (RN-FND-24), licenças (RN-FND-10) e exceções de
// CVE sem correção disponível (RN-FND-26 · FA-03).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

import { REPO_ROOT } from '../../lib/workspace.js';

export const POLICY_FILE = '.github/ci-policy.yml';

export interface LicenseException {
  /** Nome do pacote; `*` no fim casa com um prefixo (ex.: `@img/sharp-*`). */
  readonly package: string;
  /** Expressão de licença exatamente como o pacote declara. */
  readonly license: string;
  readonly reason: string;
  readonly approvedBy: string;
}

export interface CveException {
  readonly id: string;
  /** Pacote afetado; ausente = qualquer pacote com esse identificador. */
  readonly package?: string;
  readonly reason: string;
  /** Prazo de revisão (AAAA-MM-DD); vencido, a exceção deixa de valer (FA-03). */
  readonly reviewBy: string;
  readonly owner: string;
}

export interface CiPolicy {
  /** `ci.coverageThreshold` — 0 a 100 (padrão 80). */
  readonly coverageThreshold: number;
  /** `ci.coverageGateEnabled` — desativar só por decisão registrada da liderança técnica. */
  readonly coverageGateEnabled: boolean;
  readonly licenses: {
    readonly allowed: readonly string[];
    readonly exceptions: readonly LicenseException[];
  };
  readonly cveExceptions: readonly CveException[];
}

export class PolicyError extends Error {}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(entry: Raw, field: string, where: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PolicyError(`${POLICY_FILE}: ${where}.${field} é obrigatório (texto não vazio).`);
  }
  return value.trim();
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PolicyError(`${POLICY_FILE}: ${where} deve ser uma lista.`);
  return value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function parsePolicy(source: string): CiPolicy {
  const raw: unknown = parse(source);
  if (!isRecord(raw)) throw new PolicyError(`${POLICY_FILE}: documento vazio ou inválido.`);
  const ci = isRecord(raw.ci) ? raw.ci : {};

  const threshold = ci.coverageThreshold ?? 80;
  if (typeof threshold !== 'number' || threshold < 0 || threshold > 100) {
    throw new PolicyError(`${POLICY_FILE}: ci.coverageThreshold deve ser um número de 0 a 100.`);
  }
  const gate = ci.coverageGateEnabled ?? true;
  if (typeof gate !== 'boolean') {
    throw new PolicyError(`${POLICY_FILE}: ci.coverageGateEnabled deve ser true ou false.`);
  }

  const licenses = isRecord(raw.licenses) ? raw.licenses : {};
  const allowed = list(licenses.allowed, 'licenses.allowed').map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PolicyError(`${POLICY_FILE}: licenses.allowed[${index}] deve ser um SPDX.`);
    }
    return item.trim();
  });
  const licenseExceptions = list(licenses.exceptions, 'licenses.exceptions').map(
    (item, index): LicenseException => {
      const where = `licenses.exceptions[${index}]`;
      if (!isRecord(item)) throw new PolicyError(`${POLICY_FILE}: ${where} deve ser um objeto.`);
      return {
        package: text(item, 'package', where),
        license: text(item, 'license', where),
        reason: text(item, 'reason', where),
        approvedBy: text(item, 'approvedBy', where),
      };
    },
  );

  const cve = isRecord(raw.cve) ? raw.cve : {};
  const cveExceptions = list(cve.exceptions, 'cve.exceptions').map((item, index): CveException => {
    const where = `cve.exceptions[${index}]`;
    if (!isRecord(item)) throw new PolicyError(`${POLICY_FILE}: ${where} deve ser um objeto.`);
    const reviewBy = text(item, 'reviewBy', where);
    if (!isValidDate(reviewBy)) {
      throw new PolicyError(`${POLICY_FILE}: ${where}.reviewBy deve ser uma data AAAA-MM-DD.`);
    }
    const pkg = item.package;
    return {
      id: text(item, 'id', where),
      ...(typeof pkg === 'string' && pkg.trim() !== '' ? { package: pkg.trim() } : {}),
      reason: text(item, 'reason', where),
      reviewBy,
      owner: text(item, 'owner', where),
    };
  });

  return {
    coverageThreshold: threshold,
    coverageGateEnabled: gate,
    licenses: { allowed, exceptions: licenseExceptions },
    cveExceptions,
  };
}

export function readPolicy(root: string = REPO_ROOT): CiPolicy {
  return parsePolicy(readFileSync(path.join(root, POLICY_FILE), 'utf8'));
}

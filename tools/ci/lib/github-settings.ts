// Proteção da `main` e configuração do repositório como código (US-079 — RN-FND-20 · Permissões):
// `.github/repository-settings.json` descreve o estado desejado; daqui saem os payloads da API do
// GitHub (ruleset da `main`, opções de merge, permissões do Actions e ambientes). Os revisores
// obrigatórios por caminho vêm do CODEOWNERS (DEC-062: Tech Lead **e** segurança nas áreas sensíveis).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { CodeownersRule } from '../../lib/codeowners.js';
import { REPO_ROOT } from '../../lib/workspace.js';

export const SETTINGS_FILE = '.github/repository-settings.json';

/** App "GitHub Actions": só checks emitidos por ele satisfazem a ruleset (sem status forjado). */
export const GITHUB_ACTIONS_APP_ID = 15368;

export interface EnvironmentSettings {
  readonly name: string;
  /** Slugs de times que aprovam o deploy (ex.: `tech-lead`). */
  readonly reviewers: readonly string[];
  readonly wait_timer: number;
  readonly prevent_self_review: boolean;
}

export interface RepositorySettings {
  readonly organization: string;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly actions: {
    readonly default_workflow_permissions: 'read' | 'write';
    readonly can_approve_pull_request_reviews: boolean;
    readonly fork_pr_approval_policy: string;
  };
  readonly ruleset: {
    readonly name: string;
    readonly requiredStatusChecks: readonly string[];
    readonly strict: boolean;
    readonly pullRequest: Readonly<Record<string, unknown>>;
    /** Achados do CodeQL acima do limiar bloqueiam o merge (regra `code_scanning`). */
    readonly codeScanning: {
      readonly tool: string;
      readonly security_alerts_threshold: string;
      readonly alerts_threshold: string;
    };
  };
  readonly environments: readonly EnvironmentSettings[];
}

export function readSettings(root: string = REPO_ROOT): RepositorySettings {
  return JSON.parse(readFileSync(path.join(root, SETTINGS_FILE), 'utf8')) as RepositorySettings;
}

const TEAM = /^@([^/]+)\/(.+)$/;

/**
 * Times que precisam APROVAR quando um caminho tem mais de um dono: todos os listados, exceto
 * `platform` quando `security` também está (a regra é "Tech Lead + segurança/plataforma":
 * plataforma é chamada a revisar, segurança é a aprovação obrigatória). O time padrão
 * `engineering` só exige a aprovação comum do CODEOWNERS.
 */
export function requiredTeams(owners: readonly string[]): string[] {
  const teams = owners
    .map((owner) => TEAM.exec(owner)?.[2])
    .filter((team): team is string => team !== undefined && team !== 'engineering');
  if (teams.length < 2) return [];
  return teams.filter((team) => !(team === 'platform' && teams.includes('security')));
}

/** Padrão do CODEOWNERS → `fnmatch` da ruleset (`/apps/api/src/shared/` → `apps/api/src/shared/**\/*`). */
export function toFnmatch(pattern: string): string {
  const anchored = pattern.replace(/^\//, '');
  if (anchored.endsWith('/')) return `${anchored}**/*`;
  return anchored;
}

export interface RequiredReviewer {
  readonly team: string;
  readonly patterns: readonly string[];
}

export function requiredReviewers(rules: readonly CodeownersRule[]): RequiredReviewer[] {
  const byTeam = new Map<string, string[]>();
  for (const rule of rules) {
    for (const team of requiredTeams(rule.owners)) {
      const list = byTeam.get(team) ?? [];
      list.push(toFnmatch(rule.pattern));
      byTeam.set(team, list);
    }
  }
  return [...byTeam.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, patterns]) => ({ team, patterns: [...new Set(patterns)] }));
}

/** Payload de `POST/PUT /repos/{owner}/{repo}/rulesets` para a branch padrão. */
export function buildRuleset(
  settings: RepositorySettings,
  rules: readonly CodeownersRule[],
  teamIds: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const teamId = (team: string) => {
    const id = teamIds.get(team);
    if (id === undefined) throw new Error(`time @${settings.organization}/${team} não encontrado`);
    return id;
  };
  return {
    name: settings.ruleset.name,
    target: 'branch',
    enforcement: 'active',
    // Sem bypass: nem administradores mesclam sem os gates (DoD: "impossível mesclar sem passar").
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: settings.ruleset.strict,
          do_not_enforce_on_create: false,
          required_status_checks: settings.ruleset.requiredStatusChecks.map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS_APP_ID,
          })),
        },
      },
      {
        type: 'code_scanning',
        parameters: { code_scanning_tools: [settings.ruleset.codeScanning] },
      },
      {
        type: 'pull_request',
        parameters: {
          ...settings.ruleset.pullRequest,
          required_reviewers: requiredReviewers(rules).map((item) => ({
            file_patterns: item.patterns,
            minimum_approvals: 1,
            reviewer: { id: teamId(item.team), type: 'Team' },
          })),
        },
      },
    ],
  };
}

/** Payload de `PUT /repos/{owner}/{repo}/environments/{name}`. */
export function buildEnvironment(
  environment: EnvironmentSettings,
  teamIds: ReadonlyMap<string, number>,
): Record<string, unknown> {
  return {
    wait_timer: environment.wait_timer,
    prevent_self_review: environment.prevent_self_review,
    reviewers: environment.reviewers.map((team) => {
      const id = teamIds.get(team);
      if (id === undefined) throw new Error(`time ${team} não encontrado`);
      return { type: 'Team', id };
    }),
    // Deploy só a partir de branch protegida (a `main`).
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  };
}

/** Times citados no CODEOWNERS e nos ambientes (para resolver os ids pela API). */
export function teamsToResolve(
  settings: RepositorySettings,
  rules: readonly CodeownersRule[],
): string[] {
  const teams = new Set<string>();
  for (const item of requiredReviewers(rules)) teams.add(item.team);
  for (const environment of settings.environments) {
    for (const team of environment.reviewers) teams.add(team);
  }
  return [...teams].sort();
}

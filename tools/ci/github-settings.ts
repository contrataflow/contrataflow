// pnpm ci:github-settings [--apply] [--repo dono/nome]
// Aplica `.github/repository-settings.json` ao repositório no GitHub (US-079 — branch protection,
// ambientes e permissões do Actions). Sem `--apply`, só mostra os payloads (dry-run).
// Exige GH_TOKEN de quem administra o repositório (Tech Lead/plataforma); o token nunca é impresso.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseCodeowners } from '../lib/codeowners.js';
import { REPO_ROOT } from '../lib/workspace.js';
import {
  buildEnvironment,
  buildRuleset,
  readSettings,
  SETTINGS_FILE,
  teamsToResolve,
} from './lib/github-settings.js';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? '' },
  },
});

const settings = readSettings();
const rules = parseCodeowners(readFileSync(path.join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8'));
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const repo = values.repo;

async function api(method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} → ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

const teams = teamsToResolve(settings, rules);
const teamIds = new Map<string, number>();
if (values.apply) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error('✖ --apply exige GH_TOKEN e --repo dono/nome.');
    process.exit(1);
  }
  for (const team of teams) {
    const found = (await api('GET', `/orgs/${settings.organization}/teams/${team}`)) as {
      id: number;
    };
    teamIds.set(team, found.id);
  }
} else {
  // Dry-run: ids fictícios só para mostrar a forma dos payloads.
  teams.forEach((team, index) => teamIds.set(team, index + 1));
}

const ruleset = buildRuleset(settings, rules, teamIds);
const environments = settings.environments.map((environment) => ({
  name: environment.name,
  payload: buildEnvironment(environment, teamIds),
}));

if (!values.apply) {
  console.log(`Dry-run de ${SETTINGS_FILE} (ids de time fictícios). Use --apply para aplicar.\n`);
  console.log(
    JSON.stringify(
      { repository: settings.repository, actions: settings.actions, ruleset, environments },
      null,
      2,
    ),
  );
  process.exit(0);
}

await api('PATCH', `/repos/${repo}`, settings.repository);
await api('PUT', `/repos/${repo}/actions/permissions/workflow`, {
  default_workflow_permissions: settings.actions.default_workflow_permissions,
  can_approve_pull_request_reviews: settings.actions.can_approve_pull_request_reviews,
});
await api('PUT', `/repos/${repo}/actions/permissions/fork-pr-contributor-approval`, {
  approval_policy: settings.actions.fork_pr_approval_policy,
});
const existing = (await api('GET', `/repos/${repo}/rulesets`)) as { id: number; name: string }[];
const current = existing.find((item) => item.name === settings.ruleset.name);
await (current
  ? api('PUT', `/repos/${repo}/rulesets/${current.id}`, ruleset)
  : api('POST', `/repos/${repo}/rulesets`, ruleset));
for (const environment of environments) {
  await api(
    'PUT',
    `/repos/${repo}/environments/${encodeURIComponent(environment.name)}`,
    environment.payload,
  );
}
console.log(`✔ ${SETTINGS_FILE} aplicado em ${repo}.`);

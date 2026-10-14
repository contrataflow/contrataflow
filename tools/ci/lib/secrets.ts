// Achados do gitleaks (US-079 — V-02): só caminho, linha e regra chegam ao log e às anotações;
// o valor encontrado nunca é impresso (o relatório já sai com `--redact`).

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly commit: string;
}

interface GitleaksEntry {
  readonly File?: string;
  readonly StartLine?: number;
  readonly RuleID?: string;
  readonly Commit?: string;
}

/** Interpreta o relatório JSON do gitleaks; caminhos ficam relativos à raiz montada (`/repo`). */
export function parseGitleaksReport(json: string, mountPoint = '/repo/'): SecretFinding[] {
  const trimmed = json.trim();
  if (trimmed === '') return [];
  const entries = JSON.parse(trimmed) as readonly GitleaksEntry[] | null;
  return (entries ?? []).map((entry) => ({
    file: (entry.File ?? '?').replace(mountPoint, ''),
    line: entry.StartLine ?? 0,
    rule: entry.RuleID ?? '?',
    commit: (entry.Commit ?? '').slice(0, 12),
  }));
}

export function secretMessage(finding: SecretFinding): string {
  return `Segredo detectado em ${finding.file}:${finding.line}. Remova e rotacione.`;
}

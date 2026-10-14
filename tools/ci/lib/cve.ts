// Gate de vulnerabilidades do estágio "Imagens" (US-079 — RN-FND-26 · FA-03 · V-09) sobre o
// relatório JSON do Trivy: CVE crítica/alta COM correção disponível bloqueia; SEM correção vira
// exceção registrada com prazo de revisão em `.github/ci-policy.yml`. Exceção vencida deixa de
// valer (a CVE volta ao relatório como pendência) e gera alerta.
import type { CveException } from './policy.js';

export const BLOCKING_SEVERITIES = ['CRITICAL', 'HIGH'] as const;

export interface Vulnerability {
  readonly id: string;
  readonly pkg: string;
  readonly installed: string;
  readonly fixed: string;
  readonly severity: string;
  readonly target: string;
  readonly title: string;
}

interface TrivyVulnerability {
  readonly VulnerabilityID?: string;
  readonly PkgName?: string;
  readonly InstalledVersion?: string;
  readonly FixedVersion?: string;
  readonly Severity?: string;
  readonly Title?: string;
}

interface TrivyResult {
  readonly Target?: string;
  readonly Vulnerabilities?: readonly TrivyVulnerability[] | null;
}

interface TrivyReport {
  readonly Results?: readonly TrivyResult[] | null;
}

/** Vulnerabilidades críticas/altas do relatório (`trivy image --format json`), sem repetição. */
export function parseTrivyReport(json: string): Vulnerability[] {
  const report = JSON.parse(json) as TrivyReport;
  const seen = new Set<string>();
  const result: Vulnerability[] = [];
  for (const entry of report.Results ?? []) {
    for (const vuln of entry.Vulnerabilities ?? []) {
      const severity = (vuln.Severity ?? '').toUpperCase();
      if (!(BLOCKING_SEVERITIES as readonly string[]).includes(severity)) continue;
      const item: Vulnerability = {
        id: vuln.VulnerabilityID ?? '?',
        pkg: vuln.PkgName ?? '?',
        installed: vuln.InstalledVersion ?? '',
        fixed: (vuln.FixedVersion ?? '').trim(),
        severity,
        target: entry.Target ?? '',
        title: vuln.Title ?? '',
      };
      const key = `${item.id}|${item.pkg}|${item.installed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export interface CveVerdict {
  /** Com correção disponível: bloqueiam o merge. */
  readonly blocking: readonly Vulnerability[];
  /** Sem correção e com exceção dentro do prazo. */
  readonly excepted: readonly { vuln: Vulnerability; exception: CveException }[];
  /** Sem correção e sem exceção: não bloqueiam, mas precisam ser registradas. */
  readonly unregistered: readonly Vulnerability[];
  /** Sem correção e com exceção vencida: alerta para o time (FA-03). */
  readonly expired: readonly { vuln: Vulnerability; exception: CveException }[];
}

/** `today` no formato AAAA-MM-DD; a exceção vale até o fim do dia `reviewBy`. */
export function evaluateCves(
  vulns: readonly Vulnerability[],
  exceptions: readonly CveException[],
  today: string,
): CveVerdict {
  const blocking: Vulnerability[] = [];
  const excepted: { vuln: Vulnerability; exception: CveException }[] = [];
  const unregistered: Vulnerability[] = [];
  const expired: { vuln: Vulnerability; exception: CveException }[] = [];
  for (const vuln of vulns) {
    if (vuln.fixed !== '') {
      blocking.push(vuln);
      continue;
    }
    const exception = exceptions.find(
      (item) => item.id === vuln.id && (item.package === undefined || item.package === vuln.pkg),
    );
    if (!exception) unregistered.push(vuln);
    else if (exception.reviewBy >= today) excepted.push({ vuln, exception });
    else expired.push({ vuln, exception });
  }
  return { blocking, excepted, unregistered, expired };
}

export function blockingMessage(vuln: Vulnerability): string {
  return `Vulnerabilidade ${vuln.id} em ${vuln.pkg}. Atualize para ${vuln.fixed}.`;
}

// Deploy no ECS (US-079 — pós-merge; architecture.md §11.4): nova revisão da task definition com a
// imagem por digest (assinada e verificada antes), na ordem migração → api/worker → web. Os nomes
// (cluster, serviços, famílias) vêm das variáveis do ambiente do GitHub, definidas pelo Terraform.

/** Campos de `describe-task-definition` que o `register-task-definition` não aceita. */
const READ_ONLY = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
] as const;

type TaskDefinition = Record<string, unknown> & {
  containerDefinitions?: (Record<string, unknown> & { name?: string; image?: string })[];
};

/** Revisão nova com `image` no contêiner `container`; falha se o contêiner não existir. */
export function withImage(
  taskDefinition: TaskDefinition,
  container: string,
  image: string,
): TaskDefinition {
  const copy: TaskDefinition = { ...taskDefinition };
  for (const field of READ_ONLY) Reflect.deleteProperty(copy, field);
  const containers = taskDefinition.containerDefinitions ?? [];
  if (!containers.some((item) => item.name === container)) {
    throw new Error(`task definition sem o contêiner "${container}"`);
  }
  copy.containerDefinitions = containers.map((item) =>
    item.name === container ? { ...item, image } : item,
  );
  return copy;
}

/** Ordem do rollout: `api` e `worker` antes do `web` (a migração *expand* roda antes de todos). */
export const ROLLOUT = [['api', 'worker'], ['web']] as const;

/** `digest-<app>.txt` → `{ app: 'repo@sha256:…' }`. */
export function parseDigests(files: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [file, content] of Object.entries(files)) {
    const app = /digest-([a-z]+)\.txt$/.exec(file)?.[1];
    const ref = content.trim();
    if (!app) continue;
    if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(ref)) {
      throw new Error(`digest inválido para ${app}: ${ref}`);
    }
    result[app] = ref;
  }
  return result;
}

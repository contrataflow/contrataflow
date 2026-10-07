# ADR-005 — Motor de workflow próprio, declarativo e versionado

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-014, DEC-015, DEC-016 |
| **Documentos** | [entities.md](../mvp-01/entities.md) §4 (Workflow, WorkflowVersion, WorkflowStage, WorkflowTransition, WorkflowRule) · US-040..046 · [ADR-001](adr-001-modular-monolith.md) · [ADR-008](adr-008-configurable-rules.md) |

## Contexto

- A tramitação do processo de contratação pública segue a Lei 14.133/2021, mas cada ente público (tenant) tem variações legítimas de etapas, aprovadores e documentos exigidos. O fluxo não pode ficar fixo no código: precisa ser configurável por tenant e evoluir sem deploy.
- Um processo em andamento não pode ser afetado por uma edição posterior do workflow: ele "fixa" a versão na criação (`workflowVersionId`), o que exige um modelo de versionamento explícito (`DRAFT` → `PUBLISHED` → `RETIRED`), não apenas um fluxo mutável em memória.
- É preciso mais de um fluxo semeado simultaneamente — ao menos a "Fase preparatória" padrão e a contratação direta (art. 72, dispensa/inexigibilidade) — escolhidos por regra de aplicabilidade, não por configuração manual a cada processo.
- Regras de bloqueio/aviso (ex.: "ETP completo antes de avançar", "pesquisa de preços concluída") variam por etapa e por tenant e precisam ser legíveis por um administrador do órgão, sem abrir brecha para execução de código arbitrário.
- A equipe é pequena e a stack já definida é PostgreSQL + NestJS (ADR-001); qualquer motor externo de BPMN ou orquestração adicionaria uma peça de infraestrutura nova.

## Decisão

1. **Motor próprio e declarativo**, modelado como dado versionado, não como máquina de estados fixa em código: `Workflow` → `WorkflowVersion` (`DRAFT` → `PUBLISHED` → `RETIRED`) → `WorkflowStage` (`START`, `TASK`, `APPROVAL`, `END`) → `WorkflowTransition` (`FORWARD`, `RETURN`, `APPROVE`, `REJECT`, `COMPLETE`) → `WorkflowRule` (DEC-014; entities.md §4).
2. **Versão publicada é imutável:** um trigger de banco bloqueia qualquer alteração em `workflow_stages`/`workflow_transitions`/`workflow_rules` de uma `WorkflowVersion` fora de `DRAFT` (RN-WF-21, RN-WF-65); o único *update* permitido é `PUBLISHED` → `RETIRED`. Toda escrita estrutural só é aceita em `DRAFT` (RN-WF-05/RN-WF-43), com no máximo uma versão `DRAFT` por workflow (RN-WF-04/46).
3. **Processo fica preso à versão:** `Process.workflowVersionId` é fixado na criação e processos em andamento permanecem nessa versão independentemente de publicações ou aposentadorias futuras (RN-WF-67, DEC-014); migrar processos em andamento para uma nova versão é postergado para depois do MVP 1.
4. **Publicação gera snapshot verificável:** `definitionSnapshot` (JSON canonicalizado RFC 8785/JCS de etapas, transições e regras) e `definitionHash` (SHA-256, DEC-084) são gravados na publicação (RN-WF-20/64); a validação completa do grafo (toda etapa alcançável a partir da `START`; toda etapa chega a um `END`) reporta **todos** os erros de uma vez, nunca só o primeiro (RN-WF-11/12/19).
5. **Dois workflows semeados por tenant no provisionamento** (DEC-015): "Fase preparatória — Lei 14.133/2021" (7 etapas, `isDefault = true`) e "Contratação direta — art. 72" (aplicável quando `modalityCode` ∈ {`DISPENSA`, `INEXIGIBILIDADE`}, `isDefault = false`). A resolução de aplicabilidade avalia por `applicabilityPriority` crescente (empate por `createdAt`); o primeiro cuja `applicabilityRule` for nula ou verdadeira vence; sem correspondência, usa o único `isDefault = true` (RN-WF-39).
6. **Regras parametrizáveis e tipadas, não código livre** (DEC-016): `WorkflowRule` com `type` (`REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`) e `severity` (`BLOCKING` | `WARNING`); condições em JSON Logic avaliadas sobre um `RuleContext` versionado (v1), restritas a uma *allowlist* de operadores — nunca acesso direto ao banco nem execução de código arbitrário (detalhe do motor de regras em ADR-008).
7. **`BLOCKING` desabilita, `WARNING` apenas avisa:** uma regra `BLOCKING` não satisfeita desabilita a ação de avanço (`enabled = false`) e lista o motivo em `reasons[]`; uma regra `WARNING` nunca desabilita, aparece só no checklist e exige reconhecimento explícito (`acknowledgedWarnings[]`), registrado em auditoria como evidência para o Controle Interno (RN-WF-24/25).
8. **Motor somente leitura em runtime:** todo cálculo de ações disponíveis, regras e responsável de etapa usa exclusivamente a `WorkflowVersion` fixada no processo, nunca a versão `DRAFT` corrente do workflow (RN-WF-33).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Motor BPMN de mercado (ex.: Camunda) | Notação padronizada; ferramental visual pronto; recursos avançados (*gateways*, subprocessos) | Peça de infraestrutura adicional para uma equipe pequena (ADR-001); expõe complexidade (tokens, *gateways*) desproporcional às quatro etapas tipadas do domínio; versionamento imutável e regras JSON Logic teriam que ser construídos por fora do padrão de qualquer forma | **Rejeitada:** custo operacional e curva de aprendizado sem ganho proporcional ao escopo do MVP 1 |
| Orquestrador de workflow como serviço (ex.: Temporal) | Durabilidade e *replay* de execução nativos; adequado a processos de longa duração orientados a código | Pensado para orquestração de código (*activities*/*workflows* como funções), não para definição declarativa editável por um administrador do órgão sem deploy; mais uma infraestrutura externa (ADR-001) | **Rejeitada:** o requisito central é um fluxo configurável por tenant, não execução durável de função |
| Máquina de estados fixa em código (enum + `switch`) | Mais simples de implementar inicialmente; sem tabelas de definição | Qualquer variação por tenant (contratação direta vs. padrão) exige deploy; impossível fixar e versionar por processo (RN-WF-67); regras de bloqueio ficam espalhadas em código imperativo, difíceis de auditar | **Rejeitada:** viola a exigência de configuração por tenant sem deploy e de versão fixada por processo |
| Motor próprio, declarativo e versionado | Editável pelo administrador do órgão sem deploy; versão publicada imutável protege processos em andamento; regras tipadas com *allowlist* auditável; reaproveita a stack existente (PostgreSQL/NestJS) | O validador de grafo (alcançabilidade, terminação) e a canonicalização do snapshot precisam ser construídos e mantidos internamente | **Adotada** |

## Consequências

**Positivas**
- O administrador do órgão configura e evolui o fluxo (etapas, transições, regras) sem depender de deploy.
- Processos em andamento são imunes a edições futuras do workflow (versão fixada + imutabilidade da versão publicada).
- Auditabilidade: snapshot com hash na publicação (DEC-084) e reconhecimento explícito de avisos ficam registrados para o Controle Interno.
- Os dois fluxos semeados cobrem o caso padrão e a contratação direta desde o provisionamento, sem configuração manual por tenant.
- Reaproveita a stack já adotada (PostgreSQL, NestJS, JSON Logic) sem nova peça de infraestrutura.

**Negativas**
- O validador de grafo (alcançabilidade, terminação, compatibilidade ação × tipo de etapa) e a canonicalização do snapshot são construídos e mantidos pela própria equipe, não por uma biblioteca de mercado.
- Paralelismo entre etapas não é suportado no MVP 1 (um único `ProcessStage` ativo por processo); adiado para o MVP 2+.
- Não há migração de processos em andamento para uma nova versão publicada no MVP 1 — mudanças ficam represadas até o próximo processo criado.
- Limites fixos por versão (50 etapas, 200 transições, 200 regras) podem exigir revisão para fluxos muito maiores no futuro.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Edição indevida de uma versão já publicada | Trigger de banco bloqueia *update* em etapas/transições/regras fora de `DRAFT` (RN-WF-21/65), não depende só da aplicação |
| Grafo publicado inválido (etapa inalcançável ou sem saída) | Validação completa antes de publicar, reportando todos os erros (RN-WF-11/12/19); publicação exige `errors[]` vazio |
| Regra `CONDITION` usada para executar lógica arbitrária | *Allowlist* de operadores JSON Logic, sem `method`/`log`, profundidade ≤ 20 e tamanho ≤ 10 KB (RN-WF-17); detalhe em ADR-008 |
| Nenhum workflow aplicável a um processo | Resolução de aplicabilidade sempre tem fallback `isDefault = true`; sem nenhum dos dois, erro explícito `NO_APPLICABLE_WORKFLOW` (RN-WF-39) |
| Caminho do `RuleContext` inválido só descoberto em runtime | Verificação profunda na validação de publicação (`WF_RULE_PATH_UNKNOWN`); motor degrada com segurança em vez de lançar exceção (RN-WF-27) |
| Workflows padrão ficando inconsistentes entre tenants | Seeder idempotente por chave estável (`DEFAULT_PREPARATORY`, `DIRECT_CONTRACTING_ART72`); reexecução é *no-op* (RN-WF-34) |

## Critérios de revisão

- Necessidade real de paralelismo entre etapas (mais de um `ProcessStage` ativo) no MVP 2 → reabrir o modelo de execução.
- Necessidade de migrar processos em andamento para uma nova versão publicada → reabrir a decisão de versão fixada por processo.
- Limites de 50 etapas / 200 transições / 200 regras por versão atingidos em uso real → revisar limites ou a paginação do editor.
- Regras exigindo mais do que JSON Logic (ex.: chamadas externas) → reavaliar junto com ADR-008.

## Referências
- DEC-014, DEC-015, DEC-016 — [decisions.md](../architecture/decisions.md).
- [entities.md](../mvp-01/entities.md) §4 — `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule`.
- US-040 (RN-WF-01..22 — modelo e publicação), US-041 (RN-WF-23..33 — motor em runtime), US-042 (RN-WF-34..42 — workflows padrão e aplicabilidade), US-043 (RN-WF-43..52 — editor), US-044 (RN-WF-53..60 — regras), US-045 (RN-WF-61..69 — publicação e versionamento), US-046 (RN-WF-70..75 — diagrama).
- [ADR-001](adr-001-modular-monolith.md) (módulo `workflow`), [ADR-008](adr-008-configurable-rules.md) (detalhe do motor de regras JSON Logic).

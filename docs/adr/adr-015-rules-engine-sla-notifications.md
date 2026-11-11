# ADR-015 — Biblioteca de regras, `RuleContext` v2, SLA e notificações condicionais

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-11-10 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-204 (biblioteca e `RuleContext` v2), DEC-205 (SLA e notificação), DEC-016 (JSON Logic), DEC-031 (prazos), DEC-194 (paralelismo), DEC-196 (workflow v2) |
| **Documentos** | [ADR-008](adr-008-configurable-rules.md) (motor JSON Logic) · [roadmap.md §4](../product/roadmap.md#4-mvp-2--governança-e-controle) (SLA, Regras condicionais, SCR-035) · [mvp-02/overview.md](../mvp-02/overview.md) |

## Contexto

- O MVP 1 tem regras por etapa e transição (`WorkflowRule` — `REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`), escritas uma a uma em cada versão de workflow, sobre o `RuleContext` v1, e prazo por etapa (`WorkflowStage.slaDays`, DEC-031).
- O MVP 2 pede (roadmap §4.2): regras que **alteram o roteamento** ("valor acima de X exige Controle Interno"), **alçadas por valor**, aplicabilidade, **simulador e testes**, uma **biblioteca reutilizável** (SCR-035), **políticas de prazo** por tipo de contratação, modalidade ou valor, com **pausas** (diligência) e **escalonamento**, e **notificações** configuráveis.
- Os novos módulos (PCA, dotação, jurídico, controle interno, edital) trazem dados que as regras precisam ler sem quebrar as regras já publicadas.
- Princípios do MVP 1 continuam: nada de código arbitrário, nada de acesso direto ao banco, regras legais como configuração semeada (ADR-008).

## Decisão

1. **Um só executor:** o avaliador JSON Logic com *allowlist* da ADR-008 continua sendo o único motor de condições. O MVP 2 acrescenta **onde** as condições são usadas, não uma nova linguagem.
2. **Biblioteca no módulo `rules`:** `RuleDefinition` (regra reutilizável do tenant — nome, descrição, tipo, etiquetas) e `RuleDefinitionVersion` (versão publicada **imutável**, com `contextVersion`, expressão e casos de teste). Uma `WorkflowVersion` referencia a versão da regra da biblioteca que fixou na publicação; editar a regra cria nova versão e não altera workflows publicados (mesma lógica da DEC-014).
3. **Usos novos das condições:**
   - **roteamento** — `WorkflowStage.applicabilityRule`: quando falsa no momento de entrar na etapa, a etapa é **dispensada** automaticamente (registro na timeline e no `ProcessMovement`, com a regra e o valor avaliado); `WorkflowTransition.condition`: transição só disponível quando verdadeira;
   - **alçada por valor** — a resolução do aprovador (`WorkflowStageApprover`) e da política de decisão (DEC-193) pode variar por faixas avaliadas sobre o contexto;
   - **SLA** — `SlaPolicy` (módulo `sla`): aplicabilidade, prazos por etapa (`BUSINESS`/`CALENDAR`), condições de pausa e degraus de escalonamento;
   - **notificação** — `NotificationRule`: evento de origem, condição, destinatários e modelo de mensagem.
4. **`RuleContext` v2:** superset da v1 com `pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*` e `sla.*`, além de `stages.active[]` para o paralelismo. Cada regra grava sua `contextVersion`; o montador de contexto entrega a versão pedida. Regras v1 não migram à força — passam a v2 por edição do administrador.
5. **SLA calculado pelo módulo `sla`:** ao entrar numa etapa, a política aplicável define `ProcessStage.dueAt` (sem política, vale `WorkflowStage.slaDays` — DEC-031); pausas estendem o prazo pelo tempo pausado (como a suspensão já faz); o job `deadlines` consulta o `sla` para avisos e escalonamento. Uma etapa nunca tem duas políticas: vence a de menor `priority`.
6. **Execução assíncrona e idempotente** de SLA e notificações no worker, consumindo eventos do outbox; chave de idempotência `eventId` + regra. Nenhuma avaliação de regra de notificação dentro da transação do comando.
7. **Simulador:** "testar regra" (WF-23) aceita processo real visível **ou** contexto hipotético montado na tela, e roda os casos de teste salvos na versão da regra antes da publicação (falha de caso = publicação recusada, com o diff do resultado).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Motor de regras de mercado (Drools, *rules engine* em Node) | Encadeamento, tabelas de decisão prontas | Nova linguagem e runtime; perde a *allowlist* auditável; curva para administradores | **Rejeitada** |
| DMN (tabelas de decisão) | Padrão para alçadas | Mais uma notação; ferramental pesado; as alçadas cabem em faixas JSON Logic | **Rejeitada no MVP 2** |
| Manter regras só dentro de cada versão de workflow | Nada novo | Copiar a mesma regra em vários workflows; sem testes reutilizáveis; SLA e notificação continuariam fora | **Rejeitada:** a biblioteca é pedido explícito (SCR-035) |
| Prazo e notificação como tipos de `WorkflowRule` | Uma tabela só | Mistura validação de saída com efeitos assíncronos; prazo não pertence a uma transição | **Rejeitada:** entidades próprias com o mesmo executor |

## Consequências

**Positivas**
- Uma linguagem, um executor e um simulador para validação, roteamento, alçada, SLA e notificação.
- Regras reutilizáveis e testadas antes de publicar; workflows publicados continuam imutáveis.
- Regras do MVP 1 continuam funcionando sem migração.

**Negativas**
- Dispensa automática de etapa muda o caminho do processo — precisa ser muito visível (timeline, painel) para não parecer "pulo".
- Mais lugares onde uma regra mal escrita tem efeito (roteamento e alçada, não só bloqueio).
- O contexto v2 é maior; o custo de montagem cresce com os módulos novos.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Regras complexas demais para administradores (roadmap §4.10) | Modelos prontos semeados, simulador, casos de teste obrigatórios nas regras de roteamento e revisão por especialista sugerida na publicação |
| Dispensa indevida de etapa obrigatória por lei | Etapas marcadas como legais no seed (ex.: `JURIDICO` na licitação) não aceitam `applicabilityRule`; validação na publicação |
| Tempestade de notificações por regra mal configurada | Limite por regra e por destinatário por janela; agrupamento; desligamento automático com alerta ao administrador |
| Custo de montar o `RuleContext` v2 | Montagem preguiçosa por namespace (só o que a expressão referencia) e cache por requisição |

## Critérios de revisão

- Necessidade de encadeamento de regras (uma regra disparando outra) → reavaliar motor dedicado.
- Alçadas com muitas dimensões → avaliar tabelas de decisão (DMN) só para esse uso.
- Volume de notificações condicionais relevante na fila `notifications` → fila própria.

## Referências

- Internas: DEC-014, DEC-016, DEC-031, DEC-193, DEC-194, DEC-196, DEC-204, DEC-205; [ADR-005](adr-005-workflow-engine.md); [ADR-008](adr-008-configurable-rules.md).
- Lei 14.133/2021, art. 53, § 1º, I (critérios objetivos de prioridade) e art. 11 (governança).

---
id: FT-031
title: "Encaminhamento"
epic: EP-008
mvp: 1
priority: P0
stories: [US-047]
status: Especificada
---

# FT-031 — Encaminhamento

## Título
Encaminhamento

## Épico
EP-008 — Tramitação

## Descrição
Cobre o encaminhamento do processo para a próxima etapa do workflow: o custodiante atual escolhe (quando a etapa permitir) a unidade de destino, ajusta prazo e comentário, destaca os documentos relevantes e, em uma única transação, o sistema valida a transição e as regras do motor de workflow, encerra a etapa atual, abre a nova etapa com responsável e prazo calculados, numera o processo quando a autuação ocorre nesse momento e, se o destino for uma etapa de aprovação, submete os documentos cobertos e solicita a aprovação automaticamente.

## Valor para o usuário e para o órgão
- Elimina o encaminhamento informal (e-mail, despacho físico) como única evidência de tramitação.
- Garante destinatário, prazo e documentos sempre explícitos e auditáveis a cada passagem de etapa.

## Personas
- Servidor custodiante (`currentResponsibleId` ou membro da `currentDepartmentId`) — encaminha o processo pelo painel lateral SCR-103.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-047 | Encaminhar processo | P0 | L | US-004, US-041, US-059, US-106 |

## Escopo
- Validação de custódia (POL-01), status do processo e disponibilidade da transição na versão de workflow fixada.
- Avaliação das regras `BLOCKING`/`WARNING` do motor sobre o `RuleContext` v1 e reconhecimento explícito de avisos.
- Resolução de unidade e responsável de destino (`departmentResolution`, `assignmentPolicy`), cálculo de prazo em dias úteis e sobrescrita quando permitida pela transição.
- Registro do `ProcessMovement` `FORWARD` imutável, encerramento da etapa/atribuição atual e abertura da nova etapa.
- Autuação (numeração) quando `numbering.process.assignOn = START`, e submissão automática + solicitação de aprovação quando o destino é etapa `APPROVAL`.

## Fora de escopo
- Devolução para etapa anterior — FT-032.
- Decisão da aprovação solicitada no destino `APPROVAL` — FT-034.
- Definição do grafo de workflow e das regras avaliadas — EP-007.

## Regras de negócio da feature
- RN-TRAM-01 a RN-TRAM-22 — US-047.

## Telas
- SCR-006 — Detalhe do processo (`/processos/[id]`)
- SCR-103 — Encaminhar processo, painel lateral (diálogo em SCR-006)

## Endpoints
- PRC-19 `POST /processes/{id}/forward` — encaminhar o processo

## Entidades
- `ProcessStage` — etapa encerrada e etapa aberta (dono)
- `ProcessAssignment` — atribuição `STAGE_ENTRY` da nova etapa (dono)
- `ProcessMovement` — registro imutável `FORWARD` (dono)
- `Approval` — criada quando o destino é etapa `APPROVAL` (consumida; dono é FT-034)

## Eventos
- `ProcessStageChanged` (`cause = FORWARD`) — ao concluir o encaminhamento
- `ProcessStatusChanged` — quando o status do processo muda (ex.: `DRAFT`/`RETURNED` → `IN_PROGRESS`/`AWAITING_APPROVAL`)
- `ProcessAssigned` — quando há responsável resolvido no destino
- `ProcessNumberAssigned` — quando a autuação ocorre neste encaminhamento
- `ApprovalRequested` — quando o destino é etapa `APPROVAL`

## Permissões
- `PROCESS_FORWARD` — encaminhar o processo, condicionado à custódia (POL-01)

## Dependências
- Stories: US-004 (painel situacional, `PRC-07`), US-041 (motor de workflow — transições e regras, `PRC-08`/`PRC-09`), US-059 (timeline), US-106 (dias úteis, `CAL-06`).
- Decisões/ADRs: DEC-013, DEC-014, DEC-015, DEC-016, DEC-018, DEC-022, DEC-023, DEC-024, DEC-028, DEC-031, DEC-055, DEC-104, DEC-105.
- Habilitada por esta feature: FT-034 (quando o destino do encaminhamento é etapa `APPROVAL`, a solicitação de aprovação — US-051 — é criada na mesma transação).

## Critérios de aceite da feature
```gherkin
Feature: Encaminhamento
  Scenario: Encaminhar o processo para a próxima etapa de tarefa
    Given um processo "IN_PROGRESS" na etapa "Estudos preliminares" sob custódia do usuário
    When o usuário encaminhar o processo para a etapa "Pesquisa de preços" com comentário e prazo padrão
    Then o sistema deve encerrar a etapa atual, abrir a nova etapa com o prazo calculado em dias úteis e registrar um "ProcessMovement" "FORWARD" imutável
```

## Métricas de sucesso
- 100% dos encaminhamentos geram `ProcessMovement` com unidade, responsável e prazo de destino preenchidos conforme as regras resolvidas (sem encaminhamento fora deste fluxo).

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Regras `WARNING` serem reconhecidas sem leitura real do conteúdo pelo usuário | Média | Médio | Mensagem específica por regra e registro do reconhecimento em `ProcessMovement.metadata` e `AuditLog` (RN-TRAM-06) |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada

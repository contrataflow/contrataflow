---
id: FT-034
title: "Aprovações"
epic: EP-008
mvp: 1
priority: P0
stories: [US-051, US-052, US-053]
status: Especificada
---

# FT-034 — Aprovações

## Título
Aprovações

## Épico
EP-008 — Tramitação

## Descrição
Cobre o ciclo completo de uma aprovação: a solicitação automática e a resolução do aprovador quando o processo entra em etapa `APPROVAL` ou um documento é submetido isoladamente (US-051); a decisão — aprovar, devolver ou indeferir —, com todos os efeitos em documentos, etapa e status aplicados atomicamente, inclusive a solicitação em cadeia de uma nova aprovação quando a etapa seguinte também for `APPROVAL` (US-052); e, antes da decisão, a retirada da solicitação por quem a originou ou o redirecionamento para outro aprovador em caso de ausência ou impedimento (US-053, P1).

## Valor para o usuário e para o órgão
- Garante que toda etapa de aprovação do workflow — e toda submissão avulsa que exija aprovação formal — tenha um aprovador certo, resolvido sem intervenção manual de quem encaminhou.
- Aplica a segregação de funções (art. 7º, § 1º) de forma automática, reduzindo o risco de autoaprovação indevida.

## Personas
- Aprovador designado (titular, substituto ou detentor do perfil competente) — decide, no painel SCR-015, uma aprovação a ele atribuída.
- Servidor que encaminhou o processo ou submeteu o documento — pode retirar a solicitação antes da decisão (US-053).
- Gestor do fluxo — redireciona uma aprovação pendente para outro aprovador (US-053).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-051 | Solicitar aprovação e resolver o aprovador | P0 | L | US-047, US-065 |
| US-052 | Decidir aprovação (aprovar, devolver, indeferir) | P0 | L | US-051 |
| US-053 | Retirar ou redirecionar aprovação pendente | P1 | M | US-052 |

## Escopo
- Criação de `Approval` (`PENDING`) e resolução de `USER`/`ROLE`/`DEPARTMENT_HEAD` na entrada de etapa `APPROVAL` ou na submissão avulsa de documento que exija aprovação.
- Decisão `APPROVE`/`RETURN`/`REJECT`, com efeito em cada documento coberto (DEC-018), enfileiramento de renderização `APPROVAL_STAMPED`, transição de etapa/status e nova solicitação automática quando a etapa seguinte também for `APPROVAL`.
- Retirada da solicitação pendente — desfazendo o encaminhamento ou a submissão que a originou — e redirecionamento para outro aprovador elegível.
- Segregação de funções (`approval.preventSelfApproval`) aplicada no momento da decisão.

## Fora de escopo
- Encaminhamento e submissão que disparam a solicitação de aprovação — FT-031 e EP-011 (US-065).
- Política de decisão com múltiplos aprovadores ou aprovação sequencial (DEC-022, PEND-13) — MVP 2.

## Regras de negócio da feature
- RN-TRAM-43 a RN-TRAM-53 — US-051.
- RN-TRAM-54 a RN-TRAM-63 — US-052.
- RN-TRAM-64 a RN-TRAM-71 — US-053.

## Telas
- SCR-006 — Detalhe do processo (`/processos/[id]`)
- SCR-015 — Detalhe da aprovação (`/aprovacoes/[id]`)

## Endpoints
- PRC-19 `POST /processes/{id}/forward` — gatilho A da solicitação: encaminhamento para etapa `APPROVAL` (US-051)
- DOC-09 `POST /documents/{id}/submit` — gatilho B da solicitação: submissão avulsa que exige aprovação (US-051)
- APV-02 `GET /approvals/{id}` — detalhe da aprovação
- APV-03 `POST /approvals/{id}/decide` — decidir: aprovar, devolver ou indeferir (US-052)
- APV-04 `POST /approvals/{id}/withdraw` — retirar solicitação pendente de etapa (US-053)
- DOC-11 `POST /documents/{id}/withdraw` — retirar submissão avulsa pendente (US-053)
- APV-05 `POST /approvals/{id}/reassign` — redirecionar para outro aprovador (US-053)

## Entidades
- `Approval` — pendência, resolução do aprovador e decisão (dono)
- `ApprovalDocument` — versões exatas cobertas pela aprovação (dono)
- `Document`, `DocumentVersion` — efeito da decisão no ciclo de vida do documento (consumidas, DEC-018)
- `ProcessStage` — transição de etapa decorrente da decisão (consumida)

## Eventos
- `ApprovalRequested` — na criação da solicitação (US-051)
- `ApprovalCompleted` / `ApprovalReturned` / `ApprovalRejected` — na decisão (US-052)
- `ApprovalCanceled` — na retirada (US-053)
- `ApprovalReassigned` — no redirecionamento (US-053)
- `ProcessStageChanged` / `ProcessStatusChanged` — efeito da decisão ou da retirada sobre o processo

## Permissões
- `APPROVAL_VIEW` — consultar aprovações no escopo
- `APPROVAL_DECIDE` — decidir aprovação designada (POL-03, US-052)
- `APPROVAL_REASSIGN` — redirecionar aprovação pendente (US-053)
- `PROCESS_FORWARD` — retirar solicitação de etapa, combinada com POL-17 (US-053)

## Dependências
- Stories: US-047 (encaminhamento — disparo A da solicitação), US-065 (submissão avulsa — disparo B, espelhada por `DOC-11`), US-048 (mecânica de devolução reaproveitada na retirada de etapa), US-055 (`dueAt` herdado pela nova aprovação), US-057 (listagem `APV-01`).
- Decisões/ADRs: DEC-013, DEC-014, DEC-015, DEC-016, DEC-017, DEC-018, DEC-022, DEC-023, DEC-024, DEC-055, DEC-104, DEC-105; ADR-005, ADR-006, ADR-008.
- Configurações: `approval.preventSelfApproval`.

## Critérios de aceite da feature
```gherkin
Feature: Aprovações
  Scenario: Decidir uma aprovação pendente aprovando o documento
    Given uma "Approval" "PENDING" com documentos cobertos em análise e o usuário designado como aprovador
    When o aprovador decidir "APPROVE"
    Then os documentos cobertos devem passar a "APPROVED", a etapa deve avançar conforme a transição "APPROVE" e o status do processo deve refletir a nova etapa
```

## Métricas de sucesso
- 100% das decisões de aprovação passam pela checagem de designação (POL-03) e de segregação de funções antes de serem aceitas.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Aprovador não puder ser resolvido (unidade sem titular, perfil sem detentor no escopo) e bloquear o avanço | Média | Alto | `APPROVER_UNRESOLVED` desfaz integralmente a transação de origem (RN-TRAM-49/RN-TRAM-60), preservando o estado anterior |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada

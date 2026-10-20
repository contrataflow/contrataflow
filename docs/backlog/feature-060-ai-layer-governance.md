---
id: FT-060
title: "Camada de IA e governança"
epic: EP-020
mvp: 1
priority: P1
stories: [US-115, US-116]
status: Especificada
---

# FT-060 — Camada de IA e governança

## Título
Camada de IA e governança

## Épico
EP-020 — IA para documentos do planejamento

## Descrição
Fundação técnica e de governança de toda a geração assistida:
- o módulo `ai`, só com fachadas de leitura (DEC-079, regra D9);
- a porta `AiProvider` com o `FakeAiProvider`, sendo o provedor real decidido na ADR-013 (PEND-21);
- o registro `AiGeneration` com rastreabilidade completa (quem pediu, documento/seção, modelo, versão do prompt, entradas, tokens, custo);
- a fila `ai-generation` e a porta `AiSuggestionSource`, pela qual os módulos donos aplicam o conteúdo.

A feature também entrega a **governança por órgão**:
- ativação opt-in com aceite dos termos de uso;
- limite mensal de tokens e limite diário por usuário;
- avisos de consumo e relatório de uso;
- a permissão `AI_GENERATE`, que define quem pode gerar (POL-18).

## Valor para o usuário e para o órgão
- O órgão decide se usa IA, quem usa e quanto gasta, com evidência completa para controle interno e externo.
- Toda geração fica rastreável, da entrada ao modelo e ao custo, sem guardar texto em logs.
- A troca de provedor não afeta o produto (porta `AiProvider`).

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — liga ou desliga a IA, define limites e acompanha o consumo.
- Redatores (`REQUISITANTE`, `PLANEJAMENTO`, `COMPRAS`, `GESTOR_CONTRATACOES`) — consultam o histórico de gerações do processo.
- Auditor (`AUDITOR`) e Controle Interno — rastreiam as gerações na auditoria e na timeline.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-115 | Camada de IA com registro e rastreabilidade das gerações | P1 | L | US-059, US-065, US-073, US-083, US-097 |
| US-116 | Configurar a IA no órgão: ativação, limites e consumo | P1 | M | US-094, US-103, US-111, US-115 |

## Escopo
- Módulo `ai` (nível 5), `AiGeneration`, porta `AiProvider` + `FakeAiProvider`, fila `ai-generation`.
- Pipeline: `ContextSanitizer` → registro de prompts versionados → provedor → validação/reparo → TipTap → pós-processamento.
- Porta `AiSuggestionSource`.
- Endpoints AI-01 (contrato genérico), AI-02, AI-03 e AI-04; AI-05 e AI-06.
- Chaves `ai.*` em SET-02 e na seção "Inteligência artificial" da SCR-041; `AI_GENERATE`; POL-18.
- Reserva e controle de limites; `AiUsageThresholdReached` → `AI_USAGE_LIMIT_WARNING`.
- Auditoria, eventos, timeline (`AI_CONTENT_GENERATED`), notificações (`AI_GENERATION_READY` e `AI_GENERATION_FAILED`), métricas `cf_ai_*`.
- Conjunto de avaliação `pnpm ai:eval`.

## Fora de escopo
- Adaptador do provedor real, que entra quando o usuário decidir a ADR-013.
- Geradores de cada documento (FT-061) e ajustes por seção (FT-062).
- Cobrança por uso (PEND-22).
- Escolha de provedor por órgão.

## Regras de negócio da feature
- RN-AI-01..RN-AI-15 (camada) e RN-AI-16..RN-AI-24 (governança).
- A geração é sempre assíncrona e fora de transação.
- Minimização LGPD; valores sigilosos nunca são enviados.
- Uma geração ativa por alvo; só o solicitante aplica ou descarta.
- IA opt-in com termos; limites com reserva de tokens.

## Telas
- SCR-041 — Configurações gerais (`/admin/configuracoes`), seção "Inteligência artificial".
- SCR-117 — aba "Histórico de IA" (AI-03), compartilhada com a FT-061.

## Endpoints
- AI-01 `POST /processes/{id}/ai-generations` — solicitar geração (202).
- AI-02 `GET /ai-generations/{generationId}` — status e proposta.
- AI-03 `GET /processes/{id}/ai-generations` — histórico do processo.
- AI-04 `POST /ai-generations/{generationId}/discard` — descartar ou cancelar.
- AI-05 `GET /ai/availability` — o usuário pode gerar aqui?
- AI-06 `GET /ai/usage` — consumo do órgão.
- SET-02 `PATCH /settings` — chaves `ai.*`.

## Entidades
- `AiGeneration` — registro de cada geração.
- `TenantSetting` — `ai.enabled`, `ai.termsAcceptedVersion`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`.
- `Permission`/`RolePermission` — `AI_GENERATE`.

## Eventos
- `AiGenerationRequested` — na solicitação.
- `AiGenerationCompleted` / `AiGenerationFailed` — no término (worker).
- `AiUsageThresholdReached` — ao cruzar 80% ou 100% do limite mensal.
- `TenantSettingsChanged` — alteração de `ai.*`.

## Permissões
- `AI_GENERATE` — solicitar geração (POL-18).
- `PROCESS_VIEW` — consultar gerações.
- `SETTINGS_MANAGE` — configurar e ver o consumo.

## Dependências
- US-083 (worker e filas), US-065 (documentos), US-073 (auditoria), US-059 (timeline), US-097 (autorização), US-103 (configurações), US-094 (catálogo de permissões), US-111 (notificações).
- DEC-037, DEC-079, ADR-013 (PEND-21), PEND-22.

## Critérios de aceite da feature
```gherkin
Feature: Governança e rastreabilidade da IA no órgão
  Scenario: Administrador liga a IA e um redator gera com rastreabilidade
    Given que a IA está desligada no órgão "Prefeitura A"
    When o administrador ligar a IA aceitando a versão vigente dos termos de uso
    And um redator com "AI_GENERATE" pedir um rascunho do DFD do processo "0012/2026"
    Then a geração deve ser registrada com solicitante, documento, modelo, versão do prompt, entradas, tokens e custo
    And a auditoria deve conter "ai.generation_request" e "ai.generation_complete" sem nenhum texto do documento
    And a timeline do processo deve mostrar "AI_CONTENT_GENERATED"
    And o relatório de consumo do mês deve somar os tokens dessa geração
  Scenario: Limite mensal atingido
    Given que o consumo do mês chegou ao limite do órgão
    When um redator pedir nova geração
    Then a API deve responder 422 com código "AI_USAGE_LIMIT_REACHED"
    And quem tem "SETTINGS_MANAGE" deve ter recebido o aviso "AI_USAGE_LIMIT_WARNING" ao cruzar 80% e 100%
```

## Métricas de sucesso
- 100% das gerações com registro completo (modelo, prompt, entradas, tokens, custo) — verificado em teste e amostragem.
- 0 ocorrências de texto de documento em logs, eventos ou auditoria (varredura do CI).
- Aviso de 80% entregue antes de qualquer órgão atingir 100% sem aviso.

## Riscos
- Estimativa de reserva distante do consumo real — calibrar a tabela de estimativas com as métricas do primeiro mês.
- Provedor indefinido no início da implementação — o `FakeAiProvider` e os testes de contrato permitem concluir a camada sem o adaptador real.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (ligar → gerar → consumo)
- [ ] Documentação atualizada (decisions, entities, api, events, permissions, security)

---
id: FT-045
title: "Consulta de auditoria"
epic: EP-013
mvp: 1
priority: P0
stories: [US-075]
status: Especificada
---

# FT-045 — Consulta de auditoria

## Título
Consulta de auditoria

## Épico
EP-013 — Auditoria

## Descrição
Entrega a janela de leitura sobre a trilha gerada por FT-044: pesquisa filtrada por período e dimensões (ator, ação, categoria, resultado, entidade, processo), detalhe de cada registro com diff de alterações já mascarado, e exportação em CSV/NDJSON com proteção contra injeção de fórmulas. É o valor de negócio visível do épico para quem responde a diligências de controle externo e investigações internas.

## Valor para o usuário e para o órgão
- Um auditor encontra um registro específico sem precisar de acesso direto ao banco de dados, em poucos cliques.
- Exportações até 100 mil linhas sustentam diligências do TCU/TCE e auditorias externas com dados em formato aberto (CSV/NDJSON).
- Continuidade de acesso (leitura/exportação) garantida mesmo durante o encerramento (`OFFBOARDING`) de um tenant, cumprindo a guarda obrigatória de documentos públicos.

## Personas
- Auditor / controle interno (`AUDITOR`) — como usa: pesquisa, abre detalhes e exporta a trilha em SCR-037.
- Administrador do órgão (`ADMIN_ORGAO`) — como usa: mesma consulta, inclusive durante o encerramento do tenant.
- Auditor externo — TCE (`AUDITOR`, vínculo `EXTERNAL`) — como usa: mesma consulta/exportação, sem o sigilo de orçamento se aplicar (Lei 14.133, art. 24, I).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-075 | Consultar e exportar a trilha de auditoria | P0 | M | US-073, US-097 |

## Escopo
- Pesquisa por período (obrigatório, ≤ 90 dias) e filtros combináveis, com paginação por cursor.
- Detalhe de um registro com diff de `changes` mascarado.
- Exportação CSV/NDJSON (até 100 mil linhas) com proteção contra CSV injection.
- Restrição de acesso durante `OFFBOARDING` do tenant (DEC-132) e exigência de MFA (POL-14) por risco `H`.

## Fora de escopo
- Geração e verificação dos selos de integridade — tratado em FT-044 (US-074), em aba separada da mesma tela.
- Qualquer gravação na trilha — esta feature é somente leitura (além de auditar a própria consulta/exportação).

## Regras de negócio da feature
- Toda consulta exige período ≤ 90 dias, por partition pruning e previsibilidade de latência (RN-AUD-17).
- Exportação acima de 100 mil linhas é bloqueada com `EXPORT_TOO_LARGE`, pedindo filtros mais restritos (RN-AUD-19).
- Valores de texto exportados em CSV que comecem com `=`, `+`, `-`, `@` recebem apóstrofo de escape (RN-AUD-20).
- Durante `OFFBOARDING`, só `ADMIN_ORGAO`/`AUDITOR` mantêm acesso de leitura/exportação (RN-AUD-22, DEC-132).

## Telas
- SCR-037 — Auditoria (`/auditoria`), aba "Registros" (padrão)

## Endpoints
- AUD-01 `GET /api/v1/audit` — pesquisar registros
- AUD-02 `GET /api/v1/audit/{id}` — detalhe de um registro
- AUD-03 `GET /api/v1/audit/export` — exportar registros (CSV/NDJSON)

## Entidades
- `AuditLog` — consumida (somente leitura); gerada por FT-044 (US-073)

## Eventos
- Nenhum evento de domínio. A própria consulta/exportação gera `AuditLog` (`audit.search`, `audit.export`), não evento de outbox.

## Permissões
- `AUDIT_VIEW` — pesquisar e ver detalhe (`AUD-01`, `AUD-02`)
- `AUDIT_EXPORT` — exportar (`AUD-03`)

## Dependências
- US-073 (gera a trilha consultada), US-097 (autorização na API e no frontend); DEC-025, DEC-132, DEC-138; POL-14, POL-15.

## Critérios de aceite da feature
```gherkin
Feature: Consulta de auditoria
  Scenario: Jornada ponta a ponta de pesquisa, detalhe e exportação
    Given que "Clara" (perfil AUDITOR, AUDIT_VIEW e AUDIT_EXPORT, MFA ativo) acessa "/auditoria"
    When ela pesquisar os registros dos últimos 7 dias filtrando por "process.create"
    And abrir o detalhe de um dos resultados
    Then o diff de alterações deve aparecer mascarado
    When ela exportar os mesmos resultados em CSV
    Then o arquivo deve ser gerado sem exceder 100 mil linhas e sem fórmulas executáveis
```

## Métricas de sucesso
- Tempo de resposta de uma diligência (consulta + exportação) < 5 min para auditor treinado
- Exportação de 100 mil linhas < 30 s

## Riscos
- Crescimento de `audit_logs` degradar a consulta — mitigado por período obrigatório e índices por tenant+dimensão (US-075, Impacto técnico).
- Vazamento de dado sensível via exportação — mitigado por mascaramento definitivo na gravação (US-073) e por `AUD-02`/`AUD-03` nunca desmascararem um valor.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas (US-075)
- [ ] Jornada E2E da feature automatizada (pesquisar → detalhar → exportar)
- [ ] Documentação atualizada

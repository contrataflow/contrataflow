# ADR-011 — UUIDv7 e numeração de negócio por sequência transacional

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-002, DEC-028 |
| **Documentos** | [entities.md](../mvp-01/entities.md) (`NumberSequence`) · [decisions.md](../architecture/decisions.md) |

## Contexto

- Toda tabela de negócio tem chave primária (DEC-083) e FKs compostas com `tenant_id` (DEC-080/DEC-081); tabelas de alto volume de escrita (`ProcessMovement`, `AuditLog`) são sensíveis à localidade do índice da PK.
- Produto exige numeração "humana" de processo e documento (ex. `0012/2026`, `DFD 0005/2026`) para comunicação com o órgão e terceiros — prática de protocolo público que espera sequência sem lacunas, por ano e, opcionalmente, por órgão.
- Esses dois identificadores têm requisitos opostos: a **PK** não deve ser previsível nem vazar volume/ordem de negócio; o **número de negócio** precisa ser estritamente sequencial, sem lacunas mesmo sob concorrência e rollback, com escopo e máscara configuráveis por tenant.
- Tratar os dois como o mesmo identificador acopla o formato de exibição (máscara, reinício anual, escopo por órgão) a uma chave que não pode mudar depois de criada.

## Decisão

1. **PK = UUIDv7** gerado pela aplicação (DEC-002): ordenável no tempo (boa localidade de índice B-tree, útil para paginação por criação), não sequencial nem previsível, disponível em memória antes do `INSERT` (sem round-trip ao banco para obter o id).
2. **Identificador de negócio é separado da PK:** número + ano (+ código formatado por máscara) vem de uma **sequência transacional própria** (DEC-028) — a PK nunca carrega esse significado.
3. **Entidade `NumberSequence`** materializa a sequência: `sequenceKey` (`"PROCESS:<orgId|*>:<ano>"` ou `"DOCUMENT:<TYPE>:<orgId|*>:<ano>"`) + `lastValue`; linha criada sob demanda com `INSERT … ON CONFLICT DO NOTHING` (RN-TEN-68).
4. **Obtenção do número na mesma transação:** `UPDATE … SET last_value = last_value + 1 RETURNING last_value` executado **na mesma transação** da criação do processo/documento (DEC-028, RN-TEN-69). Rollback da transação desfaz o incremento — nenhum número confirmado é repetido ou pulado; concorrência é resolvida pelo lock de linha do próprio `UPDATE`.
5. **Máscara configurável por tipo** (`TenantSetting` `numbering.*`): tokens `{seq:N}` (`N` de 1 a 6), `{year}`, `{org}` (exige escopo `ORGANIZATION`) e, só em documentos, `{type}`; token desconhecido ou `{seq}` sem `N` é rejeitado (`NUMBERING_MASK_INVALID`, RN-TEN-67). Padrão de processo: `{seq:4}/{year}`; padrão de documento: `{type} {seq:4}/{year}`.
6. **Escopo e reinício anual:** `tenant` (padrão) ou `órgão` (`numbering.process.scope`); `year` é o ano corrente no fuso do tenant no instante da numeração (RN-TEN-70). Mudança de escopo só produz efeito no próximo exercício — sequências já abertas no ano corrente não são migradas (RN-TEN-68).
7. **Momento de atribuição configurável:** `numbering.process.assignOn` é `CREATE` (padrão confirmado pelo produto em 2026-10-07 — PEND-01 encerrada, DEC-028) ou `START`/autuação; a numeração em si (esta ADR) suporta os dois momentos.
8. **Máscaras semeadas por tipo de documento:** `PRICE_RESEARCH` usa `"PP {seq:4}/{year}"` e `RISK_MAP` usa `"MR {seq:4}/{year}"` via `DocumentType.numberingMask`; os demais tipos usam `numbering.document.defaultMask`, com override possível por tipo (RN-TEN-72).
9. **`internalCode` é independente:** protocolo legado/SEI informado pelo órgão, opcional, único por tenant quando preenchido — não passa pela sequência transacional.

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **UUIDv4** como PK | Padrão onipresente; nenhuma lógica de tempo embutida | Aleatório puro fragmenta o índice B-tree (pior localidade em tabelas de alta escrita como `AuditLog`/`ProcessMovement`); sem ordenação temporal útil | **Rejeitada:** UUIDv7 dá a mesma imprevisibilidade com melhor comportamento de índice |
| **bigserial/identity** como PK | Simples, compacto, sequencial e rápido | Revela contagem/volume de registros pelo id; round-trip ao banco antes de ter o id em memória; semântica de negócio numa chave que deveria ser só técnica | **Rejeitada:** contraria DEC-002 (PK não previsível) |
| **Sequência nativa do PostgreSQL** (`CREATE SEQUENCE`) por tenant | Nativa, performática, sem tabela própria | `nextval` não é transacional da forma necessária — valor é consumido mesmo com rollback, gerando lacunas; escopo dinâmico por órgão/ano exigiria criar/gerenciar sequências via DDL em massa | **Rejeitada:** DEC-028 exige zero lacunas por rollback, só garantido por `UPDATE … RETURNING` em tabela própria |
| **Número de negócio derivado da própria PK** (ex. parte sequencial embutida no id) | Um único identificador para manter | Reintroduz previsibilidade na PK (contradiz DEC-002); acopla máscara/escopo/reinício anual a uma chave imutável | **Rejeitada:** os dois identificadores têm ciclos de vida opostos |

## Consequências

**Positivas**
- PK nunca revela volume, ordem ou previsibilidade de negócio, mesmo com boa localidade de índice.
- Numeração de negócio sem lacunas, segura sob concorrência e auditável (mesma transação da criação).
- Máscara, escopo e reinício anual são configuráveis por tenant sem migração de esquema.
- Separação clara entre identidade técnica (PK) e identidade de negócio (número) permite evoluir uma sem afetar a outra.

**Negativas**
- Duas identidades por entidade numerada (PK + número) exigem manter as duas sincronizadas em telas, documentos e integrações.
- `UPDATE … RETURNING` na linha da sequência é um ponto de contenção (lock de linha) sob alta concorrência de criação no mesmo escopo/ano.
- Reinício anual e mudança de escopo exigem regra de transição cuidadosa — sequências já abertas não migram automaticamente.
- Tenants que preferirem numerar na autuação mudam `numbering.process.assignOn` para `START`, sem mudança de esquema.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Contenção na linha de `NumberSequence` sob pico de criação no mesmo tenant/ano | Lock é por linha (`sequenceKey`), não global; volume do MVP 1 não indica risco imediato — monitorar |
| Máscara mal configurada pelo tenant | Validação `NUMBERING_MASK_INVALID` na configuração, antes de afetar numeração real (RN-TEN-67) |
| Mudança de escopo no meio do exercício causar confusão | Efeito só no próximo exercício, documentado na própria configuração (RN-TEN-68) |
| Piloto preferir numerar na autuação (`START`) | Comportamento já isolado em `numbering.process.assignOn` — mudança é de configuração, não de esquema |
| Biblioteca de geração de UUIDv7 divergir da RFC final | Validar a biblioteca escolhida (Node.js) antes de congelar em produção |

## Critérios de revisão
- A maioria dos tenants passar a usar `START`, indicando que o padrão do produto deve mudar.
- Contenção real observada na sequência sob concorrência (ex. espera mensurável no `UPDATE`).
- Necessidade de numeração consolidada entre tenants/órgãos, não prevista hoje.
- Especificação de UUIDv7 mudar de forma incompatível com a biblioteca adotada.

## Referências
- DEC-002, DEC-028 — [decisions.md](../architecture/decisions.md).
- [entities.md](../mvp-01/entities.md) — `NumberSequence`; §6 (`TenantSetting` — chaves `numbering.*`); §7 (dados semeados — máscaras `PP {seq:4}/{year}` e `MR {seq:4}/{year}`).
- US-105 — `story-105-numbering.md` (RN-TEN-67 a RN-TEN-73).

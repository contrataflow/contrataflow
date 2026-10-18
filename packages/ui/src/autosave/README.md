# Autosave (`useAutosave`, `AutosaveIndicator`, `ConflictDialog`) — US-015

Mecanismo genérico de autosave do produto (DEC-182 · DEC-055 · RN-DFD-23..36). O DFD (SCR-007) é o
primeiro consumidor; ETP (US-020/022/023 — ETP-04), TR (US-036 — TRM-04) e documentos livres (US-063
— DOC-04) montam as mesmas peças trocando o endpoint de cabeçalho e a permissão de edição do tipo.

## Peças

| Peça                                 | Arquivo                                 | Papel                                                                                                                                                        |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AutosaveQueue`                      | `autosave-queue.ts`                     | Fila por alvo sem React: debounce de 1,5 s, uma gravação em voo por alvo, backoff 2/4/8/16/30 s, `Retry-After`, pausa por conflito, bloqueio geral           |
| `useAutosave`                        | `use-autosave.ts`                       | Hook sobre a fila: `change`, `flush`, `keepMine`, `discard`, `snapshot`; liga `online`, `Ctrl+S` e `beforeunload`                                            |
| `LocalDraftStore`                    | `local-draft-store.ts`                  | Contingência cifrada (AES-GCM, chave não exportável derivada do material da aba no `sessionStorage`), 24 h, chave `cf:{tenant}:{usuário}:{documento}:{alvo}` |
| `mergeHeader`                        | `header-merge.ts`                       | Merge base × local × servidor do 412 do cabeçalho (RN-DFD-28)                                                                                                |
| `diffParagraphs`                     | `text-diff.ts`                          | Diferenças por parágrafo do "Ver diferenças"                                                                                                                 |
| `AutosaveIndicator`                  | `components/autosave-indicator.tsx`     | "Alterações não salvas", "Salvando…", "Salvo às HH:mm", "Erro ao salvar", "Sem conexão — …" (`aria-live="polite"`)                                           |
| `ConflictDialog` / `SectionDiffView` | `components/conflict-dialog.tsx`        | Conflito na seção: "Ver diferenças", "Manter a minha versão", "Descartar a minha e recarregar"                                                               |
| `HeaderConflictDialog`               | `components/header-conflict-dialog.tsx` | Conflito no cabeçalho, escolha por campo                                                                                                                     |
| `RecoveredDraftBanner`               | `components/recovered-draft-banner.tsx` | "Recuperamos alterações não salvas de 14:32." com Restaurar/Descartar                                                                                        |

Os componentes trazem os textos pt-BR padrão e aceitam `labels` (a aplicação passa os do
`next-intl`). Nenhuma peça conhece tipo de documento, rota ou permissão.

## Como montar num editor de documento (ETP, TR, documento livre)

1. **Alvos.** Uma seção = `SECTION:<CHAVE>` (DOC-05, `If-Match: "s<revision>"`, revisão lida no
   DOC-03); o cabeçalho tipado = `HEADER` (ETP-04/TRM-04/DOC-04, `If-Match: "<version>"`, só os
   campos alterados).
2. **`save(alvo, valor, { resolution })`** lê o `If-Match` do alvo (guarde as revisões num `ref`),
   chama a API e atualiza a revisão com a resposta. Em "Manter a minha versão"
   (`resolution === 'keepMine'`), envie `overwrittenRevision` = a revisão atual do servidor.
3. **`classify(erro)`** traduz a API: 412 → `conflict` (com `meta.current`), 401 →
   `sessionExpired`, 403/404/409 → `blocked`, 429 → `rateLimited` (`Retry-After`), 413/422/428 →
   `invalid` (mensagem do campo), rede/5xx → `offline`. Modelo: `apps/web/src/features/dfd/dfd-autosave.ts`.
4. **Cabeçalho com 412:** dentro do `save`, mescle com `mergeHeader` (campos "última gravação vence"
   e "união" nas `rules`); sem conflitos, adote o servidor como base e reenvie (até 3 vezes); com
   conflitos, lance `new AutosaveError({ kind: 'conflict', current })` para o hook pausar o alvo e
   abrir o `HeaderConflictDialog`.
5. **Contingência:** `local: { persist, remove }` sobre um `LocalDraftStore` com o escopo
   `{ tenantId, userId, documentId }` e a revisão-base de cada alvo. Nunca guarde campos mascarados
   por POL-09. Ao abrir o editor, `loadAll(scope)` → `RecoveredDraftBanner`; "Restaurar" reaplica
   só se a revisão-base for a atual, senão abre o `ConflictDialog` (FA-08).
6. **Gatilhos:** `change` a cada digitação; `flush` na perda de foco, na troca de passo e antes de
   comandos de ciclo de vida (submeter/finalizar). `Ctrl+S`, volta da conexão e `beforeunload` já
   vêm do hook.
7. **Modo leitura:** `enabled: false` (sem `UPDATE` em `meta.allowedActions`) — o hook não grava.

```tsx
const autosave = useAutosave<string>({
  enabled: allowedActions.includes('UPDATE'),
  save: async (target, text, { resolution }) => {
    const key = target.slice('SECTION:'.length);
    const saved = await saveSection(documentId, key, text, revisions.current[key], resolution);
    revisions.current[key] = saved.revision;
  },
  classify: classifyApiError,
  local: {
    persist: (t, v) => store.save(scope, t, { base: baseOf(t), value: v }),
    remove: (t) => store.remove(scope, t),
  },
  onConflict: (target, failure) => setConflict({ target, current: failure.current }),
  onBlocked: (failure) => setBlocked(failure),
});

<AutosaveIndicator
  status={autosave.snapshot.status}
  savedAt={autosave.snapshot.savedAt}
  message={autosave.snapshot.message}
/>;
```

Referência completa: `apps/web/src/features/dfd/use-dfd-autosave.ts` (DFD) e os testes
`autosave-queue.test.ts`, `local-draft-store.test.ts`, `components/autosave.test.tsx`.

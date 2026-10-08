# AGENTS.md

## Regras

- **Não faça commit nem push imediatamente após realizar alterações.** Depois de modificar arquivos, pare e aguarde a revisão do usuário. Só faça `git commit` ou `git push` quando o usuário pedir explicitamente.
- **Spec Kit: não leia certos arquivos de `docs/`.** Ao executar qualquer fluxo do Spec Kit (`/speckit-*`), leia apenas os arquivos de `docs/` que não estejam na lista abaixo, para não enviesar as decisões do spec, do plano e das tarefas:
  - `docs/01-premissas.md`
  - `docs/02-requisitos-*`
  - `docs/03-requisitos-*`
  - `docs/04-plano-implementacao.md`
  - `docs/05-historias-de-usuario.md`
  - `docs/adr/`

  Continuam permitidos, por exemplo, `docs/desafio-tecnico.md`, `docs/pesquisa-taxa-de-alertas.md` e `docs/contratos/`.

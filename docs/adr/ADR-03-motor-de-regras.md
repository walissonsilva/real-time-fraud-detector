# ADR-03 — Motor de regras

> Status: **proposto**, com a linguagem da expressão **em aberto** · Data: 07/10/2026 · Requisitos: RF-10, RF-11, RF-18, RF-20 a RF-23, RF-26, RF-40, RNF-07, RNF-30

## Contexto

As regras precisam mudar sem redeploy, ser avaliadas com custo baixo por evento (RNF-07) e não podem executar código arbitrário (RNF-30). O `rule.v1.schema.json` define `expression` como texto, com CEL como alvo.

## Decisão

1. **Regras são dados** (`Rule v1`), avaliadas por um interpretador de expressões, **sem `eval`/`Function`**. Cada versão é compilada uma vez e mantida em memória.
2. **Linguagem da expressão: em aberto entre CEL e JSON Logic.** Será decidida no Dia 1 com um teste de cerca de 30 min. Critérios:
   - custo por avaliação (meta de trabalho: abaixo de 50 µs por regra típica, a validar);
   - limite de custo e de profundidade verificável na validação (RF-26);
   - qualidade das mensagens de erro;
   - maturidade da biblioteca em Node/TypeScript;
   - impacto no contrato.
3. **Impacto no contrato:** CEL mantém `expression: string`. JSON Logic exige `expression` como objeto, o que muda o `rule.v1` (ainda em rascunho) e seus exemplos.
4. **Fonte das regras:** Postgres (ADR-04), atrás da porta `RuleSource`. Cada instância consulta um contador de revisão a cada 15 a 30 s e, se houve mudança, compila o conjunto novo e **troca o conjunto inteiro de uma vez**. Se o banco estiver fora, mantém a última versão válida (RF-40).
5. **Validação antes de ativar:** schema, sintaxe, custo e rejeição de `WINDOWED` na fase 1 (RF-18, RF-26). Uma regra inválida não entra em produção.
6. **`appliesTo`** funciona como pré-filtro barato, antes da expressão.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| AppConfig como fonte das regras | Distribui bem (versões, publicação gradual, *rollback* por alarme), mas não cobre rascunho, aprovação e auditoria. Fica como evolução, via adaptador `AppConfigRuleSource` |
| DSL própria | Custo de parser e de segurança sem ganho para o desafio |
| Regras como código | Exige redeploy; contraria o enunciado |

## Consequências

- Mudar **valores e combinações** de regras não exige deploy. Uma regra que precise de campo ou função novos no motor ainda exige.
- A recarga leva até 30 s (RNF-40); o *rollback* reativa a versão anterior.
- O motor é igual no ambiente local e na AWS.

## Gatilhos de revisão

Resultado do teste de linguagem; necessidade de publicação gradual ou *rollback* por alarme (adotar AppConfig); regras de janela mais complexas (função `distanceKm`, agregação `LAST`).

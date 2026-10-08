# CE 1 — Motor de Detecção de Transações Suspeitas em Tempo Real

> Transcrição do enunciado fornecido em imagem. A formatação e a pontuação foram normalizadas para leitura; os requisitos foram preservados.
>
> [Imagem original](assets/desafio-tecnico-original.jpg)

## Habilidades-chave

Cloud · Containers · Mensageria e Eventos · Estrutura de Dados e Algoritmos · Linguagens de Programação · Modelagem, Armazenamento e Governança de Dados · Segurança · Engenharia de Software · APIs e Integração · Testes · Escalabilidade · Latência e Vazão · Resiliência e Confiabilidade · Monitoramento, Alertas e Observability · Deploy.

## Contexto do negócio

O Itaú quer um módulo que identifique transações suspeitas em tempo real, processando eventos de outros serviços internos e gerando alertas automáticos para a equipe antifraude e para o cliente.

## Desafio proposto

- Receber eventos de transações em tempo real.
- Aplicar lógica de detecção de transações suspeitas.
- Gerar e enviar alertas a canais internos e externos.
- Seguir operando se um serviço auxiliar cair (tecnologias livres, justificadas).
- Não é obrigatório o uso de um banco de dados específico ou arquitetura predeterminada.

## Exigências técnicas

- Vazão: 8.000 TPS (picos de 25k); alerta ≤ 500 ms.
- Segurança ponta a ponta: cripto em trânsito/repouso, autenticação entre serviços, LGPD.
- Consistência e idempotência (sem alertas duplicados).
- Extensibilidade das regras sem necessidade de redeploy.
- Monitoramento operacional (SRE) e resposta a incidentes.

## O que é esperado avaliar com o case

- Capacidade de estruturar sistemas backend distribuídos e orientados a eventos.
- Qualidade das decisões de arquitetura e justificativa de trade-offs.
- Tratamento de falhas, resiliência e estratégia de recuperação.
- Clareza na modelagem de dados e organização do código.
- Estratégia de testes e cobertura de cenários críticos.
- Equilíbrio entre simplicidade e robustez da solução.

## Complexidade do case

- Alta complexidade: múltiplas dimensões simultâneas (escala, latência, resiliência, segurança).
- Indicado para vagas pleno e sênior.
- Para júnior: simplificar via parâmetros adicionais (reduzir TPS e latência exigidos).
- O case diferencia candidatos principalmente pela capacidade de lidar com alta volumetria e tomar decisões arquiteturais sob restrições reais.

## Como aplicar — Take home

- Envie o PDF de Case do Candidato completo para ele se preparar.
- Combine o prazo de 07 dias; as tecnologias e arquitetura são livres, mas devem ser justificadas.
- Resolução assíncrona (código + decisões); finalize com apresentação e defesa ao vivo.

### Quando esse case é a melhor escolha

- Vagas backend com foco em sistemas distribuídos.
- Times que lidam com eventos, fraude ou pagamentos.
- Contextos onde escala e tempo real são relevantes.

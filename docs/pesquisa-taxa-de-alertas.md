# Pesquisa — taxa de fraude e taxa de alerta (base do P-16)

> Registro de pesquisa feito em **07/10/2026**. Objetivo: achar base pública para a premissa [P-16](01-premissas.md) (taxa de alerta), que no rascunho inicial era uma estimativa sem fonte.
> Status: **referência**. Os números são de 2024 e de fontes secundárias; reconferir antes de citar como fato na apresentação.

## 1. Conclusão

- Existe dado público sobre a **taxa de fraude** (fraudes confirmadas por transação). **Não existe** dado público sobre a **taxa de alerta** de um motor de regras: ela depende da calibração das regras de cada instituição.
- A taxa de alerta pode ser **estimada** a partir da taxa de fraude e da precisão dos alertas. A estimativa resultante é de **0,02% a 0,3%** dos eventos, com valor de projeto de **0,1%**.
- O P-16 original (0,1% a 0,5%) ficava na metade alta dessa faixa: era conservador para dimensionar o caminho de alerta, mas sem fonte.

## 2. Taxa de fraude por transação (Brasil, 2024)

As fontes divergem por metodologia. A PagBrasil registra que especialistas criticaram a contagem da Abecs.

| Fonte | Cartões (por 100 mil) | Pix (por 100 mil) | Observação |
|-------|----------------------|-------------------|------------|
| Abecs, jun/2024 | 8 | 12 | Cartões: transações autenticadas e aprovadas. Via Valor Econômico |
| Banco Central (Campos Neto), jul/2024 | 30 | 7 | Declaração pública. Via CNN Brasil |
| Abecs, dez/2024 | 4 | 15 | Pagamentos presenciais. Via InfoMoney |
| Estudo BBVA (arXiv 1710.07709) | < 2 (< 0,002%) | n/a | 900 milhões de transações em ~3 anos, 7,1 milhões de cartões |

Faixa usada na estimativa: **4 a 30 por 100 mil = 0,004% a 0,03%** das transações.

Outros números do Monitor de Fraudes da Abecs (InfoMoney): o índice de fraude em cartões por **valor** caiu 18% em 2024 (33% em dois anos) e por **quantidade** caiu 15% (34,6% em dois anos); o valor transacionado com cartões foi de R$ 4,1 trilhões, alta de 10,9%.

Serasa Experian (via CNN Brasil): tentativas de fraude bancária subiram 10,4% em 2024, com prejuízo potencial de R$ 51,6 bilhões. A fonte não traz o número absoluto de tentativas nem define a metodologia, então **não serve de denominador**. As pesquisas de percepção (por exemplo, 50,7% dos brasileiros dizem ter sido vítimas de fraude no ano) medem experiência de consumidores, não taxa por transação.

## 3. De fraude para alerta

```
taxaDeAlerta ≈ taxaDeFraude × recall ÷ precisão
```

- **Recall ≈ 0,9**: ponto de operação do sistema do BBVA no estudo (TPR ≥ 89%).
- **Precisão 10% a 20%**: o estudo cita a Javelin ("só 1 em 5 declarados como fraude é fraude"), e o sistema do BBVA tinha precisão de 0,1166 nesse ponto.

| Cenário | Fraude | Precisão | Taxa de alerta | A 8k TPS | No pico de 25k |
|---------|--------|----------|----------------|----------|----------------|
| Piso | 0,004% | 20% | ≈ 0,02% | ≈ 1,4/s | ≈ 4,5/s |
| Central | 0,015% | 15% | ≈ 0,09% (valor de projeto: 0,1%) | ≈ 7/s | ≈ 23/s |
| Teto | 0,03% | 10% | ≈ 0,27% (arredondado: 0,3%) | ≈ 22/s | ≈ 68/s |

## 4. Limites desta estimativa

- A precisão da Javelin chega de **segunda mão**, citada no artigo do BBVA.
- Os números do BBVA vêm de uma **amostra enriquecida com fraude** (72 mil cartões entre 7,1 milhões). Servem para ordem de grandeza da taxa de fraude, mas **não projetam** a taxa de alerta nem a precisão da população. O artigo também é inconsistente em alguns totais (122 mil vs. 111.897 transações fraudulentas).
- As taxas do Banco Central e da PagBrasil vêm de **reportagens**, não de fonte primária.
- Os números descrevem **sistemas maduros, com ML e várias camadas**. A taxa de um motor só de regras depende da calibração dos limites, e é isso que o gerador de carga controla.
- Fraude **confirmada** não inclui tentativas bloqueadas antes de virar fraude.

## 5. Decisão registrada

- P-16 reescrito: **valor de projeto 0,1%**, faixa plausível 0,02% a 0,3%.
- O teste de carga (k6) parametriza a taxa de alerta e cobre de **0,02% a 5%** (estresse), mais 100% como pior caso isolado do caminho de alerta.
- Na defesa: "o enunciado não informa a taxa; derivei da fraude pública e da precisão típica, e testei até 10 vezes (e 50 vezes) acima".

## 6. O que não foi possível verificar

| Fonte | Problema |
|-------|----------|
| API de dados abertos do Banco Central (`EstatisticasFraudesPix`, ODbL, publicação mensal com 30 dias de defasagem) | Acesso bloqueado pelo `robots.txt` da ferramenta de busca; a página do conjunto de dados não traz números |
| Artigo "Reducing false positives in bank anti-fraud systems" (ScienceDirect) | Bloqueado por `robots.txt` |
| CNBC, "Why credit card fraud alerts are rising" | Erro 403 |

**Próximo passo, se quiser uma base primária para o Pix:** consultar a API de dados abertos do Banco Central (estatísticas de fraude do MED e transações Pix por mês) e calcular a taxa por transação com dados oficiais.

## Fontes

- [Fraudes com cartões recuam 18% em 2024, segundo Monitor de Fraudes (InfoMoney, dados da Abecs)](https://www.infomoney.com.br/minhas-financas/fraudes-com-cartoes-recuam-18-em-2024-segundo-monitor-de-fraudes/)
- [Fraudes Pix vs. cartão de crédito (PagBrasil, citando Valor Econômico e CNN Brasil)](https://www.pagbrasil.com/blog/news/pix-vs-credit-cards-the-real-story-of-security-in-brazils-digital-payment/)
- [Reducing false positives in credit card fraud detection (arXiv 1710.07709, dados do BBVA)](https://ar5iv.arxiv.org/html/1710.07709)
- [Tentativas de fraudes bancárias sobem 10,4% em 2024 (CNN Brasil, dados da Serasa Experian)](https://www.cnnbrasil.com.br/economia/financas/tentativas-de-fraudes-bancarias-sobem-104-em-2024-diz-serasa/)
- [Estatísticas de fraude no Pix (MED), Portal de Dados Abertos do Banco Central](https://dadosabertos.bcb.gov.br/en/dataset/pix/resource/7eb5efdd-d4dd-47da-a74a-d93ce68ea185)

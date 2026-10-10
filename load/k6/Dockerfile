# Imagem do gerador de carga para a AWS (task Fargate). Construída e publicada no ECR por
# infra/terraform/scripts/loadtest.sh. Contexto de build: esta pasta.
# Sem dependências de internet em tempo de execução: as libs ficam em vendor/.
FROM grafana/k6:0.55.0
WORKDIR /scripts
COPY fraud-latency.js ./
COPY vendor ./vendor
# Parâmetros (RATE, DURATION_SECONDS, SINK_QUEUE_URL...) chegam por variáveis de ambiente da task.
CMD ["run", "--quiet", "/scripts/fraud-latency.js"]

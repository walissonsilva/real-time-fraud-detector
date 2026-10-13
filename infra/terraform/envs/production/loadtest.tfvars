# Override para as execuções de referência do teste de carga (docs/teste-de-carga-aws-1000tps.md).
# Aplicar DEPOIS do perfil base, que fornece o restante:
#   terraform apply -var-file=lean.tfvars -var-file=loadtest.tfvars -var image_tag=$TAG -var loadtest_image=<ecr>/k6:<tag>
# Ao terminar, reaplicar só com -var-file=lean.tfvars para voltar ao Spot.

# Tudo On-Demand: uma reclamação de Spot no meio da janela de medição invalidaria a rodada.
fargate_base        = 3
fargate_weight      = 1
fargate_spot_weight = 0

# Cria task definition, role, SG e logs do gerador k6. A imagem (própria, no ECR) vem de -var loadtest_image.
enable_loadtest = true

# Degrau de 4.000 TPS (cotas: 8 vCPU Fargate On-Demand; o k6 roda em EC2 e não consome a cota Fargate).
# ~0,9 vCPU do app por 1.000 TPS => ~3,5 vCPU reais a 4k; 6 a 8 tasks mantêm a CPU abaixo do alvo de 60%.
service_min_count = 6
service_max_count = 8

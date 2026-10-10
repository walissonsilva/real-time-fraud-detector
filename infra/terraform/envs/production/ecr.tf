resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ephemeral

  image_scanning_configuration { scan_on_push = true }

  encryption_configuration {
    encryption_type = var.enable_cmk ? "KMS" : "AES256"
    kms_key         = local.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Manter as 20 imagens mais recentes"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# Imagem do gerador de carga k6 (load/k6/Dockerfile), publicada pelo loadtest.sh.
resource "aws_ecr_repository" "loadtest" {
  count                = var.enable_loadtest ? 1 : 0
  name                 = "${var.name}-loadtest"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }

  encryption_configuration {
    encryption_type = var.enable_cmk ? "KMS" : "AES256"
    kms_key         = local.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "loadtest" {
  count      = var.enable_loadtest ? 1 : 0
  repository = aws_ecr_repository.loadtest[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Manter as 5 imagens mais recentes"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # Configuração parcial: terraform init -backend-config=backend.hcl (veja backend.hcl.example)
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "fraud-detector", Environment = "production", Profile = var.profile, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" { state = "available" }

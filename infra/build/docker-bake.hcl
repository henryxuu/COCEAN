variable "REGISTRY" {
  default = "ghcr.io"
}

variable "IMAGE_NAMESPACE" {
  default = "cocean-project"
}

variable "VERSION" {
  default = "edge"
}

variable "PNPM_VERSION" {
  default = "11.0.0"
}

variable "NODE_IMAGE" {
  default = "node:22.22.0-bookworm-slim"
}

variable "DEBIAN_MIRROR" {
  default = ""
}

group "default" {
  targets = ["web", "server", "worker"]
}

target "common" {
  context    = "."
  dockerfile = "infra/docker/Dockerfile.node-runtime"
  platforms  = ["linux/amd64", "linux/arm64"]
  args = {
    DEBIAN_MIRROR = DEBIAN_MIRROR
    NODE_IMAGE    = NODE_IMAGE
    PNPM_VERSION  = PNPM_VERSION
  }
  labels = {
    "org.opencontainers.image.source" = "COCEAN"
  }
}

target "web" {
  inherits = ["common"]
  args = {
    COCEAN_APP = "web"
  }
  tags = ["${REGISTRY}/${IMAGE_NAMESPACE}/web:${VERSION}"]
}

target "server" {
  inherits = ["common"]
  args = {
    COCEAN_APP = "server"
  }
  tags = ["${REGISTRY}/${IMAGE_NAMESPACE}/server:${VERSION}"]
}

target "worker" {
  inherits = ["common"]
  args = {
    COCEAN_APP = "worker"
  }
  tags = ["${REGISTRY}/${IMAGE_NAMESPACE}/worker:${VERSION}"]
}

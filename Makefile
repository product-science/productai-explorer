.PHONY: release build-docker docker-push

VERSION ?= $(shell git describe --always)
SET_LATEST ?= 0
SET_LATEST := $(shell if [ "$(SET_LATEST)" = "1" ]; then echo 1; else echo 0; fi)
PLATFORMS ?= linux/amd64,linux/arm64
IMAGE_GHCR = ghcr.io/product-science/explorer

# Multi-arch build + push. buildx cannot --load more than one platform, so this is one step.
release:
	docker buildx build \
		--platform $(PLATFORMS) \
		-f Dockerfile \
		-t $(IMAGE_GHCR):$(VERSION) \
		$(if $(filter 1,$(SET_LATEST)),-t $(IMAGE_GHCR):latest) \
		--push \
		.

# Local single-arch image for testing on this machine.
build-docker:
	docker build -f Dockerfile -t $(IMAGE_GHCR):$(VERSION) .
	@if [ "$(SET_LATEST)" = "1" ]; then \
		echo "Setting latest tag..."; \
		docker tag $(IMAGE_GHCR):$(VERSION) $(IMAGE_GHCR):latest; \
	fi

docker-push: release

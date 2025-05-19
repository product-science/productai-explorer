.PHONY: release build-docker

VERSION ?= $(shell git describe --always)
SET_LATEST ?= 0
SET_LATEST := $(shell if [ "$(SET_LATEST)" = "1" ]; then echo 1; else echo 0; fi)
IMAGE_NAME=gcr.io/decentralized-ai/ping-pub-explorer
PROXY_PORT ?= 3000

build-docker:
	docker build --build-arg PROXY_PORT=$(PROXY_PORT) -t $(IMAGE_NAME):$(VERSION) .
	@if [ "$(SET_LATEST)" = "1" ]; then \
		echo "Setting latest tag..."; \
		docker tag $(IMAGE_NAME):$(VERSION) $(IMAGE_NAME):latest; \
	fi

docker-push:
	@echo "pushing to Google Cloud Artifact Registry"
	@docker push $(IMAGE_NAME):$(VERSION)
	@docker tag $(IMAGE_NAME):$(VERSION) ghcr.io/product-science/ping-pub-explorer:$(VERSION)
	@echo "pushing to GitHub Container Registry"
	@docker push ghcr.io/product-science/ping-pub-explorer:$(VERSION)

	@if [ "$(SET_LATEST)" = "1" ]; then \
		@echo "Setting latest tag..."; \
		@docker tag $(IMAGE_NAME):$(VERSION) $(IMAGE_NAME):latest; \
		@echo "Pushing latest tag to Google Cloud Artifact Registry"; \
		@docker push $(IMAGE_NAME):latest; \
		@echo "Pushing latest tag to GitHub Container Registry"; \
		@docker tag ghcr.io/product-science/ping-pub-explorer:$(VERSION) ghcr.io/product-science/ping-pub-explorer:latest; \
		@docker push ghcr.io/product-science/ping-pub-explorer:latest; \
	fi

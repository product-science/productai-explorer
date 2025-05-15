.PHONY: release build-docker

VERSION ?= $(shell git describe --always)
SET_LATEST ?= 0
SET_LATEST := $(shell if [ "$(SET_LATEST)" = "1" ]; then echo 1; else echo 0; fi)

build-docker:
	docker build -t ping-pub-explorer:$(VERSION) .
	@if [ "$(SET_LATEST)" = "1" ]; then \
		echo "Setting latest tag..."; \
		docker tag ping-pub-explorer:$(VERSION) ping-pub-explorer:latest; \
	fi


docker-push: build-docker
	@echo "pushing to Google Cloud Artifact Registry"
	@docker push gcr.io/decentralized-ai/ping-pub-explorer:$(VERSION)
	@docker tag gcr.io/decentralized-ai/ping-pub-explorer:$(VERSION) ghcr.io/product-science/ping-pub-explorer:$(VERSION)
	@echo "pushing to GitHub Container Registry"
	@docker push ghcr.io/product-science/tmkms-softsign-with-keygen:$(VERSION)

	@if [ "$(SET_LATEST)" = "1" ]; then \
		@echo "Setting latest tag..."; \
		@docker tag gcr.io/decentralized-ai/ping-pub-explorer:$(VERSION) gcr.io/decentralized-ai/ping-pub-explorer:latest; \
		@echo "Pushing latest tag to Google Cloud Artifact Registry"; \
		@docker push gcr.io/decentralized-ai/ping-pub-explorer:latest; \
		@echo "Pushing latest tag to GitHub Container Registry"; \
		@docker tag ghcr.io/product-science/ping-pub-explorer:$(VERSION) ghcr.io/product-science/ping-pub-explorer:latest; \
		@docker push ghcr.io/product-science/ping-pub-explorer:latest; \
	fi

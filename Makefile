IMAGE_NAME ?= agent-orchestrator
REGISTRY  ?= luberserker
GIT_TAG   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo latest)
OPENCODE_VERSION ?= $(shell node -p "try{var j=require('./config/agentorchestrator.json');var r=j.orchestrator.runtimes.find(function(r){return r.type==='direct'});r?r.config.version||'':''}catch(e){''}")

.PHONY: docker-build docker-tag docker-push docker-clean docker-version render-dockerfile

render-dockerfile:       ## Render Dockerfile.template → Dockerfile
	node scripts/render-dockerfile.cjs

docker-build: render-dockerfile ## Render template, then build the image
	docker build --build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) -t $(IMAGE_NAME):latest .

docker-tag:             ## Tag with git version
	docker tag $(IMAGE_NAME):latest $(REGISTRY)/$(IMAGE_NAME):$(GIT_TAG)

docker-push: docker-tag ## Tag + push to registry
	docker push $(REGISTRY)/$(IMAGE_NAME):$(GIT_TAG)

docker-clean:           ## Remove local images for this project
	docker rmi -f $(shell docker images --filter "reference=$(IMAGE_NAME)*" -q) 2>/dev/null || true
	docker image prune -f --filter "label=org.opencontainers.image.title=$(IMAGE_NAME)" 2>/dev/null || true

docker-version:         ## Show computed image tag
	@echo "Image: $(REGISTRY)/$(IMAGE_NAME):$(GIT_TAG)"

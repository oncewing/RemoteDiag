EXPIRE_DATE ?= $(shell date -d '+1 month' +%Y-%m-%d)
VERSION     ?= $(shell grep -E '^\s+VERSION\s*=' secrets.go | sed 's/.*"\(.*\)".*/\1/')
OUTPUT      := ../dist_go/woorinet_remote_diag_agent.exe

.PHONY: build

build:
	GOOS=windows GOARCH=amd64 go build \
		-ldflags="-s -w -X main.EXPIRE_DATE=$(EXPIRE_DATE) -X main.VERSION=$(VERSION)" \
		-o $(OUTPUT) .
	@echo "빌드 완료: $(OUTPUT)  [만료일: $(EXPIRE_DATE) / 버전: $(VERSION)]"

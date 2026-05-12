.PHONY: help services-up services-down engine-dev devvit-dev lint test eval clean

help:
	@echo "ModPilot — common tasks"
	@echo ""
	@echo "  make services-up      Start local Postgres + Redis (docker-compose)"
	@echo "  make services-down    Stop local services"
	@echo "  make engine-dev       Run Investigation Engine with hot reload"
	@echo "  make devvit-dev       Upload Devvit app to test subreddit"
	@echo "  make lint             Run ruff + eslint + type checks"
	@echo "  make test             Run pytest + jest"
	@echo "  make eval             Run evaluation harness against all scenarios"
	@echo "  make clean            Remove caches, build artifacts"

services-up:
	@echo "TODO(F-0.6): docker-compose up for Postgres + Redis"

services-down:
	@echo "TODO(F-0.6): docker-compose down"

engine-dev:
	cd engine && uv run uvicorn api.main:app --reload --port 8000

devvit-dev:
	cd devvit-app && npx devvit upload

lint:
	cd engine && uv run ruff check . && uv run mypy --strict .
	cd devvit-app && npx eslint src && npx tsc --noEmit

test:
	cd engine && uv run pytest
	cd devvit-app && npx jest

eval:
	cd engine && uv run python -m eval.run --suite all

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type d -name .pytest_cache -prune -exec rm -rf {} +
	find . -type d -name .mypy_cache -prune -exec rm -rf {} +
	find . -type d -name .ruff_cache -prune -exec rm -rf {} +
	rm -rf devvit-app/dist devvit-app/.eslintcache

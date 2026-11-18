#!/usr/bin/env bash
# Single-host role deployment: PostgreSQL + scheduler + four generic builders.
#
#   export DEEPSEEK_API_KEY=...
#   scripts/roles.sh up                # build (if needed) and start
#   scripts/roles.sh up --build        # force an image rebuild
#   scripts/roles.sh down [--volumes]  # stop (optionally drop data)
#   scripts/roles.sh logs
#   scripts/roles.sh apply             # push projects/demo/project.json
#
# The host tree lives under PLATFORM_ROOT (default /opt/platform):
#
#   $PLATFORM_ROOT/projects/<project>/{repo,snapshots,work,changes,artifacts}
#   $PLATFORM_ROOT/scripts/            generic lifecycle scripts (mounted at /scripts)
#
# Builders are started with no business role; scripts/roles.sh apply assigns them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="deploy/compose.roles.yaml"
ENV_FILE="deploy/.env.roles"
export PLATFORM_ROOT="${PLATFORM_ROOT:-/opt/platform}"
export SCHEDULER_PORT="${SCHEDULER_PORT:-18443}"
export UI_PORT="${UI_PORT:-18080}"
SCHEDULER_URL="http://127.0.0.1:${SCHEDULER_PORT}"
UI_URL="http://127.0.0.1:${UI_PORT}"
export PLATFORM_SCHEDULER_URL="$SCHEDULER_URL"

# shellcheck source=scripts/lib-env.sh
. "$ROOT/scripts/lib-env.sh"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

ensure_env_file() {
  [[ -f "$ENV_FILE" ]] && return 0
  echo "[roles] creating $ENV_FILE"
  local password
  # Avoid `tr </dev/urandom | head`: head closing the pipe makes tr die of
  # SIGPIPE, and pipefail turns that into a silent script exit.
  password="$(openssl rand -hex 16 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  umask 077
  cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=${password}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}
# Mirror prefix for images that would otherwise come from Docker Hub
# (for example docker.m.daocloud.io/library/). Leave empty for direct access.
PG_REGISTRY=${PG_REGISTRY:-}
# Registry prefix for Ubuntu base images used by the scheduler/builder builds.
REGISTRY=${REGISTRY:-}
APT_MIRROR=${APT_MIRROR:-}
HOST_ID=${HOST_ID:-docker-host-01}
UI_PORT=${UI_PORT}
# First login for the admin app; created once by pcs-issuer/scripts/seed-admin.ts.
PCS_ADMIN_USER=${PCS_ADMIN_USER:-admin}
PCS_ADMIN_PASSWORD=$(openssl rand -hex 16 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
EOF
  chmod 600 "$ENV_FILE"
}

# An env file written by an older version lacks the keys newer services require;
# append defaults rather than making the operator regenerate (and lose) it.
ensure_env_keys() {
  local key value
  for key in UI_PORT PCS_ADMIN_USER PCS_ADMIN_PASSWORD; do
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      case "$key" in
        UI_PORT) value="$UI_PORT" ;;
        PCS_ADMIN_USER) value="${PCS_ADMIN_USER:-admin}" ;;
        PCS_ADMIN_PASSWORD) value="$(openssl rand -hex 16 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" ;;
      esac
      printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
      echo "[roles] added ${key} to ${ENV_FILE}"
    fi
  done
}

env_value() {
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -1
}

prepare_host_tree() {
  local projects="$PLATFORM_ROOT/projects"
  local scripts_dir="$PLATFORM_ROOT/scripts"
  local project="${PROJECT:-demo}"

  mkdir -p "$projects/$project"/{repo,snapshots,work,changes,artifacts} "$scripts_dir"

  # The generic lifecycle scripts are repository code; the host copy is what
  # the containers mount read-only.
  cp "$ROOT"/scripts/platform/*.sh "$scripts_dir/"
  chmod 0755 "$scripts_dir"/*.sh

  # Project definition (roles/plan/assignments live in the repository; the
  # host copy is only used for project-local test/review scripts).
  if [[ -d "$ROOT/projects/$project" ]]; then
    cp "$ROOT/projects/$project"/*.sh "$projects/$project/" 2>/dev/null || true
    cp "$ROOT/projects/$project/project.json" "$projects/$project/" 2>/dev/null || true
  fi

  # A demo project needs a starting tree, otherwise the first development task
  # has nothing to sync from. Real projects bring their own checkout.
  if [[ "$project" == "demo" && -z "$(ls -A "$projects/$project/repo" 2>/dev/null)" ]]; then
    mkdir -p "$projects/$project/repo/ui" "$projects/$project/repo/drivers"
    cat > "$projects/$project/repo/README.md" <<'MD'
# demo

A starting tree for the role-based scheduler. Edit files under `ui/` or
`drivers/`; a development task copies this tree into its work tree, and a
review task applies the resulting change package back here.
MD
    printf 'function render() {\n  return "hello";\n}\n' > "$projects/$project/repo/ui/view.js"
    printf '/* demo driver placeholder */\n' > "$projects/$project/repo/drivers/demo.c"
    cat > "$projects/$project/repo/smoke.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo smoke-ok
SH
    chmod +x "$projects/$project/repo/smoke.sh"
  fi

  # The scheduler container runs as root; the work tree must stay writable for
  # the builder UIDs too.
  chmod -R a+rwX "$projects/$project" || true

  echo "[roles] project tree: $projects/$project"
}

wait_healthy() {
  for _ in $(seq 1 90); do
    if curl -fsS "$SCHEDULER_URL/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "[roles] scheduler did not become healthy at $SCHEDULER_URL" >&2
  return 1
}

# The UI is a convenience; a slow first build of the web image should not fail
# `up` after the scheduler is already serving.
wait_ui() {
  for _ in $(seq 1 60); do
    if curl -fsS "$UI_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "[roles] admin UI not reachable yet at $UI_URL (check: docker compose logs web)" >&2
  return 0
}

case "${1:-}" in
  up)
    shift
    ensure_curl || { echo "[roles] curl is required" >&2; exit 1; }
    ensure_docker 1 || { echo "[roles] Docker is required" >&2; exit 1; }
    reexec_with_docker_group "$0" "$@"
    docker compose version >/dev/null 2>&1 || { echo "[roles] Docker Compose v2 is required" >&2; exit 1; }
    ensure_env_file
    ensure_env_keys
    prepare_host_tree
    compose up -d "$@"
    wait_healthy
    wait_ui
    echo "[roles] scheduler: $SCHEDULER_URL"
    echo "[roles] admin UI:  $UI_URL"
    echo "[roles] admin user: $(env_value PCS_ADMIN_USER)  (password: deploy/.env.roles)"
    echo "[roles] next: node scripts/platformctl.mjs apply projects/${PROJECT:-demo}/project.json"
    ;;
  down)
    shift
    compose down "$@"
    ;;
  logs)
    shift
    compose logs -f "$@"
    ;;
  apply)
    shift
    node "$ROOT/scripts/platformctl.mjs" apply "$ROOT/projects/${PROJECT:-demo}/project.json" "$@"
    ;;
  status)
    shift
    node "$ROOT/scripts/platformctl.mjs" status --project "${PROJECT:-demo}" "$@"
    ;;
  --help|-h|help|"")
    cat <<'USAGE'
Usage: scripts/roles.sh <command>

  up [--build]       build if needed and start the stack
  down [--volumes]   stop the stack (optionally drop its data)
  logs               follow container logs
  apply              apply projects/<PROJECT>/project.json to the scheduler
  status             instances, role coverage, plans and recent tasks

Environment:
  DEEPSEEK_API_KEY   model credential for the builders (first `up` writes it to deploy/.env.roles)
  PLATFORM_ROOT      host tree root (default /opt/platform)
  PROJECT            project key (default demo)
  SCHEDULER_PORT     loopback port for the scheduler API (default 18443)
  UI_PORT            loopback port for the admin app (default 18080)
  PCS_ADMIN_USER     first admin login, created on first `up` (default admin)
  PCS_ADMIN_PASSWORD generated into deploy/.env.roles on first `up`

The admin app is served on UI_PORT once the stack is up (default http://127.0.0.1:18080).
USAGE
    ;;
  *)
    echo "[roles] unknown command: $1" >&2
    exit 2
    ;;
esac

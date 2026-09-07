#!/usr/bin/env bash
set -Eeuo pipefail

# Install the independent STRM compose project. Every Docker operation below
# is scoped to the kikoeru-strm compose service or its fixed container name;
# this script never runs a project-wide prune/remove and never touches the
# production `kikoeru` container.

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="${KIKOERU_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd -P)}"
UPSTREAM_IMAGE='number17/kikoeru@sha256:e934185b734b35e15fcdf62d96e65445edb1979ba0ed25d23d08679abda65c1c'
DEFAULT_IMAGE='kikoeru-strm:0.1.1'
DEFAULT_PORT=12346
SERVICE='kikoeru-strm'
CONTAINER='kikoeru-strm-12346'

ENV_PATH=''
TEMP_ENV=''

die() {
  printf 'install.sh: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh --media DIR --helper HOST[:PORT] [options]

Required:
  --media DIR       Existing absolute host directory containing the STRM media.
  --helper HOST     115 STRM Helper host[:port], without scheme or path.

Options:
  --port PORT       Host port for the independent service (default: 12346).
  --image IMAGE     Versioned local image tag (default: kikoeru-strm:0.1.1).
  --force           Replace an existing .env atomically.
  -h, --help        Show this help.

The upstream image is always pinned to the verified digest in the generated
.env. This command is non-interactive and never removes existing bind data.
USAGE
}

require_value() {
  [[ $# -ge 2 && -n ${2:-} ]] || die "$1 requires a value"
}

validate_text() {
  local label=$1 value=$2
  [[ -n "$value" ]] || die "$label must not be empty"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label must not contain a newline"
}

validate_port() {
  local label=$1 value=$2 number
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label must be an integer from 1 to 65535"
  number=$((10#$value))
  (( number >= 1 && number <= 65535 )) || die "$label must be an integer from 1 to 65535"
}

validate_image() {
  local image=$1
  validate_text image "$image"
  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]*$ ]] || die "invalid image reference: $image"
  [[ "$image" == *:* || "$image" == *@* ]] || die 'image must include an explicit version tag or digest'
  case "$image" in
    latest|*/latest|*:latest) die 'mutable :latest image tags are not allowed' ;;
  esac
}

validate_helper() {
  local helper=$1 host port
  validate_text STRM_ALLOWED_HOSTS "$helper"
  [[ "$helper" != *"://"* && "$helper" != */* && "$helper" != *\?* && "$helper" != *\#* && "$helper" != *,* ]] \
    || die 'Helper must be host[:port] without scheme, path, query or fragment'

  if [[ "$helper" =~ ^\[([^][]+)\](:([0-9]+))?$ ]]; then
    host=${BASH_REMATCH[1]}
    port=${BASH_REMATCH[3]:-}
    [[ "$host" == *:* && "$host" =~ ^[0-9A-Fa-f:.]+$ ]] \
      || die 'Helper IPv6 host is invalid'
  elif [[ "$helper" =~ ^([^:]+)(:([0-9]+))?$ ]]; then
    host=${BASH_REMATCH[1]}
    port=${BASH_REMATCH[3]:-}
    [[ "$host" =~ ^[A-Za-z0-9.-]+$ && "$host" != .* && "$host" != *. && "$host" != *..* ]] \
      || die 'Helper host is invalid'
    local label
    local -a labels
    IFS='.' read -r -a labels <<< "$host"
    for label in "${labels[@]}"; do
      [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] \
        || die 'Helper host is invalid'
    done
  else
    die 'Helper must be a legal host[:port] without scheme or path'
  fi

  if [[ -n "$port" ]]; then
    validate_port 'Helper port' "$port"
  fi
}

port_available() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    if ss -H -ltn 2>/dev/null | awk -v wanted="$port" '
      {
        endpoint = $4;
        sub(/^.*:/, "", endpoint);
        if (endpoint == wanted) found = 1;
      }
      END { exit found ? 0 : 1 }
    '; then
      die "host port $port is already in use"
    fi
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .; then
      die "host port $port is already in use"
    fi
    return 0
  fi
  die 'cannot check whether the host port is available (need ss or lsof)'
}

dotenv_quote() {
  local value=$1
  [[ "$value" != *"'"* ]] || die 'values containing single quotes are not supported in .env'
  printf "'%s'" "$value"
}

cleanup_temp() {
  if [[ -n "${TEMP_ENV:-}" ]]; then
    rm -f -- "$TEMP_ENV"
  fi
}
trap cleanup_temp EXIT

compose() {
  (
    cd -- "$PROJECT_DIR"
    # Keep shell overrides from silently replacing the validated .env values.
    env -u KIKOERU_UPSTREAM_IMAGE \
      -u KIKOERU_STRM_IMAGE \
      -u KIKOERU_STRM_PORT \
      -u KIKOERU_STRM_MEDIA_DIR \
      -u STRM_ALLOWED_HOSTS \
      docker compose --env-file "$ENV_PATH" "$@"
  )
}

wait_for_health() {
  local timeout=${KIKOERU_HEALTH_TIMEOUT_SEC:-120} health='' deadline
  [[ "$timeout" =~ ^[0-9]+$ ]] || die 'KIKOERU_HEALTH_TIMEOUT_SEC must be an integer'
  deadline=$((SECONDS + timeout))
  while (( SECONDS <= deadline )); do
    health="$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    if [[ "$health" == healthy ]]; then
      if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        return 0
      fi
      # A mocked/minimal environment may not have curl; Docker health is still
      # authoritative in that case.
      if ! command -v curl >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done
  die "${CONTAINER} did not become healthy within ${timeout}s (last status: ${health:-unknown})"
}

MEDIA_DIR=''
HELPER=''
PORT=$DEFAULT_PORT
IMAGE=$DEFAULT_IMAGE
FORCE=0

while (($#)); do
  case "$1" in
    --media)
      require_value --media "${2:-}"
      MEDIA_DIR=$2
      shift 2
      ;;
    --helper)
      require_value --helper "${2:-}"
      HELPER=$2
      shift 2
      ;;
    --port)
      require_value --port "${2:-}"
      PORT=$2
      shift 2
      ;;
    --image)
      require_value --image "${2:-}"
      IMAGE=$2
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (use --help for usage)"
      ;;
  esac
done

[[ -n "$MEDIA_DIR" ]] || die '--media is required'
[[ -n "$HELPER" ]] || die '--helper is required'
validate_text media "$MEDIA_DIR"
[[ "$MEDIA_DIR" == /* ]] || die '--media must be an absolute existing directory'
[[ "$MEDIA_DIR" != *"'"* ]] || die '--media must not contain a single quote'
MEDIA_DIR="$(cd -- "$MEDIA_DIR" 2>/dev/null && pwd -P)" || die '--media must be an existing directory'
validate_helper "$HELPER"
validate_port --port "$PORT"
validate_image "$IMAGE"
port_available "$PORT"

PROJECT_DIR="$(cd -- "$PROJECT_DIR" 2>/dev/null && pwd -P)" || die 'project directory does not exist'
[[ -f "$PROJECT_DIR/docker-compose.yml" ]] || die 'docker-compose.yml is missing from project directory'
[[ -f "$PROJECT_DIR/scripts/build-overlay.sh" ]] || die 'scripts/build-overlay.sh is missing from project directory'
ENV_PATH="$PROJECT_DIR/.env"
if [[ -e "$ENV_PATH" && "$FORCE" -ne 1 ]]; then
  die "$ENV_PATH already exists; use --force only when replacing it is intentional"
fi

command -v docker >/dev/null 2>&1 || die 'docker is required'
docker compose version >/dev/null 2>&1 || die 'Docker Compose is required'
command -v npm >/dev/null 2>&1 || die 'npm is required'

mkdir -p -- \
  "$PROJECT_DIR/deploy/runtime/config" \
  "$PROJECT_DIR/deploy/runtime/sqlite" \
  "$PROJECT_DIR/deploy/runtime/covers" \
  "$PROJECT_DIR/deploy/runtime/cache"

TEMP_ENV="$(mktemp "$PROJECT_DIR/.env.install.XXXXXX")"
{
  printf '# Generated by scripts/install.sh; edit only with an intentional upgrade.\n'
  printf 'KIKOERU_ADMIN_PASSWORD=\n'
  printf 'KIKOERU_UPSTREAM_IMAGE=%s\n' "$UPSTREAM_IMAGE"
  printf 'KIKOERU_STRM_IMAGE=%s\n' "$IMAGE"
  printf 'KIKOERU_STRM_PORT=%s\n' "$PORT"
  printf 'KIKOERU_STRM_MEDIA_DIR=%s\n' "$(dotenv_quote "$MEDIA_DIR")"
  printf 'STRM_ALLOWED_HOSTS=%s\n' "$(dotenv_quote "$HELPER")"
} >"$TEMP_ENV"
chmod 600 "$TEMP_ENV"
mv -f -- "$TEMP_ENV" "$ENV_PATH"
TEMP_ENV=''

(
  cd -- "$PROJECT_DIR"
  npm test
)
compose config >/dev/null
(
  cd -- "$PROJECT_DIR"
  KIKOERU_UPSTREAM_IMAGE="$UPSTREAM_IMAGE" \
    KIKOERU_STRM_IMAGE="$IMAGE" \
    bash scripts/build-overlay.sh
)
compose up -d --no-build --force-recreate "$SERVICE"
wait_for_health

printf 'installed %s on port %s; media=%s helper=%s\n' "$SERVICE" "$PORT" "$MEDIA_DIR" "$HELPER"

#!/usr/bin/env bash
set -Eeuo pipefail

# Lifecycle operations for the independent STRM compose project. Do not add
# broad Docker cleanup here: the production `kikoeru` container and all media
# outside this project's bind mounts are intentionally out of scope.

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="${KIKOERU_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd -P)}"
ENV_PATH=''
UPSTREAM_IMAGE='number17/kikoeru@sha256:e934185b734b35e15fcdf62d96e65445edb1979ba0ed25d23d08679abda65c1c'
DEFAULT_IMAGE='kikoeru-strm:0.1.1'
SERVICE='kikoeru-strm'
CONTAINER='kikoeru-strm-12346'
TEMP_ENV=''

die() {
  printf 'manage.sh: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/manage.sh COMMAND [options]

Commands:
  status                    Show the independent service and health status.
  start                     Start the service without rebuilding its image.
  stop                      Stop only the independent service.
  upgrade [--image IMAGE]   Rebuild the configured image, or use an existing image.
  rollback --image IMAGE   Recreate using an existing local image tag.
  uninstall                 Down the compose project and retain all bind data.

Options:
  --image IMAGE             Versioned/immutable image reference.
  --purge-data              Refused intentionally; bind data is never deleted.
  -h, --help                Show this help.

All lifecycle operations are limited to the kikoeru-strm compose project and
the kikoeru-strm-12346 container. The production kikoeru container is ignored.
USAGE
}

validate_text() {
  local label=$1 value=$2
  [[ -n "$value" ]] || die "$label must not be empty"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label must not contain a newline"
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

cleanup_temp() {
  if [[ -n "${TEMP_ENV:-}" ]]; then
    rm -f -- "$TEMP_ENV"
  fi
}
trap cleanup_temp EXIT

require_project() {
  PROJECT_DIR="$(cd -- "$PROJECT_DIR" 2>/dev/null && pwd -P)" || die 'project directory does not exist'
  [[ -f "$PROJECT_DIR/docker-compose.yml" ]] || die 'docker-compose.yml is missing from project directory'
  ENV_PATH="$PROJECT_DIR/.env"
  [[ -f "$ENV_PATH" ]] || die "$ENV_PATH is missing; run install.sh first"
  command -v docker >/dev/null 2>&1 || die 'docker is required'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose is required'
}

compose() {
  (
    cd -- "$PROJECT_DIR"
    # Compose reads this exact deployment file; shell overrides for the
    # installation parameters cannot silently replace it.
    env -u KIKOERU_UPSTREAM_IMAGE \
      -u KIKOERU_STRM_IMAGE \
      -u KIKOERU_STRM_PORT \
      -u KIKOERU_STRM_MEDIA_DIR \
      -u STRM_ALLOWED_HOSTS \
      docker compose --env-file "$ENV_PATH" "$@"
  )
}

env_value() {
  local key=$1 value
  value="$(awk -v key="$key" '
    index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }
  ' "$ENV_PATH")"
  [[ -n "$value" ]] || die "$key is missing from $ENV_PATH"
  # install.sh writes only simple single-quoted values. Remove those quotes
  # without evaluating the file as shell code.
  if [[ "$value" == "'"*"'" ]]; then
    value=${value#\'}
    value=${value%\'}
  fi
  printf '%s' "$value"
}

set_env_image() {
  local image=$1
  TEMP_ENV="$(mktemp "$PROJECT_DIR/.env.install.XXXXXX")"
  awk -v image="$image" '
    BEGIN { replaced = 0 }
    index($0, "KIKOERU_STRM_IMAGE=") == 1 {
      print "KIKOERU_STRM_IMAGE=" image
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print "KIKOERU_STRM_IMAGE=" image
    }
  ' "$ENV_PATH" >"$TEMP_ENV"
  chmod 600 "$TEMP_ENV"
  mv -f -- "$TEMP_ENV" "$ENV_PATH"
  TEMP_ENV=''
}

image_exists() {
  local image=$1
  docker image inspect "$image" >/dev/null 2>&1 || die "local image does not exist: $image"
}

require_image_option() {
  [[ -n "${IMAGE:-}" ]] || die 'this command requires --image IMAGE'
  validate_image "$IMAGE"
}

COMMAND=${1:-}
if [[ -z "$COMMAND" ]]; then
  usage >&2
  exit 2
fi
shift || true

IMAGE=''
PURGE_DATA=0
POSITIONAL_IMAGE=''
while (($#)); do
  case "$1" in
    --image)
      [[ $# -ge 2 && -n ${2:-} ]] || die '--image requires a value'
      IMAGE=$2
      shift 2
      ;;
    --purge-data)
      PURGE_DATA=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      [[ $# -eq 1 ]] || die 'only one positional image is allowed'
      POSITIONAL_IMAGE=$1
      shift
      ;;
    -* )
      die "unknown option: $1 (use --help for usage)"
      ;;
    *)
      [[ -z "$POSITIONAL_IMAGE" ]] || die 'only one positional image is allowed'
      POSITIONAL_IMAGE=$1
      shift
      ;;
  esac
done

if [[ -n "$POSITIONAL_IMAGE" ]]; then
  [[ -z "$IMAGE" ]] || die 'specify the rollback image only once'
  IMAGE=$POSITIONAL_IMAGE
fi

if [[ "$COMMAND" == uninstall && "$PURGE_DATA" -eq 1 ]]; then
  die '--purge-data is intentionally refused; bind data and media are never deleted'
fi

require_project

case "$COMMAND" in
  status)
    [[ "$PURGE_DATA" -eq 0 && -z "$IMAGE" ]] || die 'status does not accept image or --purge-data'
    compose ps "$SERVICE"
    docker inspect "$CONTAINER" --format 'container={{.Name}} image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart={{.RestartCount}}' 2>/dev/null || true
    ;;

  start)
    [[ "$PURGE_DATA" -eq 0 && -z "$IMAGE" ]] || die 'start does not accept image or --purge-data'
    compose up -d --no-build "$SERVICE"
    ;;

  stop)
    [[ "$PURGE_DATA" -eq 0 && -z "$IMAGE" ]] || die 'stop does not accept image or --purge-data'
    compose stop "$SERVICE"
    ;;

  upgrade)
    [[ "$PURGE_DATA" -eq 0 ]] || die '--purge-data is only meaningful for uninstall and is refused'
    if [[ -n "$IMAGE" ]]; then
      validate_image "$IMAGE"
      image_exists "$IMAGE"
      set_env_image "$IMAGE"
    else
      IMAGE="$(env_value KIKOERU_STRM_IMAGE)"
      validate_image "$IMAGE"
      [[ -f "$PROJECT_DIR/scripts/build-overlay.sh" ]] || die 'scripts/build-overlay.sh is missing from project directory'
      (
        cd -- "$PROJECT_DIR"
        KIKOERU_UPSTREAM_IMAGE="$UPSTREAM_IMAGE" \
          KIKOERU_STRM_IMAGE="$IMAGE" \
          bash scripts/build-overlay.sh
      )
    fi
    compose up -d --no-build --force-recreate "$SERVICE"
    ;;

  rollback)
    [[ "$PURGE_DATA" -eq 0 ]] || die '--purge-data is not valid for rollback'
    require_image_option
    image_exists "$IMAGE"
    set_env_image "$IMAGE"
    compose up -d --no-build --force-recreate "$SERVICE"
    ;;

  uninstall)
    [[ -z "$IMAGE" ]] || die 'uninstall does not accept --image'
    # down is deliberately used without -v or --remove-orphans. The compose
    # project contains only this independent service and all bind data is
    # retained for a later start/rollback.
    compose down
    ;;

  *)
    die "unknown command: $COMMAND (use --help for usage)"
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

IMAGE="${KIKOERU_UPSTREAM_IMAGE:-number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391}"
EXPECTED_DIGEST="sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391"
TARGET_IMAGE="${KIKOERU_STRM_IMAGE:-kikoeru-strm:0.2.0}"

docker pull "$IMAGE" >/dev/null
actual_digest="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
if [ "$actual_digest" != "$EXPECTED_DIGEST" ]; then
  echo "upstream digest mismatch: $actual_digest (expected $EXPECTED_DIGEST)" >&2
  exit 1
fi

if [ -n "${KIKOERU_UPSTREAM_ROOT:-}" ]; then
  node scripts/verify-upstream.js --version 0.6.17 "$KIKOERU_UPSTREAM_ROOT"
fi
docker build --pull=false --build-arg UPSTREAM_IMAGE="$IMAGE" -t "$TARGET_IMAGE" .
display_image="$IMAGE"
if [[ "$IMAGE" != *@* ]]; then
  display_image="$IMAGE@$actual_digest"
fi
echo "built $TARGET_IMAGE from $display_image"

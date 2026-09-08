#!/usr/bin/env bash
set -euo pipefail

IMAGE="${KIKOERU_UPSTREAM_IMAGE:-number17/kikoeru@sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6}"
EXPECTED_DIGEST="sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6"
TARGET_IMAGE="${KIKOERU_STRM_IMAGE:-kikoeru-strm:0.1.4}"

docker pull "$IMAGE" >/dev/null
actual_digest="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
if [ "$actual_digest" != "$EXPECTED_DIGEST" ]; then
  echo "upstream digest mismatch: $actual_digest (expected $EXPECTED_DIGEST)" >&2
  exit 1
fi

if [ -n "${KIKOERU_UPSTREAM_ROOT:-}" ]; then
  node scripts/verify-upstream.js "$KIKOERU_UPSTREAM_ROOT"
fi
docker build --pull=false --build-arg UPSTREAM_IMAGE="$IMAGE" -t "$TARGET_IMAGE" .
display_image="$IMAGE"
if [[ "$IMAGE" != *@* ]]; then
  display_image="$IMAGE@$actual_digest"
fi
echo "built $TARGET_IMAGE from $display_image"

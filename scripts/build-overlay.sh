#!/usr/bin/env bash
set -euo pipefail

IMAGE="${KIKOERU_UPSTREAM_IMAGE:-number17/kikoeru:latest}"
EXPECTED_DIGEST="sha256:e934185b734b35e15fcdf62d96e65445edb1979ba0ed25d23d08679abda65c1c"
TARGET_IMAGE="${KIKOERU_STRM_IMAGE:-kikoeru-strm:0.1.0}"

docker pull "$IMAGE" >/dev/null
actual_digest="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
if [ "$actual_digest" != "$EXPECTED_DIGEST" ]; then
  echo "upstream digest mismatch: $actual_digest (expected $EXPECTED_DIGEST)" >&2
  exit 1
fi

if [ -d tmp/kikoeru-container ]; then
  node scripts/verify-upstream.js tmp/kikoeru-container
fi
docker build --pull=false --build-arg UPSTREAM_IMAGE="$IMAGE" -t "$TARGET_IMAGE" .
echo "built $TARGET_IMAGE from $IMAGE@$EXPECTED_DIGEST"

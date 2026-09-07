# 0.6.15 overlay

This directory is the complete adapter payload for the verified
`number17/kikoeru:latest` / `0.6.15` image.  `bootstrap.js` decorates only the
compiled `filesystem/utils.js` and `routes/index.js` module boundaries and
installs a small same-origin admin page hook; the upstream files are not copied
from `tmp/` or edited in place. The entrypoint also propagates this bootstrap
through `NODE_OPTIONS` so forked scanner workers use the same overlay.

The build fails before copying the payload if the application version or any
protected baseline SHA-256 fingerprint changes.  To update upstream,
extract the new image, record the new version/fingerprints, add a new
versioned directory, review the route and scanner contracts, then change the
Dockerfile/verification manifest together.  Rollback is selecting the prior
image tag and removing only this independent compose project; the production
`kikoeru` container and its files are outside the project.

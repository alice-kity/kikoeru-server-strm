# 0.6.15 overlay

This directory is the complete adapter payload for the re-reviewed hot-update
`number17/kikoeru@sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6` /
`0.6.15` image.  `bootstrap.js` decorates only the
compiled `filesystem/utils.js` and `routes/index.js` module boundaries and
installs a small same-origin admin page hook; the upstream files are not copied
from `tmp/` or edited in place. The entrypoint also propagates this bootstrap
through `NODE_OPTIONS` so forked scanner workers use the same overlay.

The re-review found two upstream compiled changes: `filesystem/audioProcessor.js`
adds `calculateLUFSSplitWithOption`, and `routes/media.js` calls it with the
`ebur128` option. STRM loudness remains owned by this adapter's `cache-manager`,
and ordinary local media still proceeds through upstream `next()`, so no adapter
JavaScript change is required. This remains a `patches/0.6.15/` payload for a
same-version hot update; the review does not claim real-client or production
validation.

The build fails before copying the payload if the application version or any
protected baseline SHA-256 fingerprint changes.  To update upstream,
extract the new image, record the new version/fingerprints, and review the
route and scanner contracts. Add a new versioned directory when the application
version changes; for a same-version hot update, re-review this directory before
changing the Dockerfile and verification manifest together. Rollback is
selecting the prior image tag and removing only this independent compose project;
the production `kikoeru` container and its files are outside the project.

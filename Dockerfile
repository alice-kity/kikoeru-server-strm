ARG UPSTREAM_IMAGE=number17/kikoeru@sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6
FROM ${UPSTREAM_IMAGE}

WORKDIR /usr/src/kikoeru
COPY scripts/verify-upstream.js /tmp/kikoeru-strm-verify-upstream.js
RUN node /tmp/kikoeru-strm-verify-upstream.js /usr/src/kikoeru

# Versioned overlay only.  No file under tmp/ is copied into the image.
COPY patches/0.6.15/strm-adapter /usr/src/kikoeru/strm-adapter
COPY scripts/strm-entrypoint.js /usr/src/kikoeru/strm-entrypoint.js
COPY scripts/strm-child-env.js /usr/src/kikoeru/strm-child-env.js
RUN node --check /usr/src/kikoeru/strm-entrypoint.js \
 && node --check /usr/src/kikoeru/strm-child-env.js \
 && for file in /usr/src/kikoeru/strm-adapter/*.js; do node --check "$file"; done \
 && rm -f /tmp/kikoeru-strm-verify-upstream.js

EXPOSE 8888
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/usr/src/kikoeru/strm-entrypoint.js"]

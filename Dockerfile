ARG UPSTREAM_IMAGE=number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391
FROM ${UPSTREAM_IMAGE}

WORKDIR /usr/src/kikoeru
COPY scripts/verify-upstream.js /tmp/kikoeru-strm-verify-upstream.js
COPY patches/0.6.15/upstream-fingerprints.json /tmp/kikoeru-strm-fingerprints/0.6.15/upstream-fingerprints.json
COPY patches/0.6.17/upstream-fingerprints.json /tmp/kikoeru-strm-fingerprints/0.6.17/upstream-fingerprints.json
RUN node /tmp/kikoeru-strm-verify-upstream.js --version 0.6.17 \
      --manifest-dir /tmp/kikoeru-strm-fingerprints /usr/src/kikoeru

# Versioned overlay only.  No file under tmp/ is copied into the image.
COPY patches/0.6.17/strm-adapter /usr/src/kikoeru/strm-adapter
COPY scripts/strm-entrypoint.js /usr/src/kikoeru/strm-entrypoint.js
COPY scripts/strm-child-env.js /usr/src/kikoeru/strm-child-env.js
RUN node --check /usr/src/kikoeru/strm-entrypoint.js \
 && node --check /usr/src/kikoeru/strm-child-env.js \
 && for file in /usr/src/kikoeru/strm-adapter/*.js; do node --check "$file"; done \
 && rm -f /tmp/kikoeru-strm-verify-upstream.js \
 && rm -rf /tmp/kikoeru-strm-fingerprints

EXPOSE 8888
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/usr/src/kikoeru/strm-entrypoint.js"]

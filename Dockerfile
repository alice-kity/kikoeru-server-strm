ARG UPSTREAM_IMAGE=number17/kikoeru:latest
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

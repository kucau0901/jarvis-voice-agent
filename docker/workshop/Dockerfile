# Jarvis's workshop: where a background job may run code and make files.
#
# It has no network (docker-compose.yml), so all it will ever have is put in
# here, and from Debian's own signed packages only. No compiler, no package
# manager for a language, nothing that runs as somebody else. Debian's
# matplotlib asks, by way of scipy, for a whole C++ compiler that nothing here
# runs with: it is taken out again, with everything there only to build by.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pandas python3-openpyxl python3-docx python3-reportlab python3-pypdf \
      python3-matplotlib python3-pil python3-markdown python3-jinja2 python3-bs4 python3-lxml python3-yaml \
      weasyprint pandoc poppler-utils qpdf hugo \
      jq ripgrep zip unzip sqlite3 file fonts-dejavu-core fonts-noto-core tini \
 && dpkg-query -W -f '${binary:Package}\n' | grep -E -- '-dev(:|$)|^(gcc|g\+\+|cpp|binutils|python3-pythran)' | grep -v -- '-base' | xargs dpkg --purge --force-depends \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* /opt/yarn* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && mkdir -p /work /run/workshop
COPY runner.mjs files.mjs door.mjs /opt/workshop/
# The first process reads the end of every one left without a parent: otherwise they count against a job's own for ever.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/workshop/runner.mjs"]

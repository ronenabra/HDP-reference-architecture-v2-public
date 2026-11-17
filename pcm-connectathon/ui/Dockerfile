FROM mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
# Pin the JavaScript runtime independently of the browser distribution's older Node.
RUN curl --fail --location https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz --output /tmp/node.tar.gz \
    && echo 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c  /tmp/node.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/node.tar.gz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.gz
WORKDIR /suite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false
COPY playwright.config.js ./
COPY tests ./tests
COPY workflow-tests ./workflow-tests
COPY hmo-tests ./hmo-tests
COPY smart-tests ./smart-tests
USER pwuser
ENTRYPOINT ["npx", "--no-install", "playwright", "test"]

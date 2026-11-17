FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

RUN apk add --no-cache openssl=3.5.9-r0

COPY src/pcm-core/package.json src/pcm-core/package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false

COPY src/pcm-core ./
# Runtime and packaged operator scripts resolve their shared code at /shared.
COPY src/shared /shared
COPY pcm-connectathon/team-config.schema.json /workspace/pcm-connectathon/team-config.schema.json
COPY docs /workspace/docs
COPY pcm-connectathon /workspace/pcm-connectathon

EXPOSE 3000 3001

CMD ["npm", "start"]

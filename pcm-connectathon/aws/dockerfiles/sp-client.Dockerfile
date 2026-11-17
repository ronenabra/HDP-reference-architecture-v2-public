FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

COPY src/sp-client/package.json src/sp-client/package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false

COPY src/sp-client ./
COPY src/shared /shared
COPY pcm-connectathon/team-config.schema.json /workspace/pcm-connectathon/team-config.schema.json

EXPOSE 3000

CMD ["npm", "start"]

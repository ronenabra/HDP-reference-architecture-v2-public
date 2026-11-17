FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false

COPY . .
# Local Compose may run with the host UID; copied source is image data, not a secret.
RUN chmod -R a+rX /app

EXPOSE 3000

CMD ["npm", "start"]

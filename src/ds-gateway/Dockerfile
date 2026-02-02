FROM nginx:latest

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Config will be mounted via docker-compose
# COPY nginx.conf /etc/nginx/nginx.conf 
# (We are using volume mount in dev, but for completeness could copy)

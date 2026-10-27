FROM node:24.14.0-alpine AS build
WORKDIR /app
COPY frontend/package*.json /app/frontend/
RUN cd frontend && npm ci
COPY frontend /app/frontend
COPY demo /app/demo
COPY data/avatar-presets.json /app/data/avatar-presets.json
RUN cd frontend && npm run build
FROM nginx:1.28-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY demo /usr/share/nginx/html/demo
EXPOSE 80

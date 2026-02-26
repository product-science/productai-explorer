# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for build)
# Copying only package files first to leverage cache
COPY package.json yarn.lock ./
# --frozen-lockfile ensures reproducible builds
RUN yarn install --frozen-lockfile --ignore-engines

# Copy source and build
COPY . .
RUN yarn build

# Stage 2: Runtime
FROM nginx:alpine

# Nginx setup
# The default nginx image will auto-substitute env vars in templates found in /etc/nginx/templates/
# We disable this by overwriting the entrypoint or just not relying on it for complex cases
# COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy template to a different location so default script doesn't pick it up (double substitution risk)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copy build artifacts from builder to the default nginx public folder
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 5173
EXPOSE 5173

# Start Nginx
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

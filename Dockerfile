FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies with frozen lockfile
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code and configuration
COPY . .

EXPOSE 3000

CMD ["bun", "run", "src/cli/index.ts", "serve", "--port", "3000"]

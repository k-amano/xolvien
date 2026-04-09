FROM python:3.11-slim

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    WORKSPACE_DIR=/workspace

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (LTS, required by Claude Code CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for Claude Code agent mode (--dangerously-skip-permissions requires non-root)
RUN useradd -m -s /bin/bash karakuri

# Create workspace directory and grant ownership to karakuri
RUN mkdir -p ${WORKSPACE_DIR} && chown karakuri:karakuri ${WORKSPACE_DIR}
WORKDIR ${WORKSPACE_DIR}

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command (keep container running)
CMD ["tail", "-f", "/dev/null"]

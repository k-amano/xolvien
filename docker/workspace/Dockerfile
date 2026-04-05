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

# Install Node.js (required for some Claude Code features)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
# Note: In production, install via npm or download from official source
RUN npm install -g @anthropic-ai/claude-code || \
    echo "Claude Code CLI installation placeholder - install manually if needed"

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

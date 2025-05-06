# Use a specific Python version, similar to the LiveKit example
ARG PYTHON_VERSION=3.11.6
FROM python:${PYTHON_VERSION}-slim

# Set environment variables for Python
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Create a non-privileged user 'appuser'
ARG UID=10001
RUN useradd --system --create-home --uid ${UID} --gid 0 appuser

# Install system build dependencies as root
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
  gcc \
  g++ \
  python3-dev && \
  rm -rf /var/lib/apt/lists/*

# Switch to the non-privileged user
USER appuser
WORKDIR /home/appuser/app

# Copy requirements.txt and install Python dependencies as 'appuser'
# The --user flag installs packages into the user's home directory
COPY --chown=appuser:0 requirements.txt .
RUN python -m pip install --user --no-cache-dir --upgrade -r requirements.txt

# Add the user's local bin directory to PATH (where pip --user installs scripts)
ENV PATH="/home/appuser/.local/bin:${PATH}"

# Copy the rest of the application code as 'appuser'
COPY --chown=appuser:0 . .

# ensure that any dependent models are downloaded at build-time
RUN python src/download.py download-files

# Expose port if the application is expected to listen on it
# Note: The current agent doesn't inherently listen on a port.
EXPOSE 8081

# Command to run the application
# The WORKDIR is /home/appuser/app, so src.main should be found.
CMD ["python", "-m", "src.main", "start"]

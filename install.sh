#!/bin/sh
# Blauwerk single-command installer (requires no npm/node/bun)
set -e

# Target directory: use /usr/local/bin if root, otherwise ~/.local/bin
INSTALL_DIR="/usr/local/bin"
if [ "$(id -u)" -ne 0 ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

# Detect OS and architecture
OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" != "Linux" ]; then
  echo "ERROR: Blauwerk currently only supports Linux."
  exit 1
fi

case "$ARCH" in
  x86_64) BIN_ARCH="x64" ;;
  aarch64|arm64) BIN_ARCH="arm64" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
esac

echo "Downloading latest Blauwerk compiled binary for linux-$BIN_ARCH..."
URL="https://github.com/sayore/blauwerk/releases/latest/download/blauwerk-linux-$BIN_ARCH"

if command -v curl >/dev/null 2>&1; then
  curl -L "$URL" -o "$INSTALL_DIR/blauwerk"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$INSTALL_DIR/blauwerk" "$URL"
else
  echo "ERROR: Neither curl nor wget is installed. Please install one to proceed."
  exit 1
fi

chmod +x "$INSTALL_DIR/blauwerk"

echo "=== Blauwerk Installation Success ==="
echo "Installed to: $INSTALL_DIR/blauwerk"
if [ "$(id -u)" -ne 0 ]; then
  case ":$PATH:" in
    *:"$INSTALL_DIR":*) ;;
    *)
      echo "WARNING: $INSTALL_DIR is not in your PATH. Add it to your shell config (~/.bashrc or ~/.zshrc):"
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
fi
echo "Run 'blauwerk diagnose' to perform a system check, or run 'blauwerk' for the dashboard."

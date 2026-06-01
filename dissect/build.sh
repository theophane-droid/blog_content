#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-linux}"
WORKDIR="${WORKDIR:-$HOME/build-acquire}"
PYTHON_BIN="${PYTHON_BIN:-python3.12}"

case "$TARGET" in
  linux)
    BIN_NAME="acquire"
    ;;
  windows|win)
    BIN_NAME="acquire.exe"
    ;;
  *)
    echo "Usage: $0 [linux|windows]"
    exit 1
    ;;
esac

CURRENT_OS="$(uname -s)"

if [[ "$TARGET" == "linux" && "$CURRENT_OS" != "Linux" ]]; then
  echo "[!] PyInstaller does not reliably cross-compile."
  echo "[!] To build for Linux, run this script on Linux."
  exit 1
fi

if [[ "$TARGET" =~ ^(windows|win)$ ]] && ! echo "$CURRENT_OS" | grep -Eq "MINGW|MSYS|CYGWIN"; then
  echo "[!] PyInstaller does not reliably cross-compile."
  echo "[!] To build for Windows, run this script on Windows using Git Bash, MSYS2, or Cygwin."
  exit 1
fi

install_python312_with_pyenv() {
  echo "[+] Python 3.12 was not found."

  if ! command -v pyenv >/dev/null 2>&1; then
    echo "[+] pyenv was not found. Installing pyenv..."

    curl https://pyenv.run | bash

    export PYENV_ROOT="$HOME/.pyenv"
    export PATH="$PYENV_ROOT/bin:$PATH"

    if command -v pyenv >/dev/null 2>&1; then
      eval "$(pyenv init -)"
    else
      echo "[!] pyenv installation failed or pyenv is not in PATH."
      echo "[!] Add the following lines to your shell config, reload your shell, then rerun this script:"
      echo 'export PYENV_ROOT="$HOME/.pyenv"'
      echo 'export PATH="$PYENV_ROOT/bin:$PATH"'
      echo 'eval "$(pyenv init -)"'
      exit 1
    fi
  else
    export PYENV_ROOT="${PYENV_ROOT:-$HOME/.pyenv}"
    export PATH="$PYENV_ROOT/bin:$PATH"
    eval "$(pyenv init -)"
  fi

  if ! pyenv versions --bare | grep -q "^3.12."; then
    echo "[+] Installing Python 3.12.11 with pyenv..."
    pyenv install 3.12.11
  fi

  pyenv local 3.12.11
  PYTHON_BIN="$(pyenv which python)"

  echo "[+] Python 3.12 is ready: $PYTHON_BIN"
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  install_python312_with_pyenv
fi

echo "[+] Target: $TARGET"
echo "[+] Workdir: $WORKDIR"
echo "[+] Python binary: $PYTHON_BIN"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

if [ ! -d acquire ]; then
  echo "[+] Cloning acquire..."
  git clone https://github.com/fox-it/acquire.git
else
  echo "[+] acquire repository already exists."
fi

if [ ! -d dissect.target ]; then
  echo "[+] Cloning dissect.target..."
  git clone https://github.com/fox-it/dissect.target.git
else
  echo "[+] dissect.target repository already exists."
fi

echo "[+] Creating Python 3.12 virtual environment..."
rm -rf venv
"$PYTHON_BIN" -m venv venv

# Linux / macOS / Git Bash / MSYS2 compatibility
if [ -f "venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source venv/Scripts/activate
else
  echo "[!] Could not find the virtual environment activation script."
  exit 1
fi

echo "[+] Python version in venv:"
python --version

echo "[+] Installing build dependencies..."
python -m pip install -U pip wheel setuptools
python -m pip install pyinstaller
python -m pip install -e ./dissect.target
python -m pip install -e ./acquire
python -m pip install dissect

echo "[+] Generating Dissect plugin list..."
target-build-pluginlist > ./dissect.target/dissect/target/plugins/_pluginlist.py

echo "[+] Building acquire with PyInstaller..."
pyinstaller ./acquire/acquire/acquire.py \
  --name "$BIN_NAME" \
  --paths ./dissect.target \
  --paths ./acquire \
  --hidden-import dissect \
  --collect-submodules dissect \
  --collect-data dissect \
  --onefile \
  --clean

echo "[+] Testing binary..."

if [[ "$TARGET" == "linux" ]]; then
  ./dist/acquire --help
else
  ./dist/acquire.exe --help
fi

echo "[+] Build completed successfully."
echo "[+] Binary available at: $WORKDIR/dist/$BIN_NAME"

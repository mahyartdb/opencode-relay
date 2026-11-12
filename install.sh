#!/usr/bin/env bash
set -euo pipefail

# Installer for opencode-relay: clones the repository, builds it, and adds it
# to the OpenCode config.

REPO="${OPENCODE_RELAY_REPO:-https://github.com/mahyartdb/opencode-relay.git}"
INSTALL_DIR="${OPENCODE_RELAY_HOME:-$HOME/.local/share/opencode-relay}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

as_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) printf '1' ;;
    *) printf '0' ;;
  esac
}

NO_CONFIG="$(as_bool "${OPENCODE_RELAY_NO_CONFIG:-0}")"
UPDATE="$(as_bool "${OPENCODE_RELAY_UPDATE:-0}")"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --no-config     install and build only; do not touch opencode.json
  --update        rebuild the existing checkout instead of cloning again
  -h, --help      show this help and exit

Environment:
  OPENCODE_RELAY_REPO       git repository to clone
                            (default: https://github.com/mahyartdb/opencode-relay.git)
  OPENCODE_RELAY_HOME       where the plugin is installed
                            (default: $HOME/.local/share/opencode-relay)
  OPENCODE_CONFIG_DIR       OpenCode config directory
                            (default: $HOME/.config/opencode)
  OPENCODE_RELAY_NO_CONFIG  set to 1 to skip writing the config
  OPENCODE_RELAY_UPDATE     set to 1 to update an existing installation
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-config)
      NO_CONFIG=1
      ;;
    --update)
      UPDATE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'install.sh: %s is required but was not found on PATH.\n' "$1" >&2
    exit 1
  fi
}

require bun
printf 'Found bun %s\n' "$(bun --version)"

if [ "$UPDATE" = "1" ]; then
  require git
  if [ ! -e "$INSTALL_DIR/.git" ]; then
    printf 'install.sh: --update needs an existing clone at %s\n' "$INSTALL_DIR" >&2
    printf 'Run this installer without --update to clone it first.\n' >&2
    exit 1
  fi
  printf 'Updating %s ...\n' "$INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR/.git" ]; then
  printf 'Found an existing clone at %s; rebuilding it.\n' "$INSTALL_DIR"
elif [ -e "$INSTALL_DIR" ]; then
  printf 'install.sh: %s exists but is not a git clone.\n' "$INSTALL_DIR" >&2
  printf 'Remove it or set OPENCODE_RELAY_HOME to another directory.\n' >&2
  exit 1
else
  require git
  mkdir -p "$(dirname "$INSTALL_DIR")"
  printf 'Cloning %s into %s ...\n' "$REPO" "$INSTALL_DIR"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

printf 'Installing dependencies ...\n'
(cd "$INSTALL_DIR" && bun install --frozen-lockfile)
printf 'Building ...\n'
(cd "$INSTALL_DIR" && bun run build)

PLUGIN="file://$INSTALL_DIR"

print_manual_snippet() {
  cat <<EOF
Add this entry to $CONFIG_FILE:

{
  "plugin": ["$PLUGIN"]
}
EOF
}

if [ "$NO_CONFIG" = "1" ]; then
  echo "Skipping the OpenCode config (--no-config)."
  print_manual_snippet
  echo
  echo 'Done. Restart OpenCode to load the plugin.'
  exit 0
fi

if [ ! -e "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  printf '{"plugin": ["%s"]}\n' "$PLUGIN" >"$CONFIG_FILE"
  printf 'Created %s.\n' "$CONFIG_FILE"
else
  printf 'Updating %s ...\n' "$CONFIG_FILE"
  set +e
  CONFIG_FILE="$CONFIG_FILE" PLUGIN="$PLUGIN" bun -e '
const fs = require("node:fs");
const configPath = process.env.CONFIG_FILE;
const plugin = process.env.PLUGIN;

let raw;
try {
  raw = fs.readFileSync(configPath, "utf8");
} catch (error) {
  console.error("install.sh: cannot read " + configPath + ": " + error.message);
  process.exit(6);
}

let config;
try {
  config = JSON.parse(raw);
} catch (error) {
  console.error("install.sh: cannot parse " + configPath + " as JSON: " + error.message);
  process.exit(3);
}

if (config === null || typeof config !== "object" || Array.isArray(config)) {
  console.error("install.sh: " + configPath + " is not a JSON object.");
  process.exit(4);
}

const current = config.plugin === undefined ? [] : config.plugin;
if (!Array.isArray(current)) {
  console.error("install.sh: the \"plugin\" entry in " + configPath + " is not a list.");
  process.exit(5);
}

if (!current.includes(plugin)) current.push(plugin);
config.plugin = current;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = configPath + ".bak-" + stamp;
fs.copyFileSync(configPath, backup);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log("Backed up the previous config to " + backup);
'
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    printf 'install.sh: %s was not modified.\n' "$CONFIG_FILE" >&2
    print_manual_snippet >&2
    exit "$status"
  fi
  printf 'Added the plugin to %s.\n' "$CONFIG_FILE"
fi

echo
echo 'Done. Restart OpenCode to load the plugin.'

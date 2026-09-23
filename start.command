#!/bin/bash
# Tiny Space Program — macOS launcher. Double-click me in Finder.
# Starts the local web server (node tools/serve.mjs) on port 8765 (or a free one) and opens your browser.
# No Node.js? It opens the self-contained dist/tiny-space-program.html instead (if it has been built).

cd "$(dirname "$0")" || exit 1

bold=$'\e[1m'; dim=$'\e[2m'; orange=$'\e[38;5;208m'; blue=$'\e[38;5;75m'; red=$'\e[31m'; reset=$'\e[0m'
echo
echo "   ${bold}🚀  Tiny ${orange}Space${reset}${bold} Program${reset}"
echo "   ${dim}Build rockets. Reach orbit. Try not to explode.${reset}"
echo

# ── find node (Finder-launched shells often lack your usual PATH) ──
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local c
  for c in \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME"/.local/share/mise/installs/node/*/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node \
    "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.nodenv/shims/node" \
    "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME"/Library/Application\ Support/fnm/aliases/default/bin/node; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  # last resort: ask a login shell (picks up ~/.zprofile / ~/.bash_profile setups)
  c=$(/bin/zsh -lc 'command -v node' 2>/dev/null) && [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  return 1
}

open_single_file() {
  if [ -f dist/tiny-space-program.html ]; then
    echo "   Opening the single-file build instead: ${blue}dist/tiny-space-program.html${reset}"
    open dist/tiny-space-program.html
  else
    echo "   ${red}dist/tiny-space-program.html has not been built yet either.${reset}"
  fi
}

NODE=$(find_node)
if [ -z "$NODE" ]; then
  echo "   ${red}Node.js was not found.${reset} Install it from https://nodejs.org (v18 or newer),"
  echo "   or play without a server by double-clicking dist/tiny-space-program.html."
  echo
  open_single_file
  echo; read -r -p "   Press Return to close this window. " _
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"

# ── what to serve: the live sources (needs node_modules/three), or the prebuilt static site ──
SERVE_ROOT=""
if [ ! -f node_modules/three/build/three.module.js ]; then
  if command -v npm >/dev/null 2>&1 && [ -f package.json ]; then
    echo "   First run: installing dependencies (npm install)…"
    npm install --no-audit --no-fund >/dev/null 2>&1 || true
  fi
  if [ ! -f node_modules/three/build/three.module.js ]; then
    if [ -f dist/web/index.html ]; then
      SERVE_ROOT="dist/web"
      echo "   ${dim}node_modules missing — serving the prebuilt dist/web/ instead.${reset}"
    else
      echo "   ${red}Dependencies are missing and npm install failed.${reset}"
      open_single_file
      echo; read -r -p "   Press Return to close this window. " _
      exit 1
    fi
  fi
fi

# ── pick a port: 8765 if free, otherwise any free one ──
port_free() { ! (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
PORT=8765
if ! port_free "$PORT"; then
  PORT=$("$NODE" -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
fi

# ── start the server ──
if [ -n "$SERVE_ROOT" ]; then
  "$NODE" --input-type=module -e "
    const { createServer } = await import('./tools/serve.mjs');
    createServer(process.cwd() + '/$SERVE_ROOT').listen($PORT, () => console.log('Tiny Space Program → http://localhost:$PORT/'));
  " &
else
  "$NODE" tools/serve.mjs "$PORT" &
fi
SERVER_PID=$!
trap 'echo; echo "   Stopping the server. Fly safe! 👋"; kill $SERVER_PID 2>/dev/null; exit 0' INT TERM HUP
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# wait until it answers (max ~5 s)
for _ in $(seq 1 50); do
  (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1 && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "   ${red}The server failed to start.${reset}"; open_single_file
    echo; read -r -p "   Press Return to close this window. " _; exit 1
  fi
  sleep 0.1
done

URL="http://localhost:$PORT/"
echo "   ${bold}Mission control is live:${reset} ${blue}$URL${reset}"
echo
echo "   ${dim}Handy links:${reset}"
echo "     ${URL}?scene=vab                      jump straight into the VAB"
echo "     ${URL}?scene=flight&craft=orbiter_1   launch Orbiter I right away"
echo "     ${URL}?debug=1                        FPS meter + error overlay"
echo
echo "   Keep this window open while you play. Press ${bold}Ctrl+C${reset} (or close it) to stop."
echo

open "$URL"
wait "$SERVER_PID"

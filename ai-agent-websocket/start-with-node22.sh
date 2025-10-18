#!/bin/bash

# Carica nvm e usa Node v22
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm use 22

# Avvia in background senza stdin
nohup pnpm start < /dev/null &

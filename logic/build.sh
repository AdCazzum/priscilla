#!/bin/bash
set -e

cd "$(dirname $0)"

TARGET="${CARGO_TARGET_DIR:-target}"

rustup run 1.88.0 rustup target add wasm32-unknown-unknown
rustup run 1.88.0 cargo build --target wasm32-unknown-unknown --profile app-release

mkdir -p res

cp $TARGET/wasm32-unknown-unknown/app-release/kv_store.wasm ./res/

if command -v wasm-opt > /dev/null; then
  wasm-opt -Oz ./res/kv_store.wasm -o ./res/kv_store.wasm
fi

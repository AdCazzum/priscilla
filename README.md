# WebLLM Chat on Calimero

Run a fully local AI chat in your browser, backed by a Calimero contract that keeps the shared conversation history in sync across participants.  
The Rust logic stores messages, while the Vite/React frontend streams replies from [web-llm](https://github.com/mlc-ai/web-llm) directly in the client – no external inference service required.

This repository still contains two independent parts:

- `logic/` — Rust smart-contract (compiled to WASM)
- `app/` — React frontend (Vite) that talks to the contract via generated ABI client

The folders are separate projects; treat each as its own repo.

## Prerequisites

- pnpm (or npm) for JavaScript tooling
- Rust toolchain + wasm target: `rustup target add wasm32-unknown-unknown`
- Optional: `wasm-opt` for size optimization

## Logic (Rust)

```bash
pnpm run logic:build
```

Optional cleanup:

```bash
pnpm run logic:clean
```

### Contract capabilities

- `send_message(sender: String, role: String, content: String)` — appends a message to the shared history and returns the stored entry.
- `messages(offset: Option<u32>, limit: Option<u32>)` — paginated view endpoint that streams the current history.
- `clear_history()` — wipes all stored messages.
- `set_max_messages(max_messages: u32)` — caps retained history (default 200, maximum 1000).
- `info()` — lightweight metadata (total stored messages + current cap).

Events emitted: `MessageAdded`, `HistoryCleared`, `MaxMessagesUpdated`

### Build artifacts

- Built WASM outputs to `logic/res/kv_store.wasm` (minified if `wasm-opt` is available)
- ABI JSON is expected at `logic/res/abi.json`

## App (React)

```bash
cd app && pnpm install
```

Build and run:

```bash
pnpm --dir app build
pnpm --dir app dev
```

Open the app in your browser and connect to a running node.

- The chat UI streams responses using `@mlc-ai/web-llm`’s **Phi-3-mini-4k-instruct-q4f16_1-MLC** model.  
  The first request will trigger a client-side download (hundreds of MB); subsequent chats are served from the browser cache.
- Per la sezione eventi SSE puoi impostare `VITE_MCP_BASE_URL` (es. `http://localhost:3000`) per puntare al Control Plane. Se non presente, il client tenta di usare direttamente il nodo Calimero selezionato.

Docs: https://calimero-network.github.io/build/quickstart

## Watchers and Dev Workflow

The root `app:dev` script runs the web app alongside a unified watcher for `logic/res/`.

```bash
pnpm run app:dev
```

What happens:

- `logic:watch`: watches `logic/res/**/*`
  - On `abi.json` change → runs codegen: `app:generate-client`
  - On `*.wasm` change → copies the changed file to data nodes via `logic:sync`

Key scripts (root `package.json`):

- `logic:watch`: `chokidar "logic/res/**/*" -c "node scripts/on-res-change.mjs {path}"`
- `logic:sync`: `bash ./scripts/sync-wasm.sh <path>` — copies to `data/calimero-node-1/` and `data/calimero-node-2/`
- `app:generate-client`: `npx @calimero-network/abi-codegen@0.1.1 -i logic/res/abi.json -o app/src/api`
- `app:dev`: `concurrently` runs the Vite dev server and `logic:watch`

Notes:

- The watcher only triggers when `logic/res/` changes. Make sure your build writes there.
- `sync-wasm.sh` copies by filename (basename) so any wasm produced in `res/` is propagated.

## ABI Codegen

Client types and a thin client are generated into `app/src/api` from `logic/res/abi.json`.

- Ad-hoc run:

```bash
pnpm run app:generate-client
```

- This is also run automatically by the watcher on `abi.json` changes.

## Merobox (Local Network)

You can bootstrap a local network with Merobox:

```bash
pnpm run network:bootstrap
```

This runs the workflow defined in `workflows/workflow-example.yml` and starts local Calimero nodes whose data dirs live under `data/`.

## Typical Dev Loop

1) Start dev (web + watchers):

```bash
pnpm run app:dev
```

2) Edit Rust contract under `logic/src` and build:

```bash
pnpm run logic:build
```

When the wasm in `logic/res/` updates, the watcher copies it to `data/calimero-node-1/` and `data/calimero-node-2/` automatically.

3) If you change public methods or events, update ABI and regenerate client:

```bash
# If you produce a new ABI at logic/res/abi.json
pnpm run app:generate-client
```

The watcher also regenerates automatically on `abi.json` changes.

## Troubleshooting

- If `concurrently` or `chokidar` are missing, install dev deps at repo root:

```bash
pnpm add -D concurrently chokidar-cli
```

- If ABI codegen fails due to missing schema, ensure you’re on `@calimero-network/abi-codegen@0.1.1` (the script pins this version).

## Contract Call Examples

```json
{
  "method": "send_message",
  "argsJson": {
    "sender": "alice",
    "role": "user",
    "content": "Hello WebLLM!"
  }
}
```

```json
{
  "method": "messages",
  "argsJson": {
    "offset": 0,
    "limit": 50
  }
}
```

```json
{
  "method": "clear_history",
  "argsJson": { }
}
```

```json
{
  "method": "info",
  "argsJson": {}
}
```

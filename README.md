# DeepSeek Local API Bridge

Minimal browser extension plus local Node server for using the DeepSeek web UI through an OpenAI-like local API.

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.
5. Open `https://chat.deepseek.com` and log in.

## Run local API

```sh
node server.js
```

Or with Docker:

```sh
docker compose up --build
```

Health check:

```sh
curl http://127.0.0.1:8787/health
```

The `bridgeOnline` field becomes `true` when the DeepSeek tab is open and the extension is polling the server.

Playground:

```text
http://127.0.0.1:8787/playground
```

## Test

```sh
node --test
```

## Use as API

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web",
    "messages": [
      {"role": "user", "content": "Ответь только словом OK"}
    ]
  }'
```

## Test from console

Open DevTools on the DeepSeek page and run:

```js
await deepseekBridge.ask("Ответь только словом OK")
```

Status events are logged automatically. Current bridge state:

```js
deepseekBridge.state()
```

Diagnostics:

```js
await deepseekBridge.debug()
```

Successful response shape:

```js
{
  type: "DEEPSEEK_BRIDGE_RESPONSE",
  requestId: "...",
  answer: "..."
}
```

Error response shape:

```js
{
  type: "DEEPSEEK_BRIDGE_ERROR",
  requestId: "...",
  error: "..."
}
```

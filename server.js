const http = require("http");
const crypto = require("crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 25000);

const jobs = [];
const pendingPolls = [];
const waitingResults = new Map();
let lastBridgeSeenAt = 0;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, null);
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        bridgeOnline: Date.now() - lastBridgeSeenAt < 35000,
        queued: jobs.length,
        pending: waitingResults.size
      });
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/playground")) {
      return sendHtml(res, 200, renderPlaygroundHtml());
    }

    if (req.method === "GET" && req.url === "/bridge/next") {
      lastBridgeSeenAt = Date.now();
      return handleBridgeNext(res);
    }

    if (req.method === "POST" && req.url === "/bridge/result") {
      const body = await readJson(req);
      return handleBridgeResult(res, body);
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readJson(req);
      return handleChatCompletions(res, body);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DeepSeek local API listening on http://${HOST}:${PORT}`);
});

function handleBridgeNext(res) {
  const job = jobs.shift();
  if (job) {
    return sendJson(res, 200, job);
  }

  const timeout = setTimeout(() => {
    removePoll(res);
    sendJson(res, 204, null);
  }, POLL_TIMEOUT_MS);

  pendingPolls.push({ res, timeout });
}

function handleBridgeResult(res, body) {
  const entry = waitingResults.get(body.id);
  if (!entry) {
    return sendJson(res, 404, { error: "Unknown job id" });
  }

  clearTimeout(entry.timeout);
  waitingResults.delete(body.id);

  if (body.error) {
    entry.reject(new Error(body.error));
  } else {
    entry.resolve(String(body.answer || ""));
  }

  return sendJson(res, 200, { ok: true });
}

async function handleChatCompletions(res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages
    .map((message) => `${message.role || "user"}: ${message.content || ""}`)
    .join("\n")
    .trim();

  if (!prompt) {
    return sendJson(res, 400, { error: "messages are required" });
  }

  const answer = await enqueuePrompt(prompt);

  return sendJson(res, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "deepseek-web",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answer
        },
        finish_reason: "stop"
      }
    ]
  });
}

function enqueuePrompt(prompt) {
  const id = crypto.randomUUID();
  const job = { id, prompt };

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waitingResults.delete(id);
      reject(new Error("Timed out waiting for DeepSeek web response"));
    }, JOB_TIMEOUT_MS);

    waitingResults.set(id, { resolve, reject, timeout });
  });

  const poll = pendingPolls.shift();
  if (poll) {
    clearTimeout(poll.timeout);
    sendJson(poll.res, 200, job);
  } else {
    jobs.push(job);
  }

  return promise;
}

function removePoll(res) {
  const index = pendingPolls.findIndex((poll) => poll.res === res);
  if (index !== -1) {
    pendingPolls.splice(index, 1);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (statusCode === 204) {
    res.end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function renderPlaygroundHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSeek Local Playground</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3f4f6;
      color: #171717;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }

    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-bottom: 1px solid #d4d4d4;
      background: #ffffff;
    }

    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #525252;
    }

    .bar {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #a3a3a3;
    }

    .dot.online {
      background: #16a34a;
    }

    .dot.offline {
      background: #dc2626;
    }

    main {
      width: min(920px, 100%);
      margin: 0 auto;
      padding: 20px;
      overflow: auto;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-bottom: 16px;
    }

    .message {
      max-width: 78%;
      white-space: pre-wrap;
      line-height: 1.45;
      font-size: 15px;
      padding: 10px 12px;
      border: 1px solid #d4d4d4;
      border-radius: 8px;
      background: #ffffff;
    }

    .message.user {
      align-self: flex-end;
      background: #111827;
      color: #ffffff;
      border-color: #111827;
    }

    .message.assistant {
      align-self: flex-start;
    }

    .message.system {
      align-self: center;
      max-width: 100%;
      color: #525252;
      background: transparent;
      border: 0;
      padding: 4px 0;
      font-size: 13px;
    }

    form {
      border-top: 1px solid #d4d4d4;
      background: #ffffff;
      padding: 12px 20px;
    }

    .composer {
      width: min(920px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: end;
    }

    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid #a3a3a3;
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      line-height: 1.4;
      outline: none;
    }

    textarea:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    }

    button {
      height: 48px;
      min-width: 108px;
      border: 0;
      border-radius: 8px;
      background: #2563eb;
      color: #ffffff;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }

    #call {
      min-width: 84px;
      background: #059669;
    }

    #call.live {
      background: #dc2626;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    @media (max-width: 640px) {
      header {
        padding: 0 12px;
      }

      main {
        padding: 12px;
      }

      .message {
        max-width: 92%;
      }

      form {
        padding: 10px 12px;
      }

      .composer {
        grid-template-columns: 1fr;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>DeepSeek Local Playground</h1>
    <div class="bar">
      <button id="call" type="button">Call</button>
      <div class="status">
        <span id="dot" class="dot"></span>
        <span id="status">checking</span>
      </div>
    </div>
  </header>

  <main>
    <div id="messages" class="messages">
      <div class="message system">Открой вкладку chat.deepseek.com, залогинься и оставь ее открытой.</div>
    </div>
  </main>

  <form id="form">
    <div class="composer">
      <textarea id="input" placeholder="Напиши сообщение..." autofocus></textarea>
      <button id="send" type="submit">Send</button>
    </div>
  </form>

  <script>
    const messages = document.getElementById("messages");
    const form = document.getElementById("form");
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const callButton = document.getElementById("call");
    const statusText = document.getElementById("status");
    const dot = document.getElementById("dot");
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recog = SpeechRecognition ? new SpeechRecognition() : null;
    const call = { state: "idle", live: false };

    if (recog) {
      recog.lang = "ru-RU";
      recog.continuous = false;
      recog.interimResults = false;
      recog.onresult = (event) => transition("thinking", event.results[0][0].transcript);
      recog.onend = () => call.live && call.state === "listening" && listen();
      recog.onerror = () => transition("idle");
    } else {
      callButton.disabled = true;
      callButton.textContent = "No mic";
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const text = input.value.trim();
      if (!text || send.disabled) {
        return;
      }

      input.value = "";
      await ask(text, false);
    });

    callButton.addEventListener("click", () => transition(call.live ? "idle" : "listening"));

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    async function refreshHealth() {
      try {
        const response = await fetch("/health", { cache: "no-store" });
        const health = await response.json();
        dot.className = "dot " + (health.bridgeOnline ? "online" : "offline");
        statusText.textContent = health.bridgeOnline ? "bridge online" : "bridge offline";
      } catch {
        dot.className = "dot offline";
        statusText.textContent = "server error";
      }
    }

    async function ask(text, voice) {
      appendMessage("user", text);
      setBusy(true);
      const pending = appendMessage("assistant", "...");

      try {
        const response = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-web",
            messages: [{ role: "user", content: text }]
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed");
        const answer = data.choices?.[0]?.message?.content || "";
        pending.textContent = answer;
        if (voice && call.live) transition("speaking", answer);
      } catch (error) {
        pending.textContent = "Error: " + (error.message || String(error));
        transition("idle");
      } finally {
        setBusy(false);
        input.focus();
      }
    }

    function transition(next, data) {
      call.state = next;
      call.live = next !== "idle";
      callButton.classList.toggle("live", call.live);
      callButton.textContent = call.live ? next : "Call";
      if (next === "idle") return stopVoice();
      if (next === "listening") return listen();
      if (next === "thinking") return ask(data, true);
      if (next === "speaking") return speak(data, () => call.live && transition("listening"));
    }

    function speak(text, done) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ru-RU";
      utterance.onend = done;
      utterance.onerror = done;
      speechSynthesis.speak(utterance);
    }

    function stopVoice() {
      try { recog?.stop(); } catch {}
      speechSynthesis.cancel();
    }

    function listen() {
      try { recog.start(); } catch {}
    }

    function appendMessage(role, text) {
      const node = document.createElement("div");
      node.className = "message " + role;
      node.textContent = text;
      messages.appendChild(node);
      node.scrollIntoView({ block: "end" });
      return node;
    }

    function setBusy(value) {
      send.disabled = value;
      input.disabled = value;
    }

    refreshHealth();
    setInterval(refreshHealth, 3000);
  </script>
</body>
</html>`;
}

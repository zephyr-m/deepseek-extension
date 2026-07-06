const assert = require("node:assert/strict");
const test = require("node:test");
const { createApp, renderPlaygroundHtml } = require("./server");

test("playground contains chat, call FSM, voice command trigger", () => {
  const html = renderPlaygroundHtml();

  assert.match(html, /id="messages"/);
  assert.match(html, /id="call"/);
  assert.match(html, /id="voice"/);
  assert.match(html, /id="heard"/);
  assert.match(html, /function transition/);
  assert.match(html, /function appendHeard/);
  assert.match(html, /setVoice\(true\)/);
  assert.match(html, /звонок/);
  assert.match(html, /AudioContext/);
});

test("health starts offline", async () => {
  await withServer({}, async (baseUrl) => {
    const health = await getJson(`${baseUrl}/health`);

    assert.equal(health.ok, true);
    assert.equal(health.bridgeOnline, false);
    assert.equal(health.queued, 0);
    assert.equal(health.pending, 0);
  });
});

test("chat completion waits for bridge result", async () => {
  await withServer({}, async (baseUrl) => {
    const chat = postJson(`${baseUrl}/v1/chat/completions`, {
      model: "deepseek-web",
      messages: [{ role: "user", content: "Ответь OK" }]
    });

    const job = await getJson(`${baseUrl}/bridge/next`);
    assert.match(job.prompt, /user: Ответь OK/);

    const accepted = await postJson(`${baseUrl}/bridge/result`, {
      id: job.id,
      answer: "OK"
    });
    assert.equal(accepted.ok, true);

    const response = await chat;
    assert.equal(response.model, "deepseek-web");
    assert.equal(response.choices[0].message.content, "OK");
  });
});

test("chat completion validates messages", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "messages are required");
  });
});

test("bash tool loop sends local command result back to bridge", async () => {
  await withServer({ enableBashTool: true, bashShell: process.env.SHELL || "/bin/sh" }, async (baseUrl) => {
    const chat = postJson(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "run pwd" }]
    });

    const first = await getJson(`${baseUrl}/bridge/next`);
    assert.match(first.prompt, /"tool":"bash"/);

    await postJson(`${baseUrl}/bridge/result`, {
      id: first.id,
      answer: JSON.stringify({ tool: "bash", cmd: "printf tool-ok" })
    });

    const second = await getJson(`${baseUrl}/bridge/next`);
    assert.match(second.prompt, /tool-ok/);

    await postJson(`${baseUrl}/bridge/result`, {
      id: second.id,
      answer: "command returned tool-ok"
    });

    const response = await chat;
    assert.equal(response.choices[0].message.content, "command returned tool-ok");
  });
});

test("chat completion times out without bridge result", async () => {
  await withServer({ jobTimeoutMs: 20 }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hang" }] })
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(body.error, /Timed out/);
  });
});

async function getJson(url) {
  const response = await fetch(url);
  assert.ok(response.ok);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.ok(response.ok);
  return response.json();
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function withServer(options, callback) {
  const server = createApp(options);
  const baseUrl = await listenServer(server);

  try {
    return await callback(baseUrl);
  } finally {
    await closeServer(server);
  }
}

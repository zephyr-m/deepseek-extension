(() => {
  const REQUEST_TYPE = "DEEPSEEK_BRIDGE_SEND";
  const RESPONSE_TYPE = "DEEPSEEK_BRIDGE_RESPONSE";
  const ERROR_TYPE = "DEEPSEEK_BRIDGE_ERROR";
  const STATUS_TYPE = "DEEPSEEK_BRIDGE_STATUS";
  const DEBUG_TYPE = "DEEPSEEK_BRIDGE_DEBUG";
  const LOCAL_API = "http://127.0.0.1:8787";

  let busy = false;

  injectPageApi();
  startLocalApiWorker();

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data) {
      return;
    }

    if (event.data.type === DEBUG_TYPE) {
      sendDebug(event.data.requestId || String(Date.now()));
      return;
    }

    if (event.data.type !== REQUEST_TYPE) {
      return;
    }

    const requestId = event.data.requestId || String(Date.now());
    const prompt = String(event.data.prompt || "").trim();

    if (!prompt) {
      sendError(requestId, "Prompt is empty");
      return;
    }

    if (busy) {
      sendError(requestId, "Bridge is busy");
      return;
    }

    try {
      const answer = await runPrompt(prompt, requestId, sendStatus);

      postBridgeMessage({
        type: RESPONSE_TYPE,
        requestId,
        status: "done",
        answer
      });
    } catch (error) {
      sendError(requestId, error.message || String(error));
    }
  });

  async function runPrompt(prompt, requestId, onStatus) {
    if (busy) {
      throw new Error("Bridge is busy");
    }

    busy = true;

    try {
      onStatus(requestId, "received");
      onStatus(requestId, "submitting");
      const before = getLastAnswerText();
      await submitPrompt(prompt);
      onStatus(requestId, "sent");
      onStatus(requestId, "waiting");
      return await waitForAnswerChange(before, requestId, prompt, onStatus);
    } finally {
      busy = false;
    }
  }

  function sendError(requestId, error) {
    postBridgeMessage({
      type: ERROR_TYPE,
      requestId,
      status: "error",
      error
    });
  }

  function sendStatus(requestId, status, detail) {
    postBridgeMessage({
      type: STATUS_TYPE,
      requestId,
      status,
      detail
    });
  }

  function sendDebug(requestId) {
    const input = findPromptInput();
    const sendButton = findSendButton();

    postBridgeMessage({
      type: STATUS_TYPE,
      requestId,
      status: "debug",
      detail: {
        hasInput: Boolean(input),
        inputTag: input?.tagName || null,
        inputRole: input?.getAttribute("role") || null,
        inputText: input?.innerText || input?.value || "",
        hasSendButton: Boolean(sendButton),
        sendButtonText: sendButton?.innerText || "",
        sendButtonLabel: sendButton?.getAttribute("aria-label") || sendButton?.title || "",
        lastAnswerPreview: getLastAnswerText().slice(0, 500)
      }
    });
  }

  async function submitPrompt(prompt) {
    const input = await waitForElement(findPromptInput, 10000);

    input.focus();
    setInputValue(input, prompt);

    const sendButton = findSendButton();
    if (sendButton) {
      sendButton.click();
      return;
    }

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
  }

  function findPromptInput() {
    const selectors = [
      "textarea",
      "[contenteditable='true']",
      "div[role='textbox']"
    ];

    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)]
        .filter((element) => isVisible(element) && !element.closest("[aria-hidden='true']"));

      if (elements.length) {
        return elements[elements.length - 1];
      }
    }

    return null;
  }

  function setInputValue(input, value) {
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
      setter ? setter.call(input, value) : input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    input.textContent = value;
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
  }

  function findSendButton() {
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => isVisible(button) && !button.disabled);

    return buttons.find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.title,
        button.textContent
      ].join(" ").toLowerCase();

      return /send|submit|arrow|отправ|发送|發送/.test(label);
    }) || buttons[buttons.length - 1] || null;
  }

  async function waitForAnswerChange(previousText, requestId, prompt, onStatus = sendStatus) {
    const startedAt = Date.now();
    let lastText = "";
    let lastAnswer = "";
    let stableSince = 0;
    let streamingStarted = false;

    while (Date.now() - startedAt < 120000) {
      await delay(750);

      const currentText = getLastAnswerText();
      if (!currentText || currentText === previousText) {
        onStatus(requestId, "waiting", {
          elapsedMs: Date.now() - startedAt
        });
        stableSince = 0;
        continue;
      }

      const currentAnswer = extractAnswerText(previousText, currentText, prompt);

      if (currentText !== lastText) {
        lastText = currentText;
        lastAnswer = currentAnswer;
        stableSince = Date.now();
        streamingStarted = true;
        onStatus(requestId, "streaming", {
          elapsedMs: Date.now() - startedAt,
          chars: currentAnswer.length,
          preview: currentAnswer.slice(0, 160)
        });
        continue;
      }

      if (stableSince && Date.now() - stableSince > 2000) {
        onStatus(requestId, "done", {
          elapsedMs: Date.now() - startedAt,
          chars: lastAnswer.length
        });
        return lastAnswer || currentText;
      }
    }

    throw new Error(streamingStarted ? "Timed out waiting for answer to finish" : "Timed out waiting for answer to start");
  }

  function getLastAnswerText() {
    const selectors = [
      "[data-message-author-role='assistant']",
      ".markdown",
      "main article",
      "main [class*='message']"
    ];

    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)]
        .filter((element) => isVisible(element) && element.innerText.trim());

      if (elements.length) {
        return elements[elements.length - 1].innerText.trim();
      }
    }

    const main = document.querySelector("main") || document.body;
    return main.innerText.trim();
  }

  function extractAnswerText(previousText, currentText, prompt) {
    let text = currentText;

    if (previousText && currentText.startsWith(previousText)) {
      text = currentText.slice(previousText.length);
    } else if (previousText) {
      text = currentText.slice(commonPrefixLength(previousText, currentText));
    }

    text = cleanExtractedText(text);

    if (prompt && text.includes(prompt)) {
      const parts = text.split(prompt);
      text = parts[parts.length - 1];
    }

    return cleanExtractedText(text);
  }

  function cleanExtractedText(text) {
    return String(text || "")
      .replace(/\n(?:DeepThink|Search|AI-generated, for reference only)\b[\s\S]*$/i, "")
      .replace(/^\s*(?:Instant|DeepThink|Search)\s*/i, "")
      .trim();
  }

  function commonPrefixLength(left, right) {
    const max = Math.min(left.length, right.length);
    let index = 0;

    while (index < max && left[index] === right[index]) {
      index += 1;
    }

    return index;
  }

  async function waitForElement(getElement, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const element = getElement();
      if (element) {
        return element;
      }

      await delay(250);
    }

    throw new Error("Prompt input not found");
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function startLocalApiWorker() {
    while (true) {
      try {
        const response = await fetch(`${LOCAL_API}/bridge/next`, {
          method: "GET",
          cache: "no-store"
        });

        if (response.status === 204) {
          continue;
        }

        if (!response.ok) {
          await delay(2000);
          continue;
        }

        const job = await response.json();
        if (!job?.id || !job?.prompt) {
          continue;
        }

        await handleLocalApiJob(job);
      } catch {
        await delay(2000);
      }
    }
  }

  async function handleLocalApiJob(job) {
    try {
      const answer = await runPrompt(job.prompt, job.id, (requestId, status, detail) => {
        console.debug("[DeepSeek Bridge local]", { requestId, status, detail });
      });

      await postLocalApiResult({
        id: job.id,
        answer
      });
    } catch (error) {
      await postLocalApiResult({
        id: job.id,
        error: error.message || String(error)
      });
    }
  }

  async function postLocalApiResult(result) {
    await fetch(`${LOCAL_API}/bridge/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(result)
    });
  }

  function postBridgeMessage(message) {
    console.debug("[DeepSeek Bridge content]", message);
    window.postMessage(message, "*");
  }

  function injectPageApi() {
    const script = document.createElement("script");
    script.src = `${chrome.runtime.getURL("page-api.js")}?v=${chrome.runtime.getManifest().version}`;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  console.info("[DeepSeek Bridge] Ready. Send messages with window.postMessage({ type: 'DEEPSEEK_BRIDGE_SEND', prompt: '...' }, '*')");
})();

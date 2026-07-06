(() => {
  const pending = new Map();
  const state = {
    ready: true,
    lastEvent: null,
    lastStatus: "ready",
    lastError: null,
    pending: 0
  };

  function send(prompt) {
    const requestId = makeRequestId();

    window.postMessage({
      type: "DEEPSEEK_BRIDGE_SEND",
      requestId,
      prompt
    }, "*");

    return requestId;
  }

  function ask(prompt, options = {}) {
    const requestId = options.requestId || makeRequestId();
    const timeoutMs = options.timeoutMs || 45000;
    const log = options.log !== false;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const request = pending.get(requestId);
        pending.delete(requestId);
        syncPendingCount();

        const error = new Error(`DeepSeek bridge timeout after ${timeoutMs}ms. Last status: ${state.lastStatus}`);
        error.lastEvent = state.lastEvent;
        error.statuses = request?.statuses || [];
        state.lastError = error.message;
        reject(error);
      }, timeoutMs);

      pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
        statuses: [],
        onStatus: typeof options.onStatus === "function" ? options.onStatus : null,
        log
      });
      syncPendingCount();

      window.postMessage({
        type: "DEEPSEEK_BRIDGE_SEND",
        requestId,
        prompt
      }, "*");
    });
  }

  function debug() {
    const requestId = makeRequestId();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(requestId);
        syncPendingCount();
        reject(new Error("DeepSeek debug timeout: content script did not answer"));
      }, 5000);

      pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
        statuses: [],
        onStatus: null,
        log: true,
        debug: true
      });
      syncPendingCount();

      window.postMessage({
        type: "DEEPSEEK_BRIDGE_DEBUG",
        requestId
      }, "*");
    });
  }

  function getState() {
    return {
      ...state,
      pendingIds: [...pending.keys()]
    };
  }

  window.deepseekSend = send;
  window.deepseekAsk = ask;
  window.deepseekDebug = debug;
  window.deepseekBridge = {
    send,
    ask,
    debug,
    state: getState
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object" || !String(message.type || "").startsWith("DEEPSEEK_BRIDGE_")) {
      return;
    }

    state.lastEvent = message;
    state.lastStatus = message.status || message.type;
    if (message.type === "DEEPSEEK_BRIDGE_ERROR") {
      state.lastError = message.error || "Unknown bridge error";
    }

    const request = pending.get(message.requestId);
    if (request?.log || !request) {
      console.log("[DeepSeek Bridge]", message);
    }

    if (!request) {
      return;
    }

    if (message.type === "DEEPSEEK_BRIDGE_STATUS") {
      request.statuses.push(message);
      request.onStatus?.(message);

      if (message.status === "debug") {
        clearTimeout(request.timeoutId);
        pending.delete(message.requestId);
        syncPendingCount();
        request.resolve(message.detail);
      }

      return;
    }

    clearTimeout(request.timeoutId);
    pending.delete(message.requestId);
    syncPendingCount();

    if (message.type === "DEEPSEEK_BRIDGE_RESPONSE") {
      request.resolve(message.answer);
      return;
    }

    if (message.type === "DEEPSEEK_BRIDGE_ERROR") {
      const error = new Error(message.error || "DeepSeek bridge error");
      error.lastEvent = message;
      error.statuses = request.statuses;
      request.reject(error);
    }
  });

  function makeRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  }

  function syncPendingCount() {
    state.pending = pending.size;
  }

  console.info("[DeepSeek Bridge] Ready. Try: await deepseekBridge.ask('Ответь OK')");
})();

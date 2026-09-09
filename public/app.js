const state = {
  mode: "baseline",
  runs: [],
  recognition: null,
  isListening: false,
  shouldSubmit: false,
  startedAt: null,
  transcript: "",
  sending: false,
};

const els = {
  talkButton: document.querySelector("#talkButton"),
  talkHint: document.querySelector("#talkHint"),
  transcript: document.querySelector("#transcript"),
  recordingState: document.querySelector("#recordingState"),
  manualText: document.querySelector("#manualText"),
  sendButton: document.querySelector("#sendButton"),
  stressButton: document.querySelector("#stressButton"),
  stressResult: document.querySelector("#stressResult"),
  latestTtfa: document.querySelector("#latestTtfa"),
  latestMode: document.querySelector("#latestMode"),
  baselineAverage: document.querySelector("#baselineAverage"),
  optimizedAverage: document.querySelector("#optimizedAverage"),
  baselineBar: document.querySelector("#baselineBar"),
  optimizedBar: document.querySelector("#optimizedBar"),
  logBody: document.querySelector("#logBody"),
  runCount: document.querySelector("#runCount"),
  toast: document.querySelector("#toast"),
  healthDot: document.querySelector("#healthDot"),
  healthLabel: document.querySelector("#healthLabel"),
};

function showToast(message, tone = "error") {
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => els.toast.classList.remove("visible"), 5000);
}

function setTranscript(text, interim = false) {
  els.transcript.textContent = text || "Your order will appear here…";
  els.transcript.classList.toggle("is-interim", interim);
}

function setListening(listening) {
  state.isListening = listening;
  els.talkButton.classList.toggle("is-listening", listening);
  els.recordingState.textContent = listening ? "LISTENING" : "READY";
  els.recordingState.classList.toggle("active", listening);
  els.talkHint.textContent = listening ? "Release to send your order" : "Press and hold, then release when you’re done";
}

function initializeRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.talkHint.textContent = "Speech capture needs Chrome — use the text field below";
    els.talkButton.classList.add("unsupported");
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onstart = () => setListening(true);
  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const phrase = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += phrase;
      else interimText += phrase;
    }
    state.transcript = `${finalText} ${interimText}`.trim();
    setTranscript(state.transcript, Boolean(interimText));
  };
  recognition.onerror = (event) => {
    if (event.error !== "aborted") showToast(`Speech capture error: ${event.error}. You can type your order below.`);
    setListening(false);
  };
  recognition.onend = () => {
    setListening(false);
    if (state.shouldSubmit) {
      state.shouldSubmit = false;
      submitOrder(state.transcript, state.startedAt);
    }
  };
  return recognition;
}

function startListening(event) {
  if (state.sending || state.isListening) return;
  event.preventDefault();
  if (!state.recognition) {
    showToast("Speech capture is not supported here. Use the text field below.", "info");
    return;
  }
  state.transcript = "";
  state.startedAt = null;
  setTranscript("");
  state.shouldSubmit = true;
  try {
    state.recognition.start();
  } catch (error) {
    state.shouldSubmit = false;
    showToast("Could not start the microphone. Please try again.");
  }
}

function stopListening(event) {
  if (!state.isListening && !state.shouldSubmit) return;
  event?.preventDefault();
  state.startedAt = performance.now();
  if (state.recognition) state.recognition.stop();
}

function selectMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-option").forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function prettyMode(mode) {
  return mode === "optimized" ? "Optimized" : "Baseline";
}

async function fetchMetric(requestId) {
  if (!requestId) return null;
  try {
    const response = await fetch("/api/metrics", { cache: "no-store" });
    const all = await response.json();
    return all.find((metric) => metric.id === requestId) || null;
  } catch {
    return null;
  }
}

function markAudioStarted(startedAt, onStarted) {
  let marked = false;
  return () => {
    if (marked) return;
    marked = true;
    onStarted(performance.now() - startedAt);
  };
}

async function playStream(response, startedAt, onStarted) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The audio stream could not be opened.");

  const markStarted = markAudioStarted(startedAt, onStarted);
  const audio = new Audio();
  audio.preload = "auto";
  let objectUrl = null;

  if (!window.MediaSource || !MediaSource.isTypeSupported("audio/mpeg")) {
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    objectUrl = URL.createObjectURL(new Blob(chunks, { type: "audio/mpeg" }));
    audio.src = objectUrl;
    audio.addEventListener("play", markStarted, { once: true });
    await audio.play();
    return;
  }

  const mediaSource = new MediaSource();
  objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;
  const sourceReady = new Promise((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", () => {
      try {
        resolve(mediaSource.addSourceBuffer("audio/mpeg"));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
  const sourceBuffer = await sourceReady;
  const pending = [];
  let streamDone = false;
  let playing = false;

  const appendNext = () => {
    if (sourceBuffer.updating || pending.length === 0) {
      if (streamDone && !sourceBuffer.updating && pending.length === 0 && mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
      return;
    }
    sourceBuffer.appendBuffer(pending.shift());
  };
  sourceBuffer.addEventListener("updateend", appendNext);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending.push(value);
    appendNext();
    if (!playing) {
      playing = true;
      audio.addEventListener("play", markStarted, { once: true });
      await audio.play().catch(() => markStarted());
    }
  }
  streamDone = true;
  appendNext();
  await new Promise((resolve) => {
    const check = () => {
      if (mediaSource.readyState !== "open" || (!sourceBuffer.updating && pending.length === 0)) resolve();
      else window.setTimeout(check, 20);
    };
    check();
  });
}

async function submitOrder(text, startedAt = performance.now(), mode = state.mode) {
  const cleanText = text?.trim();
  if (!cleanText || state.sending) {
    if (!cleanText) showToast("Tell QuickOrder what you’d like first.", "info");
    return null;
  }

  state.sending = true;
  els.sendButton.disabled = true;
  els.stressButton.disabled = true;
  els.talkButton.classList.add("is-busy");
  els.recordingState.textContent = "THINKING";
  const requestStartedAt = startedAt || performance.now();

  try {
    const response = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cleanText, mode }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }

    let ttfa = null;
    await playStream(response, requestStartedAt, (elapsed) => {
      ttfa = elapsed;
      els.latestTtfa.innerHTML = `${Math.round(elapsed)}<span>ms</span>`;
      els.latestMode.textContent = `${prettyMode(mode)} · first playable audio`;
    });
    const metric = await fetchMetric(response.headers.get("X-Request-Id"));
    const run = {
      timestamp: new Date(),
      mode,
      orderLength: cleanText.length,
      responseLength: metric?.responseTextLength || 0,
      ttfa: Math.round(ttfa ?? performance.now() - requestStartedAt),
    };
    state.runs.unshift(run);
    renderRuns();
    return run;
  } catch (error) {
    showToast(error.message || "QuickOrder could not complete that run.");
    return null;
  } finally {
    state.sending = false;
    els.sendButton.disabled = false;
    els.stressButton.disabled = false;
    els.talkButton.classList.remove("is-busy");
    els.recordingState.textContent = "READY";
  }
}

function renderRuns() {
  els.runCount.textContent = `${state.runs.length} ${state.runs.length === 1 ? "run" : "runs"}`;
  if (!state.runs.length) {
    els.logBody.innerHTML = '<tr class="empty-row"><td colspan="5"><span>No measurements yet.</span> Hold the button to start your first run.</td></tr>';
  } else {
    els.logBody.innerHTML = state.runs.map((run) => `
      <tr>
        <td class="time-cell">${formatTime(run.timestamp)}</td>
        <td><span class="mode-chip ${run.mode}"><span></span>${prettyMode(run.mode)}</span></td>
        <td class="number-cell">${run.orderLength} <small>chars</small></td>
        <td class="number-cell">${run.responseLength || "—"} <small>${run.responseLength ? "chars" : ""}</small></td>
        <td class="ttfa-cell">${run.ttfa}<small> ms</small></td>
      </tr>
    `).join("");
  }

  const averages = ["baseline", "optimized"].map((mode) => {
    const values = state.runs.filter((run) => run.mode === mode).map((run) => run.ttfa);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  });
  const max = Math.max(...averages, 1);
  els.baselineAverage.textContent = averages[0] ? `${averages[0]} ms` : "—";
  els.optimizedAverage.textContent = averages[1] ? `${averages[1]} ms` : "—";
  els.baselineBar.style.width = `${averages[0] ? Math.max((averages[0] / max) * 100, 4) : 0}%`;
  els.optimizedBar.style.width = `${averages[1] ? Math.max((averages[1] / max) * 100, 4) : 0}%`;
}

async function runStressTest() {
  if (state.sending) return;
  const prompt = "Tell me your full menu and today's specials in detail, plus your allergen policy";
  els.stressResult.hidden = false;
  els.stressResult.innerHTML = '<span class="spinner"></span> Running baseline, then optimized…';
  const baseline = await submitOrder(prompt, performance.now(), "baseline");
  const optimized = await submitOrder(prompt, performance.now(), "optimized");
  if (!baseline || !optimized) {
    els.stressResult.textContent = "Stress test stopped — check the connection and API keys.";
    return;
  }
  const improvement = Math.round((1 - optimized.ttfa / baseline.ttfa) * 100);
  els.stressResult.innerHTML = `<strong>${improvement > 0 ? `${improvement}% faster` : "Compare the two runs"}</strong><span>Baseline ${baseline.ttfa} ms → Optimized ${optimized.ttfa} ms</span>`;
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    const ready = health.providers.openai && health.providers.rime;
    els.healthDot.classList.toggle("ready", ready);
    els.healthLabel.textContent = ready ? "Voice stack ready" : "API keys needed";
  } catch {
    els.healthLabel.textContent = "Server unavailable";
  }
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => selectMode(button.dataset.mode));
});
els.talkButton.addEventListener("pointerdown", startListening);
els.talkButton.addEventListener("pointerup", stopListening);
els.talkButton.addEventListener("pointerleave", (event) => {
  if (state.isListening) stopListening(event);
});
els.talkButton.addEventListener("contextmenu", (event) => event.preventDefault());
els.sendButton.addEventListener("click", () => {
  const text = els.manualText.value;
  els.manualText.value = "";
  submitOrder(text);
});
els.manualText.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.sendButton.click();
});
els.stressButton.addEventListener("click", runStressTest);

state.recognition = initializeRecognition();
renderRuns();
checkHealth();
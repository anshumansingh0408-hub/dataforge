import express from "express";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 5000);
const HOST = "0.0.0.0";
const metrics = [];
const MAX_METRICS = 100;

const SYSTEM_PROMPT =
  "You are a friendly coffee shop counter assistant named QuickOrder. " +
  "Confirm the customer's order, suggest one relevant add-on, and state the total wait time. " +
  "Keep it conversational, 2-4 sentences unless asked for the full menu.";

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public", { etag: false, maxAge: 0 }));

function addMetric(metric) {
  metrics.unshift(metric);
  if (metrics.length > MAX_METRICS) metrics.pop();
}

function getProviderError(response, provider) {
  return response
    .text()
    .then((body) => {
      let detail = body;
      try {
        detail = JSON.parse(body)?.error?.message || body;
      } catch {
        // Keep the raw provider response when it is not JSON.
      }
      return new Error(`${provider} request failed (${response.status}): ${detail.slice(0, 300)}`);
    });
}

async function openAIStream(text) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured. Add it to Replit Secrets to enable ordering.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) throw await getProviderError(response, "OpenAI");
  return response;
}

async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data || data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore an incomplete or provider keep-alive event.
      }
    }
  }
}

async function synthesize(text) {
  if (!process.env.RIME_API_KEY) {
    throw new Error("RIME_API_KEY is not configured. Add it to Replit Secrets to enable audio.");
  }

  const response = await fetch("https://users.rime.ai/v1/rime-tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RIME_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      modelId: "mistv2",
      speaker: "astra",
      lang: "eng",
      samplingRate: 22050,
      speedAlpha: 1.0,
    }),
  });

  if (!response.ok) throw await getProviderError(response, "Rime");
  if (!response.body) throw new Error("Rime returned an empty audio stream.");
  return response;
}

async function streamAudioIntoResponse(audioResponse, res, metric) {
  let wroteAudio = false;
  for await (const chunk of audioResponse.body) {
    if (!wroteAudio) {
      wroteAudio = true;
      metric.t_first_rime_byte_sent_to_client = Date.now();
      metric.firstAudioByteAt = metric.t_first_rime_byte_sent_to_client;
      addMetric(metric);
    }
    res.write(chunk);
  }
  return wroteAudio;
}

function extractSentences(buffer) {
  const sentences = [];
  let remaining = buffer;
  const sentencePattern = /[\s\S]*?[.!?](?=\s|$)/;

  while (true) {
    const match = remaining.match(sentencePattern);
    if (!match) break;
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return { sentences, remainder: remaining };
}

async function handleOrder({ text, mode, res, metric }) {
  const llmResponse = await openAIStream(text);
  let responseText = "";

  if (mode === "baseline") {
    for await (const token of parseSSE(llmResponse.body)) responseText += token;
    responseText = responseText.trim();
    metric.responseTextLength = responseText.length;

    const audioResponse = await synthesize(responseText);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Request-Id", metric.id);
    res.flushHeaders?.();
    await streamAudioIntoResponse(audioResponse, res, metric);
    res.end();
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-Id", metric.id);
  res.flushHeaders?.();

  let sentenceBuffer = "";
  let writeChain = Promise.resolve();
  let outputError = null;

  const enqueueSentence = (sentence) => {
    const audioPromise = synthesize(sentence);
    writeChain = writeChain.then(async () => {
      const audioResponse = await audioPromise;
      await streamAudioIntoResponse(audioResponse, res, metric);
    }).catch((error) => {
      outputError ||= error;
    });
  };

  try {
    for await (const token of parseSSE(llmResponse.body)) {
      responseText += token;
      sentenceBuffer += token;
      const extracted = extractSentences(sentenceBuffer);
      sentenceBuffer = extracted.remainder;
      extracted.sentences.forEach(enqueueSentence);
    }
    if (sentenceBuffer.trim()) enqueueSentence(sentenceBuffer.trim());
    metric.responseTextLength = responseText.trim().length;
    await writeChain;
    if (outputError) throw outputError;
    res.end();
  } catch (error) {
    if (!res.writableEnded) res.end();
    throw error;
  }
}

app.post("/api/order", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const mode = req.body?.mode;
  const metric = {
    id: crypto.randomUUID(),
    mode,
    textLength: text.length,
    responseTextLength: 0,
    t_request_received: Date.now(),
    t_first_rime_byte_sent_to_client: null,
  };

  if (!text || !["baseline", "optimized"].includes(mode)) {
    res.status(400).json({ error: "text and a valid mode (baseline or optimized) are required." });
    return;
  }

  if (!process.env.OPENAI_API_KEY || !process.env.RIME_API_KEY) {
    res.status(503).json({
      error: "QuickOrder needs both OPENAI_API_KEY and RIME_API_KEY in Replit Secrets before it can run.",
      missing: [
        !process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : null,
        !process.env.RIME_API_KEY ? "RIME_API_KEY" : null,
      ].filter(Boolean),
    });
    return;
  }

  try {
    await handleOrder({ text, mode, res, metric });
    if (!metrics.some((entry) => entry.id === metric.id)) addMetric(metric);
  } catch (error) {
    console.error(`[${metric.id}] ${error.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: error.message });
    } else if (!res.writableEnded) {
      res.end();
    }
    if (!metrics.some((entry) => entry.id === metric.id)) addMetric(metric);
  }
});

app.get("/api/metrics", (_req, res) => {
  res.json(metrics);
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      rime: Boolean(process.env.RIME_API_KEY),
    },
  });
});

app.get("*", (_req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.listen(PORT, HOST, () => {
  console.log(`QuickOrder listening on http://${HOST}:${PORT}`);
});
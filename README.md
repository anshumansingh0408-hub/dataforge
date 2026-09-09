# QuickOrder

QuickOrder is a voice-native coffee shop ordering assistant built to make one hard voice problem measurable: **perceived response time**. The app measures Time-To-First-Audio (TTFA), from the moment the customer releases the talk button to the moment audio starts playing.

## What it compares

- **Baseline** — waits for the full Gemini response, then sends the full text to Rime TTS.
- **Optimized (streaming)** — streams Gemini tokens, detects complete sentences, starts a Rime request for each sentence immediately, and writes the resulting audio to the client in the original sentence order.

The browser consumes the `audio/mpeg` response as a `ReadableStream` through MediaSource Extensions. The first `play` event is the client-side t1 measurement. The server also records the first Rime byte written to the response at `GET /api/metrics`.

## Run it

1. Add `GEMINI_API_KEY` and `RIME_API_KEY` to Replit Secrets. Do not put real keys in `.env` or source control.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the app:

   ```bash
   npm start
   ```

4. Open the preview in Chrome. Hold the talk button while speaking, or type an order in the fallback text field.

The server listens on `0.0.0.0:5000` in Replit. `GET /api/health` shows whether both provider keys are available.

## Rime configuration

QuickOrder uses the live Rime HTTP streaming endpoint:

- Endpoint: `POST https://users.rime.ai/v1/rime-tts`
- Model: `mistv2`
- Voice: `astra`
- Language: `eng`
- Output: `audio/mpeg`
- Sampling rate: `22050`
- Speed alpha: `1.0`

Gemini uses the official `@google/genai` Node SDK with streaming `generateContentStream` and model `gemini-2.5-flash`.

## Acceptance test

1. Run the **stress test** button. It sends “Tell me your full menu and today's specials in detail, plus your allergen policy” through Baseline and Optimized, back-to-back.
2. Confirm both rows appear in the experiment log.
3. Compare the two TTFA values and the average bars. Optimized should begin playing near the first sentence's synthesis time while Baseline waits on the full response.
4. For a cross-check, inspect `GET /api/metrics`, which includes `t_request_received` and `t_first_rime_byte_sent_to_client` for every completed request.

## What's live vs. simulated

Everything in this experiment is live: Gemini generation, Rime synthesis, HTTP audio streaming, browser playback, and timing. There is no precomputed audio or fake latency.

## Known limitations

- Browser SpeechRecognition is primarily supported by Chrome and Chromium-based browsers.
- MP3 streaming playback uses MediaSource Extensions when supported; browsers without `audio/mpeg` MSE support use a full-download playback fallback.
- The server keeps metrics in memory and is intended for one concurrent experimenter.
- Network conditions, provider load, browser buffering, and Gemini time-to-first-token all affect measured results.
- This is a measurement demo, not a payment flow or telephony integration.

- ##Made for DataForge 2026

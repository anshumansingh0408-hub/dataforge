# Rime evidence

## Claim

Streaming sentence-chunked TTS reduces Time-To-First-Audio (TTFA) versus waiting for the full response, and the gap should widen with response length.

## Acceptance test procedure

1. Add valid `OPENAI_API_KEY` and `RIME_API_KEY` values to Replit Secrets.
2. Open QuickOrder in Chrome.
3. Click **Run stress test**.
4. Wait for the Baseline and Optimized runs to finish.
5. Screenshot the TTFA log table and the comparison bars.
6. Repeat once if network variance is high.

## Result

Fill this section after running the acceptance test. Expected result: Baseline TTFA scales with the time needed to generate and synthesize the full response. Optimized TTFA stays closer to the time needed to generate the first complete sentence and synthesize that sentence.

Observed:

- Baseline: ______ ms
- Optimized: ______ ms
- Difference: ______%

## Limitations

Network variance, OpenAI time-to-first-token, sentence boundaries, provider queueing, browser buffering, and MediaSource support all contribute to the observed result. Optimized mode makes Rime requests concurrently, but preserves sentence order when writing audio bytes to the client.
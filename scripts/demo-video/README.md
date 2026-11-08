# Demo video tooling

Re-records the demo video against the live site with captions and a Windows text-to-speech voice.
Runs outside the app (its packages are not app dependencies).

```bash
mkdir demo-run && cd demo-run
cp ../scripts/demo-video/* .
npm init -y && npm install --save-exact playwright@1.64.1 ffmpeg-static@5.3.0
npx playwright install ffmpeg
powershell -ExecutionPolicy Bypass -File tts.ps1      # narration WAVs from narration.json (Windows only)
# write durations.json (ms per clip) from the WAV headers, then:
node record.mjs                                       # resets the live demo, records with Edge (headless)
node compose.mjs FleetSpend-AI-demo.mp4               # mixes voice, fast-forwards waits (shown as "4x speed")
```

Note: recording resets the live demo and makes real PayPal **sandbox** payouts.

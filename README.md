# TM-FRAY Mobile Testing

Dedicated HTTPS testing deployment for TXPPS MotionLab Audio TM-FRAY.

## Current test build

Rebuild 265. Required files in the deployment root:

- `index.html` — TM-FRAY UI, C++/WASM DSP, and diagnostics
- `tmfray-audio-worklet.js` — separate same-origin AudioWorklet module

Both files are provided in the TMFRAY Cloudflare 265 deployment package from the ChatGPT conversation. **Do not upload audio recordings or private source material.**

## Cloudflare Pages

Connect this repository to Cloudflare Pages. Use the `main` branch, no framework, no build command, and `/` as the output directory. Cloudflare provides a `*.pages.dev` HTTPS URL. Keep both required files in the repository root.

## Mobile acceptance check

Open the HTTPS URL in Microsoft Edge on iPhone, load a local audio file using the plugin's file picker, and inspect DIAG. Target: `C++ WASM / AudioWorklet` without a CORS failure. Test Grove Wood, Moss, Dust, and Paper. If crackling occurs, copy the DIAG log for review. HTTPS resolves the known local-file loading restriction; it does not itself prove the DSP is crackle-free.

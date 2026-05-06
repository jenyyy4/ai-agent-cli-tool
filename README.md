# AI Agent CLI Tool

A conversational CLI agent (Cursor/Windsurf-style) that runs in the terminal, reasons in a **START → THINK → TOOL → OBSERVE → OUTPUT** loop, and produces real files on disk. Given the instruction *"Clone the Scaler website"*, it generates a working `index.html`, `styles.css`, and `script.js` that visually resembles [scaler.com](https://www.scaler.com).

Built for **Assignment 02 — AI Agent CLI Tool**.

## Features

- **Interactive chat** in the terminal — type instructions, the agent replies and acts.
- **Multi-step reasoning loop** — the model emits `THINK` steps, calls tools, observes their results, and iterates until the task is done. It never solves the task in a single shot.
- **Tools the agent can use:**
  - `createFolder` — make project folders
  - `writeFile` — create HTML / CSS / JS files
  - `readFile`, `listDir` — inspect what it has built
  - `executeCommand` — run shell commands
  - `getTheWeatherOfCity`, `getGithubDetailsAboutUser` — bonus tools to demonstrate generic tool use
- **Free LLM via Groq** — uses `llama-3.3-70b-versatile` through the OpenAI-compatible endpoint. No paid key needed.
- **Credit-safety guards** — per-turn call cap, tool-error abort, history trimming, and JSON-mode constraints to keep runs predictable.

## Setup

```bash
# 1. Install
npm install

# 2. Add your Groq API key
cp .env.example .env
# then edit .env and paste your key from https://console.groq.com/keys

# 3. Run
npm start
```

## Demo

```
$ npm start
AI Agent CLI — type your instruction (or 'exit' to quit).
Model: llama-3.3-70b-versatile
Try: "Clone the Scaler website"

you > clone the scaler website

[START]  User wants to clone the Scaler website...
[THINK]  I'll create a folder, then write index.html, styles.css, script.js...
[TOOL]   createFolder(scaler_clone)
[OBS]    Folder created: scaler_clone
[TOOL]   writeFile({"path":"scaler_clone/index.html",...})
[OBS]    File written: scaler_clone/index.html (4821 bytes)
[TOOL]   writeFile({"path":"scaler_clone/styles.css",...})
[OBS]    File written: scaler_clone/styles.css (6210 bytes)
[TOOL]   writeFile({"path":"scaler_clone/script.js",...})
[OBS]    File written: scaler_clone/script.js (812 bytes)
[OUTPUT] Done. Open scaler_clone/index.html in your browser.

you > exit
```

Then open `scaler_clone/index.html` in a browser:

```bash
open scaler_clone/index.html
```

## Project Structure

```
.
├── index.js          # the agent (chat loop + tool executor)
├── package.json
├── .env.example      # copy to .env and add GROQ_API_KEY
├── .gitignore
└── README.md
```

## How the agent loop works

Every turn, the model is constrained to reply with **one JSON object** of the form:

```json
{ "step": "START | THINK | TOOL | OUTPUT",
  "content": "...",
  "tool_name": "...",
  "tool_args": "..." }
```

The runtime in [index.js](index.js):

1. Parses the JSON (`response_format: json_object` enforces valid JSON; a lenient fallback handles edge cases).
2. If `step` is `TOOL`, executes the named tool with `tool_args`, then injects an `OBSERVE` message containing the result back into the conversation.
3. Repeats until the model emits an `OUTPUT` step.

This is the same pattern Cursor and similar agents use — the LLM never directly touches the filesystem; it requests tools, the runtime executes them, and the result is fed back as context.

## Why Groq?

Groq's free tier is fast, generous, and does not require a credit card. Because Groq exposes an OpenAI-compatible endpoint, the code uses the standard `openai` SDK with a custom `baseURL` — switching to OpenAI / Gemini / OpenRouter is a one-line change.

## Submission checklist

- [x] Public GitHub repository
- [x] CLI tool that accepts natural language input
- [x] Multi-step agent loop with reasoning + tool calls
- [x] Generates a working Scaler-style website (Header, Hero, Stats, Courses, Testimonials, Footer)
- [ ] YouTube demo video (2–3 min) — record yourself running `npm start`, asking the agent to clone Scaler, and opening the result in a browser.

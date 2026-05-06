import "dotenv/config";
import axios from "axios";
import readline from "readline";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { OpenAI } from "openai";

if (!process.env.GROQ_API_KEY) {
  console.error(
    "Missing GROQ_API_KEY. Copy .env.example to .env and add your key from https://console.groq.com/keys"
  );
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = "llama-3.3-70b-versatile";
const PROJECT_ROOT = process.cwd();

// Credit-protection caps. A single user task should never exceed these.
const MAX_MODEL_CALLS_PER_TURN = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 4;
const MAX_HISTORY_CHARS = 60_000; // trim oldest non-system messages past this

function safeResolve(targetPath) {
  const resolved = path.resolve(PROJECT_ROOT, targetPath);
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(`Refusing to write outside project root: ${targetPath}`);
  }
  return resolved;
}

async function getTheWeatherOfCity(cityname = "") {
  const url = `https://wttr.in/${cityname.toLowerCase()}?format=%C+%t`;
  const { data } = await axios.get(url, { responseType: "text" });
  return `The Weather of ${cityname} is ${data}`;
}

async function getGithubDetailsAboutUser(username = "") {
  const url = `https://api.github.com/users/${username}`;
  const { data } = await axios.get(url);
  return {
    login: data.login,
    name: data.name,
    blog: data.blog,
    public_repos: data.public_repos,
  };
}

function executeCommand(cmd = "") {
  return new Promise((resolve) => {
    exec(cmd, { cwd: PROJECT_ROOT }, (error, stdout, stderr) => {
      if (error) resolve(`ERROR: ${error.message}\nSTDERR: ${stderr}`);
      else resolve(stdout || `Command executed: ${cmd}`);
    });
  });
}

async function createFolder(folderPath = "") {
  const target = safeResolve(folderPath);
  await fs.mkdir(target, { recursive: true });
  return `Folder created: ${folderPath}`;
}

function parseLenientWriteArgs(raw) {
  if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {
    /* fall through */
  }

  // Accept both 'path' and "path" keys
  const pathMatch =
    raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
    raw.match(/'path'\s*:\s*'((?:\\.|[^'\\])*)'/) ||
    raw.match(/"path"\s*:\s*'([^']+)'/);
  if (!pathMatch) return null;
  const filePath = pathMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");

  // Find content key (also accept 'content' single-quoted)
  let contentKey = raw.indexOf('"content"');
  let useSingle = false;
  if (contentKey === -1) {
    contentKey = raw.indexOf("'content'");
    if (contentKey === -1) return null;
    useSingle = true;
  }
  const colon = raw.indexOf(":", contentKey);
  const valueQuoteChar = useSingle ? "'" : '"';
  const firstQuote = raw.indexOf(valueQuoteChar, colon + 1);
  if (firstQuote === -1) return null;

  // Strategy 1: walk forward, treat closing quote followed by } or , as end.
  let i = firstQuote + 1;
  let esc = false;
  let endQuote = -1;
  while (i < raw.length) {
    const ch = raw[i];
    if (esc) {
      esc = false;
    } else if (ch === "\\") {
      esc = true;
    } else if (ch === valueQuoteChar) {
      const rest = raw.slice(i + 1).trimStart();
      if (rest.startsWith("}") || rest.startsWith(",") || rest === "") {
        endQuote = i;
        break;
      }
    }
    i++;
  }

  // Strategy 2 (last resort): take the LAST quote-then-} in the string.
  if (endQuote === -1) {
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace > firstQuote) {
      let j = lastBrace - 1;
      while (j > firstQuote && /\s/.test(raw[j])) j--;
      if (raw[j] === valueQuoteChar) endQuote = j;
    }
  }

  if (endQuote === -1) return null;

  let content = raw.slice(firstQuote + 1, endQuote);
  content = content
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
  return { path: filePath, content };
}

async function writeFile(args) {
  const parsed = parseLenientWriteArgs(args);
  if (!parsed)
    throw new Error(
      'writeFile expects {"path":"...","content":"..."} as a JSON string'
    );
  const { path: filePath, content } = parsed;
  if (!filePath || content === undefined)
    throw new Error("writeFile requires both 'path' and 'content'");

  // Reject obvious skeleton/placeholder files so the agent gets feedback.
  const trimmed = content.trim();
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) {
    if (trimmed.length < 1500) {
      throw new Error(
        `HTML too short (${trimmed.length} chars). The Scaler clone needs full markup for header, hero, features, and footer. Re-emit writeFile with the COMPLETE content (≥4000 chars).`
      );
    }
    if (/<header>\s*<\/header>|<main>\s*<\/main>|<footer>\s*<\/footer>/i.test(trimmed)) {
      throw new Error(
        "HTML contains empty <header>/<main>/<footer> tags. Fill every section with real markup and re-emit writeFile."
      );
    }
  }
  if (lower.endsWith(".css") && trimmed.length < 1200) {
    throw new Error(
      `CSS too short (${trimmed.length} chars). Provide complete styles for header, hero gradient, buttons, features, and footer (≥3000 chars).`
    );
  }

  const target = safeResolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return `File written: ${filePath} (${content.length} bytes)`;
}

// Base64 variant — escape-free way for small models to ship long files.
async function writeFileBase64(args) {
  let filePath, b64;

  if (typeof args === "object" && args !== null) {
    filePath = args.path;
    b64 = args.content_base64 ?? args.content;
  } else if (typeof args === "string") {
    // Try strict JSON first — base64 contains no quotes/newlines so this usually works.
    try {
      const obj = JSON.parse(args);
      filePath = obj.path;
      b64 = obj.content_base64 ?? obj.content;
    } catch {
      // Fallback: extract via regex. Path = first quoted string after "path".
      const pm = args.match(/"path"\s*:\s*"([^"]+)"/);
      if (pm) filePath = pm[1];
      // Base64 chars only, captured greedily until the next quote.
      const bm = args.match(/"content_base64"\s*:\s*"([A-Za-z0-9+/=\s]+)"/);
      if (bm) b64 = bm[1];
    }
  }

  if (!filePath || !b64)
    throw new Error(
      'writeFileBase64 requires {"path":"...","content_base64":"..."}'
    );
  const target = safeResolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const cleaned = String(b64).replace(/\s+/g, "");
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) throw new Error("decoded base64 is empty — invalid input");
  await fs.writeFile(target, buf);
  return `File written: ${filePath} (${buf.length} bytes from base64)`;
}

async function readFile(filePath = "") {
  const content = await fs.readFile(safeResolve(filePath), "utf8");
  return content;
}

async function listDir(dirPath = ".") {
  const entries = await fs.readdir(safeResolve(dirPath), {
    withFileTypes: true,
  });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
}

const tool_map = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  createFolder,
  writeFile,
  writeFileBase64,
  readFile,
  listDir,
};

const SYSTEM_PROMPT = `You are an AI coding agent. You reply with EXACTLY ONE JSON object per turn — never multiple objects, never prose.

Your job: take the user's instruction, break it into steps, and use tools to produce real files. The runtime processes one step at a time and replies with an OBSERVE message after each TOOL call.

Each reply must be one JSON object with this shape:
{"step": "<one of: START | THINK | TOOL | OUTPUT>", "content": "<text>", "tool_name": "<optional>", "tool_args": "<optional>"}

TOOLS (tool_args is always a string):
- createFolder — tool_args is a plain folder path, e.g. "scaler_clone"
- writeFile — tool_args is a JSON-encoded string: "{\\"path\\":\\"scaler_clone/index.html\\",\\"content\\":\\"<!doctype html>...\\"}"
- readFile, listDir, executeCommand
- getTheWeatherOfCity, getGithubDetailsAboutUser

WORKFLOW — one step per turn:
- Turn 1: emit START.
- Turn 2: emit THINK (briefly explain the plan).
- Turn 3+: emit TOOL calls one at a time, waiting for OBSERVE between each.
- Final turn: emit OUTPUT.
Do NOT loop on THINK. After 1 THINK, take action.

WHEN ASKED TO CLONE THE SCALER ACADEMY WEBSITE (scaler.com):
Target the public marketing homepage. The intended visual:
- White sticky HEADER with: bold black "SCALER" wordmark; centered nav (a <ul class="nav-links">) with the items PROGRAM, MASTERCLASS, AI LABS, ALUMNI, RESOURCES (all uppercase, gray). PROGRAM and RESOURCES each have a chevron-down icon AFTER the text. The chevron MUST be this exact SVG inline (as a sibling/child inside the <a>): <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chevron-down" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>. The <a> for each nav item must be display:inline-flex with align-items:center and gap:4px so the text and chevron sit on the same line. Right side of the header has an outlined "Login" button and a filled blue "Request A Callback" button.
- HERO with a vertical blue gradient background (top #BFD7EE → middle #3A6E9B → bottom fades to white). Centered content: small uppercase tagline "‹  SCALER ACADEMY  |  12 MONTH PROGRAM  ›" in white, then a HUGE white heading "Modern Software<br>and AI Engineering." (very large, bold), then a white paragraph "Software Engineering hasn't changed. What it takes to be a great at it has. Stronger fundamentals, faster delivery, and AI fluency built into how you learn, not just an add on", then TWO CTAs side by side: a blue filled "DOWNLOAD BROCHURE" and a white outlined "TALK TO AN ADVISOR". Below the buttons: small light text "Next cohort starts May 2026".
- A "WHY SCALER" FEATURES section below the hero with a deep-navy background (#0B1B3B). Layout (top to bottom, all left-aligned inside a max-width 1200px container with padding-left: 80px and padding-right: 24px):
  - Small uppercase eyebrow text "WHY SCALER" in light gray (#9CA3AF), letter-spacing 2px, font-size 12px.
  - Big white heading "Built Different, Designed to Last" — font-size 56px, font-weight 700, color white, line-height 1.1, margin-top 12px.
  - Subheading paragraph "Four things no other program gives you" in light gray (#D1D5DB), font-size 18px, margin-top 16px.
  - A grid of EXACTLY 4 white feature cards (background #FFFFFF, border-radius 4px, padding 32px 28px, box-shadow 0 4px 12px rgba(0,0,0,0.15)). DO NOT add icons, icon placeholders, sparkles, or any decorative elements. Each card contains ONLY:
      • A bold dark-navy title (color #0B1B3B) — font-size 22px, font-weight 700, margin 0 0 16px.
      • A body paragraph (color #1F2937, font-size 14px, line-height 1.6, margin 0).
  - The four cards in order:
      1. Title: "AI-Integrated Curriculum"
         Body: "AI-integrated curriculum. Every phase is structured around how the best technical teams work today, with AI embedded in how problems are framed, built, and shipped. Updated quarterly"
      2. Title: "AI Powered Platform"
         Body: "AI-assisted coding woven into every lab, assignment, and DSA problem with a 24×7 AI Companion that hints, critiques, and pair-programs alongside you. Specialisation in Generative AI included"
      3. Title: "Lifelong Learning Access"
         Body: "The curriculum moves as the market does. When the industry shifts, your knowledge shifts with it at no extra cost. You're not buying a 2026 snapshot. You're buying a living system. Built to last"
      4. Title: "Strong Foundations"
         Body: "The things that matter in software don't change as fast as the headlines. DSA. System design. Engineering judgment. AI makes those fundamentals hit harder not the other way around Depth that doesn't expire"
  - The grid uses display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; max-width 1200px; margin: 48px auto 0; padding-left: 80px; padding-right: 24px.
  - Section overall vertical padding: 96px 0 (left/right padding is handled by the inner containers above).
- A large FOOTER on a light gray background (#F5F7FA), with two stacked sections:
  Section A — 5 columns:
    Col 1: bold "SCALER" wordmark, then small gray address text "Interviewbit Software Services Private Limited / 5th Floor, Surya Park II 14, / 3rd cross, Parappana Agrahar / Electronic City Rd, Electronics City Phase 1 / Bengaluru, Karnataka 560100";
    Col 2: blue heading "Explore Scaler" and links: Modern Software and AI Engineering | Modern Data Science and ML with Specialisation in AI | DevOps, Cloud & AI Platform Engineering | Advanced AI & Machine Learning with Agentic AI | AI Engineering Advanced Certification by IIT-Roorkee CEC | Online PGP in Business and AI | Masters in Advanced AI & Machine Learning | Masters in Software Development.
    Col 3: blue heading "Resources" and links: Alumni Reviews, Blogs, Contact Us, Careers.
    Col 4: blue heading "Others" and links: About Us, Become a Mentor, Become a TA, Hire From Us, Terms of Use, Privacy Policy.
    Col 5: blue heading "Socials" and rows with text: Youtube, LinkedIn, Facebook, Instagram, Twitter, Quora.
  Section B — three pipe-separated link rows under blue subheadings:
    "Trending Courses": Modern Data Science and ML with Specialisation in AI | DevOps, Cloud & AI Platform Engineering | Full Stack Developer Course | Machine Learning Course | Data Structures and Algorithms (DSA) Course | Web Development Course | System Design Course
    "Tutorial": Data Structure Tutorial | Python Tutorial | Java Tutorial | DBMS Tutorial | C Tutorial | JavaScript Tutorial | C++ Tutorial | Data Science Tutorial | CSS Tutorial | Software Engineering Tutorial | HTML Tutorial
    "Career Advice Resources": Software Development | Data Science | Machine Learning | DevOps
  Footer headings ("Explore Scaler", "Resources", "Others", "Socials", "Trending Courses", "Tutorial", "Career Advice Resources") use blue color #1E5BD6. Footer link text is dark gray and no text decoration.

PROCESS:
1. createFolder "scaler_clone"
2. writeFile scaler_clone/index.html — MUST contain ALL the actual visible text and DOM structure for header, hero, features strip, AND the full footer described above. Real text inside real tags. Use semantic tags (header, nav, main, section, footer). Link styles.css and script.js. The file MUST be at least 4000 characters. Empty <header></header> or <footer></footer> tags are FORBIDDEN — every section must be fully populated with real markup.
3. writeFile scaler_clone/styles.css — fully styled to match the screenshot. The CSS file MUST be at least 3000 characters and include rules for every component class used in index.html. Empty rule blocks are FORBIDDEN. Hard requirements:
   - Page bg #FFFFFF, primary blue #1E5BD6, deep navy #0B1B3B, font Inter / system-ui.
   - HEADER: sticky, height 72px, subtle shadow. The <nav> inside header MUST be a flex container with: max-width 1200px, margin 0 auto, padding 0 24px, display flex, align-items center, justify-content space-between, gap 32px — so the logo group, nav links, and buttons are evenly distributed across the width.
   - .nav-links: list-style: none; margin: 0; padding: 0; display: flex; flex-direction: row; align-items: center; gap: 32px (no bullet dots — list-style: none is REQUIRED, and flex-direction: row is REQUIRED so items sit horizontally side-by-side). Each <li> has margin 0 padding 0.
   - .nav-links a: display: inline-flex; align-items: center; gap: 4px; color: #4B5563; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; text-decoration: none.
   - .nav-links a .chevron-down: width: 14px; height: 14px; stroke: currentColor.
   - .buttons: flex, align-items center, gap 12px (so Login and "Request A Callback" have a visible gap between them).
   - Buttons in header: .login-btn is white with 1px solid #D1D5DB border, 4px radius, 9px 22px padding, 14px font, 600 weight. .callback-btn is filled #1E5BD6, white text, no border, 4px radius, 10px 22px padding.
   - HERO: linear-gradient(180deg, #BFD7EE 0%, #3A6E9B 55%, #FFFFFF 100%); padding 80px 24px 120px; text-align center.
   - .hero .heading: font-size 72px, line-height 1.05, color white, font-weight 700, letter-spacing -1px.
   - .hero p: max-width 720px, margin 0 auto 40px, font-size 16px, color white.
   - .ctas: display flex, justify-content center, align-items center, gap 16px, margin-bottom 24px (so DOWNLOAD BROCHURE and TALK TO AN ADVISOR have a clear gap between them).
   - .brochure-btn: filled #1E5BD6, white text, padding 16px 40px, 14px font, 700 weight, 1px letter-spacing.
   - .advisor-btn: transparent bg, 1.5px solid white border, white text, same padding/font as brochure-btn.
   - FOOTER: bg #F5F7FA, padding 48px 24px 24px, base font-size 12px, color #4B5563.
   - .footer-top is a CSS grid: grid-template-columns 1.4fr 1fr 0.7fr 0.7fr 0.7fr, gap 32px, max-width 1200px, margin 0 auto 40px.
   - Footer headings (.column h3.heading and .links h3.heading) MUST be exactly font-size 16px, color #1E5BD6, font-weight 700, margin 0 0 16px.
   - Footer body text and links (.column a, .column li, footer address, .links span, .links a) MUST be exactly font-size 12px, color #1F2937 with line-height ~1.5–1.6.
   - Footer link hover turns color #1E5BD6.
   - Add a responsive @media (max-width: 900px) collapsing nav-links and shrinking the hero heading.
4. writeFile scaler_clone/script.js — at least one real interactive behavior with working selectors that match elements actually present in the HTML (e.g. mobile nav toggle, smooth-scroll on anchor links, or scroll-shadow on header). At least 200 characters.
5. OUTPUT: tell the user to open scaler_clone/index.html.

CRITICAL: do not write skeleton/placeholder files. Each file must be the COMPLETE final content. Do not say "I'll add content later" — write it all now in one writeFile call per file.

EXAMPLE (one turn at a time):
{"step":"START","content":"Cloning the Scaler website."}
[next turn]
{"step":"THINK","content":"I'll create the folder, then write index.html, styles.css, script.js."}
[next turn]
{"step":"TOOL","tool_name":"createFolder","tool_args":"scaler_clone"}
[runtime returns OBSERVE]
{"step":"TOOL","tool_name":"writeFile","tool_args":"{\\"path\\":\\"scaler_clone/index.html\\",\\"content\\":\\"<!doctype html><html>...</html>\\"}"}
[runtime returns OBSERVE]
... etc ...
{"step":"OUTPUT","content":"Done. Open scaler_clone/index.html in a browser."}`;

function extractJSONObjects(text) {
  const out = [];
  if (!text) return out;
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = cleaned.slice(start, i + 1);
        try {
          const obj = JSON.parse(slice);
          if (obj && typeof obj === "object") out.push(obj);
        } catch {
          /* skip malformed */
        }
        start = -1;
      }
    }
  }
  return out;
}

function trimHistory(messages) {
  let total = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (total <= MAX_HISTORY_CHARS) return;
  // Keep the system message and the last user message; drop oldest middle entries.
  const sys = messages[0];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  // Remove pairs from oldest middle until under budget.
  let i = 1;
  while (total > MAX_HISTORY_CHARS && i < messages.length - 1) {
    if (i === lastUserIdx) {
      i++;
      continue;
    }
    total -= messages[i].content?.length ?? 0;
    messages.splice(i, 1);
    if (lastUserIdx > i) lastUserIdx--;
  }
  // Defensive: ensure system stays at index 0.
  if (messages[0] !== sys) {
    messages.unshift(sys);
    if (messages[1] === sys) messages.splice(1, 1);
  }
}

let totalCalls = 0;

async function callModel(messages) {
  trimHistory(messages);
  let attempt = 0;
  while (true) {
    try {
      totalCalls++;
      return await client.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
      });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const body =
        err?.error?.message ||
        err?.response?.data?.error?.message ||
        err?.message ||
        "";
      if (status === 429 && attempt < 2) {
        const wait = 3000 * Math.pow(2, attempt);
        console.log(
          `[!] 429 rate-limited. Retrying in ${wait / 1000}s (attempt ${attempt + 1}/2)…`
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      // 400 from Groq's JSON-mode failure: nudge the model and retry once.
      if (status === 400 && /json/i.test(body) && attempt < 1) {
        console.log("[!] JSON-mode generation failed. Retrying with a nudge…");
        messages.push({
          role: "user",
          content:
            'Your last response failed JSON validation. Reply with ONE small valid JSON object only: {"step":"TOOL","tool_name":"writeFile","tool_args":"<json string>"}. Keep tool_args short and properly escaped.',
        });
        attempt++;
        continue;
      }
      if (status === 429) {
        throw new Error(
          `Groq rate limit (429). ${body || ""}\n` +
            `→ Wait a minute and retry, or check usage at https://console.groq.com`
        );
      }
      if (status === 401 || status === 403)
        throw new Error(
          `Auth error (${status}): ${body}\n→ Check GROQ_API_KEY in .env`
        );
      throw new Error(
        `Model call failed${status ? ` (${status})` : ""}: ${body}`
      );
    }
  }
}

async function runAgentTurn(messages) {
  let modelCalls = 0;
  let consecutiveToolErrors = 0;

  while (modelCalls < MAX_MODEL_CALLS_PER_TURN) {
    modelCalls++;
    const response = await callModel(messages);
    const content = response.choices[0].message.content ?? "";
    const objects = extractJSONObjects(content);

    if (objects.length === 0) {
      if (modelCalls >= 5) {
        console.log("\n[!] Model is not returning valid JSON. Aborting turn to save credits.\n");
        return;
      }
      messages.push({
        role: "user",
        content:
          'Your last reply had no JSON. Reply with exactly one JSON object like {"step":"TOOL","tool_name":"createFolder","tool_args":"scaler_clone"} and nothing else.',
      });
      continue;
    }

    messages.push({ role: "assistant", content });

    let producedOutput = false;
    let producedTool = false;
    let toolErrored = false;

    for (const parsed of objects) {
      if (!parsed.step) continue;

      if (parsed.step === "START") {
        console.log("\n[START]", parsed.content ?? "");
      } else if (parsed.step === "THINK") {
        console.log("[THINK]", parsed.content ?? "");
      } else if (parsed.step === "TOOL") {
        console.log(
          `[TOOL]  ${parsed.tool_name}(${truncate(parsed.tool_args, 80)})`
        );
        const fn = tool_map[parsed.tool_name];
        let observation;
        if (!fn) {
          observation = `Tool "${parsed.tool_name}" is not available.`;
          toolErrored = true;
        } else {
          try {
            const result = await fn(parsed.tool_args);
            observation =
              typeof result === "string" ? result : JSON.stringify(result);
          } catch (err) {
            observation = `Tool error: ${err.message}`;
            toolErrored = true;
          }
        }
        console.log("[OBS]  ", truncate(observation, 200));
        messages.push({
          role: "user",
          content: JSON.stringify({ step: "OBSERVE", content: observation }),
        });
        producedTool = true;
        break;
      } else if (parsed.step === "OUTPUT") {
        console.log("\n[OUTPUT]", parsed.content ?? "", "\n");
        producedOutput = true;
        break;
      }
    }

    if (producedOutput) return;

    if (producedTool) {
      consecutiveToolErrors = toolErrored ? consecutiveToolErrors + 1 : 0;
      if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        console.log(
          `\n[!] ${consecutiveToolErrors} consecutive tool failures — aborting turn to save credits.\n`
        );
        return;
      }
      continue;
    }

    // Only START/THINK this turn — nudge the model to actually act.
    messages.push({
      role: "user",
      content:
        'Continue. Either call a tool now (e.g. {"step":"TOOL","tool_name":"createFolder","tool_args":"scaler_clone"}) or emit OUTPUT if you are done. Reply with one JSON object only.',
    });

    if (modelCalls >= 8) {
      console.log("\n[!] Model is thinking without acting after 8 rounds. Aborting turn.\n");
      return;
    }
  }

  console.log(
    `\n[!] Reached ${MAX_MODEL_CALLS_PER_TURN}-call cap for this turn. Stopping to save credits.\n`
  );
}

function truncate(s, n) {
  if (s == null) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

async function chat() {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("AI Agent CLI — type your instruction (or 'exit' to quit).");
  console.log(`Model: ${MODEL}`);
  console.log('Try: "Clone the Scaler website"\n');

  const prompt = () =>
    new Promise((resolve) => rl.question("you > ", (line) => resolve(line)));

  while (true) {
    const userInput = (await prompt()).trim();
    if (!userInput) continue;
    if (["exit", "quit", ":q"].includes(userInput.toLowerCase())) {
      rl.close();
      console.log(`bye. (total model calls this session: ${totalCalls})`);
      return;
    }
    messages.push({ role: "user", content: userInput });
    try {
      await runAgentTurn(messages);
    } catch (err) {
      console.error("\n[error]", err.message, "\n");
    }
    console.log(`(model calls so far this session: ${totalCalls})`);
  }
}

chat();

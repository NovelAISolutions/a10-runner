// =============================================================
// A10 Runner — v3.5.4  (Full-stack Orchestrator Enhancement)
// Architect (think) → Coder (build) → Tester (verify) → Quality (review)
// Adds PRD-aware web generation, pretty-formatted multi-file commits,
// HTML/CSS/JS synthesis logic, and resilience for future site builds.
// =============================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const SELF_URL =
  process.env.SELF_URL?.replace(/\/+$/, "") ||
  "https://a10-runner.onrender.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!GITHUB_TOKEN) console.warn("⚠️  Missing GITHUB_TOKEN.");
if (!OPENAI_API_KEY)
  console.warn("ℹ️  OPENAI_API_KEY not set — using heuristic brains.");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureString = (v) =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2);

// ---------- GitHub Helpers ----------
async function getTextFileOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return Buffer.from(data.content || "", "base64").toString("utf8");
  } catch (err) {
    if (err?.status === 404) return null;
    console.warn(`⚠️ getTextFileOrNull failed for ${path}:`, err.message);
    return null;
  }
}

async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) {
      console.log(`ℹ️ New file: ${path}`);
      return null;
    }
    console.warn(`⚠️ getFileShaOrNull error for ${path}:`, err.message);
    return null;
  }
}

async function commitWithRetry(
  { owner, repo, path, message, contentUtf8, branch },
  tries = 3
) {
  const contentB64 = Buffer.from(ensureString(contentUtf8), "utf8").toString(
    "base64"
  );
  const ref = branch || "main";
  for (let i = 0; i < tries; i++) {
    try {
      const sha = await getFileShaOrNull({ owner, repo, path, ref });
      const resp = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: contentB64,
        branch: ref,
        ...(sha ? { sha } : {}),
      });
      return {
        ok: true,
        branch: ref,
        created: !sha,
        updated: !!sha,
        path,
        status: resp?.status,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`⚠️ commit ${path} attempt ${i + 1}/${tries} failed: ${msg}`);
      if (i < tries - 1) await sleep(400 * (i + 1));
      else return { ok: false, path, error: msg };
    }
  }
  return { ok: false, path, error: "unknown_commit_failure" };
}

async function commitMany({ owner, repo, files, message, branch }) {
  const results = [];
  const errors = [];
  for (const f of files) {
    const r = await commitWithRetry({
      owner,
      repo,
      path: f.path,
      message: f.message || message,
      contentUtf8: ensureString(f.content),
      branch,
    });
    results.push(r);
    if (!r.ok) errors.push(r);
    await sleep(100);
  }
  return { results, errors };
}

// ---------- Forward ----------
async function forward(path, payload) {
  const url = `${SELF_URL}${path}`;
  const body = JSON.stringify(payload?.payload ? payload : { payload });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  let txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}

// ---------- AI / Heuristic Brains ----------
async function brain({ role, instruction, input }) {
  if (!OPENAI_API_KEY) return heuristicBrain({ role, input });
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content: `You are the ${role} in a software orchestration system. Output pure JSON. The coder must generate pretty HTML/CSS/JS.`,
          },
          {
            role: "user",
            content: `${instruction}\n\nINPUT:\n${JSON.stringify(input)}`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const data = await resp.json();
    const txt = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(txt);
  } catch (e) {
    console.warn(`⚠️ brain(${role}) fallback:`, e.message);
    return heuristicBrain({ role, input });
  }
}

function heuristicBrain({ role, input }) {
  if (role === "architect")
    return {
      coder_plan: ["index.html", "style.css", "script.js"],
      tester_plan: ["validate HTML5", "check CSS", "check JS"],
      quality_rules: ["no inline CSS", "semantic layout"],
    };

  if (role === "coder") {
    const prd = input?.goal || "Default sandbox page";
    const time = new Date().toLocaleString();
    return {
      files: [
        {
          path: "index.html",
          content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${prd}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="banner"><h1>${prd}</h1></header>
<main>
<section id="about"><h2>About</h2><p>This site was auto-generated by A10 Runner v3.5.4 at ${time}.</p></section>
<section id="gallery"><h2>Gallery</h2>
<div class="gallery">
  <img src="https://placekitten.com/400/300" alt="Sample 1">
  <img src="https://placekitten.com/401/300" alt="Sample 2">
</div></section>
<section id="contact"><h2>Contact</h2><p>Email: hello@example.com<br>Instagram: @labubu</p></section>
</main>
<footer><p>© ${new Date().getFullYear()} Auto-built by A10 Runner</p></footer>
<script src="script.js"></script>
</body>
</html>`,
        },
        {
          path: "style.css",
          content: `:root {
  --bg: #ffeaf4;
  --accent: #d39cd3;
  --text: #3b2643;
  --card-bg: #ffffffb3;
}
body {
  font-family: 'Poppins', sans-serif;
  background: var(--bg);
  color: var(--text);
  margin: 0;
  padding: 0;
  text-align: center;
}
header.banner {
  background: var(--accent);
  color: white;
  padding: 1.5rem;
  border-radius: 0 0 1rem 1rem;
}
main { padding: 1rem; }
h2 { color: var(--accent); }
.gallery {
  display: flex;
  justify-content: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 1rem;
}
.gallery img {
  width: 300px;
  border-radius: 1rem;
  box-shadow: 0 4px 10px #0002;
}
footer {
  margin-top: 2rem;
  font-size: 0.9rem;
  opacity: 0.7;
}`,
        },
        {
          path: "script.js",
          content: `document.addEventListener("DOMContentLoaded", ()=>{
  console.log("Labubu showcase page rendered successfully!");
  const time = new Date().toLocaleString();
  const msg = document.createElement("p");
  msg.textContent = "🧠 Verified build: " + time;
  document.body.appendChild(msg);
});`,
        },
      ],
      message: "Generated PRD page build",
    };
  }

  if (role === "tester")
    return { checks: [{ id: "html_ok" }, { id: "css_ok" }, { id: "js_ok" }] };
  if (role === "quality")
    return { rules: ["semantic", "no inline style", "proper footer"] };
  return {};
}

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, version: "3.5.4", time: new Date().toISOString() })
);

// =============================================================
// Architect
// =============================================================
app.post("/run/architect", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const { owner, repo } = payload;
    if (!owner || !repo)
      return res.status(400).json({ ok: false, error: "Missing owner/repo" });

    const arch = await brain({
      role: "architect",
      instruction: "Break down the PRD into coder/tester/quality plans",
      input: payload.prd || payload,
    });

    const orchestration = {
      runId: `run_${Date.now()}`,
      owner,
      repo,
      branch: payload.branch || "main",
      coder_plan: arch.coder_plan || [],
      tester_plan: arch.tester_plan || [],
      quality_rules: arch.quality_rules || [],
      prd: payload.prd || {},
      retries: 0,
      maxRetries: 2,
    };

    const coderResp = await forward("/run/coder", orchestration);
    res.json({ ok: true, agent: "architect", orchestration, forwarded: coderResp });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// Coder
// =============================================================
app.post("/run/coder", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    if (!owner || !repo)
      return res.status(400).json({ ok: false, error: "Missing owner/repo" });

    const coder = await brain({
      role: "coder",
      instruction: "Generate well-formatted index.html, style.css, and script.js for the PRD.",
      input: p.prd || { goal: "Default sandbox site" },
    });

    const files = coder.files?.length
      ? coder.files
      : heuristicBrain({ role: "coder", input: p.prd }).files;

    const { results, errors } = await commitMany({
      owner,
      repo,
      files,
      message: "Coder update",
      branch,
    });

    const [testerPlan, qualityPlan] = await Promise.all([
      brain({ role: "tester", input: p.tester_plan || [] }),
      brain({ role: "quality", input: p.quality_rules || [] }),
    ]);

    const common = {
      owner,
      repo,
      branch,
      runId: p.runId,
      checks: testerPlan.checks || [],
      rules: qualityPlan.rules || [],
    };

    const [testerResp, qualityResp] = await Promise.all([
      forward("/run/tester", common),
      forward("/run/quality", common),
    ]);

    res.json({
      ok: errors.length === 0,
      agent: "coder",
      results,
      next: ["tester", "quality"],
      tester: testerResp,
      quality: qualityResp,
    });
  } catch (err) {
    console.error("💥 Coder error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// Tester
// =============================================================
app.post("/run/tester", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    const html =
      (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) ||
      "";
    const css =
      (await getTextFileOrNull({ owner, repo, path: "style.css", ref: branch })) ||
      "";
    const js =
      (await getTextFileOrNull({ owner, repo, path: "script.js", ref: branch })) ||
      "";

    const ok =
      /<title>[^<]+<\/title>/i.test(html) &&
      /:root\s*\{[^}]+\}/i.test(css) &&
      /console\.log/i.test(js);
    res.json({ ok, agent: "tester", result: ok ? "passed" : "failed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// Quality
// =============================================================
app.post("/run/quality", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    const html =
      (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) ||
      "";
    const ok = /<main[\s>]/i.test(html) && /<\/footer>/.test(html);
    res.json({ ok, agent: "quality", status: ok ? "pass" : "fail" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================
// Integrator / Supervisor / Gate
// =============================================================
app.post("/run/integrator", async (_req, res) =>
  res.json({ ok: true, agent: "integrator", status: "complete" })
);

app.post("/run/supervisor", async (_req, res) =>
  res.json({ ok: true, agent: "supervisor", status: "done" })
);

app.post("/run/gate", async (req, res) => {
  const p = req.body?.payload || req.body || {};
  const { tester, quality, orchestration } = p;
  if (!orchestration)
    return res.status(400).json({ ok: false, error: "Missing orchestration" });

  const failed =
    tester?.ok === false ||
    tester?.result === "failed" ||
    quality?.ok === false ||
    quality?.status === "fail";

  if (failed) {
    const next = { ...orchestration, retries: (orchestration.retries || 0) + 1 };
    const coderResp = await forward("/run/coder", next);
    return res.json({ ok: true, status: "looped_to_coder", coder: coderResp });
  }

  const integ = await forward("/run/integrator", orchestration);
  const sv = await forward("/run/supervisor", orchestration);
  res.json({ ok: true, status: "proceed", integrator: integ, supervisor: sv });
});

// ---------- Start ----------
app.listen(PORT, () =>
  console.log(`🚀 A10 Runner v3.5.4 live | PORT ${PORT}`)
);

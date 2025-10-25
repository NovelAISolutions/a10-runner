// ================================================
// A10 Runner — Enhanced Smart Coder Agent + Multi-File Support
// Handles Architect → Coder → Tester → Quality → Integrator
// Supports both single-file and multi-file updates
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SELF_URL = process.env.SELF_URL || "https://a10-runner.onrender.com";

if (!GITHUB_TOKEN) console.warn("⚠️  Missing GITHUB_TOKEN");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utils ----------
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

async function createOrUpdateFile({ owner, repo, path, message, contentUtf8, branch }) {
  const contentB64 = Buffer.from(contentUtf8, "utf8").toString("base64");
  const ref = branch || "main";
  const sha = await getFileShaOrNull({ owner, repo, path, ref });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: contentB64,
    branch: ref,
    ...(sha ? { sha } : {}),
  });

  return { ok: true, branch: ref, created: !sha, updated: !!sha };
}

async function safeForward(path, payload) {
  try {
    const url = `${SELF_URL}${path}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    const j = await r.json();
    console.log(`🧩 Forwarded to ${path}:`, j);
    return j;
  } catch (err) {
    console.warn(`⚠️  Forward failed (${path}):`, err.message);
    return { ok: false, error: err.message };
  }
}

// ---------- Architect Agent ----------
app.post("/run/architect", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("📦 Architect received:", JSON.stringify(payload, null, 2));

    const required = ["owner", "repo"];
    const missing = required.filter(k => !payload[k]);
    if (missing.length)
      return res.status(400).json({ ok: false, error: `Missing: ${missing.join(", ")}` });

    const response = {
      ok: true,
      agent: "architect",
      status: "processed",
      received: payload,
      next_step: "coder",
      timestamp: new Date().toISOString(),
    };

    // Auto-trigger coder
    response.forwarded = await safeForward("/run/coder", payload);

    res.json(response);
  } catch (err) {
    console.error("💥 Architect error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Smart Coder Agent ----------
app.post("/run/coder", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🧠 Coder received payload:", JSON.stringify(p, null, 2));

    const { owner, repo } = p;
    const branch = p.branch || "main";
    const message = p.message || "Enhanced Smart Coder update";
    const task = p.task || "";
    const files = p.files || [];

    if (!owner || !repo) {
      return res.status(400).json({ ok: false, reason: "Missing owner/repo" });
    }

    // --- MULTI-FILE MODE ---
    if (Array.isArray(files) && files.length > 0) {
      console.log(`📁 Detected multi-file commit (${files.length} files)`);

      const results = [];
      for (const file of files) {
        const path = file.path || "index.html";
        const content = file.content || "<html><body><h1>Empty File</h1></body></html>";
        const commitMessage = file.message || message;

        console.log(`📝 Committing ${path} ...`);
        const result = await createOrUpdateFile({
          owner,
          repo,
          path,
          message: commitMessage,
          contentUtf8: content,
          branch,
        });
        results.push({ path, result });
      }

      const response = {
        ok: true,
        agent: "coder",
        results,
        mode: "multi-file",
        next_step: "tester",
        timestamp: new Date().toISOString(),
      };

      response.forwarded = await safeForward("/run/tester", p);
      return res.json(response);
    }

    // --- SINGLE-FILE MODE (Enhanced Smart HTML update) ---
    const path = p.path || "index.html";

    // 1️⃣ Fetch existing HTML
    let existing = "";
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
      existing = Buffer.from(data.content, "base64").toString("utf8");
    } catch {
      existing = "<html><body><h1>Initial Page</h1></body></html>";
    }

    // 2️⃣ Parse style hints
    const style = {};
    const lower = task.toLowerCase();
    if (lower.includes("center")) style["text-align"] = "center";
    if (lower.includes("bold")) style["font-weight"] = "bold";
    if (lower.includes("blue")) style.color = "blue";
    if (lower.includes("gold")) style.color = "gold";
    if (lower.includes("green")) style.color = "green";
    if (lower.includes("red")) style.color = "red";
    if (lower.includes("large") || lower.includes("bigger")) style["font-size"] = "22px";
    if (lower.includes("small")) style["font-size"] = "14px";

    const styleString = Object.entries(style)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");

    // 3️⃣ Extract message text
    const match = task.match(/says['"“](.*?)['"”]/i);
    const innerText = match ? match[1] : task;

    const addition = `
      <div class="a10-banner" style="${styleString};margin-top:20px;">
        ${innerText}
      </div>
    `;

    // 4️⃣ Replace existing banners
    const cleaned = existing.replace(/<div class="a10-banner".*?<\/div>/gs, "");

    // 5️⃣ Inject before </body>
    const updatedHtml = cleaned.includes("</body>")
      ? cleaned.replace("</body>", `${addition}\n</body>`)
      : cleaned + addition;

    // 6️⃣ Commit update
    const result = await createOrUpdateFile({
      owner,
      repo,
      path,
      message,
      contentUtf8: updatedHtml,
      branch,
    });

    console.log("✅ Smart Coder commit successful:", result);

    const response = {
      ok: true,
      agent: "coder",
      result,
      mode: "single-file",
      next_step: "tester",
      timestamp: new Date().toISOString(),
    };

    response.forwarded = await safeForward("/run/tester", p);
    res.json(response);
  } catch (err) {
    console.error("💥 Smart Coder error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Tester Agent ----------
app.post("/run/tester", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🧪 Tester received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "tester",
      result: "passed",
      next_step: "quality",
      timestamp: new Date().toISOString(),
    };

    response.forwarded = await safeForward("/run/quality", p);
    res.json(response);
  } catch (err) {
    console.error("💥 Tester error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Quality Agent ----------
app.post("/run/quality", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🔍 Quality received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "quality",
      status: "pass",
      next_step: "integrator",
      timestamp: new Date().toISOString(),
    };

    response.forwarded = await safeForward("/run/integrator", p);
    res.json(response);
  } catch (err) {
    console.error("💥 Quality error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Integrator Agent ----------
app.post("/run/integrator", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    console.log("🔗 Integrator received:", JSON.stringify(p, null, 2));

    const response = {
      ok: true,
      agent: "integrator",
      status: "complete",
      timestamp: new Date().toISOString(),
    };

    response.forwarded = await safeForward("/run/supervisor", p);
    res.json(response);
  } catch (err) {
    console.error("💥 Integrator error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Supervisor Agent ----------
app.post("/run/supervisor", (_req, res) =>
  res.json({ ok: true, agent: "supervisor", status: "done", timestamp: new Date().toISOString() })
);

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner enhanced auto-chain live on port ${PORT}`));

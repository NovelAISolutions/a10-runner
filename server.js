// server.js
import express from "express";

const app = express();
app.use(express.json()); // parse JSON bodies

// ---- Basic routes ----
app.get("/", (req, res) => {
  res.send("✅ A10 Runner is alive!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- Helper actions ----
async function handleEcho(payload = {}) {
  return { ok: true, echo: payload };
}

async function handleSum(payload = {}) {
  const nums = Array.isArray(payload?.numbers) ? payload.numbers : [];
  const total = nums.reduce((a, b) => a + Number(b || 0), 0);
  return { ok: true, sum: total, count: nums.length };
}

// ---- OpenAI Chat ----
async function handleOpenAIChat(payload = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY missing in runner env" };

  const prompt = payload.prompt || "Say hello from the A10 runner.";
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  if (!r.ok) return { ok: false, error: "OpenAI API error", detail: data };

  const text = data?.choices?.[0]?.message?.content ?? "(no content returned)";
  return { ok: true, model: body.model, text };
}

// ---- GitHub Commit ----
async function handleGithubCommit(payload = {}) {
  const {
    owner,
    repo,
    path,
    content,
    message = "Automated commit from A10 runner",
    branch = "main",
    base64 = false,
    sha,
  } = payload;

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_TOKEN missing in runner env" };
  if (!owner || !repo || !path || typeof content === "undefined") {
    return { ok: false, error: "Missing one of: owner, repo, path, content" };
  }

  const encodeBase64 = (str) => Buffer.from(str, "utf8").toString("base64");

  // Try fetching existing file to get SHA (so updates work)
  let existingSha = sha;
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const getRes = await fetch(getUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "a10-runner",
    },
  });
  if (getRes.ok) {
    const getData = await getRes.json();
    if (getData?.sha) existingSha = getData.sha;
  }

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    branch,
    content: base64 ? content : encodeBase64(String(content)),
    ...(existingSha ? { sha: existingSha } : {}),
  };

  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "a10-runner",
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });

  const data = await putRes.json();
  if (!putRes.ok) {
    return { ok: false, error: "GitHub API error", status: putRes.status, detail: data };
  }

  return {
    ok: true,
    contentPath: data?.content?.path,
    commitSha: data?.commit?.sha,
    htmlUrl: data?.content?.html_url,
  };
}

// ---- Actions map ----
const ACTIONS = {
  echo: handleEcho,
  sum: handleSum,
  "openai.chat": handleOpenAIChat,
  "github.commit": handleGithubCommit,
};

// ---- /run endpoint ----
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body || {};
    if (!action || !ACTIONS[action]) {
      return res
        .status(400)
        .json({ ok: false, error: "Unknown or missing action", action });
    }
    const result = await ACTIONS[action](payload);
    return res.json({ ok: true, action, result });
  } catch (err) {
    console.error("Run error:", err);
    return res.status(500).json({ ok: false, error: "Runner error", detail: String(err) });
  }
});

// ---- Start server ----
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 A10 Runner listening on port ${port}`);
});

// server.js
import express from "express";

const app = express();
app.use(express.json()); // <-- IMPORTANT for JSON bodies

// Root
app.get("/", (req, res) => {
  res.send("✅ A10 Runner is alive!");
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- Simple action handlers ----
async function handleEcho(payload = {}) {
  return { ok: true, echo: payload };
}

async function handleSum(payload = {}) {
  const nums = Array.isArray(payload?.numbers) ? payload.numbers : [];
  const total = nums.reduce((a, b) => a + Number(b || 0), 0);
  return { ok: true, sum: total, count: nums.length };
}

// Optional: OpenAI chat (requires OPENAI_API_KEY in Render env)
async function handleOpenAIChat(payload = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY missing in runner env" };
  }
  const prompt = payload.prompt || "Say hello from the A10 runner.";
  const body = {
    model: "gpt-4o-mini", // or "gpt-3.5-turbo" if you prefer
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
  if (!r.ok) {
    return { ok: false, error: "OpenAI API error", detail: data };
  }
  const text =
    data?.choices?.[0]?.message?.content ??
    "(no content returned by model)";
  return { ok: true, model: body.model, text };
}

// Action router
const ACTIONS = {
  echo: handleEcho,
  sum: handleSum,
  "openai.chat": handleOpenAIChat,
};

// POST /run  { action: "echo", payload: {...} }
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

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 A10 Runner listening on port ${port}`);
});

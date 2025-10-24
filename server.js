import express from "express";
const app = express();

app.get("/", (req, res) => {
  res.send("✅ A10 Runner is alive!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 A10 Runner listening on port ${port}`);
});

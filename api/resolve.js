// Vercel serverless function — เส้นทาง /api/resolve
import { resolve } from "../lib/resolve.mjs";
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try { res.status(200).json(await resolve(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
}

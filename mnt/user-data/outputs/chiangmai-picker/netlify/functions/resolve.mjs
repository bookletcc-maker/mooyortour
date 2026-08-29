import { resolve } from "../../lib/resolve.mjs";
export const config = { path: "/api/resolve" };
export default async (req) => {
  const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: H });
  try { const body = await req.json(); return new Response(JSON.stringify(await resolve(body)), { headers: H }); }
  catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: H }); }
};

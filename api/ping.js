// /api/ping — กัน Supabase (แผนฟรี) หยุดโปรเจกต์เมื่อไม่มีกิจกรรม ~7 วัน
// Vercel Cron เรียกวันละครั้ง: อ่าน 1 ครั้ง + เขียน meta:keepalive 1 แถว (ไม่เรียก Google เลย = ฟรี)
const SB_URL = "https://xxpyyvpaoxfneodnxiuy.supabase.co";
const SB_KEY = "sb_publishable_4qaMwaT5K7GFuAGjpZEa3g_lZiqmarU"; // anon key (สาธารณะอยู่แล้วใน config.js)
const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };

export default async function handler(req, res){
  try {
    const r = await fetch(`${SB_URL}/rest/v1/spaces?id=eq.meta:apiusage&select=id`, { headers: H });
    const now = new Date().toISOString();
    const w = await fetch(`${SB_URL}/rest/v1/spaces?on_conflict=id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: "meta:keepalive", data: { at: now, by: /vercel-cron/i.test(String(req.headers["user-agent"] || "")) ? "cron" : "manual" }, updated_at: now }) });
    res.setHeader("Cache-Control", "no-store");
    return res.status(r.ok && w.ok ? 200 : 502).json({ ok: r.ok && w.ok, read: r.status, write: w.status, at: now });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

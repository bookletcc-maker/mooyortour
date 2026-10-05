// /api/photo?id=<placeId> — ดึงรูปร้านสดจาก Google แบบมีเพดานรายเดือน (ฟรีแน่นอน)
// Google ห้ามเก็บ photo name ไว้ใช้ซ้ำ (หมดอายุได้) จึงขอใหม่ทุกครั้ง: Place Details (photos, Essentials) + Place Photo (Enterprise ฟรี 1,000/เดือน)
// เพดาน 900 ครั้ง/เดือน นับแบบ atomic ใน Supabase (rpc bump_photo) — เกินเพดานคืน {none:"cap"} แล้วการ์ดใช้ภาพพื้นสีแทน
const GKEY = process.env.GOOGLE_MAPS_API_KEY;
const SB_URL = "https://xxpyyvpaoxfneodnxiuy.supabase.co";
const SB_KEY = "sb_publishable_4qaMwaT5K7GFuAGjpZEa3g_lZiqmarU"; // anon key (สาธารณะอยู่แล้วใน config.js)

export default async function handler(req, res){
  const none = (reason, maxAge) => { res.setHeader("Cache-Control", `private, max-age=${maxAge}`); return res.status(200).json({ none: reason }); };
  try {
    if (!GKEY) return none("nokey", 60);
    const id = String((req.query && req.query.id) || "");
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return res.status(400).json({ error: "bad id" });
    // จองโควต้า 1 หน่วย (= 1 Place Details + 1 Place Photo) ก่อนเรียก Google เสมอ
    const r = await fetch(`${SB_URL}/rest/v1/rpc/bump_photo`, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: "{}" });
    const n = r.ok ? await r.json() : -1;
    if (typeof n !== "number" || n < 0) return none("cap", 3600);
    const d = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id), { headers: { "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "photos" } });
    if (!d.ok) return none("details", 3600);
    const ph = ((await d.json()).photos || [])[0];
    if (!ph || !ph.name) return none("nophoto", 86400);
    const m = await fetch("https://places.googleapis.com/v1/" + ph.name + "/media?maxWidthPx=640&skipHttpRedirect=true&key=" + GKEY);
    if (!m.ok) return none("media", 3600);
    const mj = await m.json();
    if (!mj.photoUri) return none("media", 3600);
    const by = (ph.authorAttributions || []).map(a => a.displayName).filter(Boolean).join(", ") || null;
    const byUri = ((ph.authorAttributions || [])[0] || {}).uri || null;
    res.setHeader("Cache-Control", "private, max-age=21600"); // แคชในเบราว์เซอร์ผู้ใช้ 6 ชม. ลดการเรียกซ้ำ
    return res.status(200).json({ uri: mj.photoUri, by, byUri, used: n });
  } catch (e) {
    return none("error", 300);
  }
}

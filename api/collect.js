// /api/collect — server-side light refresh + new-place discovery (free-tier guarded)
// GET /api/collect            → รัน region เริ่มต้น (chiangmai) — ใช้โดย Vercel Cron รายเดือน
// GET /api/collect?region=X   → รันเมือง X
//   &estimate=1  → ประเมินจำนวน call/งบ โดยไม่รันจริง
//   &force=1     → ข้าม min-interval (ปกติกันรันซ้ำภายใน 6 วัน)
// โหมดเบา (Pro tier, ฟรี 5,000/เดือน): อัปเดต rating/จำนวนรีวิวของร้านเดิม + หา id ใหม่
// ร้านใหม่เท่านั้นที่ขอข้อมูลเต็ม (Enterprise+Atmosphere, ฟรี 1,000/เดือน) จำกัด 40 ร้าน/รอบ
// ตัวกันงบ: นับ call รายเดือนใน Supabase (row meta:apiusage) — ถ้าจะเกินกันชนของโควต้าฟรี จะปฏิเสธ

const GKEY = process.env.GOOGLE_MAPS_API_KEY;
const SB_URL = "https://xxpyyvpaoxfneodnxiuy.supabase.co";
const SB_KEY = "sb_publishable_4qaMwaT5K7GFuAGjpZEa3g_lZiqmarU"; // anon key (สาธารณะอยู่แล้วใน config.js)
const SITE = "https://mooyortour.vercel.app";

const PRO_BUDGET = 4500;   // กันชนใต้โควต้าฟรี 5,000
const EA_BUDGET = 900;     // กันชนใต้โควต้าฟรี 1,000
const NEW_ENRICH_CAP = 40; // เติมข้อมูลเต็มร้านใหม่สูงสุดต่อรอบ
const PAGES_PER_SEED = 2;
const MIN_INTERVAL_DAYS = 6;

const LIGHT_FIELDS = ["id","displayName","location","types","primaryType","primaryTypeDisplayName","rating","userRatingCount","priceLevel"].map(f=>"places."+f).join(",");
const FULL_FIELDS = ["id","displayName","formattedAddress","location","types","primaryType","primaryTypeDisplayName","rating","userRatingCount","priceLevel","priceRange","regularOpeningHours","currentOpeningHours","parkingOptions","reviewSummary","generativeSummary","googleMapsUri","googleMapsLinks","editorialSummary","openingDate","goodForGroups","outdoorSeating","reservable","servesCocktails","liveMusic","evChargeOptions"].map(f=>"places."+f).join(",")+",routingSummaries";

const PRICE = {PRICE_LEVEL_FREE:0,PRICE_LEVEL_INEXPENSIVE:1,PRICE_LEVEL_MODERATE:2,PRICE_LEVEL_EXPENSIVE:3,PRICE_LEVEL_VERY_EXPENSIVE:3};
const T = {FOOD:"ร้านอาหาร",CAFE:"คาเฟ่",BAR:"บาร์",WAT:"วัด",MARKET:"ตลาด",NATURE:"ธรรมชาติ",ATTR:"ที่เที่ยว"};
const TYPE_MAP = [
  [["cafe","coffee_shop","bakery","dessert","ice_cream","tea_house"],T.CAFE],
  [["bar","pub","wine_bar","night_club"],T.BAR],
  [["restaurant","food","meal_takeaway","noodle"],T.FOOD],
  [["hindu_temple","buddhist_temple","place_of_worship","church","mosque"],T.WAT],
  [["market","shopping_mall"],T.MARKET],
  [["park","hiking_area","campground","waterfall","garden","natural_feature","lake","reservoir"],T.NATURE],
];
function mapGType(types){ for (const [keys,label] of TYPE_MAP) if ((types||[]).some(t=>keys.some(k=>String(t).includes(k)))) return label; return T.ATTR; }
function nameRuleType(name){
  const n = String(name||"");
  if (/道の駅|michinoeki|michi-no-eki|roadside station|road station/i.test(n)) return T.MARKET;
  if (/^ถนนคนเดิน/.test(n)) return T.MARKET;
  if (/onsen|温泉|ออนเซ็น/i.test(n)) return T.ATTR;
  if (/^วัด|shrine|神社/i.test(n)) return T.WAT;
  if (/^ตลาด/.test(n)) return T.MARKET;
  return null;
}
const hav = (a,b) => { const R=6371,dl=(b.lat-a.lat)*Math.PI/180,dn=(b.lng-a.lng)*Math.PI/180,x=Math.sin(dl/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dn/2)**2; return 2*R*Math.asin(Math.sqrt(x)); };

// ---------- Supabase (REST, no deps) ----------
const sbHeaders = { apikey: SB_KEY, Authorization: "Bearer "+SB_KEY, "Content-Type": "application/json" };
async function sbGet(id){
  const r = await fetch(`${SB_URL}/rest/v1/spaces?id=eq.${encodeURIComponent(id)}&select=data`, { headers: sbHeaders });
  if (!r.ok) throw new Error("supabase get "+r.status);
  const j = await r.json();
  return j[0] ? j[0].data : null;
}
async function sbUpsert(id, data){
  const r = await fetch(`${SB_URL}/rest/v1/spaces?on_conflict=id`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("supabase upsert "+r.status+" "+(await r.text()).slice(0,120));
}

// ---------- Google ----------
async function searchText(body, fields){
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": fields }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("places "+r.status+" "+(await r.text()).slice(0,150));
  return r.json();
}
async function pool(items, n, fn){
  const out = []; let i = 0;
  const workers = Array.from({length: Math.min(n, items.length)}, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx).catch(e=>({ __err: String(e && e.message || e) })); }
  });
  await Promise.all(workers); return out;
}
function parseHours(p){
  const per = (p.currentOpeningHours || p.regularOpeningHours || {}).periods; if (!per) return null;
  const out = {}; for (let d=0; d<7; d++) out[d] = [];
  for (const x of per) { if (!x.open) continue; const o=x.open, c=x.close; const hh=v=>String(v??0).padStart(2,"0"); out[o.day??0].push([hh(o.hour)+":"+hh(o.minute), c ? hh(c.hour)+":"+hh(c.minute) : "23:59"]); }
  for (const d in out) if (!out[d].length) out[d] = null; return out;
}
function parkingFromApi(p){
  const o = p.parkingOptions; if (!o) return null;
  if (o.freeParkingLot||o.freeStreetParking||o.freeGarageParking) return { status: "มี", note: "มีที่จอดฟรี (ข้อมูล Google)" };
  if (o.paidParkingLot||o.paidStreetParking||o.paidGarageParking) return { status: "มี", note: "มีที่จอดแบบเสียค่าจอด (ข้อมูล Google)" };
  return null;
}
function amenities(p){
  const KEYS = ["goodForGroups","outdoorSeating","reservable","servesCocktails","liveMusic"];
  const a = {}; for (const k of KEYS) if (p[k] != null) a[k] = !!p[k]; a.ev = !!p.evChargeOptions; return a;
}
function priceRangeTxt(p){
  const pr = p.priceRange; if (!pr) return null;
  const n = x => x ? Math.round(+x.units||0) : null; const lo = n(pr.startPrice), hi = n(pr.endPrice);
  const cur = (pr.startPrice||pr.endPrice||{}).currencyCode||""; const sym = {THB:"฿",JPY:"¥",USD:"$",EUR:"€",KRW:"₩"}[cur] ?? cur+" ";
  if (lo!=null&&hi!=null) return `${sym}${lo.toLocaleString()}–${hi.toLocaleString()}`;
  if (lo!=null) return `${sym}${lo.toLocaleString()}+`; return null;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!GKEY) return res.status(500).json({ error: "no GOOGLE_MAPS_API_KEY" });
    const q = req.query || {};
    const regionId = String(q.region || "chiangmai");
    const today = new Date().toISOString().slice(0,10);
    const month = today.slice(0,7);

    // regions definition (อ่านจากไฟล์ที่ deploy อยู่ — อัปเดตตาม repo เสมอ)
    const rjs = await fetch(SITE + "/regions.js").then(r=>r.text());
    const REGIONS = JSON.parse(rjs.replace(/^[\s\S]*?window\.REGIONS\s*=\s*/, "").replace(/;\s*$/, ""));
    const REG = REGIONS[regionId];
    if (!REG) return res.status(400).json({ error: "unknown region", regions: Object.keys(REGIONS) });
    const seeds = REG.seeds || [];
    const mode = ["DRIVE","WALK","BICYCLE","TWO_WHEELER"].includes(REG.travelMode) ? REG.travelMode : "DRIVE";

    // budget (โควต้าฟรีรายเดือน)
    const usage0 = (await sbGet("meta:apiusage")) || {};
    const usage = usage0.month === month ? usage0 : { month, pro: 0, ea: 0 };
    const plannedPro = seeds.length * PAGES_PER_SEED;
    const freeOk = (usage.pro + plannedPro <= PRO_BUDGET) && (usage.ea + NEW_ENRICH_CAP <= EA_BUDGET);
    if (q.estimate) return res.status(200).json({ region: regionId, seeds: seeds.length, plannedProCalls: plannedPro, newEnrichCap: NEW_ENRICH_CAP, usedThisMonth: { pro: usage.pro||0, ea: usage.ea||0 }, freeBudget: { pro: PRO_BUDGET, ea: EA_BUDGET }, willStayFree: freeOk });
    if (!freeOk) return res.status(429).json({ error: "จะเกินโควต้าฟรีเดือนนี้ ไม่รัน", usage });

    const cur = (await sbGet("data:"+regionId)) || { meta: {}, places: [] };
    cur.meta = cur.meta || {}; cur.places = cur.places || [];
    if (!q.force && cur.meta.lastLightAt && (Date.now() - Date.parse(cur.meta.lastLightAt)) < MIN_INTERVAL_DAYS*864e5)
      return res.status(429).json({ error: "เพิ่งรันไปเมื่อ " + cur.meta.lastLightAt + " (ใส่ force=1 ถ้าจะรันซ้ำ)" });

    const byId = new Map(cur.places.map(p => [p.id, p]));
    let proCalls = 0, eaCalls = 0;

    // 1) light search ทุก seed
    const found = new Map();
    await pool(seeds, 5, async (seed) => {
      let token = null;
      for (let page = 0; page < PAGES_PER_SEED; page++) {
        const body = { textQuery: seed, languageCode: REG.lang || "th", regionCode: REG.country || "TH", pageSize: 20,
          locationBias: { circle: { center: { latitude: REG.origin.lat, longitude: REG.origin.lng }, radius: Math.min((REG.searchRadiusKm||30)*1000, 50000) } } };
        if (token) body.pageToken = token;
        let j; try { j = await searchText(body, LIGHT_FIELDS); proCalls++; } catch (e) { break; }
        for (const g of (j.places||[])) if (g.id && !found.has(g.id)) found.set(g.id, g);
        token = j.nextPageToken; if (!token) break;
      }
    });

    // 2) merge: อัปเดตร้านเดิม + เก็บร้านใหม่
    let updated = 0; const newOnes = [];
    for (const [gid, g] of found) {
      const ex = byId.get(gid);
      const cnt = g.userRatingCount;
      if (ex) {
        if (typeof cnt === "number" && typeof ex.count === "number" && cnt !== ex.count) { ex.cntPrev = ex.count; ex.cntDelta = cnt - ex.count; ex.cntAt = today; }
        if (typeof cnt === "number") ex.count = cnt;
        if (typeof g.rating === "number") ex.rating = g.rating;
        updated++;
      } else {
        const lat = g.location && g.location.latitude, lng = g.location && g.location.longitude;
        if (lat == null) continue;
        const d = hav(REG.origin, { lat, lng });
        const allTypes = [g.primaryType||"", ...(g.types||[])];
        const name = (g.displayName && g.displayName.text) || "?";
        newOnes.push({ id: gid, placeId: gid, name, type: nameRuleType(name) || mapGType(allTypes), typeLabel: (g.primaryTypeDisplayName && g.primaryTypeDisplayName.text) || null,
          lat, lng, minutes: Math.round(d*1.3*2.2+2), km: +(d*1.3).toFixed(1), est: true,
          rating: g.rating ?? null, count: cnt ?? null, cntPrev: cnt ?? null, cntDelta: 0, cntAt: today,
          price: PRICE[g.priceLevel] ?? null, opened: null, hours: null, parking: null, photo: null, cuisine: null,
          menu: [], highlights: [], caveats: [], tags: [], nearby: [], onWay: [],
          maps: "https://www.google.com/maps/place/?q=place_id:"+gid, firstSeen: today });
      }
    }

    // 3) เติมข้อมูลเต็มเฉพาะร้านใหม่ (จำกัดจำนวน + งบ)
    const toEnrich = newOnes.slice(0, Math.min(NEW_ENRICH_CAP, Math.max(0, EA_BUDGET - (usage.ea||0))));
    await pool(toEnrich, 4, async (p) => {
      let j; try {
        j = await searchText({ textQuery: p.name, languageCode: REG.lang || "th", regionCode: REG.country || "TH", pageSize: 1,
          locationBias: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 800 } },
          routingParameters: { origin: { latitude: REG.origin.lat, longitude: REG.origin.lng }, travelMode: mode } }, FULL_FIELDS);
        eaCalls++;
      } catch (e) { return; }
      const g = (j.places||[])[0]; if (!g || g.id !== p.id) return;
      const legs = (j.routingSummaries||[])[0] && j.routingSummaries[0].legs || [];
      if (legs.length) { p.minutes = Math.round(legs.reduce((s,l)=>s+parseInt(l.duration||"0"),0)/60); p.km = +(legs.reduce((s,l)=>s+(l.distanceMeters||0),0)/1000).toFixed(1); p.est = false; }
      p.hours = parseHours(g); p.parking = parkingFromApi(g); p.amen = amenities(g); p.links = g.googleMapsLinks || null;
      p.gSummary = (g.reviewSummary && g.reviewSummary.text && g.reviewSummary.text.text) || (g.generativeSummary && g.generativeSummary.overview && g.generativeSummary.overview.text) || null;
      p.priceRange = priceRangeTxt(g); p.opened = (g.openingDate && g.openingDate.year) || null;
      if (g.googleMapsUri) p.maps = g.googleMapsUri;
      p.address = g.formattedAddress || "";
    });

    cur.places = cur.places.concat(newOnes);
    cur.meta.updated = today; cur.meta.lastLightAt = new Date().toISOString();
    await sbUpsert("data:"+regionId, cur);
    usage.pro = (usage.pro||0) + proCalls; usage.ea = (usage.ea||0) + eaCalls;
    await sbUpsert("meta:apiusage", usage);

    return res.status(200).json({ region: regionId, seen: found.size, updatedExisting: updated, newPlaces: newOnes.length, newNames: newOnes.slice(0,10).map(p=>p.name), enrichedFull: toEnrich.length, apiCalls: { pro: proCalls, ea: eaCalls }, usageThisMonth: usage, stillFree: usage.pro <= PRO_BUDGET && usage.ea <= EA_BUDGET });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}

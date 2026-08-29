// ตัวแก้ลิงก์: รับ URL ที่ผู้ใช้แปะ → ตามลิงก์ย่อ → อ่านชื่อ/พิกัด → ค้น Google Places (New) → คำนวณนาที (Routes) → สรุปรีวิว (Claude)
// ใช้ร่วมกันระหว่าง Netlify function และ Vercel function
const GKEY = process.env.GOOGLE_MAPS_API_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const AMODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const UA = "Mozilla/5.0 (compatible; PlacePicker/1.0)";

const TYPE_MAP = [
  [["cafe","coffee_shop","bakery","dessert","ice_cream","tea_house"], "คาเฟ่"],
  [["bar","pub","wine_bar","night_club"], "บาร์"],
  [["restaurant","food","meal_takeaway","noodle"], "ร้านอาหาร"],
  [["hindu_temple","buddhist_temple","place_of_worship","church","mosque"], "วัด"],
  [["market","shopping_mall"], "ตลาด"],
  [["park","hiking_area","campground","waterfall","garden","natural_feature","lake","reservoir"], "ธรรมชาติ"],
];
const CUISINE_MAP = [["japanese","ญี่ปุ่น"],["sushi","ญี่ปุ่น"],["ramen","ญี่ปุ่น"],["korean","เกาหลี"],["chinese","จีน"],["thai","ไทย"],["italian","อิตาเลียน"],["pizza","อิตาเลียน"],["american","อเมริกัน"],["hamburger","อเมริกัน"],["steak","สเต็ก"],["seafood","ซีฟู้ด"],["vietnamese","เวียดนาม"],["indian","อินเดีย"],["mexican","เม็กซิกัน"],["french","ฝรั่งเศส"],["vegan","มังสวิรัติ"],["vegetarian","มังสวิรัติ"],["barbecue","ปิ้งย่าง"],["noodle","ก๋วยเตี๋ยว"],["breakfast","อาหารเช้า"],["brunch","อาหารเช้า"]];
const mapCuisine = (types=[]) => { for (const [k,l] of CUISINE_MAP) if (types.some(t=>t.includes(k))) return l; return null; };
const mapType = (types=[]) => { for (const [keys,label] of TYPE_MAP) if (types.some(t=>keys.some(k=>t.includes(k)))) return label; return "ที่เที่ยว"; };
const PRICE = {PRICE_LEVEL_FREE:0,PRICE_LEVEL_INEXPENSIVE:1,PRICE_LEVEL_MODERATE:2,PRICE_LEVEL_EXPENSIVE:3,PRICE_LEVEL_VERY_EXPENSIVE:3};

export function parseCoords(s="") {
  for (const r of [/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|center|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/])
    { const m = s.match(r); if (m) return { lat:+m[1], lng:+m[2] }; }
  return null;
}
function nameFromUrl(u) {
  const m = u.match(/\/maps\/place\/([^\/@?]+)/); if (m) { try { return decodeURIComponent(m[1]).replace(/\+/g," "); } catch { return m[1]; } }
  const q = u.match(/[?&](?:q|query)=([^&]+)/); if (q && !/^-?\d/.test(q[1])) { try { return decodeURIComponent(q[1]).replace(/\+/g," "); } catch {} }
  return "";
}
function titleFromHtml(html) {
  const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i) || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const t = og?.[1] || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
  return t.replace(/\s*[-–|·]\s*(Google Maps|Google แผนที่|Facebook|Wongnai|TripAdvisor|Instagram).*$/i,"").trim();
}

async function expand(url) {
  // ตามลิงก์ย่อ (maps.app.goo.gl, goo.gl, bit.ly, fb.me ฯลฯ) และดึง HTML มาอ่านชื่อ
  const ctl = new AbortController(); const to = setTimeout(()=>ctl.abort(), 8000);
  try {
    const r = await fetch(url, { redirect:"follow", headers:{ "User-Agent":UA, "Accept-Language":"th,en" }, signal:ctl.signal });
    const finalUrl = r.url || url; const html = (r.headers.get("content-type")||"").includes("html") ? (await r.text()).slice(0,300000) : "";
    return { finalUrl, html };
  } catch { return { finalUrl:url, html:"" }; }
  finally { clearTimeout(to); }
}

async function placesSearch(query, bias, lang, country, origin, mode) {
  const fields = ["id","displayName","formattedAddress","location","types","primaryType","primaryTypeDisplayName","rating","userRatingCount","priceLevel","priceRange","regularOpeningHours","currentOpeningHours","parkingOptions","reviews","reviewSummary","generativeSummary","googleMapsUri","googleMapsLinks","editorialSummary","photos","openingDate","goodForGroups","outdoorSeating","reservable","servesCocktails","liveMusic","evChargeOptions"].map(f=>"places."+f).join(",")+",routingSummaries";
  const body = { textQuery:query, languageCode:lang, regionCode:country, pageSize:1 };
  if (bias) body.locationBias = { circle:{ center:{ latitude:bias.lat, longitude:bias.lng }, radius: bias.radius||2000 } };
  if (origin) body.routingParameters = { origin:{ latitude:origin.lat, longitude:origin.lng }, travelMode: mode||"DRIVE" };
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method:"POST", headers:{ "Content-Type":"application/json","X-Goog-Api-Key":GKEY,"X-Goog-FieldMask":fields }, body:JSON.stringify(body) });
  if (!r.ok) throw new Error("Places " + r.status + " " + (await r.text()).slice(0,120));
  const j = await r.json(); const p = j.places?.[0] || null;
  if (p) { const legs = j.routingSummaries?.[0]?.legs || []; if (legs.length) p._route = { minutes: Math.round(legs.reduce((s,l)=>s+parseInt(l.duration||"0"),0)/60), km: +(legs.reduce((s,l)=>s+(l.distanceMeters||0),0)/1000).toFixed(1) }; }
  return p;
}
async function routeMinutes(origin, dest, mode) {
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", { method:"POST", headers:{ "Content-Type":"application/json","X-Goog-Api-Key":GKEY,"X-Goog-FieldMask":"routes.duration,routes.distanceMeters" },
    body:JSON.stringify({ origin:{ location:{ latLng:{ latitude:origin.lat, longitude:origin.lng } } }, destination:{ location:{ latLng:{ latitude:dest.lat, longitude:dest.lng } } }, travelMode:mode }) });
  if (!r.ok) return null; const j = await r.json(); const rt = j.routes?.[0]; if (!rt) return null;
  return { minutes: Math.round(parseInt(rt.duration)/60), km: +(rt.distanceMeters/1000).toFixed(1) };
}
const AMENITY_LABEL = { goodForGroups:"กลุ่มใหญ่", outdoorSeating:"นั่งกลางแจ้ง", reservable:"จองได้", servesCocktails:"ค็อกเทล", liveMusic:"ดนตรีสด" };
function amenities(p) { const a = {}; for (const k in AMENITY_LABEL) if (p[k] != null) a[k] = !!p[k]; a.ev = !!p.evChargeOptions; return a; }
function priceRange(p) { const pr = p.priceRange; if (!pr) return null; const n = x => x ? Math.round(+x.units||0) : null; const lo = n(pr.startPrice), hi = n(pr.endPrice); const cur = (pr.startPrice||pr.endPrice||{}).currencyCode||""; const sym = {THB:"฿",JPY:"¥",USD:"$",EUR:"€",KRW:"₩"}[cur] ?? cur+" "; if (lo!=null&&hi!=null) return `${sym}${lo.toLocaleString()}–${hi.toLocaleString()}`; if (lo!=null) return `${sym}${lo.toLocaleString()}+`; return null; }
function parseHours(p) {
  const per = (p.currentOpeningHours || p.regularOpeningHours)?.periods; if (!per) return null;
  const out = {}; for (let d=0; d<7; d++) out[d] = [];
  for (const x of per) { if (!x.open) continue; const o=x.open, c=x.close; out[o.day??0].push([`${String(o.hour??0).padStart(2,"0")}:${String(o.minute??0).padStart(2,"0")}`, c?`${String(c.hour??0).padStart(2,"0")}:${String(c.minute??0).padStart(2,"0")}`:"23:59"]); }
  for (const d in out) if (!out[d].length) out[d] = null; return out;
}
function parkingFromApi(p) {
  const o = p.parkingOptions; if (!o) return null;
  if (o.freeParkingLot||o.freeStreetParking||o.freeGarageParking) return { status:"มี", note:"มีที่จอดฟรี (ข้อมูล Google)" };
  if (o.paidParkingLot||o.paidStreetParking||o.paidGarageParking) return { status:"มี", note:"มีที่จอดแบบเสียค่าจอด (ข้อมูล Google)" };
  return null;
}
async function summarize(p, ptype, region) {
  if (!AKEY || !p.reviews?.length) return {};
  const reviews = p.reviews.map(r=>`- (${r.rating??"?"}★) ${(r.text?.text||"").slice(0,600)}`).join("\n");
  const prompt = `คุณกำลังสรุปรีวิวสถานที่ใน${region}สำหรับเว็บช่วยตัดสินใจ (ตอบเป็นภาษาไทย)\nสถานที่: ${p.displayName?.text} (ประเภท: ${ptype})\nคำอธิบาย: ${p.editorialSummary?.text||"-"}\nรีวิว:\n${reviews}\n\nตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น ไม่มี markdown:\n{"menu":["เมนู/สิ่งที่คนแนะนำ สูงสุด 4 ถ้าเป็นที่เที่ยวให้ []"],"highlights":["จุดเด่นที่คนพูดถึงซ้ำ สูงสุด 3 สั้น ๆ"],"caveats":["ข้อควรระวัง สูงสุด 2"],"parking":{"status":"มี|จำกัด|ไม่มี|ไม่ทราบ","note":"จากรีวิว หรือ \\"\\""},"opened":ปี ค.ศ. ตัวเลข หรือ null,"tags":["แท็กบรรยากาศ เช่น ครอบครัว วิวสวย ถ่ายรูป นั่งทำงานได้ กลางคืน ราคาประหยัด สูงสุด 3"],"cuisine":"ถ้าเป็นร้านอาหาร ระบุสัญชาติ/แนว 1 คำ เช่น ไทย อาหารเหนือ ญี่ปุ่น เกาหลี หรือ null"}\nห้ามแต่งข้อมูลที่ไม่มีในรีวิว`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", headers:{ "Content-Type":"application/json","x-api-key":AKEY,"anthropic-version":"2023-06-01" }, body:JSON.stringify({ model:AMODEL, max_tokens:600, messages:[{ role:"user", content:prompt }] }) });
    const j = await r.json(); const text = (j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").replace(/```json|```/g,"").trim();
    return JSON.parse(text);
  } catch { return {}; }
}

export async function resolve({ url, region="", origin, travelMode="DRIVE", lang="th", country="TH" }) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("ลิงก์ไม่ถูกต้อง");
  const { finalUrl, html } = await expand(url);
  const coords = parseCoords(finalUrl) || parseCoords(url) || parseCoords(html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/)?.[0]?.replace("%2C",",")||"");
  const name = nameFromUrl(finalUrl) || nameFromUrl(url) || titleFromHtml(html);
  const base = { name: name || "ไม่ทราบชื่อ", url, finalUrl, lat:coords?.lat??null, lng:coords?.lng??null, type:"ที่เที่ยว", rating:null, count:null, price:null, opened:null, hours:null, parking:null, maps: coords?`https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`:null, enriched:false };
  if (!GKEY) return { place: base, note:"ไม่มี GOOGLE_MAPS_API_KEY ฝั่งเซิร์ฟเวอร์" };
  if (!name && !coords) throw new Error("อ่านชื่อหรือพิกัดจากลิงก์ไม่ได้");
  const q = name || `${coords.lat},${coords.lng}`;
  const found = await placesSearch(name ? (name.includes(region)?name:`${name} ${region}`) : q, coords ? {...coords, radius:1500} : (origin ? {...origin, radius:30000} : null), lang, country, origin, travelMode);
  if (!found) return { place: base, note:"ไม่พบใน Google Places" };
  const allTypes = [found.primaryType||"", ...(found.types||[])]; const ptype = mapType(allTypes);
  const cuisineApi = ["ร้านอาหาร","คาเฟ่","บาร์"].includes(ptype) ? mapCuisine(allTypes) : null;
  const [route, sum] = await Promise.all([ found._route || (origin ? routeMinutes(origin, { lat:found.location.latitude, lng:found.location.longitude }, travelMode) : null), summarize(found, ptype, region) ]);
  const amen = amenities(found);
  let parking = parkingFromApi(found) || sum.parking || { status:"ไม่ทราบ", note:"" }; if (!["มี","จำกัด","ไม่มี"].includes(parking.status)) parking.status = "ไม่ทราบ";
  return { place: {
    ...base, placeId: found.id, name: found.displayName?.text || base.name, type: ptype, cuisine: cuisineApi || sum.cuisine || (ptype==="ร้านอาหาร" ? found.primaryTypeDisplayName?.text : null) || null, address: found.formattedAddress||"",
    lat: found.location.latitude, lng: found.location.longitude, minutes: route?.minutes ?? null, km: route?.km ?? null,
    rating: found.rating ?? null, count: found.userRatingCount ?? null, price: PRICE[found.priceLevel] ?? null, priceRange: priceRange(found),
    typeLabel: found.primaryTypeDisplayName?.text || null, gSummary: found.reviewSummary?.text?.text || found.generativeSummary?.overview?.text || null, amen, links: found.googleMapsLinks || null,
    hours: parseHours(found), parking, opened: found.openingDate?.year ?? sum.opened ?? null, menu: (sum.menu||[]).slice(0,4), highlights: (sum.highlights||[]).slice(0,3), caveats: (sum.caveats||[]).slice(0,2), tags: [...new Set([...Object.keys(AMENITY_LABEL).filter(k=>amen[k]).map(k=>AMENITY_LABEL[k]), ...(sum.tags||[]).slice(0,3)])],
    maps: found.googleMapsUri || base.maps, enriched: true,
  } };
}

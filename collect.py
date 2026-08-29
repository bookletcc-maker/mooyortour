"""
collect.py — เก็บข้อมูลร้าน/ที่เที่ยวของ "ภูมิภาค" หนึ่ง แล้วเขียนออกเป็น data/<region>.js ให้หน้าเว็บใช้

    python collect.py chiangmai        # region id ต้องมีใน regions.js
    python collect.py tokyo

ขั้นตอน
  1. อ่านนิยามภูมิภาค (จุดศูนย์กลาง รัศมี ภาษา คำค้น) จาก regions.js
  2. Google Places API (New) Text Search  -> ชื่อ พิกัด ประเภท ดาว จำนวนรีวิว ราคา เวลาเปิด ที่จอดรถ รีวิว 5 รายการ รูป
  3. Google Routes API (computeRouteMatrix) -> นาทีขับรถจากประตูท่าแพ
  3.5 ถ้ามี manual.<region>.json (ส่งออกจากหน้าเว็บ) จะค้นชื่อร้านเหล่านั้นเพิ่ม
  4. Claude (Anthropic API)                 -> สรุปรีวิวเป็น เมนูเด่น / จุดเด่น / ข้อควรระวัง / ที่จอดรถ / ปีที่เปิด / แท็ก
  5. คำนวณ "ใกล้เคียง" และ "ผ่านทาง" จากพิกัด
  (ถ้ามี manual.json ที่ส่งออกจากหน้าเว็บ จะค้นชื่อร้านเหล่านั้นเพิ่มให้ด้วย)
  6. เขียน data/<region>.js (+ ดาวน์โหลดรูปลง photos/<region>/)

ตั้งค่า (environment variables)
  GOOGLE_MAPS_API_KEY   จำเป็น  เปิดใช้ Places API (New) และ Routes API ใน Google Cloud
  ANTHROPIC_API_KEY     ถ้าไม่ตั้ง จะข้ามขั้นสรุปรีวิว (ฟิลด์ menu/highlights ว่าง)
  ANTHROPIC_MODEL       ค่าเริ่มต้น claude-sonnet-4-6
  MAX_PER_QUERY         ผลลัพธ์สูงสุดต่อคำค้น (ค่าเริ่มต้น 20)
  DOWNLOAD_PHOTOS       "1" เพื่อโหลดรูป (ค่าเริ่มต้น 1)

รัน
  pip install requests anthropic
  python collect.py
"""
import json, os, re, sys, time, math, datetime, pathlib
import requests

OUT_DIR = pathlib.Path(__file__).parent

def load_regions():
    txt = (OUT_DIR / "regions.js").read_text(encoding="utf-8")
    body = txt[txt.index("{", txt.index("window.REGIONS")): txt.rindex("}") + 1]
    return json.loads(body)

REGIONS = load_regions()
REGION_ID = sys.argv[1] if len(sys.argv) > 1 else "chiangmai"
if REGION_ID not in REGIONS:
    sys.exit(f"ไม่พบภูมิภาค '{REGION_ID}' ใน regions.js (มี: {', '.join(REGIONS)})")
REG = REGIONS[REGION_ID]
ORIGIN = {"name": REG["origin"]["name"], "lat": REG["origin"]["lat"], "lng": REG["origin"]["lng"]}
LANG = REG.get("lang", "th"); COUNTRY = REG.get("country", "TH")
RADIUS_M = float(REG.get("searchRadiusKm", 30)) * 1000
TRAVEL = REG.get("travelMode", "DRIVE").upper().replace("DRIVING", "DRIVE")
if TRAVEL not in ("DRIVE", "TRANSIT", "WALK", "BICYCLE"): TRAVEL = "DRIVE"
GKEY = os.environ.get("GOOGLE_MAPS_API_KEY")
AKEY = os.environ.get("ANTHROPIC_API_KEY")
AMODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
MAX_PER_QUERY = int(os.environ.get("MAX_PER_QUERY", "20"))
DOWNLOAD_PHOTOS = os.environ.get("DOWNLOAD_PHOTOS", "1") == "1"

if not GKEY:
    sys.exit("ต้องตั้ง GOOGLE_MAPS_API_KEY ก่อน")

# ---------- 1. seed ----------
QUERIES = REG.get("seeds", [])
print(f"[{REGION_ID}] {REG['name']} — คำค้น {len(QUERIES)} รายการ, ศูนย์กลาง {ORIGIN['name']}")

# ---------- 2. Places Text Search ----------
FIELDS = ",".join([
    "places.id", "places.displayName", "places.formattedAddress", "places.location",
    "places.types", "places.primaryType", "places.primaryTypeDisplayName", "places.rating", "places.userRatingCount",
    "places.priceLevel", "places.priceRange", "places.regularOpeningHours", "places.currentOpeningHours", "places.parkingOptions",
    "places.reviews", "places.reviewSummary", "places.generativeSummary", "places.photos", "places.googleMapsUri", "places.googleMapsLinks",
    "places.editorialSummary", "places.businessStatus", "places.openingDate",
    "places.goodForGroups", "places.outdoorSeating", "places.reservable", "places.servesCocktails", "places.liveMusic", "places.evChargeOptions",
    "routingSummaries",
])

def text_search(query):
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {"X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": FIELDS, "Content-Type": "application/json"}
    body = {
        "textQuery": query, "languageCode": LANG, "regionCode": COUNTRY,
        "locationBias": {"circle": {"center": {"latitude": ORIGIN["lat"], "longitude": ORIGIN["lng"]}, "radius": RADIUS_M}},
        "pageSize": 20,
        "routingParameters": {"origin": {"latitude": ORIGIN["lat"], "longitude": ORIGIN["lng"]}, "travelMode": TRAVEL},
    }
    out, token = [], None
    while len(out) < MAX_PER_QUERY:
        if token:
            body["pageToken"] = token
        r = requests.post(url, headers=headers, json=body, timeout=30)
        if r.status_code != 200:
            print("  ! search error", r.status_code, r.text[:200]); break
        data = r.json()
        plist, rs = data.get("places", []), data.get("routingSummaries", [])
        for i, p in enumerate(plist):   # เวลาเดินทางจากจุดศูนย์กลางมากับผลค้นหาเลย
            legs = (rs[i] if i < len(rs) else {}).get("legs") or []
            if legs:
                p["_route"] = (round(sum(int(l.get("duration", "0s").rstrip("s")) for l in legs) / 60),
                               round(sum(l.get("distanceMeters", 0) for l in legs) / 1000, 1))
        out += plist
        token = data.get("nextPageToken")
        if not token: break
        time.sleep(1.5)
    return out[:MAX_PER_QUERY]

raw = {}
# ร้านที่ผู้ใช้เพิ่มเองจากหน้าเว็บ (ส่งออกเป็น manual.json) -> ค้นด้วยชื่อ เอาผลแรก
manual_path = OUT_DIR / f"manual.{REGION_ID}.json"
if manual_path.exists():
    for m in json.loads(manual_path.read_text(encoding="utf-8")):
        q = m["name"] if REG["name"] in m["name"] else f"{m['name']} {REG['name']}"
        res = text_search(q)[:1]
        print(f"  [manual] {m['name']}: {'พบ ' + res[0]['displayName']['text'] if res else 'ไม่พบ'}")
        for p in res:
            p["_manual_note"] = m.get("note"); p["_manual_url"] = m.get("url")
            raw.setdefault(p["id"], p)
for q in QUERIES:
    res = text_search(q)
    print(f"  {q}: {len(res)}")
    for p in res:
        if p.get("businessStatus", "OPERATIONAL") != "OPERATIONAL": continue
        raw.setdefault(p["id"], p)
print(f"รวม {len(raw)} สถานที่ (ไม่ซ้ำ)")

# ---------- ประเภท ----------
TYPE_MAP = [
    (("cafe", "coffee_shop", "bakery", "dessert_shop", "ice_cream_shop", "tea_house"), "คาเฟ่"),
    (("bar", "pub", "wine_bar", "night_club"), "บาร์"),
    (("restaurant", "food", "meal_takeaway", "noodle", "thai_restaurant"), "ร้านอาหาร"),
    (("hindu_temple", "buddhist_temple", "place_of_worship", "church", "mosque"), "วัด"),
    (("market", "shopping_mall", "night_market"), "ตลาด"),
    (("park", "national_park", "hiking_area", "campground", "waterfall", "garden", "natural_feature", "lake", "reservoir"), "ธรรมชาติ"),
    (("tourist_attraction", "museum", "art_gallery", "zoo", "amusement_park", "water_park", "historical_landmark", "cultural_center", "aquarium"), "ที่เที่ยว"),
]
CUISINE_MAP = [
    ("japanese", "ญี่ปุ่น"), ("sushi", "ญี่ปุ่น"), ("ramen", "ญี่ปุ่น"), ("korean", "เกาหลี"), ("chinese", "จีน"),
    ("thai", "ไทย"), ("italian", "อิตาเลียน"), ("pizza", "อิตาเลียน"), ("american", "อเมริกัน"), ("hamburger", "อเมริกัน"),
    ("steak", "สเต็ก"), ("seafood", "ซีฟู้ด"), ("vietnamese", "เวียดนาม"), ("indian", "อินเดีย"), ("mexican", "เม็กซิกัน"),
    ("french", "ฝรั่งเศส"), ("mediterranean", "เมดิเตอร์เรเนียน"), ("middle_eastern", "ตะวันออกกลาง"), ("vegan", "มังสวิรัติ"),
    ("vegetarian", "มังสวิรัติ"), ("barbecue", "ปิ้งย่าง"), ("noodle", "ก๋วยเตี๋ยว"), ("breakfast", "อาหารเช้า"), ("brunch", "อาหารเช้า"),
]
def map_cuisine(p):
    types = [p.get("primaryType", "")] + p.get("types", [])
    for key, label in CUISINE_MAP:
        if any(key in t for t in types): return label
    return None

def map_type(p):
    types = [p.get("primaryType", "")] + p.get("types", [])
    for keys, label in TYPE_MAP:
        if any(any(k in t for k in keys) for t in types): return label
    return "ที่เที่ยว"

PRICE = {"PRICE_LEVEL_FREE": 0, "PRICE_LEVEL_INEXPENSIVE": 1, "PRICE_LEVEL_MODERATE": 2,
         "PRICE_LEVEL_EXPENSIVE": 3, "PRICE_LEVEL_VERY_EXPENSIVE": 3}

def price_range(p):
    pr = p.get("priceRange")
    if not pr: return None
    def n(x): return int(float(x.get("units", 0))) if x else None
    lo, hi = n(pr.get("startPrice")), n(pr.get("endPrice"))
    cur = (pr.get("startPrice") or pr.get("endPrice") or {}).get("currencyCode", "")
    sym = {"THB": "฿", "JPY": "¥", "USD": "$", "EUR": "€", "KRW": "₩"}.get(cur, cur + " ")
    if lo is not None and hi is not None: return f"{sym}{lo:,}–{hi:,}"
    if lo is not None: return f"{sym}{lo:,}+"
    return None

AMENITY_LABEL = {"goodForGroups": "กลุ่มใหญ่", "outdoorSeating": "นั่งกลางแจ้ง", "reservable": "จองได้", "servesCocktails": "ค็อกเทล", "liveMusic": "ดนตรีสด"}
def amenities(p):
    a = {k: bool(p.get(k)) for k in AMENITY_LABEL if p.get(k) is not None}
    a["ev"] = bool(p.get("evChargeOptions"))
    return a

def parse_hours(p):
    h = (p.get("currentOpeningHours") or p.get("regularOpeningHours") or {}).get("periods")
    if not h: return None
    out = {str(d): [] for d in range(7)}
    for per in h:
        o, c = per.get("open"), per.get("close")
        if not o: continue
        day = str(o.get("day", 0))
        ot = f"{o.get('hour',0):02d}:{o.get('minute',0):02d}"
        ct = f"{c.get('hour',0):02d}:{c.get('minute',0):02d}" if c else "23:59"
        out[day].append([ot, ct])
    return {d: (v if v else None) for d, v in out.items()}

def parking_from_api(p):
    po = p.get("parkingOptions")
    if not po: return None
    free = po.get("freeParkingLot") or po.get("freeStreetParking") or po.get("freeGarageParking")
    paid = po.get("paidParkingLot") or po.get("paidStreetParking") or po.get("paidGarageParking")
    if free: return {"status": "มี", "note": "มีที่จอดฟรี (ข้อมูล Google)"}
    if paid: return {"status": "มี", "note": "มีที่จอดแบบเสียค่าจอด (ข้อมูล Google)"}
    return None

# ---------- 3. Routes: นาทีจากประตูท่าแพ ----------
def route_matrix(dests):
    url = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
    headers = {"X-Goog-Api-Key": GKEY, "Content-Type": "application/json",
               "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition"}
    result = {}
    for i in range(0, len(dests), 100):
        chunk = dests[i:i+100]
        body = {
            "origins": [{"waypoint": {"location": {"latLng": {"latitude": ORIGIN["lat"], "longitude": ORIGIN["lng"]}}}}],
            "destinations": [{"waypoint": {"location": {"latLng": {"latitude": d[1], "longitude": d[2]}}}} for d in chunk],
            "travelMode": TRAVEL,
        }
        r = requests.post(url, headers=headers, json=body, timeout=60)
        if r.status_code != 200:
            print("  ! routes error", r.status_code, r.text[:200]); continue
        for row in r.json():
            if row.get("condition") != "ROUTE_EXISTS": continue
            pid = chunk[row["destinationIndex"]][0]
            sec = int(row.get("duration", "0s").rstrip("s"))
            result[pid] = (round(sec / 60), round(row.get("distanceMeters", 0) / 1000, 1))
    return result

drive = {pid: p["_route"] for pid, p in raw.items() if p.get("_route")}
dests = [(pid, p["location"]["latitude"], p["location"]["longitude"]) for pid, p in raw.items() if pid not in drive]
if dests:
    print(f"คำนวณเวลาเดินทางเพิ่ม (Routes API) {len(dests)} แห่งที่ไม่มี routingSummaries...")
    drive.update(route_matrix(dests))

# ---------- 4. Claude สรุปรีวิว ----------
client = None
if AKEY:
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=AKEY)
    except ImportError:
        print("ไม่มี package anthropic — ข้ามการสรุปรีวิว")

SUMMARY_PROMPT = """คุณกำลังสรุปรีวิวสถานที่ใน{region}สำหรับเว็บช่วยตัดสินใจ (ตอบเป็นภาษาไทย)
สถานที่: {name} (ประเภท: {ptype})
คำอธิบาย: {summary}
รีวิว:
{reviews}

ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น ไม่มี markdown:
{{
 "menu": ["เมนู/สิ่งที่คนแนะนำ สูงสุด 4 รายการ ถ้าเป็นที่เที่ยวให้ว่าง []"],
 "highlights": ["จุดเด่นที่คนพูดถึงซ้ำ ๆ สูงสุด 3 ข้อ สั้น ๆ ภาษาไทย"],
 "caveats": ["ข้อควรระวัง/ข้อเสียที่คนบ่น สูงสุด 2 ข้อ"],
 "parking": {{"status": "มี|จำกัด|ไม่มี|ไม่ทราบ", "note": "รายละเอียดที่จอดรถจากรีวิว หรือ \\"\\" ถ้าไม่มีใครพูดถึง"}},
 "opened": ปี ค.ศ. เป็นตัวเลข ถ้ารีวิวหรือคำอธิบายระบุ ไม่งั้น null,
 "tags": ["แท็กบรรยากาศ เช่น ครอบครัว วิวสวย ถ่ายรูป นั่งทำงานได้ พาสัตว์เลี้ยงได้ กลางคืน ราคาประหยัด สูงสุด 3"],
 "cuisine": "ถ้าเป็นร้านอาหาร ระบุสัญชาติ/แนว 1 คำ เช่น ไทย อาหารเหนือ ญี่ปุ่น เกาหลี จีน อิตาเลียน ซีฟู้ด ปิ้งย่าง ก๋วยเตี๋ยว หรือ null"
}}
ห้ามแต่งข้อมูลที่ไม่มีในรีวิว"""

def summarize(p, ptype):
    if not client: return {}
    revs = p.get("reviews", [])
    if not revs: return {}
    text = "\n".join(f"- ({r.get('rating','?')}★) {r.get('text',{}).get('text','')}"[:600] for r in revs)
    prompt = SUMMARY_PROMPT.format(region=REG["name"], name=p["displayName"]["text"], ptype=ptype,
                                   summary=p.get("editorialSummary", {}).get("text", "-"), reviews=text)
    try:
        msg = client.messages.create(model=AMODEL, max_tokens=600, messages=[{"role": "user", "content": prompt}])
        body = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        body = re.sub(r"```json|```", "", body).strip()
        return json.loads(body)
    except Exception as e:
        print("  ! summarize error", p["displayName"]["text"], e); return {}

# ---------- 5. ใกล้เคียง / ผ่านทาง ----------
def haversine_km(a, b):
    R = 6371; dlat = math.radians(b[0]-a[0]); dlng = math.radians(b[1]-a[1])
    x = math.sin(dlat/2)**2 + math.cos(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.sin(dlng/2)**2
    return 2*R*math.asin(math.sqrt(x))

def dist_to_segment_km(pt, a, b):
    # ประมาณบนระนาบ (พื้นที่เล็ก) : ระยะจากจุด pt ไปยังเส้น a->b และตำแหน่ง t (0..1)
    kx = math.cos(math.radians(a[0])) * 111.32; ky = 110.57
    ax, ay = 0, 0
    bx, by = (b[1]-a[1])*kx, (b[0]-a[0])*ky
    px, py = (pt[1]-a[1])*kx, (pt[0]-a[0])*ky
    L2 = bx*bx + by*by
    if L2 == 0: return math.hypot(px, py), 0
    t = max(0, min(1, (px*bx + py*by)/L2))
    return math.hypot(px - t*bx, py - t*by), t

# ---------- ประกอบผล ----------
print("สรุปรีวิวและประกอบข้อมูล...")
places = []
for pid, p in raw.items():
    if pid not in drive: continue
    ptype = map_type(p)
    cuisine = map_cuisine(p) if ptype in ("ร้านอาหาร", "คาเฟ่", "บาร์") else None
    s = summarize(p, ptype)
    amen = amenities(p)
    park = parking_from_api(p) or s.get("parking") or {"status": "ไม่ทราบ", "note": ""}
    if park.get("status") not in ("มี", "จำกัด", "ไม่มี"): park["status"] = "ไม่ทราบ"
    photo = None
    if DOWNLOAD_PHOTOS and p.get("photos"):
        (OUT_DIR / "photos" / REGION_ID).mkdir(parents=True, exist_ok=True)
        fn = OUT_DIR / "photos" / REGION_ID / f"{pid}.jpg"
        if not fn.exists():
            u = f"https://places.googleapis.com/v1/{p['photos'][0]['name']}/media?maxWidthPx=900&key={GKEY}"
            try:
                img = requests.get(u, timeout=30)
                if img.status_code == 200: fn.write_bytes(img.content)
            except Exception: pass
        if fn.exists(): photo = f"photos/{REGION_ID}/{pid}.jpg"
    places.append({
        "id": pid, "placeId": pid, "name": p["displayName"]["text"], "type": ptype, "cuisine": cuisine or s.get("cuisine") or ((p.get("primaryTypeDisplayName") or {}).get("text") if ptype == "ร้านอาหาร" else None),
        "lat": p["location"]["latitude"], "lng": p["location"]["longitude"],
        "minutes": drive[pid][0], "km": drive[pid][1],
        "rating": p.get("rating", 0), "count": p.get("userRatingCount", 0),
        "price": PRICE.get(p.get("priceLevel"), None), "priceRange": price_range(p),
        "opened": (p.get("openingDate") or {}).get("year") or s.get("opened"), "hours": parse_hours(p), "parking": park,
        "typeLabel": (p.get("primaryTypeDisplayName") or {}).get("text"),
        "gSummary": (p.get("reviewSummary") or {}).get("text", {}).get("text") or (p.get("generativeSummary") or {}).get("overview", {}).get("text"),
        "amen": amen, "links": p.get("googleMapsLinks") or None,
        "menu": s.get("menu", [])[:4], "highlights": s.get("highlights", [])[:3],
        "caveats": s.get("caveats", [])[:2], "tags": list(dict.fromkeys([AMENITY_LABEL[k] for k, v in amen.items() if v and k in AMENITY_LABEL] + s.get("tags", [])[:3])),
        "nearby": [], "onWay": [], "maps": p.get("googleMapsUri"), "photo": photo,
        "address": p.get("formattedAddress", ""),
        "note": p.get("_manual_note"), "url": p.get("_manual_url"),
    })
    time.sleep(0.2)

O = (ORIGIN["lat"], ORIGIN["lng"])
for a in places:
    A = (a["lat"], a["lng"])
    near, onway = [], []
    for b in places:
        if b is a: continue
        B = (b["lat"], b["lng"])
        d = haversine_km(A, B)
        if d <= 1.5: near.append((d, {"id": b["id"], "name": b["name"], "minutes": max(1, round(d/0.4))}))
        if a["km"] >= 5:
            ds, t = dist_to_segment_km(B, O, A)
            if ds <= 0.7 and 0.15 < t < 0.9: onway.append((t, {"id": b["id"], "name": b["name"]}))
    a["nearby"] = [x[1] for x in sorted(near)[:3]]
    a["onWay"] = [x[1] for x in sorted(onway)[:3]]

# ---------- 6. เขียนไฟล์ ----------
meta = {"sample": False, "region": REGION_ID, "updated": datetime.date.today().isoformat(), "origin": ORIGIN["name"],
        "originLat": ORIGIN["lat"], "originLng": ORIGIN["lng"], "count": len(places), "travelMode": TRAVEL}
(OUT_DIR / "data").mkdir(exist_ok=True)
js = (f"// สร้างโดย collect.py {REGION_ID} — ข้อมูลจาก Google Places / Routes\n"
      "window.PLACES_DATA = window.PLACES_DATA || {};\n"
      f"window.PLACES_DATA[{json.dumps(REGION_ID)}] = {{ meta: {json.dumps(meta, ensure_ascii=False)},\n"
      f"places: {json.dumps(places, ensure_ascii=False, indent=1)} }};\n")
(OUT_DIR / "data" / f"{REGION_ID}.js").write_text(js, encoding="utf-8")
(OUT_DIR / "data" / f"{REGION_ID}.json").write_text(json.dumps(places, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"เสร็จ: {len(places)} สถานที่ -> data/{REGION_ID}.js")

// ตั้งค่าหน้าเว็บ
window.CONFIG = {
  googleMapsKey: "",          // ใส่ Google Maps JavaScript API key แล้วแผนที่จะสลับจาก OpenStreetMap เป็น Google Maps อัตโนมัติ
  defaultRegion: "chiangmai",
  // พื้นที่ร่วม (ใช้ด้วยกันหลายเครื่อง/หลายคน) — ใส่ค่าจาก Supabase → Settings → API แล้วรัน supabase.sql ก่อน
  supabaseUrl: "",            // เช่น https://xxxx.supabase.co
  supabaseAnonKey: "",        // anon public key (ใส่ในเบราว์เซอร์ได้ ไม่ใช่ service_role)
  // ปุ่มแนะนำ (mood) — ใช้ร่วมทุกภูมิภาค; ใช้ได้ทั้ง types / cuisines / tags / mins / openNow; ภูมิภาคไหนอยากมีชุดของตัวเองให้ใส่ "presets" ใน regions.js
  presets: [
    { label: "หิวแล้ว ใกล้ ๆ",  types: ["ร้านอาหาร"], mins: 15, openNow: true },
    { label: "อาหารไทย/เหนือ",  cuisines: ["ไทย","อาหารเหนือ","ก๋วยเตี๋ยว"], mins: 30 },
    { label: "ญี่ปุ่น",          cuisines: ["ญี่ปุ่น"], mins: 30 },
    { label: "เกาหลี",           cuisines: ["เกาหลี"], mins: 30 },
    { label: "ฝรั่ง/อิตาเลียน",  cuisines: ["อิตาเลียน","อเมริกัน","สเต็ก","ฝรั่งเศส"], mins: 30 },
    { label: "ปิ้งย่าง/ซีฟู้ด",   cuisines: ["ปิ้งย่าง","ซีฟู้ด"], mins: 30 },
    { label: "คาเฟ่นั่งชิล",     types: ["คาเฟ่"], mins: 30 },
    { label: "ไปกันหลายคน",      tags: ["กลุ่มใหญ่"], mins: 30 },
    { label: "นั่งกลางแจ้ง",      tags: ["นั่งกลางแจ้ง"], mins: 45 },
    { label: "ดื่ม/ดนตรีสด",      tags: ["ค็อกเทล","ดนตรีสด"], mins: 20, openNow: true },
    { label: "วิวสวย",           tags: ["วิวสวย"], mins: 120 },
    { label: "เที่ยวทั้งวัน",     types: ["ธรรมชาติ","ที่เที่ยว"], mins: 120 },
    { label: "หาของฝาก",         types: ["ตลาด"], mins: 20 },
    { label: "ค่ำนี้",           openNow: true, mins: 20, types: ["ร้านอาหาร","ตลาด","บาร์"] }
  ]
};

-- รันใน Supabase → SQL Editor (ครั้งเดียว)
create table if not exists spaces (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table spaces enable row level security;
-- ใครก็ตามที่รู้ id (สุ่มยาว 24 ตัว เดาไม่ได้) อ่าน/เขียนได้ — ไม่ต้องล็อกอิน
create policy "anon read"   on spaces for select to anon using (true);
create policy "anon insert" on spaces for insert to anon with check (true);
create policy "anon update" on spaces for update to anon using (true) with check (true);
-- เปิด realtime ให้ตารางนี้
alter publication supabase_realtime add table spaces;

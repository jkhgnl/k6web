-- ============================================================
-- K6Web 卫星收藏云同步 - 数据库迁移
-- user_favorites：收藏表，绑定账号跨设备同步
-- ============================================================

create table if not exists public.user_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  norad_id text not null,          -- NORAD 编号（字符串，兼容 "07530" 这类）
  created_at timestamptz not null default now(),
  unique(user_id, norad_id)
);

create index if not exists idx_user_favorites_user on public.user_favorites(user_id);

alter table public.user_favorites enable row level security;

-- 只能读取自己的收藏
create policy "Owner read favorites" on public.user_favorites
  for select using (auth.uid() = user_id);

-- 登录用户只能插入自己的收藏
create policy "Owner insert favorites" on public.user_favorites
  for insert with check (auth.uid() = user_id);

-- 用户可删除自己的收藏
create policy "Owner delete favorites" on public.user_favorites
  for delete using (auth.uid() = user_id);

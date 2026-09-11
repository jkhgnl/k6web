-- ============================================================
-- K6Web 友情链接 - 友链记录
-- friend_links：网站名称/简介/头像链接/网站链接，仅管理员可写，公开可读
-- ============================================================

create table if not exists public.friend_links (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  avatar_url text,
  site_url text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_friend_links_order on public.friend_links(display_order asc, created_at desc);
create index if not exists idx_friend_links_created on public.friend_links(created_at desc);

alter table public.friend_links enable row level security;

-- 公开可读（友链对所有访客可见）
drop policy if exists "friend_links_select_public" on public.friend_links;
create policy "friend_links_select_public" on public.friend_links
  for select using (true);

-- 写操作默认拒绝，仅 service_role（Edge Function）可写
-- 不创建 insert/update/delete 的 permissive 策略，Edge Function 使用 service_role 绕过 RLS 并自行校验管理员

-- updated_at 自动刷新
create or replace function public.touch_friend_links_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists friend_links_touch on public.friend_links;
create trigger friend_links_touch
  before update on public.friend_links
  for each row execute procedure public.touch_friend_links_updated_at();

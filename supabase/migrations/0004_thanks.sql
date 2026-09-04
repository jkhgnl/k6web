-- ============================================================
-- K6Web 鸣谢榜 - 请他喝咖啡内的感谢名单
-- thanks：鸣谢记录，含呼号字段，仅管理员可写，公开可读
-- ============================================================

create table if not exists public.thanks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  callsign text,
  amount numeric,
  message text,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_thanks_order on public.thanks(display_order asc, created_at desc);
create index if not exists idx_thanks_created on public.thanks(created_at desc);

alter table public.thanks enable row level security;

-- 公开可读（鸣谢榜对所有访客可见）
drop policy if exists "thanks_select_public" on public.thanks;
create policy "thanks_select_public" on public.thanks
  for select using (true);

-- 写操作默认拒绝，仅 service_role（Edge Function）可写
-- 不创建 insert/update/delete 的 permissive 策略，Edge Function 使用 service_role 绕过 RLS 并自行校验管理员

-- updated_at 自动刷新
create or replace function public.touch_thanks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists thanks_touch on public.thanks;
create trigger thanks_touch
  before update on public.thanks
  for each row execute procedure public.touch_thanks_updated_at();

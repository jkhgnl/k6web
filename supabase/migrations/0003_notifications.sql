-- ============================================================
-- K6Web 站内信与通知功能
-- notifications：通知表
-- ============================================================

-- ---------- 通知表 ----------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,           -- 'reply' | 'mention' | 'system'
  title text not null,
  content text,
  from_user_id uuid references public.profiles(id) on delete set null,
  from_username text,
  item_id uuid,                 -- 关联的工坊作品或评论
  item_type text,               -- 'workshop' | 'feedback'
  comment_id uuid,              -- 关联的评论
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications(user_id, is_read) where is_read = false;

alter table public.notifications enable row level security;

-- 用户只能读自己的通知
create policy "notifications_select_own" on public.notifications
  for select using (auth.uid() = user_id);

-- 用户只能更新自己的通知（标记已读）
create policy "notifications_update_own" on public.notifications
  for update using (auth.uid() = user_id);

-- 用户只能删除自己的通知
create policy "notifications_delete_own" on public.notifications
  for delete using (auth.uid() = user_id);

-- 系统可以插入通知（Edge Function 用 service_role key）
create policy "notifications_insert_system" on public.notifications
  for insert with check (true);

-- ---------- 未读通知数函数 ----------
create or replace function public.get_unread_count(uid uuid)
returns integer
language sql
security definer
stable
as $$
  select count(*)::integer from public.notifications where user_id = uid and is_read = false;
$$;

-- ---------- 标记单条已读 ----------
create or replace function public.mark_notification_read(nid uuid)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.notifications set is_read = true where id = nid and user_id = auth.uid();
  return found;
end;
$$;

-- ---------- 标记全部已读 ----------
create or replace function public.mark_all_read(uid uuid)
returns void
language sql
security definer
as $$
  update public.notifications set is_read = true where user_id = uid and is_read = false;
$$;

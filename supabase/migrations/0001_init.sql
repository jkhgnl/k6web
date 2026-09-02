-- ============================================================
-- K6Web 创意工坊 - 初始化
-- profiles：用户资料（扩展 Supabase 内置 auth.users）
-- workshop_items：创意工坊作品
-- ============================================================

-- ---------- 用户资料 ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 注册后自动创建 profile（通过 trigger 监听 auth.users）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'user_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    ),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 公开可读自己的资料；可修改自己的用户名/头像
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- ---------- 创意工坊作品 ----------
create table if not exists public.workshop_items (
  id uuid primary key default gen_random_uuid(),
  -- 注意：外键指向 profiles(id) 而非 auth.users(id)，
  -- 使 PostgREST 能直接 embed profiles(username, avatar_url)（id 与 auth.users 相同）
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  category text not null default 'other', -- theme / channel / extension / other
  file_path text not null,               -- Supabase Storage 路径
  file_name text not null,               -- 原始文件名
  file_size bigint not null default 0,
  download_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workshop_items_category_idx on public.workshop_items(category);
create index if not exists workshop_items_created_idx on public.workshop_items(created_at desc);

alter table public.workshop_items enable row level security;

-- 列表/详情公开可读
create policy "workshop_select_public" on public.workshop_items
  for select using (true);

-- 登录后可上传（行里带上自己的 user_id）
create policy "workshop_insert_auth" on public.workshop_items
  for insert with check (auth.uid() = user_id);

-- 仅本人可更新/删除自己的作品
create policy "workshop_update_own" on public.workshop_items
  for update using (auth.uid() = user_id);
create policy "workshop_delete_own" on public.workshop_items
  for delete using (auth.uid() = user_id);

-- 更新 updated_at 触发器
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workshop_items_touch on public.workshop_items;
create trigger workshop_items_touch
  before update on public.workshop_items
  for each row execute procedure public.touch_updated_at();

-- 原子自增下载计数
create or replace function public.increment_download_count(item_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  new_count integer;
begin
  update public.workshop_items
  set download_count = download_count + 1
  where id = item_id
  returning download_count into new_count;
  return new_count;
end;
$$;

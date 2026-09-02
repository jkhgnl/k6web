-- ============================================================
-- K6Web 评论功能 - 数据库迁移
-- comments：评论表
-- comment_likes：评论点赞表
-- ============================================================

-- ---------- 评论表 ----------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null,           -- 关联的工坊作品 ID 或反馈区固定 ID
  item_type text not null default 'workshop',  -- 'workshop' 或 'feedback'
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  parent_id uuid references public.comments(id) on delete cascade,  -- 嵌套回复
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_comments_item on public.comments(item_id, item_type);
create index if not exists idx_comments_parent on public.comments(parent_id);
create index if not exists idx_comments_user on public.comments(user_id);

alter table public.comments enable row level security;

-- 公开读取
create policy "Public read comments" on public.comments
  for select using (true);

-- 登录用户可插入（只能插入自己的评论）
create policy "Authenticated insert comments" on public.comments
  for insert with check (auth.uid() = user_id);

-- 作者可删除自己的评论
create policy "Owner delete comments" on public.comments
  for delete using (auth.uid() = user_id);

-- 作者可更新自己的评论
create policy "Owner update comments" on public.comments
  for update using (auth.uid() = user_id);

-- 更新 updated_at 触发器
create or replace function public.touch_comment_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists comments_touch on public.comments;
create trigger comments_touch
  before update on public.comments
  for each row execute procedure public.touch_comment_updated_at();

-- ---------- 评论点赞表 ----------
create table if not exists public.comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(comment_id, user_id)  -- 防止重复点赞
);

create index if not exists idx_comment_likes_comment on public.comment_likes(comment_id);
create index if not exists idx_comment_likes_user on public.comment_likes(user_id);

alter table public.comment_likes enable row level security;

-- 公开读取
create policy "Public read likes" on public.comment_likes
  for select using (true);

-- 登录用户可插入（只能插入自己的点赞）
create policy "Authenticated insert likes" on public.comment_likes
  for insert with check (auth.uid() = user_id);

-- 用户可删除自己的点赞
create policy "Owner delete likes" on public.comment_likes
  for delete using (auth.uid() = user_id);

-- ---------- 统计评论点赞数的函数 ----------
create or replace function public.get_comment_likes_count(comment_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  like_count integer;
begin
  select count(*) into like_count
  from public.comment_likes
  where comment_likes.comment_id = $1;
  return like_count;
end;
$$;

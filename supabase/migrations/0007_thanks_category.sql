-- ============================================================
-- K6Web 鸣谢榜 - 增加类别字段，区分首批内测用户与赞助支持用户
-- category: 'beta' = 首批内测用户；'sponsor' = 赞助支持用户（默认）
-- 存量记录均为赞助类，"请他喝咖啡"弹窗鸣谢榜行为不变
-- ============================================================

alter table public.thanks add column if not exists category text not null default 'sponsor';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'thanks_category_check'
  ) then
    alter table public.thanks
      add constraint thanks_category_check check (category in ('sponsor', 'beta'));
  end if;
end;
$$;

create index if not exists idx_thanks_category on public.thanks(category, display_order asc, created_at desc);

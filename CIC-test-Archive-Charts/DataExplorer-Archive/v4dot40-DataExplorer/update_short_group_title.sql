with tokens as (
  select
    g.id,
    g.category_title,
    w.idx,
    w.token
  from public.naei_global_t_category g
  cross join lateral (
    select w as token, idx
    from regexp_split_to_table(coalesce(g.category_title, ''), E'[^A-Za-z0-9]+') with ordinality as w(w, idx)
  ) w
  where w.token <> ''
),
rtb_scan as (
  select
    tok.id,
    tok.category_title,
    tok.idx,
    tok.token,
    case
      when lower(tok.token) = 'ready'
       and lead(lower(tok.token), 1) over (partition by tok.id order by tok.idx) = 'to'
       and lead(lower(tok.token), 2) over (partition by tok.id order by tok.idx) = 'burn'
      then true else false
    end as is_rtb_start
  from tokens tok
),
rtb_marks as (
  select
    s.*,
    lag(s.is_rtb_start, 1) over (partition by s.id order by s.idx) as prev_is_rtb_start,
    lag(s.is_rtb_start, 2) over (partition by s.id order by s.idx) as prev2_is_rtb_start
  from rtb_scan s
),
mapped as (
  select
    r.id,
    r.category_title,
    r.idx,
    r.token,
    m.replacement,
    case
      when r.is_rtb_start then 'RtB'
      when coalesce(r.prev_is_rtb_start, false) or coalesce(r.prev2_is_rtb_start, false) then null
      when lower(r.token) in ('ready','to','burn') then null
      when m.original_phrase is not null and (m.replacement = '' or lower(m.replacement) = 'null') then null
      when m.original_phrase is not null then m.replacement
      else case when length(r.token) <= 4 then r.token else substr(r.token, 1, 3) end
    end as chosen_raw
  from rtb_marks r
  left join public.naei_group_title_mapping m
    on lower(r.token) = lower(m.original_phrase)
),
capitalized as (
  select
    id,
    category_title,
    idx,
    case when chosen_raw is null then null else initcap(lower(chosen_raw)) end as piece
  from mapped
),
assembled as (
  select
    id,
    category_title,
    string_agg(piece, '' order by idx) as proposed_short
  from capitalized
  where piece is not null
  group by id, category_title
),
with_special as (
  select
    a.id,
    case
      when lower(trim(a.category_title)) = lower('Ecodesign Stove - Ready To Burn') then 'EcoRtB'
      else a.proposed_short
    end as short_name
  from assembled a
)
update public.naei_global_t_category g
set short_category_title = ws.short_name
from with_special ws
where ws.id = g.id;

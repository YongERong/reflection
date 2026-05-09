create type public.user_role as enum ('student', 'teacher', 'admin');
create type public.gibbs_stage as enum (
  'description',
  'people',
  'feelings',
  'evaluation',
  'analysis',
  'conclusion',
  'action_plan'
);
create type public.reflection_status as enum ('in_progress', 'completed');
create type public.mood_preset as enum ('gentle', 'encouraging', 'curious', 'concise', 'coach-like');
create type public.skill_permission as enum ('safe', 'sensitive', 'admin');
create type public.safety_concern_status as enum ('open', 'reviewed', 'resolved');

create table public.teacher_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role public.user_role not null default 'teacher',
  created_at timestamptz not null default now()
);

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  school_name text,
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  program_id uuid references public.programs (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.class_teachers (
  class_id uuid not null references public.classes (id) on delete cascade,
  teacher_id uuid not null references public.teacher_profiles (id) on delete cascade,
  primary key (class_id, teacher_id)
);

create table public.student_profiles (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique,
  display_name text not null,
  class_id uuid references public.classes (id) on delete set null,
  program_id uuid references public.programs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.prompt_configs (
  id uuid primary key default gen_random_uuid(),
  program_id uuid references public.programs (id) on delete cascade,
  version integer not null,
  mood public.mood_preset not null default 'gentle',
  starting_message_template text not null,
  school_context jsonb not null default '{}'::jsonb,
  summary_format text not null default 'bullet_actionables',
  enabled_skills text[] not null default array[
    'ask_next_gibbs_question',
    'summarize_reflection',
    'extract_actionables',
    'propose_memory_update',
    'detect_safety_concern',
    'generate_teacher_summary'
  ],
  created_by uuid references public.teacher_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (program_id, version)
);

create table public.student_memory (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  kind text not null check (kind in ('profileFact', 'recurringTheme', 'strength', 'goal', 'preferredStyle')),
  value text not null,
  source_reflection_id uuid,
  reason text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.reflections (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  prompt_config_id uuid references public.prompt_configs (id) on delete set null,
  current_stage public.gibbs_stage not null default 'description',
  status public.reflection_status not null default 'in_progress',
  answers jsonb not null default '{}'::jsonb,
  teacher_visible boolean not null default false,
  safety_flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reflection_turns (
  id uuid primary key default gen_random_uuid(),
  reflection_id uuid not null references public.reflections (id) on delete cascade,
  role text not null check (role in ('student', 'bot')),
  stage public.gibbs_stage not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table public.reflection_summaries (
  reflection_id uuid primary key references public.reflections (id) on delete cascade,
  brief_summary text not null,
  key_learnings text[] not null default '{}',
  actionables text[] not null default '{}',
  teacher_summary text,
  teacher_visible boolean not null default false,
  prompt_config_id uuid references public.prompt_configs (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.skill_runs (
  id uuid primary key default gen_random_uuid(),
  reflection_id uuid references public.reflections (id) on delete cascade,
  skill_name text not null,
  permission public.skill_permission not null,
  input jsonb not null,
  output jsonb not null,
  persisted boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.safety_concerns (
  id uuid primary key default gen_random_uuid(),
  reflection_id uuid not null references public.reflections (id) on delete cascade,
  student_id uuid not null references public.student_profiles (id) on delete cascade,
  stage public.gibbs_stage not null,
  student_turn_id uuid references public.reflection_turns (id) on delete set null,
  reason text not null,
  message_snippet text not null,
  status public.safety_concern_status not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.teacher_profiles (id) on delete set null
);

alter table public.teacher_profiles enable row level security;
alter table public.programs enable row level security;
alter table public.classes enable row level security;
alter table public.class_teachers enable row level security;
alter table public.student_profiles enable row level security;
alter table public.prompt_configs enable row level security;
alter table public.student_memory enable row level security;
alter table public.reflections enable row level security;
alter table public.reflection_turns enable row level security;
alter table public.reflection_summaries enable row level security;
alter table public.skill_runs enable row level security;
alter table public.safety_concerns enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.teacher_profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.can_view_student(student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1
    from public.student_profiles sp
    join public.class_teachers ct on ct.class_id = sp.class_id
    where sp.id = student and ct.teacher_id = auth.uid()
  );
$$;

create policy "teachers read own profile"
  on public.teacher_profiles for select
  using (id = auth.uid() or public.is_admin());

create policy "admins manage programs"
  on public.programs for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "teachers read assigned classes"
  on public.classes for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.class_teachers
      where class_teachers.class_id = classes.id and class_teachers.teacher_id = auth.uid()
    )
  );

create policy "teachers read assigned students"
  on public.student_profiles for select
  using (public.can_view_student(id));

create policy "teachers read visible summaries"
  on public.reflection_summaries for select
  using (
    teacher_visible and exists (
      select 1 from public.reflections r
      where r.id = reflection_summaries.reflection_id and public.can_view_student(r.student_id)
    )
  );

create policy "admins read prompt configs"
  on public.prompt_configs for select
  using (public.is_admin());

create policy "admins insert prompt configs"
  on public.prompt_configs for insert
  with check (public.is_admin());

create policy "teachers read student memory themes"
  on public.student_memory for select
  using (
    active and public.can_view_student(student_id)
  );

create policy "admins read skill runs"
  on public.skill_runs for select
  using (public.is_admin());

create policy "teachers read assigned safety concerns"
  on public.safety_concerns for select
  using (public.can_view_student(student_id));

create policy "admins update safety concerns"
  on public.safety_concerns for update
  using (public.is_admin())
  with check (public.is_admin());

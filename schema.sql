-- -------------------------------------------------------------
-- ELUNO AI SYSTEM - SUPABASE DATABASE INITIALIZATION SCHEMA
-- -------------------------------------------------------------

-- Create user profiles table linked to Supabase Auth
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  full_name text,
  role text default 'operator' check (role in ('operator', 'administrator', 'viewer')) not null
);

-- Enable Row Level Security (RLS) on profiles
alter table public.profiles enable row level security;

-- Drop existing policies if any to prevent errors on re-run
drop policy if exists "Allow public read access to profiles" on public.profiles;
drop policy if exists "Allow users to update their own profile" on public.profiles;

-- Create policies for profiles
create policy "Allow public read access to profiles"
  on public.profiles for select
  using (true);

create policy "Allow users to update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Create trigger function to automatically create a profile for new auth users
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'System Operator'),
    coalesce(new.raw_user_meta_data->>'role', 'operator')
  );
  return new;
end;
$$ language plpgsql security definer;

-- Bind the trigger function to user registration event
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -------------------------------------------------------------
-- ORDERS TABLE & PERSISTENCE CONFIGURATION
-- -------------------------------------------------------------

-- Create sequence for sequential Eluno Order ID numbers (starting at 1000)
create sequence if not exists public.orders_order_number_seq start with 1000;

-- Create orders table
create table if not exists public.orders (
  id text primary key default ('EL-' || nextval('public.orders_order_number_seq')::text),
  patient_name text not null,
  patient_email text not null,
  sph text not null,
  cyl text not null,
  lens_type text not null,
  index_value text not null,
  coating text not null,
  store text not null,
  stage text default 'Intake' not null check (stage in ('Intake', 'Stocked at Inventary', 'Lab Surfacing', 'Coating', 'Mounting', 'QC', 'Dispatch', 'Delivered')),
  sla_remaining integer not null,
  sla_total integer not null,
  risk_probability integer default 0 not null,
  history jsonb default '[]'::jsonb,
  delay_reason text default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table public.orders enable row level security;

-- Drop existing policies if any to prevent errors on re-run
drop policy if exists "Allow authenticated select on orders" on public.orders;
drop policy if exists "Allow authenticated insert on orders" on public.orders;
drop policy if exists "Allow authenticated update on orders" on public.orders;

-- Create policies for orders (open to all authenticated operators/administrators)
create policy "Allow authenticated select on orders"
  on public.orders for select
  to authenticated
  using (true);

create policy "Allow authenticated insert on orders"
  on public.orders for insert
  to authenticated
  with check (true);

create policy "Allow authenticated update on orders"
  on public.orders for update
  to authenticated
  using (true);

-- -------------------------------------------------------------
-- LENS INVENTORY TABLE & PERSISTENCE CONFIGURATION
-- -------------------------------------------------------------

-- Create inventory table
create table if not exists public.inventory (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  type text not null check (type in ('lens', 'coating')),
  lens_index text not null, -- e.g. '1.50', '1.67', 'N/A'
  qty integer not null default 0,
  min_limit integer not null default 10,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (name, lens_index)
);

-- Enable Row Level Security
alter table public.inventory enable row level security;

-- Drop existing policies if any to prevent errors on re-run
drop policy if exists "Allow authenticated select on inventory" on public.inventory;
drop policy if exists "Allow authenticated insert on inventory" on public.inventory;
drop policy if exists "Allow authenticated update on inventory" on public.inventory;

-- Create policies for inventory (open to all authenticated users)
create policy "Allow authenticated select on inventory"
  on public.inventory for select
  to authenticated
  using (true);

create policy "Allow authenticated insert on inventory"
  on public.inventory for insert
  to authenticated
  with check (true);

create policy "Allow authenticated update on inventory"
  on public.inventory for update
  to authenticated
  using (true);

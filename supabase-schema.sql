create extension if not exists pgcrypto;

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text unique,
  menu text,
  is_active boolean not null default true,
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text unique,
  photo_url text,
  vehicle_type text,
  is_active boolean not null default true,
  is_online boolean not null default false,
  current_order uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_phone text,
  vendor_id uuid references vendors(id) on delete set null,
  driver_id uuid references drivers(id) on delete set null,
  restaurant_name text not null,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(10,2) not null default 0,
  delivery_fee numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  delivery_address text,
  -- 'pending_payment' added: an order now exists in this state from the
  -- moment a Paystack link is generated until the webhook confirms payment.
  -- Vendors are never notified of an order while it's in this state.
  status text not null default 'pending_payment' check (status in ('pending_payment','pending_vendor','vendor_rejected','awaiting_driver','driver_assigned','picked_up','delivered','cancelled')),
  -- Payment tracking — set by the /webhook/paystack handler once Paystack
  -- confirms a charge.success event for this order's paystack_reference.
  -- 'unpaid' is the default so a freshly created order (before the customer
  -- has paid) is never mistaken for a paid one.
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','failed')),
  paystack_reference text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  vendor_accepted_at timestamptz,
  driver_assigned_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  estimated_prep_time_minutes integer,
  delivery_photo_url text,
  customer_confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- If you already have an `orders` table from before this change, run these
-- instead of relying on the CREATE TABLE above (which only applies to a
-- fresh table):
--   alter table orders add column if not exists payment_status text not null default 'unpaid';
--   alter table orders add column if not exists paystack_reference text unique;
--   alter table orders add column if not exists paid_at timestamptz;
--   alter table orders add column if not exists customer_confirmed_at timestamptz;
--   alter table orders drop constraint if exists orders_status_check;
--   alter table orders add constraint orders_status_check check (status in ('pending_payment','pending_vendor','vendor_rejected','awaiting_driver','driver_assigned','picked_up','delivered','cancelled'));
--   alter table orders add constraint orders_payment_status_check check (payment_status in ('unpaid','paid','failed'));

create index if not exists idx_orders_vendor_id on orders(vendor_id);
create index if not exists idx_orders_driver_id on orders(driver_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_paystack_reference on orders(paystack_reference);
create index if not exists idx_vendors_phone on vendors(phone);
create index if not exists idx_drivers_phone on drivers(phone);

alter table vendors enable row level security;
alter table drivers enable row level security;
alter table orders enable row level security;

create or replace function assign_driver_to_order(order_uuid uuid, driver_uuid uuid)
returns jsonb
language plpgsql
as $$
declare
  order_row orders%rowtype;
  driver_row drivers%rowtype;
begin
  select * into order_row from orders where id = order_uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  if order_row.status <> 'awaiting_driver' then
    return jsonb_build_object('ok', false, 'reason', 'order_not_available');
  end if;

  select * into driver_row from drivers where id = driver_uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'driver_not_found');
  end if;

  if driver_row.is_active = false or driver_row.is_online = false or driver_row.current_order is not null then
    return jsonb_build_object('ok', false, 'reason', 'driver_unavailable');
  end if;

  update orders
  set driver_id = driver_uuid,
      status = 'driver_assigned',
      driver_assigned_at = now(),
      updated_at = now()
  where id = order_uuid;

  update drivers
  set current_order = order_uuid,
      updated_at = now()
  where id = driver_uuid;

  return jsonb_build_object('ok', true, 'order_id', order_uuid, 'driver_id', driver_uuid);
end;
$$;
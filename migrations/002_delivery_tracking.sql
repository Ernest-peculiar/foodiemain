create table if not exists delivery_tracking (
  order_id uuid primary key references orders(id) on delete cascade,
  customer_token_hash text not null unique,
  rider_token_hash text not null unique,
  latitude double precision,
  longitude double precision,
  location_accuracy double precision,
  location_updated_at timestamptz,
  destination_latitude double precision,
  destination_longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table delivery_tracking enable row level security;

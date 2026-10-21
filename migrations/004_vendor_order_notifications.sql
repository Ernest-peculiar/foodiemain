alter table orders
  add column if not exists vendor_notified_at timestamptz;

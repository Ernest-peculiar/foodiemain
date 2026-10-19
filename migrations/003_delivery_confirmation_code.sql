alter table orders
  add column if not exists delivery_code_hash text;

alter table orders
  add column if not exists delivery_code_attempts integer not null default 0;

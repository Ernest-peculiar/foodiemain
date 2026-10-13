alter table vendors
  add column if not exists paystack_subaccount_code text;

alter table orders
  add column if not exists payment_processing_fee numeric(10,2) not null default 0;
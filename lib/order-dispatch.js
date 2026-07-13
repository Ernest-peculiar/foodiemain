const ORDER_STATUS_VALUES = [
  'pending_vendor',
  'vendor_rejected',
  'awaiting_driver',
  'driver_assigned',
  'picked_up',
  'delivered',
  'cancelled'
];

function isValidStatus(status) {
  return ORDER_STATUS_VALUES.includes(status);
}

function normalizeOrderForResponse(order) {
  return {
    ...order,
    status: order?.status || 'pending_vendor'
  };
}

// FIXED: the old lookup did
//   .or(phone ? `phone.eq.${phone}` : '').ilike('name', name)
// which, whenever `phone` was falsy (e.g. an order built from the "Reorder"
// one-tap flow, which never carries a phone), called `.or('')` — an invalid
// empty OR filter. That request errors out, `existing` comes back
// undefined, and the code falls through to INSERT, silently creating a
// *duplicate* vendor row with phone: null. Any order whose vendor_id points
// at that duplicate then fails to notify the real vendor (their phone is
// null on that row), which looks like "the vendor gets nothing" for that
// order — including the driver's delivery photo.
//
// Fixed to look up by phone FIRST (the real unique identifier, when we have
// one) and only fall back to a name match if there's no phone to go on —
// never calling `.or()` with an empty/invalid filter.
async function upsertVendor(supabase, vendor) {
  if (!supabase) return null;

  const name = (vendor?.name || '').trim();
  const phone = vendor?.phone || null;
  if (!name) return null;

  let existing = null;

  if (phone) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, is_active, is_open')
      .eq('phone', phone)
      .maybeSingle();

    if (error) {
      console.error('Vendor lookup by phone failed:', error.message);
    } else {
      existing = data;
    }
  }

  // Only fall back to a name-only match when we have no phone to key off of
  // (or the phone lookup found nothing) — this is the path a phoneless
  // "Reorder" vendor object now safely takes, instead of silently creating
  // a duplicate.
  if (!existing) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, is_active, is_open')
      .ilike('name', name)
      .maybeSingle();

    if (error) {
      console.error('Vendor lookup by name failed:', error.message);
    } else {
      existing = data;
    }
  }

  if (existing?.id) {
    const { data, error } = await supabase
      .from('vendors')
      .update({
        name,
        // Never clobber a real saved phone number with a missing one —
        // only write `phone` if this call actually supplied one.
        phone: phone || existing.phone,
        menu: vendor?.menu ?? existing.menu ?? null,
        is_active: vendor?.isActive ?? existing.is_active ?? true,
        is_open: vendor?.isOpen ?? existing.is_open ?? true,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select('id, name, phone, menu, is_active, is_open')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  const inserted = {
    name,
    phone,
    menu: vendor?.menu ?? null,
    is_active: vendor?.isActive ?? true,
    is_open: vendor?.isOpen ?? true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('vendors')
    .insert(inserted)
    .select('id, name, phone, is_active, is_open')
    .maybeSingle();

  if (error) throw error;
  return data;
}

// UPDATED: now also accepts/persists `photoUrl` (-> photo_url) and
// `vehicleType` (-> vehicle_type). Both are optional/nullable so this stays
// backward compatible with any existing callers that don't pass them (e.g.
// setDriverAvailability below only ever toggles is_online and won't
// accidentally wipe out a driver's saved photo/vehicle type, since the ??
// fallback preserves whatever's already on the row).
//
// REQUIRES two new nullable columns on the `drivers` table — run this once
// in Supabase if they don't already exist:
//
//   alter table drivers add column if not exists photo_url text;
//   alter table drivers add column if not exists vehicle_type text;
async function upsertDriver(supabase, driver) {
  if (!supabase) return null;

  const name = (driver?.name || '').trim();
  const phone = driver?.phone || null;
  if (!name && !phone) return null;

  // FIXED: same class of bug as upsertVendor above — `.or(phone ? ... : '')`
  // called `.or('')` (an invalid empty filter) whenever `phone` was falsy,
  // which would error out and silently fall through to an INSERT, creating
  // a duplicate driver row. Guarding the lookup so it only runs when we
  // actually have a phone to match on avoids that.
  let existing = null;
  if (phone) {
    const { data, error: lookupError } = await supabase
      .from('drivers')
      .select('id, name, phone, is_active, is_online, current_order, photo_url, vehicle_type')
      .eq('phone', phone)
      .maybeSingle();

    if (lookupError) {
      console.error('Driver lookup failed:', lookupError.message);
    } else {
      existing = data;
    }
  }


  if (existing?.id) {
    const { data, error } = await supabase
      .from('drivers')
      .update({
        name: name || existing.name,
        phone: phone || existing.phone,
        is_active: driver?.isActive ?? existing.is_active ?? true,
        is_online: driver?.isOnline ?? existing.is_online ?? false,
        current_order: driver?.currentOrder ?? existing.current_order ?? null,
        photo_url: driver?.photoUrl ?? existing.photo_url ?? null,
        vehicle_type: driver?.vehicleType ?? existing.vehicle_type ?? null,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select('id, name, phone, is_active, is_online, current_order, photo_url, vehicle_type')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  const inserted = {
    name: name || 'Driver',
    phone,
    is_active: driver?.isActive ?? true,
    is_online: driver?.isOnline ?? false,
    current_order: driver?.currentOrder ?? null,
    photo_url: driver?.photoUrl ?? null,
    vehicle_type: driver?.vehicleType ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('drivers')
    .insert(inserted)
    .select('id, name, phone, is_active, is_online, current_order, photo_url, vehicle_type')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function createOrderRecord(supabase, payload) {
  if (!supabase) return null;

  const vendor = await upsertVendor(supabase, payload.vendor);
  if (vendor && vendor.is_active === false) {
    return null;
  }
  if (vendor && vendor.is_open === false) {
    return null;
  }

  const orderPayload = {
    customer_name: payload.customerName || 'Customer',
    customer_phone: payload.customerPhone || null,
    // NEW: needed so the Paystack webhook (and the customer receipt) has
    // somewhere to send a copy of the receipt / has an email on file for
    // this order, independent of whatever's in the customer's long-term
    // profile. Nullable — orders created before this column existed, or
    // through a path that never collects an email, just leave it null.
    customer_email: payload.customerEmail || null,
    vendor_id: vendor?.id || null,
    driver_id: payload.driverId || null,
    restaurant_name: payload.restaurantName || payload.vendor?.name || null,
    items: payload.items || [],
    subtotal: payload.subtotal ?? 0,
    delivery_fee: payload.deliveryFee ?? 0,
    total: payload.total ?? 0,
    delivery_address: payload.deliveryAddress || null,
    // NEW: the Paystack transaction reference generated in server.js
    // *before* the payment link is created. This is what lets the
    // /paystack/webhook handler match an incoming "charge.success" event
    // back to this exact order row. Nullable — orders where checkout
    // couldn't create a payment link (e.g. no price set on the item) simply
    // have no reference to match against, which is fine; they never get a
    // webhook-triggered receipt because no payment was ever attempted.
    //
    // Requires a nullable, UNIQUE column on `orders`:
    //   alter table orders add column if not exists payment_reference text unique;
    //   alter table orders add column if not exists paid_at timestamptz;
    //   alter table orders add column if not exists payment_status text;
    //   alter table orders add column if not exists customer_email text;
    payment_reference: payload.paymentReference || null,
    payment_status: payload.paymentReference ? 'pending' : null,
    status: payload.status || 'pending_vendor',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(orderPayload)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return normalizeOrderForResponse(data);
}

async function updateOrderStatus(supabase, orderId, patch = {}) {
  if (!supabase || !orderId) return null;

  const payload = {
    ...patch,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('orders')
    .update(payload)
    .eq('id', orderId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return normalizeOrderForResponse(data);
}

// NEW: looks an order up by its Paystack payment reference. Used by the
// /paystack/webhook handler in server.js to map an incoming "charge.success"
// event back to the order it belongs to (the webhook payload only carries
// the reference, not the order id).
async function getOrderByPaymentReference(supabase, reference) {
  if (!supabase || !reference) return null;

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('payment_reference', reference)
    .maybeSingle();

  if (error) {
    console.error('Order lookup by payment reference failed:', error.message);
    return null;
  }
  return normalizeOrderForResponse(data);
}

async function vendorAcceptOrder(supabase, orderId, vendorId, prepMinutes) {
  if (!supabase || !orderId) return null;

  const patch = {
    status: 'awaiting_driver',
    vendor_accepted_at: new Date().toISOString(),
    estimated_prep_time_minutes: prepMinutes ?? null
  };

  const { data, error } = await supabase
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .eq('vendor_id', vendorId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return normalizeOrderForResponse(data);
}

async function vendorRejectOrder(supabase, orderId, vendorId) {
  if (!supabase || !orderId) return null;

  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'vendor_rejected',
      updated_at: new Date().toISOString()
    })
    .eq('id', orderId)
    .eq('vendor_id', vendorId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return normalizeOrderForResponse(data);
}

async function assignDriverToOrder(supabase, orderId, driverId) {
  if (!supabase || !orderId || !driverId) return { ok: false, reason: 'missing_input' };

  if (typeof supabase.rpc === 'function') {
    try {
      const { data, error } = await supabase.rpc('assign_driver_to_order', {
        order_uuid: orderId,
        driver_uuid: driverId
      });

      if (!error) {
        return data || { ok: true };
      }
      console.warn('assign_driver_to_order RPC failed, falling back to optimistic update:', error.message);
    } catch (error) {
      console.warn('assign_driver_to_order RPC threw, falling back to optimistic update:', error.message);
    }
  }

  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .eq('status', 'awaiting_driver')
    .is('driver_id', null)
    .maybeSingle();

  if (orderError) throw orderError;
  if (!orderRow) return { ok: false, reason: 'order_not_available' };

  const { data: driverRow, error: driverError } = await supabase
    .from('drivers')
    .select('*')
    .eq('id', driverId)
    .eq('is_active', true)
    .eq('is_online', true)
    .is('current_order', null)
    .maybeSingle();

  if (driverError) throw driverError;
  if (!driverRow) return { ok: false, reason: 'driver_unavailable' };

  const { data: updatedOrder, error: updateError } = await supabase
    .from('orders')
    .update({
      driver_id: driverId,
      status: 'driver_assigned',
      driver_assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', orderId)
    .eq('status', 'awaiting_driver')
    .is('driver_id', null)
    .select('*')
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updatedOrder) return { ok: false, reason: 'order_not_available' };

  const { error: driverUpdateError } = await supabase
    .from('drivers')
    .update({
      current_order: orderId,
      updated_at: new Date().toISOString()
    })
    .eq('id', driverId)
    .is('current_order', null);

  if (driverUpdateError) throw driverUpdateError;

  return { ok: true, order_id: orderId, driver_id: driverId };
}

async function markOrderPickedUp(supabase, orderId, driverId) {
  if (!supabase || !orderId || !driverId) return null;

  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'picked_up',
      picked_up_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', orderId)
    .eq('driver_id', driverId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return normalizeOrderForResponse(data);
}

async function markOrderDelivered(supabase, orderId, driverId, photoUrl = null) {
  if (!supabase || !orderId || !driverId) return null;

  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      delivery_photo_url: photoUrl || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', orderId)
    .eq('driver_id', driverId)
    .select('*')
    .maybeSingle();

  if (error) throw error;

  await supabase
    .from('drivers')
    .update({
      current_order: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', driverId);

  return normalizeOrderForResponse(data);
}

async function setDriverAvailability(supabase, phone, isOnline) {
  if (!supabase || !phone) return null;
  const existing = await supabase
    .from('drivers')
    .select('id, name')
    .eq('phone', normalizePhone(phone))
    .maybeSingle();
  const record = existing?.data || existing;
  return upsertDriver(supabase, { phone, name: record?.name || 'Driver', isActive: true, isOnline });
}

async function setVendorAvailability(supabase, phone, isOpen) {
  if (!supabase || !phone) return null;
  const existing = await supabase
    .from('vendors')
    .select('id, name')
    .eq('phone', normalizePhone(phone))
    .maybeSingle();
  const record = existing?.data || existing;
  return upsertVendor(supabase, { phone, name: record?.name || 'Vendor', isActive: true, isOpen });
}

async function findAvailableDrivers(supabase) {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('is_active', true)
    .eq('is_online', true)
    .is('current_order', null)
    .order('updated_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function ensureDeliveryPhotoBucket(supabase) {
  if (!supabase) return false;
  try {
    await supabase.storage.createBucket('delivery-photos', { public: true, fileSizeLimit: 5242880 });
  } catch (error) {
    if (!/already exists/i.test(error.message || '')) {
      throw error;
    }
  }
  return true;
}

async function uploadDeliveryPhoto(supabase, orderId, fileBuffer, mimeType, fileName) {
  if (!supabase || !orderId || !fileBuffer) return null;

  await ensureDeliveryPhotoBucket(supabase);

  const objectName = `${orderId}/${Date.now()}-${(fileName || 'delivery-photo').replace(/\s+/g, '-')}`;
  const { data, error } = await supabase.storage
    .from('delivery-photos')
    .upload(objectName, fileBuffer, { contentType: mimeType || 'image/jpeg', upsert: false });

  if (error) throw error;

  const { data: publicData } = supabase.storage.from('delivery-photos').getPublicUrl(data?.path || objectName);
  return publicData?.publicUrl || null;
}

// NEW: same pattern as ensureDeliveryPhotoBucket/uploadDeliveryPhoto above,
// but for the rider-onboarding selfie into its own bucket. Kept as a
// separate bucket (rather than reusing delivery-photos) so rider ID photos
// and delivery-proof photos have distinct storage/retention/access rules if
// you ever need them — e.g. only admins should be able to browse rider
// selfies, whereas delivery photos might reasonably be visible to the
// customer who placed that order.
//
// NOTE: like ensureDeliveryPhotoBucket above, `public: true` only takes
// effect the FIRST time this bucket is created. If `driver-photos` already
// exists as a PRIVATE bucket (e.g. created manually, or by an older version
// of this code), this call hits the "already exists" catch and silently
// leaves it private — uploads still succeed and getPublicUrl() still
// returns a URL, but that URL won't actually be fetchable by WhatsApp's
// servers, so any image message using it fails to send (silently, other
// than a console.error in sendWhatsAppMessage). If driver/vendor photos
// aren't showing up, check in the Supabase dashboard (Storage ->
// driver-photos -> should show "Public") or run:
//   update storage.buckets set public = true where id = 'driver-photos';
async function ensureDriverPhotoBucket(supabase) {
  if (!supabase) return false;
  try {
    await supabase.storage.createBucket('driver-photos', { public: true, fileSizeLimit: 5242880 });
  } catch (error) {
    if (!/already exists/i.test(error.message || '')) {
      throw error;
    }
  }
  return true;
}

// `phone` should already be normalized (digits only) by the caller — server.js
// passes normalizePhone(phone) in. Using phone as the folder key means a
// re-registering driver's old photo naturally sits alongside their new one
// (upsert: true on the same folder still creates a new timestamped file, it
// doesn't overwrite — see the timestamp in filename below).
async function uploadDriverPhoto(supabase, phone, fileBuffer, mimeType, fileName) {
  if (!supabase || !phone || !fileBuffer) return null;

  await ensureDriverPhotoBucket(supabase);

  const objectName = `${phone}/${Date.now()}-${(fileName || 'driver-photo').replace(/\s+/g, '-')}`;
  const { data, error } = await supabase.storage
    .from('driver-photos')
    .upload(objectName, fileBuffer, { contentType: mimeType || 'image/jpeg', upsert: false });

  if (error) throw error;

  const { data: publicData } = supabase.storage.from('driver-photos').getPublicUrl(data?.path || objectName);
  return publicData?.publicUrl || null;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

module.exports = {
  ORDER_STATUS_VALUES,
  isValidStatus,
  upsertVendor,
  upsertDriver,
  createOrderRecord,
  updateOrderStatus,
  getOrderByPaymentReference,
  vendorAcceptOrder,
  vendorRejectOrder,
  assignDriverToOrder,
  markOrderPickedUp,
  markOrderDelivered,
  setDriverAvailability,
  setVendorAvailability,
  findAvailableDrivers,
  uploadDeliveryPhoto,
  uploadDriverPhoto
};
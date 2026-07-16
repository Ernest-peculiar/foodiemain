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

// UPDATED: now also accepts/persists `menuItems` (-> menu_items)...
// (unchanged from before — this is the vendor upsert used by REGISTRATION,
// MENU EDITS, and explicit open/close commands, i.e. the only three places
// that should ever be allowed to write is_active/is_open.)
async function upsertVendor(supabase, vendor) {
  if (!supabase) return null;

  const name = (vendor?.name || '').trim();
  const phone = vendor?.phone || null;
  if (!name) return null;

  let existing = null;

  if (phone) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, menu_items, is_active, is_open')
      .eq('phone', phone)
      .maybeSingle();

    if (error) {
      console.error('Vendor lookup by phone failed:', error.message);
    } else {
      existing = data;
    }
  }

  if (!existing) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, menu_items, is_active, is_open')
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
        phone: phone || existing.phone,
        menu: vendor?.menu ?? existing.menu ?? null,
        menu_items: vendor?.menuItems ?? existing.menu_items ?? null,
        is_active: vendor?.isActive ?? existing.is_active ?? true,
        is_open: vendor?.isOpen ?? existing.is_open ?? true,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select('id, name, phone, menu, menu_items, is_active, is_open')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  const inserted = {
    name,
    phone,
    menu: vendor?.menu ?? null,
    menu_items: vendor?.menuItems ?? null,
    is_active: vendor?.isActive ?? true,
    is_open: vendor?.isOpen ?? true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('vendors')
    .insert(inserted)
    .select('id, name, phone, menu, menu_items, is_active, is_open')
    .maybeSingle();

  if (error) throw error;
  return data;
}

// NEW — used ONLY by createOrderRecord below. Deliberately does NOT accept
// or write isActive/isOpen at all, under any circumstance. Its only job is
// "find this vendor by phone, else by name, else create a bare row" so we
// have a vendor_id to attach to the order. Availability must never be
// touched here — that's the whole bug this function exists to prevent:
// upsertVendor() applies `vendor?.isActive ?? existing.is_active ?? true`,
// and server.js's order-creation call site was passing the literal `true`
// for both flags on every order, which silently forced any closed/inactive
// vendor back open on every single order attempt — which in turn meant the
// "reject + close if vendor.is_open === false" check in createOrderRecord
// could never fire, since the vendor had just been force-reopened one line
// above it.
//
// Only three call sites should ever be allowed to write availability:
// registration (upsertVendor with isActive/isOpen from finalizeRegistration),
// "edit menu" (upsertVendor via finalizeRegistration's menu-edit path), and
// the explicit "open"/"close" commands (setVendorAvailability below). Order
// creation is not one of them.
async function resolveOrCreateVendor(supabase, vendor) {
  if (!supabase) return null;

  const name = (vendor?.name || '').trim();
  const phone = vendor?.phone || null;
  if (!name) return null;

  let existing = null;

  if (phone) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, menu_items, is_active, is_open')
      .eq('phone', phone)
      .maybeSingle();

    if (error) {
      console.error('Vendor lookup by phone failed (resolveOrCreateVendor):', error.message);
    } else {
      existing = data;
    }
  }

  if (!existing) {
    const { data, error } = await supabase
      .from('vendors')
      .select('id, name, phone, menu, menu_items, is_active, is_open')
      .ilike('name', name)
      .maybeSingle();

    if (error) {
      console.error('Vendor lookup by name failed (resolveOrCreateVendor):', error.message);
    } else {
      existing = data;
    }
  }

  // Found it — return it completely untouched. This is the fix: we never
  // write to it, so a vendor's real is_active/is_open survives an order
  // being placed against them.
  if (existing?.id) return existing;

  // Genuinely new vendor (shouldn't normally happen mid-order, since a
  // customer can only reach checkout via a registered vendor's real menu —
  // but handled defensively). A brand-new row defaults to active/open,
  // which is correct since nothing has said otherwise yet.
  const inserted = {
    name,
    phone,
    menu: null,
    menu_items: null,
    is_active: true,
    is_open: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('vendors')
    .insert(inserted)
    .select('id, name, phone, menu, menu_items, is_active, is_open')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateVendorMenuItems(supabase, vendorId, menuItems) {
  if (!supabase || !vendorId) return null;

  const { data, error } = await supabase
    .from('vendors')
    .update({
      menu_items: menuItems || [],
      updated_at: new Date().toISOString()
    })
    .eq('id', vendorId)
    .select('id, name, phone, menu, menu_items, is_active, is_open')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertDriver(supabase, driver) {
  if (!supabase) return null;

  const name = (driver?.name || '').trim();
  const phone = driver?.phone || null;
  if (!name && !phone) return null;

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

  // FIX: was `upsertVendor(supabase, payload.vendor)`, which — combined
  // with server.js hardcoding isActive:true/isOpen:true on every order's
  // vendor payload — silently force-reopened any closed/inactive vendor on
  // every order attempt, making the checks right below this call dead code.
  // resolveOrCreateVendor() never writes availability, so a closed vendor
  // stays closed and this check now actually works.
  const vendor = await resolveOrCreateVendor(supabase, payload.vendor);
  if (vendor && vendor.is_active === false) {
    console.warn(`createOrderRecord: vendor ${vendor.id} (${vendor.name}) is inactive — refusing to create order.`);
    return null;
  }
  if (vendor && vendor.is_open === false) {
    console.warn(`createOrderRecord: vendor ${vendor.id} (${vendor.name}) is closed — refusing to create order.`);
    return null;
  }

  const orderPayload = {
    customer_name: payload.customerName || 'Customer',
    customer_phone: payload.customerPhone || null,
    vendor_id: vendor?.id || null,
    driver_id: payload.driverId || null,
    restaurant_name: payload.restaurantName || payload.vendor?.name || null,
    items: payload.items || [],
    subtotal: payload.subtotal ?? 0,
    delivery_fee: payload.deliveryFee ?? 0,
    total: payload.total ?? 0,
    delivery_address: payload.deliveryAddress || null,
    status: payload.status || 'pending_vendor',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!orderPayload.customer_phone) {
    console.error(`createOrderRecord: no customer_phone in payload for order to ${orderPayload.restaurant_name} — receipts/notifications for this order will silently have nowhere to go.`);
  }

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
  resolveOrCreateVendor,
  updateVendorMenuItems,
  upsertDriver,
  createOrderRecord,
  updateOrderStatus,
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
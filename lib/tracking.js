const crypto = require("crypto");

function hashTrackingToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createDeliveryTrackingTokens(supabase, orderId) {
  if (!supabase || !orderId) {
    throw new Error("Supabase and an order ID are required for delivery tracking.");
  }

  const customerToken = crypto.randomBytes(32).toString("hex");
  const riderToken = crypto.randomBytes(32).toString("hex");
  const { error } = await supabase.from("delivery_tracking").upsert(
    {
      order_id: orderId,
      customer_token_hash: hashTrackingToken(customerToken),
      rider_token_hash: hashTrackingToken(riderToken),
      latitude: null,
      longitude: null,
      location_accuracy: null,
      location_updated_at: null,
      destination_latitude: null,
      destination_longitude: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );

  if (error) throw error;
  return { customerToken, riderToken };
}

module.exports = {
  hashTrackingToken,
  createDeliveryTrackingTokens,
};

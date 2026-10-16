const { hashTrackingToken } = require("./tracking");

module.exports = function setupTrackingRoutes(app, { supabase, GEOAPIFY_API_KEY }) {
  function noCache(res) {
    res.set("Cache-Control", "no-store, max-age=0");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Robots-Tag", "noindex, nofollow");
  }

  function getBearerToken(req) {
    const match = (req.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/i);
    return match?.[1] || null;
  }

  async function findTrackingSession(token) {
    if (!supabase) return { error: "tracking_unavailable" };
    const tokenHash = hashTrackingToken(token);
    const { data: customerSession, error: customerError } = await supabase
      .from("delivery_tracking")
      .select("*")
      .eq("customer_token_hash", tokenHash)
      .maybeSingle();

    if (customerError) throw customerError;
    if (customerSession) return { session: customerSession, role: "customer" };

    const { data: riderSession, error: riderError } = await supabase
      .from("delivery_tracking")
      .select("*")
      .eq("rider_token_hash", tokenHash)
      .maybeSingle();

    if (riderError) throw riderError;
    return riderSession
      ? { session: riderSession, role: "rider" }
      : { error: "invalid_token" };
  }

  async function getOrder(orderId) {
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, status, restaurant_name, delivery_address, driver_id",
      )
      .eq("id", orderId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function resolveDestination(session, order) {
    if (
      Number.isFinite(session.destination_latitude) &&
      Number.isFinite(session.destination_longitude)
    ) {
      return {
        latitude: session.destination_latitude,
        longitude: session.destination_longitude,
      };
    }

    if (!GEOAPIFY_API_KEY || !order.delivery_address) return null;

    const coordinates = order.delivery_address
      .trim()
      .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    let point;

    if (coordinates) {
      point = {
        latitude: Number(coordinates[1]),
        longitude: Number(coordinates[2]),
      };
    } else {
      const url = new URL("https://api.geoapify.com/v1/geocode/search");
      url.searchParams.set("text", order.delivery_address);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");
      url.searchParams.set("filter", "countrycode:ng");
      url.searchParams.set("apiKey", GEOAPIFY_API_KEY);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Geoapify address lookup failed (${response.status}).`);
      }
      const result = await response.json();
      const feature = result.results?.[0];
      if (!feature) return null;
      point = {
        latitude: Number(feature.lat),
        longitude: Number(feature.lon),
      };
    }

    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    ) {
      return null;
    }

    const { error } = await supabase
      .from("delivery_tracking")
      .update({
        destination_latitude: point.latitude,
        destination_longitude: point.longitude,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", session.order_id);

    if (error) throw error;
    return point;
  }

  async function loadActiveTracking(req, res) {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "A valid tracking token is required." });
      return null;
    }

    const auth = await findTrackingSession(token);
    if (auth.error) {
      res
        .status(auth.error === "tracking_unavailable" ? 503 : 404)
        .json({ error: "Tracking is unavailable for this link." });
      return null;
    }

    const order = await getOrder(auth.session.order_id);
    if (!order) {
      res.status(404).json({ error: "This delivery could not be found." });
      return null;
    }

    if (auth.role === "rider" && order.driver_id == null) {
      res.status(403).json({ error: "This rider link is no longer active." });
      return null;
    }

    return { ...auth, order };
  }

  app.get("/api/tracking", async (req, res) => {
    noCache(res);
    try {
      const tracking = await loadActiveTracking(req, res);
      if (!tracking) return;

      const { session, order } = tracking;
      let driver = null;
      if (order.driver_id) {
        const { data, error } = await supabase
          .from("drivers")
          .select("name, photo_url, vehicle_type")
          .eq("id", order.driver_id)
          .maybeSingle();
        if (error) throw error;
        driver = data;
      }

      const isLive = ["driver_assigned", "picked_up"].includes(order.status);
      const destination = isLive ? await resolveDestination(session, order) : null;
      res.json({
        order: {
          id: order.id,
          status: order.status,
          restaurantName: order.restaurant_name,
          deliveryAddress:
            tracking.role === "rider" && !isLive ? null : order.delivery_address,
        },
        driver,
        riderLocation:
          ["driver_assigned", "picked_up"].includes(order.status) &&
          Number.isFinite(session.latitude) &&
          Number.isFinite(session.longitude)
            ? {
                latitude: session.latitude,
                longitude: session.longitude,
                accuracy: session.location_accuracy,
                updatedAt: session.location_updated_at,
              }
            : null,
        destination,
        role: tracking.role,
      });
    } catch (error) {
      console.error("Could not load delivery tracking:", error.message || error);
      res.status(500).json({ error: "Could not load delivery tracking." });
    }
  });

  app.get("/api/tracking/directions", async (req, res) => {
    noCache(res);
    try {
      const tracking = await loadActiveTracking(req, res);
      if (!tracking) return;
      const { session, order } = tracking;
      if (order.status === "delivered" || order.status === "cancelled") {
        return res.status(410).json({ error: "Live directions have ended for this delivery." });
      }
      if (order.status !== "picked_up") {
        return res.status(409).json({ error: "Directions to the customer are available after pickup." });
      }
      if (!GEOAPIFY_API_KEY) {
        return res.status(503).json({ error: "Map directions are not configured." });
      }

      const destination = await resolveDestination(session, order);
      if (!destination) {
        return res.status(422).json({ error: "The delivery address could not be mapped." });
      }
      if (
        !Number.isFinite(session.latitude) ||
        !Number.isFinite(session.longitude)
      ) {
        return res.status(409).json({ error: "Waiting for the rider's location." });
      }

      const url = new URL("https://api.geoapify.com/v1/routing");
      url.searchParams.set(
        "waypoints",
        `${session.latitude},${session.longitude}|${destination.latitude},${destination.longitude}`,
      );
      url.searchParams.set("mode", "drive");
      url.searchParams.set("format", "geojson");
      url.searchParams.set("apiKey", GEOAPIFY_API_KEY);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Geoapify directions failed (${response.status}).`);
      }
      const route = await response.json();
      if (!route.features?.length) {
        throw new Error("Geoapify returned no delivery route.");
      }
      res.json(route);
    } catch (error) {
      console.error("Could not calculate delivery directions:", error.message || error);
      res.status(502).json({ error: "Could not calculate delivery directions." });
    }
  });

  app.post("/api/rider/location", async (req, res) => {
    noCache(res);
    try {
      const tracking = await loadActiveTracking(req, res);
      if (!tracking) return;
      if (tracking.role !== "rider") {
        return res.status(403).json({ error: "Only the assigned rider can share location." });
      }
      if (!["driver_assigned", "picked_up"].includes(tracking.order.status)) {
        return res.status(409).json({ error: "Location sharing is only available during an active delivery." });
      }

      const { latitude, longitude, accuracy } = req.body || {};
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 ||
        (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0))
      ) {
        return res.status(400).json({ error: "A valid GPS location is required." });
      }

      const now = new Date().toISOString();
      const previousLocationAt = Date.parse(
        tracking.session.location_updated_at || "",
      );
      if (Number.isFinite(previousLocationAt) && Date.now() - previousLocationAt < 3000) {
        return res.status(429).json({ error: "Location updates are arriving too quickly." });
      }
      const { error } = await supabase
        .from("delivery_tracking")
        .update({
          latitude,
          longitude,
          location_accuracy: accuracy ?? null,
          location_updated_at: now,
          updated_at: now,
        })
        .eq("order_id", tracking.session.order_id);
      if (error) throw error;

      res.json({ ok: true, updatedAt: now });
    } catch (error) {
      console.error("Could not save rider location:", error.message || error);
      res.status(500).json({ error: "Could not save rider location." });
    }
  });
};

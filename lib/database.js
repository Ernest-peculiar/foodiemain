// Supabase/Database operations
const { normalizePhone, hasMenuContent } = require("./utils");

module.exports = function createDatabaseModule(supabase, sessions, profiles) {
  async function getSession(phone) {
    if (!supabase) return sessions.get(phone) || {};

    const { data, error } = await supabase
      .from("sessions")
      .select("stage, session_data")
      .eq("phone", phone)
      .maybeSingle();

    if (error) {
      console.error("Supabase getSession failed:", error.message);
      return {};
    }
    if (!data) return {};

    return { ...(data.session_data || {}), stage: data.stage || undefined };
  }

  async function setSession(phone, stage, sessionData = {}) {
    if (!supabase) {
      sessions.set(phone, { ...sessionData, stage });
      return;
    }

    const { error } = await supabase.from("sessions").upsert(
      {
        phone,
        stage,
        session_data: sessionData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "phone" },
    );

    if (error) console.error("Supabase setSession failed:", error.message);
  }

  async function deleteSession(phone) {
    if (!supabase) {
      sessions.delete(phone);
      return;
    }

    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("phone", phone);
    if (error) console.error("Supabase deleteSession failed:", error.message);
  }

  async function getProfile(phone) {
    if (!phone) return {};
    if (!supabase) return profiles.get(phone) || {};

    const { data, error } = await supabase
      .from("profiles")
      .select("data")
      .eq("phone", phone)
      .maybeSingle();

    if (error) {
      console.error("Supabase getProfile failed:", error.message);
      return {};
    }
    return data?.data || {};
  }

  async function saveProfile(phone, patch = {}) {
    if (!phone) return;

    if (!supabase) {
      const existing = profiles.get(phone) || {};
      profiles.set(phone, { ...existing, ...patch });
      return;
    }

    const existing = await getProfile(phone);
    const merged = { ...existing, ...patch };
    const { error } = await supabase
      .from("profiles")
      .upsert(
        { phone, data: merged, updated_at: new Date().toISOString() },
        { onConflict: "phone" },
      );

    if (error) console.error("Supabase saveProfile failed:", error.message);
  }

  async function logMessage(phone, direction, messageType, body, payload) {
    if (!supabase) return;

    const { error } = await supabase.from("messages").insert({
      phone,
      direction,
      message_type: messageType || "text",
      body: body || null,
      payload: payload || null,
    });

    if (error) console.error("Supabase logMessage failed:", error.message);
  }

  async function getVendorRecordByPhone(phone) {
    if (!supabase || !phone) return null;
    const { data, error } = await supabase
      .from("vendors")
      .select("*")
      .eq("phone", normalizePhone(phone))
      .maybeSingle();

    if (error) {
      console.error("Vendor lookup failed:", error.message);
      return null;
    }
    return data;
  }

  async function getVendorRecordById(vendorId) {
    if (!supabase || !vendorId) return null;
    const { data, error } = await supabase
      .from("vendors")
      .select("*")
      .eq("id", vendorId)
      .maybeSingle();

    if (error) {
      console.error("Vendor lookup by id failed:", error.message);
      return null;
    }
    return data;
  }

  async function getDriverRecordByPhone(phone) {
    if (!supabase || !phone) return null;
    const { data, error } = await supabase
      .from("drivers")
      .select("*")
      .eq("phone", normalizePhone(phone))
      .maybeSingle();

    if (error) {
      console.error("Driver lookup failed:", error.message);
      return null;
    }
    return data;
  }

  async function findVendorByName(candidateName) {
    if (!supabase || !candidateName) return null;
    const trimmed = candidateName.trim();
    if (!trimmed) return null;

    try {
      const { data: exactMatch, error: exactError } = await supabase
        .from("vendors")
        .select("*")
        .ilike("name", trimmed)
        .maybeSingle();
      if (!exactError && exactMatch) return exactMatch;

      const { data: partialMatches, error: partialError } = await supabase
        .from("vendors")
        .select("*")
        .ilike("name", `%${trimmed}%`)
        .limit(5);

      if (partialError) {
        console.error("Vendor partial lookup failed:", partialError.message);
        return null;
      }
      if (partialMatches && partialMatches.length === 1) {
        return partialMatches[0];
      }
      if (partialMatches && partialMatches.length > 1) {
        console.warn(
          `Vendor name "${trimmed}" matched multiple registered vendors (${partialMatches.map((v) => v.name).join(", ")}) — skipping auto-select to avoid notifying the wrong one.`,
        );
      }
    } catch (e) {
      console.error("Vendor lookup failed:", e?.message || e);
    }
    return null;
  }

  async function getRegisteredVendors() {
    if (!supabase) return [];

    const { data, error } = await supabase
      .from("vendors")
      .select("*")
      .not("menu", "is", null);

    if (error) {
      console.error("Failed to fetch registered vendors:", error.message);
      return [];
    }

    return (data || []).filter((v) => {
      const isActive = v.is_active ?? v.isActive ?? true;
      const isOpen = v.is_open ?? v.isOpen ?? true;
      return isActive !== false && isOpen !== false && hasMenuContent(v);
    });
  }

  async function resolveSenderRole(phone) {
    if (!phone) return "customer";
    const vendor = await getVendorRecordByPhone(phone);
    if (vendor) return "vendor";
    const driver = await getDriverRecordByPhone(phone);
    if (driver) return "driver";
    return "customer";
  }

  return {
    getSession,
    setSession,
    deleteSession,
    getProfile,
    saveProfile,
    logMessage,
    getVendorRecordByPhone,
    getVendorRecordById,
    getDriverRecordByPhone,
    findVendorByName,
    getRegisteredVendors,
    resolveSenderRole,
  };
};

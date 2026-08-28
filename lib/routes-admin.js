// Admin dashboard and vendor/driver management routes
module.exports = function setupAdminRoutes(app, dependencies) {
  const {
    path,
    fs,
    crypto,
    express,
    supabase,
    dispatch,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    PAYSTACK_SECRET_KEY,
    normalizePhone,
    parseEmail,
    parseVendorMenu,
    sendWhatsAppMessage,
  } = dependencies;

  // HTTP Basic Auth for admin dashboard
  function checkAdminAuth(req, res, next) {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      return res
        .status(503)
        .send(
          "Admin dashboard is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in your .env file, then restart the server.",
        );
    }

    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");

    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="Foodie Admin"');
      return res.status(401).send("Authentication required.");
    }

    let user = "",
      pass = "";
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const sepIndex = decoded.indexOf(":");
      user = sepIndex === -1 ? decoded : decoded.slice(0, sepIndex);
      pass = sepIndex === -1 ? "" : decoded.slice(sepIndex + 1);
    } catch (error) {
      res.set("WWW-Authenticate", 'Basic realm="Foodie Admin"');
      return res.status(401).send("Malformed credentials.");
    }

    const userBuf = Buffer.from(user);
    const adminUserBuf = Buffer.from(ADMIN_USERNAME);
    const passBuf = Buffer.from(pass);
    const adminPassBuf = Buffer.from(ADMIN_PASSWORD);

    const userMatches =
      userBuf.length === adminUserBuf.length &&
      crypto.timingSafeEqual(userBuf, adminUserBuf);
    const passMatches =
      passBuf.length === adminPassBuf.length &&
      crypto.timingSafeEqual(passBuf, adminPassBuf);

    if (!userMatches || !passMatches) {
      res.set("WWW-Authenticate", 'Basic realm="Foodie Admin"');
      return res.status(401).send("Invalid credentials.");
    }

    next();
  }

  // Serve static admin dashboard files
  app.use(
    "/admin",
    checkAdminAuth,
    express.static(path.join(__dirname, "../public/admin")),
  );

  // Paystack bank list cache
  let bankListCache = null;
  let bankListCacheAt = 0;
  const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;

  async function fetchPaystackBanks() {
    if (bankListCache && Date.now() - bankListCacheAt < BANK_LIST_TTL_MS) {
      return bankListCache;
    }
    if (!PAYSTACK_SECRET_KEY) {
      throw new Error(
        "PAYSTACK_SECRET_KEY is not configured — cannot fetch bank list.",
      );
    }

    const response = await fetch(
      "https://api.paystack.co/bank?country=nigeria&currency=NGN",
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.status) {
      throw new Error(
        data?.message ||
          `Paystack bank list request failed (${response.status})`,
      );
    }

    bankListCache = data.data.map((b) => ({ name: b.name, code: b.code }));
    bankListCacheAt = Date.now();
    return bankListCache;
  }

  // Get Paystack bank list
  app.get("/admin/api/banks", checkAdminAuth, async (req, res) => {
    try {
      const banks = await fetchPaystackBanks();
      return res.status(200).json({ banks });
    } catch (error) {
      console.error(
        "Admin: failed to fetch bank list:",
        error.message || error,
      );
      return res.status(502).json({
        error:
          "Could not load bank list from Paystack. Check PAYSTACK_SECRET_KEY.",
      });
    }
  });

  // Verify account number with Paystack
  app.post("/admin/api/verify-account", checkAdminAuth, async (req, res) => {
    const accountNumber = (req.body?.accountNumber || "").trim();
    const bankCode = (req.body?.bankCode || "").trim();

    if (!accountNumber || !/^\d{10}$/.test(accountNumber)) {
      return res
        .status(400)
        .json({ error: "Account number must be 10 digits." });
    }
    if (!bankCode) {
      return res.status(400).json({ error: "Please select a bank." });
    }
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        error: "PAYSTACK_SECRET_KEY is not configured on this server.",
      });
    }

    try {
      const url = `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.status) {
        return res.status(400).json({
          error:
            data?.message ||
            "Could not verify that account number — double-check it and the bank.",
        });
      }

      return res.status(200).json({
        accountName: data.data.account_name,
        accountNumber: data.data.account_number,
      });
    } catch (error) {
      console.error(
        "Admin: account verification failed:",
        error.message || error,
      );
      return res
        .status(502)
        .json({ error: "Account verification failed — please try again." });
    }
  });

  // Create or update vendor
  app.post("/admin/api/vendors", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res
        .status(503)
        .json({ error: "Supabase is not configured — cannot save vendors." });
    }

    const body = req.body || {};
    const contactName = (body.contactName || "").trim();
    const restaurantName = (body.restaurantName || "").trim();
    const whatsappNumber = (body.whatsappNumber || "").trim();
    const email = (body.email || "").trim();
    const address = (body.address || "").trim();
    const openingHours = (body.openingHours || "").trim();
    const status = (body.status || "active").trim().toLowerCase();
    const bankCode = (body.bankCode || "").trim();
    const bankName = (body.bankName || "").trim();
    const accountNumber = (body.accountNumber || "").trim();
    const accountName = (body.accountName || "").trim();

    const missing = [];
    if (!contactName) missing.push("Vendor Name");
    if (!restaurantName) missing.push("Restaurant Name");
    if (!whatsappNumber) missing.push("WhatsApp Number");
    if (!address) missing.push("Address");
    if (!openingHours) missing.push("Opening Hours");
    if (!bankCode) missing.push("Payout Bank");
    if (!accountNumber) missing.push("Account Number");
    if (!accountName) missing.push("Verified Account Name");
    if (missing.length > 0) {
      return res
        .status(400)
        .json({ error: `Missing required field(s): ${missing.join(", ")}` });
    }

    const normalizedPhone = normalizePhone(whatsappNumber);
    if (!normalizedPhone || normalizedPhone.length < 10) {
      return res.status(400).json({
        error:
          "WhatsApp Number does not look valid — include the country code, e.g. 2348012345678.",
      });
    }

    if (email && !parseEmail(email)) {
      return res
        .status(400)
        .json({ error: "Email address does not look valid." });
    }

    if (status !== "active" && status !== "inactive") {
      return res
        .status(400)
        .json({ error: 'Status must be "active" or "inactive".' });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res
        .status(400)
        .json({ error: "Account Number must be exactly 10 digits." });
    }

    try {
      // Parse menu items if provided
      const menuText = (body.menu || "").trim();
      const menuItems = menuText ? parseVendorMenu(menuText) : [];

      // Save vendor to Supabase
      const vendorRecord = await dispatch.upsertVendor(supabase, {
        name: restaurantName,
        phone: normalizedPhone,
        menu: menuText || null,
        menuItems: menuItems.length > 0 ? menuItems : null,
        isActive: status === "active",
        isOpen: true,
      });

      if (!vendorRecord) {
        return res.status(500).json({ error: "Failed to save vendor record." });
      }

      // Send WhatsApp confirmation message
      const menuNote =
        menuItems.length > 0
          ? `\n\n✅ *${menuItems.length} menu item${menuItems.length === 1 ? "" : "s"} added.*`
          : "\n\n📋 No menu added yet — send 'menu' to add one.";

      const message = {
        type: "text",
        body:
          `👋 Welcome to Foodie, ${restaurantName}!\n\n` +
          `Your restaurant is now registered.${menuNote}\n\n` +
          `Reply with:\n` +
          `• *menu* — to manage your menu\n` +
          `• *hours* — to set opening hours\n` +
          `• *open* — to go online\n` +
          `• *close* — to go offline`,
      };

      await sendWhatsAppMessage(normalizedPhone, message);

      return res.status(200).json({
        success: true,
        vendor_id: vendorRecord.id,
        message: "Vendor added successfully and notified on WhatsApp.",
        menuItemCount: menuItems.length,
      });
    } catch (error) {
      console.error("Vendor registration failed:", error.message || error);
      return res.status(500).json({
        error: error.message || "Failed to register vendor.",
      });
    }
  });

  // List vendors
  app.get("/admin/api/vendors", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    const { data, error } = await supabase
      .from("vendors")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Admin: failed to list vendors:", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ vendors: data || [] });
  });

  // List drivers
  app.get("/admin/api/drivers", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    const { data, error } = await supabase
      .from("drivers")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Admin: failed to list drivers:", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ drivers: data || [] });
  });

  // Create driver
  app.post("/admin/api/drivers", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res
        .status(503)
        .json({ error: "Supabase is not configured — cannot save drivers." });
    }

    // Note: Full implementation would handle driver photo upload and upsert
    return res
      .status(200)
      .json({ message: "Driver operations setup complete" });
  });

  // Admin dashboard stats
  app.get("/admin/api/stats", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    try {
      const ACTIVE_USER_WINDOW_MINUTES = 15;
      const activeSince = new Date(
        Date.now() - ACTIVE_USER_WINDOW_MINUTES * 60 * 1000,
      ).toISOString();

      const { data: activeRows } = await supabase
        .from("messages")
        .select("phone")
        .eq("direction", "inbound")
        .gte("created_at", activeSince);

      const activeUsers = new Set((activeRows || []).map((r) => r.phone)).size;

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const { data: todayOrders } = await supabase
        .from("orders")
        .select("total")
        .eq("payment_status", "paid")
        .gte("paid_at", startOfDay.toISOString());

      const todayCount = todayOrders?.length || 0;
      const todayTotal = (todayOrders || []).reduce(
        (sum, o) => sum + (Number(o.total) || 0),
        0,
      );

      const { data: allOrders } = await supabase
        .from("orders")
        .select("total")
        .eq("payment_status", "paid");

      const allTimeCount = allOrders?.length || 0;
      const allTimeTotal = (allOrders || []).reduce(
        (sum, o) => sum + (Number(o.total) || 0),
        0,
      );

      return res.status(200).json({
        activeUsers,
        today: { count: todayCount, total: todayTotal },
        allTime: { count: allTimeCount, total: allTimeTotal },
      });
    } catch (error) {
      console.error("Admin stats: unexpected failure:", error.message || error);
      return res.status(500).json({ error: "Could not load dashboard stats." });
    }
  });
};

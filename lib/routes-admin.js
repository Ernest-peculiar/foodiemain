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
    ADMIN_TEAM_USERNAME,
    ADMIN_TEAM_PASSWORD,
    PAYSTACK_SECRET_KEY,
    normalizePhone,
    parseEmail,
    parseVendorMenu,
    sendWhatsAppMessage,
    buildVendorWelcomeMessage,
  } = dependencies;

  // HTTP Basic Auth for admin dashboard
  function checkAdminAuth(req, res, next) {
    const adminConfigured = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);
    const teamConfigured = Boolean(
      ADMIN_TEAM_USERNAME && ADMIN_TEAM_PASSWORD,
    );
    const teamConfigIncomplete = Boolean(ADMIN_TEAM_USERNAME) !== Boolean(
      ADMIN_TEAM_PASSWORD,
    );

    if (!adminConfigured || teamConfigIncomplete) {
      return res
        .status(503)
        .send(
          "Admin dashboard credentials are not configured correctly. Set ADMIN_USERNAME and ADMIN_PASSWORD, and either set both team credentials or leave both unset.",
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

    function matchesCredentials(expectedUser, expectedPass) {
      const userBuf = Buffer.from(user);
      const expectedUserBuf = Buffer.from(expectedUser);
      const passBuf = Buffer.from(pass);
      const expectedPassBuf = Buffer.from(expectedPass);
      const userMatches =
        userBuf.length === expectedUserBuf.length &&
        crypto.timingSafeEqual(userBuf, expectedUserBuf);
      const passMatches =
        passBuf.length === expectedPassBuf.length &&
        crypto.timingSafeEqual(passBuf, expectedPassBuf);
      return userMatches && passMatches;
    }

    if (matchesCredentials(ADMIN_USERNAME, ADMIN_PASSWORD)) {
      req.adminRole = "admin";
      return next();
    }
    if (
      teamConfigured &&
      matchesCredentials(ADMIN_TEAM_USERNAME, ADMIN_TEAM_PASSWORD)
    ) {
      req.adminRole = "team";
      return next();
    }

    res.set("WWW-Authenticate", 'Basic realm="Foodie Admin"');
    return res.status(401).send("Invalid credentials.");
  }

  function requireAdvancedAdmin(req, res, next) {
    if (req.adminRole !== "admin") {
      return res.status(403).json({ error: "Advanced admin access required." });
    }
    return next();
  }

  // Serve static admin dashboard files
  app.use(
    "/admin",
    checkAdminAuth,
    express.static(path.join(__dirname, "../public/admin")),
  );

  app.get("/admin/api/access", checkAdminAuth, (req, res) => {
    return res.status(200).json({ role: req.adminRole });
  });

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
      let { data: existingVendor, error: existingVendorError } = await supabase
        .from("vendors")
        .select("id, paystack_subaccount_code")
        .eq("phone", normalizedPhone)
        .maybeSingle();
      if (existingVendorError) throw existingVendorError;
      if (!existingVendor) {
        const lookup = await supabase
          .from("vendors")
          .select("id, paystack_subaccount_code")
          .ilike("name", restaurantName)
          .maybeSingle();
        if (lookup.error) throw lookup.error;
        existingVendor = lookup.data;
      }

      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          error: "PAYSTACK_SECRET_KEY is required to set up restaurant payouts.",
        });
      }

      const subaccountPayload = {
        business_name: restaurantName,
        account_number: accountNumber,
        percentage_charge: 0,
        primary_contact_name: contactName,
        primary_contact_email: email || undefined,
        primary_contact_phone: normalizedPhone,
      };
      const hasSubaccount = Boolean(existingVendor?.paystack_subaccount_code);
      const subaccountResponse = await fetch(
        hasSubaccount
          ? `https://api.paystack.co/subaccount/${encodeURIComponent(existingVendor.paystack_subaccount_code)}`
          : "https://api.paystack.co/subaccount",
        {
          method: hasSubaccount ? "PUT" : "POST",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...subaccountPayload,
            ...(hasSubaccount
              ? { bank_code: bankCode }
              : { settlement_bank: bankCode }),
          }),
        },
      );
      const subaccountData = await subaccountResponse.json().catch(() => null);
      if (!subaccountResponse.ok || !subaccountData?.status) {
        console.error(
          "Paystack subaccount setup failed:",
          subaccountData?.message || subaccountResponse.status,
        );
        return res.status(502).json({
          error:
            subaccountData?.message ||
            "Could not set up this restaurant's Paystack payout account.",
        });
      }
      const paystackSubaccountCode =
        subaccountData.data?.subaccount_code ||
        existingVendor?.paystack_subaccount_code;
      if (!paystackSubaccountCode) {
        return res.status(502).json({
          error: "Paystack did not return a restaurant subaccount code.",
        });
      }

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
        paystackSubaccountCode,
      });

      if (!vendorRecord) {
        return res.status(500).json({ error: "Failed to save vendor record." });
      }

      // Send WhatsApp confirmation message
      const message = buildVendorWelcomeMessage(restaurantName, menuItems);
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
  app.get(
    "/admin/api/vendors",
    checkAdminAuth,
    requireAdvancedAdmin,
    async (req, res) => {
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
    },
  );

  // List drivers
  app.get(
    "/admin/api/drivers",
    checkAdminAuth,
    requireAdvancedAdmin,
    async (req, res) => {
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
    },
  );

  // Create driver
  app.post("/admin/api/drivers", checkAdminAuth, async (req, res) => {
    if (!supabase) {
      return res
        .status(503)
        .json({ error: "Supabase is not configured — cannot save drivers." });
    }

    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = normalizePhone(
      typeof body.whatsappNumber === "string" ? body.whatsappNumber : "",
    );
    const vehicleType =
      typeof body.vehicleType === "string" ? body.vehicleType.trim() : "";
    const rawStatus = body.status ?? "active";
    const status =
      typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";

    if (!name) {
      return res.status(400).json({ error: "Driver name is required." });
    }
    if (!phone || phone.length < 10) {
      return res.status(400).json({
        error:
          "WhatsApp Number does not look valid — include the country code, e.g. 2348012345678.",
      });
    }
    if (!vehicleType) {
      return res.status(400).json({ error: "Please select a vehicle type." });
    }
    if (status !== "active" && status !== "inactive") {
      return res
        .status(400)
        .json({ error: 'Status must be "active" or "inactive".' });
    }

    try {
      let photoUrl;
      if (body.photo) {
        const match =
          typeof body.photo === "string" &&
          body.photo.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (!match) {
          return res.status(400).json({ error: "The selected photo is invalid." });
        }

        photoUrl = await dispatch.uploadDriverPhoto(
          supabase,
          phone,
          Buffer.from(match[2], "base64"),
          match[1],
          `driver-photo.${match[1].split("/")[1]}`,
        );
      }

      const driver = await dispatch.upsertDriver(supabase, {
        name,
        phone,
        vehicleType,
        isActive: status === "active",
        ...(photoUrl ? { photoUrl } : {}),
      });

      if (!driver) {
        return res.status(500).json({ error: "Failed to save driver record." });
      }

      let notified = false;
      try {
        await sendWhatsAppMessage(phone, {
          type: "text",
          body: `👋 Welcome to Foodie, ${name}! You have been registered as a delivery driver. Reply "online" when you are ready to receive deliveries.`,
        });
        notified = true;
      } catch (error) {
        console.error("Driver welcome message failed:", error.message || error);
      }

      return res.status(200).json({ success: true, driver, notified });
    } catch (error) {
      console.error("Driver registration failed:", error.message || error);
      return res.status(500).json({
        error: error.message || "Failed to register driver.",
      });
    }
  });

  // Admin dashboard stats
  app.get(
    "/admin/api/stats",
    checkAdminAuth,
    requireAdvancedAdmin,
    async (req, res) => {
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

      const { data: allVendors, error: vendorsError } = await supabase
        .from("vendors")
        .select("is_active");
      if (vendorsError) throw vendorsError;

      const vendorTotal = allVendors?.length || 0;
      const activeVendorCount = (allVendors || []).filter(
        (vendor) => vendor.is_active !== false,
      ).length;
      const inactiveVendorCount = vendorTotal - activeVendorCount;

      return res.status(200).json({
        activeUsers,
        today: { count: todayCount, total: todayTotal },
        allTime: { count: allTimeCount, total: allTimeTotal },
        vendors: {
          total: vendorTotal,
          active: activeVendorCount,
          inactive: inactiveVendorCount,
        },
        },
      );
    } catch (error) {
      console.error("Admin stats: unexpected failure:", error.message || error);
      return res.status(500).json({ error: "Could not load dashboard stats." });
    }
  });

  // Operational dashboard data: open orders, driver availability, vendor
  // performance for a selected period, and vendor payout setup readiness.
  app.get(
    "/admin/api/operations",
    checkAdminAuth,
    requireAdvancedAdmin,
    async (req, res) => {
    if (!supabase) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    const period = req.query.period || "7d";
    const now = new Date();
    let periodStart;
    if (period === "today") {
      periodStart = new Date(now);
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === "7d") {
      periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "30d") {
      periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      return res.status(400).json({ error: "Period must be today, 7d, or 30d." });
    }

    try {
      const [ordersResult, driversResult, vendorsResult] = await Promise.all([
        supabase
          .from("orders")
          .select(
            "id, customer_name, restaurant_name, status, total, created_at, vendor_id, driver_id",
          )
          .in("status", [
            "pending_vendor",
            "awaiting_driver",
            "driver_assigned",
            "picked_up",
          ])
          .order("created_at", { ascending: false })
          .limit(50),
        supabase.from("drivers").select("is_active, is_online, current_order"),
        supabase
          .from("vendors")
          .select("id, name, is_active, paystack_subaccount_code"),
      ]);

      const statusBreakdown = {
        pending_vendor: 0,
        awaiting_driver: 0,
        driver_assigned: 0,
        picked_up: 0,
        delivered: 0,
        cancelled: 0,
        vendor_rejected: 0,
      };
      const dailySales = [];
      const dayMap = new Map();
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        dayMap.set(key, { label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), sales: 0, orders: 0 });
      }

      if (ordersResult.error) throw ordersResult.error;
      if (driversResult.error) throw driversResult.error;
      if (vendorsResult.error) throw vendorsResult.error;

      const paidOrders = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from("orders")
          .select("vendor_id, restaurant_name, total, paid_at")
          .eq("payment_status", "paid")
          .gte("paid_at", periodStart.toISOString())
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        paidOrders.push(...(data || []));
        if (!data || data.length < pageSize) break;
      }

      for (const order of ordersResult.data || []) {
        const key = order.status;
        if (statusBreakdown[key] !== undefined) {
          statusBreakdown[key] += 1;
        }
      }

      for (const order of paidOrders) {
        const rawPaidAt = order.paid_at || order.created_at;
        if (!rawPaidAt) continue;
        const paidDate = new Date(rawPaidAt);
        const dateKey = paidDate.toISOString().slice(0, 10);
        if (dayMap.has(dateKey)) {
          const bucket = dayMap.get(dateKey);
          bucket.sales += Number(order.total) || 0;
          bucket.orders += 1;
        }
      }
      for (const bucket of dayMap.values()) {
        dailySales.push(bucket);
      }

      const vendors = vendorsResult.data || [];
      const vendorNames = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
      const performanceByVendor = new Map();
      for (const order of paidOrders) {
        const key = order.vendor_id || order.restaurant_name || "unknown";
        const performance = performanceByVendor.get(key) || {
          vendorId: order.vendor_id,
          name:
            vendorNames.get(order.vendor_id) ||
            order.restaurant_name ||
            "Unknown vendor",
          orderCount: 0,
          sales: 0,
        };
        performance.orderCount += 1;
        performance.sales += Number(order.total) || 0;
        performanceByVendor.set(key, performance);
      }

      const drivers = driversResult.data || [];
      const activeDrivers = drivers.filter((driver) => driver.is_active !== false);
      const onlineDrivers = activeDrivers.filter(
        (driver) => driver.is_online === true,
      ).length;
      const deliveringDrivers = activeDrivers.filter(
        (driver) => driver.current_order != null,
      ).length;
      const payoutSetupGaps = vendors.filter(
        (vendor) =>
          vendor.is_active !== false && !vendor.paystack_subaccount_code,
      ).length;

      return res.status(200).json({
        period,
        openOrders: ordersResult.data || [],
        drivers: {
          online: onlineDrivers,
          available: activeDrivers.filter(
            (driver) =>
              driver.is_online === true && driver.current_order == null,
          ).length,
          delivering: deliveringDrivers,
        },
        vendorPerformance: [...performanceByVendor.values()].sort(
          (a, b) => b.sales - a.sales,
        ),
        dailySales,
        statusBreakdown,
        payoutSetupGaps,
      });
    } catch (error) {
      console.error(
        "Admin operations: failed to load dashboard data:",
        error.message || error,
      );
      return res
        .status(500)
        .json({ error: "Could not load operational dashboard data." });
    }
    },
  );
};

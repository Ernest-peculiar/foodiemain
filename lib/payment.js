// Payment processing and receipt generation
// Handles Paystack integration, receipt creation, and order confirmation

const sharp = require("sharp");
const FormData = require("form-data");

module.exports = function createPaymentHandlers(dependencies) {
  const {
    DELIVERY_FEE,
    WHATSAPP_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_API_VERSION,
    PAYSTACK_SECRET_KEY,
    PUBLIC_URL,
    sendWhatsAppMessage,
    saveProfile,
    getVendorRecordById,
  } = dependencies;

  // ============================================
  // AMOUNT FORMATTING
  // ============================================

  function getRoundedAmount(amount) {
    return Math.round(amount * 100);
  }

  // ============================================
  // PAYSTACK INTEGRATION
  // ============================================

  async function createPaystackTransaction(email, amount, reference) {
    if (!PAYSTACK_SECRET_KEY) {
      console.warn(
        "PAYSTACK_SECRET_KEY is not configured — cannot create a payment link.",
      );
      return null;
    }

    try {
      const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            amount: getRoundedAmount(amount),
            currency: "NGN",
            reference,
            callback_url: `${PUBLIC_URL}/paystack/callback`,
          }),
        },
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        console.error(
          `Paystack initialize failed (status ${response.status}):`,
          data?.message || JSON.stringify(data),
        );
        return null;
      }

      if (data?.status && data?.data) return data.data;

      console.error(
        "Paystack initialize returned 2xx but an unexpected body:",
        JSON.stringify(data),
      );
      return null;
    } catch (error) {
      console.error("Paystack initialize failed (network/exception):", error);
      return null;
    }
  }

  // ============================================
  // RECEIPT GENERATION
  // ============================================

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildReceiptSVG({
    orderId,
    vendorName,
    itemTitle,
    qty,
    unitPrice,
    total,
    address,
    reference,
    paidAt,
  }) {
    const date = new Date(paidAt || Date.now()).toLocaleString("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const rows = [
      ["Order", `#${orderId}`],
      ["Item", `${qty} x ${itemTitle}`],
      ["Unit price", `₦${(Number(unitPrice) || 0).toLocaleString("en-US")}`],
      ["Delivery fee", `₦${DELIVERY_FEE.toLocaleString("en-US")}`],
      ["Restaurant", vendorName || "—"],
      ["Deliver to", address || "—"],
      ["Paid", date],
      ["Reference", reference || "—"],
    ];

    const rowHeight = 46;
    const rowsStartY = 230;
    const cardBodyHeight = rowsStartY + rows.length * rowHeight + 40;
    const cardHeight = cardBodyHeight - 40;
    const canvasHeight = cardHeight + 120;

    const rowSvg = rows
      .map(([label, value], i) => {
        const y = rowsStartY + i * rowHeight;
        return `
      <text x="60" y="${y}" font-family="Arial, sans-serif" font-size="13" letter-spacing="0.6" fill="#888888">${escapeHtml(label.toUpperCase())}</text>
      <text x="60" y="${y + 22}" font-family="Arial, sans-serif" font-size="17" font-weight="600" fill="#222222">${escapeHtml(String(value))}</text>`;
      })
      .join("");

    return `<svg width="640" height="${canvasHeight}" viewBox="0 0 640 ${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="${canvasHeight}" fill="#FFC72C" />
  <rect x="40" y="40" width="560" height="${cardHeight}" rx="20" fill="#FFFFFF" />
  <text x="320" y="95" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#222222" text-anchor="middle">🧾 Foodie Receipt</text>
  <text x="320" y="130" font-family="Arial, sans-serif" font-size="14" fill="#888888" text-anchor="middle">Payment confirmed</text>
  <line x1="60" y1="160" x2="580" y2="160" stroke="#eeeeee" stroke-width="1" />
  <text x="320" y="200" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1a7f37" text-anchor="middle">₦${(Number(total) || 0).toLocaleString("en-US")}</text>
  ${rowSvg}
</svg>`;
  }

  async function generateReceiptPNG(receiptData) {
    const svg = buildReceiptSVG(receiptData);
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  async function uploadWhatsAppMedia(buffer, mimeType, filename) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
      console.warn(
        "WhatsApp credentials are not configured — cannot upload media.",
      );
      return null;
    }

    const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`;

    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimeType);
      form.append("file", new Blob([buffer], { type: mimeType }), filename);

      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        body: form,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.id) {
        console.error("Failed to upload media to WhatsApp:", data);
        return null;
      }

      return data.id;
    } catch (error) {
      console.error(
        "WhatsApp media upload failed (network/exception):",
        error.message || error,
      );
      return null;
    }
  }

  function buildPaymentSuccessPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Payment Successful — Foodie</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #FFC72C;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    text-align: center;
  }
  .card {
    max-width: 420px;
    width: 100%;
    background: #fff;
    border-radius: 16px;
    padding: 36px 28px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .check { font-size: 40px; margin-bottom: 8px; }
  h1 { font-size: 20px; color: #222; margin: 0 0 10px; }
  p { color: #555; font-size: 15px; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Payment received</h1>
    <p>Your receipt and order confirmation have been sent to you on WhatsApp. You can safely close this page.</p>
  </div>
</body>
</html>`;
  }

  function buildReceiptText({
    orderId,
    vendorName,
    itemTitle,
    qty,
    unitPrice,
    total,
    address,
    reference,
    paidAt,
  }) {
    const date = new Date(paidAt || Date.now()).toLocaleString("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return (
      `🧾 *Receipt* — Order ${orderId}\n\n` +
      `${qty} x ${itemTitle} — ₦${unitPrice.toLocaleString("en-US")} each\n` +
      `Delivery fee: ₦${DELIVERY_FEE.toLocaleString("en-US")}\n` +
      `*Total paid: ₦${total.toLocaleString("en-US")}*\n\n` +
      `Restaurant: ${vendorName}\n` +
      `Deliver to: ${address}\n` +
      `Paid: ${date}\n` +
      `Ref: ${reference}\n\n` +
      `Thanks for ordering with Foodie! 🙏`
    );
  }

  // ============================================
  // CHARGE CONFIRMATION HANDLER
  // ============================================

  async function handlePaystackChargeSuccess(
    data,
    supabase,
    ORDER_NOTIFY_NUMBER,
    getVendorPrepTimeButtonsReply,
  ) {
    const reference = data?.reference;
    console.log(
      `→ handlePaystackChargeSuccess called with reference=${reference}`,
    );

    if (!reference) {
      console.error(
        "🔴 No reference on the Paystack payload — cannot look up an order.",
      );
      return null;
    }
    if (!supabase) {
      console.error(
        "🔴 Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — cannot look up or update the order, so no receipt can be sent.",
      );
      return null;
    }

    let { data: orderRow, error } = await supabase
      .from("orders")
      .select("*")
      .eq("paystack_reference", reference)
      .maybeSingle();

    if (error) {
      console.warn(
        `⚠️ Lookup by paystack_reference failed (${error.message}) — falling back to lookup by id. If this persists, run migrations/002_orders_payment_columns.sql.`,
      );
    }

    if (!orderRow) {
      const fallback = await supabase
        .from("orders")
        .select("*")
        .eq("id", reference)
        .maybeSingle();
      orderRow = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error(
        "Failed to look up order for Paystack reference",
        reference,
        error.message,
      );
      return null;
    }
    if (!orderRow) {
      console.warn(
        `🔴 No order found for Paystack reference ${reference} (checked both paystack_reference and id) — ignoring webhook. Check that the order row's id/paystack_reference actually matches this reference.`,
      );
      return null;
    }

    console.log(
      `✅ Order resolved: id=${orderRow.id} customer_phone=${orderRow.customer_phone || "(none!)"} payment_status=${orderRow.payment_status}`,
    );
    if (!orderRow.customer_phone) {
      console.error(
        "🔴 orderRow.customer_phone is empty — the receipt/confirmation cannot be sent to WhatsApp because there is no phone number on the order row.",
      );
    }

    if (orderRow.payment_status === "paid") {
      console.log(
        `ℹ️ Order ${orderRow.id} is already marked paid — treating this as a duplicate webhook delivery and skipping re-send (this is expected on Paystack retries).`,
      );
      return orderRow;
    }

    const paidAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        paid_at: paidAt,
        status: "pending_vendor",
        paystack_reference: reference,
      })
      .eq("id", orderRow.id);

    if (updateError) {
      console.error("Failed to mark order paid:", updateError.message);
      return null;
    }

    orderRow = {
      ...orderRow,
      payment_status: "paid",
      paid_at: paidAt,
      status: "pending_vendor",
      paystack_reference: reference,
    };

    const items = Array.isArray(orderRow.items) ? orderRow.items : [];
    const firstItem = items[0] || {};
    const itemTitle = firstItem.title || "your order";
    const qty = firstItem.qty || 1;
    const unitPrice = firstItem.price || 0;
    const total = Number(orderRow.total) || unitPrice * qty;

    const receiptData = {
      orderId: orderRow.id,
      vendorName: orderRow.restaurant_name,
      itemTitle,
      qty,
      unitPrice,
      total,
      address: orderRow.delivery_address,
      reference,
      paidAt,
    };
    const receiptText = buildReceiptText(receiptData);

    // --- Customer: branded receipt image + confirmation text -----------------
    if (orderRow.customer_phone) {
      let receiptImageSent = false;

      try {
        console.log("→ Generating receipt PNG...");
        const pngBuffer = await generateReceiptPNG(receiptData);
        console.log(
          `✅ PNG generated (${pngBuffer.length} bytes). Uploading to WhatsApp...`,
        );

        const mediaId = await uploadWhatsAppMedia(
          pngBuffer,
          "image/png",
          `receipt-${orderRow.id}.png`,
        );

        if (mediaId) {
          console.log(
            `✅ Media uploaded, id=${mediaId}. Sending image message to ${orderRow.customer_phone}...`,
          );
          await sendWhatsAppMessage(orderRow.customer_phone, {
            type: "image",
            mediaId,
            caption: `🧾 Receipt for order ${orderRow.id}`,
          });
          receiptImageSent = true;
        } else {
          console.error(
            '🔴 uploadWhatsAppMedia returned null — see the "Failed to upload media to WhatsApp" log above for the actual API error (common causes: WHATSAPP_TOKEN expired, WHATSAPP_PHONE_NUMBER_ID wrong, or the token lacks media-upload permission).',
          );
        }
      } catch (error) {
        console.error(
          "🔴 Exception while generating/sending receipt image:",
          error.message || error,
        );
        console.error(
          '   If this says "Blob is not defined" or "FormData is not defined", your Node.js runtime is older than v18 — upgrade Node.',
        );
      }

      if (!receiptImageSent) {
        console.log("→ Falling back to plain-text receipt.");
        await sendWhatsAppMessage(orderRow.customer_phone, {
          type: "text",
          body: receiptText,
        });
      }

      console.log("→ Sending payment-confirmed text message...");
      await sendWhatsAppMessage(orderRow.customer_phone, {
        type: "text",
        body: "✅ Payment Successful! Your order has been confirmed and is now being prepared.",
      });
      console.log("✅ Customer messaging sequence complete.");

      await saveProfile(orderRow.customer_phone, {
        lastOrder: {
          vendorName: orderRow.restaurant_name,
          comboTitle: itemTitle,
          qty,
          total,
          address: orderRow.delivery_address,
          at: paidAt,
        },
      });
    }

    // --- Vendor: receipt + prep-time picker -----------------
    let vendorPhone = null;
    if (orderRow.vendor_id) {
      const vendorRecord = await getVendorRecordById(orderRow.vendor_id);
      vendorPhone = vendorRecord?.phone || null;
    }
    const vendorTarget = vendorPhone || ORDER_NOTIFY_NUMBER;

    if (vendorTarget) {
      await sendWhatsAppMessage(vendorTarget, {
        type: "text",
        body: receiptText,
      });
      await sendWhatsAppMessage(
        vendorTarget,
        getVendorPrepTimeButtonsReply(
          orderRow.id,
          `New order — ${itemTitle}. Choose how long it'll take to prepare:`,
        ),
      );
    } else {
      console.warn(
        "No vendor phone or ORDER_NOTIFY_NUMBER configured; cannot notify vendor of paid order.",
      );
    }

    return orderRow;
  }

  return {
    getRoundedAmount,
    createPaystackTransaction,
    buildReceiptSVG,
    generateReceiptPNG,
    uploadWhatsAppMedia,
    buildPaymentSuccessPage,
    buildReceiptText,
    handlePaystackChargeSuccess,
  };
};

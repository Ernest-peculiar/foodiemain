// Dispatch handlers for orders, drivers, vendors
// Manages order flow, vendor availability, driver assignments, and delivery status

module.exports = function createDispatchHandlers(dependencies) {
  const {
    STAGES,
    dispatch,
    normalizePhone,
    parseVendorMenu,
    sendWhatsAppMessage,
    getVendorRecordByPhone,
    getDriverRecordByPhone,
    getVendorMenuManagementListReply,
    getDriverAcceptButtonsReply,
    getDriverPickedUpButtonsReply,
    getCustomerConfirmDeliveryButtonsReply,
    getVehicleTypeListReply,
    WHATSAPP_TOKEN,
    WHATSAPP_API_VERSION,
    ORDER_NOTIFY_NUMBER,
  } = dependencies;

  async function handleAvailabilityCommands(text, phone, session, supabase) {
    const normalized = (text || "").trim().toLowerCase();

    if (normalized === "online" || normalized === "offline") {
      const isOnline = normalized === "online";
      const driver = await dispatch.setDriverAvailability(
        supabase,
        normalizePhone(phone),
        isOnline,
      );
      const body = driver
        ? isOnline
          ? "You are now online and will receive delivery requests."
          : "You are now offline and will not receive new delivery requests."
        : "I could not update your availability right now.";

      return {
        replies: { type: "text", body },
        nextStage: null,
        sessionData: session,
      };
    }

    if (normalized === "open" || normalized === "close") {
      const isOpen = normalized === "open";
      const vendor = await dispatch.setVendorAvailability(
        supabase,
        normalizePhone(phone),
        isOpen,
      );
      const body = vendor
        ? isOpen
          ? "Your restaurant is now open for new orders."
          : "Your restaurant is now closed for new orders."
        : "I could not update your availability right now.";

      return {
        replies: { type: "text", body },
        nextStage: null,
        sessionData: session,
      };
    }

    return null;
  }

  async function handleVendorMenuCommands(text, phone, session, supabase) {
    const normalized = (text || "").trim().toLowerCase();
    if (normalized !== "menu" && normalized !== "edit menu") return null;

    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) return null;

    if (normalized === "edit menu") {
      return {
        replies: {
          type: "text",
          body: `Send your full updated menu as text — one item per line with prices. Example:\nRice & Beans - 1500\nEgusi Soup - 1800\nChicken Sandwich - 1200\n\nItems you keep (matched by name) will keep their current available/sold-out status; new lines are added as available; lines you drop are removed.`,
        },
        nextStage: STAGES.VENDOR_AWAIT_MENU,
        sessionData: {
          ...session,
          registrationRole: "vendor",
          vendorName: vendor.name,
          isMenuEdit: true,
        },
      };
    }

    const items = vendor.menu_items || parseVendorMenu(vendor.menu);
    if (!items || items.length === 0) {
      return {
        replies: {
          type: "text",
          body: `You don't have a menu on file yet. Reply "edit menu" to add one.`,
        },
        nextStage: null,
        sessionData: session,
      };
    }

    return {
      replies: [
        { type: "text", body: `Here's your current menu, ${vendor.name}:` },
        getVendorMenuManagementListReply(
          items,
          'Tap an item to mark it available or sold out. Reply "edit menu" to rewrite the whole list.',
        ),
      ],
      nextStage: null,
      sessionData: session,
    };
  }

  async function handleRegistrationFlow(text, phone, session, supabase) {
    let normalized = (text || "").trim().toLowerCase();
    if (normalized === "register_vendor") normalized = "register vendor";
    if (normalized === "register_driver") normalized = "register driver";

    if (normalized !== "register vendor" && normalized !== "register driver") {
      return null;
    }

    if (normalized === "register vendor") {
      const vendorRecord = await getVendorRecordByPhone(phone);
      if (vendorRecord) {
        return {
          replies: {
            type: "text",
            body: `You are already registered as a vendor. Reply with open/close for availability, or "menu" to manage your menu.`,
          },
          nextStage: null,
          sessionData: session,
        };
      }

      return {
        replies: {
          type: "text",
          body: `Restaurant onboarding is now handled by our team. Please contact Foodie support to get your restaurant added — once you're on our platform you'll be able to manage your menu and availability right here.`,
        },
        nextStage: null,
        sessionData: session,
      };
    }

    const driverRecord = await getDriverRecordByPhone(phone);
    if (driverRecord) {
      return {
        replies: {
          type: "text",
          body: `You are already registered as a driver. Reply with online/offline to manage availability.`,
        },
        nextStage: null,
        sessionData: session,
      };
    }

    return {
      replies: {
        type: "text",
        body: `Driver onboarding is now handled by our team. Please contact Foodie support to get registered as a driver — once you're on our platform you'll be able to manage your availability right here.`,
      },
      nextStage: null,
      sessionData: session,
    };
  }

  async function finalizeRegistration(text, phone, session, supabase) {
    const role = session.registrationRole;
    const name = (text || "").trim();
    if (!role || !name) {
      return null;
    }

    if (role === "vendor") {
      if (session.stage === "vendorAwaitName") {
        if (!name) return null;
        return {
          replies: {
            type: "text",
            body: "Nice! Now send your restaurant menu as text. You can list one item per line with optional prices, use commas, or send a short menu description. Example:\nRice & Beans - 1500\nEgusi Soup - 1800\nChicken Sandwich - 1200",
          },
          nextStage: STAGES.VENDOR_AWAIT_MENU,
          sessionData: {
            ...session,
            registrationRole: "vendor",
            vendorName: name,
          },
        };
      }

      const menuText = name;
      const vendorName = session.vendorName;
      if (!vendorName || !menuText) {
        return {
          replies: {
            type: "text",
            body: "Please tell me your restaurant name first, then send your menu.",
          },
          nextStage: "vendorAwaitName",
          sessionData: {
            ...session,
            registrationRole: "vendor",
            vendorName: null,
          },
        };
      }

      const parsed = parseVendorMenu(menuText || "");
      const allHavePrices =
        parsed.length > 0 && parsed.every((it) => it.price !== null);
      if (!allHavePrices) {
        return {
          replies: {
            type: "text",
            body: 'Please include prices for each menu item (e.g. "Rice & Beans - 1500"). Send your menu again with prices per line or comma-separated.',
          },
          nextStage: STAGES.VENDOR_AWAIT_MENU,
          sessionData: { ...session, registrationRole: "vendor", vendorName },
        };
      }

      let existingItems = [];
      if (session.isMenuEdit) {
        const existingVendor = await getVendorRecordByPhone(phone);
        existingItems = existingVendor?.menu_items || [];
      }
      const menuItems = parseVendorMenu(menuText, existingItems);

      const vendor = await dispatch.upsertVendor(supabase, {
        phone: normalizePhone(phone),
        name: vendorName,
        menu: menuText,
        menuItems,
        isActive: true,
        isOpen: true,
      });
      return {
        replies: {
          type: "text",
          body: `✅ ${session.isMenuEdit ? "Updated menu for" : "Registered"} ${vendorName}${session.isMenuEdit ? "" : " as a vendor"}. Reply "menu" any time to mark items sold out, or "edit menu" to rewrite it.`,
        },
        nextStage: null,
        sessionData: {
          ...session,
          registrationRole: null,
          vendorName: null,
          isMenuEdit: false,
        },
      };
    }

    if (session.stage === "driverAwaitName") {
      return {
        replies: {
          type: "text",
          body: `Thanks, ${name}! 📸 Now *take a photo of yourself right now using WhatsApp's camera* — tap the camera icon in this chat and snap it live. Please don't send a photo from your gallery; this is how riders get identified.`,
        },
        nextStage: STAGES.DRIVER_REG_AWAIT_PHOTO,
        sessionData: {
          ...session,
          registrationRole: "driver",
          driverName: name,
        },
      };
    }

    return null;
  }

  async function handleDispatchPayload(payload, phone, session, supabase) {
    const normalized = (payload || "").trim();

    // --- Vendor: toggle menu item availability ---
    const toggleItemMatch = normalized.match(/^toggle_item_([a-f0-9]{6})$/i);
    if (toggleItemMatch) {
      const [, itemId] = toggleItemMatch;
      const vendor = await getVendorRecordByPhone(phone);
      if (!vendor) {
        return {
          replies: {
            type: "text",
            body: "Only a registered vendor can update a menu.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const items = vendor.menu_items || parseVendorMenu(vendor.menu);
      const item = items.find((it) => it.id === itemId);
      if (!item) {
        return {
          replies: {
            type: "text",
            body: "Could not find that menu item — it may have been removed in a later edit.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      item.available = item.available === false ? true : false;

      try {
        await dispatch.updateVendorMenuItems(supabase, vendor.id, items);
      } catch (error) {
        console.error(
          "Failed to toggle menu item availability:",
          error.message || error,
        );
        return {
          replies: {
            type: "text",
            body: "Something went wrong updating that item — please try again.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      return {
        replies: [
          {
            type: "text",
            body: `${item.available ? "✅ Marked available" : "🚫 Marked sold out"}: *${item.title || item.name}*`,
          },
          getVendorMenuManagementListReply(items),
        ],
        nextStage: null,
        sessionData: session,
      };
    }

    // --- Vendor: accept order with prep time ---
    const acceptMatch = normalized.match(/^vendor_accept_([0-9a-f-]+)_(\d+)$/i);
    if (acceptMatch) {
      const [, orderId, prepMinutes] = acceptMatch;
      const vendor = await getVendorRecordByPhone(phone);
      if (!vendor) {
        return {
          replies: {
            type: "text",
            body: "Only a registered vendor can accept this order.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const updatedOrder = await dispatch.vendorAcceptOrder(
        supabase,
        orderId,
        vendor.id,
        Number(prepMinutes),
      );
      if (!updatedOrder) {
        return {
          replies: { type: "text", body: "That order is no longer available." },
          nextStage: null,
          sessionData: session,
        };
      }

      const customerPhone = updatedOrder.customer_phone;
      const customerMessage = customerPhone
        ? {
            type: "text",
            body: `✅ ${updatedOrder.restaurant_name || "Your restaurant"} accepted your order. Estimated prep time: ${prepMinutes} minutes.`,
          }
        : null;

      if (customerPhone && customerMessage) {
        await sendWhatsAppMessage(customerPhone, customerMessage);
      }

      const pickupName =
        updatedOrder.restaurant_name || vendor.name || "the restaurant";
      const pickupAddress = vendor.vicinity || vendor.address || null;
      const pickupPhone = vendor.phone ? normalizePhone(vendor.phone) : null;

      const availableDrivers = await dispatch.findAvailableDrivers(supabase);
      if (availableDrivers.length > 0) {
        for (const driver of availableDrivers) {
          const driverMessage = {
            type: "text",
            body:
              `🚚 New delivery request (Order ${updatedOrder.id})\n` +
              `Pick up from: *${pickupName}*` +
              (pickupAddress
                ? `\n📍 ${pickupAddress}`
                : "\n📍 Pickup address not on file — confirm with the vendor") +
              (pickupPhone ? `\n📞 ${pickupPhone}` : ""),
          };
          await sendWhatsAppMessage(driver.phone, driverMessage);
          await sendWhatsAppMessage(
            driver.phone,
            getDriverAcceptButtonsReply(updatedOrder.id),
          );
        }
        await sendWhatsAppMessage(customerPhone || phone, {
          type: "text",
          body: "✅ Your order was accepted. We have broadcast it to nearby drivers.",
        });
      } else {
        await sendWhatsAppMessage(customerPhone || phone, {
          type: "text",
          body: "✅ Your order was accepted. We are waiting for a driver to become available.",
        });
      }

      return {
        replies: {
          type: "text",
          body: `Order accepted. Estimated prep time: ${prepMinutes} minutes.`,
        },
        nextStage: null,
        sessionData: session,
      };
    }

    // --- Driver: accept delivery ---
    const acceptMatchDriver = normalized.match(/^driver_accept_([0-9a-f-]+)$/i);
    if (acceptMatchDriver) {
      const [, orderId] = acceptMatchDriver;
      const driver = await getDriverRecordByPhone(phone);
      if (!driver) {
        return {
          replies: {
            type: "text",
            body: "Only a registered driver can accept this order.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const result = await dispatch.assignDriverToOrder(
        supabase,
        orderId,
        driver.id,
      );
      if (!result.ok) {
        return {
          replies: {
            type: "text",
            body: "That delivery is no longer available.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const { data: orderRow, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();
      if (!error && orderRow) {
        if (orderRow.customer_phone) {
          const riderCaption =
            `🚚 ${driver.name} has accepted your order and is on the way to pick it up.` +
            (driver.vehicle_type ? `\nVehicle: ${driver.vehicle_type}` : "");
          if (driver.photo_url) {
            await sendWhatsAppMessage(orderRow.customer_phone, {
              type: "image",
              imageUrl: driver.photo_url,
              caption: riderCaption,
            });
          } else {
            await sendWhatsAppMessage(orderRow.customer_phone, {
              type: "text",
              body: riderCaption,
            });
          }
        }

        if (orderRow.vendor_id) {
          const { data: vendorRecord } = await supabase
            .from("vendors")
            .select("*")
            .eq("id", orderRow.vendor_id)
            .maybeSingle();

          const vendorTarget =
            vendorRecord && vendorRecord.phone
              ? vendorRecord.phone
              : ORDER_NOTIFY_NUMBER;

          if (vendorTarget) {
            if (driver.photo_url) {
              await sendWhatsAppMessage(vendorTarget, {
                type: "image",
                imageUrl: driver.photo_url,
              });

              await sendWhatsAppMessage(vendorTarget, {
                type: "text",
                body: `🚴 ${driver.name} accepted your delivery.\n\n📞 Driver: ${driver.name}\n🏍️ Vehicle: ${driver.vehicle_type || "Bike"}\n\nThe rider is on the way to pick up the order.`,
              });
            } else {
              await sendWhatsAppMessage(vendorTarget, {
                type: "text",
                body: `✅ ${driver.name} has accepted the delivery and is on the way to pick up the order.`,
              });
            }
          }
        }
      }

      return {
        replies: [
          { type: "text", body: "✅ You accepted the delivery." },
          getDriverPickedUpButtonsReply(orderId),
        ],
        nextStage: null,
        sessionData: session,
      };
    }

    // --- Driver: mark picked up ---
    const pickupMatch = normalized.match(/^driver_picked_up_([0-9a-f-]+)$/i);
    if (pickupMatch) {
      const [, orderId] = pickupMatch;
      const driver = await getDriverRecordByPhone(phone);
      if (!driver) {
        return {
          replies: {
            type: "text",
            body: "Only a registered driver can update that order.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const updatedOrder = await dispatch.markOrderPickedUp(
        supabase,
        orderId,
        driver.id,
      );
      if (!updatedOrder) {
        return {
          replies: { type: "text", body: "That order could not be updated." },
          nextStage: null,
          sessionData: session,
        };
      }

      const reply = [
        { type: "text", body: "🚚 Order marked as picked up." },
        getDriverDeliveryButtonsReply(orderId),
      ];

      if (updatedOrder.customer_phone) {
        await sendWhatsAppMessage(updatedOrder.customer_phone, {
          type: "text",
          body: "🚚 Your order has been picked up and is on the way.",
        });
      }

      return {
        replies: reply,
        nextStage: null,
        sessionData: session,
      };
    }

    // --- Driver: mark delivered ---
    const deliverMatch = normalized.match(/^driver_deliver_([0-9a-f-]+)$/i);
    if (deliverMatch) {
      const [, orderId] = deliverMatch;
      const driver = await getDriverRecordByPhone(phone);
      if (!driver) {
        return {
          replies: {
            type: "text",
            body: "Only a registered driver can complete that delivery.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      const updatedOrder = await dispatch.markOrderDelivered(
        supabase,
        orderId,
        driver.id,
      );
      if (!updatedOrder) {
        return {
          replies: {
            type: "text",
            body: "That order could not be marked delivered.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      if (updatedOrder.customer_phone) {
        await sendWhatsAppMessage(updatedOrder.customer_phone, {
          type: "text",
          body: "🚚 Your rider says your order has arrived!",
        });
        await sendWhatsAppMessage(
          updatedOrder.customer_phone,
          getCustomerConfirmDeliveryButtonsReply(orderId),
        );
      }

      return {
        replies: [
          {
            type: "text",
            body: "✅ Delivery completed. Send a photo for proof of delivery, or reply with skip.",
          },
        ],
        nextStage: STAGES.DRIVER_AWAIT_PHOTO,
        sessionData: { ...session, pendingPhotoOrderId: orderId },
      };
    }

    // --- Customer: confirm delivery ---
    const confirmDeliveryMatch = normalized.match(
      /^customer_confirmed_([0-9a-f-]+)$/i,
    );
    if (confirmDeliveryMatch) {
      const [, orderId] = confirmDeliveryMatch;
      const { data: orderRow, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();

      if (
        error ||
        !orderRow ||
        normalizePhone(orderRow.customer_phone) !== normalizePhone(phone)
      ) {
        return {
          replies: {
            type: "text",
            body: "I could not find that order to confirm.",
          },
          nextStage: null,
          sessionData: session,
        };
      }

      await dispatch.updateOrderStatus(supabase, orderId, {
        customer_confirmed_at: new Date().toISOString(),
      });

      if (orderRow.driver_id) {
        const { data: driverRow } = await supabase
          .from("drivers")
          .select("*")
          .eq("id", orderRow.driver_id)
          .maybeSingle();
        if (driverRow?.phone) {
          await sendWhatsAppMessage(driverRow.phone, {
            type: "text",
            body: `✅ The customer confirmed they received order ${orderId}. Thanks for the delivery!`,
          });
        }
      }

      return {
        replies: {
          type: "text",
          body: "🙏 Thanks for confirming! Enjoy your meal.",
        },
        nextStage: null,
        sessionData: session,
      };
    }

    // --- Customer: report issue ---
    const reportIssueMatch = normalized.match(
      /^customer_complaint_([0-9a-f-]+)$/i,
    );
    if (reportIssueMatch) {
      const [, orderId] = reportIssueMatch;
      if (ORDER_NOTIFY_NUMBER) {
        await sendWhatsAppMessage(ORDER_NOTIFY_NUMBER, {
          type: "text",
          body: `⚠️ Customer reported an issue with order ${orderId}. Please follow up.`,
        });
      }
      return {
        replies: {
          type: "text",
          body: `I'm sorry to hear that. Our team has been notified and will follow up with you shortly.`,
        },
        nextStage: null,
        sessionData: session,
      };
    }

    return null;
  }

  async function handleDeliveryPhotoMessage(message, phone, session, supabase) {
    const orderId = session.pendingPhotoOrderId;
    const driver = await getDriverRecordByPhone(phone);

    if (!orderId || !driver) {
      return {
        replies: {
          type: "text",
          body: "I could not attach a delivery photo to that order.",
        },
        nextStage: null,
        sessionData: session,
      };
    }

    if (message.type === "image" && message.image?.id) {
      try {
        const mediaUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${message.image.id}`;
        const mediaResponse = await fetch(mediaUrl, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        });
        const buffer = Buffer.from(await mediaResponse.arrayBuffer());
        const photoUrl = await dispatch.uploadDeliveryPhoto(
          supabase,
          orderId,
          buffer,
          message.image.mime_type || "image/jpeg",
          `delivery-${orderId}.jpg`,
        );
        await dispatch.updateOrderStatus(supabase, orderId, {
          delivery_photo_url: photoUrl,
        });
        return {
          replies: {
            type: "text",
            body: "📷 Delivery photo saved for proof of delivery.",
          },
          nextStage: null,
          sessionData: { ...session, pendingPhotoOrderId: null },
        };
      } catch (error) {
        console.error("Failed to upload delivery photo:", error);
        return {
          replies: {
            type: "text",
            body: "I could not save that photo right now.",
          },
          nextStage: null,
          sessionData: { ...session, pendingPhotoOrderId: null },
        };
      }
    }

    if ((message.text?.body || "").trim().toLowerCase() === "skip") {
      return {
        replies: { type: "text", body: "No delivery photo attached." },
        nextStage: null,
        sessionData: { ...session, pendingPhotoOrderId: null },
      };
    }

    return {
      replies: {
        type: "text",
        body: "Send a photo for proof of delivery, or reply with skip.",
      },
      nextStage: STAGES.DRIVER_AWAIT_PHOTO,
      sessionData: session,
    };
  }

  return {
    handleAvailabilityCommands,
    handleVendorMenuCommands,
    handleRegistrationFlow,
    finalizeRegistration,
    handleDispatchPayload,
    handleDeliveryPhotoMessage,
  };
};

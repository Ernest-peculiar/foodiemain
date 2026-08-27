// Conversation flow stage handlers
// Each handler processes user input for a specific conversation stage

module.exports = function createStageHandlers(dependencies) {
  const { STAGES, STAGE_LABELS, MOOD_KEYWORDS, MOOD_CATALOG, getRegisteredVendors, findVendorByName, titleCase, parseOrderRequest, isLikelyValidAddress, mapMoodToCategory, buildMoodReply, getMoodButtonsReply, getRegisteredVendorListReply, getVendorMenuListReply, getHungryButtonsReply, getNewUserButtonsReply, getGreetingButtonsReply, getReorderButtonsReply, buildVendorMenuReply, handleBrowseRestaurants, saveProfile, askGrok, parseVendorMenu, makeItemId, createPaystackTransaction, DELIVERY_FEE } = dependencies;

  async function handleGreeting(seedText = 'hello', name = 'friend', profile = {}, phone) {
    const isReturning = Object.keys(profile).length > 0;

    if (isReturning) {
      if (profile.lastOrder) {
        return { replies: [getReorderButtonsReply(profile.lastOrder, name)], nextStage: null };
      }
      return {
        replies: [
          { type: 'text', body: `Welcome back, ${name}! 👋 What are you hungry for today?` },
          getGreetingButtonsReply()
        ],
        nextStage: null
      };
    }

    const grokReply = await askGrok(seedText, {}, { creative: true });
    const greetingText = `Hi ${name}, I'm *Foodie* — your personal Nigerian food guide. Tell me what you'd like to eat and I'll handle the rest!`;

    if (phone) await saveProfile(phone, { firstSeenAt: new Date().toISOString() });

    return {
      replies: [
        { type: 'text', body: greetingText },
        { type: 'text', body: grokReply || `I'm here to help you order food, find nearby restaurants, or get meal ideas.` },
        getNewUserButtonsReply()
      ],
      nextStage: null
    };
  }

  function handleResumePrompt(session, shortName) {
    const label = STAGE_LABELS[session.stage] || 'something';
    return {
      replies: {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: `Welcome back, ${shortName}! You were in the middle of ${label}. Pick up where you left off, or start fresh?` },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'resume_flow', title: '▶️ Resume' } },
              { type: 'reply', reply: { id: 'start_over', title: '🔄 Start over' } }
            ]
          }
        }
      },
      nextStage: session.stage,
      sessionData: session
    };
  }

  async function getStageResumeReply(session) {
    switch (session.stage) {
      case STAGES.ASK_LAST_MEAL:
        return { type: 'text', body: `Where were we — what did you last eat?` };
      case STAGES.ASK_MOOD:
        return [{ type: 'text', body: `What are you in the mood for?` }, getMoodButtonsReply()];
      case STAGES.ASK_HEALTH_GOALS:
        return { type: 'text', body: `Any health goals I should know about?` };
      case STAGES.ORDER_SELECT_RESTAURANT:
        return session.registeredVendors?.length
          ? [{ type: 'text', body: `Here are our restaurants again 👇` }, getRegisteredVendorListReply(session.registeredVendors)]
          : { type: 'text', body: `Which restaurant would you like to order from?` };
      case STAGES.ORDER_SELECT_COMBO:
        return session.menuItems?.length
          ? [{ type: 'text', body: `Here's the menu again 👇` }, getVendorMenuListReply(session.menuItems, `Menu for ${session.selectedVendor?.name || 'this restaurant'}`)]
          : { type: 'text', body: `Which item would you like?` };
      case STAGES.ORDER_ENTER_QTY:
        return { type: 'text', body: `How many would you like? (e.g. "2")` };
      case STAGES.ORDER_AWAIT_ADDRESS:
        return { type: 'text', body: `Please type your *exact delivery address* — street name, house number or a nearby landmark, and the area.` };
      case STAGES.DRIVER_REG_AWAIT_PHOTO:
        return { type: 'text', body: `📸 Please take a photo of yourself right now using WhatsApp's camera (not from your gallery) to continue registration.` };
      case STAGES.DRIVER_AWAIT_VEHICLE_TYPE:
        return [{ type: 'text', body: `What do you ride for deliveries?` }, { /* getVehicleTypeListReply() */ }];
      default:
        return { type: 'text', body: `Let's continue!` };
    }
  }

  function handleCapabilities() {
    return {
      replies: {
        type: 'text',
        body: `I help you: 🛒 Order food from restaurants near you 🍽️ Decide what to eat based on your mood & goals 🔄 Avoid meal repetition 🏪 Find nearby vendors selling your meal 📋 Plan weekly meals (Premium) Just say you're hungry to get started!`
      },
      nextStage: null
    };
  }

  function handleHungry() {
    return {
      replies: getHungryButtonsReply(),
      nextStage: null
    };
  }

  function handleRecommendMeals() {
    return {
      replies: {
        type: 'text',
        body: `Hey! 😄 What did you last eat?`
      },
      nextStage: STAGES.ASK_LAST_MEAL
    };
  }

  async function handleOrderAskWhat(text, name, session) {
    const trimmed = (text || '').trim();

    if (!trimmed || trimmed.length < 2) {
      return {
        replies: {
          type: 'text',
          body: `What would you like to order? (e.g., "rice from Munchy" or just "jollof rice")`
        },
        nextStage: STAGES.ORDER_ASK_WHAT,
        sessionData: {}
      };
    }

    const { foodItem, vendorName } = parseOrderRequest(trimmed);

    if (vendorName) {
      const vendorRecord = await findVendorByName(vendorName);
      if (vendorRecord && vendorRecord.menu) {
        const introText = foodItem
          ? `Great! Looking for *${foodItem}* — here's the menu for *${vendorRecord.name}* 👇`
          : `Great! Here's the menu for *${vendorRecord.name}* 👇`;
        return buildVendorMenuReply(vendorRecord, introText);
      }

      return handleBrowseRestaurants(`I couldn't find *${titleCase(vendorName)}* among our registered restaurants. Here's who is available 👇`);
    }

    const introText = foodItem
      ? `Looking for restaurants that serve *${foodItem}* 👇 Tap one to see their menu.`
      : `Here are our registered restaurants 👇 Tap one to see the menu.`;
    return handleBrowseRestaurants(introText);
  }

  function handleOrderNow() {
    return {
      replies: {
        type: 'text',
        body: `What would you like to order? 🛒\n\n(e.g., "rice", "rice from Munchy", "i want to order from Munchy")`
      },
      nextStage: STAGES.ORDER_ASK_WHAT,
      sessionData: {}
    };
  }

  function handleReorderLast(profile) {
    const lastOrder = profile.lastOrder;
    if (!lastOrder) return handleOrderNow();

    const vendor = { name: lastOrder.vendorName, vicinity: lastOrder.vendorVicinity || 'Previously used restaurant' };

    return {
      replies: {
        type: 'text',
        body: `Great, ${lastOrder.qty} x *${lastOrder.comboTitle}* from *${vendor.name}* again 🙌\nPlease confirm the delivery address (last time: "${lastOrder.address}") — or type a new one.`
      },
      nextStage: STAGES.ORDER_AWAIT_ADDRESS,
      sessionData: {
        selectedVendor: vendor,
        selectedComboIdx: lastOrder.comboIdx,
        qty: lastOrder.qty
      }
    };
  }

  function handleAskLastMeal(text) {
    return {
      replies: [
        { type: 'text', body: `Got it! What are you in the mood for?` },
        getMoodButtonsReply()
      ],
      nextStage: STAGES.ASK_MOOD,
      sessionData: { lastMeal: text.trim() }
    };
  }

  function handleAskMood(text, name, session) {
    return {
      replies: {
        type: 'text',
        body: `Nice. Any health goals I should know about?`
      },
      nextStage: STAGES.ASK_HEALTH_GOALS,
      sessionData: { lastMeal: session.lastMeal, userMood: text.trim() }
    };
  }

  async function handleAskHealthGoals(text, name, session, shortName) {
    const selectedMood = mapMoodToCategory(session.userMood);
    const recommendations = await buildMoodReply(selectedMood, shortName, session.lastMeal || 'something');
    const browseReply = await handleBrowseRestaurants(`Here are our registered restaurants — tap one to see if they've got something *${selectedMood}* 👇`);

    return {
      replies: [
        {
          type: 'text',
          body: `✨ Based on what you told me — here are my top picks for you:\n\n*${selectedMood.charAt(0).toUpperCase() + selectedMood.slice(1)} Nigerian Foods:*`
        },
        ...(Array.isArray(recommendations) ? recommendations : [recommendations]),
        ...(Array.isArray(browseReply.replies) ? browseReply.replies : [browseReply.replies])
      ],
      nextStage: browseReply.nextStage,
      sessionData: { ...(browseReply.sessionData || {}), selectedMood }
    };
  }

  async function handleOrderSelectRestaurant(text, name, session) {
    const trimmed = (text || '').trim();

    if (trimmed.startsWith('regvendor_') && Array.isArray(session.registeredVendors)) {
      const regIdx = parseInt(trimmed.replace('regvendor_', ''), 10);
      const vendorRecord = session.registeredVendors[regIdx];

      if (!vendorRecord) {
        return handleBrowseRestaurants(`Please tap a restaurant from the list above 👆`);
      }

      return buildVendorMenuReply(vendorRecord, `Great pick! Here's the menu for *${vendorRecord.name}* 👇`);
    }

    if (trimmed.length < 2) {
      return handleBrowseRestaurants(`Please tap a restaurant from the list above 👆, or type the restaurant's name.`);
    }

    const vendorRecord = await findVendorByName(trimmed);
    if (vendorRecord && vendorRecord.menu) {
      return buildVendorMenuReply(vendorRecord, `Great pick! Here's the menu for *${vendorRecord.name}* 👇`);
    }

    return handleBrowseRestaurants(`I couldn't find *${titleCase(trimmed)}* among our registered restaurants. Here's who is available 👇`);
  }

  async function handleOrderSelectCombo(text, name, session) {
    const trimmed = (text || '').trim();
    const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];

    if (trimmed.startsWith('proceed_qty_item_')) {
      const idx = parseInt(trimmed.replace('proceed_qty_item_', ''), 10);
      const combo = menuItems[idx];
      if (!combo) {
        return {
          replies: { type: 'text', body: `Something went wrong — please pick a menu item again 👆` },
          nextStage: STAGES.ORDER_SELECT_COMBO,
          sessionData: { selectedVendor: session.selectedVendor, menuItems }
        };
      }
      return {
        replies: { type: 'text', body: `*${combo.title || combo.name}* is a great choice! How many would you like? (e.g. "2")` },
        nextStage: STAGES.ORDER_ENTER_QTY,
        sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: idx, menuItems }
      };
    }

    if (trimmed.startsWith('item_')) {
      const itemIdx = parseInt(trimmed.replace('item_', ''), 10);
      const combo = menuItems[itemIdx] || null;
      if (!combo) {
        return {
          replies: { type: 'text', body: `Please tap a menu item from the list above 👆` },
          nextStage: STAGES.ORDER_SELECT_COMBO,
          sessionData: { selectedVendor: session.selectedVendor, menuItems }
        };
      }

      return {
        replies: { type: 'text', body: `*${combo.title || combo.name}* is a great choice! How many would you like? (e.g. "2")` },
        nextStage: STAGES.ORDER_ENTER_QTY,
        sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: itemIdx, menuItems }
      };
    }

    return {
      replies: { type: 'text', body: `Please tap a menu item from the list above 👆` },
      nextStage: STAGES.ORDER_SELECT_COMBO,
      sessionData: { selectedVendor: session.selectedVendor, menuItems }
    };
  }

  function handleOrderEnterQty(text, name, session, shortName) {
    const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];
    const combo = menuItems[session.selectedComboIdx];
    const vendor = session.selectedVendor;
    const parsedQty = parseInt((text || '').replace(/[^0-9]/g, ''), 10);
    const qty = Number.isInteger(parsedQty) && parsedQty > 0 ? Math.min(parsedQty, 20) : 1;

    if (!combo || !vendor) {
      return handleOrderNow();
    }

    return {
      replies: {
        type: 'text',
        body: `Almost there, ${shortName}! 📍 Please type your *exact delivery address* — street name, house number or a nearby landmark, and the area (e.g. "12 Ogoja Rd, opposite GTBank, Abakaliki"). I won't generate the payment link until I have this.`
      },
      nextStage: STAGES.ORDER_AWAIT_ADDRESS,
      sessionData: {
        selectedVendor: vendor,
        selectedComboIdx: session.selectedComboIdx,
        qty,
        menuItems
      }
    };
  }

  function handleMealPlanPlaceholder() {
    return {
      replies: {
        type: 'text',
        body: `📋 Weekly meal planning is a Premium feature — coming soon! For now just tell me you're hungry and I'll help you decide, meal by meal. 😊`
      },
      nextStage: null
    };
  }

  return {
    handleGreeting,
    handleResumePrompt,
    getStageResumeReply,
    handleCapabilities,
    handleHungry,
    handleRecommendMeals,
    handleOrderAskWhat,
    handleOrderNow,
    handleReorderLast,
    handleAskLastMeal,
    handleAskMood,
    handleAskHealthGoals,
    handleOrderSelectRestaurant,
    handleOrderSelectCombo,
    handleOrderEnterQty,
    handleMealPlanPlaceholder
  };
};

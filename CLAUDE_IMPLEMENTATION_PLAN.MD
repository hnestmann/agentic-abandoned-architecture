B2C Commerce — Abandon Cart Implementation Plan

  Overview

  A new cartridge plugin_abandon_cart sits on top of app_storefront_base in the cartridge path, making zero changes to base. It intercepts two existing SFRA endpoints via server.append, calls a helper that POSTs
  to the Salesforce Core REST API, and uses the B2C Service Framework for HTTP + OAuth2 token management.

  ---
  Cartridge Structure

  plugin_abandon_cart/
  ├── cartridge/
  │   ├── controllers/
  │   │   └── CheckoutServices.js          # server.append on SubmitCustomer + PlaceOrder
  │   ├── scripts/
  │   │   ├── services/
  │   │   │   └── abandonCartService.js    # B2C Service Framework HTTP service
  │   │   └── helpers/
  │   │       └── abandonCartHelpers.js    # payload builder + API call orchestration
  │   └── templates/
  │       └── (none needed)
  ├── hooks.json                           # (empty, no custom hooks needed)
  └── package.json

  ---
  Step 1 — B2C Service Framework: HTTP Service + OAuth2 Token Service

  File: cartridge/scripts/services/abandonCartService.js

  Two services registered via LocalServiceRegistry:

  ┌────────────────────┬──────┬──────────────────────────────────┐
  │     Service ID     │ Type │             Purpose              │
  ├────────────────────┼──────┼──────────────────────────────────┤
  │ abandon.cart.api   │ HTTP │ POST to Salesforce Core REST API │
  ├────────────────────┼──────┼──────────────────────────────────┤
  │ abandon.cart.oauth │ HTTP │ Client credentials token fetch   │
  └────────────────────┴──────┴──────────────────────────────────┘

  The OAuth service fetches a token using client_id + client_secret stored as Service Credentials in BM. The result is cached in a session-level or static variable with a TTL check to avoid fetching a new token
  on every request.

  BM configuration required:
  - Administration → Operations → Services → Credentials
    - abandon.cart.api.cred — URL = Salesforce Core REST base URL
    - abandon.cart.oauth.cred — URL = token endpoint, user = client_id, password = client_secret

  ---
  Step 2 — Payload Builder Helper

  File: cartridge/scripts/helpers/abandonCartHelpers.js

  Two exported functions:

  buildCartPayload(basket, status)
  Constructs the JSON body for the Salesforce Core API from the basket:
  {
    "basketId": "<basket UUID>",
    "email": "<customerEmail>",
    "firstName": "<billing address first name>",
    "lastName": "<billing address last name>",
    "status": "open" | "converted",
    "products": [
      {
        "productId": "...",
        "productName": "...",
        "productImageUrl": "...",
        "productPrice": 0.00,
        "pdpUrl": "..."
      }
    ]
  }

  sendCartToCore(basket, status)
  1. Calls abandonCartService to obtain a Bearer token (cached, refreshed when expired)
  2. Calls abandon.cart.api service with Authorization: Bearer <token> header
  3. Swallows all errors — logs via dw/system/Logger but never throws, so checkout is never blocked

  ---
  Step 3 — Controller Overrides

  File: cartridge/controllers/CheckoutServices.js

  Trigger 1 — Email submitted (SubmitCustomer)

  server.append('SubmitCustomer', function (req, res, next) {
      // Fires after base sets customerEmail on basket
      // route:BeforeComplete ensures basket already has email set
      this.on('route:BeforeComplete', function () {
          var basket = BasketMgr.getCurrentBasket();
          if (basket && basket.customerEmail) {
              abandonCartHelpers.sendCartToCore(basket, 'open');
          }
      });
      return next();
  });

  This fires after handleCustomerRouteBeforeComplete has called basket.setCustomerEmail(...) at CheckoutServices.js:115, so the email is guaranteed to be on the basket.

  Trigger 2 — Order placed (PlaceOrder)

  server.append('PlaceOrder', function (req, res, next) {
      this.on('route:BeforeComplete', function (req, res) {
          var viewData = res.getViewData();
          if (!viewData.error) {
              // Checkout completed — upsert Lead to converted status
              // Basket is gone at this point; use order.customerEmail + order UUID
              var order = viewData.order; // or retrieve from OrderMgr by orderNo
              abandonCartHelpers.sendOrderCompleteToCore(order);
          }
      });
      return next();
  });

  sendOrderCompleteToCore posts the same endpoint with "status": "converted" — matching the PATCH-to-converted approach you chose.

  ---
  Step 4 — Custom Site Preferences

  Register in BM under Administration → Site Development → System Object Types → SitePreferences:

  ┌────────────────────┬─────────┬───────────────────────────────────────────────────────┐
  │   Preference ID    │  Type   │                        Purpose                        │
  ├────────────────────┼─────────┼───────────────────────────────────────────────────────┤
  │ abandonCartEnabled │ Boolean │ Feature flag — off by default                         │
  ├────────────────────┼─────────┼───────────────────────────────────────────────────────┤
  │ abandonCartApiPath │ String  │ REST API path (e.g. /services/apexrest/abandonedcart) │
  └────────────────────┴─────────┴───────────────────────────────────────────────────────┘

  The service base URL lives in Service Credentials; the path here allows per-environment flexibility without redeploying.

  ---
  Step 5 — Cartridge Path & Metadata

  1. Add plugin_abandon_cart to the cartridge path before app_storefront_base:
  plugin_abandon_cart:app_storefront_base:modules
  2. Import metadata (site preferences XML + service definitions XML) via BM site import or via the b2c-cli:b2c-site-import-export skill.

  ---
  Data Flow Summary

  Customer types email → CheckoutServices-SubmitCustomer
      → server.append fires after base sets email on basket
      → abandonCartHelpers.sendCartToCore(basket, 'open')
          → fetch OAuth2 token (cached)
          → POST /abandonedcart  { status: "open", email, products... }
              → Salesforce Core creates/updates Lead

  Customer completes checkout → CheckoutServices-PlaceOrder (success)
      → server.append fires after successful order creation
      → abandonCartHelpers.sendOrderCompleteToCore(order)
          → POST /abandonedcart  { status: "converted", basketId... }
              → Salesforce Core updates Lead status to Converted

  Customer abandons (no action from B2C)
      → Salesforce Core record-triggered flow fires after 24h
      → Agentforce generates personalised email

  ---
  Open Questions / Decision Points

  1. Basket UUID as Lead key — the plan assumes basket.UUID is used as the correlation ID sent in both the "open" and "converted" calls. Confirm this matches how the Salesforce Core API identifies Leads.
  2. First/last name source at email-submit time — at SubmitCustomer, the billing address may not exist yet (it's filled on the payment step). The plan will fall back to null for names at that point and rely on
  the "converted" POST to supply them. Confirm this is acceptable, or if a separate SubmitPayment append should update names.
  3. Token cache scope — the plan uses a module-level variable for the OAuth token. This is fine for most cases but resets on redeployment. A dw/system/CacheMgr region is more durable if needed.
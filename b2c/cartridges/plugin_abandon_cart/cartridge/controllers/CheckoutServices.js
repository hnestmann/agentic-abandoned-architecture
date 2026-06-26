'use strict';

var server = require('server');
server.extend(module.superModule);

var BasketMgr = require('dw/order/BasketMgr');
var OrderMgr = require('dw/order/OrderMgr');
var Transaction = require('dw/system/Transaction');

var abandonCartHelpers = require('*/cartridge/scripts/helpers/abandonCartHelpers');

/**
 * Append to SubmitCustomer — fires after the base route sets customerEmail on the basket.
 * Sends the cart to Salesforce Core with status 'open' so the Lead is created/updated.
 */
server.append('SubmitCustomer', function (req, res, next) {
    this.on('route:BeforeComplete', function () {
        var viewData = res.getViewData();
        // Only proceed when the base route succeeded
        if (viewData && viewData.error) {
            return;
        }

        var currentBasket = BasketMgr.getCurrentBasket();
        if (currentBasket && currentBasket.customerEmail) {
            abandonCartHelpers.sendCartToCore(currentBasket, 'open');
        }
    });

    return next();
});

/**
 * Prepend to PlaceOrder — fires before the base route while the basket still exists.
 * Captures the basket UUID into viewData so the append can persist it on the order
 * after the base route has converted (and destroyed) the basket.
 */
server.prepend('PlaceOrder', function (req, res, next) {
    var currentBasket = BasketMgr.getCurrentBasket();
    if (currentBasket) {
        res.setViewData({ originalBasketUUID: currentBasket.UUID });
    }
    return next();
});

/**
 * Append to PlaceOrder — fires after the base route successfully places the order.
 * Persists the basket UUID captured by the prepend into order.custom.originalBasketUUID,
 * then sends a 'converted' status to Salesforce Core so the Lead is closed out.
 */
server.append('PlaceOrder', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
        var viewData = res.getViewData();
        if (!viewData || viewData.error) {
            return;
        }

        var orderNo = viewData.orderID;
        if (!orderNo) {
            return;
        }

        var order = OrderMgr.getOrder(orderNo);
        if (!order) {
            return;
        }

        // Persist the original basket UUID captured before the basket was destroyed
        var basketUUID = viewData.originalBasketUUID;
        if (basketUUID) {
            try {
                Transaction.wrap(function () {
                    order.custom.originalBasketUUID = basketUUID; // eslint-disable-line no-param-reassign
                });
            } catch (e) {
                require('dw/system/Logger')
                    .getLogger('abandonCart', 'abandonCart')
                    .error('Failed to persist originalBasketUUID on order {0}: {1}', orderNo, e.message);
            }
        }

        abandonCartHelpers.sendOrderCompleteToCore(order);
    });

    return next();
});

module.exports = server.exports();

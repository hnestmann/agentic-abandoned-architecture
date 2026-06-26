'use strict';

var server = require('server');
server.extend(module.superModule);

var BasketMgr = require('dw/order/BasketMgr');
var OrderMgr = require('dw/order/OrderMgr');

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
 * Append to PlaceOrder — fires after the base route successfully places the order.
 * Sends a 'converted' status to Salesforce Core so the Lead is closed out.
 */
server.append('PlaceOrder', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
        var viewData = res.getViewData();
        // Only proceed when the order was placed without errors
        if (!viewData || viewData.error) {
            return;
        }

        var orderNo = viewData.orderID;
        if (!orderNo) {
            return;
        }

        var order = OrderMgr.getOrder(orderNo);
        if (order) {
            abandonCartHelpers.sendOrderCompleteToCore(order);
        }
    });

    return next();
});

module.exports = server.exports();

'use strict';

var Logger = require('dw/system/Logger');
var URLUtils = require('dw/web/URLUtils');
var Site = require('dw/system/Site');

var abandonCartService = require('*/cartridge/scripts/services/abandonCartService');

var log = Logger.getLogger('abandonCart', 'abandonCart');

var API_PATH = '/services/apexrest/abandonedcart';

/**
 * Returns true when the feature is enabled via site preference.
 */
function isEnabled() {
    return Site.current.getCustomPreferenceValue('abandonCartEnabled') === true;
}

/**
 * Returns the configured API path, falling back to the default.
 */
function getApiPath() {
    var configured = Site.current.getCustomPreferenceValue('abandonCartApiPath');
    return (configured && configured.length > 0) ? configured : API_PATH;
}

/**
 * Builds the product list from a basket's product line items.
 * Each entry contains data needed by Salesforce Core to render the cart email.
 *
 * @param {dw.order.Basket} basket
 * @returns {Array}
 */
function buildProductList(basket) {
    var products = [];
    var lineItems = basket.getAllProductLineItems().iterator();

    while (lineItems.hasNext()) {
        var pli = lineItems.next();
        var product = pli.product;
        if (!product) {
            continue;
        }

        var imageUrl = '';
        try {
            var images = product.getImages('small');
            if (images && images.size() > 0) {
                imageUrl = images.get(0).absURL.toString();
            }
        } catch (e) {
            log.warn('Could not retrieve image for product {0}: {1}', product.ID, e.message);
        }

        var pdpUrl = URLUtils.abs('Product-Show', 'pid', product.ID).toString();

        products.push({
            productId: product.ID,
            productName: pli.productName || product.name,
            productImageUrl: imageUrl,
            productPrice: pli.basePrice.value,
            pdpUrl: pdpUrl
        });
    }

    return products;
}

/**
 * Builds the full request payload for the Salesforce Core abandon cart API.
 *
 * @param {dw.order.Basket} basket
 * @param {string} status - 'open' or 'converted'
 * @returns {Object}
 */
function buildCartPayload(basket, status) {
    var billingAddress = basket.billingAddress;

    return {
        basketId: basket.UUID,
        email: basket.customerEmail,
        firstName: billingAddress ? billingAddress.firstName : null,
        lastName: billingAddress ? billingAddress.lastName : null,
        status: status,
        products: buildProductList(basket)
    };
}

/**
 * Sends cart data to Salesforce Core.
 * All errors are swallowed — checkout is never blocked.
 *
 * @param {dw.order.Basket} basket
 * @param {string} status - 'open' when email is submitted, 'converted' on order placement
 */
function sendCartToCore(basket, status) {
    if (!isEnabled()) {
        return;
    }

    if (!basket || !basket.customerEmail) {
        return;
    }

    try {
        var payload = buildCartPayload(basket, status);
        var result = abandonCartService.callApi(getApiPath(), 'POST', payload);

        if (!result.ok) {
            log.error(
                'Abandon cart API call failed for basket {0} (status={1}): {2}',
                basket.UUID,
                status,
                result.errorMessage || 'unknown error'
            );
        } else {
            log.info('Abandon cart API call succeeded for basket {0} (status={1})', basket.UUID, status);
        }
    } catch (e) {
        log.error('Unexpected error in sendCartToCore for basket {0}: {1}', basket.UUID, e.message);
    }
}

/**
 * Sends order-complete notification to Salesforce Core after successful checkout.
 * Uses the placed order's data since the basket is no longer available.
 * All errors are swallowed — the order confirmation flow is never blocked.
 *
 * @param {dw.order.Order} order
 */
function sendOrderCompleteToCore(order) {
    if (!isEnabled()) {
        return;
    }

    if (!order || !order.customerEmail) {
        return;
    }

    try {
        var billingAddress = order.billingAddress;
        var products = [];
        var lineItems = order.getAllProductLineItems().iterator();

        while (lineItems.hasNext()) {
            var pli = lineItems.next();
            var product = pli.product;
            if (!product) {
                continue;
            }

            var imageUrl = '';
            try {
                var images = product.getImages('small');
                if (images && images.size() > 0) {
                    imageUrl = images.get(0).absURL.toString();
                }
            } catch (imgErr) {
                log.warn('Could not retrieve image for product {0}: {1}', product.ID, imgErr.message);
            }

            products.push({
                productId: product.ID,
                productName: pli.productName || product.name,
                productImageUrl: imageUrl,
                productPrice: pli.basePrice.value,
                pdpUrl: URLUtils.abs('Product-Show', 'pid', product.ID).toString()
            });
        }

        var payload = {
            basketId: order.getCustom().originalBasketUUID || order.orderNo,
            email: order.customerEmail,
            firstName: billingAddress ? billingAddress.firstName : null,
            lastName: billingAddress ? billingAddress.lastName : null,
            status: 'converted',
            products: products
        };

        var result = abandonCartService.callApi(getApiPath(), 'POST', payload);

        if (!result.ok) {
            log.error(
                'Abandon cart "converted" API call failed for order {0}: {1}',
                order.orderNo,
                result.errorMessage || 'unknown error'
            );
        } else {
            log.info('Abandon cart "converted" API call succeeded for order {0}', order.orderNo);
        }
    } catch (e) {
        log.error('Unexpected error in sendOrderCompleteToCore for order {0}: {1}', order.orderNo, e.message);
    }
}

module.exports = {
    sendCartToCore: sendCartToCore,
    sendOrderCompleteToCore: sendOrderCompleteToCore
};

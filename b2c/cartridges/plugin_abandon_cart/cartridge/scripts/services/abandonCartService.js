'use strict';

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');

// Module-level token cache — reused across requests, reset on redeployment
var tokenCache = {
    value: null,
    expiresAt: 0
};

var SERVICE_ID_API = 'abandon.cart.api';
var SERVICE_ID_OAUTH = 'abandon.cart.oauth';

/**
 * Creates (or returns cached) HTTP service for the Salesforce Core REST API.
 * Caller is responsible for setting the Authorization header before calling.
 */
function getApiService() {
    return LocalServiceRegistry.createService(SERVICE_ID_API, {
        createRequest: function (svc, params) {
            svc.setRequestMethod(params.method || 'POST');
            svc.addHeader('Content-Type', 'application/json');
            svc.addHeader('Authorization', 'Bearer ' + params.token);
            if (params.path) {
                svc.setURL(svc.getURL() + params.path);
            }
            return params.body ? JSON.stringify(params.body) : null;
        },
        parseResponse: function (svc, response) {
            if (response.text) {
                try {
                    return JSON.parse(response.text);
                } catch (e) {
                    return response.text;
                }
            }
            return null;
        },
        filterLogMessage: function (msg) {
            // Avoid logging bearer tokens
            return msg.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
        }
    });
}

/**
 * Creates HTTP service for the OAuth2 client credentials token endpoint.
 */
function getOAuthService() {
    return LocalServiceRegistry.createService(SERVICE_ID_OAUTH, {
        createRequest: function (svc, params) {
            svc.setRequestMethod('POST');
            svc.addHeader('Content-Type', 'application/x-www-form-urlencoded');
            // client_id and client_secret come from Service Credentials (user/password)
            var credential = svc.getConfiguration().getCredential();
            return 'grant_type=client_credentials'
                + '&client_id=' + encodeURIComponent(credential.getUser())
                + '&client_secret=' + encodeURIComponent(credential.getPassword());
        },
        parseResponse: function (svc, response) {
            try {
                return JSON.parse(response.text);
            } catch (e) {
                return null;
            }
        },
        filterLogMessage: function (msg) {
            return msg.replace(/client_secret=[^&\s]*/gi, 'client_secret=[REDACTED]');
        }
    });
}

/**
 * Returns a valid Bearer token, fetching a new one when the cached token has expired.
 * @returns {string|null} access token or null on failure
 */
function getBearerToken() {
    var now = Date.now();
    // Use cached token if still valid (with 60-second safety buffer)
    if (tokenCache.value && tokenCache.expiresAt > now + 60000) {
        return tokenCache.value;
    }

    var oauthSvc = getOAuthService();
    var result = oauthSvc.call({});

    if (!result.ok || !result.object || !result.object.access_token) {
        require('dw/system/Logger')
            .getLogger('abandonCart', 'abandonCart')
            .error('Failed to obtain OAuth2 token: {0}', result.errorMessage || 'unknown error');
        return null;
    }

    var expiresIn = result.object.expires_in || 3600;
    tokenCache.value = result.object.access_token;
    tokenCache.expiresAt = now + (expiresIn * 1000);
    return tokenCache.value;
}

/**
 * Calls the Salesforce Core abandon cart REST API.
 * @param {string} path - API path to append to the service base URL (e.g. '/abandonedcart')
 * @param {string} method - HTTP method ('POST', 'DELETE', 'PATCH')
 * @param {Object} body - request payload
 * @returns {{ok: boolean, object: Object, errorMessage: string}}
 */
function callApi(path, method, body) {
    var token = getBearerToken();
    if (!token) {
        return { ok: false, errorMessage: 'No auth token available' };
    }

    var apiSvc = getApiService();
    return apiSvc.call({
        token: token,
        path: path,
        method: method,
        body: body
    });
}

module.exports = {
    callApi: callApi,
    getBearerToken: getBearerToken
};

@RestResource(urlMapping='/abandoned-cart/*')
global with sharing class AbandonedCartResource {

    global class CartPayload {
        public String email;
        public String firstName;
        public String lastName;
        public String cartId;
        public Object items;
        public String totalPrice;
    }

    @HttpPost
    global static void handlePost() {
        RestResponse res = RestContext.response;
        try {
            CartPayload payload = (CartPayload) JSON.deserialize(
                RestContext.request.requestBody.toString(), CartPayload.class
            );

            if (String.isBlank(payload.email)) {
                res.statusCode = 400;
                res.responseBody = Blob.valueOf('{"error":"email required"}');
                return;
            }

            List<Lead> existing = [
                SELECT Id, HasOptedOutOfEmail
                FROM Lead
                WHERE Email = :payload.email
                AND Status != 'Converted'
                LIMIT 1
            ];

            if (!existing.isEmpty() && existing[0].HasOptedOutOfEmail) {
                res.statusCode = 200;
                res.responseBody = Blob.valueOf('{"status":"opted-out"}');
                return;
            }

            Lead lead = existing.isEmpty() ? new Lead() : existing[0];
            lead.Email        = payload.email;
            lead.FirstName    = payload.firstName;
            lead.LastName     = String.isBlank(payload.lastName) ? 'Unknown' : payload.lastName;
            lead.Company      = 'B2C Storefront';
            lead.LeadSource   = 'Web';
            lead.Status       = 'Open - Not Contacted';
            lead.Cart_Data__c = JSON.serialize(payload.items)
                                + ' | total: ' + payload.totalPrice
                                + ' | cartId: ' + payload.cartId;

            upsert lead;

            res.statusCode = 201;
            res.responseBody = Blob.valueOf('{"status":"ok","leadId":"' + lead.Id + '"}');

        } catch (Exception e) {
            res.statusCode = 500;
            res.responseBody = Blob.valueOf('{"error":"' + e.getMessage() + '"}');
        }
    }

    @HttpDelete
    global static void handleDelete() {
        RestResponse res = RestContext.response;
        try {
            String email = RestContext.request.params.get('email');

            if (String.isBlank(email)) {
                res.statusCode = 400;
                res.responseBody = Blob.valueOf('{"error":"email required"}');
                return;
            }

            List<Lead> leads = [
                SELECT Id FROM Lead
                WHERE Email = :email
                AND Status != 'Converted'
                LIMIT 1
            ];

            if (leads.isEmpty()) {
                res.statusCode = 404;
                res.responseBody = Blob.valueOf('{"status":"not-found"}');
                return;
            }

            leads[0].Status = 'Converted';
            update leads[0];

            res.statusCode = 200;
            res.responseBody = Blob.valueOf('{"status":"converted"}');

        } catch (Exception e) {
            res.statusCode = 500;
            res.responseBody = Blob.valueOf('{"error":"' + e.getMessage() + '"}');
        }
    }
}

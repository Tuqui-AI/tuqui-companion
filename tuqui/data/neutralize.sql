-- disconnect from Tuqui: the next activation mints a new client, so the copy never shares production's client_id
DELETE FROM tuqui_activation_nonce;
DELETE FROM tuqui_oauth_client;
-- invalidate the access tokens issued to production
DELETE FROM ir_config_parameter
    WHERE key = 'tuqui.oauth.signing_key';

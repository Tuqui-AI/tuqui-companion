-- a live connection becomes a pending test database of the same workspace: the
-- copy keeps the inherited key only to sign its own registration, the first time
-- the panel opens (tuqui.oauth.client.register_test_copy); until then it signs
-- nothing and production's credentials are refused here
DELETE FROM tuqui_activation_nonce;
UPDATE tuqui_oauth_client SET state = 'copy_pending' WHERE state IN ('active', 'test');
DELETE FROM tuqui_oauth_client WHERE state <> 'copy_pending';
-- a copy of a copy that was still registering mints its own credentials too;
-- guarded because the code can be newer than the schema (no -u tuqui yet)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tuqui_oauth_client' AND column_name = 'copy_pending_secret'
    ) THEN
        UPDATE tuqui_oauth_client
            SET copy_parent_client_id = NULL, copy_parent_signing_key = NULL, copy_pending_secret = NULL;
    END IF;
END $$;
-- invalidate the access tokens issued to production
DELETE FROM ir_config_parameter
    WHERE key = 'tuqui.oauth.signing_key';
-- events queued by production must not be delivered from the copy;
-- guarded because the code can be newer than the schema (no -u tuqui yet)
DO $$
BEGIN
    IF to_regclass('tuqui_event') IS NOT NULL THEN
        DELETE FROM tuqui_event WHERE state = 'pending';
    END IF;
END $$;

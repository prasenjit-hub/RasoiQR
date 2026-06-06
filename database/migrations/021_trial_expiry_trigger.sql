-- Migration 012: Trial Expiry Trigger
-- Automatically blocks accounts that have exceeded their 14-day trial period.

CREATE OR REPLACE FUNCTION enforce_trial_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status != 'blocked'
     AND NEW.trial_ends_at IS NOT NULL
     AND NEW.trial_ends_at < NOW()
     AND NEW.subscription_plan = 'free_trial' THEN
    
    NEW.status := 'blocked';
    NEW.is_active := FALSE;
    NEW.block_reason := 'Trial expired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trial_expiry ON restaurants;
CREATE TRIGGER trg_trial_expiry BEFORE INSERT OR UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION enforce_trial_expiry();

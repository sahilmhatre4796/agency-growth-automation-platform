import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const supabase =
  url && key
    ? createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Invitation and recovery links return to /onboard/. Supabase consumes
          // their one-time URL credentials before the owner sets a password.
          detectSessionInUrl: true,
        },
      })
    : null;

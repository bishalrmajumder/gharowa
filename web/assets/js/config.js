// Public settings for the Gharowa website.
// The anon key is designed to be public: every table is protected by Row Level Security,
// and every write that matters goes through server functions. Never put the service_role key here.
export const SUPABASE_URL = 'https://iihnssqevheqhvcqppun.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpaG5zc3FldmhlcWh2Y3FwcHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3Mjg1MDAsImV4cCI6MjEwOTMwNDUwMH0.aW3NkbHv3v4D8JqF-kqaRB-NTA6oeHlbmn-1odkU_mI';

export const FEES = { scheduled: 39, instant: 69, platform: 10 };
export const RIDER_PAY = 40;

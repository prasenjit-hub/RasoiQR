import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function generateSignature(params: Record<string, string>, secret: string) {
  // 1. Sort parameters alphabetically by key
  const sortedKeys = Object.keys(params).sort();
  // 2. Create the string to sign
  const signString = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + secret;
  
  // 3. Hash using SHA-1 (required by Cloudinary)
  const msgUint8 = new TextEncoder().encode(signString);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

Deno.serve(async (req) => {
  // Handle CORS for browser preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Ensure the user is authenticated (checking for the Auth header)
    // Edge functions automatically validate the JWT if a standard Supabase client is used.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized: User must be logged in to upload images.' }), { 
        status: 401, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // 2. Load Cloudinary secrets from Supabase environment
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');

    if (!apiKey || !apiSecret) {
      throw new Error("Missing Cloudinary API credentials in Edge Function secrets.");
    }

    // 3. Generate signature parameters
    const timestamp = Math.round(new Date().getTime() / 1000).toString();
    const folder = 'restaurant_menus'; // Enforce folder destination securely on the backend

    const paramsToSign = {
      timestamp: timestamp,
      folder: folder
    };

    // 4. Create the cryptographic signature
    const signature = await generateSignature(paramsToSign, apiSecret);

    // 5. Return the payload to the frontend
    return new Response(
      JSON.stringify({ signature, timestamp, apiKey, folder }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

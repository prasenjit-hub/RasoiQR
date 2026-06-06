import { supabase } from '../config/supabase';

export const uploadImageToCloudinary = async (file: File): Promise<string> => {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || 'dcnkg4pob';
  
  try {
    // 1. Fetch secure signature from Supabase Edge Function
    const { data: signData, error: signError } = await supabase.functions.invoke('cloudinary-sign');
    
    if (signError) {
      console.error('Signature error:', signError);
      throw new Error(signError.message || 'Failed to secure upload signature. Ensure you are logged in.');
    }
    
    if (!signData) {
      throw new Error('Failed to get signature from server.');
    }

    const { signature, timestamp, apiKey, folder } = signData;
    
    // 2. Prepare Cloudinary formData with signed payload
    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', apiKey);
    formData.append('timestamp', timestamp);
    formData.append('signature', signature);
    formData.append('folder', folder);
    
    // 3. Upload to Cloudinary securely
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('Cloudinary response error:', errText);
      throw new Error('Failed to upload image to Cloudinary.');
    }
    
    const data = await response.json();
    
    // Automatically apply Cloudinary transformations for performance (WebP format, auto quality, resize)
    const optimizedUrl = data.secure_url.replace('/upload/', '/upload/w_800,c_limit,f_auto,q_auto/');
    return optimizedUrl;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw error;
  }
};

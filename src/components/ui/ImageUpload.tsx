import React, { useRef, useState } from 'react';
import { Upload, X, Loader2 } from 'lucide-react';
import { uploadImageToCloudinary } from '../../services/imageService';

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  label?: string;
  className?: string;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({ 
  value, 
  onChange, 
  label = "Image", 
  className = "" 
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (e.g. max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be less than 5MB');
      return;
    }

    try {
      setIsUploading(true);
      setError(null);
      const url = await uploadImageToCloudinary(file);
      onChange(url);
    } catch (err: any) {
      setError(err.message || 'Failed to upload image. Please try again.');
    } finally {
      setIsUploading(false);
      // Reset input so the same file could be selected again if needed
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemove = () => {
    onChange('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <label className="block text-sm font-medium text-text">{label}</label>}
      
      <div className="flex flex-col items-start gap-4">
        {value ? (
          <div className="relative inline-block">
            <img 
              src={value} 
              alt="Uploaded preview" 
              className="w-32 h-32 object-cover rounded-lg border border-border"
            />
            <button
              type="button"
              onClick={handleRemove}
              className="absolute -top-2 -right-2 bg-white rounded-full p-1 shadow-md border border-border text-error hover:bg-error/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div 
            className="w-32 h-32 flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg bg-bg-subtle hover:bg-bg-subtle/80 cursor-pointer transition-colors relative"
            onClick={() => fileInputRef.current?.click()}
          >
            {isUploading ? (
              <Loader2 className="w-6 h-6 text-text-secondary animate-spin" />
            ) : (
              <>
                <Upload className="w-6 h-6 text-text-secondary mb-2" />
                <span className="text-xs text-text-secondary">Upload Image</span>
              </>
            )}
          </div>
        )}
        
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          className="hidden"
        />
        
        {error && <p className="text-sm text-error">{error}</p>}
        {isUploading && <p className="text-sm text-text-secondary">Uploading...</p>}
      </div>
    </div>
  );
};

import {
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
} from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, className = "", ...props }, ref) => {
    const generatedId = useId();
    const id = props.id ?? props.name ?? generatedId;

    return (
      <div className="w-full">
        {label && (
          <label className="label" htmlFor={id}>
            {label}
            {props.required && <span className="text-error ml-1">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={id}
          className={`input resize-none ${
            error ? "border-error focus:ring-error" : ""
          } ${className}`}
          rows={4}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-error">{error}</p>}
        {helperText && !error && (
          <p className="mt-1 text-sm text-text-secondary">{helperText}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";

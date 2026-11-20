import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-8 w-full rounded-md border border-white/[0.09] bg-[#0b0c0e] px-2.5 text-[13px] text-[#f7f8f8] placeholder:text-[#5b6069] transition-colors focus-visible:outline-none focus-visible:border-[#5e6ad2]/70 focus-visible:ring-1 focus-visible:ring-[#5e6ad2]/40 disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

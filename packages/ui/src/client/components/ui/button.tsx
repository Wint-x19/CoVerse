import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5e6ad2] disabled:pointer-events-none disabled:opacity-40 cursor-pointer [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[#f7f8f8] text-[#08090a] hover:bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]",
        secondary:
          "bg-[#16181d] text-[#d0d6e0] border border-white/[0.08] hover:bg-[#1d2027] hover:text-[#f7f8f8]",
        outline:
          "border border-white/[0.09] bg-transparent text-[#d0d6e0] hover:bg-white/[0.04] hover:text-[#f7f8f8]",
        ghost: "text-[#8a8f98] hover:bg-white/[0.05] hover:text-[#f7f8f8]",
        destructive: "bg-[#e5484d]/15 text-[#ff6b70] border border-[#e5484d]/30 hover:bg-[#e5484d]/25",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[12px]",
        xs: "h-6 px-2 text-[12px]",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

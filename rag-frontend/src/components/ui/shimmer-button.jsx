import { cn } from '@/lib/utils'

export function ShimmerButton({ children, className, ...props }) {
  return (
    <button
      className={cn(
        'relative inline-flex items-center justify-center gap-2',
        'rounded-md px-4 py-2 text-sm font-medium',
        'bg-primary text-primary-foreground',
        'overflow-hidden transition-all duration-300',
        'hover:shadow-[0_0_20px_hsl(var(--primary)/0.4)]',
        'before:absolute before:inset-0',
        'before:-translate-x-full before:animate-[shimmer_2s_infinite]',
        'before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent',
        'disabled:opacity-50 disabled:pointer-events-none',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

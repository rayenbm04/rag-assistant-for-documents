import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

export const HoverEffect = ({ items, className }) => {
  const [hoveredIndex, setHoveredIndex] = useState(null);

  return (
    <div className={cn("grid grid-cols-1 md:grid-cols-3 gap-2 py-4", className)}>
      {items.map((item, idx) => {
        const Tag = item.onClick ? "button" : "a";
        const extraProps = item.onClick
          ? { type: "button", onClick: item.onClick }
          : { href: item.link };

        return (
          <Tag
            key={idx}
            {...extraProps}
            className="relative group block p-2 h-full w-full text-left"
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <AnimatePresence>
              {hoveredIndex === idx && (
                <motion.span
                  className="absolute inset-0 h-full w-full bg-muted/60 block rounded-2xl"
                  layoutId="hoverBackground"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.15 } }}
                  exit={{ opacity: 0, transition: { duration: 0.15, delay: 0.1 } }}
                />
              )}
            </AnimatePresence>
            <div className={cn(
              "rounded-2xl h-full w-full px-4 py-3 overflow-hidden",
              "bg-card border border-border group-hover:border-primary/30 relative z-20 transition-colors"
            )}>
              <div className="relative z-50">
                <p className="text-card-foreground font-medium text-sm tracking-wide">{item.title}</p>
                {item.description && (
                  <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">{item.description}</p>
                )}
              </div>
            </div>
          </Tag>
        );
      })}
    </div>
  );
};

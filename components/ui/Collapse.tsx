"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Disclosure panel that animates to its content's own height.
 *
 * The mechanic is `grid-template-rows: 0fr -> 1fr`, which transitions against
 * real content, so nothing has to know or guess how tall the panel is. The
 * alternative, animating max-height, needs a ceiling: too small clips the
 * content, too large spends most of the duration animating empty space and reads
 * as sluggish.
 *
 * Children mount on first open rather than always. A transition needs its content
 * present, but the collapsed groups this wraps appear on every turn and can hold
 * many messages — mounting all of them permanently would cost render time on a
 * long session for content nobody is looking at. Mounting one frame before the
 * class flips gets the animation without that cost, and the content stays mounted
 * afterwards so collapsing animates too.
 */
export function Collapse({
  open,
  children,
  className,
  style,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  // Latches on first open and never clears: unmounting on collapse would remove
  // the content mid-transition and the panel would vanish instead of closing.
  const [mounted, setMounted] = useState(open);
  // Separate from `open` so the first frame after mount still has 0fr to leave
  // from. Setting both at once would start the element at 1fr with nothing to
  // transition, and the panel would appear instantly.
  const [active, setActive] = useState(open);
  const frameRef = useRef(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      frameRef.current = requestAnimationFrame(() => setActive(true));
      return () => cancelAnimationFrame(frameRef.current);
    }
    setActive(false);
    return undefined;
  }, [open]);

  if (!mounted) return null;

  return (
    <div className={`ui-collapse${active ? " is-open" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {/* overflow:hidden and min-height:0 both live on this inner element; the
          grid row will not shrink below its content without min-height:0.
          Deliberately not `hidden` when closed: that attribute would apply the
          moment the collapse starts and remove the content mid-transition, so the
          panel would blink out instead of closing. The clipping does the work. */}
      <div className="ui-collapse__inner">
        {children}
      </div>
    </div>
  );
}

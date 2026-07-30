import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils/cn';

interface PopoverProps {
  children: React.ReactNode;
  content: React.ReactNode;
  trigger?: 'hover' | 'click';
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export const Popover: React.FC<PopoverProps> = ({
  children,
  content,
  trigger = 'hover',
  position = 'top',
  className,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const showPopover = () => setIsVisible(true);
  const hidePopover = () => setIsVisible(false);

  useEffect(() => {
    if (isVisible && trigger === 'click') {
      const handleClickOutside = (event: MouseEvent) => {
        if (
          triggerRef.current &&
          popoverRef.current &&
          !triggerRef.current.contains(event.target as Node) &&
          !popoverRef.current.contains(event.target as Node)
        ) {
          hidePopover();
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isVisible, trigger]);

  useLayoutEffect(() => {
    if (isVisible && triggerRef.current && popoverRef.current) {
      const updatePosition = () => {
        const triggerRect = triggerRef.current!.getBoundingClientRect();
        const popoverElement = popoverRef.current!;
        const popoverRect = popoverElement.getBoundingClientRect();

        let top = 0,
          left = 0;

        switch (position) {
          case 'top':
            top = triggerRect.top - popoverRect.height - 8;
            left = triggerRect.left + (triggerRect.width - popoverRect.width) / 2;
            break;
          case 'bottom':
            top = triggerRect.bottom + 8;
            left = triggerRect.left + (triggerRect.width - popoverRect.width) / 2;
            break;
          case 'left':
            top = triggerRect.top + (triggerRect.height - popoverRect.height) / 2;
            left = triggerRect.left - popoverRect.width - 8;
            break;
          case 'right':
            top = triggerRect.top + (triggerRect.height - popoverRect.height) / 2;
            left = triggerRect.right + 8;
            break;
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (left < 8) left = 8;
        if (left + popoverRect.width > vw - 8) left = vw - popoverRect.width - 8;
        if (top < 8) top = 8;
        if (top + popoverRect.height > vh - 8) top = vh - popoverRect.height - 8;

        setPopoverStyle({
          position: 'fixed',
          top: `${top}px`,
          left: `${left}px`,
          zIndex: 50,
        });
      };

      requestAnimationFrame(updatePosition);

      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition);
      return () => {
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition);
      };
    } else {
      setPopoverStyle(null);
    }
  }, [isVisible, position]);

  const triggerProps =
    trigger === 'hover'
      ? { onMouseEnter: showPopover, onMouseLeave: hidePopover }
      : { onClick: () => setIsVisible(!isVisible) };

  const popoverContent = isVisible && (
    <div
      ref={popoverRef}
        style={
        popoverStyle ? popoverStyle : { position: 'fixed', top: '-9999px', left: '-9999px' }
      }
      className={cn(
        'rounded-xl border-2 border-ink bg-paper p-4 shadow-card transition-opacity duration-200',
        isVisible ? 'visible opacity-100' : 'invisible opacity-0',
        className
      )}
      onMouseEnter={trigger === 'hover' ? showPopover : undefined}
      onMouseLeave={trigger === 'hover' ? hidePopover : undefined}
    >
      {content}
    </div>
  );

  return (
    <>
      <div ref={triggerRef} {...triggerProps}>
        {children}
      </div>
      {isVisible && createPortal(popoverContent, document.body)}
    </>
  );
};

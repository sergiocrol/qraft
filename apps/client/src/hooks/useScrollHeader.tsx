import { useState, useEffect, useRef, useCallback } from 'react';

interface UseScrollHeaderProps {
  shouldShow: boolean;
}

export const useScrollHeader = ({ shouldShow }: UseScrollHeaderProps) => {
  const [isHeaderVisible, setIsHeaderVisible] = useState(false);
  const fullHeaderRef = useRef<HTMLElement>(null);

  const handleScroll = useCallback(() => {
    if (!shouldShow) {
      setIsHeaderVisible(false);
      return;
    }

    const currentScrollY = window.scrollY;

    if (fullHeaderRef.current) {
      const headerRect = fullHeaderRef.current.getBoundingClientRect();
      const headerBottom = headerRect.bottom;

      const shouldShowHeader = headerBottom < 100;

      setIsHeaderVisible(shouldShowHeader);
    } else {
      const threshold = 150;
      const shouldShowHeader = currentScrollY > threshold;

      setIsHeaderVisible(shouldShowHeader);
    }
  }, [shouldShow]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });

    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll]);

  useEffect(() => {
    if (!shouldShow) {
      setIsHeaderVisible(false);
    } else {
      handleScroll();
    }
  }, [shouldShow, handleScroll]);

  return {
    isHeaderVisible,
    fullHeaderRef,
  };
};

import { useState, useCallback } from 'react';

interface UseClipboardOptions {
  /** Duration in ms to show the copied state (default: 2000) */
  timeout?: number;
}

interface UseClipboardReturn {
  /** Whether the text was recently copied */
  copied: boolean;
  /** Copy text to clipboard */
  copy: (text: string) => Promise<boolean>;
}

/**
 * Hook to copy text to clipboard with visual feedback
 */
export function useClipboard(options: UseClipboardOptions = {}): UseClipboardReturn {
  const { timeout = 2000 } = options;
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;
    
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), timeout);
      return true;
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      return false;
    }
  }, [timeout]);

  return { copied, copy };
}

import { cn } from '@/lib/utils/cn';

interface DividerProps {
  className?: string;
  text?: string;
  icon?: React.ReactNode;
}

export const Divider: React.FC<DividerProps> = ({ className, text, icon }) => {
  return (
    <div className={cn('flex w-full items-center', className)}>
      <div className="flex-1 border-t border-hairline"></div>
      {text && (
        <span className="flex items-center gap-2 px-6 py-2 font-serif text-[15px] italic text-faint">
          {icon} {text}
        </span>
      )}
      <div className="flex-1 border-t border-hairline"></div>
    </div>
  );
};

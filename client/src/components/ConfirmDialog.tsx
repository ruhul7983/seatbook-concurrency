import { ReactNode, useEffect, useRef } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Focus starts on the cancel button, so a stray double click or Enter press never confirms.
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="glass rounded-3xl p-8 w-full max-w-md bg-[#1e1b4b]/90"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-2xl font-bold">
          {title}
        </h2>
        <div className="mt-3 text-white/70">{children}</div>
        <div className="mt-8 flex gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="flex-1 py-3 rounded-2xl border border-white/20 text-white/80 hover:text-white hover:border-white/40 transition-all duration-300"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-3 rounded-2xl font-bold transition-all duration-300 hover:scale-[1.02] ${
              danger
                ? 'bg-gradient-to-r from-[#ef4444] to-[#dc2626]'
                : 'bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#f97316]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

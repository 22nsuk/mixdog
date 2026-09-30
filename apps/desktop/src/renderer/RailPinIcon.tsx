import { Pin } from 'lucide-react';

/** One diagonal pushpin: outlined when available, filled when pinned. */
export function RailPinIcon({ pinned, size = 16 }: { pinned: boolean; size?: number }) {
  return (
    <Pin
      size={size}
      className="rail-pin-icon"
      fill={pinned ? 'currentColor' : 'none'}
      style={{ transform: 'rotate(45deg)' }}
      aria-hidden="true"
    />
  );
}
